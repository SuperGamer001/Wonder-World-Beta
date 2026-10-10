// Lines that drop, players who do not come back, a host that goes, a server
// that is told to stop: what becomes of everyone else each time.
import assert from 'node:assert';
import { matchMaker } from 'colyseus';
import { reset, host, join, player, hello, resolve, failure, roster, serve, until, sleep, at, WORLD, URL } from './setup.js';
import { C2S, S2C, Reject, Close, ChunkStatus } from '../src/protocol.js';
import { config } from '../src/config.js';
import { metrics } from '../src/log.js';
import { registry } from '../src/registry.js';

/** Cut a client's line without a goodbye, as a network does. The SDK picks it up again by itself. */
function drop(seen: { room: any }, retry = true) {
    seen.room.reconnection.minUptime = 0;
    seen.room.reconnection.enabled = retry;
    seen.room.leave(false);
}
const back = (seen: { room: any }) => new Promise<void>(res => seen.room.onReconnect(() => res()));

describe('a line that drops', () => {
    beforeEach(reset);

    it('a guest\'s place is held; they are shown as away, and are back as themselves', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        await until(() => roster(h).length === 2);
        const returned = back(g);
        drop(g);
        await until(() => roster(h).find(p => p.id === 2)?.connected === false, 2000, 'the others to be told they are away');
        assert.strictEqual(roster(h).length, 2, 'their place is kept');
        await returned;
        await until(() => roster(h).find(p => p.id === 2)?.connected === true);
        g.room.send(C2S.STATE, at(1, 70, 1));
        const states = await h.next(S2C.STATES);
        assert.strictEqual(states[0], 2, 'the same player, by the same number');
        assert.strictEqual(metrics.get('reconnects'), 1);
    });

    it('what was changed while they were away is theirs for the asking, in order', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(40);
        h.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 3 });
        assert.strictEqual((await g.next(S2C.BLOCK)).seq, 1);

        const returned = back(g);
        drop(g);
        await until(() => roster(h).find(p => p.id === 2)?.connected === false);
        h.room.send(C2S.BLOCK, { x: 2, y: 70, z: 0, b: 4 });
        h.room.send(C2S.BLOCK, { x: 2, y: 70, z: 0, b: 0 });
        h.room.send(C2S.BLOCK, { x: 3, y: 71, z: 0, b: 2 });
        await returned;
        assert.deepStrictEqual(await g.room.request(C2S.SYNC, { since: 1 }), { list: [2, 70, 0, 4, 2, 70, 0, 0, 3, 71, 0, 2], seq: 4 });
        assert.deepStrictEqual(await g.room.request(C2S.SYNC, { since: 4 }), { list: [], seq: 4 }, 'nothing missed, nothing sent');
        assert.deepStrictEqual(await g.room.request(C2S.SYNC, { since: 99 }), { list: [], seq: 4 });
    });

    it('if more went by than the room remembers, they are told so rather than handed part of it', async () => {
        config.recentEdits = 64;
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(40);
        for (let k = 0; k < 50; k++) h.room.send(C2S.BLOCK, { x: k % 4, y: 70, z: 0, b: 3 });
        await until(() => g.got.filter(m => m.type === S2C.BLOCK).length === 50);
        assert.strictEqual((await g.room.request(C2S.SYNC, { since: 0 }) as any).list.length, 200);
        await sleep(1300);                                              // the host's rate refills
        for (let k = 0; k < 30; k++) h.room.send(C2S.BLOCK, { x: k % 4, y: 71, z: 0, b: 3 });
        await until(() => g.got.filter(m => m.type === S2C.BLOCK).length === 80);
        assert.deepStrictEqual(await g.room.request(C2S.SYNC, { since: 0 }), { gap: true, seq: 80 });
        assert.strictEqual((await g.room.request(C2S.SYNC, { since: 30 }) as any).list.length, 200, 'what it does remember, it hands over whole');
    });

    it('a guest who does not come back is let go, and the game goes on', async () => {
        config.guestGraceSec = 1;
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        await until(() => roster(h).length === 3);
        drop(g, false);
        await until(() => roster(h).length === 2, 4000, 'their place to be given up');
        assert.ok(h.room.connection.isOpen && i.room.connection.isOpen);
        assert.strictEqual(registry.players(), 2);
        assert.ok(await i.none(S2C.CLOSED, 50));
    });

    it('a guest who leaves on purpose has no place held', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        await until(() => roster(h).length === 2);
        await g.room.leave();
        await until(() => roster(h).length === 1, 1000);
        assert.strictEqual(metrics.get('drops'), 0);
    });
});

describe('a host that goes', () => {
    beforeEach(reset);

    it('whose line drops is waited for: the room stays, and its guests are told to ask again meanwhile', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        serve(h, { chunk: () => ({ s: ChunkStatus.DATA, d: new Uint8Array([1]) }) });
        await until(() => roster(g).length === 2);
        const returned = back(h);
        h.room.reconnection.delay = 600; h.room.reconnection.minDelay = 600;
        drop(h);
        await until(() => roster(g).find(p => p.host)?.connected === false, 2000, 'the guests to see the host is away');
        assert.deepStrictEqual(await g.room.request(C2S.CHUNK, { cx: 0, cz: 0 }), { s: ChunkStatus.RETRY });
        assert.ok(await g.none(S2C.CLOSED, 50), 'the game is not over');
        await returned;
        await until(() => roster(g).find(p => p.host)?.connected === true);
        assert.strictEqual((await g.room.request(C2S.CHUNK, { cx: 0, cz: 0 }) as any).s, ChunkStatus.DATA);
        // Still the host: what only the host may say is still theirs to say.
        h.room.send(C2S.ATMOS, { a: { day: { time: 0.1 } } });
        assert.strictEqual((await g.next(S2C.ATMOS)).a.day.time, 0.1);
    });

    it('and does not come back takes the room with it: the world was on their machine', async () => {
        config.hostGraceSec = 1;
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        drop(h, false);
        assert.deepStrictEqual(await g.next(S2C.CLOSED, 4000), { reason: 'host' });
        assert.strictEqual(await g.left, Close.HOST_LEFT);
        assert.strictEqual(await i.left, Close.HOST_LEFT);
        await until(() => registry.rooms.size === 0 && registry.players() === 0, 3000);
    });

    it('nobody is made host in their place', async () => {
        config.hostGraceSec = 1;
        const h = await host();
        const g = await join(h.welcome.code);
        drop(h, false);
        await until(() => roster(g).find(p => p.host)?.connected === false);
        g.room.send(C2S.ATMOS, { a: { day: { time: 0.9 } } });
        g.room.send(C2S.MOBS, { list: [] });
        g.room.send(C2S.KICK, { id: 1 });
        await g.left;
        assert.ok(!g.got.some(m => m.type === S2C.ATMOS));
        assert.strictEqual(metrics.get('violation_role'), 3);
    });

    it('a room nobody came to, or everybody left, is not kept', async () => {
        const h = await host();
        const code = h.welcome.code;
        await h.room.leave();
        await until(() => registry.rooms.size === 0, 3000);
        assert.strictEqual((await failure(join(code, 'gus')))?.status, 404);
        assert.strictEqual(metrics.get('rooms_disposed'), 1);
    });

    it('a place that was given up cannot be taken back with an old reconnection token', async () => {
        config.guestGraceSec = 1;
        const h = await host();
        const g = await join(h.welcome.code);
        await until(() => roster(h).length === 2);
        const tokenBefore = g.room.reconnectionToken;
        drop(g, false);
        await until(() => roster(h).length === 1, 4000);
        const c = await player('gus');
        assert.ok(await failure(c.reconnect(tokenBefore)), 'the place is gone');
        assert.ok(await failure(c.reconnect(`${h.room.roomId}:not-a-token`)));
        assert.strictEqual(roster(h).length, 1);
    });
});

describe('a server that is told to stop', () => {
    beforeEach(reset);

    it('tells every room why before it lets go of anyone', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        matchMaker.getLocalRoomById(h.room.roomId).onBeforeShutdown();
        assert.deepStrictEqual(await g.next(S2C.CLOSED), { reason: 'shutdown' });
        assert.deepStrictEqual(await h.next(S2C.CLOSED), { reason: 'shutdown' });
        assert.strictEqual(await g.left, Close.SHUTDOWN);
        assert.strictEqual(await h.left, Close.SHUTDOWN);
        await until(() => registry.rooms.size === 0, 3000);
    });

    it('takes nobody new while it does', async () => {
        const h = await host();
        registry.closing = true;
        assert.strictEqual((await fetch(`${URL}/readyz`)).status, 503);
        assert.strictEqual((await fetch(`${URL}/healthz`)).status, 200, 'alive, and not to be sent players');
        const c = await player('gus');
        const r = await resolve(h.welcome.code, c.auth.token!);
        assert.strictEqual((await failure(c.joinById(r.data.roomId, { ...hello(), code: h.welcome.code })))?.code, Reject.CLOSING);
        assert.strictEqual((await failure((await player('otto')).create('world', { ...hello(), world: WORLD, maxPlayers: 4 })))?.code, Reject.CLOSING);
        registry.closing = false;
    });

    it('a room that is ending takes no more messages and no more players', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const room = matchMaker.getLocalRoomById(h.room.roomId);
        h.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(40);
        room.onBeforeShutdown();
        h.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 3 });
        const e = await failure(join(h.welcome.code, 'ivy'));
        assert.ok(e, 'nobody new');
        await g.left;
        assert.ok(!g.got.some(m => m.type === S2C.BLOCK));
    });
});
