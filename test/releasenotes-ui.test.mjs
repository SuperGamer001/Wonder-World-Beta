// The release notes in the real page: they come up by themselves the first
// time a newer version is played, not again, and Settings opens them.
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

// A notes file of the test's own (the game's may be half written between
// releases): three versions with "---" between them, the oldest with nothing
// under its title. The first is the version this run is.
const VERSION = '9.9.9';
const NOTES = [
    '# **Wonder World 9.9.9** Release Notes:', '',
    '### Added', '- One thing', '- Another **bold** thing', '  carried on', '',
    '### Fixed', '- A bug', '',
    '---', '',
    '# **Wonder World 9.9.8** Release Notes:', '',
    '### Older', '- Old news', '',
    '---', '',
    '# **Wonder World 9.9.7** Release Notes:', '',
].join('\r\n');
const SECTIONS = ['Added', 'Fixed'];           // this version's
const ITEMS = 3, ALL_ITEMS = 4;
process.env.WW_APP_VERSION = VERSION;

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-notes-ui-'));
process.env.WW_RELEASE_NOTES = path.join(process.env.WONDER_DATA_DIR, 'ReleaseNotes.txt');
fs.writeFileSync(process.env.WW_RELEASE_NOTES, NOTES);
const server = await import('../server/server.js');
const { port, host } = await server.serverReady;
const base = `http://${host}:${port}`;

const DBG = 9920 + (process.pid % 30);
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
const settings = async () => (await fetch(`${base}/api/settings`)).json();
const putSettings = (body) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const reload = async () => {
    await sleep(600);                                   // a change of settings is sent a quarter of a second after it is made
    await send('Page.navigate', { url: `${base}/game.html` });
    return until(titleUp, 30000);
};
const text = (id) => ev(`document.getElementById('${id}').textContent.replace(/\\s+/g, ' ').trim()`);

// ── The first start of a newer version, for someone who was here before ──────
// (The run began with a player already named and no version on record: an
// update from a version that kept none.)
ck('the title is up', await until(titleUp, 30000));
ck('a newer version than was played last shows what is new', await until(() => up('ReleaseNotesScreen'), 6000));
ck('… as "What\'s New", naming the version', (await text('releaseNotesTitle')) === "What's New" && (await text('releaseNotesSub')).includes(VERSION), await text('releaseNotesSub'));
const shape = await ev(`(() => { const b = document.getElementById('releaseNotesBody'); return { h: [...b.querySelectorAll('h3')].map(e => e.textContent), items: b.querySelectorAll('li').length, boxes: b.querySelectorAll('.releaseNotesBox').length, raw: /[#*]{2}|^- |---/m.test(b.textContent), title: /Release Notes/.test(b.textContent), old: /Old news|9\\.9\\.8/.test(b.textContent), bold: b.querySelector('li strong')?.textContent, carried: /thing carried on/.test(b.textContent) }; })()`);
ck('… with this version\'s sections and items, in one box', shape.boxes === 1 && shape.h.length === SECTIONS.length && shape.h.every((h, i) => h === SECTIONS[i]) && shape.items === ITEMS, `${shape.h.join(' | ')} — ${shape.items} items, ${shape.boxes} box(es)`);
ck('… and nothing of an older version\'s', !shape.old);
ck('… drawn, not as marks', !shape.raw && !shape.title && shape.bold === 'bold' && shape.carried);
ck('… over the title, with Continue', (await titleUp()) && (await text('releaseNotesCloseBtn')) === 'Continue');
await press('releaseNotesCloseBtn');
ck('Continue puts it away', (await up('ReleaseNotesScreen')) === false);
ck('the version played is kept with the settings', await until(async () => (await settings()).lastVersion === VERSION, 4000), (await settings()).lastVersion);

// ── The same version again ───────────────────────────────────────────────────
await reload();
await sleep(1500);
ck('started again in the same version, nothing comes up', (await up('ReleaseNotesScreen')) === false);

// ── From an older one ────────────────────────────────────────────────────────
await putSettings({ lastVersion: '0.0.9' });
await reload();
ck('started after playing an older version, it comes up again', await until(() => up('ReleaseNotesScreen'), 6000));
await press('releaseNotesCloseBtn');
ck('… and the record moves on', await until(async () => (await settings()).lastVersion === VERSION, 4000));

// ── From a newer one (an older copy of the game run after a newer) ───────────
await putSettings({ lastVersion: '99.0.0' });
await reload();
await sleep(1500);
ck('going back to an older version shows nothing', (await up('ReleaseNotesScreen')) === false);
ck('… but is recorded', await until(async () => (await settings()).lastVersion === VERSION, 4000));

// ── Settings → Game → Release Notes ──────────────────────────────────────────
await press('settingReleaseNotes');
ck('Settings opens the release notes', await until(() => up('ReleaseNotesScreen'), 4000));
ck('… as "Release Notes", with Close', (await text('releaseNotesTitle')) === 'Release Notes' && (await text('releaseNotesCloseBtn')) === 'Close', await text('releaseNotesSub'));
const hist = await ev(`(() => { const b = document.getElementById('releaseNotesBody'); return { heads: [...b.querySelectorAll('.releaseNotesBox > h2')].map(e => e.textContent), boxes: [...b.querySelectorAll('.releaseNotesBox')].map(e => e.querySelectorAll('li').length), raw: /[#*]{2}|---|Notes:/.test(b.textContent) }; })()`);
ck('… the whole history, a box a version, newest first', hist.boxes.length === 2 && hist.boxes[0] === ITEMS && hist.boxes[0] + hist.boxes[1] === ALL_ITEMS, hist.boxes.join(' + '));
ck('… each under its version, a version with nothing written left out', hist.heads.length === 2 && hist.heads[0] === 'Wonder World 9.9.9 Release Notes' && hist.heads[1].includes('9.9.8') && !hist.raw, hist.heads.join(' | '));
await press('releaseNotesCloseBtn');

// ── This version's notes not written yet (only older ones in the file) ───────
fs.writeFileSync(process.env.WW_RELEASE_NOTES, NOTES.replace('9.9.9', '9.9.10').replace(/### Added[\s\S]*?---/, '---'));
await putSettings({ lastVersion: '0.0.9' });
await reload();
await sleep(1500);
ck('a version whose notes are not written shows nothing by itself', (await up('ReleaseNotesScreen')) === false);
fs.writeFileSync(process.env.WW_RELEASE_NOTES, NOTES);

// ── Which version is newer ───────────────────────────────────────────────────
const newer = (a, b) => ev(`versionNewer('${a}', '${b}')`);
ck('0.1.2 is newer than 0.1.1', await newer('0.1.2', '0.1.1') && !(await newer('0.1.1', '0.1.2')) && !(await newer('0.1.2', '0.1.2')));
ck('0.10.0 is newer than 0.9.9', await newer('0.10.0', '0.9.9'));
ck('beta.10 is newer than beta.9, and a release than its betas', await newer('1.0.0-beta.10', '1.0.0-beta.9') && await newer('1.0.0', '1.0.0-beta.10') && !(await newer('1.0.0-beta.2', '1.0.0')));

// ── Notes left over from the last release are not shown as this one's ────────
await ev(`window.__realFetch = window.fetch; window.fetch = (u, o) => String(u).includes('/api/release-notes')
    ? Promise.resolve(new Response(JSON.stringify({ version: '5.0.0', notesVersion: '4.9.0', text: '# Old\\n- old news' }), { headers: { 'Content-Type': 'application/json' } }))
    : window.__realFetch(u, o); 1`);
await ev(`maybeShowWhatsNew(true)`);
await sleep(400);
ck('notes that are another version\'s are not shown', (await up('ReleaseNotesScreen')) === false);
await ev(`window.fetch = window.__realFetch; 1`);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
ws.close(); kill();
await sleep(200);
process.exit(fails === 0 ? 0 : 1);
