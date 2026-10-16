// What play.test.mjs stands on: the real game in a headless browser, in a
// world of its own, with a mouse and keys as a player has them. The pointer is
// really locked to the game (headless Chromium gives pointer lock to a focused
// page — hence Page.bringToFront), and keys sent through the debugger take the
// browser's own path: Esc included, which is the browser's before it is the
// page's. That is what the smoke test cannot reach, because it never holds
// the pointer. Importing this starts all of it; `finish()` ends it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BROWSERS = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const BROWSER = BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) { console.error('No Chromium-family browser found. Set BROWSER=<path>.'); process.exit(2); }

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-play-'));
const server = await import('../server/server.js');
const { port, host } = await server.serverReady;
const base = `http://${host}:${port}`;

const DBG = 10100 + (process.pid % 400);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-playprof-'));
const br = spawn(BROWSER, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });
const kill = () => { try { br.kill('SIGKILL'); } catch {} };
process.on('exit', kill);
process.on('uncaughtException', e => { console.error(e); kill(); process.exit(1); });
process.on('unhandledRejection', e => { console.error(e); kill(); process.exit(1); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null; } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('browser debugger unreachable'); kill(); process.exit(1); }

const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise(r => ws.once('open', r));
let id = 0;
const pend = new Map(), pageErrors = [];
ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.id != null) {
        const p = pend.get(m.id);
        if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(d.exception?.description ?? d.text);
    }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
const until = async (expr, ms = 8000, every = 100) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if (await ev(expr).catch(() => false)) return true; await sleep(every); }
    return false;
};

let fails = 0;
const ck = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  — ' + detail : ''}`); };

// ── Input, the way a player makes it ─────────────────────────────────────────
const VK = { KeyE: [69, 'e'], KeyC: [67, 'c'], KeyW: [87, 'w'], Escape: [27, 'Escape'], Digit1: [49, '1'] };
const key = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: VK[code][1], windowsVirtualKeyCode: VK[code][0], nativeVirtualKeyCode: VK[code][0] });
const tap = async (code, hold = 70) => { await key('rawKeyDown', code); await sleep(hold); await key('keyUp', code); await sleep(60); };
const mouse = (type, x, y, button = 'left') => send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1 });
const click = async (x = 640, y = 360, button = 'left') => { await mouse('mousePressed', x, y, button); await sleep(40); await mouse('mouseReleased', x, y, button); await sleep(60); };
/** Click the middle of an element. */
const clickOn = async (selector) => {
    const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
    if (!r) throw new Error(`nothing matches ${selector}`);
    await click(r[0], r[1]);
};
const state = () => ev(`(() => ({
    locked: document.pointerLockElement === document.getElementById('GameScreen'),
    paused, menu: _menuOpen,
    pause: !document.getElementById('PauseScreen').classList.contains('hidden'),
    inv: !document.getElementById('InventoryScreen').classList.contains('hidden'),
    panel: !document.getElementById('InteractivePanel').classList.contains('hidden'),
    death: !document.getElementById('DeathScreen').classList.contains('hidden'),
}))()`);
const show = (s) => JSON.stringify(s);
/** Playing: the pointer held, nothing up. */
const playing = (s) => s.locked && !s.paused && !s.menu && !s.pause && !s.inv && !s.panel && !s.death;
/** Get back to playing from wherever a check has left things (so one failure is one failure). */
async function backToPlay() {
    for (let i = 0; i < 6; i++) {
        const s = await state();
        if (playing(s)) return true;
        if (s.death) await clickOn('#respawnBtn');
        else if (s.inv) await clickOn('#invCloseBtn');
        else if (s.panel) await clickOn('#interactivePanelClose');
        else if (s.pause) await clickOn('#pauseResumeBtn, #PauseScreen .menuButton.primary');
        else await click();
        await sleep(1500);
    }
    return playing(await state());
}

await send('Runtime.enable');
await send('Page.enable');
// Who is playing (a new data folder would stop to ask), and a world to play in.
process.env.WW_RELEASE_NOTES = 'none';      // no notes file: "What is New" does not come up over this run
await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tester' }) });
await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'Tester', graphics: 'simple' }) });
const world = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Play', seed: 2024, gameMode: 'SURVIVAL', worldType: 'flat', flat: { mode: 'layers', layers: [{ block: 'GRASS', depth: 1 }, { block: 'DIRT', depth: 3 }, { block: 'STONE', depth: 20 }, { block: 'BEDROCK', depth: 1 }], biome: 'PLAINS', decorations: false, structures: false } }),
})).json();

await send('Page.navigate', { url: `${base}/game.html` });
await until(`(() => { const t = document.getElementById('TitleScreen'); return !!t && !t.classList.contains('hidden'); })()`, 40000, 300);
await ev(`window.__wwMenuWorld?.(false); startWorld(${JSON.stringify(world)}); 1`);
ck('the world loads', await until(`!document.getElementById('GameScreen').classList.contains('hidden') && !_loadingActive`, 90000, 300));
await send('Page.bringToFront');
await sleep(500);

export { ev, send, sleep, until, ck, tap, key, click, clickOn, mouse, state, show, playing, backToPlay, base, world, server, pageErrors };
export const finish = async () => {
    ck('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
    ws.close(); kill();
    await sleep(200);
    process.exit(fails === 0 ? 0 : 1);
};
