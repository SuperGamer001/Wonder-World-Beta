/**
 * What every test file shares: one server (booted once, on the testing
 * package's port), a clean slate before each test, and the few moves a test
 * makes over and over — sign in, host a world, join it, wait for a message.
 */
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { Client, type Room } from '@colyseus/sdk';
import { config, loadConfig } from '../src/config.js';
import { registry } from '../src/registry.js';
import { metrics } from '../src/log.js';
import { knownContents } from '../src/content.js';
import { initTokens } from '../src/auth/tokens.js';
import { PROTOCOL, S2C } from '../src/protocol.js';
// A static import, like every other: one copy of the server's modules, which the tests and the server share.
import app from '../src/app.config.js';

export const URL = 'http://127.0.0.1:2568';
export const CONTENT = knownContents()[0];

// The secrets are made up per process; everything else starts from these each test.
const defaults = structuredClone({ ...loadConfig({ NODE_ENV: 'test' }), jwtSecret: config.jwtSecret, playerKeySecret: config.playerKeySecret, logSalt: config.logSalt });

let server: ColyseusTestServer | null = null;

export async function start(): Promise<ColyseusTestServer> {
    if (!server) server = await boot(app);
    return server;
}

/** Before each test: nobody connected, nothing counted, the configuration as it ships for tests. */
export async function reset(): Promise<void> {
    const s = await start();
    await s.cleanup();
    await sleep(20);
    Object.assign(config, structuredClone(defaults));
    initTokens();
    registry.reset();
    metrics.reset();
}

// One server for the whole run, stopped when every file is done (a root hook:
// this module is evaluated once, however many test files import it).
after(async () => {
    await server?.shutdown();
    server = null;
});

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${URL}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, data, headers: res.headers };
}

/** A session token for a made-up account of the given edition (POST /auth/dev). */
export async function token(name: string, edition: 'full' | 'free' = 'full'): Promise<string> {
    const r = await post('/auth/dev', { name, edition });
    if (r.status !== 200) throw new Error(`dev sign-in failed: ${r.status}`);
    return r.data.token;
}

/** An SDK client signed in as `name`. */
export async function player(name: string, edition: 'full' | 'free' = 'full'): Promise<Client> {
    const c = new Client(URL);
    c.auth.token = await token(name, edition);
    return c;
}

export const WORLD = {
    name: 'Test World', seed: 1234, worldGen: 2, terrainStyle: 'smooth' as const, gameMode: 'SURVIVAL' as const,
    difficulty: 'NORMAL' as const, daylightCycle: true, weather: 'dynamic', flat: null,
};

/** What a game says of itself at the door. */
export const hello = (over: Record<string, unknown> = {}) => ({
    protocol: PROTOCOL, version: '0.1.0', content: CONTENT, worldGen: 2, name: 'Player', slot: 0, ...over,
});

/** A room as a test holds it: everything it has been sent, and a way to wait for more. */
export interface Seen {
    room: Room;
    got: { type: string; data: any }[];
    next(type: string, ms?: number): Promise<any>;
    none(type: string, ms?: number): Promise<boolean>;
    welcome: any;
    left: Promise<number>;
}

export async function watch(room: Room): Promise<Seen> {
    const got: Seen['got'] = [], waiting: { type: string; resolve: (d: any) => void }[] = [];
    room.onMessage('*', (type: string | number, data: any) => {
        const t = String(type), i = waiting.findIndex(w => w.type === t);
        if (i >= 0) waiting.splice(i, 1)[0].resolve(data); else got.push({ type: t, data });
    });
    const left = new Promise<number>(resolve => room.onLeave((code: number) => resolve(code)));
    const seen: Seen = {
        room, got, left, welcome: null,
        next(type, ms = 2000) {
            const i = got.findIndex(m => m.type === type);
            if (i >= 0) return Promise.resolve(got.splice(i, 1)[0].data);
            return new Promise((resolve, reject) => {
                const w = { type, resolve };
                waiting.push(w);
                setTimeout(() => { const j = waiting.indexOf(w); if (j >= 0) { waiting.splice(j, 1); reject(new Error(`no "${type}" message`)); } }, ms);
            });
        },
        async none(type, ms = 250) {
            await sleep(ms);
            return !got.some(m => m.type === type);
        },
    };
    seen.welcome = await seen.next(S2C.WELCOME);
    return seen;
}

/** Host a world as `name`. */
export async function host(name = 'hana', over: Record<string, unknown> = {}, edition: 'full' | 'free' = 'full'): Promise<Seen> {
    const c = await player(name, edition);
    const { world = WORLD, maxPlayers = 8, ...rest } = over as any;
    return watch(await c.create('world', { ...hello({ name, ...rest }), world, maxPlayers }));
}

/** The id of the room with this code, as a signed-in game is told it. */
export async function resolve(code: string, tok: string) {
    return post('/rooms/resolve', { code }, { Authorization: `Bearer ${tok}` });
}

/** Join the room with this code as `name`. */
export async function join(code: string, name = 'gus', over: Record<string, unknown> = {}, edition: 'full' | 'free' = 'full'): Promise<Seen> {
    const c = await player(name, edition);
    const r = await resolve(code, c.auth.token!);
    if (r.status !== 200) throw Object.assign(new Error(`resolve ${r.status}`), { status: r.status });
    return watch(await c.joinById(r.data.roomId, { ...hello({ name, ...over }), code }));
}

/** A promise's rejection, or null if it resolved. */
export async function failure(p: Promise<unknown>): Promise<any> {
    try { await p; return null; } catch (e) { return e; }
}

/** A player's state, as packState makes one. */
export const at = (x: number, y: number, z: number, flags = 1, swings = 0) => [x, y, z, 0, 0, 0, flags, swings, 0];

/** Wait until `test` is true (a patch arriving, a room going). Throws after `ms`. */
export async function until(test: () => unknown, ms = 2500, what = 'condition'): Promise<void> {
    const end = Date.now() + ms;
    while (!test()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(15);
    }
}

/** Who a client has been told is in the room: [{ id, name, skin, host, connected }]. */
export function roster(seen: Seen): { id: number; name: string; skin: string; host: boolean; connected: boolean }[] {
    return Object.values((seen.room.state as any).players.toJSON());
}

/** Answer, as the host's game does, what the room asks on a guest's behalf. */
export function serve(h: Seen, handlers: Record<string, (m: any) => unknown>): { asked: any[] } {
    const asked: any[] = [];
    h.room.onMessage('ask', async (m: any) => {
        asked.push(m);
        const d = await handlers[m.op]?.(m);
        h.room.send('reply', d === undefined ? { rid: m.rid, ok: false } : { rid: m.rid, ok: true, d });
    });
    return { asked };
}

/** The game's own source, which is outside this project: imported by address so the compiler does not follow it. */
export function gameModule(file: string): Promise<any> {
    return import('file://' + gamePath(file).replace(/\\/g, '/'));
}
export const gamePath = (file: string) => `${process.cwd()}/../${file}`;
