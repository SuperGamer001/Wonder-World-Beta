// Mobs with more than one player in the world (engine/EntityManager.js, *With
// other players*): each game spawns round its own player and runs the mobs
// nearest that player; the others show them. Here two or three games stand on
// one level world, joined by nothing but what they hand each other — the
// snapshots, the mobs handed over, the blows — as world.js passes them on.
//
// What is asked: mobs appear round every player, not only the first; players
// standing together fill one neighbourhood between them no faster and no
// fuller than one player would; a mob is run by the game of the player nearest
// it, and goes on being seen by the others while it changes hands; and a blow
// on a mob reaches the game that runs it, whoever struck.
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { EntityManager } from '../src/scripts/engine/EntityManager.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
}

const reg = new BlockRegistry();
reg.register({ id: 0, name: 'AIR', transparent: true, noCollision: true });
reg.register({ id: 3, name: 'STONE' });
const G = 10;                                   // the ground's top block is at G − 1: a mob stands at y = G
const world = { getBlock: (_x, y, _z) => (y < G ? 3 : 0) };
const scene = { add() {}, remove() {} };
// One kind of mob, with no model (drawn as the plain boxes, which need no textures): it stays where it is put.
const SHEEP = { id: 'sheep', model: 'none', width: 0.9, height: 1.2, speed: 0, health: 10, spawnRules: {}, drops: [{ itemId: 'wool', minCount: 1, maxCount: 1 }] };
// A page's own things, as far as the manager touches them.
globalThis.window = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

// A source of chance that is the same every run.
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
Math.random = rnd;

/** Games in one world. Each is a manager with its player; what one says to another is handed straight over. */
function session(places) {
    const games = places.map(([x, z], i) => {
        const em = new EntityManager(world, reg, null, scene);
        em.loadEntityTypes([SHEEP]);
        em.owner = i + 1;
        const g = { id: i + 1, em, pos: { x, y: G, z }, here: true, attacks: [], drops: [], inv: { addItem: () => 0 } };
        return g;
    });
    const to = (id) => games.find(g => g.id === id && g.here);
    for (const g of games) {
        g.em.onGive = (pid, m) => to(pid)?.em.adopt(JSON.parse(JSON.stringify(m)));
        g.em.onRemoteHit = (pid, id, dmg) => to(pid)?.em.hitById(id, dmg, { id: g.id, ...g.pos });
        g.em.onRemoteAttack = (pid, dmg) => to(pid)?.attacks.push(dmg);
        g.em.onRemoteDrops = (pid, pos, items) => to(pid)?.drops.push(...items);
    }
    /** Run every game for `seconds`, each telling the others of its mobs ten times a second when it has something to say. */
    const run = (seconds, each = null) => {
        const dt = 1 / 20;
        for (let t = 0, said = 0; t < seconds; t += dt) {
            for (const g of games) {
                if (!g.here) continue;
                g.em.others = games.filter(o => o !== g && o.here).map(o => ({ id: o.id, ...o.pos }));
                g.em.update(dt, g.pos, g.inv, 'SURVIVAL');
            }
            said += dt;
            if (said >= 0.1) {
                said = 0;
                for (const g of games) {
                    if (!g.here || !g.em.hasWord) continue;
                    const snap = JSON.parse(JSON.stringify(g.em.snapshot(true)));
                    for (const o of games) if (o !== g && o.here) o.em.applySnapshot(g.id, snap);
                }
            }
            each?.(t);
        }
    };
    return { games, run };
}
const own = (g) => [...g.em._mobs.values()].filter(m => !m.net);
const shown = (g) => [...g.em._mobs.values()].filter(m => m.net);
const near = (mobs, p, r) => mobs.filter(m => Math.hypot(m.pos.x - p.x, m.pos.z - p.z) < r);
const ids = (mobs) => mobs.map(m => m.id).sort((a, b) => a - b).join();

// ── Round every player ───────────────────────────────────────────────────────
{
    const { games: [host, guest], run } = session([[0, 0], [1000, 0]]);
    run(240);
    check('mobs appear round a player far from the host, as they do round the host',
        near(own(host), host.pos, 80).length >= 4 && near(own(guest), guest.pos, 80).length >= 4, `${own(host).length} and ${own(guest).length}`);
    check('… each run by the game of the player they are near, with nothing said between two so far apart',
        shown(host).length === 0 && shown(guest).length === 0 && !host.em.hasWord && !guest.em.hasWord);
    check('no two games give a mob the same name', new Set([...own(host), ...own(guest)].map(m => m.id)).size === own(host).length + own(guest).length);
}

// ── Together: no faster, no fuller ───────────────────────────────────────────
{
    // How many mobs one player has after two minutes, and how many they ever have; then the same of two standing together.
    const count = (places, seconds) => {
        const s = session(places);
        s.run(seconds);
        const all = new Map();
        for (const g of s.games) for (const m of g.em._mobs.values()) all.set(m.id, m);
        return { all: all.size, per: s.games.map(g => g.em._mobs.size), owned: s.games.map(g => own(g).length) };
    };
    const tries = 12;
    let alone = 0, together = 0, three = 0;
    for (let i = 0; i < tries; i++) {
        alone += count([[0, 0]], 64).all;
        together += count([[0, 0], [6, 0]], 64).all;
        three += count([[0, 0], [6, 0], [0, 6]], 64).all;
    }
    alone /= tries; together /= tries; three /= tries;
    check('two players standing together fill the place no faster than one alone',
        together > alone * 0.6 && together < alone * 1.4, `alone ${alone.toFixed(1)}, two together ${together.toFixed(1)}`);
    check('… nor do three', three > alone * 0.6 && three < alone * 1.45, `alone ${alone.toFixed(1)}, three together ${three.toFixed(1)}`);

    const full = count([[0, 0], [6, 0]], 1500);
    const one = count([[0, 0]], 1500);
    check('… and no fuller: the most a neighbourhood holds is the same however many stand in it', full.all === one.all && one.all === 24, `${one.all} alone, ${full.all} with two`);
    check('… with every one of them seen by both', full.per.every(n => n === full.all), full.per.join());
}

// ── Whose a mob is ───────────────────────────────────────────────────────────
{
    const { games: [a, b], run } = session([[0, 0], [40, 0]]);
    // A mob of A's, standing beside A; another of A's that stands beside B.
    const stay = a.em._spawnMob('sheep', { x: 3.5, y: G, z: 0.5 });
    const wander = a.em._spawnMob('sheep', { x: 36.5, y: G, z: 0.5 });
    run(1.2);
    check('a mob is run by the game of the player nearest it', ids(own(a)).includes(String(stay)) && !own(a).some(m => m.id === wander) && own(b).some(m => m.id === wander),
        `A runs ${ids(own(a))}, B runs ${ids(own(b))}`);
    check('… and shown by the other', shown(a).some(m => m.id === wander) && shown(b).some(m => m.id === stay));
    // It was never out of sight on the way: from the first word of it on, both games have it at every moment.
    const c = session([[0, 0], [40, 0]]);
    const m = c.games[0].em._spawnMob('sheep', { x: 36.5, y: G, z: 0.5 });
    let gaps = 0, handed = false;
    c.run(3, (t) => {
        if (t < 0.2) return;
        for (const g of c.games) if (!g.em._mobs.has(m)) gaps++;
        if (own(c.games[1]).some(x => x.id === m)) handed = true;
    });
    check('changing hands, it is never gone from either game', handed && gaps === 0, `handed over: ${handed}; ${gaps} moments without it`);

    // A blow on a mob another game runs goes to that game, and what it drops comes back to whoever struck.
    const theirs = shown(a).find(x => x.id === wander);
    const before = own(b).find(x => x.id === wander).health;
    a.em.hitMob(theirs, 4, a.pos);
    check('a blow on a mob another game runs lands in that game', own(b).find(x => x.id === wander).health === before - 4);
    a.em.hitMob(theirs, 50, a.pos);
    run(0.3);
    check('… and what it drops falls to whoever killed it', a.drops.some(d => d[0] === 'wool') && b.drops.length === 0, JSON.stringify(a.drops));
    run(2.5);
    check('… and it is gone from both when it has fallen', !a.em._mobs.has(wander) && !b.em._mobs.has(wander));

    // The player walks off: the mob they left beside the other player is that player's now, not lost.
    a.pos.x = -400;
    run(2);
    check('a mob left behind beside another player goes on, in that player\'s game', own(b).some(x => x.id === stay) && !a.em._mobs.has(stay),
        `B runs ${ids(own(b))}; A has ${ids([...a.em._mobs.values()])}`);

    // A game that leaves takes its mobs with it.
    const d = session([[0, 0], [30, 0]]);
    d.games[1].em._spawnMob('sheep', { x: 28.5, y: G, z: 0.5 });
    d.run(1);
    const had = shown(d.games[0]).length;
    d.games[1].here = false;
    d.games[0].em.dropOwner(2);
    check('a player who leaves takes the mobs their game ran', had === 1 && shown(d.games[0]).length === 0);
    // … and one that simply falls silent (the line dropped) is not shown for ever.
    const e = session([[0, 0], [30, 0]]);
    e.games[1].em._spawnMob('sheep', { x: 28.5, y: G, z: 0.5 });
    e.run(1);
    e.games[1].here = false;
    e.run(3);
    check('… and a game gone silent is not shown for ever', shown(e.games[0]).length === 0);
}

// ── What comes from another game is not taken on trust ───────────────────────
{
    const { games: [a], run } = session([[0, 0]]);
    a.em.applySnapshot(2, { list: ['x', 'sheep', 1, G, 1, 0, 0, 0, 0, 0, 0, 7, 'dragon', 1, G, 1, 0, 0, 0, 0, 0, 0, 8, 'sheep', NaN, G, 1, 0, 0, 0, 0, 0, 0], info: { 7: null, 8: null } });
    a.em.applySnapshot(2, null);
    a.em.applySnapshot(2, { list: 'no' });
    a.em.adopt(null); a.em.adopt([1, 'dragon', 0, G, 0, 0, 5, null]); a.em.adopt([NaN, 'sheep', 0, G, 0, 0, 5, null]); a.em.adopt([9, 'sheep', Infinity, G, 0, 0, 5, null]);
    run(0.2);
    check('nonsense from another game makes no mob', a.em._mobs.size === 0);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
