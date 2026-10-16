// Commands (engine/Commands.js): a line of chat beginning with "/" — read, checked
// against who typed it, and done through what the world says it can do. Here
// the world is a handful of functions that note what they were asked.
import { CommandRunner, parseCommand, cleanChat, CHAT_MAX } from '../src/scripts/engine/Commands.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
}

/** A world with its owner (Alex), an operator-to-be (Big Al) and a guest (Bo), and a note of everything asked of it. */
function world() {
    const w = {
        people: [
            { id: 1, name: 'Alex', x: 0, y: 70, z: 0, owner: true },
            { id: 2, name: 'Big Al', x: 100, y: 64, z: -40, owner: false },
            { id: 3, name: 'Bo', x: -8, y: 80, z: 8, owner: false },
        ],
        ops: new Set(), acts: [], said: [], told: [], hours: 9, weather: 'dynamic', mobs: [], blocks: [], kicked: [], pvp: true,
    };
    // Who a player is does not change with their name: an operator is kept by that.
    for (const p of w.people) p.key = 'k' + p.id;
    w.run = new CommandRunner({
        players: () => w.people,
        isOp: (p) => w.ops.has(p.key),
        setOp: (p, on) => { const key = p.key ?? w.people.find(q => q.name.toLowerCase() === p.name.toLowerCase())?.key; if (on) w.ops.add(key); else w.ops.delete(key); },
        ops: () => w.people.filter(p => w.ops.has(p.key)).map(p => p.name),
        kick: (id) => (id === 3 ? (w.kicked.push(id), true) : false),
        pvp: () => w.pvp, setPvp: (on) => { w.pvp = on; },
        act: (id, a) => w.acts.push([id, a]),
        hours: () => w.hours, setHours: (h) => { w.hours = h; },
        weathers: () => ['dynamic', 'sunny', 'heavy_rain', 'thunderstorm'],
        setWeather: (id) => { w.weather = id; },
        mobs: () => ['cow', 'pig'],
        summon: (t, x, y, z) => { w.mobs.push([t, x, y, z]); return true; },
        hasItem: (id) => ['torch', 'wood_log', 'stone'].includes(id),
        setBlock: (x, y, z, name) => (['STONE', 'AIR'].includes(name) ? (w.blocks.push([x, y, z, name]), true) : false),
        seed: () => 4242,
        reply: (actor, text) => w.told.push([actor.id, text]),
        announce: (text) => w.said.push(text),
    });
    w.as = (name, text) => w.run.run(w.people.find(p => p.name === name), text);
    return w;
}

// ── Reading a line ───────────────────────────────────────────────────────────
{
    const c = parseCommand('/give "Big Al" torch 4');
    check('a line is split into its words, a quoted name staying whole', c.name === 'give' && c.args.join('|') === 'Big Al|torch|4');
    check('what does not begin with a slash is not a command', parseCommand('hello /there') === null && parseCommand('/') === null);
    check('chat is one line, without control characters, and no longer than it may be',
        cleanChat('a\nb\u0000c') === 'a b c' && cleanChat('x'.repeat(999)).length === CHAT_MAX && cleanChat(null) === '');
}

// ── Who may ──────────────────────────────────────────────────────────────────
{
    const w = world();
    w.as('Bo', '/time set noon');
    check('a player without operator status may not change the world', w.hours === 9 && w.said.length === 0 && /operator/.test(w.told.at(-1)?.[1] ?? ''), w.told.at(-1)?.[1]);
    check('… and is told so alone', w.told.at(-1)[0] === 3);
    w.as('Bo', '/op Bo');
    check('… nor give it to themselves', w.ops.size === 0);
    w.as('Bo', '/list');
    check('… but may ask who is here', /Alex\*, Big Al, Bo/.test(w.told.at(-1)[1]), w.told.at(-1)[1]);
    w.as('Bo', '/help');
    check('… and is shown only what they may use', /\/help/.test(w.told.at(-2)[1]) && !/\/give/.test(w.told.at(-2)[1]), w.told.at(-2)[1]);

    w.as('Alex', '/time set noon');
    check('the world\'s owner always may', w.hours === 12 && /Alex set the time to 12:00/.test(w.said.at(-1)));
    w.as('Alex', '/op big');
    check('the owner gives operator status, by the beginning of a name', w.ops.has('k2') && /made Big Al an operator/.test(w.said.at(-1)));
    w.people[1].name = 'Albert';
    w.as('Albert', '/time set 15');
    check('… which a change of name does not lose', w.hours === 15);
    w.people[1].name = 'Big Al';
    w.as('Big Al', '/weather heavy_rain');
    check('… and an operator may then change the world', w.weather === 'heavy_rain' && /Big Al set the weather to heavy rain/.test(w.said.at(-1)), w.said.at(-1));
    w.as('Alex', '/deop "Big Al"');
    w.as('Big Al', '/weather sunny');
    check('… until it is taken away', !w.ops.has('k2') && w.weather === 'heavy_rain');
    w.as('Alex', '/op Alex');
    check('the owner is not made an operator twice', w.ops.size === 0);
}

// ── What they do ─────────────────────────────────────────────────────────────
{
    const w = world();
    w.as('Alex', '/time add 20');
    check('time is added round the clock', Math.abs(w.hours - 5) < 1e-9 && /05:00/.test(w.said.at(-1)), `${w.hours}`);
    w.as('Alex', '/time set 99');
    check('a time that is none is refused, with how it is used', Math.abs(w.hours - 5) < 1e-9 && /^Usage: \/time/.test(w.told.at(-1)[1]));
    w.as('Alex', '/weather snowballs');
    check('a weather there is none of is refused', w.weather === 'dynamic' && /no weather/.test(w.told.at(-1)[1]));
    w.as('Alex', '/weather Thunderstorm');
    check('weather is taken in any case', w.weather === 'thunderstorm');

    w.as('Alex', '/gamemode creative');
    check('a mode with no name is for whoever asked', w.acts.at(-1)[0] === 1 && w.acts.at(-1)[1].k === 'mode' && w.acts.at(-1)[1].mode === 'CREATIVE');
    w.as('Alex', '/gm sp Bo');
    check('… and with one, for that player, in their own game', w.acts.at(-1)[0] === 3 && w.acts.at(-1)[1].mode === 'SPECTATOR' && /put Bo in Spectator mode/.test(w.said.at(-1)), w.said.at(-1));
    w.as('Alex', '/gamemode flying');
    check('a mode there is none of does nothing', w.acts.length === 2);

    w.as('Alex', '/tp Bo');
    check('/tp <player> goes to them', w.acts.at(-1)[0] === 1 && w.acts.at(-1)[1].x === -8 && w.acts.at(-1)[1].y === 80);
    w.as('Alex', '/tp ~ ~10 ~-2');
    check('"~" is where the player stands', w.acts.at(-1)[1].x === 0 && w.acts.at(-1)[1].y === 80 && w.acts.at(-1)[1].z === -2);
    w.as('Alex', '/tp Bo "Big Al"');
    check('/tp <who> <player> sends one to another', w.acts.at(-1)[0] === 3 && w.acts.at(-1)[1].x === 100);
    w.as('Alex', '/tp Bo 5 90 5');
    check('/tp <who> <x> <y> <z> sends them to a place', w.acts.at(-1)[0] === 3 && w.acts.at(-1)[1].y === 90);
    const n = w.acts.length;
    w.as('Alex', '/tp 1e9 0 0'); w.as('Alex', '/tp x y z'); w.as('Alex', '/tp Nobody'); w.as('Alex', '/tp');
    check('nowhere, nonsense and nobody move no one', w.acts.length === n);

    w.as('Alex', '/give torch 16');
    check('/give <item> <count> hands it to whoever asked', w.acts.at(-1)[0] === 1 && w.acts.at(-1)[1].item === 'torch' && w.acts.at(-1)[1].n === 16);
    w.as('Alex', '/give Bo wood_log 3');
    check('… or, the player first, to them', w.acts.at(-1)[0] === 3 && w.acts.at(-1)[1].item === 'wood_log' && w.acts.at(-1)[1].n === 3);
    w.as('Alex', '/give stone Bo');
    check('… or one, with the player last', w.acts.at(-1)[0] === 3 && w.acts.at(-1)[1].n === 1);
    const g = w.acts.length;
    w.as('Alex', '/give dragon_egg'); w.as('Alex', '/give torch 100000'); w.as('Alex', '/give torch 2 Nobody');
    check('no such item, too many, or nobody: nothing is handed over', w.acts.length === g);

    w.as('Alex', '/heal Bo'); w.as('Alex', '/kill');
    check('healing and killing reach the right game', w.acts.at(-2)[0] === 3 && w.acts.at(-2)[1].k === 'heal' && w.acts.at(-1)[0] === 1 && w.acts.at(-1)[1].k === 'kill');

    w.as('Alex', '/summon cow 3');
    check('mobs are summoned round whoever asked, not on one spot', w.mobs.length === 3 && new Set(w.mobs.map(m => `${m[1].toFixed(1)},${m[3].toFixed(1)}`)).size === 3 && w.mobs.every(m => Math.hypot(m[1], m[3]) > 1.5));
    w.as('Alex', '/summon dragon'); w.as('Alex', '/summon cow 500');
    check('… and not what there is none of, nor a herd', w.mobs.length === 3);

    w.as('Alex', '/setblock ~ ~-1 ~ stone');
    check('a block is put where it is said', w.blocks.at(-1).join() === '0,69,0,STONE');
    w.as('Alex', '/setblock 0 0 0 cheese');
    check('… and an unknown block is not', w.blocks.length === 1 && /no block/.test(w.told.at(-1)[1]));

    w.as('Alex', '/kick Bo');
    check('a player is sent away', w.kicked.join() === '3' && /removed Bo/.test(w.said.at(-1)));
    w.as('Alex', '/kick Alex'); w.as('Alex', '/kick Nobody');
    check('… but not oneself, nor nobody', w.kicked.length === 1);
    w.as('Alex', '/pvp off');
    check('PvP is turned off, and on again', w.pvp === false && (w.as('Alex', '/pvp on'), w.pvp === true) && (w.as('Alex', '/pvp maybe'), w.pvp === true));

    w.as('Alex', '/say dinner is ready');
    check('/say tells everyone', w.said.at(-1) === '[Alex] dinner is ready');
    w.as('Alex', '/seed');
    check('/seed answers the one who asked', w.told.at(-1)[0] === 1 && /4242/.test(w.told.at(-1)[1]));
    check('an unknown command says so', w.as('Alex', '/dance') === true && /no command/.test(w.told.at(-1)[1]));
    check('… and one that is a property of every object is not a command', (w.as('Alex', '/constructor'), /no command/.test(w.told.at(-1)[1])) && (w.as('Alex', '/help toString'), /no command/.test(w.told.at(-1)[1])));
    check('a line that is not a command is not run', w.as('Alex', 'hello') === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
