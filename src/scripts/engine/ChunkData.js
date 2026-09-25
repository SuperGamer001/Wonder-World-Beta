export const CHUNK_SIZE   = 16;                              // XZ size (blocks per axis)
export const CHUNK_SHIFT  = 4;                               // log2(CHUNK_SIZE)
export const CHUNK_MASK   = 0x0F;                            // CHUNK_SIZE - 1

// ── World height ──────────────────────────────────────────────────────────────
// Every cost in the engine scales linearly with CHUNK_SIZE_Y: resident voxel
// memory, terrain generation, cave carving, and every greedy-mesh sweep. Keep
// this only as tall as the game actually uses.
//
// Playable range: terrain tops out near y=180 (MOUNTAINS baseHeight 90 +
// heightVariation 90) and the deep-stone zone starts at y=-80, so -128 leaves a
// full deep layer below the ore bands and 319 leaves ~140 blocks of build
// headroom above the tallest natural peak.
//
// CHANGING THESE INVALIDATES SAVED WORLDS. The on-disk chunk payload is exactly
// CHUNK_VOLUME bytes, so a saved chunk from a differently-sized world cannot be
// read back. Bump WORLD_FORMAT whenever they change; the save layer uses it to
// reject mismatched chunks instead of silently truncating them.
export const CHUNK_SIZE_Y = 448;                             // Full world height
export const WORLD_MIN_Y  = -128;                            // Bottom of the world (bedrock floor)
export const WORLD_MAX_Y  = WORLD_MIN_Y + CHUNK_SIZE_Y - 1;  // 319 — top of the world
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE_Y * CHUNK_SIZE; // 16 × 448 × 16 = 114,688

// Save-format version. Incremented when the chunk payload layout or the world
// dimensions change. Stored in each world's metadata.
export const WORLD_FORMAT = 2;

// Palette indices are stored in a Uint8Array, so a chunk can hold at most this
// many distinct block types. Exceeding it is a hard error rather than a silent
// wrap that would corrupt the column.
export const MAX_PALETTE = 256;

// Packs local coords into a flat index.
// Layout: lx fastest (stride 1), ly middle (stride 16), lz slowest (stride 16*CHUNK_SIZE_Y).
// lx ∈ [0,15]  ly ∈ [0,CHUNK_SIZE_Y-1]  lz ∈ [0,15]
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

// Scratch table for loadVoxels: blockId → palette index, or -1 when unseen.
// A plain typed array beats a Map here because loadVoxels does one lookup per
// voxel (CHUNK_VOLUME of them) for every chunk that arrives from a worker.
const _paletteScratch = new Int16Array(65536).fill(-1);

/**
 * Palette-compressed chunk storage for a 16×CHUNK_SIZE_Y×16 column.
 *
 * Each chunk spans the full world height (WORLD_MIN_Y to WORLD_MAX_Y).
 * There is exactly one chunk per (cx, cz) column — no vertical chunk stacking.
 *
 * Storage:
 *   _palette  — array of unique block IDs present (<= MAX_PALETTE entries)
 *   _indices  — Uint8Array(CHUNK_VOLUME) where each element indexes into _palette
 *
 * Workers operate on plain Uint16Array voxel buffers, but the main thread never
 * builds one: snapshot() hands the compressed pair straight to the worker, which
 * expands it there. See ChunkManager._requestMesh.
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

        // Vertical extent of non-air voxels, as local Y. Lets the mesher skip the
        // empty sky and keeps mesh bounding spheres tight. Recomputed on load;
        // widened (never narrowed) by setVoxel, since narrowing would need a scan.
        this.minFilledY = 0;
        this.maxFilledY = CHUNK_SIZE_Y - 1;

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
            if (this._palette.length >= MAX_PALETTE) {
                // Refusing is better than wrapping to index 0 (AIR) and punching a
                // hole in the column. Unreachable in practice — a 16×448×16 column
                // would need 256 distinct block types.
                console.error(`[ChunkData] palette full at chunk ${this.cx},${this.cz}; dropped block ${id}`);
                return false;
            }
            pi = this._palette.length;
            this._palette.push(id);
        }
        this._indices[voxelIndex(lx, ly, lz)] = pi;
        this.dirty = true;
        if (id !== 0) {
            if (ly < this.minFilledY) this.minFilledY = ly;
            if (ly > this.maxFilledY) this.maxFilledY = ly;
        }
        return true;
    }

    /**
     * Load voxel data arriving from a terrain worker (Uint16Array transfer).
     * Builds the palette and the filled-Y extent in a single O(N) pass.
     */
    loadVoxels(src) {
        const pal    = [];
        const idxArr = new Uint8Array(CHUNK_VOLUME);
        const seen   = _paletteScratch;

        let minY = CHUNK_SIZE_Y;
        let maxY = -1;

        for (let i = 0; i < src.length; i++) {
            const id = src[i];
            let pi = seen[id];
            if (pi === -1) {
                pi = pal.length;
                pal.push(id);
                seen[id] = pi;
            }
            idxArr[i] = pi;
            if (id !== 0) {
                const ly = ((i / CHUNK_SIZE) | 0) % CHUNK_SIZE_Y;
                if (ly < minY) minY = ly;
                if (ly > maxY) maxY = ly;
            }
        }

        // Reset only the entries we touched, so the scratch table stays reusable
        // without clearing all 65,536 slots.
        for (let p = 0; p < pal.length; p++) seen[pal[p]] = -1;

        if (pal.length > MAX_PALETTE) {
            console.error(`[ChunkData] chunk ${this.cx},${this.cz} has ${pal.length} block types; ` +
                          `only the first ${MAX_PALETTE} are representable`);
        }

        this._palette   = pal;
        this._indices   = idxArr;
        this.minFilledY = maxY < 0 ? 0 : minY;
        this.maxFilledY = maxY < 0 ? 0 : maxY;
    }

    /**
     * Compressed snapshot for a worker mesh job.
     *
     * Returns freshly allocated copies so the caller can hand the buffers to
     * postMessage as transferables — the chunk keeps its own storage. This is
     * deliberately NOT toUint16Array(): sending the palette pair moves
     * CHUNK_VOLUME bytes instead of 2x CHUNK_VOLUME, and the palette expansion
     * happens on the worker thread rather than blocking the frame.
     */
    snapshot() {
        return {
            palette: Uint16Array.from(this._palette),
            indices: this._indices.slice(),
            minY:    this.minFilledY,
            maxY:    this.maxFilledY,
        };
    }

    /**
     * Expand palette back to a flat Uint16Array.
     * Kept for tooling and tests — the mesh path uses snapshot() instead.
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
        chunk._recomputeFilledY();
        return chunk;
    }

    /** Scan for the vertical extent of non-air voxels. */
    _recomputeFilledY() {
        const pal = this._palette;
        const idx = this._indices;
        // Palette slots that map to AIR — usually just one.
        const isAir = pal.map(id => id === 0);
        let minY = CHUNK_SIZE_Y, maxY = -1;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const slab = lz * CHUNK_SIZE * CHUNK_SIZE_Y;
            for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) {
                const row = slab + ly * CHUNK_SIZE;
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    if (!isAir[idx[row + lx]]) {
                        if (ly < minY) minY = ly;
                        if (ly > maxY) maxY = ly;
                        break;
                    }
                }
            }
        }
        this.minFilledY = maxY < 0 ? 0 : minY;
        this.maxFilledY = maxY < 0 ? 0 : maxY;
    }

    // World-space XZ origin (south-west corner) of this chunk column.
    get worldX() { return this.cx << CHUNK_SHIFT; }
    get worldY() { return WORLD_MIN_Y; }
    get worldZ() { return this.cz << CHUNK_SHIFT; }
}
