# Wonder World — online server

The server that lets a world be played over the internet: a
[Colyseus](https://colyseus.io) 0.18 server (TypeScript, Node 22+) that the
desktop edition and the browser edition both connect to.

It does not run the game. A world online is still hosted by one player's game,
exactly as on a split screen or a local network; this server is the one place
every message between the players passes through, and it is the authority on
who is in a room, who may say what, and what a message may be. Why it is built
that way, and what it does and does not protect against, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SECURITY.md](docs/SECURITY.md).
Running it for real is [docs/OPERATIONS.md](docs/OPERATIONS.md).

It is deployed by itself. Nothing in this folder is shipped to players
(`electron-builder.yml` leaves it out), and nothing outside it is needed to run
it.

## Run it on your machine

```
cd online
npm install
npm start            # http://localhost:2567, restarting when a file changes
```

No configuration is needed: with no environment it runs in development mode,
makes up its signing secrets for the session, and has developer sign-in on.

Then point the game at it and play:

```
# in the game's folder, a second terminal
WW_ONLINE_URL=http://127.0.0.1:2567 npm run server      # PowerShell: $env:WW_ONLINE_URL='http://127.0.0.1:2567'; npm run server
```

Open the address it prints, start a world, **pause → Players → Open online**:
the panel shows a code. In a second browser profile (or on another machine,
through its own copy of the game with the same `WW_ONLINE_URL`) choose
**Play → Join a game** and type the code.

Neither of those players is under Steam, so both are guests with the free
edition — which, as shipped, may join but not host. For local play either let
the free edition host (`EDITION_FREE={"canHost":true}` in `.env.development`),
or leave it and see the refusal the browser edition will get.

`http://localhost:2567/monitor` (development only, unless a password is set)
lists the rooms.

## Scripts

| | |
|---|---|
| `npm start` | Run from source, watching for changes |
| `npm test` | Every test: boots the real server and connects real clients (150 of them; under a minute) |
| `npm run typecheck` | The compiler, without output |
| `npm run build` | Compile to `build/` — what production runs (`node build/index.js`) |
| `npm run content` | Copy the game's block list into `src/content/known.json` (run when `data/blocks`, `data/biomes` or `data/terrain` change) |
| `npm run audit` | `npm audit` of what is installed in production |

From the game's folder: `npm run test:online` runs this folder's tests, and
`npm run test:online:e2e` plays two real copies of the game against each other
through this server in a headless browser.

## What is where

```
src/
  index.ts            Listens (leave as it is for Colyseus Cloud)
  app.config.ts       The server put together: transport and its limits, the room, the routes, shutdown
  config.ts           Every setting, from the environment, checked; what production refuses to start with
  protocol.ts         The messages and codes — the server's copy (the game's is src/scripts/engine/net/OnlineProtocol.js)
  gate.ts             In front of matchmaking: who may make a room, who may ask for a place, how often
  http.ts             Sign-in, finding a room by its code, health, metrics
  net.ts              Where a request came from; which pages may talk to the server; the size of a request
  limits.ts           Token bucket, per-key limiter, gauge
  registry.ts         What this process is holding: rooms, players, sockets, limiters
  log.ts              One JSON line an event, naming nobody; counters
  content.ts          The blocks of each version of the game the server knows
  content/known.json    … written by tools/sync-content.mjs
  auth/tokens.ts      Session tokens, guest credentials, the key a host keeps a guest's things under
  auth/steam.ts       Steam ticket → Steam id → does it own the game
  rooms/WorldRoom.ts  A world and everyone in it: every message, checked
  rooms/RoomState.ts  Who is here (the part Colyseus synchronises by itself)
  rooms/validate.ts   What each message must look like
test/                 unit · auth · room · security · limits · reconnect · client (the game's own code against the server)
tools/sync-content.mjs
docs/                 ARCHITECTURE · SECURITY · OPERATIONS
Dockerfile · ecosystem.config.cjs · .env.example
```

The game's side of the line is in the game's own source, not here:
`src/scripts/engine/net/` (`OnlineSession.js`, `OnlineProtocol.js`,
`ChunkCodec.js`) and `src/scripts/Online.js`.

## Configuration

Everything is an environment variable; `.env.example` lists them all, and
`src/config.ts` is where each is read and described. In development none is
needed. In production two secrets are required and the server will not start
without them — see [docs/OPERATIONS.md](docs/OPERATIONS.md).
