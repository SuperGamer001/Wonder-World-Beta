/**
 * What every game in a room is kept told of without asking: who is here.
 *
 * This is the part of a room that Colyseus synchronises by itself — a change
 * here reaches every client as a small patch, and a client that reconnects is
 * sent the whole of it again, so the list of players cannot go stale across a
 * dropped line. Everything fast (where the players are, the blocks, the mobs)
 * goes as messages instead: see WorldRoom.ts.
 *
 * Nothing here says who a player *is*: no account, no edition, no address.
 */
import { schema, t, type SchemaType } from '@colyseus/schema';

export const PlayerInfo = schema({
    /** The player's number in this room: given by the server, never used twice. */
    id: t.uint16(),
    name: t.string(),
    /** Their look, as JSON: a few small whole numbers by name. */
    skin: t.string(),
    host: t.boolean(),
    /** False while their line is down and their place is being held. */
    connected: t.boolean().default(true),
}, 'PlayerInfo');
export type PlayerInfo = SchemaType<typeof PlayerInfo>;

export const RoomState = schema({
    /** By session id. */
    players: t.map(PlayerInfo),
    hostId: t.uint16(),
    /** The host has shut the door: nobody new comes in. */
    locked: t.boolean(),
}, 'RoomState');
export type RoomState = SchemaType<typeof RoomState>;
