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
const world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Headless', seed: 2024, gameMode: 'CREATIVE' }),
})).json();
console.log('world created:', world.id.slice(0, 8), 'seed', world.seed);

await evalJs(`startWorld(${JSON.stringify({
    id: world.id, seed: world.seed, gameMode: 'CREATIVE',
    playerPos: { x: 0, y: 100, z: 0 }, name: 'Headless',
})}); 'started'`);

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

console.log('re-entering a second world...');
const world2 = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Headless 2', seed: 555, gameMode: 'SURVIVAL' }),
})).json();
await evalJs(`startWorld(${JSON.stringify({
    id: world2.id, seed: world2.seed, gameMode: 'SURVIVAL',
    playerPos: { x: 0, y: 100, z: 0 }, name: 'Headless 2',
})}); 'started'`);
for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const s = await evalJs(`window.__wwDebug ? window.__wwDebug() : null`).catch(() => null);
    if (s?.meshes > 0) console.log(`  t+${(i + 1) * 2.5}s meshes=${s.meshes} geometries=${s.geometries} textures=${s.textures}`);
}
const afterReenter = await evalJs(`window.__wwDebug ? window.__wwDebug() : null`);
console.log('after re-entry:', JSON.stringify(afterReenter));

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
process.exit(errs.length === 0 && pageErrors.length === 0 ? 0 : 1);
