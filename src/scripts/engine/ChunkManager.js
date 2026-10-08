/**
 * ChunkManager
 *
 * Coordinates the lifecycle of chunks: deciding which chunks to load / unload,
 * scheduling generation and meshing jobs through the WorkerPool, and notifying
 * the render layer when geometry is ready or should be removed.
 *
 * Each chunk is a 16×448×16 column spanning the full world height.
 * Chunks are addressed by (cx, cz) only — there is no vertical chunking.
 *
 * Priority model (lower number = higher priority)
 * ───────────────────────────────────────────────
 *   0  re-mesh or relight of a chunk already on screen — a stale seam or light
 *      edge is the most noticeable thing to leave waiting
 *   1  first mesh — a new chunk appearing
 *   2  terrain generation — slowest job, can wait behind mesh updates
 *
 * Neighbour-driven work is coalesced: a chunk is not meshed while a neighbour
 * that is due to load is still missing, so it is meshed once rather than once
 * per neighbour that arrives after it (see _schedule).
 *
 * The render layer (world.js) attaches three callbacks:
 *   onMeshReady(cx, cz, geo, light)  — chunk geometry ready (first mesh, re-mesh or edit)
 *   onLightReady(cx, cz, light)      — sky light changed, geometry did not
 *   onChunkUnload(key)               — dispose Three.js mesh
 *
 * `light` is the chunk's sky light (workers/Skylight.js). It rides with every
 * mesh job and can arrive out of order, so each chunk counts its light jobs and
 * a result older than the one on screen passes `light` as null.
 *
 * Sky light reaches SKY_MAX blocks, so it depends on all eight surrounding
 * chunks: every job sends the diagonal chunks too, and a load or an edit
 * relights the neighbours whose geometry does not otherwise need rebuilding.
 */

import { ChunkData, CHUNK_SIZE, CHUNK_SHIFT, CHUNK_MASK, CHUNK_SIZE_Y } from './ChunkData.js';
import { WorldState }            from './WorldState.js';
import { SMOOTH_REACH }          from './SmoothShape.js';

const MAX_DISPATCH = 32;  // max new jobs queued per update() call

const NEIGHBOR_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL_OFFSETS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL_OFFSETS      = [...NEIGHBOR_OFFSETS, ...DIAGONAL_OFFSETS];

/**
 * Build the four horizontal neighbour payloads for a mesh job.
 *
 * Each neighbour is sent as its compressed palette pair rather than an expanded
 * Uint16Array: that is CHUNK_VOLUME bytes instead of 2x CHUNK_VOLUME, and the
 * expansion runs on the worker instead of blocking the frame. The returned
 * buffers are fresh copies, so they are pushed onto the transfer list by the
 * caller and move to the worker without a structured-clone copy.
 *
 * Missing / ungenerated neighbours are omitted; the mesher culls those faces.
 */
function _collectNeighbors(world, cx, cz, transferList) {
    const neighbors = {};
    for (const [ddx, ddz] of NEIGHBOR_OFFSETS) {
        const nc = world.getChunk(cx + ddx, cz + ddz);
        if (!nc?.generated) continue;
        const snap = nc.snapshot();
        neighbors[`${ddx},${ddz}`] = snap;
        transferList.push(snap.palette.buffer, snap.indices.buffer);
    }
    return neighbors;
}

/** Full snapshots of the four diagonal chunks, for sky light. */
function _collectDiagonals(world, cx, cz, transferList) {
    const diagonals = {};
    for (const [ddx, ddz] of DIAGONAL_OFFSETS) {
        const nc = world.getChunk(cx + ddx, cz + ddz);
        if (!nc?.generated) continue;
        const snap = nc.snapshot();
        diagonals[`${ddx},${ddz}`] = snap;
        transferList.push(snap.palette.buffer, snap.indices.buffer);
    }
    return diagonals;
}

/**
 * Smooth worlds only: the SMOOTH_REACH × SMOOTH_REACH columns of each diagonal
 * chunk nearest this chunk's corner. Smooth surfaces near a chunk corner read
 * voxels in the diagonal chunk; without them the two chunks would disagree
 * there and leave a crack.
 */
function _collectCorners(world, cx, cz, transferList) {
    const corners = {};
    const far = CHUNK_SIZE - SMOOTH_REACH;
    for (const [ddx, ddz] of DIAGONAL_OFFSETS) {
        const nc = world.getChunk(cx + ddx, cz + ddz);
        if (!nc?.generated) continue;
        const block = nc.cornerBlock(ddx > 0 ? 0 : far, ddz > 0 ? 0 : far, SMOOTH_REACH);
        corners[`${ddx},${ddz}`] = block;
        transferList.push(block.buffer);
    }
    return corners;
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
        this.onMeshReady        = null;  // (cx, cz, geo, light) => void
        this.onLightReady       = null;  // (cx, cz, light) => void
        this.onChunkUnload      = null;  // (key) => void

        // Track in-flight jobs so we never double-dispatch
        this._pendingGen    = new Map(); // key → token of the generation request in flight
        this._pendingMesh   = new Set(); // keys with a mesh job queued or in flight
        this._pendingLight  = new Set(); // keys with a light-only job in flight
        this._relight       = new Set(); // keys to relight again once that job returns
        this._gated         = new Map(); // key → chunk held until its neighbours load (_schedule)

        this._genToken = 0;

        // Cached residency set. Rebuilding it allocates ~500 string keys, so it is
        // recomputed only when the player crosses a chunk boundary or the render
        // distance changes — not on every one of the 60 update() calls per second.
        this._neededKeys   = new Set();
        this._neededCoords = [];        // parallel [cx, cz, cx, cz, …] for the missing scan
        this._neededList   = [];        // … and their keys, so the per-frame scan builds no strings
        this._lastPcx      = null;
        this._lastPcz      = null;
        this._lastRD       = -1;

        // Server-backed world persistence. Set worldId and worldClient to enable.
        this.worldId     = null;
        this.worldClient = null;

        // Generation gate. While false, update() dispatches nothing. world.js flips
        // this true only once persistence setup has finished (worldClient attached,
        // or confirmed unavailable). This prevents a startup race where the render
        // loop ticks during the connect()/fetchManifest() awaits — before
        // worldClient is attached — and generates fresh terrain over the spawn-area
        // chunks instead of loading the player's saved edits from disk.
        this.ready = false;

        // Smooth-terrain world. Set once by world.js before `ready`. Mesh shapes
        // at a chunk's edge depend on neighbour voxels (including diagonals), so
        // this widens neighbour re-meshing and sends corner columns.
        this.smooth = false;
    }

    /**
     * Send the server the loaded chunks it does not have yet — fresh terrain
     * never saved, and chunks edited since their last save — in one WebSocket
     * batch. This runs on every autosave and every time the pointer is
     * released (pause, the inventory, any menu). It used to send every loaded
     * chunk: at render distance 14 that was ~840 chunks, ~97 MB copied on the
     * main thread and every region file around the player compressed again,
     * about a second of CPU each time the inventory opened. When the client is
     * unsure what the server has (savedKeys null), everything goes.
     */
    saveAll() {
        if (!(this.worldId && this.worldClient?.connected)) return;
        const saved  = this.worldClient.savedKeys;
        const edited = this.world.pendingChanges;
        const chunks = new Map();
        for (const [key, chunk] of this.world.chunks) {
            if (!chunk.generated) continue;
            if (saved?.has(key) && !edited.has(key)) continue;
            chunks.set(key, chunk);
        }
        this.worldClient.saveChunks(this.worldId, { chunks }, saved === null);
        // Saved now, so there is nothing to replay on the next reload.
        for (const key of chunks.keys()) edited.delete(key);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Called every frame. Drives the load / unload cycle.
     *
     * @param {{ x, y, z }} playerPos   — world-space position
     */
    update(playerPos) {
        // Hold off all generation/meshing until persistence setup is complete, so
        // saved chunks are loaded from disk rather than regenerated as fresh terrain.
        if (!this.ready) return;

        // Math.floor, not `| 0`: truncation put x in (-1, 0) in chunk 0, which
        // shifted the loaded square a chunk the wrong way for that sliver.
        const pcx = WorldState.worldToChunk(Math.floor(playerPos.x));
        const pcz = WorldState.worldToChunk(Math.floor(playerPos.z));
        const rd  = this.renderDistance;

        // ── Rebuild the residency set only when it can actually have changed ──
        const moved = pcx !== this._lastPcx || pcz !== this._lastPcz || rd !== this._lastRD;
        if (moved) {
            this._lastPcx = pcx;
            this._lastPcz = pcz;
            this._lastRD  = rd;

            const needed = this._neededKeys;
            const coords = this._neededCoords;
            const list   = this._neededList;
            needed.clear();
            coords.length = 0;
            list.length = 0;

            // A square: every chunk within rd of the player's chunk on both
            // axes, (2rd+1)² in all. The chunk fog in world.js is shaped to
            // match, so the whole square is visible and its edge never is.
            for (let dx = -rd; dx <= rd; dx++) {
                for (let dz = -rd; dz <= rd; dz++) {
                    const cx = pcx + dx, cz = pcz + dz;
                    const key = WorldState.key(cx, cz);
                    needed.add(key);
                    coords.push(cx, cz);
                    list.push(key);
                }
            }

            // ── Unload chunks no longer needed ──────────────────────────────
            // Only possible right after the set changed, so it is gated too.
            for (const key of [...this.world.chunks.keys()]) {
                if (!needed.has(key)) this._unload(key);
            }
            // Requests for chunks not loaded yet are not in world.chunks, so the
            // sweep above never sees them. Dropping them invalidates their tokens:
            // queued ones never run, running ones are discarded on arrival.
            for (const key of [...this._pendingGen.keys()]) {
                if (!needed.has(key)) this._pendingGen.delete(key);
            }

            // A held chunk may have been waiting on a neighbour that is no
            // longer due to load; look at each again against the new set.
            for (const chunk of [...this._gated.values()]) this._schedule(chunk.cx, chunk.cz);
        }

        const coords = this._neededCoords;
        const keys   = this._neededList;

        // ── Collect and prioritise missing chunks ────────────────────────────
        // Walks the cached coordinate and key lists, so no key parsing and no
        // per-frame string allocation in the common case where nothing is
        // missing. (Building the key here cost ~650 strings a frame at render
        // distance 14 — steady garbage for the collector.)
        let missing = null;
        for (let i = 0; i < coords.length; i += 2) {
            const cx = coords[i], cz = coords[i + 1];
            const key = keys[i >> 1];
            const chunk = this.world.chunks.get(key);
            if (chunk?.generated && !chunk.dirty) continue;
            if (this._pendingGen.has(key) || this._pendingMesh.has(key)) continue;
            // Held for its neighbours; released by their arrival, not by polling,
            // so it must not use up this frame's dispatch budget.
            if (this._gated.has(key)) continue;
            (missing ??= []).push({
                key, cx, cz,
                priority: this._priority(cx, cz, pcx, pcz),
            });
        }

        if (missing === null) return;
        missing.sort((a, b) => a.priority - b.priority);

        // ── Dispatch generation jobs ─────────────────────────────────────────
        let dispatched = 0;
        for (const { key, cx, cz } of missing) {
            if (dispatched >= MAX_DISPATCH) break;
            const chunk = this.world.chunks.get(key);

            if (!chunk || !chunk.generated) {
                this._requestGenerate(cx, cz);
            } else if (chunk.dirty) {
                this._schedule(cx, cz);
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

    /**
     * Re-mesh after a single block edit at world coords (wx, wz). Always re-meshes
     * the edited chunk, and additionally re-meshes any face-adjacent neighbour whose
     * seam faces depend on this voxel — i.e. when the edit sits on a chunk boundary.
     * Without this, mining/placing at a chunk edge leaves the neighbour's boundary
     * faces stale (holes or leftover faces along the seam). Each re-mesh runs as a
     * job on the shared worker pool, so neighbour updates happen off the main thread.
     */
    markEdited(wx, wz) {
        const cx = wx >> CHUNK_SHIFT;
        const cz = wz >> CHUNK_SHIFT;
        this.markDirty(cx, cz);

        // How far a voxel's influence reaches across a seam: only the boundary
        // faces in blocky worlds, SMOOTH_REACH blocks of shapes in smooth ones.
        const m  = this.smooth ? SMOOTH_REACH : 1;
        const lx = wx & CHUNK_MASK;
        const lz = wz & CHUNK_MASK;
        const ex = lx < m ? -1 : lx >= CHUNK_SIZE - m ? 1 : 0;
        const ez = lz < m ? -1 : lz >= CHUNK_SIZE - m ? 1 : 0;
        if (ex) this.markDirty(cx + ex, cz);
        if (ez) this.markDirty(cx, cz + ez);
        // Smooth worlds: near a corner, the diagonal chunk's shapes read it too.
        if (this.smooth && ex && ez) this.markDirty(cx + ex, cz + ez);
        // Sky light from the edit reaches SKY_MAX blocks — into every neighbour
        // at any position in a 16-wide chunk. Relight the ones not re-meshed above.
        for (const [ddx, ddz] of ALL_OFFSETS) {
            const remeshed = (ex && ddx === ex && ddz === 0) || (ez && ddz === ez && ddx === 0) ||
                             (this.smooth && ex && ez && ddx === ex && ddz === ez);
            if (!remeshed) this._requestLight(cx + ddx, cz + ddz);
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _priority(cx, cz, pcx, pcz) {
        const dx = cx - pcx;
        const dz = cz - pcz;
        return Math.sqrt(dx*dx + dz*dz);
    }

    /**
     * Load or generate a chunk. Each request carries a token, and a result is
     * used only if its token is still the key's current one: unloading the
     * chunk (or a newer request for it) makes an in-flight result stale.
     * A cancellation set could not tell two requests for one key apart, so
     * after unload → reload → unload the old reply consumed the one
     * cancellation and the newer reply installed a chunk outside the render
     * distance — generated, meshed and uploaded for nothing.
     */
    async _requestGenerate(cx, cz) {
        const key = WorldState.key(cx, cz);
        if (this._pendingGen.has(key)) return;
        const token = ++this._genToken;
        this._pendingGen.set(key, token);
        const current = () => this._pendingGen.get(key) === token;

        // Try to load a saved chunk via WebSocket first.
        if (this.worldId && this.worldClient?.connected) {
            const saved = await this.worldClient.loadChunk(this.worldId, cx, cz);
            if (!current()) return;           // unloaded while the server answered
            if (saved) {
                this._pendingGen.delete(key);
                const chunk = ChunkData.deserialize(cx, cz, saved);
                this._applyPendingChanges(chunk, cx, cz);
                this.world.setChunk(cx, cz, chunk);
                chunk.dirty = true;
                this._schedule(cx, cz);
                this._remeshNeighbors(cx, cz);
                return;
            }
        }

        // No saved data — generate via worker (lowest priority: gen waits behind mesh jobs).
        this.pool.dispatch(
            // Checked when a worker frees up: a chunk left behind while its job
            // waited in the queue is dropped without being generated.
            () => current() ? { job: { type: 'generateChunk', cx, cz }, xfer: [] } : null,
            ({ type, palette, indices, minY, maxY }) => {
                // Stale: the chunk was unloaded, and perhaps requested again,
                // while this ran. Leave the newer request's state alone.
                if (!current()) return;
                this._pendingGen.delete(key);

                // Generation failed in the worker. The key is already cleared,
                // so update() will pick this column up again on a later frame
                // rather than leaving a permanent hole.
                if (type === 'error' || !indices) return;

                // Arrives palette-compressed from the worker: adopting it is free.
                const chunk = new ChunkData(cx, cz);
                chunk.adoptCompressed(palette, indices, minY, maxY);
                chunk.generated = true;
                this._applyPendingChanges(chunk, cx, cz);

                this.world.setChunk(cx, cz, chunk);

                chunk.dirty = true;
                this._schedule(cx, cz);
                this._remeshNeighbors(cx, cz);
            },
            [],
            2, // priority: lowest — generation is slow; mesh updates should run first
        );
    }

    /**
     * Chunk (cx, cz) has just arrived: record what each neighbour now needs
     * and let _schedule decide when to run it (see there).
     */
    _remeshNeighbors(cx, cz) {
        for (const [ddx, ddz] of ALL_OFFSETS) {
            const nx = cx + ddx, nz = cz + ddz;
            const nc = this.world.getChunk(nx, nz);
            if (!nc?.generated) continue;
            if (!nc.meshed || this.smooth || ddx === 0 || ddz === 0) {
                // Not on screen yet: its first mesh will see this chunk. Face
                // neighbours: the faces on the shared seam change. Smooth worlds:
                // a diagonal neighbour deforms Mesh voxels near the shared corner.
                nc.dirty = true;
            } else {
                // Blocky diagonal: geometry is unaffected, only its light.
                nc._needLight = true;
            }
            this._schedule(nx, nz);
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
        this._gated.delete(key);

        // Built when a worker takes the job (see WorkerPool.dispatch), so it
        // carries the chunk and its neighbours as they are then. Edits made
        // while it waited are included, which is why `dirty` clears here.
        let seq = 0;
        const build = () => {
            if (this.world.getChunk(cx, cz) !== chunk) return null;
            chunk.dirty = false;
            const xfer      = [];
            const self      = chunk.snapshot();
            xfer.push(self.palette.buffer, self.indices.buffer);
            const neighbors = _collectNeighbors(this.world, cx, cz, xfer);
            const diagonals = _collectDiagonals(this.world, cx, cz, xfer);
            const corners   = this.smooth ? _collectCorners(this.world, cx, cz, xfer) : undefined;
            seq = this._lightSeq(chunk);
            return { job: { type: 'meshChunk', cx, cz, chunk: self, neighbors, diagonals, corners }, xfer };
        };
        this.pool.dispatch(
            build,
            ({ type, geo, light }) => {
                this._pendingMesh.delete(key);

                // Meshing failed in the worker — leave the chunk dirty so the
                // next update() re-queues it instead of leaving it invisible.
                if (type === 'error' || !geo) {
                    if (this.world.getChunk(cx, cz) === chunk) chunk.dirty = true;
                    return;
                }

                // Stale result — chunk was unloaded or replaced while in flight.
                if (this.world.getChunk(cx, cz) !== chunk) return;

                chunk.meshed = true;
                this.onMeshReady?.(cx, cz, geo, this._freshLight(chunk, seq, light));

                // Re-run if dirty was set during this job (an edit, or a neighbour
                // arriving). Through the gate, so arrivals coalesce into one mesh.
                if (chunk.dirty) this._schedule(cx, cz);
            },
            [],
            // A chunk already on screen is showing a stale seam or edit; a new
            // one is merely not there yet.
            chunk.meshed ? 0 : 1,
        );
    }

    /**
     * Recompute only the sky light of a chunk already on screen. Chunks not yet
     * meshed get their light with their first mesh; a chunk with a light job in
     * flight is relit again when it returns, so the newest state always wins.
     */
    _requestLight(cx, cz) {
        const key   = WorldState.key(cx, cz);
        const chunk = this.world.getChunk(cx, cz);
        if (!chunk?.generated || !chunk.meshed) return;
        if (this._pendingLight.has(key)) { this._relight.add(key); return; }
        this._pendingLight.add(key);
        let seq = 0;
        const build = () => {
            if (this.world.getChunk(cx, cz) !== chunk) return null;
            // Anything asked for before this point is covered by this job.
            this._relight.delete(key);
            const xfer      = [];
            const self      = chunk.snapshot();
            xfer.push(self.palette.buffer, self.indices.buffer);
            const neighbors = _collectNeighbors(this.world, cx, cz, xfer);
            const diagonals = _collectDiagonals(this.world, cx, cz, xfer);
            seq = this._lightSeq(chunk);
            return { job: { type: 'lightChunk', cx, cz, chunk: self, neighbors, diagonals }, xfer };
        };
        this.pool.dispatch(
            build,
            ({ type, light }) => {
                this._pendingLight.delete(key);
                if (this.world.getChunk(cx, cz) !== chunk) { this._relight.delete(key); return; }
                const fresh = type === 'error' ? null : this._freshLight(chunk, seq, light);
                if (fresh) this.onLightReady?.(cx, cz, fresh);
                if (this._relight.delete(key) || type === 'error') this._requestLight(cx, cz);
            },
            [],
            0, // same as a seam fix: a stale light edge is just as visible
        );
    }

    /**
     * Neighbour-driven updates go through here rather than straight to a job.
     *
     * A chunk's geometry and light depend on all eight neighbours, so while one
     * that is due to load (inside the render distance) has not been generated
     * yet, any job would only have to be redone when it arrives. The chunk is
     * held in `_gated` instead, and re-examined when a neighbour arrives
     * (_remeshNeighbors) or the set of chunks to load changes (update). While
     * flying into new terrain that turns up to eight meshes per chunk — one per
     * neighbour arriving after it — into one. Neighbours outside the render
     * distance are not waited for, so chunks at the edge still appear.
     *
     * Once released, the cheaper job that covers what is outstanding runs: a
     * mesh (never meshed, or `dirty`; it carries light), else a light-only job.
     * Block edits do not come through here: they go straight to their jobs and
     * show at once.
     */
    _schedule(cx, cz) {
        const key   = WorldState.key(cx, cz);
        const chunk = this.world.getChunk(cx, cz);
        if (!chunk?.generated) { this._gated.delete(key); return; }
        if (this._awaitingNeighbours(cx, cz)) { this._gated.set(key, chunk); return; }
        this._gated.delete(key);

        if (!chunk.meshed || chunk.dirty) {
            chunk.dirty = true;
            chunk._needLight = false;                      // a mesh carries light
            this._requestMesh(cx, cz);
        } else if (chunk._needLight) {
            chunk._needLight = false;
            this._requestLight(cx, cz);
        }
    }

    /** Is a neighbour of (cx, cz) that is due to load not generated yet? */
    _awaitingNeighbours(cx, cz) {
        for (const [ddx, ddz] of ALL_OFFSETS) {
            const key = WorldState.key(cx + ddx, cz + ddz);
            if (this._neededKeys.has(key) && !this.world.chunks.get(key)?.generated) return true;
        }
        return false;
    }

    /** Number a job that will return light for `chunk`. */
    _lightSeq(chunk) { return (chunk._lightSeq = (chunk._lightSeq ?? 0) + 1); }

    /** `light` if no newer job's light has already been shown, else null. */
    _freshLight(chunk, seq, light) {
        if (!light || seq < (chunk._lightShown ?? 0)) return null;
        chunk._lightShown = seq;
        return light;
    }

    _unload(key) {
        // Persist dirty chunks before dropping them from memory so player edits
        // are not lost when a chunk scrolls out of the render distance before
        // the next auto-save fires.
        const chunk = this.world.chunks.get(key);
        const changes = this.world.pendingChanges.get(key);
        if (chunk?.generated && changes?.size > 0 && this.worldId && this.worldClient?.connected) {
            this.worldClient.saveChunks(this.worldId, { chunks: new Map([[key, chunk]]) });
            if (this.worldClient._savedChunks) this.worldClient._savedChunks.add(key);
            this.world.pendingChanges.delete(key);
        }

        this._pendingGen.delete(key);
        this._pendingMesh.delete(key);
        this._pendingLight.delete(key);
        this._relight.delete(key);
        this._gated.delete(key);
        this.onChunkUnload?.(key);
        this.world.removeChunkByKey(key);
    }

    // Replay any block edits that were made to this chunk while it was unloaded
    // (or before the first save). Converts the flat voxelIndex back to local coords.
    _applyPendingChanges(chunk, cx, cz) {
        const key     = WorldState.key(cx, cz);
        const changes = this.world.pendingChanges.get(key);
        if (!changes || changes.size === 0) return;
        for (const [idx, blockId] of changes) {
            const lx = idx % CHUNK_SIZE;
            const rem = (idx - lx) / CHUNK_SIZE;
            const ly = rem % CHUNK_SIZE_Y;
            const lz = (rem - ly) / CHUNK_SIZE_Y;
            chunk.setVoxel(lx, ly, lz, blockId);
        }
        chunk.dirty = true;
    }
}
