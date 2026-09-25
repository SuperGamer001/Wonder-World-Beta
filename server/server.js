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
import { CHUNK_VOLUME, CHUNK_SIZE_Y, WORLD_MIN_Y, WORLD_FORMAT } from '../src/scripts/engine/ChunkData.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ROOT         = path.join(__dirname, '..');
// Writable game data (world saves, settings, screenshots) lives under DATA_ROOT.
// In the packaged desktop (Electron) build the app files are read-only, so the
// launcher points WONDER_DATA_DIR at a per-user writable location. Defaults to
// the repo root for a plain `node server.js` run.
const DATA_ROOT    = process.env.WONDER_DATA_DIR ?? ROOT;
const WORLDS_DIR   = path.join(DATA_ROOT, 'user', 'worlds');
const SETTINGS_PATH = path.join(DATA_ROOT, 'user', 'settings.json');
// Port 0 asks the OS for any free port. A fixed port meant that anything else
// already bound to it — another dev server, Docker, a second copy of the app —
// made the desktop build fail to start with no window and no message at all.
// Set PORT explicitly to pin it (useful when running the server standalone and
// opening http://localhost:3000 by hand).
const PORT         = process.env.PORT != null ? Number(process.env.PORT) : 0;
// Loopback only. This server exposes read/write access to the player's saved
// worlds; binding all interfaces published that to every device on the network.
const HOST         = process.env.HOST ?? '127.0.0.1';
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

// ── Region cache ──────────────────────────────────────────────────────────────
// A region holds up to 64 chunk columns. Decoding one costs a gunzip plus a
// parse of several megabytes, and every chunk the client asked for used to pay
// that in full — 64 chunks in a region meant 64 complete decodes of the same
// file, serialised behind the region lock. Loading a saved world was ~13x
// slower than generating it from scratch.
//
// Regions are now decoded once and kept in memory, keyed by world and region
// coords, under a byte budget with least-recently-used eviction.
const REGION_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const _regionCache = new Map();   // "worldId:rx,rz" -> { entries, bytes }
let   _regionCacheBytes = 0;

function _regionKey(id, rx, rz) { return `${id}:${rx},${rz}`; }

function _cacheGet(id, rx, rz) {
    const k = _regionKey(id, rx, rz);
    const hit = _regionCache.get(k);
    if (!hit) return null;
    // Refresh recency — Map preserves insertion order, so re-inserting moves it
    // to the end and the oldest entry is always first.
    _regionCache.delete(k);
    _regionCache.set(k, hit);
    return hit.entries;
}

function _cachePut(id, rx, rz, entries) {
    const k = _regionKey(id, rx, rz);
    const prev = _regionCache.get(k);
    if (prev) { _regionCacheBytes -= prev.bytes; _regionCache.delete(k); }

    let bytes = 0;
    for (const e of Object.values(entries)) bytes += e.indices.length + e.palette.length * 2 + 64;
    _regionCache.set(k, { entries, bytes });
    _regionCacheBytes += bytes;

    while (_regionCacheBytes > REGION_CACHE_MAX_BYTES && _regionCache.size > 1) {
        const oldest = _regionCache.keys().next().value;
        const dropped = _regionCache.get(oldest);
        _regionCache.delete(oldest);
        _regionCacheBytes -= dropped.bytes;
    }
}

/** Drop every cached region for a world (used when it is deleted). */
function _cacheDropWorld(id) {
    const prefix = `${id}:`;
    for (const [k, v] of [..._regionCache]) {
        if (k.startsWith(prefix)) { _regionCache.delete(k); _regionCacheBytes -= v.bytes; }
    }
    _manifestCache.delete(id);
}

// ── Region file format ────────────────────────────────────────────────────────
// v2 is a flat binary blob, gzipped:
//   "WWR2" | count:u16 | per chunk: lx:u8 lz:u8 palLen:u16 palette:u16* indices:u8*CHUNK_VOLUME
//
// The original format was JSON with base64-encoded indices, which inflated the
// payload by a third and made every read a multi-megabyte string parse. Old
// files are still read transparently and are rewritten as v2 on the next save.
const REGION_MAGIC = 'WWR2';

function _decodeRegion(raw) {
    if (raw.length >= 4 && raw.toString('latin1', 0, 4) === REGION_MAGIC) {
        const entries = {};
        let o = 4;
        const count = raw.readUInt16LE(o); o += 2;
        for (let i = 0; i < count; i++) {
            const lx = raw.readUInt8(o); o += 1;
            const lz = raw.readUInt8(o); o += 1;
            const palLen = raw.readUInt16LE(o); o += 2;
            const palette = new Array(palLen);
            for (let p = 0; p < palLen; p++) { palette[p] = raw.readUInt16LE(o); o += 2; }
            const indices = raw.subarray(o, o + CHUNK_VOLUME); o += CHUNK_VOLUME;
            entries[`${lx},${lz}`] = { palette, indices };
        }
        return entries;
    }

    // Legacy JSON form: { "lx,lz": { palette: [...], indices: "<base64>" } }
    const obj = JSON.parse(raw.toString('utf8'));
    const entries = {};
    for (const [k, v] of Object.entries(obj)) {
        entries[k] = {
            palette: Array.isArray(v.palette) ? v.palette : Array.from(v.palette ?? []),
            indices: Buffer.from(v.indices, 'base64'),
        };
    }
    return entries;
}

function _encodeRegion(entries) {
    const keys = Object.keys(entries);
    let size = 4 + 2;
    for (const k of keys) size += 1 + 1 + 2 + entries[k].palette.length * 2 + CHUNK_VOLUME;

    const buf = Buffer.allocUnsafe(size);
    buf.write(REGION_MAGIC, 0, 'latin1');
    let o = 4;
    buf.writeUInt16LE(keys.length, o); o += 2;
    for (const k of keys) {
        const [lx, lz] = k.split(',').map(Number);
        const { palette, indices } = entries[k];
        buf.writeUInt8(lx & 0xFF, o); o += 1;
        buf.writeUInt8(lz & 0xFF, o); o += 1;
        buf.writeUInt16LE(palette.length, o); o += 2;
        for (const p of palette) { buf.writeUInt16LE(p, o); o += 2; }
        // A chunk saved by a build with different world dimensions is skipped by
        // buildChunkResponse; pad or truncate so the file stays self-consistent.
        if (indices.length === CHUNK_VOLUME) buf.set(indices, o);
        else buf.set(indices.subarray(0, Math.min(indices.length, CHUNK_VOLUME)), o);
        o += CHUNK_VOLUME;
    }
    return buf;
}

async function readRegion(id, rx, rz) {
    const cached = _cacheGet(id, rx, rz);
    if (cached) return cached;

    const p = regionPath(id, rx, rz);
    if (!fs.existsSync(p)) return {};
    try {
        const raw = await gunzip(fs.readFileSync(p));
        const entries = _decodeRegion(raw);
        _cachePut(id, rx, rz, entries);
        return entries;
    } catch (err) {
        console.warn(`[server] region ${rx},${rz} unreadable:`, err?.message ?? err);
        return {};
    }
}

async function writeRegion(id, rx, rz, data) {
    fs.mkdirSync(regionsDir(id), { recursive: true });
    _cachePut(id, rx, rz, data);
    const compressed = await gzip(_encodeRegion(data));
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
    // A cache hit needs no lock: the entries object is replaced wholesale on
    // write, never mutated in place, so a reader always sees a consistent one.
    const cached = _cacheGet(id, rx, rz);
    if (cached) return cached[`${lx},${lz}`] ?? null;

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
    const savedKeys = [];
    for (const { cx, cz, palette, indices } of chunks) {
        const [rx, rz] = regionCoords(cx, cz);
        const [lx, lz] = localCoords(cx, cz);
        const rk = `${rx},${rz}`;
        if (!byRegion.has(rk)) byRegion.set(rk, { rx, rz, entries: {} });
        // Indices stay a Buffer all the way to disk now — the old base64 round
        // trip inflated the payload and made every region read a huge string parse.
        byRegion.get(rk).entries[`${lx},${lz}`] = { palette, indices: Buffer.from(indices) };
        savedKeys.push(`${cx},${cz}`);
    }
    // Read-merge-write each region under its lock so saves never clobber.
    await Promise.all([...byRegion.values()].map(({ rx, rz, entries }) =>
        withRegion(worldId, rx, rz, async () => {
            // Replace the entries object rather than mutating the cached one in
            // place, so a concurrent reader never observes a half-merged region.
            const merged = { ...await readRegion(worldId, rx, rz), ...entries };
            await writeRegion(worldId, rx, rz, merged);
        })));

    _recordSavedChunks(worldId, savedKeys);
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
// Same-origin only. This API can read, modify and delete the player's saved
// worlds, and a wildcard CORS policy let any web page the user happened to have
// open issue requests against it. The game itself is served from this origin,
// so it never needs a cross-origin grant.
app.use(cors({ origin: false }));
app.use(express.json({ limit: '8mb' }));   // generous limit for world screenshots
// Serve writable user data (e.g. world screenshots) from DATA_ROOT, which may
// differ from the app root in the packaged desktop build. Mounted before the
// app-root static handler so these paths resolve to the per-user location.
app.use('/user', express.static(path.join(DATA_ROOT, 'user')));
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
        // Stamped so a world saved by a build with different world dimensions
        // can be identified rather than silently misread.
        format: WORLD_FORMAT,
        worldHeight: CHUNK_SIZE_Y,
        worldMinY: WORLD_MIN_Y,
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
    // Drop cached regions and the key index — otherwise a new world that reused
    // the id (or a re-import) would read this one's data out of memory.
    _cacheDropWorld(req.params.id);
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

// ── Update status bridge ──────────────────────────────────────────────────────
// The Electron launcher owns the updater, but the UI that has to surface it
// lives in the renderer — which has no IPC channel, because the window runs with
// contextIsolation and sandbox on and no preload script. Both the launcher and
// this server run in the same process, so the launcher writes status here and
// the renderer reads it over HTTP like everything else it needs.
//
// Running `node server/server.js` directly (no Electron) leaves this at
// supported:false, and the UI simply shows nothing.
// Read once at startup so the UI can show the real version instead of a
// hardcoded string, whether or not an updater is present.
let _appVersion = '0.0.0';
try {
    _appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? _appVersion;
} catch { /* keep the placeholder */ }

const _updateState = {
    supported:      false,  // an updater is present at all
    checking:       false,
    available:      false,
    canAutoInstall: false,  // false => notify only, user downloads manually
    downloaded:     false,
    currentVersion: _appVersion,
    newVersion:     null,
    downloadUrl:    null,
    error:          null,
    lastChecked:    0,
};

let _onCheckRequested  = null;
let _onInstallRequested = null;

/** Called by the launcher to publish updater progress. */
export function setUpdateState(patch) { Object.assign(_updateState, patch); }

/** Called by the launcher to register manual check / install handlers. */
export function setUpdateHandlers({ onCheck, onInstall }) {
    _onCheckRequested   = onCheck   ?? null;
    _onInstallRequested = onInstall ?? null;
}

app.get('/api/update-status', (_req, res) => res.json(_updateState));

app.post('/api/update-check', async (_req, res) => {
    if (!_onCheckRequested) return res.json({ ..._updateState, supported: false });
    try { await _onCheckRequested(); } catch (err) {
        setUpdateState({ checking: false, error: String(err?.message ?? err) });
    }
    res.json(_updateState);
});

app.post('/api/update-install', async (_req, res) => {
    if (!_onInstallRequested || !_updateState.downloaded) {
        return res.status(409).json({ error: 'No downloaded update to install' });
    }
    res.json({ ok: true });
    // Respond first — this quits the app.
    setTimeout(() => { try { _onInstallRequested(); } catch { /* quitting anyway */ } }, 100);
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
const wss    = new WebSocketServer({
    server,
    perMessageDeflate: true,
    // WebSocket upgrades are not covered by CORS, so a page on any origin could
    // otherwise open a socket to this port and read or overwrite saved worlds.
    // Accept only connections that carry no Origin (a native client) or one
    // matching the local server itself.
    verifyClient: ({ origin }) => {
        if (!origin) return true;
        try {
            const host = new URL(origin).hostname;
            return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
        } catch {
            return false;
        }
    },
});

// ── WebSocket message handling ────────────────────────────────────────────────

wss.on('connection', (ws) => {
    ws.on('message', async (data, isBinary) => {
        try {
            if (isBinary) {
                await handleBinaryMessage(ws, data);
            } else {
                await handleTextMessage(ws, JSON.parse(data.toString()));
            }
        } catch (err) {
            // A malformed frame must not take the whole server down — an
            // unhandled rejection in this async handler would do exactly that.
            console.error('[server] websocket message failed:', err?.message ?? err);
        }
    });
    ws.on('error', (err) => console.error('[server] websocket error:', err?.message ?? err));
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
// Saved-chunk key index, per world. The manifest only needs the *keys* of saved
// chunks, but deriving them used to mean decoding every region file in the
// world on each open — an unbounded cost that grew with how much the player had
// explored. The key set is now kept in a small sidecar file and in memory.
const _manifestCache = new Map();   // worldId -> Set<"cx,cz">

function indexPath(id) { return path.join(worldDir(id), 'chunk-index.json'); }

function _recordSavedChunks(worldId, keys) {
    let set = _manifestCache.get(worldId);
    if (!set) { set = new Set(); _manifestCache.set(worldId, set); }
    let added = false;
    for (const k of keys) if (!set.has(k)) { set.add(k); added = true; }
    if (!added) return;
    try {
        fs.writeFileSync(indexPath(worldId), JSON.stringify([...set]));
    } catch (err) {
        // Non-fatal: a missing index just means the next open rebuilds it by
        // scanning, which is correct, only slower.
        console.warn('[server] could not write chunk index:', err?.message ?? err);
    }
}

async function buildManifest(worldId) {
    const cached = _manifestCache.get(worldId);
    if (cached) return [...cached];

    // Fast path — the sidecar index written alongside saves.
    try {
        const list = JSON.parse(fs.readFileSync(indexPath(worldId), 'utf8'));
        if (Array.isArray(list)) {
            _manifestCache.set(worldId, new Set(list));
            return list;
        }
    } catch { /* missing or corrupt — fall through to a rebuild */ }

    // Slow path — a world saved before the index existed. Scan once, then
    // persist the index so this never happens again for this world.
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
    _manifestCache.set(worldId, new Set());
    _recordSavedChunks(worldId, keys);
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
let _warnedStaleChunks = false;

function buildChunkResponse(cx, cz, entry) {
    // Region entries hold raw Buffers now; the base64 round trip is gone.
    const indices = entry ? entry.indices : null;

    // A chunk saved by a build with a different world height has a different
    // payload length. Buffer.copy would truncate it silently and hand back
    // corrupt terrain, so treat it as "not saved" and let the client regenerate.
    if (indices && indices.length !== CHUNK_VOLUME) {
        if (!_warnedStaleChunks) {
            _warnedStaleChunks = true;
            console.warn(
                `[server] ignoring saved chunks from an incompatible world format ` +
                `(payload ${indices.length} bytes, this build expects ${CHUNK_VOLUME}). ` +
                `Affected chunks will be regenerated from the world seed.`);
        }
        entry = null;
    }

    if (!entry) {
        // No data — 9 bytes (cx + cz + has)
        const buf = Buffer.alloc(9);
        buf.writeInt32LE(cx, 0);
        buf.writeInt32LE(cz, 4);
        buf.writeUInt8(0, 8);
        return buf;
    }

    const palette = entry.palette;
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

// Resolves once the HTTP + WebSocket server is accepting connections. The
// Electron launcher awaits this before opening the game window so the first
// request can't race server startup. Running `node server.js` directly still
// just starts the server as a side effect of importing this module.
export const serverReady = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
        // With PORT=0 the real port is only known once the socket is bound, so
        // callers (the Electron launcher) must read it from here rather than
        // assuming a constant.
        const port = server.address().port;
        console.log(`Wonder World server listening on http://${HOST}:${port}`);
        console.log(`Worlds stored in: ${WORLDS_DIR}`);
        resolve({ port, host: HOST });
    });
});
