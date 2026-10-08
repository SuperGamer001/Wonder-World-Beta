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
 *     and emitted here: a sampled top patch, a sampled bottom patch, and a
 *     strip on each open side between the two. On a diagonal slope a top
 *     patch dips below its own voxel into the one it stands on (see
 *     "Diagonal steps" in SmoothShape.js); that one stays a cube here, since
 *     every face of it beside
 *     the dip is against more ground and is never drawn by the greedy pass.
 *   • Where two columns do not draw the same line along the edge between them
 *     (one is a wall, or pinned by a Solid block), the higher one's side shows
 *     above the lower one's edge. The lower one's top voxel draws that wall
 *     (_emitWall), up to the top of its own level; from there up the higher
 *     column's own faces and strips take over.
 *   • Every Mesh voxel hides faces drawn against it (`occ`). See
 *     buildOccluderTable for why that is safe even for deformed ones.
 *
 * Patches are shaded smoothly: each vertex carries the surface normal at that
 * point (GreedyMesher's signed-byte `normals`), neighbouring patches compute
 * the same normal along a shared side, and the chunk shader lights every
 * pixel from the interpolated normal. The texture is chosen once per patch, from the face (top,
 * bottom or a side) closest to the patch's overall direction, so a curved
 * slope never switches texture half way across a block.
 *
 * A top patch of natural ground also carries its blend code (GreedyMesher
 * blendCode): which neighbouring ground spreads over its edges. The chunk
 * shader draws that from the code and the position inside the voxel, so the
 * patch's own triangles — the ones collision uses — do not change.
 *
 * Coordinates are chunk-local. Reads reach SMOOTH_REACH voxels past the chunk
 * on X/Z: into the four face neighbours, and into a SMOOTH_REACH-square block
 * of columns from each diagonal chunk.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME } from '../engine/ChunkData.js';
import { FACE_NORMAL8 } from './GreedyMesher.js';
import {
    KIND_EMPTY, KIND_MESH, SENTINEL, SMOOTH_REACH, SMOOTH_SPREAD, SMOOTH_SAMPLES,
    EDGE_A, EDGE_B, CORNER_U, CORNER_V,
    SmoothField, buildKindTable, buildOccluderTable, describeVoxel, isDeformed, newShape,
    edgeSample, surfaceGrid, gridHeightAt,
} from '../engine/SmoothShape.js';

const N_XZ = CHUNK_SIZE;
const N_Y  = CHUNK_SIZE_Y;
const SY   = CHUNK_SIZE;
const SZ   = CHUNK_SIZE * CHUNK_SIZE_Y;

// The four sides: neighbour offset, and the patch edge lying on that side.
const SIDES = [
    { dx:  1, dz:  0, edge: 3 },   // +X  (u = 1)
    { dx: -1, dz:  0, edge: 2 },   // -X  (u = 0)
    { dx:  0, dz:  1, edge: 1 },   // +Z  (v = 1)
    { dx:  0, dz: -1, edge: 0 },   // -Z  (v = 0)
];

/** A normal component (-1..1) as a signed byte, as GreedyMesher stores them. */
const n8 = (v) => Math.round((v > 1 ? 1 : v < -1 ? -1 : v) * 127);

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
        // chunk (corners at 0..16, slopes one line further) — and, for tops,
        // SMOOTH_SPREAD more for the lean of each of those — at any level of
        // the column plus a few either side of the world.
        const get     = (x, y, z) => this._read(x, y, z);
        this._get     = get;
        const span    = CHUNK_SIZE + 3, far = SMOOTH_SPREAD, wide = span + 2 * far;
        this.field    = new SmoothField(this.kind, get, false, { x0: -1 - far, z0: -1 - far, nx: wide, nz: wide, y0: -8, ny: N_Y + 16 });
        this.flipped  = new SmoothField(this.kind, get, true,  { x0: -1, z0: -1, nx: span, nz: span, y0: -N_Y - 8, ny: N_Y + 16 });
        this._shape   = newShape();
        this._shape2  = newShape();   // the ground beside the voxel being emitted
        this._e       = new Float64Array(2);
        // Room for a strip's samples, and one more between each pair (a wall
        // is cut off at the top of its level: see _emitWall).
        const most    = SMOOTH_SAMPLES[SMOOTH_SAMPLES.length - 1].length * 2;
        this._stripT  = new Float64Array(most);
        this._stripB  = new Float64Array(most);
        this._stripP  = new Float64Array(most);

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
     * @returns {{ occ, partial, emit(sink), read(lx, ly, lz) }} context for GreedyMesher.meshGroup
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
        const kind = this.kind, partial = this.partial, s = this._shape;
        partial.fill(0);

        const yMin = Math.max(0, yRange?.min ?? 0);
        const yMax = Math.min(N_Y - 1, yRange?.max ?? N_Y - 1);
        // Memos for the levels this chunk has ground on, and a few either side.
        this.field.rebase(yMin - 8, yMax + 8);
        this.flipped.rebase(-1 - yMax - 8, -1 - yMin + 8);

        // Deformed voxels as flat (lx, ly, lz, id) records. Only their corners
        // are looked at here; the shapes are worked out when they are emitted.
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
                    if (!isDeformed(this.field, this.flipped, lx, ly, lz)) continue;
                    partial[row + lx] = 1;
                    list.push(lx, ly, lz, id);
                }
            }
        }

        return {
            occ: this.occ,
            partial,
            read: this._get,
            emit: (sink) => {
                for (let i = 0; i < list.length; i += 4) {
                    describeVoxel(this.field, this.flipped, list[i], list[i + 1], list[i + 2], s);
                    this._emitVoxel(sink, list[i], list[i + 1], list[i + 2], list[i + 3], s);
                }
            },
        };
    }

    isMesh(id) { return this.kind[id] === KIND_MESH; }

    /**
     * Height, as a fraction of the voxel, of the top surface at the centre of
     * the Mesh voxel at (lx, ly, lz): 1 for a full cube. Exactly what the
     * collider (SmoothTerrain) reports there. Reads this job's memos, so it
     * must follow prepare() for the same chunk.
     */
    topHeight(lx, ly, lz) {
        const s = this._shape;
        if (!describeVoxel(this.field, this.flipped, lx, ly, lz, s)) return 1;
        return gridHeightAt(surfaceGrid(s.top, false), 0.5, 0.5);
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
        const above = this._read(lx, ly + 1, lz);
        // (The bottom of a thin sheet is split into triangles as its top is.)
        const g = occ[above] ? null : this._emitPatch(sink, s.top, false, lx, ly, lz, id, null);
        if (!occ[this._read(lx, ly - 1, lz)]) this._emitPatch(sink, s.bot, true,  lx, ly, lz, id, g);
        const surface = this.kind[above] === KIND_EMPTY;
        for (const sd of SIDES) {
            const nid = this._read(lx + sd.dx, ly, lz + sd.dz);
            if (!occ[nid]) this._emitSide(sink, s, sd, lx, ly, lz, id);
            if (surface)   this._emitWall(sink, s, sd, lx, ly, lz, nid);
        }
    }

    /**
     * One sampled patch, sharing vertices across its grid. `flip` = the bottom
     * surface (described upside down; surfaceGrid converts its heights back).
     * Returns its grid; `like` is the grid of the voxel's other surface.
     */
    _emitPatch(sink, surf, flip, lx, ly, lz, id, like) {
        const g  = surfaceGrid(surf, flip, true, like);
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
        // Textured: the blend bytes (MeshFormat.js) — on a top patch showing
        // its top texture, the ground that spreads over its edges.
        const code = layer >= 0 && ni === 2 && m._blend[id] !== 0 ? m.blendCode(this._get, lx, ly, lz, id) : 0;
        const cr  = layer >= 0 ? (code >>> 8) / 255 : m._colors[cb];
        const cg  = layer >= 0 ? (code & 255) / 255 : m._colors[cb + 1];
        const cbl = layer >= 0 ? m._natural[id]     : m._colors[cb + 2];
        const glow = m._glow[id];

        const base = (sink.pos.n / 3) | 0;
        for (let j = 0; j <= nv; j++) {
            const v = vs[j];
            for (let i = 0; i <= nu; i++) {
                const k = j * w + i, u = us[i], y = h[k];
                sink.pos.push3(lx + u, ly + y, lz + v);
                sink.col.push3(cr, cg, cbl);
                sink.nrm.push4(n8(n[k * 3]), n8(n[k * 3 + 1]), n8(n[k * 3 + 2]), glow);
                sink.lay.push1(layer);
                // Same axis layout as GreedyMesher: ±Y (z, x), ±X (z, y), ±Z (x, y).
                // Heights go two tiles up: a top that leans can be below its
                // voxel, and a texture coordinate cannot be below 0.
                if (ni === 2 || ni === 3)      sink.uv.push2(v, u);
                else if (ni === 0 || ni === 1) sink.uv.push2(v, y + 2);
                else                           sink.uv.push2(u, y + 2);
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
        return g;
    }

    /**
     * The strip on one open side, between the bottom and top edge curves. It
     * samples both edges through edgeSample, at every sample either one takes,
     * so it lies exactly on the lines the top and bottom patches draw there.
     */
    _emitSide(sink, s, sd, lx, ly, lz, id) {
        const e = sd.edge;
        const top = s.top, bot = s.bot, ev = this._e;
        const P = top.sets[Math.max(top.elev[e], bot.elev[e])];   // nested: the finer set
        const segs = P.length - 1;

        // Heights along the side; skip it entirely if it has no height anywhere.
        const tH = this._stripT, bH = this._stripB;
        let any = false;
        for (let k = 0; k <= segs; k++) {
            edgeSample(top, e, P[k], ev); tH[k] = ev[0];
            edgeSample(bot, e, P[k], ev); bH[k] = 1 - ev[0];
            if (tH[k] > bH[k]) any = true;
        }
        if (any) this._strip(sink, sd, lx, ly, lz, P, P.length, bH, tH, true, id);
    }

    /**
     * The wall of the ground beside a top voxel, on the side `sd`: whatever of
     * the next column stands above this voxel's top edge there, up to the top
     * of this voxel's level (above that this column is air, and the other one
     * draws its own side). Nothing when the two columns draw the same line
     * along the edge, which is what a slope is made of.
     *
     * @param nid the block across that side, on this level
     */
    _emitWall(sink, s, sd, lx, ly, lz, nid) {
        const kind = this.kind, nk = kind[nid];
        if (nk !== KIND_EMPTY && nk !== KIND_MESH) return;
        const e = sd.edge, top = s.top;
        const a = EDGE_A[e], b = EDGE_B[e];
        const ca = top.c[a], cb = top.c[b];
        const nx = lx + sd.dx, nz = lz + sd.dz;

        // Which voxel of that column the wall is the side of, the highest it
        // can show (in this voxel's heights), and that column's own top voxel
        // within reach, if it has one (sy; NaN: it goes on up, or is built on).
        let wallId = nid, cap = 1, sy = NaN;
        if (nk === KIND_EMPTY) {
            // Air beside: only below this voxel's own floor, where it dips.
            if (ca >= 0 && cb >= 0) return;
            sy = ly - 1; cap = 0;
            wallId = this._read(nx, sy, nz);
            if (kind[wallId] !== KIND_MESH) return;
        } else {
            if (ca >= 1 && cb >= 1) return;                   // this edge is at full height: nothing shows over it
            const u1 = kind[this._read(nx, ly + 1, nz)];
            if (u1 === KIND_EMPTY) return;                    // a top voxel on this level: it shares the edge
            if (u1 === KIND_MESH) {
                const u2 = kind[this._read(nx, ly + 2, nz)];
                if (u2 === KIND_EMPTY) sy = ly + 1;
                else if (u2 === KIND_MESH && kind[this._read(nx, ly + 3, nz)] === KIND_EMPTY) sy = ly + 2;
            }
        }

        const eo = e ^ 1;        // the same lattice edge, as the voxel across it numbers it
        let other = null, off = 0;
        if (sy === sy) {
            off = sy - ly;
            const f = this.field;
            // One line from both sides: the same ends, and the same rule for
            // what runs between them (a sheet with air under it is straight).
            if (f.top(lx + CORNER_U[a], sy, lz + CORNER_V[a]) + off === ca &&
                f.top(lx + CORNER_U[b], sy, lz + CORNER_V[b]) + off === cb &&
                top.thin[e] === 0 && kind[this._read(nx, sy - 1, nz)] !== KIND_EMPTY) return;
            if (describeVoxel(f, this.flipped, nx, sy, nz, this._shape2)) other = this._shape2.top;
        }

        // Both lines at every sample either takes — and where the other
        // column's line passes the top of this level, a sample exactly there:
        // cut off sample by sample, the wall would lose the corner between.
        const S = top.sets[other ? Math.max(top.elev[e], other.elev[eo]) : top.elev[e]];
        const P = this._stripP, lo = this._stripB, hi = this._stripT, ev = this._e;
        let n = 0, any = false, pl = 0, ll = 0, hl = 0;
        for (let k = 0; k < S.length; k++) {
            const p = S[k];
            edgeSample(top, e, p, ev);
            const l = ev[0];
            let h = cap;
            if (other) { edgeSample(other, eo, p, ev); h = ev[0] + off; }
            else if (sy === sy) h = 1 + off;                  // a whole block
            if (k > 0 && (hl - cap) * (h - cap) < 0) {
                const q = (cap - hl) / (h - hl);
                P[n] = pl + (p - pl) * q; lo[n] = ll + (l - ll) * q; hi[n] = cap;
                if (hi[n] > lo[n]) any = true;
                n++;
            }
            P[n] = p; lo[n] = l; hi[n] = h > cap ? cap : h;
            if (hi[n] > lo[n]) any = true;
            n++;
            pl = p; ll = l; hl = h;
        }
        if (any) this._strip(sink, sd, lx, ly, lz, P, n, lo, hi, false, wallId);
    }

    /**
     * A flat strip on the side `sd` of voxel (lx, ly, lz), between the heights
     * lo[k] and hi[k] at the `n` samples P[k], drawn only where hi is above lo: a
     * stretch where the two cross ends exactly on the crossing, which lies on
     * both lines, so it leaves no crack against the patches that draw them.
     * `outward`: it faces away from the voxel (the voxel's own side) — or back
     * at it (the wall of the ground beside it). One normal, one texture: the
     * side of block `id`.
     */
    _strip(sink, sd, lx, ly, lz, P, n, lo, hi, outward, id) {
        const alongZ = sd.dx !== 0;
        const fx = lx + (sd.dx > 0 ? 1 : 0), fz = lz + (sd.dz > 0 ? 1 : 0);
        const out = sd.dx > 0 ? 0 : sd.dx < 0 ? 1 : sd.dz > 0 ? 4 : 5;
        const ni = outward ? out : out ^ 1;
        const m = this.mesher, layer = m._layerSide[id];
        const cb = id * 18 + ni * 3;
        const r  = layer >= 0 ? 0 : m._colors[cb];
        const g  = layer >= 0 ? 0 : m._colors[cb + 1];
        const bl = layer >= 0 ? m._natural[id] : m._colors[cb + 2];
        const fn = FACE_NORMAL8[ni], glow = m._glow[id];
        // Walking along +z a quad wound (low, low, high) faces −x, along +x it
        // faces +z; turn it where the strip faces the other way.
        const turn = (alongZ ? sd.dx > 0 : sd.dz < 0) === outward;

        const put = (p, h) => {
            sink.pos.push3(alongZ ? fx : lx + p, ly + h, alongZ ? lz + p : fz);
            sink.col.push3(r, g, bl);
            sink.nrm.push4(fn[0], fn[1], fn[2], glow);
            sink.lay.push1(layer);
            sink.uv.push2(p, h + 2);       // ±X: (z, y), ±Z: (x, y); two tiles up, as in _emitPatch
        };
        const idx = sink.idx;
        for (let k = 1; k < n; k++) {
            const p0 = P[k - 1], p1 = P[k];
            const d0 = hi[k - 1] - lo[k - 1], d1 = hi[k] - lo[k];
            if (d0 <= 0 && d1 <= 0) continue;
            const v = (sink.pos.n / 3) | 0;
            if (d0 > 0 && d1 > 0) {
                put(p0, lo[k - 1]); put(p0, hi[k - 1]); put(p1, lo[k]); put(p1, hi[k]);   // b0 t0 b1 t1
                if (turn) { idx.push3(v, v + 3, v + 2); idx.push3(v, v + 1, v + 3); }
                else      { idx.push3(v, v + 2, v + 3); idx.push3(v, v + 3, v + 1); }
                continue;
            }
            // One end has no height: a triangle from the other end to where the lines cross.
            const q = d0 / (d0 - d1), pc = p0 + (p1 - p0) * q, hc = lo[k - 1] + (lo[k] - lo[k - 1]) * q;
            if (d0 > 0) {
                put(p0, lo[k - 1]); put(p0, hi[k - 1]); put(pc, hc);                     // b0 t0 c
                if (turn) idx.push3(v, v + 1, v + 2); else idx.push3(v, v + 2, v + 1);
            } else {
                put(pc, hc); put(p1, lo[k]); put(p1, hi[k]);                             // c b1 t1
                if (turn) idx.push3(v, v + 2, v + 1); else idx.push3(v, v + 1, v + 2);
            }
        }
    }
}
