/**
 * Greedy Mesher
 *
 * Converts a 32x32x32 voxel chunk (plus its six face-adjacent neighbours for
 * boundary face visibility) into two compact triangle meshes:
 *   • opaque  — standard opaque blocks
 *   • transparent — water, leaves, glass etc.
 *
 * The mesher runs entirely inside a worker thread and returns plain typed
 * arrays that the main thread uploads to Three.js BufferGeometry.
 *
 * Algorithm summary per face direction:
 *   1. Build a 32×32 integer mask for the slice perpendicular to that axis.
 *      mask[u][v] = blockID if the face between voxel (u,v) and its neighbour
 *      in the face direction is visible, otherwise 0.
 *   2. Walk the mask and expand each non-zero run into the largest rectangle
 *      of the same blockID (greedy merge in v first, then u).
 *   3. Emit one quad per rectangle, appending positions / normals / colors /
 *      indices to the output arrays.
 *
 * Face-axis / u-axis / v-axis mapping:
 *   X faces  (±X): uAxis = Y, vAxis = Z
 *   Y faces  (±Y): uAxis = Z, vAxis = X
 *   Z faces  (±Z): uAxis = X, vAxis = Y
 *
 * Winding order (Three.js CCW = front-face convention):
 *   Positive face (+X/+Y/+Z): indices 0,1,2  0,2,3
 *   Negative face (-X/-Y/-Z): indices 0,2,1  0,3,2
 */

import { CHUNK_SIZE, voxelIndex } from '../engine/ChunkData.js';

const N = CHUNK_SIZE;

// Per-face directional brightness multiplier — simulates simple directional
// lighting without a real light pass.
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
    constructor(blockRegistry) {
        this.reg = blockRegistry;
    }

    /**
     * @param {Uint16Array} voxels      — this chunk's voxel data
     * @param {Object}      neighbors   — map "dx,dy,dz" → Uint16Array | undefined
     *                                    keys are "-1,0,0" "1,0,0" etc.
     * @returns {{ positions, normals, colors, indices,
     *             transparentPositions, transparentNormals,
     *             transparentColors, transparentIndices }}
     */
    mesh(voxels, neighbors) {
        const pos   = [], norm  = [], col  = [], idx  = [];
        const tPos  = [], tNorm = [], tCol = [], tIdx = [];

        for (const fd of FACE_DEFS) {
            this._sweepFace(fd, voxels, neighbors,
                pos, norm, col, idx,
                tPos, tNorm, tCol, tIdx);
        }

        return {
            positions:            new Float32Array(pos),
            normals:              new Float32Array(norm),
            colors:               new Float32Array(col),
            indices:              new Uint32Array(idx),
            transparentPositions: new Float32Array(tPos),
            transparentNormals:   new Float32Array(tNorm),
            transparentColors:    new Float32Array(tCol),
            transparentIndices:   new Uint32Array(tIdx),
        };
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    _getVoxel(voxels, neighbors, lx, ly, lz) {
        if (lx >= 0 && lx < N && ly >= 0 && ly < N && lz >= 0 && lz < N) {
            return voxels[voxelIndex(lx, ly, lz)];
        }
        const nx = lx < 0 ? -1 : lx >= N ? 1 : 0;
        const ny = ly < 0 ? -1 : ly >= N ? 1 : 0;
        const nz = lz < 0 ? -1 : lz >= N ? 1 : 0;
        const nv = neighbors?.[`${nx},${ny},${nz}`];
        if (!nv) return 0;
        return nv[voxelIndex(
            ((lx % N) + N) % N,
            ((ly % N) + N) % N,
            ((lz % N) + N) % N,
        )];
    }

    _sweepFace(fd, voxels, neighbors,
        pos, norm, col, idx,
        tPos, tNorm, tCol, tIdx)
    {
        const { faceAxis, uAxis, vAxis, positive, ni } = fd;
        const [dx, dy, dz] = NORMALS[ni];
        const brightness   = FACE_BRIGHTNESS[ni];
        const normal       = NORMALS[ni];
        const reg          = this.reg;

        const coord = [0, 0, 0];
        const mask  = new Int32Array(N * N);    // opaque face IDs
        const maskT = new Int32Array(N * N);    // transparent face IDs

        for (coord[faceAxis] = 0; coord[faceAxis] < N; coord[faceAxis]++) {
            // Fill masks for this slice
            for (let u = 0; u < N; u++) {
                coord[uAxis] = u;
                for (let v = 0; v < N; v++) {
                    coord[vAxis] = v;
                    const [lx, ly, lz] = coord;
                    const id    = this._getVoxel(voxels, neighbors, lx,    ly,    lz);
                    const adjId = this._getVoxel(voxels, neighbors, lx+dx, ly+dy, lz+dz);

                    const solidSrc  = reg.isSolid(id);
                    const solidAdj  = reg.isSolid(adjId);
                    const transpSrc = !solidSrc && id !== 0;
                    const airAdj    = adjId === 0;

                    mask [u * N + v] = (solidSrc  && !solidAdj) ? id : 0;
                    maskT[u * N + v] = (transpSrc && airAdj)    ? id : 0;
                }
            }

            const depth = coord[faceAxis];
            this._greedyMerge(mask,  depth, faceAxis, uAxis, vAxis, positive, ni, brightness, normal, pos,  norm,  col,  idx,  false);
            this._greedyMerge(maskT, depth, faceAxis, uAxis, vAxis, positive, ni, brightness, normal, tPos, tNorm, tCol, tIdx, true );
        }
    }

    _greedyMerge(mask, depth, faceAxis, uAxis, vAxis, positive, ni, brightness, normal,
        posArr, normArr, colArr, idxArr, transparent)
    {
        const done = new Uint8Array(N * N);

        for (let u = 0; u < N; u++) {
            for (let v = 0; v < N; v++) {
                const startId = mask[u * N + v];
                if (!startId || done[u * N + v]) continue;

                // Grow rectangle: expand v first, then u
                let vW = 1;
                while (v + vW < N &&
                       mask[u * N + v + vW] === startId &&
                       !done[u * N + v + vW]) vW++;

                let uW = 1;
                expand_u:
                while (u + uW < N) {
                    for (let k = 0; k < vW; k++) {
                        if (mask[(u + uW) * N + v + k] !== startId ||
                            done[(u + uW) * N + v + k]) break expand_u;
                    }
                    uW++;
                }

                // Mark cells consumed
                for (let uu = u; uu < u + uW; uu++)
                    for (let vv = v; vv < v + vW; vv++)
                        done[uu * N + vv] = 1;

                // Build 4 quad vertices
                const faceOffset = positive ? depth + 1 : depth;
                const p = [[0,0,0],[0,0,0],[0,0,0],[0,0,0]];
                p[0][faceAxis] = faceOffset;  p[0][uAxis] = u;      p[0][vAxis] = v;
                p[1][faceAxis] = faceOffset;  p[1][uAxis] = u + uW; p[1][vAxis] = v;
                p[2][faceAxis] = faceOffset;  p[2][uAxis] = u + uW; p[2][vAxis] = v + vW;
                p[3][faceAxis] = faceOffset;  p[3][uAxis] = u;      p[3][vAxis] = v + vW;

                // Block colour with face tinting
                const block = this.reg.get(startId);
                let [r, g, b] = this._faceColor(block, ni);
                r *= brightness; g *= brightness; b *= brightness;

                const base = (posArr.length / 3) | 0;
                for (const pt of p) posArr.push(pt[0], pt[1], pt[2]);
                for (let i = 0; i < 4; i++) {
                    normArr.push(normal[0], normal[1], normal[2]);
                    colArr.push(r, g, b);
                }

                // Winding: positive faces CCW match normal; negative need flip.
                if (positive) {
                    idxArr.push(base, base+1, base+2, base, base+2, base+3);
                } else {
                    idxArr.push(base, base+2, base+1, base, base+3, base+2);
                }
            }
        }
    }

    _faceColor(block, ni) {
        // ni: 0/1=±X  2/3=±Y  4/5=±Z
        if (ni === 2 && block.topColor)    return block.topColor;
        if (ni === 3 && block.bottomColor) return block.bottomColor;
        if ((ni === 0 || ni === 1 || ni === 4 || ni === 5) && block.sideColor) return block.sideColor;
        return block.color;
    }
}
