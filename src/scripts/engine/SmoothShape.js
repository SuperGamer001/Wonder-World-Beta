/**
 * SmoothShape — the geometry of a Mesh block in a smooth-terrain world.
 *
 * Shared by the worker mesher (what is drawn) and by collision (what you stand
 * on), so the two can never disagree. No Three.js, no DOM.
 *
 * ── The model ────────────────────────────────────────────────────────────────
 * A Mesh voxel is its unit cube, cut from above by a smooth *top surface* and
 * from below by a smooth *bottom surface*. Both are heightfields over the
 * voxel's footprint with heights in [0, 1] of the voxel:
 *
 *     corner 0 = (x, z)   1 = (x+1, z)   2 = (x+1, z+1)   3 = (x, z+1)
 *
 * Each surface is pinned at the four vertical edges (the corner heights), joined
 * along each side of the footprint by an *edge curve*, and filled in between by
 * a C1 Coons patch. Three properties make the whole thing work:
 *
 *   1. Nothing leaves the ground. Corner heights are at most 1, edge curves
 *      are monotone cubics that never overshoot their end points, and interior
 *      samples are clamped. A top surface may *dip* below its own voxel, by
 *      less than two blocks and only into Mesh ground it stands on (see "Diagonal
 *      steps" below); it never rises into the air above.
 *   2. Neighbours meet exactly. Everything an edge curve depends on — its two
 *      corner heights, their slopes, whether it carries a ridge — is computed
 *      from the edge's own neighbourhood, not from the voxel asking, so the two
 *      voxels sharing a side draw the same curve bit for bit.
 *   3. Surfaces are smooth across voxels. The patch blends with smoothstep, so
 *      its slope across a side depends only on that side's corner slopes: both
 *      voxels agree on it, and a ramp meets flat ground tangentially.
 *
 * ── Corner heights (edge rule) ───────────────────────────────────────────────
 * For the vertical edge at lattice (X, Z), level y, look at the four voxels
 * around it at that level:
 *   • any Solid block among them      → edge is full (t=1, b=0): terrain meets
 *                                       a cube flush, as if it were part of it
 *   • any of them has a block above   → t = 1  (the surface continues upward)
 *   • any of them has a block below   → b = 0
 *   • all four filled                 → t = 1, b = 0 (flat interior)
 *   • otherwise the corner drops (t = 0) — including inside corners, which is
 *     what keeps diagonal terrace edges from turning into a sawtooth
 *   • if that leaves b > t (thin floating sheet) both meet at 0.5
 *
 * "Filled" means any non-air, non-liquid block. Water counts as empty, so the
 * sea floor smooths like dry land.
 *
 * ── Diagonal steps ───────────────────────────────────────────────────────────
 * Those heights alone pin every corner along a step line to a whole level. On
 * a slope that runs diagonally the step lines are zigzags, so the slope came
 * out as a row of dimples: each block a cube with one corner cut off, and a
 * triangle of wall beside it. Two cases are therefore taken as one *sheet*
 * running across the levels, with a corner shared by the voxels of all of
 * them:
 *
 *   • The sheet at a lattice point has a *base level*: the level where all
 *     four voxels round it are Mesh and at least one is open above, with no
 *     Solid block standing on any of them.
 *   • Steps one block wide on the diagonal (the ground climbs a block in x
 *     and a block in z at once: four columns stepping 0, 1, 1, 2 round the
 *     point). The highest column comes down to the lowest there: its corner
 *     is at −1, a whole block below its own voxel, in the ground it stands
 *     on (_join2). All four then meet in one point and the slope is a plane.
 *     Only when the high ground is diagonal to the low; right beside it, it
 *     stays a wall.
 *   • Steps two blocks wide on the diagonal. The tip of each tooth of the
 *     zigzag is lowered by half a block (`delta`): seen from the base level
 *     the corner is at ½, from the level above at −½ — the same height, so
 *     both draw the same edge, and again the slope is a plane. `delta` is
 *     looked for along the four lattice lines through the point (x, z and
 *     both diagonals): a drop one step one way and higher ground two steps
 *     the other, and only at a point that has ground standing on the base
 *     (a step line). Nowhere else: flat ground, steps along x or z, the edge
 *     of a plateau and the ground round a hole are exactly what the edge rule
 *     makes them.
 *
 * A surface that dips below its own voxel is in the voxel underneath, which is
 * why that one is cut to it in collision (SmoothTerrain). Two columns that do
 * not draw the same line along the edge between them leave a gap between the
 * two lines; the mesher closes it (SmoothMesher, _emitWall).
 *
 * ── Corner slopes ────────────────────────────────────────────────────────────
 * Each corner gets a slope along x and z from the surface heights on the lattice
 * lines either side of it, found *across levels* (topCrossNear). A staircase of
 * one-block steps therefore gets a steady slope and renders as one straight
 * ramp, while the slope drops to zero wherever the surface flattens or turns,
 * which rounds off ramp tops and bottoms. Slopes use the Fritsch–Butland mean
 * and are limited (Fritsch–Carlson) by every same-level stretch of surface that
 * meets the corner — on this level or on the one the sheet shares the corner
 * with — so every voxel at the corner agrees on them and no curve overshoots.
 * Edges that would barely bend are drawn straight (SMOOTH_MIN_BEND).
 *
 * ── Thin features: crests ────────────────────────────────────────────────────
 * A voxel whose four corners all drop (by the edge rule; a lean does not
 * count) — a one-wide line, bend, cross or ring,
 * or a lone block — would flatten away. It becomes a *crest voxel* instead: a
 * rounded crest runs from its centre to the middle of every side it shares with
 * an open-topped Mesh voxel on the same level, and those sides carry the crest
 * as a hump in their edge curve. Whether a side carries one is decided from
 * both voxels symmetrically, so thin features join up into one piece: a ring is
 * a continuous loop, a plus is four arms meeting in a raised centre, a line end
 * gets a rounded cap, a lone block a round dome, and a thin arm flows into the
 * wide ground it is attached to. The crest profile has zero height and slope at
 * unlinked sides, so it never disturbs a neighbour.
 *
 * ── Bottoms ──────────────────────────────────────────────────────────────────
 * Bottom surfaces (overhangs, cave ceilings) use exactly the same rules, on a
 * second SmoothField that sees the world upside down — except that their edges
 * are always drawn straight, since they are rarely seen.
 */

import { WORLD_MIN_Y, CHUNK_SIZE_Y, CHUNK_SHIFT, CHUNK_MASK } from './ChunkData.js';

export const KIND_EMPTY = 0;   // air, liquids
export const KIND_CUBE  = 1;   // Solid-type block (any opacity)
export const KIND_MESH  = 2;   // Mesh-type block

// Stands for "outside the world" / "not loaded". Treated as a filled cube, the
// same way the greedy mesher treats it as solid.
export const SENTINEL = 0xFFFF;

// Where a surface is sampled along an edge or a patch axis, by level:
//   0 — straight: just the ends. Flat and evenly sloped patches stay one quad.
//   1 — curved: thirds.
//   2 — carries a crest: sixths, so the crest line is drawn at its full height
//       and a mound one block wide is round, not a frustum.
// The sets are nested, which is what lets two voxels sample a shared edge at
// different resolutions without cracks: every sample either one takes lies on
// the polyline through that edge's own samples (see edgeSample).
const T1 = 1 / 3, T2 = 2 / 3;
export const SMOOTH_SAMPLES = Object.freeze([
    Object.freeze([0, 1]),
    Object.freeze([0, T1, T2, 1]),
    Object.freeze([0, 1 / 6, T1, 0.5, T2, 5 / 6, 1]),
]);

// An edge that would bend less than this (in blocks) from a straight line is
// drawn straight. Rounding that small is invisible under smooth shading, and
// straight edges are what keep flatter terrain at two triangles per block.
export const SMOOTH_MIN_BEND = 0.05;

// How high a crest stands, as a fraction of its block: a lone block of ground,
// a ridge one block wide. At the full height of the block it was a spike.
export const SMOOTH_CREST = 0.6;
// The most a crest rises over the surface it stands on. That surface is below
// the voxel at the peak of a diagonal slope (its corners come down a block),
// where the full way up to SMOOTH_CREST would be a spike again: the peak is a
// rounded cap on the slopes that meet under it.
const CREST_RISE = SMOOTH_CREST;


// How far along a lattice line a corner on a step line looks for the drop and
// the rise either side of it (see "Diagonal steps").
export const SMOOTH_SPREAD = 2;

// Farthest a voxel's shape reads from itself, horizontally, in blocks: corner
// slopes look one lattice line further out than the corners, each of those
// SMOOTH_SPREAD lines further for its lean, and a lattice point is the corner
// of the voxels either side. Mesh jobs carry a SMOOTH_REACH × SMOOTH_REACH
// block of columns from each diagonal chunk, and an edit this close to a chunk
// seam re-meshes the chunk across it.
export const SMOOTH_REACH = SMOOTH_SPREAD + 2;

// wet[id] for a kind table: 1 for liquids, which count as empty.
const WET_OF = new WeakMap();
const NO_WET = new Uint8Array(65536);

/** kind[id] for the whole 16-bit id space, so lookups never need a bounds check. */
export function buildKindTable(reg) {
    const kind = new Uint8Array(65536).fill(KIND_CUBE);
    const wet  = new Uint8Array(65536);
    for (const def of reg.serialize()) {
        const id = def.id;
        if (id === 0 || reg.isLiquid(id)) kind[id] = KIND_EMPTY;
        else if (reg.isMesh(id))          kind[id] = KIND_MESH;
        else                              kind[id] = KIND_CUBE;
        if (id !== 0 && reg.isLiquid(id)) wet[id] = 1;
    }
    kind[0]        = KIND_EMPTY;
    kind[SENTINEL] = KIND_CUBE;
    WET_OF.set(kind, wet);
    return kind;
}

/**
 * occ[id] = 1 when a block hides a face drawn against it. In a smooth world
 * every Mesh block qualifies, not only full-shape ones: the greedy pass never
 * draws a face between two Mesh voxels. On one level they draw identical edge
 * curves along the side they share, so their cross-sections there match and
 * nothing of the face can show; where one column's edge is lower than the
 * ground beside it, what shows is a wall, and the smooth mesher draws it
 * (SmoothMesher._emitWall).
 */
export function buildOccluderTable(reg) {
    const occ = new Uint8Array(65536);
    for (const def of reg.serialize()) {
        const id = def.id;
        if (reg.isSolid(id) || reg.isMesh(id)) occ[id] = 1;
    }
    occ[0]        = 0;
    occ[SENTINEL] = 1;
    return occ;
}

// Corner (u, v) positions within the voxel, in corner order 0..3.
export const CORNER_U = [0, 1, 1, 0];
export const CORNER_V = [0, 0, 1, 1];

// Patch edges. Each runs toward increasing x or z, so the two voxels sharing an
// edge walk it the same way:
//   0: v = 0 (−z side)   1: v = 1 (+z side)   2: u = 0 (−x side)   3: u = 1 (+x side)
export const EDGE_A    = [0, 3, 0, 1];   // start corner
export const EDGE_B    = [1, 2, 3, 2];   // end corner
export const EDGE_AXIS = [0, 0, 1, 1];   // 0 = runs along x (u), 1 = along z (v)

// Voxels around the vertical edge at lattice (X, Z): offsets from (X, Z).
const RING_DX = [-1, 0, -1, 0];
const RING_DZ = [-1, -1, 0, 0];

// Packed edge span: bit 1 = some ring voxel is filled, bits 2–3 = 2·t, bits 4–5 = 2·b.
const SPAN_EMPTY = 0;
const SPAN_FULL  = 2 | (2 << 2);
const spanFilled = (s) => (s & 2) !== 0;
const spanT      = (s) => ((s >> 2) & 3) * 0.5;
const spanB      = (s) => ((s >> 4) & 3) * 0.5;

// What the ground at a lattice point is doing on one level, as a surface that
// level carries elsewhere sees it (SmoothField.at): gone lower, still level,
// or covered by higher ground.
const AT_LOWER = 1, AT_LEVEL = 2, AT_HIGHER = 3;
const AT_WET   = 4;    // lower, at a waterline
const AT_HALF  = 8;    // lower by half a block (the rim of a thin sheet)
const AT_SHEET = 16;   // level, and free to lean: the base of a sheet (see header)

// The lattice lines a lean is measured along.
const LINE_DX = [1, 0, 1, 1];
const LINE_DZ = [0, 1, 1, -1];

// The two voxels of the ring beside each one (the fourth is diagonal to it).
const RING_N1 = [1, 0, 0, 1];
const RING_N2 = [2, 3, 3, 2];

/**
 * How far a corner `i` steps from a drop leans toward it, as a fraction of the
 * drop. `other` is what the ground does the opposite way, `n` steps off (0:
 * still level as far as it was followed).
 */
function lean(i, other, n) {
    // Only between a drop and a rise: the tooth of a zigzag step line.
    if (other !== AT_HIGHER) return 0;
    const w = Math.min(SMOOTH_SPREAD, i + n - 1);
    return w > i ? 1 - i / w : 0;
}

// Memo key of a lattice cell within its 16 × 16 tile (Map mode).
const cellKey = (X, y, Z) => (X & 15) | ((Z & 15) << 4) | ((y + 2048) << 8);

/**
 * Per-edge surface data for one orientation of the world, memoised. Bottom
 * surfaces come from a second field constructed with `flipped`, which reads
 * voxel (x, y, z) as (x, −1 − y, z): its "tops" are the real bottoms, so every
 * rule is written once.
 */
export class SmoothField {
    /**
     * @param {Uint8Array} kind  kind table (buildKindTable)
     * @param {(x:number, y:number, z:number) => number} get  voxel id accessor
     * @param {boolean} flipped  view the world upside down
     * @param {object} [box]  lattice region the queries stay in, in this field's
     *   frame: { x0, z0, nx, nz, y0, ny }. With it, memos are flat typed arrays
     *   (the worker, which meshes one chunk at a time); without, Maps (collision,
     *   which follows the player around the world).
     */
    constructor(kind, get, flipped = false, box = null) {
        this.kind = kind;
        this.wet  = WET_OF.get(kind) ?? NO_WET;
        this.get  = flipped ? (x, y, z) => get(x, -1 - y, z) : get;
        // Bottoms (the flipped field) are cave ceilings and overhang undersides:
        // straight edges are plenty there, and they would otherwise cost as many
        // triangles as all the terrain you can actually see. They do not lean
        // either.
        this.minBend = flipped ? Infinity : SMOOTH_MIN_BEND;
        this.lean    = !flipped;
        this.samples = SMOOTH_SAMPLES;
        this._k      = new Int8Array(4);
        this._ks     = new Uint8Array(4);
        this._box = box;
        if (box) {
            this._x0 = box.x0; this._z0 = box.z0; this._y0 = box.y0;
            this._nx = box.nx; this._nz = box.nz; this._ny = box.ny;
            const n = box.nx * box.nz * box.ny;
            this._spanMemo  = new Uint8Array(n);        // span | 128 once computed
            this._slopeDone = new Uint8Array(n);        // bit 0: x slope, bit 1: z slope
            this._slopeX    = new Float64Array(n);
            this._slopeZ    = new Float64Array(n);
            if (this.lean) {
                this._atMemo    = new Uint8Array(n);    // at | 128 once computed
                this._deltaMemo = new Uint16Array(n);   // delta × 1024 + 1 once computed
                this._topMemo   = new Uint16Array(n);   // top × 1024 + 4096 once computed
            }
        } else {
            // Memos in 16 × 16 tiles of lattice cells, so the collider can
            // drop the ones round a change and keep the rest.
            this._tiles = new Map();
            this._tcx = NaN; this._tcz = NaN; this._tlast = null;
        }
    }

    clear() {
        if (this._box) {
            this._spanMemo.fill(0); this._slopeDone.fill(0);
            if (this.lean) { this._atMemo.fill(0); this._deltaMemo.fill(0); this._topMemo.fill(0); }
        } else {
            this._tiles.clear();
            this._tcx = NaN; this._tcz = NaN; this._tlast = null;
        }
    }
    get size() { return this._box ? 0 : this._tiles.size; }

    /**
     * Box mode: start afresh, keeping answers for levels y0 … y1 only (in this
     * field's frame). The ground of a chunk is a small part of the column, and
     * clearing every level for every job was a tenth of the work. Outside
     * them nothing is kept: a question there is simply worked out again.
     */
    rebase(y0, y1) {
        this._y0 = y0;
        this._ny = Math.min(this._box.ny, y1 - y0 + 1);
        const n = this._ny * this._nz * this._nx;
        this._spanMemo.fill(0, 0, n); this._slopeDone.fill(0, 0, n);
        if (this.lean) { this._atMemo.fill(0, 0, n); this._deltaMemo.fill(0, 0, n); this._topMemo.fill(0, 0, n); }
    }

    /** Map mode: forget what was worked out for the lattice cells of chunk (cx, cz). */
    dropTile(cx, cz) {
        this._tiles.delete(cx * 4194304 + cz);
        this._tcx = NaN; this._tcz = NaN; this._tlast = null;
    }

    _tile(X, Z) {
        const cx = X >> CHUNK_SHIFT, cz = Z >> CHUNK_SHIFT;
        if (cx === this._tcx && cz === this._tcz) return this._tlast;
        const key = cx * 4194304 + cz;
        let t = this._tiles.get(key);
        if (!t) {
            t = { spans: new Map(), ats: new Map(), deltas: new Map(), tops: new Map(), slopes: new Map() };
            this._tiles.set(key, t);
        }
        this._tcx = cx; this._tcz = cz; this._tlast = t;
        return t;
    }

    // Flat index into the box memos, or −1 outside it.
    _cell(X, y, Z) {
        const i = X - this._x0, k = Z - this._z0, j = y - this._y0;
        if (i < 0 || i >= this._nx || k < 0 || k >= this._nz || j < 0 || j >= this._ny) return -1;
        return (j * this._nz + k) * this._nx + i;
    }

    /** Packed span of the vertical edge at lattice (X, Z), level y. */
    span(X, y, Z) {
        if (this._box !== null) {
            const i = X - this._x0, k = Z - this._z0, j = y - this._y0;
            if (i < 0 || i >= this._nx || k < 0 || k >= this._nz || j < 0 || j >= this._ny) return this._computeSpan(X, y, Z);
            const c = (j * this._nz + k) * this._nx + i;
            const m = this._spanMemo[c];
            if (m & 128) return m & 127;
            const s = this._computeSpan(X, y, Z);
            this._spanMemo[c] = s | 128;
            return s;
        }
        const spans = this._tile(X, Z).spans, key = cellKey(X, y, Z);
        let s = spans.get(key);
        if (s === undefined) {
            s = this._computeSpan(X, y, Z);
            spans.set(key, s);
        }
        return s;
    }

    /** What the ground at lattice (X, Z) is doing on level y: AT_* bits. */
    at(X, y, Z) {
        if (this._box !== null) {
            const i = X - this._x0, k = Z - this._z0, j = y - this._y0;
            if (i < 0 || i >= this._nx || k < 0 || k >= this._nz || j < 0 || j >= this._ny) return this._computeAt(X, y, Z);
            const n = (j * this._nz + k) * this._nx + i;
            const m = this._atMemo[n];
            if (m & 128) return m & 127;
            const c = this._computeAt(X, y, Z);
            this._atMemo[n] = c | 128;
            return c;
        }
        const ats = this._tile(X, Z).ats, key = cellKey(X, y, Z);
        let c = ats.get(key);
        if (c === undefined) {
            c = this._computeAt(X, y, Z);
            ats.set(key, c);
        }
        return c;
    }

    _computeAt(X, y, Z) {
        const s = this.span(X, y, Z), t2 = (s >> 2) & 3;
        const kind = this.kind, get = this.get;
        if (!spanFilled(s) || t2 !== 2) {
            if (spanFilled(s) && t2 === 1) return AT_LOWER | AT_HALF;
            return this._lowerAt(X, y, Z);
        }
        let filled = 0, mesh = 0, open = 0, cube = false;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            const kd = kind[get(x, y, z)];
            if (kd === KIND_EMPTY) continue;
            filled++;
            if (kd === KIND_MESH) mesh++;
            const up = kind[get(x, y + 1, z)];
            if (up === KIND_EMPTY) open++;
            else if (up === KIND_CUBE) cube = true;
        }
        // Nothing here has a top on this level: higher ground (whatever gaps
        // it may have in it).
        if (open === 0) return AT_HIGHER;
        // Some of the ground is missing on this level, yet the corner is held
        // up by higher ground beside it (the foot of a wall where a terrace
        // ends). The terrace does end here — unless what is left of it has
        // nothing under the gap to come down to, or the gap is a pocket under
        // an overhang (see top()), and it stays up at the corner.
        if (filled < 4) {
            return this._sheetBase(X, y - 1, Z) && this._openOver(X, y - 1, Z) ? this._lowerAt(X, y, Z) : AT_LEVEL;
        }
        // A sheet: Mesh all round, and no Solid block standing on it here (the
        // ground stays level under the corner of anything built on it).
        return mesh === 4 && !cube ? AT_LEVEL | AT_SHEET : AT_LEVEL;
    }

    /**
     * Does the ground two levels above the sheet based on level y come down to
     * it at (X, Z)? It does where it is only diagonal to the open ground, and
     * nothing else is on that level here: no Solid block, and nothing hanging
     * over the open ground.
     */
    _join2(X, y, Z) {
        const kind = this.kind, get = this.get;
        // What stands on each of the four: 0 nothing (it is open), 1 or 2 Mesh
        // blocks with air over them, 3 more than that.
        const k = this._k;
        let two = false;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            if (kind[get(x, y + 1, z)] === KIND_EMPTY) { k[r] = 0; continue; }
            const u2 = kind[get(x, y + 2, z)];
            if (u2 === KIND_EMPTY) k[r] = 1;
            else if (u2 === KIND_CUBE) return false;
            else if (kind[get(x, y + 3, z)] === KIND_EMPTY) { k[r] = 2; two = true; }
            else k[r] = 3;
        }
        if (!two) return false;
        for (let r = 0; r < 4; r++) {
            if (k[r] === 2) { if (k[RING_N1[r]] < 1 || k[RING_N2[r]] < 1) return false; }
            else if (k[r] === 0 && kind[get(X + RING_DX[r], y + 2, Z + RING_DZ[r])] !== KIND_EMPTY) return false;
        }
        return true;
    }

    /** AT_LOWER, marked wet at a waterline: water on this level with its surface here. */
    _lowerAt(X, y, Z) {
        const wet = this.wet, get = this.get;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            if (wet[get(x, y, z)] === 1 && wet[get(x, y + 1, z)] !== 1) return AT_LOWER | AT_WET;
        }
        return AT_LOWER;
    }

    /** Is level y the base of a sheet at (X, Z)? What at() marks AT_SHEET, without the rest of it. */
    _sheetBase(X, y, Z) {
        const kind = this.kind, get = this.get;
        let open = 0;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            if (kind[get(x, y, z)] !== KIND_MESH) return false;
            const u = kind[get(x, y + 1, z)];
            if (u === KIND_CUBE) return false;
            if (u === KIND_EMPTY) open++;
        }
        return open > 0;
    }

    /** How far the sheet with base level y leans down at lattice (X, Z): 0 … under 1. */
    delta(X, y, Z) {
        if (this._box) {
            const i = this._cell(X, y, Z);
            if (i < 0) return this._computeDelta(X, y, Z) / 1024;
            const m = this._deltaMemo[i];
            if (m !== 0) return (m - 1) / 1024;
            const d = this._computeDelta(X, y, Z);
            this._deltaMemo[i] = d + 1;
            return d / 1024;
        }
        const deltas = this._tile(X, Z).deltas, key = cellKey(X, y, Z);
        let d = deltas.get(key);
        if (d === undefined) {
            d = this._computeDelta(X, y, Z);
            deltas.set(key, d);
        }
        return d / 1024;
    }

    /**
     * The lean in 1024ths. A whole number of them, so that 1 − delta on the
     * base level and −delta on the level above are exact and name one height.
     */
    _computeDelta(X, y, Z) {
        // Only on a step line (something stands on the base here): open
        // ground is left as the edge rule has it.
        if (!spanFilled(this.span(X, y + 1, Z))) return 0;
        let best = 0;
        for (let l = 0; l < 4; l++) {
            const dx = LINE_DX[l], dz = LINE_DZ[l];
            let ka = 0, na = 0, ca = 0, kb = 0, nb = 0, cb = 0;
            for (let n = 1; n <= SMOOTH_SPREAD; n++) {
                const c = this.at(X + n * dx, y, Z + n * dz);
                if ((c & 3) !== AT_LEVEL) { ka = c & 3; na = n; ca = c; break; }
            }
            for (let n = 1; n <= SMOOTH_SPREAD; n++) {
                const c = this.at(X - n * dx, y, Z - n * dz);
                if ((c & 3) !== AT_LEVEL) { kb = c & 3; nb = n; cb = c; break; }
            }
            if (ka === AT_LOWER && (ca & AT_WET) === 0) {
                const d = lean(na, kb, nb) * ((ca & AT_HALF) !== 0 ? 0.5 : 1);
                if (d > best) best = d;
            }
            if (kb === AT_LOWER && (cb & AT_WET) === 0) {
                const d = lean(nb, ka, na) * ((cb & AT_HALF) !== 0 ? 0.5 : 1);
                if (d > best) best = d;
            }
        }
        return Math.round(best * 1024);
    }

    /**
     * Height of the level-y top surface at lattice (X, Z), in blocks above the
     * bottom of that level: the edge rule's 0, ½ or 1 — or, where the ground
     * is a sheet, the sheet's height: 1 − delta on its base level, −delta one
     * level up, −1 − delta two up (all the same place).
     */
    top(X, y, Z) {
        if (!this.lean) return ((this.span(X, y, Z) >> 2) & 3) * 0.5;
        // Kept in 1024ths, which every one of these heights is a whole number of.
        if (this._box !== null) {
            const i = X - this._x0, k = Z - this._z0, j = y - this._y0;
            if (i < 0 || i >= this._nx || k < 0 || k >= this._nz || j < 0 || j >= this._ny) return this._computeTop(X, y, Z);
            const n = (j * this._nz + k) * this._nx + i;
            const m = this._topMemo[n];
            if (m !== 0) return (m - 4096) / 1024;
            const t = this._computeTop(X, y, Z);
            this._topMemo[n] = t * 1024 + 4096;
            return t;
        }
        const tops = this._tile(X, Z).tops, key = cellKey(X, y, Z);
        let t = tops.get(key);
        if (t === undefined) {
            t = this._computeTop(X, y, Z);
            tops.set(key, t);
        }
        return t;
    }

    _computeTop(X, y, Z) {
        const s = this.span(X, y, Z), t2 = (s >> 2) & 3;
        if (!spanFilled(s) || t2 === 1) return t2 * 0.5;
        if (t2 === 2 && (this.at(X, y, Z) & AT_SHEET) !== 0) return 1 - this.delta(X, y, Z);
        // One level up from a sheet: a corner the edge rule drops is on it. So
        // is one the edge rule holds up, but only on a diagonal step (0, 1, 1,
        // 2 round the point), where the ground two up comes down as well.
        if ((this.at(X, y - 1, Z) & AT_SHEET) !== 0 && (t2 === 0 || this._join2(X, y - 1, Z))) return -this.delta(X, y - 1, Z);
        // The same diagonal step standing on a floor that is no sheet (a hill
        // on a built floor, or with a Solid block in the ground at its foot):
        // the floor's top is where its corners meet.
        if (t2 === 2) return this._floor(X, y - 1, Z) && this._join2(X, y - 1, Z) ? 0 : 1;
        if ((this.at(X, y - 2, Z) & AT_SHEET) !== 0 && this._join2(X, y - 2, Z)) return -1 - this.delta(X, y - 2, Z);
        if (this._floor(X, y - 2, Z) && this._join2(X, y - 2, Z)) return -1;
        return 0;
    }

    /**
     * Is level y ground under all four voxels round (X, Z), with a Solid block
     * among them, and open above one of them? (The open one is the low ground
     * of the step; without it the "floor" is just a layer inside the ground.)
     */
    _floor(X, y, Z) {
        const kind = this.kind, get = this.get;
        let cube = false, open = false;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            const kd = kind[get(x, y, z)];
            if (kd === KIND_EMPTY) return false;
            if (kd === KIND_CUBE) cube = true;
            if (kind[get(x, y + 1, z)] === KIND_EMPTY) open = true;
        }
        return cube && open;
    }

    /** Is every open voxel round (X, Z) on level y open for a second block above it? */
    _openOver(X, y, Z) {
        const kind = this.kind, get = this.get;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            if (kind[get(x, y + 1, z)] === KIND_EMPTY && kind[get(x, y + 2, z)] !== KIND_EMPTY) return false;
        }
        return true;
    }

    _computeSpan(X, y, Z) {
        const kind = this.kind, get = this.get;
        const ks = this._ks;
        let cubes = 0;
        for (let r = 0; r < 4; r++) {
            const k = kind[get(X + RING_DX[r], y, Z + RING_DZ[r])];
            ks[r] = k;
            if (k === KIND_CUBE) cubes++;
        }
        // A Solid block holds the edge up — but not one that only touches the
        // ground here corner to corner, with nothing beside it: ground does
        // not reach across a diagonal to a block it shares no side with. (A
        // block beside both, of either kind, joins them.)
        if (cubes > 0) {
            for (let r = 0; r < 4; r++) {
                if (ks[r] === KIND_CUBE && (ks[RING_N1[r]] !== KIND_EMPTY || ks[RING_N2[r]] !== KIND_EMPTY)) return SPAN_FULL;
            }
        }
        let filled = 0, topHeld = false, botHeld = false;
        for (let r = 0; r < 4; r++) {
            if (ks[r] !== KIND_MESH) continue;
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            filled++;
            if (!topHeld && kind[get(x, y + 1, z)] !== KIND_EMPTY) topHeld = true;
            if (!botHeld && kind[get(x, y - 1, z)] !== KIND_EMPTY) botHeld = true;
        }
        if (filled === 0) return SPAN_EMPTY;
        let t2 = topHeld || filled === 4 ? 2 : 0;
        let b2 = botHeld || filled === 4 ? 0 : 2;
        if (b2 > t2) { t2 = 1; b2 = 1; }
        return 2 | (t2 << 2) | (b2 << 4);
    }

    /**
     * World height (in levels) of the top surface crossing the lattice line
     * (X, Z) nearest to W, or NaN if none is within 1.5 blocks. Follows a slope
     * from one level into the next, which is what gives a staircase of
     * one-block steps a steady slope.
     */
    topCrossNear(X, Z, W) {
        const base = Math.floor(W);
        let best = NaN, bestD = Infinity;
        for (let l = base - 2; l <= base + 2; l++) {
            const s = this.span(X, l, Z);
            if (!spanFilled(s)) continue;
            const t = this.top(X, l, Z);
            if (t === 1) {
                const a = this.span(X, l + 1, Z);
                if (spanFilled(a) && spanB(a) === 0) continue;   // solid carries on upward
            }
            const c = l + t, d = Math.abs(c - W);
            if (d < bestD) { best = c; bestD = d; }
        }
        return bestD <= 1.5 ? best : NaN;
    }

    /** Monotone (Fritsch–Butland) slope of the top surface at (X, W, Z), along x or z. */
    slope(X, Z, W, alongZ) {
        const dx = alongZ ? 0 : 1, dz = alongZ ? 1 : 0;
        const wm = this.topCrossNear(X - dx, Z - dz, W);
        const wp = this.topCrossNear(X + dx, Z + dz, W);
        if (wm !== wm || wp !== wp) return 0;   // NaN: no surface to follow
        const dm = W - wm, dp = wp - W;
        if (dm * dp <= 0) return 0;             // peak, valley or flat: level off
        return 2 * dm * dp / (dm + dp);
    }

    /**
     * Slope along x or z at corner (X, Z) of the level-y top surfaces.
     *
     * Starts from the sheet slope, then is limited (Fritsch–Carlson) by every
     * stretch of top surface that runs from this corner *at this height* — on
     * this level, or on a level above or below where its surface is at the
     * same height here (the levels of a sheet, or the top of one step and the
     * foot of the next). Every voxel meeting at the corner sees the same
     * stretches, so they agree on the slope and the surface is C1 across the
     * seam, and two voxels on different levels that share an edge draw the
     * same curve along it. A stretch that is covered (the surface carries on
     * at another level, as on a staircase) does not count, so it cannot
     * flatten a steady slope.
     */
    cornerSlope(X, Z, y, alongZ) {
        const bit = alongZ ? 2 : 1;
        if (this._box) {
            const i = this._cell(X, y, Z);
            if (i >= 0) {
                if (this._slopeDone[i] & bit) return alongZ ? this._slopeZ[i] : this._slopeX[i];
                const m = this._cornerSlope(X, Z, y, alongZ);
                this._slopeDone[i] |= bit;
                if (alongZ) this._slopeZ[i] = m; else this._slopeX[i] = m;
                return m;
            }
            return this._cornerSlope(X, Z, y, alongZ);
        }
        const slopes = this._tile(X, Z).slopes, key = cellKey(X, y, Z) * 2 + (alongZ ? 1 : 0);
        let m = slopes.get(key);
        if (m === undefined) {
            m = this._cornerSlope(X, Z, y, alongZ);
            slopes.set(key, m);
        }
        return m;
    }

    _cornerSlope(X, Z, y, alongZ) {
        const W = y + this.top(X, y, Z);
        let m = this.slope(X, Z, W, alongZ);
        if (m === 0) return 0;
        const dx = alongZ ? 0 : 1, dz = alongZ ? 1 : 0;
        for (let l = y - 2; l <= y + 2; l++) {
            if (l !== y && (!spanFilled(this.span(X, l, Z)) || l + this.top(X, l, Z) !== W)) continue;
            for (let dir = -1; dir <= 1; dir += 2) {
                if (!this._liveStretch(X, Z, l, alongZ, dir)) continue;
                const hn = l + this.top(X + dir * dx, l, Z + dir * dz);
                const d  = dir > 0 ? hn - W : W - hn;      // rise in the +axis direction
                if (d === 0 || (d > 0) !== (m > 0)) return 0;
                const lim = 3 * Math.abs(d);
                if (Math.abs(m) > lim) m = m > 0 ? lim : -lim;
            }
        }
        return m;
    }

    /**
     * Does a top surface on level y run along the lattice edge from (X, Z) one
     * step in direction `dir` along x (or z)? It does when either voxel beside
     * that edge is a top-open Mesh voxel on level y.
     */
    _liveStretch(X, Z, y, alongZ, dir) {
        if (!alongZ) {
            const vx = dir > 0 ? X : X - 1;
            return this._openTop(vx, y, Z - 1) || this._openTop(vx, y, Z);
        }
        const vz = dir > 0 ? Z : Z - 1;
        return this._openTop(X - 1, y, vz) || this._openTop(X, y, vz);
    }

    _openTop(x, y, z) { return this.kind[this.get(x, y, z)] === KIND_MESH && this._isEmpty(x, y + 1, z); }
    _isEmpty(x, y, z) { return this.kind[this.get(x, y, z)] === KIND_EMPTY; }

    /** Do all four top corners of the level-y voxel at (x, z) drop, by the edge rule? Then it is a thin feature. */
    _allDropped(x, y, z) {
        for (let i = 0; i < 4; i++) {
            if (spanT(this.span(x + CORNER_U[i], y, z + CORNER_V[i])) === 1) return false;
        }
        return true;
    }

    /**
     * The corner heights of the top surface of the voxel at (x, y, z), into
     * `s`. False when all four are at 1: a flat top, with nothing more to say.
     */
    cornersInto(x, y, z, s) {
        const c = s.c;
        let lo = 0, bent = false;
        for (let i = 0; i < 4; i++) {
            const v = this.top(x + CORNER_U[i], y, z + CORNER_V[i]);
            c[i] = v;
            if (v < lo) lo = v;
            if (v !== 1) bent = true;
        }
        s.lo = lo;
        return bent;
    }

    /** Describe the top surface of the Mesh voxel at (x, y, z) into `s` (see newSurface). */
    describeTop(x, y, z, s) {
        this.cornersInto(x, y, z, s);
        this.finishTop(x, y, z, s);
    }

    /** The rest of describeTop, after cornersInto: slopes, crests, how each edge is drawn. */
    finishTop(x, y, z, s) {
        for (let i = 0; i < 4; i++) {
            const X = x + CORNER_U[i], Z = z + CORNER_V[i];
            s.mx[i] = this.cornerSlope(X, Z, y, false);
            s.mz[i] = this.cornerSlope(X, Z, y, true);
        }

        // A voxel whose corners all drop would flatten away. Instead it becomes
        // a crest voxel: a rounded crest from its centre to the middle of every
        // side it shares with a neighbouring top surface on the same level.
        // (Dropped by the edge rule: a corner that only leans does not count.)
        const open = this._openTop(x, y, z);
        let drops = 0;
        if (open) {
            for (let i = 0; i < 4; i++) {
                if (spanT(this.span(x + CORNER_U[i], y, z + CORNER_V[i])) !== 1) drops |= 1 << i;
            }
        }
        s.crest = drops === 15;

        // A side carries the crest (a hump in its edge curve) when both voxels
        // beside it are open-topped Mesh voxels on this level and either one is
        // a crest voxel. Both voxels evaluate exactly this, so they agree —
        // which is what joins rings, bends, crosses and ridges into one piece.
        // (The voxel across a side has that side's two corners too: unless both
        // drop it is no crest, and there is nothing to look up.)
        const hump = s.hump;
        for (let e = 0; e < 4; e++) {
            hump[e] = 0;
            if (!s.crest && ((drops >> EDGE_A[e]) & (drops >> EDGE_B[e]) & 1) === 0) continue;
            const nx = x + SIDE_DX[e], nz = z + SIDE_DZ[e];
            if (this._openTop(nx, y, nz) && (s.crest || this._allDropped(nx, y, nz))) hump[e] = 1;
        }

        // A sheet with air under it has a bottom surface too, whose edges are
        // straight. Where a top and a bottom edge start and end together, a
        // curved top would cross below the straight bottom; so the top edges
        // of such a voxel are drawn straight as well — and of the voxel beside
        // it, for the edge they share, so the two still agree on it.
        const thin = s.thin;
        if (this.lean) {
            const kind = this.kind, get = this.get;
            const under = kind[get(x, y - 1, z)] === KIND_EMPTY;
            for (let e = 0; e < 4; e++) {
                const nx = x + SIDE_DX[e], nz = z + SIDE_DZ[e];
                thin[e] = under || (kind[get(nx, y, nz)] !== KIND_EMPTY && kind[get(nx, y - 1, nz)] === KIND_EMPTY) ? 1 : 0;
            }
        } else thin[0] = thin[1] = thin[2] = thin[3] = 0;
        s.sets = this.samples;
        finishSurface(s, this.minBend);
    }
}

// Neighbour across each patch edge: 0 −z, 1 +z, 2 −x, 3 +x.
const SIDE_DX = [0, 0, -1, 1];
const SIDE_DZ = [-1, 1, 0, 0];

/** A surface record. `c` is in the describing field's frame (see describeVoxel). */
export function newSurface() {
    return {
        c:     new Float64Array(4),   // corner heights
        lo:    0,                     // lowest of them, or 0: how far the surface dips below the voxel
        mx:    new Float64Array(4),   // corner slopes along x (raw)
        mz:    new Float64Array(4),   // corner slopes along z (raw)
        em:    new Float64Array(8),   // per edge: [start, end] slopes used for geometry
        es:    new Float64Array(8),   // per edge: the same before straightening, for shading
        hump:  new Uint8Array(4),     // per edge: carries a crest (see describeTop)
        thin:  new Uint8Array(4),     // per edge: beside a voxel with air under it — drawn straight
        elev:  new Uint8Array(4),     // per edge: SMOOTH_SAMPLES level it is drawn with
        crest: false,                 // thin voxel: crest profile over the patch
        sets: SMOOTH_SAMPLES,         // the field's sample sets
        us: SMOOTH_SAMPLES[0],        // sample positions along u (x)
        vs: SMOOTH_SAMPLES[0],        // sample positions along v (z)
    };
}

/** { top, bot } — `bot` is described upside down; see describeVoxel. */
export function newShape() {
    return { top: newSurface(), bot: newSurface() };
}

function clamp01x3(r) { return r < 0 ? 0 : r > 3 ? 3 : r; }

/**
 * Largest gap between a cubic edge curve and its straight chord, given how far
 * its end slopes differ from the chord's slope (α at the start, β at the end).
 * The gap is α·s(1−s)² − β·s²(1−s); sampled finely enough for a threshold test.
 */
function edgeBend(alpha, beta) {
    let worst = 0;
    for (let k = 1; k < 12; k++) {
        const s = k / 12, q = s * (1 - s);
        const g = Math.abs(q * (alpha * (1 - s) - beta * s));
        if (g > worst) worst = g;
    }
    return worst;
}

/**
 * Per-edge slope limiting, straightening, and sampling.
 *
 * An edge whose curve would bend less than `minBend` from its chord is drawn
 * straight: the rounding would be too small to see, and every curved edge
 * multiplies the triangles. The decision depends only on the edge itself, so
 * both voxels sharing it always make the same one. Shading keeps the
 * unstraightened slopes (`es`), so lighting stays smooth either way.
 */
function finishSurface(s, minBend) {
    const c = s.c;
    for (let e = 0; e < 4; e++) {
        const a = EDGE_A[e], b = EDGE_B[e];
        const alongZ = EDGE_AXIS[e] === 1;
        const d = c[b] - c[a];
        let ma = 0, mb = 0;
        if (d !== 0) {
            // Fritsch–Carlson: slopes of the chord's sign, at most 3× it, keep the
            // cubic monotone — so it never leaves [c[a], c[b]] ⊂ [0, 1].
            ma = d * clamp01x3((alongZ ? s.mz[a] : s.mx[a]) / d);
            mb = d * clamp01x3((alongZ ? s.mz[b] : s.mx[b]) / d);
        }
        s.es[2 * e]     = ma;
        s.es[2 * e + 1] = mb;
        if (!s.hump[e] && (ma !== d || mb !== d) && (s.thin[e] === 1 || edgeBend(ma - d, mb - d) < minBend)) {
            ma = d;
            mb = d;
        }
        s.em[2 * e]     = ma;
        s.em[2 * e + 1] = mb;
        s.elev[e] = s.hump[e] ? 2 : ma !== d || mb !== d ? 1 : 0;
    }
    // Each axis samples at the finest level of its two edges (the sets are
    // nested, so every edge's own samples are included). A crest voxel samples
    // both axes finely enough to hit its crest lines and centre.
    s.us = s.sets[s.crest ? 2 : Math.max(s.elev[0], s.elev[1])];
    s.vs = s.sets[s.crest ? 2 : Math.max(s.elev[2], s.elev[3])];
}

/**
 * Describe the Mesh voxel at (x, y, z).
 *
 * `field` sees the world upright and `flipped` upside down (both over the same
 * voxels). The top surface comes from `field`; the bottom is the top of the
 * flipped voxel, so `out.bot.c` holds 1 − (real bottom height).
 *
 * @returns {boolean} true if the voxel is deformed; false if it is a full cube,
 *   in which case it is meshed and collided exactly like a Solid block.
 */
export function describeVoxel(field, flipped, x, y, z, out) {
    const kind = field.kind, get = field.get;
    // Buried voxels are always full cubes — the voxel itself is in the ring of
    // all four of its edges and has a block both above and below. This is the
    // fast path that skips nearly every voxel in a chunk.
    if (kind[get(x, y + 1, z)] !== KIND_EMPTY && kind[get(x, y - 1, z)] !== KIND_EMPTY) return false;

    const top = field.cornersInto(x, y, z, out.top);
    const bot = flipped.cornersInto(x, -1 - y, z, out.bot);
    if (!top && !bot) return false;
    field.finishTop(x, y, z, out.top);
    flipped.finishTop(x, -1 - y, z, out.bot);
    // A sheet with air above and below shows both surfaces. The top is never
    // under the bottom at a corner, along an edge (both straight there) or in
    // the patch — but drawn as triangles, two surfaces sampled or split
    // differently can still cross between their samples. So both are sampled
    // at the same places here, and surfaceGrid splits the second like the
    // first (its `like`).
    if (kind[get(x, y + 1, z)] === KIND_EMPTY && kind[get(x, y - 1, z)] === KIND_EMPTY) {
        const t = out.top, b = out.bot;
        if (b.us.length > t.us.length) t.us = b.us; else b.us = t.us;
        if (b.vs.length > t.vs.length) t.vs = b.vs; else b.vs = t.vs;
    }
    return true;
}

/**
 * Is the Mesh voxel at (x, y, z) deformed? What describeVoxel returns, without
 * describing it: for the mesher's first pass over a chunk, which only sorts
 * the voxels into those the greedy pass keeps and those drawn as shapes.
 */
export function isDeformed(field, flipped, x, y, z) {
    const kind = field.kind, get = field.get;
    if (kind[get(x, y + 1, z)] !== KIND_EMPTY && kind[get(x, y - 1, z)] !== KIND_EMPTY) return false;
    for (let i = 0; i < 4; i++) {
        if (field.top(x + CORNER_U[i], y, z + CORNER_V[i]) !== 1) return true;
    }
    for (let i = 0; i < 4; i++) {
        if (flipped.top(x + CORNER_U[i], -1 - y, z + CORNER_V[i]) !== 1) return true;
    }
    return false;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

// The crest profile across a ridge (and along a side that carries one):
// 16·s²(1−s)², which is 0 with zero slope at the voxel sides and 1 with zero
// slope on the crest, so crests are round on top and meet the ground smoothly.
// (1 − t³)² for t = 2d, d the distance from the crest: 1 with zero slope on the
// crest, 0 with zero slope half a block from it — at the voxel's sides — so a
// crest is round on top and meets the ground smoothly. It keeps half its
// height two thirds of the way out; the bell it replaces (16·s²(1−s)²) had
// lost half by half way, which is what made a lone block a narrow point.
function bump(d) { const t = 2 * d, q = 1 - t * t * t; return t >= 1 ? 0 : q * q; }
function bumpSlope(d) { const t = 2 * d; return t >= 1 ? 0 : -12 * t * t * (1 - t * t * t); }   // per unit of d

/**
 * Edge e of surface s at parameter p ∈ [0, 1]: out[0] = height, out[1] = slope.
 * Both voxels sharing an edge call this with identical arguments, so shared
 * samples are bit-identical. `shading` evaluates the curve as it was before
 * straightening (used only for normals); `plain` leaves out the crest hump.
 */
export function edgeAt(s, e, p, out, shading = false, plain = false) {
    const a = s.c[EDGE_A[e]], b = s.c[EDGE_B[e]];
    const sl = shading ? s.es : s.em;
    const ma = sl[2 * e], mb = sl[2 * e + 1];
    const p2 = p * p, p3 = p2 * p;
    let v = (2 * p3 - 3 * p2 + 1) * a + (p3 - 2 * p2 + p) * ma + (-2 * p3 + 3 * p2) * b + (p3 - p2) * mb;
    let d = (6 * p2 - 6 * p) * a + (3 * p2 - 4 * p + 1) * ma + (-6 * p2 + 6 * p) * b + (3 * p2 - 2 * p) * mb;
    if (s.hump[e] && !plain && v < SMOOTH_CREST) {
        // The crest crosses a side that carries it at its middle.
        const off = p < 0.5 ? 0.5 - p : p - 0.5;
        const B = bump(off), up = Math.min(SMOOTH_CREST - v, CREST_RISE);
        d = d * (1 - B) + up * bumpSlope(off) * (p < 0.5 ? -1 : 1);
        v = v + up * B;
    }
    // Within the edge's own ends (and the voxel), by the edge's own numbers, so
    // both voxels beside it clamp alike.
    const lo = a < b ? (a < 0 ? a : 0) : (b < 0 ? b : 0);
    out[0] = v < lo ? lo : v > 1 ? 1 : v;
    out[1] = d;
}

const _es = new Float64Array(2);

/**
 * Height of edge e *as drawn* at parameter p: the polyline through the edge's
 * own samples (SMOOTH_SAMPLES[s.elev[e]]). At one of those samples this is the
 * curve itself; between them it is the straight line joining them. Every patch
 * and strip bordering the edge samples it through here, so however finely each
 * one samples it, they all draw the same line — no cracks, at worst a
 * T-junction on a straight segment.
 */
export function edgeSample(s, e, p, out) {
    const S = s.sets[s.elev[e]];
    let k = 0;
    while (k < S.length - 1 && S[k + 1] <= p) k++;
    if (S[k] === p) { edgeAt(s, e, p, out); return; }
    edgeAt(s, e, S[k], _es);     const a = _es[0];
    edgeAt(s, e, S[k + 1], _es); const b = _es[0];
    const w = S[k + 1] - S[k];
    out[0] = a + (b - a) * (p - S[k]) / w;
    out[1] = (b - a) / w;
}

/**
 * Crest profile of a crest voxel at (u, v): out[0] = height, out[1..2] = its
 * gradient. The crest runs from the voxel centre to the middle of each side
 * flagged in `link`; the profile is bump(d) for distance d to that crest.
 *
 * Along a linked side the nearest crest point is the side's midpoint, so the
 * profile there is exactly the hump in that side's edge curve, and its slope
 * across the side is zero — the neighbour's patch joins it seamlessly. Along an
 * unlinked side every point is at least ½ from the crest, so the profile is 0.
 * With no links it is a round dome; one link, a ridge with a rounded cap; two
 * or more, a bend, a straight run, a T or a cross.
 */
function crestAt(link, u, v, out) {
    const du = u - 0.5, dv = v - 0.5;
    // From the centre the distance is the 4-norm, whose "circle" of radius ½
    // nearly fills the square: a lone block is a mound the width of the block,
    // not a cone in the middle of it.
    const q = du * du * du * du + dv * dv * dv * dv;
    let d = Math.sqrt(Math.sqrt(q)), gu = 0, gv = 0;
    if (d > 1e-9) { const k = 1 / (d * d * d); gu = du * du * du * k; gv = dv * dv * dv * k; }   // its gradient
    const au = Math.abs(du), av = Math.abs(dv);
    if (link[2] && u <= 0.5 && av < d) { d = av; gu = 0; gv = dv < 0 ? -1 : 1; }   // to −x side
    if (link[3] && u >= 0.5 && av < d) { d = av; gu = 0; gv = dv < 0 ? -1 : 1; }   // to +x side
    if (link[0] && v <= 0.5 && au < d) { d = au; gu = du < 0 ? -1 : 1; gv = 0; }   // to −z side
    if (link[1] && v >= 0.5 && au < d) { d = au; gu = du < 0 ? -1 : 1; gv = 0; }   // to +z side
    if (d >= 0.5) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
    const sl = bumpSlope(d);
    out[0] = bump(d);
    out[1] = sl * gu;
    out[2] = sl * gv;
}

const _ea = new Float64Array(2);
const _cr = new Float64Array(3);

/**
 * Surface s at (u, v): out[0] = height, out[1] = ∂h/∂u, out[2] = ∂h/∂v.
 *
 * A smoothstep-blended Coons patch of the four edge curves. Because
 * smoothstep has zero slope at 0 and 1, the slope across any side comes only
 * from that side's two corner slopes, so neighbouring patches join C1. A crest
 * voxel blends its crest profile over the patch of its plain edges instead of
 * carrying humps in them; on its sides the two agree exactly.
 * `shading` evaluates the unstraightened surface, for normals.
 */
export function patchAt(s, u, v, out, shading = false) {
    const crest = s.crest;
    edgeAt(s, 0, u, _ea, shading, crest); const c0 = _ea[0], c0u = _ea[1];
    edgeAt(s, 1, u, _ea, shading, crest); const c1 = _ea[0], c1u = _ea[1];
    edgeAt(s, 2, v, _ea, shading, crest); const d0 = _ea[0], d0v = _ea[1];
    edgeAt(s, 3, v, _ea, shading, crest); const d1 = _ea[0], d1v = _ea[1];

    const c = s.c;
    const Su = u * u * (3 - 2 * u), Sv = v * v * (3 - 2 * v);
    const dSu = 6 * u * (1 - u),    dSv = 6 * v * (1 - v);
    let h = (1 - Sv) * c0 + Sv * c1 + (1 - Su) * d0 + Su * d1
          - ((1 - Su) * (1 - Sv) * c[0] + Su * (1 - Sv) * c[1] + Su * Sv * c[2] + (1 - Su) * Sv * c[3]);
    let hu = (1 - Sv) * c0u + Sv * c1u + dSu * (d1 - d0)
           - dSu * ((1 - Sv) * (c[1] - c[0]) + Sv * (c[2] - c[3]));
    let hv = dSv * (c1 - c0) + (1 - Su) * d0v + Su * d1v
           - dSv * ((1 - Su) * (c[3] - c[0]) + Su * (c[2] - c[1]));

    if (crest && h < SMOOTH_CREST) {
        crestAt(s.hump, u, v, _cr);
        const C = _cr[0], up = Math.min(SMOOTH_CREST - h, CREST_RISE);
        hu = hu * (1 - C) + up * _cr[1];
        hv = hv * (1 - C) + up * _cr[2];
        h  = h + up * C;
    }
    out[0] = h < s.lo ? s.lo : h > 1 ? 1 : h;
    out[1] = hu;
    out[2] = hv;
}

const _pa = new Float64Array(3);

/**
 * Sample a surface onto its grid (s.us × s.vs), in real in-voxel heights (a
 * flipped/bottom surface is converted back: height = 1 − h).
 *
 * Boundary samples come from edgeSample, so both voxels sharing a side draw it
 * identically; interior samples come from the patch. Returns
 * { us, vs, h, diag, n }: `diag[cell]` is 0 when the cell is split along
 * (0,0)–(1,1) and 1 along (1,0)–(0,1) — the diagonal joining the closer
 * heights. `n` (optional) holds unit outward normals per vertex. `like`: a
 * grid over the same samples whose split to use (the other surface of a thin
 * sheet — see describeVoxel).
 */
export function surfaceGrid(s, flip, withNormals = false, like = null) {
    const us = s.us, vs = s.vs, nu = us.length - 1, nv = vs.length - 1, w = nu + 1;
    const h = new Float64Array(w * (nv + 1));
    const n = withNormals ? new Float32Array(w * (nv + 1) * 3) : null;
    for (let j = 0; j <= nv; j++) {
        const v = vs[j];
        for (let i = 0; i <= nu; i++) {
            const u = us[i], k = j * w + i;
            let val;
            if      (j === 0)  { edgeSample(s, 0, u, _ea); val = _ea[0]; }
            else if (j === nv) { edgeSample(s, 1, u, _ea); val = _ea[0]; }
            else if (i === 0)  { edgeSample(s, 2, v, _ea); val = _ea[0]; }
            else if (i === nu) { edgeSample(s, 3, v, _ea); val = _ea[0]; }
            else               { patchAt(s, u, v, _pa);    val = _pa[0]; }
            h[k] = flip ? 1 - val : val;
            if (n) {
                // Normals come from the unstraightened surface: its slopes across
                // a side are the ones both neighbours share, so shading matches.
                patchAt(s, u, v, _pa, true);
                // Outward normal of y = h(x, z): (−hx, 1, −hz) on top. Upside down
                // the bottom is 1 − h', whose outward normal is (−h'x, −1, −h'z).
                const nx = -_pa[1], ny = flip ? -1 : 1, nz = -_pa[2];
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                n[k * 3] = nx / len; n[k * 3 + 1] = ny / len; n[k * 3 + 2] = nz / len;
            }
        }
    }
    if (like !== null && like.us === us && like.vs === vs) return { us, vs, h, diag: like.diag, n };
    const diag = new Uint8Array(nu * nv);
    for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
            const k = j * w + i;
            diag[j * nu + i] = Math.abs(h[k] - h[k + w + 1]) <= Math.abs(h[k + 1] - h[k + w]) ? 0 : 1;
        }
    }
    return { us, vs, h, diag, n };
}

/** Index of the grid cell along one axis that contains x. */
function cellOf(samples, x) {
    let i = 0;
    const last = samples.length - 2;
    while (i < last && samples[i + 1] <= x) i++;
    return i;
}

/** Height of a grid at (u, v), using exactly the triangles that are rendered. */
export function gridHeightAt(g, u, v) {
    const us = g.us, vs = g.vs, nu = us.length - 1, w = nu + 1;
    const i = cellOf(us, u), j = cellOf(vs, v);
    const fu = (u - us[i]) / (us[i + 1] - us[i]);
    const fv = (v - vs[j]) / (vs[j + 1] - vs[j]);
    const k = j * w + i, h = g.h;
    const h00 = h[k], h10 = h[k + 1], h01 = h[k + w], h11 = h[k + w + 1];
    if (g.diag[j * nu + i] === 0) {
        return fu >= fv ? h00 + (h10 - h00) * fu + (h11 - h10) * fv
                        : h00 + (h11 - h01) * fu + (h01 - h00) * fv;
    }
    return fu + fv <= 1 ? h00 + (h10 - h00) * fu + (h01 - h00) * fv
                        : h11 + (h11 - h01) * (fu - 1) + (h11 - h10) * (fv - 1);
}

// Allocation-free triangle/rectangle clipping for collision queries.
const _clipA = new Float64Array(3 * 8), _clipB = new Float64Array(3 * 8);

function clipPlane(src, n, dst, axis, bound, sign) {
    let m = 0;
    for (let i = 0; i < n; i++) {
        const c = i * 3, p = ((i + n - 1) % n) * 3;
        const dc = sign * (src[c + axis] - bound);
        const dp = sign * (src[p + axis] - bound);
        if ((dc >= 0) !== (dp >= 0)) {
            const t = dp / (dp - dc);
            dst[m * 3]     = src[p]     + (src[c]     - src[p])     * t;
            dst[m * 3 + 1] = src[p + 1] + (src[c + 1] - src[p + 1]) * t;
            dst[m * 3 + 2] = src[p + 2] + (src[c + 2] - src[p + 2]) * t;
            m++;
        }
        if (dc >= 0) {
            dst[m * 3] = src[c]; dst[m * 3 + 1] = src[c + 1]; dst[m * 3 + 2] = src[c + 2];
            m++;
        }
    }
    return m;
}

function triExtent(ax, ah, az, bx, bh, bz, cx, ch, cz, u0, v0, u1, v1, wantMax, best) {
    if (Math.max(ax, bx, cx) < u0 || Math.min(ax, bx, cx) > u1 ||
        Math.max(az, bz, cz) < v0 || Math.min(az, bz, cz) > v1) return best;
    const A = _clipA;
    A[0] = ax; A[1] = ah; A[2] = az; A[3] = bx; A[4] = bh; A[5] = bz; A[6] = cx; A[7] = ch; A[8] = cz;
    let n = 3;
    n = clipPlane(_clipA, n, _clipB, 0, u0,  1); if (!n) return best;
    n = clipPlane(_clipB, n, _clipA, 0, u1, -1); if (!n) return best;
    n = clipPlane(_clipA, n, _clipB, 2, v0,  1); if (!n) return best;
    n = clipPlane(_clipB, n, _clipA, 2, v1, -1);
    for (let i = 0; i < n; i++) {
        const y = _clipA[i * 3 + 1];
        if (wantMax ? y > best : y < best) best = y;
    }
    return best;
}

/**
 * Highest (wantMax) or lowest height of a grid over the rectangle
 * [u0,u1]×[v0,v1] of the voxel. Exact: each triangle is planar, so its extreme
 * over the rectangle lies on a vertex of the clipped polygon.
 * Returns ±Infinity if the rectangle misses the footprint.
 */
export function gridExtent(g, u0, v0, u1, v1, wantMax) {
    const us = g.us, vs = g.vs, nu = us.length - 1, w = nu + 1, h = g.h;
    let best = wantMax ? -Infinity : Infinity;
    const i0 = cellOf(us, u0), i1 = cellOf(us, u1);
    const j0 = cellOf(vs, v0), j1 = cellOf(vs, v1);
    for (let j = j0; j <= j1; j++) {
        const va = vs[j], vb = vs[j + 1];
        for (let i = i0; i <= i1; i++) {
            const ua = us[i], ub = us[i + 1];
            const k = j * w + i;
            const h00 = h[k], h10 = h[k + 1], h01 = h[k + w], h11 = h[k + w + 1];
            if (g.diag[j * nu + i] === 0) {
                best = triExtent(ua, h00, va, ub, h10, va, ub, h11, vb, u0, v0, u1, v1, wantMax, best);
                best = triExtent(ua, h00, va, ub, h11, vb, ua, h01, vb, u0, v0, u1, v1, wantMax, best);
            } else {
                best = triExtent(ua, h00, va, ub, h10, va, ua, h01, vb, u0, v0, u1, v1, wantMax, best);
                best = triExtent(ub, h10, va, ub, h11, vb, ua, h01, vb, u0, v0, u1, v1, wantMax, best);
            }
        }
    }
    return best;
}

// ── Main-thread collider ─────────────────────────────────────────────────────

const EPS = 1e-5;

// The two surfaces of a voxel that is whole on that side.
const FULL_TOP = Object.freeze({ us: SMOOTH_SAMPLES[0], vs: SMOOTH_SAMPLES[0], h: new Float64Array([1, 1, 1, 1]), diag: new Uint8Array(1), n: null });
const FULL_BOT = Object.freeze({ us: SMOOTH_SAMPLES[0], vs: SMOOTH_SAMPLES[0], h: new Float64Array(4), diag: new Uint8Array(1), n: null });

// Most chunks the collider keeps shapes for at once before starting over.
const MAX_TILES = 96;

/**
 * Collision against smooth terrain, for the player and mobs.
 *
 * Reads the live WorldState. Shapes and what they are worked out from are
 * cached chunk by chunk, and a change to the world (a block edit, a chunk
 * loading or unloading — WorldState.changeLog) drops the cache for that chunk
 * and the eight round it: nothing reads further than SMOOTH_REACH. A cached
 * shape is therefore never stale, and chunks streaming in at the edge of the
 * world cost nothing where the player and the mobs are standing. (A world
 * that keeps no log is watched through its editVersion, and any change drops
 * everything.)
 */
export class SmoothTerrain {
    constructor(worldState, blockRegistry) {
        this.world = worldState;
        this.kind  = buildKindTable(blockRegistry);
        const get  = (x, y, z) => this._block(x, y, z);
        this._field   = new SmoothField(this.kind, get, false);
        this._flipped = new SmoothField(this.kind, get, true);
        this._tiles   = new Map();   // chunk → Map(voxel → shape | null)
        this._tcx = NaN; this._tcz = NaN; this._tlast = null;
        this._ver     = -1;
        this._seq     = -1;
        this._scratch = newShape();
    }

    _clear() {
        this._tiles.clear();
        this._field.clear();
        this._flipped.clear();
        this._tcx = NaN; this._tcz = NaN; this._tlast = null;
    }

    /** Catch up with the world: drop what its changes since last time could have touched. */
    _sync() {
        const w = this.world;
        const ver = w.editVersion ?? 0;
        if (ver === this._ver) return;
        this._ver = ver;
        const log = w.changeLog, seq = w.changeSeq;
        if (!log || this._seq < 0 || seq - this._seq > (log.length >> 1) || this._tiles.size > MAX_TILES) {
            this._clear();
        } else {
            const cap = log.length >> 1;
            for (let i = this._seq; i < seq; i++) {
                const k = (i % cap) * 2, cx = log[k], cz = log[k + 1];
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        this._tiles.delete((cx + dx) * 4194304 + cz + dz);
                        this._field.dropTile(cx + dx, cz + dz);
                        this._flipped.dropTile(cx + dx, cz + dz);
                    }
                }
            }
            this._tcx = NaN; this._tcz = NaN; this._tlast = null;
        }
        this._seq = seq ?? -1;
    }

    isMesh(id) { return this.kind[id] === KIND_MESH; }

    // Matches what the worker sees: out-of-world and not-yet-generated read as
    // SENTINEL (a filled cube), so collision agrees with the rendered mesh.
    _block(x, y, z) {
        const ly = y - WORLD_MIN_Y;
        if (ly < 0 || ly >= CHUNK_SIZE_Y) return SENTINEL;
        const chunk = this.world.getChunk(x >> CHUNK_SHIFT, z >> CHUNK_SHIFT);
        if (!chunk?.generated) return SENTINEL;
        return chunk.getVoxel(x & CHUNK_MASK, ly, z & CHUNK_MASK);
    }

    /**
     * Sampled shape of the Mesh voxel at world (x, y, z), or null when it is a
     * full cube: { top, bot, low } — grids of in-voxel heights (surfaceGrid),
     * and the lowest the top goes (under 0: below the voxel's own floor).
     *
     * A top that dips is in the voxel underneath (or the one under that), so
     * those voxels' shapes are cut to it: their top is the same grid, one or
     * two blocks up in their own terms (and over 1 wherever the ground above
     * is solid over them).
     */
    shapeAt(x, y, z) {
        this._sync();
        const cx = x >> CHUNK_SHIFT, cz = z >> CHUNK_SHIFT;
        let tile = this._tlast;
        if (cx !== this._tcx || cz !== this._tcz) {
            const tk = cx * 4194304 + cz;
            tile = this._tiles.get(tk);
            if (!tile) { tile = new Map(); this._tiles.set(tk, tile); }
            this._tcx = cx; this._tcz = cz; this._tlast = tile;
        }
        const key = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << 4) | ((y - WORLD_MIN_Y) << 8);
        let entry = tile.get(key);
        if (entry === undefined) {
            entry = this._build(x, y, z);
            tile.set(key, entry);
        }
        return entry;
    }

    _build(x, y, z) {
        const kind = this.kind, s = this._scratch;
        const up = kind[this._block(x, y + 1, z)];
        let top = FULL_TOP, bot = FULL_BOT;
        if (describeVoxel(this._field, this._flipped, x, y, z, s)) {
            if (up === KIND_EMPTY) top = surfaceGrid(s.top, false);
            bot = surfaceGrid(s.bot, true, false, top === FULL_TOP ? null : top);
        }
        if (up === KIND_MESH) {
            // Under the ground's top voxel, n blocks up: cut to its surface if
            // that comes down this far.
            const up2 = kind[this._block(x, y + 2, z)];
            const n = up2 === KIND_EMPTY ? 1 : up2 === KIND_MESH && kind[this._block(x, y + 3, z)] === KIND_EMPTY ? 2 : 0;
            const above = n > 0 ? this.shapeAt(x, y + n, z) : null;
            if (above !== null && above.low + n < 1) {
                const h = new Float64Array(above.top.h.length);
                for (let i = 0; i < h.length; i++) h[i] = above.top.h[i] + n;
                top = { us: above.top.us, vs: above.top.vs, h, diag: above.top.diag, n: null };
            }
        }
        if (top === FULL_TOP && bot === FULL_BOT) return null;
        let low = Infinity;
        for (let i = 0; i < top.h.length; i++) if (top.h[i] < low) low = top.h[i];
        return { top, bot, low };
    }

    /**
     * Does the AABB [x0,x1]×[y0,y1]×[z0,z1] (world space) intersect the Mesh
     * voxel at (bx, by, bz)? Uses the highest point of the top surface and the
     * lowest point of the bottom surface under the box's footprint, which is
     * exact for terrain (a single surface over solid ground).
     */
    cellBlocks(bx, by, bz, x0, y0, z0, x1, y1, z1) {
        const shape = this.shapeAt(bx, by, bz);
        if (!shape) return true;
        const u0 = Math.max(0, x0 - bx), u1 = Math.min(1, x1 - bx);
        const v0 = Math.max(0, z0 - bz), v1 = Math.min(1, z1 - bz);
        if (u0 > u1 || v0 > v1) return false;
        const top = gridExtent(shape.top, u0, v0, u1, v1, true);
        if (!(top > y0 - by + EPS)) return false;
        const bot = gridExtent(shape.bot, u0, v0, u1, v1, false);
        return bot < y1 - by - EPS;
    }

    /** Is the world-space point inside the solid part of the Mesh voxel it is in? */
    pointInMesh(x, y, z) {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const shape = this.shapeAt(bx, by, bz);
        if (!shape) return true;
        const u = x - bx, v = z - bz, h = y - by;
        return h < gridHeightAt(shape.top, u, v) && h > gridHeightAt(shape.bot, u, v);
    }
}
