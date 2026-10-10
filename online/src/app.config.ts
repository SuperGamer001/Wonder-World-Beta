/**
 * The server, put together: the room, the gate in front of it, the transport
 * and its limits, the HTTP routes, and what happens when it is told to stop.
 *
 * src/index.ts listens with this; the tests boot it as it is.
 */
import { defineServer, defineRoom, monitor, type Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import type { IncomingMessage } from 'node:http';
import { config, assertProductionSafe } from './config.js';
import { log, metrics, netOf } from './log.js';
import { registry } from './registry.js';
import { originAllowed, requestIp, ipKey, limitRequestBodies } from './net.js';
import { initTokens } from './auth/tokens.js';
import { installGate } from './gate.js';
import { bindRoutes, passwordGuard } from './http.js';
import { WorldRoom } from './rooms/WorldRoom.js';
import { ROOM } from './protocol.js';

assertProductionSafe();
initTokens();
installGate();

const transport = new WebSocketTransport({
    // A client that stops answering pings is let go after ~12 seconds.
    pingInterval: 4000,
    pingMaxRetries: 3,
    // The largest frame a client may send (a host's compressed chunk). ws closes anything bigger unread.
    maxPayload: config.maxPayloadBytes,
    // Chunks arrive compressed already, and the rest is small: deflate would cost CPU and memory per socket.
    perMessageDeflate: false,
    /**
     * Before a socket is accepted at all: is it from a page this server
     * serves, and is there room — for it, and for its address?
     */
    verifyClient: (info: { origin: string; req: IncomingMessage }, next: (ok: boolean, code?: number, name?: string) => void) => {
        if (registry.closing) return next(false, 503, 'Restarting');
        if (!originAllowed(info.origin)) { metrics.inc('socket_refused_origin'); return next(false, 403, 'Forbidden'); }
        const ip = requestIp(info.req), key = ipKey(ip);
        if (registry.sockets.total >= config.maxConnections) { metrics.inc('socket_refused_capacity'); return next(false, 503, 'Full'); }
        if (registry.sockets.get(key) >= config.maxConnectionsPerIp) {
            log.security('socket_limit', { net: netOf(ip) });
            return next(false, 429, 'Too Many Connections');
        }
        next(true);
    },
});

// No HTTP listener — Colyseus's matchmaking, or ours — is handed a request with a body bigger than a game sends.
limitRequestBodies(transport.server as import('node:http').Server, (req, status) => {
    metrics.inc('http_body_refused');
    log.security('http_body', { net: netOf(requestIp(req)), status });
});

// Every open socket is counted against the address it came from, until it closes.
(transport as unknown as { wss: { on(ev: string, fn: (...a: any[]) => void): void } }).wss.on('connection', (ws: { once(ev: 'close', fn: () => void): void }, req: IncomingMessage) => {
    const key = ipKey(requestIp(req));
    registry.sockets.inc(key);
    ws.once('close', () => registry.sockets.dec(key));
});

/**
 * What Colyseus itself logs. Its errors arrive as whole stack traces, and some
 * of them anybody can cause at will (a frame too big is one), so each is cut
 * to its first line and counted.
 */
const line = (args: unknown[]) => String(args[0] instanceof Error ? args[0].message : args[0] ?? '').split(/\r?\n/)[0].slice(0, 240);
const frameworkLogger = {
    debug: (...a: unknown[]) => log.debug('colyseus', { message: line(a) }),
    info: (...a: unknown[]) => log.debug('colyseus', { message: line(a) }),
    trace: (...a: unknown[]) => log.debug('colyseus', { message: line(a) }),
    warn: (...a: unknown[]) => log.warn('colyseus', { message: line(a) }),
    error: (...a: unknown[]) => { metrics.inc('framework_errors'); log.warn('colyseus', { message: line(a) }); },
} as unknown as Console;

const server: Server = defineServer({
    transport,
    rooms: {
        [ROOM]: defineRoom(WorldRoom),
    },
    // Restores rooms after a code change. Never in production: it writes room state to disk.
    devMode: false,
    greet: false,
    // @colyseus/auth is here for its JWT helper only: its sign-up, password and OAuth routes are never mounted.
    auth: false,
    logger: frameworkLogger,
    express: (app) => {
        // The Colyseus monitor lists every room and can close them: for an operator, behind a password, or not at all.
        if (config.monitorPassword) {
            app.use('/monitor', passwordGuard('admin', config.monitorPassword), monitor());
        } else if (!config.prod) {
            app.use('/monitor', monitor());
        }
        bindRoutes(app);
    },
});

// SIGTERM / SIGINT (a deploy, a restart): stop taking players, tell every room, then go.
server.onBeforeShutdown(async () => {
    registry.closing = true;
    log.info('server.stopping', { rooms: registry.rooms.size, players: registry.players() });
});
server.onShutdown(async () => {
    log.info('server.stopped');
});

log.info('server.configured', {
    env: config.env, steam: !!(config.steamAppId && config.steamWebApiKey), devAuth: config.devAuth,
    origins: config.allowedOrigins.length, loopback: config.allowLoopbackOrigins, trustProxy: config.trustProxy,
    freeCanHost: config.editions.free.canHost,
});

export default server;
