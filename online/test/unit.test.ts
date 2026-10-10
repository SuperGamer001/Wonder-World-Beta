// The small parts by themselves: limits, configuration, addresses, the
// validators — and that the game and the server still speak one protocol.
import assert from 'node:assert';
import fs from 'node:fs';
import { TokenBucket, KeyedLimiter, Gauge } from '../src/limits.js';
import { loadConfig, assertProductionSafe, config } from '../src/config.js';
import { clientIp, ipKey, originAllowed } from '../src/net.js';
import { boundedSize, cleanName, cleanSkin, versionAtLeast, msg, joinOptions, createOptions } from '../src/rooms/validate.js';
import { acctTag, netOf } from '../src/log.js';
import { knownContents, contentFor, isBlock, isLiquid } from '../src/content.js';
import * as server from '../src/protocol.js';
import { hello, WORLD, CONTENT, gameModule, gamePath } from './setup.js';

describe('limits', () => {
    it('a token bucket lets a burst through, then only its rate', () => {
        const b = new TokenBucket(10, 5, 0);
        let ok = 0;
        for (let i = 0; i < 20; i++) if (b.take(1, 0)) ok++;
        assert.strictEqual(ok, 5, 'the burst, and no more');
        assert.strictEqual(b.take(1, 50), false, 'half a token is not one');
        assert.strictEqual(b.take(1, 100), true, 'a tenth of a second earns one');
        assert.strictEqual(b.take(1, 10_000_000), true);
        let saved = 1;
        while (b.take(1, 10_000_000)) saved++;
        assert.strictEqual(saved, 5, 'however long it waits, it saves up no more than its burst');
    });

    it('a keyed limiter counts each key by itself and starts again each window', () => {
        const l = new KeyedLimiter(3, 1000);
        assert.deepStrictEqual([1, 2, 3, 4].map(() => l.hit('a', 0)), [true, true, true, false]);
        assert.strictEqual(l.hit('b', 0), true, 'another key has its own count');
        assert.strictEqual(l.hit('a', 999), false);
        assert.strictEqual(l.hit('a', 1000), true, 'a new window');
        assert.strictEqual(l.remaining('a', 1000), 2);
    });

    it('a flood of made-up keys costs a fixed amount of memory', () => {
        const l = new KeyedLimiter(3, 60_000, 1000);
        for (let i = 0; i < 50_000; i++) l.hit(`k${i}`, 0);
        assert.ok(l.size <= 1000, `the table holds ${l.size}`);
    });

    it('a gauge never goes below nothing', () => {
        const g = new Gauge();
        g.inc('a'); g.inc('a'); g.dec('a'); g.dec('a'); g.dec('a');
        assert.strictEqual(g.get('a'), 0);
        assert.strictEqual(g.total, 0);
    });
});

describe('configuration', () => {
    const good = {
        NODE_ENV: 'production', JWT_SECRET: 'q8Zr2Lx0Vt6Nw4Kd9Hs1Bf7Gy3Pm5Cj8Ua2Xe6', PLAYER_KEY_SECRET: 'M4nB7vC1xZ9lK3jH6gF2dS8aP5oI0uY7tR4eW1',
        ALLOWED_ORIGINS: 'https://play.example.com', TRUST_PROXY: 'true',
    };

    it('a production server with real secrets starts', () => {
        assert.doesNotThrow(() => assertProductionSafe(loadConfig(good)));
    });

    it('production has no secret to fall back on, and says everything that is wrong at once', () => {
        const c = loadConfig({ NODE_ENV: 'production' });
        assert.strictEqual(c.jwtSecret, '');
        assert.throws(() => assertProductionSafe(c), /JWT_SECRET[\s\S]*PLAYER_KEY_SECRET/);
    });

    it('production refuses a short or repetitive secret, one secret used twice, dev sign-in, and loose origins', () => {
        const bad = (over: Record<string, string>, what: RegExp) => assert.throws(() => assertProductionSafe(loadConfig({ ...good, ...over })), what);
        bad({ JWT_SECRET: 'short' }, /JWT_SECRET/);
        bad({ JWT_SECRET: 'a'.repeat(64) }, /JWT_SECRET/);
        bad({ PLAYER_KEY_SECRET: good.JWT_SECRET }, /must differ/);
        bad({ DEV_AUTH: 'true' }, /DEV_AUTH/);
        bad({ ALLOWED_ORIGINS: '*' }, /ALLOWED_ORIGINS/);
        bad({ ALLOWED_ORIGINS: 'http://play.example.com' }, /ALLOWED_ORIGINS/);
        bad({ ALLOWED_ORIGINS: '', ALLOW_LOOPBACK_ORIGINS: 'false' }, /no game could connect/);
        bad({ STEAM_APP_ID: '480' }, /STEAM_APP_ID and STEAM_WEB_API_KEY/);
        bad({ MONITOR_PASSWORD: 'hunter2' }, /MONITOR_PASSWORD/);
        bad({ METRICS_TOKEN: 'short' }, /METRICS_TOKEN/);
    });

    it('production defaults are the careful ones', () => {
        const c = loadConfig(good);
        assert.strictEqual(c.devAuth, false);
        assert.strictEqual(c.allowNoOrigin, false);
        assert.strictEqual(c.allowUnknownContent, false);
        assert.strictEqual(c.editions.free.canHost, false);
    });

    it('outside production the secrets are made up afresh each time', () => {
        const a = loadConfig({}), b = loadConfig({});
        assert.ok(a.jwtSecret.length >= 32 && a.jwtSecret !== b.jwtSecret);
    });

    it('a number that is not one is an error, not a silent default', () => {
        assert.throws(() => loadConfig({ MAX_ROOMS: 'lots' }), /MAX_ROOMS/);
        assert.throws(() => loadConfig({ TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
        assert.throws(() => loadConfig({ EDITION_FREE: '{not json' }), /EDITION_FREE/);
    });

    it('an edition is set as JSON', () => {
        const c = loadConfig({ EDITION_FREE: '{"canHost":true,"maxRoomPlayers":2,"blockedBlocks":["lamp"]}' });
        assert.deepStrictEqual(c.editions.free, { canHost: true, maxRoomPlayers: 2, maxLocalPlayers: 2, canBuild: true, blockedBlocks: ['LAMP'] });
    });
});

describe('addresses', () => {
    afterEach(() => { config.trustProxy = false; config.allowedOrigins = []; config.allowLoopbackOrigins = true; config.allowNoOrigin = true; });

    it('without a proxy, what a client writes in a header is not its address', () => {
        config.trustProxy = false;
        assert.strictEqual(clientIp({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }, '9.9.9.9'), '9.9.9.9');
        assert.strictEqual(clientIp(new Headers({ 'x-forwarded-for': '5.6.7.8' }), undefined), '');
    });

    it('behind a proxy it is what the proxy wrote, not the client, that is taken', () => {
        config.trustProxy = true;
        assert.strictEqual(clientIp({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '6.6.6.6, 5.6.7.8' }, '10.0.0.1'), '1.2.3.4');
        // The first entry is what the client sent; the last is what the proxy saw.
        assert.strictEqual(clientIp({ 'x-forwarded-for': '6.6.6.6, 5.6.7.8' }, '10.0.0.1'), '5.6.7.8');
        assert.strictEqual(clientIp({ 'x-real-ip': 'not an address' }, '::ffff:10.0.0.1'), '10.0.0.1');
    });

    it('limits count an IPv6 subscriber, not each of the addresses it can make up', () => {
        assert.strictEqual(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKey('2001:db8:1:2:1:2:3:4'));
        assert.notStrictEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
        assert.strictEqual(ipKey('1.2.3.4'), '1.2.3.4');
        assert.strictEqual(ipKey(''), 'unknown');
    });

    it('only the pages this server is for may talk to it', () => {
        config.allowedOrigins = ['https://play.example.com'];
        config.allowNoOrigin = false;
        assert.ok(originAllowed('https://play.example.com'));
        assert.ok(originAllowed('http://127.0.0.1:54321'), 'the desktop app');
        assert.ok(originAllowed('http://localhost:3000'));
        for (const o of ['https://evil.example', 'https://play.example.com.evil.example', 'http://play.example.com', 'null', 'https://127.0.0.1:1', 'http://127.0.0.1.evil.example', undefined, '']) {
            assert.strictEqual(originAllowed(o), false, String(o));
        }
        config.allowLoopbackOrigins = false;
        assert.strictEqual(originAllowed('http://127.0.0.1:54321'), false);
    });

    it('a log names nobody', () => {
        const tag = acctTag('steam:76561198000000001');
        assert.ok(tag.length === 10 && !tag.includes('7656'));
        assert.strictEqual(tag, acctTag('steam:76561198000000001'), 'the same account, the same tag');
        assert.notStrictEqual(tag, acctTag('steam:76561198000000002'));
        assert.strictEqual(netOf('203.0.113.77'), '203.0.113.0/24');
        assert.strictEqual(netOf('2001:db8:1:2::9'), '2001:db8:1::/48');
    });
});

describe('what a message may be', () => {
    it('plain data of a bounded size, and nothing else', () => {
        assert.ok(boundedSize({ a: [1, 'two', null, true, { b: 2 }] }, 1000) > 0);
        assert.strictEqual(boundedSize('x'.repeat(600), 1000), -1, 'too big');
        assert.strictEqual(boundedSize({ a: NaN }, 1000), -1);
        assert.strictEqual(boundedSize({ a: Infinity }, 1000), -1);
        assert.strictEqual(boundedSize({ a: undefined }, 1000), -1);
        assert.strictEqual(boundedSize(new Map(), 1000), -1);
        assert.strictEqual(boundedSize(new Date(), 1000), -1);
        assert.strictEqual(boundedSize(new Uint8Array(4), 1000), -1);
        assert.strictEqual(boundedSize(JSON.parse('{"__proto__":{"x":1}}'), 1000), -1, 'no reaching for a prototype');
        assert.strictEqual(boundedSize({ constructor: 1 }, 1000), -1);
        let deep: any = 1;
        for (let i = 0; i < 20; i++) deep = [deep];
        assert.strictEqual(boundedSize(deep, 1000), -1, 'too deep');
        const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, 0]));
        assert.strictEqual(boundedSize(wide, 1000), -1, 'many small things are a big thing');
    });

    it('a name is letters, digits and a few marks, sixteen at most', () => {
        assert.strictEqual(cleanName('  Ann   Lee  ', 'x'), 'Ann Lee');
        assert.strictEqual(cleanName('<img src=x onerror=alert(1)>', 'x'), 'img srcx onerror');
        assert.strictEqual(cleanName('a'.repeat(40), 'x').length, 16);
        assert.strictEqual(cleanName('‮evil\u0000', 'x'), 'evil');
        assert.strictEqual(cleanName('', 'Player 3'), 'Player 3');
        assert.strictEqual(cleanName({ toString: () => 'obj' }, 'Player 3'), 'Player 3');
    });

    it('a look is small whole numbers by name; the rest is dropped', () => {
        assert.deepStrictEqual(cleanSkin({ hair: 2, outfit: 1, evil: 'x', big: 999, neg: -1, 'bad key': 1, half: 1.5 }), { hair: 2, outfit: 1 });
        assert.deepStrictEqual(cleanSkin([1, 2]), {});
        assert.deepStrictEqual(cleanSkin(null), {});
        const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${String.fromCharCode(97 + i % 26)}${String.fromCharCode(97 + (i / 26 | 0))}`, 1]));
        assert.strictEqual(Object.keys(cleanSkin(many)).length, 24);
    });

    it('versions compare as numbers', () => {
        assert.ok(versionAtLeast('0.10.0', '0.9.0'));
        assert.ok(versionAtLeast('1.0.0-beta.1', '1.0.0'));
        assert.ok(!versionAtLeast('0.9.9', '1.0.0'));
        assert.ok(!versionAtLeast('nonsense', '1.0.0'));
    });

    it('a state is nine finite numbers inside the world', () => {
        const ok = [0, 70, 0, 0, 0, 0, 1, 0, 0];
        assert.ok(msg.state.safeParse(ok).success);
        for (const bad of [
            [...ok, 1], ok.slice(1), [NaN, 70, 0, 0, 0, 0, 1, 0, 0], [Infinity, 70, 0, 0, 0, 0, 1, 0, 0], [3e6, 70, 0, 0, 0, 0, 1, 0, 0],
            [0, 9999, 0, 0, 0, 0, 1, 0, 0], [0, 70, 0, 0, 0, 0, 16, 0, 0], [0, 70, 0, 0, 0, 0, 1.5, 0, 0], ['0', 70, 0, 0, 0, 0, 1, 0, 0], {}, null, 'state',
        ]) assert.ok(!msg.state.safeParse(bad).success, JSON.stringify(bad));
    });

    it('a block is four whole numbers inside the world, and nothing more', () => {
        assert.ok(msg.block.safeParse({ x: 1, y: 64, z: -3, b: 7 }).success);
        for (const bad of [
            { x: 1, y: 64, z: -3 }, { x: 1.5, y: 64, z: -3, b: 7 }, { x: 1, y: 400, z: -3, b: 7 }, { x: 1, y: -129, z: -3, b: 7 },
            { x: 2_000_001, y: 64, z: 0, b: 7 }, { x: 1, y: 64, z: -3, b: -1 }, { x: 1, y: 64, z: -3, b: 65536 }, { x: 1, y: 64, z: -3, b: 7, id: 1 },
            { x: '1', y: 64, z: -3, b: 7 }, [1, 64, -3, 7],
        ]) assert.ok(!msg.block.safeParse(bad).success, JSON.stringify(bad));
    });

    it('options at the door are strict: nothing a client adds is carried in', () => {
        assert.ok(joinOptions.safeParse({ ...hello(), code: 'ABCDEFGH' }).success);
        assert.ok(!joinOptions.safeParse({ ...hello(), code: 'ABCDEFGH', edition: 'full' }).success);
        assert.ok(!joinOptions.safeParse({ ...hello(), code: 'ABCDEFGH', creator: 'steam:1' }).success);
        assert.ok(!joinOptions.safeParse({ ...hello(), code: 'abcdefgh' }).success, 'a code is in the code alphabet');
        assert.ok(!joinOptions.safeParse({ ...hello({ slot: 4 }), code: 'ABCDEFGH' }).success);
        assert.ok(createOptions.safeParse({ ...hello(), world: WORLD, maxPlayers: 8 }).success);
        assert.ok(!createOptions.safeParse({ ...hello(), world: { ...WORLD, gameMode: 'GOD' }, maxPlayers: 8 }).success);
        assert.ok(!createOptions.safeParse({ ...hello(), world: { ...WORLD, extra: 1 }, maxPlayers: 8 }).success);
        assert.ok(!createOptions.safeParse({ ...hello(), world: WORLD, maxPlayers: 9 }).success);
        assert.ok(!createOptions.safeParse({ ...hello({ content: 'zz' }), world: WORLD, maxPlayers: 8 }).success);
    });
});

describe('the game and the server', () => {
    it('speak the same protocol', async () => {
        const game = await gameModule('src/scripts/engine/net/OnlineProtocol.js');
        for (const name of ['PROTOCOL', 'MIN_PROTOCOL', 'ROOM', 'C2S', 'S2C', 'HostOp', 'ChunkStatus', 'RejectWhy', 'Reject', 'Close', 'ClosedReason',
            'WORLD', 'StateFlag', 'MAX_NAME', 'MAX_SKIN_KEYS', 'MAX_LOCAL_PLAYERS', 'HARD_MAX_PLAYERS', 'CODE_ALPHABET', 'CODE_LENGTH']) {
            assert.deepStrictEqual(game[name], (server as any)[name], `${name} differs between src/scripts/engine/net/OnlineProtocol.js and online/src/protocol.ts`);
        }
    });

    it('a refusal at the door is a status an HTTP answer can carry', () => {
        for (const [name, code] of Object.entries(server.Reject)) assert.ok(code >= 400 && code <= 499, name);
        for (const [name, code] of Object.entries(server.Close)) assert.ok(code >= 4011 && code <= 4999, `${name} is an application close code`);
    });

    it('the server knows the blocks of the game in this repository (npm run content)', async () => {
        const game = await gameModule('src/scripts/engine/net/OnlineProtocol.js');
        const read = (dir: string) => fs.readdirSync(gamePath(`data/${dir}`)).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(gamePath(`data/${dir}/${f}`), 'utf8')));
        const hash = game.contentHash({ blocks: read('blocks'), biomes: read('biomes'), terrain: read('terrain') });
        assert.ok(knownContents().includes(hash), `the game data has changed: run "npm run content" in online/ (fingerprint ${hash})`);
        const content = contentFor(hash)!;
        assert.strictEqual(content.names.get(5), 'WATER');
        assert.ok(isLiquid(content, 5) && !isLiquid(content, 3));
        assert.ok(isBlock(content, 43) && !isBlock(content, 9999) && !isBlock(content, -1) && !isBlock(content, 1.5));
        assert.ok(isBlock(null, 9999), 'a game the server does not know is only range-checked');
        assert.strictEqual(CONTENT, hash);
    });

    it('the fingerprint is of what the world is made of, not of how it looks or what order it was read in', async () => {
        const { contentHash } = await gameModule('src/scripts/engine/net/OnlineProtocol.js');
        const blocks = [{ id: 1, name: 'GRASS', terrainType: 'mesh', texture: 'a.png' }, { id: 2, name: 'DIRT', terrainType: 'mesh' }];
        const biomes = [{ name: 'PLAINS', mapColor: '#fff', surface: { top: 'GRASS' } }];
        const base = contentHash({ blocks, biomes, terrain: [] });
        assert.match(base, /^[0-9a-f]{28}$/);
        assert.strictEqual(contentHash({ blocks: [...blocks].reverse(), biomes, terrain: [] }), base, 'order');
        assert.strictEqual(contentHash({ blocks: [{ ...blocks[0], texture: 'hd.png', color: [1, 1, 1] }, blocks[1]], biomes: [{ ...biomes[0], mapColor: '#000' }], terrain: [] }), base, 'looks');
        assert.notStrictEqual(contentHash({ blocks: [{ ...blocks[0], name: 'LAWN' }, blocks[1]], biomes, terrain: [] }), base, 'a block renamed');
        assert.notStrictEqual(contentHash({ blocks: [...blocks, { id: 3, name: 'STONE' }], biomes, terrain: [] }), base, 'a block added');
        assert.notStrictEqual(contentHash({ blocks, biomes: [{ ...biomes[0], surface: { top: 'DIRT' } }], terrain: [] }), base, 'a biome changed');
    });
});
