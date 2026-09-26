// Times the worker pipeline on real terrain, stage by stage, and prints a hash
// of every stage's output so an optimisation can be checked for changing
// nothing but speed.
//
//   node test/pipelinebench.mjs [radius] [seed]
//
// Generates a (2r+3)² area, then meshes (blocky and smooth) and lights the
// inner (2r+1)², exactly as worldWorker does. Stages are run in bulk rather
// than interleaved so each one's timing reflects a warmed-up JIT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { BlockRegistry }    from '../src/scripts/engine/BlockRegistry.js';
import { ChunkData, CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME } from '../src/scripts/engine/ChunkData.js';
import { setSeed }          from '../src/scripts/workers/noise.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';
import { StructurePlacer }  from '../src/scripts/workers/StructurePlacer.js';
import { GreedyMesher }     from '../src/scripts/workers/GreedyMesher.js';
import { SmoothMesher }     from '../src/scripts/workers/SmoothMesher.js';
import { computeSkylight }  from '../src/scripts/workers/Skylight.js';
import { SMOOTH_REACH }     from '../src/scripts/engine/SmoothShape.js';

const R    = Number(process.argv[2] ?? 2);
const SEED = Number(process.argv[3] ?? 4242);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const reg = new BlockRegistry();
for (const f of fs.readdirSync(path.join(root, 'data/blocks')))
    reg.register(JSON.parse(fs.readFileSync(path.join(root, 'data/blocks', f), 'utf8')));
const biomes = fs.readdirSync(path.join(root, 'data/biomes'))
    .map(f => JSON.parse(fs.readFileSync(path.join(root, 'data/biomes', f), 'utf8')));
// A face map like world.js builds: every block textured, so the layer path runs.
const faceMap = {};
for (const b of reg.serialize()) faceMap[b.id] = { top: b.id, side: b.id, bottom: b.id };

setSeed(SEED);
const gen    = new TerrainGenerator(SEED, reg, biomes);
const placer = new StructurePlacer(SEED, reg, gen.biomes, gen);
const mesher = new GreedyMesher(reg, faceMap);
const smooth = new SmoothMesher(reg, mesher);

const hash = () => createHash('sha1');
const feed = (h, ta) => h.update(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength));
const time = (label, n, fn) => {
    const t = performance.now();
    const r = fn();
    const ms = performance.now() - t;
    console.log(`${label.padEnd(26)} ${ms.toFixed(0).padStart(6)} ms   ${(ms / n).toFixed(2).padStart(6)} ms/chunk`);
    return r;
};

const coords = [];
for (let cz = -R - 1; cz <= R + 1; cz++) for (let cx = -R - 1; cx <= R + 1; cx++) coords.push([cx, cz]);
const inner = coords.filter(([cx, cz]) => Math.abs(cx) <= R && Math.abs(cz) <= R);
const key = (cx, cz) => `${cx},${cz}`;

// ── Generation ──────────────────────────────────────────────────────────────
const voxels = new Map();
time('generate + structures', coords.length, () => {
    for (const [cx, cz] of coords) {
        const v = gen.generateChunk(cx, cz);
        const { heights, blends } = gen.buildColumnData(cx, cz);
        placer.apply(v, cx, cz, heights, blends);
        voxels.set(key(cx, cz), v);
    }
});
const hGen = hash();
for (const [cx, cz] of coords) feed(hGen, voxels.get(key(cx, cz)));

// ── Palette compression (runs in the generation worker) ─────────────────────
const chunks = new Map();
time('compress (worker side)', coords.length, () => {
    for (const [cx, cz] of coords) {
        const cd = new ChunkData(cx, cz);
        cd.loadVoxels(voxels.get(key(cx, cz)));
        chunks.set(key(cx, cz), cd);
    }
});
const hLoad = hash();
for (const [cx, cz] of coords) {
    const cd = chunks.get(key(cx, cz));
    feed(hLoad, Uint16Array.from(cd._palette)); feed(hLoad, cd._indices);
    feed(hLoad, new Int32Array([cd.minFilledY, cd.maxFilledY]));
}

// ── Meshing inputs, as the worker sees them ─────────────────────────────────
const job = ([cx, cz]) => {
    const c = chunks.get(key(cx, cz));
    const nb = {};
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) nb[key(dx, dz)] = voxels.get(key(cx + dx, cz + dz));
    const corners = {};
    const far = CHUNK_SIZE - SMOOTH_REACH;
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        corners[key(dx, dz)] = chunks.get(key(cx + dx, cz + dz))
            .cornerBlock(dx > 0 ? 0 : far, dz > 0 ? 0 : far, SMOOTH_REACH);
    }
    return { v: voxels.get(key(cx, cz)), nb, corners, yRange: { min: c.minFilledY, max: c.maxFilledY } };
};
const jobs = inner.map(job);

const feedGeo = (h, g) => {
    for (const k of ['positions', 'colors', 'uvs', 'layers', 'indices',
                     'transparentPositions', 'transparentColors', 'transparentUVs',
                     'transparentLayers', 'transparentIndices']) feed(h, g[k]);
};

// All six face directions in one group, as worldWorker meshes a chunk.
const ALL_FACES = [0, 1, 2, 3, 4, 5];

let tris = 0;
const hBlocky = hash();
time('mesh blocky', jobs.length, () => {
    for (const j of jobs) {
        const g = mesher.meshGroup(j.v, j.nb, ALL_FACES, j.yRange);
        feedGeo(hBlocky, g);
        tris += g.indices.length / 3;
    }
});
console.log(`  ${(tris / jobs.length).toFixed(0)} opaque tris/chunk`);

tris = 0;
const hSmooth = hash();
time('mesh smooth', jobs.length, () => {
    for (const j of jobs) {
        const g = mesher.meshGroup(j.v, j.nb, ALL_FACES, j.yRange, smooth.prepare(j.v, j.nb, j.corners, j.yRange));
        feedGeo(hSmooth, g);
        tris += g.indices.length / 3;
    }
});
console.log(`  ${(tris / jobs.length).toFixed(0)} opaque tris/chunk`);

const hLight = hash();
time('sky light', inner.length, () => {
    for (const [cx, cz] of inner) {
        const views = [], minY = [], maxY = [];
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
            const c = chunks.get(key(cx + dx, cz + dz));
            views.push(voxels.get(key(cx + dx, cz + dz))); minY.push(c.minFilledY); maxY.push(c.maxFilledY);
        }
        const L = computeSkylight(views, minY, maxY, mesher._solid);
        feed(hLight, L.data); feed(hLight, new Int32Array([L.y0, L.h]));
    }
});

console.log('\nhashes');
for (const [n, h] of [['generate', hGen], ['loadVoxels', hLoad], ['blocky mesh', hBlocky],
                      ['smooth mesh', hSmooth], ['light', hLight]]) {
    console.log(`  ${n.padEnd(12)} ${h.digest('hex')}`);
}
