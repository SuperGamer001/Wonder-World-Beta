/**
 * SmoothMesher — the smooth-terrain pass that runs alongside GreedyMesher.
 *
 * Only used in smooth worlds. Shapes come from engine/SmoothShape.js, which the
 * player's collision also uses, so what is drawn is what is collided with.
 *
 * Division of labour with the greedy mesher:
 *   • Solid blocks, and Mesh blocks whose shape works out to a full cube (every
 *     buried voxel and the flat interior of terrain), stay in the greedy pass —
 *     flat ground is still one quad per merged rectangle.
 *   • Deformed Mesh voxels are flagged in `partial`, skipped by the greedy pass
 *     and emitted here, entirely inside their own voxel: a sampled top patch, a
 *     sampled bottom patch, and a strip on each open side between the two.
 *   • Every Mesh voxel hides faces drawn against it (`occ`). See
 *     buildOccluderTable for why that is safe even for deformed ones.
 *
 * Patches are shaded smoothly: each vertex gets the brightness of the surface
 * normal at that point, and neighbouring patches compute the same normal along
 * a shared side. The texture is chosen once per patch, from the face (top,
 * bottom or a side) closest to the patch's overall direction, so a curved
 * slope never switches texture half way across a block.
 *
 * Coordinates are chunk-local. Reads reach SMOOTH_REACH voxels past the chunk
 * on X/Z: into the four face neighbours, and into a SMOOTH_REACH-square block
 * of columns from each diagonal chunk.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME } from '../engine/ChunkData.js';
import { sunBrightness } from '../engine/Sun.js';
import {
    KIND_EMPTY, KIND_MESH, SENTINEL, SMOOTH_REACH, SMOOTH_SAMPLES, EDGE_AXIS,
    SmoothField, buildKindTable, buildOccluderTable, describeVoxel, newShape,
    edgeSample, surfaceGrid,
} from '../engine/SmoothShape.js';

const N_XZ = CHUNK_SIZE;
const N_Y  = CHUNK_SIZE_Y;
const SY   = CHUNK_SIZE;
const SZ   = CHUNK_SIZE * CHUNK_SIZE_Y;

// Face brightness, same values as GreedyMesher: +X -X +Y -Y +Z -Z.
const FACE_BRIGHTNESS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .map(([x, y, z]) => sunBrightness(x, y, z));

// The four sides: neighbour offset, and the patch edge lying on that side.
const SIDES = [
    { dx:  1, dz:  0, edge: 3 },   // +X  (u = 1)
    { dx: -1, dz:  0, edge: 2 },   // -X  (u = 0)
    { dx:  0, dz:  1, edge: 1 },   // +Z  (v = 1)
    { dx:  0, dz: -1, edge: 0 },   // -Z  (v = 0)
];

/** Brightness for a unit normal: lit by the sun (engine/Sun.js), exactly as a cube face would be. */
const brightness = sunBrightness;

/** The block face (0..5 = +X -X +Y -Y +Z -Z) closest to a direction; ties go to ±Y. */
function closestFace(nx, ny, nz) {
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ay >= ax && ay >= az) return ny > 0 ? 2 : 3;
    if (ax >= az)             return nx > 0 ? 0 : 1;
    return nz > 0 ? 4 : 5;
}

export class SmoothMesher {
    /**
     * @param {BlockRegistry} reg
     * @param {GreedyMesher}  mesher  — shares its colour and texture-layer tables
     */
    constructor(reg, mesher) {
        this.kind    = buildKindTable(reg);
        this.occ     = buildOccluderTable(reg);
        this.mesher  = mesher;
        this.partial = new Uint8Array(CHUNK_VOLUME);

        // Every lattice line a chunk's shapes read lies within one step of the
        // chunk (corners at 0..16, slopes one line further), at any level of the
        // column plus a few either side of the world.
        const get     = (x, y, z) => this._read(x, y, z);
        const span    = CHUNK_SIZE + 3;
        this.field    = new SmoothField(this.kind, get, false, { x0: -1, z0: -1, nx: span, nz: span, y0: -8,       ny: N_Y + 16 });
        this.flipped  = new SmoothField(this.kind, get, true,  { x0: -1, z0: -1, nx: span, nz: span, y0: -N_Y - 8, ny: N_Y + 16 });
        this._shape   = newShape();
        this._e       = new Float64Array(2);
        const most    = SMOOTH_SAMPLES[SMOOTH_SAMPLES.length - 1].length;
        this._stripT  = new Float64Array(most);
        this._stripB  = new Float64Array(most);

        // Set per job by prepare().
        this._v = null;
        this._px = this._nx = this._pz = this._nz = null;
        this._cpp = this._cpn = this._cnp = this._cnn = null;
    }

    /**
     * Classify every Mesh voxel in the chunk and collect the deformed ones.
     *
     * @param {Uint16Array} voxels     this chunk, expanded
     * @param {object}      neighbors  { "1,0", "-1,0", "0,1", "0,-1" } expanded chunks
     * @param {object}      corners    { "1,1", "1,-1", "-1,1", "-1,-1" } —
     *   SMOOTH_REACH² columns from each diagonal chunk (ChunkData.cornerBlock)
     * @param {{min,max}}   yRange
     * @returns {{ occ, partial, emit(sink) }} context for GreedyMesher.meshGroup
     */
    prepare(voxels, neighbors, corners, yRange) {
        this._v   = voxels;
        this._px  = neighbors?.['1,0']  ?? null;
        this._nx  = neighbors?.['-1,0'] ?? null;
        this._pz  = neighbors?.['0,1']  ?? null;
        this._nz  = neighbors?.['0,-1'] ?? null;
        this._cpp = corners?.['1,1']    ?? null;
        this._cpn = corners?.['1,-1']   ?? null;
        this._cnp = corners?.['-1,1']   ?? null;
        this._cnn = corners?.['-1,-1']  ?? null;
        this.field.clear();
        this.flipped.clear();

        const kind = this.kind, partial = this.partial, s = this._shape;
        partial.fill(0);

        const yMin = Math.max(0, yRange?.min ?? 0);
        const yMax = Math.min(N_Y - 1, yRange?.max ?? N_Y - 1);

        // Deformed voxels as flat (lx, ly, lz, id) records. Shapes are
        // re-derived at emit time from the memoised edge spans rather than kept.
        const list = [];
        for (let lz = 0; lz < N_XZ; lz++) {
            for (let ly = yMin; ly <= yMax; ly++) {
                const row = ly * SY + lz * SZ;
                // describeVoxel's buried-voxel fast path, read straight from the
                // chunk: a block above and below means a full cube. Only valid
                // away from the world's top and bottom, where those reads stay
                // inside this array; the ends go through describeVoxel as before.
                const inner = ly > 0 && ly < N_Y - 1;
                for (let lx = 0; lx < N_XZ; lx++) {
                    const i  = row + lx;
                    const id = voxels[i];
                    if (kind[id] !== KIND_MESH) continue;
                    if (inner && kind[voxels[i + SY]] !== KIND_EMPTY && kind[voxels[i - SY]] !== KIND_EMPTY) continue;
                    if (!describeVoxel(this.field, this.flipped, lx, ly, lz, s)) continue;
                    partial[row + lx] = 1;
                    list.push(lx, ly, lz, id);
                }
            }
        }

        return {
            occ: this.occ,
            partial,
            emit: (sink) => {
                for (let i = 0; i < list.length; i += 4) {
                    describeVoxel(this.field, this.flipped, list[i], list[i + 1], list[i + 2], s);
                    this._emitVoxel(sink, list[i], list[i + 1], list[i + 2], list[i + 3], s);
                }
            },
        };
    }

    /** Read a voxel at chunk-local coords, up to SMOOTH_REACH past the chunk on X/Z. */
    _read(lx, ly, lz) {
        if (ly < 0 || ly >= N_Y) return SENTINEL;
        const ox = lx < 0 ? -1 : lx >= N_XZ ? 1 : 0;
        const oz = lz < 0 ? -1 : lz >= N_XZ ? 1 : 0;
        if (ox === 0 && oz === 0) return this._v[lx + ly * SY + lz * SZ];
        if (oz === 0) {
            const n = ox > 0 ? this._px : this._nx;
            return n ? n[(lx - ox * N_XZ) + ly * SY + lz * SZ] : SENTINEL;
        }
        if (ox === 0) {
            const n = oz > 0 ? this._pz : this._nz;
            return n ? n[lx + ly * SY + (lz - oz * N_XZ) * SZ] : SENTINEL;
        }
        const block = ox > 0 ? (oz > 0 ? this._cpp : this._cpn) : (oz > 0 ? this._cnp : this._cnn);
        if (!block) return SENTINEL;
        // Diagonal blocks hold the SMOOTH_REACH columns nearest this chunk.
        const bx = ox > 0 ? lx - N_XZ : lx + SMOOTH_REACH;
        const bz = oz > 0 ? lz - N_XZ : lz + SMOOTH_REACH;
        if (bx < 0 || bx >= SMOOTH_REACH || bz < 0 || bz >= SMOOTH_REACH) return SENTINEL;
        return block[(bx + bz * SMOOTH_REACH) * N_Y + ly];
    }

    _emitVoxel(sink, lx, ly, lz, id, s) {
        const occ = this.occ;
        if (!occ[this._read(lx, ly + 1, lz)]) this._emitPatch(sink, s.top, false, lx, ly, lz, id);
        if (!occ[this._read(lx, ly - 1, lz)]) this._emitPatch(sink, s.bot, true,  lx, ly, lz, id);
        for (const sd of SIDES) {
            if (!occ[this._read(lx + sd.dx, ly, lz + sd.dz)]) this._emitSide(sink, s, sd, lx, ly, lz, id);
        }
    }

    /**
     * One sampled patch, sharing vertices across its grid. `flip` = the bottom
     * surface (described upside down; surfaceGrid converts its heights back).
     */
    _emitPatch(sink, surf, flip, lx, ly, lz, id) {
        const g  = surfaceGrid(surf, flip, true);
        const us = g.us, vs = g.vs, nu = us.length - 1, nv = vs.length - 1, w = nu + 1;
        const h  = g.h, n = g.n;
        const m  = this.mesher;

        // Texture face from the patch's overall direction: the outward normal of
        // the plane through its corners — (−sx, 1, −sz) on top, (sx, −1, sz) below.
        const r0 = h[0], r1 = h[nu], r3 = h[nv * w], r2 = h[nv * w + nu];
        const sx = ((r1 + r2) - (r0 + r3)) / 2, sz = ((r3 + r2) - (r0 + r1)) / 2;
        const ni = flip ? closestFace(sx, -1, sz) : closestFace(-sx, 1, -sz);
        const layer = (ni === 2 ? m._layerTop : ni === 3 ? m._layerBottom : m._layerSide)[id];
        const cb = id * 18 + ni * 3;

        const base = (sink.pos.n / 3) | 0;
        for (let j = 0; j <= nv; j++) {
            const v = vs[j];
            for (let i = 0; i <= nu; i++) {
                const k = j * w + i, u = us[i], y = h[k];
                sink.pos.push3(lx + u, ly + y, lz + v);
                const b = brightness(n[k * 3], n[k * 3 + 1], n[k * 3 + 2]);
                if (layer >= 0) sink.col.push3(b, b, b);
                else            sink.col.push3(m._colors[cb] * b, m._colors[cb + 1] * b, m._colors[cb + 2] * b);
                sink.lay.push1(layer);
                // Same axis layout as GreedyMesher: ±Y (z, x), ±X (z, y), ±Z (x, y).
                if (ni === 2 || ni === 3)      sink.uv.push2(v, u);
                else if (ni === 0 || ni === 1) sink.uv.push2(v, y);
                else                           sink.uv.push2(u, y);
            }
        }

        // Two triangles per cell, split on the diagonal surfaceGrid chose (the
        // same split collision uses), wound to face up — or down for a bottom.
        const idx = sink.idx;
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                const a = base + j * w + i, b = a + 1, c = a + w, d = a + w + 1;   // 00 10 01 11
                if (g.diag[j * nu + i] === 0) {
                    if (flip) { idx.push3(a, b, d); idx.push3(a, d, c); }
                    else      { idx.push3(a, d, b); idx.push3(a, c, d); }
                } else {
                    if (flip) { idx.push3(a, b, c); idx.push3(b, d, c); }
                    else      { idx.push3(a, c, b); idx.push3(b, c, d); }
                }
            }
        }
    }

    /**
     * The strip on one open side, between the bottom and top edge curves. It
     * samples both edges through edgeSample, at every sample either one takes,
     * so it lies exactly on the lines the top and bottom patches draw there.
     */
    _emitSide(sink, s, sd, lx, ly, lz, id) {
        const e = sd.edge, alongZ = EDGE_AXIS[e] === 1;
        const top = s.top, bot = s.bot, ev = this._e;
        const P = top.sets[Math.max(top.elev[e], bot.elev[e])];   // nested: the finer set
        const segs = P.length - 1;
        // Fixed coordinate of this side.
        const fx = lx + (sd.dx > 0 ? 1 : 0), fz = lz + (sd.dz > 0 ? 1 : 0);

        // Heights along the side; skip it entirely if it has no height anywhere.
        const tH = this._stripT, bH = this._stripB;
        let any = false;
        for (let k = 0; k <= segs; k++) {
            edgeSample(top, e, P[k], ev); tH[k] = ev[0];
            edgeSample(bot, e, P[k], ev); bH[k] = 1 - ev[0];
            if (tH[k] > bH[k]) any = true;
        }
        if (!any) return;

        // A strip is one flat face: shared vertices, one normal, one texture.
        const ni = sd.dx > 0 ? 0 : sd.dx < 0 ? 1 : sd.dz > 0 ? 4 : 5;
        const m = this.mesher, layer = m._layerSide[id], b = FACE_BRIGHTNESS[ni];
        const cb = id * 18 + ni * 3;
        const r = layer >= 0 ? b : m._colors[cb] * b;
        const g = layer >= 0 ? b : m._colors[cb + 1] * b;
        const bl = layer >= 0 ? b : m._colors[cb + 2] * b;

        const base = (sink.pos.n / 3) | 0;
        for (let k = 0; k <= segs; k++) {
            const p = P[k];
            const X = alongZ ? fx : lx + p, Z = alongZ ? lz + p : fz;
            for (let top1 = 0; top1 < 2; top1++) {
                const h = top1 ? tH[k] : bH[k];
                sink.pos.push3(X, ly + h, Z);
                sink.col.push3(r, g, bl);
                sink.lay.push1(layer);
                if (alongZ) sink.uv.push2(Z - lz, h);   // ±X: (z, y)
                else        sink.uv.push2(X - lx, h);   // ±Z: (x, y)
            }
        }

        // Vertex 2k = bottom, 2k+1 = top. Walking along +z the quads naturally
        // face −x, walking along +x they face +z; flip where the side faces the
        // other way. A zero-height end turns its half of the quad degenerate.
        const flip = alongZ ? sd.dx > 0 : sd.dz < 0;
        const idx = sink.idx;
        for (let k = 1; k <= segs; k++) {
            const b0 = base + 2 * (k - 1), t0 = b0 + 1, b1 = base + 2 * k, t1 = b1 + 1;
            if (tH[k] > bH[k]) {
                if (flip) idx.push3(b0, t1, b1); else idx.push3(b0, b1, t1);
            }
            if (tH[k - 1] > bH[k - 1]) {
                if (flip) idx.push3(b0, t0, t1); else idx.push3(b0, t1, t0);
            }
        }
    }
}
