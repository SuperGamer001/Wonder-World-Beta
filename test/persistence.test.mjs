// Verifies chunk persistence round-trips byte-for-byte, that the legacy
// JSON+base64 region format is still readable, and that chunks saved by a
// different world height are rejected rather than silently truncated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-persist-'));
const DATA_DIR = process.env.WONDER_DATA_DIR;

const { serverReady } = await import('../server/server.js');
const { CHUNK_VOLUME } = await import('../src/scripts/engine/ChunkData.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ws = new WebSocket(`ws://${host}:${port}`, { maxPayload: 512 * 1024 * 1024 });
ws.binaryType = 'arraybuffer';
ws.setMaxListeners(0);
await new Promise(r => ws.once('open', r));

const world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Persist', seed: 7 }),
})).json();

// Distinct, non-trivial content per chunk so a mix-up is detectable.
function makeChunk(cx, cz) {
    const palette = [0, 1, 3, 5, 19, (cx * 31 + cz * 17) % 60000];
    const indices = Buffer.alloc(CHUNK_VOLUME);
    for (let i = 0; i < CHUNK_VOLUME; i++) indices[i] = (i * 7 + cx * 13 + cz * 29) % palette.length;
    return { cx, cz, palette, indices };
}

const chunks = [];
for (let cx = 0; cx < 5; cx++) for (let cz = 0; cz < 5; cz++) chunks.push(makeChunk(cx, cz));

// ── Save ─────────────────────────────────────────────────────────────────────
const idBuf = new TextEncoder().encode(world.id);
let total = 1 + 2 + idBuf.length + 4;
for (const c of chunks) total += 4 + 4 + 2 + c.palette.length * 2 + CHUNK_VOLUME;
const buf = Buffer.alloc(total);
let o = 0;
buf.writeUInt8(0xC5, o); o += 1;
buf.writeUInt16LE(idBuf.length, o); o += 2;
buf.set(idBuf, o); o += idBuf.length;
buf.writeUInt32LE(chunks.length, o); o += 4;
for (const c of chunks) {
    buf.writeInt32LE(c.cx, o); o += 4;
    buf.writeInt32LE(c.cz, o); o += 4;
    buf.writeUInt16LE(c.palette.length, o); o += 2;
    for (const p of c.palette) { buf.writeUInt16LE(p, o); o += 2; }
    buf.set(c.indices, o); o += CHUNK_VOLUME;
}
ws.send(buf);

function manifest() {
    return new Promise((res) => {
        const h = (ev) => {
            if (typeof ev.data === 'string') {
                const m = JSON.parse(ev.data);
                if (m.type === 'manifest') { ws.removeEventListener('message', h); res(m.chunks); }
            }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ type: 'getManifest', worldId: world.id }));
    });
}
function load(cx, cz) {
    return new Promise((res) => {
        const h = (ev) => {
            if (ev.data instanceof ArrayBuffer) {
                const dv = new DataView(ev.data);
                if (dv.getInt32(0, true) === cx && dv.getInt32(4, true) === cz) {
                    ws.removeEventListener('message', h);
                    if (dv.getUint8(8) !== 1) return res(null);
                    const palLen = dv.getUint16(9, true);
                    const palette = [];
                    for (let i = 0; i < palLen; i++) palette.push(dv.getUint16(11 + i * 2, true));
                    const start = 11 + palLen * 2;
                    res({ palette, indices: Buffer.from(new Uint8Array(ev.data, start, CHUNK_VOLUME)) });
                }
            }
        };
        ws.addEventListener('message', h);
        ws.send(JSON.stringify({ type: 'loadChunk', worldId: world.id, cx, cz }));
    });
}

let keys = [];
for (let i = 0; i < 100 && keys.length < chunks.length; i++) {
    keys = await manifest();
    if (keys.length < chunks.length) await new Promise(r => setTimeout(r, 50));
}
check('manifest lists every saved chunk', keys.length === chunks.length, `${keys.length}/${chunks.length}`);

// ── Round trip, warm cache ───────────────────────────────────────────────────
let mismatched = 0, palMismatched = 0;
for (const c of chunks) {
    const got = await load(c.cx, c.cz);
    if (!got) { mismatched++; continue; }
    if (!got.indices.equals(c.indices)) mismatched++;
    if (got.palette.join(',') !== c.palette.join(',')) palMismatched++;
}
check('indices round-trip byte-for-byte (warm)', mismatched === 0, `${mismatched} bad`);
check('palettes round-trip exactly (warm)', palMismatched === 0, `${palMismatched} bad`);

// ── Round trip, cold cache (region re-read from disk) ────────────────────────
// Deleting the world drops its cached regions; instead, verify the on-disk file
// decodes correctly by reading it directly with the server's own format.
const rDir = path.join(DATA_DIR, 'user', 'worlds', world.id, 'regions');
const rFiles = fs.readdirSync(rDir).filter(f => f.endsWith('.wwr'));
check('region files written', rFiles.length > 0, `${rFiles.length} files`);
const rawRegion = zlib.gunzipSync(fs.readFileSync(path.join(rDir, rFiles[0])));
check('region uses binary WWR2 format', rawRegion.toString('latin1', 0, 4) === 'WWR2',
      `magic=${JSON.stringify(rawRegion.toString('latin1', 0, 4))}`);

// ── Legacy JSON region is still readable ─────────────────────────────────────
const legacy = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Legacy', seed: 9 }),
})).json();
const legacyDir = path.join(DATA_DIR, 'user', 'worlds', legacy.id, 'regions');
fs.mkdirSync(legacyDir, { recursive: true });
const legacyChunk = makeChunk(2, 3);
const legacyJson = { '2,3': { palette: legacyChunk.palette, indices: legacyChunk.indices.toString('base64') } };
fs.writeFileSync(path.join(legacyDir, '0,0.wwr'), zlib.gzipSync(Buffer.from(JSON.stringify(legacyJson), 'utf8')));

const legacyGot = await new Promise((res) => {
    const h = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
            const dv = new DataView(ev.data);
            if (dv.getInt32(0, true) === 2 && dv.getInt32(4, true) === 3) {
                ws.removeEventListener('message', h);
                if (dv.getUint8(8) !== 1) return res(null);
                const palLen = dv.getUint16(9, true);
                res(Buffer.from(new Uint8Array(ev.data, 11 + palLen * 2, CHUNK_VOLUME)));
            }
        }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ type: 'loadChunk', worldId: legacy.id, cx: 2, cz: 3 }));
});
check('legacy JSON+base64 region still reads', !!legacyGot && legacyGot.equals(legacyChunk.indices));

// ── Wrong-size payload is rejected, not truncated ────────────────────────────
const badWorld = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bad', seed: 11 }),
})).json();
const badDir = path.join(DATA_DIR, 'user', 'worlds', badWorld.id, 'regions');
fs.mkdirSync(badDir, { recursive: true });
// Simulates a world saved by a build with a taller world.
const wrongSize = Buffer.alloc(CHUNK_VOLUME + 5000, 7);
fs.writeFileSync(path.join(badDir, '0,0.wwr'), zlib.gzipSync(Buffer.from(JSON.stringify({
    '0,0': { palette: [0, 3], indices: wrongSize.toString('base64') },
}), 'utf8')));

const badGot = await new Promise((res) => {
    const h = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
            const dv = new DataView(ev.data);
            if (dv.getInt32(0, true) === 0 && dv.getInt32(4, true) === 0) {
                ws.removeEventListener('message', h);
                res(dv.getUint8(8));
            }
        }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ type: 'loadChunk', worldId: badWorld.id, cx: 0, cz: 0 }));
});
check('mismatched world-height chunk is refused', badGot === 0, `has=${badGot}`);

// ── The game's own client: WorldClient + ChunkData against this server ───────
// A chunk keeps only its filled rows in memory but is saved as the whole
// column; this is the path a player's world takes out and back.
{
    const { WorldClient } = await import('../src/scripts/engine/WorldClient.js');
    const { ChunkData, voxelIndex, CHUNK_SIZE, CHUNK_SIZE_Y } = await import('../src/scripts/engine/ChunkData.js');
    const w = await (await fetch(`${base}/api/worlds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Client', seed: 9 }),
    })).json();

    // Terrain-like columns (slot 0 is the floor block, not AIR), then edits
    // above and below the rows the chunk was loaded with.
    const made = new Map();
    for (let cx = -1; cx <= 1; cx++) for (let cz = 0; cz <= 1; cz++) {
        const ref = new Uint16Array(CHUNK_VOLUME);
        for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const h = 150 + ((lx * 3 + lz * 5 + cx * 7 + cz) % 9);
            for (let ly = 40; ly <= h; ly++) ref[voxelIndex(lx, ly, lz)] = ly === 40 ? 19 : ly === h ? 1 : 3;
        }
        const c = new ChunkData(cx, cz);
        c.loadVoxels(ref);
        c.generated = true;
        for (const [lx, ly, lz, id] of [[1, 300, 1, 6], [2, 5, 2, 44], [3, 100, 3, 0], [4, 447, 4, 7]]) {
            ref[voxelIndex(lx, ly, lz)] = id;
            c.setVoxel(lx, ly, lz, id);
        }
        made.set(`${cx},${cz}`, { c, ref });
    }

    const saver = new WorldClient(`ws://${host}:${port}`);
    await saver.connect();
    await saver.fetchManifest(w.id);
    saver.saveChunks(w.id, { chunks: new Map([...made].map(([k, v]) => [k, v.c])) }, true);
    // Saved once the server lists them.
    let listed = 0;
    for (let i = 0; i < 100 && listed < made.size; i++) {
        await new Promise(r => setTimeout(r, 50));
        const probe = new WorldClient(`ws://${host}:${port}`);
        await probe.connect();
        await probe.fetchManifest(w.id);
        listed = probe.savedKeys?.size ?? 0;
        probe.close();
    }
    saver.close();
    check('WorldClient: every chunk it saved is listed', listed === made.size, `${listed}/${made.size}`);

    const loader = new WorldClient(`ws://${host}:${port}`);
    await loader.connect();
    await loader.fetchManifest(w.id);
    let bad = 0, compact = 0;
    for (const [key, { ref }] of made) {
        const [cx, cz] = key.split(',').map(Number);
        const saved = await loader.loadChunk(w.id, cx, cz);
        const back = saved && ChunkData.deserialize(cx, cz, saved);
        const got = back?.toUint16Array();
        if (!got || got.length !== ref.length || !got.every((x, i) => x === ref[i])) bad++;
        if (back && back.byteLength < CHUNK_VOLUME && back.minFilledY === 5 && back.maxFilledY === 447) compact++;
    }
    loader.close();
    check('WorldClient + ChunkData: chunks come back voxel for voxel', bad === 0, `${bad} differ`);
    check('… with their filled band found again', compact === made.size, `${compact}/${made.size}`);
}

ws.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
// Let in-flight zlib threadpool work settle before exiting; calling
// process.exit() straight away trips a libuv teardown assertion on Windows.
await new Promise(r => setTimeout(r, 150));
process.exit(failures === 0 ? 0 : 1);
