/**
 * Steam, for the launcher: proving to the online server who is playing.
 *
 * The online server (online/) gives a player the full edition when Steam
 * vouches that they own the game. The page cannot ask Steam for anything —
 * the window has no Node, no preload — so the launcher does: it asks the Steam
 * client for an auth ticket made out to the online server, and the page
 * fetches it through the game's own server (`POST /api/online/steam-ticket`,
 * the same bridge the updater's status uses). The page then sends the ticket
 * to the online server, which checks it with Steam itself. Nothing here, or in
 * the page, is believed by the server: only what Steam says of the ticket.
 *
 * NOT YET EXERCISED AGAINST STEAM. It needs two things this repository does
 * not have, and does nothing without them (the player is then a guest, with
 * the free edition):
 *
 *   1. The Steamworks bindings:  npm install steamworks.js
 *      (a native module: electron-builder must be told to keep it unpacked —
 *      this project ships with asar off, which is already enough).
 *   2. The game's Steam App ID, as STEAM_APP_ID in the environment or in a
 *      `steam_appid.txt` beside the app (which Steam's own tools use too).
 *
 * `STEAM_IDENTITY` must be the same string here and on the online server: a
 * ticket is made out to one service, and is no use to another.
 */
import fs from 'node:fs';
import path from 'node:path';

const IDENTITY = process.env.STEAM_IDENTITY || 'wonder-world-online';
// How long a ticket is left alive for the online server to check it with Steam.
const TICKET_LIFE_MS = 30_000;

function appId(appDir) {
    const fromEnv = Number(process.env.STEAM_APP_ID);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
    try {
        const n = Number(fs.readFileSync(path.join(appDir, 'steam_appid.txt'), 'utf8').trim());
        return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
        return 0;
    }
}

/**
 * Give the game's server a way to fetch Steam tickets, if this is a Steam
 * build running under Steam. Never throws: without Steam the game is simply
 * not signed in to it.
 * @param {{ setOnlineHandlers: Function }} server  the embedded server module
 * @param {string} appDir                            where the app's files are
 */
export async function setupSteam(server, appDir) {
    const id = appId(appDir);
    if (!id) return false;
    let client;
    try {
        // Not a dependency until the game is on Steam (see the note above): looked for, not required.
        const steamworks = (await import('steamworks.js')).default;
        client = steamworks.init(id);
    } catch (err) {
        console.warn('[steam] not available — playing online as a guest:', err?.message ?? err);
        return false;
    }
    server.setOnlineHandlers({
        steamTicket: async () => {
            const ticket = await client.auth.getAuthTicketForWebApi(IDENTITY);
            const hex = Buffer.from(ticket.getBytes()).toString('hex');
            // A ticket is good until it is cancelled. The server needs it for a moment; after that it is only a risk.
            setTimeout(() => { try { ticket.cancel(); } catch { /* already gone */ } }, TICKET_LIFE_MS).unref?.();
            return hex;
        },
    });
    console.log('[steam] signed in to Steam: online play will ask it to vouch for this player');
    return true;
}
