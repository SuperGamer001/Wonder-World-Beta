// Online play: the token service (online/auth.js), and the game's own end of a
// room (engine/net/OnlineSession.js) — several games in one room, through a
// stand-in for Ably that enforces what Ably enforces (test/fakeAbly.mjs).
//
// What this cannot show is that Ably itself agrees with the stand-in. The one
// thing checked against Ably's own code is the signing: a token request made
// here must be, byte for byte, the one Ably's SDK makes from the same key.
import Ably from 'ably';
import { createAuth, tokenRequest, capability, channels as serverChannels, CODE_ALPHABET, LOBBY as SERVER_LOBBY } from '../online/auth.js';
import { OnlineSession, OnlineAuth, OnlineWorldClient, OnlineError } from '../src/scripts/engine/net/OnlineSession.js';
import { channels, cleanCode, ChunkStatus, HARD_MAX_PLAYERS, PROTOCOL, RATE, PART_BYTES, LOBBY, CODE_ALPHABET as GAME_ALPHABET } from '../src/scripts/engine/net/OnlineProtocol.js';
import { packEdits, unpackEdits } from '../src/scripts/engine/net/ChunkCodec.js';
import { makeFakeAbly } from './fakeAbly.mjs';

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000, what = '') {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what || fn}`);
        await sleep(10);
    }
}
const failure = (p) => p.then(() => null, (e) => e);

// A key of the right shape, made up: nothing here goes to Ably.
const KEY = 'aBcDeF.GhIjKl:' + 'S3cr3t-' + 'x'.repeat(40);
const SECRET = KEY.split(':')[1];
const DEVICE = (n) => `device-${n}-`.padEnd(30, 'z');

// ── The token service ─────────────────────────────────────────────────────────

{
    const auth = createAuth({ key: KEY, allowedOrigins: ['https://play.example.com'], ratePerMinute: 1000 });
    const post = (op, body, origin = '', ip = '1.2.3.4') => auth.respond({ method: 'POST', path: `/${op}`, origin, body, ip });

    // The one thing that has to be exactly as Ably has it.
    const cap = capability('ABCDEFGH', 'pXYZ-0', true);
    const mine = await tokenRequest({ keyName: 'aBcDeF.GhIjKl', keySecret: SECRET, clientId: 'pXYZ-0', capability: cap, ttl: 3600000, timestamp: 1700000000000, nonce: 'a-nonce-of-sixteen-or-more' });
    const theirs = await new Ably.Rest({ key: KEY }).auth.createTokenRequest({ clientId: 'pXYZ-0', capability: cap, ttl: 3600000, timestamp: 1700000000000, nonce: 'a-nonce-of-sixteen-or-more' });
    check("a token request is signed exactly as Ably's own SDK signs it", mine.mac === theirs.mac && mine.capability === theirs.capability && mine.keyName === theirs.keyName,
        `${mine.mac} / ${theirs.mac}`);

    const h = await post('host', { device: DEVICE(1), slot: 0 });
    check('a host is given a room: a code, a ticket, and a token request for it',
        h.status === 200 && cleanCode(h.body.code) === h.body.code && typeof h.body.ticket === 'string' && h.body.ticket.length >= 40 &&
        h.body.tokenRequest.keyName === 'aBcDeF.GhIjKl' && h.body.tokenRequest.ttl === 3600000, JSON.stringify(h.body).slice(0, 120));
    check('… and nothing of the key but its public name', !JSON.stringify(h).includes(SECRET) && !JSON.stringify(h).includes('S3cr3t'));
    const code = h.body.code, n = channels(code);
    const hostCap = JSON.parse(h.body.tokenRequest.capability);
    check("the host's token: speaks on the host channel, hears what guests send the host, writes to each guest",
        hostCap[n.host].includes('publish') && hostCap[n.up].includes('subscribe') && !hostCap[n.up].includes('publish') &&
        hostCap[`ww:${code}:to:*`].join() === 'publish' && Object.keys(hostCap).every(k => k.startsWith(`ww:${code}:`)));

    const g = await post('token', { code, device: DEVICE(2), slot: 0 });
    const guestCap = JSON.parse(g.body.tokenRequest.capability);
    check("a guest's token: hears the host and cannot speak as it, cannot hear what others send the host, reads only its own letters",
        g.status === 200 && g.body.host === false && guestCap[n.host].join() === 'subscribe' && guestCap[n.up].join() === 'publish' &&
        guestCap[n.to(g.body.clientId)].join() === 'subscribe' && Object.keys(guestCap).length === 4 && !Object.keys(guestCap).some(k => k.includes('*')));

    const again = await post('token', { code, device: DEVICE(2), slot: 0 });
    const other = await post('token', { code, device: DEVICE(3), slot: 0 });
    const second = await post('token', { code, device: DEVICE(2), slot: 1 });
    check('who a game is comes from its secret: the same each time, different for another, and for a second player of one machine',
        again.body.clientId === g.body.clientId && other.body.clientId !== g.body.clientId && second.body.clientId !== g.body.clientId &&
        second.body.clientId.slice(0, -2) === g.body.clientId.slice(0, -2) && /^p[A-Za-z0-9_-]{20}-[0-3]$/.test(g.body.clientId) && !g.body.clientId.includes(DEVICE(2)));
    check('… and not from the key in a way another key would repeat',
        (await createAuth({ key: KEY.replace('S3cr3t', 'S3cr3T') }).respond({ method: 'POST', path: '/token', body: { code, device: DEVICE(2), slot: 0 }, ip: 'x' })).body.clientId !== g.body.clientId);

    const renewed = await post('token', { code, device: DEVICE(1), slot: 0, ticket: h.body.ticket });
    check('the host renews its token with the ticket', renewed.status === 200 && renewed.body.host === true && renewed.body.clientId === h.body.clientId);
    const h2 = await post('host', { device: DEVICE(1), slot: 0 });
    const tries = {
        'a made-up ticket': { code, device: DEVICE(2), slot: 0, ticket: 'x'.repeat(h.body.ticket.length) },
        "the host's ticket, in another player's hands": { code, device: DEVICE(2), slot: 0, ticket: h.body.ticket },
        "another room's ticket": { code, device: DEVICE(1), slot: 0, ticket: h2.body.ticket },
        "the host's ticket, for a second player of the host's machine": { code, device: DEVICE(1), slot: 1, ticket: h.body.ticket },
        'an empty ticket': { code, device: DEVICE(1), slot: 0, ticket: '' },
    };
    for (const [what, body] of Object.entries(tries)) check(`${what} makes nobody the host`, (await post('token', body)).status === 403);
    check('with no ticket the host itself is a guest', (await post('token', { code, device: DEVICE(1), slot: 0 })).body.host === false);

    const bad = [
        ['token', { code, device: 'short', slot: 0 }], ['token', { code, device: DEVICE(1), slot: 4 }], ['token', { code, device: DEVICE(1), slot: -1 }],
        ['token', { code, device: DEVICE(1), slot: '0' }], ['token', { code: 'ABCD', device: DEVICE(1), slot: 0 }], ['token', { code: code.toLowerCase(), device: DEVICE(1), slot: 0 }],
        ['token', { code: 'ABCDEFG*', device: DEVICE(1), slot: 0 }], ['token', { code: 'ABCD:FGH', device: DEVICE(1), slot: 0 }], ['token', { device: DEVICE(1), slot: 0 }],
        ['token', { code, device: DEVICE(1) + ':*', slot: 0 }], ['host', { device: DEVICE(1), slot: 1 }], ['host', {}], ['token', null], ['token', [1]], ['token', 'text'],
    ];
    const let_through = [];
    for (const [op, body] of bad) if ((await post(op, body)).status !== 400) let_through.push(JSON.stringify(body));
    check('what is not a request is refused', let_through.length === 0, let_through.join(' | '));
    check('there is nothing else here', (await auth.respond({ method: 'POST', path: '/admin', body: {} })).status === 404 && (await auth.respond({ method: 'GET', path: '/host' })).status === 404 &&
        (await auth.respond({ method: 'GET', path: '/' })).body.ok === true);

    const codes = new Set();
    for (let i = 0; i < 300; i++) codes.add((await post('host', { device: DEVICE(1), slot: 0 })).body.code);
    check('codes are made at random, from letters nobody misreads', codes.size === 300 && [...codes].every(c => [...c].every(ch => CODE_ALPHABET.includes(ch))) && CODE_ALPHABET === GAME_ALPHABET);

    // Who may ask.
    const from = (origin) => post('token', { code, device: DEVICE(2), slot: 0 }, origin);
    const allowed = await from('https://play.example.com'), desktop = await from('http://127.0.0.1:53124'), stranger = await from('https://evil.example');
    check("the browser edition's page, and a page served from the player's own machine, may ask; another site's page may not",
        allowed.status === 200 && allowed.headers['Access-Control-Allow-Origin'] === 'https://play.example.com' &&
        desktop.status === 200 && desktop.headers['Access-Control-Allow-Origin'] === 'http://127.0.0.1:53124' &&
        stranger.status === 403 && !stranger.headers['Access-Control-Allow-Origin'] &&
        (await from('https://play.example.com.evil.example')).status === 403 && (await from('http://127.0.0.1.evil.example')).status === 403 && (await from('null')).status === 403);
    check('a browser asking leave first is answered', (await auth.respond({ method: 'OPTIONS', path: '/host', origin: 'https://play.example.com' })).status === 204);
    check('pages on a player\'s own machine can be refused too',
        (await createAuth({ key: KEY, allowLoopback: false }).respond({ method: 'POST', path: '/host', origin: 'http://127.0.0.1:3000', body: { device: DEVICE(1), slot: 0 } })).status === 403);

    // How often.
    let t = 0;
    const slow = createAuth({ key: KEY, ratePerMinute: 5, now: () => t });
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await slow.respond({ method: 'POST', path: '/host', body: { device: DEVICE(1), slot: 0 }, ip: '9.9.9.9' })).status);
    const elsewhere = (await slow.respond({ method: 'POST', path: '/host', body: { device: DEVICE(1), slot: 0 }, ip: '8.8.8.8' })).status;
    t += 60000;
    const later = (await slow.respond({ method: 'POST', path: '/host', body: { device: DEVICE(1), slot: 0 }, ip: '9.9.9.9' })).status;
    check('an address asks only so often, and is let in again a minute later', statuses.join() === '200,200,200,200,200,429,429' && elsewhere === 200 && later === 200, statuses.join());

    // As a Worker, or Node's own server, speaks to it.
    const res = await auth.handle(new Request('https://online.example.com/token', { method: 'POST', headers: { Origin: 'https://play.example.com' }, body: JSON.stringify({ code, device: DEVICE(2), slot: 0 }) }), '5.5.5.5');
    const big = await auth.handle(new Request('https://online.example.com/token', { method: 'POST', body: JSON.stringify({ code, device: DEVICE(2), slot: 0, pad: 'x'.repeat(3000) }) }));
    const junk = await auth.handle(new Request('https://online.example.com/token', { method: 'POST', body: '{not json' }));
    check('it answers a Request with a Response', res.status === 200 && (await res.json()).clientId === g.body.clientId && res.headers.get('Access-Control-Allow-Origin') === 'https://play.example.com' &&
        big.status === 413 && junk.status === 400);

    check('it will not start without a key that could be one', ['', 'abc', 'app.key', 'app.key:', 'app:secretsecret', undefined].every(k => { try { createAuth({ key: k }); return false; } catch { return true; } }));
    check('the game and the token service name a room\'s channels alike',
        JSON.stringify([channels('ABCDEFGH').all, channels('ABCDEFGH').host, channels('ABCDEFGH').up, channels('ABCDEFGH').to('pX-0')]) ===
        JSON.stringify([serverChannels('ABCDEFGH').all, serverChannels('ABCDEFGH').host, serverChannels('ABCDEFGH').up, serverChannels('ABCDEFGH').to('pX-0')]));
}

// ── Rooms ─────────────────────────────────────────────────────────────────────

const WORLD = { name: 'Shared', seed: 1234, worldGen: 2, terrainStyle: 'smooth', gameMode: 'SURVIVAL', difficulty: 'NORMAL', daylightCycle: true, weather: 'dynamic', flat: null };
const CONTENT = 'c'.repeat(28);

function setup() {
    const { Ably: Fake, hub, settle } = makeFakeAbly({ key: KEY });
    // The token service asks Ably who is in the lobby: here, the stand-in answers as Ably's REST API does.
    const ably = { asked: 0, auth: null };
    const service = createAuth({
        key: KEY, ratePerMinute: 100000, now: () => Date.now() + (ably.skip ?? 0),
        fetchFn: async (url, init) => {
            ably.asked++; ably.auth = init?.headers?.Authorization ?? null; ably.url = String(url);
            if (ably.down) return new Response('no', { status: 503 });
            return new Response(JSON.stringify(hub.restPresence(decodeURIComponent(String(url).split('/channels/')[1].split('/')[0]))), { status: 200 });
        },
    });
    const fetchFn = async (url, init) => service.handle(new Request(url, init), 'test');
    const sessions = [];
    let devices = 0;
    /** A game: its own secret, kept where a game keeps it. */
    function game(name, { slot = 0, device = null, hello = {} } = {}) {
        const store = { v: device ?? DEVICE(100 + devices++), get() { return this.v; }, set(v) { this.v = v; } };
        const s = new OnlineSession(Fake, new OnlineAuth({ url: 'https://online.example.com', fetchFn, storage: store }));
        const g = { s, name, store, hello: { version: '0.1.0', content: CONTENT, worldGen: 2, name, skin: { hair: 1 }, slot, ...hello }, blocks: [], msgs: [], states: [], joined: [], left: [], closed: null, down: [], world: new Map() };
        s.onBlock = (x, y, z, b) => { g.blocks.push([x, y, z, b]); g.world.set(`${x},${y},${z}`, b); };
        s.onMsg = (from, d) => g.msgs.push([from, d]);
        s.onState = (id, st) => g.states.push([id, st]);
        s.onJoined = (p) => g.joined.push(p.name);
        s.onLeft = (id) => g.left.push(id);
        s.onClosed = (reason) => { g.closed = reason; };
        s.onDown = (down) => g.down.push(down);
        // Each game's own copy of the world, as world.js keeps one.
        s.blockAt = (x, y, z) => g.world.get(`${x},${y},${z}`) ?? 0;
        g.set = (x, y, z, b) => { const was = s.blockAt(x, y, z); g.world.set(`${x},${y},${z}`, b); s.block(x, y, z, b, was); };
        sessions.push(s);
        return g;
    }
    const names = (g) => [...g.s.players.values()].map(p => `${p.id}:${p.name}`).sort().join(' ');
    const end = () => { for (const s of sessions) s.close(); };
    return { hub, settle, game, names, end, Fake, service, fetchFn, ably };
}

{
    const { hub, settle, game, names, end, Fake, fetchFn } = setup();
    const host = game('Hana'), gus = game('Gus'), ivy = game('Ivy');

    const w = await host.s.open(host.hello, WORLD);
    check('a host opens a room and is its host, alone', w.id === 1 && host.s.isHost && host.s.alone && cleanCode(host.s.code) === host.s.code && host.s.online === true);
    hub.reset();
    host.s.state([0, 70, 0, 0, 0, 0, 1, 0, 0]);
    host.set(1, 70, 0, 3);
    host.s.all({ t: 'mobs', list: [1, 2, 3] });
    host.s.atmos({ time: 0.5 });
    await settle();
    check('alone, nothing is said: nobody is there to hear it, and every message is counted', hub.messages === 0, String(hub.messages));

    check('a code no game has is no game', (await failure(game('Mal').s.enter('AAAAAAAA', { ...host.hello, name: 'Mal' })))?.reason === 'code');
    check('… nor is something that is not a code', (await failure(game('Mal').s.enter('abc', host.hello)))?.reason === 'code');

    const gw = await gus.s.enter(host.s.code.toLowerCase().replace(/^(....)/, '$1-'), gus.hello);
    check('a guest joins by the code, and is told who is who', gw.id === 2 && gw.hostId === 1 && !gus.s.isHost && names(gus) === '1:Hana' && gw.players.length === 1);
    check('… and what world to make', JSON.stringify(gus.s.world) === JSON.stringify(WORLD));
    await until(() => names(host) === '2:Gus', 2000, 'the host to see the guest');
    check('the host sees them arrive', host.joined.join() === 'Gus' && host.s.players.get(2).skin.hair === 1);

    await ivy.s.enter(host.s.code, ivy.hello);
    await until(() => names(gus) === '1:Hana 3:Ivy' && names(host) === '2:Gus 3:Ivy' && names(ivy) === '1:Hana 2:Gus', 2000, 'everyone to see everyone');
    check('a third player: everyone sees everyone, under the numbers the host gave', gus.joined.join() === 'Ivy' && ivy.s.id === 3);

    // Where everyone is.
    host.s.state([1, 70, 1, 0, 0, 0, 1, 0, 0]);
    gus.s.state([5, 70, 5, 0, 0, 0, 1, 0, 0]);
    await settle();
    check('where a player is reaches the others, and says whose it is', JSON.stringify(ivy.states.sort()) === JSON.stringify([[1, [1, 70, 1, 0, 0, 0, 1, 0, 0]], [2, [5, 70, 5, 0, 0, 0, 1, 0, 0]]]) &&
        host.states.length === 1 && host.states[0][0] === 2 && gus.states.length === 1);
    hub.reset();
    await sleep(RATE.STATE + 20);
    const began = Date.now();
    for (let i = 0; i < 40; i++) { gus.s.state([5 + i * 0.1, 70, 5, 0, 0, 0, 1, 0, 0]); await sleep(5); }
    const took = Date.now() - began;
    await settle();
    const said = hub.count.inbound;
    check('it is said five times a second at most, however often the game offers it', said >= 1 && said <= Math.floor(took / RATE.STATE) + 1, `${said} in ${took} ms, offered 40 times`);
    hub.reset();
    await sleep(RATE.STATE + 20);
    for (let i = 0; i < 30; i++) { gus.s.state([9, 70, 5, 0, 0, 0, 1, 0, 0]); await sleep(RATE.STATE / 4); }
    await settle();
    check('… and a player standing still says so once, then every two seconds', hub.count.inbound === 1, String(hub.count.inbound));

    // Blocks.
    await sleep(RATE.STATE + 20);
    host.s.state([0, 70, 0, 0, 0, 0, 1, 0, 0]); gus.s.state([2, 70, 0, 0, 0, 0, 1, 0, 0]); ivy.s.state([4, 70, 0, 0, 0, 0, 1, 0, 0]);
    await settle();
    host.set(1, 70, 0, 27);
    gus.set(2, 71, 0, 25);
    await settle();
    check('a block changed by the host, or by a guest, changes for everyone',
        [host, gus, ivy].every(g => g.world.get('1,70,0') === 27 && g.world.get('2,71,0') === 25));
    check('… and is not sent back to whoever changed it', !host.blocks.some(b => b.join() === '1,70,0,27') && !gus.blocks.some(b => b.join() === '2,71,0,25'));

    // Two players, one block, the same moment: each has heard the other's after their own.
    gus.set(3, 70, 0, 11);
    ivy.set(3, 70, 0, 12);
    await settle();
    const ends = [host, gus, ivy].map(g => g.world.get('3,70,0'));
    check('two players changing one block at once end up agreeing: as the host has it', new Set(ends).size === 1 && ends[0] === host.world.get('3,70,0'), ends.join());

    // Too far to be a player's doing.
    gus.set(500, 70, 500, 43);
    await settle();
    check("a block out of its player's reach is not done on the host, and is put back for everyone",
        (host.world.get('500,70,500') ?? 0) === 0 && (gus.world.get('500,70,500') ?? 0) === 0 && (ivy.world.get('500,70,500') ?? 0) === 0);
    gus.set(60, 70, 0, 5);
    await settle();
    check('water may be changed further off (it flows)', host.world.get('60,70,0') === 5);
    const junk = [[1, 2, 3], [1, 70, 1, -1, 0], [1, 9999, 1, 3, 0], [1.5, 70, 1, 3, 0], [3e6, 70, 1, 3, 0], [1, 70, 1, 70000, 0], 'x', { x: 1 }, [1, 70, 1, '3', 0]];
    const before = ivy.blocks.length;
    const rawGus = [...hub.connections].find(c => c.clientId === gus.s._client);
    for (const j of junk) await rawGus.channels.get(channels(host.s.code).all).publish('b', j);
    await settle();
    check('what is not a block change changes nothing', ivy.blocks.length === before && host.blocks.every(b => b.every(Number.isInteger)));

    // The host's word.
    host.s.all({ t: 'mobs', list: [7, 1, 2, 3], info: { 7: { type: 'cow' } } });
    host.s.all({ t: 'mobs', list: [8, 1, 2, 3], info: { 8: { type: 'pig' } } });      // within the same third of a second
    await sleep(RATE.MOBS + 30);
    host.s.all({ t: 'mobs', list: [8, 4, 5, 6] });
    host.s.atmos({ time: 0.25 });
    await settle();
    const mobs = gus.msgs.filter(m => m[1].t === 'mobs');
    check("the host's mobs reach every guest, a few times a second, as the host's", mobs.length === 2 && mobs.every(m => m[0] === 1) && ivy.msgs.filter(m => m[1].t === 'mobs').length === 2);
    check("… and a mob's look, sent once, is never lost with a snapshot that was not sent", JSON.stringify(mobs[1][1].info) === JSON.stringify({ 8: { type: 'pig' } }) && mobs[0][1].info[7].type === 'cow');
    gus.s.host({ t: 'hit', id: 7, dmg: 3 });
    host.s.to(3, { t: 'attack', dmg: 2 });
    await settle();
    check('a blow on a mob goes to the host alone, and says who struck', host.msgs.some(m => m[0] === 2 && m[1].t === 'hit' && m[1].id === 7) && !ivy.msgs.some(m => m[1].t === 'hit'));
    check("a mob's blow goes to the one player it landed on", ivy.msgs.some(m => m[0] === 1 && m[1].t === 'attack') && !gus.msgs.some(m => m[1].t === 'attack'));

    // What a guest's token will not do, whatever its game is changed to try.
    const n = channels(host.s.code);
    hub.refused.length = 0;
    const forged = [
        await failure(rawGus.channels.get(n.host, { modes: ['PUBLISH'] }).publish('r', { ids: { [gus.s._client]: 1 } })),
        await failure(rawGus.channels.get(n.host, { modes: ['PUBLISH'] }).publish('bye', {})),
        await failure(rawGus.channels.get(n.host, { modes: ['PUBLISH'] }).publish('m', { t: 'mobs', list: [] })),
        await failure(rawGus.channels.get(n.to(ivy.s._client), { modes: ['PUBLISH'] }).publish('k', {})),
        await failure(rawGus.channels.get(n.to(ivy.s._client), { modes: ['SUBSCRIBE'] }).subscribe(() => {})),
        await failure(rawGus.channels.get(n.up, { modes: ['SUBSCRIBE'] }).subscribe(() => {})),
        await failure(rawGus.channels.get('ww:ZZZZZZZZ:all').publish('s', [0, 0, 0])),
        await failure(rawGus.channels.get('ww:ZZZZZZZZ:all').subscribe(() => {})),
    ];
    await settle();
    check("a guest cannot speak as the host, send another guest away, read another's letters or what is sent the host, or reach another room",
        forged.every(e => e?.code === 40160) && !ivy.closed && names(ivy) === '1:Hana 2:Gus', forged.map(e => e?.code ?? 'allowed').join());
    // … and what it may publish does not make it anyone else.
    await rawGus.channels.get(n.all).publish('r', { ids: { [gus.s._client]: 1 } });
    await rawGus.channels.get(n.all).publish('bye', {});
    await rawGus.channels.get(n.all).publish('s', { clientId: ivy.s._client, 0: 1 });
    await rawGus.channels.get(n.up).publish('q', { rid: 1, op: '__proto__' });
    await rawGus.channels.get(n.up).publish('q', { rid: 2, op: 'constructor' });
    await settle();
    check('… and saying the host\'s things where guests speak does nothing', !ivy.closed && !host.closed && names(ivy) === '1:Hana 2:Gus' && ivy.s.hostId === 1);

    // Somebody who has the code and was never let in.
    const lurker = new OnlineAuth({ url: 'https://online.example.com', fetchFn, storage: { get: () => DEVICE(999), set() {} } });
    const grant = await lurker.token(host.s.code, 0);
    const raw = new Fake.Realtime({ authCallback: (_p, cb) => cb(null, grant.tokenRequest) });
    await until(() => raw.connection.state === 'connected');
    const seen = ivy.states.length;
    await raw.channels.get(n.all).publish('s', [1, 2, 3, 0, 0, 0, 0, 0, 0]);
    await raw.channels.get(n.all).publish('b', [1, 70, 0, 0, 27]);
    await settle();
    check('a game the host has not let in is not heard by anyone', ivy.states.length === seen && host.world.get('1,70,0') === 27 && ivy.world.get('1,70,0') === 27);
    raw.close();

    // The host's world, for its guests.
    const asked = [];
    const chunkBytes = new Uint8Array(PART_BYTES * 2 + 1234).map((_, i) => (i * 31) & 255);
    const keys = Array.from({ length: 20000 }, (_, i) => `${i - 10000},${(i * 7) % 4001 - 2000}`);
    const places = new Map();
    let busy = 1;
    host.s.serve.manifest = async () => ({ keys });
    host.s.serve.chunk = async ({ cx, cz }) => {
        asked.push(`${cx},${cz}`);
        if (cx === 9 && busy-- > 0) return { s: ChunkStatus.RETRY };
        if (cx === 1) return { s: ChunkStatus.DATA, d: chunkBytes };
        if (cx === 2) return { s: ChunkStatus.EDITS, d: packEdits(new Map([[5, 7], [900, 3]])) };
        if (cx === 3) throw new Error('disk');
        return { s: ChunkStatus.NONE };
    };
    host.s.serve.pload = async ({ key }) => ({ state: places.get(key) ?? null });
    host.s.serve.psave = async ({ key, state }) => { places.set(key, state); return {}; };

    const got = await gus.s.manifest();
    check('a guest is told which chunks the host has data for — tens of thousands, in a few messages', got.size === keys.length && keys.every(k => got.has(k)));
    const big = await gus.s.chunk(1, 0);
    check('a chunk bigger than one message arrives whole', big.s === ChunkStatus.DATA && big.d.length === chunkBytes.length && big.d.every((v, i) => v === chunkBytes[i]));
    check('a chunk the host has nothing for, or cannot read, is one to make from the seed', (await gus.s.chunk(5, 5)).s === ChunkStatus.NONE && !(await gus.s.chunk(3, 0))?.d);
    check('a busy host is asked again', (await gus.s.chunk(9, 0)).s === ChunkStatus.NONE && asked.filter(k => k === '9,0').length === 2);
    const pending = new Map();
    const wc = new OnlineWorldClient(gus.s, { unpackEdits, unpackChunk: async (d) => ({ bytes: d.length }) }, { pendingChanges: pending });
    await wc.fetchManifest();
    keys.push('1,0', '2,0');
    await wc.fetchManifest();
    check('as the game\'s chunk loader sees it: saved chunks come whole, changed ones as their changes, the rest are generated',
        (await wc.loadChunk('w', 1, 0)).bytes === chunkBytes.length && (await wc.loadChunk('w', 2, 0)) === null && pending.get('2,0').get(900) === 3 &&
        (await wc.loadChunk('w', 77777, 0)) === null && !asked.includes('77777,0'));

    check('a guest with no saved place has none', (await ivy.s.loadState()) === null);
    gus.s.saveState({ pos: [1, 2, 3], inv: ['torch'] });
    ivy.s.saveState({ pos: [9, 9, 9] });
    await settle(); await sleep(60); await settle();
    check('each guest\'s place is kept by the host under who Ably says they are', places.size === 2 && places.get(gus.s._client).inv[0] === 'torch' && /^[A-Za-z0-9_-]{8,40}$/.test(gus.s._client) &&
        JSON.stringify(await gus.s.loadState()) === JSON.stringify({ pos: [1, 2, 3], inv: ['torch'] }) && JSON.stringify(await ivy.s.loadState()) === JSON.stringify({ pos: [9, 9, 9] }));
    await rawGus.channels.get(n.up).publish('q', { rid: 0, op: 'psave', key: ivy.s._client, state: { pos: 'stolen' } });
    await settle(); await sleep(60);
    check("… so nobody saves over another's by naming them", JSON.stringify(places.get(ivy.s._client)) === JSON.stringify({ pos: [9, 9, 9] }));

    // The line.
    await hub.blip(gus.s._client);
    check('a line that drops and comes back is said to have, and the game goes on', gus.down.join() === 'true,false' && !gus.closed && gus.s.connected);
    const conn = [...hub.connections].find(c => c.clientId === host.s._client);
    await conn.renew();
    check('when its token runs out the host is given another, still as the host', conn.tokens === 2 && JSON.parse(JSON.stringify(conn._cap))[n.host].includes('publish'));

    // A name changed.
    ivy.s.profile('Ivy the 2nd <b>', { hair: 3 });
    await until(() => names(gus) === '1:Hana 3:Ivy the 2nd b', 2000, 'the new name');
    check('a changed name and look reach everyone, cleaned', host.s.players.get(3).skin.hair === 3 && host.s.players.get(3).name === 'Ivy the 2nd b');

    // Sent away.
    host.s.kick(2);
    await until(() => gus.closed, 2000, 'the guest to be told');
    await settle();
    check('a player the host removes is told, and is gone for everyone', gus.closed === 'kicked' && names(host) === '3:Ivy the 2nd b' && names(ivy) === '1:Hana' && ivy.left.includes(2));
    const back = game('Gus', { device: gus.store.v });
    check('… and is not let back in', (await failure(back.s.enter(host.s.code, back.hello)))?.reason === 'kicked');
    const pane = game('Gus2', { device: gus.store.v, slot: 1 });
    check('… nor is a second player of their machine', (await failure(pane.s.enter(host.s.code, pane.hello)))?.reason === 'kicked');

    // Leaving.
    ivy.s.close();
    await until(() => host.s.alone, 2000, 'the host to be alone');
    check('a guest who leaves is gone at once', host.left.includes(3));
    const jay = game('Jay');
    await jay.s.enter(host.s.code, jay.hello);
    check('a newcomer takes a new number; nobody inherits one', jay.s.id === 4);
    host.s.close();
    await until(() => jay.closed, 2000, 'the guest to hear the host has gone');
    check('when the host closes the game, its guests are told at once', jay.closed === 'host');
    await settle();
    check('… and the code is no game any more', (await failure(game('Kay').s.enter(host.s.code, host.hello)))?.reason === 'code');
    check('nothing was tried that a token refused, other than on purpose', hub.refused.length === 8, hub.refused.join(' | '));
    end();
}

// ── Who is let in ─────────────────────────────────────────────────────────────

{
    const { hub, settle, game, names, end } = setup();
    const host = game('Hana');
    await host.s.open(host.hello, WORLD, 3);
    const join = (name, o) => { const g = game(name, o); return failure(g.s.enter(host.s.code, g.hello)).then(e => [g, e]); };

    check('a game with other blocks is turned away: it could not make the same land', (await join('Odd', { hello: { content: 'd'.repeat(28) } }))[1]?.reason === 'content');
    check('… as is one with an older world generator than the world needs', (await join('Old', { hello: { worldGen: 1 } }))[1]?.reason === 'update');
    const [a] = await join('Ann');
    host.s.lock(true);
    check('a host can shut the door', (await join('Late'))[1]?.reason === 'locked');
    host.s.lock(false);
    const [b, eb] = await join('Bob');
    check('a room holds as many as its host asked for', !eb && (await join('Cy'))[1]?.reason === 'full' && host.s.max === 3);
    check('… and never more than the most a room may', (await (async () => { const h = game('Big'); await h.s.open(h.hello, WORLD, 99); return h.s.max; })()) === HARD_MAX_PLAYERS);
    await until(() => names(host) === '2:Ann 3:Bob');

    // The host's own machine: a second player on its screen is a guest of the room, from the same secret.
    b.s.close();
    await until(() => names(host) === '2:Ann');
    const pane = game('Ben', { device: host.store.v, slot: 1 });
    await pane.s.enter(host.s.code, pane.hello);
    await until(() => names(host) === '2:Ann 4:Ben');
    check("a second player of the host's machine is in the room as themselves, and is not the host", !pane.s.isHost && pane.s._client !== host.s._client && pane.s._client.slice(0, -2) === host.s._client.slice(0, -2));
    const same = game('Imp', { device: a.store.v, slot: 0 });
    const [, twice] = [null, await failure(same.s.enter(host.s.code, same.hello))];
    check('a player already in the room is one player, however many times their game connects', !twice && [...host.s.players.values()].filter(p => p.id === 2).length === 1 && host.s.players.size === 2);

    // The host is gone without a word (its machine slept, its line was cut).
    hub.vanish(host.s._client);
    await until(() => a.closed && pane.closed, 2000, 'the guests to be told');
    check('when the host vanishes, its guests are told the game is over', a.closed === 'host' && pane.closed === 'host' && host.closed === 'lost');
    await settle();
    end();
}

// ── Public games ──────────────────────────────────────────────────────────────

{
    const { hub, settle, game, names, end, Fake, service, fetchFn, ably } = setup();
    const fresh = () => { ably.skip = (ably.skip ?? 0) + 10000; };      // past the few seconds a list is kept for
    const list = async (g, filter) => { fresh(); return g.s.auth.rooms(filter); };
    const lobbyCap = (g) => JSON.parse(JSON.stringify([...hub.connections].find(c => c.clientId === g.s._client)._cap))[LOBBY];

    const priv = game('Pia'), pub = game('Hana'), creative = game('Otto'), wes = game('Wes');
    await priv.s.open(priv.hello, WORLD);
    await pub.s.open(pub.hello, { ...WORLD, name: 'Castle <b>Build</b>' }, 3, { visibility: 'public' });
    await creative.s.open({ ...creative.hello, content: 'd'.repeat(28) }, { ...WORLD, name: 'Sky', gameMode: 'CREATIVE', flat: { mode: 'layers' } }, 4, { visibility: 'public', roomName: 'Flat Fun' });
    await settle();
    check('a host chooses: a room is private unless it was opened to anyone', priv.s.visibility === 'private' && pub.s.visibility === 'public' && LOBBY === SERVER_LOBBY);
    check('only the host of a public room may stand in the lobby — and may do nothing else there', lobbyCap(pub)?.join() === 'presence' && lobbyCap(priv) === undefined);

    const rooms = await list(wes);
    check('the list of public games: each as its host describes it, with its code, and the private one not in it',
        JSON.stringify(rooms.sort((a, b) => a.name.localeCompare(b.name))) === JSON.stringify([
            { code: pub.s.code, name: 'Castle bBuildb', host: 'Hana', players: 1, max: 3, mode: 'SURVIVAL', flat: false },
            { code: creative.s.code, name: 'Flat Fun', host: 'Otto', players: 1, max: 4, mode: 'CREATIVE', flat: true },
        ]) && !JSON.stringify(rooms).includes(priv.s.code), JSON.stringify(rooms));
    check('… read from Ably by the service with the key, which no game sees', ably.auth === `Basic ${Buffer.from(KEY).toString('base64')}` && ably.url.includes('/channels/ww%3Alobby/presence') &&
        !JSON.stringify(rooms).includes(SECRET));
    check('it can be asked for one kind of game, and for the games this copy could play in',
        (await list(wes, { mode: 'CREATIVE' })).map(r => r.name).join() === 'Flat Fun' && (await list(wes, { content: CONTENT, protocol: PROTOCOL })).map(r => r.host).join() === 'Hana' &&
        (await list(wes, { protocol: 99 })).length === 0);
    const before = ably.asked;
    await Promise.all([wes.s.auth.rooms(), wes.s.auth.rooms(), wes.s.auth.rooms()]);
    await wes.s.auth.rooms();
    check('however many ask, Ably is asked once every few seconds', ably.asked === before);
    const bad = [];
    for (const q of ['mode=GOD', 'content=zz', 'protocol=x', 'protocol=-1']) if ((await service.handle(new Request(`https://o.example/rooms?${q}`), 'q')).status !== 400) bad.push(q);
    check('what is not a question about rooms is refused', bad.length === 0 && (await service.handle(new Request('https://o.example/rooms', { method: 'POST', body: '{}' }), 'q')).status === 404, bad.join());

    // Joining one: its code is in the list, and that is all it takes.
    const ann = game('Ann'), bob = game('Bob');
    await ann.s.enter(rooms.find(r => r.host === 'Hana').code, ann.hello);
    await until(() => names(pub) === '2:Ann');
    await settle();
    check('a public game is joined with the code the list gave, and the list counts its players', (await list(wes)).find(r => r.host === 'Hana').players === 2);
    await bob.s.enter(pub.s.code, bob.hello);
    await until(() => pub.s.players.size === 2);
    await settle();
    check('a full game is no longer listed', !(await list(wes)).some(r => r.host === 'Hana'));
    bob.s.close();
    await until(() => pub.s.players.size === 1);
    await settle();
    check('… and is again when a place is free', (await list(wes)).some(r => r.host === 'Hana' && r.players === 2));
    pub.s.lock(true);
    await settle();
    check('a game its host has shut is not listed', !(await list(wes)).some(r => r.host === 'Hana'));
    pub.s.lock(false);
    pub.s.profile('Hana the Great', {});
    await settle();
    check('the list follows the host\'s name', (await list(wes)).find(r => r.code === pub.s.code)?.host === 'Hana the Great');

    // What cannot be put in the list.
    const lobbyOf = (g) => [...hub.connections].find(c => c.clientId === g.s._client).channels.get(LOBBY, { modes: ['PRESENCE'] });
    const privTry = await failure(lobbyOf(priv).presence.enter({ v: PROTOCOL, code: priv.s.code, tag: 'x'.repeat(43), name: 'Free stuff', host: 'Pia', players: 1, max: 4 }));
    const guestTry = await failure(lobbyOf(ann).presence.enter({ v: PROTOCOL, code: pub.s.code, name: 'Mine now', host: 'Ann', players: 1, max: 4 }));
    check("a private room's host, and a guest, cannot stand in the lobby at all", privTry?.code === 40160 && guestTry?.code === 40160);
    // The host of one public room, advertising others it has no tag for: another's private room, a made-up one, and its own under a forged tag.
    const mine = pub.s._tag;
    const raw = [...hub.connections].find(c => c.clientId === creative.s._client).channels.get(LOBBY, { modes: ['PRESENCE'] });
    for (const data of [
        { v: PROTOCOL, code: priv.s.code, tag: creative.s._tag, name: 'Come in', host: 'Otto', players: 1, max: 4 },
        { v: PROTOCOL, code: priv.s.code, tag: mine, name: 'Come in', host: 'Otto', players: 1, max: 4 },
        { v: PROTOCOL, code: 'AAAAAAAA', tag: creative.s._tag, name: 'Come in', host: 'Otto', players: 1, max: 4 },
        { v: PROTOCOL, code: creative.s.code, tag: 'x'.repeat(43), name: 'Come in', host: 'Otto', players: 1, max: 4 },
        'not a room', null, { code: 5 }, { v: PROTOCOL, code: creative.s.code, tag: creative.s._tag, players: 99, max: 4 }, { v: PROTOCOL, code: creative.s.code, tag: creative.s._tag, players: 1, max: 4000 },
    ]) {
        await raw.presence.update(data);
        const got = await list(wes);
        if (got.some(r => r.name === 'Come in' || r.code === priv.s.code || r.code === 'AAAAAAAA' || r.players > r.max || r.max > 16)) { check('a host cannot list a room that is not its own public one', false, JSON.stringify(data)); break; }
    }
    check('a host cannot list a room that is not its own public one, nor nonsense', !(await list(wes)).some(r => r.code === priv.s.code));
    check('with its tag a public host renews its token with its place in the lobby; without, or with another\'s, it has none',
        (await (async () => { const c = [...hub.connections].find(x => x.clientId === pub.s._client); await c.renew(); return c._cap[LOBBY]?.join(); })()) === 'presence' &&
        (await failure(pub.s.auth.token(pub.s.code, 0, 'wrong-ticket', pub.s._tag)))?.reason === 'auth' &&
        (await service.respond({ method: 'POST', path: '/token', body: { code: pub.s.code, device: ann.store.v, slot: 0, tag: pub.s._tag }, ip: 'z' })).status === 403);

    // Gone.
    pub.s.close();
    await until(() => ann.closed === 'host');
    await settle();
    check('a public game that has ended is gone from the list', !(await list(wes)).some(r => r.code === pub.s.code));
    ably.down = true;
    check('when Ably cannot be asked, the list says it cannot be had (and nothing else breaks)', (await failure(list(wes)))?.reason === 'unreachable');
    ably.down = false;
    end();
}

// ── What it costs ─────────────────────────────────────────────────────────────
// Ably counts a message when it is published and again for each game it reaches.
// The free plan is six million a month: this is what a second of play spends.
{
    for (const players of [2, 4]) {
        const { hub, settle, game, names, end } = setup();
        const games = [game('P1')];
        await games[0].s.open(games[0].hello, WORLD);
        for (let i = 1; i < players; i++) { const g = game(`P${i + 1}`); await g.s.enter(games[0].s.code, g.hello); games.push(g); }
        await until(() => games.every(g => g.s.players.size === players - 1));
        await settle();
        hub.reset();
        const t0 = Date.now(), SECONDS = 2;
        // Everyone on the move, the host with mobs about, as world.js offers them: 15 and 10 times a second.
        while (Date.now() - t0 < SECONDS * 1000) {
            const t = Date.now() - t0;
            for (const [i, g] of games.entries()) g.s.state([t / 100 + i, 70, 0, 0, 0, 4, 1, 0, 0]);
            games[0].s.all({ t: 'mobs', list: [1, t, 2, 3] });
            games[0].s.atmos({ time: t });
            await sleep(33);
        }
        await settle();
        const perSecond = hub.messages / SECONDS, hours = 6_000_000 / (perSecond * 3600);
        const expected = players * players * (1000 / RATE.STATE) + players * (1000 / RATE.MOBS);
        check(`${players} players, all moving, with mobs: about ${Math.round(perSecond)} messages a second — the free plan's month is about ${Math.round(hours)} hours of it`,
            perSecond > expected * 0.5 && perSecond < expected * 1.15, `expected about ${Math.round(expected)}`);
        end();
    }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
await sleep(100);
process.exit(failures === 0 ? 0 : 1);
