# Online server — running it

Nothing has been deployed. The game ships with no online server set
(`data/online.json` has an empty `url`), so online play is off — the Players
panel has no Online section and Join a game has no code box — until a server
exists and the game is told where it is. Choosing a host, and paying for one,
is yours to do; this is how.

- [Development and production](#development-and-production)
- [Deploying](#deploying)
- [Secrets](#secrets)
- [Updates](#updates)
- [Backups](#backups)
- [Monitoring](#monitoring)
- [Scaling](#scaling)
- [When something is wrong](#when-something-is-wrong)

---

## Development and production

One codebase, two behaviours, chosen by `NODE_ENV`. `src/config.ts` is the
whole of it.

| | Development (`npm start`) | Production (`NODE_ENV=production`) |
|---|---|---|
| Signing secrets | Made up afresh at every start | **Required.** Will not start without `JWT_SECRET` and `PLAYER_KEY_SECRET` |
| Developer sign-in (`/auth/dev`) | On | Off; will not start with it on |
| A client with no `Origin` | Allowed (tests, tools) | Refused |
| Allowed origins | Loopback | `ALLOWED_ORIGINS` (exact `https://` origins) and loopback, for the desktop app |
| A game whose blocks the server does not know | Allowed (ids range-checked) | Refused |
| `/monitor` | Open | 404 unless `MONITOR_PASSWORD` is set |
| `/metrics` | 404 unless `METRICS_TOKEN` is set | the same |
| Environment file | `.env.development`, if you make one | None: set variables in the host |
| Log level | `info` | `info` |

Running locally is in the [README](../README.md).

## Deploying

The server is a plain Node process that speaks HTTP and WebSocket on one port
(`PORT`, 2567). Two things must be in front of it, whoever hosts it:

1. **TLS.** Games connect with `https://` / `wss://`; the game refuses an
   online address that is not `https://`. The server does not speak TLS
   itself.
2. **The player's real address, in `X-Real-IP`.** Every per-address limit
   depends on it. Set `TRUST_PROXY=true` exactly when a proxy you control
   sets that header.

### Colyseus Cloud (the first choice)

It is the framework's own hosting: it builds from a git repository, runs the
server under PM2 behind nginx with TLS, and restarts it on a push. This folder
is laid out the way its template is (`src/index.ts`, `src/app.config.ts`,
`ecosystem.config.cjs`, `npm run build` → `build/index.js`).

1. Create an application at <https://cloud.colyseus.io> and connect the
   repository. **Check first** whether the application's build settings let
   you set a root directory: this server is in `online/`, not at the root of
   the repository, and Colyseus Cloud's documentation does not say. If they do
   not, the simplest way round is a repository of its own for this folder
   (`git subtree split --prefix=online`), deployed from there.
2. In **Settings → Environment Variables** set at least:
   `NODE_ENV=production`, `JWT_SECRET`, `PLAYER_KEY_SECRET`, `ALLOWED_ORIGINS`,
   `TRUST_PROXY=true`, and — when the game is on Steam — `STEAM_APP_ID`,
   `STEAM_WEB_API_KEY`. They are stored encrypted there. Do not commit a
   `.env.production`.
3. Deploy (`npx @colyseus/cloud deploy` from `online/`, or a push). The first
   deploy writes `.colyseus-cloud.json`, which holds deploy credentials: it is
   git-ignored, keep it that way.
4. Go through the release checklist in [SECURITY.md](SECURITY.md) — in
   particular the one that checks `X-Real-IP` really is the player's address
   there.
5. Put the address in the game: `data/online.json` → `{ "url": "https://…" }`.

`ecosystem.config.cjs` runs **one** process on purpose; see
[Scaling](#scaling). Its DDoS protection is an add-on at the network level;
the limits in this server are the application's.

### Any machine or container host

```
docker build -t wonder-world-online online/
docker run -d --restart unless-stopped --name ww-online -p 127.0.0.1:2567:2567 --env-file /etc/ww-online.env wonder-world-online
```

The image runs as an unprivileged user, has a health check, holds no secret,
and stops gracefully on `SIGTERM`. Publish the port on loopback only, as above,
and put a proxy in front. With Caddy that is the whole configuration, TLS
certificate included:

```
play-server.example.com {
    reverse_proxy 127.0.0.1:2567 {
        header_up X-Real-IP {remote_host}
    }
}
```

With nginx, the block in Colyseus's deployment guide, plus
`proxy_set_header X-Real-IP $remote_addr;` and a long `proxy_read_timeout`.
Either way: `TRUST_PROXY=true`, and nothing but the proxy able to reach 2567.

Without Docker: `npm ci && npm run build`, then `pm2 start ecosystem.config.cjs`
(or a systemd unit running `node build/index.js`) with the variables in the
service's environment.

## Secrets

There are three, and they exist only in the server's environment.

| | What it does | If it leaks | If it is changed |
|---|---|---|---|
| `JWT_SECRET` | Signs session tokens and guest credentials | Anyone can be any guest, or mint the full edition. Rotate at once | Everyone is signed out. Steam players sign in again unnoticed. **Guests become new guests** and lose the places kept for them in hosts' worlds |
| `PLAYER_KEY_SECRET` | Makes the key a host keeps a guest's place under | Low: someone who also has a host's files could match keys to accounts | **Every guest's saved place in every host's world is orphaned**, Steam players included. Do not rotate without a reason |
| `STEAM_WEB_API_KEY` | The publisher key: asks Steam about tickets and ownership | Serious, and wider than this game: it is your Steamworks publisher key. Revoke it in Steamworks | Nothing, once the new one is set |

Make the first two with:

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Set them in the host's secret store (Colyseus Cloud: Application Settings; a
VM: a root-only env file, mode 600; a container platform: its secrets). Never
in the repository, an image, a build log, or the game. `.env*` files are
git-ignored here, `.env.example` excepted — and that one must only ever hold
names.

`METRICS_TOKEN`, `MONITOR_PASSWORD` and `LOG_SALT` are lesser secrets of the
same kind. Changing `LOG_SALT` only means the account tags in new logs do not
match the old ones.

To rotate `JWT_SECRET`: set the new value, restart. Rooms end (as on any
restart) and everyone signs in again.

## Updates

**The server.** A deploy restarts the process. Every room is told the server
is restarting and is closed; hosts carry on offline in their own worlds and
can open them online again in a moment. There is no way to move a room to a
new process, so deploy when few are playing (`ww_players` in the metrics).

**The game.** The server and the game are released separately, and must stay
compatible:

- If `data/blocks`, `data/biomes` or `data/terrain` changed: run
  `npm run content` in `online/` and **deploy the server before the game**.
  The new fingerprint is added beside the old ones, so players who have not
  updated keep playing with each other. A test fails if you forget
  (`unit.test.ts`: *the server knows the blocks of the game in this
  repository*). Remove a retired version with
  `node tools/sync-content.mjs --prune <hash>`.
- If a message changed shape or meaning: raise `PROTOCOL` in both
  `online/src/protocol.ts` and `src/scripts/engine/net/OnlineProtocol.js`
  (a test fails if they differ), keep `MIN_PROTOCOL` where it was for as long
  as the server can still speak the old one, and deploy the server first.
- To make everyone update (a security fix in the game): set
  `MIN_GAME_VERSION`. Older games are told to update.

**Dependencies.** `npm run audit` in `online/`, and after any
`npm update`: `npm run typecheck && npm test`. Colyseus's packages move
together — keep `colyseus`, `@colyseus/tools`, `@colyseus/schema`,
`@colyseus/testing` on one minor, and the game's `@colyseus/sdk` on the same
one. The CI workflow (`.github/workflows/online.yml`) runs all of this on
every change to the server and once a week.

## Backups

**The server stores nothing.** No database, no files, no worlds, no accounts.
Rooms are in memory and are meant to be lost on a restart. The only things to
keep are the secrets (above — in a password manager, not only in the host) and
the host's own configuration.

Worlds are on their owners' machines, where they always were: the game's data
folder (`user/worlds/`; on Windows `%APPDATA%\Wonder World\user\worlds`). A
guest's place in someone's world is in that world's `players/` folder, and
what guests built where the host never went is in its `pending-edits.json`;
both are copied and deleted with the world. That is for players to back up,
and worth saying to them.

## Monitoring

| | |
|---|---|
| `GET /healthz` | 200 `ok` while the process is up. For the host's liveness check |
| `GET /readyz` | 200 while it is taking players; 503 once it has been told to stop. `{ ready, rooms, players }` |
| `GET /metrics` | Prometheus text, for a request with `Authorization: Bearer $METRICS_TOKEN`. 404 otherwise, and 404 if no token is set |
| `/monitor` | Colyseus's room list, behind `MONITOR_PASSWORD` (user `admin`). Leave it off unless you need it: it can close rooms |
| Logs | One JSON line an event on stdout / stderr |

**Counters worth a graph** (all prefixed `ww_`):

| | Means |
|---|---|
| `rooms`, `players`, `sockets` | Now |
| `rooms_created_total`, `joins_total`, `leaves_total` | Use |
| `drops_total`, `reconnects_total` | Network quality. Drops far above reconnects: places are being given up |
| `auth_rejected_total`, `gate_refused_*_total` | Refused at the door, by reason (`auth`, `rate`, `edition`, `content`, `protocol`, `capacity`, …) |
| `security_*_total` | Events that were logged as security events, by kind |
| `violation_*_total`, `invalid_messages_total`, `blocks_refused_total`, `states_refused_total` | Refused inside rooms. A steady trickle is players on bad connections; a spike is someone trying something |
| `relay_bytes_total` | Chunk data passed from hosts to guests: most of the bandwidth |
| `http_body_refused_total` | Oversized requests turned away |
| `framework_errors_total`, `room_exceptions_total` | Should be flat. Anything here is a bug |
| `memory_rss_bytes`, `uptime_seconds` | The process |

**Log events.** `server.configured` (once, at start: check it), `room.created`
/ `room.join` / `room.leave` / `room.drop` / `room.reconnect` / `room.kick` /
`room.disposed`, `auth.steam`, and `security.*` (`violation`, `invalid_message`,
`flood_kick`, `invalid_kick`, `wrong_code`, `matchmake_rate`, `http_rate`,
`guest_rate`, `resolve_rate`, `create_rate`, `socket_limit`, `steam_refused`,
`bad_close`, `http_body`). Accounts appear as a ten-character tag (`acct`),
addresses as a network (`net`); names, codes, tokens and positions never
appear. At most thirty lines of each security event are written a minute; the
counters keep the true total.

**Alert on:** `/readyz` failing; the process restarting; `framework_errors` or
`room_exceptions` rising; `auth.steam_unavailable` in the log (Steam is not
answering, so desktop players are being let in as guests); memory climbing
without players climbing.

## Scaling

One process is what this server is built and tested as. It relays; it does not
simulate; a room costs a few kilobytes and its traffic. The default limits
(`MAX_ROOMS=200`, `MAX_CONNECTIONS=1500`) are a guess at a small machine, not a
measurement — measure before raising them (`npm create colyseus-app` ships a
load-test tool; `@colyseus/loadtest`).

Before running a second process, these have to move out of memory, because
each process would otherwise count from nothing and every limit would be twice
as loose:

- `registry.ts` — rooms per account, players in total, the rate limiters. To
  Redis (Colyseus's `presence` already offers counters and expiring keys).
- Room codes are already in `presence`, and so already shared.
- Colyseus itself needs `RedisPresence` and `RedisDriver` (on Colyseus Cloud
  with more than one CPU these are set up for you — which is exactly why
  `ecosystem.config.cjs` asks for one instance).

## When something is wrong

| | |
|---|---|
| **Turn online play off** | Stop the server. Games say the online server cannot be reached; everything else in the game works |
| **Stop new games, let current ones finish** | `MAX_ROOMS=0` is not accepted (minimum 1); set `EDITION_FULL={"canHost":false}` and `EDITION_FREE={"canHost":false}`, restart at a quiet moment |
| **Everyone must update** | `MIN_GAME_VERSION=<version>` |
| **A secret may have leaked** | Rotate it (above). For the Steam key: revoke it in Steamworks first |
| **One source is flooding** | The limits hold it to its share; block the network (`net` in the log) at the proxy or firewall |
| **Players all share one set of limits** | `TRUST_PROXY` is off behind a proxy, or the proxy is not setting `X-Real-IP` |
| **Nobody can connect from the browser edition** | Its origin is not in `ALLOWED_ORIGINS` (exactly: scheme, host, port, no trailing slash) |
| **"That game uses different game packs"** | The game's data changed and the server was not told: `npm run content`, deploy |
| **Desktop players are "free edition"** | Steam is not set up on the server (`GET /info` → `"steam": false`), the launcher has no `steamworks.js` / App ID, or Steam is not answering (`auth.steam_unavailable`) |
