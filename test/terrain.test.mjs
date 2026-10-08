// The world generator: what it promises beyond "it runs".
//
//   - worlds made before the current generator still generate exactly what
//     they always did (legacy/, pinned by a hash of its output)
//   - generation is deterministic
//   - a single column (Geography.column) is bit-for-bit the chunk's, which is
//     what lets structures and weather ask about any column
//   - water is always contained: no water block beside air or above it, across
//     chunk seams too — so no cave or ravine opens under the sea or a lake
//   - every block a biome or the geology names exists
//   - the world has a sensible balance of land, sea and biomes, and every
//     biome turns up on some seed
//   - it stays fast enough
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y } from '../src/scripts/engine/ChunkData.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';
import { LegacyWorldGen } from '../src/scripts/workers/legacy/LegacyTerrainGenerator.js';
import { Geography, NO_WATER } from '../src/scripts/workers/Geography.js';
import { BiomeSet } from '../src/scripts/workers/Biomes.js';
import { FLAT_TOP, normaliseFlat } from '../src/scripts/engine/FlatWorld.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readDir = (d) => fs.readdirSync(path.join(root, d)).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')));
const blocks = readDir('data/blocks');
const biomes = readDir('data/biomes');
const terrain = readDir('data/terrain');
const reg = new BlockRegistry();
for (const b of blocks) reg.register(b);

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}
const N = CHUNK_SIZE, SZ = N * CHUNK_SIZE_Y;

// ── Old worlds ───────────────────────────────────────────────────────────────
// The hash of 81 chunks of seed 4242 from the generator as it was before the
// overhaul (test/pipelinebench.mjs printed it then). Changing it means old
// worlds grow seams where new terrain meets what the player already explored.
{
    const gen = new LegacyWorldGen(4242, reg);
    const h = createHash('sha1');
    for (let cz = -4; cz <= 4; cz++) for (let cx = -4; cx <= 4; cx++) {
        const v = gen.generate(cx, cz);
        h.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    }
    const got = h.digest('hex');
    check('legacy generator reproduces pre-overhaul worlds exactly', got === 'aecae455623621b6d17286c4b9af8f5887a8f7ad', got);
}

// ── Determinism ──────────────────────────────────────────────────────────────
{
    const a = new TerrainGenerator(1234, reg, biomes, terrain), b = new TerrainGenerator(1234, reg, biomes, terrain);
    // b generates other chunks first, so caches and scratch are in another state.
    b.generate(40, -40); b.generate(-7, 3);
    let same = true;
    for (const [cx, cz] of [[0, 0], [5, -3], [-12, 9]]) {
        const va = a.generate(cx, cz), vb = b.generate(cx, cz);
        for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) { same = false; break; }
    }
    check('same seed and chunk give the same voxels, whatever was generated before', same);
    const c = new TerrainGenerator(1235, reg, biomes, terrain).generate(5, -3);
    const d = a.generate(5, -3);
    let diff = 0;
    for (let i = 0; i < c.length; i++) if (c[i] !== d[i]) diff++;
    check('another seed gives other terrain', diff > 1000, `${diff} voxels differ`);
}

// ── One column is exactly the chunk's ────────────────────────────────────────
{
    const geo = new Geography(99, new BiomeSet(biomes));
    let bad = 0, n = 0;
    for (const [cx, cz] of [[0, 0], [3, -8], [-20, 14], [61, 7]]) {
        const R = geo.region(cx * N, cz * N, N);
        const top = Int16Array.from(R.top), water = Int16Array.from(R.water), biome = Uint8Array.from(R.biome);
        const slope = Float32Array.from(R.slope), temp = Float32Array.from(R.temp), wf = Int16Array.from(R.wetFloor);
        for (const [lx, lz] of [[0, 0], [15, 0], [0, 15], [15, 15], [7, 9], [15, 4], [2, 15]]) {
            const c = geo.column(cx * N + lx, cz * N + lz), i = lx * N + lz;
            n++;
            if (c.top !== top[i] || c.water !== water[i] || c.biome !== biome[i] || c.slope !== slope[i] ||
                c.temp !== temp[i] || c.wetFloor !== wf[i]) bad++;
        }
    }
    check('Geography.column() matches region() bit for bit (edges and corners included)', bad === 0, `${bad} of ${n} differ`);
}

// ── Water is contained ───────────────────────────────────────────────────────
// A block of 4×4 chunks with a ring of neighbours, in several kinds of country:
// every water block's side and bottom neighbours must be water, ice or solid.
function waterLeaks(seed, X, Z) {
    const gen = new TerrainGenerator(seed, reg, biomes, terrain);
    const water = reg.getByName('WATER').id, ice = reg.getByName('ICE').id;
    const pcx = Math.floor(X / N), pcz = Math.floor(Z / N);
    const chunks = new Map();
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) chunks.set(`${pcx + dx},${pcz + dz}`, gen.generate(pcx + dx, pcz + dz));
    const at = (x, y, z) => {
        const v = chunks.get(`${Math.floor(x / N)},${Math.floor(z / N)}`);
        const lx = ((x % N) + N) % N, lz = ((z % N) + N) % N;
        return v[lx + (y - WORLD_MIN_Y) * N + lz * SZ];
    };
    let leaks = 0, waterBlocks = 0, where = '';
    for (let x = (pcx - 2) * N; x < (pcx + 3) * N; x++) for (let z = (pcz - 2) * N; z < (pcz + 3) * N; z++) {
        for (let y = WORLD_MIN_Y + 1; y < WORLD_MIN_Y + CHUNK_SIZE_Y - 1; y++) {
            if (at(x, y, z) !== water) continue;
            waterBlocks++;
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
                const id = at(x + dx, y + dy, z + dz);
                if (id === water || id === ice) continue;
                if (id === 0 || reg.isNoCollision(id) && !reg.isLiquid(id) && id !== 0 && !reg.get(id).leaves) {
                    if (id === 0) { leaks++; if (!where) where = `${x},${y},${z}`; }
                }
            }
        }
    }
    return { leaks, waterBlocks, where };
}
{
    const spots = [];
    const geo = new Geography(4242, new BiomeSet(biomes));
    // Find a lake, a river, a coast, a swamp and a fjord to test against.
    const find = (pred) => {
        for (let r = 0; r < 8000; r += 64) for (let k = 0, n = Math.max(1, Math.round(r / 10)); k < n; k++) {
            const a = k / n * Math.PI * 2, x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
            const c = geo.column(x, z);
            if (pred(c)) return [x, z];
        }
        return null;
    };
    const name = (c) => geo.biomes.list[c.biome].name;
    spots.push(['lake', find(c => c.flags & 1 && c.water > 70)]);
    spots.push(['river', find(c => name(c) === 'RIVER')]);
    spots.push(['coast', find(c => name(c) === 'BEACH')]);
    spots.push(['swamp', find(c => name(c) === 'SWAMP')]);
    spots.push(['cold coast', find(c => c.water !== NO_WATER && c.temp < 0.25 && c.top < 55)]);
    for (const [label, p] of spots) {
        if (!p) { check(`water contained: ${label}`, false, 'no such place found'); continue; }
        const r = waterLeaks(4242, p[0], p[1]);
        check(`water contained: ${label} at ${p[0]},${p[1]}`, r.leaks === 0 && r.waterBlocks > 0,
              `${r.waterBlocks} water blocks, ${r.leaks} beside or above air${r.where ? ' e.g. ' + r.where : ''}`);
    }
}

// ── Data ─────────────────────────────────────────────────────────────────────
{
    const names = new Set(blocks.map(b => b.name));
    const missing = new Set();
    const need = (n) => { if (n && !names.has(n)) missing.add(n); };
    for (const b of biomes) {
        const s = b.surface ?? {};
        need(s.top); need(s.stone); need(s.snow); need(s.deep);
        for (const l of s.layers ?? []) need(l.block);
        for (const c of [s.steep, s.underwater]) {
            if (typeof c === 'string') need(c);
            else if (c) { need(c.top); for (const l of c.layers ?? []) need(l.block); }
        }
        for (const p of [...(s.patches ?? []), ...(s.underwaterPatches ?? [])]) need(p.block);
        for (const n of s.bands ?? []) need(n);
        for (const o of b.ores ?? []) need(o.block);
    }
    for (const g of terrain) {
        need(g.stone); need(g.bedrock); need(g.deepStone?.block);
        for (const b of g.rockBlobs ?? []) need(b.block);
        for (const o of g.ores ?? []) need(o.block);
        for (const n of [...(g.oreHosts ?? []), ...(g.blobHosts ?? [])]) need(n);
    }
    check('every block the biomes and geology name exists', missing.size === 0, [...missing].join(', '));
    const ids = blocks.map(b => b.id);
    check('block ids are unique', new Set(ids).size === ids.length);
    const tex = blocks.flatMap(b => b.texture ? [b.texture] : b.textures ? Object.values(b.textures) : []);
    const gone = tex.filter(t => !fs.existsSync(path.join(root, 'data/textures/blocks', t)));
    check('every texture a block names exists', gone.length === 0, gone.join(', '));
}

// ── Balance ──────────────────────────────────────────────────────────────────
{
    const seen = new Set();
    for (const seed of [4242, 777, 31337, 2024]) {
        const geo = new Geography(seed, new BiomeSet(biomes));
        let land = 0, n = 0, rivers = 0, lakes = 0;
        for (let x = -7000; x <= 7000; x += 50) for (let z = -7000; z <= 7000; z += 50) {
            const c = geo.column(x, z);
            n++;
            seen.add(geo.biomes.list[c.biome].name);
            if (c.water === NO_WATER) land++;
            if (c.flags & 2 && c.water !== NO_WATER) rivers++;
            if (c.flags & 1) lakes++;
        }
        const f = land / n;
        check(`seed ${seed}: land is ${(f * 100).toFixed(0)}% of the world`, f > 0.4 && f < 0.75,
              `rivers ${(100 * rivers / n).toFixed(1)}%, lakes ${(100 * lakes / n).toFixed(2)}%`);
    }
    const all = biomes.map(b => b.name);
    const never = all.filter(b => !seen.has(b));
    check('every biome appears on some seed', never.length === 0, never.join(', '));
}

// ── Speed ────────────────────────────────────────────────────────────────────
{
    const gen = new TerrainGenerator(4242, reg, biomes, terrain);
    for (let i = 0; i < 6; i++) gen.generate(100 + i, 100);    // warm up
    const t0 = performance.now();
    let n = 0;
    for (let cz = -5; cz <= 5; cz++) for (let cx = -5; cx <= 5; cx++, n++) gen.generate(cx, cz);
    const ms = (performance.now() - t0) / n;
    // About 3 ms on an idle 15 W laptop CPU. The limit only catches a gross
    // regression: a busy machine easily triples the time (npm run
    // bench:pipeline measures it properly).
    check('generation stays under 20 ms per chunk', ms < 20, `${ms.toFixed(2)} ms`);
}

// ── Flat worlds ──────────────────────────────────────────────────────────────
// No land is shaped: every column is level at FLAT_TOP and holds its layers
// and nothing else. (A normal world is untouched by any of it: the hashes and
// seams above are of generators made without `flat`.)
{
    const at = (v, lx, y, lz) => v[lx + (y - WORLD_MIN_Y) * N + lz * SZ];
    const id = (n) => reg.getByName(n).id;
    const tops = (v) => {
        let level = true, above = 0;
        for (let lx = 0; lx < N; lx++) for (let lz = 0; lz < N; lz++) {
            if (at(v, lx, FLAT_TOP, lz) === 0) level = false;
            if (at(v, lx, FLAT_TOP + 1, lz) !== 0) above++;
        }
        return { level, above };
    };

    // The player's own layers: exactly the stack, top first, and air under it.
    const layers = [{ block: 'GRASS', depth: 1 }, { block: 'DIRT', depth: 3 }, { block: 'STONE', depth: 5 }, { block: 'BEDROCK', depth: 1 }];
    const bare = new TerrainGenerator(77, reg, biomes, terrain, { mode: 'layers', layers, biome: 'DESERT', decorations: false, structures: false });
    let exact = true, biomeOk = true;
    for (const [cx, cz] of [[0, 0], [-3, 5], [40, -17]]) {
        const v = bare.generate(cx, cz);
        for (let lx = 0; lx < N; lx++) for (let lz = 0; lz < N; lz++) {
            let y = FLAT_TOP;
            for (const l of layers) for (let k = 0; k < l.depth; k++, y--) if (at(v, lx, y, lz) !== id(l.block)) exact = false;
            for (let yy = WORLD_MIN_Y; yy <= y; yy++) if (at(v, lx, yy, lz) !== 0) exact = false;
            for (let yy = FLAT_TOP + 1; yy < FLAT_TOP + 40; yy++) if (at(v, lx, yy, lz) !== 0) exact = false;
        }
        for (let i = 0; i < N * N; i++) if (bare.biomes.list[bare.lastColumns.biome[i]].name !== 'DESERT') biomeOk = false;
    }
    check('flat world: the layers the player chose, and nothing else', exact);
    check('flat world: one biome throughout', biomeOk);

    // With decorations: still level, and things stand on it; the same chunk twice is the same.
    const wooded = { mode: 'layers', layers: [{ block: 'GRASS', depth: 1 }, { block: 'DIRT', depth: 3 }], biome: 'FOREST', decorations: true, structures: true };
    const a = new TerrainGenerator(77, reg, biomes, terrain, wooded), b = new TerrainGenerator(77, reg, biomes, terrain, wooded);
    let grown = 0, same = true, levelAll = true;
    for (let cx = -3; cx < 3; cx++) for (let cz = -3; cz < 3; cz++) {
        const va = a.generate(cx, cz), vb = b.generate(cx, cz);
        const t = tops(va);
        grown += t.above;
        if (!t.level) levelAll = false;
        for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) { same = false; break; }
    }
    check('flat world: trees grow on it when asked, and it is deterministic', grown > 50 && same && levelAll, `${grown} columns with something on them`);
    const none = new TerrainGenerator(77, reg, biomes, terrain, { ...wooded, decorations: false, structures: false });
    let stray = 0;
    for (let cx = -3; cx < 3; cx++) for (let cz = -3; cz < 3; cz++) stray += tops(none.generate(cx, cz)).above;
    check('flat world: nothing on it when not', stray === 0, `${stray}`);

    // Biomes by climate: level, dry, several biomes, each column its biome's own ground down to bedrock.
    const bio = new TerrainGenerator(4242, reg, biomes, terrain, { mode: 'biomes', decorations: false });
    const seen = new Set();
    let ok = true, air = 0;
    for (let cx = -24; cx < 24; cx += 3) for (let cz = -24; cz < 24; cz += 3) {
        const v = bio.generate(cx, cz), cols = bio.lastColumns;
        for (let i = 0; i < N * N; i++) {
            const bm = bio.biomes.list[cols.biome[i]];
            seen.add(bm.name);
            if (bm.category !== 'land' || cols.top[i] !== FLAT_TOP || cols.water[i] !== NO_WATER) ok = false;
        }
        const t = tops(v);
        if (!t.level || t.above) ok = false;
        for (let y = WORLD_MIN_Y; y <= FLAT_TOP; y++) if (at(v, 7, y, 9) === 0) air++;     // no caves
    }
    check('flat world by biome: level, dry land of several biomes, solid to bedrock', ok && seen.size >= 3 && air === 0,
          `${seen.size} biomes: ${[...seen].join(', ')}; ${air} holes`);
    const one = new Geography(4242, new BiomeSet(biomes), normaliseFlat({ mode: 'biomes' }));
    const reg16 = one.region(48, -160, 16), keep = Array.from(reg16.biome);
    let agree = true;
    for (let lx = 0; lx < 16; lx += 5) for (let lz = 0; lz < 16; lz += 5) if (one.column(48 + lx, -160 + lz).biome !== keep[lx * 16 + lz]) agree = false;
    check('flat world: one column is the chunk\'s', agree);
    const sp = one.findSpawn(123, -456);
    check('flat world: spawn is where it was asked for', sp.x === 123 && sp.z === -456);

    // What is stored is checked: nonsense becomes a usable world.
    const n = normaliseFlat({ mode: 'layers', layers: [{ block: 'air', depth: 3 }, { block: 'stone', depth: 999 }, { depth: 2 }] });
    check('flat settings are put right', n.layers.length === 1 && n.layers[0].block === 'STONE' && n.layers[0].depth === 64 && n.biome === 'PLAINS' &&
          normaliseFlat(null) === null && normaliseFlat({ mode: 'layers', layers: [] }).layers.length === 3);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
