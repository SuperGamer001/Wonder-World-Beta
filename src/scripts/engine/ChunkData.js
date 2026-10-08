export const CHUNK_SIZE   = 16;                              // XZ size (blocks per axis)
export const CHUNK_SHIFT  = 4;                               // log2(CHUNK_SIZE)
export const CHUNK_MASK   = 0x0F;                            // CHUNK_SIZE - 1

// ── World height ──────────────────────────────────────────────────────────────
// Every cost in the engine scales linearly with CHUNK_SIZE_Y: resident voxel
// memory, terrain generation, cave carving, and every greedy-mesh sweep. Keep
// this only as tall as the game actually uses.
//
// Playable range: the tallest natural peaks reach about y=290 (Geography.js
// MAX_HEIGHT; most mountains stay under 250, ordinary land 65–120) and caves
// go down to just above the bedrock floor at -128, with slate from about y=0
// down. 319 leaves room for trees on the highest peaks and a little building.
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
// … and the palette index of every voxel of the column, before the filled
// band is cut out of it. Written whole on each call, so never cleared.
const _indexScratch = new Uint8Array(CHUNK_VOLUME);

const ROW = CHUNK_SIZE;                    // voxels in one row (one x run)
const SLAB = CHUNK_SIZE * CHUNK_SIZE_Y;    // voxels in one z slice of a whole column

/**
 * The rows [lo, hi] of a whole-column array (voxelIndex layout), packed one
 * block per z slice: out[(ly − lo)·16 + lx + lz·band], band = rows·16. This is
 * the layout a chunk is stored in and crosses to the workers in.
 */
function packBand(full, lo, hi) {
    const band = (hi - lo + 1) * ROW;
    const out  = new Uint8Array(band * CHUNK_SIZE);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const from = lz * SLAB + lo * ROW;
        out.set(full.subarray(from, from + band), lz * band);
    }
    return out;
}

/**
 * Palette-compress an expanded chunk and find its filled-Y extent, in one pass.
 * Runs in the generation worker, so the main thread receives the compact form
 * and does no per-voxel work.
 *
 * @param {Uint16Array} src  CHUNK_VOLUME block ids
 * @returns {{ palette: Uint16Array, indices: Uint8Array, minY: number, maxY: number }}
 *   `indices` covers only the filled band [minY, maxY] (packBand layout) —
 *   everything outside it is AIR. minY / maxY are 0 for an empty chunk.
 */
export function compressVoxels(src, cx = '?', cz = '?') {
    const pal  = [];
    const idx  = _indexScratch;
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

    const lo = maxY < 0 ? 0 : minY, hi = maxY < 0 ? 0 : maxY;
    return {
        palette: Uint16Array.from(pal),
        indices: packBand(idx, lo, hi),
        minY: lo,
        maxY: hi,
    };
}

// When an edit lands outside the rows a chunk stores, it grows to cover the
// edit and this many rows beyond, so building upward does not grow it per block.
const GROW_ROWS = 8;

/**
 * Palette-compressed chunk storage for a 16×CHUNK_SIZE_Y×16 column.
 *
 * Each chunk spans the full world height (WORLD_MIN_Y to WORLD_MAX_Y).
 * There is exactly one chunk per (cx, cz) column — no vertical chunk stacking.
 *
 * Storage:
 *   _palette  — array of unique block IDs present (<= MAX_PALETTE entries)
 *   _indices  — one palette slot per voxel, for the rows [_lo, _lo + _rows)
 *               only, in packBand layout. Every voxel outside those rows is
 *               AIR. A generated or loaded chunk stores exactly its filled
 *               band, [minFilledY, maxFilledY]; a block placed outside it
 *               grows the storage (_cover).
 *
 * The sky above the terrain is most of a column, so storing the whole column
 * (CHUNK_VOLUME bytes, as this used to) held about twice the memory per loaded
 * chunk — 92 MB of voxels at render distance 14.
 *
 * Workers operate on plain Uint16Array voxel buffers, but the main thread never
 * builds one: snapshot() hands the compressed pair straight to the worker, which
 * expands it there. See ChunkManager._requestMesh.
 */
export class ChunkData {
    constructor(cx, cz) {
        this.cx = cx;
        this.cz = cz;

        this._palette = [0];                // palette[0] = AIR
        this._indices = new Uint8Array(0);  // no rows stored → all AIR
        this._lo      = 0;                  // first stored row (local Y)
        this._rows    = 0;                  // stored rows
        this._band    = 0;                  // _rows · 16: the index stride in z

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
        const r = ly - this._lo;
        if (r < 0 || r >= this._rows) return 0;
        return this._palette[this._indices[lx + r * ROW + lz * this._band]];
    }

    /** Local Y of the highest non-air voxel in column (lx, lz), or -1 if it is all air. */
    columnTop(lx, lz) {
        const pal = this._palette, ind = this._indices;
        const top = Math.min(this.maxFilledY, this._lo + this._rows - 1);
        const bottom = Math.max(this.minFilledY, this._lo);
        let idx = lx + (top - this._lo) * ROW + lz * this._band;
        for (let ly = top; ly >= bottom; ly--, idx -= ROW) {
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
        let r = ly - this._lo;
        if (r < 0 || r >= this._rows) {
            // Outside the stored rows everything is AIR already.
            if (id === 0) { this.dirty = true; return true; }
            this._cover(ly);
            r = ly - this._lo;
        }
        this._indices[lx + r * ROW + lz * this._band] = pi;
        this.dirty = true;
        if (id !== 0) {
            if (ly < this.minFilledY) this.minFilledY = ly;
            if (ly > this.maxFilledY) this.maxFilledY = ly;
        }
        return true;
    }

    /** The palette slot of AIR, added if the palette has none yet. */
    _airSlot() {
        let a = this._palette.indexOf(0);
        if (a === -1) {
            if (this._palette.length >= MAX_PALETTE) {
                console.error(`[ChunkData] palette full at chunk ${this.cx},${this.cz}; no slot for AIR`);
                return 0;
            }
            a = this._palette.length;
            this._palette.push(0);
        }
        return a;
    }

    /** Grow the stored rows to include `ly` (and GROW_ROWS beyond it); the new rows are AIR. */
    _cover(ly) {
        const oldLo = this._lo, oldRows = this._rows, oldBand = this._band, old = this._indices;
        let lo, hi;
        if (oldRows === 0) {
            lo = ly - GROW_ROWS; hi = ly + GROW_ROWS;
        } else {
            lo = Math.min(oldLo, ly - GROW_ROWS);
            hi = Math.max(oldLo + oldRows - 1, ly + GROW_ROWS);
        }
        lo = Math.max(0, lo);
        hi = Math.min(CHUNK_SIZE_Y - 1, hi);

        const rows = hi - lo + 1, band = rows * ROW;
        const next = new Uint8Array(band * CHUNK_SIZE);
        const air  = this._airSlot();
        if (air !== 0) next.fill(air);
        const shift = (oldLo - lo) * ROW;
        for (let lz = 0; lz < CHUNK_SIZE && oldBand > 0; lz++) {
            next.set(old.subarray(lz * oldBand, (lz + 1) * oldBand), lz * band + shift);
        }
        this._indices = next;
        this._lo = lo; this._rows = rows; this._band = band;
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
     * straight from a worker: `indices` holds the rows [minY, maxY]. No copy,
     * no per-voxel work on this thread. (A whole-column array is accepted too,
     * and cut down to the band.)
     */
    adoptCompressed(palette, indices, minY, maxY) {
        const rows = maxY - minY + 1;
        if (indices.length !== rows * ROW * CHUNK_SIZE) {
            if (indices.length !== CHUNK_VOLUME) throw new Error(`[ChunkData] ${indices.length} indices for rows ${minY}..${maxY}`);
            indices = packBand(indices, minY, maxY);
        }
        this._palette   = Array.isArray(palette) ? palette : Array.from(palette);
        this._indices   = indices;
        this._lo        = minY;
        this._rows      = rows;
        this._band      = rows * ROW;
        this.minFilledY = minY;
        this.maxFilledY = maxY;
        // The rows left out are AIR, so the palette must be able to say so.
        if (rows < CHUNK_SIZE_Y) this._airSlot();
    }

    /**
     * Compressed snapshot for a worker mesh job.
     *
     * Returns freshly allocated copies so the caller can hand the buffers to
     * postMessage as transferables — the chunk keeps its own storage. This is
     * deliberately NOT toUint16Array(): sending the palette pair moves a
     * fraction of the bytes, and the palette expansion happens on the worker
     * thread rather than blocking the frame.
     *
     * Only the filled band [minY, maxY] is sent — everything outside it is AIR
     * by this class's invariant — packed as one block per z slice:
     *   indices[(ly − minY)·CHUNK_SIZE + lx + lz·bandSize],  bandSize = rows·CHUNK_SIZE
     * That is how the chunk is stored, so for a chunk nobody has built above or
     * below it is one copy of _indices. Every mesh or light job copies nine of
     * these on this thread. Expanded by worldWorker.
     */
    snapshot() {
        const lo = this.minFilledY, hi = this.maxFilledY;
        const band = (hi - lo + 1) * ROW;
        let indices;
        if (lo === this._lo && band === this._band) {
            indices = this._indices.slice();
        } else {
            // The stored rows and the filled band differ (an edit grew the
            // storage, or a chunk built by hand): copy where they overlap.
            indices = new Uint8Array(band * CHUNK_SIZE);
            const air = this._palette.indexOf(0);
            if (air > 0) indices.fill(air);
            const from = Math.max(lo, this._lo), to = Math.min(hi, this._lo + this._rows - 1);
            if (to >= from) {
                const n = (to - from + 1) * ROW;
                const src = this._indices;
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    const s = lz * this._band + (from - this._lo) * ROW;
                    indices.set(src.subarray(s, s + n), lz * band + (from - lo) * ROW);
                }
            }
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
        const out = new Uint16Array(size * size * CHUNK_SIZE_Y);   // zeros: AIR outside the stored rows
        const pal = this._palette;
        const idx = this._indices;
        const lo = this._lo, rows = this._rows;
        for (let bz = 0; bz < size; bz++) {
            for (let bx = 0; bx < size; bx++) {
                const src = (x0 + bx) + (z0 + bz) * this._band;
                const dst = (bx + bz * size) * CHUNK_SIZE_Y + lo;
                for (let r = 0; r < rows; r++) out[dst + r] = pal[idx[src + r * ROW]];
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
        const band = this._band, base = this._lo * ROW;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const dst = lz * SLAB + base, src = lz * band;
            for (let k = 0; k < band; k++) out[dst + k] = pal[idx[src + k]];
        }
        return out;
    }

    /**
     * Write the whole column's palette slots — CHUNK_VOLUME bytes in voxelIndex
     * layout, the form chunks are saved in — into `target` at `offset`.
     */
    writeIndices(target, offset = 0) {
        const band = this._band, rows = this._rows;
        if (rows < CHUNK_SIZE_Y) target.fill(this._airSlot(), offset, offset + CHUNK_VOLUME);
        const src = this._indices, base = offset + this._lo * ROW;
        for (let lz = 0; lz < CHUNK_SIZE && band > 0; lz++) {
            target.set(src.subarray(lz * band, (lz + 1) * band), base + lz * SLAB);
        }
    }

    /** Compact serialization for server storage: the palette and the whole column's slots. */
    serialize() {
        // Before the palette is copied: writing may add AIR's slot to it.
        const data = new Uint8Array(CHUNK_VOLUME);
        this.writeIndices(data);
        return { palette: this._palette.slice(), data };
    }

    /** Restore a chunk from server-saved data (`data`: the whole column's slots; not kept). */
    static deserialize(cx, cz, { palette, data }) {
        const chunk = new ChunkData(cx, cz);
        const pal  = Array.isArray(palette) ? palette : Array.from(palette);
        const full = data instanceof Uint8Array ? data : new Uint8Array(data);
        const { minY, maxY } = _filledRows(pal, full, 0, CHUNK_SIZE_Y, SLAB);
        chunk.adoptCompressed(pal, packBand(full, minY, maxY), minY, maxY);
        chunk.generated = true;
        return chunk;
    }

    /** Scan for the vertical extent of non-air voxels. */
    _recomputeFilledY() {
        const { minY, maxY } = _filledRows(this._palette, this._indices, this._lo, this._rows, this._band);
        this.minFilledY = minY;
        this.maxFilledY = maxY;
    }

    /** Bytes of voxel storage this chunk holds (diagnostics). */
    get byteLength() { return this._indices.byteLength; }

    // World-space XZ origin (south-west corner) of this chunk column.
    get worldX() { return this.cx << CHUNK_SHIFT; }
    get worldY() { return WORLD_MIN_Y; }
    get worldZ() { return this.cz << CHUNK_SHIFT; }
}

/**
 * The first and last row holding a non-air voxel, in `idx`: palette slots for
 * `rows` rows starting at local Y `lo`, `band` apart in z. Both 0 when it is
 * all air.
 */
function _filledRows(pal, idx, lo, rows, band) {
    // Palette slots that map to AIR — usually just one.
    const isAir = pal.map(id => id === 0);
    let minY = CHUNK_SIZE_Y, maxY = -1;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const slab = lz * band;
        for (let r = 0; r < rows; r++) {
            const row = slab + r * ROW;
            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                if (!isAir[idx[row + lx]]) {
                    if (lo + r < minY) minY = lo + r;
                    if (lo + r > maxY) maxY = lo + r;
                    break;
                }
            }
        }
    }
    return { minY: maxY < 0 ? 0 : minY, maxY: maxY < 0 ? 0 : maxY };
}
