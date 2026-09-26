// Smooth-terrain invariants: voxel bounds, watertightness (including across
// chunk edges and corners), collision matching the rendered surface, the
// Mesh/Solid interaction rules, and the shape of the smoothing itself.
import { GreedyMesher }  from '../src/scripts/workers/GreedyMesher.js';
import { SmoothMesher }  from '../src/scripts/workers/SmoothMesher.js';
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { WorldState }    from '../src/scripts/engine/WorldState.js';
import { PlayerPhysics } from '../src/scripts/engine/PlayerPhysics.js';
import {
    ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME, WORLD_MIN_Y, voxelIndex,
} from '../src/scripts/engine/ChunkData.js';
import {
    SmoothTerrain, SmoothField, buildKindTable, describeVoxel, newShape, surfaceGrid, gridHeightAt,
    KIND_CUBE, KIND_MESH, SMOOTH_REACH, SMOOTH_SAMPLES,
} from '../src/scripts/engine/SmoothShape.js';

const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, WATER = 5, GLASS = 28, BRICKS = 27;

const reg = new BlockRegistry();
reg.register({ id: AIR,    name: 'AIR',    terrainType: 'solid', transparent: true, noCollision: true });
reg.register({ id: GRASS,  name: 'GRASS',  terrainType: 'mesh' });
reg.register({ id: DIRT,   name: 'DIRT',   terrainType: 'mesh' });
reg.register({ id: STONE,  name: 'STONE',  terrainType: 'mesh' });
reg.register({ id: WATER,  name: 'WATER',  terrainType: 'solid', transparent: true, liquid: true, noCollision: true });
reg.register({ id: BRICKS, name: 'BRICKS', terrainType: 'solid' });
reg.register({ id: GLASS,  name: 'GLASS',  terrainType: 'solid', transparent: true });

const faceMap = { 1: { top: 1, side: 2, bottom: 0 }, 2: { top: 0, side: 0, bottom: 0 } };
const greedy  = new GreedyMesher(reg, faceMap);
const smooth  = new SmoothMesher(reg, greedy);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
}

// Deterministic PRNG so failures reproduce.
let _seed = 12345;
function rand() {
    _seed = (_seed * 1664525 + 1013904223) >>> 0;
    return _seed / 4294967296;
}

// ── World construction ───────────────────────────────────────────────────────

const BASE_Y = 100;   // local Y of the island's underside

/** Floating island over a 2×2 block of chunks, crossing the shared corner. */
function islandBlock(x, y, z) {
    const dx = x - 16, dz = z - 16;
    const r  = Math.sqrt(dx * dx + dz * dz);
    if (r > 11) return AIR;
    // Steps along x = 16 and z = 16 put slopes right on the chunk seams and on
    // the shared corner, where the diagonal chunk's column decides the shape.
    const top = BASE_Y + 2 + Math.round(3 * Math.sin(x * 0.7) * Math.cos(z * 0.5) + (11 - r) * 0.5)
              + (x < 16 ? 1 : 0) + (z < 16 ? 1 : 0);
    if (y < BASE_Y || y > top) {
        // A little pond on top, and a floating fragment above.
        if (y === top + 1 && r > 4 && r < 6) return WATER;
        if (y === top + 4 && Math.abs(dx - 3) <= 1 && Math.abs(dz + 2) <= 1) return DIRT;
        return AIR;
    }
    if (y === top) {
        if (Math.abs(dx - 5) <= 0 && Math.abs(dz) <= 1) return BRICKS;   // Solid in the surface
        if (dx === -4 && dz === 3) return GLASS;
        return GRASS;
    }
    if (y >= top - 2) return DIRT;
    return STONE;
}

function makeChunk(cx, cz, fn) {
    const v = new Uint16Array(CHUNK_VOLUME);
    for (let lz = 0; lz < CHUNK_SIZE; lz++)
        for (let ly = BASE_Y - 2; ly < BASE_Y + 30; ly++)
            for (let lx = 0; lx < CHUNK_SIZE; lx++)
                v[voxelIndex(lx, ly, lz)] = fn(cx * CHUNK_SIZE + lx, ly, cz * CHUNK_SIZE + lz);
    return v;
}

function filledRange(v) {
    let min = CHUNK_SIZE_Y, max = -1;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) {
        const ly = ((i / CHUNK_SIZE) | 0) % CHUNK_SIZE_Y;
        if (ly < min) min = ly;
        if (ly > max) max = ly;
    }
    return max < 0 ? { min: 0, max: 0 } : { min, max };
}

/** Same layout as ChunkData.cornerBlock. */
function cornerBlock(v, x0, z0) {
    const R = SMOOTH_REACH, out = new Uint16Array(R * R * CHUNK_SIZE_Y);
    for (let bz = 0; bz < R; bz++)
        for (let bx = 0; bx < R; bx++)
            for (let ly = 0; ly < CHUNK_SIZE_Y; ly++)
                out[(bx + bz * R) * CHUNK_SIZE_Y + ly] = v[voxelIndex(x0 + bx, ly, z0 + bz)];
    return out;
}

// Chunks -1..2 on both axes: the island's four plus a ring of empty ones, so
// every meshed chunk has real neighbours rather than the solid sentinel.
const chunks = new Map();
for (let cx = -1; cx <= 2; cx++)
    for (let cz = -1; cz <= 2; cz++)
        chunks.set(`${cx},${cz}`, makeChunk(cx, cz, islandBlock));

function meshChunk(cx, cz, faces = [0, 1, 2, 3, 4, 5]) {
    const v = chunks.get(`${cx},${cz}`);
    const nb = {
        '1,0':  chunks.get(`${cx + 1},${cz}`), '-1,0': chunks.get(`${cx - 1},${cz}`),
        '0,1':  chunks.get(`${cx},${cz + 1}`), '0,-1': chunks.get(`${cx},${cz - 1}`),
    };
    const corners = {};
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const c = chunks.get(`${cx + dx},${cz + dz}`);
        const far = CHUNK_SIZE - SMOOTH_REACH;
        if (c) corners[`${dx},${dz}`] = cornerBlock(c, dx > 0 ? 0 : far, dz > 0 ? 0 : far);
    }
    const yRange = filledRange(v);
    const ctx = smooth.prepare(v, nb, corners, yRange);
    return greedy.meshGroup(v, nb, faces, yRange, ctx);
}

/** Opaque triangles in world-block coordinates (local Y), as flat [x,y,z]*3 arrays. */
function soup(geo, ox, oz, out = []) {
    const p = geo.positions, idx = geo.indices;
    for (let i = 0; i < idx.length; i += 3) {
        const tri = [];
        for (let k = 0; k < 3; k++) {
            const j = idx[i + k] * 3;
            tri.push(p[j] + ox, p[j + 1], p[j + 2] + oz);
        }
        out.push(tri);
    }
    return out;
}

// Segment/triangle intersection (Möller–Trumbore); returns t in (0,1) or -1.
function segHit(o, d, tri) {
    const e1x = tri[3] - tri[0], e1y = tri[4] - tri[1], e1z = tri[5] - tri[2];
    const e2x = tri[6] - tri[0], e2y = tri[7] - tri[1], e2z = tri[8] - tri[2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) return -1;
    const inv = 1 / det;
    const tx = o[0] - tri[0], ty = o[1] - tri[1], tz = o[2] - tri[2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 0 && t < 1 ? t : -1;
}

// ── 1. Every smooth triangle stays inside one voxel ─────────────────────────

{
    let tris = 0, bad = 0;
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        // No greedy faces: the output is the smooth pass alone.
        const geo = meshChunk(cx, cz, []);
        for (const tri of soup(geo, 0, 0)) {
            tris++;
            const cxl = Math.floor((tri[0] + tri[3] + tri[6]) / 3);
            const cyl = Math.floor((tri[1] + tri[4] + tri[7]) / 3);
            const czl = Math.floor((tri[2] + tri[5] + tri[8]) / 3);
            for (let k = 0; k < 9; k += 3) {
                const e = 1e-9;
                if (tri[k]     < cxl - e || tri[k]     > cxl + 1 + e ||
                    tri[k + 1] < cyl - e || tri[k + 1] > cyl + 1 + e ||
                    tri[k + 2] < czl - e || tri[k + 2] > czl + 1 + e) { bad++; break; }
            }
        }
    }
    check('smooth triangles never leave their voxel', tris > 0 && bad === 0, `${tris} tris, ${bad} outside`);
}

// ── 2. Watertight across chunk edges and the shared corner ──────────────────

const allTris = [];
for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    soup(meshChunk(cx, cz), cx * CHUNK_SIZE, cz * CHUNK_SIZE, allTris);
}

{
    // Any segment between two points outside a closed surface crosses it an even
    // number of times. A hole or a crack along a seam shows up as odd.
    let odd = 0;
    const RAYS = 2400;
    for (let r = 0; r < RAYS; r++) {
        // A third of the rays are aimed at the shared chunk corner (16, 16).
        const focus = r % 3 === 0;
        const span = focus ? 4 : 40, off = focus ? 14 : -4;
        const a = [rand() * span + off, BASE_Y - 6, rand() * span + off];
        const b = [rand() * span + off, BASE_Y + 30, rand() * span + off];
        // Mix in horizontal rays, which cross the side walls and chunk seams.
        if (r % 3 === 1) { a[1] = BASE_Y + rand() * 14; b[1] = BASE_Y + rand() * 14; a[0] = -6; b[0] = 38; }
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let n = 0;
        for (const tri of allTris) if (segHit(a, d, tri) >= 0) n++;
        if (n % 2) odd++;
    }
    check('surface is closed across chunk seams and corners', odd === 0,
          `${odd} of ${RAYS} rays crossed an odd number of times (${allTris.length} tris)`);
}

// ── 3. Collision matches the rendered surface ───────────────────────────────

const world = new WorldState();
for (const [key, v] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    const c = new ChunkData(cx, cz);
    c.loadVoxels(v);
    c.generated = true;
    world.setChunk(cx, cz, c);
}
const terrain = new SmoothTerrain(world, reg);
const kindTable = buildKindTable(reg);

/**
 * Height (local Y) of the first surface the collider has in column (x, z),
 * scanning down from local Y `fromY`. Deformed Mesh voxels report the higher of
 * their two surfaces at that point, which is what a ray from above meets first
 * (the two coincide where a floating sheet thins to nothing at its rim).
 */
function colliderTop(x, z, fromY) {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let ly = fromY; ly > fromY - 60; ly--) {
        const wy = ly + WORLD_MIN_Y;
        const id = world.getBlock(bx, wy, bz);
        if (id === 0 || reg.isNoCollision(id)) continue;
        if (!terrain.isMesh(id)) return ly + 1;
        const sh = terrain.shapeAt(bx, wy, bz);
        if (!sh) return ly + 1;
        return ly + Math.max(gridHeightAt(sh.top, x - bx, z - bz), gridHeightAt(sh.bot, x - bx, z - bz));
    }
    return NaN;
}

{
    let samples = 0, mismatch = 0, worst = 0;
    for (let i = 0; i < 600; i++) {
        const x = 6 + rand() * 20, z = 6 + rand() * 20;
        const o = [x, BASE_Y + 40, z], d = [0, -60, 0];
        let best = -1;
        for (const tri of allTris) {
            const t = segHit(o, d, tri);
            if (t >= 0 && (best < 0 || t < best)) best = t;
        }
        if (best < 0) continue;
        const h = o[1] + d[1] * best;
        // Under a see-through Solid block (glass) the first *opaque* hit is the
        // ground beneath it, while the glass itself is rightly solid.
        const above = world.getBlock(Math.floor(x), Math.floor(h + 0.003 + WORLD_MIN_Y), Math.floor(z));
        if (above !== 0 && reg.isTransparent(above) && !reg.isNoCollision(above)) continue;
        samples++;
        const err = Math.abs(colliderTop(x, z, BASE_Y + 39) - h);
        worst = Math.max(worst, err);
        if (!(err < 1e-5)) {
            mismatch++;
            if (process.env.DEBUG_SMOOTH) console.log('  mismatch at', x.toFixed(4), z.toFixed(4), 'rendered', h.toFixed(5), 'collider', colliderTop(x, z, BASE_Y + 39));
        }
    }
    check('collision surface equals rendered surface', samples > 200 && mismatch === 0,
          `${samples} samples, ${mismatch} mismatched, worst ${worst.toExponential(1)}`);
}

{
    // Every smooth triangle is wound to face out of the solid: just in front of
    // it is empty, just behind it is filled. An inverted strip or patch would
    // show up dark (back-face) or vanish (culled) in the game.
    const occupied = (lx, ly, lz) => {
        const wy = ly + WORLD_MIN_Y;
        const id = world.getBlock(Math.floor(lx), Math.floor(wy), Math.floor(lz));
        if (terrain.isMesh(id)) return terrain.pointInMesh(lx, wy, lz);
        return id !== 0 && reg.isSolid(id);   // opaque cubes only; glass/water count as open
    };
    let checked = 0, inverted = 0;
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        for (const t of soup(meshChunk(cx, cz, []), cx * CHUNK_SIZE, cz * CHUNK_SIZE)) {
            const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            const len = Math.hypot(n[0], n[1], n[2]);
            if (len < 1e-6) continue;
            const c = [(t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3];
            const k = 1e-3 / len;
            const front = occupied(c[0] + n[0] * k, c[1] + n[1] * k, c[2] + n[2] * k);
            const back  = occupied(c[0] - n[0] * k, c[1] - n[1] * k, c[2] - n[2] * k);
            checked++;
            if (front && !back) inverted++;
        }
    }
    check('every smooth triangle faces out of the solid', checked > 1000 && inverted === 0,
          `${checked} triangles, ${inverted} inverted`);
}

{
    // A player-sized box settled onto the terrain by the same binary search the
    // physics uses must come to rest on the highest rendered point under its
    // footprint (sampled densely from the actual triangles).
    const HW = 0.3, H = 1.8;
    const blocked = (x, z, yLocal) => {
        const y0 = yLocal + WORLD_MIN_Y, y1 = y0 + H - 0.001;
        const x0 = x - HW, x1 = x + HW - 0.001, z0 = z - HW, z1 = z + HW - 0.001;
        for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++)
            for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++)
                for (let by = Math.floor(y0); by <= Math.floor(y1); by++) {
                    const id = world.getBlock(bx, by, bz);
                    if (id === 0 || reg.isNoCollision(id)) continue;
                    if (!terrain.isMesh(id)) return true;
                    if (terrain.cellBlocks(bx, by, bz, x0, y0, z0, x1, y1, z1)) return true;
                }
        return false;
    };
    let ok = 0, bad = 0, worst = 0;
    for (let i = 0; i < 150; i++) {
        const x = 8 + rand() * 16, z = 8 + rand() * 16;
        const near = allTris.filter(t =>
            Math.max(t[0], t[3], t[6]) >= x - HW && Math.min(t[0], t[3], t[6]) <= x + HW &&
            Math.max(t[2], t[5], t[8]) >= z - HW && Math.min(t[2], t[5], t[8]) <= z + HW);
        let top = -Infinity;
        const N = 30;
        for (let a = 0; a <= N; a++) for (let c = 0; c <= N; c++) {
            const o = [x - HW + (2 * HW - 0.001) * a / N, BASE_Y + 40, z - HW + (2 * HW - 0.001) * c / N];
            const d = [0, -60, 0];
            let best = -1;
            for (const tri of near) {
                const t = segHit(o, d, tri);
                if (t >= 0 && (best < 0 || t < best)) best = t;
            }
            if (best >= 0) top = Math.max(top, o[1] + d[1] * best);
        }
        if (top === -Infinity) continue;
        let lo = top - 0.5, hi = top + 0.6;
        if (!blocked(x, z, lo) || blocked(x, z, hi)) continue;   // headroom under the fragment
        for (let k = 0; k < 20; k++) {
            const mid = (lo + hi) / 2;
            if (blocked(x, z, mid)) lo = mid; else hi = mid;
        }
        const err = hi - top;
        worst = Math.max(worst, Math.abs(err));
        // Dense sampling can only under-estimate the true maximum, by at most
        // grid spacing × steepest rendered slope (0.02 × ~3, on a ridge hump).
        if (err < -1e-3 || err > 0.07) bad++; else ok++;
    }
    check('player box rests on the rendered surface', ok > 80 && bad === 0,
          `${ok} ok, ${bad} off, worst |error| ${worst.toFixed(4)}`);
}

// ── 4. Mesh / Solid interaction ─────────────────────────────────────────────

/** Shape of the voxel at (x, y, z) in a world defined by fn, or null if it is a full cube. */
function shapeIn(fn, x, y, z) {
    const s = newShape();
    const field = new SmoothField(kindTable, fn, false), flipped = new SmoothField(kindTable, fn, true);
    return describeVoxel(field, flipped, x, y, z, s) ? s : null;
}
const topOf    = (s) => [...s.top.c];
const bottomOf = (s) => [...s.bot.c].map(c => 1 - c);   // bot is described upside down

/** Rendered top height of the voxel at (x, y, z) at (u, v) in a world defined by fn (1 for a full cube). */
function topAt(fn, x, y, z, u, v) {
    const s = shapeIn(fn, x, y, z);
    return s ? gridHeightAt(surfaceGrid(s.top, false), u, v) : 1;
}

{
    // A single Mesh block on flat ground keeps volume: a round dome peaking at
    // the full block height, rather than collapsing when every corner drops.
    const lone = (x, y, z) => y < 0 ? DIRT : (x === 0 && y === 0 && z === 0 ? GRASS : AIR);
    const s = shapeIn(lone, 0, 0, 0);
    const g = s && surfaceGrid(s.top, false);
    const peak = g ? gridHeightAt(g, 0.5, 0.5) : 0;
    const rim  = g ? Math.max(...[0, 0.25, 0.5, 0.75, 1].flatMap(t =>
        [gridHeightAt(g, t, 0), gridHeightAt(g, t, 1), gridHeightAt(g, 0, t), gridHeightAt(g, 1, t)])) : 1;
    check('an isolated placed Mesh block becomes a round dome', s && s.top.crest && peak === 1 && rim === 0,
          s ? `corners ${topOf(s)}, peak ${peak}, rim ${rim}` : 'shape was full');
}

{
    // Grass slope ending against a Solid block: the shared edge is pinned full
    // so the terrain meets the cube's flat face flush.
    // A one-deep grass strip along X (z = 0 only), so its far corners are free to drop.
    const f = (x, y, z) => y < 0 ? DIRT : y > 0 ? AIR : x === 1 ? BRICKS : x <= 0 && x >= -3 && z === 0 ? GRASS : AIR;
    const s = shapeIn(f, 0, 0, 0);
    // Corners 1 and 2 are on the x=1 face, shared with the brick.
    const t = s && topOf(s), b = s && bottomOf(s);
    check('Mesh meets a Solid neighbour flush', s && t[1] === 1 && t[2] === 1 && b[1] === 0 && b[2] === 0,
          s ? `t=${t} b=${b}` : 'full');

    // Remove the brick: the same voxel now slopes down on that side.
    const g = (x, y, z) => (x === 1 && y === 0 ? AIR : f(x, y, z));
    const s2 = shapeIn(g, 0, 0, 0);
    check('removing the Solid block lets the terrain slope again', s2 && s2.top.c[1] < 1 && s2.top.c[2] < 1,
          s2 ? `t=${topOf(s2)}` : 'full');
}

{
    // Solid blocks never deform, whatever surrounds them.
    check('Solid blocks classify as cubes', kindTable[BRICKS] === KIND_CUBE && kindTable[GLASS] === KIND_CUBE);
    // Transparent blocks cannot be declared Mesh.
    const r2 = new BlockRegistry();
    const origWarn = console.warn; console.warn = () => {};
    r2.register({ id: 9, name: 'BAD', terrainType: 'mesh', transparent: true });
    console.warn = origWarn;
    check('transparent blocks are forced Solid', r2.isMesh(9) === false);
}

{
    // Buried and flat-interior Mesh voxels are full cubes and stay in the greedy
    // pass, so flat ground is still merged into large quads.
    const flat = (x, y, z) => (y <= 0 ? GRASS : AIR);
    check('flat Mesh terrain stays cubic (greedy-merged)', shapeIn(flat, 5, 0, 5) === null);
    check('buried Mesh voxel is cubic', shapeIn(flat, 5, -3, 5) === null);
}

// ── 5. The shape of the smoothing ───────────────────────────────────────────

{
    // An L-shaped plateau: the inside corner drops with the rest of the edge
    // instead of standing up as a vertical triangle (a sawtooth on diagonals).
    const ell = (x, y, z) => y < 0 ? DIRT : y === 0 && (x <= 0 || z <= 0) && x > -6 && z > -6 ? GRASS : AIR;
    const s = shapeIn(ell, 0, 0, 0);
    check('inside corners drop with the edge', s && s.top.c[2] === 0, s ? `t=${topOf(s)}` : 'full');
}

{
    // A one-wide ridge along z is one continuous rounded crest at full height,
    // not a row of spikes, and ends in a rounded cap.
    const ridge = (x, y, z) => y < 0 ? DIRT : y === 0 && x === 0 && z >= -5 && z <= 5 ? GRASS : AIR;
    let minCrest = Infinity;
    for (let z = -5; z <= 5; z++) {
        for (const v of [0, 0.25, 0.5, 0.75, 1]) {
            if ((z === -5 && v < 0.5) || (z === 5 && v > 0.5)) continue;   // the caps
            minCrest = Math.min(minCrest, topAt(ridge, 0, 0, z, 0.5, v));
        }
    }
    const endCrest = topAt(ridge, 0, 0, 5, 0.5, 1);
    check('a one-wide ridge is a continuous crest', minCrest === 1 && endCrest === 0,
          `lowest crest point ${minCrest}, open end ${endCrest}`);
}

// ── 5b. Thin features join up ───────────────────────────────────────────────
// Built from the shapes in the user's screenshot: a ring with no middle, and a
// plus. Every block must carry the crest, and every side two of them share must
// carry it at full height, so the pieces read as one connected shape.

/** Crest heights through each block of a thin shape: its centre, and the middle of each side it shares. */
function crestCheck(name, fn, cells) {
    const has = new Set(cells.map(([x, z]) => x + ',' + z));
    let low = 1, joins = 0;
    for (const [x, z] of cells) {
        low = Math.min(low, topAt(fn, x, 0, z, 0.5, 0.5));
        for (const [dx, dz, u, v] of [[-1, 0, 0, 0.5], [1, 0, 1, 0.5], [0, -1, 0.5, 0], [0, 1, 0.5, 1]]) {
            if (!has.has((x + dx) + ',' + (z + dz))) continue;
            low = Math.min(low, topAt(fn, x, 0, z, u, v));
            joins++;
        }
    }
    check(`${name} is joined into one crest`, low === 1 && joins > 0,
          `${cells.length} blocks, ${joins / 2} joins, lowest crest ${low.toFixed(3)}`);
}

{
    const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    const plus = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const shape = (cells) => {
        const has = new Set(cells.map(([x, z]) => x + ',' + z));
        return (x, y, z) => y < 0 ? DIRT : y === 0 && has.has(x + ',' + z) ? STONE : AIR;
    };
    crestCheck('a ring with no middle block', shape(ring), ring);
    crestCheck('a plus sign', shape(plus), plus);
    crestCheck('an L bend', shape([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]), [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]]);
    crestCheck('a T junction', shape([[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]]), [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]]);

    // The plus's arms end in a rounded cap, not a cliff.
    const p = shape(plus);
    const tip = topAt(p, 1, 0, 0, 1, 0.5);
    check('a plus arm ends in a rounded cap', tip === 0, `height at the tip ${tip}`);

    // A thin arm attached to wider ground flows into it: the ground block it
    // meets carries the crest on that side too, at the same height.
    const plateau = (x, y, z) => y < 0 ? DIRT : y === 0 && ((x >= -1 && x <= 1 && z >= -1 && z <= 1) || (z === 0 && (x === 2 || x === 3))) ? DIRT : AIR;
    const armSide = topAt(plateau, 2, 0, 0, 0, 0.5), groundSide = topAt(plateau, 1, 0, 0, 1, 0.5);
    check('a thin arm flows into the ground it is attached to', armSide === 1 && groundSide === 1,
          `arm side ${armSide}, ground side ${groundSide}`);
}

// A hill rising one block per block (then a plateau), along +X.
const hill = (x, y, z) => {
    const top = BASE_Y + Math.max(0, Math.min(x - 4, 8));
    return y <= top && y >= BASE_Y - 3 ? GRASS : AIR;
};
const hillWorld = new WorldState();
for (let cx = -1; cx <= 2; cx++) for (let cz = -1; cz <= 1; cz++) {
    const c = new ChunkData(cx, cz);
    c.loadVoxels(makeChunk(cx, cz, hill));
    c.generated = true;
    hillWorld.setChunk(cx, cz, c);
}
const hillTerrain = new SmoothTerrain(hillWorld, reg);

/** Rendered top-surface height (world y) of a column, read back through the collider's grids. */
function surfaceY(t, w, x, z, fromY) {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let y = fromY; y > fromY - 40; y--) {
        const id = w.getBlock(bx, y, bz);
        if (id === 0 || reg.isNoCollision(id)) continue;
        if (!t.isMesh(id)) return y + 1;
        const sh = t.shapeAt(bx, y, bz);
        if (!sh) return y + 1;
        const h = gridHeightAt(sh.top, x - bx, z - bz);
        if (h > 0) return y + h;
    }
    return NaN;
}

{
    // A staircase of one-block steps is one straight slope: slopes follow the
    // surface from one level into the next, so there is no S-bend per step.
    const top = BASE_Y + WORLD_MIN_Y + 12;
    let worst = 0;
    for (const x of [6.25, 7.5, 9.0, 10.75, 11.9]) {
        const y = surfaceY(hillTerrain, hillWorld, x, 8.5, top);
        worst = Math.max(worst, Math.abs(y - (BASE_Y + WORLD_MIN_Y + x - 4)));
    }
    check('a staircase of one-block steps renders as one straight slope', worst < 1e-9,
          `worst deviation ${worst.toExponential(2)}`);

    // Where the slope starts it leaves the flat ground tangentially, instead of
    // at a sharp 45 degree crease: the first rendered segment is much flatter.
    const y0 = surfaceY(hillTerrain, hillWorld, 5.0, 8.5, top);
    const first = SMOOTH_SAMPLES[1][1];   // first sample along a curved edge
    const y1 = surfaceY(hillTerrain, hillWorld, 5 + first, 8.5, top);
    const footSlope = (y1 - y0) / first;
    check('a ramp meets flat ground tangentially', footSlope > 0 && footSlope < 0.6,
          `slope of the first segment ${footSlope.toFixed(3)} (a crease would be 1)`);
}

{
    // Neighbouring patches agree on the normal along the side they share, so
    // shading runs smoothly across block boundaries.
    const f  = new SmoothField(kindTable, islandBlock, false);
    const ff = new SmoothField(kindTable, islandBlock, true);
    const a = newShape(), b = newShape();
    let seams = 0, worst = 0;
    for (let x = 6; x < 26; x++) for (let z = 6; z < 26; z++) for (let y = BASE_Y; y < BASE_Y + 14; y++) {
        if (kindTable[islandBlock(x, y, z)] !== KIND_MESH || kindTable[islandBlock(x + 1, y, z)] !== KIND_MESH) continue;
        if (islandBlock(x, y + 1, z) !== AIR || islandBlock(x + 1, y + 1, z) !== AIR) continue;
        if (!describeVoxel(f, ff, x, y, z, a) || !describeVoxel(f, ff, x + 1, y, z, b)) continue;
        if (a.top.nv !== b.top.nv) continue;
        const ga = surfaceGrid(a.top, false, true), gb = surfaceGrid(b.top, false, true);
        for (let j = 0; j <= ga.nv; j++) {
            const ka = (j * (ga.nu + 1) + ga.nu) * 3, kb = (j * (gb.nu + 1)) * 3;   // a's u=1 side, b's u=0 side
            worst = Math.max(worst, Math.hypot(ga.n[ka] - gb.n[kb], ga.n[ka + 1] - gb.n[kb + 1], ga.n[ka + 2] - gb.n[kb + 2]));
        }
        seams++;
    }
    check('neighbouring patches share normals along their seam', seams > 20 && worst < 0.2,
          `${seams} seams, largest normal difference ${worst.toFixed(3)}`);
}

// ── 5c. The same guarantees for thin structures ─────────────────────────────

{
    // A floating dirt slab (so the scene is closed), with thin shapes on top
    // and a plus floating on its own, one of the rings straddling the corner
    // where four chunks meet.
    const cells = new Map();
    const put = (list, y, id) => { for (const [x, z] of list) cells.set(`${x},${y},${z}`, id); };
    const ringAt = (cx, cz) => [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([x, z]) => [cx + x, cz + z]);
    const plusAt = (cx, cz) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => [cx + x, cz + z]);
    put(ringAt(5, 5), 100, STONE);
    put(plusAt(10, 5), 100, DIRT);
    put([[4, 10], [5, 10], [6, 10], [6, 11], [6, 12]], 100, DIRT);                 // L bend
    for (let x = 9; x <= 11; x++) for (let z = 9; z <= 11; z++) put([[x, z]], 100, DIRT);
    put([[12, 10], [13, 10]], 100, DIRT);                                         // arm off the plateau
    put([[4, 14]], 100, GRASS);                                                   // lone block
    put(ringAt(16, 16), 100, STONE);                                              // across the chunk corner
    put([[20, 5], [21, 5], [22, 5], [21, 6], [21, 7]], 100, DIRT);                // T junction
    put([[20, 12]], 100, DIRT); put([[20, 12]], 101, DIRT);                       // two-high pillar
    put(plusAt(24, 22), 104, DIRT);                                               // floating plus
    const thin = (x, y, z) => {
        if (y >= 96 && y <= 99 && x >= 2 && x <= 28 && z >= 2 && z <= 28) return DIRT;
        return cells.get(`${x},${y},${z}`) ?? AIR;
    };

    const tchunks = new Map();
    for (let cx = -1; cx <= 2; cx++) for (let cz = -1; cz <= 2; cz++) tchunks.set(`${cx},${cz}`, makeChunk(cx, cz, thin));
    const meshT = (cx, cz, faces = [0, 1, 2, 3, 4, 5]) => {
        const v = tchunks.get(`${cx},${cz}`);
        const nb = { '1,0': tchunks.get(`${cx + 1},${cz}`), '-1,0': tchunks.get(`${cx - 1},${cz}`),
                     '0,1': tchunks.get(`${cx},${cz + 1}`), '0,-1': tchunks.get(`${cx},${cz - 1}`) };
        const corners = {}, far = CHUNK_SIZE - SMOOTH_REACH;
        for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const c = tchunks.get(`${cx + dx},${cz + dz}`);
            if (c) corners[`${dx},${dz}`] = cornerBlock(c, dx > 0 ? 0 : far, dz > 0 ? 0 : far);
        }
        const yRange = filledRange(v);
        return greedy.meshGroup(v, nb, faces, yRange, smooth.prepare(v, nb, corners, yRange));
    };

    const twWorld = new WorldState();
    for (const [key, v] of tchunks) {
        const [cx, cz] = key.split(',').map(Number);
        const c = new ChunkData(cx, cz);
        c.loadVoxels(v);
        c.generated = true;
        twWorld.setChunk(cx, cz, c);
    }
    const twTerrain = new SmoothTerrain(twWorld, reg);

    const all = [], smoothOnly = [];
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        soup(meshT(cx, cz), cx * CHUNK_SIZE, cz * CHUNK_SIZE, all);
        soup(meshT(cx, cz, []), cx * CHUNK_SIZE, cz * CHUNK_SIZE, smoothOnly);
    }

    let outside = 0;
    for (const tri of smoothOnly) {
        const cxl = Math.floor((tri[0] + tri[3] + tri[6]) / 3), cyl = Math.floor((tri[1] + tri[4] + tri[7]) / 3);
        const czl = Math.floor((tri[2] + tri[5] + tri[8]) / 3);
        for (let k = 0; k < 9; k += 3) {
            if (tri[k] < cxl - 1e-9 || tri[k] > cxl + 1 + 1e-9 || tri[k + 1] < cyl - 1e-9 ||
                tri[k + 1] > cyl + 1 + 1e-9 || tri[k + 2] < czl - 1e-9 || tri[k + 2] > czl + 1 + 1e-9) { outside++; break; }
        }
    }
    check('thin structures stay inside their voxels', smoothOnly.length > 200 && outside === 0,
          `${smoothOnly.length} tris, ${outside} outside`);

    let odd = 0;
    const RAYS = 2000;
    for (let r = 0; r < RAYS; r++) {
        const a = [rand() * 30 + 1, 94, rand() * 30 + 1], b = [rand() * 30 + 1, 108, rand() * 30 + 1];
        if (r % 2) { a[1] = 99.5 + rand() * 6; b[1] = 99.5 + rand() * 6; a[0] = -1; b[0] = 33; }
        const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let n = 0;
        for (const tri of all) if (segHit(a, d, tri) >= 0) n++;
        if (n % 2) odd++;
    }
    check('thin structures are closed surfaces', odd === 0, `${odd} of ${RAYS} rays odd (${all.length} tris)`);

    const occupied = (lx, ly, lz) => {
        const wy = ly + WORLD_MIN_Y;
        const id = twWorld.getBlock(Math.floor(lx), Math.floor(wy), Math.floor(lz));
        if (twTerrain.isMesh(id)) return twTerrain.pointInMesh(lx, wy, lz);
        return id !== 0 && reg.isSolid(id);
    };
    let inverted = 0;
    for (const t of smoothOnly) {
        const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]], e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-6) continue;
        const c = [(t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3], k = 1e-3 / len;
        if (occupied(c[0] + n[0] * k, c[1] + n[1] * k, c[2] + n[2] * k) &&
            !occupied(c[0] - n[0] * k, c[1] - n[1] * k, c[2] - n[2] * k)) inverted++;
    }
    check('thin structures face outward', inverted === 0, `${inverted} inverted`);

    // Collision surface equals the rendered one across every structure.
    let samples = 0, bad = 0;
    for (let i = 0; i < 800; i++) {
        const x = 2.5 + rand() * 26, z = 2.5 + rand() * 26;
        const o = [x, 112, z], d = [0, -20, 0];
        let best = -1;
        for (const tri of all) { const t = segHit(o, d, tri); if (t >= 0 && (best < 0 || t < best)) best = t; }
        if (best < 0) continue;
        const h = o[1] + d[1] * best;
        const bx = Math.floor(x), bz = Math.floor(z);
        let top = NaN;
        for (let ly = 111; ly > 90; ly--) {
            const wy = ly + WORLD_MIN_Y, id = twWorld.getBlock(bx, wy, bz);
            if (id === 0 || reg.isNoCollision(id)) continue;
            const sh = twTerrain.isMesh(id) ? twTerrain.shapeAt(bx, wy, bz) : null;
            top = sh ? ly + Math.max(gridHeightAt(sh.top, x - bx, z - bz), gridHeightAt(sh.bot, x - bx, z - bz)) : ly + 1;
            break;
        }
        samples++;
        if (!(Math.abs(top - h) < 1e-5)) bad++;
    }
    check('thin structures collide exactly as drawn', samples > 300 && bad === 0, `${samples} samples, ${bad} mismatched`);
}

// ── 6. Walking over smooth terrain ──────────────────────────────────────────

{
    const w = hillWorld;
    const walk = (smoothOn, startX, dirX, seconds) => {
        const phys = new PlayerPhysics(w, reg);
        phys.smooth = smoothOn ? new SmoothTerrain(w, reg) : null;
        const pos = { x: startX, y: BASE_Y + WORLD_MIN_Y + (startX > 10 ? 9.01 : 1.01), z: 8.5 };
        // Settle onto the ground first.
        const idle = { fwd: { x: dirX, z: 0 }, rightDir: { x: 0, z: -dirX } };
        for (let i = 0; i < 30; i++) phys.update(pos, idle, 1 / 60, 'SURVIVAL');
        let grounded = 0, frames = 0;
        for (let i = 0; i < seconds * 60; i++) {
            const r = phys.update(pos, { ...idle, forward: true }, 1 / 60, 'SURVIVAL');
            frames++;
            if (r.onGround) grounded++;
        }
        return { x: pos.x, y: pos.y - WORLD_MIN_Y - BASE_Y, grounded: grounded / frames };
    };

    const up = walk(true, 1.5, 1, 4);
    check('player walks up a smooth hill without jumping', up.x > 14 && up.y > 8.9,
          `reached x=${up.x.toFixed(2)} height ${up.y.toFixed(2)}, grounded ${(up.grounded * 100).toFixed(0)}%`);
    check('player stays grounded on the way up', up.grounded > 0.95, `${(up.grounded * 100).toFixed(0)}%`);

    const down = walk(true, 15.5, -1, 4);
    check('player walks down without bouncing off the slope', down.x < 3 && down.grounded > 0.95,
          `reached x=${down.x.toFixed(2)}, grounded ${(down.grounded * 100).toFixed(0)}%`);

    const blocky = walk(false, 1.5, 1, 4);
    check('blocky collision still stops at a one-block step', blocky.x < 4.8,
          `stopped at x=${blocky.x.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
