/**
 * ChunkManager
 *
 * Coordinates the lifecycle of chunks: deciding which chunks to load / unload,
 * scheduling generation and meshing jobs through the WorkerPool, and notifying
 * the render layer when geometry is ready or should be removed.
 *
 * Each chunk is a 16×640×16 column spanning the full world height.
 * Chunks are addressed by (cx, cz) only — there is no vertical chunking.
 *
 * Priority model (lower number = higher priority)
 * ───────────────────────────────────────────────
 *   0  partial XZ re-mesh — dirty seam fix on a visible chunk (fastest to process,
 *                           most noticeable if delayed)
 *   1  initial full mesh  — first appearance of a new chunk
 *   2  terrain generation — slowest job, can wait behind mesh updates
 *
 * The render layer (world.js) attaches three callbacks:
 *   onMeshReady(cx, cz, yGeo, xzGeo)  — full split mesh ready (initial / block-edit)
 *   onPartialMeshReady(cx, cz, xzGeo) — XZ side faces updated (neighbour-load fix)
 *   onChunkUnload(key)                — dispose Three.js mesh
 */

import { ChunkData, CHUNK_SIZE } from './ChunkData.js';
import { WorldState }            from './WorldState.js';

const MAX_DISPATCH = 32;  // max new jobs queued per update() call

// Build the four horizontal neighbour voxel buffers for a mesh job.
// Missing / ungenerated neighbours are omitted; the mesher culls those faces.
function _collectNeighbors(world, cx, cz) {
    const neighbors = {};
    for (const [ddx, ddz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nc = world.getChunk(cx + ddx, cz + ddz);
        if (nc?.generated) neighbors[`${ddx},${ddz}`] = nc.toUint16Array().buffer;
    }
    return neighbors;
}

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
        this.onMeshReady        = null;  // (cx, cz, yGeo, xzGeo) => void
        this.onPartialMeshReady = null;  // (cx, cz, xzGeo) => void
        this.onChunkUnload      = null;  // (key) => void

        // Track in-flight jobs so we never double-dispatch
        this._pendingGen   = new Set();  // keys currently being generated
        this._pendingMesh  = new Set();  // keys currently being full-meshed
        this._pendingMeshXZ = new Set(); // keys currently being partial-XZ-meshed

        // Keys unloaded while their generation was still in-flight.
        this._cancelledChunks = new Set();

        // Server-backed world persistence. Set worldId and worldClient to enable.
        this.worldId     = null;
        this.worldClient = null;
    }

    /** Send all currently loaded chunks to the server in one WebSocket batch. */
    saveAll() {
        if (this.worldId && this.worldClient?.connected) {
            this.worldClient.saveChunks(this.worldId, this.world);
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Called every frame. Drives the load / unload cycle.
     *
     * @param {{ x, y, z }} playerPos   — world-space position
     */
    update(playerPos) {
        const pcx = WorldState.worldToChunk(playerPos.x | 0);
        const pcz = WorldState.worldToChunk(playerPos.z | 0);

        // ── Build set of chunk columns that should be resident ──────────────
        const needed = new Set();
        const rd     = this.renderDistance;

        for (let dx = -rd; dx <= rd; dx++) {
            for (let dz = -rd; dz <= rd; dz++) {
                // Circular cull — skip corners beyond the render radius
                if (dx*dx + dz*dz > (rd + 0.5) * (rd + 0.5)) continue;
                needed.add(WorldState.key(pcx + dx, pcz + dz));
            }
        }

        // ── Unload chunks no longer needed ──────────────────────────────────
        for (const key of [...this.world.chunks.keys()]) {
            if (!needed.has(key)) this._unload(key);
        }

        // ── Collect and prioritise missing chunks ────────────────────────────
        const missing = [];
        for (const key of needed) {
            const chunk = this.world.chunks.get(key);
            if (chunk?.generated && !chunk.dirty) continue;
            if (this._pendingGen.has(key) || this._pendingMesh.has(key) || this._pendingMeshXZ.has(key)) continue;
            const [cx, cz] = key.split(',').map(Number);
            missing.push({
                key, cx, cz,
                priority: this._priority(cx, cz, pcx, pcz),
            });
        }

        missing.sort((a, b) => a.priority - b.priority);

        // ── Dispatch generation jobs ─────────────────────────────────────────
        let dispatched = 0;
        for (const { key, cx, cz } of missing) {
            if (dispatched >= MAX_DISPATCH) break;
            const chunk = this.world.chunks.get(key);

            if (!chunk || !chunk.generated) {
                this._requestGenerate(cx, cz);
            } else if (chunk.dirty) {
                this._requestMesh(cx, cz);
            }
            dispatched++;
        }
    }

    /** Force a re-mesh of a chunk (e.g., after a block is placed/broken). */
    markDirty(cx, cz) {
        const chunk = this.world.getChunk(cx, cz);
        if (chunk) {
            chunk.dirty = true;
            this._requestMesh(cx, cz);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _priority(cx, cz, pcx, pcz) {
        const dx = cx - pcx;
        const dz = cz - pcz;
        return Math.sqrt(dx*dx + dz*dz);
    }

    async _requestGenerate(cx, cz) {
        const key = WorldState.key(cx, cz);
        if (this._pendingGen.has(key)) return;
        this._pendingGen.add(key);

        // Try to load a saved chunk via WebSocket first.
        if (this.worldId && this.worldClient?.connected) {
            const saved = await this.worldClient.loadChunk(this.worldId, cx, cz);
            if (saved) {
                this._pendingGen.delete(key);
                if (this._cancelledChunks.has(key)) {
                    this._cancelledChunks.delete(key);
                    return;
                }
                this.world.setChunk(cx, cz, ChunkData.deserialize(cx, cz, saved));
                this._requestMesh(cx, cz);
                this._remeshNeighbors(cx, cz);
                return;
            }
        }

        // No saved data — generate via worker (lowest priority: gen waits behind mesh jobs).
        this.pool.dispatch(
            { type: 'generateChunk', cx, cz },
            ({ voxels }) => {
                this._pendingGen.delete(key);

                if (this._cancelledChunks.has(key)) {
                    this._cancelledChunks.delete(key);
                    return;
                }

                const chunk = new ChunkData(cx, cz);
                chunk.loadVoxels(new Uint16Array(voxels));
                chunk.generated = true;

                this.world.setChunk(cx, cz, chunk);

                this._requestMesh(cx, cz);
                this._remeshNeighbors(cx, cz);
            },
            [],
            2, // priority: lowest — generation is slow; mesh updates should run first
        );
    }

    _remeshNeighbors(cx, cz) {
        for (const [ddx, ddz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nc = this.world.getChunk(cx + ddx, cz + ddz);
            if (!nc?.generated) continue;
            nc.dirty = true;
            if (nc.meshed) {
                // Chunk is already visible — fix the seam immediately with a high-priority
                // partial re-mesh that only rebuilds the ±X / ±Z side faces.
                this._requestPartialMesh(cx + ddx, cz + ddz);
            }
            // If nc hasn't been rendered yet, update() will dispatch the initial full mesh
            // later, capturing up-to-date neighbour data at that time.
        }
    }

    _requestMesh(cx, cz) {
        const key   = WorldState.key(cx, cz);
        const chunk = this.world.getChunk(cx, cz);
        if (!chunk?.generated) return;

        if (this._pendingMesh.has(key)) {
            chunk.dirty = true;
            return;
        }

        this._pendingMesh.add(key);
        chunk.dirty = false;

        const neighbors = _collectNeighbors(this.world, cx, cz);

        this.pool.dispatch(
            { type: 'meshChunk', cx, cz, voxels: chunk.toUint16Array().buffer, neighbors, partial: false },
            ({ yGeo, xzGeo }) => {
                this._pendingMesh.delete(key);

                // Stale result — chunk was unloaded or replaced while in flight.
                if (this.world.getChunk(cx, cz) !== chunk) return;

                chunk.meshed = true;
                this.onMeshReady?.(cx, cz, yGeo, xzGeo);

                // Re-run full mesh if dirty was set during this job (e.g. block edit).
                if (chunk.dirty) this._requestMesh(cx, cz);
            },
            [],
            1, // priority: normal — initial chunk appearances
        );
    }

    _requestPartialMesh(cx, cz) {
        const key   = WorldState.key(cx, cz);
        const chunk = this.world.getChunk(cx, cz);
        // Only relevant for chunks already on screen; unrendered chunks get a full mesh.
        if (!chunk?.generated || !chunk.meshed) return;

        if (this._pendingMesh.has(key)) {
            // Full mesh already in flight — it will incorporate the latest neighbours.
            chunk.dirty = true;
            return;
        }
        if (this._pendingMeshXZ.has(key)) {
            // Another partial is in flight — re-run once it finishes.
            chunk.dirty = true;
            return;
        }

        this._pendingMeshXZ.add(key);
        chunk.dirty = false;

        const neighbors = _collectNeighbors(this.world, cx, cz);

        this.pool.dispatch(
            { type: 'meshChunk', cx, cz, voxels: chunk.toUint16Array().buffer, neighbors, partial: true },
            ({ xzGeo }) => {
                this._pendingMeshXZ.delete(key);

                if (this.world.getChunk(cx, cz) !== chunk) return;

                this.onPartialMeshReady?.(cx, cz, xzGeo);

                // If more neighbours loaded while this job ran, queue another partial.
                if (chunk.dirty) this._requestPartialMesh(cx, cz);
            },
            [],
            0, // priority: highest — fixes visible seams before new chunks appear
        );
    }

    _unload(key) {
        if (this._pendingGen.has(key)) this._cancelledChunks.add(key);

        this._pendingGen.delete(key);
        this._pendingMesh.delete(key);
        this._pendingMeshXZ.delete(key);
        this.onChunkUnload?.(key);
        this.world.removeChunkByKey(key);
    }
}
