/**
 * Where a request came from, and whether it may come in.
 *
 * An address is only as good as whoever wrote it down. Behind a reverse proxy
 * (the only way this server should face the internet: the proxy is what speaks
 * TLS) the proxy writes the real address into X-Real-IP, or appends it to
 * X-Forwarded-For — and only then (TRUST_PROXY) are those headers read. The
 * *first* entry of X-Forwarded-For is whatever the client chose to send, so it
 * is the last one, the proxy's own, that is taken. Without a proxy the headers
 * are ignored and the socket's address is used.
 */
import net from 'node:net';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import { config } from './config.js';

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderSource | undefined, name: string): string | undefined {
    if (!h) return undefined;
    const v = typeof (h as Headers).get === 'function' ? (h as Headers).get(name) : (h as any)[name];
    return (Array.isArray(v) ? v[v.length - 1] : v) ?? undefined;
}

/** The address behind a request, or '' when it cannot be known. */
export function clientIp(headers: HeaderSource | undefined, socketAddress?: string): string {
    const clean = (ip: string | undefined) => {
        const s = (ip ?? '').trim().replace(/^::ffff:/, '');
        return net.isIP(s) ? s : '';
    };
    if (config.trustProxy) {
        const real = clean(header(headers, 'x-real-ip'));
        if (real) return real;
        const hops = (header(headers, 'x-forwarded-for') ?? '').split(',');
        const last = clean(hops[hops.length - 1]);
        if (last) return last;
    }
    return clean(socketAddress);
}

/**
 * What limits are counted against: the address itself for IPv4; for IPv6 the
 * /64 it is in, since one subscriber is handed a whole /64 to pick addresses from.
 */
export function ipKey(ip: string): string {
    if (!ip) return 'unknown';
    if (!ip.includes(':')) return ip;
    return ip.split(':').slice(0, 4).join(':') + '::/64';
}

/** Whether a page at `origin` may talk to this server. */
export function originAllowed(origin: string | undefined | null): boolean {
    if (!origin) return config.allowNoOrigin;
    if (config.allowedOrigins.includes(origin)) return true;
    if (config.allowLoopbackOrigins) {
        // The desktop app serves its page from this machine, on a port the system picks.
        try {
            const u = new URL(origin);
            if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return true;
        } catch { /* not an origin */ }
    }
    return false;
}

export const requestIp = (req: IncomingMessage) => clientIp(req.headers, req.socket?.remoteAddress);

/**
 * Turn away, unread, any request whose body is bigger than this server has a
 * use for. Colyseus reads and parses the whole body of a matchmaking request
 * before anything of ours sees it — twenty megabytes of JSON from anybody at
 * all cost a hundred of memory — so the check goes in front of every listener
 * the HTTP server has, by the size the request itself declares. A body with
 * no declared size (chunked) is refused: no game sends one.
 *
 * It is put on the server's `emit`, not among its listeners: Colyseus adds,
 * removes and reorders those as it starts, and this has to be ahead of all of
 * them whenever they arrive.
 */
export function limitRequestBodies(server: HttpServer, onRefused?: (req: IncomingMessage, status: number) => void): void {
    const emit = server.emit.bind(server);
    server.emit = function (event: string, ...args: any[]): boolean {
        if (event !== 'request') return emit(event, ...args);
        const req = args[0] as IncomingMessage, res = args[1] as ServerResponse, method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            const length = Number(req.headers['content-length'] ?? 0);
            const status = req.headers['transfer-encoding'] !== undefined ? 411
                : !Number.isFinite(length) || length < 0 ? 400
                : length > config.maxHttpBodyBytes ? 413 : 0;
            if (status) {
                onRefused?.(req, status);
                res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' });
                res.end('{"error":"request body not accepted"}');
                // Whatever of it is on its way is not read.
                req.socket?.destroySoon?.();
                return true;
            }
        }
        return emit(event, ...args);
    } as HttpServer['emit'];
}
