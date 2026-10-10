// The game's own side of the line (src/scripts/engine/net/), run against the
// server as it is: the desktop game and the browser game in one world, several
// players of one machine, the host's world reaching a guest, a line dropping.
import assert from 'node:assert';
import * as sdk from '@colyseus/sdk';
import { reset, post, until, sleep, gameModule, URL, WORLD, CONTENT } from './setup.js';
import { config } from '../src/config.js';
import { steam } from '../src/auth/steam.js';
import { registry } from '../src/registry.js';
import { PROTOCOL } from '../src/protocol.js';

// The game's modules, loaded before the first test. (Not with a top-level await: that would make this
// file a module of another kind from the rest, with a server of its own.)
let codec: any, proto: any, ChunkData: any, CHUNK_VOLUME: number, voxelIndex: (x: number, y: number, z: number) => number;
let OnlineSession: any, OnlineAccount: any, OnlineWorldClient: any, OnlineError: any;
before(async () => {
    ({ OnlineSession, OnlineAccount, OnlineWorldClient, OnlineError } = await gameModule('src/scripts/engine/net/OnlineSession.js'));
    codec = await gameModule('src/scripts/engine/net/ChunkCodec.js');
    proto = await gameModule('src/scripts/engine/net/OnlineProtocol.js');
    ({ ChunkData, CHUNK_VOLUME, voxelIndex } = await gameModule('src/scripts/engine/ChunkData.js'));
});

const HELLO = (name: string, over: Record<string, unknown> = {}) => ({ version: '0.1.0', content: CONTENT, worldGen: 2, name, skin: { hair: 1 }, slot: 0, ...over });

/** A game signed in the way the desktop edition is (the tests' stand-in for a Steam ticket that checks out). */
const desktop = (name: string) => new OnlineAccount({ url: URL, signIn: async () => (await post('/auth/dev', { name, edition: 'full' })).data });
/** A game signed in the way the browser edition is: a guest, whose credential it keeps. */
function browser() {
    let kept: string | null = null;
    const account = new OnlineAccount({ url: URL, storage: { get: () => kept, set: (v: string) => { kept = v; } } });
    return { account, credential: () => kept };
}

/** A game's world, as far as these tests need one: what block is where. */
function game(account: any) {
    const s = new OnlineSession(sdk, account);
    const blocks = new Map<string, number>(), log: any[] = [];
    s.onBlock = (x: number, y: number, z: number, b: number) => { blocks.set(`${x},${y},${z}`, b); log.push(['block', x, y, z, b]); };
    s.onBlockRejected = (x: number, y: number, z: number, was: number, why: string) => { blocks.set(`${x},${y},${z}`, was); log.push(['rejected', x, y, z, was, why]); };
    s.onJoined = (p: any) => log.push(['joined', p.id, p.name]);
    s.onLeft = (id: number) => log.push(['left', id]);
    s.onProfile = (p: any) => log.push(['profile', p.id, p.name]);
    s.onState = (id: number, st: number[]) => log.push(['state', id, st[0]]);
    s.onAtmos = (a: any) => log.push(['atmos', a]);
    s.onMsg = (from: number, d: any) => log.push(['msg', from, d]);
    s.onClosed = (reason: string) => log.push(['closed', reason]);
    s.onDown = (down: boolean) => log.push(['down', down]);
    /** Change a block as the game does: here first, then told to the room. */
    const set = (x: number, y: number, z: number, b: number) => {
        const key = `${x},${y},${z}`, was = blocks.get(key) ?? 0;
        blocks.set(key, b);
        s.block(x, y, z, b, was);
    };
    return { s, blocks, log, set, at: (x: number, y: number, z: number) => s.state([x, y, z, 0, 0, 0, 1, 0, 0]) };
}

const sessions: any[] = [];
function play(account: any) { const g = game(account); sessions.push(g.s); return g; }

describe('the game\'s own line to the server', () => {
    beforeEach(async () => {
        for (const s of sessions.splice(0)) s.close();
        await reset();
    });

    it('the desktop game hosts; the browser game joins by the code; each knows the other', async () => {
        const h = play(desktop('hana')), b = browser(), g = play(b.account);
        const welcome = await h.s.open(HELLO('Hana'), WORLD);
        assert.deepStrictEqual([welcome.id, welcome.hostId, welcome.players, welcome.edits], [1, 1, [], []]);
        assert.ok(h.s.isHost && h.s.alone && h.s.edition === 'full');
        assert.match(proto.showCode(h.s.code), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

        h.at(4, 70, 4);
        await sleep(30);
        // As a player types it: lower case, with the dash.
        const joined = await g.s.enter(proto.showCode(h.s.code).toLowerCase(), HELLO('Gus'));
        assert.strictEqual(joined.hostId, 1);
        assert.deepStrictEqual(joined.players.map((p: any) => [p.id, p.name, p.skin]), [[1, 'Hana', { hair: 1 }]]);
        assert.deepStrictEqual(joined.players[0].state.slice(0, 3), [4, 70, 4], 'and where the host is, to start beside them');
        assert.deepStrictEqual(g.s.world, WORLD, 'the world to make');
        assert.strictEqual(g.s.edition, 'free');
        assert.ok(!g.s.isHost && !g.s.alone);
        assert.ok(b.credential(), 'the browser game keeps its credential');
        assert.deepStrictEqual(await g.s.join(), joined, 'join() is the welcome, as world.js asks for it');

        await until(() => h.log.some(l => l[0] === 'joined'));
        assert.deepStrictEqual(h.log.find(l => l[0] === 'joined'), ['joined', 2, 'Gus']);
        assert.ok(!h.s.alone);
    });

    it('what each does reaches the other, in the shapes world.js has always been handed', async () => {
        const h = play(desktop('hana')), g = play(browser().account);
        await h.s.open(HELLO('Hana'), WORLD);
        await g.s.enter(h.s.code, HELLO('Gus'));
        await until(() => !h.s.alone);

        h.at(1, 70, 1); g.at(2, 70, 2);
        await until(() => h.log.some(l => l[0] === 'state') && g.log.some(l => l[0] === 'state'));
        assert.deepStrictEqual(h.log.find(l => l[0] === 'state'), ['state', 2, 2]);
        assert.deepStrictEqual(g.log.find(l => l[0] === 'state'), ['state', 1, 1]);
        assert.deepStrictEqual(g.s.players.get(1).state.slice(0, 3), [1, 70, 1]);

        h.s.atmos({ day: { time: 0.3, day: 2 }, running: true });
        h.s.all({ t: 'mobs', list: [7, 2, 3, 70, 3, 0, 1, 0, 0, 0, 0], info: { 7: { coat: 2 } } });
        await until(() => g.log.some(l => l[0] === 'msg'));
        assert.deepStrictEqual(g.log.find(l => l[0] === 'atmos')[1].day, { time: 0.3, day: 2 });
        assert.deepStrictEqual(g.log.find(l => l[0] === 'msg'), ['msg', 1, { t: 'mobs', list: [7, 2, 3, 70, 3, 0, 1, 0, 0, 0, 0], info: { 7: { coat: 2 } } }]);

        g.s.host({ t: 'hit', id: 7, dmg: 3 });
        await until(() => h.log.some(l => l[0] === 'msg'));
        assert.deepStrictEqual(h.log.find(l => l[0] === 'msg'), ['msg', 2, { t: 'hit', id: 7, dmg: 3 }]);
        h.s.to(2, { t: 'attack', dmg: 2 });
        h.s.to(2, { t: 'drops', pos: { x: 3, y: 70, z: 3 }, items: [['raw_beef', 1]] });
        await until(() => g.log.filter(l => l[0] === 'msg').length === 3);
        assert.deepStrictEqual(g.log.filter(l => l[0] === 'msg').slice(1).map(l => l[2].t), ['attack', 'drops']);

        g.s.profile('Gustav', { hair: 4 });
        await until(() => h.log.some(l => l[0] === 'profile'));
        assert.deepStrictEqual([h.s.players.get(2).name, h.s.players.get(2).skin], ['Gustav', { hair: 4 }]);
    });

    it('what only the host may say, a guest\'s game does not even send', async () => {
        const h = play(desktop('hana')), g = play(browser().account);
        await h.s.open(HELLO('Hana'), WORLD);
        await g.s.enter(h.s.code, HELLO('Gus'));
        g.s.atmos({ day: { time: 0.9 } });
        g.s.all({ t: 'mobs', list: [] });
        g.s.to(1, { t: 'attack', dmg: 50 });
        g.s.kick(1);
        h.s.host({ t: 'hit', id: 1, dmg: 1 });
        g.s.all({ t: 'something else' });
        await sleep(200);
        assert.ok(!h.log.some(l => l[0] === 'atmos' || l[0] === 'msg'));
        assert.ok(g.s.connected && h.s.connected);
    });

    it('two players changing one block at once end with the same block', async () => {
        const h = play(desktop('hana')), g = play(desktop('gus'));
        await h.s.open(HELLO('Hana'), WORLD);
        await g.s.enter(h.s.code, HELLO('Gus'));
        h.at(0, 70, 0); g.at(0, 70, 0);
        await sleep(60);
        for (let round = 0; round < 12; round++) {
            // Each has put its own block down before it hears of the other's.
            h.set(1, 70, round, 3);
            g.set(1, 70, round, 4);
        }
        await until(() => h.s._own.size === 0 && g.s._own.size === 0, 3000, 'every change to come round');
        await sleep(80);
        for (let round = 0; round < 12; round++) {
            const key = `1,70,${round}`;
            assert.strictEqual(h.blocks.get(key), g.blocks.get(key), `block ${key}: host ${h.blocks.get(key)}, guest ${g.blocks.get(key)}`);
            assert.ok([3, 4].includes(h.blocks.get(key)!));
        }
        // A change nobody contested is not laid down twice.
        const before = h.log.length;
        h.set(5, 70, 5, 3);
        await until(() => h.s._own.size === 0);
        assert.strictEqual(h.log.length, before, 'the echo of an uncontested change is not handed up again');
        await until(() => g.blocks.get('5,70,5') === 3);
    });

    it('a change the server refuses is put back as it was', async () => {
        const h = play(desktop('hana')), g = play(browser().account);
        await h.s.open(HELLO('Hana'), WORLD);
        await g.s.enter(h.s.code, HELLO('Gus'));
        g.at(0, 70, 0);
        await sleep(40);
        g.blocks.set('300,70,0', 7);
        g.set(300, 70, 0, 3);                                            // far out of reach
        await until(() => g.log.some(l => l[0] === 'rejected'));
        assert.deepStrictEqual(g.log.find(l => l[0] === 'rejected'), ['rejected', 300, 70, 0, 7, 'reach']);
        assert.strictEqual(g.blocks.get('300,70,0'), 7);
        assert.ok(!h.blocks.has('300,70,0'), 'and the host never had it');
    });

    it('the browser game cannot host; a game that is too old, or has other blocks, is told why', async () => {
        const g = play(browser().account);
        await assert.rejects(g.s.open(HELLO('Gus'), WORLD), (e: any) => e instanceof OnlineError && e.reason === 'edition');

        const h = play(desktop('hana'));
        await h.s.open(HELLO('Hana'), WORLD);
        const reason = async (hello: object, code = h.s.code) => {
            const s = play(browser().account).s;
            try { await s.enter(code, hello); return 'joined'; } catch (e: any) { return e.reason; }
        };
        assert.strictEqual(await reason(HELLO('Old', { content: 'f'.repeat(28) })), 'content');
        assert.strictEqual(await reason(HELLO('Old', { worldGen: 1 })), 'update', 'cannot generate this world');
        assert.strictEqual(await reason(HELLO('Gus'), 'AAAA-AAAA'), 'code');
        assert.strictEqual(await reason(HELLO('Gus'), 'not a code'), 'code');
        config.minGameVersion = '0.2.0';
        assert.strictEqual(await reason(HELLO('Old')), 'update');
        config.minGameVersion = '';
        assert.strictEqual(await reason(HELLO('Gus')), 'joined');
    });

    it('a game speaking a protocol the server does not is turned away at the door, before any room', async () => {
        const h = play(desktop('hana'));
        await h.s.open(HELLO('Hana'), WORLD);
        const s = await desktop('zed').session();
        for (const protocol of [PROTOCOL + 1, 0]) {
            const c = new sdk.Client(URL);
            c.auth.token = s.token;
            const e: any = await c.create('world', { protocol, ...HELLO('Zed'), world: WORLD, maxPlayers: 4 }).then(() => null, (x) => x);
            assert.strictEqual(e?.code, proto.Reject.PROTOCOL, `protocol ${protocol}`);
        }
        assert.strictEqual(registry.rooms.size, 1);
    });

    it('a server that does not know a game\'s blocks takes its rooms only where it is told to', async () => {
        const modded = HELLO('Mod', { content: 'a'.repeat(28) });
        config.allowUnknownContent = false;
        await assert.rejects(play(desktop('mod')).s.open(modded, WORLD), (e: any) => e.reason === 'content');
        config.allowUnknownContent = true;
        const h = play(desktop('mod'));
        await h.s.open(modded, WORLD);
        const g = play(desktop('gus'));
        await g.s.enter(h.s.code, modded);
        g.at(0, 70, 0);
        await sleep(40);
        g.set(1, 70, 0, 9000);                                           // a pack's block: in range, so let through
        await until(() => h.blocks.get('1,70,0') === 9000);
    });
});

describe('a Steam ticket, from the game to an edition', () => {
    beforeEach(async () => {
        for (const s of sessions.splice(0)) s.close();
        await reset();
        config.steamAppId = '480'; config.steamWebApiKey = 'k'.repeat(32);
    });
    afterEach(() => { steam.fetchImpl = (url, init) => fetch(url, init); });

    function steamSays(owns: boolean) {
        steam.fetchImpl = async (url) => ({
            ok: true, status: 200,
            json: async () => url.includes('AuthenticateUserTicket')
                ? { response: { params: { result: 'OK', steamid: '76561198000000042', ownersteamid: '76561198000000042', vacbanned: false, publisherbanned: false } } }
                : { appownership: { ownsapp: owns, result: 'OK' } },
        });
    }

    it('the desktop game with a ticket that checks out is the full edition, and hosts', async () => {
        steamSays(true);
        const account = new OnlineAccount({ url: URL, steamTicket: async () => 'ab'.repeat(100) });
        assert.deepStrictEqual((({ account: a, edition }) => ({ a, edition }))(await account.session()), { a: 'steam:76561198000000042', edition: 'full' });
        const h = play(account);
        await h.s.open(HELLO('Hana'), WORLD);
        assert.strictEqual(h.s.edition, 'full');
    });

    it('a desktop game Steam will not vouch for still plays, as a guest', async () => {
        steamSays(true);
        let kept: string | null = null;
        const account = new OnlineAccount({ url: URL, steamTicket: async () => null, storage: { get: () => kept, set: (v: string) => { kept = v; } } });
        const s = await account.session();
        assert.ok(s.account.startsWith('guest:') && s.edition === 'free');
        // … and a ticket Steam turns down ends the same way, not in an error.
        steam.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ response: { error: { errorcode: 101 } } }) });
        const refused = new OnlineAccount({ url: URL, steamTicket: async () => 'ab'.repeat(100), storage: { get: () => null, set: () => {} } });
        assert.strictEqual((await refused.session()).edition, 'free');
    });

    it('a session is asked for once and kept until it is nearly out', async () => {
        let asked = 0;
        const account = new OnlineAccount({ url: URL, signIn: async () => { asked++; return (await post('/auth/dev', { name: 'hana', edition: 'full' })).data; } });
        const [a, b] = await Promise.all([account.session(), account.session()]);
        assert.strictEqual(a.token, b.token);
        await account.session();
        assert.strictEqual(asked, 1);
        account._session.until = Date.now() - 1;
        await account.session();
        assert.strictEqual(asked, 2);
    });

    it('a server that cannot be reached is an error the game can show, not a crash', async () => {
        const account = new OnlineAccount({ url: 'http://127.0.0.1:9', storage: { get: () => null, set: () => {} } });
        await assert.rejects(account.session(), (e: any) => e instanceof OnlineError && e.reason === 'unreachable');
        await assert.rejects(new OnlineSession(sdk, account).open(HELLO('Hana'), WORLD), (e: any) => e.reason === 'unreachable');
    });
});

describe('several players of one machine', () => {
    beforeEach(async () => {
        for (const s of sessions.splice(0)) s.close();
        await reset();
    });

    it('each pane of a split screen is its own player, on the one account', async () => {
        const account = desktop('hana');
        const one = play(account), two = play(account), three = play(account);
        await one.s.open(HELLO('Hana', { slot: 0 }), WORLD);
        await two.s.enter(one.s.code, HELLO('Ben', { slot: 1 }));
        await three.s.enter(one.s.code, HELLO('Cy', { slot: 2 }));
        assert.deepStrictEqual([one.s.id, two.s.id, three.s.id], [1, 2, 3]);
        assert.deepStrictEqual([one.s.isHost, two.s.isHost, three.s.isHost], [true, false, false]);
        await until(() => one.s.players.size === 2 && two.s.players.size === 2);
        assert.deepStrictEqual([...three.s.players.values()].map((p: any) => p.name).sort(), ['Ben', 'Hana']);

        // A guest's machine with two players of its own, in the same world.
        const theirs = desktop('gus');
        const g1 = play(theirs), g2 = play(theirs);
        await g1.s.enter(one.s.code, HELLO('Gus', { slot: 0 }));
        await g2.s.enter(one.s.code, HELLO('Gil', { slot: 1 }));
        assert.deepStrictEqual([g1.s.id, g2.s.id], [4, 5]);
        // A state is passed on only for a player the game has been told of, and the roster comes by
        // another road (the room's state) than the states do: sent once, at once, it can get there first.
        await until(() => one.s.players.has(5));
        g2.at(9, 70, 9);
        await until(() => one.log.some(l => l[0] === 'state' && l[1] === 5));
        assert.strictEqual(registry.roomsOf('dev:gus'), 1);
    });

    it('a pane leaving leaves the others playing', async () => {
        const account = desktop('hana');
        const one = play(account), two = play(account);
        await one.s.open(HELLO('Hana'), WORLD);
        await two.s.enter(one.s.code, HELLO('Ben', { slot: 1 }));
        await until(() => one.s.players.size === 1);
        two.s.close();
        await until(() => one.log.some(l => l[0] === 'left'));
        assert.deepStrictEqual(one.log.find(l => l[0] === 'left'), ['left', 2]);
        assert.ok(one.s.connected && one.s.alone);
        assert.ok(!two.log.some(l => l[0] === 'closed'), 'a pane that left is not told the game ended');
    });
});

describe('the host\'s world reaching a guest', () => {
    beforeEach(async () => {
        for (const s of sessions.splice(0)) s.close();
        await reset();
    });

    /** A column with a house on it: enough different blocks to tell if any moved. */
    function builtChunk(cx: number, cz: number) {
        const c = new ChunkData(cx, cz);
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
            for (let y = 0; y < 190; y++) c.setVoxel(x, y, z, y < 3 ? 19 : y < 180 ? 3 : 2);
            c.setVoxel(x, 190, z, 1);
        }
        for (let y = 191; y < 196; y++) { c.setVoxel(4, y, 4, 25); c.setVoxel(4, y, 9, 28); c.setVoxel(9, y, 4, 43); }
        c.generated = true;
        return c;
    }

    it('a chunk survives the journey whole: host, server, guest', async () => {
        const h = play(desktop('hana')), g = play(browser().account);
        await h.s.open(HELLO('Hana'), WORLD);
        const chunk = builtChunk(3, -2);
        const pending = new Map([[voxelIndex(1, 200, 1), 36], [voxelIndex(2, 200, 2), 41]]);
        h.s.serve.manifest = async () => ({ keys: ['3,-2', '8,8'] });
        h.s.serve.chunk = async ({ cx, cz }: any) =>
            cx === 3 && cz === -2 ? { s: proto.ChunkStatus.DATA, d: await codec.packChunk(chunk) }
            : cx === 8 && cz === 8 ? { s: proto.ChunkStatus.EDITS, d: codec.packEdits(pending) }
            : { s: proto.ChunkStatus.NONE };
        await g.s.enter(h.s.code, HELLO('Gus'));

        const world = { pendingChanges: new Map<string, Map<number, number>>() };
        const client = new OnlineWorldClient(g.s, codec, world);
        await client.fetchManifest();
        assert.deepStrictEqual([...client.savedKeys].sort(), ['3,-2', '8,8']);
        assert.ok(client.connected);

        const saved = await client.loadChunk('online', 3, -2);
        const copy = ChunkData.deserialize(3, -2, saved);
        let differ = 0;
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y < 448; y += (y > 170 && y < 200 ? 1 : 17)) {
            if (copy.getVoxel(x, y, z) !== chunk.getVoxel(x, y, z)) differ++;
        }
        assert.strictEqual(differ, 0);
        assert.strictEqual(copy.getVoxel(9, 193, 4), 43, 'the lamp is where it was put');

        // A chunk the host has only changes for: nothing to load, and the changes waiting for it.
        world.pendingChanges.set('8,8', new Map([[voxelIndex(1, 200, 1), 0]]));       // heard since, and newer
        assert.strictEqual(await client.loadChunk('online', 8, 8), null);
        assert.deepStrictEqual([...world.pendingChanges.get('8,8')!].sort(), [[voxelIndex(1, 200, 1), 0], [voxelIndex(2, 200, 2), 41]].sort());

        // A chunk the host has nothing for is not asked about at all.
        let asked = 0;
        const serveChunk = h.s.serve.chunk;
        h.s.serve.chunk = async (m: any) => { asked++; return serveChunk(m); };
        assert.strictEqual(await client.loadChunk('online', 100, 100), null);
        assert.strictEqual(asked, 0);
    });

    it('a packed chunk is a few kilobytes, and what is not a chunk unpacks to nothing', async () => {
        const packed = await codec.packChunk(builtChunk(0, 0));
        assert.ok(packed.length < 6000, `${packed.length} bytes of ${CHUNK_VOLUME}`);
        assert.ok(packed.length < config.maxChunkBytes);
        assert.strictEqual(await codec.unpackChunk(new Uint8Array([1, 2, 3, 4])), null, 'not gzip');
        assert.strictEqual(await codec.unpackChunk(packed.subarray(0, packed.length - 20)), null, 'cut short');
        // gzip of a megabyte of zeros: small to send, and not unpacked past the size of a chunk.
        const bomb = new Uint8Array(await new Response(new Blob([new Uint8Array(4 * 1024 * 1024)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        assert.ok(bomb.length < 8000);
        assert.strictEqual(await codec.unpackChunk(bomb), null);
        // The right size, naming a block the palette does not have.
        const raw = new Uint8Array(2 + 2 + CHUNK_VOLUME);
        new DataView(raw.buffer).setUint16(0, 1, true);
        raw[4 + 77] = 9;
        const forged = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        assert.strictEqual(await codec.unpackChunk(forged), null);
        assert.deepStrictEqual(codec.unpackEdits(new Uint8Array([1, 0, 0, 0, 5, 0, 255, 255, 255, 255, 5, 0, 9])), [[1, 5]], 'an edit outside a chunk is dropped');
    });

    it('a guest\'s place in the world is kept by the host, and found again next time', async () => {
        const h = play(desktop('hana')), b = browser(), g = play(b.account);
        await h.s.open(HELLO('Hana'), WORLD);
        const disk = new Map<string, unknown>();
        h.s.serve.psave = async ({ key, state }: any) => { disk.set(key, state); return {}; };
        h.s.serve.pload = async ({ key }: any) => ({ state: disk.get(key) ?? null });
        await g.s.enter(h.s.code, HELLO('Gus'));
        assert.strictEqual(await g.s.loadState(), null, 'new here');
        g.s.saveState({ position: { x: 5, y: 70, z: 5 }, health: 64, inventory: { slots: [] } });
        await until(() => disk.size === 1);
        g.s.close();

        // Another day: the same browser (its credential), the same name.
        const again = play(b.account);
        await again.s.enter(h.s.code, HELLO('Gus'));
        assert.deepStrictEqual(await again.s.loadState(), { position: { x: 5, y: 70, z: 5 }, health: 64, inventory: { slots: [] } });
        // Another browser calling itself Gus is somebody else.
        const other = play(browser().account);
        await other.s.enter(h.s.code, HELLO('Gus'));
        assert.strictEqual(await other.s.loadState(), null);
    });
});

describe('the line dropping, as the game sees it', () => {
    beforeEach(async () => {
        for (const s of sessions.splice(0)) s.close();
        await reset();
    });

    it('a guest whose line drops catches up on what was built, and what it built meanwhile is not lost', async () => {
        const h = play(desktop('hana')), g = play(desktop('gus'));
        await h.s.open(HELLO('Hana'), WORLD);
        await g.s.enter(h.s.code, HELLO('Gus'));
        h.at(0, 70, 0); g.at(0, 70, 0);
        await sleep(60);
        h.set(1, 70, 0, 3);
        await until(() => g.blocks.get('1,70,0') === 3);

        g.s.room.reconnection.minUptime = 0;
        g.s.room.leave(false);
        await until(() => g.s.down, 2000, 'the game to notice');
        assert.ok(!g.s.connected);
        h.set(2, 70, 0, 4);
        h.set(1, 70, 0, 0);
        g.set(0, 71, 0, 25);                                             // built while cut off
        await until(() => !g.s.down, 5000, 'the line to be picked up');
        assert.deepStrictEqual(g.log.filter(l => l[0] === 'down').map(l => l[1]), [true, false]);
        assert.deepStrictEqual([g.blocks.get('2,70,0'), g.blocks.get('1,70,0')], [4, 0], 'what the host built and broke');
        await until(() => h.blocks.get('0,71,0') === 25, 2000, 'what the guest built to arrive');
        assert.ok(!g.log.some(l => l[0] === 'closed'));
        assert.ok(g.s.connected);
    });

    it('why the game ended is what the player is told', async () => {
        config.hostGraceSec = 0;
        const h = play(desktop('hana')), g = play(browser().account), k = play(desktop('kay'));
        await h.s.open(HELLO('Hana'), WORLD);
        await g.s.enter(h.s.code, HELLO('Gus'));
        await k.s.enter(h.s.code, HELLO('Kay'));
        await until(() => h.s.players.size === 2);
        h.s.kick(k.s.id);
        await until(() => k.log.some(l => l[0] === 'closed'));
        assert.deepStrictEqual(k.log.find(l => l[0] === 'closed'), ['closed', 'kicked']);
        await assert.rejects(play(desktop('kay')).s.enter(h.s.code, HELLO('Kay')), (e: any) => e.reason === 'kicked');

        h.s.close();
        await until(() => g.log.some(l => l[0] === 'closed'));
        assert.deepStrictEqual(g.log.find(l => l[0] === 'closed'), ['closed', 'host']);
        assert.ok(!h.log.some(l => l[0] === 'closed'), 'whoever left is not told so');
        assert.strictEqual(g.s.id, 0);
    });

    it('the host can shut the door, and open it again', async () => {
        const h = play(desktop('hana'));
        await h.s.open(HELLO('Hana'), WORLD);
        h.s.lock(true);
        await sleep(150);
        await assert.rejects(play(browser().account).s.enter(h.s.code, HELLO('Gus')), (e: any) => e.reason === 'code');
        h.s.lock(false);
        await sleep(150);
        const g = play(browser().account);
        await g.s.enter(h.s.code, HELLO('Gus'));
        assert.strictEqual(g.s.id, 2);
    });
});
