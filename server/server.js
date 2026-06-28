/**
 * Wonder World V7 — World Save Server
 *
 * REST (HTTP) — world metadata CRUD:
 *   GET  /api/worlds              list worlds
 *   POST /api/worlds              create world  (body: { name, seed, gameMode })
 *   GET  /api/worlds/:id          get metadata
 *   PUT  /api/worlds/:id/player-state  save full player state
 *   GET  /api/worlds/:id/player-state  load full player state
 *   PUT  /api/worlds/:id/settings      update world settings (gameMode etc.)
 *   POST /api/worlds/:id/duplicate
 *   DEL  /api/worlds/:id
 *   GET  /api/settings            get global player settings
 *   PUT  /api/settings            update global player settings
 *   GET  /api/data/manifest       list all data JSON files by category
 *
 * WebSocket — chunk I/O (chunks are 16×CHUNK_SIZE_Y×16 columns, addressed by cx,cz only):
 *   Client→Server text:   { type:'loadChunk', worldId, cx, cz }
 *   Server→Client binary: [cx:i32][cz:i32][has:u8]([palLen:u16][pal:u16*][idx:u8*CHUNK_VOLUME])
 *
 *   Client→Server binary (batch save):
 *     [0xC5:u8][worldIdLen:u16][worldId:utf8][count:u32]
 *     per chunk: [cx:i32][cz:i32][palLen:u16][pal:u16*][idx:u8*CHUNK_VOLUME]
 *
 * Region file format (gzip-compressed JSON):
 *   File: user/worlds/{id}/regions/{rx},{rz}.wwr
 *   One region covers 8×8 chunk columns (XZ only).
 *   JSON: { "lx,lz": { palette:[u16…], indices:"base64" }, … }
 *
 * Start: cd server && npm install && npm start
 */

import express        from 'express';
import cors           from 'cors';
import { WebSocketServer } from 'ws';
import http           from 'http';
import fs             from 'fs';
import path           from 'path';
import zlib           from 'zlib';
import { promisify }  from 'util';
import { fileURLToPath } from 'url';
import crypto         from 'crypto';
// Single source of truth for chunk dimensions — keeps the binary save/load
// format byte-for-byte identical to the client. If CHUNK_SIZE_Y changes on the
// client, the server picks it up automatically (no stale hardcoded volume).
import { CHUNK_VOLUME } from '../src/scripts/engine/ChunkData.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ROOT         = path.join(__dirname, '..');
const WORLDS_DIR   = path.join(ROOT, 'user', 'worlds');
const SETTINGS_PATH = path.join(ROOT, 'user', 'settings.json');
const PORT         = process.env.PORT ?? 3000;
const REGION_BITS = 3;                 // 2^3 = 8 chunk columns per axis per region

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

fs.mkdirSync(WORLDS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function worldDir(id)         { return path.join(WORLDS_DIR, id); }
function worldMetaPath(id)    { return path.join(worldDir(id), 'world.json'); }
function playerStatePath(id)  { return path.join(worldDir(id), 'player.json'); }
function screenshotPath(id)   { return path.join(worldDir(id), 'screenshot.jpg'); }
function regionsDir(id)       { return path.join(worldDir(id), 'regions'); }

function regionPath(id, rx, rz) {
    return path.join(regionsDir(id), `${rx},${rz}.wwr`);
}

function regionCoords(cx, cz) {
    return [cx >> REGION_BITS, cz >> REGION_BITS];
}

function localCoords(cx, cz) {
    const M = (1 << REGION_BITS) - 1;
    return [cx & M, cz & M];
}

function readMeta(id) {
    try { return JSON.parse(fs.readFileSync(worldMetaPath(id), 'utf8')); }
    catch { return null; }
}

function writeMeta(id, meta) {
    fs.writeFileSync(worldMetaPath(id), JSON.stringify(meta, null, 2));
}

function listWorlds() {
    if (!fs.existsSync(WORLDS_DIR)) return [];
    return fs.readdirSync(WORLDS_DIR)
        .filter(n => fs.existsSync(path.join(WORLDS_DIR, n, 'world.json')))
        .map(n => readMeta(n))
        .filter(Boolean)
        .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
}

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
    }
}

// ── Region I/O ─────────────────────────────────────────────────────────────────

// Per-region async mutex. Region files use read-merge-write, so concurrent saves
// (autosave batch overlapping an unload-save) or a load reading mid-write would
// otherwise clobber each other and silently lose edits. Every read/write of a
// given region funnels through its lock so they run strictly one at a time.
const _regionLocks = new Map();

function withRegion(worldId, rx, rz, fn) {
    const key  = `${worldId}:${rx},${rz}`;
    const prev = _regionLocks.get(key) ?? Promise.resolve();
    const run  = prev.then(fn, fn);                       // run fn after prev settles (ok or not)
    const tail = run.then(() => {}, () => {});            // chain link that never rejects
    _regionLocks.set(key, tail);
    // Drop the entry once the chain is idle so the map doesn't grow unboundedly.
    tail.then(() => { if (_regionLocks.get(key) === tail) _regionLocks.delete(key); });
    return run;
}

async function readRegion(id, rx, rz) {
    const p = regionPath(id, rx, rz);
    if (!fs.existsSync(p)) return {};
    try {
        const data = await gunzip(fs.readFileSync(p));
        return JSON.parse(data.toString('utf8'));
    } catch { return {}; }
}

async function writeRegion(id, rx, rz, data) {
    fs.mkdirSync(regionsDir(id), { recursive: true });
    const compressed = await gzip(Buffer.from(JSON.stringify(data), 'utf8'));
    // Write to a temp file then rename so a concurrent read never sees a partial
    // (and therefore corrupt / "empty") region file.
    const dst = regionPath(id, rx, rz);
    const tmp = `${dst}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, compressed);
    fs.renameSync(tmp, dst);
}

async function getChunkFromRegion(id, cx, cz) {
    const [rx, rz] = regionCoords(cx, cz);
    const [lx, lz] = localCoords(cx, cz);
    return withRegion(id, rx, rz, async () => {
        const region = await readRegion(id, rx, rz);
        return region[`${lx},${lz}`] ?? null;
    });
}

/**
 * Write a batch of chunks. Grouped by region so each file is read/written once.
 * `chunks` is an array of { cx, cz, palette: number[], indices: Buffer }
 */
async function saveChunkBatch(worldId, chunks) {
    const byRegion = new Map();
    for (const { cx, cz, palette, indices } of chunks) {
        const [rx, rz] = regionCoords(cx, cz);
        const [lx, lz] = localCoords(cx, cz);
        const rk = `${rx},${rz}`;
        if (!byRegion.has(rk)) byRegion.set(rk, { rx, rz, entries: {} });
        byRegion.get(rk).entries[`${lx},${lz}`] = {
            palette,
            indices: Buffer.from(indices).toString('base64'),
        };
    }
    // Read-merge-write each region under its lock so saves never clobber.
    await Promise.all([...byRegion.values()].map(({ rx, rz, entries }) =>
        withRegion(worldId, rx, rz, async () => {
            const existing = await readRegion(worldId, rx, rz);
            Object.assign(existing, entries);
            await writeRegion(worldId, rx, rz, existing);
        })));
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));   // generous limit for world screenshots
app.use(express.static(ROOT));

// World list
app.get('/api/worlds', (_req, res) => res.json(listWorlds()));

// Create world
app.post('/api/worlds', (req, res) => {
    const { name = 'New World', seed, gameMode = 'SURVIVAL', difficulty = 'NORMAL' } = req.body ?? {};
    const id  = crypto.randomUUID();
    const now = Date.now();
    const meta = {
        id, name: String(name).trim() || 'New World',
        seed: seed != null ? Number(seed) : (Math.random() * 2147483647 | 0),
        created: now, lastPlayed: now,
        gameMode: ['SURVIVAL','CREATIVE','SPECTATOR'].includes(gameMode) ? gameMode : 'SURVIVAL',
        difficulty: ['PEACEFUL','EASY','NORMAL','HARD'].includes(difficulty) ? difficulty : 'NORMAL',
        playerPos: { x: 0, y: 100, z: 0 },
    };
    fs.mkdirSync(worldDir(id), { recursive: true });
    writeMeta(id, meta);
    res.status(201).json(meta);
});

// Get metadata
app.get('/api/worlds/:id', (req, res) => {
    const meta = readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    res.json(meta);
});

// Delete world
app.delete('/api/worlds/:id', (req, res) => {
    const d = worldDir(req.params.id);
    if (!fs.existsSync(d)) return res.status(404).json({ error: 'Not found' });
    fs.rmSync(d, { recursive: true, force: true });
    res.json({ ok: true });
});

// Duplicate world
app.post('/api/worlds/:id/duplicate', (req, res) => {
    const src = readMeta(req.params.id);
    if (!src) return res.status(404).json({ error: 'Not found' });
    const newId = crypto.randomUUID(), now = Date.now();
    copyDir(worldDir(req.params.id), worldDir(newId));
    const meta = { ...src, id: newId, name: `${src.name} (Copy)`, created: now, lastPlayed: now };
    writeMeta(newId, meta);
    res.status(201).json(meta);
});

// Legacy player position (kept for backwards compat)
app.put('/api/worlds/:id/player-pos', (req, res) => {
    const meta = readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    const { x, y, z } = req.body ?? {};
    meta.playerPos = { x: Number(x) || 0, y: Number(y) || 0, z: Number(z) || 0 };
    meta.lastPlayed = Date.now();
    writeMeta(req.params.id, meta);
    res.json({ ok: true });
});

// Save full player state
app.put('/api/worlds/:id/player-state', (req, res) => {
    const meta = readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    const state = req.body ?? {};
    if (state.position) meta.playerPos = state.position;
    meta.lastPlayed = Date.now();
    writeMeta(req.params.id, meta);
    fs.writeFileSync(playerStatePath(req.params.id), JSON.stringify(state, null, 2));
    res.json({ ok: true });
});

// Save a world screenshot (JPEG data URL) — written next to the save files and
// served back via the static mount at /user/worlds/:id/screenshot.jpg.
app.put('/api/worlds/:id/screenshot', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const dataUrl = req.body?.dataUrl ?? '';
    const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'Bad image data' });
    try {
        fs.writeFileSync(screenshotPath(req.params.id), Buffer.from(m[1], 'base64'));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Write failed' });
    }
});

// Load full player state
app.get('/api/worlds/:id/player-state', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    try {
        const raw = fs.readFileSync(playerStatePath(req.params.id), 'utf8');
        res.json(JSON.parse(raw));
    } catch { res.json(null); }
});

// Update world settings (game mode etc.)
app.put('/api/worlds/:id/settings', (req, res) => {
    const meta = readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    const { gameMode, difficulty } = req.body ?? {};
    if (gameMode && ['SURVIVAL','CREATIVE','SPECTATOR'].includes(gameMode)) meta.gameMode = gameMode;
    if (difficulty && ['PEACEFUL','EASY','NORMAL','HARD'].includes(difficulty)) meta.difficulty = difficulty;
    writeMeta(req.params.id, meta);
    res.json({ ok: true });
});

// Global player settings
function readSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch { return {}; }
}

app.get('/api/settings', (_req, res) => res.json(readSettings()));

app.put('/api/settings', (req, res) => {
    const cur = readSettings();
    const merged = { ...cur, ...(req.body ?? {}) };
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
});

// Data manifest — lists all JSON files in data/blocks/, items/, biomes/, entities/, recipes/
app.get('/api/data/manifest', (_req, res) => {
    const dataDir = path.join(ROOT, 'data');
    const cats = ['blocks', 'items', 'biomes', 'entities', 'recipes'];
    const manifest = {};
    for (const cat of cats) {
        const dir = path.join(dataDir, cat);
        manifest[cat] = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => `data/${cat}/${f}`)
            : [];
    }
    res.json(manifest);
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ server, perMessageDeflate: true });

// ── WebSocket message handling ────────────────────────────────────────────────

wss.on('connection', (ws) => {
    ws.on('message', async (data, isBinary) => {
        if (isBinary) {
            await handleBinaryMessage(ws, data);
        } else {
            await handleTextMessage(ws, JSON.parse(data.toString()));
        }
    });
});

async function handleTextMessage(ws, msg) {
    if (msg.type === 'loadChunk') {
        const { worldId, cx, cz } = msg;
        const entry = await getChunkFromRegion(worldId, cx, cz);
        ws.send(buildChunkResponse(cx, cz, entry));
    } else if (msg.type === 'getManifest') {
        const { worldId } = msg;
        const chunks = await buildManifest(worldId);
        ws.send(JSON.stringify({ type: 'manifest', worldId, chunks }));
    }
}

/**
 * Return an array of "cx,cz" strings for every chunk column saved for this world.
 * Scans all region files and expands local coords back to world coords.
 */
async function buildManifest(worldId) {
    const rDir = regionsDir(worldId);
    if (!fs.existsSync(rDir)) return [];
    const keys = [];
    for (const file of fs.readdirSync(rDir)) {
        if (!file.endsWith('.wwr')) continue;
        const [rx, rz] = file.slice(0, -4).split(',').map(Number);
        const region = await readRegion(worldId, rx, rz);
        for (const lk of Object.keys(region)) {
            const [lx, lz] = lk.split(',').map(Number);
            keys.push(`${(rx << REGION_BITS) + lx},${(rz << REGION_BITS) + lz}`);
        }
    }
    return keys;
}

/**
 * Binary batch-save message layout:
 *   [0]:       0xC5 opcode
 *   [1..2]:    worldId length (uint16 LE)
 *   [3..3+wl-1]: worldId (UTF-8)
 *   [3+wl..6+wl]: chunk count (uint32 LE)
 *   per chunk: [cx:i32][cz:i32][palLen:u16][pal:u16*palLen][idx:u8*CHUNK_VOLUME]
 */
async function handleBinaryMessage(ws, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const opcode = buf.readUInt8(0);

    if (opcode !== 0xC5) return;

    const wl      = buf.readUInt16LE(1);
    const worldId = buf.toString('utf8', 3, 3 + wl);
    const count   = buf.readUInt32LE(3 + wl);

    let offset = 3 + wl + 4;
    const chunks = [];

    for (let i = 0; i < count; i++) {
        const cx     = buf.readInt32LE(offset);     offset += 4;
        const cz     = buf.readInt32LE(offset);     offset += 4;
        const palLen = buf.readUInt16LE(offset);    offset += 2;
        const palette = [];
        for (let p = 0; p < palLen; p++) {
            palette.push(buf.readUInt16LE(offset)); offset += 2;
        }
        const indices = buf.slice(offset, offset + CHUNK_VOLUME); offset += CHUNK_VOLUME;
        chunks.push({ cx, cz, palette, indices });
    }

    // Ensure the world exists before writing (ignore stale saves for deleted worlds)
    if (!readMeta(worldId)) return;

    await saveChunkBatch(worldId, chunks);
}

/**
 * Build the binary chunk response sent back to the client.
 * Layout: [cx:i32][cz:i32][has:u8]([palLen:u16][pal:u16*][idx:u8*CHUNK_VOLUME])
 */
function buildChunkResponse(cx, cz, entry) {
    if (!entry) {
        // No data — 9 bytes (cx + cz + has)
        const buf = Buffer.alloc(9);
        buf.writeInt32LE(cx, 0);
        buf.writeInt32LE(cz, 4);
        buf.writeUInt8(0, 8);
        return buf;
    }

    const palette = entry.palette;
    const indices = Buffer.from(entry.indices, 'base64');
    const palLen  = palette.length;
    const total   = 9 + 2 + palLen * 2 + CHUNK_VOLUME;
    const buf     = Buffer.alloc(total);

    buf.writeInt32LE(cx, 0);
    buf.writeInt32LE(cz, 4);
    buf.writeUInt8(1, 8);
    buf.writeUInt16LE(palLen, 9);
    for (let i = 0; i < palLen; i++) buf.writeUInt16LE(palette[i], 11 + i * 2);
    indices.copy(buf, 11 + palLen * 2);

    return buf;
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`Wonder World server listening on http://localhost:${PORT}`);
    console.log(`Worlds stored in: ${WORLDS_DIR}`);
});
