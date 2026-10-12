# Online play with Ably — getting it started

Online multiplayer is written, and works against Ably: three games in one
room, with a real key, on 2026-10-11 (`npm run test:online:live`). What is
left is the one step only you can take, **step 4: put the token service on
the internet**, so that a player's game can be let in without ever holding the
key. Until then online play works wherever `WW_ABLY_KEY` is set, which is
your own machines.

- [1. Make an Ably account and a key](#1-make-an-ably-account-and-a-key) — needed
- [2. Try it on your own machine](#2-try-it-on-your-own-machine) — needed, to see that it works
- [3. Try it between two computers](#3-try-it-between-two-computers)
- [4. Before players can use it: deploy the token service](#4-before-players-can-use-it-deploy-the-token-service) — needed to ship
- [What the free plan allows](#what-the-free-plan-allows)
- [What this does not protect](#what-this-does-not-protect)
- [What has and has not been checked](#what-has-and-has-not-been-checked)
- [How it works, and what is where](#how-it-works-and-what-is-where)

---

## 1. Make an Ably account and a key

1. Sign up at <https://ably.com/sign-up>. The free plan asks for no card.
2. Ably makes a first app for you. Open it, then **API Keys**.
3. Make a key for the game rather than using the root key (**Create a new
   API key**). The dashboard's wording may differ a little from this:
   - **Capabilities:** publish, subscribe and presence. Nothing else.
   - **Restrict it to channels** matching `ww:*`. Every channel the game uses
     starts with `ww:`.

   A token can never do more than the key it was made with, so this is the
   outer wall: whatever goes wrong in the game, this key can only touch game
   rooms.
4. Copy the key. It looks like `aBcDeF.GhIjKl:a-long-secret`.

**The key is a password.** It goes in an environment variable on your machine
(step 2) and in a secret on the token service (step 4). It never goes in the
repository, in `data/online.json`, or in anything a player downloads. The game
has no place to put it, on purpose.

## 2. Try it on your own machine

Two players on one computer need two copies of the game's server, each with
its own data folder: who a player is online is kept with their settings, so
two browser windows on *one* server would be the same player twice.

PowerShell, two terminals in the game's folder:

```powershell
# terminal 1 — the host
$env:WW_ABLY_KEY = 'aBcDeF.GhIjKl:a-long-secret'
npm run server

# terminal 2 — the guest
$env:WW_ABLY_KEY = 'aBcDeF.GhIjKl:a-long-secret'
$env:PORT = '3001'
$env:WONDER_DATA_DIR = "$env:TEMP\ww-guest"
npm run server
```

Each prints its address. Then:

1. Open the first address. Start a world, then **pause → Players → Open
   online**. The panel shows a code like `ABCD-EFGH`.
2. Open the second address. **Play → Join a game**, type the code, **Join**.

With `WW_ABLY_KEY` set, the game's own server signs tokens itself, so nothing
needs deploying yet. Without it (and with `data/online.json` empty, as it
ships) the game has no online play and shows none of these buttons.

**Then look at the Ably dashboard** (your app → **Stats**) while both are
playing: it shows messages and connections as Ably counts them. Compare with
[the numbers below](#what-the-free-plan-allows); they are the first thing I
would want confirmed.

If it does not connect, the browser's console (F12) has Ably's own error with
a code, and <https://ably.com/docs/platform/errors/codes> says what each means.
`40160` ("client lacks the required capability") is the key missing a
capability from step 1.3.

## 3. Try it between two computers

Ably is the meeting point, so no tunnel, port forwarding or hosting is needed.
On each computer: the same version of the game, the same `WW_ABLY_KEY`, then
`npm run server` and open the address it prints. One hosts, the other joins by
the code.

Only do this with people you would hand the key to. For anyone else, step 4.

## 4. Before players can use it: deploy the token service

A player's game cannot hold the key, so something on the internet has to sign
tokens for it. That is `online/auth.js`: about 200 lines, no state, no
database. Where it lives goes in `data/online.json`:

```json
{ "auth": "https://wonder-world-online.your-name.workers.dev" }
```

I have not deployed it anywhere: it needs an account with a host, which is
yours to make. Two ways, both free at this size.

### Cloudflare Workers (free plan, no server to look after)

```
cd online
npx wrangler login                      # opens a browser; makes a free Cloudflare account if you have none
npx wrangler deploy                     # prints the address
npx wrangler secret put ABLY_API_KEY    # paste the key when asked
```

(Until the secret is there it answers "ABLY_API_KEY is not set".)

Put the address in `data/online.json`. If the browser edition is served from
a website, add its origin to `ALLOWED_ORIGINS` in `wrangler.toml`
(`"https://play.example.com"`) and deploy again; the desktop app needs nothing
added.

`worker.js` is written for this and tested as a `Request`/`Response` handler,
but **has not been deployed**, so treat the first deploy as a test.

### Any machine that runs Node

```
ABLY_API_KEY=… ALLOWED_ORIGINS=https://play.example.com TRUST_PROXY=true PORT=8787 node online/server.mjs
```

It speaks plain HTTP: put it behind something that speaks HTTPS (Caddy, nginx,
a host's own proxy). The game refuses an `http://` address that is not the
player's own machine. Set `TRUST_PROXY=true` only behind a proxy that sets
`X-Forwarded-For`, or one player's flood limits everybody.

### Then

- Check it: `curl https://your-address/` answers `{"ok":true,…}`.
- Put the address in `data/online.json`, run the game **without**
  `WW_ABLY_KEY`, and repeat step 2. That is what a player has.
- `WW_ONLINE_AUTH=https://…` overrides `data/online.json` for one run.

---

## What the free plan allows

From Ably's pages on 2026-10-11 ([free plan](https://ably.com/docs/platform/pricing/free),
[limits](https://ably.com/docs/platform/pricing/limits),
[how messages are counted](https://ably.com/docs/platform/pricing/message-counting)).
Check them again before relying on a number.

| Limit | Free plan | What it means for the game |
|---|---|---|
| Messages a month | 6,000,000 | See below: this is the one that runs out |
| Connections at once | 200 | 200 players online at once, in all rooms |
| Channels at once | 200 | A room is 3 channels plus one per guest: about 33 rooms of four |
| Messages a second, per channel | 50 | Why a room holds 6 players at most (`HARD_MAX_PLAYERS`) |
| Message size | 64 KiB | Chunks and long lists are sent in parts (`PART_BYTES`) |
| A dropped connection is held for | 2 minutes | Longer than that and a guest is sent back to their menu |

**Ably counts a message once when it is sent and once more for each game that
receives it.** One player moving in a room of four is four messages, each
time. So the game says things as seldom as it can (`RATE` in
`OnlineProtocol.js`): where a player is, five times a second while moving and
once every two seconds standing still; the host's mobs three times a second;
nothing at all while a host is alone in the room.

Measured in the test, everyone moving the whole time, with mobs about:

| Players | Messages a second | Hours of that in 6,000,000 |
|---|---|---|
| 2 | about 26 | about 64 |
| 4 | about 88 | about 19 |

The cost grows with the square of the players. Real play is cheaper (people
stand still, build, open menus), but **a month of the free plan is tens of
hours of four-player play in total, across all players of the game.** That is
plenty to build and test with, and not enough to ship to many players on.
Before a release, either move to a paid Ably plan or lower the rates.

The free plan has no card, so it cannot bill you. What Ably does when a limit
is reached is described on its limits page; I have not seen it happen.

## What this does not protect

There is no game server checking what players do. Ably carries messages; it
does not understand them. What is enforced, and by what:

| | Enforced by | |
|---|---|---|
| Who sent a message | Ably | A game's `clientId` comes from its token and is stamped on everything it sends. Nobody can speak as another player |
| Who the host is | The token | Only the host's token may publish on the room's host channel, read what guests send the host, or write to a guest alone. A guest cannot make one |
| Which room a game can touch | The token | It is good for one room's channels and nothing else |
| Who is in the room | The host's game | It lets players in and gives them their numbers. A game it has not let in is ignored by everyone |
| What a block ends up as | The host's game | It refuses a block out of its player's reach, and settles two players changing one block at once |

And what is not:

- **Anyone with the code can join.** The code is the invitation: eight
  characters, about 850 billion of them, and the token service limits how
  often an address may ask. There is no list of games.
- **A modified game can cheat within reach**: fly, walk through walls, place
  blocks it does not have, build faster than a player could. Nothing checks
  inventories or movement. This is the same trust as playing on a home
  network: you gave them the code.
- **Names are display names.** Two players can use the same one. Nothing is
  signed up for; who a game is, is a random secret it keeps with its settings.
- **A player the host removes is silenced, not disconnected.** Their game is
  told to leave and everyone stops hearing them, and they are not let back in.
  But the token service remembers nothing, so a changed game could go on
  *listening* to that room until the host closes it and opens it again (which
  makes a new code). A fresh install is a new player and could rejoin with
  the code.
- **Anyone who finds the token service can ask it for rooms**, and so use
  your message allowance. It is limited per address, and only pages from the
  origins you allow can call it from a browser, but a script is not a browser.
- **The host can do anything to their own world**, including to the saved
  place of anyone who has played in it.
- **The key on a developer's machine** (steps 2 and 3) is the whole account's
  worth of the capabilities you gave it. That is why step 1.3 narrows it.

## What has and has not been checked

Checked without a key (`npm test`, `npm run test:online:e2e`):

- A token request made here is, byte for byte, the one Ably's own SDK makes
  from the same key and the same fields.
- The token service: tickets, forged tickets, who may ask, limits, bad input.
- Rooms of two to four games through a stand-in for Ably that enforces signed
  tokens, capabilities and sender identity: joining, moving, building, mobs,
  conflicts, chunks from the host, saved places, removing a player, leaving,
  a host vanishing, a dropped line.
- Two real games in a browser, through the real menus, one hosting and one
  joining by code (again through the stand-in).
- Ably's real SDK loads in the page from where the game asks for it.

Checked against Ably itself (`WW_ABLY_KEY=… npm run test:online:live`, about
half a minute and a few hundred messages):

- Ably accepts the token requests the token service signs.
- Three games in one room: joining by code, positions, blocks both ways, two
  players at one block, a block out of reach put back, mobs, chunks bigger
  than one message arriving byte for byte, saved places, a name changed, a
  player removed and kept out, the host closing.
- **Ably refuses a guest's token** everything it should: speaking as the
  host, writing to another guest, reading another guest's letters or what
  guests send the host, another room, any channel outside the game's.

Not checked yet:

- Two real games *in a browser* against Ably (step 2 does exactly that).
- Reconnection after a real network drop of more than a moment.
- The message counts above, against Ably's own statistics page.
- The Cloudflare Worker, deployed. It builds (`npx wrangler deploy --dry-run`,
  8 KB); it has not been uploaded.

## How it works, and what is where

```
host's game ──┐                          ┌── guest's game
              ├── Ably (channels of the room) ──┤
              │                          │
              └──── token service ───────┘     (once, to be let in; then hourly)
```

The host's game still runs the world, as on a home network: it holds the
world, runs the mobs and the clock, and answers a guest's requests for chunks.
Ably replaces the game's own server as the thing messages go through.

| File | |
|---|---|
| `online/auth.js` | The token service: who a game is, which room, who the host is. Web Crypto only, so it runs anywhere |
| `online/worker.js`, `wrangler.toml` | … as a Cloudflare Worker |
| `online/server.mjs` | … as a Node server (`npm run online:auth`) |
| `server/server.js` (*Online*) | … on a developer's machine, when `WW_ABLY_KEY` is set; and `/api/online/config`, which tells the page where the service is |
| `data/online.json` | Where the service is, as shipped (`auth`; empty: no online play) |
| `src/scripts/engine/net/OnlineSession.js` | A game's end of a room: the same surface as `Multiplayer.js`, over Ably's channels |
| `src/scripts/engine/net/OnlineProtocol.js` | Channel and message names, rates, limits, the content fingerprint |
| `src/scripts/engine/net/ChunkCodec.js` | A chunk packed to go from the host's game to a guest's |
| `src/scripts/Online.js` | The page's side: loads Ably's SDK, keeps the game's secret, holds the one room |
| `test/online.test.mjs`, `test/fakeAbly.mjs` | The tests, and the stand-in for Ably |
| `test/online.smoke.mjs` | Two real games in a browser |

`online/` is not packaged into the desktop app (`electron-builder.yml`).
