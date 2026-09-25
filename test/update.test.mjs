// Exercises the update status bridge the way the launcher and the renderer use
// it: the launcher publishes state into the server, the renderer reads it back
// over HTTP, and a manual check round-trips through the registered handler.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-update-'));
const server = await import('../server/server.js');
const { port, host } = await server.serverReady;
const base = `http://${host}:${port}`;

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const status = () => fetch(`${base}/api/update-status`).then(r => r.json());

// ── Default state: no launcher attached (plain `npm run server`) ─────────────
let s = await status();
check('reports unsupported without a launcher', s.supported === false);
check('still reports the real app version', /^\d+\.\d+\.\d+/.test(s.currentVersion ?? ''), s.currentVersion);
check('claims no update by default', s.available === false);

const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
check('version matches package.json', s.currentVersion === pkgVersion, `${s.currentVersion} vs ${pkgVersion}`);

// A manual check with no handler registered must not throw or hang.
const noHandler = await (await fetch(`${base}/api/update-check`, { method: 'POST' })).json();
check('manual check is safe with no launcher', noHandler.supported === false);

// Installing when nothing is downloaded must be refused, not acted on.
const badInstall = await fetch(`${base}/api/update-install`, { method: 'POST' });
check('install refused when nothing is downloaded', badInstall.status === 409, `HTTP ${badInstall.status}`);

// ── With a launcher attached ─────────────────────────────────────────────────
let checksRun = 0, installsRun = 0;
server.setUpdateHandlers({
    onCheck:   async () => { checksRun++; server.setUpdateState({ checking: false, available: true, newVersion: '1.0.0-beta.2', canAutoInstall: true, lastChecked: Date.now() }); },
    onInstall: () => { installsRun++; },
});
server.setUpdateState({ supported: true, canAutoInstall: true });

s = await status();
check('reports supported once a launcher attaches', s.supported === true);

const checked = await (await fetch(`${base}/api/update-check`, { method: 'POST' })).json();
check('manual check invokes the launcher handler', checksRun === 1);
check('check result reports the new version', checked.available === true && checked.newVersion === '1.0.0-beta.2',
      JSON.stringify({ available: checked.available, v: checked.newVersion }));

// Still not downloaded — install must remain refused.
const earlyInstall = await fetch(`${base}/api/update-install`, { method: 'POST' });
check('install still refused before download completes', earlyInstall.status === 409);
check('no install ran', installsRun === 0);

// Download completes.
server.setUpdateState({ downloaded: true });
const goodInstall = await fetch(`${base}/api/update-install`, { method: 'POST' });
check('install accepted once downloaded', goodInstall.ok, `HTTP ${goodInstall.status}`);
await new Promise(r => setTimeout(r, 250));
check('install handler invoked', installsRun === 1);

// ── A failing check must degrade, not crash the endpoint ────────────────────
server.setUpdateHandlers({ onCheck: async () => { throw new Error('network down'); }, onInstall: () => {} });
const failed = await fetch(`${base}/api/update-check`, { method: 'POST' });
check('failing check still returns a response', failed.ok, `HTTP ${failed.status}`);
const failedBody = await failed.json();
check('failure is reported in state', typeof failedBody.error === 'string' && failedBody.checking === false,
      JSON.stringify({ error: failedBody.error, checking: failedBody.checking }));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
await new Promise(r => setTimeout(r, 120));
process.exit(failures === 0 ? 0 : 1);
