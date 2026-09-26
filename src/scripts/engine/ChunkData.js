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

// Scratch table for compressVoxels: blockId → palette index, or -1 when unseen.
// A plain typed array beats a Map here: compression looks up a palette index
// for every run of voxels in every generated chunk.
const _paletteScratch = new Int16Array(65536).fill(-1);

/**
 * Palette-compress an expanded chunk and find its filled-Y extent, in one pass.
 * Runs in the generation worker, so the main thread receives the compact form
 * (CHUNK_VOLUME bytes instead of twice that) and does no per-voxel work.
 *
 * @param {Uint16Array} src  CHUNK_VOLUME block ids
 * @returns {{ palette: Uint16Array, indices: Uint8Array, minY: number, maxY: number }}
 *   minY / maxY are 0 for an empty chunk.
 */
export function compressVoxels(src, cx = '?', cz = '?') {
    const pal  = [];
    const idx  = new Uint8Array(CHUNK_VOLUME);
    const seen = _paletteScratch;

    let minY = CHUNK_SIZE_Y;
    let maxY = -1;
    // Runs of one block are the norm (stone, air), so the last lookup is kept.
    let lastId = -1, lastPi = 0;

    // Walked in storage order (x fastest, then y, then z), so the level of each
    // row is known without dividing it back out of the index.
    let i = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) {
            let filled = false;
            for (let lx = 0; lx < CHUNK_SIZE; lx++, i++) {
                const id = src[i];
                if (id !== lastId) {
                    let pi = seen[id];
                    if (pi === -1) {
                        pi = pal.length;
                        pal.push(id);
                        seen[id] = pi;
                    }
                    lastId = id;
                    lastPi = pi;
                }
                idx[i] = lastPi;
                if (id !== 0) filled = true;
            }
            if (filled) {
                if (ly < minY) minY = ly;
                if (ly > maxY) maxY = ly;
            }
        }
    }

    // Reset only the entries we touched, so the scratch table stays reusable
    // without clearing all 65,536 slots.
    for (let p = 0; p < pal.length; p++) seen[pal[p]] = -1;

    if (pal.length > MAX_PALETTE) {
        console.error(`[ChunkData] chunk ${cx},${cz} has ${pal.length} block types; ` +
                      `only the first ${MAX_PALETTE} are representable`);
    }

    return {
        palette: Uint16Array.from(pal),
        indices: idx,
        minY: maxY < 0 ? 0 : minY,
        maxY: maxY < 0 ? 0 : maxY,
    };
}

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

    /** Local Y of the highest non-air voxel in column (lx, lz), or -1 if it is all air. */
    columnTop(lx, lz) {
        const pal = this._palette, ind = this._indices;
        let idx = voxelIndex(lx, this.maxFilledY, lz);
        for (let ly = this.maxFilledY; ly >= this.minFilledY; ly--, idx -= CHUNK_SIZE) {
            if (pal[ind[idx]] !== 0) return ly;
        }
        return -1;
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
     * Load an expanded Uint16Array of block ids (tooling and tests). The game
     * itself never calls this on the main thread: the generation worker runs
     * compressVoxels and the result is handed to adoptCompressed.
     */
    loadVoxels(src) {
        const c = compressVoxels(src, this.cx, this.cz);
        this.adoptCompressed(Array.from(c.palette), c.indices, c.minY, c.maxY);
    }

    /**
     * Take ownership of already-compressed storage — a compressVoxels result
     * straight from a worker. No copy, no per-voxel work on this thread.
     */
    adoptCompressed(palette, indices, minY, maxY) {
        this._palette   = Array.isArray(palette) ? palette : Array.from(palette);
        this._indices   = indices;
        this.minFilledY = minY;
        this.maxFilledY = maxY;
    }

    /**
     * Compressed snapshot for a worker mesh job.
     *
     * Returns freshly allocated copies so the caller can hand the buffers to
     * postMessage as transferables — the chunk keeps its own storage. This is
     * deliberately NOT toUint16Array(): sending the palette pair moves
     * CHUNK_VOLUME bytes instead of 2x CHUNK_VOLUME, and the palette expansion
     * happens on the worker thread rather than blocking the frame.
     *
     * Only the filled band [minY, maxY] is sent — everything outside it is AIR
     * by this class's invariant — packed as one block per z slice:
     *   indices[(ly − minY)·CHUNK_SIZE + lx + lz·bandSize],  bandSize = rows·CHUNK_SIZE
     * The sky above the terrain is most of a column, so this is roughly half the
     * bytes, and half the allocation, of copying all of _indices. Every mesh or
     * light job copies nine of these on this thread. Expanded by worldWorker.
     */
    snapshot() {
        const lo = this.minFilledY, hi = this.maxFilledY;
        const band = (hi - lo + 1) * CHUNK_SIZE;
        const SZ = CHUNK_SIZE * CHUNK_SIZE_Y;
        const src = this._indices;
        const indices = new Uint8Array(band * CHUNK_SIZE);
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const from = lz * SZ + lo * CHUNK_SIZE;
            indices.set(src.subarray(from, from + band), lz * band);
        }
        return {
            palette: Uint16Array.from(this._palette),
            indices,
            minY:    lo,
            maxY:    hi,
        };
    }

    /**
     * A size × size block of expanded columns starting at (x0, z0), for a
     * smooth-terrain mesh job. Smooth surfaces near a chunk corner depend on the
     * diagonal chunk, but only on the few columns nearest that corner — so that
     * is all that is sent, rather than four more whole-chunk snapshots.
     * Layout: out[(bx + bz * size) * CHUNK_SIZE_Y + ly].
     */
    cornerBlock(x0, z0, size) {
        const out = new Uint16Array(size * size * CHUNK_SIZE_Y);
        const pal = this._palette;
        const idx = this._indices;
        for (let bz = 0; bz < size; bz++) {
            for (let bx = 0; bx < size; bx++) {
                const src = (x0 + bx) + (z0 + bz) * CHUNK_SIZE * CHUNK_SIZE_Y;
                const dst = (bx + bz * size) * CHUNK_SIZE_Y;
                for (let ly = 0; ly < CHUNK_SIZE_Y; ly++) out[dst + ly] = pal[idx[src + ly * CHUNK_SIZE]];
            }
        }
        return out;
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
