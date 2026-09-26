/**
 * Greedy Mesher
 *
 * Converts a 16×CHUNK_SIZE_Y×16 voxel chunk column (plus its four horizontal
 * neighbours for boundary face visibility) into two compact triangle meshes:
 *   • opaque       — standard opaque blocks
 *   • transparent  — water, leaves, glass etc.
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
 * Performance notes — this is the hottest code in the engine, roughly
 * 2.3M voxel reads per full chunk mesh:
 *   • Voxel reads are inlined per-sweep rather than routed through a method
 *     with bounds checks and a template-literal neighbour key.
 *   • Solidity is a prebuilt Uint8Array lookup instead of a registry call.
 *   • Output goes straight into growable typed arrays; no JS array boxing and
 *     no final Array→Float32Array copy.
 *   • No `normal` attribute is produced. The chunk shaders bake directional
 *     brightness into vertex colour and never read a normal, so emitting one
 *     would be 12 bytes per vertex of pure waste.
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
import { sunBrightness } from '../engine/Sun.js';

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

// Face brightness under open sky, from the sun's direction (engine/Sun.js):
// +X -X +Y -Y +Z -Z. Sky light and shadows are applied on top in the shader.
const FACE_BRIGHTNESS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .map(([x, y, z]) => sunBrightness(x, y, z));

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
    trim() { return this.a.slice(0, this.n); }
}

/** One mesh's worth of output buffers. */
function _newSink() {
    return { pos: new F32Buf(), col: new F32Buf(), uv: new F32Buf(), lay: new F32Buf(), idx: new U32Buf() };
}

function _resetSink(s) {
    s.pos.n = 0; s.col.n = 0; s.uv.n = 0; s.lay.n = 0; s.idx.n = 0;
    return s;
}

function _sinkArrays(s) {
    return { positions: s.pos.trim(), colors: s.col.trim(), uvs: s.uv.trim(), layers: s.lay.trim(), indices: s.idx.trim() };
}

// Flat-index stride of each axis (X, Y, Z).
const STRIDE = [1, SY, SZ];

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
        const maxSlice = N_XZ * N_Y;
        this._mask   = new Uint16Array(maxSlice);
        this._maskT  = new Uint16Array(maxSlice);
        this._opaque = _newSink();
        this._transp = _newSink();
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
     */
    _buildTables() {
        const ids = this.reg.serialize().map(b => b.id);
        const maxId = ids.length ? Math.max(...ids) : 0;
        const n = maxId + 1;

        this._solid       = new Uint8Array(65536);
        this._layerTop    = new Int16Array(n).fill(-1);
        this._layerSide   = new Int16Array(n).fill(-1);
        this._layerBottom = new Int16Array(n).fill(-1);
        // colors[id*18 + ni*3 + c] — per-face RGB for all six faces.
        this._colors      = new Float32Array(n * 18);

        for (const id of ids) {
            const block = this.reg.get(id);
            if (!block) continue;
            this._solid[id] = this.reg.isSolid(id) ? 1 : 0;

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
     *   { occ, partial, emit }. `occ` replaces the solidity table for the
     *   neighbour test (Mesh blocks hide faces against them), `partial` marks
     *   deformed Mesh voxels the greedy pass must leave alone, and `emit(sink)`
     *   appends their custom geometry to the opaque output. Omitted in blocky
     *   worlds, where behaviour is exactly as before.
     */
    meshGroup(voxels, neighbors, faceDefIndices, yRange, smooth = null) {
        const opaque = _resetSink(this._opaque);
        const transp = _resetSink(this._transp);

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
            for (const i of faceDefIndices) {
                this._sweepFace(FACE_DEFS[i], voxels, nbr, opaque, transp, yMin, yMax, smooth);
            }
        }

        smooth?.emit?.(opaque);

        const o = _sinkArrays(opaque);
        const t = _sinkArrays(transp);
        return {
            positions:            o.positions,
            colors:               o.colors,
            uvs:                  o.uvs,
            layers:               o.layers,
            indices:              o.indices,
            transparentPositions: t.positions,
            transparentColors:    t.colors,
            transparentUVs:       t.uvs,
            transparentLayers:    t.layers,
            transparentIndices:   t.indices,
            // Tight local-space Y bounds, so the render layer can set a bounding
            // sphere without Three.js scanning every position on the main thread.
            yMin, yMax,
        };
    }

    /** Full mesh — all 6 face directions. */
    mesh(voxels, neighbors, yRange) {
        return this.meshGroup(voxels, neighbors, [0, 1, 2, 3, 4, 5], yRange);
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    /**
     * Build the visibility masks for every slice of one face direction and
     * merge each into quads.
     *
     * Voxels are addressed by flat index with per-axis strides rather than
     * through coordinate arrays. Within a slice every voxel's neighbour in the
     * face direction lives in the same array at the same index offset — this
     * chunk for interior slices, one neighbour chunk for the boundary slice —
     * so that is resolved once per slice and the inner loop is a plain read.
     */
    _sweepFace(fd, voxels, nbr, opaque, transp, yMin, yMax, smooth) {
        const { faceAxis, uAxis, vAxis, positive, ni } = fd;
        const solid = this._solid;
        // Blocky worlds: the adjacent test uses the same table as the source test.
        const occ   = smooth ? smooth.occ     : solid;
        const skip  = smooth ? smooth.partial : null;

        const nFace = DIM[faceAxis];
        const nU    = DIM[uAxis];
        const nV    = DIM[vAxis];

        // Restrict the swept range to the band that can contain blocks.
        const faceLo = faceAxis === 1 ? Math.max(0, yMin - 1)       : 0;
        const faceHi = faceAxis === 1 ? Math.min(nFace - 1, yMax + 1) : nFace - 1;
        const uLo    = uAxis === 1 ? yMin : 0;
        const uHi    = uAxis === 1 ? yMax : nU - 1;
        const vLo    = vAxis === 1 ? yMin : 0;
        const vHi    = vAxis === 1 ? yMax : nV - 1;

        const sF = STRIDE[faceAxis], sU = STRIDE[uAxis], sV = STRIDE[vAxis];
        const dir = positive ? 1 : -1;

        // Fill in memory order: whichever of u / v has the smaller voxel stride
        // runs innermost. The masks are indexed u·nV + v either way.
        const vInner = sV < sU;
        const oLo = vInner ? uLo : vLo, oHi = vInner ? uHi : vHi;
        const iLo = vInner ? vLo : uLo, iHi = vInner ? vHi : uHi;
        const oS  = vInner ? sU : sV,   iS  = vInner ? sV : sU;
        const oC  = vInner ? nV : 1,    iC  = vInner ? 1  : nV;

        const mask = this._mask, maskT = this._maskT;

        for (let f = faceLo; f <= faceHi; f++) {
            // Which array holds this slice's neighbours, and the index shift from
            // a source voxel to its neighbour in that array.
            const a = f + dir;
            let adj = voxels, shift = dir * sF;
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
            }

            // Every cell in range is written, so the masks need no clearing.
            let anyO = 0, anyT = 0;
            const base = f * sF;
            for (let o = oLo; o <= oHi; o++) {
                let src  = base + o * oS + iLo * iS;
                let cell = o * oC + iLo * iC;
                for (let i = iLo; i <= iHi; i++, src += iS, cell += iC) {
                    const id = voxels[src];
                    let m = 0, mt = 0;
                    // Air emits no face in either pass; a deformed Mesh voxel is
                    // drawn by the smooth pass instead.
                    if (id !== 0 && (skip === null || skip[src] === 0)) {
                        const adjId = adj[src + shift];
                        if (solid[id] === 1) {
                            if (occ[adjId] !== 1) m = id;
                        } else if (adjId === 0) {
                            // Transparent (non-solid, non-air) against air.
                            mt = id;
                        }
                    }
                    mask[cell]  = m;
                    maskT[cell] = mt;
                    anyO |= m;
                    anyT |= mt;
                }
            }

            // Most slices have no transparent faces at all, many no opaque ones.
            if (anyO !== 0) this._greedyMerge(mask,  f, faceAxis, uAxis, vAxis, nV, uLo, uHi, vLo, vHi, positive, ni, opaque);
            if (anyT !== 0) this._greedyMerge(maskT, f, faceAxis, uAxis, vAxis, nV, uLo, uHi, vLo, vHi, positive, ni, transp);
        }
    }

    /**
     * Merge one slice's mask into rectangles and emit a quad for each. Cells a
     * rectangle consumes are zeroed in the mask itself (it is rebuilt for the
     * next slice anyway), so no separate "done" table is needed.
     */
    _greedyMerge(mask, depth, faceAxis, uAxis, vAxis, nV, uLo, uHi, vLo, vHi, positive, ni, sink) {
        const brightness = FACE_BRIGHTNESS[ni];
        const colors = this._colors;
        const layerTable = ni === 2 ? this._layerTop : ni === 3 ? this._layerBottom : this._layerSide;
        const faceOffset = positive ? depth + 1 : depth;

        const posArr = sink.pos, colArr = sink.col, uvArr = sink.uv, layArr = sink.lay, idxArr = sink.idx;

        for (let u = uLo; u <= uHi; u++) {
            const rowBase = u * nV;
            for (let v = vLo; v <= vHi; v++) {
                const cell = rowBase + v;
                const startId = mask[cell];
                if (startId === 0) continue;

                // Grow rectangle: expand v first, then u
                let vW = 1;
                while (v + vW <= vHi && mask[cell + vW] === startId) vW++;

                let uW = 1;
                expand_u:
                while (u + uW <= uHi) {
                    const probe = (u + uW) * nV + v;
                    for (let k = 0; k < vW; k++) {
                        if (mask[probe + k] !== startId) break expand_u;
                    }
                    uW++;
                }

                // Mark cells consumed
                for (let uu = 0; uu < uW; uu++) {
                    const c0 = (u + uu) * nV + v;
                    for (let vv = 0; vv < vW; vv++) mask[c0 + vv] = 0;
                }

                const layer = layerTable[startId];

                // Textured faces store brightness as uniform grey so the shader can
                // tint the texture; untextured faces store the shaded block colour.
                let r, g, b;
                if (layer >= 0) {
                    r = brightness; g = brightness; b = brightness;
                } else {
                    const cbase = startId * 18 + ni * 3;
                    r = colors[cbase]     * brightness;
                    g = colors[cbase + 1] * brightness;
                    b = colors[cbase + 2] * brightness;
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

                // UV: tile once per block across both axes — shader uses fract() for repeating.
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

                if (positive) {
                    idxArr.push6(base, base + 1, base + 2, base, base + 2, base + 3);
                } else {
                    idxArr.push6(base, base + 2, base + 1, base, base + 3, base + 2);
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
