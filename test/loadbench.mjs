// Measures saved-world load cost over the real protocol, using real generated
// terrain so region sizes and compression are representative.
//
//   node test/loadbench.mjs [chunkCount]
//
// Phase 1 saves N chunks. Phase 2 re-execs this file against the same data
// directory with an empty cache, which is what actually happens when a player
// opens an existing world.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const COUNT = Number(process.argv[2] ?? 225);
const COLD  = process.env.WW_BENCH_COLD === '1';

const DATA_DIR = COLD
    ? process.env.WONDER_DATA_DIR
    : fs.mkdtempSync(path.join(os.tmpdir(), 'ww-bench-'));
process.env.WONDER_DATA_DIR = DATA_DIR;

const { serverReady } = await import('../server/server.js');
const { CHUNK_VOLUME } = await import('../src/scripts/engine/ChunkData.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;

const ws = new WebSocket(`ws://${host}:${port}`, { maxPayload: 512 * 1024 * 1024 });
ws.binaryType = 'arraybuffer';
ws.setMaxListeners(0);
await new Promise(r => ws.once('open', r));

const side = Math.ceil(Math.sqrt(COUNT));
const coords = [];
for (let i = 0; i < COUNT; i++) coords.push([i % side, (i / side) | 0]);

function manifestOnce(worldId) {
    return new Promise((res) => {
        const h = (ev) => {
            if (typeof ev.data === 'string') {
                const m = JSON.parse(ev.data);
                if (m.type === 'manifest') { ws.removeEventListener('message', h); res(m.chunks); }
            }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ type: 'getManifest', worldId }));
    });
}

function loadChunk(worldId, cx, cz) {
    return new Promise((res) => {
        const h = (ev) => {
            if (ev.data instanceof ArrayBuffer) {
                const dv = new DataView(ev.data);
                if (dv.getInt32(0, true) === cx && dv.getInt32(4, true) === cz) {
                    ws.removeEventListener('message', h);
                    res(dv.getUint8(8) === 1);
                }
            }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ type: 'loadChunk', worldId, cx, cz }));
    });
}

// ChunkManager dispatches up to MAX_DISPATCH (32) per frame.
async function loadAll(worldId) {
    let hits = 0;
    for (let i = 0; i < coords.length; i += 32) {
        const wave = coords.slice(i, i + 32);
        const got = await Promise.all(wave.map(([cx, cz]) => loadChunk(worldId, cx, cz)));
        hits += got.filter(Boolean).length;
    }
    return hits;
}

const worldsDir = path.join(DATA_DIR, 'user', 'worlds');

if (!COLD) {
    // ── Phase 1: generate real terrain and save it ───────────────────────────
    const { TerrainGenerator } = await import('../src/scripts/workers/TerrainGenerator.js');
    const { BlockRegistry }    = await import('../src/scripts/engine/BlockRegistry.js');
    const { ChunkData }        = await import('../src/scripts/engine/ChunkData.js');

    const root = path.join(path.dirname(__filename), '..');
    const reg = new BlockRegistry();
    for (const f of fs.readdirSync(path.join(root, 'data/blocks')))
        reg.register(JSON.parse(fs.readFileSync(path.join(root, 'data/blocks', f), 'utf8')));
    const readDir = (d) => fs.readdirSync(path.join(root, d)).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')));

    const gen = new TerrainGenerator(4242, reg, readDir('data/biomes'), readDir('data/terrain'));

    const world = await (await fetch(`${base}/api/worlds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bench', seed: 4242 }),
    })).json();
    fs.writeFileSync(path.join(DATA_DIR, 'bench-world-id'), world.id);

    let t = performance.now();
    const built = coords.map(([cx, cz]) => {
        const cd = new ChunkData(cx, cz);
        cd.loadVoxels(gen.generate(cx, cz));
        return cd;
    });
    const genMs = performance.now() - t;
    console.log(`generate ${COUNT} chunks fresh : ${genMs.toFixed(0)} ms  (${(genMs / COUNT).toFixed(2)} ms/chunk)`);

    const enc = new TextEncoder();
    const idBuf = enc.encode(world.id);
    let total = 1 + 2 + idBuf.length + 4;
    for (const cd of built) total += 4 + 4 + 2 + cd._palette.length * 2 + CHUNK_VOLUME;
    const buf = Buffer.alloc(total);
    let o = 0;
    buf.writeUInt8(0xC5, o); o += 1;
    buf.writeUInt16LE(idBuf.length, o); o += 2;
    buf.set(idBuf, o); o += idBuf.length;
    buf.writeUInt32LE(built.length, o); o += 4;
    for (const cd of built) {
        buf.writeInt32LE(cd.cx, o); o += 4;
        buf.writeInt32LE(cd.cz, o); o += 4;
        buf.writeUInt16LE(cd._palette.length, o); o += 2;
        for (const p of cd._palette) { buf.writeUInt16LE(p, o); o += 2; }
        cd.writeIndices(buf, o); o += CHUNK_VOLUME;
    }

    t = performance.now();
    ws.send(buf);
    let saved = [];
    for (let i = 0; i < 300; i++) {
        saved = await manifestOnce(world.id);
        if (saved.length >= coords.length) break;
        await new Promise(r => setTimeout(r, 100));
    }
    console.log(`save ${saved.length} chunks            : ${(performance.now() - t).toFixed(0)} ms`);

    const rDir = path.join(worldsDir, world.id, 'regions');
    const files = fs.readdirSync(rDir);
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(rDir, f)).size, 0);
    console.log(`on disk                       : ${files.length} regions, ${(bytes / 1024 / 1024).toFixed(2)} MB gzipped`);

    t = performance.now();
    const hits = await loadAll(world.id);
    const warmMs = performance.now() - t;
    console.log(`\nWARM load (cache populated)   : ${warmMs.toFixed(0)} ms  (${(warmMs / COUNT).toFixed(2)} ms/chunk, ${hits} hits)`);

    ws.close();

    // ── Phase 2: same data, fresh process, empty cache ───────────────────────
    console.log('\n--- cold open (fresh process, empty cache) ---');
    const r = spawnSync(process.execPath, [__filename, String(COUNT)], {
        env: { ...process.env, WW_BENCH_COLD: '1', WONDER_DATA_DIR: DATA_DIR },
        encoding: 'utf8',
    });
    process.stdout.write(r.stdout.split('\n').filter(l => !/Wonder World server|Worlds stored/.test(l)).join('\n'));
    if (r.stderr?.trim()) process.stderr.write(r.stderr);
    process.exit(0);
} else {
    // ── Cold path ────────────────────────────────────────────────────────────
    const worldId = fs.readFileSync(path.join(DATA_DIR, 'bench-world-id'), 'utf8').trim();

    let t = performance.now();
    const keys = await manifestOnce(worldId);
    console.log(`getManifest (cold)            : ${(performance.now() - t).toFixed(0)} ms  (${keys.length} keys)`);

    t = performance.now();
    const hits = await loadAll(worldId);
    const coldMs = performance.now() - t;
    console.log(`COLD load ${COUNT} saved chunks  : ${coldMs.toFixed(0)} ms  (${(coldMs / COUNT).toFixed(2)} ms/chunk, ${hits} hits)`);

    ws.close();
    process.exit(0);
}
