/**
 * BlockModels — draws the blocks that are not cubes: torches and lanterns,
 * slabs, stairs, fences, doors, furniture, plants. What each is made of is in
 * engine/BlockShapes.js, which the collision and the crosshair go by too; this
 * turns those boxes and planes into triangles.
 *
 * A box's face shows the block's texture for the way it faces (top, side,
 * bottom, or the one its `mat` names), laid over the voxel: the face shows the
 * part of the texture it covers, so the planks of a stair line up with the
 * planks of the block beside it. (The torch and the lantern pick rectangles of
 * a 16-pixel sheet instead, as they always have: `uv`.) A `cross` is a plant:
 * two upright planes, seen from both sides, each the whole texture.
 *
 * A model is built facing east and turned to the block's `facing`; the wall
 * torch also leans away from its wall.
 *
 * Models go into the opaque mesh — the texels they use are opaque, and the
 * chunk shader alpha-tests the rest — with a real normal per face and the
 * block's glow in each vertex's fourth normal byte, so a torch is drawn
 * full-bright.
 *
 * GreedyMesher skips model blocks and calls emitModel for each one; model
 * blocks never hide a neighbour's face (they are see-through).
 */

export { isModel } from '../engine/BlockShapes.js';

// How far a wall torch leans away from the wall, and where its foot is (block
// units, in the frame where the wall is the -X side of the voxel).
const WALL_TILT = 22.5 * Math.PI / 180;
const WALL_FOOT = [0.07, 0.2];

// Keeps texture lookups off the edge of each rectangle, so nearest filtering
// never picks up the neighbouring (transparent) texel.
const UV_INSET = 0.02;

// Scratch
const _p = new Float64Array(3);
const _n = new Float64Array(3);
const _corners = new Float64Array(12);
const _uv = new Float64Array(8);

/**
 * The transform of one block's model: rotate by matrix m (row-major 3×3), then
 * translate by t — in block units, within the voxel.
 */
function transformFor(shape) {
    const cp = shape.cos, sp = shape.sin;
    // Ry(phi): x' = x cos + z sin, z' = -x sin + z cos — about the voxel centre.
    const ry = [cp, 0, sp, 0, 1, 0, -sp, 0, cp];
    if (!shape.tilt) {
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

/**
 * Append a block's model at chunk-local voxel (lx, ly, lz) to `sink`.
 *
 * @param {object} sink    GreedyMesher output buffers { pos, col, uv, lay, nrm, idx }
 * @param {object} shape   the block's compiled shape (BlockShapes.compileShape)
 * @param {object} tables  { top, side, bottom: texture layers (−1: none), color: [r,g,b], glow } for this block id
 * @param {number} conn    how its neighbours change it (BlockShapes connCode: for a fence, which sides it joins on); 0 for anything else
 * @param {number} lift    blocks to raise it by (a plant on smooth ground stands on the surface: ≤ 0)
 */
export function emitModel(sink, lx, ly, lz, shape, tables, conn = 0, lift = 0) {
    const xf = shape._xf ?? (shape._xf = transformFor(shape));
    let els = shape.els;
    if (typeof els === 'function') {
        const cache = shape._elsBy ?? (shape._elsBy = []);
        els = cache[conn] ?? (cache[conn] = els(conn));
    }
    for (const el of els) {
        if (el.cross) emitCross(sink, lx, ly + lift, lz, el, xf, tables);
        else emitBox(sink, lx, ly + lift, lz, el, xf, tables);
    }
}

// The six faces: its letter, outward normal, the four corners (as 0/1 picks
// of from/to per axis, counter-clockwise seen from outside, starting
// bottom-left), which uv rectangle of a sheet it uses, which of the block's
// textures it shows, and which two axes run across it (for a texture laid over
// the voxel). "Bottom-left" is the lower corner on the viewer's left.
const FACES = [
    { k: 'e', n: [ 1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: 'side',   mat: 'side',   a: 2, b: 1 },
    { k: 'w', n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: 'side',   mat: 'side',   a: 2, b: 1 },
    { k: 's', n: [ 0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: 'side',   mat: 'side',   a: 0, b: 1 },
    { k: 'n', n: [ 0, 0,-1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: 'side',   mat: 'side',   a: 0, b: 1 },
    { k: 'u', n: [ 0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], uv: 'top',    mat: 'top',    a: 2, b: 0 },
    { k: 'd', n: [ 0,-1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], uv: 'bottom', mat: 'bottom', a: 2, b: 0 },
];

function emitBox(sink, lx, ly, lz, box, xf, tables) {
    const m = xf.m, t = xf.t;
    const color = tables.color;
    const glow = box.glow === false ? 0 : tables.glow;
    const sheet = box.uv ?? null;
    for (const f of FACES) {
        if (box.only && !box.only.includes(f.k)) continue;
        const rect = sheet ? sheet[f.uv] : null;
        if (sheet && !rect) continue;
        const mat = typeof box.mat === 'string' ? box.mat : (box.mat?.[f.k] ?? f.mat);
        const layer = tables[mat];
        // Textured: no colour of its own, and no blending (MeshFormat.js).
        const r = layer >= 0 ? 0 : color[0], g = layer >= 0 ? 0 : color[1], b = layer >= 0 ? 0 : color[2];

        // Corners in block units, transformed into the voxel.
        for (let k = 0; k < 4; k++) {
            const pick = f.c[k];
            _p[0] = (pick[0] ? box.to[0] : box.from[0]) / 16;
            _p[1] = (pick[1] ? box.to[1] : box.from[1]) / 16;
            _p[2] = (pick[2] ? box.to[2] : box.from[2]) / 16;
            // A texture laid over the voxel: the corner's own place across the face.
            _uv[k * 2] = _p[f.a]; _uv[k * 2 + 1] = _p[f.b];
            _corners[k * 3]     = m[0] * _p[0] + m[1] * _p[1] + m[2] * _p[2] + t[0];
            _corners[k * 3 + 1] = m[3] * _p[0] + m[4] * _p[1] + m[5] * _p[2] + t[1];
            _corners[k * 3 + 2] = m[6] * _p[0] + m[7] * _p[1] + m[8] * _p[2] + t[2];
        }
        _n[0] = m[0] * f.n[0] + m[1] * f.n[1] + m[2] * f.n[2];
        _n[1] = m[3] * f.n[0] + m[4] * f.n[1] + m[5] * f.n[2];
        _n[2] = m[6] * f.n[0] + m[7] * f.n[1] + m[8] * f.n[2];
        const nx = Math.round(_n[0] * 127), ny = Math.round(_n[1] * 127), nz = Math.round(_n[2] * 127);

        // The texture turned round (a door hung on its other side), or only a part of it shown, scaled up (a piece of a painting).
        if (box.flip) for (let k = 0; k < 4; k++) _uv[k * 2] = 1 - _uv[k * 2];
        const uvt = box.uvt;
        if (uvt) for (let k = 0; k < 4; k++) { _uv[k * 2] = uvt[1] + _uv[k * 2] * uvt[0]; _uv[k * 2 + 1] = uvt[2] + _uv[k * 2 + 1] * uvt[0]; }

        if (rect) {
            // Texture rectangle: x right, y down in the image; v = 0 is its bottom row.
            const u0 = (rect[0] + UV_INSET) / 16, u1 = (rect[0] + rect[2] - UV_INSET) / 16;
            const v0 = 1 - (rect[1] + rect[3] - UV_INSET) / 16, v1 = 1 - (rect[1] + UV_INSET) / 16;
            for (let k = 0; k < 4; k++) { _uv[k * 2] = k === 0 || k === 3 ? u0 : u1; _uv[k * 2 + 1] = k < 2 ? v0 : v1; }
        }

        const base = (sink.pos.n / 3) | 0;
        for (let k = 0; k < 4; k++) {
            sink.pos.push3(lx + _corners[k * 3], ly + _corners[k * 3 + 1], lz + _corners[k * 3 + 2]);
            sink.col.push3(r, g, b);
            sink.lay.push1(layer);
            sink.nrm.push4(nx, ny, nz, glow);
            sink.uv.push2(_uv[k * 2], _uv[k * 2 + 1]);
        }
        sink.idx.push6(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

// A plant: the two diagonals of its box, each a plane seen from both sides.
// Lit as the ground it stands on is (a normal pointing up), so neither side
// of a leaf is ever the dark one.
function emitCross(sink, lx, ly, lz, el, xf, tables) {
    const m = xf.m, t = xf.t, c = el.cross;
    const layer = tables[el.mat ?? 'top'];
    const color = tables.color;
    const r = layer >= 0 ? 0 : color[0], g = layer >= 0 ? 0 : color[1], b = layer >= 0 ? 0 : color[2];
    const glow = el.glow === false ? 0 : tables.glow;
    const y0 = c[1] / 16, y1 = c[4] / 16;
    for (let d = 0; d < 2; d++) {
        const ax = c[0] / 16, bx = c[3] / 16;
        const az = (d ? c[5] : c[2]) / 16, bz = (d ? c[2] : c[5]) / 16;
        const X = [ax, bx, bx, ax], Y = [y0, y0, y1, y1], Z = [az, bz, bz, az];
        const base = (sink.pos.n / 3) | 0;
        for (let k = 0; k < 4; k++) {
            sink.pos.push3(lx + m[0] * X[k] + m[2] * Z[k] + t[0], ly + Y[k] + t[1], lz + m[6] * X[k] + m[8] * Z[k] + t[2]);
            sink.col.push3(r, g, b);
            sink.lay.push1(layer);
            sink.nrm.push4(0, 127, 0, glow);
            sink.uv.push2(k === 0 || k === 3 ? UV_INSET / 16 : 1 - UV_INSET / 16, k < 2 ? UV_INSET / 16 : 1 - UV_INSET / 16);
        }
        sink.idx.push6(base, base + 1, base + 2, base, base + 2, base + 3);
        sink.idx.push6(base, base + 2, base + 1, base, base + 3, base + 2);
    }
}
