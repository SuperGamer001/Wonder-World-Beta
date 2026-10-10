// What the room will not have: messages that are not messages, things said by
// someone who may not say them, claims to be someone else, and things no
// player in their place could have done.
import assert from 'node:assert';
import { reset, host, join, player, hello, resolve, failure, watch, roster, serve, until, sleep, at, WORLD } from './setup.js';
import { C2S, S2C, Reject, Close, ChunkStatus, RejectWhy } from '../src/protocol.js';
import { config } from '../src/config.js';
import { metrics } from '../src/log.js';
import { registry } from '../src/registry.js';

describe('messages that are not messages', () => {
    beforeEach(reset);

    it('none of them is passed on, and each is counted', async () => {
        config.rate.invalidPerMinute = 1000;
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(0, 70, 0));
        await h.next(S2C.STATES);
        const bad: [string, unknown][] = [
            [C2S.STATE, [NaN, 70, 0, 0, 0, 0, 1, 0, 0]],
            [C2S.STATE, [0, 70, 0, 0, 0, 0, 1, 0]],
            [C2S.STATE, { x: 0, y: 70, z: 0 }],
            [C2S.STATE, 'here'],
            [C2S.STATE, [3e9, 70, 0, 0, 0, 0, 1, 0, 0]],
            [C2S.BLOCK, { x: 0, y: 70, z: 0 }],
            [C2S.BLOCK, { x: 0.5, y: 70, z: 0, b: 1 }],
            [C2S.BLOCK, { x: 0, y: 5000, z: 0, b: 1 }],
            [C2S.BLOCK, { x: 0, y: 70, z: 0, b: 70000 }],
            [C2S.BLOCK, { x: '0', y: 70, z: 0, b: 1 }],
            [C2S.BLOCK, null],
            [C2S.BLOCK, [0, 70, 0, 1]],
            [C2S.PROFILE, { name: 5 }],
            [C2S.PROFILE, { name: 'x'.repeat(100) }],
            [C2S.HIT, { id: 'seven', dmg: 1 }],
            [C2S.HIT, { id: 7 }],
            [C2S.CHUNK, { cx: 1e9, cz: 0 }],
            [C2S.PSAVE, {}],
            [C2S.PSAVE, { state: { a: Infinity } }],
            ['dance', { fast: true }],
            ['__proto__', {}],
            [C2S.SYNC, { since: -1 }],
        ];
        for (const [type, payload] of bad) g.room.send(type, payload);
        await sleep(300);
        assert.strictEqual(metrics.get('invalid_messages'), bad.length, 'every one of them was seen for what it was');
        assert.ok(!h.got.some(m => m.type === S2C.BLOCK), 'no block came of it');
        assert.strictEqual(h.got.filter(m => m.type === S2C.STATES).length, 0, 'nor any movement');
        assert.ok(g.room.connection.isOpen, 'and the sender, under the limit, is still here');
    });

    it('a player who keeps sending them is removed', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        for (let k = 0; k < config.rate.invalidPerMinute + 2; k++) g.room.send(C2S.BLOCK, { nonsense: k });
        assert.strictEqual(await g.left, Close.INVALID);
        await until(() => roster(h).length === 2);
        assert.ok(i.room.connection.isOpen && h.room.connection.isOpen, 'and nobody else is troubled');
        assert.ok(metrics.get('security_invalid_kick') >= 1);
    });

    it('a frame bigger than the limit closes the connection that sent it, and no place is held for it', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        await until(() => roster(h).length === 2);
        g.room.send(C2S.PSAVE, { state: 'x'.repeat(config.maxPayloadBytes + 2000) });
        assert.strictEqual(await g.left, 1009, 'message too big');
        await until(() => roster(h).length === 1, 2000, 'the seat to be freed at once');
        assert.ok(h.room.connection.isOpen);
    });

    it('a saved place too big for the host to be asked to keep is refused', async () => {
        config.maxPlayerStateBytes = 2000;
        const h = await host();
        const g = await join(h.welcome.code);
        const { asked } = serve(h, { psave: () => ({}) });
        g.room.send(C2S.PSAVE, { state: { junk: 'x'.repeat(5000) } });
        g.room.send(C2S.PSAVE, { state: { health: 50 } });
        await until(() => asked.length >= 1);
        await sleep(100);
        assert.deepStrictEqual(asked.map(a => a.state), [{ health: 50 }]);
    });

    it('a host that answers nonsense, or too much, is not passed on', async () => {
        config.maxChunkBytes = 4096;
        const h = await host();
        const g = await join(h.welcome.code);
        let n = 0;
        serve(h, {
            chunk: () => [{ s: ChunkStatus.DATA, d: new Uint8Array(9000) }, { s: 7 }, { s: ChunkStatus.DATA, d: 'text' }, { s: ChunkStatus.DATA }][n++],
            manifest: () => ({ keys: ['not a key'] }),
        });
        assert.deepStrictEqual(await g.room.request(C2S.CHUNK, { cx: 0, cz: 0 }), { s: ChunkStatus.NONE }, 'too big: left out');
        assert.deepStrictEqual(await g.room.request(C2S.CHUNK, { cx: 1, cz: 0 }), { s: ChunkStatus.RETRY }, 'no such status');
        assert.deepStrictEqual(await g.room.request(C2S.CHUNK, { cx: 2, cz: 0 }), { s: ChunkStatus.RETRY }, 'not bytes');
        assert.deepStrictEqual(await g.room.request(C2S.CHUNK, { cx: 3, cz: 0 }), { s: ChunkStatus.NONE }, 'data with no data');
        assert.deepStrictEqual(await g.room.request(C2S.MANIFEST), { retry: true });
    });

    it('a mob list of the wrong shape, or of too many mobs, goes nowhere', async () => {
        config.maxMobs = 4;
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.MOBS, { list: [1, 2, 3] });
        h.room.send(C2S.MOBS, { list: Array(11 * 5).fill(1) });
        h.room.send(C2S.MOBS, { list: [7, 2, 10, 70, 10, 0, 1, 0, 0, 0, NaN] });
        assert.ok(await g.none(S2C.MOBS, 300));
        h.room.send(C2S.MOBS, { list: [7, 2, 10, 70, 10, 0, 1, 0, 0, 0, 0] });
        assert.strictEqual((await g.next(S2C.MOBS)).list[0], 7);
    });
});

describe('who may say what', () => {
    beforeEach(reset);

    it('a guest cannot speak as the host', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        g.room.send(C2S.ATMOS, { a: { day: { time: 0.99 } } });
        g.room.send(C2S.MOBS, { list: [7, 2, 10, 70, 10, 0, 1, 0, 0, 0, 0] });
        g.room.send(C2S.ATTACK, { to: 3, dmg: 99 });
        g.room.send(C2S.DROPS, { to: 2, pos: { x: 0, y: 70, z: 0 }, items: [['gold_ingot', 64]] });
        g.room.send(C2S.LOCK, { locked: true });
        await sleep(300);
        for (const s of [h, g, i]) {
            for (const type of [S2C.ATMOS, S2C.MOBS, S2C.ATTACK, S2C.DROPS]) assert.ok(!s.got.some(m => m.type === type), `${type} reached someone`);
        }
        assert.ok(!(h.room.state as any).locked);
        assert.strictEqual(metrics.get('violation_role'), 5);
        assert.ok(metrics.get('security_violation') >= 1, 'and it is written down');
    });

    it('a guest cannot remove a player; the host can, and that account does not come back', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        g.room.send(C2S.KICK, { id: 3 });
        g.room.send(C2S.KICK, { id: 1 });
        await sleep(200);
        assert.ok(i.room.connection.isOpen && h.room.connection.isOpen);

        h.room.send(C2S.KICK, { id: 3 });
        assert.deepStrictEqual(await i.next(S2C.CLOSED), { reason: 'kicked' });
        assert.strictEqual(await i.left, Close.KICKED);
        await until(() => roster(h).length === 2);
        assert.strictEqual((await failure(join(h.welcome.code, 'ivy')))?.code, Reject.BANNED);
        assert.strictEqual((await failure(join(h.welcome.code, 'ivy', { name: 'Not Ivy', slot: 1 })))?.code, Reject.BANNED, 'whatever they call themselves');
    });

    it('a guest who keeps trying to speak as the host is removed', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        for (let k = 0; k < 8; k++) g.room.send(C2S.ATMOS, { a: {} });
        assert.strictEqual(await g.left, Close.FLOOD);
        assert.ok(h.room.connection.isOpen);
    });

    it('the host cannot answer a question nobody asked, and a guest cannot answer at all', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        serve(h, {});
        // Ivy tries to answer Gus's question before the host does.
        const asking = g.room.request(C2S.PLOAD);
        for (let rid = 1; rid <= 3; rid++) i.room.send(C2S.REPLY, { rid, ok: true, d: { state: { health: 1, forged: true } } });
        h.room.send(C2S.REPLY, { rid: 999, ok: true, d: { state: { nobody: 'asked' } } });
        assert.deepStrictEqual(await asking, { retry: true }, 'the host declined; the forgery was not the answer');
        assert.ok(metrics.get('violation_role') >= 3);
    });

    it('the host cannot land a blow through the room, nor a guest on a mob that is not there, too far, or too hard', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.MOBS, { list: [7, 2, 10, 70, 10, 0, 1, 0, 0, 0, 0] });
        await g.next(S2C.MOBS);
        h.room.send(C2S.HIT, { id: 7, dmg: 5 });

        g.room.send(C2S.HIT, { id: 7, dmg: 5 });                       // no place yet: not judged in their favour
        g.room.send(C2S.STATE, at(9, 70, 10));
        g.room.send(C2S.HIT, { id: 99, dmg: 5 });                      // no such mob
        g.room.send(C2S.HIT, { id: 7, dmg: config.maxHitDamage + 1 }); // harder than anything hits
        g.room.send(C2S.HIT, { id: 7, dmg: -5 });
        await sleep(250);
        assert.ok(!h.got.some(m => m.type === S2C.HIT));

        g.room.send(C2S.HIT, { id: 7, dmg: 5 });
        assert.deepStrictEqual(await h.next(S2C.HIT), { from: 2, id: 7, dmg: 5 });

        // The same blow from the other side of the world.
        for (let k = 0; k < 3; k++) g.room.send(C2S.STATE, at(9000 + k, 70, 10));
        await sleep(120);
        g.room.send(C2S.HIT, { id: 7, dmg: 5 });
        assert.ok(await h.none(S2C.HIT, 250));
        assert.ok(metrics.get('violation_hit_reach') >= 2 && metrics.get('violation_hit_damage') >= 1);
    });

    it('a mob\'s blow is no harder than the server allows, and falls only on a player who is there', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        h.room.send(C2S.ATTACK, { to: 2, dmg: 900 });
        assert.deepStrictEqual(await g.next(S2C.ATTACK), { dmg: config.maxHitDamage });
        h.room.send(C2S.ATTACK, { to: 55, dmg: 1 });
        h.room.send(C2S.ATTACK, { to: 2, dmg: 5000 });                 // out of range altogether
        assert.ok(await g.none(S2C.ATTACK, 200));
    });
});

describe('claims to be someone else', () => {
    beforeEach(reset);

    it('a message cannot carry its sender: who sent it is who the connection is', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(40);
        // As player 1 (the host), in every way a client could try to say so.
        g.room.send(C2S.BLOCK, { x: 0, y: 70, z: 0, b: 3, id: 1 });
        g.room.send(C2S.BLOCK, { x: 0, y: 70, z: 0, b: 3, from: 1 });
        g.room.send(C2S.HIT, { id: 7, dmg: 1, from: 1 });
        g.room.send(C2S.STATE, [1, ...at(0, 70, 0)]);
        g.room.send(S2C.STATES, [1, at(500, 70, 500)]);                 // a server message, sent upward
        g.room.send(S2C.BLOCK, { x: 0, y: 70, z: 0, b: 3, id: 1, seq: 1 });
        g.room.send(S2C.WELCOME, { id: 1, hostId: 2 });
        await sleep(250);
        assert.ok(!h.got.some(m => m.type === S2C.BLOCK));
        assert.strictEqual(metrics.get('invalid_messages'), 7);
        g.room.send(C2S.BLOCK, { x: 0, y: 70, z: 0, b: 3 });
        assert.strictEqual((await h.next(S2C.BLOCK)).id, 2, 'and an honest one is stamped by the room');
    });

    it('nobody becomes the host by asking: not with a field, not by arriving first with another account', async () => {
        const h = await host('hana');
        const c = await player('mal');
        const r = await resolve(h.welcome.code, c.auth.token!);
        for (const extra of [{ host: true }, { creator: 'dev:hana' }, { creatorEdition: 'full' }, { edition: 'full' }, { role: 'host' }, { id: 1 }]) {
            const e = await failure(c.joinById(r.data.roomId, { ...hello({ name: 'mal' }), code: h.welcome.code, ...extra }));
            // `creator` / `creatorEdition` are the server's own fields: stripped, so that join goes through as a guest.
            if (e) assert.strictEqual(e.code, Reject.BAD_REQUEST, JSON.stringify(extra));
        }
        await until(() => roster(h).length >= 1);
        assert.deepStrictEqual(roster(h).filter(p => p.host).map(p => p.id), [1]);
        assert.strictEqual((h.room.state as any).hostId, 1);
    });

    it('a room made by one account is hosted by that account, whatever its options say', async () => {
        const c = await player('mal', 'free');
        const e = await failure(c.create('world', { ...hello({ name: 'mal' }), world: WORLD, maxPlayers: 8, creator: 'dev:hana', creatorEdition: 'full' }));
        assert.strictEqual(e?.code, Reject.EDITION, 'the free edition does not host, and cannot say it is another');
        assert.strictEqual(registry.rooms.size, 0);
    });

    it('a name is a name, not an identity: it is cleaned, and two players may share one', async () => {
        const h = await host('hana');
        const g = await join(h.welcome.code, 'mal', { name: 'hana' });
        const x = await join(h.welcome.code, 'xss', { name: '<script>alert(1)</script>' });
        await until(() => roster(h).length === 3);
        const names = roster(h).sort((a, b) => a.id - b.id).map(p => p.name);
        assert.deepStrictEqual(names, ['hana', 'hana', 'scriptalert1scri']);
        assert.notStrictEqual(g.welcome.id, h.welcome.id, 'the same name; a different player, by number');
        assert.ok(x.room.connection.isOpen);
    });

    it('a guest is never handed another player\'s saved place', async () => {
        const h = await host('hana');
        const g = await join(h.welcome.code, 'gus'), m = await join(h.welcome.code, 'mal', { name: 'gus' });
        const { asked } = serve(h, { pload: (q) => ({ state: { key: q.key } }) });
        const mine = await g.room.request(C2S.PLOAD) as any, theirs = await m.room.request(C2S.PLOAD) as any;
        assert.notStrictEqual(mine.state.key, theirs.state.key, 'the same name on another account is another key');
        // There is no way to name a key: the request takes nothing.
        m.room.send(C2S.PLOAD, { key: mine.state.key });
        await sleep(150);
        assert.strictEqual(asked.length, 2);
        assert.ok(metrics.get('invalid_messages') >= 1);
    });
});

describe('things no player in their place could have done', () => {
    beforeEach(reset);

    it('a block is changed within reach of where its player is, or not at all', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.BLOCK, { x: 0, y: 70, z: 0, b: 3 });
        assert.deepStrictEqual(await g.next(S2C.REJECT), { x: 0, y: 70, z: 0, why: RejectWhy.POSITION }, 'nobody knows where they are yet');

        g.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(30);
        g.room.send(C2S.BLOCK, { x: 200, y: 70, z: 0, b: 3 });
        assert.deepStrictEqual(await g.next(S2C.REJECT), { x: 200, y: 70, z: 0, why: RejectWhy.REACH });
        g.room.send(C2S.BLOCK, { x: 0, y: -100, z: 0, b: 0 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.REACH);
        assert.ok(await h.none(S2C.BLOCK, 150), 'the others never saw it');

        g.room.send(C2S.BLOCK, { x: 3, y: 71, z: -2, b: 3 });
        assert.strictEqual((await h.next(S2C.BLOCK)).x, 3);
    });

    it('water runs on from where it was poured, so it is given more room — but not the world', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(30);
        g.room.send(C2S.BLOCK, { x: 30, y: 40, z: 0, b: 5 });
        assert.strictEqual((await h.next(S2C.BLOCK)).b, 5);
        g.room.send(C2S.BLOCK, { x: 30, y: 40, z: 0, b: 3 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.REACH, 'stone at that distance is not water');
        g.room.send(C2S.BLOCK, { x: 5000, y: 40, z: 0, b: 5 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.REACH);
    });

    it('a block the game does not have cannot be placed', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(30);
        g.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 9999 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.BLOCK);
        assert.ok(await h.none(S2C.BLOCK, 150));
    });

    it('in a world for looking at, nobody builds or fights', async () => {
        const h = await host('hana', { world: { ...WORLD, gameMode: 'SPECTATOR' } });
        const g = await join(h.welcome.code);
        h.room.send(C2S.STATE, at(0, 70, 0));
        g.room.send(C2S.STATE, at(0, 70, 0));
        h.room.send(C2S.MOBS, { list: [7, 2, 1, 70, 1, 0, 1, 0, 0, 0, 0] });
        await g.next(S2C.MOBS);
        g.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 3 });
        h.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 3 });
        g.room.send(C2S.HIT, { id: 7, dmg: 3 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.MODE);
        assert.strictEqual((await h.next(S2C.REJECT)).why, RejectWhy.MODE, 'the host included');
        assert.ok(await h.none(S2C.HIT, 150));
    });

    it('a player moves as fast as a player goes: a jump is not passed on, bar the few a respawn makes', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(0, 70, 0));
        const seen = () => h.got.filter(m => m.type === S2C.STATES).flatMap(m => m.data).filter(v => Array.isArray(v)).map(v => v[0]);
        await until(() => seen().length >= 1);
        // Walking, falling: fine.
        g.room.send(C2S.STATE, at(3, 20, 0));
        await until(() => seen().includes(3));
        // A thousand blocks a step, six times: three are let through as jumps, the rest are not.
        for (let k = 1; k <= 6; k++) { g.room.send(C2S.STATE, at(k * 1000, 70, 0)); await sleep(80); }
        await sleep(100);
        const far = seen().filter(x => x >= 1000);
        assert.deepStrictEqual(far, [1000, 2000, 3000]);
        assert.strictEqual(metrics.get('states_refused'), 3);
        // … and the room still judges by where it last believed them to be.
        g.room.send(C2S.BLOCK, { x: 6000, y: 70, z: 0, b: 3 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.REACH);
    });
});

describe('the free edition, as the server holds it', () => {
    beforeEach(reset);

    it('does not host — whatever the game says of itself', async () => {
        const c = await player('fay', 'free');
        assert.strictEqual((await failure(c.create('world', { ...hello({ name: 'fay' }), world: WORLD, maxPlayers: 4 })))?.code, Reject.EDITION);
        config.editions.free.canHost = true;
        const room = await watch(await c.create('world', { ...hello({ name: 'fay' }), world: WORLD, maxPlayers: 8 }));
        assert.strictEqual(room.welcome.max, config.editions.free.maxRoomPlayers, 'and where it may, its room is the size its edition allows');
    });

    it('joins the full edition\'s games, and is told which edition it is', async () => {
        const h = await host('hana');
        const g = await join(h.welcome.code, 'fay', {}, 'free');
        assert.strictEqual(g.welcome.edition, 'free');
        assert.strictEqual(h.welcome.edition, 'full');
    });

    it('cannot place what it does not have; the full edition, beside it, can', async () => {
        config.editions.free.blockedBlocks = ['LAMP', 'GOLD_BLOCK'];
        const h = await host('hana');
        const g = await join(h.welcome.code, 'fay', {}, 'free');
        const f = await join(h.welcome.code, 'ful');
        g.room.send(C2S.STATE, at(0, 70, 0));
        f.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(40);
        g.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 43 });           // LAMP
        assert.deepStrictEqual(await g.next(S2C.REJECT), { x: 1, y: 70, z: 0, why: RejectWhy.EDITION });
        g.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 0 });            // breaking is not restricted
        assert.strictEqual((await h.next(S2C.BLOCK)).b, 0);
        g.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 3 });
        assert.strictEqual((await h.next(S2C.BLOCK)).b, 3);
        f.room.send(C2S.BLOCK, { x: 2, y: 70, z: 0, b: 43 });
        assert.deepStrictEqual((await h.next(S2C.BLOCK)).b, 43);
    });

    it('where it may not build at all, it cannot', async () => {
        config.editions.free.canBuild = false;
        const h = await host('hana');
        const g = await join(h.welcome.code, 'fay', {}, 'free');
        assert.strictEqual(g.welcome.canBuild, false);
        g.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(30);
        g.room.send(C2S.BLOCK, { x: 1, y: 70, z: 0, b: 0 });
        assert.strictEqual((await g.next(S2C.REJECT)).why, RejectWhy.EDITION);
    });
});
