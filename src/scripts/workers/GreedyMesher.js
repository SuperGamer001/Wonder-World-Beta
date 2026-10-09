/**
 * Greedy Mesher
 *
 * Converts a 16×CHUNK_SIZE_Y×16 voxel chunk column (plus its four horizontal
 * neighbours for boundary face visibility) into two compact triangle meshes:
 *   • opaque       — opaque blocks, and the see-through blocks drawn as
 *                    cutouts (leaves, glass: BlockRegistry `render`), whose
 *                    texels are either there or not. They write depth like
 *                    everything else here, so nothing in this mesh needs sorting.
 *   • transparent  — what is blended over the scene: water and ice. Each face
 *                    goes in twice, once facing each way, and the mesh is drawn
 *                    with back faces culled; its triangles are put in an order
 *                    that is back to front from wherever it is seen (see
 *                    _orderTranslucent).
 *
 * Because chunks span the full world height there are no vertical chunk
 * boundaries.  Only four horizontal neighbours are needed (±X, ±Z).
 * Y values outside [0, CHUNK_SIZE_Y) are treated as solid (SOLID_SENTINEL) so
 * faces at the world's top and bottom edges are culled.
 *
 * Algorithm summary per face direction:
 *   1. Build a mask for each perpendicular slice.
 *      mask[u][v] = blockID if the face between voxel (u,v) and its neighbour
 *      in the face direction is visible, otherwise 0.
 *   2. Walk the mask and expand each non-zero run into the largest rectangle
 *      of the same blockID (greedy merge in v first, then u).
 *   3. Emit one quad per rectangle.
 *
 * Performance notes — this is the hottest code in the engine:
 *   • The cells that can have a face are found sixteen at a time from two
 *     words a row (_buildRows); only those are read, with the block they
 *     face. (Reading every voxel and its neighbour for each of the six
 *     directions was roughly 2.3M reads per full chunk mesh.)
 *   • Solidity is a prebuilt Uint8Array lookup instead of a registry call.
 *   • Output goes straight into growable typed arrays; no JS array boxing and
 *     no final Array→Float32Array copy.
 *
 * Every vertex carries its surface normal as four signed bytes (`normals`:
 * x, y, z × 127, then the block's glow × 127). The chunk shader lights each
 * pixel from it — sun, sky, block light — so vertex colour is the plain block
 * colour, with no light baked in, and smooth terrain, whose normals vary
 * across a patch, is shaded smoothly rather than per triangle.
 *
 * Blocks with a model (torches, lanterns — BlockRegistry `model`) are not
 * greedy-meshed: they are skipped here and drawn by BlockModels.js, and they
 * never hide a neighbour's face.
 *
 * The opaque mesh's triangles are put in order of section — sixteen levels of
 * the column each — so that the sections the camera cannot see (most of a
 * chunk's triangles are cave walls) are left out of the draw as one range of
 * indices: engine/Visibility.js. A face belongs to the section of the cell in
 * front of it, the one it is seen from, and no quad spans two sections.
 *
 * A textured face has no colour of its own, so its three colour bytes carry
 * something else (engine/MeshFormat.js): which neighbouring ground spreads
 * over this face's edges and from which sides (blendCode, smooth worlds), and
 * whether it is natural ground at all.
 *
 * Chunk dimensions:  DIM = [16, CHUNK_SIZE_Y, 16]  (X, Y, Z)
 *
 * Face-axis / u-axis / v-axis mapping:
 *   X faces  (±X): faceAxis=0, uAxis=1 (Y),  vAxis=2 (Z)
 *   Y faces  (±Y): faceAxis=1, uAxis=2 (Z),  vAxis=0 (X)
 *   Z faces  (±Z): faceAxis=2, uAxis=0 (X),  vAxis=1 (Y)
 *
 * Winding order (Three.js CCW = front-face):
 *   Positive face (+X/+Y/+Z): indices 0,1,2  0,2,3
 *   Negative face (-X/-Y/-Z): indices 0,2,1  0,3,2
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y } from '../engine/ChunkData.js';
import { emitModel, isModel } from './BlockModels.js';
import { packTints, packUVs, packIndices } from '../engine/MeshFormat.js';
import { SECTIONS, SECTION_SHIFT, SECTION_SIZE } from '../engine/Visibility.js';

const N_XZ = CHUNK_SIZE;
const N_Y  = CHUNK_SIZE_Y;

// Strides for the flat voxel index: lx + ly*SY + lz*SZ
const SY = CHUNK_SIZE;
const SZ = CHUNK_SIZE * CHUNK_SIZE_Y;

// DIM[axis] = number of voxels along that axis
const DIM = [N_XZ, N_Y, N_XZ];

// Returned for reads outside the world vertically, or toward an unloaded
// neighbour: treated as solid so the face is culled.
const SOLID_SENTINEL = 0xFFFF;

// Face normals as signed bytes (x, y, z × 127): +X -X +Y -Y +Z -Z.
export const FACE_NORMAL8 = [[127, 0, 0], [-127, 0, 0], [0, 127, 0], [0, -127, 0], [0, 0, 127], [0, 0, -127]];

// faceAxis, uAxis, vAxis, isPositive, normalIndex
const FACE_DEFS = [
    { faceAxis: 0, uAxis: 1, vAxis: 2, positive: true,  ni: 0 }, // +X
    { faceAxis: 0, uAxis: 1, vAxis: 2, positive: false, ni: 1 }, // -X
    { faceAxis: 1, uAxis: 2, vAxis: 0, positive: true,  ni: 2 }, // +Y
    { faceAxis: 1, uAxis: 2, vAxis: 0, positive: false, ni: 3 }, // -Y
    { faceAxis: 2, uAxis: 0, vAxis: 1, positive: true,  ni: 4 }, // +Z
    { faceAxis: 2, uAxis: 0, vAxis: 1, positive: false, ni: 5 }, // -Z
];

/**
 * Append-only Float32Array that doubles when full.
 * Replaces `[].push(...)` + `new Float32Array(arr)` in the quad emit path.
 * Each mesher keeps its buffers across jobs (see _resetSink), so after the
 * first few chunks they are already big enough and never grow again.
 */
class F32Buf {
    constructor(cap = 4096) { this.a = new Float32Array(cap); this.n = 0; }
    _fit(extra) {
        if (this.n + extra <= this.a.length) return;
        let cap = this.a.length || 1;
        while (cap < this.n + extra) cap *= 2;
        const next = new Float32Array(cap);
        next.set(this.a.subarray(0, this.n));
        this.a = next;
    }
    /** Make room for `extra` values and return the backing array to write into from `n`. */
    reserve(extra)    { this._fit(extra); return this.a; }
    push1(x)          { this._fit(1); this.a[this.n++] = x; }
    push2(x, y)       { this._fit(2); const a = this.a; a[this.n++] = x; a[this.n++] = y; }
    push3(x, y, z)    { this._fit(3); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
    /** Exact-length copy for transfer to the main thread. */
    trim()            { return this.a.slice(0, this.n); }
}

/** Same, for the signed-byte normals (four per vertex). */
export class I8Buf {
    constructor(cap = 4096) { this.a = new Int8Array(cap); this.n = 0; }
    _fit(extra) {
        if (this.n + extra <= this.a.length) return;
        let cap = this.a.length || 1;
        while (cap < this.n + extra) cap *= 2;
        const next = new Int8Array(cap);
        next.set(this.a.subarray(0, this.n));
        this.a = next;
    }
    reserve(extra) { this._fit(extra); return this.a; }
    push4(x, y, z, w) {
        this._fit(4);
        const a = this.a;
        a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; a[this.n++] = w;
    }
    trim() { return this.a.slice(0, this.n); }
}

/** Same, for Uint32 indices. */
class U32Buf {
    constructor(cap = 4096) { this.a = new Uint32Array(cap); this.n = 0; }
    _fit(extra) {
        if (this.n + extra <= this.a.length) return;
        let cap = this.a.length || 1;
        while (cap < this.n + extra) cap *= 2;
        const next = new Uint32Array(cap);
        next.set(this.a.subarray(0, this.n));
        this.a = next;
    }
    reserve(extra) { this._fit(extra); return this.a; }
    push6(a0, b0, c0, d0, e0, f0) {
        this._fit(6);
        const a = this.a;
        a[this.n++] = a0; a[this.n++] = b0; a[this.n++] = c0;
        a[this.n++] = d0; a[this.n++] = e0; a[this.n++] = f0;
    }
    push3(a0, b0, c0) {
        this._fit(3);
        const a = this.a;
        a[this.n++] = a0; a[this.n++] = b0; a[this.n++] = c0;
    }
    push2(a0, b0) {
        this._fit(2);
        const a = this.a;
        a[this.n++] = a0; a[this.n++] = b0;
    }
    trim() { return this.a.slice(0, this.n); }
}

/**
 * One mesh's worth of output buffers. `sec` notes which section the indices
 * belong to, as runs — (first index, section) each time it changes
 * (markSection) — for _sortSections.
 */
function _newSink() {
    return { pos: new F32Buf(), col: new F32Buf(), uv: new F32Buf(), lay: new F32Buf(), nrm: new I8Buf(), idx: new U32Buf(),
             sec: new U32Buf(256), secCur: -1 };
}

function _resetSink(s) {
    s.pos.n = 0; s.col.n = 0; s.uv.n = 0; s.lay.n = 0; s.nrm.n = 0; s.idx.n = 0;
    s.sec.n = 0; s.secCur = -1;
    return s;
}

/**
 * The triangles `sink` is given from here on belong to `section` (a local Y
 * >> SECTION_SHIFT): the section of the open cell they are seen from. Called
 * by everything that writes to the opaque sink, before it writes.
 */
export function markSection(sink, section) {
    if (sink.secCur === section) return;
    sink.secCur = section;
    sink.sec.push2(sink.idx.n, section);
}

// The arrays that leave the worker, packed as engine/MeshFormat.js describes.
// The sinks stay float while a mesh is being built — the emit paths write
// whole quads into them — and are packed once, here.
function _sinkArrays(s) {
    const verts = s.lay.n;
    return {
        positions: s.pos.trim(),
        tints:     packTints(s.col.a, s.lay.a, verts),
        uvs:       packUVs(s.uv.a, s.uv.n),
        normals:   s.nrm.trim(),
        indices:   packIndices(s.idx.a, s.idx.n, verts),
    };
}

// Flat-index stride of each axis (X, Y, Z).
const STRIDE = [1, SY, SZ];

/**
 * Where a translucent quad goes in its mesh's draw order (lower first). See
 * _orderTranslucent: horizontal faces, then those across x, then across z;
 * within each, the faces turned toward + by rising position, then the ones
 * turned toward − by falling position.
 */
function _translucentKey(faceAxis, facesPositive, plane) {
    const family = faceAxis === 1 ? 0 : faceAxis === 0 ? 1 : 2;
    return family * 4096 + (facesPositive ? plane : 2048 - plane);
}

// The eight columns around a voxel, in the order of a blend code's bits:
// −x, +x, −z, +z, then the corners (−x−z, +x−z, −x+z, +x+z).
const BLEND_DX = [-1, 1, 0, 0, -1, 1, -1, 1];
const BLEND_DZ = [0, 0, -1, 1, -1, -1, 1, 1];

export class GreedyMesher {
    /**
     * @param {BlockRegistry} blockRegistry
     * @param {Object} blockFaceMap  { blockId: { top, side, bottom } } — texture layer indices.
     *   A value of -1 (or missing entry) means use vertex color for that block.
     */
    constructor(blockRegistry, blockFaceMap = {}) {
        this.reg          = blockRegistry;
        this.blockFaceMap = blockFaceMap;

        this._buildTables();

        // Scratch reused across jobs (a worker meshes one chunk at a time).
        // Masks hold block ids, which are 16-bit; sized for the largest slice.
        // The opaque one is 32-bit: a top face's blend code rides in the high
        // half, so faces only merge with faces that blend the same way.
        const maxSlice = N_XZ * N_Y;
        this._mask   = new Uint32Array(maxSlice);
        this._maskT  = new Uint16Array(maxSlice);
        this._opaque = _newSink();
        this._transp = _newSink();
        // The transparent mesh's quads, three numbers each: sort key, first
        // vertex, and which way it faces (_orderTranslucent).
        this._tq     = new U32Buf(256);
        this._nb     = new Uint16Array(8);
        // Which cells of each row of sixteen along x can have a face, and
        // which hide one drawn against them (_buildRows), and the same for the
        // cells of the four neighbouring chunks that touch this one.
        this._rowSrc = new Uint16Array(N_Y * N_XZ);
        this._rowOcc = new Uint16Array(N_Y * N_XZ);
        this._rowClosed = new Uint16Array(N_Y * N_XZ);     // closedRows()
        this._edgePX = new Uint8Array(N_Y * N_XZ);
        this._edgeNX = new Uint8Array(N_Y * N_XZ);
        this._edgePZ = new Uint16Array(N_Y);
        this._edgeNZ = new Uint16Array(N_Y);
        // The cells of one slice that are looked at (_sweepFace): voxel index, u, v.
        this._cSrc = new Int32Array(maxSlice);
        this._cU   = new Uint16Array(maxSlice);
        this._cV   = new Uint16Array(maxSlice);
        // _sortSections: the indices in their new order (swapped with the
        // opaque sink's each job), and where each section's go.
        this._idxSorted = new U32Buf();
        this._secFill   = new Uint32Array(SECTIONS);
    }

    /**
     * Flatten the registry into typed lookup tables.
     *
     * `_solid` is indexed on the hot path (twice per voxel, ~2.3M reads per full
     * chunk mesh) so it is allocated across the whole 16-bit id space — 64 KB —
     * to keep the lookup branch-free even for the SOLID_SENTINEL value.
     *
     * The colour and texture-layer tables are only read once per emitted quad,
     * so they are sized to the registry and indexed by ids that came out of the
     * mask (always real, registered block ids).
     *
     * See-through blocks that draw their own faces are `_cutout` (leaves,
     * glass: into the opaque mesh) or `_glassy` (water, ice: the transparent
     * one). `_airLike` is what a translucent face shows against besides a
     * cutout: air, and model blocks like torches, which do not fill their
     * voxel. All three are read only off the opaque branch of the mask fill.
     *
     * `_blend` is the block's `blend` (how readily natural ground spreads over
     * its neighbours' edges, 0 = takes no part) and `_natural` 1 for the
     * blocks that have one.
     */
    _buildTables() {
        const ids = this.reg.serialize().map(b => b.id);
        const maxId = ids.length ? Math.max(...ids) : 0;
        const n = maxId + 1;

        this._solid       = new Uint8Array(65536);
        this._glassy      = new Uint8Array(65536);
        this._cutout      = new Uint8Array(65536);
        this._airLike     = new Uint8Array(65536);
        this._blend       = new Uint8Array(65536);
        this._natural     = new Float32Array(n);
        this._anyBlend    = false;
        this._model       = new Uint8Array(65536);
        this._modelDef    = [];
        this._layerTop    = new Int16Array(n).fill(-1);
        this._layerSide   = new Int16Array(n).fill(-1);
        this._layerBottom = new Int16Array(n).fill(-1);
        // colors[id*18 + ni*3 + c] — per-face RGB for all six faces.
        this._colors      = new Float32Array(n * 18);
        // glow[id] — full-bright share, 0..127, written into each vertex's normal.w
        this._glow        = new Int8Array(n);
        // light[id] — block light given off, 0..15 (Blocklight.js)
        this._light       = new Uint8Array(65536);
        this._airLike[0]  = 1;

        for (const id of ids) {
            const block = this.reg.get(id);
            if (!block) continue;
            this._solid[id] = this.reg.isSolid(id) ? 1 : 0;
            this._glow[id]  = Math.round((block.glow ?? 0) * 127);
            this._light[id] = block.light ?? 0;
            if (block.model && isModel(block.model)) {
                this._model[id]    = 1;
                this._airLike[id]  = 1;
                this._modelDef[id] = { model: block.model, facing: block.facing ?? null };
            } else if (id !== 0 && !this._solid[id]) {
                if (block.render === 'cutout') this._cutout[id] = 1;
                else this._glassy[id] = 1;
            }
            if (this._solid[id] && block.terrainType === 'mesh' && block.blend > 0) {
                this._blend[id] = block.blend;
                this._natural[id] = 1;
                this._anyBlend = true;
            }

            const fe = this.blockFaceMap[id];
            if (fe) {
                const top = fe.top ?? -1;
                this._layerTop[id]    = top;
                this._layerSide[id]   = fe.side   ?? top;
                this._layerBottom[id] = fe.bottom ?? top;
            }

            for (let ni = 0; ni < 6; ni++) {
                const c = this._faceColor(block, ni);
                const base = id * 18 + ni * 3;
                this._colors[base]     = c[0];
                this._colors[base + 1] = c[1];
                this._colors[base + 2] = c[2];
            }
        }

        // SOLID_SENTINEL stands in for "outside the world" and must cull faces.
        this._solid[SOLID_SENTINEL] = 1;
    }

    /**
     * Mesh only the face directions listed in `faceDefIndices` (0–5 indices into FACE_DEFS).
     *   0=+X  1=-X  2=+Y  3=-Y  4=+Z  5=-Z
     *
     * Use [2,3]       for top/bottom (±Y) faces — permanent; never changes on neighbour load.
     * Use [0,1,4,5]   for side (±X, ±Z) faces  — updated when a horizontal neighbour loads.
     *
     * @param {{min:number,max:number}} [yRange] local-Y band that contains blocks.
     *   Faces only exist on solid voxels, so sweeping outside this band can never
     *   produce geometry. Skipping the empty sky is most of a 448-tall column.
     * @param {object} [smooth] smooth-terrain context from SmoothMesher.prepare():
     *   { occ, partial, emit, read }. `occ` replaces the solidity table for the
     *   neighbour test (Mesh blocks hide faces against them), `partial` marks
     *   deformed Mesh voxels the greedy pass must leave alone, `emit(sink)`
     *   appends their custom geometry to the opaque output, and `read(lx, ly,
     *   lz)` reads a voxel up to a block past the chunk on every side — with
     *   it, the tops of natural ground carry their blend code. Omitted in
     *   blocky worlds, where behaviour is exactly as before.
     * @param {boolean} [models] the chunk may hold model blocks (torches,
     *   lanterns): look for them and draw them. worldWorker knows from the
     *   chunk's palette (hasModels), so chunks without any skip the scan.
     */
    meshGroup(voxels, neighbors, faceDefIndices, yRange, smooth = null, models = false) {
        const opaque = _resetSink(this._opaque);
        const transp = _resetSink(this._transp);
        this._tq.n = 0;

        const yMin = Math.max(0,       (yRange?.min ?? 0) | 0);
        const yMax = Math.min(N_Y - 1, (yRange?.max ?? (N_Y - 1)) | 0);

        // Resolve neighbour arrays once instead of building a "dx,dz" key string
        // inside the innermost loop.
        const nbr = {
            px: neighbors?.['1,0']  ?? null,
            nx: neighbors?.['-1,0'] ?? null,
            pz: neighbors?.['0,1']  ?? null,
            nz: neighbors?.['0,-1'] ?? null,
        };

        if (yMax >= yMin) {
            // The masks are all zero between slices (a merge clears what it
            // takes); this is for a job that stopped half way.
            this._mask.fill(0);
            this._maskT.fill(0);
            this._buildRows(voxels, nbr, yMin, yMax, smooth ? smooth.occ : this._solid, smooth ? smooth.partial : null);
            for (const i of faceDefIndices) {
                this._sweepFace(FACE_DEFS[i], voxels, nbr, opaque, transp, yMin, yMax, smooth);
            }
        } else {
            // Nothing in the chunk: no rows either (closedRows).
            this._rowSrc.fill(0);
            this._rowOcc.fill(0);
        }

        smooth?.emit?.(opaque);
        if (models && yMax >= yMin) this._emitModels(voxels, yMin, yMax, opaque);
        const sections = this._sortSections(opaque);
        this._orderTranslucent(transp);

        const o = _sinkArrays(opaque);
        const t = _sinkArrays(transp);
        return {
            positions:            o.positions,
            tints:                o.tints,
            uvs:                  o.uvs,
            normals:              o.normals,
            indices:              o.indices,
            transparentPositions: t.positions,
            transparentTints:     t.tints,
            transparentUVs:       t.uvs,
            transparentNormals:   t.normals,
            transparentIndices:   t.indices,
            // Tight local-space Y bounds, so the render layer can set a bounding
            // sphere without Three.js scanning every position on the main thread.
            yMin, yMax,
            // Where each section's triangles are in `indices`: section s is
            // indices sections[s] … sections[s + 1] (engine/Visibility.js).
            sections,
        };
    }

    /**
     * Put the opaque mesh's triangles in order of section, lowest first, from
     * the runs markSection noted. Returns Uint32Array(SECTIONS + 1): where
     * each section's indices begin, and where the last ends.
     */
    _sortSections(sink) {
        const offsets = new Uint32Array(SECTIONS + 1);
        const total = sink.idx.n, runs = sink.sec.a, nr = sink.sec.n;
        const fill = this._secFill;
        fill.fill(0);
        // Anything written before the first mark would be section 0's; every
        // writer marks first, so there is nothing.
        const first = nr > 0 ? runs[0] : total;
        fill[0] = first;
        for (let r = 0; r < nr; r += 2) {
            const end = r + 2 < nr ? runs[r + 2] : total;
            fill[runs[r + 1]] += end - runs[r];
        }
        let at = 0;
        for (let k = 0; k < SECTIONS; k++) { offsets[k] = at; at += fill[k]; fill[k] = offsets[k]; }
        offsets[SECTIONS] = at;
        if (total === 0) return offsets;

        const sorted = this._idxSorted;
        sorted.n = 0;
        const out = sorted.reserve(total), src = sink.idx.a;
        for (let i = 0; i < first; i++) out[fill[0]++] = src[i];
        for (let r = 0; r < nr; r += 2) {
            const end = r + 2 < nr ? runs[r + 2] : total, sec = runs[r + 1];
            let o = fill[sec];
            for (let i = runs[r]; i < end; i++) out[o++] = src[i];
            fill[sec] = o;
        }
        sorted.n = total;
        // The sink takes the sorted buffer; its old one is next job's scratch.
        this._idxSorted = sink.idx;
        sink.idx = sorted;
        return offsets;
    }

    /**
     * For the chunk meshGroup was last given: a word for each row of sixteen
     * cells along x (rows numbered y · 16 + z), with a bit for each cell that
     * is a full opaque cube — what sight cannot pass through. For
     * engine/Visibility.js (connectivityOfRows), which then has no voxel to
     * read. In a smooth world a Mesh voxel cut to a shape is not one.
     */
    closedRows() {
        const src = this._rowSrc, occ = this._rowOcc, out = this._rowClosed;
        for (let i = 0; i < out.length; i++) out[i] = src[i] & occ[i];
        return out;
    }

    /** Full mesh — all 6 face directions. */
    mesh(voxels, neighbors, yRange) {
        return this.meshGroup(voxels, neighbors, [0, 1, 2, 3, 4, 5], yRange);
    }

    /** Whether any id in `palette` is a model block (worldWorker, before meshing). */
    hasModels(palette) {
        for (let i = 0; i < palette.length; i++) if (this._model[palette[i]] === 1) return true;
        return false;
    }

    /** Draw every model block in the band (BlockModels.js). */
    _emitModels(voxels, yMin, yMax, sink) {
        const model = this._model;
        const tables = { layer: -1, color: [1, 1, 1], glow: 0 };
        for (let lz = 0; lz < N_XZ; lz++) {
            for (let ly = yMin; ly <= yMax; ly++) {
                const row = ly * SY + lz * SZ;
                for (let lx = 0; lx < N_XZ; lx++) {
                    const id = voxels[row + lx];
                    if (model[id] !== 1) continue;
                    markSection(sink, ly >> SECTION_SHIFT);   // a model is inside its own cell
                    const cb = id * 18 + 2 * 3;   // the top face's colour
                    tables.layer = this._layerTop[id];
                    tables.color[0] = this._colors[cb];
                    tables.color[1] = this._colors[cb + 1];
                    tables.color[2] = this._colors[cb + 2];
                    tables.glow = this._glow[id];
                    emitModel(sink, lx, ly, lz, this._modelDef[id], tables);
                }
            }
        }
    }

    /**
     * Smooth worlds: which neighbouring ground spreads over the top of the
     * natural-ground voxel at (lx, ly, lz), and from which sides.
     *
     * Each kind of natural ground has a `blend` number (BlockRegistry). Where
     * two kinds meet, the higher one creeps onto the lower one's edge: this
     * looks at the surface voxel of each of the eight columns around — a step
     * up, level, or a step down, since that is how the smooth surface runs
     * on — and takes the highest-ranking ground above this voxel's own.
     *
     * @param {(x, y, z) => number} read  a voxel at chunk-local coordinates,
     *        up to a block outside the chunk (the smooth mesher's)
     * @returns {number} that ground's top texture layer × 256 + a bit for each
     *        of the eight sides it lies on (BLEND_DX/DZ order), or 0 for none.
     *        The chunk shader does the rest (blendGround in world.js).
     */
    blendCode(read, lx, ly, lz, id) {
        const rank = this._blend, mine = rank[id], nb = this._nb, solid = this._solid;
        let best = mine, bestId = 0;
        for (let k = 0; k < 8; k++) {
            const x = lx + BLEND_DX[k], z = lz + BLEND_DZ[k];
            // The column's surface next to this voxel's top: the block a step
            // up if it is open above, else the one level with us, else a step
            // down. Water and leaves do not close a surface.
            const up = read(x, ly + 1, z);
            let s = 0;
            if (rank[up] !== 0) {
                if (solid[read(x, ly + 2, z)] !== 1) s = up;
            } else if (solid[up] !== 1) {
                const level = read(x, ly, z);
                if (rank[level] !== 0) s = level;
                else if (solid[level] !== 1) {
                    const down = read(x, ly - 1, z);
                    if (rank[down] !== 0) s = down;
                }
            }
            nb[k] = s;
            if (rank[s] > best) { best = rank[s]; bestId = s; }
        }
        if (bestId === 0) return 0;
        const layer = this._layerTop[bestId];
        if (layer < 0) return 0;
        let sides = 0;
        for (let k = 0; k < 8; k++) if (nb[k] === bestId) sides |= 1 << k;
        return layer * 256 + sides;
    }

    /**
     * Write the transparent mesh's indices, in an order that is back to front
     * from any viewpoint.
     *
     * Every translucent quad is in the mesh twice, once facing each way, and
     * the mesh is drawn with back faces culled. Among quads that face the same
     * way, the camera can only see those it is in front of, so of two it can
     * see, the one further along their normal is the nearer: drawing them by
     * rising position (falling, for those that face −) is back to front
     * wherever the camera is. A quad facing + and one facing − on the same
     * axis are never both visible unless the camera is between them, and then
     * no line of sight crosses both, so the two lists can simply follow each
     * other. That is exact for everything on one axis — every water and ice
     * surface, which is nearly all there is. The three axes are drawn in turn
     * (horizontal faces first), which is only approximate between a surface
     * and the side of something standing in it.
     *
     * Chunks are ordered among themselves by world.js (_cullChunks).
     */
    _orderTranslucent(sink) {
        const tq = this._tq, n = (tq.n / 3) | 0;
        if (n === 0) return;
        const q = tq.a;
        const order = new Array(n);
        for (let i = 0; i < n; i++) order[i] = i;
        order.sort((a, b) => (q[a * 3] - q[b * 3]) || (a - b));
        const idx = sink.idx;
        for (let i = 0; i < n; i++) {
            const o = order[i] * 3, base = q[o + 1];
            if (q[o + 2] === 1) idx.push6(base, base + 1, base + 2, base, base + 2, base + 3);
            else                idx.push6(base, base + 2, base + 1, base, base + 3, base + 2);
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    /**
     * For each row of sixteen cells along x in the band, two words with a bit
     * a cell:
     *   _rowSrc — it can have a face: not air, and not a Mesh voxel the smooth
     *             pass draws (`skip`);
     *   _rowOcc — it hides a face drawn against it (`occ`).
     * Rows are numbered y · 16 + z, so the row beside one is ± 1 and the one
     * above or below ± 16. The cells of the neighbouring chunks that touch
     * this one are noted the same way: a bit a row for the two across x
     * (_edgePX / _edgeNX), a word a level for the two across z.
     *
     * With these a sweep finds the cells that can have a face in its direction
     * sixteen at a time — `src & ~occ` of the row it faces — instead of
     * reading every voxel and its neighbour for each of the six directions,
     * which was half of meshing a blocky chunk: nearly all of a chunk is air
     * or buried rock, and has none.
     */
    _buildRows(voxels, nbr, yMin, yMax, occ, skip) {
        const rowSrc = this._rowSrc, rowOcc = this._rowOcc;
        rowSrc.fill(0);
        rowOcc.fill(0);
        for (let lz = 0; lz < N_XZ; lz++) {
            for (let ly = yMin; ly <= yMax; ly++) {
                let i = ly * SY + lz * SZ, src = 0, oc = 0;
                for (let x = 0; x < N_XZ; x++, i++) {
                    const id = voxels[i];
                    if (id === 0) continue;
                    if (skip === null || skip[i] === 0) src |= 1 << x;
                    if (occ[id] === 1) oc |= 1 << x;
                }
                const r = ly * N_XZ + lz;
                rowSrc[r] = src;
                rowOcc[r] = oc;
            }
        }
        const px = nbr.px, nx = nbr.nx, pz = nbr.pz, nz = nbr.nz;
        if (px !== null || nx !== null) {
            const ePX = this._edgePX, eNX = this._edgeNX;
            for (let lz = 0; lz < N_XZ; lz++) {
                for (let ly = yMin; ly <= yMax; ly++) {
                    const i = ly * SY + lz * SZ, r = ly * N_XZ + lz;
                    if (px !== null) ePX[r] = occ[px[i]];                    // its x = 0
                    if (nx !== null) eNX[r] = occ[nx[i + N_XZ - 1]];         // its x = 15
                }
            }
        }
        if (pz !== null || nz !== null) {
            const ePZ = this._edgePZ, eNZ = this._edgeNZ, last = (N_XZ - 1) * SZ;
            for (let ly = yMin; ly <= yMax; ly++) {
                const i = ly * SY;
                let a = 0, b = 0;
                for (let x = 0; x < N_XZ; x++) {
                    if (pz !== null && occ[pz[i + x]] === 1) a |= 1 << x;          // its z = 0
                    if (nz !== null && occ[nz[i + x + last]] === 1) b |= 1 << x;   // its z = 15
                }
                ePZ[ly] = a;
                eNZ[ly] = b;
            }
        }
    }

    /**
     * Build the visibility masks for every slice of one face direction and
     * merge each into quads.
     *
     * A slice is done in two steps. First the cells that can have a face this
     * way are picked out from the row words (_buildRows): a cell that is
     * something, facing a cell that does not hide it. Then only those are
     * looked at — the block, the block it faces, and which mask the face goes
     * in. Within a slice every voxel's neighbour in the face direction lives
     * in the same array at the same index offset — this chunk for interior
     * slices, one neighbour chunk for the boundary slice — so that is resolved
     * once per slice.
     *
     * The masks are not cleared and not filled: a merge zeroes every cell it
     * takes, and takes every cell that was set, so they are all zero again
     * when the next slice begins. The merge is given the box of cells that
     * were set, not the whole slice.
     */
    _sweepFace(fd, voxels, nbr, opaque, transp, yMin, yMax, smooth) {
        const { faceAxis, uAxis, vAxis, positive, ni } = fd;
        const solid = this._solid, glassy = this._glassy, cutout = this._cutout, airLike = this._airLike;
        // Tops of natural ground blend with their neighbours (smooth worlds).
        const blendRead = ni === 2 && this._anyBlend && smooth?.read ? smooth.read : null;
        const blendT = this._blend;
        // Blocky worlds: the adjacent test uses the same table as the source test.
        const occ   = smooth ? smooth.occ     : solid;

        const nFace = DIM[faceAxis];
        const nU    = DIM[uAxis];
        const nV    = DIM[vAxis];

        // Restrict the swept range to the band that can contain blocks.
        const faceLo = faceAxis === 1 ? Math.max(0, yMin - 1)       : 0;
        const faceHi = faceAxis === 1 ? Math.min(nFace - 1, yMax + 1) : nFace - 1;

        const sF = STRIDE[faceAxis];
        const dir = positive ? 1 : -1;

        const mask = this._mask, maskT = this._maskT;
        const rowSrc = this._rowSrc, rowOcc = this._rowOcc;
        const cSrc = this._cSrc, cU = this._cU, cV = this._cV;

        for (let f = faceLo; f <= faceHi; f++) {
            // Which array holds this slice's neighbours, and the index shift from
            // a source voxel to its neighbour in that array.
            const a = f + dir;
            let adj = voxels, shift = dir * sF, inside = true;
            if (a < 0 || a >= nFace) {
                // Above or below the world, or toward an unloaded chunk, the
                // neighbour is SOLID_SENTINEL: it hides every opaque face and is
                // not air, so no transparent face shows either. Nothing to emit.
                if (faceAxis === 1) continue;
                adj = faceAxis === 0 ? (a < 0 ? nbr.nx : nbr.px)
                                     : (a < 0 ? nbr.nz : nbr.pz);
                if (adj === null) continue;
                // Same position on the far side of the neighbouring chunk.
                shift = (a < 0 ? nFace - 1 : 1 - nFace) * sF;
                inside = false;
            }

            // The cells that can have a face: something there (and not the
            // smooth pass's), and what it faces does not hide it. Each with
            // its place in the mask, u · nV + v.
            let n = 0;
            if (faceAxis === 0) {
                // ±X: the slice is x = f; u is y and v is z, so a row is a cell.
                const edge = positive ? this._edgePX : this._edgeNX;
                for (let y = yMin; y <= yMax; y++) {
                    const r0 = y * N_XZ;
                    for (let z = 0; z < N_XZ; z++) {
                        const r = r0 + z;
                        if (((rowSrc[r] >> f) & 1) === 0) continue;
                        if (inside ? ((rowOcc[r] >> a) & 1) === 1 : edge[r] === 1) continue;
                        cSrc[n] = f + y * SY + z * SZ; cU[n] = y; cV[n] = z;
                        n++;
                    }
                }
            } else if (faceAxis === 1) {
                // ±Y: the slice is y = f; u is z and v is x. The row above or below.
                const r0 = f * N_XZ, ra = a * N_XZ;
                for (let z = 0; z < N_XZ; z++) {
                    let w = rowSrc[r0 + z] & ~rowOcc[ra + z];
                    while (w !== 0) {
                        const x = 31 - Math.clz32(w & -w);
                        w &= w - 1;
                        cSrc[n] = x + f * SY + z * SZ; cU[n] = z; cV[n] = x;
                        n++;
                    }
                }
            } else {
                // ±Z: the slice is z = f; u is x and v is y. The row beside.
                const edge = positive ? this._edgePZ : this._edgeNZ;
                for (let y = yMin; y <= yMax; y++) {
                    let w = rowSrc[y * N_XZ + f];
                    if (w === 0) continue;
                    w &= ~(inside ? rowOcc[y * N_XZ + a] : edge[y]);
                    while (w !== 0) {
                        const x = 31 - Math.clz32(w & -w);
                        w &= w - 1;
                        cSrc[n] = x + y * SY + f * SZ; cU[n] = x; cV[n] = y;
                        n++;
                    }
                }
            }
            if (n === 0) continue;

            // Which of them do have one, and in which mesh. The box of cells
            // set in each mask is what its merge has to look at.
            let anyO = false, anyT = false;
            let u0 = nU, u1 = -1, v0 = nV, v1 = -1;         // opaque
            let tu0 = nU, tu1 = -1, tv0 = nV, tv1 = -1;     // translucent
            for (let k = 0; k < n; k++) {
                const src = cSrc[k], id = voxels[src], adjId = adj[src + shift];
                if (solid[id] === 1) {
                    if (occ[adjId] === 1) continue;
                } else if (cutout[id] === 1) {
                    // Leaves, glass: against anything that does not hide
                    // them, but not against more of themselves.
                    if (adjId === id || occ[adjId] === 1) continue;
                } else {
                    // Water, ice: against air (or a torch), and against a
                    // cutout block, which shows what is behind it. Model
                    // blocks are neither: they draw themselves (_emitModels).
                    if (glassy[id] === 1 && (airLike[adjId] === 1 || cutout[adjId] === 1)) {
                        const u = cU[k], v = cV[k];
                        maskT[u * nV + v] = id;
                        anyT = true;
                        if (u < tu0) tu0 = u; if (u > tu1) tu1 = u;
                        if (v < tv0) tv0 = v; if (v > tv1) tv1 = v;
                    }
                    continue;
                }
                const u = cU[k], v = cV[k];
                mask[u * nV + v] = id;
                anyO = true;
                if (u < u0) u0 = u; if (u > u1) u1 = u;
                if (v < v0) v0 = v; if (v > v1) v1 = v;
            }

            // Most slices have no transparent faces at all, many no opaque ones.
            if (anyO) {
                if (blendRead !== null) {
                    // +Y: u is z and v is x. The code goes in the mask's high half.
                    for (let u = u0; u <= u1; u++) {
                        for (let v = v0; v <= v1; v++) {
                            const cell = u * nV + v, id = mask[cell];
                            if (id === 0 || blendT[id] === 0) continue;
                            const code = this.blendCode(blendRead, v, f, u, id);
                            if (code !== 0) mask[cell] = id + code * 65536;
                        }
                    }
                }
                // A top or bottom face is seen from the level it faces.
                if (faceAxis === 1) markSection(opaque, a >> SECTION_SHIFT);
                this._greedyMerge(mask, f, faceAxis, uAxis, vAxis, nV, u0, u1, v0, v1, positive, ni, opaque, false);
            }
            if (anyT) this._greedyMerge(maskT, f, faceAxis, uAxis, vAxis, nV, tu0, tu1, tv0, tv1, positive, ni, transp, true);
        }
    }

    /**
     * Merge one slice's mask into rectangles and emit a quad for each. Cells a
     * rectangle consumes are zeroed in the mask itself (it is rebuilt for the
     * next slice anyway), so no separate "done" table is needed.
     */
    _greedyMerge(mask, depth, faceAxis, uAxis, vAxis, nV, uLo, uHi, vLo, vHi, positive, ni, sink, translucent) {
        const colors = this._colors, glowT = this._glow, natural = this._natural;
        const layerTable = ni === 2 ? this._layerTop : ni === 3 ? this._layerBottom : this._layerSide;
        const faceOffset = positive ? depth + 1 : depth;
        const fn = FACE_NORMAL8[ni], nx = fn[0], ny = fn[1], nz = fn[2];

        const posArr = sink.pos, colArr = sink.col, uvArr = sink.uv, layArr = sink.lay, nrmArr = sink.nrm, idxArr = sink.idx;

        // An opaque side face belongs to the section it is in, and no quad may
        // span two: a rectangle stops growing at the top of its section. Which
        // of u and v is the vertical depends on the face (tops and bottoms have
        // neither, and are marked a slice at a time by _sweepFace).
        const splitU = !translucent && uAxis === 1, splitV = !translucent && vAxis === 1;
        const LAST = SECTION_SIZE - 1;

        for (let u = uLo; u <= uHi; u++) {
            const rowBase = u * nV;
            const uEnd = splitU ? Math.min(uHi, u | LAST) : uHi;
            for (let v = vLo; v <= vHi; v++) {
                const cell = rowBase + v;
                const startV = mask[cell];
                if (startV === 0) continue;

                // Grow rectangle: expand v first, then u
                const vEnd = splitV ? Math.min(vHi, v | LAST) : vHi;
                let vW = 1;
                while (v + vW <= vEnd && mask[cell + vW] === startV) vW++;

                let uW = 1;
                expand_u:
                while (u + uW <= uEnd) {
                    const probe = (u + uW) * nV + v;
                    for (let k = 0; k < vW; k++) {
                        if (mask[probe + k] !== startV) break expand_u;
                    }
                    uW++;
                }

                // The block, and for a top face in a smooth world the ground
                // that spreads onto it (blendCode), from the mask's high half.
                const startId = startV & 0xFFFF, code = startV >>> 16;

                // Mark cells consumed
                for (let uu = 0; uu < uW; uu++) {
                    const c0 = (u + uu) * nV + v;
                    for (let vv = 0; vv < vW; vv++) mask[c0 + vv] = 0;
                }

                const layer = layerTable[startId];

                // A textured face's colour is its texture, so its three bytes
                // say how it blends instead (MeshFormat.js); an untextured
                // face carries the block's colour for this face. The shader
                // does all the lighting, from the normal.
                let r, g, b;
                if (layer >= 0) {
                    r = (code >>> 8) / 255; g = (code & 255) / 255; b = natural[startId];
                } else {
                    const cbase = startId * 18 + ni * 3;
                    r = colors[cbase];
                    g = colors[cbase + 1];
                    b = colors[cbase + 2];
                }

                // The 4 quad corners, at (u, v) offsets (0,0) (uW,0) (uW,vW) (0,vW).
                // faceAxis / uAxis / vAxis are a permutation of 0,1,2, so each
                // lands in its own component slot.
                const u1 = u + uW, v1 = v + vW;
                let n = posArr.n;
                const base = (n / 3) | 0;
                const pa = posArr.reserve(12);
                pa[n + faceAxis] = faceOffset; pa[n + uAxis] = u;  pa[n + vAxis] = v;  n += 3;
                pa[n + faceAxis] = faceOffset; pa[n + uAxis] = u1; pa[n + vAxis] = v;  n += 3;
                pa[n + faceAxis] = faceOffset; pa[n + uAxis] = u1; pa[n + vAxis] = v1; n += 3;
                pa[n + faceAxis] = faceOffset; pa[n + uAxis] = u;  pa[n + vAxis] = v1; n += 3;
                posArr.n = n;

                n = colArr.n;
                const ca = colArr.reserve(12);
                for (let i = 0; i < 4; i++, n += 3) { ca[n] = r; ca[n + 1] = g; ca[n + 2] = b; }
                colArr.n = n;

                n = layArr.n;
                const la = layArr.reserve(4);
                la[n] = layer; la[n + 1] = layer; la[n + 2] = layer; la[n + 3] = layer;
                layArr.n = n + 4;

                n = nrmArr.n;
                const na = nrmArr.reserve(16);
                const glow = glowT[startId];
                for (let i = 0; i < 4; i++, n += 4) { na[n] = nx; na[n + 1] = ny; na[n + 2] = nz; na[n + 3] = glow; }
                nrmArr.n = n;

                // UV: tile once per block across both axes — the texture sampler repeats.
                // For ±X faces (faceAxis=0): uAxis=Y (vertical), vAxis=Z (horizontal).
                // Swap so UV.x maps to Z (horizontal on face) and UV.y maps to Y (vertical).
                n = uvArr.n;
                const ua = uvArr.reserve(8);
                if (faceAxis === 0) {
                    ua[n]     = 0;  ua[n + 1] = 0;  ua[n + 2] = 0;  ua[n + 3] = uW;
                    ua[n + 4] = vW; ua[n + 5] = uW; ua[n + 6] = vW; ua[n + 7] = 0;
                } else {
                    ua[n]     = 0;  ua[n + 1] = 0;  ua[n + 2] = uW; ua[n + 3] = 0;
                    ua[n + 4] = uW; ua[n + 5] = vW; ua[n + 6] = 0;  ua[n + 7] = vW;
                }
                uvArr.n = n + 8;

                if (!translucent) {
                    if (splitU) markSection(sink, u >> SECTION_SHIFT);
                    else if (splitV) markSection(sink, v >> SECTION_SHIFT);
                    if (positive) {
                        idxArr.push6(base, base + 1, base + 2, base, base + 2, base + 3);
                    } else {
                        idxArr.push6(base, base + 2, base + 1, base, base + 3, base + 2);
                    }
                } else {
                    // The same quad again, facing the other way (the far side
                    // of a sheet of water, seen from under it), and both noted
                    // for _orderTranslucent, which writes the indices.
                    posArr.reserve(12).copyWithin(posArr.n, posArr.n - 12, posArr.n); posArr.n += 12;
                    colArr.reserve(12).copyWithin(colArr.n, colArr.n - 12, colArr.n); colArr.n += 12;
                    uvArr.reserve(8).copyWithin(uvArr.n, uvArr.n - 8, uvArr.n);       uvArr.n += 8;
                    layArr.reserve(4).copyWithin(layArr.n, layArr.n - 4, layArr.n);   layArr.n += 4;
                    n = nrmArr.n;
                    const nb = nrmArr.reserve(16);
                    for (let i = 0; i < 4; i++, n += 4) { nb[n] = -nx; nb[n + 1] = -ny; nb[n + 2] = -nz; nb[n + 3] = glow; }
                    nrmArr.n = n;
                    const tq = this._tq;
                    tq.push3(_translucentKey(faceAxis, positive, faceOffset), base, positive ? 1 : 0);
                    tq.push3(_translucentKey(faceAxis, !positive, faceOffset), base + 4, positive ? 0 : 1);
                }

                // Skip the cells this rectangle just consumed.
                v += vW - 1;
            }
        }
    }

    _faceColor(block, ni) {
        // ni: 0=+X(right)  1=-X(left)  2=+Y(top)  3=-Y(bottom)  4=+Z(back)  5=-Z(front)
        switch (ni) {
            case 2: return block.topColor    ?? block.color;
            case 3: return block.bottomColor ?? block.color;
            case 0: return block.rightColor  ?? block.sideColor ?? block.color;
            case 1: return block.leftColor   ?? block.sideColor ?? block.color;
            case 4: return block.backColor   ?? block.sideColor ?? block.color;
            case 5: return block.frontColor  ?? block.sideColor ?? block.color;
            default: return block.color;
        }
    }
}
