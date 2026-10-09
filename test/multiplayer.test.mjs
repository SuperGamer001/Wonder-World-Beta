// The server's side of multiplayer: sessions (who is here, who is the host,
// what is passed on to whom, the journal of changed blocks a newcomer is
// handed), each player's own state file, and what a guest from the network may
// and may not reach while a world is open to it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

process.env.WONDER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-mp-'));
process.env.WW_LAN_PORT = '0';                                    // any free port
process.env.WW_BEACON_PORT = String(41000 + (process.pid % 2000));

const { serverReady } = await import('../server/server.js');
const { port, host } = await serverReady;
const base = `http://${host}:${port}`;

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const json = (url, method = 'GET', body) => fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
});

/** A client: its socket, everything it has been sent, and a way to wait for a message. */
async function client(url, opts = {}) {
    const ws = new WebSocket(url, opts);
    const got = [], waiting = [];
    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const m = JSON.parse(data.toString());
        got.push(m);
        for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].test(m)) waiting.splice(i, 1)[0].resolve(m);
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return {
        ws, got,
        send: (m) => ws.send(JSON.stringify(m)),
        next: (type, ms = 2000) => new Promise((resolve, reject) => {
            const test = (m) => m.type === type;
            const have = got.findIndex(test);
            if (have >= 0) return resolve(got.splice(have, 1)[0]);
            const w = { test: (m) => { if (!test(m)) return false; got.splice(got.indexOf(m), 1); return true; }, resolve };
            waiting.push(w);
            setTimeout(() => { const i = waiting.indexOf(w); if (i >= 0) { waiting.splice(i, 1); reject(new Error(`no ${type}`)); } }, ms);
        }),
        none: async (type, ms = 250) => { await sleep(ms); return !got.some(m => m.type === type); },
        close: () => ws.close(),
    };
}

const world = await (await json(`${base}/api/worlds`, 'POST', { name: 'Together', seed: 11 })).json();
const other = await (await json(`${base}/api/worlds`, 'POST', { name: 'Private', seed: 12 })).json();

// ── A session ────────────────────────────────────────────────────────────────
const a = await client(`ws://${host}:${port}`);
a.send({ type: 'mp:join', worldId: world.id, clientId: 'aaa', name: 'Ann', skin: { hair: 2, outfit: 1, evil: 'x', big: 999 } });
const wa = await a.next('mp:welcome');
check('the first to join is the host', wa.id === wa.hostId && wa.players.length === 0);

const b = await client(`ws://${host}:${port}`);
b.send({ type: 'mp:join', worldId: world.id, clientId: 'bbb', name: '   ', skin: { hair: 4 } });
const wb = await b.next('mp:welcome');
check('the second is told who is here, and who the host is',
    wb.hostId === wa.id && wb.players.length === 1 && wb.players[0].name === 'Ann' && wb.id !== wa.id);
check('a look is kept to small whole numbers', JSON.stringify(wb.players[0].skin) === JSON.stringify({ hair: 2, outfit: 1 }));
const joined = await a.next('mp:joined');
check('everyone is told of a newcomer, who has a name whether they gave one or not',
    joined.player.id === wb.id && joined.player.name === `Player ${wb.id}` && joined.player.skin.hair === 4);

a.send({ type: 'mp:state', s: [1, 2, 3, 0.5] });
const st = await b.next('mp:state');
check('where a player is goes to the others', st.id === wa.id && st.s[2] === 3);
check('… and not back to them', await a.none('mp:state'));

b.send({ type: 'mp:block', x: 10, y: 64, z: -3, b: 7 });
b.send({ type: 'mp:block', x: 10, y: 64, z: -3, b: 0 });
b.send({ type: 'mp:block', x: 11, y: 64, z: -3, b: 5 });
b.send({ type: 'mp:block', x: 'no', y: 64, z: -3, b: 5 });
const blk = await a.next('mp:block');
check('a changed block goes to the others', blk.x === 10 && blk.b === 7 && blk.id === wb.id);
await sleep(100);

// Messages between clients.
b.send({ type: 'mp:host', d: { t: 'hit', n: 1 } });
check('a message for the host reaches the host', (await a.next('mp:msg')).d.t === 'hit');
a.send({ type: 'mp:all', d: { t: 'mobs' } });
check('… one for everyone else, everyone else', (await b.next('mp:msg')).from === wa.id);
a.send({ type: 'mp:to', to: wb.id, d: { t: 'drops' } });
check('… and one for one player, that player', (await b.next('mp:msg')).d.t === 'drops');
b.send({ type: 'mp:atmos', a: { time: 0.9 } });
check('only the host sets the time and the weather', await a.none('mp:atmos'));
a.send({ type: 'mp:atmos', a: { time: 0.25 } });
check('… which the others are told', (await b.next('mp:atmos')).a.time === 0.25);

// A newcomer gets the journal: the latest block for each place, once.
const c = await client(`ws://${host}:${port}`);
c.send({ type: 'mp:join', worldId: world.id, clientId: 'ccc', name: 'Cy' });
const wc = await c.next('mp:welcome');
const edits = [];
for (let i = 0; i < wc.edits.length; i += 4) edits.push(wc.edits.slice(i, i + 4).join(','));
check('a newcomer is handed what has been changed, the latest of each place',
    edits.length === 2 && edits.includes('10,64,-3,0') && edits.includes('11,64,-3,5'), edits.join(' | '));
check('… the time and weather, and where everyone is',
    wc.atmos?.time === 0.25 && wc.players.length === 2 && wc.players.find(p => p.id === wa.id)?.state?.[0] === 1);

b.send({ type: 'mp:profile', name: 'Bea', skin: { outfit: 3 } });
check('a change of name or look is passed on', (await c.next('mp:profile')).name === 'Bea');

b.close();
check('a guest leaving is told to the rest', (await a.next('mp:left')).id === wb.id);
check('… and the session goes on', await c.none('mp:closed'));
a.close();
check('the host leaving ends it for everyone', (await c.next('mp:closed')).reason === 'host');

// A new session of the same world starts clean.
const d = await client(`ws://${host}:${port}`);
d.send({ type: 'mp:join', worldId: world.id, clientId: 'ddd' });
const wd = await d.next('mp:welcome');
check('the next session starts with no journal', wd.edits.length === 0 && wd.id === wd.hostId);
const e = await client(`ws://${host}:${port}`);
e.send({ type: 'mp:join', worldId: 'nope', clientId: 'eee' });
check('a world that does not exist cannot be joined', (await e.next('mp:closed')).reason === 'no-world');
e.close();

// ── Each player's own state ──────────────────────────────────────────────────
await json(`${base}/api/worlds/${world.id}/player-state`, 'PUT', { position: { x: 1, y: 70, z: 1 }, health: 80 });
await json(`${base}/api/worlds/${world.id}/player-state?player=guest-1`, 'PUT', { position: { x: 50, y: 70, z: 50 }, health: 20 });
await json(`${base}/api/worlds/${world.id}/player-state?player=../../evil`, 'PUT', { health: 1 });
const own = await (await json(`${base}/api/worlds/${world.id}/player-state`)).json();
const guest = await (await json(`${base}/api/worlds/${world.id}/player-state?player=guest-1`)).json();
const meta = await (await json(`${base}/api/worlds/${world.id}`)).json();
check('the owner and a guest each have their own state', own.health === 80 && guest.health === 20);
check('… and the world remembers where its owner was, not a guest', meta.playerPos?.x === 1);
check('a player id cannot name a file outside the world',
    fs.existsSync(path.join(process.env.WONDER_DATA_DIR, 'user', 'worlds', world.id, 'players', '______evil.json')) &&
    !fs.existsSync(path.join(process.env.WONDER_DATA_DIR, 'user', 'evil.json')));

// ── On the network ───────────────────────────────────────────────────────────
check('nothing is open to the network to begin with', (await (await json(`${base}/api/lan/status`)).json()).open === false);
const opened = await (await json(`${base}/api/lan/open`, 'POST', { worldId: world.id })).json();
check('opening a world starts a listener for it', opened.open && opened.port > 0 && opened.worldId === world.id);
const net = `http://127.0.0.1:${opened.port}`;
const status = async (url, method = 'GET', body) => (await json(url, method, body)).status;

check('a guest gets the game itself', await status(`${net}/game.html`) === 200 && await status(`${net}/src/main.js`) === 200 &&
    await status(`${net}/data/sounds/ui/click.ogg`) === 200 && await status(`${net}/api/data/manifest`) === 200);
const info = await (await json(`${net}/api/lan/info`)).json();
check('… and is told it is a guest, and of which world', info.guest === true && info.world?.id === world.id);
check('the player\'s own page is told it is not', (await (await json(`${base}/api/lan/info`)).json()).guest === false);
check('a guest cannot list worlds, make one or delete one',
    await status(`${net}/api/worlds`) === 403 && await status(`${net}/api/worlds`, 'POST', { name: 'x' }) === 403 &&
    await status(`${net}/api/worlds/${world.id}`, 'DELETE') === 403);
check('… or reach another world', await status(`${net}/api/worlds/${other.id}`) === 403 &&
    await status(`${net}/api/worlds/${other.id}/player-state?player=g`) === 403);
check('… or the owner\'s state, settings, or saved files',
    await status(`${net}/api/worlds/${world.id}/player-state`) === 403 &&
    await status(`${net}/api/settings`, 'PUT', { fov: 1 }) === 403 &&
    await status(`${net}/user/worlds/${world.id}/world.json`) === 403 &&
    await status(`${net}/src/../user/settings.json`) === 403 && await status(`${net}/src/%2e%2e/package.json`) === 403 &&
    await status(`${net}/package.json`) === 403 && await status(`${net}/server/server.js`) === 403);
check('… or open or close the network itself',
    await status(`${net}/api/lan/close`, 'POST') === 403 && await status(`${net}/api/lan/open`, 'POST', { worldId: other.id }) === 403);
check('a guest\'s settings are their own: they are given none',
    JSON.stringify(await (await json(`${net}/api/settings`)).json()) === '{}');
check('a guest has their own state in the world that is open',
    await status(`${net}/api/worlds/${world.id}/player-state?player=g1`, 'PUT', { health: 5 }) === 200 &&
    (await (await json(`${net}/api/worlds/${world.id}/player-state?player=g1`)).json()).health === 5);

const g = await client(`ws://127.0.0.1:${opened.port}`);
g.send({ type: 'mp:join', worldId: other.id, clientId: 'g1' });
check('a guest\'s socket cannot join another world', await g.none('mp:welcome', 300));
g.send({ type: 'getManifest', worldId: other.id });
check('… or read its chunks', await g.none('manifest', 300));
g.send({ type: 'mp:join', worldId: world.id, clientId: 'g1', name: 'Guest' });
const wg = await g.next('mp:welcome');
check('… but joins the one that is open', wg.hostId === wd.id);
check('a socket from another site is turned away', await client(`ws://127.0.0.1:${opened.port}`, { origin: 'http://evil.example' }).then(() => false, () => true));
check('the status counts the players', (await (await json(`${base}/api/lan/status`)).json()).players === 2);

await json(`${base}/api/lan/close`, 'POST');
check('closing sends the guests away', (await g.next('mp:closed')).reason === 'closed');
check('… and leaves the host playing', await d.none('mp:closed', 300));
check('… and the listener is gone', await fetch(`${net}/game.html`).then(() => false, () => true));

// The network closes by itself when the world's last player has gone.
const again = await (await json(`${base}/api/lan/open`, 'POST', { worldId: world.id })).json();
d.close();
await sleep(400);
// Not at once: a guest told the game is over still has their place in it to save.
const lingering = await status(`http://127.0.0.1:${again.port}/api/worlds/${world.id}/player-state?player=g1`, 'PUT', { health: 3 });
await sleep(1800);
const after = await (await json(`${base}/api/lan/status`)).json();
check('when the last player leaves, a guest can still save where they were', lingering === 200);
check('… and then the world closes to the network', again.open === true && after.open === false, JSON.stringify({ again, after }));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
await sleep(150);
process.exit(failures === 0 ? 0 : 1);
