// How often, and how many at once: every limit the server keeps, met from the
// outside the way a flood would meet it.
import assert from 'node:assert';
import { Client } from '@colyseus/sdk';
import { reset, host, join, player, token, hello, resolve, post, failure, watch, roster, until, sleep, at, WORLD, URL } from './setup.js';
import { C2S, S2C, Reject, Close, RejectWhy } from '../src/protocol.js';
import { config } from '../src/config.js';
import { metrics } from '../src/log.js';
import { registry } from '../src/registry.js';

describe('how often', () => {
    beforeEach(reset);

    it('a flood of movement is thinned to what a game sends; the rest goes nowhere', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        for (let k = 0; k < 200; k++) g.room.send(C2S.STATE, at(k * 0.01, 70, 0));
        await sleep(400);
        const told = h.got.filter(m => m.type === S2C.STATES).length;
        assert.ok(told >= 1 && told <= 8, `the host was told ${told} times`);
        assert.ok(metrics.get('violation_rate') >= 150, `${metrics.get('violation_rate')} were dropped`);
        assert.ok(g.room.connection.isOpen, 'a burst is not a reason to be removed');
    });

    it('blocks are changed only so fast: the rest are refused, and their sender told to put them back', async () => {
        const h = await host();
        const g = await join(h.welcome.code);
        g.room.send(C2S.STATE, at(0, 70, 0));
        await sleep(40);
        for (let k = 0; k < 150; k++) g.room.send(C2S.BLOCK, { x: k % 5, y: 70 + (k % 3), z: 1, b: 3 });
        await sleep(400);
        const done = h.got.filter(m => m.type === S2C.BLOCK).length;
        const refused = g.got.filter(m => m.type === S2C.REJECT);
        assert.ok(done >= 60 && done <= 75, `${done} were made`);
        assert.strictEqual(done + refused.length, 150, 'each was either made or refused');
        assert.ok(refused.every(m => m.data.why === RejectWhy.RATE));
        assert.deepStrictEqual(h.got.filter(m => m.type === S2C.BLOCK).map(m => m.data.seq), Array.from({ length: done }, (_, k) => k + 1), 'and those made are numbered without a gap');
    });

    it('a player whose messages keep being refused is removed', async () => {
        config.rate.violationsPerMinute = 40;
        const h = await host();
        const g = await join(h.welcome.code);
        const i = await join(h.welcome.code, 'ivy');
        for (let k = 0; k < 150; k++) g.room.send(C2S.STATE, at(0, 70, 0));
        assert.deepStrictEqual(await g.next(S2C.CLOSED), { reason: 'flood' });
        assert.strictEqual(await g.left, Close.FLOOD);
        await until(() => roster(h).length === 2, 2000, 'no place to be held for them');
        assert.ok(i.room.connection.isOpen);
        assert.ok(metrics.get('security_flood_kick') >= 1);
    });

    it('past the hard limit on messages a second, the connection is simply closed', async () => {
        config.rate.messagesPerSecond = 40;
        const h = await host();
        const g = await join(h.welcome.code);
        await until(() => roster(h).length === 2);
        for (let k = 0; k < 120; k++) g.room.send(C2S.PROFILE, { name: `n${k}` });
        const code = await g.left;
        assert.ok(code === 4002 || code === 1006, `closed with ${code}`);
        await until(() => roster(h).length === 1, 2000, 'and no place held');
        assert.ok(h.room.connection.isOpen);
    });

    it('one address asks for places in rooms only so often', async () => {
        config.rate.matchmakePerIp = 6;
        registry.reset();
        const h = await host();                                             // 1
        const c = await player('gus');
        const { roomId } = (await resolve(h.welcome.code, c.auth.token!)).data;
        const codes = [];
        for (let k = 0; k < 8; k++) codes.push((await failure(c.joinById(roomId, { ...hello(), code: 'AAAAAAAA' })))?.code);
        assert.deepStrictEqual(codes, [Reject.CODE, Reject.CODE, Reject.CODE, Reject.CODE, Reject.CODE, Reject.LIMIT, Reject.LIMIT, Reject.LIMIT]);
        assert.strictEqual((await failure(c.joinById(roomId, { ...hello(), code: h.welcome.code })))?.code, Reject.LIMIT, 'right or wrong: guessing a code is not something to do at speed');
        assert.ok(metrics.get('security_matchmake_rate') >= 1);
    });

    it('one address signs in only so often, and makes only so many new guests', async () => {
        config.rate.authPerIp = 5;
        config.rate.newGuestsPerIpPerHour = 2;
        registry.reset();
        const first = await post('/auth/guest');
        assert.strictEqual((await post('/auth/guest')).status, 200);
        const third = await post('/auth/guest');
        assert.strictEqual(third.status, 429, 'a third new guest');
        assert.strictEqual(third.headers.get('retry-after'), '600');
        assert.strictEqual((await post('/auth/guest', { credential: first.data.credential })).status, 200, 'a guest there already is, is not a new one');
        assert.strictEqual((await post('/auth/guest', { credential: first.data.credential })).status, 200);
        assert.strictEqual((await post('/auth/guest', { credential: first.data.credential })).status, 429, 'the sixth sign-in of any kind');
        assert.strictEqual((await post('/auth/steam', { ticket: 'ab'.repeat(40) })).status, 429);
    });

    it('a code is looked up only so often, by an account and by an address', async () => {
        config.rate.resolvePerAccount = 3;
        registry.reset();
        const h = await host();
        const t = await token('gus');
        const statuses = [];
        for (let k = 0; k < 5; k++) statuses.push((await resolve('AAAAAAAA', t)).status);
        assert.deepStrictEqual(statuses, [404, 404, 404, 429, 429]);
        assert.strictEqual((await resolve(h.welcome.code, t)).status, 429, 'the right code too');
        assert.strictEqual((await resolve(h.welcome.code, await token('ivy'))).status, 200, 'another account has its own count');

        config.rate.resolvePerIp = 2;
        registry.reset();
        assert.deepStrictEqual([(await resolve('AAAAAAAA', t)).status, (await resolve('AAAAAAAA', t)).status, (await resolve('AAAAAAAA', await token('ivy'))).status], [404, 404, 429]);
    });

    it('an account starts only so many games an hour', async () => {
        config.rate.createPerAccountPerHour = 2;
        registry.reset();
        for (let k = 0; k < 2; k++) {
            const h = await host('hana');
            await h.room.leave();
            await until(() => registry.rooms.size === 0);
        }
        const c = await player('hana');
        assert.strictEqual((await failure(c.create('world', { ...hello(), world: WORLD, maxPlayers: 4 })))?.code, Reject.LIMIT);
        assert.ok((await host('otto')).welcome.code, 'another account is not held back by it');
    });
});

describe('how much', () => {
    beforeEach(reset);

    it('a request with a body bigger than a game sends is turned away unread — before anyone is asked who they are', async () => {
        const big = JSON.stringify({ junk: 'x'.repeat(4 * 1024 * 1024) });
        for (const path of ['/matchmake/create/world', '/matchmake/joinById/abc', '/auth/guest', '/auth/steam', '/rooms/resolve', '/nowhere']) {
            const r = await fetch(`${URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big }).then(x => x.status, () => 'reset');
            assert.ok(r === 413 || r === 'reset', `${path} answered ${r}`);
        }
        assert.strictEqual(metrics.get('http_body_refused'), 6);
        assert.strictEqual(metrics.get('matchmake_requests'), 0, 'the matchmaker never saw them');
    });

    it('a body that does not say how big it is, is not read either', async () => {
        const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":1}')); c.close(); } });
        const r = await fetch(`${URL}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit).then(x => x.status, () => 'reset');
        assert.ok(r === 411 || r === 'reset', `answered ${r}`);
        assert.strictEqual((await post('/auth/guest')).status, 200, 'an ordinary one is');
    });

    it('however much is refused, only so much is written about it', async () => {
        const lines: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
        config.logLevel = 'warn';
        try {
            const big = 'x'.repeat(40_000);
            await Promise.all(Array.from({ length: 120 }, () => fetch(`${URL}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big }).then(x => x.status, () => 0)));
        } finally { process.stderr.write = write; }
        assert.strictEqual(metrics.get('security_http_body'), 120, 'every one is counted');
        assert.ok(lines.length <= 30, `${lines.length} lines were written`);
        assert.strictEqual(metrics.get('security_lines_suppressed'), 90);
    });
});

describe('how many at once', () => {
    beforeEach(reset);

    it('the server holds only so many rooms', async () => {
        config.maxRooms = 2;
        await host('hana');
        await host('otto');
        const c = await player('pia');
        assert.strictEqual((await failure(c.create('world', { ...hello(), world: WORLD, maxPlayers: 4 })))?.code, Reject.LIMIT);
        assert.strictEqual(registry.rooms.size, 2);
    });

    it('an account hosts one game at a time', async () => {
        await host('hana');
        const c = await player('hana');
        assert.strictEqual((await failure(c.create('world', { ...hello(), world: WORLD, maxPlayers: 4 })))?.code, Reject.LIMIT);
    });

    it('a room holds as many as its host asked for, and no more', async () => {
        const h = await host('hana', { maxPlayers: 2 });
        await join(h.welcome.code, 'gus');
        assert.strictEqual((await failure(join(h.welcome.code, 'ivy')))?.code, Reject.CODE, 'full is locked, and locked says no more than "no such game"');
        assert.strictEqual(h.welcome.max, 2);
    });

    it('the server holds only so many players', async () => {
        config.maxConnections = 2;
        const h = await host('hana');
        await join(h.welcome.code, 'gus');
        assert.strictEqual((await failure(join(h.welcome.code, 'ivy')))?.code, Reject.LIMIT);
        assert.strictEqual((await failure((await player('otto')).create('world', { ...hello(), world: WORLD, maxPlayers: 4 })))?.code, Reject.LIMIT);
    });

    it('one address opens only so many sockets', async () => {
        config.maxConnectionsPerIp = 3;
        const h = await host('hana');
        await join(h.welcome.code, 'gus');
        await join(h.welcome.code, 'ivy');
        await until(() => registry.sockets.total === 3);
        const e = await failure(join(h.welcome.code, 'jay'));
        assert.ok(e, 'the fourth socket is not opened');
        assert.ok(metrics.get('security_socket_limit') >= 1);
        await until(() => roster(h).length === 3);
        assert.strictEqual(registry.players(), 3, 'and the place it was given is not left taken');
    });

    it('a socket that is closed is no longer counted', async () => {
        const h = await host('hana');
        const g = await join(h.welcome.code, 'gus');
        await until(() => registry.sockets.total === 2);
        await g.room.leave();
        await until(() => registry.sockets.total === 1, 2000, 'the count to come down');
        await h.room.leave();
        await until(() => registry.sockets.total === 0 && registry.rooms.size === 0);
    });

    it('a connection that never joins a room is not kept', async () => {
        const WebSocket = (await import('ws')).default;
        const ws = new WebSocket('ws://127.0.0.1:2568/');
        const closed = new Promise<number>(res => ws.on('close', (code) => res(code)));
        await new Promise(res => ws.on('open', res));
        assert.strictEqual(await Promise.race([closed, sleep(3000).then(() => -1)]), 1000, 'let go within a second or so');
        await until(() => registry.sockets.total === 0);
    });

    it('a new client with no token gets nowhere, however many it opens', async () => {
        const attempts = await Promise.all(Array.from({ length: 10 }, () => failure(new Client(URL).create('world', { ...hello(), world: WORLD, maxPlayers: 4 }))));
        assert.ok(attempts.every(e => e?.code === Reject.AUTH));
        assert.strictEqual(registry.rooms.size, 0);
        assert.strictEqual(registry.sockets.total, 0, 'not one socket was opened for them');
    });
});
