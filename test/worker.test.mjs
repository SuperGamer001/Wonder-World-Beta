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
import { ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y } from '../src/scripts/engine/ChunkData.js';
import { GreedyMesher }     from '../src/scripts/workers/GreedyMesher.js';
import { SmoothMesher }     from '../src/scripts/workers/SmoothMesher.js';
import { computeSkylight }  from '../src/scripts/workers/Skylight.js';
import { SMOOTH_REACH }     from '../src/scripts/engine/SmoothShape.js';
import { setSeed }          from '../src/scripts/workers/noise.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';

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
const biomes = fs.readdirSync(path.join(root, 'data/biomes'))
    .map(f => JSON.parse(fs.readFileSync(path.join(root, 'data/biomes', f), 'utf8')));
const faceMap = {};
for (const b of reg.serialize()) faceMap[b.id] = { top: b.id, side: b.id, bottom: b.id };

const SEED = 31337;

// ── Chunks: real terrain, plus hand-made ones whose bands differ a lot ───────
setSeed(SEED);
const gen = new TerrainGenerator(SEED, reg, biomes);
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
    return {
        geo:   mesher.meshGroup(views[4], nb, [0, 1, 2, 3, 4, 5], yRange, ctx),
        light: computeSkylight(views, minY, maxY, mesher._solid),
    };
}

const GEO_KEYS = ['positions', 'colors', 'uvs', 'layers', 'indices',
                  'transparentPositions', 'transparentColors', 'transparentUVs',
                  'transparentLayers', 'transparentIndices'];
const sameArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameGeo = (a, b) => GEO_KEYS.every(k => sameArray(a[k], b[k]));
const sameLight = (a, b) => a.y0 === b.y0 && a.h === b.h && sameArray(a.data, b.data);

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
    ['tall pillars around terrain',   tall,  all(chunks.get('1,1'))],
    ['terrain surrounded by tall',    chunks.get('0,0'), all(tall)],
    ['low slab surrounded by terrain', low,  all(chunks.get('-1,0'))],
    ['terrain surrounded by low',     chunks.get('1,0'), all(low)],
    ['terrain, some neighbours gone', chunks.get('-1,-1'), around(-1, -1, ['1,0', '0,1', '1,1'])],
    ['empty surrounded by tall',      empty, all(tall)],
    ['terrain surrounded by empty',   chunks.get('1,1'), all(empty)],
    ['terrain again, all neighbours', chunks.get('0,0'), around(0, 0)],
];

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

// Generation through the worker matches the generator plus structures.
send({ type: 'init', seed: SEED, blockRegistry: reg.serialize(), biomes, blockFaceMap: faceMap, terrainStyle: 'blocky' });
const g = send({ type: 'generateChunk', taskId: 3, cx: 3, cz: -4 });
const { StructurePlacer } = await import('../src/scripts/workers/StructurePlacer.js');
setSeed(SEED);
const gen2 = new TerrainGenerator(SEED, reg, biomes);
const v2 = gen2.generateChunk(3, -4);
const cols = gen2.buildColumnData(3, -4);
new StructurePlacer(SEED, reg, gen2.biomes, gen2).apply(v2, 3, -4, cols.heights, cols.blends);
const adopted = new ChunkData(3, -4);
adopted.adoptCompressed(g.palette, g.indices, g.minY, g.maxY);
check('generateChunk reply matches generator + structures',
      g?.type === 'chunkGenerated' && sameArray(adopted.toUint16Array(), v2));
const loaded = new ChunkData(3, -4);
loaded.loadVoxels(v2);
check('reply palette, indices and band match loadVoxels',
      sameArray(adopted._palette, loaded._palette) && sameArray(adopted._indices, loaded._indices) &&
      adopted.minFilledY === loaded.minFilledY && adopted.maxFilledY === loaded.maxFilledY);

// buildColumnData must match a from-scratch computation, cached or not.
const fresh = new TerrainGenerator(SEED, reg, biomes).buildColumnData(3, -4);
check('cached column heights match a fresh computation', sameArray(cols.heights, fresh.heights));
check('cached column blends match a fresh computation',
      cols.blends.every((b, i) => sameArray(b.weights, fresh.blends[i].weights)));

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
