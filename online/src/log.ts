/**
 * Logging and counting.
 *
 * One line of JSON an event, to stdout (the host's log collector takes it from
 * there). Two rules keep the logs from becoming a record of who played what:
 *
 *   • Nobody is named. An account is logged as a short keyed hash of its id
 *     (`acct`), an address as its network (`net`: the first three bytes of an
 *     IPv4 address, the first three groups of an IPv6 one). Enough to see that
 *     one source is misbehaving and to block it; not enough to say who it is.
 *   • Nothing a player made is logged: no names, no chat (there is none), no
 *     world names, no positions, no tokens, no room codes.
 *
 * `metrics` are plain counters and gauges, read at GET /metrics.
 */
import crypto from 'node:crypto';
import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function write(level: Level, event: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[config.logLevel]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
    debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
    info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
    error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
    /**
     * Something worth a second look: a refused token, a flood, a kick. Every
     * one is counted; only so many of a kind are written a minute, because
     * whoever causes them can cause as many as they like, and a full disk is
     * an outage too.
     */
    security: (event: string, fields?: Record<string, unknown>) => {
        metrics.inc(`security_${event}`);
        const now = Date.now();
        let w = written.get(event);
        if (!w || now >= w.until) written.set(event, w = { n: 0, until: now + 60_000 });
        if (++w.n > SECURITY_LINES_PER_MINUTE) { metrics.inc('security_lines_suppressed'); return; }
        write('warn', `security.${event}`, fields);
    },
};

const SECURITY_LINES_PER_MINUTE = 30;
const written = new Map<string, { n: number; until: number }>();

/** An account, for a log line: the same account gives the same tag, and the tag does not give the account. */
export function acctTag(account: string | undefined): string {
    if (!account) return '-';
    return crypto.createHmac('sha256', config.logSalt).update(account).digest('base64url').slice(0, 10);
}

/** An address, for a log line and for per-network counting: its network, not the machine. */
export function netOf(ip: string | undefined): string {
    if (!ip) return 'unknown';
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
    if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
    const groups = ip.split(':');
    return groups.length > 3 ? `${groups.slice(0, 3).join(':')}::/48` : 'unknown';
}

class Metrics {
    private counters = new Map<string, number>();
    private gauges = new Map<string, () => number>();
    readonly started = Date.now();

    inc(name: string, by = 1): void { this.counters.set(name, (this.counters.get(name) ?? 0) + by); }
    get(name: string): number { return this.counters.get(name) ?? 0; }
    gauge(name: string, read: () => number): void { this.gauges.set(name, read); }

    /** Prometheus text format. */
    render(): string {
        const out: string[] = [];
        const safe = (n: string) => `ww_${n.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        for (const [n, read] of [...this.gauges].sort()) out.push(`# TYPE ${safe(n)} gauge`, `${safe(n)} ${read()}`);
        for (const [n, v] of [...this.counters].sort()) out.push(`# TYPE ${safe(n)}_total counter`, `${safe(n)}_total ${v}`);
        return out.join('\n') + '\n';
    }

    reset(): void { this.counters.clear(); written.clear(); }
}

export const metrics = new Metrics();
metrics.gauge('uptime_seconds', () => Math.round((Date.now() - metrics.started) / 1000));
metrics.gauge('memory_rss_bytes', () => process.memoryUsage().rss);
