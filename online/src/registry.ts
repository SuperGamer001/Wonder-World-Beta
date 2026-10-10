/**
 * What this process is holding, counted: rooms, the rooms each account is in,
 * sockets per address — and the limiters that say "not so fast".
 *
 * All of it is this process's own. One process is what this server is built
 * and tested as; docs/OPERATIONS.md (*Scaling*) says what moves to Redis
 * before there is a second.
 */
import { config } from './config.js';
import { KeyedLimiter, Gauge } from './limits.js';
import { metrics } from './log.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;

function makeLimiters() {
    const r = config.rate;
    return {
        matchmake: new KeyedLimiter(r.matchmakePerIp, MINUTE),
        create: new KeyedLimiter(r.createPerAccountPerHour, HOUR),
        auth: new KeyedLimiter(r.authPerIp, MINUTE),
        newGuests: new KeyedLimiter(r.newGuestsPerIpPerHour, HOUR),
        resolveIp: new KeyedLimiter(r.resolvePerIp, MINUTE),
        resolveAccount: new KeyedLimiter(r.resolvePerAccount, MINUTE),
    };
}

export const registry = {
    /** Ids of the rooms alive here. */
    rooms: new Set<string>(),
    /** account → the rooms it has a player in, and how many players in each. */
    accounts: new Map<string, Map<string, number>>(),
    /** Open sockets per address. */
    sockets: new Gauge(),
    limiters: makeLimiters(),
    /** Set while the process is shutting down: nothing new is let in. */
    closing: false,

    roomsOf(account: string): number { return this.accounts.get(account)?.size ?? 0; },
    seatsOf(account: string, roomId: string): number { return this.accounts.get(account)?.get(roomId) ?? 0; },

    seat(account: string, roomId: string): void {
        let rooms = this.accounts.get(account);
        if (!rooms) this.accounts.set(account, rooms = new Map());
        rooms.set(roomId, (rooms.get(roomId) ?? 0) + 1);
    },
    unseat(account: string, roomId: string): void {
        const rooms = this.accounts.get(account);
        if (!rooms) return;
        const n = (rooms.get(roomId) ?? 0) - 1;
        if (n > 0) rooms.set(roomId, n); else rooms.delete(roomId);
        if (rooms.size === 0) this.accounts.delete(account);
    },

    /** Players in every room here. */
    players(): number {
        let n = 0;
        for (const rooms of this.accounts.values()) for (const seats of rooms.values()) n += seats;
        return n;
    },

    /** Start again from nothing, with the limits the configuration has now (tests). */
    reset(): void {
        this.rooms.clear();
        this.accounts.clear();
        this.sockets.reset();
        this.limiters = makeLimiters();
        this.closing = false;
    },
};

metrics.gauge('rooms', () => registry.rooms.size);
metrics.gauge('players', () => registry.players());
metrics.gauge('sockets', () => registry.sockets.total);
