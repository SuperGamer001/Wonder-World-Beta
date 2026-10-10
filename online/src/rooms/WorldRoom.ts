/**
 * WorldRoom — one world, hosted by one player's game, and everyone in it.
 *
 * The game was built so that every player's game holds the whole world and
 * runs its own player, and the host's also runs what there must be one of:
 * the mobs, the clock, the weather. Online it stays that way — this server
 * does not simulate the world, and the world's saved data never leaves the
 * host's disk. What the room is, is the one place every message goes through,
 * and it is the authority on everything that can be decided without the world:
 *
 *   • Who is here. A player's number, name, look and whether they are the
 *     host are the room's to say (RoomState.ts). A client cannot choose its
 *     number, claim to be the host, or speak for another player: every
 *     message is stamped with the sender the *connection* belongs to.
 *   • Who may say what. Only the host's connection may send the mobs, the
 *     clock, a mob's blow, a kill's drops, or remove a player. Only a guest
 *     may land a blow on a mob.
 *   • What a message may be. Each has a strict schema (validate.ts), a rate
 *     (TokenBucket), and — where the room knows enough to judge — a
 *     plausibility check: a block changed within reach of where its player
 *     is, a blow within reach of the mob, a move no faster than a player goes.
 *   • The order of things. Every accepted block change gets the next number
 *     and goes to everyone, its sender included, so all games end with the
 *     same block where two players changed one at once.
 *
 * What it is *not* the authority on is in docs/SECURITY.md (*What the server
 * cannot check*): it has no copy of the world, so it cannot tell whether a
 * player really had the block they placed, or really was where they say.
 *
 * World data a guest needs (chunks the host has changed, the guest's own
 * saved place) is asked of the host's game through the room and passed back,
 * bounded in size and rate; the room never reads it.
 */
import crypto from 'node:crypto';
import { Room, type Client, type AuthContext, ServerError, matchMaker } from 'colyseus';
import { config, type EditionPolicy } from '../config.js';
import { log, metrics, acctTag } from '../log.js';
import { TokenBucket } from '../limits.js';
import { registry } from '../registry.js';
import { clientIp } from '../net.js';
import { verifySession, playerKey, sameText, type Session } from '../auth/tokens.js';
import { contentFor, isBlock, isLiquid, type Content } from '../content.js';
import {
    C2S, S2C, HostOp, ChunkStatus, RejectWhy, Reject, Close, ClosedReason, StateFlag,
    CODE_ALPHABET, CODE_LENGTH, HARD_MAX_PLAYERS, type Edition,
} from '../protocol.js';
import { RoomState, PlayerInfo } from './RoomState.js';
import { msg, reply as replySchema, hostReply, createOptions, joinOptions, cleanName, cleanSkin, boundedSize, type WorldInfo } from './validate.js';
import type { z } from 'zod';

/** Where room codes are kept: code → room id (Colyseus presence, so it works across processes with Redis). */
export const CODES = 'ww:codes';

/** What static onAuth hands the room about a connection. */
interface Auth extends Session { ip: string }

interface Seat {
    id: number;
    sessionId: string;
    client: Client;
    account: string;
    edition: Edition;
    policy: EditionPolicy;
    slot: number;
    name: string;
    host: boolean;
    /** Where the host keeps this player's saved place (never sent to anyone but the host). */
    key: string;
    connected: boolean;
    /** Removed by the room: no place is held for them. */
    gone: boolean;
    /** Their socket failed on something they sent (a frame too big): likewise. */
    broke: boolean;

    /** The last state passed on, and the place in it. */
    state: number[] | null;
    pos: { x: number; y: number; z: number } | null;
    flags: number;
    dirty: boolean;

    buckets: Map<string, TokenBucket>;
    /** Blocks of level ground this player may still cover: refilled at the speed a player goes. */
    move: TokenBucket;
    /** Jumps that are not movement: a respawn, a spawn point found. A few, not a stream. */
    jumps: TokenBucket;
    violations: number;
    invalid: number;
    windowEnds: number;
    warned: Set<string>;
}

interface Pending {
    op: string;
    resolve: (d: any) => void;
    reject: (why: string) => void;
    timer: ReturnType<typeof setTimeout>;
}

type Rate = readonly [perSecond: number, burst: number];

/**
 * Close codes after which no place is held: the connection broke the protocol
 * (a frame too big, data that is not a message) or Colyseus closed it for
 * sending too much. A line that simply went dead is 1005 / 1006.
 */
const NO_RETURN = new Set([1002, 1003, 1007, 1008, 1009, 4002]);

const REFUSALS = new Set<number>(Object.values(Reject));

const ASK_TIMEOUT_MS = 8000;
const MAX_PENDING_ASKS = 512;
const STATE_HZ = 15;
const ROLE_WEIGHT = 100;          // saying what only the host may say counts a hundred times over

export class WorldRoom extends Room<{ state: RoomState }> {
    state = new RoomState();
    // Colyseus closes a connection that sends more than this in a second, whatever it sends.
    maxMessagesPerSecond = config.rate.messagesPerSecond;
    // The list of players changes rarely; ten patches a second is plenty.
    patchRate = 100;

    private seats = new Map<string, Seat>();          // by session id
    private byId = new Map<number, Seat>();
    private host: Seat | null = null;
    private nextId = 1;

    private code = '';
    private creator = '';
    private world!: WorldInfo;
    private protocol = 0;
    private contentHash = '';
    private content: Content | null = null;
    /** Block ids each edition may not place here. */
    private blocked: Record<Edition, Set<number>> = { full: new Set(), free: new Set() };
    private banned = new Set<string>();
    private closing = false;

    /** Every accepted block change has the next of these. */
    private seq = 0;
    /** The last changes, five numbers each (seq, x, y, z, block), written round and round. */
    private recent!: Float64Array;
    private recentCount = 0;

    private atmos: unknown = null;
    /** Where the host last said each mob is: id → [x, y, z]. */
    private mobs = new Map<number, [number, number, number]>();

    private rid = 0;
    private pending = new Map<number, Pending>();
    private hostAsks!: TokenBucket;
    private relay!: TokenBucket;
    private chunkAsks = new Map<string, Promise<{ s: number; d?: Uint8Array }>>();

    // ── Authentication ────────────────────────────────────────────────────────

    /**
     * Runs before a place in any room is given. The token is the only thing
     * read; what comes back is all the room ever knows of who a connection is.
     */
    static async onAuth(token: string, _options: unknown, context: AuthContext): Promise<Auth> {
        try {
            const session = await verifySession(token);
            return { ...session, ip: clientIp(context?.headers) };
        } catch {
            metrics.inc('auth_rejected');
            throw new ServerError(Reject.AUTH, 'sign in again');
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    async onCreate(options: any) {
        // The matchmaking gate (gate.ts) is the only way a room is made: it has
        // checked the token, the edition and the options, and written down who asked.
        const creator = options?.creator;
        if (typeof creator !== 'string' || !creator) throw new ServerError(Reject.BAD_REQUEST, 'rooms are made through matchmaking');
        const { creator: _c, creatorEdition, ...rest } = options;
        const o = createOptions.parse(rest);
        const edition: Edition = creatorEdition === 'full' ? 'full' : 'free';

        this.creator = creator;
        this.world = o.world;
        this.protocol = o.protocol;
        this.contentHash = o.content;
        this.content = contentFor(o.content);
        this.maxClients = Math.min(o.maxPlayers, config.editions[edition].maxRoomPlayers, HARD_MAX_PLAYERS);
        this.seatReservationTimeout = 20;

        for (const ed of ['full', 'free'] as const) {
            if (!this.content) break;
            const names = new Set(config.editions[ed].blockedBlocks);
            for (const [id, name] of this.content.names) if (names.has(name)) this.blocked[ed].add(id);
        }

        this.recent = new Float64Array(config.recentEdits * 5);
        this.hostAsks = new TokenBucket(config.rate.hostAsksPerSecond, config.rate.hostAsksPerSecond * 2);
        this.relay = new TokenBucket(config.maxRelayBytesPerMinute / 60, config.maxRelayBytesPerMinute);

        // A room is found by its code and by nothing else: it is never matched, never listed.
        this.code = await this.claimCode();
        await this.setMatchmaking({ private: true, unlisted: true, metadata: {} });

        this.registerMessages();
        this.setSimulationInterval(() => this.tick(), 1000 / STATE_HZ);

        registry.rooms.add(this.roomId);
        metrics.inc('rooms_created');
        log.info('room.created', { room: this.roomId, acct: acctTag(creator), edition, max: this.maxClients, known: !!this.content });
    }

    async onJoin(client: Client, options: any, auth: Auth) {
        if (this.closing || registry.closing) throw new ServerError(Reject.CLOSING, 'the game is ending');
        if (!auth?.sub) throw new ServerError(Reject.AUTH, 'sign in again');
        const policy = config.editions[auth.ed];

        // The first to arrive must be whoever asked for the room: they are its host.
        const hosting = !this.host && this.seats.size === 0;
        let hello: { protocol: number; content: string; worldGen: number; name: string; skin?: unknown; slot: number };
        if (hosting) {
            if (auth.sub !== this.creator) throw new ServerError(Reject.CODE, 'not your room');
            const { creator: _c, creatorEdition: _e, ...rest } = options ?? {};
            const o = createOptions.safeParse(rest);
            if (!o.success) throw new ServerError(Reject.BAD_REQUEST, 'bad options');
            hello = o.data;
        } else {
            const o = joinOptions.safeParse(options);
            if (!o.success) throw new ServerError(Reject.BAD_REQUEST, 'bad options');
            // The code is checked again here: knowing a room's id is not an invitation.
            if (!sameText(o.data.code, this.code)) {
                log.security('wrong_code', { room: this.roomId, acct: acctTag(auth.sub) });
                throw new ServerError(Reject.CODE, 'wrong code');
            }
            hello = o.data;
        }
        if (this.banned.has(auth.sub)) throw new ServerError(Reject.BANNED, 'removed by the host');
        if (hello.protocol !== this.protocol) throw new ServerError(Reject.PROTOCOL, 'a different version of the game');
        if (hello.content !== this.contentHash) throw new ServerError(Reject.CONTENT, 'different blocks and biomes');
        if (hello.worldGen < this.world.worldGen) throw new ServerError(Reject.WORLD_GEN, 'this world needs a newer game');

        // One account may bring a few players (a split screen), each in a slot of their own.
        const mine = [...this.seats.values()].filter(s => s.account === auth.sub);
        if (mine.length >= policy.maxLocalPlayers) throw new ServerError(Reject.FULL, 'no more players on this account');
        if (mine.length === 0 && registry.roomsOf(auth.sub) >= config.maxRoomsPerAccount) throw new ServerError(Reject.LIMIT, 'already in another game');
        if (mine.some(s => s.slot === hello.slot)) throw new ServerError(Reject.BAD_REQUEST, 'that player is already here');
        if (hosting && hello.slot !== 0) throw new ServerError(Reject.BAD_REQUEST, 'the host is the first player');

        const id = this.nextId++;
        let name = cleanName(hello.name, `Player ${id}`);
        // Two players of one account are told apart by name where the host keeps their things.
        if (mine.some(s => s.name.toLowerCase() === name.toLowerCase())) name = cleanName(`${name.slice(0, 12)} ${id}`, `Player ${id}`);
        const skin = cleanSkin(hello.skin);
        const now = Date.now();

        const seat: Seat = {
            id, sessionId: client.sessionId, client, account: auth.sub, edition: auth.ed, policy, slot: hello.slot, name,
            host: hosting, key: playerKey(this.creator, auth.sub, name), connected: true, gone: false, broke: false,
            state: null, pos: null, flags: 0, dirty: false,
            buckets: new Map(),
            move: new TokenBucket(config.maxSpeed, config.maxSpeed * 2 + 8, now),
            jumps: new TokenBucket(1 / 3, 3, now),
            violations: 0, invalid: 0, windowEnds: now + 60_000, warned: new Set(),
        };
        this.seats.set(client.sessionId, seat);
        this.byId.set(id, seat);
        // ws reports a frame over the size limit (and other protocol errors) here, just before it closes the socket.
        client.ref.once('error', () => { seat.broke = true; });
        if (hosting) this.host = seat;
        registry.seat(auth.sub, this.roomId);

        const info = new PlayerInfo();
        info.id = id; info.name = name; info.skin = JSON.stringify(skin); info.host = hosting; info.connected = true;
        this.state.players.set(client.sessionId, info);
        if (hosting) this.state.hostId = id;

        const players: [number, number[] | null][] = [];
        for (const s of this.seats.values()) if (s !== seat) players.push([s.id, s.state]);
        client.send(S2C.WELCOME, {
            id, hostId: this.host?.id ?? 0, code: this.code, world: this.world, players, atmos: this.atmos, seq: this.seq,
            edition: auth.ed, canBuild: policy.canBuild, max: this.maxClients,
        });
        metrics.inc('joins');
        log.info('room.join', { room: this.roomId, acct: acctTag(auth.sub), edition: auth.ed, host: hosting, players: this.seats.size });
    }

    /** A line went down that nobody asked to close. */
    onDrop(client: Client, code?: number) {
        const seat = this.seats.get(client.sessionId);
        // Never got in, was removed, or the room is ending: there is no place to hold.
        if (!seat || seat.gone || this.closing) return;
        if (seat.broke || NO_RETURN.has(code ?? 0)) {
            seat.gone = true;
            log.security('bad_close', { room: this.roomId, acct: acctTag(seat.account), code });
            return;
        }
        const grace = seat.host ? config.hostGraceSec : config.guestGraceSec;
        if (grace <= 0) return;
        seat.connected = false;
        const info = this.state.players.get(seat.sessionId);
        if (info) info.connected = false;
        // The host's game is not there to answer: whoever is waiting asks again.
        if (seat.host) this.failPending('away');
        metrics.inc('drops');
        log.info('room.drop', { room: this.roomId, acct: acctTag(seat.account), host: seat.host, code });
        // Not awaited: Colyseus calls onReconnect or onLeave with what came of it.
        this.allowReconnection(client, grace).catch(() => { /* onLeave has it */ });
    }

    onReconnect(client: Client) {
        const seat = this.seats.get(client.sessionId);
        if (!seat) return;
        seat.client = client;
        seat.connected = true;
        const info = this.state.players.get(seat.sessionId);
        if (info) info.connected = true;
        metrics.inc('reconnects');
        log.info('room.reconnect', { room: this.roomId, acct: acctTag(seat.account), host: seat.host });
    }

    /** A player has gone for good: they left, were removed, or did not come back in time. */
    onLeave(client: Client, code?: number) {
        const seat = this.seats.get(client.sessionId);
        if (!seat) return;
        this.seats.delete(seat.sessionId);
        this.byId.delete(seat.id);
        this.state.players.delete(seat.sessionId);
        registry.unseat(seat.account, this.roomId);
        metrics.inc('leaves');
        log.info('room.leave', { room: this.roomId, acct: acctTag(seat.account), host: seat.host, code, players: this.seats.size });
        if (seat.host) {
            // The host's game was the one running the world, and the world is on the host's disk.
            this.host = null;
            this.failPending('away');
            this.close(ClosedReason.HOST, Close.HOST_LEFT);
        }
    }

    async onDispose() {
        this.failPending('closed');
        registry.rooms.delete(this.roomId);
        for (const seat of this.seats.values()) registry.unseat(seat.account, this.roomId);
        this.seats.clear();
        try { if (this.code) await matchMaker.presence.hdel(CODES, this.code); } catch { /* the presence is going too */ }
        metrics.inc('rooms_disposed');
        log.info('room.disposed', { room: this.roomId });
    }

    /** The server is restarting: say so, then let everyone go. */
    onBeforeShutdown() {
        this.close(ClosedReason.SHUTDOWN, Close.SHUTDOWN);
    }

    onUncaughtException(err: Error, method: string) {
        // Turning someone away at the door is not a fault.
        const cause: any = (err as any)?.cause ?? err;
        if (cause instanceof ServerError && REFUSALS.has(cause.code)) return;
        metrics.inc('room_exceptions');
        log.error('room.exception', { room: this.roomId, method, message: String((err as any)?.cause?.message ?? err?.message ?? err).slice(0, 300) });
    }

    /** End the room: everyone is told why, then disconnected. */
    private close(reason: string, code: number) {
        if (this.closing) return;
        this.closing = true;
        this.lock().catch(() => { /* already going */ });
        this.broadcast(S2C.CLOSED, { reason });
        // A moment for the reason to arrive ahead of the close.
        this.clock.setTimeout(() => { this.disconnect(code).catch(() => { /* already disposed */ }); }, 150);
    }

    private async claimCode(): Promise<string> {
        for (let tries = 0; tries < 12; tries++) {
            let code = '';
            for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
            if (await matchMaker.presence.hget(CODES, code)) continue;      // taken: about one in a trillion
            await matchMaker.presence.hset(CODES, code, this.roomId);
            return code;
        }
        throw new ServerError(Reject.LIMIT, 'no room code to be had');
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    /**
     * One message type: who may send it, how often, what it must look like,
     * and what is done with it. Whatever `fn` returns answers a request.
     */
    private on<S extends z.ZodType>(
        type: string, schema: S, rule: { rate: Rate; from?: 'host' | 'guest' },
        fn: (seat: Seat, data: z.infer<S>) => unknown,
    ) {
        this.onMessage(type, (client: Client, raw: unknown) => {
            const seat = this.seats.get(client.sessionId);
            if (!seat || seat.gone || this.closing) return undefined;
            metrics.inc('messages');
            if ((rule.from === 'host') !== seat.host && rule.from !== undefined) {
                // A guest sending the mobs, the clock or a kick; a host "hitting" its own mobs through the room.
                this.violation(seat, 'role', type, ROLE_WEIGHT);
                return undefined;
            }
            if (!this.bucket(seat, type, rule.rate).take()) { this.violation(seat, 'rate', type); return undefined; }
            const parsed = schema.safeParse(raw);
            if (!parsed.success) { this.invalid(seat, type); return undefined; }
            return fn(seat, parsed.data);
        });
    }

    private registerMessages() {
        // ── Everyone ──
        this.on(C2S.STATE, msg.state, { rate: [20, 40] }, (seat, s) => this.onState(seat, s));
        // The outer rate is the flood limit; onBlock has the real ones, which answer with a refusal.
        this.on(C2S.BLOCK, msg.block, { rate: [600, 1200] }, (seat, m) => this.onBlock(seat, m));
        this.on(C2S.PROFILE, msg.profile, { rate: [0.5, 3] }, (seat, m) => {
            const mine = [...this.seats.values()].filter(s => s !== seat && s.account === seat.account);
            const name = cleanName(m.name, seat.name);
            // The name is part of where the host keeps this player's things: it stays as it was at the door.
            const info = this.state.players.get(seat.sessionId);
            if (!info) return;
            if (!mine.some(s => s.name.toLowerCase() === name.toLowerCase())) { seat.name = name; info.name = name; }
            info.skin = JSON.stringify(cleanSkin(m.skin));
        });
        this.on(C2S.SYNC, msg.sync, { rate: [1, 4] }, (_seat, m) => this.editsSince(m.since));

        // ── The host ──
        this.on(C2S.ATMOS, msg.atmos, { rate: [2, 6], from: 'host' }, (seat, m) => {
            this.atmos = m.a;
            this.broadcast(S2C.ATMOS, { a: m.a }, { except: seat.client });
        });
        this.on(C2S.MOBS, msg.mobs, { rate: [14, 28], from: 'host' }, (seat, m) => this.onMobs(seat, m));
        this.on(C2S.ATTACK, msg.attack, { rate: [30, 60], from: 'host' }, (seat, m) => {
            const to = this.byId.get(m.to);
            if (!to || to === seat || to.gone) return;
            to.client.send(S2C.ATTACK, { dmg: Math.min(m.dmg, config.maxHitDamage) });
        });
        this.on(C2S.DROPS, msg.drops, { rate: [10, 30], from: 'host' }, (seat, m) => {
            const to = this.byId.get(m.to);
            if (!to || to === seat || to.gone) return;
            to.client.send(S2C.DROPS, { pos: m.pos, items: m.items });
        });
        this.on(C2S.KICK, msg.kick, { rate: [2, 4], from: 'host' }, (seat, m) => {
            const who = this.byId.get(m.id);
            if (!who || who === seat) return;
            // The account, not the player: its other players on the same screen go too, and none come back.
            this.banned.add(who.account);
            log.info('room.kick', { room: this.roomId, acct: acctTag(who.account) });
            for (const s of [...this.seats.values()]) if (s.account === who.account && !s.host) this.remove(s, Close.KICKED, ClosedReason.KICKED);
        });
        this.on(C2S.LOCK, msg.lock, { rate: [2, 4], from: 'host' }, (_seat, m) => {
            this.state.locked = m.locked;
            (m.locked ? this.lock() : this.unlock()).catch(() => { /* closing */ });
        });
        this.on(C2S.REPLY, replySchema, { rate: [config.rate.hostAsksPerSecond * 2, config.rate.hostAsksPerSecond * 4], from: 'host' }, (seat, m) => {
            const p = this.pending.get(m.rid);
            if (!p) return;                                    // answered already, or it timed out
            this.pending.delete(m.rid);
            clearTimeout(p.timer);
            if (!m.ok) return p.reject('refused');
            const parsed = (hostReply as Record<string, z.ZodType>)[p.op].safeParse(m.d);
            if (!parsed.success) { this.invalid(seat, `${C2S.REPLY}:${p.op}`); return p.reject('invalid'); }
            p.resolve(parsed.data);
        });

        // ── A guest ──
        this.on(C2S.HIT, msg.hit, { rate: [8, 16], from: 'guest' }, (seat, m) => this.onHit(seat, m));
        this.on(C2S.MANIFEST, msg.manifest, { rate: [0.2, 3], from: 'guest' }, async () => {
            try { return await this.ask(HostOp.MANIFEST, {}); } catch { return { retry: true }; }
        });
        this.on(C2S.CHUNK, msg.chunk, { rate: [60, 600], from: 'guest' }, (_seat, m) => this.onChunk(m.cx, m.cz));
        this.on(C2S.PLOAD, msg.pload, { rate: [0.2, 3], from: 'guest' }, async (seat) => {
            try {
                const r = await this.ask(HostOp.PLOAD, { key: seat.key });
                const state = r?.state ?? null;
                return { state: state !== null && boundedSize(state, config.maxPlayerStateBytes) >= 0 ? state : null };
            } catch { return { retry: true }; }
        });
        this.on(C2S.PSAVE, msg.psave, { rate: [1, 6], from: 'guest' }, (seat, m) => {
            if (boundedSize(m.state, config.maxPlayerStateBytes) < 0) return this.invalid(seat, C2S.PSAVE);
            this.ask(HostOp.PSAVE, { key: seat.key, state: m.state }).catch(() => { /* the host is away: the guest saves again later */ });
        });

        // Anything else is not a message this room has.
        this.onMessage('*', (client: Client, type: string | number) => {
            const seat = this.seats.get(client.sessionId);
            if (seat && !seat.gone) this.invalid(seat, `unknown:${String(type).slice(0, 24)}`);
        });
    }

    private bucket(seat: Seat, type: string, rate: Rate): TokenBucket {
        let b = seat.buckets.get(type);
        if (!b) seat.buckets.set(type, b = new TokenBucket(rate[0], rate[1]));
        return b;
    }

    /** Fifteen times a second: everyone who moved, in one message. */
    private tick() {
        if (this.seats.size < 2 || this.closing) return;
        let out: (number | number[])[] | null = null;
        for (const seat of this.seats.values()) {
            if (!seat.dirty) continue;
            seat.dirty = false;
            (out ??= []).push(seat.id, seat.state!);
        }
        if (out) this.broadcast(S2C.STATES, out);
    }

    private onState(seat: Seat, s: number[]) {
        const now = Date.now(), x = s[0], y = s[1], z = s[2];
        if (seat.pos) {
            // Level distance only: a fall is as fast as it is.
            const d = Math.hypot(x - seat.pos.x, z - seat.pos.z);
            if (!seat.move.take(d, now) && !seat.jumps.take(1, now)) {
                // Faster than a player goes, and not one of the few jumps a respawn makes: not passed on.
                metrics.inc('states_refused');
                return this.violation(seat, 'speed', C2S.STATE);
            }
        }
        seat.pos = { x, y, z };
        seat.state = s;
        seat.flags = s[6];
        seat.dirty = true;
    }

    private onBlock(seat: Seat, m: { x: number; y: number; z: number; b: number }) {
        const why = this.blockRefused(seat, m);
        if (why) {
            metrics.inc('blocks_refused');
            this.violation(seat, `block_${why}`, C2S.BLOCK);
            seat.client.send(S2C.REJECT, { x: m.x, y: m.y, z: m.z, why });
            return;
        }
        const seq = ++this.seq, at = ((seq - 1) % config.recentEdits) * 5;
        this.recent[at] = seq; this.recent[at + 1] = m.x; this.recent[at + 2] = m.y; this.recent[at + 3] = m.z; this.recent[at + 4] = m.b;
        this.recentCount = Math.min(this.recentCount + 1, config.recentEdits);
        metrics.inc('blocks');
        // To everyone, the one who made it included: the echo is how its game learns the order.
        this.broadcast(S2C.BLOCK, { x: m.x, y: m.y, z: m.z, b: m.b, id: seat.id, seq });
    }

    private blockRefused(seat: Seat, m: { x: number; y: number; z: number; b: number }): string | null {
        if (this.world.gameMode === 'SPECTATOR') return RejectWhy.MODE;
        if (!seat.policy.canBuild) return RejectWhy.EDITION;
        if (!isBlock(this.content, m.b)) return RejectWhy.BLOCK;
        if (m.b !== 0 && this.blocked[seat.edition].has(m.b)) return RejectWhy.EDITION;
        if (!seat.pos) return RejectWhy.POSITION;
        // Water runs on from where it was poured, block after block, so it is given more room and more rate.
        const liquid = m.b !== 0 && isLiquid(this.content, m.b);
        const d = Math.hypot(m.x + 0.5 - seat.pos.x, m.y + 0.5 - (seat.pos.y + 1), m.z + 0.5 - seat.pos.z);
        if (d > (liquid ? config.fluidReach : config.blockReach)) return RejectWhy.REACH;
        if (!this.bucket(seat, liquid ? 'block:fluid' : 'block:solid', liquid ? [200, 600] : [25, 60]).take()) return RejectWhy.RATE;
        return null;
    }

    /** The changes after number `since`, for a game whose line was down — or `gap` if too many went by. */
    private editsSince(since: number) {
        if (since >= this.seq) return { list: [], seq: this.seq };
        if (this.seq - since > this.recentCount) return { gap: true, seq: this.seq };
        const list: number[] = [];
        for (let seq = since + 1; seq <= this.seq; seq++) {
            const at = ((seq - 1) % config.recentEdits) * 5;
            list.push(this.recent[at + 1], this.recent[at + 2], this.recent[at + 3], this.recent[at + 4]);
        }
        return { list, seq: this.seq };
    }

    private onMobs(seat: Seat, m: { list: number[]; info?: Record<string, unknown> }) {
        const n = m.list.length / 11;
        if (!Number.isInteger(n) || n > config.maxMobs || (m.info && Object.keys(m.info).length > config.maxMobs)) return this.invalid(seat, C2S.MOBS);
        this.mobs.clear();
        for (let i = 0; i < m.list.length; i += 11) this.mobs.set(m.list[i], [m.list[i + 2], m.list[i + 3], m.list[i + 4]]);
        this.broadcast(S2C.MOBS, m, { except: seat.client });
    }

    private onHit(seat: Seat, m: { id: number; dmg: number }) {
        const mob = this.mobs.get(m.id);
        if (!mob || !this.host?.connected) return;             // it has died, or there is nobody to tell
        if (this.world.gameMode === 'SPECTATOR' || (seat.flags & StateFlag.DEAD)) return this.violation(seat, 'hit_mode', C2S.HIT);
        if (!(m.dmg > 0) || m.dmg > config.maxHitDamage) return this.violation(seat, 'hit_damage', C2S.HIT);
        if (!seat.pos || Math.hypot(mob[0] - seat.pos.x, mob[1] - seat.pos.y, mob[2] - seat.pos.z) > config.hitReach) {
            return this.violation(seat, 'hit_reach', C2S.HIT);
        }
        this.host.client.send(S2C.HIT, { from: seat.id, id: m.id, dmg: m.dmg });
    }

    // ── Asking the host ───────────────────────────────────────────────────────

    /** Ask the host's game for something. Rejects if it is away, busy, slow, or answers nonsense. */
    private ask(op: string, payload: Record<string, unknown>): Promise<any> {
        return new Promise((resolve, reject) => {
            const host = this.host;
            if (!host || !host.connected || host.gone || this.closing) return reject('away');
            if (this.pending.size >= MAX_PENDING_ASKS || !this.hostAsks.take()) return reject('busy');
            const rid = ++this.rid;
            const timer = setTimeout(() => { if (this.pending.delete(rid)) reject('timeout'); }, ASK_TIMEOUT_MS);
            this.pending.set(rid, { op, resolve, reject, timer });
            host.client.send(S2C.ASK, { rid, op, ...payload });
        });
    }

    private failPending(why: string) {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(why); }
        this.pending.clear();
    }

    /** One chunk of the host's world, for a guest. Two guests asking for the same one share the asking. */
    private onChunk(cx: number, cz: number): Promise<{ s: number; d?: Uint8Array }> {
        const key = `${cx},${cz}`;
        let job = this.chunkAsks.get(key);
        if (!job) {
            job = this.ask(HostOp.CHUNK, { cx, cz }).then((r: { s: number; d?: Uint8Array }) => {
                if (r.s !== ChunkStatus.DATA && r.s !== ChunkStatus.EDITS) return { s: r.s === ChunkStatus.RETRY ? ChunkStatus.RETRY : ChunkStatus.NONE };
                if (!r.d || r.d.length === 0 || r.d.length > config.maxChunkBytes) return { s: ChunkStatus.NONE };
                // What one room may have passed along in a minute: past it, guests wait.
                if (!this.relay.take(r.d.length)) return { s: ChunkStatus.RETRY };
                metrics.inc('relay_bytes', r.d.length);
                return { s: r.s, d: r.d };
            }, () => ({ s: ChunkStatus.RETRY })).finally(() => this.chunkAsks.delete(key));
            this.chunkAsks.set(key, job);
        }
        return job;
    }

    // ── Misbehaviour ──────────────────────────────────────────────────────────

    private window(seat: Seat) {
        const now = Date.now();
        if (now >= seat.windowEnds) { seat.violations = 0; seat.invalid = 0; seat.windowEnds = now + 60_000; }
    }

    /** A message that was well formed but not allowed: too many, too far, not theirs to send. */
    private violation(seat: Seat, kind: string, type: string, weight = 1) {
        this.window(seat);
        seat.violations += weight;
        metrics.inc(`violation_${kind}`);
        // Once a player a kind: enough to see it, not enough to fill a disk.
        if (!seat.warned.has(kind)) {
            seat.warned.add(kind);
            log.security('violation', { room: this.roomId, acct: acctTag(seat.account), kind, type });
        }
        if (seat.violations > config.rate.violationsPerMinute) {
            log.security('flood_kick', { room: this.roomId, acct: acctTag(seat.account), kind });
            this.remove(seat, Close.FLOOD, ClosedReason.FLOOD);
        }
    }

    /** A message that does not parse: a broken game, or somebody probing. */
    private invalid(seat: Seat, type: string) {
        this.window(seat);
        seat.invalid++;
        metrics.inc('invalid_messages');
        if (!seat.warned.has(`invalid:${type}`)) {
            seat.warned.add(`invalid:${type}`);
            log.security('invalid_message', { room: this.roomId, acct: acctTag(seat.account), type });
        }
        if (seat.invalid > config.rate.invalidPerMinute) {
            log.security('invalid_kick', { room: this.roomId, acct: acctTag(seat.account) });
            this.remove(seat, Close.INVALID, ClosedReason.FLOOD);
        }
    }

    /** Take a player out of the room now; no place is held for them. */
    private remove(seat: Seat, code: number, reason: string) {
        if (seat.gone) return;
        seat.gone = true;
        try { seat.client.send(S2C.CLOSED, { reason }); } catch { /* already gone */ }
        // The host removed (for flooding its own room): the room ends with it, through onLeave.
        seat.client.leave(code);
    }
}
