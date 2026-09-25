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

const FACE_BRIGHTNESS = [
    0.70,   // +X
    0.70,   // -X
    1.00,   // +Y  (top, brightest)
    0.45,   // -Y  (bottom, darkest)
    0.85,   // +Z
    0.80,   // -Z
];

const NORMALS = [
    [ 1, 0, 0], [-1, 0, 0],
    [ 0, 1, 0], [ 0,-1, 0],
    [ 0, 0, 1], [ 0, 0,-1],
];

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
    push6(a0, b0, c0, d0, e0, f0) {
        this._fit(6);
        const a = this.a;
        a[this.n++] = a0; a[this.n++] = b0; a[this.n++] = c0;
        a[this.n++] = d0; a[this.n++] = e0; a[this.n++] = f0;
    }
    trim() { return this.a.slice(0, this.n); }
}

/** One mesh's worth of output buffers. */
function _newSink() {
    return { pos: new F32Buf(), col: new F32Buf(), uv: new F32Buf(), lay: new F32Buf(), idx: new U32Buf() };
}

function _sinkArrays(s) {
    return { positions: s.pos.trim(), colors: s.col.trim(), uvs: s.uv.trim(), layers: s.lay.trim(), indices: s.idx.trim() };
}

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
     */
    meshGroup(voxels, neighbors, faceDefIndices, yRange) {
        const opaque = _newSink();
        const transp = _newSink();

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
                this._sweepFace(FACE_DEFS[i], voxels, nbr, opaque, transp, yMin, yMax);
            }
        }

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
     * Read a voxel that may lie one step outside the chunk on X or Z.
     * `ly` is always within [0, N_Y) at call sites that can cross XZ.
     */
    _readXZ(voxels, nbr, lx, ly, lz) {
        if (lx < 0)      { const n = nbr.nx; return n ? n[(lx + N_XZ) + ly * SY + lz * SZ] : SOLID_SENTINEL; }
        if (lx >= N_XZ)  { const n = nbr.px; return n ? n[(lx - N_XZ) + ly * SY + lz * SZ] : SOLID_SENTINEL; }
        if (lz < 0)      { const n = nbr.nz; return n ? n[lx + ly * SY + (lz + N_XZ) * SZ] : SOLID_SENTINEL; }
        if (lz >= N_XZ)  { const n = nbr.pz; return n ? n[lx + ly * SY + (lz - N_XZ) * SZ] : SOLID_SENTINEL; }
        return voxels[lx + ly * SY + lz * SZ];
    }

    _sweepFace(fd, voxels, nbr, opaque, transp, yMin, yMax) {
        const { faceAxis, uAxis, vAxis, positive, ni } = fd;
        const normal = NORMALS[ni];
        const dx = normal[0], dy = normal[1], dz = normal[2];
        const solid = this._solid;

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

        const mask  = new Int32Array(nU * nV);
        const maskT = new Int32Array(nU * nV);

        const coord  = [0, 0, 0];
        const coordA = [0, 0, 0];

        for (let f = faceLo; f <= faceHi; f++) {
            mask.fill(0);
            maskT.fill(0);
            coord[faceAxis]  = f;
            coordA[faceAxis] = f + (faceAxis === 0 ? dx : faceAxis === 1 ? dy : dz);

            for (let u = uLo; u <= uHi; u++) {
                coord[uAxis]  = u;
                coordA[uAxis] = u;
                const rowBase = u * nV;

                for (let v = vLo; v <= vHi; v++) {
                    coord[vAxis]  = v;
                    coordA[vAxis] = v;

                    const lx = coord[0],  ly = coord[1],  lz = coord[2];
                    const ax = coordA[0], ay = coordA[1], az = coordA[2];

                    // Source voxel is always inside the chunk.
                    const id = voxels[lx + ly * SY + lz * SZ];
                    if (id === 0) continue;   // air emits no face in either pass

                    // Adjacent voxel may be vertically out of world or across XZ.
                    const adjId = (ay < 0 || ay >= N_Y)
                        ? SOLID_SENTINEL
                        : this._readXZ(voxels, nbr, ax, ay, az);

                    const solidSrc = solid[id] === 1;
                    const solidAdj = solid[adjId] === 1;

                    if (solidSrc) {
                        if (!solidAdj) mask[rowBase + v] = id;
                    } else if (adjId === 0) {
                        // Transparent (non-solid, non-air) against air.
                        maskT[rowBase + v] = id;
                    }
                }
            }

            this._greedyMerge(mask,  f, faceAxis, uAxis, vAxis, nU, nV, uLo, uHi, vLo, vHi, positive, ni, opaque);
            this._greedyMerge(maskT, f, faceAxis, uAxis, vAxis, nU, nV, uLo, uHi, vLo, vHi, positive, ni, transp);
        }
    }

    _greedyMerge(mask, depth, faceAxis, uAxis, vAxis, nU, nV, uLo, uHi, vLo, vHi, positive, ni, sink) {
        const done = this._doneFor(nU * nV);
        const brightness = FACE_BRIGHTNESS[ni];
        const colors = this._colors;
        const layerTable = ni === 2 ? this._layerTop : ni === 3 ? this._layerBottom : this._layerSide;

        const posArr = sink.pos, colArr = sink.col, uvArr = sink.uv, layArr = sink.lay, idxArr = sink.idx;

        for (let u = uLo; u <= uHi; u++) {
            const rowBase = u * nV;
            for (let v = vLo; v <= vHi; v++) {
                const cell = rowBase + v;
                const startId = mask[cell];
                if (!startId || done[cell]) continue;

                // Grow rectangle: expand v first, then u
                let vW = 1;
                while (v + vW <= vHi &&
                       mask[cell + vW] === startId &&
                       !done[cell + vW]) vW++;

                let uW = 1;
                expand_u:
                while (u + uW <= uHi) {
                    const probe = (u + uW) * nV + v;
                    for (let k = 0; k < vW; k++) {
                        if (mask[probe + k] !== startId || done[probe + k]) break expand_u;
                    }
                    uW++;
                }

                // Mark cells consumed
                for (let uu = 0; uu < uW; uu++) {
                    const base = (u + uu) * nV + v;
                    for (let vv = 0; vv < vW; vv++) done[base + vv] = 1;
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

                // Build the 4 quad corners directly into the position buffer.
                const faceOffset = positive ? depth + 1 : depth;
                const base = (posArr.n / 3) | 0;

                // Corner (u, v) offsets, in order 0..3
                const cu = [0, uW, uW, 0];
                const cv = [0, 0, vW, vW];
                for (let i = 0; i < 4; i++) {
                    let px = 0, py = 0, pz = 0;
                    // faceAxis / uAxis / vAxis are always a permutation of 0,1,2
                    if (faceAxis === 0) px = faceOffset; else if (faceAxis === 1) py = faceOffset; else pz = faceOffset;
                    const uVal = u + cu[i], vVal = v + cv[i];
                    if (uAxis === 0) px = uVal; else if (uAxis === 1) py = uVal; else pz = uVal;
                    if (vAxis === 0) px = vVal; else if (vAxis === 1) py = vVal; else pz = vVal;
                    posArr.push3(px, py, pz);
                    colArr.push3(r, g, b);
                    layArr.push1(layer);
                }

                // UV: tile once per block across both axes — shader uses fract() for repeating.
                // For ±X faces (faceAxis=0): uAxis=Y (vertical), vAxis=Z (horizontal).
                // Swap so UV.x maps to Z (horizontal on face) and UV.y maps to Y (vertical).
                if (faceAxis === 0) {
                    uvArr.push2(0, 0); uvArr.push2(0, uW); uvArr.push2(vW, uW); uvArr.push2(vW, 0);
                } else {
                    uvArr.push2(0, 0); uvArr.push2(uW, 0); uvArr.push2(uW, vW); uvArr.push2(0, vW);
                }

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

    /** Reusable `done` scratch, grown on demand and cleared per slice. */
    _doneFor(size) {
        if (!this._done || this._done.length < size) {
            this._done = new Uint8Array(size);
        } else {
            this._done.fill(0, 0, size);
        }
        return this._done;
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
