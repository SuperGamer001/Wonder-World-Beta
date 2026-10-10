/**
 * Steam: is this who they say, and do they own the game?
 *
 * The desktop game asks Steam for an auth ticket made out to this service
 * (`GetAuthTicketForWebApi(identity)`) and sends it here. Two calls to Steam's
 * Web API with the publisher key — which lives only in this server's
 * environment — turn it into facts:
 *
 *   ISteamUserAuth/AuthenticateUserTicket   the ticket is real, was made out to
 *                                           us, and belongs to this Steam id
 *   ISteamUser/CheckAppOwnership            that Steam id owns the game
 *
 * The Steam id a client *says* it has is never read. Without STEAM_APP_ID and
 * STEAM_WEB_API_KEY this is switched off and every player is a guest.
 *
 * `fetchImpl` is swapped out by the tests; nothing else reaches the network.
 */
import { config } from '../config.js';

export interface SteamResult {
    steamId: string;
    owns: boolean;
    /** The library's owner when the game is borrowed through family sharing. */
    ownerSteamId: string;
}

export class SteamError extends Error {
    constructor(public reason: 'disabled' | 'invalid' | 'banned' | 'unavailable', message: string) { super(message); }
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export const steam = {
    fetchImpl: ((url, init) => fetch(url, init)) as FetchLike,

    get enabled(): boolean { return !!(config.steamAppId && config.steamWebApiKey); },

    async call(pathname: string, params: Record<string, string>): Promise<any> {
        const url = new URL(`https://partner.steam-api.com/${pathname}`);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        url.searchParams.set('key', config.steamWebApiKey);
        url.searchParams.set('appid', config.steamAppId);
        let res;
        try {
            res = await this.fetchImpl(url.toString(), { signal: AbortSignal.timeout(config.steamTimeoutMs) });
        } catch {
            // The address carries the key: it must not end up in an error, a log or a reply.
            throw new SteamError('unavailable', 'Steam did not answer');
        }
        if (res.status === 401 || res.status === 403) throw new SteamError('unavailable', 'Steam refused the publisher key');
        if (!res.ok) throw new SteamError('unavailable', `Steam answered ${res.status}`);
        return res.json();
    },

    /** @param ticket the ticket's bytes as hex, as the game sent them */
    async verifyTicket(ticket: unknown): Promise<SteamResult> {
        if (!this.enabled) throw new SteamError('disabled', 'Steam sign-in is not set up on this server');
        if (typeof ticket !== 'string' || !/^[0-9a-fA-F]{32,4096}$/.test(ticket) || ticket.length % 2) {
            throw new SteamError('invalid', 'not a ticket');
        }

        const auth = (await this.call('ISteamUserAuth/AuthenticateUserTicket/v1/', { ticket, identity: config.steamIdentity }))?.response;
        const p = auth?.params;
        if (!p || p.result !== 'OK' || !/^\d{17}$/.test(String(p.steamid ?? ''))) throw new SteamError('invalid', 'Steam did not accept the ticket');
        if (p.vacbanned || p.publisherbanned) throw new SteamError('banned', 'this Steam account is banned from the game');
        const steamId = String(p.steamid), ownerSteamId = /^\d{17}$/.test(String(p.ownersteamid ?? '')) ? String(p.ownersteamid) : steamId;

        const own = (await this.call('ISteamUser/CheckAppOwnership/v2/', { steamid: steamId }))?.appownership;
        let owns = own?.result === 'OK' && own.ownsapp === true;
        // Borrowed from a family member's library: theirs to play, if the publisher allows it.
        if (owns && ownerSteamId !== steamId && !config.steamAllowFamilySharing) owns = false;
        return { steamId, owns, ownerSteamId };
    },
};
