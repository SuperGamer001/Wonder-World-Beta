// The blocks that are not cubes, played with: doors, slabs, stairs, beds, pots,
// cake, ladders, buckets and water, fire, a bomb, a sapling, the map — in the
// real game, by a player who looks at things and uses them.
//
//     npm run test:decor
//
// This is not a module: it is the body of a function run INSIDE the game's
// page by the screenshot tool (test/terrainshots.mjs --eval-file), which has
// the game up in a headless browser on the real GPU. What it returns is
// printed; the last line says how many checks failed.
//
// The player's hands are a made-up controller (as in the smoke test): a page
// cannot be given the pointer here, and a controller needs none — so, unlike
// the play test, this never takes the mouse of whoever is at the machine.
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const frames = (n = 4) => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const out = [];
const check = (name, ok, detail = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);

const idOf = Object.fromEntries(mergedGamePackData.blocks.map(b => [b.name, b.id]));
const nameOf = Object.fromEntries(mergedGamePackData.blocks.map(b => [b.id, b.name]));
const p0 = window.me.position;
const O = { x: Math.floor(p0.x) + 3, y: Math.floor(p0.y) + 34, z: Math.floor(p0.z) + 3 };
const S = (x, y, z, name) => window.__wwSetBlock(O.x + x, O.y + y, O.z + z, name);
const at = (x, y, z) => nameOf[window.__wwBlockAt(O.x + x, O.y + y, O.z + z)] ?? '?';
const stand = (x, y, z) => window.__wwTeleport(O.x + x, O.y + y, O.z + z);
const look = (tx, ty, tz) => {
    const p = window.me.position, dx = O.x + tx - p.x, dy = O.y + ty - (p.y + 1.6), dz = O.z + tz - p.z;
    window.__wwLook(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
};
// (In every slot of the hotbar: whichever is the one in hand.)
const hold = (item) => { const h = window.me.inventory.hotbar; for (let i = 0; i < h.length; i++) h[i] = item ? { itemId: item, count: 8 } : null; };
const mode = (m) => { const e = new Event('WorldJS_setGameMode'); e.data = { gameMode: m }; document.dispatchEvent(e); };
const until = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await wait(120); } return !!fn(); };

// ── A controller, and the game going ─────────────────────────────────────────
const pad = { connected: true, mapping: 'standard', id: 'Test pad', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
navigator.getGamepads = () => [pad];
window.dispatchEvent(new Event('gamepadconnected'));
const press = (i, on) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
const tap = async (i) => { press(i, true); await frames(5); press(i, false); await frames(5); };
const use = () => tap(6);                 // the left trigger: place, use
const hit = async () => { press(7, true); await frames(3); press(7, false); await frames(5); };   // the right trigger: break
pad.axes[2] = 0.4; await frames(5); pad.axes[2] = 0; await frames(3);      // a touch of the stick: the controller is the device in use
if (paused) await tap(0);                 // the pause menu is up (no pointer lock here): A on Resume
await until(() => !paused, 3000);
check('the game plays, with a controller and no pointer lock', !paused && !document.pointerLockElement, `paused=${paused}`);
mode('CREATIVE');

// ── A floor in the air, with a rim, to try things on ─────────────────────────
for (let x = -1; x <= 15; x++) for (let z = -1; z <= 15; z++) {
    S(x, 0, z, 'STONE_BRICKS');
    for (let y = 1; y <= 5; y++) S(x, y, z, x === -1 || x === 15 || z === -1 || z === 15 ? (y === 1 ? 'STONE_BRICKS' : 'AIR') : 'AIR');
}
stand(7.5, 1, 8.2);
await wait(2500);

// ── A door ───────────────────────────────────────────────────────────────────
// (What the game asks the mixer to play, by name.)
const heard = [];
const playSound = window.__wwSound.play.bind(window.__wwSound);
window.__wwSound.play = (name, o) => { heard.push(name); return playSound(name, o); };
S(2, 1, 5, 'WOODEN_DOOR_SOUTH'); S(2, 2, 5, 'WOODEN_DOOR_SOUTH_TOP');
stand(2.5, 1, 8.2); await frames(3);
look(2.5, 1.5, 5.1); await frames(3); heard.length = 0; await use();
const openSound = heard.filter(n => n.startsWith('door_'));
check('a door opens, both halves — with the sound of a door opening, once', at(2, 1, 5) === 'WOODEN_DOOR_SOUTH_OPEN' && at(2, 2, 5) === 'WOODEN_DOOR_SOUTH_OPEN_TOP' && openSound.join() === 'door_open',
    `${at(2, 1, 5)} / ${at(2, 2, 5)}; heard ${heard.join(', ')}`);
look(2.5, 1.5, 5.1); await frames(3); await use();
const through = at(2, 1, 5);              // open, the middle of the doorway is empty: the look goes through
await wait(200); heard.length = 0;
look(2.92, 1.5, 5.5); await frames(3); await use();
check('… is looked through where it stands open, and shut by its leaf — with the sound of it shutting', through === 'WOODEN_DOOR_SOUTH_OPEN' && at(2, 1, 5) === 'WOODEN_DOOR_SOUTH' && at(2, 2, 5) === 'WOODEN_DOOR_SOUTH_TOP' && heard.includes('door_close'),
    `${through} → ${at(2, 1, 5)}; heard ${heard.join(', ')}`);
hold('wooden_door'); stand(4.5, 1, 8.2); await frames(3); look(4.5, 1.0, 5.5); await frames(3); await use();
check('a door is put down with its top, turned the way the player looks', at(4, 1, 5) === 'WOODEN_DOOR_NORTH' && at(4, 2, 5) === 'WOODEN_DOOR_NORTH_TOP', `${at(4, 1, 5)} / ${at(4, 2, 5)}`);
// A second door beside it, the same way round: hung on the other side, so the two are a pair.
stand(5.5, 1, 8.2); await frames(3); look(5.5, 1.0, 5.5); await frames(3); await use();
check('a door put down beside another is hung on its other side: double doors', at(5, 1, 5) === 'WOODEN_DOOR_NORTH_RIGHT' && at(5, 2, 5) === 'WOODEN_DOOR_NORTH_RIGHT_TOP', `${at(5, 1, 5)} / ${at(5, 2, 5)}`);
look(5.5, 1.5, 5.9); await frames(3); await hit();
look(4.5, 1.5, 5.9); await frames(3); await hit();
check('breaking one half takes the other', at(4, 1, 5) === 'AIR' && at(4, 2, 5) === 'AIR' && at(5, 1, 5) === 'AIR', `${at(4, 1, 5)} / ${at(4, 2, 5)}`);

// A gate opens away from whoever opens it, from either side.
S(13, 1, 3, 'FENCE_GATE'); await frames(4);               // facing east: its front is +x
hold(null); stand(11.6, 1, 3.5); await frames(3); look(13.5, 1.5, 3.5); await frames(3); await use();
const fromBack = at(13, 1, 3);
await use();
const shutAgain = at(13, 1, 3);
stand(14.4, 1, 3.5); await frames(3); look(13.5, 1.5, 3.5); await frames(3); await use();
const fromFront = at(13, 1, 3);
check('a gate opens away from whoever opens it, either way, and shuts from where it is open — and sounds like a gate', fromBack === 'FENCE_GATE_OPEN' && shutAgain === 'FENCE_GATE' && fromFront === 'FENCE_GATE_OPEN_BACK' && heard.includes('gate_open') && heard.includes('gate_close'),
    `${fromBack} → ${shutAgain}; ${fromFront}; heard ${[...new Set(heard)].join(', ')}`);
S(13, 1, 3, 'AIR');

// ── Slabs, stairs ────────────────────────────────────────────────────────────
hold('wooden_slab'); stand(6.5, 1, 8.2); await frames(3); look(6.5, 1.0, 5.5); await frames(3); await use();
const lower = at(6, 1, 5);
look(6.5, 1.5, 5.5); await frames(3); await use();
check('a slab on a floor is the lower half; another on it makes a whole block', lower === 'WOODEN_SLAB' && at(6, 1, 5) === 'WOODEN_PLANKS', `${lower} → ${at(6, 1, 5)}`);
S(8, 1, 4, 'STONE'); S(8, 2, 4, 'STONE'); await frames(4);
stand(8.5, 1, 8.2); await frames(3); look(8.5, 1.85, 5.0); await frames(3); await use();
check('… and against the upper part of a wall, the upper half', at(8, 1, 5) === 'WOODEN_SLAB_TOP', at(8, 1, 5));
hold('stone_brick_stairs'); stand(10.5, 1, 8.2); await frames(3); look(10.5, 1.0, 5.5); await frames(3); await use();
check('stairs go up the way the player looks', at(10, 1, 5) === 'STONE_BRICK_STAIRS_NORTH', at(10, 1, 5));
S(12, 1, 4, 'STONE'); await frames(4);
hold('brick_wall_slab'); stand(12.5, 1, 8.2); await frames(3); look(12.5, 1.5, 5.0); await frames(3); await use();
check('a wall slab stands against the wall it is put on', at(12, 1, 5) === 'BRICK_WALL_SLAB_NORTH', at(12, 1, 5));

// ── Furniture, a bed ─────────────────────────────────────────────────────────
hold('chair'); stand(1.5, 1, 13.2); await frames(3); look(1.5, 1.0, 10.5); await frames(3); await use();
check('a chair is put down facing whoever puts it down', at(1, 1, 10) === 'CHAIR_SOUTH', at(1, 1, 10));
hold(null); look(1.5, 1.4, 10.5); await frames(3); await use(); await frames(6);
const seated = window.__wwRest();
check('a chair is sat in', seated?.kind === 'sit' && seated.x === O.x + 1 && seated.z === O.z + 10, JSON.stringify(seated));
await tap(1);                              // B: get up
check('… and got up from, standing beside it', !window.__wwRest() && Math.abs(window.me.position.y - (O.y + 1)) < 0.05, `${JSON.stringify(window.__wwRest())} y ${(window.me.position.y - O.y).toFixed(2)}`);
// Sat in, in Survival, it rests the sitter a little.
mode('SURVIVAL'); window.me.energy = 50;
look(1.5, 1.4, 10.5); await frames(3); await use(); await wait(3000);
const rested = window.me.energy;
await tap(1); mode('CREATIVE');
check('… and sitting in it rests the sitter a little', rested > 50.05 && rested < 52, `energy 50 → ${rested.toFixed(2)}`);

// An open curtain is met across its whole width: drawn shut by looking through the gap in it.
S(9, 1, 12, 'RED_CURTAIN_OPEN'); await frames(4);
stand(7.5, 1, 12.5); await frames(3); look(9.1, 1.5, 12.5); await frames(3); await use();
check('an open curtain is drawn shut by a look through the gap in it', at(9, 1, 12) === 'RED_CURTAIN', at(9, 1, 12));
S(9, 1, 12, 'AIR');
hold('bed'); stand(3.5, 1, 13.2); await frames(3); look(3.5, 1.0, 10.5); await frames(3); await use();
check('a bed is two blocks: its foot, and its head beyond', at(3, 1, 10) === 'BED_NORTH' && at(3, 1, 9) === 'BED_HEAD_NORTH', `${at(3, 1, 10)} / ${at(3, 1, 9)}`);
hold(null); look(3.5, 1.45, 10.5); await frames(3); await use(); await frames(6);
const bed = window.__wwMapInfo().bed, lying = window.__wwRest();
check('lying in it makes it where the player wakes', !!bed && bed.x === O.x + 3 && bed.y === O.y + 1 && bed.z === O.z + 10, JSON.stringify(bed));
check('… and the player lies in it, until they get up', lying?.kind === 'lie', JSON.stringify(lying));
await tap(1); await frames(4);
check('… beside it', !window.__wwRest() && Math.abs(window.me.position.y - (O.y + 1)) < 0.05, `y ${(window.me.position.y - O.y).toFixed(2)}`);

// Slept in, at any hour: every few seconds the clock cuts forward an hour, and
// the world with it (a sapling nearby grows meanwhile), until sunrise wakes the
// sleeper — rested, healed, a little hungrier.
S(20, 0, 20, 'STONE_BRICKS'); S(20, 1, 20, 'OAK_SAPLING');
const A = window.__wwAtmos();
A.setDaylightCycle(true); A.setHours(20);
mode('SURVIVAL'); window.me.energy = 20; window.me.hunger = 80; window.me.health = 50;
stand(3.5, 1, 13.2); await frames(3); look(3.5, 1.45, 10.5); await frames(3); await use();
const h0 = A.day.hours;
await wait(3600);
const h1 = A.day.hours;
const woke = await until(() => !window.__wwRest(), 45000);
const h2 = A.day.hours, rest = { energy: window.me.energy, hunger: window.me.hunger, health: window.me.health };
mode('CREATIVE');
check('a bed is slept in at night: the clock cuts forward an hour every few seconds', h0 > 19.9 && h0 < 20.2 && h1 > 20.9 && h1 < 21.5, `${h0.toFixed(2)} → ${h1.toFixed(2)}`);
check('… until sunrise wakes the sleeper', woke && Math.abs(h2 - 6) < 0.05, `woke ${woke} at ${h2.toFixed(2)}`);
check('… rested, healed, and a little hungrier', rest.energy > 95 && rest.health > 90 && rest.hunger < 70 && rest.hunger > 55, JSON.stringify(rest));
check('… and the world went on meanwhile: a sapling beside grew into a tree', at(20, 1, 20) !== 'OAK_SAPLING' && at(20, 1, 20) !== 'AIR', at(20, 1, 20));
for (let x = 15; x <= 25; x++) for (let y = 1; y <= 14; y++) for (let z = 15; z <= 25; z++) if (x > 15 || z > 15) S(x, y, z, 'AIR');
S(20, 0, 20, 'AIR');
// And by day too: lain in at noon, it is evening when they wake.
A.setHours(12); await frames(3);
look(3.5, 1.45, 10.5); await frames(3); await use();
const dayWoke = await until(() => !window.__wwRest(), 30000);
check('a bed is slept in by day too, until sunset', dayWoke && Math.abs(A.day.hours - 18) < 0.05, `woke ${dayWoke} at ${A.day.hours.toFixed(2)}`);
stand(3.5, 1, 13.2); await frames(3); look(3.5, 1.45, 10.5); await frames(3); await hit();
check('… and it is broken as one', at(3, 1, 10) === 'AIR' && at(3, 1, 9) === 'AIR', `${at(3, 1, 10)} / ${at(3, 1, 9)}`);

// ── A pot, a cake, a ladder ──────────────────────────────────────────────────
S(5, 1, 10, 'FLOWER_POT'); await frames(4);
hold('tulip'); stand(5.5, 1, 13.2); await frames(3); look(5.5, 1.2, 10.5); await frames(3); await use();
const potted = at(5, 1, 10);
hold(null); await use();
check('a flower goes into a pot, and comes out again', potted === 'POTTED_TULIP' && at(5, 1, 10) === 'FLOWER_POT', `${potted} → ${at(5, 1, 10)}`);
// A plate: food put on it, and taken off again.
S(5, 1, 12, 'PLATE'); await frames(4);
hold('apple'); stand(5.5, 1, 14.2); await frames(3); look(5.5, 1.05, 12.5); await frames(3); await use();
const plated = at(5, 1, 12);
hold(null); await use();
check('food goes on a plate, and comes off again', plated === 'PLATE_APPLE' && at(5, 1, 12) === 'PLATE', `${plated} → ${at(5, 1, 12)}`);
S(5, 1, 12, 'AIR');
S(7, 1, 10, 'CAKE'); await frames(4);
stand(7.5, 1, 13.2); await frames(3); look(7.5, 1.3, 10.5); await frames(3); await use();
check('a cake is eaten a piece at a time', at(7, 1, 10) === 'CAKE_1', at(7, 1, 10));
S(9, 1, 9, 'STONE'); S(9, 2, 9, 'STONE'); await frames(4);
hold('ladder'); stand(9.5, 1, 13.2); await frames(3); look(9.5, 1.5, 10.0); await frames(3); await use();
check('a ladder goes on the wall it is put against', at(9, 1, 10) === 'LADDER_SOUTH', at(9, 1, 10));
window.__wwBreak(O.x + 9, O.y + 1, O.z + 9); await frames(6);
check('… and comes down with it', at(9, 1, 10) === 'AIR', at(9, 1, 10));
S(9, 2, 9, 'AIR');

// ── A painting two blocks wide, and a spruce log ─────────────────────────────
for (let x = 9; x <= 12; x++) for (let y = 1; y <= 3; y++) S(x, y, 2, 'STONE');
await frames(4);
hold('painting_wide'); stand(10.5, 1, 5.5); await frames(3); look(10.5, 1.6, 3.0); await frames(3); await use();
const wide = [at(10, 1, 3), at(11, 1, 3), at(9, 1, 3)];
check('a wide painting is put up as two pieces, to the right as it is seen', /^PAINTING_WIDE/.test(wide[0]) && /^PAINTING_WIDE/.test(wide[1]) && wide[2] === 'AIR', wide.join(' '));
look(11.5, 1.5, 3.05); await frames(3); await hit();
check('… and taken down whole from either piece', at(10, 1, 3) === 'AIR' && at(11, 1, 3) === 'AIR', `${at(10, 1, 3)} ${at(11, 1, 3)}`);
for (let x = 9; x <= 12; x++) for (let y = 1; y <= 3; y++) S(x, y, 2, 'AIR');
mode('SURVIVAL');
S(9, 1, 10, 'SPRUCE_LOG'); await frames(4);
const logsBefore = window.me.inventory.countItem('spruce_log');
hold('iron_axe'); stand(9.5, 1, 12.2); await frames(3); look(9.5, 1.5, 10.5); await frames(3);
press(7, true); await until(() => at(9, 1, 10) === 'AIR', 6000); press(7, false); await frames(4);
check('a spruce log mined is a spruce log', window.me.inventory.countItem('spruce_log') === logsBefore + 1, `${window.me.inventory.countItem('spruce_log') - logsBefore} spruce logs`);
mode('CREATIVE');

// ── Water: a bucket emptied, the water running, and taken up again ───────────
hold('water_bucket'); stand(12.5, 1, 13.4); await frames(3); look(12.5, 1.0, 10.5); await frames(3); await use();
const source = at(12, 1, 10);
await until(() => at(13, 1, 10) === 'WATER_7' && at(12, 1, 8) === 'WATER_6', 4000);
check('a bucket of water is a source, and it runs', source === 'WATER' && at(13, 1, 10) === 'WATER_7' && at(12, 1, 8) === 'WATER_6', `${source}, ${at(13, 1, 10)}, ${at(12, 1, 8)}`);
await wait(1500);
hold('bucket'); look(12.5, 1.6, 10.5); await frames(3); await use();
const taken = at(12, 1, 10) !== 'WATER';
const dry = await until(() => { for (let x = 0; x < 15; x++) for (let z = 0; z < 15; z++) if (/^WATER/.test(at(x, 1, z))) return false; return true; }, 9000);
check('taken up with a bucket, the water it fed goes', taken && dry, `taken=${taken} dry=${dry}`);

// ── Fire ─────────────────────────────────────────────────────────────────────
for (let x = 9; x <= 11; x++) S(x, 1, 2, 'RED_WOOL');
await frames(4);
hold('flint_and_steel'); stand(9.5, 1, 5.6); await frames(3); look(9.5, 1.5, 3.0); await frames(3); await use();
const lit = at(9, 1, 3);
const burnt = await until(() => [9, 10, 11].some(x => at(x, 1, 2) !== 'RED_WOOL'), 25000);
check('flint and steel lights a fire, and it burns what is beside it', lit === 'FIRE' && burnt, `${lit}; wool: ${[9, 10, 11].map(x => at(x, 1, 2)).join(' ')}`);
const out2 = await until(() => !window.__wwTicking().some(e => e.kind === 'fire'), 60000);
check('… and burns out', out2, `${window.__wwTicking().filter(e => e.kind === 'fire').length} fires left`);

// ── A bomb ───────────────────────────────────────────────────────────────────
S(13, 1, 2, 'BOMB'); await frames(4);
hold('flint_and_steel'); stand(13.5, 1, 5.8); await frames(3); look(13.5, 1.3, 2.5); await frames(3); await use();
const fuse = at(13, 1, 2);
const gone = await until(() => at(13, 1, 2) === 'AIR' && at(13, 0, 2) === 'AIR', 7000);
check('a bomb is lit, and goes off, and takes the ground with it', fuse === 'BOMB_LIT' && gone && at(11, 0, 2) === 'AIR' && at(6, 0, 2) === 'STONE_BRICKS', `${fuse}; ${at(13, 0, 2)} ${at(11, 0, 2)} ${at(6, 0, 2)}`);

// ── A sapling ────────────────────────────────────────────────────────────────
S(13, 1, 12, 'OAK_SAPLING'); await frames(4);
const grew = window.__wwGrow(O.x + 13, O.y + 1, O.z + 12);
await frames(6);
let leaves = 0;
for (let x = 10; x <= 16; x++) for (let y = 3; y <= 9; y++) for (let z = 9; z <= 15; z++) if (at(x, y, z) === 'LEAVES') leaves++;
check('a sapling grows into a tree', grew && at(13, 1, 12) === 'WOOD' && at(13, 3, 12) === 'WOOD' && leaves > 10, `${at(13, 1, 12)}, ${leaves} leaves`);

// ── On foot: up a flight of stairs, up a ladder, and stopped by a fence ──────
mode('SURVIVAL');
for (let k = 0; k < 3; k++) { for (let y = 1; y <= k; y++) S(6, y, 12 - k, 'WOODEN_PLANKS'); S(6, 1 + k, 12 - k, 'WOODEN_STAIRS_NORTH'); }
await frames(6);
stand(6.5, 1.02, 13.6); window.__wwLook(0, 0); await wait(400);
let top = 0; pad.axes = [0, -1, 0, 0];
for (let i = 0; i < 30; i++) { await wait(100); top = Math.max(top, window.me.position.y - O.y); }
pad.axes = [0, 0, 0, 0];
check('a flight of stairs is walked up, with no jumping', top > 3.9, `reached ${top.toFixed(2)} above the floor`);
for (let y = 1; y <= 4; y++) { S(1, y, 14, 'STONE'); S(1, y, 13, 'LADDER_NORTH'); }
await frames(6);
stand(1.5, 1.02, 12.3); window.__wwLook(Math.PI, 0); await wait(400);
top = 0; pad.axes = [0, -1, 0, 0];
for (let i = 0; i < 30; i++) { await wait(100); top = Math.max(top, window.me.position.y - O.y); }
pad.axes = [0, 0, 0, 0];
check('a ladder is climbed by walking into it', top > 3.2, `reached ${top.toFixed(2)} above the floor`);
for (let x = 0; x <= 14; x++) S(x, 1, 7, 'WOODEN_FENCE');
await frames(6);
stand(10.5, 1.02, 9.5); window.__wwLook(0, 0); await wait(400);
pad.axes = [0, -1, 0, 0]; press(0, true);          // forward, jumping all the way
let north = 99;
for (let i = 0; i < 25; i++) { await wait(100); north = Math.min(north, window.me.position.z - O.z); }
pad.axes = [0, 0, 0, 0]; press(0, false);
check('a fence is not jumped over', north > 7.8, `got as far north as z ${north.toFixed(2)} (the fence is at 7.5)`);

// ── The map ──────────────────────────────────────────────────────────────────
mode('CREATIVE');
stand(7.5, 1.02, 10.5); hold('map'); await frames(4); await use();
const opened = _mapOpen && !document.getElementById('MapScreen').classList.contains('hidden');
await until(() => { const d = _mapSheet?.canvas.getContext('2d').getImageData(0, 0, 128, 128).data; let n = 0; if (d) for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n === 128 * 128; }, 15000);
const d = _mapSheet?.canvas.getContext('2d').getImageData(0, 0, 128, 128).data;
let painted = 0, colours = new Set();
if (d) for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { painted++; colours.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4); }
check('a map in hand, used, shows the land', opened && painted === 128 * 128 && colours.size > 8, `open=${opened} painted=${painted} colours=${colours.size}`);
await wait(500);
window.__mapShot = true;

// (Drawn by BlockIcons.js, and made into images off the main thread: blob URLs.)
const drawnIcons = Object.keys(_itemIcons).filter(k => /^(blob|data):/.test(String(_itemIcons[k]))).length;
check('the blocks that are not cubes have pictures of themselves', drawnIcons > 45, String(drawnIcons));
const failed = out.filter(l => l.startsWith('FAIL')).length;
out.push(failed ? `${failed} FAILED` : 'ALL PASS');
return '\n' + out.join('\n');
