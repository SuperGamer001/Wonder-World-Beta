// Two real games playing one world over the internet, as far as that can be
// had on one machine with no Ably account: two of the game's own servers — the
// host's machine and the guest's, each with its own data folder — and a
// headless browser with a page for each player.
//
// Ably itself is stood in for (test/fakeAbly.mjs, which enforces what Ably
// enforces: signed token requests, what each token may do, who sent what). It
// runs in this process, and each page talks to it through a thin `Ably` of its
// own over a WebSocket. Everything else is the real thing: the game's pages,
// the Players panel and Join screen, Online.js, OnlineSession.js, world.js,
// and the token service (online/auth.js, served by each game's own server as
// it is on a developer's machine, with a made-up key).
//
// The host opens a world online from the game itself and is given a code; the
// guest joins by the code. Then: each sees the other; what the host had built
// before the guest came is in the guest's world (it came from the host's game,
// through the room); what either builds afterwards reaches the other; what the
// host's game will not have is put back; the guest's place in the world is
// kept on the host's disk; what the guest built far from the host is kept with
// the world; and when the host closes the game the guest is back at their own
// menu.
//
// Set BROWSER=<path> to pick the browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { makeFakeAbly } from './fakeAbly.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const BROWSER = [
    process.env.BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) { console.error('No Chromium-family browser found. Set BROWSER=<path to chrome/edge>.'); process.exit(2); }

// Ports of this run's own, so a run that was cut short cannot be mistaken for this one.
const P = 21000 + (process.pid % 2000) * 4;
const HUB = `ws://127.0.0.1:${P}`, HOST = `http://127.0.0.1:${P + 1}`, GUEST = `http://127.0.0.1:${P + 2}`, DBG = P + 3;

const children = [];
function run(cmd, args, opts) {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    child.output = '';
    child.stdout.on('data', d => { child.output += d; });
    child.stderr.on('data', d => { child.output += d; });
    children.push(child);
    return child;
}
const stopAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
process.on('exit', stopAll);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopAll(); process.exit(1); });
process.on('uncaughtException', (e) => { console.error(e); stopAll(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); stopAll(); process.exit(1); });

async function up(url, what) {
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
        await sleep(250);
    }
    throw new Error(`${what} did not come up at ${url}`);
}

// ── Ably's stand-in, and the line each page has to it ────────────────────────
// A made-up key of the right shape: the game's servers sign with it, the stand-in checks the signature with it.
const KEY = 'aBcDeF.GhIjKl:' + 'e2e-' + 'k'.repeat(40);
const { Ably: Fake, hub } = makeFakeAbly({ key: KEY });
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const pack = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? { $b: b64(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) } : d;
const unpack = (d) => d && typeof d === 'object' && typeof d.$b === 'string' ? new Uint8Array(Buffer.from(d.$b, 'base64')) : d;
new WebSocketServer({ port: P, host: '127.0.0.1' }).on('connection', (ws) => {
    const clients = new Map(), asking = new Map();
    let asks = 0;
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    ws.on('close', () => { for (const rt of clients.values()) rt.close(); });
    ws.on('message', async (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === 'new') {
            const rt = new Fake.Realtime({
                authCallback: (_p, cb) => { const id = ++asks; asking.set(id, cb); send({ t: 'auth?', c: m.c, id }); },
            });
            rt.connection.on((change) => send({ t: 'state', c: m.c, s: change.current, reason: change.reason ?? null }));
            clients.set(m.c, rt);
        } else if (m.t === 'auth') {
            asking.get(m.id)?.(m.e ?? null, m.r ?? null);
            asking.delete(m.id);
        } else if (m.t === 'close') {
            clients.get(m.c)?.close();
        } else if (m.t === 'call') {
            const rt = clients.get(m.c);
            try {
                const ch = rt.channels.get(m.ch, m.o);
                const tell = (k) => (msg) => send({ t: 'msg', c: m.c, ch: m.ch, k, m: { ...msg, data: pack(msg.data) } });
                let r;
                if (m.m === 'subscribe') r = await ch.subscribe(tell('m'));
                else if (m.m === 'presence.subscribe') r = await ch.presence.subscribe(tell('p'));
                else if (m.m === 'publish') r = await ch.publish(m.a[0], unpack(m.a[1]));
                else if (m.m === 'attach') r = await ch.attach();
                else if (m.m.startsWith('presence.')) r = await ch.presence[m.m.slice(9)](...m.a);
                send({ t: 'ret', id: m.id, r: r ?? null });
            } catch (e) { send({ t: 'ret', id: m.id, e: { message: e.message, code: e.code ?? 0 } }); }
        }
    });
});

/** What each page has for `Ably`: the SDK's shape, with the stand-in at the other end of a socket. */
function ablyShim(url) {
    const ws = new WebSocket(url), ready = new Promise((res) => { ws.onopen = res; });
    const send = (m) => ready.then(() => ws.send(JSON.stringify(m)));
    const calls = new Map(), clients = new Map();
    let ids = 0;
    const b64 = (buf) => { let t = ''; for (const b of new Uint8Array(buf)) t += String.fromCharCode(b); return btoa(t); };
    const pack = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? { $b: b64(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) } : d;
    const unpack = (d) => d && typeof d === 'object' && typeof d.$b === 'string' ? Uint8Array.from(atob(d.$b), (ch) => ch.charCodeAt(0)).buffer : d;
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data), rt = clients.get(m.c);
        if (m.t === 'ret') { const p = calls.get(m.id); calls.delete(m.id); m.e ? p.rej(Object.assign(new Error(m.e.message), { code: m.e.code })) : p.res(m.r); }
        else if (m.t === 'auth?') rt._options.authCallback({}, (err, r) => send({ t: 'auth', id: m.id, e: err ? String(err) : null, r }));
        else if (m.t === 'state') { const previous = rt.connection.state; rt.connection.state = m.s; for (const fn of [...rt._listeners]) fn({ current: m.s, previous, reason: m.reason }); }
        else if (m.t === 'msg') for (const fn of rt._subs.get(`${m.k}|${m.ch}`) ?? []) fn({ ...m.m, data: unpack(m.m.data) });
    };
    class Realtime {
        constructor(options) {
            this._options = options; this._listeners = new Set(); this._subs = new Map(); this._chans = new Map();
            const c = this._c = ++ids;
            clients.set(c, this);
            this.connection = { state: 'initialized', on: (fn) => this._listeners.add(fn), off: (fn) => this._listeners.delete(fn) };
            const call = (ch, o, m, a = []) => new Promise((res, rej) => { const id = ++ids; calls.set(id, { res, rej }); send({ t: 'call', c, id, ch, o, m, a }); });
            const listen = (k, ch, o, m) => (fn) => {
                const key = `${k}|${ch}`, first = !this._subs.has(key);
                if (first) this._subs.set(key, []);
                this._subs.get(key).push(fn);
                return first ? call(ch, o, m) : Promise.resolve();
            };
            this.channels = {
                get: (name, o) => {
                    if (!this._chans.has(name)) this._chans.set(name, {
                        name, on() {}, attach: () => call(name, o, 'attach'),
                        subscribe: listen('m', name, o, 'subscribe'),
                        publish: (n, d) => call(name, o, 'publish', [n, pack(d)]),
                        presence: {
                            enter: (d) => call(name, o, 'presence.enter', [d]), update: (d) => call(name, o, 'presence.update', [d]),
                            leave: () => call(name, o, 'presence.leave'), get: () => call(name, o, 'presence.get'),
                            subscribe: listen('p', name, o, 'presence.subscribe'),
                        },
                    });
                    return this._chans.get(name);
                },
            };
            send({ t: 'new', c });
        }
        close() { send({ t: 'close', c: this._c }); }
    }
    globalThis.Ably = { Realtime, stoodIn: true };
}

// ── The two machines ─────────────────────────────────────────────────────────
function gameServer(port, dir) {
    return run(process.execPath, ['server/server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), WONDER_DATA_DIR: dir, WW_ABLY_KEY: KEY, WW_LAN_PORT: '0', WW_BEACON_PORT: String(port + 200) },
    });
}
const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-online-host-')), guestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-online-guest-'));
gameServer(P + 1, hostDir);
gameServer(P + 2, guestDir);
await up(`${HOST}/api/online/config`, "the host's game server");
await up(`${GUEST}/api/online/config`, "the guest's game server");

const json = (url, method = 'GET', body) => fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
// Who is playing on each machine, and light graphics: two games share this one.
for (const [base, name] of [[HOST, 'Hana'], [GUEST, 'Gus']]) {
    await json(`${base}/api/profiles`, 'POST', { name });
    await json(`${base}/api/settings`, 'PUT', { playerName: name, graphics: 'simple' });
}
const world = await (await json(`${HOST}/api/worlds`, 'POST', { name: 'Shared', seed: 2024, gameMode: 'CREATIVE' })).json();

// ── The browser, and a page for each player ──────────────────────────────────
run(BROWSER, [
    '--headless=new', '--disable-gpu-sandbox', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion', `--remote-debugging-port=${DBG}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'ww-online-edge-'))}`, '--window-size=960,600', 'about:blank',
]);

class Page {
    static async open(url, { ably = true } = {}) {
        let target;
        for (let i = 0; i < 60 && !target; i++) {
            try { target = await (await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(250); }
        }
        if (!target?.webSocketDebuggerUrl) throw new Error('the browser never became reachable');
        const page = new Page(new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 }));
        await new Promise((res, rej) => { page.ws.once('open', res); page.ws.once('error', rej); });
        for (const domain of ['Runtime', 'Log', 'Page', 'Network']) await page.send(`${domain}.enable`);
        await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
        if (ably) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${ablyShim})(${JSON.stringify(HUB)})` });
        await page.send('Page.navigate', { url });
        return page;
    }
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.failed = []; this.urls = new Map();
        ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.id != null) {
                const p = this.pending.get(m.id);
                if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
            } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                this.errors.push((m.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' '));
            } else if (m.method === 'Runtime.exceptionThrown') {
                this.errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
            } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
                this.errors.push(m.params.entry.text);
            } else if (m.method === 'Network.requestWillBeSent') {
                this.urls.set(m.params.requestId, m.params.request.url);
            } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
                this.failed.push(`${m.params.response.status} ${m.params.response.url}`);
            } else if (m.method === 'Network.loadingFailed' && !(m.params.canceled && m.params.type === 'Media')) {
                this.failed.push(`${m.params.errorText} ${this.urls.get(m.params.requestId) ?? '?'}`);
            }
        });
    }
    send(method, params = {}) {
        return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
    }
    async eval(expression, awaitPromise = false) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, allowUnsafeEvalBlocking: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    }
    /** Wait until `expression` is truthy in the page; its value. */
    async until(expression, what, ms = 90000) {
        const end = Date.now() + ms;
        for (;;) {
            const v = await this.eval(expression).catch(() => null);
            if (v) return v;
            if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
            await sleep(400);
        }
    }
}

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const hostPage = await Page.open(`${HOST}/game.html`), guestPage = await Page.open(`${GUEST}/game.html`);
const atTitle = "typeof startWorld === 'function' && !document.getElementById('TitleScreen').classList.contains('hidden')";
await hostPage.until(atTitle, "the host's title screen");
await guestPage.until(atTitle, "the guest's title screen");
for (const p of [hostPage, guestPage]) await p.eval('window.__wwMenuWorld(false); 1');
const inWorld = "(() => { const d = window.__wwDebug?.(); return d && d.meshes > 20 && document.getElementById('loadingContainer').classList.contains('hidden') ? d.meshes : 0; })()";

// ── The host: into the world, something built, then online ───────────────────
await hostPage.eval(`startWorld(${JSON.stringify(world)}); 1`);
await hostPage.until(inWorld, "the host's world to load", 120000);
const at = await hostPage.until("(() => { const p = window.me.position; return p.y > -100 && p.y < 300 && window.__wwBlockAt(p.x, p.y - 1.2, p.z) !== 0 ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } : null; })()", 'the host to be standing somewhere');
const LAMP = 43, BRICKS = 27, PLANKS = 25;
// Before anyone else is here, and not saved yet: only the host's game has it.
await hostPage.eval(`window.__wwSetBlock(${at.x + 2}, ${at.y + 3}, ${at.z}, 'LAMP')`);

check('this copy of the game can go online', await hostPage.eval('window.__wwOnline.available()', true));
const code = await hostPage.eval('window.__wwWorld.goOnline(activeWorld)', true);
check('the host opens the world online and is given a code', /^[A-Z2-9]{8}$/.test(code), code);
const hostNet = await hostPage.eval('window.__wwWorld.online()');
check('… and is the host of its room', hostNet?.host === true && hostNet.players === 1, JSON.stringify(hostNet));

// ── The guest: by the code, from their own menu ──────────────────────────────
await guestPage.eval(`joinOnline(${JSON.stringify(code.slice(0, 4).toLowerCase() + '-' + code.slice(4))}); 1`);
await guestPage.until(inWorld, "the guest's world to load", 150000).catch(async (e) => {
    console.log('guest note:', await guestPage.eval("document.getElementById('lanJoinNote').textContent").catch(() => '?'));
    throw e;
});
const players = async (p) => p.eval('window.__wwPlayers().map(q => `${q.name}${q.host ? "*" : ""}${q.you ? "!" : ""}`).sort().join(",")');
await hostPage.until('window.__wwPlayers().length === 2', 'the host to see the guest');
check('each sees the other, and who the host is', await players(hostPage) === 'Gus,Hana*!' && await players(guestPage) === 'Gus!,Hana*', `${await players(hostPage)} | ${await players(guestPage)}`);
check('the guest is in the world it was told to make', await guestPage.eval('window.__wwDebug().terrainStyle') === world.terrainStyle &&
    await guestPage.eval("document.body.classList.contains('isGuest') && document.getElementById('pauseQuitBtn').textContent") === 'Leave Game');

const lampAt = `window.__wwBlockAt(${at.x + 2}, ${at.y + 3}, ${at.z})`;
check('what the host had built before the guest came is in the guest\'s world',
    await guestPage.until(`${lampAt} === ${LAMP}`, 'the lamp to arrive with its chunk', 60000).then(() => true, () => false), `guest has block ${await guestPage.eval(lampAt)}`);

const guestPos = await guestPage.until("(() => { const p = window.me.position; return p.y > -100 && p.y < 300 ? { x: p.x, y: p.y, z: p.z } : null; })()", 'the guest to be standing somewhere');
check('the guest starts beside the host', Math.hypot(guestPos.x - at.x, guestPos.z - at.z) < 24, JSON.stringify(guestPos));

// ── What each builds reaches the other ───────────────────────────────────────
await hostPage.eval(`window.__wwSetBlock(${at.x + 2}, ${at.y + 4}, ${at.z}, 'BRICKS')`);
check('what the host builds now reaches the guest',
    await guestPage.until(`window.__wwBlockAt(${at.x + 2}, ${at.y + 4}, ${at.z}) === ${BRICKS}`, 'the bricks', 20000).then(() => true, () => false));
const gx = Math.floor(guestPos.x) + 1, gy = Math.floor(guestPos.y) + 3, gz = Math.floor(guestPos.z);
await sleep(600);                                                            // the host has heard where the guest stands
await guestPage.eval(`window.__wwSetBlock(${gx}, ${gy}, ${gz}, 'WOODEN_PLANKS')`);
check('what the guest builds reaches the host',
    await hostPage.until(`window.__wwBlockAt(${gx}, ${gy}, ${gz}) === ${PLANKS}`, 'the planks', 20000).then(() => true, () => false));

// A block far out of the guest's reach: the host's game will not have it, and says what is there instead.
const far = { x: gx + 40, y: gy, z: gz };
const before = await guestPage.eval(`window.__wwBlockAt(${far.x}, ${far.y}, ${far.z})`);
await guestPage.eval(`window.__wwSetBlock(${far.x}, ${far.y}, ${far.z}, 'BRICKS')`);
await sleep(1500);
check('a block out of reach is refused: the host never has it, and the guest\'s is put back',
    await hostPage.eval(`window.__wwBlockAt(${far.x}, ${far.y}, ${far.z})`) !== BRICKS && await guestPage.eval(`window.__wwBlockAt(${far.x}, ${far.y}, ${far.z})`) === before,
    `was ${before}, guest now ${await guestPage.eval(`window.__wwBlockAt(${far.x}, ${far.y}, ${far.z})`)}`);

// ── Far from the host: kept with the world, though the host's game never loads it ──
const away = { x: at.x + 400, z: at.z };
await guestPage.eval(`(() => { window.me.position.x = ${away.x + 0.5}; window.me.position.y = 200; window.me.position.z = ${away.z + 0.5}; return 1; })()`);
await guestPage.until(`window.__wwBlockAt(${away.x}, 0, ${away.z}) !== 0`, 'the land far away to load for the guest', 90000);
// Wherever the guest has come to rest there (they may have fallen to the ground): a block beside them.
let rest = null;
for (let i = 0, last = NaN; i < 60; i++) {
    await sleep(500);
    const y = await guestPage.eval('window.me.position.y');
    if (Math.abs(y - last) < 0.01) { rest = y; break; }
    last = y;
}
const farBlock = { x: away.x + 1, y: Math.floor(rest ?? 200) + 2, z: away.z };
await sleep(800);                                                            // the host has heard where the guest now stands
await guestPage.eval(`window.__wwSetBlock(${farBlock.x}, ${farBlock.y}, ${farBlock.z}, 'BRICKS')`);
await sleep(1500);
check('the host is not there', await hostPage.eval(`window.__wwBlockAt(${away.x}, 0, ${away.z})`) === 0);

// ── The guest leaves: their place is kept on the host's disk ─────────────────
await guestPage.eval('leaveWorld(); 1');
await guestPage.until("!document.getElementById('WorldListScreen').classList.contains('hidden')", "the guest's own world list");
await hostPage.until('window.__wwPlayers().length === 1', 'the host to see the guest go');
const playersDir = path.join(hostDir, 'user', 'worlds', world.id, 'players');
let keptFile = null;
for (let i = 0; i < 40 && !keptFile; i++) {
    keptFile = (fs.existsSync(playersDir) ? fs.readdirSync(playersDir) : []).find(f => f.startsWith('online-')) ?? null;
    if (!keptFile) await sleep(250);
}
const keptState = keptFile ? JSON.parse(fs.readFileSync(path.join(playersDir, keptFile), 'utf8')) : null;
check('the guest\'s place in the world is kept with the world, on the host\'s machine, under a key that names nobody',
    !!keptState && Math.abs(keptState.position.x - (away.x + 0.5)) < 2 && /^online-p[A-Za-z0-9_-]{20}-0\.json$/.test(keptFile) && !/gus/i.test(keptFile), keptFile ?? 'no file');
check('… and nothing of the world was written on the guest\'s', !fs.existsSync(path.join(guestDir, 'user', 'worlds', 'online')));
check('the guest is their own again: their own menu, their own settings',
    await guestPage.eval("!document.body.classList.contains('isGuest') && window.__wwWorld.online() === null"));

// ── … and found again ────────────────────────────────────────────────────────
await guestPage.eval(`joinOnline(${JSON.stringify(code)}); 1`);
await guestPage.until(inWorld, "the guest's world to load again", 150000);
const backAt = await guestPage.eval('({ x: window.me.position.x, z: window.me.position.z })');
check('back in the game, the guest is where they left off', Math.abs(backAt.x - (away.x + 0.5)) < 3, JSON.stringify(backAt));
check('… with what they built there still standing (asked of the host, who has only the change)',
    await guestPage.until(`window.__wwBlockAt(${farBlock.x}, ${farBlock.y}, ${farBlock.z}) === ${BRICKS}`, 'the far bricks', 60000).then(() => true, () => false));

// ── The host closes the game ─────────────────────────────────────────────────
await hostPage.eval('window.__wwWorld.goOffline()', true);
await guestPage.until("!document.getElementById('WorldListScreen').classList.contains('hidden')", 'the guest to be sent back to their menu', 30000);
check('when the host closes the game the guest is told, and is back at their own menu',
    /host has left/i.test(await guestPage.eval("document.getElementById('padNotice').textContent")), await guestPage.eval("document.getElementById('padNotice').textContent"));
check('the host plays on, offline', await hostPage.eval('window.__wwWorld.online() === null && window.__wwDebug().meshes > 0'));

// The host leaves the world: what was built where it never went is kept with the world.
await hostPage.eval('leaveWorld(); 1');
const pendingFile = path.join(hostDir, 'user', 'worlds', world.id, 'pending-edits.json');
for (let i = 0; i < 40 && !fs.existsSync(pendingFile); i++) await sleep(250);
const pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : {};
const farKey = `${farBlock.x >> 4},${farBlock.z >> 4}`;
check('what the guest built far from the host is kept with the host\'s world', Array.isArray(pending[farKey]) && pending[farKey].some(e => e[1] === BRICKS), `${farKey}: ${JSON.stringify(pending[farKey] ?? null)}`);

// ── Nothing went wrong on the way ────────────────────────────────────────────
// (One request is allowed to fail: back at the world list, the card of a world that was never drawn on a
// real screen asks for a thumbnail there is none of. That is the game as it was, and nothing to do with this.)
const thumbnail = (line) => /screenshot\.jpg/.test(line);
for (const [who, p] of [['host', hostPage], ['guest', guestPage]]) {
    const failed = p.failed.filter(f => !thumbnail(f));
    const errors = p.errors.filter(e => !(/Failed to load resource/.test(e) && p.failed.some(thumbnail) && failed.length === 0));
    check(`the ${who}'s page logged no errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    check(`the ${who}'s page had no failed requests`, failed.length === 0, failed.slice(0, 3).join(' | '));
}
check('nothing was tried that a token would not allow', hub.refused.length === 0, hub.refused.slice(0, 4).join(' | '));
console.log(`      (${hub.messages} messages, as Ably counts them, for the whole run)`);

// ── … and the real SDK is where the game looks for it ────────────────────────
// (Every page above had the stand-in for `Ably`. This one loads what a player's game loads.)
const sdkPage = await Page.open(`${HOST}/data/online.json`, { ably: false });
await sleep(500);
const sdk = await sdkPage.eval(`new Promise((res) => { const s = document.createElement('script'); s.src = '/node_modules/ably/build/ably.min.js';
    s.onload = () => res({ realtime: typeof globalThis.Ably?.Realtime, version: globalThis.Ably?.version ?? null }); s.onerror = () => res(null); document.documentElement.appendChild(s); })`, true);
check("Ably's own SDK loads in the page from where the game asks for it", sdk?.realtime === 'function', JSON.stringify(sdk));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
stopAll();
await sleep(200);
process.exit(failures === 0 ? 0 : 1);
