// worldWorker.js end to end: its mesh and light replies must be exactly what
// the mesher and sky-light solver produce from fully expanded voxel arrays.
//
// The worker reuses its expansion buffers between jobs and only expands each
// snapshot's filled band, clearing what an earlier job left outside it. A slip
// there leaves stale blocks in a buffer — phantom faces at chunk seams, wrong
// light — so jobs here are run in an order that makes the bands grow, shrink
// and move, and that leaves neighbours out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlockRegistry }    from '../src/scripts/engine/BlockRegistry.js';
import { ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y } from '../src/scripts/engine/ChunkData.js';
import { FEATURE_STEPS }    from '../src/scripts/workers/FarTiles.js';
import { GreedyMesher }     from '../src/scripts/workers/GreedyMesher.js';
import { SmoothMesher }     from '../src/scripts/workers/SmoothMesher.js';
import { computeSkylight }  from '../src/scripts/workers/Skylight.js';
import { computeBlocklight, paletteHasLight } from '../src/scripts/workers/Blocklight.js';
import { SMOOTH_REACH }     from '../src/scripts/engine/SmoothShape.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';
import { sectionConnectivity } from '../src/scripts/engine/Visibility.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

// ── A worker in this thread: `self` stands in for the worker global ──────────
let reply = null;
globalThis.self = { postMessage(msg) { reply = msg; } };
await import('../src/scripts/workers/worldWorker.js');
const send = (msg) => { reply = null; self.onmessage({ data: msg }); return reply; };

const reg = new BlockRegistry();
for (const f of fs.readdirSync(path.join(root, 'data/blocks')))
    reg.register(JSON.parse(fs.readFileSync(path.join(root, 'data/blocks', f), 'utf8')));
const readDir = (d) => fs.readdirSync(path.join(root, d)).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')));
const biomes = readDir('data/biomes');
const terrain = readDir('data/terrain');
const faceMap = {};
for (const b of reg.serialize()) faceMap[b.id] = { top: b.id, side: b.id, bottom: b.id };

const SEED = 31337;

// ── Chunks: real terrain, plus hand-made ones whose bands differ a lot ───────
const gen = new TerrainGenerator(SEED, reg, biomes, terrain);
const chunks = new Map();
const key = (cx, cz) => `${cx},${cz}`;
for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) {
    const c = new ChunkData(cx, cz);
    c.loadVoxels(gen.generateChunk(cx, cz));
    chunks.set(key(cx, cz), c);
}
const STONE = reg.getByName('STONE').id, GLASS = reg.getByName('GLASS').id, WATER = reg.getByName('WATER').id;
// A tall pillar field high up (band far above the terrain's), a thin low
// slab (band far below), and an empty chunk (band 0..0).
const tall = new ChunkData(10, 0), low = new ChunkData(11, 0), empty = new ChunkData(12, 0);
for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    if ((lx + lz) % 3 === 0) for (let ly = 300; ly < 420; ly++) tall.setVoxel(lx, ly, lz, lx % 2 ? STONE : GLASS);
    low.setVoxel(lx, 5, lz, STONE);
    if (lx === lz) low.setVoxel(lx, 6, lz, WATER);
}
for (const c of [tall, low, empty]) { c.generated = true; c._recomputeFilledY(); }

// Light sources: torches on the terrain of 0,0 (one on a wall by the corner it
// shares with 1,1), a lamp in 1,0, a hanging lantern in -1,-1 — so block light
// crosses seams and corners and the model path runs.
{
    const at = (c, lx, lz, id, dy = 1) => c.setVoxel(lx, c.columnTop(lx, lz) + dy, lz, id);
    const id = (n) => reg.getByName(n).id;
    const c00 = chunks.get('0,0');
    at(c00, 4, 4, id('TORCH'));
    at(c00, 11, 6, id('TORCH'));
    const wy = c00.columnTop(15, 15) + 1;
    c00.setVoxel(15, wy + 1, 15, STONE);
    c00.setVoxel(14, wy + 1, 15, id('WALL_TORCH_WEST'));
    at(chunks.get('1,0'), 2, 9, id('LAMP'));
    const cm = chunks.get('-1,-1');
    const ly = cm.columnTop(8, 8) + 4;
    cm.setVoxel(8, ly + 1, 8, STONE);
    cm.setVoxel(8, ly, 8, id('HANGING_LANTERN'));
}

// A job for chunk `c` whose neighbours are the chunks named in `around`
// ({ "dx,dz": ChunkData }), mirroring ChunkManager._requestMesh.
function makeJob(c, around, smooth) {
    const neighbors = {}, diagonals = {}, corners = smooth ? {} : undefined;
    const far = CHUNK_SIZE - SMOOTH_REACH;
    for (const [k, n] of Object.entries(around)) {
        const [dx, dz] = k.split(',').map(Number);
        if (dx !== 0 && dz !== 0) {
            diagonals[k] = n.snapshot();
            if (smooth) corners[k] = n.cornerBlock(dx > 0 ? 0 : far, dz > 0 ? 0 : far, SMOOTH_REACH);
        } else {
            neighbors[k] = n.snapshot();
        }
    }
    return { type: 'meshChunk', taskId: 1, cx: c.cx, cz: c.cz, chunk: c.snapshot(), neighbors, diagonals, corners };
}

// What the reply must be: the same work on freshly expanded arrays.
function expected(c, around, smooth) {
    const mesher = new GreedyMesher(reg, faceMap);
    const nb = {};
    const views = new Array(9).fill(null), minY = new Array(9).fill(0), maxY = new Array(9).fill(0);
    views[4] = c.toUint16Array(); minY[4] = c.minFilledY; maxY[4] = c.maxFilledY;
    const corners = {};
    const far = CHUNK_SIZE - SMOOTH_REACH;
    for (const [k, n] of Object.entries(around)) {
        const [dx, dz] = k.split(',').map(Number);
        const v = n.toUint16Array();
        const i = (dx + 1) + (dz + 1) * 3;
        views[i] = v; minY[i] = n.minFilledY; maxY[i] = n.maxFilledY;
        if (dx === 0 || dz === 0) nb[k] = v;
        else corners[k] = n.cornerBlock(dx > 0 ? 0 : far, dz > 0 ? 0 : far, SMOOTH_REACH);
    }
    const yRange = { min: c.minFilledY, max: c.maxFilledY };
    const ctx = smooth ? new SmoothMesher(reg, mesher).prepare(views[4], nb, corners, yRange) : null;
    const light = computeSkylight(views, minY, maxY, mesher._solid);
    const palettes = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        palettes.push(dx === 0 && dz === 0 ? c._palette : around[key(dx, dz)]?._palette ?? null);
    }
    const scan = palettes.map(p => paletteHasLight(p, mesher._light));
    light.block = scan.some(Boolean) ? computeBlocklight(views, minY, maxY, mesher._solid, mesher._light, scan) : null;
    const geo = mesher.meshGroup(views[4], nb, [0, 1, 2, 3, 4, 5], yRange, ctx, mesher.hasModels(c._palette));
    // What open space joins in each section (engine/Visibility.js).
    geo.conn = sectionConnectivity(views[4], yRange.min, yRange.max, ctx ? ctx.occ : mesher._solid, ctx ? ctx.partial : null);
    return { geo, light };
}

const GEO_KEYS = ['positions', 'tints', 'uvs', 'normals', 'indices',
                  'transparentPositions', 'transparentTints', 'transparentUVs',
                  'transparentNormals', 'transparentIndices', 'sections', 'conn'];
const sameArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameGeo = (a, b) => GEO_KEYS.every(k => sameArray(a[k], b[k]));
const sameVolume = (a, b) => a.y0 === b.y0 && a.h === b.h && sameArray(a.data, b.data);
const sameLight = (a, b) => sameVolume(a, b) &&
    ((a.block ?? null) === null ? (b.block ?? null) === null : !!b.block && sameVolume(a.block, b.block));

const around = (cx, cz, drop = []) => {
    const o = {};
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const k = key(dx, dz);
        if ((dx || dz) && !drop.includes(k) && chunks.has(key(cx + dx, cz + dz))) o[k] = chunks.get(key(cx + dx, cz + dz));
    }
    return o;
};
const all = (n) => ({ '1,0': n, '-1,0': n, '0,1': n, '0,-1': n, '1,1': n, '1,-1': n, '-1,1': n, '-1,-1': n });

// Jobs in an order that swings every buffer's band around.
const sequence = [
    ['terrain, all neighbours',       chunks.get('0,0'), around(0, 0)],
    ['next to a lamp and torches',    chunks.get('1,1'), around(1, 1)],
    ['a lantern, torches two away',   chunks.get('-1,-1'), around(-1, -1)],
    ['tall pillars around terrain',   tall,  all(chunks.get('1,1'))],
    ['terrain surrounded by tall',    chunks.get('0,0'), all(tall)],
    ['low slab surrounded by terrain', low,  all(chunks.get('-1,0'))],
    ['terrain surrounded by low',     chunks.get('1,0'), all(low)],
    ['terrain, some neighbours gone', chunks.get('-1,-1'), around(-1, -1, ['1,0', '0,1', '1,1'])],
    ['empty surrounded by tall',      empty, all(tall)],
    ['terrain surrounded by empty',   chunks.get('1,1'), all(empty)],
    ['terrain again, all neighbours', chunks.get('0,0'), around(0, 0)],
];

// The jobs above really do carry block light, and a chunk with no light source
// in reach carries none (the common case: no work, no texture).
check('torch-lit chunks come back with block light',
      expected(chunks.get('0,0'), around(0, 0), false).light.block !== null &&
      expected(chunks.get('1,1'), around(1, 1), false).light.block !== null);
check('a chunk with no light source in reach has none',
      expected(chunks.get('2,2'), around(2, 2), false).light.block === null);

for (const smooth of [false, true]) {
    send({ type: 'init', seed: SEED, blockRegistry: reg.serialize(), biomes, blockFaceMap: faceMap,
           terrainStyle: smooth ? 'smooth' : 'blocky' });
    check(`${smooth ? 'smooth' : 'blocky'} worker initialises`, reply?.type === 'ready');
    for (const [name, c, nbrs] of sequence) {
        const got  = send(makeJob(c, nbrs, smooth));
        const want = expected(c, nbrs, smooth);
        check(`${smooth ? 'smooth' : 'blocky'} mesh: ${name}`,
              got?.type === 'chunkMeshed' && sameGeo(got.geo, want.geo) && sameLight(got.light, want.light));
        // Light-only jobs share the same buffers.
        const job = makeJob(c, nbrs, false);
        const lit = send({ type: 'lightChunk', taskId: 2, cx: c.cx, cz: c.cz,
                           chunk: job.chunk, neighbors: job.neighbors, diagonals: job.diagonals });
        check(`${smooth ? 'smooth' : 'blocky'} light: ${name}`,
              lit?.type === 'chunkLit' && sameLight(lit.light, expected(c, nbrs, false).light));
    }
}

// Rain heights (geo.rain) used to be worked out on the render thread from the
// live world through the collider. The worker's must be exactly those: the top
// of each column's highest block or, in a smooth world, the surface of a
// deformed top voxel at the column centre. Rain falls past torches and
// lanterns (model blocks) to whatever is under them.
{
    const { WorldState } = await import('../src/scripts/engine/WorldState.js');
    const { SmoothTerrain, gridHeightAt } = await import('../src/scripts/engine/SmoothShape.js');
    const { WORLD_MIN_Y } = await import('../src/scripts/engine/ChunkData.js');
    const world = new WorldState();
    for (const c of chunks.values()) { c.generated = true; world.setChunk(c.cx, c.cz, c); }
    const c = chunks.get('0,0');
    for (const smooth of [false, true]) {
        send({ type: 'init', seed: SEED, blockRegistry: reg.serialize(), biomes, blockFaceMap: faceMap,
               terrainStyle: smooth ? 'smooth' : 'blocky' });
        const rain = send(makeJob(c, around(0, 0), smooth))?.geo?.rain;
        const collider = smooth ? new SmoothTerrain(world, reg) : null;
        let bad = 0, deformed = 0;
        for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            let ly = c.columnTop(lx, lz);
            while (ly >= 0 && (c.getVoxel(lx, ly, lz) === 0 || reg.hasModel(c.getVoxel(lx, ly, lz)))) ly--;
            let want = NaN;
            if (ly >= 0) {
                const y = WORLD_MIN_Y + ly;
                want = y + 1;
                if (collider?.isMesh(c.getVoxel(lx, ly, lz))) {
                    const shape = collider.shapeAt(c.cx * CHUNK_SIZE + lx, y, c.cz * CHUNK_SIZE + lz);
                    if (shape) { want = y + gridHeightAt(shape.top, 0.5, 0.5); deformed++; }
                }
            }
            const got = rain?.[lx + lz * CHUNK_SIZE];
            if (!(Math.abs(got - want) < 1e-4) && !(Number.isNaN(got) && Number.isNaN(want))) bad++;
        }
        check(`${smooth ? 'smooth' : 'blocky'} rain heights match the collider`,
              rain?.length === CHUNK_SIZE * CHUNK_SIZE && bad === 0 && (!smooth || deformed > 0),
              `${bad} of 256 columns differ, ${deformed} deformed`);
    }
}

// Generation through the worker matches the generator it was told to use.
const { LegacyWorldGen } = await import('../src/scripts/workers/legacy/LegacyTerrainGenerator.js');
for (const worldGen of [2, undefined]) {
    const label = worldGen ? `worldGen ${worldGen}` : 'a world from before worldGen';
    send({ type: 'init', seed: SEED, blockRegistry: reg.serialize(), biomes, terrain, blockFaceMap: faceMap,
           terrainStyle: 'blocky', worldGen });
    const g = send({ type: 'generateChunk', taskId: 3, cx: 3, cz: -4 });
    const v2 = worldGen ? new TerrainGenerator(SEED, reg, biomes, terrain).generate(3, -4)
                        : new LegacyWorldGen(SEED, reg).generate(3, -4);
    const adopted = new ChunkData(3, -4);
    adopted.adoptCompressed(g.palette, g.indices, g.minY, g.maxY);
    check(`${label}: generateChunk reply matches its generator`,
          g?.type === 'chunkGenerated' && sameArray(adopted.toUint16Array(), v2));
    const loaded = new ChunkData(3, -4);
    loaded.loadVoxels(v2);
    check(`${label}: reply palette, indices and band match loadVoxels`,
          sameArray(adopted._palette, loaded._palette) && sameArray(adopted._indices, loaded._indices) &&
          adopted.minFilledY === loaded.minFilledY && adopted.maxFilledY === loaded.maxFilledY);

    // Far terrain tiles (FarTiles.js): well formed, the same every time, and
    // two neighbours of one step agree exactly along the edge they share —
    // heights, normals and colours — so no seam shows between them.
    const tile = (x0, z0, step, cells) => send({ type: 'farTile', taskId: 4, x0, z0, step, cells });
    // The ground's vertices come first (n × n, then the skirts); what stands
    // on it — trees and buildings as boxes, at the finer steps — follows.
    const n = 17, verts = n * n + 4 * n;
    const a = tile(512, -1024, 4, 16), again = tile(512, -1024, 4, 16), b = tile(576, -1024, 4, 16);
    const total = a.positions.length / 3;
    check(`${label}: farTile reply is well formed`,
          a?.type === 'farTileBuilt' && total >= verts && (total === verts) === (a.features === 0) &&
          a.colors.length === total * 4 && a.normals.length === total * 4 && a.indices.every(i => i < total) &&
          a.positions.every(Number.isFinite) && a.yMin <= a.yMax);
    check(`${label}: farTile is deterministic`,
          sameArray(a.positions, again.positions) && sameArray(a.colors, again.colors) && sameArray(a.normals, again.normals));
    let seam = 0;
    for (let j = 0; j < n; j++) {
        const va = (n - 1) * n + j, vb = j;   // a's +x edge is b's −x edge
        if (a.positions[va * 3 + 1] !== b.positions[vb * 3 + 1]) seam++;
        for (let c = 0; c < 4; c++) if (a.normals[va * 4 + c] !== b.normals[vb * 4 + c] || a.colors[va * 4 + c] !== b.colors[vb * 4 + c]) seam++;
    }
    check(`${label}: neighbouring far tiles meet exactly`, seam === 0, `${seam} differences`);

    // The current generator samples a far tile as a lattice (farGrid). At step
    // 1 that must be the chunks' own geography, column for column; coarser, it
    // measures gradients across the lattice, so it is close rather than exact.
    if (worldGen) {
        // Where a tile draws its trees as shapes (steps 4 and 8) its ground is
        // the bare ground; elsewhere a forest's canopy is part of the surface.
        const G = new TerrainGenerator(SEED, reg, biomes, terrain), s = {};
        const cmp = (step, cells) => {
            const t = tile(700, 300, step, cells), m = cells + 1;
            let exact = 0, near = 0;
            for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
                G.farSample(700 + i * step, 300 + j * step, true, s, !FEATURE_STEPS.includes(step));
                const d = Math.abs(t.positions[(i * m + j) * 3 + 1] - Math.fround(s.h));
                if (d === 0) exact++;
                if (d <= 2) near++;
            }
            return { exact: exact / (m * m), near: near / (m * m) };
        };
        const one = cmp(1, 24), four = cmp(4, 32);
        check(`${label}: a step-1 far tile is exactly the chunks' surface`, one.exact === 1, `${(one.exact * 100).toFixed(1)}% exact`);
        check(`${label}: a step-4 far tile stays close to it`, four.near >= 0.95,
              `${(four.near * 100).toFixed(1)}% within 2 blocks, ${(four.exact * 100).toFixed(1)}% exact`);

        // What stands on a far tile: the plants and buildings of the chunks
        // there. Somewhere wooded, every tree a step-4 tile draws stands on a
        // spot where the chunk has one (a trunk, or leaves, in the column
        // above the ground) — bar the few its coarser view of the land gets
        // wrong — and the tile is the same every time.
        let spot = null;
        for (let r = 0; r < 6000 && !spot; r += 160) for (let k = 0; k < 8 && !spot; k++) {
            const x = Math.round(Math.cos(k * 0.785) * r / 256) * 256, z = Math.round(Math.sin(k * 0.785) * r / 256) * 256;
            const t = tile(x, z, 4, 16);
            if (t.features >= 40) spot = { x, z, t };
        }
        check(`${label}: wooded land has trees on its far tiles`, !!spot, spot ? `${spot.t.features} shapes at ${spot.x},${spot.z}` : 'no wooded tile found');
        if (spot) {
            const { x, z, t } = spot, t2 = tile(x, z, 4, 16);
            check(`${label}: … the same ones every time`, sameArray(t.positions, t2.positions) && sameArray(t.indices, t2.indices));
            // The chunks under the tile (64 blocks: 4 × 4 chunks), as generated.
            const cols = new Map();
            const at = (wx, wy, wz) => {
                const cx = wx >> 4, cz = wz >> 4, key = cx + ',' + cz;
                if (!cols.has(key)) cols.set(key, G.generate(cx, cz));
                return cols.get(key)[(wx & 15) + (wy - WORLD_MIN_Y) * CHUNK_SIZE + (wz & 15) * CHUNK_SIZE * CHUNK_SIZE_Y];
            };
            const woody = new Set(reg.serialize().filter(d => /LOG|WOOD$|LEAVES|CACTUS|MUSHROOM|MOSSY|ANDESITE|PLANKS/.test(d.name)).map(d => d.id));
            // Each shape's foot, from its first vertex and the offset in its spare bytes.
            let feet = 0, onTree = 0;
            const seen = new Set();
            for (let v = verts; v < t.positions.length / 3; v++) {
                const fx = Math.floor(x + t.positions[v * 3] + t.normals[v * 4 + 3] / 16);
                const fz = Math.floor(z + t.positions[v * 3 + 2] + (t.colors[v * 4 + 3] - 128) / 16);
                if (seen.has(fx + ',' + fz) || fx < x || fx >= x + 64 || fz < z || fz >= z + 64) continue;
                seen.add(fx + ',' + fz);
                feet++;
                const y0 = Math.floor(t.positions[v * 3 + 1]);
                let hit = false;
                for (let y = y0 - 8; y <= y0 + 24 && !hit; y++) if (y > WORLD_MIN_Y && y < 319 && woody.has(at(fx, y, fz))) hit = true;
                if (hit) onTree++;
            }
            check(`${label}: … standing where the chunks have them`, feet >= 10 && onTree / feet >= 0.9,
                  `${onTree} of ${feet} feet on a tree, rock or house`);
        }

        // A chunk the player has changed shows its own surface: a tower the
        // generator knows nothing of.
        const heights = new Int16Array(256).fill(200), ids = new Uint16Array(256).fill(reg.getByName('STONE').id);
        const edited = send({ type: 'farTile', taskId: 5, x0: 512, z0: -1024, step: 4, cells: 16,
                              edits: [{ cx: 33, cz: -63, heights, ids }] });
        let raised = 0, others = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const wx = 512 + i * 4, wz = -1024 + j * 4, inChunk = (wx >> 4) === 33 && (wz >> 4) === -63;
            const y = edited.positions[(i * n + j) * 3 + 1];
            if (inChunk) { if (y === 201) raised++; else raised = -1e9; }
            else if (y !== a.positions[(i * n + j) * 3 + 1]) others++;
        }
        check(`${label}: a changed chunk's surface replaces the generated one, there only`, raised === 16 && others === 0,
              `${raised} points raised, ${others} others changed`);
    }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
