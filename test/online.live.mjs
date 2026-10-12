// Online play against Ably itself: three games in one room, with a real key.
//
//   WW_ABLY_KEY=appId.keyId:secret node test/online.live.mjs        (npm run test:online:live)
//
// test/online.test.mjs asks the same questions of a stand-in. This is the
// check that Ably agrees with the stand-in: that it takes the token requests
// the token service signs, enforces what each token may do, says who sent
// what, and carries the game's messages (bytes included) as the game expects.
//
// It uses the key from the environment and writes it nowhere. It spends a few
// hundred messages of the account's allowance and takes about half a minute.
import Ably from 'ably';
import { createAuth } from '../online/auth.js';
import { OnlineSession, OnlineAuth } from '../src/scripts/engine/net/OnlineSession.js';
import { channels, ChunkStatus, PART_BYTES, RATE } from '../src/scripts/engine/net/OnlineProtocol.js';

const KEY = process.env.WW_ABLY_KEY;
if (!KEY) { console.error('Set WW_ABLY_KEY to an Ably API key (online/README.md). Nothing was run.'); process.exit(2); }

let failures = 0;
function check(name, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
    const t0 = Date.now();
    for (;;) {
        if (await fn()) return true;
        if (Date.now() - t0 > ms) { console.log(`      (timed out waiting for ${what})`); return false; }
        await sleep(50);
    }
}
const failure = (p) => p.then(() => null, (e) => e);

const service = createAuth({ key: KEY, ratePerMinute: 1000 });
const fetchFn = async (url, init) => service.handle(new Request(url, init), 'live-test');
const WORLD = { name: 'Live', seed: 1234, worldGen: 2, terrainStyle: 'smooth', gameMode: 'SURVIVAL', difficulty: 'NORMAL', daylightCycle: true, weather: 'dynamic', flat: null };
const sessions = [], spies = [];
function game(name) {
    const store = { v: null, get() { return this.v; }, set(v) { this.v = v; } };
    const s = new OnlineSession(Ably, new OnlineAuth({ url: 'https://token.invalid', fetchFn, storage: store }));
    const g = { s, name, store, hello: { version: '0.1.0', content: 'c'.repeat(28), worldGen: 2, name, skin: { hair: 1 }, slot: 0 }, world: new Map(), msgs: [], states: [], closed: null, down: [] };
    s.onBlock = (x, y, z, b) => g.world.set(`${x},${y},${z}`, b);
    s.onMsg = (from, d) => g.msgs.push([from, d]);
    s.onState = (id, st) => g.states.push([id, st]);
    s.onClosed = (reason) => { g.closed = reason; };
    s.onDown = (d) => g.down.push(d);
    s.blockAt = (x, y, z) => g.world.get(`${x},${y},${z}`) ?? 0;
    g.set = (x, y, z, b) => { const was = s.blockAt(x, y, z); g.world.set(`${x},${y},${z}`, b); s.block(x, y, z, b, was); };
    sessions.push(s);
    return g;
}
const names = (g) => [...g.s.players.values()].map(p => `${p.id}:${p.name}`).sort().join(' ');

try {
    const host = game('Hana'), gus = game('Gus'), ivy = game('Ivy');
    const t0 = Date.now();
    await host.s.open(host.hello, WORLD);
    check('Ably takes the token request the token service signs, and the host has a room', host.s.isHost && /^[A-Z2-9]{8}$/.test(host.s.code), `${Date.now() - t0} ms`);

    check('a code no game has is no game', (await failure(game('Mal').s.enter('AAAAAAAA', host.hello)))?.reason === 'code');

    const t1 = Date.now();
    const w = await gus.s.enter(host.s.code, gus.hello);
    check('a guest joins by the code and is welcomed by the host', w.id === 2 && names(gus) === '1:Hana' && JSON.stringify(gus.s.world) === JSON.stringify(WORLD), `${Date.now() - t1} ms`);
    await ivy.s.enter(host.s.code, ivy.hello);
    check('three games: everyone sees everyone',
        await until(() => names(host) === '2:Gus 3:Ivy' && names(gus) === '1:Hana 3:Ivy' && names(ivy) === '1:Hana 2:Gus', 8000, 'the rosters'),
        `${names(host)} | ${names(gus)} | ${names(ivy)}`);

    host.s.state([0, 70, 0, 0, 0, 0, 1, 0, 0]); gus.s.state([2, 70, 0, 0, 0, 0, 1, 0, 0]); ivy.s.state([4, 70, 0, 0, 0, 0, 1, 0, 0]);
    check('where each player is reaches the others, stamped with who sent it',
        await until(() => host.states.length >= 2 && gus.states.length >= 2 && ivy.states.length >= 2, 5000, 'states') &&
        ivy.states.some(s => s[0] === 1 && s[1][0] === 0) && ivy.states.some(s => s[0] === 2 && s[1][0] === 2));
    check('a game does not hear itself (and is not billed for it)', !gus.states.some(s => s[0] === 2));

    host.set(1, 70, 0, 27);
    gus.set(2, 71, 0, 25);
    check('blocks changed by the host and by a guest change for everyone',
        await until(() => [host, gus, ivy].every(g => g.world.get('1,70,0') === 27 && g.world.get('2,71,0') === 25), 5000, 'blocks'));
    gus.set(3, 70, 0, 11); ivy.set(3, 70, 0, 12);
    await sleep(1500);
    const ends = [host, gus, ivy].map(g => g.world.get('3,70,0'));
    check('two players at one block at once end up agreeing, as the host has it', new Set(ends).size === 1, ends.join());
    gus.set(500, 70, 500, 43);
    await sleep(1500);
    check('a block out of reach is not done on the host and is put back', [host, gus, ivy].every(g => (g.world.get('500,70,500') ?? 0) === 0));

    host.s.all({ t: 'mobs', list: [7, 1, 2, 3], info: { 7: { type: 'cow' } } });
    gus.s.host({ t: 'hit', id: 7, dmg: 3 });
    host.s.to(3, { t: 'attack', dmg: 2 });
    check("the host's mobs reach guests; a blow goes to the host alone; a mob's blow to one player alone",
        await until(() => gus.msgs.some(m => m[1].t === 'mobs') && ivy.msgs.some(m => m[1].t === 'mobs') && host.msgs.some(m => m[0] === 2 && m[1].t === 'hit') && ivy.msgs.some(m => m[1].t === 'attack'), 5000, 'messages') &&
        !ivy.msgs.some(m => m[1].t === 'hit') && !gus.msgs.some(m => m[1].t === 'attack'));

    // What Ably itself refuses a guest's token.
    const n = channels(host.s.code), raw = gus.s._rt;
    // (A second connection with the same guest's token, to try the channels its game has open another way.)
    const spyGrant = await gus.s.auth.token(host.s.code, 0);
    const spy = new Ably.Realtime({ authCallback: (_p, cb) => cb(null, spyGrant.tokenRequest), echoMessages: false });
    spies.push(spy);
    const tries = {
        'speak as the host': () => raw.channels.get(n.host + '', { modes: ['SUBSCRIBE'] }).publish('bye', {}),
        'write to another guest': () => raw.channels.get(n.to(ivy.s._client), { modes: ['PUBLISH'] }).publish('k', {}),
        'reach another room': () => raw.channels.get('ww:ZZZZZZZZ:all', { modes: ['PUBLISH'] }).publish('s', [0, 0, 0]),
        "read another guest's letters": () => spy.channels.get(n.to(ivy.s._client), { modes: ['SUBSCRIBE'] }).subscribe(() => {}),
        'read what guests send the host': () => spy.channels.get(n.up, { modes: ['SUBSCRIBE'] }).subscribe(() => {}),
        'leave the game\'s channels altogether': () => raw.channels.get('other:thing', { modes: ['PUBLISH'] }).publish('x', {}),
    };
    for (const [what, attempt] of Object.entries(tries)) {
        const e = await Promise.race([failure(attempt()), sleep(6000).then(() => ({ code: 'no answer' }))]);
        check(`Ably refuses a guest's token: ${what}`, e?.code === 40160, `code ${e?.code ?? 'none: it was allowed'}`);
    }
    await sleep(500);
    check('… and nobody was sent away by any of it', !ivy.closed && !host.closed && !gus.closed);

    // The host's world, in bytes, bigger than one message.
    const bytes = new Uint8Array(PART_BYTES + 5000).map((_, i) => (i * 31) & 255);
    const keys = Array.from({ length: 9000 }, (_, i) => `${i - 4500},${(i * 7) % 2001 - 1000}`);
    const places = new Map();
    host.s.serve.manifest = async () => ({ keys });
    host.s.serve.chunk = async ({ cx }) => cx === 1 ? { s: ChunkStatus.DATA, d: bytes } : { s: ChunkStatus.NONE };
    host.s.serve.pload = async ({ key }) => ({ state: places.get(key) ?? null });
    host.s.serve.psave = async ({ key, state }) => { places.set(key, state); return {}; };
    const got = await gus.s.manifest();
    check('the list of saved chunks arrives (thousands of keys, as bytes)', got?.size === keys.length && keys.every(k => got.has(k)));
    const big = await gus.s.chunk(1, 0);
    check('a chunk bigger than one message arrives whole, byte for byte', big?.s === ChunkStatus.DATA && big.d?.length === bytes.length && big.d.every((v, i) => v === bytes[i]), `${big?.d?.length ?? 0} bytes`);
    check('a chunk the host has nothing for says so', (await gus.s.chunk(5, 5))?.s === ChunkStatus.NONE);
    gus.s.saveState({ pos: [1, 2, 3] });
    check("a guest's place is kept by the host under who Ably says they are",
        await until(() => places.has(gus.s._client), 5000, 'the save') && JSON.stringify(await gus.s.loadState()) === JSON.stringify({ pos: [1, 2, 3] }));

    ivy.s.profile('Ivy Two', { hair: 3 });
    check('a changed name reaches everyone', await until(() => names(gus) === '1:Hana 3:Ivy Two' && host.s.players.get(3)?.skin.hair === 3, 5000, 'the name'));

    host.s.kick(2);
    check('a player the host removes is told and is gone for everyone',
        await until(() => gus.closed === 'kicked' && names(host) === '3:Ivy Two' && names(ivy) === '1:Hana', 8000, 'the removal'), `${gus.closed} | ${names(host)} | ${names(ivy)}`);
    const back = game('Gus'); back.store.v = gus.store.v;
    check('… and is not let back in', (await failure(back.s.enter(host.s.code, back.hello)))?.reason === 'kicked');

    host.s.close();
    check('when the host closes the game its guest is told at once', await until(() => ivy.closed === 'host', 8000, 'the goodbye'), String(ivy.closed));
    await sleep(1500);
    check('… and the code is no game any more', (await failure(game('Kay').s.enter(host.s.code, host.hello)))?.reason === 'code');
} catch (e) {
    check('the run finished', false, e?.stack ?? String(e));
}

for (const s of sessions) s.close();
for (const s of spies) s.close();
console.log(failures === 0 ? '\nALL PASS — against Ably itself' : `\n${failures} FAILURE(S)`);
await sleep(2000);
process.exit(failures === 0 ? 0 : 1);
