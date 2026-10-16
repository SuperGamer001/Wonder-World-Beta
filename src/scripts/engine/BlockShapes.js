/**
 * BlockShapes — what a block that is not a cube is made of.
 *
 * A block with a `model` (BlockRegistry) is a few boxes and planes inside its
 * voxel: a slab, a flight of stairs, a fence, a door, a chair, a flower. This
 * file says what each is, once, and everything that has to agree about it goes
 * by it: the mesher draws these elements (workers/BlockModels.js), the player
 * and the mobs collide with the same boxes, and the crosshair picks them
 * (ShapeSet, below). No Three.js and no DOM: the workers import it too.
 *
 * Everything is in sixteenths of a block, built facing east (+X is the front)
 * and turned about the voxel's vertical centre line to the block's `facing`.
 * What changes a model besides its facing is in the block's `shape` object:
 * `half: "top"` (an upper slab, stairs upside down), `open` (a door, a gate, a
 * curtain), `stage` (how much of a cake is eaten), `plant` (a pot with
 * something in it).
 *
 * An element is one of
 *   { from, to }                a box. Its faces show the block's textures by
 *                               the way they face — `top`, `bottom`, `side` —
 *                               or the one(s) `mat` names (a string for every
 *                               face, or { e, w, s, n, u, d } for some). The
 *                               texture is laid over the voxel, so a box shows
 *                               the part of it that it covers: a texture is a
 *                               view of the whole model from that side. `only`
 *                               (a string of face letters) draws just those;
 *                               `uv` ({ side, top, bottom }: rectangles of a
 *                               16-pixel sheet) is the older way of picking
 *                               texels, kept for the torch and the lantern.
 *                               `glow: false` leaves a box out of the block's
 *                               glow (the logs under a fire). `flip` mirrors
 *                               the texture across (a door hung on its other
 *                               side); `uvt: [scale, u0, v0]` shows only that
 *                               part of it (a piece of a painting several
 *                               blocks across, which shares a texture).
 *   { cross: [x0, y0, z0, x1, y1, z1] }
 *                               two upright planes corner to corner of that
 *                               box, each showing the whole texture: a plant.
 *
 * Faces: e +X, w −X, s +Z, n −Z, u +Y, d −Y.
 */

const box = (x0, y0, z0, x1, y1, z1, o) => ({ from: [x0, y0, z0], to: [x1, y1, z1], ...o });
const FULL = [[0, 0, 0, 16, 16, 16]];
// How high a fence, a wall or a shut gate stops a body, in sixteenths: a block
// and a half, though it is drawn one high — the player's jump is 1.25
// (PlayerPhysics), and a fence that can be jumped keeps nothing in.
const FENCE_TOP = 24;
const NONE = [];

// cos and sin of the turn that takes +X to each facing: x' = x cos + z sin, z' = −x sin + z cos.
const TURN = { east: [1, 0], west: [-1, 0], south: [0, -1], north: [0, 1] };
export const FACINGS = ['east', 'west', 'south', 'north'];
export const FACING_DIR = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
/** The facing a horizontal direction (dx, dz) is nearest. */
export function facingOf(dx, dz) {
    return Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north');
}
export const OPPOSITE = { east: 'west', west: 'east', south: 'north', north: 'south' };
/**
 * A quarter turn anticlockwise, seen from above: the way that is on the left
 * of one facing that way. A model is built facing east, and its −z side is
 * that left (north); its +z side is the right.
 */
export const LEFT_OF = { east: 'north', north: 'west', west: 'south', south: 'east' };

// A bit for each side a fence reaches out to.
export const CONN_E = 1, CONN_W = 2, CONN_S = 4, CONN_N = 8;
// A bit for each side a sofa, a chair or a shelf has one of its own kind on:
// its left (model −z) and its right (model +z).
export const SIDE_L = 1, SIDE_R = 2;
// The shapes a flight of stairs takes from the stairs round it: straight, an
// outer corner (only a quarter of the step), or an inner one (the step and a
// quarter more), on its left or its right.
export const STAIR_STRAIGHT = 0, STAIR_OUTER_L = 1, STAIR_OUTER_R = 2, STAIR_INNER_L = 3, STAIR_INNER_R = 4;
// … and a sofa: 0–3 a straight piece (SIDE_L | SIDE_R: which sides have a sofa
// beside); an outer corner (only a post where the backs meet) on its left or
// right; an inner corner (a second back along its left or right), + 1 when a
// sofa beside its open side carries the row on (no arm there).
export const SOFA_OUTER_L = 4, SOFA_OUTER_R = 5, SOFA_INNER_L = 6, SOFA_INNER_R = 8;

/** A sofa's backs, its arms, and the sides a sofa stands beside (no legs there), for its join code. */
function sofaParts(c) {
    if (c < SOFA_OUTER_L) {
        return { backs: [[0, 7, 0, 5, 14, 16]], armL: !(c & SIDE_L), armR: !(c & SIDE_R), nearL: !!(c & SIDE_L), nearR: !!(c & SIDE_R) };
    }
    if (c < SOFA_INNER_L) {
        const L = c === SOFA_OUTER_L;
        return { backs: [L ? [0, 7, 0, 5, 14, 5] : [0, 7, 11, 5, 14, 16]], armL: false, armR: false, nearL: L, nearR: !L };
    }
    const L = c < SOFA_INNER_R, joined = (c - (L ? SOFA_INNER_L : SOFA_INNER_R)) === 1;
    return {
        backs: [[0, 7, 0, 5, 14, 16], L ? [5, 7, 0, 16, 14, 5] : [5, 7, 11, 16, 14, 16]],
        armL: !L && !joined, armR: L && !joined, nearL: !L && joined, nearR: L && joined,
    };
}

/** The four legs of something standing on them, at the corners of (x0, z0)–(x1, z1); `skip(i)` leaves leg i out (0 −x−z, 1 +x−z, 2 −x+z, 3 +x+z). */
const legsWhere = (x0, z0, x1, z1, h, t, o, skip) => [
    [x0, z0], [x1 - t, z0], [x0, z1 - t], [x1 - t, z1 - t],
].flatMap(([x, z], i) => (skip(i) ? [] : [box(x, 0, z, x + t, h, z + t, o)]));

// ── The torch and the lantern, as they were ──────────────────────────────────
const TORCH_STICK = { from: [-1, 0, -1], to: [1, 10, 1], uv: { side: [7, 6, 2, 10], top: [7, 6, 2, 2], bottom: [7, 14, 2, 2] } };
const lanternBoxes = (y) => [
    { from: [5, y, 5], to: [11, y + 7, 11], uv: { side: [0, 2, 6, 7], top: [0, 9, 6, 6], bottom: [0, 9, 6, 6] } },
    { from: [6, y + 7, 6], to: [10, y + 9, 10], uv: { side: [6, 0, 4, 2], top: [6, 2, 4, 4] }, only: 'ewsnu' },
];

const legs = (x0, z0, x1, z1, h, t = 2, o = { mat: 'side' }) => [
    box(x0, 0, z0, x0 + t, h, z0 + t, o), box(x1 - t, 0, z0, x1, h, z0 + t, o),
    box(x0, 0, z1 - t, x0 + t, h, z1, o), box(x1 - t, 0, z1 - t, x1, h, z1, o),
];

/**
 * The models. Each is given the block's `shape` object (never null) and
 * answers
 *   els     what is drawn — or a function of the sides a fence joins on
 *   hit     boxes that stop a body (default: none — it is walked through)
 *   pick    boxes the crosshair meets (default: `hit`, or the whole voxel)
 * and may say
 *   tall    its `hit` stands above its own voxel (a fence: two blocks)
 *   climb   a ladder
 *   wash    water takes it away
 *   soft    it does not count as a block to the ground beside it (smooth
 *           worlds), and it stands on the ground's own surface
 *   shade   it stops light, and rain, like a cube
 *   rain    where rain stops on it, in sixteenths (default: 16 if it has a
 *           `hit`, else it falls through)
 *   joins   fences reach out to it
 *   connect its own elements depend on its neighbours, and how (connCode):
 *           'fence'  a bit for each side with something it reaches out to
 *           'stairs' straight, or a corner, from the stairs in front and behind
 *           'side'   a bit for each side with one of its own kind, the same way round
 *           'sofa'   as 'side', or a corner (as stairs turn one) from the sofas in front and behind
 *           'table'  a bit for each side with another table
 *           `els`, `hit` and `pick` are then functions of that code
 *   turn    false: it is not turned to a facing
 *   tilt    the wall torch's lean
 *   closes  it can close on a body (a door, a gate), which may then walk on
 *           out of it (PlayerPhysics, MobAI)
 *   seat    sixteenths up to where someone sits on it (a chair, a sofa)
 *   lie     sixteenths up to where someone lies on it (a bed)
 */
const MODELS = {
    torch:           () => ({ els: [{ ...TORCH_STICK, from: [7, 0, 7], to: [9, 10, 9] }], pick: [[6, 0, 6, 10, 11, 10]], wash: true }),
    wall_torch:      () => ({ els: [TORCH_STICK], tilt: true, pick: [[0, 2, 5, 7, 14, 11]], wash: true }),
    lantern:         () => ({ els: lanternBoxes(0), pick: [[4, 0, 4, 12, 10, 12]] }),
    hanging_lantern: () => ({
        els: [...lanternBoxes(1), { from: [7.5, 10, 7.5], to: [8.5, 16, 8.5], uv: { side: [11, 0, 1, 6] }, only: 'ewsn' }],
        pick: [[4, 1, 4, 12, 16, 12]],
    }),

    // ── Building ─────────────────────────────────────────────────────────────
    slab: (s) => {
        const b = s.half === 'top' ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16];
        return { els: [box(...b)], hit: [b], shade: true, rain: b[4] };
    },
    // Half a block upright: the half toward its facing.
    vslab: () => ({ els: [box(8, 0, 0, 16, 16, 16)], hit: [[8, 0, 0, 16, 16, 16]], shade: true }),
    // Up toward its facing; upside down with half: "top". Stairs meeting
    // stairs turned across them make a corner, as they would be built: the
    // step shrinks to a quarter (outer) or gains a quarter (inner) — connCode.
    stairs: (s) => {
        const top = s.half === 'top';
        const lo = top ? 0 : 8, hi = top ? 8 : 16;
        const base = top ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16];
        const boxes = (c) => [base, ...({
            [STAIR_STRAIGHT]: [[8, lo, 0, 16, hi, 16]],
            [STAIR_OUTER_L]:  [[8, lo, 0, 16, hi, 8]],
            [STAIR_OUTER_R]:  [[8, lo, 8, 16, hi, 16]],
            [STAIR_INNER_L]:  [[8, lo, 0, 16, hi, 16], [0, lo, 0, 8, hi, 8]],
            [STAIR_INNER_R]:  [[8, lo, 0, 16, hi, 16], [0, lo, 8, 8, hi, 16]],
        }[c] ?? [[8, lo, 0, 16, hi, 16]])];
        return { connect: 'stairs', els: (c) => boxes(c).map(q => box(...q)), hit: boxes, shade: true };
    },
    fence: () => ({
        connect: 'fence', joins: true, tall: true, turn: false,
        els: (c) => [
            box(6, 0, 6, 10, 16, 10),
            ...(c & CONN_E ? [box(10, 12, 7, 16, 15, 9), box(10, 6, 7, 16, 9, 9)] : []),
            ...(c & CONN_W ? [box(0, 12, 7, 6, 15, 9), box(0, 6, 7, 6, 9, 9)] : []),
            ...(c & CONN_S ? [box(7, 12, 10, 9, 15, 16), box(7, 6, 10, 9, 9, 16)] : []),
            ...(c & CONN_N ? [box(7, 12, 0, 9, 15, 6), box(7, 6, 0, 9, 9, 6)] : []),
        ],
        hit: (c) => [
            [6, 0, 6, 10, FENCE_TOP, 10],
            ...(c & CONN_E ? [[10, 0, 6, 16, FENCE_TOP, 10]] : []), ...(c & CONN_W ? [[0, 0, 6, 6, FENCE_TOP, 10]] : []),
            ...(c & CONN_S ? [[6, 0, 10, 10, FENCE_TOP, 16]] : []), ...(c & CONN_N ? [[6, 0, 0, 10, FENCE_TOP, 6]] : []),
        ],
        pick: (c) => [
            [6, 0, 6, 10, 16, 10],
            ...(c & CONN_E ? [[10, 5, 6, 16, 16, 10]] : []), ...(c & CONN_W ? [[0, 5, 6, 6, 16, 10]] : []),
            ...(c & CONN_S ? [[6, 5, 10, 10, 16, 16]] : []), ...(c & CONN_N ? [[6, 5, 0, 10, 16, 6]] : []),
        ],
    }),
    // A low wall of stone: a thick post, and lower stretches between posts.
    wall: () => ({
        connect: 'fence', joins: true, tall: true, turn: false, rain: 16,
        els: (c) => [
            box(4, 0, 4, 12, 16, 12),
            ...(c & CONN_E ? [box(12, 0, 5, 16, 14, 11)] : []), ...(c & CONN_W ? [box(0, 0, 5, 4, 14, 11)] : []),
            ...(c & CONN_S ? [box(5, 0, 12, 11, 14, 16)] : []), ...(c & CONN_N ? [box(5, 0, 0, 11, 14, 4)] : []),
        ],
        hit: (c) => [
            [4, 0, 4, 12, FENCE_TOP, 12],
            ...(c & CONN_E ? [[12, 0, 5, 16, FENCE_TOP, 11]] : []), ...(c & CONN_W ? [[0, 0, 5, 4, FENCE_TOP, 11]] : []),
            ...(c & CONN_S ? [[5, 0, 12, 11, FENCE_TOP, 16]] : []), ...(c & CONN_N ? [[5, 0, 0, 11, FENCE_TOP, 4]] : []),
        ],
        pick: (c) => [
            [4, 0, 4, 12, 16, 12],
            ...(c & CONN_E ? [[12, 0, 5, 16, 14, 11]] : []), ...(c & CONN_W ? [[0, 0, 5, 4, 14, 11]] : []),
            ...(c & CONN_S ? [[5, 0, 12, 11, 14, 16]] : []), ...(c & CONN_N ? [[5, 0, 0, 11, 14, 4]] : []),
        ],
    }),
    // Across the way it faces; open, its two leaves swing toward its facing —
    // or, with `back`, away from it: a gate opens away from whoever opens it.
    // Open or shut, the crosshair meets the whole gateway (the leaves and the
    // gap between the posts), so it can be shut again by looking through it.
    gate: (s) => {
        if (!s.open) return {
            joins: true, tall: true, closes: true,
            els: [
                box(7, 5, 0, 9, 16, 2), box(7, 5, 14, 9, 16, 16),
                box(7, 12, 2, 9, 15, 14), box(7, 6, 2, 9, 9, 14), box(7, 9, 6, 9, 12, 10),
            ],
            hit: [[6, 0, 0, 10, FENCE_TOP, 16]],
            pick: [[6, 0, 0, 10, 16, 16]],
        };
        const [a, b] = s.back ? [1, 7] : [9, 15], k = s.back ? 1 : 13;
        return {
            joins: true, closes: true,
            els: [
                box(7, 5, 0, 9, 16, 2), box(7, 5, 14, 9, 16, 16),
                box(a, 12, 0, b, 15, 2), box(a, 6, 0, b, 9, 2), box(k, 9, 0, k + 2, 12, 2),
                box(a, 12, 14, b, 15, 16), box(a, 6, 14, b, 9, 16), box(k, 9, 14, k + 2, 12, 16),
            ],
            pick: [[6, 0, 2, 10, 16, 14], [Math.min(a, 7), 5, 0, Math.max(b, 9), 16, 2], [Math.min(a, 7), 5, 14, Math.max(b, 9), 16, 16]],
        };
    },
    // A leaf three sixteenths thick: shut, on the side of its voxel behind its
    // facing; open, swung round on its hinge to the side beside that. Hung on
    // the left (−z) by default; `hinge: "right"` hangs it on the other side,
    // its picture turned round — two of them, one each way, are double doors.
    door: (s) => {
        const right = s.hinge === 'right';
        const b = s.open ? (right ? [0, 0, 13, 16, 16, 16] : [0, 0, 0, 16, 16, 3]) : [0, 0, 0, 3, 16, 16];
        return { els: [box(...b, right ? { flip: true } : {})], hit: [b], closes: true };
    },
    trapdoor: (s) => {
        const b = s.open ? [0, 0, 0, 3, 16, 16] : s.half === 'top' ? [0, 13, 0, 16, 16, 16] : [0, 0, 0, 16, 3, 16];
        return { els: [box(...b)], hit: [b], climb: !!s.open, closes: true };
    },
    // Flat against the block behind its facing.
    ladder: () => ({ els: [box(0.6, 0, 0, 1, 16, 16, { only: 'ew' })], pick: [[0, 0, 0, 2, 16, 16]], climb: true }),

    // ── Things on a wall ─────────────────────────────────────────────────────
    // A board on the wall behind its facing. A picture several blocks across
    // is a block for each piece (`tile`: [scale, u0, v0], the part of the
    // shared texture this piece shows). The picture is turned the right way
    // round to whoever looks at it from the room (`flip`).
    painting: (s) => ({ els: [box(0, 0, 0, 1, 16, 16, { flip: true, ...(Array.isArray(s.tile) ? { uvt: s.tile } : {}) })], pick: [[0, 0, 0, 2, 16, 16]] }),
    // Open, it is drawn back to either side — and the crosshair still meets the
    // whole of it, the gap between too, so it can be drawn shut by looking
    // through it (as a gate is).
    curtain: (s) => ({
        els: s.open
            ? [box(1, 0, 0, 1.5, 16, 4, { only: 'ew' }), box(1, 0, 12, 1.5, 16, 16, { only: 'ew' })]
            : [box(1, 0, 0, 1.5, 16, 16, { only: 'ew' })],
        pick: [[0, 0, 0, 3, 16, 16]],
    }),
    // Shelves side by side are one long shelf: brackets only at its ends.
    shelf: () => ({
        connect: 'side',
        els: (c) => [box(0, 9, 0, 8, 11, 16), ...(c & SIDE_L ? [] : [box(0, 4, 1, 6, 9, 3)]), ...(c & SIDE_R ? [] : [box(0, 4, 13, 6, 9, 15)])],
        hit: [[0, 9, 0, 8, 11, 16]], rain: 0,
    }),
    // Hung across the top of its voxel, from side to side of the way it faces.
    bunting: () => ({ els: [box(7.8, 5, 0, 8.2, 16, 16, { only: 'ew' })], pick: [[7, 8, 0, 9, 16, 16]] }),

    // ── Plants ───────────────────────────────────────────────────────────────
    // (`pick`: how tall the plant is, for the crosshair.)
    cross: (s) => ({ els: [{ cross: [1.5, 0, 1.5, 14.5, 16, 14.5] }], pick: [[4, 0, 4, 12, s.pick ?? 12, 12]], wash: true, soft: true, turn: false }),
    pot: (s) => ({
        turn: false,
        els: [
            box(5, 0, 5, 11, 6, 11, { mat: { u: 'bottom' } }),
            box(4.5, 5, 4.5, 11.5, 6.5, 11.5, { only: 'ewsn' }),
            ...(s.plant ? [{ cross: [3.5, 6, 3.5, 12.5, 16, 12.5], mat: 'top' }] : []),
        ],
        hit: [[5, 0, 5, 11, 6, 11]],
        pick: s.plant ? [[4, 0, 4, 12, 15, 12]] : [[4, 0, 4, 12, 7, 12]],
        rain: 0,
    }),
    vase: () => ({
        turn: false,
        els: [box(4, 0, 4, 12, 9, 12), box(5.5, 9, 5.5, 10.5, 12, 10.5, { only: 'ewsn' }), box(4.5, 12, 4.5, 11.5, 14, 11.5)],
        hit: [[4, 0, 4, 12, 14, 12]],
    }),

    // ── Furniture ────────────────────────────────────────────────────────────
    // Tables side by side are one table: legs only at its outer corners.
    table: () => ({
        turn: false, connect: 'table',
        els: (c) => [box(0, 13, 0, 16, 16, 16, { mat: 'top' }), ...tableLegs(c).map(q => box(...q, { mat: 'side' }))],
        hit: (c) => [[0, 13, 0, 16, 16, 16], ...tableLegs(c)],
        pick: FULL,
    }),
    // The back is behind its facing: whoever sits in it looks that way.
    // Chairs side by side, the same way round, are a bench: one seat, one
    // back, legs only at its ends.
    chair: () => ({
        connect: 'side', seat: 9,
        els: (c) => {
            const z0 = c & SIDE_L ? 0 : 2, z1 = c & SIDE_R ? 16 : 14, top = { mat: 'top' };
            return [box(2, 7, z0, 14, 9, z1, top), box(2, 9, z0, 4, 16, z1, top),
                ...legsWhere(2, 2, 14, 14, 7, 2, { mat: 'side' }, (i) => (i < 2 ? c & SIDE_L : c & SIDE_R))];
        },
        hit: (c) => { const z0 = c & SIDE_L ? 0 : 2, z1 = c & SIDE_R ? 16 : 14; return [[2, 0, z0, 14, 9, z1], [2, 9, z0, 4, 16, z1]]; },
    }),
    stool: () => ({
        turn: false, seat: 9,
        els: [box(3, 7, 3, 13, 9, 13, { mat: 'top' }), ...legs(3.5, 3.5, 12.5, 12.5, 7)],
        hit: [[3, 0, 3, 13, 9, 13]],
    }),
    // Arms at its ends; sofas side by side, the same way round, are one long
    // sofa, with arms only at the ends of the row. And it turns a corner as
    // stairs do (connCode 'sofa'): an inner corner has a second back along one
    // side, an outer one only a post where the two backs meet.
    sofa: () => ({
        connect: 'sofa', seat: 7,
        els: (c) => {
            const top = { mat: 'top' }, p = sofaParts(c);
            return [box(0, 2, 0, 16, 7, 16, top), ...p.backs.map(q => box(...q, top)),
                ...(p.armL ? [box(5, 7, 0, 16, 11, 2.5, top)] : []), ...(p.armR ? [box(5, 7, 13.5, 16, 11, 16, top)] : []),
                ...legsWhere(0.5, 0.5, 15.5, 15.5, 2, 2, { mat: 'side' }, (i) => (i < 2 ? p.nearL : p.nearR))];
        },
        hit: (c) => {
            const p = sofaParts(c);
            return [[0, 0, 0, 16, 7, 16], ...p.backs, ...(p.armL ? [[5, 7, 0, 16, 11, 2.5]] : []), ...(p.armR ? [[5, 7, 13.5, 16, 11, 16]] : [])];
        },
    }),
    // A cupboard: a cube whose front (its facing) is its `top` texture.
    cabinet: () => ({ els: [box(0, 0, 0, 16, 16, 16, { mat: { e: 'top', u: 'bottom', d: 'bottom' } })], hit: FULL, shade: true }),
    // Made of what a bed is made of, so it comes in any colour of wool: a
    // wooden frame (`bottom`), a white mattress and pillow (`side`), and a
    // blanket (`top`). The head is toward the facing.
    bed: (s) => {
        const wood = { mat: 'bottom' }, white = { mat: 'side' }, cover = { mat: 'top' };
        const head = s.part === 'head';
        return {
            lie: 9,
            // (No two faces of it lie in one plane facing the same way: they would flicker.)
            els: head ? [
                box(0, 2, 0.6, 14, 7, 15.4, white),                                     // the mattress
                box(0, 7, 0, 7, 9, 16, cover),                                          // the blanket, over it
                box(0, 3, 0, 7, 7, 0.6, cover), box(0, 3, 15.4, 7, 7, 16, cover),       // … and down its sides
                box(7, 7, 0.6, 8.5, 9.4, 15.4, white),                                  // the sheet turned down
                box(9, 7, 2, 13.5, 9.8, 14, white),                                     // the pillow
                box(14, 0, 0, 16, 14, 16, wood),                                        // the headboard
                box(0, 1, 0, 14, 2, 0.6, wood), box(0, 1, 15.4, 14, 2, 16, wood),       // the rails
            ] : [
                box(2.1, 2, 0.6, 16, 7, 15.4, white),
                box(1.5, 7, 0, 16, 9, 16, cover),
                box(1.5, 3, 0, 16, 7, 0.6, cover), box(1.5, 3, 15.4, 16, 7, 16, cover), box(1.5, 3, 0.6, 2.1, 7, 15.4, cover),
                box(0, 0, 0, 1.5, 9.5, 1.5, wood), box(0, 0, 14.5, 1.5, 9.5, 16, wood), box(0, 2, 1.5, 0.75, 7.5, 14.5, wood),
                box(1.5, 1, 0, 16, 2, 0.6, wood), box(1.5, 1, 15.4, 16, 2, 16, wood),
            ],
            hit: [[0, 0, 0, 16, 9, 16]],
        };
    },
    carpet: () => ({ turn: false, els: [box(0, 0, 0, 16, 1, 16)], pick: [[0, 0, 0, 16, 2, 16]], wash: true }),

    // ── Food that is put down ────────────────────────────────────────────────
    cake: (s) => {
        const x0 = 1 + (s.stage | 0) * 3.5;
        return { turn: false, els: [box(x0, 0, 1, 15, 7, 15, { mat: { u: 'top', d: 'bottom', w: (s.stage | 0) > 0 ? 'bottom' : 'side' } })], hit: [[x0, 0, 1, 15, 7, 15]], rain: 0 };
    },
    pie: (s) => {
        const x0 = 2 + (s.stage | 0) * 4;
        return { turn: false, els: [box(x0, 0, 2, 14, 4, 14, { mat: { u: 'top', d: 'bottom', w: (s.stage | 0) > 0 ? 'bottom' : 'side' } })], hit: [[x0, 0, 2, 14, 4, 14]], rain: 0 };
    },

    // ── Fire, and what goes off ──────────────────────────────────────────────
    fire: () => ({ turn: false, els: [{ cross: [0.5, 0, 0.5, 15.5, 16, 15.5] }, box(4, 0, 0, 4, 12, 16, { only: 'ew' }), box(12, 0, 0, 12, 12, 16, { only: 'ew' })], pick: [[2, 0, 2, 14, 10, 14]], wash: true }),
    // Four logs (bark: `side`; their cut ends: `bottom`) and, lit, the fire (`top`).
    campfire: (s) => {
        const alongX = { glow: false, mat: { e: 'bottom', w: 'bottom', u: 'side', d: 'side', s: 'side', n: 'side' } };
        const alongZ = { glow: false, mat: { s: 'bottom', n: 'bottom', u: 'side', d: 'side', e: 'side', w: 'side' } };
        return {
            turn: false,
            els: [
                box(1, 0, 3, 15, 3, 6, alongX), box(1, 0, 10, 15, 3, 13, alongX),
                box(3, 3, 1, 6, 6, 15, alongZ), box(10, 3, 1, 13, 6, 15, alongZ),
                ...(s.lit ? [{ cross: [2.5, 4, 2.5, 13.5, 16, 13.5], mat: 'top' }] : []),
            ],
            hit: [[1, 0, 1, 15, 6, 15]], rain: 0,
        };
    },
    bomb: () => ({
        turn: false,
        els: [box(3, 0, 3, 13, 10, 13), box(7.5, 10, 7.5, 8.5, 13, 8.5, { mat: 'top', only: 'ewsn' })],
        hit: [[3, 0, 3, 13, 10, 13]],
    }),

    // ── Things to use ────────────────────────────────────────────────────────
    // A plate (`side`: its glaze), with a rim, and with `food` what is on it (`top`: a picture of it, cut out).
    plate: (s) => ({
        turn: false, rain: 0,
        els: [
            box(2.5, 0, 2.5, 13.5, 0.6, 13.5, { mat: 'side' }),
            box(2, 0.6, 2, 14, 1.3, 3, { mat: 'side' }), box(2, 0.6, 13, 14, 1.3, 14, { mat: 'side' }),
            box(2, 0.6, 3, 3, 1.3, 13, { mat: 'side' }), box(13, 0.6, 3, 14, 1.3, 13, { mat: 'side' }),
            // The whole picture over each (uvt), twice, the upper a little smaller: it has some thickness.
            ...(s.food ? [box(3.5, 0.7, 3.5, 12.5, 0.9, 12.5, { mat: 'top', only: 'u', uvt: [16 / 9, -3.5 / 9, -3.5 / 9] }),
                          box(4, 1.5, 4, 12, 1.7, 12, { mat: 'top', only: 'u', uvt: [2, -0.5, -0.5] })] : []),
        ],
        hit: [[2, 0, 2, 14, 1.3, 14]],
        pick: [[2, 0, 2, 14, s.food ? 4 : 2, 14]],
    }),
    // An anvil: a foot, a waist, and the long face it is worked on, across its facing.
    anvil: () => ({
        els: [box(2, 0, 2, 14, 4, 14), box(4, 4, 3, 12, 5, 13), box(6, 5, 4, 10, 10, 12), box(3, 10, 0, 13, 16, 16)],
        hit: [[2, 0, 2, 14, 10, 14], [3, 10, 0, 13, 16, 16]],
        pick: [[2, 0, 2, 14, 10, 14], [3, 10, 0, 13, 16, 16]],
    }),
};

/** A table's legs, in sixteenths: at its corners where no table stands beside it on either side (connCode 'table'). */
function tableLegs(c) {
    const out = [];
    for (const [x0, z0, ex, ez] of [[1, 1, CONN_W, CONN_N], [13, 1, CONN_E, CONN_N], [1, 13, CONN_W, CONN_S], [13, 13, CONN_E, CONN_S]]) {
        if (!(c & ex) && !(c & ez)) out.push([x0, 0, z0, x0 + 2, 13, z0 + 2]);
    }
    return out;
}

/** Whether a model name is known. */
export function isModel(name) { return Object.prototype.hasOwnProperty.call(MODELS, name); }

function turnBox(b, c, s) {
    // The two corners, turned about the centre line; a quarter turn keeps a box a box.
    const ax = c * (b[0] - 8) + s * (b[2] - 8) + 8, az = -s * (b[0] - 8) + c * (b[2] - 8) + 8;
    const bx = c * (b[3] - 8) + s * (b[5] - 8) + 8, bz = -s * (b[3] - 8) + c * (b[5] - 8) + 8;
    return [Math.min(ax, bx), b[1], Math.min(az, bz), Math.max(ax, bx), b[4], Math.max(az, bz)];
}

/** Boxes in sixteenths, model space → Float32Array of block units in the voxel, six numbers a box. */
function place(list, c, s) {
    const out = new Float32Array(list.length * 6);
    list.forEach((b, i) => { const t = turnBox(b, c, s); for (let k = 0; k < 6; k++) out[i * 6 + k] = t[k] / 16; });
    return out;
}

/**
 * A block definition's shape, worked out: what the mesher draws and what
 * stops and is met. `def` needs `model`, `facing` and `shape`. Null for a
 * block with no model (a cube).
 */
export function compileShape(def) {
    if (!def?.model || !isModel(def.model)) return null;
    const m = MODELS[def.model](def.shape ?? {});
    const turn = m.turn === false ? TURN.east : (TURN[def.facing] ?? TURN.east);
    const [c, s] = turn;
    const per = (v, fallback) => {
        v ??= fallback;
        if (typeof v === 'function') { const all = []; for (let k = 0; k < 16; k++) all.push(place(v(k), c, s)); return all; }
        return place(v, c, s);
    };
    const hit = per(m.hit, NONE);
    const hasHit = Array.isArray(hit) ? true : hit.length > 0;
    return {
        model: def.model,
        // What another block's shape asks of this one (connCode): which way it faces, which way up it is.
        facing: m.turn === false ? 'east' : (TURN[def.facing] ? def.facing : 'east'),
        half: def.shape?.half === 'top' ? 'top' : 'bottom',
        cos: c, sin: s,
        tilt: !!m.tilt,
        connect: m.connect || false,             // how its neighbours change it (connCode), or false
        els: m.els,                              // elements, or (conn) => elements
        hit,                                     // Float32Array, or one for each of the 16 ways it can join
        pick: per(m.pick, m.hit ?? FULL.slice()),
        collides: hasHit,
        tall: !!m.tall, climb: !!m.climb, wash: !!m.wash, soft: !!m.soft, shade: !!m.shade, joins: !!m.joins,
        closes: !!m.closes, seat: m.seat ?? 0, lie: m.lie ?? 0,
        rain: m.rain ?? (hasHit ? 16 : 0),
    };
}

/**
 * What a definition's model says about the block besides its looks — the
 * registry keeps these on the definition, where the workers and the smooth
 * terrain find them.
 */
export function shapeFlags(def) {
    const sh = compileShape(def);
    if (!sh) return null;
    return { collides: sh.collides, tall: sh.tall, climb: sh.climb, wash: sh.wash, soft: sh.soft, shade: sh.shade, joins: sh.joins, rain: sh.rain,
        connect: !!sh.connect, closes: sh.closes, seat: sh.seat, lie: sh.lie };
}

/**
 * How a shaped block is changed by the four blocks beside it: the code its
 * `els`, `hit` and `pick` are looked up by (0 … 15), or 0 for one whose shape
 * does not depend on them. The mesher and the collision both ask this, so
 * what is drawn is what is met.
 *
 * @param sh       the block's compiled shape
 * @param idAt     (dx, dz) → the id of the block beside it, that way
 * @param shapeOf  id → its compiled shape, or undefined for a cube
 * @param joinOf   id → whether a fence reaches out to it
 */
export function connCode(sh, idAt, shapeOf, joinOf) {
    // (No closures made here: it is asked on every collision test beside a fence, a stair or furniture.)
    switch (sh.connect) {
        case 'fence':
            return (joinOf(idAt(1, 0)) ? CONN_E : 0) | (joinOf(idAt(-1, 0)) ? CONN_W : 0)
                 | (joinOf(idAt(0, 1)) ? CONN_S : 0) | (joinOf(idAt(0, -1)) ? CONN_N : 0);
        case 'table': {
            const m = sh.model;
            return (shapeOf(idAt(1, 0))?.model === m ? CONN_E : 0) | (shapeOf(idAt(-1, 0))?.model === m ? CONN_W : 0)
                 | (shapeOf(idAt(0, 1))?.model === m ? CONN_S : 0) | (shapeOf(idAt(0, -1))?.model === m ? CONN_N : 0);
        }
        case 'side': {
            // One of its own kind beside it, turned the same way.
            const left = LEFT_OF[sh.facing];
            return (_ownBeside(sh, left, idAt, shapeOf) ? SIDE_L : 0) | (_ownBeside(sh, OPPOSITE[left], idAt, shapeOf) ? SIDE_R : 0);
        }
        case 'sofa': {
            // As stairs are: a sofa turned across this one in front of it makes
            // this an inner corner, its back running on along the side that
            // one's back is on; one turned across it behind makes it an outer
            // corner, only a post where the two backs meet — unless a straight
            // row carries on past where the corner would be.
            const F = sh.facing, B = OPPOSITE[F], left = LEFT_OF[F], right = OPPOSITE[left];
            const front = _sofaBeside(sh, F, idAt, shapeOf);
            if (front && front.facing !== F && front.facing !== B) {
                const side = OPPOSITE[front.facing];
                if (!_ownBeside(sh, side, idAt, shapeOf)) {
                    const L = side === left;
                    return (L ? SOFA_INNER_L : SOFA_INNER_R) + (_sofaJoins(sh, L ? right : left, idAt, shapeOf) ? 1 : 0);
                }
            }
            const back = _sofaBeside(sh, B, idAt, shapeOf);
            if (back && back.facing !== F && back.facing !== B) {
                const side = OPPOSITE[back.facing];
                if (!_ownBeside(sh, OPPOSITE[side], idAt, shapeOf)) return side === left ? SOFA_OUTER_L : SOFA_OUTER_R;
            }
            return (_sofaJoins(sh, left, idAt, shapeOf) ? SIDE_L : 0) | (_sofaJoins(sh, right, idAt, shapeOf) ? SIDE_R : 0);
        }
        case 'stairs': {
            // As stairs are built: stairs behind this flight turned across it
            // make an outer corner of it, stairs in front of it turned across
            // it an inner one — unless that would break a straight run of
            // stairs beside it the same way round.
            const F = sh.facing, B = OPPOSITE[F], left = LEFT_OF[F];
            const back = _stairsBeside(sh, F, idAt, shapeOf);
            if (back && back.facing !== F && back.facing !== B && _stairsBeside(sh, OPPOSITE[back.facing], idAt, shapeOf)?.facing !== F)
                return back.facing === left ? STAIR_OUTER_L : STAIR_OUTER_R;
            const front = _stairsBeside(sh, B, idAt, shapeOf);
            if (front && front.facing !== F && front.facing !== B && _stairsBeside(sh, front.facing, idAt, shapeOf)?.facing !== F)
                return front.facing === left ? STAIR_INNER_L : STAIR_INNER_R;
            return STAIR_STRAIGHT;
        }
    }
    return 0;
}

/** Whether the block beside `sh` toward `f` is one of its own model, turned the same way. */
function _ownBeside(sh, f, idAt, shapeOf) {
    const d = FACING_DIR[f], o = shapeOf(idAt(d[0], d[1]));
    return o?.model === sh.model && o.facing === sh.facing;
}

/** The sofa beside `sh` toward `f`, or null. */
function _sofaBeside(sh, f, idAt, shapeOf) {
    const d = FACING_DIR[f], o = shapeOf(idAt(d[0], d[1]));
    return o?.model === sh.model ? o : null;
}

/**
 * Whether the row goes on from `sh` toward `f`: a sofa there the same way
 * round — or turned across, as the corner a row turns at is (only one facing
 * the other way, back to back or face to face, is not part of it).
 */
function _sofaJoins(sh, f, idAt, shapeOf) {
    const o = _sofaBeside(sh, f, idAt, shapeOf);
    return !!o && o.facing !== OPPOSITE[sh.facing];
}

/** The stairs beside `sh` toward `f`, the same way up, or null. */
function _stairsBeside(sh, f, idAt, shapeOf) {
    const d = FACING_DIR[f], o = shapeOf(idAt(d[0], d[1]));
    return o?.model === 'stairs' && o.half === sh.half ? o : null;
}

/**
 * The shapes of a registry's blocks, for whatever moves about among them.
 * `world` is anything with getBlock(x, y, z).
 */
export class ShapeSet {
    constructor(reg) {
        this.reg = reg;
        this._s = [];
        // What connCode reads, made once: conn says where it is asking about.
        this._w = null; this._x = 0; this._y = 0; this._z = 0;
        this._idAt = (dx, dz) => this._w.getBlock(this._x + dx, this._y, this._z + dz);
        this._shapeOf = (id) => this._s[id];
        this._joinOf = (id) => this._join[id] === 1;
        // What a fence reaches out to: a full cube that is not see-through, or
        // another fence, wall or gate.
        this._join = new Uint8Array(65536);
        for (const def of reg.serialize()) {
            const sh = compileShape(def);
            if (sh) this._s[def.id] = sh;
            this._join[def.id] = sh ? (sh.joins ? 1 : 0) : (def.id !== 0 && !reg.isTransparent(def.id) ? 1 : 0);
        }
    }

    /** The shape of block `id`, or undefined for a cube (or air). */
    of(id) { return this._s[id]; }

    /** How the shaped block at (x, y, z) is changed by what stands beside it (connCode): for a fence, which of its four sides it joins on. */
    conn(world, x, y, z, sh = this._s[world.getBlock(x, y, z)]) {
        if (!sh?.connect) return 0;
        this._w = world; this._x = x; this._y = y; this._z = z;
        const c = connCode(sh, this._idAt, this._shapeOf, this._joinOf);
        this._w = null;
        return c;
    }

    _boxes(which, sh, world, x, y, z) {
        const b = sh[which];
        return Array.isArray(b) ? b[this.conn(world, x, y, z, sh)] : b;
    }

    /** Does the box (x0 … z1, world space) touch what stops a body of the shaped block at (bx, by, bz)? */
    boxHits(sh, world, bx, by, bz, x0, y0, z0, x1, y1, z1) {
        const b = this._boxes('hit', sh, world, bx, by, bz);
        for (let i = 0; i < b.length; i += 6) {
            if (x1 > bx + b[i] && x0 < bx + b[i + 3] && y1 > by + b[i + 1] && y0 < by + b[i + 4] &&
                z1 > bz + b[i + 2] && z0 < bz + b[i + 5]) return true;
        }
        return false;
    }

    /** Is the point inside what the crosshair meets (`solid`: what stops a body) of the shaped block it is in? */
    pointIn(sh, world, x, y, z, solid = false, lift = 0) {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const b = this._boxes(solid ? 'hit' : 'pick', sh, world, bx, by, bz);
        const u = x - bx, v = y - by - lift, w = z - bz;
        for (let i = 0; i < b.length; i += 6) {
            if (u >= b[i] && u <= b[i + 3] && v >= b[i + 1] && v <= b[i + 4] && w >= b[i + 2] && w <= b[i + 5]) return true;
        }
        return false;
    }

    /**
     * Which face of the shaped block a look along (dx, dy, dz) came in by, to
     * reach the point (x, y, z) inside what the crosshair meets of it: the
     * face's normal, [nx, ny, nz], or null if the point is in none of its
     * boxes. (The top of a slab is a face of the slab, though it is in the
     * middle of the slab's voxel.)
     */
    faceAt(sh, world, x, y, z, dx, dy, dz, lift = 0) {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const b = this._boxes('pick', sh, world, bx, by, bz);
        const p = [x - bx, y - by - lift, z - bz], d = [dx, dy, dz], e = 0.03;
        let best = null, back = Infinity;
        for (let i = 0; i < b.length; i += 6) {
            if (p[0] < b[i] - e || p[0] > b[i + 3] + e || p[1] < b[i + 1] - e || p[1] > b[i + 4] + e || p[2] < b[i + 2] - e || p[2] > b[i + 5] + e) continue;
            // Back along the look, the first side of the box that is come to is the one it came in by.
            for (let a = 0; a < 3; a++) {
                if (d[a] === 0) continue;
                const t = d[a] > 0 ? (p[a] - b[i + a]) / d[a] : (b[i + 3 + a] - p[a]) / -d[a];
                if (t < back) { back = t; best = [0, 0, 0]; best[a] = d[a] > 0 ? -1 : 1; }
            }
        }
        return best;
    }

    /** The highest point of what stops a body in the shaped block's voxel, in blocks above its floor (0: nothing does). */
    top(sh, world, bx, by, bz) {
        const b = this._boxes('hit', sh, world, bx, by, bz);
        let t = 0;
        for (let i = 0; i < b.length; i += 6) if (b[i + 4] > t) t = b[i + 4];
        return t;
    }
}
