/**
 * The gate: everything that asks for a place in a room comes through here first.
 *
 * Colyseus answers POST /matchmake/<method>/<room> itself, ahead of any Express
 * middleware, and for `joinById` it looks the room up *before* it authenticates
 * — so, left alone, anybody could ask "is there a room called X?" as fast as
 * they liked, and anybody with a token could have a room made. The matchmaker's
 * controller is the documented place to change that (it is where CORS is set),
 * and its one entry point is wrapped here:
 *
 *   • only `create`, `joinById` and `reconnect` exist. Rooms are private and
 *     found by code, so the methods that match a stranger into a room are off;
 *   • every call is counted against the address it came from;
 *   • `create` and `joinById` need a session token that verifies *before*
 *     anything is looked up or made, and options that parse;
 *   • a room is made only by an edition that may host, on a version and
 *     content this server accepts, within the limits on rooms — and the gate
 *     writes down who asked (`creator`), which is how the room knows its host.
 *     A client cannot write that field: it is stripped from what they send.
 */
import { matchMaker, ServerError } from 'colyseus';
import { config } from './config.js';
import { log, metrics, acctTag, netOf } from './log.js';
import { clientIp, ipKey, originAllowed } from './net.js';
import { registry } from './registry.js';
import { verifySession } from './auth/tokens.js';
import { contentFor } from './content.js';
import { PROTOCOL, MIN_PROTOCOL, ROOM, Reject } from './protocol.js';
import { createOptions, joinOptions, versionAtLeast } from './rooms/validate.js';

const OURS = new Set<number>(Object.values(Reject));

/** Fields of the options that only this server writes. */
const SERVER_FIELDS = ['creator', 'creatorEdition'];

function refuse(code: number, message: string, why: string): never {
    metrics.inc(`gate_refused_${why}`);
    throw new ServerError(code, message);
}

function checkHello(o: { protocol: number; version: string }) {
    if (o.protocol < MIN_PROTOCOL || o.protocol > PROTOCOL) refuse(Reject.PROTOCOL, 'update the game to play online', 'protocol');
    if (config.minGameVersion && !versionAtLeast(o.version, config.minGameVersion)) refuse(Reject.VERSION, 'update the game to play online', 'version');
}

let installed = false;

export function installGate(): void {
    if (installed) return;
    installed = true;
    const controller = matchMaker.controller;
    controller.exposedMethods = ['create', 'joinById', 'reconnect'];

    // A page elsewhere on the web does not get to call this server from a player's browser.
    // An origin that is not allowed is given no Access-Control-Allow-Origin at
    // all, and the browser throws the answer away. (Not "null": that is the
    // origin of a sandboxed frame, and would let one in.)
    //
    // Allow-Credentials goes only with an allowed origin, named exactly. It is
    // there because the SDK asks for it (its requests are made "with
    // credentials", and a browser throws away the answer otherwise) — not
    // because there are any: this server sets no cookie, and a token travels
    // in a header the page has to add itself.
    const defaults = controller.DEFAULT_CORS_HEADERS as Record<string, string>;
    delete defaults['Access-Control-Allow-Origin'];
    delete defaults['Access-Control-Allow-Credentials'];
    controller.getCorsHeaders = function (headers: Headers): any {
        const origin = headers.get('origin');
        return origin && originAllowed(origin)
            ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' }
            : { 'Vary': 'Origin' };
    };

    const invoke = controller.invokeMethod.bind(controller);
    controller.invokeMethod = async function (method: string, roomName: string, clientOptions: any = {}, auth: any) {
        metrics.inc('matchmake_requests');
        if (registry.closing) refuse(Reject.CLOSING, 'the server is restarting', 'closing');
        const ip = clientIp(auth?.headers), key = ipKey(ip);
        if (!registry.limiters.matchmake.hit(key)) {
            log.security('matchmake_rate', { net: netOf(ip) });
            refuse(Reject.LIMIT, 'too many attempts: wait a minute', 'rate');
        }
        if (!originAllowed(auth?.headers?.get?.('origin'))) refuse(Reject.AUTH, 'not from here', 'origin');
        if (!controller.exposedMethods.includes(method)) refuse(Reject.BAD_REQUEST, 'no such method', 'method');

        // A reconnection carries its own secret (the token the room gave that connection).
        if (method === 'reconnect') return invoke(method, roomName, clientOptions, auth);

        const session = await verifySession(auth?.token).catch(() => null);
        if (!session) refuse(Reject.AUTH, 'sign in again', 'auth');
        if (!clientOptions || typeof clientOptions !== 'object' || Array.isArray(clientOptions)) refuse(Reject.BAD_REQUEST, 'bad options', 'options');
        for (const f of SERVER_FIELDS) delete clientOptions[f];

        if (method === 'create') {
            if (roomName !== ROOM) refuse(Reject.BAD_REQUEST, 'no such room', 'room');
            const o = createOptions.safeParse(clientOptions);
            if (!o.success) refuse(Reject.BAD_REQUEST, 'bad options', 'options');
            checkHello(o.data);
            if (!config.editions[session.ed].canHost) refuse(Reject.EDITION, 'this edition cannot host a game', 'edition');
            if (!contentFor(o.data.content) && !config.allowUnknownContent) refuse(Reject.CONTENT, 'this server does not know this version of the game', 'content');
            if (o.data.world.worldGen > o.data.worldGen) refuse(Reject.BAD_REQUEST, 'bad options', 'options');
            if (registry.roomsOf(session.sub) >= config.maxRoomsPerAccount) refuse(Reject.LIMIT, 'already in another game', 'account_rooms');
            if (registry.rooms.size >= config.maxRooms || registry.players() >= config.maxConnections) refuse(Reject.LIMIT, 'the server is full: try again later', 'capacity');
            if (!registry.limiters.create.hit(session.sub)) {
                log.security('create_rate', { acct: acctTag(session.sub) });
                refuse(Reject.LIMIT, 'too many games started: wait a while', 'create_rate');
            }
            clientOptions.creator = session.sub;
            clientOptions.creatorEdition = session.ed;
        } else {
            if (typeof roomName !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(roomName)) refuse(Reject.BAD_REQUEST, 'no such room', 'room');
            const o = joinOptions.safeParse(clientOptions);
            if (!o.success) refuse(Reject.BAD_REQUEST, 'bad options', 'options');
            checkHello(o.data);
            if (registry.players() >= config.maxConnections) refuse(Reject.LIMIT, 'the server is full: try again later', 'capacity');
        }

        try {
            return await invoke(method, roomName, clientOptions, auth);
        } catch (e: any) {
            // "No such room" and "that room is locked" are one answer: a room's id is not for guessing at.
            if (method === 'joinById' && !OURS.has(e?.code)) refuse(Reject.CODE, 'no such game', 'no_room');
            throw e;
        }
    };
}
