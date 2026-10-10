// A world online, played as it is meant to be: a host and their guests, what
// each is told, several players on one screen, and what a guest is passed of
// the host's world.
import assert from 'node:assert';
import { matchMaker } from 'colyseus';
import { reset, host, join, player, hello, resolve, failure, watch, roster, serve, until, sleep, at } from './setup.js';
import { C2S, S2C, Reject, Close, ChunkStatus } from '../src/protocol.js';
import { config } from '../src/config.js';
import { registry } from '../src/registry.js';
import { CODES } from '../src/rooms/WorldRoom.js';

describe('a world online', () => {
    beforeEach(reset);

    it('the host is given a code and is the first player; a guest finds the room by the code', async () => {
        const h = await host('hana');
        assert.match(h.welcome.code, /^[A-HJ-KM-NP-Z2-9]{8}$/);
        assert.strictEqual(h.welcome.id, 1);
        assert.strictEqual(h.welcome.hostId, 1);
        assert.strictEqual(h.welcome.world.seed, 1234, 'the world is handed back as the room keeps it');

        const g = await join(h.welcome.code, 'gus');
        assert.strictEqual(g.welcome.hostId, 1);
        assert.strictEqual(g.welcome.id, 2);
        assert.deepStrictEqual(g.welcome.world, h.welcome.world, 'a guest is told the world it is to make');
        assert.strictEqual(g.welcome.code, h.welcome.code);
    });

    it('everyone is told who is here by the room, and nothing of who they are', async () => {
        const h = await host('hana', { skin: { hair: 2, evil: 'x' } });
        const g = await join(h.welcome.code, 'gus');
        await until(() => roster(h).length === 2 && roster(g).length === 2);
        const list = roster(g).sort((a, b) => a.id - b.id);
        assert.deepStrictEqual(list, [
            { id: 1, name: 'hana', skin: '{"hair":2}', host: true, connected: true },
            { id: 2, name: 'gus', skin: '{}', host: false, connected: true },
        ]);
        const text = JSON.stringify((g.room.state as any).toJSON());
        assert.ok(!/dev:|steam:|guest:|full|free|127\.0\.0\.1/.test(text), 'no account, edition or address is in the shared state');
    });

    it('where a player is goes to the others, everyone who moved in one message', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        h.room.send(C2S.STATE, at(1, 70, 2));
        g.room.send(C2S.STATE, at(3, 71, 4));
        await until(() => i.got.filter(m => m.type === S2C.STATES).flatMap(m => m.data).filter(v => Array.isArray(v)).length >= 2);
        const list = i.got.filter(m => m.type === S2C.STATES).flatMap(m => m.data);
        const where = new Map<number, number[]>();
        for (let k = 0; k < list.length; k += 2) where.set(list[k], list[k + 1]);
        assert.deepStrictEqual(where.get(1)!.slice(0, 3), [1, 70, 2]);
        assert.deepStrictEqual(where.get(2)!.slice(0, 3), [3, 71, 4]);
        assert.ok(!where.has(3), 'and nobody is told where they did not move');
    });

    it('a changed block goes to everyone, numbered, its sender included', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(10, 64, -3));
        await sleep(30);
        g.room.send(C2S.BLOCK, { x: 10, y: 64, z: -3, b: 3 });
        g.room.send(C2S.BLOCK, { x: 11, y: 64, z: -3, b: 0 });
        const first = await h.next(S2C.BLOCK), second = await h.next(S2C.BLOCK);
        assert.deepStrictEqual(first, { x: 10, y: 64, z: -3, b: 3, id: 2, seq: 1 });
        assert.deepStrictEqual(second, { x: 11, y: 64, z: -3, b: 0, id: 2, seq: 2 });
        assert.deepStrictEqual(await g.next(S2C.BLOCK), first, 'the sender hears its own change back, with its number');
    });

    it('the clock, the weather and the mobs are the host\'s to tell, and reach the guests', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.ATMOS, { a: { day: { time: 0.25, day: 3 }, weather: { mode: 'dynamic', current: 'rain', P: [0.5, 0.1] }, running: true } });
        assert.strictEqual((await g.next(S2C.ATMOS)).a.day.time, 0.25);
        assert.ok(await h.none(S2C.ATMOS), 'and not back to the host');

        h.room.send(C2S.MOBS, { list: [7, 2, 10, 70, 10, 0, 1, 0, 0, 0, 0], info: { 7: { coat: 1 } } });
        const mobs = await g.next(S2C.MOBS);
        assert.strictEqual(mobs.list.length, 11);
        assert.deepStrictEqual(mobs.info, { 7: { coat: 1 } });
    });

    it('a guest\'s blow reaches the host; a mob\'s blow and a kill\'s drops reach their player and nobody else', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        h.room.send(C2S.MOBS, { list: [7, 2, 10, 70, 10, 0, 1, 0, 0, 0, 0] });
        g.room.send(C2S.STATE, at(8, 70, 10));
        await g.next(S2C.MOBS);
        g.room.send(C2S.HIT, { id: 7, dmg: 4 });
        assert.deepStrictEqual(await h.next(S2C.HIT), { from: 2, id: 7, dmg: 4 }, 'stamped with who the connection is');
        assert.ok(await i.none(S2C.HIT));

        h.room.send(C2S.ATTACK, { to: 2, dmg: 3 });
        h.room.send(C2S.DROPS, { to: 2, pos: { x: 10, y: 70, z: 10 }, items: [['raw_beef', 2]] });
        assert.deepStrictEqual(await g.next(S2C.ATTACK), { dmg: 3 });
        assert.deepStrictEqual(await g.next(S2C.DROPS), { pos: { x: 10, y: 70, z: 10 }, items: [['raw_beef', 2]] });
        assert.ok(await i.none(S2C.ATTACK) && await i.none(S2C.DROPS, 10));
    });

    it('a newcomer is told where everyone is, the time, and how far the changes have got', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.STATE, at(5, 80, 5));
        h.room.send(C2S.ATMOS, { a: { day: { time: 0.5, day: 1 } } });
        h.room.send(C2S.BLOCK, { x: 5, y: 80, z: 5, b: 3 });
        await g.next(S2C.BLOCK);
        const late = await join(h.welcome.code, 'ivy');
        const where = new Map<number, number[] | null>(late.welcome.players);
        assert.deepStrictEqual(where.get(1)!.slice(0, 3), [5, 80, 5]);
        assert.strictEqual(where.get(2), null, 'a player who has not said where they are has no place yet');
        assert.strictEqual(late.welcome.atmos.day.time, 0.5);
        assert.strictEqual(late.welcome.seq, 1);
    });

    it('a change of name or look reaches everyone', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.PROFILE, { name: 'Gustav <b>', skin: { outfit: 3, hax: 'x' } });
        await until(() => roster(h).some(p => p.name === 'Gustav b'));
        assert.strictEqual(roster(h).find(p => p.id === 2)!.skin, '{"outfit":3}');
    });

    it('a guest leaving is told to the rest and the game goes on; the host leaving ends it for everyone', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        await until(() => roster(h).length === 3);
        await g.room.leave();
        await until(() => roster(h).length === 2 && roster(i).length === 2);
        assert.ok(await i.none(S2C.CLOSED, 100));

        await h.room.leave();
        assert.deepStrictEqual(await i.next(S2C.CLOSED), { reason: 'host' });
        assert.strictEqual(await i.left, Close.HOST_LEFT);
    });

    it('when a room has gone, so have its code and everything counted for it', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const tok = (await player('zed')).auth.token!;
        assert.strictEqual((await resolve(h.welcome.code, tok)).status, 200);
        assert.strictEqual(registry.rooms.size, 1);
        assert.strictEqual(registry.players(), 2);
        await h.room.leave();
        await g.left;
        await until(() => registry.rooms.size === 0, 3000, 'the room to be disposed');
        assert.strictEqual((await resolve(h.welcome.code, tok)).status, 404);
        assert.strictEqual(await matchMaker.presence.hget(CODES, h.welcome.code), null);
        assert.strictEqual(registry.players(), 0);
        assert.strictEqual(registry.accounts.size, 0);
    });

    it('a number, once a player has had it, is never another player\'s', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        await g.room.leave();
        const i = await join(h.welcome.code, 'ivy');
        assert.strictEqual(i.welcome.id, 3);
    });
});

describe('several players on one screen', () => {
    beforeEach(reset);

    /** Another player of the same account: the same token, another slot. */
    async function pane(code: string, account: string, slot: number, name: string, edition: 'full' | 'free' = 'full') {
        const c = await player(account, edition);
        const r = await resolve(code, c.auth.token!);
        return watch(await c.joinById(r.data.roomId, { ...hello({ name, slot }), code }));
    }

    it('one account brings several players, each with a number of their own', async () => {
        const h = await host('hana');
        const two = await pane(h.welcome.code, 'hana', 1, 'Ben');
        const three = await pane(h.welcome.code, 'hana', 2, 'Cy');
        const four = await pane(h.welcome.code, 'hana', 3, 'Di');
        assert.deepStrictEqual([h, two, three, four].map(s => s.welcome.id), [1, 2, 3, 4]);
        assert.ok([two, three, four].every(s => s.welcome.hostId === 1), 'the first is the host; the others are players');
        await until(() => roster(four).length === 4);
        assert.deepStrictEqual(roster(four).filter(p => p.host).map(p => p.id), [1]);
        assert.strictEqual(registry.roomsOf('dev:hana'), 1, 'four players, one room');
        assert.strictEqual(registry.seatsOf('dev:hana', h.room.roomId), 4);

        // Each is their own player to everyone else.
        const g = await join(h.welcome.code, 'gus');
        two.room.send(C2S.STATE, at(1, 70, 1));
        three.room.send(C2S.STATE, at(2, 70, 2));
        await until(() => g.got.filter(m => m.type === S2C.STATES).flatMap(m => m.data).filter(v => typeof v === 'number').length >= 2);
        const ids = g.got.filter(m => m.type === S2C.STATES).flatMap(m => m.data).filter(v => typeof v === 'number');
        assert.deepStrictEqual([...new Set(ids)].sort(), [2, 3]);
    });

    it('a slot holds one player, and an account only so many', async () => {
        const h = await host('hana');
        await pane(h.welcome.code, 'hana', 1, 'Ben');
        assert.strictEqual((await failure(pane(h.welcome.code, 'hana', 1, 'Again')))?.code, Reject.BAD_REQUEST, 'the same slot twice');
        assert.strictEqual((await failure(pane(h.welcome.code, 'hana', 0, 'Host2')))?.code, Reject.BAD_REQUEST, 'nor the host\'s');

        const g = await join(h.welcome.code, 'gus', {}, 'free');
        assert.strictEqual(g.welcome.edition, 'free');
        await pane(h.welcome.code, 'gus', 1, 'Gil', 'free');
        assert.strictEqual((await failure(pane(h.welcome.code, 'gus', 2, 'Gab', 'free')))?.code, Reject.FULL, 'the free edition brings two');
    });

    it('two players of one account never share a name: it is what the host keeps their things under', async () => {
        const h = await host('hana');
        const two = await pane(h.welcome.code, 'hana', 1, 'hana');
        await until(() => roster(h).length === 2);
        const names = roster(h).map(p => p.name);
        assert.strictEqual(new Set(names.map(n => n.toLowerCase())).size, 2, names.join(', '));
        // … and cannot be renamed into one.
        two.room.send(C2S.PROFILE, { name: 'HANA' });
        await sleep(250);
        assert.strictEqual(new Set(roster(h).map(p => p.name.toLowerCase())).size, 2);
    });

    it('an account plays in one game at a time', async () => {
        const h = await host('hana');
        const other = await host('otto');
        const c = await player('hana');
        const r = await resolve(other.welcome.code, c.auth.token!);
        assert.strictEqual((await failure(c.joinById(r.data.roomId, { ...hello({ name: 'hana' }), code: other.welcome.code })))?.code, Reject.LIMIT);
        assert.ok(h.room.connection.isOpen);
    });
});

describe('the host\'s world, for a guest', () => {
    beforeEach(reset);

    it('a guest asks which chunks the host has, and for each of them', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const chunk = new Uint8Array(3000).map((_, k) => k % 251);
        const { asked } = serve(h, {
            manifest: () => ({ keys: ['0,0', '-1,2'] }),
            chunk: (m) => m.cx === 0 && m.cz === 0 ? { s: ChunkStatus.DATA, d: chunk } : { s: ChunkStatus.NONE },
        });
        assert.deepStrictEqual(await g.room.request(C2S.MANIFEST), { keys: ['0,0', '-1,2'] });
        const got = await g.room.request(C2S.CHUNK, { cx: 0, cz: 0 }) as { s: number; d: Uint8Array };
        assert.strictEqual(got.s, ChunkStatus.DATA);
        assert.deepStrictEqual(new Uint8Array(got.d), chunk, 'the bytes arrive as the host sent them');
        assert.deepStrictEqual(await g.room.request(C2S.CHUNK, { cx: 5, cz: 5 }), { s: ChunkStatus.NONE });
        assert.deepStrictEqual(asked.map(a => a.op), ['manifest', 'chunk', 'chunk']);
    });

    it('two guests asking for one chunk are one question to the host', async () => {
        const h = await host();
        const g = await join(h.welcome.code), i = await join(h.welcome.code, 'ivy');
        const { asked } = serve(h, { chunk: async () => { await sleep(80); return { s: ChunkStatus.DATA, d: new Uint8Array([1, 2, 3]) }; } });
        const [a, b] = await Promise.all([g.room.request(C2S.CHUNK, { cx: 1, cz: 1 }), i.room.request(C2S.CHUNK, { cx: 1, cz: 1 })]) as any[];
        assert.strictEqual(a.s, ChunkStatus.DATA);
        assert.strictEqual(b.s, ChunkStatus.DATA);
        assert.strictEqual(asked.length, 1);
    });

    it('a guest\'s place in the world is kept by the host under a name the server makes', async () => {
        const h = await host('hana');
        const g = await join(h.welcome.code, 'gus'), i = await join(h.welcome.code, 'ivy');
        const kept = new Map<string, unknown>();
        const { asked } = serve(h, {
            psave: (m) => { kept.set(m.key, m.state); return {}; },
            pload: (m) => ({ state: kept.get(m.key) ?? null }),
        });
        g.room.send(C2S.PSAVE, { state: { health: 80, inventory: { slots: [{ id: 'apple', n: 3 }] } } });
        i.room.send(C2S.PSAVE, { state: { health: 20 } });
        await until(() => kept.size === 2);
        const keys = [...kept.keys()];
        assert.ok(keys.every(k => /^[A-Za-z0-9_-]{24}$/.test(k)) && keys[0] !== keys[1], 'a key each, and nothing of the account in it');
        assert.ok(!keys.some(k => k.includes('gus') || k.includes('ivy')));

        assert.deepStrictEqual(await g.room.request(C2S.PLOAD), { state: { health: 80, inventory: { slots: [{ id: 'apple', n: 3 }] } } });
        assert.deepStrictEqual(await i.room.request(C2S.PLOAD), { state: { health: 20 } }, 'each is handed their own and no other');
        assert.ok(asked.every(a => !('account' in a) && !('name' in a)), 'the host is told a key, never who');

        // The same player, back another day (a new room of the same host): the same key.
        await g.room.leave();
        const back = await join(h.welcome.code, 'gus');
        assert.deepStrictEqual(await back.room.request(C2S.PLOAD), { state: { health: 80, inventory: { slots: [{ id: 'apple', n: 3 }] } } });
    });

    it('while the host does not answer, a guest is told to ask again rather than left waiting', async () => {
        config.rate.hostAsksPerSecond = 2;
        const h = await host();
        const g = await join(h.welcome.code);
        serve(h, { chunk: () => ({ s: ChunkStatus.DATA, d: new Uint8Array([9]) }) });
        const answers = await Promise.all(Array.from({ length: 12 }, (_, k) => g.room.request(C2S.CHUNK, { cx: k, cz: 0 }))) as any[];
        assert.ok(answers.some(a => a.s === ChunkStatus.DATA));
        assert.ok(answers.some(a => a.s === ChunkStatus.RETRY), 'the host is asked only so much a second');
    });
});
