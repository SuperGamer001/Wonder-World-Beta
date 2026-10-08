// Loads the real game in headless Edge and drives it into a live world, so the
// shader compile, worker pipeline and mesh upload are all exercised for real.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

// First Chromium-family browser we can find. Override with BROWSER=<path>.
const BROWSER_CANDIDATES = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const EDGE = BROWSER_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!EDGE) {
    console.error('No Chromium-family browser found. Set BROWSER=<path to chrome/edge>.');
    process.exit(2);
}
// Unique per run: a fixed port meant a timed-out run left an orphan Edge behind
// and the next run silently attached to its stale page.
const DBG_PORT = 9400 + (process.pid % 500);

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-headless-'));
const { serverReady } = await import('../server/server.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-edge-'));
const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--enable-features=Vulkan',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    'about:blank',
], { stdio: 'ignore' });

// Always reap the browser, including on timeout or an unhandled rejection.
const killEdge = () => { try { edge.kill('SIGKILL'); } catch {} };
process.on('exit', killEdge);
process.on('SIGTERM', () => { killEdge(); process.exit(1); });
process.on('SIGINT',  () => { killEdge(); process.exit(1); });
process.on('uncaughtException', (e) => { console.error(e); killEdge(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); killEdge(); process.exit(1); });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function targetWs() {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json();
            const page = list.find(t => t.type === 'page');
            if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    throw new Error('Edge debugger never became reachable');
}

const wsUrl = await targetWs();
const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let msgId = 0;
const pending = new Map();
const consoleMsgs = [];
const pageErrors = [];
const failedReqs = [];
const reqUrls = new Map();

ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id != null) {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
        return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ');
        consoleMsgs.push({ level: m.params.type, text });
    } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(d.exception?.description ?? d.text);
    } else if (m.method === 'Network.loadingFailed') {
        failedReqs.push(m.params.errorText + ' ' + (reqUrls.get(m.params.requestId) ?? '?'));
    } else if (m.method === 'Network.requestWillBeSent') {
        reqUrls.set(m.params.requestId, m.params.request.url);
    } else if (m.method === 'Network.responseReceived') {
        if (m.params.response.status >= 400) failedReqs.push(m.params.response.status + ' ' + m.params.response.url);
    } else if (m.method === 'Log.entryAdded') {
        consoleMsgs.push({ level: m.params.entry.level, text: m.params.entry.text });
    }
});

const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
});

// SMOKE_SHOTS=<dir> saves a screenshot of each world, taken from a few blocks
// above the player so the terrain surface is in view.
async function screenshot(name) {
    const dir = process.env.SMOKE_SHOTS;
    if (!dir) return;
    await evalJs(`(() => { window.me.position.y += 7; return 1; })()`);
    await sleep(60);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, 'base64'));
    console.log('screenshot:', path.join(dir, `${name}.png`));
}

const evalJs = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise, allowUnsafeEvalBlocking: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
// A page that believes it is in the background stops drawing: with the flags
// above, this keeps a headless window alive when the display sleeps.
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Network.enable');

console.log('navigating to', `${base}/game.html`);
await send('Page.navigate', { url: `${base}/game.html` });

// Wait for gamepack loading to finish (the title screen is the signal) rather
// than guessing at a delay — starting a world early meant the workers got an
// empty biome list.
let ready = false;
for (let i = 0; i < 80; i++) {
    await sleep(500);
    ready = await evalJs(`(() => {
        const t = document.getElementById('TitleScreen');
        return !!t && !t.classList.contains('hidden');
    })()`).catch(() => false);
    if (ready) break;
}
console.log('gamepacks loaded / title screen up:', ready);

// ── Environment sanity ───────────────────────────────────────────────────────
const env = await evalJs(`(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
        webgl2: !!gl,
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        hasStartWorld: typeof window.startWorld === 'function',
        // mergedGamePackData is a module-scope const in a classic script, so it
        // is not on window; count the rendered gamepack UI instead.
        packsLoaded: typeof packsLoaded !== 'undefined' ? packsLoaded : 'n/a',
    };
})()`);
console.log('environment:', env);

// ── Create a world through the real API, then start it ───────────────────────
// Started from the record the server returns, exactly as the create-world
// screen does, so the world gets the server's default terrain style (smooth).
const world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Headless', seed: 2024, gameMode: 'CREATIVE' }),
})).json();
console.log('world created:', world.id.slice(0, 8), 'seed', world.seed, 'terrain', world.terrainStyle);

await evalJs(`startWorld(${JSON.stringify({ ...world, playerPos: { x: 0, y: 100, z: 0 } })}); 'started'`);

// Let terrain generate + mesh. Software rasterisation is slow, so be generous.
for (let i = 0; i < 12; i++) {
    await sleep(2500);
    const s = await evalJs(`(() => {
        const r = window.__wwDebug ? window.__wwDebug() : null;
        return r;
    })()`).catch(() => null);
    if (s && s.meshes > 0) { console.log(`  t+${(i+1)*2.5}s meshes=${s.meshes} drawCalls=${s.drawCalls} tris=${s.tris}`); }
}

const final = await evalJs(`(() => {
    const r = window.__wwDebug ? window.__wwDebug() : null;
    return { debug: r, loadingHidden: document.getElementById('loadingContainer')?.classList.contains('hidden') };
})()`);
console.log('final state:', JSON.stringify(final));
await screenshot('world1-smooth');

// ── Day cycle and weather ────────────────────────────────────────────────────
// Runs every atmosphere shader path in the real renderer: both skies, both
// cloud levels, shadows following a moving sun, each kind of precipitation,
// lightning, a tornado, fog and dust. A shader that fails to compile shows up
// in the console-error count below; a scene that does not take effect fails
// atmosOk. SMOKE_SHOTS saves a screenshot of each.
const dispatch = (name, data) => evalJs(`(() => { const e = new Event('WorldJS_${name}'); e.data = ${JSON.stringify(data)}; document.dispatchEvent(e); return 1; })()`);
// Eye Adaptation on for all of it: every shader draws into PostFX's linear
// target, and the whole post chain (meter, adapt, bloom, composite) runs. Far
// Terrain too, so its tiles are built, swapped in and drawn under every sky.
await dispatch('applySettings', { sky: 'pretty', clouds: 'fancy', particles: 'high', shadows: 'medium', eyeAdaptation: 'on', farTerrain: 16 });
const scenes = [
    ['noon-sunny',          12,   'sunny'],
    ['sunset-thunderstorm', 18,   'thunderstorm'],
    ['morning-heavy-snow',  9,    'heavy_snow'],
    ['night-clear',         23,   'clear'],
    ['morning-dense-fog',   7,    'dense_fog'],
    ['afternoon-tornado',   16,   'tornado'],
    ['noon-dusty',          13,   'dusty'],
    ['hail',                14,   'hailstorm'],
    ['simple-sky-rain',     15,   'rain'],
    ['simple-sky-night',    1,    'mostly_sunny'],
];
let atmosOk = true;
for (const [name, hours, weather] of scenes) {
    if (name.startsWith('simple')) await dispatch('applySettings', { sky: 'simple', clouds: 'fast', particles: 'medium' });
    // Snap straight to the weather: software rendering runs at a few frames a
    // second, far too slow to watch it roll in.
    await dispatch('setAtmosphere', { hours, weather, immediate: true });
    await sleep(4000);
    const a = (await evalJs(`window.__wwDebug ? window.__wwDebug().atmosphere : null`).catch(() => null)) ?? {};
    const h = parseInt(String(a.time).split(':')[0], 10);
    // The GPU must see the clouds the weather has (they also place the rain).
    const ok = a.weather === weather && Math.abs(h - hours) <= 1 && (a.cover < 0.05 || a.gpuClouds);
    if (!ok) atmosOk = false;
    console.log(`  ${ok ? 'OK   ' : 'WRONG'} ${name.padEnd(22)} ${a.time} ${a.weatherLabel} cover=${a.cover} wind=${a.wind} sky=${a.sky} clouds=${a.clouds}${a.tornado ? ' tornado' : ''} particles=${JSON.stringify(a.particles)}`);
    // Headless has no pointer lock, so the pause menu is up; hide it for the shot.
    await evalJs(`document.getElementById('PauseScreen').style.visibility = 'hidden'`).catch(() => {});
    await screenshot('atmos-' + name);
    await evalJs(`document.getElementById('PauseScreen').style.visibility = ''`).catch(() => {});
}

// Far Terrain has been on through the scenes: every tile of its selection must
// be built and on screen, and the fog must have moved out to its end.
// (Its tiles are built behind all chunk work, so on a busy machine they can
// still be on their way: give them a while.)
const farNow = async () => (await evalJs(`(() => { const d = window.__wwDebug(); return { ...d.far, fogFar: d.fogFar, renderDist: d.renderDist }; })()`).catch(() => null)) ?? {};
let far = await farNow();
for (let i = 0; i < 120 && !(far.shown > 0 && far.shown === far.wanted); i++) { await sleep(500); far = await farNow(); }
const farOk = far.extra === 16 && far.shown > 0 && far.shown === far.wanted && far.fogFar === (far.renderDist + 16) * 16;
console.log(`  ${farOk ? 'OK   ' : 'WRONG'} far-terrain            ${JSON.stringify(far)}`);

// ── Torches, a lantern and a lamp at night ───────────────────────────────────
// Block light (Blocklight.js) reaches the chunk shader, the models draw, and a
// torch in hand lights the ground. Placed on the ground around the player.
await dispatch('setAtmosphere', { hours: 0, weather: 'clear', immediate: true });
const lit = await evalJs(`(() => {
    const p = window.me.position, x = Math.floor(p.x), z = Math.floor(p.z);
    const dbg = window.__wwDebug();
    let placed = 0;
    // Ground height at a column: the first block below the player's head.
    const ground = (gx, gz) => {
        for (let y = Math.floor(p.y) + 8; y > Math.floor(p.y) - 30; y--) {
            if (window.__wwBlockAt(gx, y, gz) !== 0) return y;
        }
        return Math.floor(p.y) - 1;
    };
    const spots = [[3, 0, 'TORCH'], [-3, 2, 'TORCH'], [0, -4, 'LANTERN'], [4, 4, 'LAMP'], [-4, -3, 'TORCH']];
    for (const [dx, dz, name] of spots) {
        const gy = ground(x + dx, z + dz);
        if (window.__wwSetBlock(x + dx, gy + 1, z + dz, name)) placed++;
    }
    window.me.inventory?.addItem('torch', 4);
    return { placed, eye: dbg.eyeAdaptation, supported: dbg.eyeAdaptationSupported };
})()`);
await evalJs(`window.__wwLook(0.6, -0.75)`);   // down at the torches
await sleep(5000);
// The light comes with the chunks' next mesh; on a busy machine that can take longer.
let litAfter = await evalJs(`window.__wwDebug()`);
for (let i = 0; i < 80 && !(litAfter.blockLitChunks > 0); i++) { await sleep(500); litAfter = await evalJs(`window.__wwDebug()`); }
const torchOk = lit.placed === 5 && litAfter.blockLitChunks > 0 && litAfter.eyeAdaptation === true;
console.log(`  ${torchOk ? 'OK   ' : 'WRONG'} torches-night          placed=${lit.placed} blockLitChunks=${litAfter.blockLitChunks} eyeAdaptation=${litAfter.eyeAdaptation} (supported ${lit.supported})`);
if (!torchOk) atmosOk = false;
await evalJs(`document.getElementById('PauseScreen').style.visibility = 'hidden'`).catch(() => {});
await screenshot('torches-night');
await dispatch('applySettings', { eyeAdaptation: 'off' });
await sleep(1500);
await screenshot('torches-night-no-eye-adaptation');
await evalJs(`document.getElementById('PauseScreen').style.visibility = ''`).catch(() => {});


// ── Mobs ─────────────────────────────────────────────────────────────────────
// One of each around the player, by day: every one gets its model and stands
// on the ground; a struck pig runs, a struck Quiddle comes for the player, and
// a killed chicken falls and is gone.
await dispatch('setAtmosphere', { hours: 11, weather: 'sunny', immediate: true });
await dispatch('applySettings', { eyeAdaptation: 'on' });
const mobTypes = ['cow', 'pig', 'sheep', 'chicken', 'quiddle', 'quiddle', 'quiddle'];
const spawned = await evalJs(`(() => {
    const p = window.me.position, x = Math.floor(p.x), z = Math.floor(p.z);
    const ground = (gx, gz) => {
        for (let y = Math.floor(p.y) + 8; y > Math.floor(p.y) - 30; y--) if (window.__wwBlockAt(gx, y, gz) !== 0) return y;
        return Math.floor(p.y) - 1;
    };
    const types = ${JSON.stringify(mobTypes)};
    let n = 0;
    types.forEach((t, i) => {
        const a = -0.9 + i * 0.3, r = 5 + (i % 2) * 1.5;
        const gx = x + Math.round(-Math.sin(a + 0.6) * r), gz = z + Math.round(-Math.cos(a + 0.6) * r);
        if (window.__wwSpawnMob(t, gx + 0.5, ground(gx, gz) + 1.05, gz + 0.5) != null) n++;
    });
    return n;
})()`);
await evalJs(`window.__wwLook(0.6, -0.28)`);
await sleep(2500);
await evalJs(`document.getElementById('PauseScreen').style.visibility = 'hidden'`).catch(() => {});
await screenshot('mobs');
await evalJs(`document.getElementById('PauseScreen').style.visibility = ''`).catch(() => {});
// They are dropped in just above the ground: wait for them to land (frames can be very slow here).
let mobsBefore = await evalJs(`window.__wwMobs()`);
for (let i = 0; i < 40 && mobsBefore.filter(m => m.onGround).length < mobsBefore.length - 1; i++) { await sleep(500); mobsBefore = await evalJs(`window.__wwMobs()`); }
const mine = mobsBefore.filter(m => mobTypes.includes(m.type));
const struck = await evalJs(`(() => {
    const hit = (type, dmg) => { const m = window.__wwMobs().find(m => m.type === type); return m ? window.__wwHitMob(m.x, m.y, m.z, dmg) : 0; };
    return { pig: hit('pig', 1), quiddle: hit('quiddle', 1), chicken: hit('chicken', 99) };
})()`);
let mobsHit = await evalJs(`window.__wwMobs()`);
for (let i = 0; i < 20 && !mobsHit.some(m => m.state === 'DYING'); i++) { await sleep(250); mobsHit = await evalJs(`window.__wwMobs()`); }
// The chicken lies a moment, then is gone (game time: frames are slow in software rendering).
let mobsAfter = mobsHit;
for (let i = 0; i < 40 && mobsAfter.some(m => m.state === 'DYING'); i++) { await sleep(500); mobsAfter = await evalJs(`window.__wwMobs()`); }
const mobOk = spawned === mobTypes.length && mine.length >= mobTypes.length && mine.every(m => m.model) &&
    mine.filter(m => m.onGround).length >= mine.length - 1 &&
    mobsHit.some(m => m.type === 'pig' && m.state === 'FLEE') && mobsHit.some(m => m.type === 'quiddle' && m.state === 'ATTACK') &&
    mobsHit.some(m => m.type === 'chicken' && m.state === 'DYING') &&
    !mobsAfter.some(m => m.state === 'DYING');
console.log(`  ${mobOk ? 'OK   ' : 'WRONG'} mobs                   spawned=${spawned} modelled=${mine.filter(m => m.model).length} grounded=${mine.filter(m => m.onGround).length} ` +
            `states=${mobsHit.map(m => m.type.slice(0, 2) + ':' + m.state).join(' ')}`);
if (!mobOk) atmosOk = false;

// ── A controller ─────────────────────────────────────────────────────────────
// A made-up one, through the Gamepad API (src/gamepad.js): it must be able to
// play with no pointer lock (a page cannot take the pointer on a controller
// button), move the player, and pause and resume by itself.
await evalJs(`(() => {
    const p = window.__fakePad = { connected: true, mapping: 'standard', id: 'Smoke pad', index: 0, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    navigator.getGamepads = () => [p];
    window.dispatchEvent(new Event('gamepadconnected'));
    return 1;
})()`);
// A press lasts a few frames, however long those are here: the controller is
// read once a frame, and in software rendering a frame can outlast any sleep.
const padFrames = () => evalJs(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(1)))))`, true);
const padTap = async (i) => {
    await evalJs(`(() => { const b = window.__fakePad.buttons[${i}]; b.pressed = true; b.value = 1; return 1; })()`);
    await padFrames();
    await evalJs(`(() => { const b = window.__fakePad.buttons[${i}]; b.pressed = false; b.value = 0; return 1; })()`);
    await padFrames();
};
const padState = () => evalJs(`({ active: window.__wwPad.active, play: window.__wwPad.play, paused, focus: document.querySelector('.padFocus')?.textContent.trim() ?? null })`);
await padTap(4);                                              // LB: any input makes it the device in use
if ((await padState()).paused) await padTap(0);               // on the pause menu (no pointer lock here): A on Resume
const padStart = await padState();
const padFrom = await evalJs(`({ x: window.me.position.x, z: window.me.position.z })`);
await evalJs(`window.__fakePad.axes = [0, -1, 0, 0]; 1`);
let padMoved = 0;
for (let i = 0; i < 30 && padMoved < 0.5; i++) {              // frames are slow in software rendering
    await sleep(400);
    padMoved = await evalJs(`Math.hypot(window.me.position.x - ${padFrom.x}, window.me.position.z - ${padFrom.z})`);
}
await evalJs(`window.__fakePad.axes = [0, 0, 0, 0]; 1`);
await padTap(9);                                              // Start: pause
const padPaused = await padState();
await padTap(0);                                              // A on Resume
const padResumed = await padState();
await evalJs(`window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); 1`);
await padFrames();
const padAfter = await padState();
const padOk = padStart.play && !padStart.paused && padMoved >= 0.5 &&
    padPaused.paused && !padPaused.play && padPaused.focus === 'Resume' &&
    padResumed.play && !padResumed.paused && !padAfter.active && !padAfter.play;
console.log(`  ${padOk ? 'OK   ' : 'WRONG'} controller             play=${padStart.play} moved=${padMoved.toFixed(2)} ` +
            `paused=${padPaused.paused} focus=${padPaused.focus} resumed=${padResumed.play} mouseTakesOver=${!padAfter.active}`);
if (!padOk) atmosOk = false;
await evalJs(`navigator.getGamepads = () => []; window.dispatchEvent(new Event('gamepaddisconnected')); 1`);

await evalJs(`window.__wwLook(0, 0)`);
await dispatch('setAtmosphere', { weather: 'dynamic', daylightCycle: true });

// ── Quit and re-enter ────────────────────────────────────────────────────────
// Exercises teardown (EntityManager.dispose, mesh disposal, worker pool
// termination, HUD cache reset) and a second world load in the same session.
// A leak or a stale handle here shows up as an error or as geometries that
// never drop back toward zero.
console.log('\nquitting world...');
await evalJs(`(() => { const e = new Event('WorldJS_quitWorld'); e.data = {}; document.dispatchEvent(e); return 1; })()`);
await sleep(3000);
const afterQuit = await evalJs(`window.__wwDebug ? window.__wwDebug() : null`);
console.log('after quit :', JSON.stringify(afterQuit));

// The second world is switched to blocky terrain through the hidden world
// setting, so one run covers both terrain styles and the switch between them.
console.log('re-entering a second world (blocky terrain)...');
const world2 = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Headless 2', seed: 555, gameMode: 'SURVIVAL' }),
})).json();
await fetch(`${base}/api/worlds/${world2.id}/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terrainStyle: 'blocky' }),
});
const meta2 = await (await fetch(`${base}/api/worlds/${world2.id}`)).json();
await evalJs(`startWorld(${JSON.stringify({ ...meta2, playerPos: { x: 0, y: 100, z: 0 } })}); 'started'`);
for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const s = await evalJs(`window.__wwDebug ? window.__wwDebug() : null`).catch(() => null);
    if (s?.meshes > 0) console.log(`  t+${(i + 1) * 2.5}s meshes=${s.meshes} geometries=${s.geometries} textures=${s.textures}`);
}
const afterReenter = await evalJs(`window.__wwDebug ? window.__wwDebug() : null`);
console.log('after re-entry:', JSON.stringify(afterReenter));
await screenshot('world2-blocky');

// New worlds default to smooth, the hidden setting switches one to blocky, and
// each world must load in that style and produce geometry.
const styleOk = world.terrainStyle === 'smooth' && meta2.terrainStyle === 'blocky' &&
                final.debug?.terrainStyle === 'smooth' && afterReenter?.terrainStyle === 'blocky';
const meshOk  = (final.debug?.meshes ?? 0) > 0 && (afterReenter?.meshes ?? 0) > 0;
// A hidden page gets no animation frames, so nothing loads or renders — which
// otherwise shows up only as a world with no meshes. Windows can report the
// headless window as occluded (Edge does, with the display off).
if (await evalJs(`document.visibilityState`).catch(() => '') === 'hidden') {
    console.log('WARNING: the page went hidden, so the browser stopped rendering it. ' +
                'Rerun with the display on, or with BROWSER=<path to chrome.exe>.');
}
console.log(`terrain styles: ${final.debug?.terrainStyle} -> ${afterReenter?.terrainStyle}  ${styleOk ? 'OK' : 'WRONG'}`);
console.log(`atmosphere scenes: ${atmosOk ? 'OK' : 'WRONG'}`);
console.log(`far terrain: ${farOk ? 'OK' : 'WRONG'}`);

// ── Report ───────────────────────────────────────────────────────────────────
const errs  = consoleMsgs.filter(m => m.level === 'error');
const warns = consoleMsgs.filter(m => m.level === 'warning' || m.level === 'warn');

console.log(`\nconsole errors: ${errs.length}`);
for (const e of errs.slice(0, 25)) console.log('   ERROR  ', e.text.slice(0, 400));
console.log(`page exceptions: ${pageErrors.length}`);
const excKinds = {}; for (const e of pageErrors) { const k = String(e).split(':')[0]; excKinds[k] = (excKinds[k]||0)+1; }
console.log('   exception kinds:', JSON.stringify(excKinds));
console.log(`failed requests: ${failedReqs.length}`);
for (const f of [...new Set(failedReqs)]) console.log('   HTTP   ', f);
console.log(`console warnings: ${warns.length}`);
const warnSeen = new Set();
for (const w of warns) {
    const k = w.text.slice(0, 90);
    if (warnSeen.has(k)) continue;
    warnSeen.add(k);
    console.log('   WARN   ', w.text.slice(0, 300));
}

try { ws.close(); } catch {}
edge.kill();
await sleep(500);
process.exit(errs.length === 0 && pageErrors.length === 0 && styleOk && meshOk && atmosOk && farOk ? 0 : 1);
