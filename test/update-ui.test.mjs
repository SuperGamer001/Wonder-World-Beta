// Drives the real page in headless Chromium: stubs update states into the
// server and checks the question the game asks about an update — when it is
// asked, what each answer does, that online play waits for the update — and
// the Settings check button. Covers the UI paths the main smoke test never reaches.
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

const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

await ev(`fetchUpdateStatus()`); await sleep(400);
ck('version label shows the real version',
   (await ev(`document.getElementById('versionText')?.textContent`)) === `Wonder World Beta v${pkgVersion}`,
   await ev(`document.getElementById('versionText')?.textContent`));

ck('nothing is asked when the game is up to date', (await promptUp()) === false && (await ev(`updatePending()`)) === false);

// What the launcher does, stood in for: it can check, and it can install.
let installs = 0;
server.setUpdateHandlers({ onCheck: async () => {}, onInstall: () => { installs++; } });

// An update that came out while the game was open, where the app cannot install it — the macOS / unsigned path.
server.setUpdateState({
    supported: true, available: true, canAutoInstall: false, downloaded: false,
    newVersion: '1.0.0-beta.2', downloadUrl: 'https://example.invalid/dl',
});
await ev(`fetchUpdateStatus().then(maybeAskUpdate)`); await sleep(300);
ck('the player is asked when an update is out', (await promptUp()) === true);
let txt = await promptText();
ck('… which version, and whether to update now', txt.includes('1.0.0-beta.2') && txt.includes('Update Now') && txt.includes('Not Now'), txt);
ck('… and that online play waits for it', /online/i.test(txt), txt);

// Not now: the question goes away, and stays away.
await press('updateLaterBtn'); await sleep(200);
ck('Not Now puts the question away', (await promptUp()) === false && (await titleUp()) === true);
await ev(`fetchUpdateStatus().then(maybeAskUpdate)`); await sleep(300);
ck('… and it is not asked again', (await promptUp()) === false);

// Until it is installed, there is no playing online.
ck('online play is off until the update is installed', (await ev(`updatePending()`)) === true);
await ev(`openLanJoin(); 1`); await sleep(200);
await ev(`joinOnline('ABCD-EFGH')`); await sleep(200);
const refused = await ev(`document.getElementById('lanJoinNote').textContent`);
ck('… a game cannot be joined with its code', /update/i.test(refused), refused);
await ev(`closeLanJoin(); 1`);

// Settings → Check for Updates asks again.
await ev(`checkForUpdatesNow()`); await sleep(600);
const st = await ev(`document.getElementById('updateCheckStatus')?.textContent`);
ck('settings reports a check result', st === 'Version 1.0.0-beta.2 available', st);
ck('check button label restored', (await ev(`document.getElementById('settingCheckUpdates')?.textContent`)) === 'Check for Updates');
ck('… and asks the question again', (await promptUp()) === true);
// Update Now, where the app cannot install it: the download page, and a way to carry on.
await ev(`window.open = (url) => { window.__opened = url; }; 1`);
await press('updateNowBtn'); await sleep(200);
txt = await promptText();
ck('Update Now opens the download page', (await ev(`window.__opened`)) === 'https://example.invalid/dl' && txt.includes('download page'), txt);
await press('updateLaterBtn'); await sleep(200);
ck('… and the game can be carried on with', (await promptUp()) === false);

// Where the app can install it — the Windows path: downloading, then installed by itself.
server.setUpdateState({ canAutoInstall: true, downloaded: false, progress: 40 });
await ev(`checkForUpdatesNow()`); await sleep(500);
await press('updateNowBtn'); await sleep(900);
txt = await promptText();
ck('Update Now shows the download on its way', txt.includes('Downloading') && txt.includes('40%') && installs === 0, txt);
server.setUpdateState({ downloaded: true, progress: 100 });
ck('… and installs it the moment it is here', await until(async () => installs === 1, 5000), `installs=${installs}`);
txt = await promptText();
ck('… saying so', txt.includes('restart'), txt);

// At startup the question comes first: before the title, with the game waiting behind it.
server.setUpdateState({ canAutoInstall: false, downloaded: false, progress: 0 });
await send('Page.navigate', { url: `${base}/game.html` });
ck('started with an update out, the game asks before anything else', await until(promptUp, 30000) && (await titleUp()) === false);
await press('updateLaterBtn');
ck('… and goes on to the title when answered', await until(titleUp, 8000) && (await promptUp()) === false);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
ws.close(); kill();
await sleep(200);
process.exit(fails === 0 ? 0 : 1);
