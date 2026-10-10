/**
 * Limits: how often, and how many at once.
 *
 * Three small tools, all in memory and all bounded:
 *
 *   • TokenBucket — a steady rate with a burst, for one stream of one player's
 *     messages. Costs two numbers.
 *   • KeyedLimiter — so many a window for each key (an address, an account).
 *     Its table cannot grow past `maxKeys`: the oldest keys go first, so a
 *     flood of made-up keys costs a fixed amount of memory and no more.
 *   • Gauge — how many of something each key has open right now.
 *
 * They are per process. Run more than one process and each keeps its own
 * count (docs/OPERATIONS.md, *Scaling*).
 */

export class TokenBucket {
    private tokens: number;
    private at: number;

    /** @param rate tokens a second  @param burst the most that can be saved up */
    constructor(private rate: number, private burst: number, now = Date.now()) {
        this.tokens = burst;
        this.at = now;
    }

    /** Take `n` tokens if they are there. */
    take(n = 1, now = Date.now()): boolean {
        if (now > this.at) {
            this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / 1000 * this.rate);
            this.at = now;
        }
        if (this.tokens < n) return false;
        this.tokens -= n;
        return true;
    }
}

export class KeyedLimiter {
    private hits = new Map<string, { n: number; until: number }>();

    constructor(private max: number, private windowMs: number, private maxKeys = 50_000) {}

    /** Count one for `key`. False when that is one too many for this window. */
    hit(key: string, now = Date.now()): boolean {
        let e = this.hits.get(key);
        if (!e || now >= e.until) {
            if (!e && this.hits.size >= this.maxKeys) this.evict(now);
            e = { n: 0, until: now + this.windowMs };
            // Re-inserting keeps the map in order of when each window began.
            this.hits.delete(key);
            this.hits.set(key, e);
        }
        e.n++;
        return e.n <= this.max;
    }

    /** How many `key` has left in its window, without counting one. */
    remaining(key: string, now = Date.now()): number {
        const e = this.hits.get(key);
        return !e || now >= e.until ? this.max : Math.max(0, this.max - e.n);
    }

    private evict(now: number): void {
        for (const [k, e] of this.hits) if (now >= e.until) this.hits.delete(k);
        // Still full of live windows: the oldest tenth go.
        let drop = this.hits.size >= this.maxKeys ? Math.ceil(this.maxKeys / 10) : 0;
        for (const k of this.hits.keys()) { if (drop-- <= 0) break; this.hits.delete(k); }
    }

    get size(): number { return this.hits.size; }
    reset(): void { this.hits.clear(); }
}

export class Gauge {
    private counts = new Map<string, number>();
    total = 0;

    get(key: string): number { return this.counts.get(key) ?? 0; }

    inc(key: string): number {
        const n = this.get(key) + 1;
        this.counts.set(key, n);
        this.total++;
        return n;
    }

    dec(key: string): void {
        const n = this.get(key);
        if (n <= 0) return;
        if (n === 1) this.counts.delete(key); else this.counts.set(key, n - 1);
        this.total--;
    }

    reset(): void { this.counts.clear(); this.total = 0; }
}
