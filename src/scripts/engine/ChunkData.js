export const CHUNK_SIZE   = 16;                              // XZ size (blocks per axis)
export const CHUNK_SHIFT  = 4;                               // log2(CHUNK_SIZE)
export const CHUNK_MASK   = 0x0F;                            // CHUNK_SIZE - 1
export const CHUNK_SIZE_Y = 740;                             // Full world height
export const WORLD_MIN_Y  = -460;                            // Bottom of the world (BEDROCK_Y)
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE_Y * CHUNK_SIZE; // 16 × 640 × 16 = 163,840

// Packs local coords into a flat index.
// Layout: lx fastest (stride 1), ly middle (stride 16), lz slowest (stride 10,240).
// lx ∈ [0,15]  ly ∈ [0,639]  lz ∈ [0,15]
export function voxelIndex(lx, ly, lz) {
    return lx + ly * CHUNK_SIZE + lz * (CHUNK_SIZE * CHUNK_SIZE_Y);
}

// Unpacks a flat index back to local coords.
export function voxelCoords(idx) {
    const lx  = idx % CHUNK_SIZE;
    const rem = (idx - lx) / CHUNK_SIZE;
    const ly  = rem % CHUNK_SIZE_Y;
    const lz  = (rem - ly) / CHUNK_SIZE_Y;
    return { lx, ly, lz };
}

/**
 * Palette-compressed chunk storage for a 16×640×16 column.
 *
 * Each chunk spans the full world height (WORLD_MIN_Y to WORLD_MIN_Y + CHUNK_SIZE_Y).
 * There is exactly one chunk per (cx, cz) column — no vertical chunk stacking.
 *
 * Storage:
 *   _palette  — array of unique block IDs present (≤ 256 entries, all 20 block types fit)
 *   _indices  — Uint8Array(163,840) where each element indexes into _palette
 *
 * Workers operate on plain Uint16Array buffers; conversion happens at the
 * main-thread boundary via loadVoxels() and toUint16Array().
 */
export class ChunkData {
    constructor(cx, cz) {
        this.cx = cx;
        this.cz = cz;

        this._palette = [0];                           // palette[0] = AIR
        this._indices = new Uint8Array(CHUNK_VOLUME);  // all 0 → all AIR

        this.generated = false;  // terrain pass complete
        this.meshed    = false;  // geometry sent to main thread at least once
        this.dirty     = false;  // needs re-mesh (block modified after initial mesh)

        // Three.js Mesh handles, owned by world.js — null until first mesh upload.
        this.mesh            = null;
        this.transparentMesh = null;
    }

    getVoxel(lx, ly, lz) {
        return this._palette[this._indices[voxelIndex(lx, ly, lz)]];
    }

    setVoxel(lx, ly, lz, id) {
        let pi = this._palette.indexOf(id);
        if (pi === -1) {
            pi = this._palette.length;
            this._palette.push(id);
        }
        this._indices[voxelIndex(lx, ly, lz)] = pi;
        this.dirty = true;
    }

    /**
     * Load voxel data arriving from a terrain worker (Uint16Array transfer).
     * Builds the palette in a single O(N) pass.
     */
    loadVoxels(src) {
        const seen = new Map();
        this._palette = [];
        this._indices = new Uint8Array(CHUNK_VOLUME);
        for (let i = 0; i < src.length; i++) {
            const id = src[i];
            let pi = seen.get(id);
            if (pi === undefined) {
                pi = this._palette.length;
                this._palette.push(id);
                seen.set(id, pi);
            }
            this._indices[i] = pi;
        }
    }

    /**
     * Expand palette back to a flat Uint16Array for sending to a meshing worker.
     */
    toUint16Array() {
        const out = new Uint16Array(CHUNK_VOLUME);
        const pal = this._palette;
        const idx = this._indices;
        for (let i = 0; i < CHUNK_VOLUME; i++) out[i] = pal[idx[i]];
        return out;
    }

    /** Compact serialization for server storage. */
    serialize() {
        return {
            palette: this._palette.slice(),
            data:    this._indices.slice(),
        };
    }

    /** Restore a chunk from server-saved data. */
    static deserialize(cx, cz, { palette, data }) {
        const chunk = new ChunkData(cx, cz);
        chunk._palette  = Array.isArray(palette) ? palette : Array.from(palette);
        chunk._indices  = data instanceof Uint8Array ? data : new Uint8Array(data);
        chunk.generated = true;
        return chunk;
    }

    // World-space XZ origin (south-west corner) of this chunk column.
    get worldX() { return this.cx << CHUNK_SHIFT; }
    get worldY() { return WORLD_MIN_Y; }
    get worldZ() { return this.cz << CHUNK_SHIFT; }
}
