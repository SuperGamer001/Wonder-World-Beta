import { ChunkData, CHUNK_SIZE, CHUNK_SHIFT, CHUNK_MASK, CHUNK_SIZE_Y, WORLD_MIN_Y, voxelIndex } from './ChunkData.js';

export class WorldState {
    constructor() {
        this.chunks = new Map(); // "cx,cz" -> ChunkData
        this.seed   = (Math.random() * 0x7FFFFFFF) | 0;
        // Block edits keyed by chunk: Map<"cx,cz", Map<voxelIndex, blockId>>.
        // Survives chunk unload so edits can be replayed when a chunk regenerates.
        // Cleared per-chunk when that chunk is saved to the server.
        this.pendingChanges = new Map();
    }

    // ── Chunk access ────────────────────────────────────────────────────────────

    static key(cx, cz)         { return `${cx},${cz}`; }

    getChunk(cx, cz)           { return this.chunks.get(WorldState.key(cx, cz)); }
    hasChunk(cx, cz)           { return this.chunks.has(WorldState.key(cx, cz)); }
    hasChunkByKey(key)         { return this.chunks.has(key);                     }
    setChunk(cx, cz, chunk)    { this.chunks.set(WorldState.key(cx, cz), chunk); }

    removeChunk(cx, cz) {
        const key   = WorldState.key(cx, cz);
        const chunk = this.chunks.get(key);
        if (chunk) {
            chunk.mesh            = null;
            chunk.transparentMesh = null;
        }
        this.chunks.delete(key);
    }

    removeChunkByKey(key) { this.chunks.delete(key); }

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
