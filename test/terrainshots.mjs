// Screenshots of the landscape the world generator makes, in the real game on
// the real GPU: the spawn, a mountain range, a river valley, a coast, a lake, a
// fjord and a handful of biomes, each found on the seed's geography first and
// then flown to.
//
//   node test/terrainshots.mjs [--seed 4242] [--out dir] [--preset normal] [--only name,name] [--far chunks] [--terrain blocky] [--mobs] [--cull-check]
//
// Also reports, per view, how long its chunks took to arrive. BROWSER=<path>
// picks the browser (Chrome first: headless Edge can stop drawing with the
// display off).
//
// --cull-check: at each view — and looking down from it, and from inside the
// caves under it in four directions — draws the frame with and without leaving
// out what the camera cannot see (engine/Visibility.js), and compares the two:
// no patch of pixels may differ (what is left out is hidden), and no more
// pinholes may open onto the sky (see cullCompare). Exits 1 otherwise. Best
// with --preset classic: Eye Adaptation drifts from frame to frame.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { Geography, NO_WATER, COL_RIVER, COL_LAKE } from '../src/scripts/workers/Geography.js';
import { BiomeSet } from '../src/scripts/workers/Biomes.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const SEED = Number(arg('seed', 4242));
const OUT = arg('out', path.join(os.tmpdir(), 'wonder-world-terrainshots'));
const PRESET = arg('preset', 'normal');
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const FAR = arg('far', null);   // Far Terrain, in chunks past the render distance (else the preset's)
const TERRAIN = arg('terrain', null);   // 'blocky' or 'smooth' (else what new worlds get)
const MOBS = process.argv.includes('--mobs');   // stand one of every mob in front of each view
const PITCH = arg('pitch', null);   // look this far up (+) or down (−) instead, radians
const CULL_CHECK = process.argv.includes('--cull-check');
fs.mkdirSync(OUT, { recursive: true });

// ── Find the views on the geography ──────────────────────────────────────────
const biomeDefs = fs.readdirSync(path.join(root, 'data/biomes'))
    .map(f => JSON.parse(fs.readFileSync(path.join(root, 'data/biomes', f), 'utf8')));
const biomes = new BiomeSet(biomeDefs);
const geo = new Geography(SEED, biomes);
const nameOf = (c) => biomes.list[c.biome].name;

function find(pred, maxR = 9000, step = 40) {
    for (let r = 0; r <= maxR; r += step) {
        const n = Math.max(1, Math.round(2 * Math.PI * r / step));
        for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
            const c = geo.column(x, z);
            if (pred(c, x, z)) return { x, z, top: c.top, biome: nameOf(c) };
        }
    }
    return null;
}
const around = (x, z, d, f) => [[d, 0], [-d, 0], [0, d], [0, -d]].filter(([dx, dz]) => f(geo.column(x + dx, z + dz))).length;

/** A camera `dist` blocks from the target, `up` above the ground there, looking at it. */
function vista(t, dist, up, angle = 0.6, pitch = -0.12) {
    const vx = Math.round(t.x + Math.cos(angle) * dist), vz = Math.round(t.z + Math.sin(angle) * dist);
    const g = geo.column(vx, vz);
    const ground = g.water !== NO_WATER ? g.water : g.top;
    const y = Math.max(ground, t.top * 0.4 + ground * 0.6) + up;
    const yaw = Math.atan2(-(t.x - vx), -(t.z - vz));
    return { x: vx + 0.5, y, z: vz + 0.5, yaw, pitch };
}

const spawnXZ = geo.findSpawn(0, 0);
const views = [];
const add = (name, target, cam) => { if (target) views.push({ name, target, cam }); else console.log(`(no ${name} found)`); };

{
    const s = geo.column(spawnXZ.x, spawnXZ.z);
    add('spawn', { ...spawnXZ, top: s.top, biome: nameOf(s) }, { x: spawnXZ.x + 0.5, y: s.top + 3, z: spawnXZ.z + 0.5, yaw: 0.8, pitch: -0.05 });
}
const peak = find(c => c.top > 190 && /PEAKS/.test(nameOf(c)));
add('mountains', peak, peak && vista(peak, 190, 30, 0.9, 0.02));
// Views into the distance, where Far Terrain (--far) takes over from the chunks.
{
    const s = geo.column(spawnXZ.x, spawnXZ.z);
    add('panorama', { ...spawnXZ, top: s.top, biome: nameOf(s) }, { x: spawnXZ.x + 0.5, y: s.top + 110, z: spawnXZ.z + 0.5, yaw: 2.4, pitch: -0.16 });
}
add('far-range', peak, peak && vista(peak, 620, 25, 2.6, 0.03));
const river = find((c, x, z) => (c.flags & COL_RIVER) && c.water !== NO_WATER && around(x, z, 40, q => q.water === NO_WATER && q.top > 72) >= 2);
add('river-valley', river, river && vista(river, 60, 28, 2.2, -0.28));
const lake = find(c => (c.flags & COL_LAKE) && c.water > 72);
add('lake', lake, lake && vista(lake, 70, 22, 0.3, -0.2));
const cliff = find((c, x, z) => nameOf(c) === 'STONY_SHORE' || (c.water === NO_WATER && c.top > 76 && around(x, z, 12, q => q.water !== NO_WATER && q.top < 58) >= 1));
add('coast', cliff, cliff && vista(cliff, 55, 14, 3.6, -0.12));
const fjord = find((c, x, z) => c.water !== NO_WATER && c.temp < 0.3 && c.top < 52 && around(x, z, 45, q => q.top > 120) >= 2);
add('fjord', fjord, fjord && vista(fjord, 30, 8, 1.2, 0.05));
for (const [name, b, dist, up] of [
    ['desert', 'DESERT', 60, 20], ['badlands', 'BADLANDS', 110, 26], ['jungle', 'JUNGLE', 40, 26],
    ['taiga', 'TAIGA', 40, 22], ['snowy-taiga', 'SNOWY_TAIGA', 40, 22], ['swamp', 'SWAMP', 36, 14],
    ['savanna', 'SAVANNA', 50, 20], ['birch-forest', 'BIRCH_FOREST', 40, 20], ['dense-forest', 'DENSE_FOREST', 40, 22],
    ['meadow', 'MEADOW', 60, 20], ['plains', 'PLAINS', 60, 14],
]) {
    const t = find((c, x, z) => nameOf(c) === b && around(x, z, 30, q => nameOf(q) === b) === 4);
    add(name, t, t && vista(t, dist, up, 0.5, -0.2));
    // Standing in the plains, looking level across open land: where the chunks
    // end and far terrain begins is in plain view.
    if (name === 'plains' && t) add('edge', t, { x: t.x + 0.5, y: t.top + 3, z: t.z + 0.5, yaw: 0.5, pitch: -0.02 });
}
const todo = ONLY ? views.filter(v => ONLY.includes(v.name)) : views;
console.log(`seed ${SEED}: ${todo.length} views`);
for (const v of todo) console.log(`  ${v.name.padEnd(14)} target ${v.target.x},${v.target.z} (${v.target.biome}, y ${v.target.top})`);

// ── The game ─────────────────────────────────────────────────────────────────
const BROWSER = [
    process.env.BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) { console.error('No Chromium-family browser found. Set BROWSER=<path>.'); process.exit(2); }

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-shots-'));
const { serverReady } = await import('../server/server.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;
const DBG_PORT = 9600 + (process.pid % 200);
const browser = spawn(BROWSER, [
    '--headless=new', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ww-shots-browser-'))}`,
    '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });
const kill = () => { try { browser.kill('SIGKILL'); } catch {} };
process.on('exit', kill);
process.on('uncaughtException', (e) => { console.error(e); kill(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); kill(); process.exit(1); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; }
    catch { /* not up yet */ }
    if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id != null) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push((m.params.args ?? []).map(a => a.value ?? a.description).join(' '));
    }
});
const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const dispatch = (name, data) => evalJs(`(() => { const e = new Event('WorldJS_${name}'); e.data = ${JSON.stringify(data)}; document.dispatchEvent(e); return 1; })()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
// A new data folder has no player yet, and the game would stop to ask for a
// name (src/players.js). This run is not about that: say who is playing.
await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tester' }) });
await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'Tester' }) });
await send('Page.navigate', { url: `${base}/game.html` });
for (let i = 0; i < 80; i++) {
    await sleep(500);
    if (await evalJs(`(() => { const t = document.getElementById('TitleScreen'); return !!t && !t.classList.contains('hidden'); })()`).catch(() => false)) break;
}

let world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Terrain shots', seed: SEED, gameMode: 'CREATIVE' }),
})).json();
if (TERRAIN) {
    // The hidden world setting (see Smooth Terrain in CLAUDE.md).
    await fetch(`${base}/api/worlds/${world.id}/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terrainStyle: TERRAIN }),
    });
    world = await (await fetch(`${base}/api/worlds/${world.id}`)).json();
}
console.log(`world ${world.id.slice(0, 8)} worldGen ${world.worldGen} terrain ${world.terrainStyle}`);
await evalJs(`startWorld(${JSON.stringify(world)}); 1`);
await sleep(3000);
const presets = {
    normal: { renderDistance: 10, farTerrain: 16, fogStart: 0.86, shadows: 'medium', clouds: 'fancy', sky: 'pretty', eyeAdaptation: 'on' },
    far:    { renderDistance: 16, farTerrain: 64, fogStart: 0.9,  shadows: 'high',   clouds: 'fancy', sky: 'pretty', eyeAdaptation: 'on' },
    classic: { renderDistance: 8, farTerrain: 0,  fogStart: 0.82, shadows: 'off',    clouds: 'fast',  sky: 'simple', eyeAdaptation: 'off' },
};
await dispatch('applySettings', { ...presets[PRESET] ?? presets.normal, particles: 'medium', ...(FAR != null ? { farTerrain: Number(FAR) } : {}) });
await dispatch('setAtmosphere', { hours: 11, weather: 'sunny', immediate: true, daylightCycle: false });

async function settle(label, limitMs = 60000) {
    const t0 = Date.now();
    let s = null, quiet = 0;
    while (Date.now() - t0 < limitMs) {
        await sleep(500);
        s = await evalJs('window.__wwDebug()').catch(() => null);
        // Far terrain done too: every tile of the selection built and on screen.
        const farDone = !s?.far || s.far.extra === 0 || (s.far.inflight === 0 && s.far.shown === s.far.wanted);
        if (s && s.pending === 0 && s.queued === 0 && farDone) { if (++quiet >= 3) break; } else quiet = 0;
    }
    return { ms: Date.now() - t0, s };
}

// ── --cull-check ─────────────────────────────────────────────────────────────
let cullChecks = 0, cullFailures = 0;
const CRACK_PIXELS = 30;    // grouped pixels that may differ in a frame of 1600 × 900

/**
 * Draw the frame leaving out what cannot be seen, then everything, then
 * leaving out again, and compare the first two; the first and last are the
 * same picture, so what differs between those is whatever still moves (mobs).
 *
 * A face left out that should have been drawn is a patch of pixels, so what
 * counts is pixels that differ in a group. Lone pixels do differ, a handful a
 * frame, and must: the mesh has pinholes — gaps a pixel wide where triangles
 * meet, now and then a crack a few pixels long — and through one you see
 * whatever comes next behind the land, which with everything drawn can be a
 * cave wall nobody could otherwise see. So the pinholes are counted too, with
 * the sky and fog turned an unmistakable colour: leaving things out must not
 * open any more of them onto the sky.
 */
async function cullCompare(label) {
    const r = await evalJs(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const grab = async (on) => { window.__wwCaveCull(on); await wait(350); return (await window.__wwGrabFrame())?.data ?? null; };
        const a = await grab(true);
        const d = window.__wwDebug();       // what is being left out, while it is
        const b = await grab(false), c = await grab(true);
        if (!a || !b || !c) return null;
        const w = document.getElementById('gameCanvas').width, h = a.length / 4 / w;
        // Pixels that differ, how many of them have another beside them, and the first of those.
        const diff = (p, q) => {
            const m = new Uint8Array(w * h);
            let all = 0, grouped = 0, at = -1;
            for (let i = 0, k = 0; i < p.length; i += 4, k++) {
                if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 4) { m[k] = 1; all++; }
            }
            for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
                const k = y * w + x;
                if (m[k] === 0) continue;
                if (m[k - 1] + m[k + 1] + m[k - w] + m[k + w] + m[k - w - 1] + m[k - w + 1] + m[k + w - 1] + m[k + w + 1] > 0) {
                    grouped++;
                    if (at < 0) at = k;
                }
            }
            return { all, grouped, at };
        };
        const ab = diff(a, b), ac = diff(a, c);
        // The surroundings of the first patch, eight times enlarged, from each picture side by side.
        let crop = null;
        if (ab.grouped > ac.grouped) {
            const px = ab.at % w, py = Math.floor(ab.at / w), R = 24, Z = 8;
            const cv = document.createElement('canvas');
            cv.width = (2 * R + 1) * Z * 2 + Z; cv.height = (2 * R + 1) * Z;
            const g = cv.getContext('2d');
            [a, b].forEach((img, side) => {
                for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                    const x = px + dx, y = py + dy;
                    if (x < 0 || y < 0 || x >= w || y >= h) continue;
                    const i = (y * w + x) * 4;
                    g.fillStyle = 'rgb(' + img[i] + ',' + img[i + 1] + ',' + img[i + 2] + ')';
                    g.fillRect(side * ((2 * R + 1) * Z + Z) + (dx + R) * Z, (dy + R) * Z, Z, Z);
                }
            });
            crop = cv.toDataURL('image/png').split(',')[1];
        }
        // Pinholes onto the sky: single pixels of it with land all round.
        const fog = window.__wwAtmos().uniforms.uFogColor.value, set = fog.set;
        fog.set = function () { return set.call(this, 1, 0, 1); };
        const holes = (img) => {
            const sky = (x, y) => { const i = (y * w + x) * 4; return img[i] > 200 && img[i + 1] < 70 && img[i + 2] > 200; };
            let n = 0;
            for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
                if (!sky(x, y)) continue;
                let land = 0;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !sky(x + dx, y + dy)) land++;
                if (land >= 7) n++;
            }
            return n;
        };
        const holesOn = holes(await grab(true)), holesOff = holes(await grab(false));
        delete fog.set;
        window.__wwCaveCull(true);
        return { ab, ac, crop, holesOn, holesOff, share: d.visibility.drawnShare, hidden: d.visibility.hiddenChunks, on: d.visibility.on };
    })()`, true);
    cullChecks++;
    if (!r) { cullFailures++; console.log(`   cull check ${label}: no frame`); return; }
    // A crack between triangles can be a few pixels long, and what shows
    // through it changes like a pinhole's: a few grouped pixels are allowed for.
    // (And where the picture is still settling — the fog easing after a
    // move — two frames of the same differ by more, so more is allowed.)
    const ok = r.ab.grouped <= r.ac.grouped * 1.3 + CRACK_PIXELS && r.holesOn <= r.holesOff + Math.max(2, r.holesOff * 0.05);
    if (!ok) cullFailures++;
    if (!ok && r.crop) {
        // Left: with what cannot be seen left out. Right: with everything drawn.
        const file = path.join(OUT, `${SEED}-cull-${cullChecks}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
        fs.writeFileSync(file, Buffer.from(r.crop, 'base64'));
        console.log(`          round the first patch: ${file}`);
    }
    console.log(`   ${ok ? 'same  ' : 'DIFFER'} ${label.padEnd(22)} ${r.ab.grouped} pixels differ in groups, ${r.ab.all - r.ab.grouped} alone (${r.ac.grouped} and ${r.ac.all - r.ac.grouped} between two frames of the same); ` +
        `sky pinholes ${r.holesOn} (${r.holesOff} with everything drawn) — ${Math.round(r.share * 100)}% of triangles kept, ${r.hidden} chunks hidden${r.on ? '' : ' [camera in rock: nothing left out]'}`);
}

/** Open cells under the land round (x, z) with a roof over them: places to stand in a cave. */
function findCaves(x, z, top) {
    return evalJs(`(() => {
        const out = [], air = (x, y, z) => window.__wwBlockAt(x, y, z) === 0;
        for (let r = 0; r <= 28 && out.length < 3; r += 4) {
            for (let k = 0; k < 8 && out.length < 3; k++) {
                const a = k / 8 * Math.PI * 2, cx = Math.floor(${x} + Math.cos(a) * r), cz = Math.floor(${z} + Math.sin(a) * r);
                let roof = false;
                for (let y = ${Math.floor(top)} + 40; y > -110; y--) {
                    if (!air(cx, y, cz)) { roof = true; continue; }
                    if (roof && air(cx, y - 1, cz) && !air(cx, y - 2, cz) && !out.some(o => Math.abs(o.y - y) < 24)) {
                        out.push({ x: cx + 0.5, y: y - 1, z: cz + 0.5 });
                        break;
                    }
                }
                if (r === 0) break;
            }
        }
        return out;
    })()`);
}

if (CULL_CHECK) {
    // Nothing may move between the frames compared: no swaying leaves, no flicker.
    await evalJs(`(() => { const u = window.__wwAtmos().uniforms.uTime; Object.defineProperty(u, 'value', { get: () => 0, set: () => {} }); return 1; })()`);
    await dispatch('applySettings', { reduceMotion: true });
    await dispatch('setAtmosphere', { hours: 11, weather: 'clear', immediate: true, daylightCycle: false });
    // A spectator: no mobs come to wander through the picture, and the camera stays where it is put.
    await dispatch('setGameMode', { gameMode: 'SPECTATOR' });
}

for (const v of todo) {
    if (PITCH !== null) v.cam.pitch = Number(PITCH);
    await evalJs(`window.__wwTeleport(${v.cam.x}, ${v.cam.y}, ${v.cam.z}); window.__wwLook(${v.cam.yaw}, ${v.cam.pitch}); 1`);
    const { ms, s } = await settle(v.name);
    await evalJs(`window.__wwTeleport(${v.cam.x}, ${v.cam.y}, ${v.cam.z}); window.__wwLook(${v.cam.yaw}, ${v.cam.pitch}); document.getElementById('PauseScreen').style.visibility = 'hidden'; 1`);
    await sleep(1200);
    if (MOBS) {
        // In an arc a few blocks ahead, each on the ground under it.
        await evalJs(`(() => {
            const p = window.me.position, yaw = ${v.cam.yaw};
            const ground = (gx, gz) => { for (let y = Math.floor(p.y) + 6; y > Math.floor(p.y) - 40; y--) if (window.__wwBlockAt(gx, y, gz) !== 0) return y; return null; };
            const types = ['quiddle', 'cow', 'quiddle', 'pig', 'sheep', 'quiddle', 'chicken', 'cow', 'sheep'];
            types.forEach((t, i) => {
                const a = yaw + (i - (types.length - 1) / 2) * 0.16, r = 6 + (i % 3) * 1.6;
                const gx = Math.floor(p.x - Math.sin(a) * r), gz = Math.floor(p.z - Math.cos(a) * r);
                const g = ground(gx, gz);
                if (g !== null) window.__wwSpawnMob(t, gx + 0.5, g + 1.05, gz + 0.5);
            });
            return 1;
        })()`);
        await sleep(2500);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${SEED}-${v.name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    await evalJs(`document.getElementById('PauseScreen').style.visibility = ''; 1`);
    console.log(`${v.name.padEnd(14)} loaded in ${(ms / 1000).toFixed(1)}s  chunks ${s?.chunks} meshes ${s?.meshes} calls ${s?.drawCalls} tris ${s?.tris}${s?.far?.extra ? `  far ${s.far.shown} tiles` : ''}  → ${file}`);
    if (CULL_CHECK) {
        await evalJs(`document.getElementById('PauseScreen').style.visibility = 'hidden'; 1`);
        await cullCompare('the view');
        await evalJs(`window.__wwLook(${v.cam.yaw}, -1.35); 1`);
        await cullCompare('looking down');
        for (const c of await findCaves(v.cam.x, v.cam.z, v.cam.y)) {
            await evalJs(`window.__wwTeleport(${c.x}, ${c.y}, ${c.z}); 1`);
            await sleep(400);
            for (const [yaw, pitch] of [[0, 0.1], [1.6, -0.3], [3.1, 0.5], [4.7, 0]]) {
                await evalJs(`window.__wwLook(${yaw}, ${pitch}); 1`);
                await cullCompare(`cave y ${c.y}, yaw ${yaw}`);
            }
        }
        await evalJs(`document.getElementById('PauseScreen').style.visibility = ''; 1`);
    }
}
if (CULL_CHECK) console.log(`\ncull check: ${cullChecks} frames compared, ${cullFailures} differ`);

console.log(`\nerrors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  ', String(e).slice(0, 300));
try { ws.close(); } catch {}
kill();
process.exit(errors.length || cullFailures ? 1 : 0);
