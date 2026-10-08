// Screenshots of the mob models on a stage (test/mob_viewer.html), on the real
// GPU: every model all round (painted, and in plain clay), square on from the
// side, the front and above, its variants, a stride at a walk and at a run,
// and a few poses — grazing, looking round, striking, falling, swimming, dead.
//
//   node test/mobshots.mjs [--out dir] [--only cow,quiddle] [--clay]      (npm run mobshots)
//
// --clay draws every shot unpainted.
//
// Fails on any console error or page exception. BROWSER=<path> picks the browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const OUT = arg('out', path.join(os.tmpdir(), 'wonder-world-mobshots'));
const ONLY = arg('only', '') ? arg('only', '').split(',') : null;
const CLAY = process.argv.includes('--clay');
fs.mkdirSync(OUT, { recursive: true });

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

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-mobshots-'));
const { serverReady } = await import('../server/server.js');
const { port, host } = await serverReady;
const DBG_PORT = 9300 + (process.pid % 200);
const browser = spawn(BROWSER, [
    '--headless=new', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    `--remote-debugging-port=${DBG_PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ww-mobshots-browser-'))}`,
    '--window-size=1500,820', 'about:blank',
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
const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
};
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
await send('Page.navigate', { url: `http://${host}:${port}/test/mob_viewer.html` });
for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (await evalJs('window.viewerReady === true').catch(() => false)) break;
}

async function shot(name, list, opts) {
    const n = await evalJs(`window.show(${JSON.stringify(list)}, ${JSON.stringify({ ...opts, clay: opts.clay || CLAY })})`);
    await sleep(150);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`${name.padEnd(22)} ${n} shown → ${file}`);
}

// How far back to stand for each model, and where to look.
const STAGE = {
    cow: { dist: 10.5, lookY: 0.8, spacing: 2.3 }, pig: { dist: 7.2, lookY: 0.45, spacing: 1.7 },
    sheep: { dist: 7.6, lookY: 0.6, spacing: 1.7 }, chicken: { dist: 3.2, lookY: 0.3, spacing: 0.8 },
    fish: { dist: 2.6, lookY: 0.2, spacing: 0.75 }, quiddle: { dist: 7.6, lookY: 0.95, spacing: 1.25 },
};
const names = (await evalJs('window.modelNames')).filter(n => !ONLY || ONLY.includes(n));
const TAU = Math.PI * 2;

for (const model of names) {
    const st = STAGE[model] ?? { dist: 6, lookY: 0.8, spacing: 1.6 };
    const swim = model === 'fish' ? 1 : 0, base = { model, anim: { swim }, y: swim * 0.3 };
    // All round: front, three-quarter, side, back three-quarter, back — as it is, and in
    // plain clay, where the shapes can be judged without the paint.
    const turn = [0, 0.7, 1.57, 2.5, 3.14].map(yaw => ({ ...base, yaw }));
    await shot(`${model}-turn`, turn, { ...st, camYaw: 0, camPitch: 0.16 });
    await shot(`${model}-clay`, turn, { ...st, camYaw: 0, camPitch: 0.16, clay: true });
    // From the side, from above and from in front, square on: the proportions.
    await shot(`${model}-plan`, [{ ...base, yaw: 1.5708 }, { ...base, yaw: 0 }], { ...st, spacing: st.spacing * 1.3, dist: st.dist * 0.72, camYaw: 0, camPitch: 0.02, clay: true });
    await shot(`${model}-above`, [{ ...base, yaw: 1.5708 }, { ...base, yaw: 0 }], { ...st, spacing: st.spacing * 1.3, dist: st.dist * 0.8, lookY: 0, camYaw: 0, camPitch: 1.45, clay: true });
    // Its looks.
    if (model === 'quiddle') {
        // Every outfit and head of hair, on the sex it is for; then the builds.
        const SEX = { outfit: [0, 0, 1, 0, 1, 1], hair: [0, 1, 0, 0, 1, 0] };
        await shot('quiddle-outfits', [0, 1, 2, 3, 4, 5].map(outfit => ({ model, yaw: 0.45, variant: { outfit, sex: SEX.outfit[outfit], hair: [0, 2, 1, 5, 4, 1][outfit], hairColor: outfit % 5, eyes: outfit % 3, skin: outfit % 5 } })),
            { ...st, spacing: 1.2, dist: 8.2, camYaw: 0, camPitch: 0.14 });
        await shot('quiddle-hair', [0, 1, 2, 3, 4, 5].flatMap(hair => [0.5, 2.6].map(yaw => ({ model, yaw, variant: { hair, sex: SEX.hair[hair], hairColor: hair % 5, outfit: SEX.hair[hair] ? 4 : 5, skin: (hair + 1) % 5 } }))),
            { spacing: 0.62, dist: 4.4, lookY: 1.55, camYaw: 0, camPitch: 0.04 });
        await shot('quiddle-builds', [0, 1].flatMap(sex => [0, 1, 2].map(k => ({ model, yaw: 0.35, variant: { sex, build: k, arms: k, legs: k, height: k * 2, outfit: sex ? 4 : 1, hair: sex ? 4 : 3, hairColor: k, skin: k + sex } }))),
            { ...st, spacing: 1.3, dist: 8.4, camYaw: 0, camPitch: 0.1 });
        await shot('quiddle-builds-clay', [0, 1].flatMap(sex => [0, 1, 2].map(k => ({ model, yaw: 0.35, variant: { sex, build: k, arms: k, legs: k, height: k * 2, outfit: 1, hair: 3 } }))),
            { ...st, spacing: 1.3, dist: 8.4, camYaw: 0, camPitch: 0.1, clay: true });
        await shot('quiddle-faces', [0, 1, 2, 3, 4].map(skin => ({ model, yaw: 0, variant: { outfit: 1, hair: [0, 3, 5, 0, 2][skin], hairColor: skin, eyes: skin % 3, skin } })),
            { spacing: 0.62, dist: 3.4, lookY: 1.62, camYaw: 0, camPitch: 0.02 });
        await shot('quiddle-close', [{ model, yaw: 0.35, variant: { outfit: 1, hair: 1, eyes: 1, skin: 0 } }, { model, yaw: -0.5, variant: { outfit: 2, hair: 2, eyes: 2, skin: 1 } }],
            { spacing: 1.1, dist: 3.4, lookY: 1.15, camYaw: 0, camPitch: 0.1 });
        await shot('quiddle-head', [0, 0.8, 1.57, 3.14].map((yaw, i) => ({ model, yaw, variant: { outfit: i % 3, hair: i % 3, eyes: i % 3, skin: i % 3 } })),
            { spacing: 0.55, dist: 1.9, lookY: 1.62, camYaw: 0, camPitch: 0.04 });
        await shot('quiddle-back', [0, 1, 2].map(hair => ({ model, yaw: 2.6, variant: { outfit: hair, hair, eyes: 0, skin: hair } })),
            { ...st, dist: 5.2, camYaw: 0, camPitch: 0.16 });
    } else {
        await shot(`${model}-coats`, [0, 1, 2].flatMap(coat => [0.6, 2.2].map(yaw => ({ ...base, yaw, variant: { coat } }))), { ...st, camYaw: 0, camPitch: 0.2 });
        // Up close, where the face can be judged.
        await shot(`${model}-close`, [0.15, 0.75, -1.2].map((yaw, coat) => ({ ...base, yaw, variant: { coat } })),
            { ...st, dist: st.dist * 0.5, camYaw: 0, camPitch: 0.12 });
    }
    // A stride, eight steps of it from the side: walking, then running.
    const stride = (extra) => [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ model, yaw: 1.5708, y: swim * 0.3, anim: { swim, move: 1, phase: i / 8 * TAU, time: i / 8, ...extra } }));
    const wide = { ...st, spacing: st.spacing * 0.95, dist: Math.max(st.dist * 1.6, st.spacing * 8.8), camYaw: 0, camPitch: 0.06 };
    await shot(`${model}-walk`, stride({}), wide);
    await shot(`${model}-run`, stride({ run: 1, panic: 1 }), wide);
    // A long skirt has to go with the legs under it.
    if (model === 'quiddle') await shot('quiddle-dress', stride({}).map(s => ({ ...s, yaw: 1.2, variant: { outfit: 2, hair: 1, eyes: 1, skin: 0 } })), wide);
    // Poses: standing, grazing, looking round, striking, in the air, swimming, struck, dead.
    const poses = [
        { anim: {} },
        { anim: { graze: 1, time: 0.4 } },
        { anim: { lookYaw: 0.9, lookPitch: -0.3, time: 2 } },
        { anim: { attack: 0.3, time: 0.2 } },
        { anim: { attack: 0.7, time: 0.3 } },
        { anim: { air: 1, time: 0.1 } },
        { anim: { swim: 1, time: 0.6, move: 0.5, phase: 1 } },
        { anim: { hurt: 1 }, death: 1 },
    ].map(p => ({ model, yaw: 0.9, ...p, anim: { swim, ...p.anim } }));
    await shot(`${model}-poses`, poses, { ...st, spacing: st.spacing * 1.05, dist: Math.max(st.dist * 1.45, st.spacing * 9.6), camYaw: 0, camPitch: 0.18 });
}

console.log(`\nerrors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  ', String(e).slice(0, 300));
try { ws.close(); } catch {}
kill();
await sleep(200);
process.exit(errors.length ? 1 : 0);
