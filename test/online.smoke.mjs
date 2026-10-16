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
import http from 'node:http';
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
// (The token service asks Ably's REST API who is in the lobby of public games: this answers for it.)
const hubHttp = http.createServer((req, res) => {
    const name = /^\/channels\/([^/]+)\/presence/.exec(req.url)?.[1];
    if (!name) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hub.restPresence(decodeURIComponent(name))));
});
await new Promise((res) => hubHttp.listen(P, '127.0.0.1', res));
new WebSocketServer({ server: hubHttp }).on('connection', (ws) => {
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
        env: { ...process.env, PORT: String(port), WONDER_DATA_DIR: dir, WW_RELEASE_NOTES: 'none', WW_ABLY_KEY: KEY, WW_ABLY_REST: `http://127.0.0.1:${P}`, WW_LAN_PORT: '0', WW_BEACON_PORT: String(port + 200) },
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

// ── Chat, and commands ───────────────────────────────────────────────────────
// What is said is seen by both; a command is run by the host's game, for whoever
// may; and what it does to a player is done in that player's own game.
const chat = (page) => page.eval("[...document.querySelectorAll('#chatLog .chatLine')].map(e => (e.classList.contains('sys') ? '* ' : '') + e.textContent).join(' | ')");
const said = (page, re, what) => page.until(`${re}.test([...document.querySelectorAll('#chatLog .chatLine')].map(e => e.textContent).join(' | '))`, what, 15000).then(() => true, () => false);
await guestPage.eval("window.__wwChat.send('hello from Gus')");
check('what a guest says is shown to the host, under their name', await said(hostPage, '/\\(Gus\\) hello from Gus/', 'the guest\'s line'), await chat(hostPage));
await hostPage.eval("window.__wwChat.send('and hello back')");
check('… and what the host says, to the guest', await said(guestPage, '/\\(Hana\\) and hello back/', 'the host\'s line'), await chat(guestPage));
check('… each seeing their own line too', /\(Gus\) hello from Gus/.test(await chat(guestPage)) && /\(Hana\) and hello back/.test(await chat(hostPage)));

const hoursOf = (page) => page.eval('window.__wwAtmos().day.hours');
await guestPage.eval("window.__wwChat.send('/time set midnight')");
check('a guest who is not an operator is told so — alone', await said(guestPage, '/needs operator status/', 'the refusal'), await chat(guestPage));
check('… and the time has not changed', Math.abs(await hoursOf(hostPage)) > 0.5 && !/operator status/.test(await chat(hostPage)), String(await hoursOf(hostPage)));
await hostPage.eval("window.__wwChat.send('/op Gus')");
check('the host makes the guest an operator, and everyone is told', await said(guestPage, '/Hana made Gus an operator/', 'the news'), await chat(guestPage));
await guestPage.eval("window.__wwChat.send('/time set noon')");
check('the guest\'s command is then run by the host\'s game', await hostPage.until('Math.abs(window.__wwAtmos().day.hours - 12) < 0.2', 'noon on the host', 15000).then(() => true, () => false), String(await hoursOf(hostPage)));
check('… and its clock is the guest\'s clock', await guestPage.until('Math.abs(window.__wwAtmos().day.hours - 12) < 0.3', 'noon for the guest', 15000).then(() => true, () => false), String(await hoursOf(guestPage)));
await hostPage.eval("window.__wwChat.send('/gamemode spectator Gus')");
check('a command about a player is done in that player\'s game', await guestPage.until("activeWorld.gameMode === 'SPECTATOR'", 'the guest a spectator', 15000).then(() => true, () => false));
await hostPage.eval("window.__wwChat.send('/gamemode creative Gus')");
await guestPage.until("activeWorld.gameMode === 'CREATIVE'", 'the guest in creative again', 15000).catch(() => {});
await guestPage.eval("window.__wwChat.send('/give torch 3')");
check('… and what a guest gives themselves is in their own hands', await guestPage.until("JSON.stringify(window.me.inventory.hotbar).includes('torch')", 'the torches', 15000).then(() => true, () => false));
check('the host\'s list of operators is kept with the world', await hostPage.eval("window.__wwChat.ops().join()") === 'Gus');

// ── The storm is one storm ───────────────────────────────────────────────────
// The host's lightning comes down in the same place in the guest's game, and its tornado stands where the host's does.
const boltAt = { x: Math.round(at.x) + 31, z: Math.round(at.z) - 17 };
await hostPage.eval(`(() => { const a = window.__wwAtmos(); a.onBolt(${boltAt.x}, ${boltAt.z}, false, 12345); })()`);
check('lightning that strikes in the host\'s game strikes the same place in the guest\'s',
    await guestPage.until(`window.__wwAtmos().lightning.bolts.some(b => Math.abs(b.x - ${boltAt.x}) < 0.2 && Math.abs(b.z - ${boltAt.z}) < 0.2)`, 'the bolt', 8000).then(() => true, () => false));
check('… and the guest\'s game makes none of its own', await guestPage.eval('window.__wwAtmos().guest === true') && await hostPage.eval('window.__wwAtmos().guest === false'));
await hostPage.eval("window.__wwChat.send('/weather tornado')");
const torOk = await guestPage.until('window.__wwAtmos()._tor.on === true', 'the tornado in the guest\'s game', 15000).then(() => true, () => false);
await sleep(1200);
const torH = await hostPage.eval('(() => { const t = window.__wwAtmos()._tor; return { x: t.x, z: t.z, on: t.on }; })()');
const torG = await guestPage.eval('(() => { const t = window.__wwAtmos()._tor; return { x: t.x, z: t.z, on: t.on }; })()');
check('a tornado in the host\'s game is the same tornado in the guest\'s', torOk && torH.on && Math.hypot(torH.x - torG.x, torH.z - torG.z) < 25, JSON.stringify({ torH, torG, host: await hostPage.eval('({ state: window.__wwAtmos().tornadoState(), weather: window.__wwAtmos().weather.local })'), guest: await guestPage.eval('({ net: window.__wwAtmos()._torNet, guest: window.__wwAtmos().guest, weather: window.__wwAtmos().weather.local, active: window.__wwAtmos().active })') }));
await hostPage.eval("window.__wwChat.send('/weather sunny')");
await guestPage.until('window.__wwAtmos()._torNet === null', 'the tornado to be over for the guest', 15000).catch(() => {});

// ── Players against players ──────────────────────────────────────────────────
await hostPage.eval("window.__wwChat.send('/gamemode survival Gus'); window.__wwChat.send('/heal Gus'); window.__wwChat.send('/tp Gus')");
await guestPage.until("activeWorld.gameMode === 'SURVIVAL'", 'the guest in survival', 15000).catch(() => {});
await sleep(1200);                                                           // each has heard where the other now stands
const gusId = await hostPage.eval('window.__wwPlayers().find(p => !p.you).id');
check('PvP is on in a world unless it is turned off', await hostPage.eval('window.__wwWorld.pvp()') === true);
await hostPage.eval(`window.__wwStrike(${gusId}, 6)`);
check('a blow from one player lands on the other, in their own game', await guestPage.until('window.me.health < 99', 'the guest to be hurt', 10000).then(() => true, () => false), String(await guestPage.eval('window.me.health')));
await hostPage.eval("window.__wwChat.send('/pvp off')");
check('turned off by the host, it is off for everyone', await guestPage.until('window.__wwWorld.pvp() === false', 'the guest to hear PvP is off', 10000).then(() => true, () => false));
await hostPage.eval("window.__wwChat.send('/heal Gus')");
await guestPage.until('window.me.health >= 100', 'the guest healed', 10000).catch(() => {});
check('… and no blow is struck', await hostPage.eval(`window.__wwStrike(${gusId}, 6)`) === false && (await sleep(800), await guestPage.eval('window.me.health')) >= 100);
await hostPage.eval("window.__wwChat.send('/pvp on'); window.__wwChat.send('/gamemode creative Gus')");
await guestPage.until("activeWorld.gameMode === 'CREATIVE'", 'the guest in creative again', 15000).catch(() => {});

// ── The Players panel: who is who ────────────────────────────────────────────
const asHost = await hostPage.eval('window.__wwPlayers()'), asGuest = await guestPage.eval('window.__wwPlayers()');
check('each game knows who the operators are', asHost.find(q => !q.you)?.op === true && asGuest.find(q => q.you)?.op === true && asGuest.find(q => !q.you)?.op === true,
    JSON.stringify(asGuest));

// A block far out of the guest's reach: the host's game will not have it, and says what is there instead.
const far = { x: gx + 40, y: gy, z: gz };
const before = await guestPage.eval(`window.__wwBlockAt(${far.x}, ${far.y}, ${far.z})`);
await guestPage.eval(`window.__wwSetBlock(${far.x}, ${far.y}, ${far.z}, 'BRICKS')`);
await sleep(1500);
// (As long again, on a machine with its hands full, for the host's answer to have come.)
await guestPage.until(`window.__wwBlockAt(${far.x}, ${far.y}, ${far.z}) === ${before}`, 'the block to be put back', 8000).catch(() => {});
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
// The host has heard where the guest now stands: one standing still says so every two seconds
// (RATE.STATE_IDLE), and the last word while falling can be blocks above where they came to rest.
await sleep(2600);
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

// ── Join a game: first where it is, then which ──────────────────────────────────
const SHOTS = process.env.ONLINE_SHOTS;
const shot = async (page, name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
};
const shown = (id) => `!document.getElementById('${id}').classList.contains('hidden')`;
// The host opens the world to anyone, from the Players panel as a player does.
await hostPage.eval("openPlayers(); 1");
await hostPage.until(shown('onlineSection'), 'the Online part of the Players panel');
await hostPage.eval(`(() => { const b = [...document.querySelectorAll('#onlineWhoRow .segBtn')].find(x => x.dataset.value === 'public'); b.click(); return 1; })()`);
await sleep(300);
await shot(hostPage, 'players-panel-public');
await hostPage.eval("document.getElementById('onlineOpenToggle').click(); 1");
const pubNet = await hostPage.until("(() => { const n = window.__wwWorld.online(); return n?.visibility ? n : null; })()", 'the world to be open to anyone', 30000);
check('from the Players panel, the host opens the world to anyone', pubNet.visibility === 'public' && pubNet.host === true, JSON.stringify(pubNet));
await sleep(700);
await shot(hostPage, 'players-panel-open');
await hostPage.eval("closePlayers(); 1");

await guestPage.eval('openLanJoin(); 1');
await guestPage.until("!document.getElementById('joinOnlineWayBtn').classList.contains('cannot')", 'the Online choice to be there');
check('Join a game first asks where: on the network, or online', await guestPage.eval(`${shown('joinChoose')} && !(${shown('joinLanView')}) && !(${shown('joinOnlineView')})`));
check('nowhere is an address asked for', await guestPage.eval("!document.getElementById('lanJoinAddress') && !/address/i.test(document.getElementById('LanJoinModal').textContent)"));
await shot(guestPage, 'join-choose');
await guestPage.eval("document.getElementById('joinLanWayBtn').click(); 1");
await guestPage.until("/network/i.test(document.getElementById('lanGameList').textContent)", 'the list of games on the network', 15000).catch(() => {});
check('on the network: the games open on it, and nothing else', await guestPage.eval(`${shown('joinLanView')} && !(${shown('joinChoose')}) && !(${shown('joinOnlineView')}) && /network/i.test(document.getElementById('lanGameList').textContent)`));
await shot(guestPage, 'join-lan');
await guestPage.eval("document.getElementById('lanJoinCloseBtn').click(); 1");
check('Back returns to the choice', await guestPage.eval(`${shown('joinChoose')} && ${shown('LanJoinModal')}`));
await guestPage.eval("document.getElementById('joinOnlineWayBtn').click(); 1");
const row = await guestPage.until("(() => { const r = document.querySelector('#onlineRoomList .roomItem'); return r ? r.textContent : null; })()", 'the public game to be listed', 30000);
check('online: the public games, each with its name, its host and how many are in it', row.includes(world.name) && /Hana/.test(row) && /1\/\d/.test(row), row);
check('… and a place for a private game\'s code', await guestPage.eval(`${shown('joinOnlineView')} && !!document.getElementById('onlineJoinCode') && !!document.getElementById('onlineJoinGoBtn')`));
await shot(guestPage, 'join-online');
await guestPage.eval("document.querySelector('#onlineRoomList .roomItem').click(); 1");
await guestPage.until(inWorld, "the guest's world to load, joined from the list", 150000).catch(async (e) => {
    console.log('guest note:', await guestPage.eval("document.getElementById('lanJoinNote').textContent").catch(() => '?'));
    throw e;
});
await hostPage.until('window.__wwPlayers().length === 2', 'the host to see the guest who walked in', 30000);
check('a click on a public game joins it: a guest, in the host\'s world', await players(hostPage) === 'Gus,Hana*!' && await players(guestPage) === 'Gus!,Hana*', `${await players(hostPage)} | ${await players(guestPage)}`);
await hostPage.eval('window.__wwWorld.goOffline()', true);
await guestPage.until("!document.getElementById('WorldListScreen').classList.contains('hidden')", 'the guest to be sent back to their menu again', 30000);
await sleep(3500);                                                           // the list is kept a few seconds
check('closed, the game is gone from the list', (await guestPage.eval('window.__wwOnline.rooms({ gamepack: mergedGamePackData })', true)).length === 0);
// A private game's code, typed into the same screen.
const code2 = await hostPage.eval('window.__wwWorld.goOnline(activeWorld)', true);
await guestPage.eval('openLanJoin(); 1');
await guestPage.until("!document.getElementById('joinOnlineWayBtn').classList.contains('cannot')", 'the Online choice');
await guestPage.eval("document.getElementById('joinOnlineWayBtn').click(); 1");
await sleep(1500);
check('a private game is in no list', await guestPage.eval("document.querySelectorAll('#onlineRoomList .roomItem').length") === 0);
await guestPage.eval(`(() => { document.getElementById('onlineJoinCode').value = ${JSON.stringify(code2)}; document.getElementById('onlineJoinGoBtn').click(); return 1; })()`);
await guestPage.until(inWorld, "the guest's world to load, joined by the code typed", 150000);
check('… and is joined by typing its code', await players(guestPage) === 'Gus!,Hana*');
await hostPage.eval('window.__wwWorld.goOffline()', true);
await guestPage.until("!document.getElementById('WorldListScreen').classList.contains('hidden')", 'the guest to be back at their menu', 30000);

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
