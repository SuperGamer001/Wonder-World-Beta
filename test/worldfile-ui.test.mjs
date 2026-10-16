// The world list in the real page: it keeps itself up to date, a world's
// options export it to where the player says, and Import World scans a file
// and adds it only when the player has seen what it is.
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

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-worldfile-ui-'));
const server = await import('../server/server.js');
const { port, host } = await server.serverReady;
const base = `http://${host}:${port}`;

const DBG = 9960 + (process.pid % 30);
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
// A new data folder has no player yet, and the game would stop to ask for a
// name (src/players.js). This run is not about that: say who is playing.
process.env.WW_RELEASE_NOTES = 'none';      // no notes file: "What is New" does not come up over this run
await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tester' }) });
await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'Tester' }) });
await send('Page.navigate', { url: `${base}/game.html` });
for (let i = 0; i < 60; i++) {
    await sleep(500);
    const up = await ev(`(() => { const t = document.getElementById('TitleScreen'); return !!t && !t.classList.contains('hidden'); })()`).catch(() => false);
    if (up) break;
}

let fails = 0;
const ck = (n, ok, d = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const promptUp   = () => ev(`!document.getElementById('UpdatePrompt').classList.contains('hidden')`);
const promptText = () => ev(`document.getElementById('UpdatePrompt').textContent.replace(/\\s+/g, ' ').trim()`);
const titleUp    = () => ev(`!document.getElementById('TitleScreen').classList.contains('hidden')`);
const press      = (id) => ev(`document.getElementById('${id}').click(); 1`);
const until      = async (test, ms = 6000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if (await test().catch(() => false)) return true; await sleep(150); } return false; };

const up = (id) => ev(`!document.getElementById('${id}').classList.contains('hidden')`);
const cards = () => ev(`[...document.querySelectorAll('#worldListContainer .worldCardName')].map(e => e.textContent)`);
const api = (url, method = 'GET', body) => fetch(`${base}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

// ── The list keeps itself up to date ─────────────────────────────────────────
await press('startButton');
ck('Play brings up Your Worlds', await until(() => up('WorldListScreen'), 15000));
ck('… empty, in a new folder', await until(async () => (await cards()).length === 0 && /No worlds yet/.test(await ev(`document.getElementById('worldListContainer').textContent`))));

// A world made behind the page's back — another window, a folder copied in.
const first = await (await api('/api/worlds', 'POST', { name: 'Orchard', seed: 77 })).json();
ck('a world made elsewhere turns up by itself', await until(async () => (await cards()).join() === 'Orchard', 9000), (await cards()).join());

// Drawn again only when it has changed: the cards on screen are left alone.
await ev(`document.querySelector('#worldListContainer .worldCard').dataset.mark = 'kept'; 1`);
await sleep(5000);
ck('… and an unchanged list is not drawn again', (await ev(`document.querySelector('#worldListContainer .worldCard')?.dataset.mark`)) === 'kept');

// The screen coming up again, by whatever hand, asks again.
await ev(`document.getElementById('WorldListScreen').classList.add('hidden'); 1`);
await api('/api/worlds', 'POST', { name: 'Quarry', seed: 78 });
await ev(`document.getElementById('WorldListScreen').classList.remove('hidden'); 1`);
ck('the screen appearing refreshes the list', await until(async () => (await cards()).length === 2, 2500), (await cards()).join());

// ── Export ───────────────────────────────────────────────────────────────────
// The browser's "save where?" window cannot be answered from here: stand in
// for it, and keep what the game writes to the file it is given.
await ev(`window.__saved = null; window.__asked = null;
window.showSaveFilePicker = async (o) => {
    window.__asked = o;
    const parts = [];
    return { name: o.suggestedName, createWritable: async () => new WritableStream({
        write(c) { parts.push(c); },
        close() { window.__saved = new Blob(parts); },
    }) };
}; 1`);
await ev(`[...document.querySelectorAll('#worldListContainer .worldCard')].find(c => c.textContent.includes('Orchard')).querySelector('[data-act="more"]').click(); 1`);
ck('a world\'s options offer Export', await until(() => up('WorldDetailModal')) && await ev(`!!document.getElementById('worldExportBtn')`));
await press('worldExportBtn');
ck('Export asks where to put the file', await until(() => ev(`!!window.__asked`)), await ev(`window.__asked?.suggestedName`));
ck('… suggesting the world\'s name', (await ev(`window.__asked?.suggestedName`)) === 'Orchard.wwworld');
ck('… and writes the world there', await until(() => ev(`!!window.__saved`), 8000));
ck('the file is a world file', (await ev(`window.__saved.slice(0, 6).text()`)) === 'WWEX1\n', `${await ev(`window.__saved.size`)} bytes`);
ck('exporting closed the options', (await up('WorldDetailModal')) === false);

// Cancelling the window does nothing at all.
await ev(`window.__saved = null; window.showSaveFilePicker = async () => { throw new DOMException('closed', 'AbortError'); }; 1`);
await ev(`exportWorld({ id: '${first.id}', name: 'Orchard' }); 1`);
await sleep(600);
ck('closing the window without choosing exports nothing', (await ev(`window.__saved`)) === null);

// ── Import ───────────────────────────────────────────────────────────────────
ck('the list offers Import World', await ev(`!!document.getElementById('importWorldBtn') && document.getElementById('importWorldFile').accept === '.wwworld'`));
await ev(`window.__opened = 0; window.showOpenFilePicker = async () => { window.__opened++; throw new DOMException('closed', 'AbortError'); }; 1`);
await press('importWorldBtn');
ck('Import World asks where the world is', await until(() => ev(`window.__opened === 1`)));

const file = Buffer.from(await (await fetch(`${base}/api/worlds/${first.id}/export`)).arrayBuffer()).toString('base64');
await ev(`window.__file = Uint8Array.from(atob('${file}'), c => c.charCodeAt(0)); 1`);

// A file that is not a world: told so, and nothing to say yes to.
await ev(`importWorld(new File(['holiday photo'], 'beach.wwworld')); 1`);
ck('a file that is not a world is refused after the scan', await until(async () => await up('confirmPopup') && /cannot be imported/.test(await ev(`document.getElementById('confirmMessage').textContent`))),
    await ev(`document.getElementById('confirmMessage').textContent.replace(/\\s+/g, ' ')`));
ck('… with only OK to press', await ev(`getComputedStyle(document.getElementById('confirmNo')).display === 'none' && document.getElementById('confirmYes').textContent === 'OK'`));
await press('confirmYes');
ck('… and nothing was added', (await (await api('/api/worlds')).json()).length === 2);

// The real one: scanned, shown, and added on Yes.
await ev(`importWorld(new File([window.__file], 'Orchard.wwworld')); 1`);
ck('a world file is scanned and shown before it is added', await until(async () => await up('confirmPopup') && /Orchard/.test(await ev(`document.getElementById('confirmMessage').textContent`))),
    await ev(`document.getElementById('confirmMessage').textContent.replace(/\\s+/g, ' ')`));
ck('… with Yes and No again', await ev(`getComputedStyle(document.getElementById('confirmNo')).display !== 'none' && document.getElementById('confirmYes').textContent === 'Yes'`));
ck('… and not before Yes', (await (await api('/api/worlds')).json()).length === 2);
await press('confirmYes');
ck('Yes adds it, and the list shows it', await until(async () => (await cards()).length === 3, 8000), (await cards()).join(' | '));
ck('… under a name of its own', (await cards()).includes('Orchard (Imported)'));

// Saying No leaves things as they are.
await ev(`importWorld(new File([window.__file], 'Orchard.wwworld')); 1`);
await until(() => up('confirmPopup'));
await press('confirmNo');
await sleep(500);
ck('No adds nothing', (await (await api('/api/worlds')).json()).length === 3);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
ws.close(); kill();
await sleep(200);
process.exit(fails === 0 ? 0 : 1);
