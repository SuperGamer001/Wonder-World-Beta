/**
 * FarTiles — the meshes of far terrain, built in the worker.
 *
 * A far tile is a square of the world `cells × step` blocks wide, drawn as a
 * heightfield: one vertex every `step` blocks at the surface the chunk there
 * would have (the generator's farSample — land, or the water on it), coloured
 * like that surface from far off. No voxels are made: it is the geography
 * sampled directly — the current generator does the whole lattice in one pass
 * (farGrid), 35–50 ms for a 64-cell tile on a laptop — so a tile costs the same
 * however far away it is, and its detail is chosen by its step (FarTerrain.js
 * on the render thread picks the tiles).
 *
 * On that ground stand the things the chunks there have:
 *
 *   • Trees, cacti, huge mushrooms, boulders and houses, each where the chunk
 *     will have it (the generator's farFeatures: the structure placer's own
 *     cells and its own rule), in the tiles of FEATURE_STEPS, the two finest.
 *     In the finest a plant is a crown — a box narrowing toward its top, or
 *     a pyramid for a conifer — on a trunk, where it stands apart. A wood has
 *     a tree every few blocks, and that is where the triangles would go, so
 *     there the trunks are left out (the crowns hide them) and every other
 *     tree, the rest drawn a little bigger to close the gaps: it reads as
 *     the same wood. In the next step out everything is a pyramid, and one
 *     in two (one in four in a wood). Further out still a forest is its
 *     canopy: the ground raised and tinted (farGrid with the canopy), as all
 *     of far terrain used to be.
 *   • What the player has built or dug (`edits`): for a chunk that has been
 *     changed, the surface it really has — its highest block in each column
 *     and that block's colour, summarised by world.js when the chunk is saved
 *     or unloaded — replaces the generated one, trees and all.
 *
 * Nothing under the surface is here at all: no caves, no overhangs. A column
 * is its top.
 *
 * Normals come from one sample beyond each edge, so neighbouring tiles of the
 * same step shade their shared edge identically. A tile next to a coarser one
 * samples its edge twice as often, which can leave hairline cracks between
 * them; each edge carries a skirt — a strip hanging down from it — that fills
 * any such gap from every side.
 *
 * A vertex has two spare bytes (the normal's fourth and the colour's alpha),
 * and they say where the thing it belongs to stands: the offset from the
 * vertex to its foot, in sixteenths of a block. The far shader asks whether
 * the chunk *there* is on screen, so a whole tree gives way to the real one at
 * once instead of being cut where its crown crosses a chunk border.
 */

export const FAR_CELLS = 64;   // cells per tile side

/** Tile steps (blocks per cell) at which plants and buildings are drawn as shapes. */
export const FEATURE_STEPS = [4, 8];
// Of the plants in a tile, one in THIN is drawn, GROW times as wide to cover
// the ground the others stood on: [standing apart, in a wood] for each step.
const THIN = { 4: [1, 2], 8: [2, 4] };
const GROW = { 4: [1, 1.3], 8: [1.3, 1.8] };

/** Height stored for a column with nothing in it (FarEdits, world.js). */
export const EDIT_EMPTY = -32768;

const _s = { h: 0, r: 0, g: 0, b: 0 };
let _H = null, _rgb = null;     // lattice scratch, reused across tiles of one size

/**
 * Heights over the (n+2)² lattice around a tile (one point beyond each edge),
 * and colours: from gen.farGrid in one pass where the generator has it, else
 * sample by sample.
 */
function sampleLattice(gen, x0, z0, step, m, canopy) {
    if (!_H || _H.length !== m * m) { _H = new Float32Array(m * m); _rgb = new Float32Array(m * m * 3); }
    if (gen.farGrid) {
        gen.farGrid(x0 - step, z0 - step, step, m, _H, _rgb, canopy);
        return;
    }
    const n = m - 2;
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) {
            const inner = i >= 1 && i <= n && j >= 1 && j <= n;
            gen.farSample(x0 + (i - 1) * step, z0 + (j - 1) * step, inner, _s);
            const o = i * m + j;
            _H[o] = _s.h;
            if (inner) { _rgb[o * 3] = _s.r; _rgb[o * 3 + 1] = _s.g; _rgb[o * 3 + 2] = _s.b; }
        }
    }
}

/**
 * Lay the changed chunks' real surfaces over the lattice. `edits`:
 * [{ cx, cz, heights: Int16Array(256), ids: Uint16Array(256) }] with a
 * column's entry at lx + lz·16: the world Y of its highest block (EDIT_EMPTY
 * for none) and that block's id.
 */
function applyEdits(gen, edits, gx0, gz0, step, m) {
    for (const e of edits) {
        const ex = e.cx * 16, ez = e.cz * 16;
        const i0 = Math.max(0, Math.ceil((ex - gx0) / step)), i1 = Math.min(m - 1, Math.floor((ex + 15 - gx0) / step));
        const j0 = Math.max(0, Math.ceil((ez - gz0) / step)), j1 = Math.min(m - 1, Math.floor((ez + 15 - gz0) / step));
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const k = (gx0 + i * step - ex) + (gz0 + j * step - ez) * 16;
                const h = e.heights[k];
                if (h === EDIT_EMPTY) continue;
                const o = i * m + j;
                _H[o] = h + 1;
                gen.farColor(e.ids[k], _s);
                _rgb[o * 3] = _s.r; _rgb[o * 3 + 1] = _s.g; _rgb[o * 3 + 2] = _s.b;
            }
        }
    }
}

// ── Shapes ───────────────────────────────────────────────────────────────────
// What stands on the ground is drawn from three solids, each given as points
// (x and z in half-widths, y 0 at the bottom and 1 at the top) and faces:
//   BOX      a box narrowing toward its top: four sides and the top
//   PYRAMID  four sides up to a point
//   STEM     a three-sided post, open at both ends (a trunk under a crown)
// The normals lean outward and, at the top, upward, so a crown is shaded as
// something rounded rather than as a crate.
function solid(points, faces) {
    const tris = [];
    for (const f of faces) {
        const [a, b, c] = [points[f[0]], points[f[1]], points[f[2]]];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        // The middle of the face, seen from the solid's own middle, is the way out.
        const mid = [0, 1, 2].map(d => f.reduce((s, v) => s + points[v][d], 0) / f.length - (d === 1 ? 0.5 : 0));
        const o = n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] > 0 ? f : [...f].reverse();
        for (let k = 2; k < o.length; k++) tris.push(o[0], o[k - 1], o[k]);
    }
    return { points, tris };
}
const RING = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const BOX = solid([...RING.map(([x, z]) => [x, 0, z]), ...RING.map(([x, z]) => [x, 1, z])],
                  [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]]);
const PYRAMID = solid([...RING.map(([x, z]) => [x, 0, z]), [0, 1, 0]],
                      [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]);
const TRI = [0, 1, 2].map(k => [Math.cos(k * 2.0944 + 0.5) * 1.2, Math.sin(k * 2.0944 + 0.5) * 1.2]);
const STEM = solid([...TRI.map(([x, z]) => [x, 0, z]), ...TRI.map(([x, z]) => [x, 1, z])],
                   [[0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]]);
const SOLIDS = [BOX, PYRAMID, STEM];

/** Offset to a foot, in sixteenths of a block, as the two spare bytes hold it. */
const foot8 = (d) => Math.max(-127, Math.min(127, Math.round(d * 16)));

/**
 * @param gen   a generator with farSample(x, z, wantColor, out), and
 *              optionally farGrid / farFeatures / farColor (the current one)
 * @param edits changed chunks' surfaces, see applyEdits — those overlapping
 *              the tile and the ring of samples round it
 * @returns { positions: Float32Array (x, y, z relative to the tile corner),
 *            colors: Uint8Array (rgb, and the foot's z offset),
 *            normals: Int8Array (xyz, and the foot's x offset),
 *            indices: Uint16Array or Uint32Array, yMin, yMax, features }
 */
export function buildFarTile(gen, x0, z0, step, cells = FAR_CELLS, edits = null) {
    const n = cells + 1;            // vertices per side
    const m = n + 2;                // samples per side, with a ring for normals
    const shapes = !!gen.farFeatures && FEATURE_STEPS.includes(step);
    sampleLattice(gen, x0, z0, step, m, !shapes);

    // Plants and buildings, before anything else disturbs the generator's
    // lattice: [x, y, z (the foot, tile-relative), x0, y0, z0, x1, y1, z1,
    // taper, r, g, b, solid] each.
    const boxes = [];
    let shapeVerts = 0, shapeIdx = 0;
    if (shapes) {
        const size = cells * step;
        const near = step === FEATURE_STEPS[0];
        const changed = edits?.length ? new Set(edits.map(e => e.cx + ',' + e.cz)) : null;
        const skip = changed ? (x, z) => changed.has((x >> 4) + ',' + (z >> 4)) : null;
        gen.farFeatures(x0, z0, size, (x, y, z, proxy, h, dense) => {
            // No two trees quite the same green.
            const k = 0.9 + ((h >>> 20) & 15) / 75;
            const building = proxy.length > 1 && proxy[1][7] < 0;
            const w = dense ? 1 : 0, grow = GROW[step][w];
            if (!building && ((h >>> 9) & 0xff) % THIN[step][w] !== 0) return;
            for (const b of proxy) {
                const stem = b[8] === 1;
                // Trunks: only up close, and only where they can be seen.
                if (stem && (!near || dense)) continue;
                // A crown that comes nearly to a point is a pyramid anyway.
                const kind = stem ? 2 : building || (near && b[7] > 0.25) ? 0 : 1;
                const g = building || stem ? 1 : grow, mx = (b[0] + b[3]) / 2, mz = (b[2] + b[5]) / 2;
                gen.farColor(b[6], _s, stem ? 0.75 : k);
                boxes.push(x - x0, y, z - z0,
                           mx + (b[0] - mx) * g, b[1], mz + (b[2] - mz) * g, mx + (b[3] - mx) * g, b[1] + (b[4] - b[1]) * (g > 1 ? 1.2 : 1), mz + (b[5] - mz) * g,
                           b[7], _s.r, _s.g, _s.b, kind);
                shapeVerts += SOLIDS[kind].points.length;
                shapeIdx += SOLIDS[kind].tris.length;
            }
        }, 1, skip);
    }
    if (edits?.length && gen.farColor) applyEdits(gen, edits, x0 - step, z0 - step, step, m);

    const H = _H, rgb = _rgb;
    const nBoxes = boxes.length / 14;
    const ground = n * n + 4 * n;   // the surface, then a skirt vertex under each edge vertex
    const vCount = ground + shapeVerts;
    const positions = new Float32Array(vCount * 3);
    const colors = new Uint8Array(vCount * 4);
    const normals = new Int8Array(vCount * 4);
    const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const v = i * n + j, o = ((i + 1) * m + (j + 1)) * 3;
            colors[v * 4]     = byte(rgb[o]);
            colors[v * 4 + 1] = byte(rgb[o + 1]);
            colors[v * 4 + 2] = byte(rgb[o + 2]);
            colors[v * 4 + 3] = 128;            // its own foot
        }
    }

    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const v = i * n + j, s = (i + 1) * m + (j + 1);
            const h = H[s];
            positions[v * 3] = i * step;
            positions[v * 3 + 1] = h;
            positions[v * 3 + 2] = j * step;
            if (h < yMin) yMin = h;
            if (h > yMax) yMax = h;
            const dx = (H[s + m] - H[s - m]) / (2 * step), dz = (H[s + 1] - H[s - 1]) / (2 * step);
            const len = Math.sqrt(dx * dx + 1 + dz * dz);
            normals[v * 4]     = Math.round(-dx / len * 127);
            normals[v * 4 + 1] = Math.round(1 / len * 127);
            normals[v * 4 + 2] = Math.round(-dz / len * 127);
        }
    }

    // Skirts: under each edge vertex, a copy lowered far enough to meet a
    // coarser neighbour's edge wherever it lies.
    const drop = step * 1.5 + 4;
    const edge = [];                // surface vertex of each skirt vertex, in order
    for (let k = 0; k < n; k++) edge.push(k);                       // i = 0 (−x)
    for (let k = 0; k < n; k++) edge.push((n - 1) * n + k);         // i = n−1 (+x)
    for (let k = 0; k < n; k++) edge.push(k * n);                   // j = 0 (−z)
    for (let k = 0; k < n; k++) edge.push(k * n + (n - 1));         // j = n−1 (+z)
    for (let e = 0; e < edge.length; e++) {
        const src = edge[e], v = n * n + e;
        positions[v * 3] = positions[src * 3];
        positions[v * 3 + 1] = positions[src * 3 + 1] - drop;
        positions[v * 3 + 2] = positions[src * 3 + 2];
        for (let c = 0; c < 4; c++) { colors[v * 4 + c] = colors[src * 4 + c]; normals[v * 4 + c] = normals[src * 4 + c]; }
    }
    yMin -= drop;

    // Two triangles per cell, counter-clockwise from above (the material culls
    // back faces). A gap beside a skirt can be seen from either side, so each
    // skirt quad goes in twice, once facing each way.
    const groundIdx = cells * cells * 6 + 4 * cells * 12;
    const iCount = groundIdx + shapeIdx;
    const indices = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let p = 0;
    for (let i = 0; i < cells; i++) {
        for (let j = 0; j < cells; j++) {
            const a = i * n + j, b = a + 1, c = a + n + 1, d = a + n;
            indices[p++] = a; indices[p++] = b; indices[p++] = c;
            indices[p++] = a; indices[p++] = c; indices[p++] = d;
        }
    }
    for (let side = 0; side < 4; side++) {
        for (let k = 0; k < cells; k++) {
            const e = side * n + k;
            const t0 = edge[e], t1 = edge[e + 1], s0 = n * n + e, s1 = s0 + 1;
            indices[p++] = t0; indices[p++] = t1; indices[p++] = s1;
            indices[p++] = t0; indices[p++] = s1; indices[p++] = s0;
            indices[p++] = t0; indices[p++] = s1; indices[p++] = t1;
            indices[p++] = t0; indices[p++] = s0; indices[p++] = s1;
        }
    }

    // The shapes.
    let base = ground;
    for (let q = 0; q < nBoxes; q++) {
        const o = q * 14, S = SOLIDS[boxes[o + 13]];
        const fx = boxes[o], fy = boxes[o + 1], fz = boxes[o + 2];
        const cx = fx + (boxes[o + 3] + boxes[o + 6]) / 2, cz = fz + (boxes[o + 5] + boxes[o + 8]) / 2;
        const hx = (boxes[o + 6] - boxes[o + 3]) / 2, hz = (boxes[o + 8] - boxes[o + 5]) / 2;
        const y0 = fy + boxes[o + 4], y1 = fy + boxes[o + 7];
        // A taper below zero draws in along x only: a roof to its ridge.
        const taper = boxes[o + 9], tx = Math.abs(taper), tz = taper < 0 ? 1 : taper;
        const r = byte(boxes[o + 10]), g = byte(boxes[o + 11]), b = byte(boxes[o + 12]);
        for (let v = 0; v < S.points.length; v++) {
            const pt = S.points[v], top = pt[1] > 0.5;
            const x = cx + pt[0] * hx * (top ? tx : 1), z = cz + pt[2] * hz * (top ? tz : 1);
            const i = (base + v) * 3, k = (base + v) * 4;
            positions[i] = x; positions[i + 1] = top ? y1 : y0; positions[i + 2] = z;
            const ny = top ? 0.85 : 0.3, len = Math.sqrt(pt[0] * pt[0] + pt[2] * pt[2] + ny * ny);
            normals[k] = Math.round(pt[0] / len * 127); normals[k + 1] = Math.round(ny / len * 127); normals[k + 2] = Math.round(pt[2] / len * 127);
            // Its foot: the middle of the block it is rooted on.
            normals[k + 3] = foot8(fx + 0.5 - x);
            colors[k] = r; colors[k + 1] = g; colors[k + 2] = b;
            colors[k + 3] = 128 + foot8(fz + 0.5 - z);
        }
        for (let t = 0; t < S.tris.length; t++) indices[p++] = base + S.tris[t];
        base += S.points.length;
        if (y1 > yMax) yMax = y1;
    }

    return { positions, colors, normals, indices, yMin, yMax, features: nBoxes };
}
