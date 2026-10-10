# Online multiplayer — architecture and migration plan

This document has four parts: how multiplayer worked before there was an
online server; what online play adds and why it is shaped the way it is; the
plan, with what is done and what is next; and the assumptions made along the
way that are yours to confirm or correct.

---

## 1. What the game already had

Found by reading `server/multiplayer.js`, `server/server.js`,
`src/scripts/engine/Multiplayer.js`, `src/scripts/world.js`, `src/players.js`,
`src/scripts/Players.js`, `src/scripts/engine/EntityManager.js`, `index.js`
and `electron/main.js`.

### Transport

One WebSocket per game to the game's **own server** (`server/server.js`:
Express and `ws`, started in-process by the desktop app, loopback only). JSON
text frames carry multiplayer (`mp:*`); binary frames carry chunk saves and
loads. For the local network a second listener is opened on all interfaces
(`/api/lan/open`), behind an allow-list of what a guest may fetch, with a UDP
beacon for discovery. A LAN guest loads the *host's copy of the game* from that
listener, so versions always match.

### The session, and who runs what

Every world is a session on that server (`MultiplayerHub`). **The first to
join is the host.** Every game holds the whole world and simulates its own
player; the host's game also simulates what there must be one of.

| | Run by | How it reaches the others |
|---|---|---|
| A player (position, look, health, inventory) | that player's game | `mp:state` 15×/s, passed on unread |
| Blocks | whoever changes one | `mp:block`, passed on; kept in a per-session **journal** handed to newcomers |
| Mobs | the host's game | `mp:all {t:'mobs'}` 10×/s; guests show replicas. A guest's blow goes to the host (`mp:host {t:'hit'}`); a mob's blow and a kill's drops go to one player (`mp:to`) |
| Clock and weather | the host's game | `mp:atmos` every 2 s (the one message the server checks the sender of) |

The server relays; apart from `mp:atmos` and the shape of `mp:block` it does
not look inside anything. When the host leaves, the session ends.

### World data

The world lives on the host's disk (region files through the game's own
server). On a LAN, guests read and write chunks through the host's listener
directly, and keep their own place in the world in a file of their own
(`players/<key>.json`).

### Identity

There is none to speak of. A player is a name and a look, chosen from a list
kept in `settings.json`; a machine has a random `clientId`. A session player id
is a counter. Everything is whatever the client says.

### Split screen

`index.js` opens a second copy of the game in an iframe beside the first
(`?pane=…&pad=…`). **Each pane is a whole game with its own connection**, and
joins the session as its own player. That is what "several local players
through one computer" means in this codebase: several connections from one
machine.

### What that means for going online

Three things do not survive the trip to the internet as they are:

1. **Nothing is checked.** On a LAN everyone is in the same room in the
   literal sense. Online, any message may be hostile.
2. **Nobody is anybody.** There has to be something a server can believe
   about who a connection is — and, with a paid and a free edition, about
   which edition it has.
3. **A guest cannot reach the host's machine.** Chunks and saved player state
   came straight from the host's listener. Online there is only the server in
   between.

---

## 2. What online play is

```
 desktop game (Steam) ─┐                              ┌─ the world's saved data
   split-screen panes ─┤                              │  (host's disk, as before)
                       ├─ wss ──  online server  ── wss ──  the HOST's game
 browser game (free)  ─┤          (this folder)             (simulates mobs, clock,
   its panes          ─┘                                     weather — as before)
```

### The decision that shapes everything: the host still hosts

The server does **not** simulate the world. A world online is hosted by one
player's game, as it is on a LAN, and the world's data never leaves the host's
disk. The server is an **authoritative relay**: every message goes through it,
and it is the authority on everything that can be decided without a copy of
the world.

Why not a fully server-run simulation:

- It would mean running terrain generation, smooth-terrain collision, mob AI
  and physics on the server for every room — most of the engine, ported and
  kept in step for ever. The brief was to preserve the gameplay code.
- It would mean the server storing every world: storage, backups, and a bill
  that grows with every player, for a game sold once.
- The game is co-operative building. The thing most worth protecting is the
  host's world and the players' identities, and both can be protected without
  simulating anything.

What it costs — the server cannot verify what only the world knows — is listed
honestly in [SECURITY.md](SECURITY.md) (*What the server cannot check*).

### What the server is the authority on

| | How |
|---|---|
| **Who a connection is** | A session token the server itself issued (`auth/tokens.ts`), after Steam vouched for a ticket (`auth/steam.ts`) or as an anonymous guest. Nothing a client says about itself is read as a fact |
| **Which edition** | In the token: `full` only if Steam says the account owns the game. The free edition's limits are enforced here, never in the client |
| **Who is in a room, and who the host is** | `RoomState` — Colyseus state, synchronised by the framework. Player numbers are given by the room and never reused. The host is whoever asked for the room (written down by the gate, not by the client) |
| **Who may say what** | Only the host's connection may send mobs, the clock, a mob's blow, drops, a kick, a lock, or an answer to a question the room asked. Only a guest may land a blow |
| **What a message may be** | A strict schema each (zod), a rate each (token bucket), a size limit on the frame |
| **Whether it is plausible** | A block within reach of where the room last believed its player to be; a blow within reach of the mob and no harder than anything hits; a move no faster than a player goes |
| **The order of block changes** | Each accepted change gets the next number and goes to everyone *including its sender*, so two players changing one block at once finish on the same block |
| **Who a message is from** | Stamped by the room from the connection. A message cannot carry its sender |

### Getting into a room

```
game ── POST /auth/steam {ticket}  or  /auth/guest {credential} ──▶ session token
host ── create "world" {world, version, content…} ─▶ gate ─▶ room ─▶ code  ABCD-EFGH
guest ─ POST /rooms/resolve {code} (token) ─▶ roomId ─▶ joinById(roomId, {code}) ─▶ gate ─▶ room
```

- Rooms are **private and unlisted**: there is no list, and no matchmaking a
  stranger can be matched in by. A room is found by its code (8 characters,
  40 bits, from an alphabet with nothing to misread), looked up through a
  rate-limited, authenticated route — and the code is checked again at the
  room's door, so a room id by itself is not an invitation.
- **The gate** (`gate.ts`) wraps Colyseus's one matchmaking entry point.
  Colyseus looks a room up *before* it authenticates, and reads request bodies
  of any size; the gate authenticates first, counts every attempt against its
  address, and only exposes `create`, `joinById` and `reconnect`.
- Games must be compatible to share a world: the same **protocol** number,
  the same **content** fingerprint (blocks, biomes, geology — so the same
  seed makes the same land and a block id means the same block), and a world
  generator at least as new as the world's. The desktop and browser editions
  ship the same data, so they have the same fingerprint and play together;
  the edition is a property of the *account*, not of the build.

### Several players of one machine

An **account** may hold several **seats** in a room, one per `slot` (0–3):
each pane of a split screen connects by itself, with the same account's token
and its own slot, and is given its own player number. The room enforces one
player per slot, a per-edition limit on seats per account, and one room per
account at a time. This kept the pane model as it was: a pane is still a whole
game with its own connection.

### The host's world, for a guest

A guest's game makes the world from the seed, like any other. What it cannot
make is what the host has changed, so the host's game answers for its world
through the room (`world.js: _serveGuests`):

- **manifest** — which chunks the host has data for (saved, or changed and
  not saved yet). Every other chunk is generated locally.
- **chunk** — one of them: the save format, gzipped (a few kilobytes).
- **pload / psave** — the guest's own place in the world (position,
  inventory), kept on the host's disk with the world under a key **the server
  makes** (an HMAC of host, guest and name). A guest cannot ask for another's;
  the host learns a key, not an account.

The room passes these on unread, bounded in size and rate, and never to anyone
but the guest who asked. The existing rule that a game applies its remembered
changes on top of a chunk as it loads (`pendingChanges`) is what keeps a chunk
that arrives a moment late consistent with the block changes that arrived
first.

One gap had to be closed in the game itself: a guest far from the host changes
blocks in chunks the host's game never loads, and — unlike a LAN guest — cannot
save them to the host's disk. Those changes are now kept with the world
(`pending-edits.json`) until the host's game next loads the chunk.

### When things go wrong

| | What happens |
|---|---|
| A guest's line drops | Their place is held (30 s). The SDK reconnects by itself; the game asks for the block changes it missed (`sync`), then sends the ones it made meanwhile. Too many missed: it leaves, and can rejoin |
| The host's line drops | The room waits (60 s). Guests keep their world; mobs stand still; requests for chunks answer "ask again" |
| The host does not come back, or leaves | The room ends for everyone. It has to: the world is on the host's machine. There is no host migration |
| The server restarts | Every room is told why, then closed. A host's own game carries on offline in its world; nothing is lost, because nothing was stored here |
| A client misbehaves | Refused messages are counted; past a limit the player is removed. No place is held for a connection that broke the protocol |

### The game's side

`src/scripts/engine/net/OnlineSession.js` has **the same surface** as
`Multiplayer.js` (`id`, `hostId`, `players`, `isHost`, `state()`, `block()`,
`all()`, `host()`, `to()`, the `on…` callbacks), so `world.js` is handed one or
the other and uses them alike. The three kinds of play coexist because a world
is always in exactly one session:

| | Session | World data |
|---|---|---|
| Alone, split screen, LAN | `Multiplayer` → the game's own server | the game's own server |
| Online, hosting (and the host's panes) | `OnlineSession` → the room | the game's own server |
| Online, as a guest (and their panes) | `OnlineSession` → the room | the host, through the room (`OnlineWorldClient`) |

Opening a world online, or closing it, moves the running world from one
session to the other (`goOnline` / `goOffline`).

---

## 3. Migration plan

**Done in this change**

| | |
|---|---|
| 0 | The existing architecture read and written down (part 1) |
| 1 | The server: `online/`, Colyseus 0.18, from the official template. Auth, gate, room, validation, limits, logging, metrics, health, graceful shutdown |
| 2 | Its tests: 150, against the real server with real SDK clients |
| 3 | The game's transport (`engine/net/`), tested against the server as it is |
| 4 | The game wired to it: Players panel → **Open online**; Join a game → a code; split-screen panes join the room; the host serves its world; pending edits kept with the world |
| 5 | An end-to-end run of two real games in a headless browser (`npm run test:online:e2e`) |
| 6 | Deployment files (Dockerfile, PM2 config for Colyseus Cloud), configuration for development and production, operations and security documents |

**Not done — and why**

| | | Needs |
|---|---|---|
| A | **Deployment.** Nothing has been deployed, and the game ships with no online server set (`data/online.json` is empty), so online play is off until you choose a host and fill it in | Your decision on hosting and its cost |
| B | **Steam, end to end.** The server's side is written and tested against a stand-in for Steam's API. The launcher's side (`electron/steam.js`) is written but has never run: it needs `steamworks.js` and the game's App ID | The App ID, the publisher Web API key, a Steam build |
| C | **The free edition's limits.** The mechanism is there and tested (may it host, how big a room, how many local players, which blocks it may not place). The *values* are placeholders | What the browser edition actually may not do |
| D | **Where the browser edition is served from.** The game still needs its own server for saves; a browser edition that is a static site would need worlds kept some other way, which is outside this change | How you intend to host it |

**Next, in the order I would do it**

1. Deploy to a staging address; run the release checklist in SECURITY.md.
2. Steam: add `steamworks.js`, verify a real ticket against the real API.
3. Set the free edition's real limits; decide whether it may host.
4. Play-test on real connections: the reach, speed and rate limits are set
   from reading the code, not from watching players on a bad line.
5. Then the things in *Known limitations* (CLAUDE.md) that turn out to matter:
   serving only chunks that were actually edited, far terrain for guests,
   chat, a public room list (which needs moderation first).

---

## 4. Assumptions to confirm

Each of these was a decision I made in order to keep going. None is expensive
to change now; some would be later.

1. **The host's game keeps hosting; the server relays and validates.** If you
   want worlds that live on the server and outlast their host, that is a
   different (and much larger) design.
2. **Rooms are private, found by a code.** There is deliberately no public
   list of games: it would need moderation of names and a way to report
   players, and neither exists yet.
3. **The free edition may join but not host**, holds two local players, and
   has no block restrictions yet (`EDITION_FREE`). Placeholders.
4. **Both editions ship the same blocks and biomes.** If the browser edition
   really lacks content, it has a different fingerprint and cannot share a
   world with the desktop edition — by design, since it could not generate
   the same land. "Content-limited" then has to mean limited in what a player
   may *do*, which is what the edition policy enforces.
5. **Steam is the only proof of purchase.** A desktop build not running under
   Steam is a guest with the free edition.
6. **Guests are anonymous.** A guest is a credential the game keeps. Whoever
   has it is that guest; clearing the game's data makes a new one. There are
   no accounts, passwords or e-mail addresses, so there is nothing to leak.
7. **Players cannot hurt each other** (as now), so nothing about health or
   inventory is validated: a player who edits their own is only cheating
   themselves, in a world whose owner invited them.
8. **Colyseus Cloud is the first choice of host**, with a Dockerfile for any
   other. Whether Colyseus Cloud will build from a sub-folder of this
   repository is not something its documentation settles; see OPERATIONS.md.
9. **One server process.** Enough for hundreds of rooms of a relay; what moves
   to Redis before a second is in OPERATIONS.md.
10. **A family-shared Steam library counts as owning the game**
    (`STEAM_ALLOW_FAMILY_SHARING`).
