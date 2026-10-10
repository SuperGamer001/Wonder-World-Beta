# Online multiplayer — security

What the online server protects, how, what it does not, and what to check
before a release. Read *What the server cannot check* before telling anyone
the game is cheat-proof: it is not, and no client-side measure will make it so.

---

## Who trusts whom

| | Trusted for | Not trusted for |
|---|---|---|
| **The server** | Who a connection is, which edition, who is in a room, who the host is, the order of block changes | It holds no worlds and no player data, so a breach of it leaks neither |
| **A room's host** | That one world: the host's game runs its mobs, clock and weather, holds its saved data, and keeps its guests' places in it. A guest who joins a world is trusting its owner with that world — as they would in the owner's house | Anything outside the room. A host cannot learn a guest's account, speak for another player, exceed the server's limits, or affect another room |
| **A guest** | Their own player: where they are, what they hold | Anything else. Guests need not trust each other |
| **Any client's word about itself** | Nothing. Name, look, edition, Steam id, role, player number, position: none is believed because a client said so | |

---

## What is done, requirement by requirement

| Requirement | How it is met | Where | Tested in |
|---|---|---|---|
| Validate and authorise every important action | Every message type has a sender rule (host / guest / anyone), a rate, a strict schema, and — for blocks, blows and movement — a plausibility check against what the room knows | `rooms/WorldRoom.ts` (`on`, `blockRefused`, `onHit`, `onState`) | `security.test.ts` |
| Strict validation of types, ranges, sizes | zod schemas, strict (an unknown field is an error); numbers finite and inside the world; lists bounded. Frames over 96 KB are closed unread by the transport; HTTP bodies over 16 KB are refused unread, before Colyseus parses them | `rooms/validate.ts`, `app.config.ts`, `net.ts` (`limitRequestBodies`) | `security.test.ts`, `unit.test.ts`, `limits.test.ts` |
| Rate limits, configurable | Per message type per player (token buckets); per address for sign-in, matchmaking and code look-ups; per account for look-ups and room creation; a hard per-connection cap on messages a second | `rooms/WorldRoom.ts`, `registry.ts`, `config.ts` (`RATE_*`) | `limits.test.ts` |
| Connection limits, configurable | Sockets per address and in total (refused at the upgrade); rooms in total and per account; players per room and per account | `app.config.ts` (`verifyClient`), `gate.ts`, `config.ts` (`MAX_*`) | `limits.test.ts` |
| Authentication that fits the game | Steam for the desktop edition (ticket checked with Steam's Web API, ownership asked of Steam); anonymous guest credentials for everyone else; short-lived HS256 session tokens pinned to algorithm, issuer and audience | `auth/steam.ts`, `auth/tokens.ts`, `http.ts` | `auth.test.ts` |
| Secure room creation, joining, private rooms, codes | Rooms are private and unlisted; found only by an 8-character code through an authenticated, rate-limited look-up; the code is checked again (in constant time) at the room. Wrong code, no such room, locked and full all give the same answer. Only an edition allowed to host can make a room | `gate.ts`, `http.ts`, `rooms/WorldRoom.ts` (`onJoin`, `claimCode`) | `auth.test.ts`, `limits.test.ts` |
| Secure WebSockets in production | The server speaks HTTP behind a proxy that speaks TLS; the game only accepts an `https://` online address (or loopback, for development), and the SDK then uses `wss://`. HSTS is sent in production. Origins are allow-listed for both HTTP (CORS) and the WebSocket upgrade | `net.ts` (`originAllowed`), `gate.ts`, `http.ts`; game: `Online.js`, `server.js` (`onlineUrl`) | `auth.test.ts`, `unit.test.ts` |
| Secrets and environment | Everything from the environment; no secret has a default; production refuses to start with weak or missing secrets, developer sign-in on, or loose origins. `.env*` is git-ignored; nothing secret is in the client or the image | `config.ts` (`assertProductionSafe`), `.gitignore`, `Dockerfile` | `unit.test.ts` |
| Forged identities | The token is the only identity read. A message cannot carry its sender (schemas are strict; the room stamps the sender from the connection). The host is whoever the gate recorded as asking for the room; server-written fields are stripped from what clients send | `gate.ts`, `rooms/WorldRoom.ts` | `security.test.ts`, `auth.test.ts` |
| Unauthorised state changes | Host-only messages from a guest are dropped and counted a hundredfold; a few and the player is removed. A reply is accepted only from the host, only to a question the room asked | `rooms/WorldRoom.ts` | `security.test.ts` |
| Message flooding | Per-type rates; refused messages counted and the sender removed past a limit; Colyseus's per-connection hard cap; chunk relay capped in bytes per room per minute; security log lines capped per minute | `rooms/WorldRoom.ts`, `log.ts` | `limits.test.ts` |
| Invalid state transitions | A room that is ending takes no messages and no players; a removed player's messages are ignored; nobody becomes host when the host is away; a spectator world takes no building or fighting | `rooms/WorldRoom.ts` | `reconnect.test.ts`, `security.test.ts` |
| Disconnects, reconnection, abandoned rooms, host or server failure | Places held for a grace period; missed block changes replayed in order; rooms disposed when empty; the room ends when its host is gone for good; graceful shutdown tells every room first | `rooms/WorldRoom.ts`, `app.config.ts` | `reconnect.test.ts`, `client.test.ts` |
| Minimal, privacy-conscious logging; monitoring | JSON lines; accounts logged as a keyed hash, addresses as a network, nothing a player typed; counters at `/metrics` behind a token; `/healthz`, `/readyz` | `log.ts`, `http.ts` | `unit.test.ts`, `auth.test.ts` |
| Free-edition restrictions enforced by the server | The edition is in the server's token. Hosting, room size, local players, building at all, and which blocks may be placed are checked in the gate and the room | `config.ts` (`EDITION_*`), `gate.ts`, `rooms/WorldRoom.ts` | `security.test.ts` |
| Dependency auditing, production configuration | `npm run audit`; CI runs it on every change. See *Dependencies* below | `package.json`, `.github/workflows/online.yml` | — |
| Nothing privileged in a client | The Steam publisher key and both secrets exist only in the server's environment. The game holds a session token and, for guests, a guest credential — its own, and nothing else's | | `auth.test.ts` (the key never appears in an answer or a log) |

---

## What the server cannot check

The server has no copy of the world. That is the price of not simulating it,
and these follow from it. None is a bug to be fixed with more checks on the
client: **a client is a program on someone else's computer, and anything it
checks about itself it can be made to lie about.**

- **Whether a player had the block they placed**, or the tool to break the one
  they broke. Inventories live in each player's own game. The server knows a
  block is a real one, allowed for that edition, within reach and within rate.
- **What block was there.** It cannot refuse breaking bedrock, or enforce
  survival's mining times.
- **Where a player really is.** It believes a position that moves no faster
  than a player can (with a few allowed jumps, which a respawn needs), and
  then judges reach by that position. A modified client can walk through
  walls, or fly, at ordinary speed.
- **A player's health and hunger.** Players cannot hurt each other, so a
  player who does not take damage only cheats themselves.
- **What the host's game does to its own world.** A host can spawn mobs, set
  the time, hand out items, and edit the saved place of anyone who has played
  there. It is their world.
- **That a chunk the host serves is "true".** It is the host's world by
  definition. The guest's game does check that it is a well-formed chunk of
  bounded size before using it (`ChunkCodec.js`).

What that adds up to: a cheat can build faster, fly and place blocks they did
not earn — in a world whose owner chose to let them in, and can remove them
(the host's **Remove** bans the account from the room). What a cheat cannot do
is become someone else, become the host, speak for another player, reach
another room, exceed the limits, harm the server, or touch a world they were
not invited to.

## Known limits and residual risks

- **Steam sign-in has not run against Steam.** The server's side is tested
  against a stand-in that answers as Steam's documentation says it does; the
  launcher's side has never run. Verify both before relying on the full
  edition meaning "paid" (checklist, below).
- **A guest credential is a bearer token.** Whoever has it is that guest. It
  is kept with the player's settings on their own machine.
- **A reconnection token is the key to a seat** for the grace period. Colyseus
  sends it only to the connection it belongs to.
- **Names are cleaned, not moderated.** Characters are restricted and length
  capped; there is no filter for offensive names. Rooms are private, so a name
  is only seen by people who were given the code.
- **No protection below the application.** Per-address limits stop one source;
  a distributed flood of connections is for the host's network (Colyseus
  Cloud's DDoS add-on, or a proxy in front) to absorb.
- **One process.** The limits are counted in memory (OPERATIONS.md, *Scaling*).
- **Per-address limits depend on the proxy.** `TRUST_PROXY` must be on only
  behind a proxy that sets `X-Real-IP`, and must be on there — otherwise every
  player shares one address and one set of limits. The first deployment has to
  check this (checklist).
- **Session tokens are not revocable** before they expire (an hour by default).
  A kick is enforced by the room, not the token. Rotating `JWT_SECRET` revokes
  everything at once.

## Dependencies

`npm audit --omit=dev` (run on the day this was written) reports one low
advisory with no fix released: `elliptic` (GHSA-848j-6mx2-7j84), reached as
`@colyseus/auth` → `grant` → `jwk-to-pem`. That is the OAuth half of
`@colyseus/auth`. This server uses the package for its JWT helper only: no
OAuth route is mounted (`auth: false` in `app.config.ts`), so the code is
installed and never run. A second advisory in the same chain (`uuid`,
GHSA-w5hq-g745-h8pq) is closed by an `overrides` entry in `package.json`; take
it out when `grant` no longer needs it.

The game's own `package.json` — not this folder — has five advisories of its
own from before this work (`express` 4's `qs`, `proxy-addr`, `js-yaml`), all
with fixes available through `npm audit fix`. They concern the game's local
server and were left for you to apply: `node_modules` is partly committed in
that repository, and the fix would touch it.

---

## Release checklist

Before the first public deployment, and again whenever the server changes.

**Configuration**

- [ ] `NODE_ENV=production`. The server logs `server.configured` on start: read it.
- [ ] `JWT_SECRET` and `PLAYER_KEY_SECRET` set in the host's secret store, each
      48 random bytes, different from each other, in no file and no chat log.
- [ ] `ALLOWED_ORIGINS` is the browser edition's exact `https://` origin(s).
- [ ] `DEV_AUTH` unset. `POST /auth/dev` answers 404.
- [ ] `ALLOW_NO_ORIGIN` unset (false). A `curl -X POST` with no `Origin` to
      `/auth/guest` answers 403.
- [ ] `ALLOW_UNKNOWN_CONTENT` unset (false), unless gamepacks are meant to
      play online.
- [ ] `MONITOR_PASSWORD` and `METRICS_TOKEN` either unset (both pages answer
      404) or long and stored like the other secrets.
- [ ] The free edition's policy (`EDITION_FREE`) is what the browser edition
      is meant to be allowed.

**Transport**

- [ ] The server is reachable only through the TLS proxy; port 2567 is not
      open to the internet directly.
- [ ] `https://<server>/healthz` answers `ok`; plain `http://` redirects or
      refuses.
- [ ] `TRUST_PROXY=true`, and it is true that the proxy sets `X-Real-IP`:
      cause a security log line from two different networks (a wrong room code
      will do) and check their `net` fields differ and are not the proxy's.
- [ ] The game's `data/online.json` (or `WW_ONLINE_URL`) is the `https://`
      address. The game refuses any other.

**Steam** (when the desktop edition is on Steam)

- [ ] `STEAM_APP_ID`, `STEAM_WEB_API_KEY` (the *publisher* key) and
      `STEAM_IDENTITY` set on the server; the same identity in the launcher.
- [ ] From a real Steam build: `GET /info` says `"steam": true`; the Players
      panel does not say "free edition"; the account can host.
- [ ] From an account that does not own the game (or outside Steam): free
      edition; cannot host.
- [ ] The publisher key appears nowhere in the game's files:
      `grep -r "<the first 8 characters>" .` over the built game finds nothing.

**Behaviour** — `npm test` in `online/` passing is most of this; these are the ones worth seeing with your own eyes on the deployed server.

- [ ] Two real machines, on different networks, play through it.
- [ ] A wrong code and a code for a full room give the same message.
- [ ] Pull a guest's network cable for ten seconds: they come back, and what
      was built meanwhile is there.
- [ ] Restart the server during a game: both players are told; the host's
      world is intact and playable offline.
- [ ] `npm run audit` reports nothing new.

**Afterwards**

- [ ] An alert exists for `/readyz` failing and for the process restarting.
- [ ] Someone knows where the secrets are and how to rotate them
      (OPERATIONS.md).
