// Who a connection is: tokens, guests, Steam — and everything that is closed
// to a connection that is nobody.
import assert from 'node:assert';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { Client } from '@colyseus/sdk';
import { reset, host, join, player, token, hello, resolve, post, failure, watch, URL, WORLD } from './setup.js';
import { Reject } from '../src/protocol.js';
import { config } from '../src/config.js';
import { metrics } from '../src/log.js';
import { registry } from '../src/registry.js';
import { steam } from '../src/auth/steam.js';
import { verifySession, signSession, signGuestCredential, playerKey } from '../src/auth/tokens.js';

const ISS = 'wonder-world-online', AUD = 'ww-session';
const withToken = (t: string) => { const c = new Client(URL); c.auth.token = t; return c; };
const create = (c: Client) => c.create('world', { ...hello(), world: WORLD, maxPlayers: 4 });

describe('a connection that is nobody', () => {
    beforeEach(reset);

    it('cannot make a room or join one', async () => {
        const h = await host();
        const good = await player('gus');
        const { roomId } = (await resolve(h.welcome.code, good.auth.token!)).data;
        const forged: Record<string, string> = {
            'no token': '',
            'nonsense': 'not.a.token',
            'signed with another secret': jwt.sign({ ed: 'full' }, 'x'.repeat(48), { algorithm: 'HS256', subject: 'dev:mal', issuer: ISS, audience: AUD, expiresIn: 600 }),
            'unsigned (alg none)': `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'dev:mal', ed: 'full', iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.`,
            'out of date': jwt.sign({ ed: 'full' }, config.jwtSecret, { algorithm: 'HS256', subject: 'dev:mal', issuer: ISS, audience: AUD, expiresIn: -10 }),
            'from another issuer': jwt.sign({ ed: 'full' }, config.jwtSecret, { algorithm: 'HS256', subject: 'dev:mal', issuer: 'someone-else', audience: AUD, expiresIn: 600 }),
            'a guest credential, shown as a session': await signGuestCredential('A'.repeat(22)),
            'another algorithm': jwt.sign({ ed: 'full' }, config.jwtSecret, { algorithm: 'HS512', subject: 'dev:mal', issuer: ISS, audience: AUD, expiresIn: 600 }),
            'an account that is not one': jwt.sign({ ed: 'full' }, config.jwtSecret, { algorithm: 'HS256', subject: 'admin', issuer: ISS, audience: AUD, expiresIn: 600 }),
            'an edition that is not one': jwt.sign({ ed: 'god' }, config.jwtSecret, { algorithm: 'HS256', subject: 'dev:mal', issuer: ISS, audience: AUD, expiresIn: 600 }),
        };
        for (const [what, t] of Object.entries(forged)) {
            const c = withToken(t);
            assert.strictEqual((await failure(create(c)))?.code, Reject.AUTH, `create with ${what}`);
            assert.strictEqual((await failure(c.joinById(roomId, { ...hello(), code: h.welcome.code })))?.code, Reject.AUTH, `join with ${what}`);
            assert.strictEqual((await resolve(h.welcome.code, t)).status, 401, `resolve with ${what}`);
        }
        assert.strictEqual(registry.rooms.size, 1, 'nothing was made');
        assert.ok(metrics.get('gate_refused_auth') >= Object.keys(forged).length * 2);
    });

    it('cannot learn whether a room exists', async () => {
        const h = await host();
        const anon = withToken('');
        const real = await failure(anon.joinById(h.room.roomId, { ...hello(), code: h.welcome.code }));
        const none = await failure(anon.joinById('nosuchroom', { ...hello(), code: h.welcome.code }));
        assert.deepStrictEqual([real.code, real.message], [none.code, none.message], 'the same answer either way');
    });

    it('a guest signed with the server\'s own key is still never the full edition', async () => {
        const t = jwt.sign({ ed: 'full' }, config.jwtSecret, { algorithm: 'HS256', subject: `guest:${'A'.repeat(22)}`, issuer: ISS, audience: AUD, expiresIn: 600 });
        await assert.rejects(verifySession(t), /guest edition/);
        assert.strictEqual((await failure(create(withToken(t))))?.code, Reject.AUTH);
    });

    it('a developer\'s token is worth nothing where developer sign-in is off', async () => {
        const t = await token('dev');
        config.devAuth = false;
        await assert.rejects(verifySession(t), /dev token/);
        assert.strictEqual((await failure(create(withToken(t))))?.code, Reject.AUTH);
    });

    it('a session token says who and which edition, and nothing a client sent', async () => {
        const { token: t } = await signSession('steam:76561198000000001', 'full');
        const claims = jwt.decode(t) as Record<string, unknown>;
        assert.deepStrictEqual(Object.keys(claims).sort(), ['aud', 'ed', 'exp', 'iat', 'iss', 'sub']);
        assert.deepStrictEqual(await verifySession(t), { sub: 'steam:76561198000000001', ed: 'full' });
        assert.ok((claims.exp as number) - (claims.iat as number) <= 24 * 60 * 60, 'and not for long');
    });
});

describe('finding a room', () => {
    beforeEach(reset);

    it('takes the code: the room\'s id alone is not an invitation', async () => {
        const h = await host();
        const c = await player('mal');
        assert.strictEqual((await failure(c.joinById(h.room.roomId, { ...hello(), code: 'AAAAAAAA' })))?.code, Reject.CODE);
        assert.strictEqual((await failure(c.joinById(h.room.roomId, hello() as any)))?.code, Reject.BAD_REQUEST, 'no code at all');
        assert.ok(metrics.get('security_wrong_code') >= 1);
    });

    it('a code that is not one, or is nobody\'s, finds nothing — the same nothing', async () => {
        const h = await host();
        const t = await token('gus');
        const answers = [];
        for (const code of ['AAAAAAAA', 'aaaaaaaa', '', 'AAAA', "'; DROP TABLE rooms;--", h.welcome.code.toLowerCase(), h.welcome.code + 'A', '../../etc', '__proto__']) {
            const r = await resolve(code, t);
            answers.push(`${r.status} ${JSON.stringify(r.data)}`);
        }
        assert.deepStrictEqual([...new Set(answers)], ['404 {"error":"no game has that code"}']);
        assert.strictEqual((await resolve(h.welcome.code, t)).data.roomId, h.room.roomId);
    });

    it('there is no way into a room but by its code: nothing matches a stranger in, nothing lists them', async () => {
        await host();
        const c = await player('mal');
        assert.strictEqual((await failure(c.joinOrCreate('world', { ...hello(), code: 'AAAAAAAA' })))?.code, Reject.BAD_REQUEST);
        assert.strictEqual((await failure(c.join('world', { ...hello(), code: 'AAAAAAAA' })))?.code, Reject.BAD_REQUEST);
        for (const path of ['/matchmake/world', '/matchmake', '/rooms', '/rooms/world', '/api/rooms', '/colyseus', '/playground']) {
            const r = await fetch(`${URL}${path}`);
            assert.ok(r.status === 404, `${path} answered ${r.status}`);
        }
    });

    it('a locked room takes nobody new, and says no more than that there is no such game', async () => {
        const h = await host();
        h.room.send('lock', { locked: true });
        await new Promise(r => setTimeout(r, 150));
        const e = await failure(join(h.welcome.code, 'gus'));
        assert.strictEqual(e?.code, Reject.CODE);
        h.room.send('lock', { locked: false });
        await new Promise(r => setTimeout(r, 150));
        assert.ok((await join(h.welcome.code, 'gus')).welcome.id);
    });
});

describe('guests', () => {
    beforeEach(reset);

    it('anybody may be one; the game keeps the credential and is the same guest next time', async () => {
        const a = await post('/auth/guest');
        assert.strictEqual(a.status, 200);
        assert.match(a.data.account, /^guest:[A-Za-z0-9_-]{22}$/);
        assert.strictEqual(a.data.edition, 'free');
        const again = await post('/auth/guest', { credential: a.data.credential });
        assert.strictEqual(again.data.account, a.data.account);
        assert.deepStrictEqual(await verifySession(again.data.token), { sub: a.data.account, ed: 'free' });
    });

    it('a credential that is not one of ours just makes a new guest', async () => {
        const a = await post('/auth/guest');
        const tampered = a.data.credential.slice(0, -4) + 'AAAA';
        for (const credential of [tampered, 'nonsense', 42, { a: 1 }, a.data.token /* a session token is not a credential */]) {
            const r = await post('/auth/guest', { credential });
            assert.strictEqual(r.status, 200);
            assert.notStrictEqual(r.data.account, a.data.account);
        }
    });

    it('a guest joins a game, and does not host one', async () => {
        const h = await host();
        const a = await post('/auth/guest');
        const c = withToken(a.data.token);
        assert.strictEqual((await failure(create(c)))?.code, Reject.EDITION);
        const { roomId } = (await resolve(h.welcome.code, a.data.token)).data;
        const g = await watch(await c.joinById(roomId, { ...hello({ name: 'Guest' }), code: h.welcome.code }));
        assert.strictEqual(g.welcome.edition, 'free');
    });
});

describe('Steam', () => {
    beforeEach(async () => {
        await reset();
        config.steamAppId = '480';
        config.steamWebApiKey = 'PUBLISHER-KEY-THAT-MUST-NOT-LEAK';
    });
    afterEach(() => { steam.fetchImpl = (url, init) => fetch(url, init); });

    const TICKET = 'ab'.repeat(120);
    /** Steam, as the tests have it answer. */
    function fake(o: { result?: string; steamid?: string; owner?: string; owns?: boolean; vac?: boolean; pub?: boolean; status?: number; down?: boolean } = {}) {
        const calls: URL[] = [];
        steam.fetchImpl = async (url) => {
            const u = new globalThis.URL(url);
            calls.push(u);
            if (o.down) throw new Error(`connect ECONNREFUSED ${url}`);
            if (o.status) return { ok: false, status: o.status, json: async () => ({}) };
            if (u.pathname.includes('AuthenticateUserTicket')) {
                return { ok: true, status: 200, json: async () => o.result === 'error'
                    ? { response: { error: { errorcode: 101, errordesc: 'Invalid ticket' } } }
                    : { response: { params: { result: 'OK', steamid: o.steamid ?? '76561198000000001', ownersteamid: o.owner ?? o.steamid ?? '76561198000000001', vacbanned: !!o.vac, publisherbanned: !!o.pub } } } };
            }
            return { ok: true, status: 200, json: async () => ({ appownership: { ownsapp: o.owns !== false, permanent: true, result: 'OK' } }) };
        };
        return calls;
    }

    it('a ticket Steam vouches for, from an account that owns the game, is the full edition', async () => {
        const calls = fake();
        const r = await post('/auth/steam', { ticket: TICKET });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.data.account, r.data.edition], ['steam:76561198000000001', 'full']);
        assert.deepStrictEqual(await verifySession(r.data.token), { sub: 'steam:76561198000000001', ed: 'full' });
        // Steam was asked about this ticket, for this game, made out to this service.
        assert.strictEqual(calls[0].hostname, 'partner.steam-api.com');
        assert.deepStrictEqual([calls[0].searchParams.get('ticket'), calls[0].searchParams.get('appid'), calls[0].searchParams.get('identity')], [TICKET, '480', config.steamIdentity]);
        assert.strictEqual(calls[1].searchParams.get('steamid'), '76561198000000001', 'ownership is asked of the id Steam gave, not one the client did');
        // … and may host.
        assert.ok((await watch(await create(withToken(r.data.token)))).welcome.code);
    });

    it('the Steam id a client claims is never read', async () => {
        fake({ steamid: '76561198000000001' });
        const r = await post('/auth/steam', { ticket: TICKET, steamId: '76561198099999999', steamid: '76561198099999999', account: 'steam:76561198099999999', edition: 'full' });
        assert.strictEqual(r.data.account, 'steam:76561198000000001');
    });

    it('an account that does not own the game plays, as the free edition', async () => {
        fake({ owns: false });
        const r = await post('/auth/steam', { ticket: TICKET });
        assert.deepStrictEqual([r.status, r.data.edition], [200, 'free']);
        assert.strictEqual((await failure(create(withToken(r.data.token))))?.code, Reject.EDITION);
    });

    it('a borrowed library counts, unless the publisher says it does not', async () => {
        fake({ owner: '76561198000000777' });
        assert.strictEqual((await post('/auth/steam', { ticket: TICKET })).data.edition, 'full');
        config.steamAllowFamilySharing = false;
        assert.strictEqual((await post('/auth/steam', { ticket: TICKET })).data.edition, 'free');
    });

    it('a ticket Steam does not accept, or a banned account, is refused without saying which', async () => {
        const answers = [];
        fake({ result: 'error' });
        answers.push(await post('/auth/steam', { ticket: TICKET }));
        fake({ vac: true });
        answers.push(await post('/auth/steam', { ticket: TICKET }));
        fake({ pub: true });
        answers.push(await post('/auth/steam', { ticket: TICKET }));
        fake();
        for (const ticket of ['zz', '', 'ab'.repeat(5), 'abc', 42, null, ['ab'.repeat(40)], 'ab'.repeat(3000), '../../x']) answers.push(await post('/auth/steam', { ticket }));
        assert.deepStrictEqual([...new Set(answers.map(a => `${a.status} ${JSON.stringify(a.data)}`))], ['401 {"error":"not accepted"}']);
    });

    it('when Steam is down the answer is "not now", and the publisher key appears nowhere', async () => {
        const lines: string[] = [];
        const write = process.stderr.write.bind(process.stderr), out = process.stdout.write.bind(process.stdout);
        (process.stderr as any).write = (s: any) => { lines.push(String(s)); return true; };
        (process.stdout as any).write = (s: any) => { lines.push(String(s)); return true; };
        config.logLevel = 'debug';
        let down, refused, limited;
        try {
            fake({ down: true });
            down = await post('/auth/steam', { ticket: TICKET });
            fake({ status: 403 });
            refused = await post('/auth/steam', { ticket: TICKET });
            fake({ status: 429 });
            limited = await post('/auth/steam', { ticket: TICKET });
        } finally {
            process.stderr.write = write; process.stdout.write = out;
        }
        for (const r of [down, refused, limited]) {
            assert.strictEqual(r.status, 503);
            assert.ok(!JSON.stringify(r.data).includes('PUBLISHER'), 'not in the answer');
        }
        assert.ok(lines.length > 0 && !lines.join('').includes('PUBLISHER'), 'not in the log');
    });

    it('with no Steam set up, nobody is the full edition that way', async () => {
        config.steamAppId = ''; config.steamWebApiKey = '';
        const calls = fake();
        const r = await post('/auth/steam', { ticket: TICKET });
        assert.strictEqual(r.status, 503);
        assert.strictEqual(calls.length, 0);
    });

    it('a host knows a guest by a key, not by their Steam id', () => {
        const key = playerKey('steam:76561198000000001', 'steam:76561198000000002', 'Gus');
        assert.match(key, /^[A-Za-z0-9_-]{24}$/);
        assert.ok(!key.includes('7656'));
        assert.strictEqual(key, playerKey('steam:76561198000000001', 'steam:76561198000000002', 'gus'), 'the same player, the same key');
        assert.notStrictEqual(key, playerKey('steam:76561198000000009', 'steam:76561198000000002', 'Gus'), 'another host cannot match their guests against this one\'s');
        assert.notStrictEqual(key, playerKey('steam:76561198000000001', 'steam:76561198000000003', 'Gus'));
    });
});

describe('the server\'s own pages', () => {
    beforeEach(reset);

    it('answers a page that is not its own with nothing a browser will hand over', async () => {
        config.allowedOrigins = ['https://play.example.com'];
        const from = (origin: string, path = '/auth/guest', method = 'POST') =>
            fetch(`${URL}${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });

        for (const origin of ['https://evil.example', 'null', 'https://play.example.com.evil.example']) {
            const r = await from(origin);
            assert.strictEqual(r.status, 403, origin);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), null, origin);
            assert.strictEqual(r.headers.get('access-control-allow-credentials'), null, origin);
            const pre = await fetch(`${URL}/matchmake/create/world`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
            assert.strictEqual(pre.headers.get('access-control-allow-origin'), null, `${origin} preflight`);
            const mm = await from(origin, '/matchmake/create/world');
            assert.strictEqual(mm.headers.get('access-control-allow-origin'), null);
            assert.strictEqual((await mm.json()).code, Reject.AUTH);
        }
        for (const origin of ['https://play.example.com', 'http://127.0.0.1:54321']) {
            const r = await from(origin);
            assert.strictEqual(r.status, 200, origin);
            assert.strictEqual(r.headers.get('access-control-allow-origin'), origin, 'named exactly, never *');
            assert.strictEqual(r.headers.get('set-cookie'), null, 'and no cookie is ever set for a page to send back');
        }
    });

    it('a socket from a page that is not its own is not opened', async () => {
        config.allowedOrigins = ['https://play.example.com'];
        const open = (origin?: string) => new Promise<number | string>((res) => {
            const ws = new WebSocket('ws://127.0.0.1:2568/', origin ? { origin } : {});
            ws.on('unexpected-response', (_q, r) => res(r.statusCode ?? 0));
            ws.on('open', () => { res('open'); ws.close(); });
            ws.on('error', () => res('error'));
        });
        assert.strictEqual(await open('https://evil.example'), 403);
        assert.strictEqual(await open('https://play.example.com'), 'open');
        config.allowNoOrigin = false;
        assert.strictEqual(await open(), 403, 'nor one from no page at all, in production');
    });

    it('sends the headers of an API, and says nothing of what it runs on', async () => {
        const r = await fetch(`${URL}/info`);
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
        assert.strictEqual(r.headers.get('x-powered-by'), null);
        const root = await fetch(`${URL}/`);
        assert.strictEqual(root.status, 404);
        assert.ok(!/colyseus|express|\d+\.\d+\.\d+/i.test(await root.text()));
    });

    it('takes small bodies of JSON and nothing else', async () => {
        const big = await fetch(`${URL}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: 'x'.repeat(20000) }) });
        assert.strictEqual(big.status, 413);
        const broken = await fetch(`${URL}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
        assert.strictEqual(broken.status, 400);
        assert.ok(!(await broken.text()).includes('at '), 'no stack trace');
        const mm = await fetch(`${URL}/matchmake/create/world`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
        assert.ok(mm.status >= 400 && mm.status < 500);
    });

    it('health is for anyone; the counters are for whoever holds the token', async () => {
        assert.strictEqual(await (await fetch(`${URL}/healthz`)).text(), 'ok');
        assert.deepStrictEqual(await (await fetch(`${URL}/readyz`)).json(), { ready: true, rooms: 0, players: 0 });
        assert.strictEqual((await fetch(`${URL}/metrics`)).status, 404, 'no token set: no such page');
        config.metricsToken = crypto.randomBytes(24).toString('hex');
        assert.strictEqual((await fetch(`${URL}/metrics`)).status, 404);
        assert.strictEqual((await fetch(`${URL}/metrics`, { headers: { Authorization: 'Bearer wrong' } })).status, 404);
        await host();
        const r = await fetch(`${URL}/metrics`, { headers: { Authorization: `Bearer ${config.metricsToken}` } });
        const text = await r.text();
        assert.strictEqual(r.status, 200);
        assert.match(text, /^ww_rooms 1$/m);
        assert.match(text, /^ww_players 1$/m);
        assert.match(text, /^ww_rooms_created_total 1$/m);
        assert.ok(!/dev:|steam:|guest:|127\.0\.0\.1/.test(text), 'counts, and nobody in them');
    });

    it('developer sign-in is not there when it is off', async () => {
        assert.strictEqual((await post('/auth/dev', { name: 'x', edition: 'full' })).status, 200);
        config.devAuth = false;
        const r = await post('/auth/dev', { name: 'x', edition: 'full' });
        assert.deepStrictEqual([r.status, r.data], [404, { error: 'not found' }]);
    });
});
