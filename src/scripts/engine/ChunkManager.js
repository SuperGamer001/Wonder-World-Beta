/**
 * ChunkManager
 *
 * Coordinates the lifecycle of chunks: deciding which chunks to load / unload,
 * scheduling generation and meshing jobs through the WorkerPool, and notifying
 * the render layer when geometry is ready or should be removed.
 *
 * Priority model (lower number = higher priority)
 * ───────────────────────────────────────────────
 *   base   = Euclidean distance from player chunk
 *   × 0.6  if chunk is inside the view frustum
 *   × 0.7  if chunk is in the player's movement direction
 *   Result: chunks ahead of the player load noticeably before those behind.
 *
 * The render layer (world.js) attaches two callbacks:
 *   onMeshReady(cx, cy, cz, geometry)  — build / replace Three.js mesh
 *   onChunkUnload(key)                 — dispose Three.js mesh
 */

import { ChunkData, CHUNK_SIZE } from './ChunkData.js';
import { WorldState }            from './WorldState.js';

const N             = CHUNK_SIZE;
const MAX_DISPATCH  = 6;   // max new jobs queued per update() call (throttle)

export class ChunkManager {
    /**
     * @param {WorldState}  worldState
     * @param {WorkerPool}  workerPool
     * @param {number}      renderDistance   default render distance in chunks
     */
    constructor(worldState, workerPool, renderDistance = 4) {
        this.world          = worldState;
        this.pool           = workerPool;
        this.renderDistance = renderDistance;

        // Callbacks wired by world.js
        this.onMeshReady   = null;  // (cx, cy, cz, geometry) => void
        this.onChunkUnload = null;  // (key) => void

        // Track in-flight jobs so we never double-dispatch
        this._pendingGen  = new Set();  // keys currently being generated
        this._pendingMesh = new Set();  // keys currently being meshed
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Called every frame.  Drives the load / unload cycle.
     *
     * @param {{ x, y, z }} playerPos   — world-space position
     * @param {{ x, z }}    viewDir     — normalised horizontal look direction
     * @param {{ x, z }}    moveDir     — normalised horizontal movement direction (may be zero)
     */
    update(playerPos, viewDir, moveDir) {
        const pcx = WorldState.worldToChunk(playerPos.x | 0);
        const pcy = WorldState.worldToChunk(playerPos.y | 0);
        const pcz = WorldState.worldToChunk(playerPos.z | 0);

        // ── Build set of chunks that should be resident ────────────────────
        const needed = new Set();
        const rd     = this.renderDistance;

        // Slightly squash the Y range (vertical chunks are less critical)
        const yrd = Math.max(2, Math.ceil(rd * 0.6));

        for (let dx = -rd; dx <= rd; dx++) {
            for (let dy = -yrd; dy <= yrd; dy++) {
                for (let dz = -rd; dz <= rd; dz++) {
                    // Ellipsoidal cull — skip corners of the cube
                    const dist2 = dx*dx + (dy/0.6)*(dy/0.6) + dz*dz;
                    if (dist2 > (rd + 0.5) * (rd + 0.5)) continue;
                    needed.add(WorldState.key(pcx + dx, pcy + dy, pcz + dz));
                }
            }
        }

        // ── Unload chunks no longer needed ────────────────────────────────
        for (const key of [...this.world.chunks.keys()]) {
            if (!needed.has(key)) this._unload(key);
        }

        // ── Collect and prioritise missing chunks ──────────────────────────
        const missing = [];
        for (const key of needed) {
            const chunk = this.world.chunks.get(key);
            if (chunk?.generated && !chunk.dirty) continue;  // already good
            if (this._pendingGen.has(key) || this._pendingMesh.has(key)) continue;
            const [cx, cy, cz] = key.split(',').map(Number);
            missing.push({
                key, cx, cy, cz,
                priority: this._priority(cx, cy, cz, pcx, pcy, pcz, viewDir, moveDir),
            });
        }

        missing.sort((a, b) => a.priority - b.priority);

        // ── Dispatch generation jobs ───────────────────────────────────────
        let dispatched = 0;
        for (const { key, cx, cy, cz } of missing) {
            if (dispatched >= MAX_DISPATCH) break;
            const chunk = this.world.chunks.get(key);

            if (!chunk || !chunk.generated) {
                this._requestGenerate(cx, cy, cz);
            } else if (chunk.dirty) {
                this._requestMesh(cx, cy, cz);
            }
            dispatched++;
        }
    }

    /** Force a re-mesh of a chunk (e.g., after a block is placed/broken). */
    markDirty(cx, cy, cz) {
        const chunk = this.world.getChunk(cx, cy, cz);
        if (chunk) {
            chunk.dirty = true;
            this._requestMesh(cx, cy, cz);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _priority(cx, cy, cz, pcx, pcy, pcz, viewDir, moveDir) {
        const dx = cx - pcx;
        const dy = cy - pcy;
        const dz = cz - pcz;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.001;

        // Normalised horizontal direction to chunk
        const hdist = Math.sqrt(dx*dx + dz*dz) + 0.001;
        const nx = dx / hdist;
        const nz = dz / hdist;

        // Dot with view direction (in front → positive)
        const viewDot = nx * viewDir.x + nz * viewDir.z;
        // Dot with movement direction (in travel direction → positive)
        const moveDot = nx * (moveDir?.x ?? 0) + nz * (moveDir?.z ?? 0);

        const viewFactor = 1.0 - viewDot * 0.40;   // front chunks: ×0.60
        const moveFactor = 1.0 - moveDot * 0.20;   // travelling toward: ×0.80

        return dist * viewFactor * moveFactor;
    }

    _requestGenerate(cx, cy, cz) {
        const key = WorldState.key(cx, cy, cz);
        if (this._pendingGen.has(key)) return;
        this._pendingGen.add(key);

        this.pool.dispatch(
            { type: 'generateChunk', cx, cy, cz },
            ({ voxels }) => {
                this._pendingGen.delete(key);

                // voxels arrived as a transferred buffer — wrap it back.
                const chunk = new ChunkData(cx, cy, cz);
                chunk.voxels    = new Uint16Array(voxels);
                chunk.generated = true;

                this.world.setChunk(cx, cy, cz, chunk);

                // Immediately request a mesh
                this._requestMesh(cx, cy, cz);

                // Also re-mesh adjacent chunks that share a face with this one,
                // so their boundary faces are updated with correct neighbour data.
                const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
                for (const [ddx, ddy, ddz] of dirs) {
                    const nc = this.world.getChunk(cx+ddx, cy+ddy, cz+ddz);
                    if (nc?.generated) this._requestMesh(cx+ddx, cy+ddy, cz+ddz);
                }
            },
        );
    }

    _requestMesh(cx, cy, cz) {
        const key   = WorldState.key(cx, cy, cz);
        const chunk = this.world.getChunk(cx, cy, cz);
        if (!chunk?.generated) return;
        if (this._pendingMesh.has(key)) return;

        this._pendingMesh.add(key);
        chunk.dirty = false;

        // Collect neighbour voxel data — copy (not transfer) so WorldState
        // retains ownership.  Missing neighbours send undefined (treated as air).
        const neighbors = {};
        const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        for (const [ddx, ddy, ddz] of dirs) {
            const nc = this.world.getChunk(cx+ddx, cy+ddy, cz+ddz);
            if (nc?.generated) {
                // Slice creates a copy without transferring
                neighbors[`${ddx},${ddy},${ddz}`] = nc.voxels.slice().buffer;
            }
        }

        this.pool.dispatch(
            { type: 'meshChunk', cx, cy, cz, voxels: chunk.voxels.slice().buffer, neighbors },
            ({ geometry }) => {
                this._pendingMesh.delete(key);
                chunk.meshed = true;

                // Notify the render layer
                this.onMeshReady?.(cx, cy, cz, geometry);
            },
        );
    }

    _unload(key) {
        this._pendingGen.delete(key);
        this._pendingMesh.delete(key);
        this.onChunkUnload?.(key);
        this.world.removeChunkByKey(key);
    }
}
