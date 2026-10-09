/**
 * Visibility — which parts of the loaded chunks the camera could possibly see.
 *
 * Most of a chunk's triangles are cave walls (see *Caves* in CLAUDE.md), and
 * from the surface none of them can be seen: yet every one was drawn whenever
 * its column was in view. This works out, cheaply and without ever hiding
 * something that shows, which of them cannot be seen from where the camera is.
 *
 * A chunk column is cut into SECTIONS sections of 16 levels. Two things are
 * known about each (shared by the mesh workers and the render thread, hence
 * this module — no Three.js, no DOM):
 *
 *   • Which of its six faces are joined by open space inside it
 *     (connectivityOfRows, in the worker with each mesh job): the regions of
 *     cells sight can pass through, and the faces each touches. Six bytes a
 *     section.
 *
 *   • Where its triangles are in the chunk's index buffer: the mesher puts
 *     them in order of section, so a run of sections is one range of indices
 *     and still one draw call (GreedyMesher._sortSections).
 *
 * From those, SectionVisibility finds the sections a line of sight from the
 * camera could reach. A straight line never turns back along any axis, and
 * inside each section it passes it runs through open cells from the face it
 * came in by to the face it leaves by — so every section a line of sight
 * reaches is reached by a walk from section to section that only crosses
 * faces joined by open space and never steps back toward the camera on any
 * axis. All such walks are followed (a breadth-first search over sections:
 * a few thousand steps). What they do not reach cannot be seen, whichever
 * way the camera is turned; the search is only run again when the camera
 * moves to another section or a chunk changes.
 *
 * It errs on the side of drawing:
 *   • a face belongs to the section of the open cell in front of it, which
 *     for a face on a chunk's edge is in the next chunk — so a chunk's section
 *     is drawn when it or the section beside it in any of the four chunks
 *     round it is reached;
 *   • one section more is drawn above the highest one reached: on a diagonal
 *     slope a smooth surface belongs to the voxel over the one it dips into;
 *   • a chunk draws everything from the lowest section it needs to the
 *     highest, in one range;
 *   • chunks not there yet, and levels outside a chunk's ground, are open.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y } from './ChunkData.js';

export const SECTION_SHIFT = 4;
export const SECTION_SIZE  = 1 << SECTION_SHIFT;                 // levels in a section
export const SECTIONS      = CHUNK_SIZE_Y >> SECTION_SHIFT;      // 28 in a column
/** Every face joined to every other: a section of air. */
export const ALL_FACES = 63;

const SY = CHUNK_SIZE;
const SZ = CHUNK_SIZE * CHUNK_SIZE_Y;
const ROWS = CHUNK_SIZE * SECTION_SIZE;      // rows of sixteen cells along x in a section

// connectivityOfRows: the runs of open cells in a section's rows (at most
// eight in a row of sixteen), each knowing the run it has been joined to.
const MAX_RUNS  = ROWS * (CHUNK_SIZE >> 1);
const _parent   = new Uint16Array(MAX_RUNS);
const _cells    = new Uint16Array(MAX_RUNS);     // the run's cells: a bit each
const _faces    = new Uint8Array(MAX_RUNS);      // the faces of the section it touches
const _rowStart = new Uint16Array(ROWS + 1);     // where each row's runs begin
const _rows     = new Uint16Array(CHUNK_SIZE_Y * CHUNK_SIZE);   // sectionConnectivity's own row words

function _find(i) {
    const parent = _parent;
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
}

/**
 * Which faces of each section of a chunk are joined by open space inside it,
 * from a word for each row of sixteen cells along x — rows numbered y · 16 + z,
 * a bit for each cell that is closed (a full opaque cube; see
 * sectionConnectivity). GreedyMesher has these words from meshing the chunk
 * (closedRows), so in the worker this reads no voxel at all.
 *
 * The open cells of a section are gathered into runs along x, and runs that
 * touch in the row beside or the row below are joined (union–find): a few
 * hundred runs a section, where flooding it cell by cell was four thousand
 * cells and six looks from each.
 *
 * @param {Uint16Array} closedRows  CHUNK_SIZE_Y × 16 words; 0 outside the band
 * @param {number} yMin, yMax       the chunk's filled band, local Y
 * @param {Uint8Array} [out]        SECTIONS × 6
 * @returns {Uint8Array} out[s * 6 + f]: a bit for each face joined to face f
 *   of section s (0 if no open cell touches f). Faces as in GreedyMesher:
 *   0 +X, 1 −X, 2 +Y, 3 −Y, 4 +Z, 5 −Z.
 */
export function connectivityOfRows(closedRows, yMin, yMax, out = new Uint8Array(SECTIONS * 6)) {
    out.fill(0);
    const sLo = yMin >> SECTION_SHIFT, sHi = yMax >> SECTION_SHIFT;
    const parent = _parent, cells = _cells, faces = _faces, rowStart = _rowStart;
    for (let s = 0; s < SECTIONS; s++) {
        const o6 = s * 6;
        // Nothing but air: outside the band the chunk has blocks on.
        if (s < sLo || s > sHi) { out.fill(ALL_FACES, o6, o6 + 6); continue; }

        const r0 = (s << SECTION_SHIFT) * CHUNK_SIZE;
        let n = 0;
        for (let q = 0; q < ROWS; q++) {
            rowStart[q] = n;
            let w = ~closedRows[r0 + q] & 0xFFFF;
            if (w === 0) continue;
            const y = q >> 4, z = q & 15;
            // The faces any run of this row touches by being in it.
            const here = (y === 15 ? 4 : 0) | (y === 0 ? 8 : 0) | (z === 15 ? 16 : 0) | (z === 0 ? 32 : 0);
            const a0 = z > 0 ? rowStart[q - 1] : 0,  a1 = z > 0 ? rowStart[q] : 0;          // the row beside
            const b0 = y > 0 ? rowStart[q - 16] : 0, b1 = y > 0 ? rowStart[q - 15] : 0;     // the row below
            while (w !== 0) {
                // The lowest run of set bits: adding its lowest bit carries right through it.
                const low = w & -w, sum = w + low, run = w & ~sum;
                w &= sum;
                const id = n++;
                parent[id] = id;
                cells[id] = run;
                faces[id] = here | (run & 1 ? 2 : 0) | (run & 0x8000 ? 1 : 0);
                for (let j = a0; j < a1; j++) {
                    if ((cells[j] & run) !== 0) { const a = _find(j), b = _find(id); if (a !== b) parent[b] = a; }
                }
                for (let j = b0; j < b1; j++) {
                    if ((cells[j] & run) !== 0) { const a = _find(j), b = _find(id); if (a !== b) parent[b] = a; }
                }
            }
        }
        rowStart[ROWS] = n;
        if (n === 0) continue;                       // solid through and through

        // Each region's faces, gathered at the run that stands for it; then
        // every face a region touches is joined to all the others it touches.
        for (let i = 0; i < n; i++) {
            const root = _find(i);
            if (root !== i) faces[root] |= faces[i];
        }
        for (let i = 0; i < n; i++) {
            if (parent[i] !== i) continue;
            const mask = faces[i];
            if (mask === 0) continue;                // a pocket that touches no face
            for (let f = 0; f < 6; f++) if ((mask >> f) & 1) out[o6 + f] |= mask;
        }
    }
    return out;
}

/**
 * The same from the voxels themselves (tests, and anything without a mesher's
 * row words to hand).
 *
 * A cell is open when sight can pass through any of it: everything that is
 * not a full opaque cube. `closed[id]` is 1 for the blocks that are one
 * (GreedyMesher's `_solid` in a blocky world, the smooth mesher's `occ` in a
 * smooth one), and `partial[i]` marks the Mesh voxels of a smooth world that
 * are cut to a shape, which are open however little is cut away.
 *
 * @param {Uint16Array} voxels   the chunk, expanded (AIR outside its filled band)
 * @param {number} yMin, yMax    its filled band, local Y
 * @param {Uint8Array} closed    65536 entries
 * @param {Uint8Array|null} partial
 * @param {Uint8Array} [out]     SECTIONS × 6
 */
export function sectionConnectivity(voxels, yMin, yMax, closed, partial = null, out = new Uint8Array(SECTIONS * 6)) {
    const rows = _rows;
    rows.fill(0);
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let y = Math.max(0, yMin); y <= yMax && y < CHUNK_SIZE_Y; y++) {
            let i = y * SY + z * SZ, w = 0;
            for (let x = 0; x < CHUNK_SIZE; x++, i++) {
                if (closed[voxels[i]] === 1 && (partial === null || partial[i] === 0)) w |= 1 << x;
            }
            rows[y * CHUNK_SIZE + z] = w;
        }
    }
    return connectivityOfRows(rows, yMin, yMax, out);
}

/**
 * The section of a chunk a world Y lies in (it may be outside 0 … SECTIONS − 1:
 * above or below the world).
 */
export function sectionOf(localY) { return Math.floor(localY) >> SECTION_SHIFT; }

/**
 * Finds, for a set of chunks, the sections of each the camera could see.
 *
 * A chunk here is any object with
 *   cx, cz          its place
 *   conn            Uint8Array from sectionConnectivity, or null (taken as open)
 *   secLo, secHi    the sections it has triangles in (secHi < secLo: none)
 * and compute() writes back
 *   drawLo, drawHi  the sections to draw, lowest and highest; nothing when
 *                   drawHi < drawLo.
 */
export class SectionVisibility {
    constructor() {
        this._size = 0;
        this._list = [];            // the chunks of the search
        this._grid = [];            // the chunk at each column of it, or null
        this._vis = null;           // per section: reached
        this._done = null;          // per section: the faces already walked out of
        this._queue = null;         // section | faces << 24
        this.reached = 0;           // sections reached by the last search (diagnostics)
    }

    /**
     * @param {Iterable<object>} chunks
     * @param {number} camCx, camCz   the camera's chunk
     * @param {number} camSec         … and its section (sectionOf of its local Y)
     */
    compute(chunks, camCx, camCz, camSec) {
        // The square of columns to search, and the levels.
        let x0 = camCx, x1 = camCx, z0 = camCz, z1 = camCz, sMin = SECTIONS, sMax = -1;
        const list = this._list;
        list.length = 0;
        for (const c of chunks) {
            if (c.cx < x0) x0 = c.cx; if (c.cx > x1) x1 = c.cx;
            if (c.cz < z0) z0 = c.cz; if (c.cz > z1) z1 = c.cz;
            if (c.secLo < sMin) sMin = c.secLo;
            if (c.secHi > sMax) sMax = c.secHi;
            list.push(c);
        }
        this.reached = 0;
        if (sMax < sMin) { list.length = 0; return; }       // nothing with a triangle in it
        // One level more than the chunks have anything in, above and below,
        // for walks over and under them (it may lie outside the world: that
        // is air too); the camera starts no further out than that.
        const vLo = sMin - 1, vHi = sMax + 1;
        const W = x1 - x0 + 1, D = z1 - z0 + 1, H = vHi - vLo + 1, WD = W * D, N = WD * H;

        if (N > this._size) {
            this._size = N;
            this._vis = new Uint8Array(N);
            this._done = new Uint8Array(N);
            this._queue = new Int32Array(N * 6 + 6);
        } else {
            this._vis.fill(0, 0, N);
            this._done.fill(0, 0, N);
        }
        const grid = this._grid, vis = this._vis, done = this._done, queue = this._queue;
        grid.length = WD;
        grid.fill(null);
        for (const c of list) grid[(c.cx - x0) + (c.cz - z0) * W] = c;
        list.length = 0;            // hold on to no chunk between searches

        // The faces of section `l` of column `col` joined to its face `e`. A
        // chunk that is not there, or has not said, is taken as open.
        const joined = (col, l, e) => {
            const s = l + vLo;
            if (s < 0 || s >= SECTIONS) return ALL_FACES;
            const c = grid[col];
            return c === null || c.conn === null ? ALL_FACES : c.conn[s * 6 + e];
        };

        const ci = camCx - x0, cj = camCz - z0;
        const cl = Math.max(vLo, Math.min(vHi, camSec)) - vLo;
        const start = ci + cj * W + cl * WD;
        let head = 0, tail = 0;
        vis[start] = 1;
        done[start] = ALL_FACES;
        queue[tail++] = start | (ALL_FACES << 24);

        while (head < tail) {
            const q = queue[head++], idx = q & 0xFFFFFF, bits = q >>> 24;
            const col = idx % WD, l = (idx - col) / WD, i = col % W, j = (col - i) / W;
            // Where this section is from the camera's: no step may undo that.
            const ox = i - ci, oz = j - cj, oy = (l + vLo) - camSec;
            for (let f = 0; f < 6; f++) {
                if (((bits >> f) & 1) === 0) continue;
                let ni = i, nj = j, nl = l;
                if (f === 0)      { if (ox < 0 || i + 1 >= W) continue; ni++; }
                else if (f === 1) { if (ox > 0 || i === 0)    continue; ni--; }
                else if (f === 2) { if (oy < 0 || l + 1 >= H) continue; nl++; }
                else if (f === 3) { if (oy > 0 || l === 0)    continue; nl--; }
                else if (f === 4) { if (oz < 0 || j + 1 >= D) continue; nj++; }
                else              { if (oz > 0 || j === 0)    continue; nj--; }
                const ncol = ni + nj * W, nidx = ncol + nl * WD;
                const allow = joined(ncol, nl, f ^ 1);        // in by the face opposite the one left by
                if (allow === 0) continue;                    // that face of it is shut
                vis[nidx] = 1;
                const fresh = allow & ~done[nidx];
                if (fresh !== 0) {
                    done[nidx] |= fresh;
                    queue[tail++] = nidx | (fresh << 24);
                }
            }
        }

        // What each chunk draws: from the lowest section it, or the one
        // beside it in a neighbouring chunk, was reached in — to one above
        // the highest.
        let reached = 0;
        for (let col = 0; col < WD; col++) {
            const c = grid[col];
            if (c === null) continue;
            const i = col % W, j = (col - i) / W;
            let lo = SECTIONS, hi = -1;
            for (let s = c.secLo; s <= c.secHi; s++) {
                const k = col + (s - vLo) * WD;
                if (vis[k] === 1) reached++;
                if (vis[k] === 1 ||
                    (i > 0 && vis[k - 1] === 1) || (i + 1 < W && vis[k + 1] === 1) ||
                    (j > 0 && vis[k - W] === 1) || (j + 1 < D && vis[k + W] === 1)) {
                    if (s < lo) lo = s;
                    hi = s;
                }
            }
            if (hi < 0) { c.drawLo = 1; c.drawHi = 0; }
            else { c.drawLo = lo; c.drawHi = Math.min(hi + 1, c.secHi); }
        }
        grid.fill(null);            // … nor after one
        this.reached = reached;
    }
}
