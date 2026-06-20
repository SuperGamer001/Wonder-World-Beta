import { ChunkData, CHUNK_SIZE, CHUNK_SHIFT, CHUNK_MASK } from './ChunkData.js';

export class WorldState {
    constructor() {
        this.chunks = new Map(); // "cx,cy,cz" -> ChunkData
        this.seed   = (Math.random() * 0x7FFFFFFF) | 0;
    }

    // ── Chunk access ────────────────────────────────────────────────────────

    static key(cx, cy, cz) { return `${cx},${cy},${cz}`; }

    getChunk(cx, cy, cz)        { return this.chunks.get(WorldState.key(cx, cy, cz));  }
    hasChunk(cx, cy, cz)        { return this.chunks.has(WorldState.key(cx, cy, cz));  }
    hasChunkByKey(key)          { return this.chunks.has(key);                          }

    setChunk(cx, cy, cz, chunk) { this.chunks.set(WorldState.key(cx, cy, cz), chunk); }

    removeChunk(cx, cy, cz) {
        const key   = WorldState.key(cx, cy, cz);
        const chunk = this.chunks.get(key);
        if (chunk) {
            chunk.mesh            = null;
            chunk.transparentMesh = null;
        }
        this.chunks.delete(key);
    }

    removeChunkByKey(key) { this.chunks.delete(key); }

    // ── Block access (world-space coordinates) ───────────────────────────────

    getBlock(wx, wy, wz) {
        const cx = wx >> CHUNK_SHIFT;
        const cy = wy >> CHUNK_SHIFT;
        const cz = wz >> CHUNK_SHIFT;
        const chunk = this.getChunk(cx, cy, cz);
        if (!chunk?.generated) return 0;
        return chunk.getVoxel(wx & CHUNK_MASK, wy & CHUNK_MASK, wz & CHUNK_MASK);
    }

    setBlock(wx, wy, wz, id) {
        const cx = wx >> CHUNK_SHIFT;
        const cy = wy >> CHUNK_SHIFT;
        const cz = wz >> CHUNK_SHIFT;
        const chunk = this.getChunk(cx, cy, cz);
        if (!chunk) return false;
        chunk.setVoxel(wx & CHUNK_MASK, wy & CHUNK_MASK, wz & CHUNK_MASK, id);
        return true;
    }

    // ── Coordinate helpers ───────────────────────────────────────────────────

    static worldToChunk(worldCoord) { return worldCoord >> CHUNK_SHIFT; }
    static chunkToWorld(chunkCoord) { return chunkCoord << CHUNK_SHIFT; }

    // Returns chunk coords containing the given world point.
    static chunkAt(wx, wy, wz) {
        return {
            cx: wx >> CHUNK_SHIFT,
            cy: wy >> CHUNK_SHIFT,
            cz: wz >> CHUNK_SHIFT,
        };
    }
}
