/**
 * Greedy Mesher
 *
 * Converts a 16×640×16 voxel chunk column (plus its four horizontal neighbours
 * for boundary face visibility) into two compact triangle meshes:
 *   • opaque       — standard opaque blocks
 *   • transparent  — water, leaves, glass etc.
 *
 * Because chunks now span the full world height there are no vertical chunk
 * boundaries.  Only four horizontal neighbours are needed (±X, ±Z).
 * Y values outside [0, CHUNK_SIZE_Y) are treated as solid (0xFFFF) so faces
 * at the world's top and bottom edges are culled.
 *
 * Algorithm summary per face direction:
 *   1. Build a mask for each perpendicular slice.
 *      mask[u][v] = blockID if the face between voxel (u,v) and its neighbour
 *      in the face direction is visible, otherwise 0.
 *   2. Walk the mask and expand each non-zero run into the largest rectangle
 *      of the same blockID (greedy merge in v first, then u).
 *   3. Emit one quad per rectangle.
 *
 * Chunk dimensions:  DIM = [16, 640, 16]  (X, Y, Z)
 *
 * Face-axis / u-axis / v-axis mapping:
 *   X faces  (±X): faceAxis=0, uAxis=1 (Y,640), vAxis=2 (Z,16)  — 16 slices of 640×16
 *   Y faces  (±Y): faceAxis=1, uAxis=2 (Z,16),  vAxis=0 (X,16)  — 640 slices of 16×16
 *   Z faces  (±Z): faceAxis=2, uAxis=0 (X,16),  vAxis=1 (Y,640) — 16 slices of 16×640
 *
 * Winding order (Three.js CCW = front-face):
 *   Positive face (+X/+Y/+Z): indices 0,1,2  0,2,3
 *   Negative face (-X/-Y/-Z): indices 0,2,1  0,3,2
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, voxelIndex } from '../engine/ChunkData.js';

const N_XZ = CHUNK_SIZE;    // 16
const N_Y  = CHUNK_SIZE_Y;  // 640

// DIM[axis] = number of voxels along that axis
const DIM = [N_XZ, N_Y, N_XZ];

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

export class GreedyMesher {
    /**
     * @param {BlockRegistry} blockRegistry
     * @param {Object} blockFaceMap  { blockId: { top, side, bottom } } — texture layer indices.
     *   A value of -1 (or missing entry) means use vertex color for that block.
     */
    constructor(blockRegistry, blockFaceMap = {}) {
        this.reg          = blockRegistry;
        this.blockFaceMap = blockFaceMap;
    }

    /**
     * Mesh only the face directions listed in `faceDefIndices` (0–5 indices into FACE_DEFS).
     *   0=+X  1=-X  2=+Y  3=-Y  4=+Z  5=-Z
     *
     * Use [2,3]       for top/bottom (±Y) faces — permanent; never changes on neighbour load.
     * Use [0,1,4,5]   for side (±X, ±Z) faces  — updated when a horizontal neighbour loads.
     */
    meshGroup(voxels, neighbors, faceDefIndices) {
        const pos   = [], norm  = [], col  = [], idx  = [], uv  = [], lay  = [];
        const tPos  = [], tNorm = [], tCol = [], tIdx = [], tuv = [], tlay = [];

        for (const i of faceDefIndices) {
            this._sweepFace(FACE_DEFS[i], voxels, neighbors,
                pos, norm, col, idx, uv, lay,
                tPos, tNorm, tCol, tIdx, tuv, tlay);
        }

        return {
            positions:            new Float32Array(pos),
            normals:              new Float32Array(norm),
            colors:               new Float32Array(col),
            indices:              new Uint32Array(idx),
            uvs:                  new Float32Array(uv),
            layers:               new Float32Array(lay),
            transparentPositions: new Float32Array(tPos),
            transparentNormals:   new Float32Array(tNorm),
            transparentColors:    new Float32Array(tCol),
            transparentIndices:   new Uint32Array(tIdx),
            transparentUVs:       new Float32Array(tuv),
            transparentLayers:    new Float32Array(tlay),
        };
    }

    /** Full mesh — all 6 face directions. */
    mesh(voxels, neighbors) {
        return this.meshGroup(voxels, neighbors, [0, 1, 2, 3, 4, 5]);
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    _getVoxel(voxels, neighbors, lx, ly, lz) {
        if (lx >= 0 && lx < N_XZ && ly >= 0 && ly < N_Y && lz >= 0 && lz < N_XZ) {
            return voxels[voxelIndex(lx, ly, lz)];
        }
        // Y out of world bounds → treat as solid so world-edge faces are culled
        if (ly < 0 || ly >= N_Y) return 0xFFFF;
        // XZ neighbor lookup — ly is guaranteed in [0, N_Y) at this point
        const nx = lx < 0 ? -1 : lx >= N_XZ ? 1 : 0;
        const nz = lz < 0 ? -1 : lz >= N_XZ ? 1 : 0;
        const nv = neighbors?.[`${nx},${nz}`];
        if (!nv) return 0xFFFF;  // unloaded neighbor → cull all faces toward it
        return nv[voxelIndex(
            ((lx % N_XZ) + N_XZ) % N_XZ,
            ly,
            ((lz % N_XZ) + N_XZ) % N_XZ,
        )];
    }

    _sweepFace(fd, voxels, neighbors,
        pos, norm, col, idx, uv, lay,
        tPos, tNorm, tCol, tIdx, tuv, tlay)
    {
        const { faceAxis, uAxis, vAxis, positive, ni } = fd;
        const [dx, dy, dz] = NORMALS[ni];
        const brightness    = FACE_BRIGHTNESS[ni];
        const normal        = NORMALS[ni];
        const reg           = this.reg;

        const nFace = DIM[faceAxis];
        const nU    = DIM[uAxis];
        const nV    = DIM[vAxis];

        const coord = [0, 0, 0];
        const mask  = new Int32Array(nU * nV);
        const maskT = new Int32Array(nU * nV);

        for (coord[faceAxis] = 0; coord[faceAxis] < nFace; coord[faceAxis]++) {
            // Fill masks for this slice
            for (let u = 0; u < nU; u++) {
                coord[uAxis] = u;
                for (let v = 0; v < nV; v++) {
                    coord[vAxis] = v;
                    const [lx, ly, lz] = coord;
                    const id    = this._getVoxel(voxels, neighbors, lx,    ly,    lz);
                    const adjId = this._getVoxel(voxels, neighbors, lx+dx, ly+dy, lz+dz);

                    const solidSrc  = reg.isSolid(id);
                    const solidAdj  = adjId === 0xFFFF || reg.isSolid(adjId);
                    const transpSrc = !solidSrc && id !== 0;
                    const airAdj    = adjId === 0;

                    mask [u * nV + v] = (solidSrc  && !solidAdj) ? id : 0;
                    maskT[u * nV + v] = (transpSrc && airAdj)    ? id : 0;
                }
            }

            const depth = coord[faceAxis];
            this._greedyMerge(mask,  depth, faceAxis, uAxis, vAxis, nU, nV, positive, ni, brightness, normal, pos,  norm,  col,  idx,  uv,  lay,  false);
            this._greedyMerge(maskT, depth, faceAxis, uAxis, vAxis, nU, nV, positive, ni, brightness, normal, tPos, tNorm, tCol, tIdx, tuv, tlay, true );
        }
    }

    _greedyMerge(mask, depth, faceAxis, uAxis, vAxis, nU, nV, positive, ni, brightness, normal,
        posArr, normArr, colArr, idxArr, uvArr, layArr, transparent)
    {
        const done = new Uint8Array(nU * nV);

        for (let u = 0; u < nU; u++) {
            for (let v = 0; v < nV; v++) {
                const startId = mask[u * nV + v];
                if (!startId || done[u * nV + v]) continue;

                // Grow rectangle: expand v first, then u
                let vW = 1;
                while (v + vW < nV &&
                       mask[u * nV + v + vW] === startId &&
                       !done[u * nV + v + vW]) vW++;

                let uW = 1;
                expand_u:
                while (u + uW < nU) {
                    for (let k = 0; k < vW; k++) {
                        if (mask[(u + uW) * nV + v + k] !== startId ||
                            done[(u + uW) * nV + v + k]) break expand_u;
                    }
                    uW++;
                }

                // Mark cells consumed
                for (let uu = u; uu < u + uW; uu++)
                    for (let vv = v; vv < v + vW; vv++)
                        done[uu * nV + vv] = 1;

                // Determine texture layer for this face (-1 = use vertex color)
                const faceEntry = this.blockFaceMap[startId];
                const layer = faceEntry ? this._faceLayer(faceEntry, ni) : -1;

                // Build vertex color: textured faces store brightness; others store full color
                const block = this.reg.get(startId);
                let [r, g, b] = this._faceColor(block, ni);
                if (layer >= 0) {
                    // Store brightness as uniform grey so the shader can tint the texture
                    r = brightness; g = brightness; b = brightness;
                } else {
                    r *= brightness; g *= brightness; b *= brightness;
                }

                // Build 4 quad vertices
                const faceOffset = positive ? depth + 1 : depth;
                const p = [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
                p[0][faceAxis] = faceOffset;  p[0][uAxis] = u;      p[0][vAxis] = v;
                p[1][faceAxis] = faceOffset;  p[1][uAxis] = u + uW; p[1][vAxis] = v;
                p[2][faceAxis] = faceOffset;  p[2][uAxis] = u + uW; p[2][vAxis] = v + vW;
                p[3][faceAxis] = faceOffset;  p[3][uAxis] = u;      p[3][vAxis] = v + vW;

                // UV: tile once per block across both axes
                // (0,0)→(uW,0)→(uW,vW)→(0,vW) — shader uses fract() for repeating
                const uvCoords = [[0,0],[uW,0],[uW,vW],[0,vW]];

                const base = (posArr.length / 3) | 0;
                for (const pt of p) posArr.push(pt[0], pt[1], pt[2]);
                for (let i = 0; i < 4; i++) {
                    normArr.push(normal[0], normal[1], normal[2]);
                    colArr.push(r, g, b);
                    uvArr.push(uvCoords[i][0], uvCoords[i][1]);
                    layArr.push(layer);
                }

                if (positive) {
                    idxArr.push(base, base+1, base+2, base, base+2, base+3);
                } else {
                    idxArr.push(base, base+2, base+1, base, base+3, base+2);
                }
            }
        }
    }

    _faceLayer(faceEntry, ni) {
        // ni: 2=+Y(top), 3=-Y(bottom), others=side
        if (ni === 2) return faceEntry.top  ?? -1;
        if (ni === 3) return faceEntry.bottom ?? faceEntry.top ?? -1;
        return faceEntry.side ?? faceEntry.top ?? -1;
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
