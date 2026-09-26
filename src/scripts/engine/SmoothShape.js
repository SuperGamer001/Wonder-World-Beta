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
 *   1. Nothing leaves the voxel. Corner heights are in [0, 1], edge curves are
 *      monotone cubics that never overshoot their end points, and interior
 *      samples are clamped to [0, 1].
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
 * ── Corner slopes ────────────────────────────────────────────────────────────
 * Each corner gets a slope along x and z from the surface heights on the lattice
 * lines either side of it, found *across levels* (topCrossNear). A staircase of
 * one-block steps therefore gets a steady slope and renders as one straight
 * ramp, while the slope drops to zero wherever the surface flattens or turns,
 * which rounds off ramp tops and bottoms. Slopes use the Fritsch–Butland mean
 * and are limited (Fritsch–Carlson) by every same-level stretch of surface that
 * meets the corner, so both voxels at a seam agree on them and no curve
 * overshoots. Edges that would barely bend are drawn straight (SMOOTH_MIN_BEND).
 *
 * ── Thin features: crests ────────────────────────────────────────────────────
 * A voxel whose four corners all drop — a one-wide line, bend, cross or ring,
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
//   2 — carries a crest: thirds plus the middle, so the crest line is drawn at
//       its full height instead of being cut flat between samples.
// The sets are nested, which is what lets two voxels sample a shared edge at
// different resolutions without cracks: every sample either one takes lies on
// the polyline through that edge's own samples (see edgeSample).
const T1 = 1 / 3, T2 = 2 / 3;
export const SMOOTH_SAMPLES = Object.freeze([
    Object.freeze([0, 1]),
    Object.freeze([0, T1, T2, 1]),
    Object.freeze([0, T1, 0.5, T2, 1]),
]);

// An edge that would bend less than this (in blocks) from a straight line is
// drawn straight. Rounding that small is invisible under smooth shading, and
// straight edges are what keep flatter terrain at two triangles per block.
export const SMOOTH_MIN_BEND = 0.05;


// Farthest a voxel's shape reads from itself, horizontally, in blocks: corner
// slopes look one lattice line further out than the corners. Mesh jobs carry a
// SMOOTH_REACH × SMOOTH_REACH block of columns from each diagonal chunk, and an
// edit this close to a chunk seam re-meshes the chunk across it.
export const SMOOTH_REACH = 2;

/** kind[id] for the whole 16-bit id space, so lookups never need a bounds check. */
export function buildKindTable(reg) {
    const kind = new Uint8Array(65536).fill(KIND_CUBE);
    for (const def of reg.serialize()) {
        const id = def.id;
        if (id === 0 || reg.isLiquid(id)) kind[id] = KIND_EMPTY;
        else if (reg.isMesh(id))          kind[id] = KIND_MESH;
        else                              kind[id] = KIND_CUBE;
    }
    kind[0]        = KIND_EMPTY;
    kind[SENTINEL] = KIND_CUBE;
    return kind;
}

/**
 * occ[id] = 1 when a block hides a face drawn against it. In a smooth world
 * every Mesh block qualifies, not only full-shape ones: two Mesh voxels sharing
 * a side draw identical edge curves there, so their cross-sections on that side
 * match and the face between them can never be visible.
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
        this.get  = flipped ? (x, y, z) => get(x, -1 - y, z) : get;
        // Bottoms (the flipped field) are cave ceilings and overhang undersides:
        // straight edges are plenty there, and they would otherwise cost as many
        // triangles as all the terrain you can actually see.
        this.minBend = flipped ? Infinity : SMOOTH_MIN_BEND;
        this.samples = SMOOTH_SAMPLES;
        this._box = box;
        if (box) {
            const n = box.nx * box.nz * box.ny;
            this._spanMemo  = new Uint8Array(n);        // span | 128 once computed
            this._slopeDone = new Uint8Array(n);        // bit 0: x slope, bit 1: z slope
            this._slopeX    = new Float64Array(n);
            this._slopeZ    = new Float64Array(n);
        } else {
            this._spans  = new Map();
            this._slopes = new Map();
        }
    }

    clear() {
        if (this._box) { this._spanMemo.fill(0); this._slopeDone.fill(0); }
        else           { this._spans.clear(); this._slopes.clear(); }
    }
    get size() { return this._box ? 0 : this._spans.size + this._slopes.size; }

    // Flat index into the box memos, or −1 outside it.
    _cell(X, y, Z) {
        const b = this._box;
        const i = X - b.x0, k = Z - b.z0, j = y - b.y0;
        if (i < 0 || i >= b.nx || k < 0 || k >= b.nz || j < 0 || j >= b.ny) return -1;
        return (j * b.nz + k) * b.nx + i;
    }

    /** Packed span of the vertical edge at lattice (X, Z), level y. */
    span(X, y, Z) {
        if (this._box) {
            const i = this._cell(X, y, Z);
            if (i < 0) return this._computeSpan(X, y, Z);
            const m = this._spanMemo[i];
            if (m & 128) return m & 127;
            const s = this._computeSpan(X, y, Z);
            this._spanMemo[i] = s | 128;
            return s;
        }
        // Queries are always local, so 10 bits of X/Z keep keys distinct.
        const key = ((X & 1023) | ((Z & 1023) << 10)) + (y + 1024) * 1048576;
        let s = this._spans.get(key);
        if (s === undefined) {
            s = this._computeSpan(X, y, Z);
            this._spans.set(key, s);
        }
        return s;
    }

    _computeSpan(X, y, Z) {
        const kind = this.kind, get = this.get;
        let filled = 0, topHeld = false, botHeld = false;
        for (let r = 0; r < 4; r++) {
            const x = X + RING_DX[r], z = Z + RING_DZ[r];
            const k = kind[get(x, y, z)];
            if (k === KIND_EMPTY) continue;
            if (k === KIND_CUBE) return SPAN_FULL;
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
        for (let l = base - 2; l <= base + 1; l++) {
            const s = this.span(X, l, Z);
            if (!spanFilled(s)) continue;
            const t = spanT(s);
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
     * stretch of top surface *on this level* that runs from this corner. Both
     * voxels meeting at a seam see the same stretches, so they agree on the
     * slope and the surface is C1 across the seam; a stretch that is covered
     * (the surface carries on at another level, as on a staircase) does not
     * count, so it cannot flatten a steady slope.
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
        const key = (((X & 1023) | ((Z & 1023) << 10)) + (y + 1024) * 1048576) * 2 + (alongZ ? 1 : 0);
        let m = this._slopes.get(key);
        if (m === undefined) {
            m = this._cornerSlope(X, Z, y, alongZ);
            this._slopes.set(key, m);
        }
        return m;
    }

    _cornerSlope(X, Z, y, alongZ) {
        const c = spanT(this.span(X, y, Z));
        let m = this.slope(X, Z, y + c, alongZ);
        if (m === 0) return 0;
        const dx = alongZ ? 0 : 1, dz = alongZ ? 1 : 0;
        for (let dir = -1; dir <= 1; dir += 2) {
            if (!this._liveStretch(X, Z, y, alongZ, dir)) continue;
            const cn = spanT(this.span(X + dir * dx, y, Z + dir * dz));
            const d  = dir > 0 ? cn - c : c - cn;          // rise in the +axis direction
            if (d === 0 || (d > 0) !== (m > 0)) return 0;
            const lim = 3 * Math.abs(d);
            if (Math.abs(m) > lim) m = m > 0 ? lim : -lim;
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

    /** Do all four top corners of the level-y voxel at (x, z) drop? Then it is a thin feature. */
    _allDropped(x, y, z) {
        for (let i = 0; i < 4; i++) {
            if (spanT(this.span(x + CORNER_U[i], y, z + CORNER_V[i])) === 1) return false;
        }
        return true;
    }

    /** Describe the top surface of the Mesh voxel at (x, y, z) into `s` (see newSurface). */
    describeTop(x, y, z, s) {
        const c = s.c;
        for (let i = 0; i < 4; i++) c[i] = spanT(this.span(x + CORNER_U[i], y, z + CORNER_V[i]));
        for (let i = 0; i < 4; i++) {
            const X = x + CORNER_U[i], Z = z + CORNER_V[i];
            s.mx[i] = this.cornerSlope(X, Z, y, false);
            s.mz[i] = this.cornerSlope(X, Z, y, true);
        }

        // A voxel whose corners all drop would flatten away. Instead it becomes
        // a crest voxel: a rounded crest from its centre to the middle of every
        // side it shares with a neighbouring top surface on the same level.
        const open = this._openTop(x, y, z);
        s.crest = open && c[0] < 1 && c[1] < 1 && c[2] < 1 && c[3] < 1;

        // A side carries the crest (a hump in its edge curve) when both voxels
        // beside it are open-topped Mesh voxels on this level and either one is
        // a crest voxel. Both voxels evaluate exactly this, so they agree —
        // which is what joins rings, bends, crosses and ridges into one piece.
        const hump = s.hump;
        for (let e = 0; e < 4; e++) {
            const nx = x + SIDE_DX[e], nz = z + SIDE_DZ[e];
            hump[e] = open && this._openTop(nx, y, nz) && (s.crest || this._allDropped(nx, y, nz)) ? 1 : 0;
        }
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
        mx:    new Float64Array(4),   // corner slopes along x (raw)
        mz:    new Float64Array(4),   // corner slopes along z (raw)
        em:    new Float64Array(8),   // per edge: [start, end] slopes used for geometry
        es:    new Float64Array(8),   // per edge: the same before straightening, for shading
        hump:  new Uint8Array(4),     // per edge: carries a crest (see describeTop)
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
        if (!s.hump[e] && (ma !== d || mb !== d) && edgeBend(ma - d, mb - d) < minBend) {
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

    field.describeTop(x, y, z, out.top);
    flipped.describeTop(x, -1 - y, z, out.bot);
    const t = out.top.c, b = out.bot.c;
    return !(t[0] === 1 && t[1] === 1 && t[2] === 1 && t[3] === 1 &&
             b[0] === 1 && b[1] === 1 && b[2] === 1 && b[3] === 1);
}

// ── Evaluation ───────────────────────────────────────────────────────────────

// The crest profile across a ridge (and along a side that carries one):
// 16·s²(1−s)², which is 0 with zero slope at the voxel sides and 1 with zero
// slope on the crest, so crests are round on top and meet the ground smoothly.
function bump(s) { const q = s * (1 - s); return 16 * q * q; }
function bumpSlope(s) { const q = s * (1 - s); return 32 * q * (1 - 2 * s); }

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
    if (s.hump[e] && !plain) {
        const B = bump(p);
        d = d * (1 - B) + (1 - v) * bumpSlope(p);
        v = v + (1 - v) * B;
    }
    out[0] = v < 0 ? 0 : v > 1 ? 1 : v;
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
 * flagged in `link`; the profile is bump(½ − d) for distance d to that crest.
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
    let d2 = du * du + dv * dv, gu = du, gv = dv;          // centre point
    if (link[2] && u <= 0.5 && dv * dv < d2) { d2 = dv * dv; gu = 0; gv = dv; }   // to −x side
    if (link[3] && u >= 0.5 && dv * dv < d2) { d2 = dv * dv; gu = 0; gv = dv; }   // to +x side
    if (link[0] && v <= 0.5 && du * du < d2) { d2 = du * du; gu = du; gv = 0; }   // to −z side
    if (link[1] && v >= 0.5 && du * du < d2) { d2 = du * du; gu = du; gv = 0; }   // to +z side
    const d = Math.sqrt(d2);
    if (d >= 0.5) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
    out[0] = bump(0.5 - d);
    if (d < 1e-12) { out[1] = 0; out[2] = 0; return; }
    const k = -bumpSlope(0.5 - d) / d;                     // d/d(u,v) of bump(½ − d)
    out[1] = k * gu;
    out[2] = k * gv;
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

    if (crest) {
        crestAt(s.hump, u, v, _cr);
        const C = _cr[0];
        hu = hu * (1 - C) + (1 - h) * _cr[1];
        hv = hv * (1 - C) + (1 - h) * _cr[2];
        h  = h + (1 - h) * C;
    }
    out[0] = h < 0 ? 0 : h > 1 ? 1 : h;
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
 * heights. `n` (optional) holds unit outward normals per vertex.
 */
export function surfaceGrid(s, flip, withNormals = false) {
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

/**
 * Collision against smooth terrain, for the player and mobs.
 *
 * Reads the live WorldState. Shapes and edge spans are cached, and the caches
 * are dropped whenever WorldState.editVersion moves (a block edit or a chunk
 * load/unload), so a cached shape is never stale.
 */
export class SmoothTerrain {
    constructor(worldState, blockRegistry) {
        this.world = worldState;
        this.kind  = buildKindTable(blockRegistry);
        const get  = (x, y, z) => this._block(x, y, z);
        this._field   = new SmoothField(this.kind, get, false);
        this._flipped = new SmoothField(this.kind, get, true);
        this._cache   = new Map();
        this._ver     = -1;
        this._scratch = newShape();
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
     * full cube: { top, bot } grids of real in-voxel heights (surfaceGrid).
     */
    shapeAt(x, y, z) {
        const ver = this.world.editVersion ?? 0;
        if (ver !== this._ver || this._cache.size > 4096 || this._field.size > 65536) {
            this._cache.clear();
            this._field.clear();
            this._flipped.clear();
            this._ver = ver;
        }
        const key = (x & 0x3FF) + (z & 0x3FF) * 1024 + (y - WORLD_MIN_Y) * 1048576;
        if (this._cache.has(key)) return this._cache.get(key);

        let entry = null;
        const s = this._scratch;
        if (describeVoxel(this._field, this._flipped, x, y, z, s)) {
            entry = { top: surfaceGrid(s.top, false), bot: surfaceGrid(s.bot, true) };
        }
        this._cache.set(key, entry);
        return entry;
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
