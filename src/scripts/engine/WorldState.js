import { ChunkData, CHUNK_SIZE, CHUNK_SHIFT, CHUNK_MASK, CHUNK_SIZE_Y, WORLD_MIN_Y, voxelIndex } from './ChunkData.js';

export class WorldState {
    constructor() {
        this.chunks = new Map(); // "cx,cz" -> ChunkData
        this.seed   = (Math.random() * 0x7FFFFFFF) | 0;
        // Block edits keyed by chunk: Map<"cx,cz", Map<voxelIndex, blockId>>.
        // Survives chunk unload so edits can be replayed when a chunk regenerates.
        // Cleared per-chunk when that chunk is saved to the server.
        this.pendingChanges = new Map();
        // Keys of the chunks edited since world.js last summarised them for far
        // terrain (which shows what the player has built from a distance).
        this.edited = new Set();
        // Bumped on every block edit and chunk load/unload. Caches derived from
        // voxel data (smooth-terrain collision shapes) compare against it.
        this.editVersion = 0;
        // Where: the chunk of each of the last changes, cx then cz, written
        // round and round; changeSeq counts them all. Whoever keeps a cache
        // remembers the count it has seen and drops only what the changes since
        // could have touched (or everything, if it has fallen a lap behind).
        this.changeLog = new Int32Array(2 * 256);
        this.changeSeq = 0;

        // The last chunk getChunk() looked up (or its absence). Voxel reads come
        // in runs inside one chunk — collision, raycasts, smooth shapes, mob AI —
        // and building the string key is most of a lookup's cost: every getBlock
        // used to allocate a string. Reset by anything that changes the map.
        this._lastCx = NaN;
        this._lastCz = NaN;
        this._lastChunk = undefined;
    }

    // ── Chunk access ────────────────────────────────────────────────────────────

    static key(cx, cz)         { return `${cx},${cz}`; }

    getChunk(cx, cz) {
        if (cx === this._lastCx && cz === this._lastCz) return this._lastChunk;
        const chunk = this.chunks.get(WorldState.key(cx, cz));
        this._lastCx = cx;
        this._lastCz = cz;
        this._lastChunk = chunk;
        return chunk;
    }
    hasChunk(cx, cz)           { return this.getChunk(cx, cz) !== undefined; }
    hasChunkByKey(key)         { return this.chunks.has(key);                     }
    setChunk(cx, cz, chunk)    { this.chunks.set(WorldState.key(cx, cz), chunk); this._changed(cx, cz); }

    removeChunk(cx, cz) {
        const key   = WorldState.key(cx, cz);
        const chunk = this.chunks.get(key);
        if (chunk) {
            chunk.mesh            = null;
            chunk.transparentMesh = null;
        }
        this.chunks.delete(key);
        this._changed(cx, cz);
    }

    removeChunkByKey(key) {
        this.chunks.delete(key);
        const comma = key.indexOf(',');
        this._changed(Number(key.slice(0, comma)), Number(key.slice(comma + 1)));
    }

    /** The chunk map changed: bump the version and forget the cached lookup. */
    _changed(cx, cz) {
        this._note(cx, cz);
        this._lastCx = this._lastCz = NaN;
        this._lastChunk = undefined;
    }

    /** Record a change in chunk (cx, cz). */
    _note(cx, cz) {
        const k = (this.changeSeq % (this.changeLog.length >> 1)) * 2;
        this.changeLog[k] = cx;
        this.changeLog[k + 1] = cz;
        this.changeSeq++;
        this.editVersion++;
    }

    // ── Block access (world-space coordinates) ───────────────────────────────────

    getBlock(wx, wy, wz) {
        const ly = wy - WORLD_MIN_Y;
        if (ly < 0 || ly >= CHUNK_SIZE_Y) return 0;
        const chunk = this.getChunk(wx >> CHUNK_SHIFT, wz >> CHUNK_SHIFT);
        if (!chunk?.generated) return 0;
        return chunk.getVoxel(wx & CHUNK_MASK, ly, wz & CHUNK_MASK);
    }

    setBlock(wx, wy, wz, id) {
        const ly = wy - WORLD_MIN_Y;
        if (ly < 0 || ly >= CHUNK_SIZE_Y) return false;
        const cx  = wx >> CHUNK_SHIFT;
        const cz  = wz >> CHUNK_SHIFT;
        const lx  = wx & CHUNK_MASK;
        const lz  = wz & CHUNK_MASK;
        const key = WorldState.key(cx, cz);

        // Record change in persistent memory so it can be replayed if the chunk
        // unloads before the next auto-save.
        if (!this.pendingChanges.has(key)) this.pendingChanges.set(key, new Map());
        this.pendingChanges.get(key).set(voxelIndex(lx, ly, lz), id);
        this.edited.add(key);

        this._note(cx, cz);
        // Whoever else is in this world is told (world.js: Multiplayer).
        this.onSet?.(wx, wy, wz, id);
        const chunk = this.getChunk(cx, cz);
        if (!chunk) return false;
        chunk.setVoxel(lx, ly, lz, id);
        return true;
    }

    // ── Coordinate helpers ───────────────────────────────────────────────────────

    // Converts a world XZ coordinate to its chunk coordinate.
    static worldToChunk(worldCoord) { return worldCoord >> CHUNK_SHIFT; }
    static chunkToWorld(chunkCoord) { return chunkCoord << CHUNK_SHIFT; }

    // Returns chunk column coords for the given world point.
    static chunkAt(wx, wy, wz) {
        return {
            cx: wx >> CHUNK_SHIFT,
            cz: wz >> CHUNK_SHIFT,
        };
    }
}
