/**
 * BlockModels — small shapes for blocks that do not fill their voxel: torches
 * (standing and on a wall) and lanterns (standing and hanging).
 *
 * A model is a few boxes in sixteenths of a block, each face textured from a
 * rectangle of the block's texture sheet (pixels, y down, as in an image
 * editor). A directional model (a wall torch) is built leaning toward +X and
 * turned to its `facing`.
 *
 * Models go into the opaque mesh — the texels they use are opaque, and the
 * chunk shader alpha-tests the rest — with a real normal per face and the
 * block's glow in each vertex's fourth normal byte, so a torch is drawn
 * full-bright. They sit entirely inside their voxel.
 *
 * GreedyMesher skips model blocks and calls emitModel for each one; model
 * blocks never hide a neighbour's face (they are see-through).
 */

// Each box: from/to in sixteenths; uv rectangles [x, y, w, h] in pixels of the
// texture sheet for its sides, top and bottom (null = not drawn, because it is
// hidden against another box or the block it hangs from).
const TORCH_STICK = {
    from: [-1, 0, -1], to: [1, 10, 1],
    side: [7, 6, 2, 10], top: [7, 6, 2, 2], bottom: [7, 14, 2, 2],
};

// Lantern sheet regions (see the texture generator's notes in Lantern.png):
// body side 0,2 6×7 · body top 0,9 6×6 · cap side 6,0 4×2 · cap top 6,2 4×4 ·
// chain 11,0 1×6.
const lanternBoxes = (y) => [
    { from: [5, y, 5], to: [11, y + 7, 11], side: [0, 2, 6, 7], top: [0, 9, 6, 6], bottom: [0, 9, 6, 6] },
    { from: [6, y + 7, 6], to: [10, y + 9, 10], side: [6, 0, 4, 2], top: [6, 2, 4, 4], bottom: null },
];

// How far a wall torch leans away from the wall, and where its foot is (block
// units, in the frame where the wall is the -X side of the voxel).
const WALL_TILT = 22.5 * Math.PI / 180;
const WALL_FOOT = [0.07, 0.2];

const MODELS = {
    torch: {
        boxes: [{ ...TORCH_STICK, from: [7, 0, 7], to: [9, 10, 9] }],
    },
    // Built centred on the origin, then tilted and moved to the wall (xf).
    wall_torch: {
        boxes: [TORCH_STICK],
        tilt: true,
    },
    lantern: {
        boxes: lanternBoxes(0),
    },
    hanging_lantern: {
        boxes: [
            ...lanternBoxes(1),
            { from: [7.5, 10, 7.5], to: [8.5, 16, 8.5], side: [11, 0, 1, 6], top: null, bottom: null },
        ],
    },
};

// Turn about the voxel's vertical centre line so +X leans toward `facing`.
const FACING_ANGLE = { east: 0, west: Math.PI, south: -Math.PI / 2, north: Math.PI / 2 };

// Keeps texture lookups off the edge of each rectangle, so nearest filtering
// never picks up the neighbouring (transparent) texel.
const UV_INSET = 0.02;

// Scratch
const _p = new Float64Array(3);
const _n = new Float64Array(3);
const _corners = new Float64Array(12);

/**
 * The transform of one block's model: rotate by matrix m (row-major 3×3), then
 * translate by t — in block units, within the voxel.
 */
function transformFor(def) {
    const spec = MODELS[def.model];
    const phi = FACING_ANGLE[def.facing] ?? 0;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    // Ry(phi): x' = x cos + z sin, z' = -x sin + z cos — about the voxel centre.
    const ry = [cp, 0, sp, 0, 1, 0, -sp, 0, cp];
    if (!spec.tilt) {
        return { m: ry, t: [0.5 - (cp * 0.5 + sp * 0.5), 0, 0.5 - (-sp * 0.5 + cp * 0.5)] };
    }
    // Tilt about Z so the top leans toward +X: Rz(-a).
    const ca = Math.cos(-WALL_TILT), sa = Math.sin(-WALL_TILT);
    const rz = [ca, -sa, 0, sa, ca, 0, 0, 0, 1];
    // Then the foot goes to WALL_FOOT (centred in z), then the whole thing turns
    // about the voxel centre.
    const m = mul3(ry, rz);
    const foot = [WALL_FOOT[0] - 0.5, WALL_FOOT[1], 0];
    const tf = apply3(ry, foot);
    return { m, t: [tf[0] + 0.5, tf[1], tf[2] + 0.5] };
}

function mul3(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
    return o;
}
function apply3(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

// Transforms are per (model, facing); a chunk full of wall torches builds four.
const _xfCache = new Map();
function cachedTransform(def) {
    const key = def.model + ':' + (def.facing ?? '');
    let xf = _xfCache.get(key);
    if (!xf) { xf = transformFor(def); _xfCache.set(key, xf); }
    return xf;
}

/** Whether a model name is known. */
export function isModel(name) { return !!MODELS[name]; }

/**
 * Append block `id`'s model at chunk-local voxel (lx, ly, lz) to `sink`.
 *
 * @param {object} sink    GreedyMesher output buffers { pos, col, uv, lay, nrm, idx }
 * @param {object} tables  { layer, color: [r,g,b], glow } for this block id
 * @param {object} def     the block definition: { model, facing }
 */
export function emitModel(sink, lx, ly, lz, def, tables) {
    const spec = MODELS[def.model];
    if (!spec) return;
    const xf = cachedTransform(def);
    for (const box of spec.boxes) emitBox(sink, lx, ly, lz, box, xf, tables);
}

// The six faces: outward normal, the four corners (as 0/1 picks of from/to per
// axis, counter-clockwise seen from outside, starting bottom-left) and which uv
// rectangle it uses. "Bottom-left" is the lower corner on the viewer's left.
const FACES = [
    { n: [ 1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: 'side' },
    { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: 'side' },
    { n: [ 0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: 'side' },
    { n: [ 0, 0,-1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: 'side' },
    { n: [ 0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: 'top' },
    { n: [ 0,-1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: 'bottom' },
];

function emitBox(sink, lx, ly, lz, box, xf, tables) {
    const m = xf.m, t = xf.t;
    const { layer, color, glow } = tables;
    // Textured: no colour of its own, and no blending (MeshFormat.js).
    const r = layer >= 0 ? 0 : color[0], g = layer >= 0 ? 0 : color[1], b = layer >= 0 ? 0 : color[2];
    for (const f of FACES) {
        const rect = box[f.uv];
        if (!rect) continue;
        // Corners in block units, transformed into the voxel.
        for (let k = 0; k < 4; k++) {
            const pick = f.c[k];
            _p[0] = (pick[0] ? box.to[0] : box.from[0]) / 16;
            _p[1] = (pick[1] ? box.to[1] : box.from[1]) / 16;
            _p[2] = (pick[2] ? box.to[2] : box.from[2]) / 16;
            _corners[k * 3]     = m[0] * _p[0] + m[1] * _p[1] + m[2] * _p[2] + t[0];
            _corners[k * 3 + 1] = m[3] * _p[0] + m[4] * _p[1] + m[5] * _p[2] + t[1];
            _corners[k * 3 + 2] = m[6] * _p[0] + m[7] * _p[1] + m[8] * _p[2] + t[2];
        }
        _n[0] = m[0] * f.n[0] + m[1] * f.n[1] + m[2] * f.n[2];
        _n[1] = m[3] * f.n[0] + m[4] * f.n[1] + m[5] * f.n[2];
        _n[2] = m[6] * f.n[0] + m[7] * f.n[1] + m[8] * f.n[2];
        const nx = Math.round(_n[0] * 127), ny = Math.round(_n[1] * 127), nz = Math.round(_n[2] * 127);

        // Texture rectangle: x right, y down in the image; v = 0 is its bottom row.
        const u0 = (rect[0] + UV_INSET) / 16, u1 = (rect[0] + rect[2] - UV_INSET) / 16;
        const v0 = 1 - (rect[1] + rect[3] - UV_INSET) / 16, v1 = 1 - (rect[1] + UV_INSET) / 16;

        const base = (sink.pos.n / 3) | 0;
        for (let k = 0; k < 4; k++) {
            sink.pos.push3(lx + _corners[k * 3], ly + _corners[k * 3 + 1], lz + _corners[k * 3 + 2]);
            sink.col.push3(r, g, b);
            sink.lay.push1(layer);
            sink.nrm.push4(nx, ny, nz, glow);
            sink.uv.push2(k === 0 || k === 3 ? u0 : u1, k < 2 ? v0 : v1);
        }
        sink.idx.push6(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}
