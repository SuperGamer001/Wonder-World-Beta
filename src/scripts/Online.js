/**
 * Online — playing over the internet, as this page does it.
 *
 * The line itself is engine/net/OnlineSession.js, which knows nothing of pages.
 * This is the page's end: where the online server is, the Colyseus SDK (loaded
 * only when someone goes online), who this game is to that server, and the one
 * room this game is in. world.js takes the room from here (`online.session`)
 * in place of its line to the game's own server; players.js (the Players panel,
 * "Join a game") asks for one to be opened or joined.
 *
 * Where the online server is comes from the game itself — `/api/online/config`
 * (the game's own server: WW_ONLINE_URL, or data/online.json as shipped) — and
 * never from the address bar or anything a link could carry: a token, and in
 * the desktop app a Steam ticket, is sent to whatever that says.
 */
import { OnlineSession, OnlineAccount, OnlineWorldClient, OnlineError } from './engine/net/OnlineSession.js';
import * as codec from './engine/net/ChunkCodec.js';
import { contentHash, cleanCode, showCode, HARD_MAX_PLAYERS } from './engine/net/OnlineProtocol.js';

const HERE = (typeof location !== 'undefined' && location.origin && location.origin !== 'null') ? location.origin : 'http://127.0.0.1:3000';
const SDK_SRC = '/node_modules/@colyseus/sdk/dist/colyseus.js';
const GUEST_KEY = 'ww_online_guest';

let _config = null, _sdk = null, _account = null;

/** https, or this machine (a developer's own server): nothing is sent anywhere else. */
function checkedUrl(url) {
    url = String(url ?? '').trim().replace(/\/+$/, '');
    return /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(url) ? url : '';
}

async function config() {
    if (_config) return _config;
    let c = null;
    try {
        const res = await fetch(`${HERE}/api/online/config`, { cache: 'no-store' });
        if (res.ok) c = await res.json();
    } catch { /* below */ }
    if (!c) {
        // A page with no game server behind it: the file as it was shipped.
        try {
            const res = await fetch(`${HERE}/data/online.json`, { cache: 'no-store' });
            if (res.ok) c = await res.json();
        } catch { /* no online play */ }
    }
    return _config = { url: checkedUrl(c?.url), version: String(c?.version ?? '0.0.0'), steam: !!c?.steam };
}

function loadSdk() {
    if (globalThis.Colyseus?.Client) return Promise.resolve(globalThis.Colyseus);
    return _sdk ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SDK_SRC;
        s.onload = () => globalThis.Colyseus?.Client ? resolve(globalThis.Colyseus) : reject(new OnlineError('unreachable'));
        s.onerror = () => { _sdk = null; reject(new OnlineError('unreachable')); };
        document.head.appendChild(s);
    });
}

/**
 * Where a guest's credential is kept: with the player's settings, which the
 * game's own server keeps (the desktop app's page has a new origin, and so
 * empty localStorage, at every launch). A further pane of a split screen reads
 * the first player's, so one machine is one guest.
 */
const guestStore = {
    get() {
        try { return globalThis.getSettings?.().onlineCredential ?? localStorage.getItem(GUEST_KEY); } catch { return null; }
    },
    set(v) {
        try { localStorage.setItem(GUEST_KEY, v); } catch { /* storage unavailable */ }
        try { if (globalThis.getSettings && globalThis.saveSettings) globalThis.saveSettings({ ...globalThis.getSettings(), onlineCredential: v }); } catch { /* likewise */ }
    },
};

async function account() {
    if (_account) return _account;
    const c = await config();
    if (!c.url) throw new OnlineError('unavailable');
    return _account = new OnlineAccount({
        url: c.url, storage: guestStore,
        // In the desktop app the launcher can ask Steam for a ticket; the page cannot.
        steamTicket: c.steam ? async () => {
            const res = await fetch(`${HERE}/api/online/steam-ticket`, { method: 'POST' });
            return res.ok ? (await res.json()).ticket ?? null : null;
        } : null,
    });
}

/** What every game says of itself at the door. */
async function hello({ name, skin, slot = 0, gamepack }) {
    const c = await config();
    const { WORLD_GEN } = await import('./workers/TerrainGenerator.js');
    return { version: c.version, content: contentHash(gamepack), worldGen: WORLD_GEN, name: String(name ?? ''), skin: skin ?? {}, slot };
}

/** A world.json, as a guest's game needs it — and nothing else that is in one. */
function describe(world) {
    if (!Number.isInteger(world.seed) || world.seed < -2147483648 || world.seed > 4294967295) throw new OnlineError('world');
    return {
        name: String(world.name ?? 'World').slice(0, 64),
        seed: world.seed,
        worldGen: world.worldGen ?? 1,
        terrainStyle: world.terrainStyle === 'smooth' ? 'smooth' : 'blocky',
        gameMode: ['SURVIVAL', 'CREATIVE', 'SPECTATOR'].includes(world.gameMode) ? world.gameMode : 'SURVIVAL',
        difficulty: ['PEACEFUL', 'EASY', 'NORMAL', 'HARD'].includes(world.difficulty) ? world.difficulty : 'NORMAL',
        daylightCycle: world.daylightCycle !== false,
        weather: /^[a-z_]{2,32}$/.test(world.weather ?? '') ? world.weather : 'dynamic',
        flat: world.worldType === 'flat' && world.flat ? {
            mode: world.flat.mode === 'biomes' ? 'biomes' : 'layers',
            layers: (world.flat.layers ?? []).slice(0, 16).map(l => ({ block: String(l.block), depth: l.depth })),
            biome: world.flat.biome ?? null,
            decorations: world.flat.decorations !== false,
            structures: !!world.flat.structures,
        } : null,
    };
}

export const online = {
    /** The room this game is in, once it is (an OnlineSession). */
    session: null,
    /** … and whether the world is someone else's, on a machine this one cannot reach. */
    remote: false,

    showCode, cleanCode,

    /** Whether this game has an online server to go to. */
    async available() { return !!(await config()).url; },

    /**
     * Host `world` (a world.json) online. Resolves with the session; its `code` is what guests type.
     * @param {object} who  { name, skin, slot, gamepack }
     */
    async host(world, who) {
        this.release();
        const session = new OnlineSession(await loadSdk(), await account());
        await session.open(await hello(who), describe(world), HARD_MAX_PLAYERS);
        this.session = session;
        this.remote = false;
        return session;
    },

    /**
     * Join the game with this code. `local`: it is hosted on this machine (a
     * further pane of the host's screen), so the world itself is at hand.
     */
    async join(code, who, local = false) {
        this.release();
        const session = new OnlineSession(await loadSdk(), await account());
        await session.enter(code, await hello(who));
        this.session = session;
        this.remote = !local;
        return session;
    },

    /** The host's world, as startWorld() takes one. */
    world() {
        const w = this.session?.world;
        if (!w) return null;
        return {
            id: 'online', online: true, name: w.name, seed: w.seed, worldGen: w.worldGen, terrainStyle: w.terrainStyle,
            gameMode: w.gameMode, difficulty: w.difficulty, daylightCycle: w.daylightCycle, weather: w.weather,
            ...(w.flat ? { worldType: 'flat', flat: w.flat } : {}),
        };
    },

    /** A guest's stand-in for the save server: chunks come from the host, through the room. */
    worldClient(worldState) { return new OnlineWorldClient(this.session, codec, worldState); },

    /** Leave the room and forget it. */
    release() {
        const s = this.session;
        this.session = null;
        this.remote = false;
        s?.close();
    },
};

if (typeof window !== 'undefined') window.__wwOnline = online;
