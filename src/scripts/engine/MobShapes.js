/**
 * MobShapes — what a mob model is built from: bones, the shapes that hang on
 * them, where each shape's texels are, and its triangles.
 *
 * Pure data and maths (no Three.js, no DOM). The models themselves are in
 * MobModelDefs.js, their animation in MobAnim.js; the renderer (MobModels.js)
 * and the texture painter (tools/gen_mob_textures.mjs) both read a shape
 * through `shape.patches`, `surfacePoint` and `shapeMesh`, so the two can
 * never disagree about where a texel is.
 *
 * A model is a tree of **parts** — its bones. A part turns about its pivot (a
 * shin about the knee, the head about the top of the neck). Everything is
 * measured in **pixels, 16 to a block**.
 *
 * Axes: +Y up, +Z the way the mob faces, +X its left. Feet stand on y = 0.
 *
 * Two kinds of shape:
 *
 *   loft  A skin over a row of cross-sections ("stations") along a path: a
 *         leg from shoulder to hoof, a body from rump to chest, a head from
 *         poll to muzzle. Each station says where the path is, how wide and
 *         how deep the section is there (and how square: an oval, or closer to
 *         a rounded box), so a shape has the profile of the thing it is — a
 *         deep chest, a tucked flank, a knee, a jaw — rather than the outline
 *         of a ball. Stations are joined by smooth curves that never overshoot
 *         them.
 *         **A station also says which bone it follows**, and may follow two:
 *         the ring of skin at a knee goes half with the thigh and half with
 *         the shin. One loft therefore runs unbroken through a joint, and
 *         bends there like skin — nothing is hinged on, and no gap opens.
 *   box   A block, its edges rounded off as far as asked (`round`) and
 *         narrowed toward one end (`taper`): ears, fins, hat brims, eyelids.
 *         It follows the one bone it is on.
 *
 * Texels: a model has `density` texels to the pixel (2: twice the ground's 16
 * to a block); a shape may ask for more (faces do). A shape is unwrapped into
 * **patches**, rectangles of the model's atlas: a loft's side as one sheet
 * wrapped round it (across = round the section, starting under or behind it;
 * down = along the path) plus one for each closed end, seen end on; a box one
 * per face. Patches are packed with a texel of space between them, which the
 * painter fills with the colour beside it, so nothing bleeds at an edge.
 *
 * Variants: a model may come in several looks (`variants`: name → count). A
 * part with `show: { hair: 2 }` (or `{ hair: [0, 2] }`) is drawn only for that choice, and
 * `layers(variant)` names the texture files to stack for a variant.
 */

export const PX = 1 / 16;

export const FACE_NAMES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const FACE_NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;
const AXES = { x: 0, y: 1, z: 2 };
const GUTTER = 1;          // texels left clear round every patch
const ARC_STEPS = 24;      // samples of a quarter section, for spacing texels evenly round it
const three = (v) => Array.isArray(v) ? v : [v, v, v];
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const spow = (c, e) => c < 0 ? -Math.pow(-c, e) : Math.pow(c, e);

export class Builder {
    /**
     * @param {string} name
     * @param {object} [opts]  variants, layers (see above); density: texels per px (default 2)
     */
    constructor(name, opts = {}) {
        this.model = {
            name,
            parts: [],
            index: {},
            shapes: [],
            marks: {},
            variants: opts.variants ?? {},
            layers: opts.layers ?? (() => [name]),
            density: opts.density ?? 2,
            atlas: { width: 0, height: 0 },
        };
        this.part('root', null, [0, 0, 0]);
    }

    /**
     * A bone, which becomes the current part: shapes that follow are its own.
     * @param {string} name
     * @param {string|null} parent
     * @param {number[]} pivot   the point it turns about (px)
     * @param {object} [opts]    rot: degrees [x, y, z] its shapes are turned by
     *                           about the pivot after being laid out (an ear set
     *                           at an angle); show: { variantName: choice } —
     *                           drawn only for it
     */
    part(name, parent, pivot, opts = {}) {
        const m = this.model;
        const p = {
            name,
            parent: parent === null ? -1 : m.index[parent],
            pivot: [...pivot],
            rot: (opts.rot ?? [0, 0, 0]).map(d => d * DEG),
            show: opts.show ?? null,
            shapes: [],
            rest: null,
        };
        if (parent !== null && p.parent === undefined) throw new Error(`${m.name}: part ${name} has no parent ${parent}`);
        if (m.index[name] !== undefined) throw new Error(`${m.name}: two parts are called ${name}`);
        m.index[name] = m.parts.length;
        m.parts.push(p);
        this._part = p;
        return this;
    }

    /**
     * Name a point of the model as it stands at rest (px): an eye, the tip of
     * the nose. The painter puts features there and the animator reaches with
     * them, so neither has to repeat the number.
     */
    mark(name, point) {
        this.model.marks[name] = point;
        return this;
    }

    /** Make an earlier part the current one again. */
    on(name) {
        const i = this.model.index[name];
        if (i === undefined) throw new Error(`${this.model.name}: no part ${name}`);
        this._part = this.model.parts[i];
        return this;
    }

    _add(shape, opts) {
        const m = this.model;
        shape.part = m.index[this._part.name];
        shape.tag = opts.tag ?? this._part.name;
        shape.density = opts.density ?? m.density;
        shape.patches = null;
        this._part.shapes.push(shape);
        m.shapes.push(shape);
        return this;
    }

    /**
     * A loft on the current part. A station is
     *
     *     [x, y, z, across, up, down?, { sq, bone }?]
     *
     * its centre; half its width across the path; how far the section reaches
     * to one side of the centre the other way, and to the opposite side if
     * that differs. "Across" is the model's X unless `side` says otherwise,
     * and "up" is then the path's direction × across: +Y on a path that runs
     * forward (a body, back uppermost), +Z on one that runs down (a leg, shin
     * foremost).
     *   sq    2 an ellipse … 4 and more a rounded box (default: opts.sq, or 2)
     *   bone  the part this ring of skin follows: a name; ['a', 'b', w] for w
     *         of b and the rest of a; or (u, v) => either, for a ring that is
     *         not all of a piece — u and v run −1 … 1 across and up the
     *         section. Default: the current part.
     * Options:
     *   caps    [start, end]: how each end is closed — not at all (default: it
     *           is buried in another shape), true for flat, or a number of px
     *           it domes outward
     *   crease  the edge of a cap is kept sharp (a hoof's sole, a snout's disc)
     *   seg     edges round a section (default: by size)
     *   step    px: rings are added between stations until none are further
     *           apart than this (default: only at the stations)
     *   side    the "across" direction (default [1, 0, 0])
     *   along   sections all face this way instead of following the path's
     *           turns: slices of a head stay level
     *   smooth  false joins the stations with straight lines
     *   tag     names it for the texture painter (default: the part's name)
     *   density texels per px here
     */
    loft(stations, opts = {}) {
        const part = this._part;
        const st = stations.map((s) => {
            const last = s[s.length - 1];
            const o = typeof last === 'object' && last !== null ? last : {};
            const n = s.filter(v => typeof v === 'number');
            if (n.length < 5) throw new Error(`${this.model.name}: a station of ${opts.tag ?? part.name} needs x, y, z, across, up`);
            return { at: [n[0], n[1], n[2]], r: [n[3], n[4], n[5] ?? n[4]], sq: o.sq ?? opts.sq ?? 2, bone: o.bone ?? opts.bone ?? part.name };
        });
        if (st.length < 2) throw new Error(`${this.model.name}: a loft needs two stations`);
        return this._add({
            kind: 'loft',
            stations: st,
            side: opts.side ?? [1, 0, 0],
            along: opts.along ?? null,
            seg: opts.seg ?? null,
            step: opts.step ?? Infinity,
            caps: [opts.caps?.[0] ?? false, opts.caps?.[1] ?? false],
            crease: !!opts.crease,
            smooth: opts.smooth !== false,
            bind: null,
            L: null,
        }, opts);
    }

    /**
     * A box on the current part. `from` is its low corner and `size` its
     * extent, before the part's `rot`.
     *   round    corner radius in px, one number or [x, y, z]; an axis left 0
     *            keeps flat ends, one as large as half the box is fully round
     *   taper    ['y', lo, hi]: how wide the cross-section is at the low and
     *            the high end of that axis (1 = as laid out); either may be a
     *            pair, for the two other axes in x, y, z order
     *   inflate  grows it on every side without changing its texels
     *   faces    the faces to draw, of FACE_NAMES (default: all six)
     *   seg      edges per 45° of rounding (default: by radius)
     *   tag, density  as for a loft
     */
    box(from, size, opts = {}) {
        let taper = null;
        if (opts.taper) {
            const [axis, lo, hi] = opts.taper, a = AXES[axis];
            const spread = (k) => {
                const o = [1, 1, 1], v = Array.isArray(k) ? k : [k, k];
                for (let b = 0, i = 0; b < 3; b++) if (b !== a) o[b] = v[i++];
                return o;
            };
            taper = { axis: a, lo: spread(lo), hi: spread(hi) };
        }
        return this._add({
            kind: 'box',
            from, size,
            inflate: opts.inflate ?? 0,
            round: three(opts.round ?? 0),
            taper,
            seg: opts.seg ?? null,
            faces: opts.faces ? opts.faces.map(n => FACE_NAMES.indexOf(n)) : null,
            shape: null,
        }, opts);
    }

    /** A box placed by its centre. */
    blob(centre, size, opts = {}) {
        return this.box([centre[0] - size[0] / 2, centre[1] - size[1] / 2, centre[2] - size[2] / 2], size, opts);
    }

    done() {
        const m = this.model;
        restPose(m);
        for (const sh of m.shapes) {
            if (sh.kind === 'loft') sh.bind = sh.stations.map(s => bindSpec(m, sh, s.bone));
            sh.patches = sh.kind === 'loft' ? loftPatches(sh) : boxPatches(sh);
        }
        packAtlas(m);
        return m;
    }
}

// ── The rest pose ────────────────────────────────────────────────────────────

/** out = M · p for a 3 × 4 row-major matrix. */
function xform(M, p, out) {
    const x = p[0], y = p[1], z = p[2];
    out[0] = M[0] * x + M[1] * y + M[2] * z + M[3];
    out[1] = M[4] * x + M[5] * y + M[6] * z + M[7];
    out[2] = M[8] * x + M[9] * y + M[10] * z + M[11];
    return out;
}

/**
 * Work out where everything is at rest. A part's `rot` only says how its
 * shapes were laid out: `rest` is the matrix that takes them from there to
 * where they stand (its parents' turns included), and it is baked into the
 * geometry, so in the rest pose every bone's matrix is the identity. That is
 * what lets one vertex follow two bones. Pivots end up where they stand too.
 */
function restPose(model) {
    for (const p of model.parts) {
        const [ax, ay, az] = p.rot;
        const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
        // R = Ry · Rx · Rz, about the pivot.
        const R = [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
                   cx * sz, cx * cz, -sx,
                   -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx];
        const [px, py, pz] = p.pivot;
        const local = [R[0], R[1], R[2], px - (R[0] * px + R[1] * py + R[2] * pz),
                       R[3], R[4], R[5], py - (R[3] * px + R[4] * py + R[5] * pz),
                       R[6], R[7], R[8], pz - (R[6] * px + R[7] * py + R[8] * pz)];
        const A = p.parent < 0 ? null : model.parts[p.parent].rest;
        if (!A) p.rest = local;
        else {
            p.rest = new Array(12);
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) p.rest[r * 4 + c] = A[r * 4] * local[c] + A[r * 4 + 1] * local[4 + c] + A[r * 4 + 2] * local[8 + c];
                p.rest[r * 4 + 3] = A[r * 4] * local[3] + A[r * 4 + 1] * local[7] + A[r * 4 + 2] * local[11] + A[r * 4 + 3];
            }
        }
        p.turned = p.rest.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-9);
        if (A) xform(A, p.pivot, p.pivot);
    }
}

/** Take a laid-out point and normal (out[0..5]) to where they stand at rest. */
function bake(part, out) {
    if (!part.turned) return out;
    const M = part.rest, x = out[0], y = out[1], z = out[2], nx = out[3], ny = out[4], nz = out[5];
    out[0] = M[0] * x + M[1] * y + M[2] * z + M[3];
    out[1] = M[4] * x + M[5] * y + M[6] * z + M[7];
    out[2] = M[8] * x + M[9] * y + M[10] * z + M[11];
    out[3] = M[0] * nx + M[1] * ny + M[2] * nz;
    out[4] = M[4] * nx + M[5] * ny + M[6] * nz;
    out[5] = M[8] * nx + M[9] * ny + M[10] * nz;
    return out;
}

// ── The atlas ────────────────────────────────────────────────────────────────

/**
 * Give every patch its place in the atlas: shelves, tallest first, in the
 * narrowest power-of-two width that comes out no taller than it is wide. The
 * order is fixed by the definition, so the layout only changes when a model
 * does (and its textures are then repainted — tools/gen_mob_textures.mjs).
 */
function packAtlas(model) {
    const all = [];
    for (const sh of model.shapes) for (const p of sh.patches) all.push(p);
    const order = new Map(all.map((p, i) => [p, i]));
    const sorted = [...all].sort((a, b) => (b.h - a.h) || (b.w - a.w) || (order.get(a) - order.get(b)));
    let width = 32;
    for (const p of all) while (p.w + 2 * GUTTER > width) width *= 2;
    for (;; width *= 2) {
        let x = GUTTER, y = GUTTER, shelf = 0;
        for (const p of sorted) {
            if (x + p.w + GUTTER > width) { x = GUTTER; y += shelf; shelf = 0; }
            p.x = x; p.y = y;
            x += p.w + GUTTER;
            if (p.h + GUTTER > shelf) shelf = p.h + GUTTER;
        }
        if (y + shelf <= width || width >= 2048) {
            model.atlas.width = width;
            model.atlas.height = y + shelf;
            return;
        }
    }
}

// ── Lofts ────────────────────────────────────────────────────────────────────

/** A station's `bone` as [bone, other bone or −1, the other's share], or a function giving that. */
function bindSpec(model, shape, bone) {
    const one = (b) => {
        const name = (n) => {
            const i = model.index[n];
            if (i === undefined) throw new Error(`${model.name}: ${shape.tag} follows a part that does not exist, ${n}`);
            return i;
        };
        return Array.isArray(b) ? [name(b[0]), name(b[1]), b[2]] : [name(b), -1, 0];
    };
    return typeof bone === 'function' ? (u, v) => one(bone(u, v)) : one(bone);
}

/** Slopes for a cubic through (x[k], y[k]) that never overshoots a point (Fritsch–Carlson). */
function monotoneSlopes(x, y) {
    const n = x.length, m = new Array(n).fill(0), d = [];
    for (let k = 0; k < n - 1; k++) d.push((y[k + 1] - y[k]) / (x[k + 1] - x[k]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let k = 1; k < n - 1; k++) {
        if (d[k - 1] * d[k] <= 0) continue;
        const h0 = x[k] - x[k - 1], h1 = x[k + 1] - x[k];
        const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
        m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
    }
    return m;
}

/**
 * Everything about a loft that is worked out once: its stations as numbers
 * (centre, three radii, squareness), how far along the surface each one is
 * ("knots": measured along the profile, not the path, so texels keep their
 * height where the shape narrows to an end), the curves between them, where
 * its rings go, and a table for spacing texels evenly round a section.
 */
function loftOf(shape) {
    if (shape.L) return shape.L;
    const st = shape.stations, n = st.length;
    const val = st.map(s => [s.at[0], s.at[1], s.at[2], s.r[0], s.r[1], s.r[2], s.sq]);
    const mean = (v) => (v[3] + (v[4] + v[5]) / 2) / 2;
    const knot = [0];
    for (let k = 1; k < n; k++) {
        const a = val[k - 1], b = val[k];
        knot.push(knot[k - 1] + Math.max(1e-3, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2], mean(b) - mean(a))));
    }
    const slope = val.map(() => new Array(7).fill(0));
    for (let c = 0; c < 7; c++) {
        const m = monotoneSlopes(knot, val.map(v => v[c]));
        for (let k = 0; k < n; k++) slope[k][c] = m[k];
    }

    // Texels are spaced by distance round the widest section, a quarter at a
    // time, so the middle of each side and of the top falls on a texel edge.
    let ref = val[0];
    for (const v of val) if (v[3] + v[4] + v[5] > ref[3] + ref[4] + ref[5]) ref = v;
    const arc = [];
    let perimeter = 0;
    for (let q = 0; q < 4; q++) {
        const cum = [0];
        let px = 0, py = 0;
        for (let i = 0; i <= ARC_STEPS; i++) {
            const phi = (q + i / ARC_STEPS) * HALF_PI, cu = -Math.sin(phi), cv = -Math.cos(phi), e = 2 / ref[6];
            const x = spow(cu, e) * ref[3], y = spow(cv, e) * (cv > 0 ? ref[4] : ref[5]);
            if (i > 0) cum.push(cum[i - 1] + Math.hypot(x - px, y - py));
            px = x; py = y;
        }
        const total = cum[ARC_STEPS] || 1;
        perimeter += cum[ARC_STEPS];
        arc.push(cum.map(v => v / total));
    }

    const total = knot[n - 1];
    const rings = [];
    for (let k = 0; k < n; k++) {
        rings.push(knot[k]);
        if (k + 1 < n) {
            const extra = Number.isFinite(shape.step) ? Math.max(0, Math.ceil((knot[k + 1] - knot[k]) / shape.step - 1e-6) - 1) : 0;
            for (let i = 1; i <= extra; i++) rings.push(knot[k] + (knot[k + 1] - knot[k]) * i / (extra + 1));
        }
    }
    const side = shape.side, sl = Math.hypot(side[0], side[1], side[2]);
    const along = shape.along, al = along ? Math.hypot(along[0], along[1], along[2]) : 1;
    const L = shape.L = {
        n, val, knot, slope, arc, perimeter, total, rings,
        smooth: shape.smooth,
        seg: shape.seg ?? (perimeter > 30 ? 16 : perimeter > 11 ? 12 : perimeter > 4.5 ? 8 : 6),
        side: [side[0] / sl, side[1] / sl, side[2] / sl],
        along: along ? [along[0] / al, along[1] / al, along[2] / al] : null,
        out: 1,
    };
    // Which way round the surface's two directions cross to face out. It is
    // the same all over the shape, so it is settled once, where the shape is
    // widest and "out" is plainly away from the middle — asking each point
    // would get it wrong where the shape flares sharply.
    let vote = 0;
    for (let i = 0; i < 8; i++) vote += Math.sign(sideCross(L, (i + 0.5) / 8, knot[val.indexOf(ref)], []));
    L.out = vote < 0 ? -1 : 1;
    return L;
}

function loftPatches(shape) {
    const L = loftOf(shape), d = shape.density, st = shape.stations;
    const out = [{ kind: 'side', w: 4 * Math.max(1, Math.ceil(L.perimeter * d / 4 - 1e-6)), h: Math.max(1, Math.ceil(L.total * d - 1e-6)), x: 0, y: 0 }];
    for (let end = 0; end < 2; end++) {
        if (shape.caps[end] === false) continue;
        const r = st[end ? st.length - 1 : 0].r;
        out.push({ kind: 'cap', end, w: Math.max(1, Math.ceil(2 * r[0] * d - 1e-6)), h: Math.max(1, Math.ceil((r[1] + r[2]) * d - 1e-6)), x: 0, y: 0 });
    }
    return out;
}

// One section of a loft: v = centre, radii and squareness there; T, U, V the
// path's direction and the section's "across" and "up"; k, s the stations it
// lies between and how far from the first to the second.
const makeFrame = () => ({ v: new Float64Array(7), T: [0, 0, 1], U: [1, 0, 0], V: [0, 1, 0], k: 0, s: 0 });
const _F = makeFrame();

function loftFrame(L, tau, F) {
    const knot = L.knot, n = L.n;
    tau = clamp(tau, 0, L.total);
    let k = 0;
    while (k < n - 2 && tau > knot[k + 1]) k++;
    const h = knot[k + 1] - knot[k], s = clamp((tau - knot[k]) / h, 0, 1);
    const v0 = L.val[k], v1 = L.val[k + 1], T = F.T;
    if (L.smooth) {
        const m0 = L.slope[k], m1 = L.slope[k + 1], s2 = s * s, s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1, h10 = (s3 - 2 * s2 + s) * h, h01 = 3 * s2 - 2 * s3, h11 = (s3 - s2) * h;
        for (let c = 0; c < 7; c++) F.v[c] = h00 * v0[c] + h10 * m0[c] + h01 * v1[c] + h11 * m1[c];
        const d00 = 6 * (s2 - s) / h, d10 = 3 * s2 - 4 * s + 1, d11 = 3 * s2 - 2 * s;
        for (let c = 0; c < 3; c++) T[c] = d00 * (v0[c] - v1[c]) + d10 * m0[c] + d11 * m1[c];
    } else {
        for (let c = 0; c < 7; c++) F.v[c] = v0[c] + (v1[c] - v0[c]) * s;
        for (let c = 0; c < 3; c++) T[c] = v1[c] - v0[c];
    }
    if (L.along) { T[0] = L.along[0]; T[1] = L.along[1]; T[2] = L.along[2]; }
    let l = Math.hypot(T[0], T[1], T[2]);
    if (l < 1e-9) { T[0] = v1[0] - v0[0]; T[1] = v1[1] - v0[1]; T[2] = v1[2] - v0[2]; l = Math.hypot(T[0], T[1], T[2]) || 1; }
    T[0] /= l; T[1] /= l; T[2] /= l;
    const S = L.side, U = F.U, V = F.V, dot = S[0] * T[0] + S[1] * T[1] + S[2] * T[2];
    U[0] = S[0] - dot * T[0]; U[1] = S[1] - dot * T[1]; U[2] = S[2] - dot * T[2];
    l = Math.hypot(U[0], U[1], U[2]) || 1;
    U[0] /= l; U[1] /= l; U[2] /= l;
    V[0] = T[1] * U[2] - T[2] * U[1]; V[1] = T[2] * U[0] - T[0] * U[2]; V[2] = T[0] * U[1] - T[1] * U[0];
    F.k = k; F.s = s;
    return F;
}

/** The angle round a section at `a` of the way round it (0 … 1), by distance. */
function sectionAngle(L, a) {
    a -= Math.floor(a);
    const q = Math.min(3, Math.floor(a * 4)), f = a * 4 - q, tab = L.arc[q];
    let i = 1;
    while (i < ARC_STEPS && tab[i] < f) i++;
    const lo = tab[i - 1], hi = tab[i];
    return (q + (i - 1 + (hi > lo ? (f - lo) / (hi - lo) : 0)) / ARC_STEPS) * HALF_PI;
}

const _uv = [0, 0];
/** Where `a` of the way round is on the unit section: out = [across, up], each −1 … 1. Starts underneath (0, −1). */
function sectionUnit(L, a, sq, out) {
    const phi = sectionAngle(L, a), e = 2 / sq;
    out[0] = spow(-Math.sin(phi), e);
    out[1] = spow(-Math.cos(phi), e);
    return out;
}

/** A point of a loft's side: `a` round it, `tau` along it. out[0..2]. */
function sidePos(L, a, tau, out) {
    const F = loftFrame(L, tau, _F), v = F.v;
    sectionUnit(L, a, v[6], _uv);
    const pu = _uv[0] * v[3], pv = _uv[1] * (_uv[1] > 0 ? v[4] : v[5]);
    out[0] = v[0] + F.U[0] * pu + F.V[0] * pv;
    out[1] = v[1] + F.U[1] * pu + F.V[1] * pv;
    out[2] = v[2] + F.U[2] * pu + F.V[2] * pv;
    return out;
}

const _a = [0, 0, 0], _b = [0, 0, 0];
/**
 * A point of a loft's side, out[0..2], with the cross of the surface's two
 * directions there, out[3..5]: the normal, but for its length and which way
 * it faces. Returns how far that cross points away from the middle of the
 * section (negative: toward it).
 *
 * On the inside of a bend tighter than the shape is thick, the smooth surface
 * between two stations doubles back on itself (the rings that are drawn do
 * not), and the cross comes out reversed; it is turned round again there.
 */
function sideCross(L, a, tau, out) {
    const da = 2e-3, dt = Math.min(0.02, L.total * 0.01);
    sidePos(L, a - da, tau, _a); sidePos(L, a + da, tau, _b);
    const ax = _b[0] - _a[0], ay = _b[1] - _a[1], az = _b[2] - _a[2];
    sidePos(L, a, Math.max(0, tau - dt), _a); sidePos(L, a, Math.min(L.total, tau + dt), _b);
    const bx = _b[0] - _a[0], by = _b[1] - _a[1], bz = _b[2] - _a[2];
    sidePos(L, a, tau, out);
    const T = _F.T, back = bx * T[0] + by * T[1] + bz * T[2] < 0 ? -1 : 1;
    out[3] = (ay * bz - az * by) * back; out[4] = (az * bx - ax * bz) * back; out[5] = (ax * by - ay * bx) * back;
    const v = _F.v;
    return out[3] * (out[0] - v[0]) + out[4] * (out[1] - v[1]) + out[5] * (out[2] - v[2]);
}

/** A point of a loft's side and its normal: out = [x, y, z, nx, ny, nz]. */
function sidePoint(L, a, tau, out) {
    sideCross(L, a, tau, out);
    let l = Math.hypot(out[3], out[4], out[5]) * L.out;
    if (Math.abs(l) < 1e-12) {
        // Where the surface comes to a point there is no cross: straight out from the middle.
        const v = _F.v;
        out[3] = out[0] - v[0]; out[4] = out[1] - v[1]; out[5] = out[2] - v[2];
        l = Math.hypot(out[3], out[4], out[5]) || 1;
    }
    out[3] /= l; out[4] /= l; out[5] /= l;
    return out;
}

/**
 * A point of a loft's cap, and its normal: (x, y) across and up the end
 * section, each −1 … 1; outside the section's outline it is the nearest point
 * of the rim. A cap that domes rises by `bulge` at its middle.
 */
function capPoint(shape, end, x, y, out) {
    const L = loftOf(shape), bulge = shape.caps[end] === true ? 0 : shape.caps[end];
    const F = loftFrame(L, end ? L.total : 0, _F), v = F.v, sq = v[6], dir = end ? 1 : -1;
    let rho = Math.pow(Math.pow(Math.abs(x), sq) + Math.pow(Math.abs(y), sq), 1 / sq);
    if (rho > 1) { x /= rho; y /= rho; rho = 1; }
    const rv = y > 0 ? v[4] : v[5], pu = x * v[3], pv = y * rv, rise = bulge * (1 - rho * rho) * dir;
    out[0] = v[0] + F.U[0] * pu + F.V[0] * pv + F.T[0] * rise;
    out[1] = v[1] + F.U[1] * pu + F.V[1] * pv + F.T[1] * rise;
    out[2] = v[2] + F.U[2] * pu + F.V[2] * pv + F.T[2] * rise;
    // The dome's slope: d(ρ²)/d(across), d(ρ²)/d(up).
    let gu = 0, gv = 0;
    if (bulge && rho > 1e-6) {
        const k = 2 * Math.pow(rho, 2 - sq) * bulge;
        gu = k * spow(x, sq - 1) / v[3];
        gv = k * spow(y, sq - 1) / rv;
    }
    const nx = F.T[0] * dir + F.U[0] * gu + F.V[0] * gv, ny = F.T[1] * dir + F.U[1] * gu + F.V[1] * gv, nz = F.T[2] * dir + F.U[2] * gu + F.V[2] * gv;
    const l = Math.hypot(nx, ny, nz) || 1;
    out[3] = nx / l; out[4] = ny / l; out[5] = nz / l;
    return out;
}

/** Which bones a point of a ring follows: out = [bone, other bone or −1, the other's share]. */
function weights(shape, k, s, u, v, out) {
    const n = shape.bind.length, spec = (i) => typeof shape.bind[i] === 'function' ? shape.bind[i](u, v) : shape.bind[i];
    const A = spec(k), B = s > 1e-6 && k + 1 < n ? spec(k + 1) : null;
    const w = new Map();
    const add = (sp, share) => {
        w.set(sp[0], (w.get(sp[0]) ?? 0) + share * (sp[1] < 0 ? 1 : 1 - sp[2]));
        if (sp[1] >= 0) w.set(sp[1], (w.get(sp[1]) ?? 0) + share * sp[2]);
    };
    add(A, B ? 1 - s : 1);
    if (B) add(B, s);
    // The two it follows most; a third would be a modelling slip, and is dropped.
    const top = [...w.entries()].sort((p, q) => q[1] - p[1]);
    const share = top.length > 1 ? top[1][1] / (top[0][1] + top[1][1]) : 0;
    out[0] = top[0][0];
    out[1] = share > 1e-3 ? top[1][0] : -1;
    out[2] = share > 1e-3 ? share : 0;
    return out;
}

function loftMesh(shape) {
    const L = loftOf(shape), K = L.seg, rings = L.rings, R = rings.length;
    const side = shape.patches[0];
    const pos = [], nrm = [], uv = [], idx = [], ba = [], bb = [], bw = [], pt = [], w = [0, -1, 0];
    const d2 = (i, j) => (pos[i * 3] - pos[j * 3]) ** 2 + (pos[i * 3 + 1] - pos[j * 3 + 1]) ** 2 + (pos[i * 3 + 2] - pos[j * 3 + 2]) ** 2;
    const push = (p, u, v, wt) => {
        pos.push(p[0], p[1], p[2]); nrm.push(p[3], p[4], p[5]); uv.push(u, v);
        ba.push(wt[0]); bb.push(wt[1]); bw.push(wt[2]);
    };
    // Which way round a triangle must go to face out: tested on the first one with any area.
    const facing = (i, j, k, n) => {
        const ax = pos[j * 3] - pos[i * 3], ay = pos[j * 3 + 1] - pos[i * 3 + 1], az = pos[j * 3 + 2] - pos[i * 3 + 2];
        const bx = pos[k * 3] - pos[i * 3], by = pos[k * 3 + 1] - pos[i * 3 + 1], bz = pos[k * 3 + 2] - pos[i * 3 + 2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        return Math.hypot(cx, cy, cz) < 1e-9 ? 0 : cx * n[0] + cy * n[1] + cz * n[2];
    };
    const tri = (flip, i, j, k) => { if (flip) idx.push(i, k, j); else idx.push(i, j, k); };

    // The side: a ring of K + 1 vertices at every station (the last on top of
    // the first, with the texels of the sheet's other edge).
    for (let r = 0; r < R; r++) {
        for (let c = 0; c <= K; c++) {
            const a = c / K;
            sidePoint(L, a, rings[r], pt);
            sectionUnit(L, a, _F.v[6], _uv);
            weights(shape, _F.k, _F.s, _uv[0], _uv[1], w);
            push(pt, side.x + a * side.w, side.y + rings[r] / L.total * side.h, w);
        }
    }
    let flip = null;
    const quads = [];
    for (let r = 0; r + 1 < R; r++) for (let c = 0; c < K; c++) {
        const tl = r * (K + 1) + c, tr = tl + 1, bl = tl + K + 1, br = bl + 1;
        if (flip === null) {
            const f = facing(tl, bl, br, [nrm[tl * 3] + nrm[br * 3], nrm[tl * 3 + 1] + nrm[br * 3 + 1], nrm[tl * 3 + 2] + nrm[br * 3 + 2]]);
            if (f !== 0) flip = f < 0;
        }
        quads.push(tl, tr, bl, br);
    }
    for (let q = 0; q < quads.length; q += 4) {
        const tl = quads[q], tr = quads[q + 1], bl = quads[q + 2], br = quads[q + 3];
        // Split each cell along its shorter diagonal: on a curve that is the one that follows it.
        if (d2(tl, br) <= d2(tr, bl) + 1e-9) { tri(flip, tl, bl, br); tri(flip, tl, br, tr); }
        else { tri(flip, tl, bl, tr); tri(flip, tr, bl, br); }
    }

    // The caps: the end ring again with the cap's own texels, a ring inside it
    // if the cap domes, and the middle.
    for (const patch of shape.patches) {
        if (patch.kind !== 'cap') continue;
        const end = patch.end, bulge = shape.caps[end] === true ? 0 : shape.caps[end];
        const tau = end ? L.total : 0, ring0 = (end ? R - 1 : 0) * (K + 1);
        const F = loftFrame(L, tau, _F), k = F.k, s = F.s, sq = F.v[6];
        const texel = (x, y) => [patch.x + (x + 1) / 2 * patch.w, patch.y + (1 - (y + 1) / 2) * patch.h];
        const base = pos.length / 3, scales = bulge ? [1, 0.55] : [1];
        for (const sc of scales) for (let c = 0; c < K; c++) {
            sectionUnit(L, c / K, sq, _uv);
            const x = _uv[0] * sc, y = _uv[1] * sc;
            capPoint(shape, end, x, y, pt);
            if (sc === 1 && bulge && !shape.crease) {
                // A domed cap runs into the side without an edge: both take the normal between theirs.
                const o = (ring0 + c) * 3;
                let nx = pt[3] + nrm[o], ny = pt[4] + nrm[o + 1], nz = pt[5] + nrm[o + 2];
                const l = Math.hypot(nx, ny, nz) || 1;
                nx /= l; ny /= l; nz /= l;
                pt[3] = nrm[o] = nx; pt[4] = nrm[o + 1] = ny; pt[5] = nrm[o + 2] = nz;
                if (c === 0) { const e = (ring0 + K) * 3; nrm[e] = nx; nrm[e + 1] = ny; nrm[e + 2] = nz; }
            }
            weights(shape, k, s, x, y, w);
            const t = texel(x, y);
            push(pt, t[0], t[1], w);
        }
        capPoint(shape, end, 0, 0, pt);
        weights(shape, k, s, 0, 0, w);
        const mid = texel(0, 0), centre = pos.length / 3;
        push(pt, mid[0], mid[1], w);
        const last = base + (scales.length - 1) * K;
        let cf = null;
        const faces = [];
        if (bulge) for (let c = 0; c < K; c++) {
            const o0 = base + c, o1 = base + (c + 1) % K, i0 = last + c, i1 = last + (c + 1) % K;
            faces.push(o0, o1, i1, o0, i1, i0);
        }
        for (let c = 0; c < K; c++) faces.push(last + c, last + (c + 1) % K, centre);
        const out = [pt[3], pt[4], pt[5]];
        for (let f = 0; f < faces.length && cf === null; f += 3) {
            const v = facing(faces[f], faces[f + 1], faces[f + 2], out);
            if (v !== 0) cf = v < 0;
        }
        for (let f = 0; f < faces.length; f += 3) tri(cf, faces[f], faces[f + 1], faces[f + 2]);
    }
    return { pos, nrm, uv, idx, ba, bb, bw };
}

// ── Boxes ────────────────────────────────────────────────────────────────────

const QUARTER = Math.PI / 4;

/**
 * A box's faces that are drawn, as patches, in FACE_NAMES order. For each:
 * how its rectangle lies on the box as laid out, before rounding — `o` the
 * corner the top-left texel starts at, `u` and `v` the edges its width and
 * height run along (px, inflate applied), `ua` and `va` the axes those are.
 * Seen from outside, u runs right and v down.
 */
function boxPatches(box) {
    const d = box.density, t = (s) => Math.max(1, Math.ceil(s * d - 1e-6));
    const w = t(box.size[0]), h = t(box.size[1]), dp = t(box.size[2]);
    const g = box.inflate;
    const x0 = box.from[0] - g, y0 = box.from[1] - g, z0 = box.from[2] - g;
    const sx = box.size[0] + 2 * g, sy = box.size[1] + 2 * g, sz = box.size[2] + 2 * g;
    const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
    const all = [
        { face: 0, w: dp, h,     o: [x1, y1, z1], u: [0, 0, -sz], v: [0, -sy, 0], ua: 2, va: 1 },   // +X
        { face: 1, w: dp, h,     o: [x0, y1, z0], u: [0, 0, sz],  v: [0, -sy, 0], ua: 2, va: 1 },   // −X
        { face: 2, w,     h: dp, o: [x0, y1, z0], u: [sx, 0, 0],  v: [0, 0, sz],  ua: 0, va: 2 },   // +Y
        { face: 3, w,     h: dp, o: [x0, y0, z1], u: [sx, 0, 0],  v: [0, 0, -sz], ua: 0, va: 2 },   // −Y
        { face: 4, w,     h,     o: [x0, y1, z1], u: [sx, 0, 0],  v: [0, -sy, 0], ua: 0, va: 1 },   // +Z (front)
        { face: 5, w,     h,     o: [x1, y1, z0], u: [-sx, 0, 0], v: [0, -sy, 0], ua: 0, va: 1 },   // −Z (back)
    ];
    for (const f of all) { f.kind = 'face'; f.x = 0; f.y = 0; }
    return box.faces ? all.filter(f => box.faces.includes(f.face)) : all;
}

/**
 * What a box is rounded with, worked out once: centre, half extents and radii
 * (inflate included — a shell stays the same distance off the shape under
 * it), and how finely each axis's rounding is cut: one segment per 45° up to
 * a radius of 2 px, two up to 8, three beyond.
 */
function boxOf(box) {
    if (box.shape) return box.shape;
    const g = box.inflate, c = [], h = [], r = [], seg = [];
    for (let a = 0; a < 3; a++) {
        c[a] = box.from[a] + box.size[a] / 2;
        h[a] = box.size[a] / 2 + g;
        r[a] = box.round[a] > 0 ? Math.min(h[a], box.round[a] + g) : 0;
        seg[a] = box.seg ?? (r[a] > 8 ? 3 : r[a] > 2 ? 2 : 1);
    }
    return box.shape = { c, h, r, seg, taper: box.taper };
}

const _q = [0, 0, 0], _d = [0, 0, 0], _p = [0, 0, 0], _n = [0, 0, 0];

/**
 * Where the point (sx, sy, sz) on the surface of the box as laid out
 * (relative to its centre) lies on the rounded shape, and the normal there.
 *
 * Each axis is flat between ±(h − r) and rounded beyond. In the rounded zone
 * the offset is read as an angle — equal steps along the box are equal turns
 * of the surface, so texels keep their size round a corner instead of
 * bunching up at it — and the three offsets together are pushed out onto the
 * ellipsoid of radii r. Where the face's own axis is not rounded (the end of
 * a cylinder) the same map squeezes the flat face into its round outline.
 * Both faces at an edge are given the same point there, so they meet.
 */
function boxPoint(sh, face, sx, sy, sz, out) {
    const h = sh.h, r = sh.r, c = sh.c;
    _p[0] = sx; _p[1] = sy; _p[2] = sz;
    let m = 0, len2 = 0;
    for (let a = 0; a < 3; a++) {
        const inner = h[a] - r[a], v = _p[a];
        const q = v < -inner ? -inner : v > inner ? inner : v;
        const d = r[a] > 0 && v !== q ? Math.tan((v - q) / r[a] * QUARTER) : 0;
        _q[a] = q; _d[a] = d;
        if (d > m) m = d; else if (-d > m) m = -d;
        len2 += d * d;
    }
    const k = len2 > 0 ? m / Math.sqrt(len2) : 0;
    const axis = face >> 1;
    for (let a = 0; a < 3; a++) {
        _p[a] = _q[a] + r[a] * _d[a] * k;
        // On a rounded face the normal is the ellipsoid's; a flat end keeps its own.
        _n[a] = r[axis] > 0 ? (r[a] > 0 ? _d[a] / r[a] : 0) : FACE_NORMALS[face][a];
    }
    const t = sh.taper;
    if (t) {
        // Scale the cross-section along the taper's axis; the normal leans with the slope.
        const A = t.axis, f = (_p[A] + h[A]) / (2 * h[A]);
        let nA = _n[A];
        for (let b = 0; b < 3; b++) {
            if (b === A) continue;
            const kb = Math.max(1e-3, t.lo[b] + (t.hi[b] - t.lo[b]) * f);
            nA -= (t.hi[b] - t.lo[b]) / (2 * h[A]) / kb * _p[b] * _n[b];
            _n[b] /= kb;
            _p[b] *= kb;
        }
        _n[A] = nA;
    }
    const nl = Math.hypot(_n[0], _n[1], _n[2]) || 1;
    out[0] = c[0] + _p[0]; out[1] = c[1] + _p[1]; out[2] = c[2] + _p[2];
    out[3] = _n[0] / nl; out[4] = _n[1] / nl; out[5] = _n[2] / nl;
    return out;
}

function facePoint(box, f, a, b, out) {
    const sh = boxOf(box), c = sh.c;
    return boxPoint(sh, f.face,
        f.o[0] + f.u[0] * a + f.v[0] * b - c[0],
        f.o[1] + f.u[1] * a + f.v[1] * b - c[1],
        f.o[2] + f.u[2] * a + f.v[2] * b - c[2], out);
}

/** Where a face's mesh has its edges along one axis, as fractions 0 … 1 of the face. */
function stops(sh, a) {
    const h = sh.h[a], r = sh.r[a], n = sh.seg[a];
    if (r <= 1e-6) return [0, 1];
    const s = [], inner = h - r;
    for (let i = 0; i <= n; i++) s.push((r * i / n) / (2 * h));
    for (let i = inner > 1e-6 ? 0 : 1; i <= n; i++) s.push((h + inner + r * i / n) / (2 * h));
    s[s.length - 1] = 1;
    return s;
}

/**
 * Each face is a grid — a line where the rounding starts and one for every
 * segment of it — so a plain box is still twelve triangles. Faces share the
 * positions and normals of the vertices along their common edge, but not
 * their texels: each has its own.
 */
function boxMesh(box) {
    const sh = boxOf(box);
    const pos = [], nrm = [], uv = [], idx = [], ba = [], bb = [], bw = [], pt = [];
    const d2 = (i, j) => (pos[i * 3] - pos[j * 3]) ** 2 + (pos[i * 3 + 1] - pos[j * 3 + 1]) ** 2 + (pos[i * 3 + 2] - pos[j * 3 + 2]) ** 2;
    for (const f of box.patches) {
        const A = stops(sh, f.ua), B = stops(sh, f.va);
        const base = pos.length / 3, cols = A.length;
        for (const b of B) for (const a of A) {
            facePoint(box, f, a, b, pt);
            pos.push(pt[0], pt[1], pt[2]);
            nrm.push(pt[3], pt[4], pt[5]);
            uv.push(f.x + a * f.w, f.y + b * f.h);
            ba.push(box.part); bb.push(-1); bw.push(0);
        }
        for (let j = 0; j + 1 < B.length; j++) for (let i = 0; i + 1 < cols; i++) {
            const tl = base + j * cols + i, tr = tl + 1, bl = tl + cols, br = bl + 1;
            if (d2(tl, br) <= d2(tr, bl) + 1e-9) idx.push(tl, bl, br, tl, br, tr);
            else idx.push(tl, bl, tr, tr, bl, br);
        }
    }
    return { pos, nrm, uv, idx, ba, bb, bw };
}

// ── What the renderer and the painter read ───────────────────────────────────

/**
 * The point of a shape's surface, and its normal, at (a, b) of one of its
 * patches — a across the rectangle, b down it, both 0 … 1.
 * out = [x, y, z, nx, ny, nz]: where it stands in the rest pose (px).
 */
export function surfacePoint(model, shape, patch, a, b, out = []) {
    if (patch.kind === 'face') facePoint(shape, patch, a, b, out);
    else if (patch.kind === 'side') sidePoint(loftOf(shape), a, b * loftOf(shape).total, out);
    else capPoint(shape, patch.end, 2 * a - 1, 1 - 2 * b, out);
    return bake(model.parts[shape.part], out);
}

/**
 * A shape as triangles, in the rest pose: `pos` and `nrm` three numbers a
 * vertex (px), `uv` two (texels of the atlas, from its top-left), `idx` three
 * a triangle, wound anticlockwise seen from outside; and what each vertex
 * follows — `ba` its bone, `bb` a second one or −1, `bw` the second's share.
 */
export function shapeMesh(model, shape) {
    const m = shape.kind === 'loft' ? loftMesh(shape) : boxMesh(shape);
    const part = model.parts[shape.part];
    if (part.turned) {
        const pt = [];
        for (let i = 0; i < m.pos.length; i += 3) {
            for (let k = 0; k < 3; k++) { pt[k] = m.pos[i + k]; pt[3 + k] = m.nrm[i + k]; }
            bake(part, pt);
            for (let k = 0; k < 3; k++) { m.pos[i + k] = pt[k]; m.nrm[i + k] = pt[3 + k]; }
        }
    }
    return m;
}

/**
 * Whether choice `i` of the variant `name` goes with what `variant` already
 * says. A model may limit a choice with `only`: { hair: { 1: { sex: 1 } } }
 * keeps the second head of hair for the second sex.
 */
export function choiceAllowed(model, name, i, variant) {
    const need = model.only?.[name]?.[i];
    if (!need) return true;
    for (const k in need) if ((variant?.[k] ?? 0) !== need[k]) return false;
    return true;
}

/**
 * A random look for a model: one choice for each of its variants, in the
 * order they are listed, each from those its `only` allows given the ones
 * before it.
 */
export function randomVariant(model, rnd = Math.random) {
    const v = {};
    for (const [name, count] of Object.entries(model.variants)) {
        const open = [];
        for (let i = 0; i < count; i++) if (choiceAllowed(model, name, i, v)) open.push(i);
        v[name] = open.length ? open[Math.floor(rnd() * open.length) % open.length] : 0;
    }
    return v;
}

/** Whether `part` is drawn for `variant`: `show` gives, per variant, the choice or the choices it goes with. */
export function partShown(part, variant) {
    if (!part.show) return true;
    for (const k in part.show) {
        const want = part.show[k], have = variant?.[k] ?? 0;
        if (Array.isArray(want) ? !want.includes(have) : have !== want) return false;
    }
    return true;
}

/**
 * A number that changes whenever a model's texels move: the textures painted
 * for one layout are wrong for any other. The painter records it beside the
 * textures and the renderer checks it, so a model changed without repainting
 * says so instead of just looking wrong.
 */
export function layoutKey(model) {
    let h = (model.atlas.width * 73856093) ^ (model.atlas.height * 19349663);
    for (const sh of model.shapes) for (const p of sh.patches) {
        for (const v of [p.x, p.y, p.w, p.h]) h = (Math.imul(h, 16777619) ^ v) >>> 0;
    }
    return h >>> 0;
}
