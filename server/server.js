/**
 * Wonder World V7 — World Save Server
 *
 * REST (HTTP) — world metadata CRUD:
 *   GET  /api/worlds              list worlds
 *   POST /api/worlds              create world  (body: { name, seed, gameMode })
 *   GET  /api/worlds/:id          get metadata
 *   PUT  /api/worlds/:id/player-state  save full player state
 *   GET  /api/worlds/:id/player-state  load full player state
 *   GET  /api/worlds/:id/far-edits     surfaces of the chunks the player has changed
 *   PUT  /api/worlds/:id/far-edits     … add to them (for far terrain)
 *   PUT  /api/worlds/:id/settings      update world settings (gameMode, difficulty,
 *                                      daylightCycle, weather, and the hidden terrainStyle)
 *   POST /api/worlds/:id/duplicate
 *   DEL  /api/worlds/:id
 *   GET  /api/settings            get global player settings
 *   PUT  /api/settings            update global player settings
 *   GET  /api/data/manifest       list all data JSON files by category
 *   POST /api/lan/open | close    let players on the network into a world (see *On the network*)
 *   GET  /api/lan/status | games | info
 *   GET  /api/worlds/:id/pending-edits   blocks changed in chunks this game never had loaded
 *   PUT  /api/worlds/:id/pending-edits   … all of them, replacing what was kept
 *   GET  /api/worlds/:id/containers      what is in the world's chests
 *   PUT  /api/worlds/:id/containers      … all of them, replacing what was kept
 *   GET  /api/worlds/:id/mobs            the world's mobs, as they were when it was last saved
 *   PUT  /api/worlds/:id/mobs            … all of them, replacing what was kept
 *   GET  /api/reports             what went wrong lately (errors and crashes), newest first
 *   POST /api/reports             … one more;  DELETE … forget them
 *   GET  /api/online/config       where the online token service is (see *Online*)
 *   POST /api/online/auth/host | token, GET …/rooms   … which is this server, on a developer's machine (WW_ABLY_KEY)
 *
 * WebSocket — multiplayer: every `mp:*` text message goes to multiplayer.js.
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
import os             from 'os';
import dgram          from 'dgram';
import { MultiplayerHub } from './multiplayer.js';
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

// ── Hidden world setting: terrain style ───────────────────────────────────────
// 'smooth' — Mesh blocks (see "terrainType" in data/blocks/*.json) deform into
//            smooth terrain; Solid blocks stay cubes. The default.
// 'blocky' — the classic cube world.
//
// Deliberately absent from every settings screen. Each world stores its own
// value as "terrainStyle" in user/worlds/<id>/world.json; edit that to switch an
// existing world, or change TERRAIN_STYLE to pick what new worlds get. It is read
// only when a world starts loading, so a change applies on the next load.
//
// Worlds made before this setting existed have no value and load blocky — that
// is how they were built (see startWorld in src/main.js).
//
// Voxel data and the save format are identical in both styles, so a world can
// be switched back and forth freely.
const TERRAIN_STYLES = ['blocky', 'smooth'];
const TERRAIN_STYLE  = 'smooth';

// ── World generator version ───────────────────────────────────────────────────
// Stamped into each new world as "worldGen" (see TerrainGenerator.js
// WORLD_GEN). A world keeps generating with the generator it was made with, so
// unexplored land still matches explored land: worlds without the field
// predate the current generator and use workers/legacy/. Bump this — and keep
// the previous generator as legacy — when a change would alter the terrain of
// existing worlds.
const WORLD_GEN = 2;

const gzip   = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

fs.mkdirSync(WORLDS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function worldDir(id)         { return path.join(WORLDS_DIR, id); }
function worldMetaPath(id)    { return path.join(worldDir(id), 'world.json'); }
function playerStatePath(id)  { return path.join(worldDir(id), 'player.json'); }
// Everyone but the world's owner — the other players of a split screen, and
// those who joined over the network — has a file of their own, by the id their
// game gave (settings: clientId).
function guestStatePath(id, player) {
    return path.join(worldDir(id), 'players', `${String(player).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.json`);
}
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

// ── On the network ────────────────────────────────────────────────────────────
// The server listens on this machine only. When the player opens a world to the
// network (POST /api/lan/open, from the pause menu) a second listener is
// started on every interface, and what comes in through it is a guest: it may
// fetch the game itself and play in the one world that is open — its chunks,
// its own player file, the multiplayer session — and nothing else. Not the
// list of worlds, not another world, not the settings, not a way to delete or
// make anything. Guests run this copy of the game (their browser or their own
// app loads it from here), so both ends are always the same version.
const LAN_PORT    = Number(process.env.WW_LAN_PORT ?? 25599);
const BEACON_PORT = Number(process.env.WW_BEACON_PORT ?? 25598);
const lan = { worldId: null, server: null, wss: null, port: 0, beacon: null, timer: null };
const GUEST_FILES = /^\/(index\.(html|css|js)|game\.html)$/;
const GUEST_DIRS  = /^\/(src|data|gamepacks|node_modules\/three\/build)\//;

app.use((req, res, next) => {
    if (!lan.server || req.socket.localPort !== lan.port) return next();     // the player's own machine
    req.lan = true;
    let p;
    try { p = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
    if (!lan.worldId || p.includes('..') || p.includes('\\') || p.includes('\0')) return res.status(403).json({ error: 'Not open' });
    const world = `/api/worlds/${lan.worldId}`, get = req.method === 'GET', put = req.method === 'PUT';
    const ok =
        (get && (p === '/' || GUEST_FILES.test(p) || GUEST_DIRS.test(p))) ||
        (get && ['/api/data/manifest', '/api/data/bundle', '/api/lan/info', '/api/settings', '/api/update-status', '/api/online/config', world, `${world}/far-edits`].includes(p)) ||
        ((get || put) && p === `${world}/player-state` && typeof req.query.player === 'string' && req.query.player.length > 0) ||
        (put && p === `${world}/far-edits`);
    if (!ok) return res.status(403).json({ error: 'Not for guests' });
    next();
});

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

/**
 * A Flat world's settings as they are stored: the same checks as the game's
 * normaliseFlat (src/scripts/engine/FlatWorld.js), which the generator runs
 * again on what it is given. `mode` 'layers' — the player's own stack, top
 * first, and one biome — or 'biomes' — biomes by climate, each with its own
 * ground; `decorations` (trees and plants) and `structures` (buildings).
 */
function cleanFlat(raw) {
    const mode = raw?.mode === 'biomes' ? 'biomes' : 'layers';
    const layers = [];
    if (mode === 'layers') {
        for (const l of Array.isArray(raw?.layers) ? raw.layers.slice(0, 16) : []) {
            const block = String(l?.block ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
            const depth = Math.max(1, Math.min(64, Math.round(Number(l?.depth) || 1)));
            if (block && block !== 'AIR') layers.push({ block, depth });
        }
        if (layers.length === 0) layers.push({ block: 'GRASS', depth: 1 }, { block: 'DIRT', depth: 3 }, { block: 'BEDROCK', depth: 1 });
    }
    return {
        mode, layers,
        biome: mode === 'layers' ? String(raw?.biome ?? 'PLAINS').toUpperCase().replace(/[^A-Z0-9_]/g, '') : null,
        decorations: raw?.decorations !== false,
        structures: !!raw?.structures,
    };
}

// Create world
app.post('/api/worlds', (req, res) => {
    const { name = 'New World', seed, gameMode = 'SURVIVAL', difficulty = 'NORMAL', worldType, flat } = req.body ?? {};
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
        terrainStyle: TERRAIN_STYLE,
        worldGen: WORLD_GEN,
    };
    // A Flat world: level ground made of what `flat` says (cleanFlat). Fixed
    // when the world is made, like its seed — the land already generated
    // would not match anything else.
    if (worldType === 'flat') { meta.worldType = 'flat'; meta.flat = cleanFlat(flat); }
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

// ── Export and import ─────────────────────────────────────────────────────────
//
// A world as one file (.wwworld), to keep somewhere or hand to someone:
//
//   "WWEX1\n"                       6 bytes
//   header length                   u32, little-endian
//   header                          JSON: { app, version, exported, world, files: [{ path, size }] }
//   every file's bytes, in the header's order
//
// `world` is the world's world.json, so a file can be told about without being
// read through; the files are everything in the world's folder, as it is on
// disk (regions are gzipped already, so the file is not compressed again and
// is written out as it is read). Nothing in the file is trusted on the way
// back in: `scanWorldFile` goes through all of it before a byte is kept.
// These routes are the owner's alone — a guest from the network reaches
// nothing that is not on the list at the top of the app.
const EXPORT_MAGIC   = Buffer.from('WWEX1\n', 'latin1');
const EXPORT_VERSION = 1;
const IMPORT_MAX     = 2 * 1024 * 1024 * 1024 - 1;     // bytes: what one Buffer may hold
const IMPORT_FILES   = 20000;
// What a world's folder holds, and so what an import may bring: its own files,
// one player file each, and regions by their coordinates.
const WORLD_FILE = /^(world\.json|player\.json|screenshot\.jpg|chunk-index\.json|far-edits\.json|pending-edits\.json|containers\.json|mobs\.json|players\/[A-Za-z0-9_-]{1,80}\.json|regions\/-?\d{1,7},-?\d{1,7}\.wwr)$/;

function worldFiles(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...worldFiles(dir, p));
        else if (e.isFile() && WORLD_FILE.test(p)) out.push({ path: p, size: fs.statSync(path.join(dir, p)).size });
    }
    return out;
}

app.get('/api/worlds/:id/export', (req, res) => {
    const meta = readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    const dir = worldDir(req.params.id), files = worldFiles(dir);
    const header = Buffer.from(JSON.stringify({ app: 'WonderWorld', version: EXPORT_VERSION, exported: Date.now(), world: meta, files }));
    const size = Buffer.alloc(4);
    size.writeUInt32LE(header.length);
    const name = (String(meta.name ?? 'World').replace(/[^A-Za-z0-9 ._-]/g, '').trim() || 'World').slice(0, 60);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.wwworld"`);
    res.setHeader('Content-Length', EXPORT_MAGIC.length + 4 + header.length + files.reduce((n, f) => n + f.size, 0));
    res.write(EXPORT_MAGIC); res.write(size); res.write(header);
    // One file after another, each read as it is sent: a world can be large.
    let i = 0;
    const next = () => {
        if (i >= files.length) return res.end();
        const f = files[i++], stream = fs.createReadStream(path.join(dir, f.path), { end: Math.max(0, f.size - 1) });
        let sent = 0;
        if (f.size === 0) { stream.destroy(); return next(); }
        stream.on('data', (chunk) => { sent += chunk.length; });
        stream.on('error', () => res.destroy());                      // the length promised cannot be kept: the download fails, as it should
        stream.on('end', () => (sent === f.size ? next() : res.destroy()));
        stream.pipe(res, { end: false });
    };
    next();
});

/**
 * Go through a world file and say what it is, or why it will not do. Every
 * path is checked against what a world's folder may hold, the sizes against
 * the file's length, world.json against this build's world format, and every
 * region is opened and decoded — a file that is cut short or is not a world
 * is found out here, before anything is written.
 * Returns { ok, error?, world?, files?, chunks, regions, bytes, entries? }.
 */
async function scanWorldFile(buf) {
    const bad = (error) => ({ ok: false, error });
    if (!Buffer.isBuffer(buf) || buf.length < EXPORT_MAGIC.length + 4) return bad('This is not a Wonder World world file.');
    if (!buf.subarray(0, EXPORT_MAGIC.length).equals(EXPORT_MAGIC)) return bad('This is not a Wonder World world file.');
    let o = EXPORT_MAGIC.length;
    const headerLen = buf.readUInt32LE(o); o += 4;
    if (headerLen > 8 * 1024 * 1024 || o + headerLen > buf.length) return bad('The file is damaged: its list of contents is cut short.');
    let header;
    try { header = JSON.parse(buf.toString('utf8', o, o + headerLen)); } catch { return bad('The file is damaged: its list of contents cannot be read.'); }
    o += headerLen;
    if (header?.app !== 'WonderWorld' || !Array.isArray(header.files)) return bad('This is not a Wonder World world file.');
    if (header.version > EXPORT_VERSION) return bad('This world was exported by a newer version of Wonder World. Update the game to import it.');
    if (header.files.length > IMPORT_FILES) return bad('The file lists more files than a world has.');

    const entries = [], seen = new Set();
    for (const f of header.files) {
        const p = String(f?.path ?? ''), size = Number(f?.size);
        if (!WORLD_FILE.test(p) || seen.has(p)) return bad(`The file holds something that is not part of a world ("${p.slice(0, 60)}").`);
        if (!Number.isInteger(size) || size < 0 || o + size > buf.length) return bad('The file is cut short: part of the world is missing.');
        seen.add(p);
        entries.push({ path: p, data: buf.subarray(o, o + size) });
        o += size;
    }
    if (o !== buf.length) return bad('The file is damaged: it is longer than its contents.');

    const metaFile = entries.find(e => e.path === 'world.json');
    if (!metaFile) return bad('The file has no world in it (no world.json).');
    let world;
    try { world = JSON.parse(metaFile.data.toString('utf8')); } catch { return bad('The world\'s description (world.json) cannot be read.'); }
    if (!world || typeof world !== 'object' || !Number.isFinite(Number(world.seed))) return bad('The world\'s description (world.json) is not a world\'s.');
    if ((world.format ?? WORLD_FORMAT) !== WORLD_FORMAT || (world.worldHeight ?? CHUNK_SIZE_Y) !== CHUNK_SIZE_Y || (world.worldMinY ?? WORLD_MIN_Y) !== WORLD_MIN_Y) {
        return bad('This world was made by a version of the game whose worlds are a different height, and cannot be opened by this one.');
    }
    for (const e of entries) {
        if (!e.path.endsWith('.json') || e.path === 'world.json') continue;
        try { JSON.parse(e.data.toString('utf8')); } catch { return bad(`The file is damaged: "${e.path}" cannot be read.`); }
    }
    let chunks = 0, regions = 0;
    for (const e of entries) {
        if (!e.path.startsWith('regions/')) continue;
        try {
            const region = _decodeRegion(await gunzip(e.data));
            for (const c of Object.values(region)) if (c.indices.length !== CHUNK_VOLUME) throw new Error('size');
            chunks += Object.keys(region).length;
            regions++;
        } catch { return bad(`The file is damaged: part of the world's land ("${e.path}") cannot be read.`); }
    }
    return {
        ok: true, entries, chunks, regions, bytes: buf.length,
        world: {
            name: String(world.name ?? 'World').slice(0, 40), seed: Number(world.seed),
            gameMode: world.gameMode ?? 'SURVIVAL', difficulty: world.difficulty ?? 'NORMAL',
            worldType: world.worldType === 'flat' ? 'flat' : 'normal', lastPlayed: world.lastPlayed ?? null,
        },
        meta: world,
    };
}

const worldUpload = express.raw({ type: 'application/octet-stream', limit: IMPORT_MAX });

// Look at a world file: what world it is, or what is wrong with it. Keeps nothing.
app.post('/api/worlds/import/scan', worldUpload, async (req, res) => {
    const scan = await scanWorldFile(req.body);
    if (!scan.ok) return res.status(400).json({ ok: false, error: scan.error });
    res.json({ ok: true, world: scan.world, chunks: scan.chunks, regions: scan.regions, bytes: scan.bytes, files: scan.entries.length });
});

// Take a world file in, as a new world: it never replaces one that is here.
app.post('/api/worlds/import', worldUpload, async (req, res) => {
    const scan = await scanWorldFile(req.body);
    if (!scan.ok) return res.status(400).json({ ok: false, error: scan.error });
    const id = crypto.randomUUID(), now = Date.now(), dir = worldDir(id);
    const taken = new Set(listWorlds().map(w => w.name));
    let name = scan.world.name.trim() || 'World';
    if (taken.has(name)) name = `${name} (Imported)`.slice(0, 48);
    try {
        fs.mkdirSync(dir, { recursive: true });        // a world never played is its description and nothing else
        for (const e of scan.entries) {
            if (e.path === 'world.json') continue;
            const dst = path.join(dir, ...e.path.split('/'));
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, e.data);
        }
        // Its description last: a world is listed once it has one, so one that
        // was cut off half way through being written is never offered.
        const meta = { ...scan.meta, id, name, lastPlayed: now, imported: now };
        writeMeta(id, meta);
        _cacheDropWorld(id);
        res.status(201).json(meta);
    } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true });
        res.status(500).json({ ok: false, error: `The world could not be saved here: ${err?.message ?? err}` });
    }
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
    if (req.query.player) {
        // Another player of this world: their own file, and the world is not theirs to stamp.
        const file = guestStatePath(req.params.id, req.query.player);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state));
        return res.json({ ok: true });
    }
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
        const file = req.query.player ? guestStatePath(req.params.id, req.query.player) : playerStatePath(req.params.id);
        res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { res.json(null); }
});

// Update world settings (game mode etc.)
app.put('/api/worlds/:id/settings', (req, res) => {
    const meta = readMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    const { gameMode, difficulty, terrainStyle, daylightCycle, weather, ops, pvp } = req.body ?? {};
    if (gameMode && ['SURVIVAL','CREATIVE','SPECTATOR'].includes(gameMode)) meta.gameMode = gameMode;
    if (difficulty && ['PEACEFUL','EASY','NORMAL','HARD'].includes(difficulty)) meta.difficulty = difficulty;
    // Time and weather. `weather` is 'dynamic' or a weather type id held fixed;
    // the client ignores ids it does not know, so only the shape is checked here.
    if (typeof daylightCycle === 'boolean') meta.daylightCycle = daylightCycle;
    if (typeof weather === 'string' && /^[a-z_]{2,32}$/.test(weather)) meta.weather = weather;
    // Who has operator status besides the owner: each by the key of who they
    // are (world.js: *Who a player is*), with the name they had when it was given.
    if (Array.isArray(ops)) {
        const seen = new Set();
        meta.ops = ops.filter(o => o && typeof o.key === 'string' && /^[A-Za-z0-9|:_-]{4,120}$/.test(o.key) && !seen.has(o.key) && seen.add(o.key))
            .slice(0, 64).map(o => ({ key: o.key, name: String(o.name ?? '').replace(/[^\p{L}\p{N} ._'#-]/gu, '').slice(0, 24) }));
    }
    // Whether players can hurt each other.
    if (typeof pvp === 'boolean') meta.pvp = pvp;
    // Hidden — no UI sends this. Takes effect the next time the world loads.
    if (TERRAIN_STYLES.includes(terrainStyle)) meta.terrainStyle = terrainStyle;
    writeMeta(req.params.id, meta);
    res.json({ ok: true });
});

// What far terrain shows of the chunks the player has changed: for each, the
// highest block of every column and which block it is, as the client
// summarised it ("cx,cz" → base64 of 1024 bytes; see world.js). Kept beside
// the regions so it is copied and deleted with the world.
function farEditsPath(id) { return path.join(worldDir(id), 'far-edits.json'); }
function readFarEdits(id) {
    try { return JSON.parse(fs.readFileSync(farEditsPath(id), 'utf8')); }
    catch { return {}; }
}

app.get('/api/worlds/:id/far-edits', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(readFarEdits(req.params.id));
});

app.put('/api/worlds/:id/far-edits', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const all = readFarEdits(req.params.id);
    for (const [key, value] of Object.entries(req.body ?? {})) {
        if (/^-?\d+,-?\d+$/.test(key) && typeof value === 'string' && value.length <= 2048) all[key] = value;
    }
    fs.writeFileSync(farEditsPath(req.params.id), JSON.stringify(all));
    res.json({ ok: true });
});

// Blocks changed in chunks the owner's game never had loaded — by another
// player, far from the owner — kept as changes ("cx,cz" → [[voxelIndex,
// blockId], …]) until the chunk is next loaded there, when they are put down
// in it and it is saved whole (world.js: WorldState.pendingChanges). A guest
// on the network saves such a chunk itself; a guest of an online game cannot
// reach this server, and without this their building far from the host would
// be gone when the host quit. The whole set is sent each time and replaces
// what was kept.
const MAX_PENDING_CHUNKS = 20000, MAX_PENDING_PER_CHUNK = 8192;
function pendingEditsPath(id) { return path.join(worldDir(id), 'pending-edits.json'); }

app.get('/api/worlds/:id/pending-edits', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    try { res.json(JSON.parse(fs.readFileSync(pendingEditsPath(req.params.id), 'utf8'))); }
    catch { res.json({}); }
});

app.put('/api/worlds/:id/pending-edits', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const out = {};
    let chunks = 0;
    for (const [key, list] of Object.entries(req.body ?? {})) {
        if (chunks >= MAX_PENDING_CHUNKS) break;
        if (!/^-?\d{1,7},-?\d{1,7}$/.test(key) || !Array.isArray(list)) continue;
        const clean = [];
        for (const e of list.slice(0, MAX_PENDING_PER_CHUNK)) {
            if (Array.isArray(e) && Number.isInteger(e[0]) && e[0] >= 0 && e[0] < CHUNK_VOLUME &&
                Number.isInteger(e[1]) && e[1] >= 0 && e[1] <= 65535) clean.push([e[0], e[1]]);
        }
        if (clean.length) { out[key] = clean; chunks++; }
    }
    const file = pendingEditsPath(req.params.id);
    if (chunks === 0) { try { fs.rmSync(file, { force: true }); } catch { /* nothing kept */ } }
    else fs.writeFileSync(file, JSON.stringify(out));
    res.json({ ok: true });
});

// What is in the world's chests: "x,y,z" → its slots, each null or { itemId,
// count } (world.js: *Chests*). The owner's game keeps them and sends the
// whole set when any has changed; it replaces what was kept. Guests do not
// come here: they ask the owner's game, through the session.
const MAX_CONTAINERS = 20000, MAX_CONTAINER_SLOTS = 64;
function containersPath(id) { return path.join(worldDir(id), 'containers.json'); }

app.get('/api/worlds/:id/containers', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    try { res.json(JSON.parse(fs.readFileSync(containersPath(req.params.id), 'utf8'))); }
    catch { res.json({}); }
});

app.put('/api/worlds/:id/containers', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const out = {};
    let n = 0;
    for (const [key, slots] of Object.entries(req.body ?? {})) {
        if (n >= MAX_CONTAINERS) break;
        if (!/^-?\d{1,8},-?\d{1,4},-?\d{1,8}$/.test(key) || !Array.isArray(slots)) continue;
        const clean = slots.slice(0, MAX_CONTAINER_SLOTS).map(s =>
            s && typeof s.itemId === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(s.itemId) && Number.isInteger(s.count) && s.count > 0 && s.count <= 9999
                ? { itemId: s.itemId, count: s.count } : null);
        if (clean.some(Boolean)) { out[key] = clean; n++; }
    }
    const file = containersPath(req.params.id);
    if (n === 0) { try { fs.rmSync(file, { force: true }); } catch { /* nothing kept */ } }
    else fs.writeFileSync(file, JSON.stringify(out));
    res.json({ ok: true });
});

// The world's mobs: a list of [type, x, y, z, yaw, health, look] — those that
// were asleep where the players had left them, and those up and about when
// the world was saved (EntityManager: *Mobs that are left behind*). The
// owner's game sends the whole list with every save; it replaces what was
// kept. Guests do not come here.
const MAX_MOBS_KEPT = 20000;
function mobsPath(id) { return path.join(worldDir(id), 'mobs.json'); }

app.get('/api/worlds/:id/mobs', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    try { res.json(JSON.parse(fs.readFileSync(mobsPath(req.params.id), 'utf8'))); }
    catch { res.json([]); }
});

app.put('/api/worlds/:id/mobs', (req, res) => {
    if (!readMeta(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const out = [];
    for (const m of Array.isArray(req.body) ? req.body : []) {
        if (out.length >= MAX_MOBS_KEPT) break;
        if (!Array.isArray(m) || typeof m[0] !== 'string' || !/^[A-Za-z0-9_]{1,48}$/.test(m[0])) continue;
        if (![m[1], m[2], m[3], m[4], m[5]].every(Number.isFinite)) continue;
        // A look is a choice (a small whole number) for each of a model's variants.
        let look = null;
        if (m[6] && typeof m[6] === 'object' && !Array.isArray(m[6])) {
            look = {};
            for (const [k, v] of Object.entries(m[6]).slice(0, 24)) if (/^[A-Za-z0-9_]{1,24}$/.test(k) && Number.isInteger(v) && v >= 0 && v < 1000) look[k] = v;
        }
        out.push([m[0], m[1], m[2], m[3], m[4], m[5], look]);
    }
    const file = mobsPath(req.params.id);
    if (!out.length) { try { fs.rmSync(file, { force: true }); } catch { /* nothing kept */ } }
    else fs.writeFileSync(file, JSON.stringify(out));
    res.json({ ok: true });
});

// ── Online ────────────────────────────────────────────────────────────────────
// Playing over the internet goes through Ably (see *Online* in CLAUDE.md), not
// through this server. All this server has to do with it is tell the page
// where the token service is: WW_ONLINE_AUTH, or data/online.json as shipped
// (`auth`); empty means the game has no online play.
//
// On a developer's machine it can be the token service itself: with
// WW_ABLY_KEY set (an Ably API key), it answers at /api/online/auth, with the
// code that is deployed (online/auth.js). That is for trying online play with
// no service deployed. The key is never in a build: online/ is not packaged,
// and nothing in the game reads the variable but this.
let _onlineAuth = null;
async function onlineAuth() {
    if (!process.env.WW_ABLY_KEY) return null;
    if (_onlineAuth?.key !== process.env.WW_ABLY_KEY) {
        const { createAuth } = await import('../online/auth.js');
        // (WW_ABLY_REST: where Ably's REST API is, for a test that stands in for it.)
        _onlineAuth = { key: process.env.WW_ABLY_KEY, auth: createAuth({ key: process.env.WW_ABLY_KEY, ...(process.env.WW_ABLY_REST ? { ablyRest: process.env.WW_ABLY_REST } : {}) }) };
    }
    return _onlineAuth.auth;
}

function onlineAuthUrl(req) {
    let url = process.env.WW_ONLINE_AUTH;
    if (url === undefined && process.env.WW_ABLY_KEY) return `${req.protocol}://${req.get('host')}/api/online/auth`;
    if (url === undefined) {
        try { url = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'online.json'), 'utf8')).auth; } catch { url = ''; }
    }
    url = String(url ?? '').trim().replace(/\/+$/, '');
    // https, or this machine for a developer's own: a game's secret is not sent anywhere else in the clear.
    return /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url) ||
           /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(url) ? url : '';
}

// A guest from the network plays in the host's copy of the game, as the host's guest: going online is not theirs to do from here.
app.get('/api/online/config', (req, res) => res.json({ auth: req.lan ? '' : onlineAuthUrl(req), version: _appVersion }));

app.all('/api/online/auth/:op', async (req, res) => {
    const auth = req.lan ? null : await onlineAuth().catch(() => null);
    if (!auth) return res.status(404).json({ error: 'Not found' });
    const r = await auth.respond({ method: req.method, path: req.path, origin: req.get('origin') ?? '', body: req.body, ip: req.socket.remoteAddress ?? '',
        query: Object.fromEntries(Object.entries(req.query).filter(([, v]) => typeof v === 'string')) });
    res.status(r.status).set(r.headers);
    if (r.body === null) res.end(); else res.json(r.body);
});

// Global player settings
function readSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); }
    catch { return {}; }
}

// A guest's settings are their own, kept by their browser: they get none of these.
app.get('/api/settings', (req, res) => res.json(req.lan ? {} : readSettings()));

app.put('/api/settings', (req, res) => {
    const cur = readSettings();
    // The names are changed one at a time (below): a whole list sent with the
    // settings may be an old one, from before another pane added a name.
    const { profiles: _stale, ...body } = req.body ?? {};
    const merged = { ...cur, ...body };
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
});

// The names used on this machine, each with the look that goes with it — and
// a code of its own, which nobody is shown (settings.json `profiles`:
// [{ name, skin, code }]). The code is who a player is to a world they are a
// guest in: their place there, and whether they are an operator, go by it and
// not by what they are called.
const PROFILE_CODE = /^[0-9a-f]{16,32}$/;
function writeProfiles(change) {
    const cur = readSettings();
    cur.profiles = change(Array.isArray(cur.profiles) ? cur.profiles.filter(p => p && typeof p.name === 'string') : []);
    for (const p of cur.profiles) if (!PROFILE_CODE.test(p.code ?? '')) p.code = crypto.randomBytes(8).toString('hex');
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cur, null, 2));
    return cur.profiles;
}
app.post('/api/profiles', (req, res) => {
    const name = String(req.body?.name ?? '').replace(/[^A-Za-z0-9 ._'-]/g, '').trim().slice(0, 16);
    if (!name) return res.status(400).json({ error: 'A name is needed' });
    const skin = req.body?.skin && typeof req.body.skin === 'object' ? req.body.skin : null;
    // A name the page made up a code for before it could ask (it keeps that one).
    const code = PROFILE_CODE.test(req.body?.code ?? '') ? req.body.code : null;
    res.json(writeProfiles((list) => {
        const p = list.find(q => q.name === name);
        if (p) { if (skin) p.skin = skin; if (code && !PROFILE_CODE.test(p.code ?? '')) p.code = code; }
        else if (list.length < 32) list.push({ name, skin, code });
        return list;
    }));
});
app.delete('/api/profiles/:name', (req, res) => {
    res.json(writeProfiles((list) => list.filter(p => p.name !== req.params.name)));
});

// ── What went wrong ───────────────────────────────────────────────────────────
// Errors and crashes, kept so that there is something to go on afterwards
// (user/reports.json, the last REPORTS_KEPT of them, newest first). The page
// sends what it catches — an error nobody caught, a promise nobody caught, a
// worker or the graphics giving up (main.js: *REPORTS*) — and the launcher
// what it sees from outside: the page's process dying, the app's own crash.
// One that is the same as the last is counted, not added again. The player
// reads them under Settings → Game. Nothing is sent anywhere.
const REPORTS_PATH = path.join(DATA_ROOT, 'user', 'reports.json');
const REPORTS_KEPT = 60;
function readReports() {
    try { const r = JSON.parse(fs.readFileSync(REPORTS_PATH, 'utf8')); return Array.isArray(r) ? r : []; }
    catch { return []; }
}
const reportText = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max);
/** Keep a report: { kind, message, stack, where, version, at }. Never throws. */
export function addReport(report) {
    try {
        const r = {
            at: Number.isFinite(report?.at) ? report.at : Date.now(),
            kind: ['error', 'crash', 'graphics', 'worker', 'app'].includes(report?.kind) ? report.kind : 'error',
            message: reportText(report?.message, 600) || 'Something went wrong',
            stack: reportText(report?.stack, 6000),
            where: reportText(report?.where, 200),
            version: reportText(report?.version, 40) || _appVersion,
            count: 1,
        };
        const list = readReports(), last = list[0];
        if (last && last.kind === r.kind && last.message === r.message && last.stack === r.stack) {
            last.count = Math.min(9999, (last.count | 0) + 1); last.at = r.at; last.where = r.where;
        } else list.unshift(r);
        fs.mkdirSync(path.dirname(REPORTS_PATH), { recursive: true });
        fs.writeFileSync(REPORTS_PATH, JSON.stringify(list.slice(0, REPORTS_KEPT), null, 1));
    } catch { /* a report that cannot be kept is one less thing to go wrong */ }
}
app.get('/api/reports', (_req, res) => res.json(readReports()));
app.post('/api/reports', (req, res) => { addReport(req.body); res.json({ ok: true }); });
app.delete('/api/reports', (_req, res) => {
    try { fs.rmSync(REPORTS_PATH, { force: true }); } catch { /* nothing kept */ }
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
// A test says which version this is (the release notes come up for a newer one).
if (process.env.WW_APP_VERSION) _appVersion = process.env.WW_APP_VERSION;

const _updateState = {
    supported:      false,  // an updater is present at all
    checking:       false,
    available:      false,
    canAutoInstall: false,  // false => notify only, user downloads manually
    downloaded:     false,
    progress:       0,      // of a download under way, 0–100
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

// What this version added and fixed: ReleaseNotes.txt, beside the game, as it
// is written (a little Markdown: "# title", "### section", "- item",
// **bold**; a line of "---" between one version's notes and the next, newest
// first — the game splits them). `notesVersion` is the version its first line
// names, so the game can tell notes that are this version's from ones left
// over from the last. WW_RELEASE_NOTES names another file, for a test.
app.get('/api/release-notes', (_req, res) => {
    let text = '';
    try { text = fs.readFileSync(process.env.WW_RELEASE_NOTES || path.join(ROOT, 'ReleaseNotes.txt'), 'utf8'); } catch { /* none shipped */ }
    const named = text.split(/\r?\n/, 1)[0].match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/);
    res.json({ version: _appVersion, notesVersion: named ? named[0] : null, text });
});

// ── Screenshots ──────────────────────────────────────────────────────────────
// F2 in a game (or Screenshot in the pause menu) sends the frame here as a PNG,
// to keep in user/screenshots/ under the data directory. The desktop app can
// open that folder (`setShellHandlers`: the launcher's shell); a page with no
// launcher behind it is told where the folder is.
const SCREENSHOTS_DIR = path.join(DATA_ROOT, 'user', 'screenshots');
let _openFolder = null;

/** Called by the launcher: how to show a folder on this machine. */
export function setShellHandlers({ openFolder }) { _openFolder = openFolder ?? null; }

app.post('/api/screenshots', express.raw({ type: 'image/png', limit: '96mb' }), (req, res) => {
    const png = req.body;
    if (!Buffer.isBuffer(png) || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return res.status(400).json({ error: 'Not a PNG' });
    // A name of the world's and the time's, in letters a file name can have.
    const world = String(req.query.world ?? '').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'Wonder World';
    const d = new Date(), two = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    try {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        let file = `${world} ${stamp}.png`, n = 2;
        while (fs.existsSync(path.join(SCREENSHOTS_DIR, file))) file = `${world} ${stamp} (${n++}).png`;
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, file), png);
        res.json({ ok: true, file, dir: SCREENSHOTS_DIR, canOpen: !!_openFolder });
    } catch (err) {
        res.status(500).json({ error: String(err?.message ?? err) });
    }
});

app.get('/api/screenshots', (_req, res) => res.json({ dir: SCREENSHOTS_DIR, canOpen: !!_openFolder }));

app.post('/api/screenshots/open', async (_req, res) => {
    if (!_openFolder) return res.status(409).json({ error: 'No way to open a folder here', dir: SCREENSHOTS_DIR });
    try {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        await _openFolder(SCREENSHOTS_DIR);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: String(err?.message ?? err) }); }
});

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

// Data manifest — lists all JSON files in data/blocks/, items/, biomes/,
// entities/, recipes/ and terrain/ (world-generation settings: geology.json)
app.get('/api/data/manifest', (_req, res) => {
    const dataDir = path.join(ROOT, 'data');
    const cats = ['blocks', 'items', 'biomes', 'entities', 'recipes', 'terrain'];
    const manifest = {};
    for (const cat of cats) {
        const dir = path.join(dataDir, cat);
        manifest[cat] = fs.existsSync(dir)
            ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => `data/${cat}/${f}`)
            : [];
    }
    // Sounds are files, not definitions: every audio file under data/sounds/,
    // one folder deep (blocks, entities, ambiant, ui, music). Sound.js names a
    // sound after its file.
    manifest.sounds = [];
    const soundDir = path.join(dataDir, 'sounds');
    if (fs.existsSync(soundDir)) {
        for (const sub of fs.readdirSync(soundDir, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            for (const f of fs.readdirSync(path.join(soundDir, sub.name))) {
                if (/\.(ogg|wav|mp3|m4a|flac)$/i.test(f)) manifest.sounds.push(`data/sounds/${sub.name}/${f}`);
            }
        }
    }
    res.json(manifest);
});

// Every definition at once — blocks, items, biomes, entities, recipes, terrain —
// in the manifest's order, each file's JSON as it is (one that does not parse
// is left out). There are well over a thousand files, a file a block, and the
// game asked for them one by one; a browser asks a server for six at a time.
// Read afresh each time: the tools write these files while the server runs.
app.get('/api/data/bundle', (_req, res) => {
    const dataDir = path.join(ROOT, 'data');
    const out = {};
    for (const cat of ['blocks', 'items', 'biomes', 'entities', 'recipes', 'terrain']) {
        const dir = path.join(dataDir, cat);
        out[cat] = [];
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            try { out[cat].push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip a bad file */ }
        }
    }
    res.json(out);
});

// ── Multiplayer and the network ───────────────────────────────────────────────

const hub = new MultiplayerHub((id) => !!readMeta(id));
// When the last player of the world that is open to the network has gone, it
// closes — a moment later: the guests have just been told the game is over,
// and what each sends to be saved as they go has to find the door still open.
const LAN_LINGER_MS = 1500;
hub.onChange = (worldId) => {
    if (worldId !== lan.worldId || hub.count(worldId) > 0) return;
    setTimeout(() => { if (worldId === lan.worldId && hub.count(worldId) === 0) closeLan(); }, LAN_LINGER_MS).unref?.();
};

/** This machine's addresses on its networks, and each network's broadcast address. */
function lanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list ?? []) {
            if (a.family !== 'IPv4' || a.internal) continue;
            const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
            out.push({ address: a.address, broadcast: ip.map((v, i) => (v | (~mask[i] & 255))).join('.') });
        }
    }
    return out;
}

function lanStatus() {
    const open = !!lan.worldId;
    return {
        open, worldId: lan.worldId, port: open ? lan.port : 0,
        addresses: open ? lanAddresses().map(a => `${a.address}:${lan.port}`) : [],
        players: open ? hub.count(lan.worldId) : 0,
        // … and how many of them came in from the network (while any is here, the world stays open to it).
        guests: open ? hub.count(lan.worldId, (ws) => !!ws.lan) : 0,
    };
}

/** Open `worldId` to the network: the second listener, and a beacon so games on the network can find it. */
async function openLan(worldId) {
    if (lan.worldId && lan.worldId !== worldId) closeLan();
    if (!lan.server) {
        const srv = http.createServer(app);
        const listen = (port) => new Promise((resolve, reject) => {
            srv.once('error', reject);
            srv.listen(port, '0.0.0.0', () => { srv.removeListener('error', reject); resolve(); });
        });
        // The usual port, so an address typed in once works again; any port if that one is taken.
        try { await listen(LAN_PORT); } catch { await listen(0); }
        lan.server = srv;
        lan.port = srv.address().port;
        lan.wss = new WebSocketServer({
            server: srv, perMessageDeflate: true,
            // The page a guest plays in came from this listener: its sockets say so.
            verifyClient: ({ origin }) => {
                if (!origin) return true;
                try { return new URL(origin).port === String(lan.port); } catch { return false; }
            },
        });
        lan.wss.on('connection', (ws) => { ws.lan = true; onSocket(ws); });
    }
    lan.worldId = worldId;
    if (!lan.beacon) {
        lan.beacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        lan.beacon.on('error', () => { /* no broadcast on this network: the address still works */ });
        lan.beacon.bind(() => { try { lan.beacon.setBroadcast(true); } catch { /* likewise */ } });
        lan.timer = setInterval(() => {
            if (!lan.worldId) return;
            const msg = Buffer.from(JSON.stringify({
                ww: 'wonder-world', name: readMeta(lan.worldId)?.name ?? 'World', host: os.hostname(),
                port: lan.port, players: hub.count(lan.worldId),
            }));
            for (const to of new Set(['255.255.255.255', ...lanAddresses().map(a => a.broadcast)])) {
                lan.beacon.send(msg, BEACON_PORT, to, () => { /* a network that will not carry it */ });
            }
        }, 1500);
        lan.timer.unref?.();
    }
}

function closeLan() {
    const worldId = lan.worldId;
    lan.worldId = null;
    clearInterval(lan.timer); lan.timer = null;
    try { lan.beacon?.close(); } catch { /* already */ }
    lan.beacon = null;
    if (worldId) hub.close(worldId, 'closed', (ws) => !!ws.lan);      // the guests go; whoever is here stays
    for (const ws of lan.wss?.clients ?? []) { try { ws.close(); } catch { /* gone */ } }
    lan.wss?.close();
    lan.server?.close();
    lan.server?.closeAllConnections?.();
    lan.server = lan.wss = null;
    lan.port = 0;
}

// Games other machines on the network have open, heard from their beacons.
const _games = new Map();   // "address:port" → { name, host, address, port, players, seen }
let _listener = null;
function listenForGames() {
    if (_listener) return;
    _listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    _listener.on('error', () => { try { _listener.close(); } catch { /* */ } _listener = null; });
    _listener.on('message', (buf, from) => {
        try {
            const m = JSON.parse(buf.toString());
            if (m?.ww !== 'wonder-world' || !Number.isInteger(m.port)) return;
            _games.set(`${from.address}:${m.port}`, {
                name: String(m.name ?? 'World').slice(0, 40), host: String(m.host ?? '').slice(0, 40),
                address: from.address, port: m.port, players: Number(m.players) || 0, seen: Date.now(),
            });
        } catch { /* not ours */ }
    });
    _listener.bind(BEACON_PORT);
    _listener.unref?.();
}

app.post('/api/lan/open', async (req, res) => {
    const worldId = String(req.body?.worldId ?? '');
    if (!readMeta(worldId)) return res.status(404).json({ error: 'Not found' });
    try { await openLan(worldId); res.json(lanStatus()); }
    catch (e) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
app.post('/api/lan/close', (_req, res) => { closeLan(); res.json(lanStatus()); });
app.get('/api/lan/status', (_req, res) => res.json(lanStatus()));
app.get('/api/lan/games', (_req, res) => {
    listenForGames();
    const mine = new Set(lanAddresses().map(a => a.address).concat('127.0.0.1'));
    const now = Date.now(), out = [];
    for (const [key, g] of _games) {
        if (now - g.seen > 5000) { _games.delete(key); continue; }
        if (lan.worldId && g.port === lan.port && mine.has(g.address)) continue;      // our own
        out.push({ name: g.name, host: g.host, address: `${g.address}:${g.port}`, players: g.players });
    }
    res.json(out);
});
// What a page is: the player's own game, or a guest's view of the world that is open.
app.get('/api/lan/info', (req, res) => {
    res.json(req.lan ? { guest: true, world: readMeta(lan.worldId) } : { guest: false });
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

wss.on('connection', onSocket);

function onSocket(ws) {
    ws.on('close', () => hub.leave(ws));
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
}

async function handleTextMessage(ws, msg) {
    // A guest has the one world that is open, and no other.
    if (ws.lan && msg.worldId !== undefined && msg.worldId !== lan.worldId) return;
    if (typeof msg.type === 'string' && msg.type.startsWith('mp:')) {
        hub.handle(ws, msg);
    } else if (msg.type === 'loadChunk') {
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
    if (ws.lan && worldId !== lan.worldId) return;

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
