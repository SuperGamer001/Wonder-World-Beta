// Playing, as a player with a mouse and keys does it — see playHarness.mjs,
// which starts the real game in a headless browser, in a flat survival world,
// with the pointer really lockable and Esc really the browser's key.
//
// What is asked here is what went wrong once: the pointer lost for good after
// a menu closed, the pause menu over the death screen, armor in any slot, a
// recipe unchosen by every craft, a chest that was a crafting bench, tools
// that mined everything, mobs struck through walls and walled into blocks.
import { ev, sleep, until, ck, tap, key, click, clickOn, mouse, state, show, playing, backToPlay, base, world, finish } from './playHarness.mjs';

const settle = (ms = 900) => sleep(ms);
/** Wait until playing (the pointer held, nothing up), for as long as a slow machine may need. */
const untilPlaying = async (ms = 6000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; ) { if (playing(await state())) return true; await sleep(120); } return false; };

// ── The pointer, and the menus round it ──────────────────────────────────────

// A world that has only just loaded has no click behind it: the browser may not
// give the pointer. Then the game says what does, and a click on the world does.
let s = await state();
if (!s.locked) {
    ck('with the pointer not held, the game says how to take it', await until(`!document.getElementById('clickToPlay').classList.contains('hidden')`, 4000), show(s));
    await click();
}
ck('a click on the world takes the pointer', await untilPlaying(), show(await state()));
ck('… and the note goes', await until(`document.getElementById('clickToPlay').classList.contains('hidden')`, 2000));

await tap('KeyE'); await settle();
s = await state();
ck('E opens the inventory: the pointer is let go, and that is not a pause', s.inv && s.menu && !s.locked && !s.paused && !s.pause, show(s));
await clickOn('#invCloseBtn');
ck('its Close button goes back to playing, pointer and all', await untilPlaying(), show(await state()));

await tap('KeyE'); await settle();
await tap('Escape');
ck('Esc closes it and goes back to playing — not to the pause menu', await untilPlaying(), show(await state()));
await settle(1500);
ck('… and stays there', playing(await state()), show(await state()));

await tap('KeyE'); await settle();
await tap('KeyE');
ck('E closes what E opened', await untilPlaying(), show(await state()));

await tap('KeyC'); await settle();
s = await state();
ck('C opens hand crafting', s.panel && s.menu && !s.paused, show(s));
await tap('KeyC');
ck('… and C closes it', await untilPlaying(), show(await state()));

await tap('Escape'); await settle();
s = await state();
ck('Esc while playing is the pause menu', s.pause && s.paused && !s.locked, show(s));
await sleep(1400);                       // (a browser refuses the pointer for a moment after Esc)
await clickOn('#PauseScreen .menuButton.primary');
ck('Resume goes back to playing', await untilPlaying(), show(await state()));

// ── Dying ────────────────────────────────────────────────────────────────────

await ev(`window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage: 5000 } })); 1`);
await settle(1500);
s = await state();
ck('dead: the death screen, the pointer free — and no pause menu over it', s.death && !s.locked && !s.pause, show(s));
await tap('Escape'); await settle(600);
s = await state();
ck('Esc does not put it away, or bring the pause menu', s.death && !s.pause, show(s));
await clickOn('#respawnBtn');
ck('Respawn goes back to playing', await untilPlaying(20000), show(await state()));
await until(`window.__wwDebug().player.y < 70`, 20000, 300);      // on the ground again
await settle(1500);

// ── What is worn goes where it is worn ───────────────────────────────────────

const inv = (expr) => ev(`(() => { const inv = window.me.inventory; return ${expr}; })()`);
await inv(`(inv.hotbar.fill(null), inv.slots.length = 0, inv.addItem('dirt', 8), inv.addItem('iron_helmet', 1), inv.addItem('iron_boots', 1), inv.addItem('wood_log', 6), 1)`);
await tap('KeyE'); await settle();
const slot = (type, index) => `.invGridSlot[data-slot-type="${type}"][data-slot-index="${index}"]`;
const cursor = () => ev(`_invCursor ? _invCursor.itemId : null`);
await clickOn(slot('hotbar', 0));                      // the dirt
ck('a click picks a stack up', (await cursor()) === 'dirt');
await clickOn(slot('equip', 'head'));
ck('dirt is not worn: the head slot will not take it', (await cursor()) === 'dirt' && (await inv(`inv.equipment.head`)) === null);
await clickOn(slot('hotbar', 0));                      // back where it was
await clickOn(slot('hotbar', 1));                      // the helmet
await clickOn(slot('equip', 'feet'));
ck('a helmet does not go on the feet', (await cursor()) === 'iron_helmet' && (await inv(`inv.equipment.feet`)) === null);
await clickOn(slot('equip', 'quiver'));
ck('… nor in the quiver\'s place', (await cursor()) === 'iron_helmet' && (await inv(`inv.equipment.quiver`)) === null);
await clickOn(slot('equip', 'head'));
ck('… it goes on the head', (await cursor()) === null && (await inv(`inv.equipment.head?.itemId`)) === 'iron_helmet');
await clickOn(slot('hotbar', 2));                      // the boots
await clickOn(slot('equip', 'head'));                  // where the helmet is
ck('boots are not swapped onto the head either', (await cursor()) === 'iron_boots' && (await inv(`inv.equipment.head?.itemId`)) === 'iron_helmet');
await clickOn(slot('equip', 'feet'));
ck('… they go on the feet', (await cursor()) === null && (await inv(`inv.equipment.feet?.itemId`)) === 'iron_boots');
await clickOn('#invCloseBtn');
await untilPlaying();

// ── Crafting ─────────────────────────────────────────────────────────────────

await tap('KeyC'); await settle();
const recipes = () => ev(`[...document.querySelectorAll('.recipeListItem')].map(e => e.dataset.recipe)`);
const chosen = () => ev(`document.querySelector('.recipeListItem.active')?.dataset.recipe ?? null`);
const hand = await recipes();
ck('hand crafting lists its recipes', hand.length > 0 && hand.includes('stick'), hand.join(' '));
await clickOn('#recipe-stick');
ck('a recipe is chosen by clicking it', (await chosen()) === 'stick');
const sticks0 = await inv(`inv.countItem('stick')`);
await clickOn('#craftBtn'); await settle(400);
ck('Craft makes it', (await inv(`inv.countItem('stick')`)) > sticks0 && (await inv(`inv.countItem('wood_log')`)) === 5);
ck('… and the recipe stays chosen, ready to be made again', (await chosen()) === 'stick' &&
    (await ev(`!document.getElementById('craftBtn').classList.contains('cannot') && document.getElementById('recipeDetailName').textContent.length > 0`)));
await clickOn('#craftBtn'); await settle(400);
ck('a second click makes a second', (await inv(`inv.countItem('wood_log')`)) === 4 && (await chosen()) === 'stick');
await tap('KeyC');
await untilPlaying();
// At a crafting table: its own recipes, and everything a hand can make.
await ev(`openInteractivePanel({ interactType: 'crafting', x: 0, y: 0, z: 0 }); 1`); await settle();
const table = await recipes();
ck('a crafting table makes what hands make too', hand.every(r => table.includes(r)) && table.length > hand.length, `${hand.length} by hand, ${table.length} at the table`);
await clickOn('#interactivePanelClose');
ck('… and its Close button goes back to playing', await untilPlaying(), show(await state()));

// ── A place to stand, with things in front of it ─────────────────────────────

// The ground is level at y 64 (a flat world): the player stands on it, looking along −z.
await ev(`window.__wwLook(0, 0); 1`);
const me = await ev(`(() => { const p = window.me.position; return { x: Math.floor(p.x), y: Math.round(p.y), z: Math.floor(p.z) }; })()`);
await ev(`window.__wwTeleport(${me.x + 0.5}, ${me.y}, ${me.z + 0.5}); 1`);
const block = (dx, dy, dz, name) => ev(`window.__wwSetBlock(${me.x + dx}, ${me.y + dy}, ${me.z + dz}, '${name}')`);
const blockAt = (dx, dy, dz) => ev(`window.__wwBlockAt(${me.x + dx}, ${me.y + dy}, ${me.z + dz})`);
const id = (name) => ev(`(mergedGamePackData.blocks.find(b => b.name === '${name}') ?? {}).id ?? -1`);
/**
 * Look from the eyes at a point given from where the player's feet are. The mouse is brought to the middle of the
 * screen first: with the pointer held, a click somewhere new is also a move of the mouse, and would turn the view.
 */
const lookAt = async (dx, dy, dz) => {
    // The move has to have arrived before the view is set, or it turns the view afterwards: it is waited for (no
    // move comes if the mouse was in the middle already, so not for long), and the view is set once it is quiet.
    await ev(`window.__moves ??= (document.addEventListener('mousemove', () => { window.__moved = performance.now(); }), 1); window.__moved = 0; 1`);
    await mouse('mouseMoved', 640, 360, 'none');
    await until(`window.__moved > 0`, 700, 50);
    await until(`performance.now() - window.__moved > 150`, 1000, 50);
    await ev(`window.__wwLook(${Math.atan2(-dx, -dz)}, ${Math.atan2(dy - 1.6, Math.hypot(dx, dz))}); 1`);
};
const hold = async (button, ms) => { await mouse('mousePressed', 640, 360, button); await sleep(ms); await mouse('mouseReleased', 640, 360, button); await sleep(150); };
const select = (i) => ev(`(() => { const e = new KeyboardEvent('keydown', { code: 'Digit${i + 1}', bubbles: true }); document.dispatchEvent(e); document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit${i + 1}', bubbles: true })); return 1; })()`);

// ── A chest holds things ─────────────────────────────────────────────────────

await block(0, 0, -2, 'CHEST');
await lookAt(0, 0.5, -2);
await settle(600);
await click(640, 360, 'right'); await settle(1200);
s = await state();
const chestUp = await ev(`!document.getElementById('invChest').classList.contains('hidden') && document.querySelectorAll('#invChestSlots .invGridSlot').length`);
ck('a chest opens as a place to put things — not as a crafting bench', s.inv && !s.panel && chestUp === 27, `${show(s)} slots=${chestUp}`);
await inv(`(inv.hotbar.fill(null), inv.slots.length = 0, inv.addItem('dirt', 8), inv.addItem('stick', 3), 1)`);
await ev(`_renderInventory(); 1`);
await clickOn(slot('hotbar', 0));
await clickOn(slot('chest', 4));
ck('a stack is put into it', (await cursor()) === null && (await ev(`_chest.slots[4]?.itemId + ':' + _chest.slots[4]?.count`)) === 'dirt:8' && (await inv(`inv.countItem('dirt')`)) === 0);
await ev(`(() => { const e = document.querySelector(${JSON.stringify(slot('hotbar', 1))}); e.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); return 1; })()`);
ck('shift-click sends a stack across', (await ev(`_chest.slots.filter(Boolean).map(s => s.itemId + ':' + s.count).join()`)) === 'stick:3,dirt:8' && (await inv(`inv.countItem('stick')`)) === 0,
    await ev(`JSON.stringify(_chest.slots.filter(Boolean))`));
await tap('KeyE');
ck('E closes it', await untilPlaying(), show(await state()));
await click(640, 360, 'right'); await settle(1200);
ck('opened again, they are still there', (await ev(`_chest ? _chest.slots.filter(Boolean).map(s => s.itemId + ':' + s.count).join() : ''`)) === 'stick:3,dirt:8');
await ev(`(() => { const e = document.querySelector(${JSON.stringify(slot('chest', 4))}); e.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); return 1; })()`);
ck('… and come out again', (await inv(`inv.countItem('dirt')`)) === 8 && (await ev(`_chest.slots[4]`)) === null);
await tap('Escape');
await untilPlaying();
// Kept with the world: on the server a moment later.
const kept = async () => (await (await fetch(`${base}/api/worlds/${world.id}/containers`)).json())[`${me.x},${me.y},${me.z - 2}`] ?? null;
let saved = null;
const inChest = (c) => c?.filter(Boolean).map(s => `${s.itemId}:${s.count}`).join();
for (let i = 0; i < 40 && inChest(saved) !== 'stick:3'; i++) { await sleep(300); saved = await kept(); }
ck('what is in it is kept with the world', inChest(saved) === 'stick:3', JSON.stringify(saved));
// Broken, it spills.
await ev(`window.__wwBreak(${me.x}, ${me.y}, ${me.z - 2})`); await settle(400);
const spilt = await ev(`window.__wwDrops()`);
ck('broken, it spills what was in it', spilt.some(d => d.itemId === 'stick' && d.count === 3), JSON.stringify(spilt));
for (let i = 0; i < 30 && saved; i++) { await sleep(300); saved = await kept(); }
ck('… and is forgotten', saved === null, JSON.stringify(saved));

// ── A tool is quick at what it is for ────────────────────────────────────────

// A log takes two seconds by hand. A gold pickaxe is no better at it; a gold axe is twelve times as quick.
await inv(`(inv.hotbar.fill(null), inv.slots.length = 0, inv.hotbar[0] = { itemId: 'gold_pickaxe', count: 1 }, inv.hotbar[1] = { itemId: 'gold_axe', count: 1 }, 1)`);
await ev(`window.dispatchEvent(new CustomEvent('ww_itemPickup')); 1`);
const WOOD = await id('WOOD');
await block(0, 0, -2, 'WOOD');
await lookAt(0, 0.5, -2);
await select(0); await settle(500);
await hold('left', 1200);
ck('a pickaxe is no quicker through wood than a hand', (await blockAt(0, 0, -2)) === WOOD);
await select(1); await settle(500);
// (A sixth of a second of the game's time — which on a slow machine, drawing a few frames a second, is longer of ours.)
await mouse('mousePressed', 640, 360, 'left');
const felled = await until(`window.__wwBlockAt(${me.x}, ${me.y}, ${me.z - 2}) === 0`, 1500, 60);
await mouse('mouseReleased', 640, 360, 'left'); await sleep(150);
ck('an axe is', felled);

// ── Mobs: struck only in plain sight, and not built into ─────────────────────

// A pig in a pen two blocks off: stone on every side of it, two high.
await select(2);
const pen = [[-1, -3], [1, -3], [0, -4], [0, -2]];
for (const [dx, dz] of pen) { await block(dx, 0, dz, 'STONE'); await block(dx, 1, dz, 'STONE'); }
// (This pig, by the name it was given: the world has pigs of its own wandering about. And one that stays where it
// is put: its pen is about to lose a wall.)
const pigId = await ev(`window.__wwSpawnMob('pig', ${me.x + 0.5}, ${me.y}, ${me.z - 3 + 0.5}, true)`);
await settle(1500);
const pig = () => ev(`window.__wwMobs().find(m => m.id === ${pigId}) ?? null`);
let p = await pig();
ck('a pig stands in its pen', !!p && Math.abs(p.x - (me.x + 0.5)) < 0.6 && Math.abs(p.z - (me.z - 2.5)) < 0.6, JSON.stringify(p));
const full = p?.health;
await lookAt(0, 0.6, -3);
await settle(400);
await hold('left', 700);
await hold('left', 700);
p = await pig();
ck('it cannot be struck through the wall of the pen', p?.health === full, JSON.stringify(p));
// A block is not put down where it stands.
await inv(`(inv.hotbar[3] = { itemId: 'dirt', count: 8 }, 1)`);
await ev(`window.dispatchEvent(new CustomEvent('ww_itemPickup')); 1`);
await select(3);
await block(0, 0, -2, 'AIR'); await block(0, 1, -2, 'AIR');      // the wall in the way comes down
await lookAt(0, -0.02, -3);              // the ground under the pig: a block there would go where the pig is
await settle(500);
await click(640, 360, 'right'); await settle(400);
p = await pig();
ck('a block cannot be put down where a mob stands', !!p && Math.floor(p.z) === me.z - 3 && Math.floor(p.x) === me.x && (await blockAt(0, 0, -3)) === 0 && (await inv(`inv.hotbar[3]?.count`)) === 8,
    `${JSON.stringify(p)} block ${await blockAt(0, 0, -3)}`);
await select(2);
await lookAt(0, 0.6, -3);
await settle(400);
await hold('left', 700);
p = await pig();
ck('with the wall gone the pig can be struck', !!p && p.health < full, JSON.stringify(p));
await ev(`(() => { const m = window.__wwMobs().find(m => m.id === ${pigId}); return m ? window.__wwHitMob(m.x, m.y, m.z, 500) : 0; })()`);
await until(`!window.__wwMobs().some(m => m.id === ${pigId})`, 8000, 200);
await select(3);
await lookAt(0, -0.02, -3);
await settle(500);
await click(640, 360, 'right'); await settle(500);
ck('… and the block can be put down once it is gone', (await blockAt(0, 0, -3)) === (await id('DIRT')) && (await inv(`inv.hotbar[3]?.count`)) === 7);
// Nor where the player stands: the block at their own feet's side, cutting into them.
await ev(`window.__wwTeleport(${me.x + 0.5}, ${me.y}, ${me.z + 0.1}); 1`);   // close against the block's place to the −z side
await lookAt(0, -0.02, -0.6);
await settle(500);
await click(640, 360, 'right'); await settle(500);
ck('nor where the player is standing', (await blockAt(0, 0, -1)) === 0);

// ── Dying brings the player back to the world's spawn ────────────────────────

// A world whose origin is no place to stand: with seed 8 the nearest good land — the world's spawn — is some seventy
// blocks from (0, 0), which is what tells the two apart. It is entered, left and entered again, because the fault was
// in a world loaded from a save: nobody is set down at the spawn in that session, and it was known in no other.
const sea = await (await fetch(`${base}/api/worlds`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Spawn', seed: 8, gameMode: 'SURVIVAL' }),
})).json();
const where = () => ev(`(() => { const p = window.__wwDebug().player; return { x: p.x, y: p.y, z: p.z }; })()`);
/** Into a world, and standing in it: the pointer held, and feet on the ground (a new player waits in the air while the land loads). */
async function enter(w) {
    await ev(`startWorld(${JSON.stringify(w)}); 1`);
    if (!(await until(`!document.getElementById('GameScreen').classList.contains('hidden') && !_loadingActive`, 120000, 300))) return null;
    await sleep(600);
    if (!(await state()).locked) await click();
    await untilPlaying(8000);
    return landed();
}
async function landed() {
    await until(`window.__wwDebug().player.y < 150`, 60000, 300);
    let at = await where();
    for (let i = 0; i < 20; i++) { await sleep(500); const now = await where(); if (Math.abs(now.y - at.y) < 0.01) return now; at = now; }
    return at;
}
const leave = async () => { await ev(`leaveWorld()`, true); await sleep(2500); };      // (and what it saves is on its way)
const far = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

await leave();
const first = await enter(sea);
ck('a new world sets its player down at its spawn — good land, here well away from (0, 0)', !!first && far(first, { x: 57.5, z: 44.5 }) < 30 && far(first, { x: 0, z: 0 }) > 40, JSON.stringify(first));
await leave();
// What was kept: the place, and where dying leads back to. A save from before that was kept has no such line —
// which is every save there was — so it is taken out again: the spawn has to be found from the seed.
const stateUrl = `${base}/api/worlds/${sea.id}/player-state`;
const kept2 = await (await fetch(stateUrl)).json();
ck('where the player first stood is kept with their state', Number.isFinite(kept2?.spawn?.x) && far({ x: kept2.spawn.x + 0.5, z: kept2.spawn.z + 0.5 }, first) < 1.5, JSON.stringify(kept2?.spawn));
delete kept2.spawn;
await fetch(stateUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kept2) });
const again = await enter(await (await fetch(`${base}/api/worlds/${sea.id}`)).json());
ck('entered again, the player is where they were', !!again && far(again, first) < 1.5, JSON.stringify(again));
await ev(`window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage: 5000 } })); 1`);
await until(`!document.getElementById('DeathScreen').classList.contains('hidden')`, 5000);
await clickOn('#respawnBtn');
await untilPlaying(20000);
const back = await landed();
ck('dying there brings them back to the world\'s spawn — not to (0, 0)', !!back && far(back, first) < 3 && far(back, { x: 0, z: 0 }) > 40, `first ${JSON.stringify(first)}, after dying ${JSON.stringify(back)}`);

await finish();
