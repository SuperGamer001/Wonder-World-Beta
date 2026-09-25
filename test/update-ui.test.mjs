// Drives the real renderer in headless Chromium: stubs update states into the
// server and checks the banner, its wording, when it hides, and the Settings
// check button. Covers the UI paths the main smoke test never reaches.
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
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const BROWSER = BROWSERS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) { console.error('No Chromium-family browser found. Set BROWSER=<path>.'); process.exit(2); }

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-update-ui-'));
const server = await import('../server/server.js');
const { port, host } = await server.serverReady;
const base = `http://${host}:${port}`;

const DBG = 9800 + (process.pid % 150);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-uiprof-'));
const br = spawn(BROWSER, [
    '--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader', `--remote-debugging-port=${DBG}`,
    `--user-data-dir=${prof}`, '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });
const kill = () => { try { br.kill('SIGKILL'); } catch {} };
process.on('exit', kill);
process.on('uncaughtException', e => { console.error(e); kill(); process.exit(1); });
process.on('unhandledRejection', e => { console.error(e); kill(); process.exit(1); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
        const l = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
        wsUrl = l.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch { /* not up */ }
    if (!wsUrl) await sleep(250);
}
if (!wsUrl) { console.error('browser debugger unreachable'); kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
ws.setMaxListeners(0);
await new Promise(r => ws.once('open', r));
let id = 0;
const pend = new Map();
ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.id != null) {
        const p = pend.get(m.id);
        if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    }
});
const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${base}/game.html` });
for (let i = 0; i < 60; i++) {
    await sleep(500);
    const up = await ev(`(() => { const t = document.getElementById('TitleScreen'); return !!t && !t.classList.contains('hidden'); })()`).catch(() => false);
    if (up) break;
}

let fails = 0;
const ck = (n, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const bannerVisible = () => ev(`!document.getElementById('updateBanner').classList.contains('hidden')`);
const bannerText    = () => ev(`document.getElementById('updateBanner').textContent`);

const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

await ev(`fetchUpdateStatus()`); await sleep(400);
ck('version label shows the real version',
   (await ev(`document.getElementById('versionText')?.textContent`)) === `Wonder World Beta v${pkgVersion}`,
   await ev(`document.getElementById('versionText')?.textContent`));

ck('no banner when up to date', (await bannerVisible()) === false);

// Update available but not auto-installable — the macOS / unsigned path.
server.setUpdateState({
    supported: true, available: true, canAutoInstall: false, downloaded: false,
    newVersion: '1.0.0-beta.2', downloadUrl: 'https://example.invalid/dl',
});
await ev(`fetchUpdateStatus()`); await sleep(300);
ck('banner appears when an update is available', (await bannerVisible()) === true);
let txt = await bannerText();
ck('banner offers a manual download', txt.includes('1.0.0-beta.2') && txt.includes('Download'), txt);

// Downloaded and installable — the Windows path.
server.setUpdateState({ canAutoInstall: true, downloaded: true });
await ev(`fetchUpdateStatus()`); await sleep(300);
txt = await bannerText();
ck('banner offers restart once downloaded', txt.includes('Restart') && txt.includes('ready'), txt);

// Must never cover live gameplay.
await ev(`gameStarted = true; paused = false; _menuOpen = false; renderUpdateBanner(); 1`);
ck('banner hidden during active play', (await bannerVisible()) === false);
await ev(`paused = true; renderUpdateBanner(); 1`);
ck('banner returns on the pause screen', (await bannerVisible()) === true);
await ev(`gameStarted = false; paused = false; renderUpdateBanner(); 1`);

// Settings → Check for Updates.
await ev(`checkForUpdatesNow()`); await sleep(600);
const st = await ev(`document.getElementById('updateCheckStatus')?.textContent`);
ck('settings reports a check result', typeof st === 'string' && st.length > 0, st);
ck('check button label restored', (await ev(`document.getElementById('settingCheckUpdates')?.textContent`)) === 'Check for Updates');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
ws.close(); kill();
await sleep(200);
process.exit(fails === 0 ? 0 : 1);
