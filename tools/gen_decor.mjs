/**
 * Writes the definitions of the blocks that come in families — flowing water,
 * slabs, stairs, fences, doors, beds, furniture, plants, paintings and the
 * rest — with their items and recipes: data/blocks/<id>_<name>.json,
 * data/items/<id>.json, data/recipes/<id>.json.
 *
 *     node tools/gen_decor.mjs        (npm run decor)
 *
 * A block has no state besides which block it is, so a stair turned four ways
 * and both ways up is eight blocks, and a door sixteen. Nobody should write
 * those by hand; this does, from the lists below. It is deterministic and
 * only ever writes the files it names, so it can be run again after a change.
 *
 * IDS ARE FIXED. Worlds store them. Every family has its own range (see the
 * numbers below) with room left in it: add to a family at its end, start a new
 * family at a new number, and never renumber.
 *
 * What the fields mean is in BlockRegistry.makeDef; what a `model` is made of,
 * in engine/BlockShapes.js; who reads `place`, `use`, `twin` and `tick`, in
 * world.js. The textures named here are painted by tools/gen_decor_textures.py.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const blocks = [], items = [], recipes = [];
const FACINGS = ['east', 'west', 'south', 'north'];
const DIR = { east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1] };
const neg = (v) => v.map(n => -n || 0);
const title = (s) => s.toLowerCase().split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const by = (fn) => Object.fromEntries(FACINGS.map(f => [f, fn(f)]));
const by_ = by;              // (for where `by` is a block's place)
/** NAME for the facing a family is built in (east), NAME_WEST … for the rest. */
const faced = (name, f) => (f === 'east' ? name : `${name}_${f.toUpperCase()}`);

function block(id, name, o) {
    if (blocks.some(b => b.id === id)) throw new Error(`block id ${id} used twice (${name})`);
    if (blocks.some(b => b.name === name)) throw new Error(`block name ${name} used twice`);
    blocks.push({ id, name, terrainType: 'solid', ...o });
}
function item(id, o = {}) {
    items.push({ id, name: o.name ?? title(id), type: 'resource', weight: 1, maxStack: 64, ...o });
}
// An ingredient is an item id, or `any(group)` for any item of a kind (any planks, any log):
// the item named is the one shown, and the one used first.
const ANY_OF = { log: 'wood_log', planks: 'wooden_planks' };
const any = (group) => ({ any: group });
function recipe(id, station, count, ...ing) {
    const ingredients = [];
    for (let i = 0; i < ing.length; i += 2) {
        const what = ing[i];
        ingredients.push(typeof what === 'string' ? { itemId: what, count: ing[i + 1] } : { itemId: ANY_OF[what.any], count: ing[i + 1], any: what.any });
    }
    recipes.push({ id, station, result: { itemId: id.replace(/__.*$/, ''), count }, ingredients });
}
const drop = (itemId, count = 1) => [{ itemId, count }];

// ── 72–79: flowing water ─────────────────────────────────────────────────────
const WATER = { transparent: true, liquid: true, noCollision: true, color: [0.1, 0.4, 0.8], hardness: 0, drops: null, render: 'translucent', texture: 'Water.png', variant: true };
for (let l = 1; l <= 7; l++) block(71 + l, `WATER_${l}`, { ...WATER, fluid: l });
block(79, 'WATER_FALL', { ...WATER, fluid: 'fall' });

item('bucket', { maxStack: 16, category: 'Tools', use: 'bucket', icon: 'data/textures/items/bucket.png' });
item('water_bucket', { maxStack: 1, category: 'Tools', use: 'pour', icon: 'data/textures/items/water_bucket.png' });

// ── The woods ────────────────────────────────────────────────────────────────
// Oak was the only wood: its things keep their names (TABLE, WOODEN_DOOR …) and
// spruce and birch ones are called after their wood. `planks` is the block, and
// the item, a thing of that wood is made from; `tex` its texture.
const PLANKS = 'Wooden_Planks.png';
const WOODS = [
    { key: 'OAK', prefix: '', planks: 'wooden_planks', log: 'wood_log', tex: PLANKS, color: [0.72, 0.55, 0.33], door: 'Door', cabinet: 'Cabinet_Front' },
    { key: 'SPRUCE', prefix: 'SPRUCE_', planks: 'spruce_planks', log: 'spruce_log', tex: 'Spruce_Planks.png', color: [0.45, 0.32, 0.2], door: 'Spruce_Door', cabinet: 'Spruce_Cabinet_Front' },
    { key: 'BIRCH', prefix: 'BIRCH_', planks: 'birch_planks', log: 'birch_log', tex: 'Birch_Planks.png', color: [0.82, 0.74, 0.54], door: 'Birch_Door', cabinet: 'Birch_Cabinet_Front' },
];
const [OAK, SPRUCE, BIRCH] = WOODS;
const woodName = (w, name) => w.prefix + name;
const woodTitle = (w, name) => (w.prefix ? title(w.key) + ' ' : '') + name;
// 430–435: planks of the other woods (room for more).
[SPRUCE, BIRCH].forEach((w, i) => {
    block(430 + i, `${w.key}_PLANKS`, { color: w.color, hardness: 1.5, tool: 'axe', drops: drop(w.planks), texture: w.tex, flammable: 25, sound: 'wood' });
    item(w.planks, { name: `${title(w.key)} Planks`, category: 'Building', group: 'planks' });
    item(w.log, { name: `${title(w.key)} Log`, category: 'Natural', group: 'log' });
    recipe(w.planks, 'crafting_table', 4, w.log, 1);
});
recipe('bucket', 'crafting_table', 1, 'iron_ingot', 3);

// ── 80–87: wool in colours.  96–104: carpets ─────────────────────────────────
const COLOURS = [
    ['RED', [0.72, 0.2, 0.18], 'poppy'], ['ORANGE', [0.86, 0.5, 0.16], 'tulip'], ['YELLOW', [0.9, 0.78, 0.25], 'dandelion'],
    ['GREEN', [0.36, 0.55, 0.24], 'fern'], ['BLUE', [0.25, 0.38, 0.72], 'cornflower'], ['PURPLE', [0.5, 0.3, 0.66], 'violet'],
    ['BLACK', [0.14, 0.14, 0.16], 'coal'], ['BROWN', [0.45, 0.31, 0.2], 'mud'],
];
const CAP = (s) => s[0] + s.slice(1).toLowerCase();
COLOURS.forEach(([c, rgb, dye], i) => {
    const n = `${c}_WOOL`, id = n.toLowerCase();
    block(80 + i, n, { color: rgb, hardness: 0.6, drops: drop(id), texture: `Wool_${CAP(c)}.png`, flammable: 60, sound: 'grass' });
    item(id, { category: 'Building' });
    recipe(id, 'crafting_table', 1, 'wool_block', 1, dye, 1);
});
const CARPETS = [['WHITE', [0.95, 0.95, 0.95], 'Wool_Block.png', 'wool_block'], ...COLOURS.map(([c, rgb]) => [c, rgb, `Wool_${CAP(c)}.png`, `${c.toLowerCase()}_wool`])];
CARPETS.forEach(([c, rgb, tex, wool], i) => {
    const n = `${c}_CARPET`, id = n.toLowerCase();
    block(96 + i, n, { model: 'carpet', color: rgb, hardness: 0.1, drops: drop(id), texture: tex, support: [0, -1, 0], flammable: 60, sound: 'grass' });
    item(id, { category: 'Building' });
    recipe(id, 'crafting_table', 3, wool, 2);
});

// ── 88–92: blocks for building and for show ──────────────────────────────────
block(88, 'BOOKSHELF', { color: [0.55, 0.4, 0.25], hardness: 1.5, tool: 'axe', drops: drop('bookshelf'), textures: { top: PLANKS, side: 'Bookshelf.png', bottom: PLANKS }, flammable: 30, sound: 'wood' });
block(89, 'HAY_BALE', { color: [0.8, 0.68, 0.25], hardness: 0.5, drops: drop('hay_bale'), textures: { top: 'Hay_Top.png', side: 'Hay_Side.png', bottom: 'Hay_Top.png' }, flammable: 80, sound: 'grass' });
block(90, 'CHISELED_STONE', { color: [0.56, 0.56, 0.57], hardness: 2.5, requiresTool: 'pickaxe', drops: drop('chiseled_stone'), texture: 'Chiseled_Stone.png' });
block(91, 'TILES', { color: [0.7, 0.68, 0.64], hardness: 2, requiresTool: 'pickaxe', drops: drop('tiles'), texture: 'Tiles.png' });
block(92, 'THATCH', { color: [0.72, 0.6, 0.3], hardness: 0.5, drops: drop('thatch'), texture: 'Thatch.png', flammable: 80, sound: 'grass' });
for (const id of ['bookshelf', 'hay_bale', 'chiseled_stone', 'tiles', 'thatch']) item(id, { category: 'Building' });
recipe('bookshelf', 'crafting_table', 1, any('planks'), 6, 'leather', 2);
recipe('hay_bale', 'crafting_table', 1, 'tall_grass', 9);
recipe('chiseled_stone', 'crafting_table', 1, 'stone_slab', 2);
recipe('tiles', 'crafting_table', 4, 'polished_diorite', 2, 'polished_granite', 2);
recipe('thatch', 'crafting_table', 2, 'tall_grass', 4);

// ── 110–123: plants ──────────────────────────────────────────────────────────
const PLANTS = [
    [110, 'POPPY', [0.75, 0.15, 0.12], 10], [111, 'DANDELION', [0.92, 0.8, 0.2], 9], [112, 'CORNFLOWER', [0.3, 0.42, 0.85], 11],
    [113, 'DAISY', [0.94, 0.94, 0.9], 10], [114, 'TULIP', [0.9, 0.5, 0.2], 11], [115, 'VIOLET', [0.52, 0.32, 0.7], 8],
    [116, 'TALL_GRASS', [0.36, 0.58, 0.22], 13], [117, 'FERN', [0.26, 0.5, 0.2], 13], [118, 'DEAD_BUSH', [0.5, 0.38, 0.22], 12],
    [119, 'RED_MUSHROOM', [0.78, 0.2, 0.16], 8], [120, 'BROWN_MUSHROOM', [0.55, 0.4, 0.28], 8],
    [121, 'OAK_SAPLING', [0.3, 0.55, 0.2], 13, 'oak_tree'], [122, 'BIRCH_SAPLING', [0.45, 0.62, 0.3], 13, 'birch_tree'], [123, 'SPRUCE_SAPLING', [0.18, 0.4, 0.24], 13, 'spruce_tree'],
];
const texOf = (name) => name.split('_').map(CAP).join('_') + '.png';
for (const [id, name, rgb, pick, grows] of PLANTS) {
    const it = name.toLowerCase();
    block(id, name, {
        model: 'cross', shape: { pick }, color: rgb, hardness: 0.02, drops: drop(it), texture: texOf(name), support: [0, -1, 0],
        flammable: 70, sound: 'grass', ...(grows ? { tick: 'sapling', grows } : {}),
    });
    item(it, { category: 'Natural' });
}

// ── 125–136: pots ────────────────────────────────────────────────────────────
const POTTED = ['POPPY', 'DANDELION', 'CORNFLOWER', 'DAISY', 'TULIP', 'VIOLET', 'FERN', 'DEAD_BUSH', 'OAK_SAPLING', 'BIRCH_SAPLING', 'SPRUCE_SAPLING'];
const POT = { model: 'pot', color: [0.62, 0.36, 0.24], hardness: 0.1, support: [0, -1, 0], sound: 'stone' };
block(124, 'FLOWER_POT', {
    ...POT, drops: drop('flower_pot'), textures: { top: 'Flower_Pot.png', side: 'Flower_Pot.png', bottom: 'Dirt.png' },
    use: { pot: Object.fromEntries(POTTED.map(p => [p.toLowerCase(), `POTTED_${p}`])) },
});
POTTED.forEach((p, i) => block(125 + i, `POTTED_${p}`, {
    ...POT, shape: { plant: true }, variant: true, textures: { top: texOf(p), side: 'Flower_Pot.png', bottom: 'Dirt.png' },
    drops: [{ itemId: 'flower_pot', count: 1 }, { itemId: p.toLowerCase(), count: 1 }],
    use: { unpot: p.toLowerCase(), to: 'FLOWER_POT' },
}));
block(136, 'VASE', { model: 'vase', color: [0.62, 0.36, 0.24], hardness: 0.3, drops: drop('vase'), texture: 'Vase.png', support: [0, -1, 0] });
item('flower_pot', { category: 'Building' });
item('vase', { category: 'Building' });
recipe('flower_pot', 'crafting_table', 1, 'clay_ball', 3);
recipe('vase', 'crafting_table', 1, 'clay_ball', 5);

// ── 140–144: fire, the campfire, the bomb ────────────────────────────────────
block(140, 'FIRE', { model: 'fire', color: [1, 0.6, 0.15], hardness: 0, drops: [], texture: 'Fire.png', light: 15, tick: 'fire', sound: 'sand' });
// (The fire is `top`, the bark `side` and the cut ends of the logs `bottom`: the logs were drawn with the
// fire on their tops — BlockShapes says which face of a log is which.)
const CAMP = { model: 'campfire', color: [0.4, 0.28, 0.16], hardness: 1, tool: 'axe', drops: drop('campfire'), support: [0, -1, 0], sound: 'wood',
    textures: { top: 'Fire.png', side: 'Campfire_Log.png', bottom: 'Log_Top.png' } };
block(141, 'CAMPFIRE', { ...CAMP, use: { light: 'CAMPFIRE_LIT' } });
block(142, 'CAMPFIRE_LIT', { ...CAMP, shape: { lit: true }, variant: true, light: 14, use: { cook: true, douse: 'CAMPFIRE' }, tick: 'campfire' });
const BOMB = { model: 'bomb', color: [0.2, 0.2, 0.22], hardness: 0.3, support: null, sound: 'stone' };
block(143, 'BOMB', { ...BOMB, drops: drop('bomb'), textures: { top: 'Bomb_Top.png', side: 'Bomb_Side.png', bottom: 'Bomb_Top.png' }, use: { ignite: 'BOMB_LIT' }, flammable: 100 });
block(144, 'BOMB_LIT', { ...BOMB, drops: [], variant: true, textures: { top: 'Bomb_Top.png', side: 'Bomb_Lit.png', bottom: 'Bomb_Top.png' }, light: 7, glow: 0.7, tick: 'bomb' });
item('campfire', { category: 'Tools' });
item('bomb', { category: 'Tools', maxStack: 16 });
item('flint_and_steel', { maxStack: 1, category: 'Tools', use: 'ignite', icon: 'data/textures/items/flint_and_steel.png' });
item('map', { maxStack: 1, category: 'Tools', use: 'map', icon: 'data/textures/items/map.png' });
recipe('campfire', 'crafting_table', 1, any('log'), 3, 'stick', 3, 'coal', 1);
recipe('bomb', 'crafting_table', 1, 'coal', 4, 'sand', 4, 'string', 1);
recipe('flint_and_steel', 'hand', 1, 'flint', 1, 'iron_ingot', 1);
recipe('map', 'crafting_table', 1, 'leather', 2, 'coal', 1, 'stick', 1);

// ── 145–151: food that is put down, and eaten a piece at a time ──────────────
const food = (first, name, stages, tex, eat) => {
    for (let s = 0; s < stages; s++) {
        const last = s === stages - 1;
        block(first + s, s ? `${name}_${s}` : name, {
            model: name.toLowerCase(), shape: { stage: s }, color: tex.color, hardness: 0.2, drops: s ? [] : drop(name.toLowerCase()),
            textures: { top: `${CAP(name)}_Top.png`, side: `${CAP(name)}_Side.png`, bottom: `${CAP(name)}_Inside.png` },
            support: [0, -1, 0], sound: 'grass', ...(s ? { variant: true } : {}),
            use: { eat: { ...eat, to: last ? 'AIR' : `${name}_${s + 1}` } },
        });
    }
    item(name.toLowerCase(), { category: 'Food', maxStack: 16 });
};
food(145, 'CAKE', 4, { color: [0.95, 0.9, 0.82] }, { hunger: 14, energy: 12 });
food(149, 'PIE', 3, { color: [0.8, 0.55, 0.25] }, { hunger: 12, energy: 8, health: 4 });
recipe('cake', 'crafting_table', 1, 'bread', 3, 'apple', 2);
recipe('pie', 'oven', 1, 'bread', 1, 'apple', 3, 'coal', 1);

// ── 152–155: the ladder ──────────────────────────────────────────────────────
const wallNames = (name) => by(f => faced(name, f));
FACINGS.forEach((f, i) => block(152 + i, faced('LADDER', f), {
    model: 'ladder', facing: f, color: [0.6, 0.45, 0.26], hardness: 0.4, tool: 'axe', drops: drop('ladder'), texture: 'Ladder.png',
    support: neg(DIR[f]), flammable: 30, sound: 'wood', ...(i ? { variant: true } : { placement: wallNames('LADDER') }),
}));
item('ladder', { category: 'Building' });
recipe('ladder', 'crafting_table', 3, 'stick', 7);

// ── Doors: 156–171 oak, hung on the left; 436–451 oak, hung on the right ─────
// ── 452–483 spruce, 484–515 birch (left, then right) ─────────────────────────
// Which side a door is hung on is chosen as it is put down (world.js): beside
// another door the same way round, the other side, so the two are a pair.
{
    const DOOR_IDS = { OAK: [156, 436], SPRUCE: [452, 468], BIRCH: [484, 500] };
    for (const w of WOODS) {
        const base = w === OAK ? 'WOODEN_DOOR' : woodName(w, 'DOOR'), itemId = base.toLowerCase();
        const name = (f, open, top, right) => base + (f === 'east' ? '' : `_${f.toUpperCase()}`) + (right ? '_RIGHT' : '') + (open ? '_OPEN' : '') + (top ? '_TOP' : '');
        for (const right of [false, true]) {
            let id = DOOR_IDS[w.key][right ? 1 : 0];
            for (const f of FACINGS) for (const open of [false, true]) for (const top of [false, true]) {
                const first = !right && f === 'east' && !open && !top;
                block(id++, name(f, open, top, right), {
                    model: 'door', facing: f, shape: { open, part: top ? 'upper' : 'lower', ...(right ? { hinge: 'right' } : {}) }, color: w.color, hardness: 1.5, tool: 'axe',
                    drops: top ? [] : drop(itemId), texture: `${w.door}_${top ? 'Top' : 'Bottom'}.png`, sound: 'wood', flammable: 20,
                    twin: top ? [0, -1, 0] : [0, 1, 0], ...(top ? {} : { support: [0, -1, 0] }),
                    use: { toggle: name(f, !open, top, right), sound: 'door' },
                    ...(first ? { place: { mode: 'door',
                        lower: by(q => name(q, false, false, false)), upper: by(q => name(q, false, true, false)),
                        lowerRight: by(q => name(q, false, false, true)), upperRight: by(q => name(q, false, true, true)) } } : { variant: true }),
                });
            }
        }
        item(itemId, { name: woodTitle(w, w === OAK ? 'Wooden Door' : 'Door'), category: 'Building', maxStack: 16 });
        recipe(itemId, 'crafting_table', 1, w.planks, 6);
    }
}

// ── Beds: 172–179 red; 606–669 in eight more colours, eight ids each ─────────
// A bed is built of wool and wood (BlockShapes `bed`): its blanket is the
// colour of its wool.
// (The colours beds and sofas come in: red first, as they were; then the rest.)
const FURNISH = [
    ['RED', 'Wool_Red.png', 'red_wool', [0.7, 0.2, 0.2]], ['ORANGE', 'Wool_Orange.png', 'orange_wool', [0.86, 0.5, 0.16]],
    ['YELLOW', 'Wool_Yellow.png', 'yellow_wool', [0.9, 0.78, 0.25]], ['GREEN', 'Wool_Green.png', 'green_wool', [0.36, 0.55, 0.24]],
    ['BLUE', 'Wool_Blue.png', 'blue_wool', [0.25, 0.38, 0.72]], ['PURPLE', 'Wool_Purple.png', 'purple_wool', [0.5, 0.3, 0.66]],
    ['BLACK', 'Wool_Black.png', 'black_wool', [0.14, 0.14, 0.16]], ['BROWN', 'Wool_Brown.png', 'brown_wool', [0.45, 0.31, 0.2]],
    ['WHITE', 'Wool_Block.png', 'wool_block', [0.94, 0.94, 0.92]],
];
FURNISH.forEach(([c, wool, woolItem, rgb], k) => {
    const red = k === 0, base = red ? 'BED' : `${c}_BED`, itemId = base.toLowerCase();
    const name = (f, head) => base + (head ? '_HEAD' : '') + (f === 'east' ? '' : `_${f.toUpperCase()}`);
    let id = red ? 172 : 606 + (k - 1) * 8;
    for (const head of [false, true]) for (const f of FACINGS) {
        const first = !head && f === 'east';
        block(id++, name(f, head), {
            model: 'bed', facing: f, shape: { part: head ? 'head' : 'foot' }, color: rgb, hardness: 0.4,
            drops: head ? [] : drop(itemId), sound: 'grass', flammable: 30,
            textures: { top: wool, side: 'Wool_Block.png', bottom: PLANKS },
            twin: head ? neg(DIR[f]) : DIR[f], use: { sleep: true },
            ...(first ? { place: { mode: 'bed', foot: by(q => name(q, false)), head: by(q => name(q, true)) } } : { variant: true }),
        });
    }
    item(itemId, { name: `${title(c)} Bed`, category: 'Building', maxStack: 1 });
    recipe(itemId, 'crafting_table', 1, 'wool_block', 2, woolItem, 1, any('planks'), 3);
});

// ── Gates: 180–187 oak, 516–519 oak opened the other way; 520–531 spruce, ───
// ── 532–543 birch (shut, open, open the other way). 188 the oak fence, ──────
// ── 544 spruce, 545 birch. 189–191 walls ────────────────────────────────────
// A gate opens away from whoever opens it (`away`: world.js), so it swings
// either way; it shuts from either.
{
    for (const w of WOODS) {
        const base = woodName(w, 'FENCE_GATE'), itemId = base.toLowerCase();
        const name = (f, open, back) => faced(base, f) + (open ? (back ? '_OPEN_BACK' : '_OPEN') : '');
        const gate = (id, f, open, back) => block(id, name(f, open, back), {
            model: 'gate', facing: f, shape: { open, ...(back ? { back: true } : {}) }, color: w.color, hardness: 1.5, tool: 'axe', drops: drop(itemId),
            texture: w.tex, sound: 'wood', flammable: 20,
            use: open ? { toggle: name(f, false, false), sound: 'gate' } : { toggle: name(f, true, false), away: name(f, true, true), sound: 'gate' },
            ...(f === 'east' && !open ? { place: { mode: 'look', names: by(q => name(q, false, false)) } } : { variant: true }),
        });
        if (w === OAK) {
            let id = 180;
            for (const f of FACINGS) for (const open of [false, true]) gate(id++, f, open, false);
            FACINGS.forEach((f, i) => gate(516 + i, f, true, true));
        } else {
            let id = w === SPRUCE ? 520 : 532;
            for (const f of FACINGS) for (const [open, back] of [[false, false], [true, false], [true, true]]) gate(id++, f, open, back);
        }
        item(itemId, { name: woodTitle(w, 'Fence Gate'), category: 'Building' });
        recipe(itemId, 'crafting_table', 1, 'stick', 4, w.planks, 2);

        const fence = w === OAK ? 'WOODEN_FENCE' : woodName(w, 'FENCE'), fenceItem = fence.toLowerCase();
        block(w === OAK ? 188 : w === SPRUCE ? 544 : 545, fence, { model: 'fence', color: w.color, hardness: 1.5, tool: 'axe', drops: drop(fenceItem), texture: w.tex, sound: 'wood', flammable: 20 });
        item(fenceItem, { name: woodTitle(w, w === OAK ? 'Wooden Fence' : 'Fence'), category: 'Building' });
        recipe(fenceItem, 'crafting_table', 3, w.planks, 2, 'stick', 4);
    }
}
[['STONE_BRICK', 'Stone_Bricks.png', 'stone_bricks', [0.5, 0.5, 0.52]], ['BRICK', 'Bricks.png', 'bricks', [0.62, 0.27, 0.22]], ['MOSSY_STONE', 'Mossy_Stone.png', 'mossy_stone', [0.42, 0.5, 0.4]]]
    .forEach(([p, tex, from, rgb], i) => {
        const n = `${p}_WALL`, id = n.toLowerCase();
        block(189 + i, n, { model: 'wall', color: rgb, hardness: 2.5, requiresTool: 'pickaxe', drops: drop(id), texture: tex });
        item(id, { category: 'Building' });
        recipe(id, 'crafting_table', 6, from, 6);
    });

// ── Furniture: 192–209 oak; 546–573 spruce and birch; 574–605 sofas ──────────
// Chairs, stools and sofas are sat on (`sit`: world.js); chairs, sofas,
// shelves and tables beside their own kind join up (BlockShapes `connect`).
const WOOD = { color: [0.62, 0.46, 0.27], hardness: 1, tool: 'axe', sound: 'wood', flammable: 20 };
// (Turned to whoever puts them down: a chair is put down facing its sitter.)
const turned = (first, name, o) => FACINGS.forEach((f, i) => block(first + i, faced(name, f), {
    ...o, facing: f, drops: drop(name.toLowerCase()),
    ...(i ? { variant: true } : { place: { mode: 'look', back: true, names: by(q => faced(name, q)) } }),
}));
const shelves = (first, name, o) => FACINGS.forEach((f, i) => block(first + i, faced(name, f), {
    ...o, model: 'shelf', facing: f, drops: drop(name.toLowerCase()), support: neg(DIR[f]),
    ...(i ? { variant: true } : { placement: wallNames(name) }),
}));
const FURNITURE_IDS = {
    OAK:    { table: 192, stool: 193, chair: 194, cabinet: 202, shelf: 206 },
    SPRUCE: { table: 546, stool: 548, chair: 550, cabinet: 558, shelf: 566 },
    BIRCH:  { table: 547, stool: 549, chair: 554, cabinet: 562, shelf: 570 },
};
for (const w of WOODS) {
    const ids = FURNITURE_IDS[w.key], wood = { ...WOOD, color: w.color }, n = (s) => woodName(w, s);
    block(ids.table, n('TABLE'), { ...wood, model: 'table', drops: drop(n('TABLE').toLowerCase()), texture: w.tex });
    block(ids.stool, n('STOOL'), { ...wood, model: 'stool', drops: drop(n('STOOL').toLowerCase()), texture: w.tex, use: { sit: true } });
    turned(ids.chair, n('CHAIR'), { ...wood, model: 'chair', texture: w.tex, use: { sit: true } });
    turned(ids.cabinet, n('CABINET'), { ...wood, model: 'cabinet', hardness: 2, interactable: true, interactType: 'chest', textures: { top: `${w.cabinet}.png`, side: w.tex, bottom: w.tex } });
    shelves(ids.shelf, n('SHELF'), { ...wood, texture: w.tex });
    for (const thing of ['Table', 'Stool', 'Chair', 'Cabinet', 'Shelf']) item(n(thing.toUpperCase()).toLowerCase(), { name: woodTitle(w, thing), category: 'Building' });
    recipe(n('TABLE').toLowerCase(), 'crafting_table', 1, w.planks, 3, 'stick', 4);
    recipe(n('STOOL').toLowerCase(), 'crafting_table', 1, w.planks, 1, 'stick', 4);
    recipe(n('CHAIR').toLowerCase(), 'crafting_table', 1, w.planks, 2, 'stick', 4);
    recipe(n('CABINET').toLowerCase(), 'crafting_table', 1, w.planks, 8);
    recipe(n('SHELF').toLowerCase(), 'crafting_table', 2, w.planks, 1, 'stick', 2);
}
FURNISH.forEach(([c, wool, woolItem, rgb], k) => {
    const name = k === 0 ? 'SOFA' : `${c}_SOFA`;
    turned(k === 0 ? 198 : 574 + (k - 1) * 4, name, { ...WOOD, model: 'sofa', color: rgb, sound: 'grass', textures: { top: wool, side: PLANKS, bottom: PLANKS }, use: { sit: true } });
    item(name.toLowerCase(), { name: `${title(c)} Sofa`, category: 'Building' });
    recipe(name.toLowerCase(), 'crafting_table', 1, woolItem, 3, any('planks'), 2);
});

// ── 210–213: what is hung across a room ──────────────────────────────────────
[['BUNTING', 'Bunting.png', [0.8, 0.3, 0.3]], ['STREAMERS', 'Streamers.png', [0.9, 0.8, 0.3]]].forEach(([n, tex, rgb], k) => {
    const names = { east: n, west: n, south: `${n}_SOUTH`, north: `${n}_SOUTH` };
    const o = { model: 'bunting', color: rgb, hardness: 0.05, drops: drop(n.toLowerCase()), texture: tex, sound: 'grass', flammable: 80 };
    block(210 + k * 2, n, { ...o, facing: 'east', place: { mode: 'look', names } });
    block(211 + k * 2, `${n}_SOUTH`, { ...o, facing: 'south', variant: true });
    item(n.toLowerCase(), { category: 'Building' });
});
recipe('bunting', 'crafting_table', 6, 'string', 2, 'red_wool', 1, 'yellow_wool', 1, 'blue_wool', 1);
recipe('streamers', 'crafting_table', 6, 'string', 2, 'wool_block', 2);

// ── Curtains: 214–237 red, blue, white; 670–717 six colours more ─────────────
[['RED', [0.72, 0.2, 0.18], 'red_wool'], ['BLUE', [0.25, 0.38, 0.72], 'blue_wool'], ['WHITE', [0.94, 0.94, 0.92], 'wool_block'],
 ['ORANGE', [0.86, 0.5, 0.16], 'orange_wool'], ['YELLOW', [0.9, 0.78, 0.25], 'yellow_wool'], ['GREEN', [0.36, 0.55, 0.24], 'green_wool'],
 ['PURPLE', [0.5, 0.3, 0.66], 'purple_wool'], ['BLACK', [0.14, 0.14, 0.16], 'black_wool'], ['BROWN', [0.45, 0.31, 0.2], 'brown_wool']].forEach(([c, rgb, wool], k) => {
    const base = `${c}_CURTAIN`;
    const name = (f, open) => faced(base, f) + (open ? '_OPEN' : '');
    let id = k < 3 ? 214 + k * 8 : 670 + (k - 3) * 8;
    for (const f of FACINGS) for (const open of [false, true]) {
        const first = f === 'east' && !open;
        block(id++, name(f, open), {
            model: 'curtain', facing: f, shape: { open }, color: rgb, hardness: 0.1, drops: drop(base.toLowerCase()), texture: `Curtain_${CAP(c)}.png`,
            support: neg(DIR[f]), sound: 'grass', flammable: 80, use: { toggle: name(f, !open) },
            ...(first ? { placement: by(q => name(q, false)) } : { variant: true }),
        });
    }
    item(base.toLowerCase(), { category: 'Building' });
    recipe(base.toLowerCase(), 'crafting_table', 2, wool, 2, 'stick', 1);
});

// ── Paintings: 238–269 a block across (eight pictures) ───────────────────────
{
    const PICTURES = 8;
    const name = (n, f) => (n === 0 ? faced('PAINTING', f) : `PAINTING_${n}` + (f === 'east' ? '' : `_${f.toUpperCase()}`));
    let id = 238;
    for (let n = 0; n < PICTURES; n++) for (const f of FACINGS) {
        const first = n === 0 && f === 'east';
        block(id++, name(n, f), {
            model: 'painting', facing: f, color: [0.5, 0.36, 0.2], hardness: 0.1, drops: drop('painting'), texture: `Painting_${n + 1}.png`,
            support: neg(DIR[f]), sound: 'wood', flammable: 60, use: { toggle: name((n + 1) % PICTURES, f) },
            ...(first ? { placement: by(q => name(0, q)) } : { variant: true }),
        });
    }
    item('painting', { name: 'Small Painting', category: 'Building' });
    recipe('painting', 'crafting_table', 1, 'stick', 8, 'wool_block', 1);
}

// ── 740–1027: paintings of several blocks ────────────────────────────────────
// A block for each piece of each picture, each way round. The pieces of one
// hang together (`group`: where the others are; `piece`: which picture) and
// are put down, used and broken as one. Painted at 16 texels to a block, two
// blocks to a side of a texture (`tile`: the part of it a piece shows), so
// several pictures share the texture array's layers:
//   wide  2 × 1   four pictures, two to a texture: Painting_Wide_A (1, 2), _B (3, 4)
//   tall  1 × 2   four, two to a texture, side by side: Painting_Tall_A, _B
//   large 2 × 2   four, a texture each: Painting_Large_1 …
//   grand 4 × 2   two, two textures each: Painting_Grand_1_L, _R
//   huge  4 × 3   two, four textures each: Painting_Huge_1_TL, _TR, _BL, _BR (the lower two half used)
// Put down, a picture of the size is chosen at random; used, the next one.
{
    const SIZES = [
        { key: 'WIDE', w: 2, h: 1, pics: 4, first: 740, title: 'Wide Painting', sticks: 8, wool: 2 },
        { key: 'TALL', w: 1, h: 2, pics: 4, first: 772, title: 'Tall Painting', sticks: 8, wool: 2 },
        { key: 'LARGE', w: 2, h: 2, pics: 4, first: 804, title: 'Large Painting', sticks: 12, wool: 4 },
        { key: 'GRAND', w: 4, h: 2, pics: 2, first: 868, title: 'Grand Painting', sticks: 16, wool: 6 },
        { key: 'HUGE', w: 4, h: 3, pics: 2, first: 932, title: 'Huge Painting', sticks: 20, wool: 8 },
    ];
    // Which texture a piece is on, and where on it: the picture's top left is at
    // block (ox, oy) of a grid of textures two blocks square.
    const where = (size, n) => {
        if (size.key === 'WIDE') return { ox: 0, oy: n % 2, file: () => `Painting_Wide_${'AB'[n >> 1]}.png` };
        if (size.key === 'TALL') return { ox: n % 2, oy: 0, file: () => `Painting_Tall_${'AB'[n >> 1]}.png` };
        if (size.key === 'LARGE') return { ox: 0, oy: 0, file: () => `Painting_Large_${n + 1}.png` };
        if (size.key === 'GRAND') return { ox: 0, oy: 0, file: (tx) => `Painting_Grand_${n + 1}_${'LR'[tx]}.png` };
        return { ox: 0, oy: 0, file: (tx, ty) => `Painting_Huge_${n + 1}_${'TB'[ty]}${'LR'[tx]}.png` };
    };
    for (const size of SIZES) {
        const { key, w, h, pics } = size, item0 = `painting_${key.toLowerCase()}`;
        // Piece i along (from the left, as it is looked at) and j up, of picture n.
        const name = (n, i, j, f) => (n === 0 && i === 0 && j === 0 && f === 'east' ? `PAINTING_${key}` : `PAINTING_${key}_${n + 1}_${i}_${j}` + (f === 'east' ? '' : `_${f.toUpperCase()}`));
        let id = size.first;
        for (let n = 0; n < pics; n++) {
            const at = where(size, n);
            for (const f of FACINGS) {
                // Along the picture, to the right of whoever looks at it: the left of its facing (BlockShapes LEFT_OF).
                const R = DIR[{ east: 'north', north: 'west', west: 'south', south: 'east' }[f]];
                const off = (i, j) => [R[0] * i, j, R[2] * i];
                for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
                    const bx = at.ox + i, by = at.oy + (h - 1 - j);              // the piece's block on the grid, from the top
                    const tile = [0.5, (bx % 2) * 0.5, by % 2 === 0 ? 0.5 : 0];
                    const group = [];
                    for (let q = 0; q < h; q++) for (let p = 0; p < w; p++) if (p !== i || q !== j) {
                        const a = off(p, q), b = off(i, j);
                        group.push([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
                    }
                    const anchor = i === 0 && j === 0;
                    block(id++, name(n, i, j, f), {
                        model: 'painting', facing: f, shape: { tile }, color: [0.5, 0.36, 0.2], hardness: 0.1,
                        drops: anchor ? drop(item0) : [], texture: at.file(bx >> 1, by >> 1),
                        support: neg(DIR[f]), sound: 'wood', flammable: 60, group, piece: `PAINTING_${key}_${n + 1}`,
                        use: { toggle: name((n + 1) % pics, i, j, f) },
                        ...(n === 0 && i === 0 && j === 0 && f === 'east' ? {
                            place: { mode: 'painting', w, h, pictures: Array.from({ length: pics }, (_, m) => by_(q => Array.from({ length: w * h }, (_, k) => name(m, k % w, Math.floor(k / w), q)))) },
                        } : { variant: true }),
                    });
                }
            }
        }
        item(item0, { name: size.title, category: 'Building' });
        recipe(item0, 'crafting_table', 1, 'stick', size.sticks, 'wool_block', size.wool);
    }
}

// ── 718–728: plates, and what is put on them ─────────────────────────────────
// Food is put on a plate (`plate`) and taken off again (`unplate`): its picture
// lies on it (BlockShapes `plate`), the item's own icon.
{
    const FOODS = ['apple', 'bread', 'cooked_beef', 'cooked_chicken', 'cooked_fish', 'cooked_pork', 'raw_beef', 'raw_chicken', 'raw_fish', 'raw_pork'];
    const P = { model: 'plate', color: [0.92, 0.9, 0.86], hardness: 0.2, support: [0, -1, 0], sound: 'glass' };
    block(718, 'PLATE', { ...P, drops: drop('plate'), texture: 'Plate.png', use: { plate: Object.fromEntries(FOODS.map(f => [f, `PLATE_${f.toUpperCase()}`])) } });
    FOODS.forEach((f, i) => block(719 + i, `PLATE_${f.toUpperCase()}`, {
        ...P, shape: { food: true }, variant: true, textures: { top: `../items/${f}.png`, side: 'Plate.png', bottom: 'Plate.png' },
        drops: [{ itemId: 'plate', count: 1 }, { itemId: f, count: 1 }], use: { unplate: f, to: 'PLATE' },
    }));
    item('plate', { category: 'Building', maxStack: 16 });
    recipe('plate', 'oven', 2, 'clay_ball', 3);
}

// ── 736–738: the anvil, turned the other three ways (24 is the anvil, written by hand) ──
FACINGS.slice(1).forEach((f, i) => block(736 + i, `ANVIL_${f.toUpperCase()}`, {
    model: 'anvil', facing: f, color: [0.35, 0.35, 0.35], texture: 'Anvil.png', interactable: true, interactType: 'anvil',
    hardness: 5, tool: 'pickaxe', drops: drop('anvil'), sound: 'stone', variant: true,
}));

// ── 270 … : slabs and stairs, sixteen ids a material ─────────────────────────
// +0 slab  +1 slab (upper)  +2…5 wall slab  +6…9 stairs  +10…13 stairs upside down
const MATERIALS = [
    ['WOODEN', 'WOODEN_PLANKS', 'wooden_planks', PLANKS, { color: [0.72, 0.55, 0.33], hardness: 1.5, tool: 'axe', sound: 'wood', flammable: 25 }],
    ['STONE', 'STONE', 'stone', 'Stone.png', { color: [0.5, 0.5, 0.5], hardness: 2, requiresTool: 'pickaxe' }],
    ['STONE_BRICK', 'STONE_BRICKS', 'stone_bricks', 'Stone_Bricks.png', { color: [0.5, 0.5, 0.52], hardness: 2.5, requiresTool: 'pickaxe' }],
    ['BRICK', 'BRICKS', 'bricks', 'Bricks.png', { color: [0.62, 0.27, 0.22], hardness: 2.5, requiresTool: 'pickaxe' }],
    ['SANDSTONE', 'SANDSTONE', 'sandstone', 'Sandstone.png', { color: [0.85, 0.78, 0.55], hardness: 1.5, requiresTool: 'pickaxe' }],
    ['POLISHED_GRANITE', 'POLISHED_GRANITE', 'polished_granite', 'Polished_Granite.png', { color: [0.62, 0.42, 0.36], hardness: 2.5, requiresTool: 'pickaxe' }],
    ['POLISHED_DIORITE', 'POLISHED_DIORITE', 'polished_diorite', 'Polished_Diorite.png', { color: [0.88, 0.88, 0.9], hardness: 2.5, requiresTool: 'pickaxe' }],
    ['MOSSY_STONE', 'MOSSY_STONE', 'mossy_stone', 'Mossy_Stone.png', { color: [0.42, 0.5, 0.4], hardness: 2.5, requiresTool: 'pickaxe' }],
    // 398 …, 414 …: the other woods.
    ['SPRUCE', 'SPRUCE_PLANKS', 'spruce_planks', 'Spruce_Planks.png', { color: SPRUCE.color, hardness: 1.5, tool: 'axe', sound: 'wood', flammable: 25 }],
    ['BIRCH', 'BIRCH_PLANKS', 'birch_planks', 'Birch_Planks.png', { color: BIRCH.color, hardness: 1.5, tool: 'axe', sound: 'wood', flammable: 25 }],
];
MATERIALS.forEach(([p, full, from, tex, o], k) => {
    const id0 = 270 + k * 16;
    const slab = `${p}_SLAB`, wslab = `${p}_WALL_SLAB`, stairs = `${p}_STAIRS`;
    const common = { ...o, texture: tex };
    block(id0, slab, { ...common, model: 'slab', drops: drop(slab.toLowerCase()), place: { mode: 'slab', bottom: slab, top: `${slab}_TOP`, full } });
    block(id0 + 1, `${slab}_TOP`, { ...common, model: 'slab', shape: { half: 'top' }, drops: drop(slab.toLowerCase()), variant: true });
    FACINGS.forEach((f, i) => block(id0 + 2 + i, faced(wslab, f), {
        ...common, model: 'vslab', facing: f, drops: drop(wslab.toLowerCase()),
        ...(i ? { variant: true } : { place: { mode: 'wallslab', names: by(q => faced(wslab, q)), full } }),
    }));
    const sname = (f, top) => (top ? `${stairs}_TOP` : stairs) + (f === 'east' ? '' : `_${f.toUpperCase()}`);
    [false, true].forEach((top, t) => FACINGS.forEach((f, i) => block(id0 + 6 + t * 4 + i, sname(f, top), {
        ...common, model: 'stairs', facing: f, ...(top ? { shape: { half: 'top' } } : {}), drops: drop(stairs.toLowerCase()),
        ...(t || i ? { variant: true } : { place: { mode: 'stairs', up: by(q => sname(q, false)), down: by(q => sname(q, true)) } }),
    })));
    for (const n of [slab, wslab, stairs]) item(n.toLowerCase(), { name: title(n.replace(/^WOODEN_/, 'OAK_')), category: 'Building' });
    recipe(slab.toLowerCase(), 'crafting_table', 2, from, 1);
    recipe(wslab.toLowerCase(), 'crafting_table', 2, from, 1);
    recipe(stairs.toLowerCase(), 'crafting_table', 4, from, 3);
});

// ── What the blocks that were there already gain ─────────────────────────────
// (Read, changed and written back: nothing else in those files is touched.)
const PATCH = {
    '6_wood': { flammable: 15 },
    // A spruce or birch log is that log, not an oak one.
    '62_spruce_log': { flammable: 15, drops: drop('spruce_log') }, '64_birch_log': { flammable: 15, drops: drop('birch_log') },
    '25_wooden_planks': { flammable: 25 }, '32_wool_block': { flammable: 60 }, '20_crafting_table': { flammable: 15 },
    '7_leaves': { flammable: 70, addDrop: { itemId: 'oak_sapling', count: 1, chance: 0.07 } },
    '63_spruce_leaves': { flammable: 70, addDrop: { itemId: 'spruce_sapling', count: 1, chance: 0.07 } },
    '65_birch_leaves': { flammable: 70, addDrop: { itemId: 'birch_sapling', count: 1, chance: 0.07 } },
    '66_jungle_leaves': { flammable: 70 }, '67_acacia_leaves': { flammable: 70 },
    // The anvil is shaped like one, and turned the way it is put down (736–738).
    '24_anvil': { set: { model: 'anvil', facing: 'east', texture: 'Anvil.png', sound: 'stone',
        place: { mode: 'look', names: by(q => (q === 'east' ? 'ANVIL' : `ANVIL_${q.toUpperCase()}`)) } } },
};
// … and the items. Oak is now one wood of three; a ball of clay is not a block of
// it (it is not put down: `placeable`), and the block has an item of its own.
const ITEM_PATCH = {
    wood_log: { name: 'Oak Log', group: 'log' },
    wooden_planks: { name: 'Oak Planks', group: 'planks', category: 'Building' },
    clay_ball: { name: 'Clay Ball', placeable: false, category: 'Materials' },
};
item('clay', { name: 'Clay', category: 'Natural' });
recipe('clay', 'hand', 1, 'clay_ball', 4);
// … and the recipes written by hand that any wood will do for.
const ANY_LOG = ['stick', 'crafting_table', 'chest_recipe', 'wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_sword', 'wooden_spear', 'iron_shield', 'charcoal'];

// ── Write ────────────────────────────────────────────────────────────────────
const write = (file, obj) => {
    const text = JSON.stringify(obj, null, 2) + '\n';
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text) return 0;
    fs.writeFileSync(file, text);
    return 1;
};
let wrote = 0;
// A block of ours whose name has changed leaves its old file behind: one file an id.
const mine = new Map(blocks.map(b => [b.id, `${b.id}_${b.name.toLowerCase()}.json`]));
for (const f of fs.readdirSync(path.join(ROOT, 'blocks'))) {
    const id = parseInt(f, 10);
    if (mine.has(id) && mine.get(id) !== f) fs.unlinkSync(path.join(ROOT, 'blocks', f));
}
for (const b of blocks) {
    for (const k of Object.keys(b)) if (b[k] === null && k !== 'drops') delete b[k];
    wrote += write(path.join(ROOT, 'blocks', `${b.id}_${b.name.toLowerCase()}.json`), b);
}
for (const it of items) wrote += write(path.join(ROOT, 'items', `${it.id}.json`), it);
for (const r of recipes) wrote += write(path.join(ROOT, 'recipes', `${r.id}.json`), r);
for (const [file, p] of Object.entries(PATCH)) {
    const f = path.join(ROOT, 'blocks', `${file}.json`);
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (p.flammable) b.flammable = p.flammable;
    if (p.drops) b.drops = p.drops;
    if (p.set) Object.assign(b, p.set);
    if (p.addDrop) {
        b.drops = (b.drops ?? []).filter(d => (d.itemId ?? d.item) !== p.addDrop.itemId);
        b.drops.push(p.addDrop);
    }
    wrote += write(f, b);
}
for (const [id, p] of Object.entries(ITEM_PATCH)) {
    const f = path.join(ROOT, 'items', `${id}.json`);
    wrote += write(f, { ...JSON.parse(fs.readFileSync(f, 'utf8')), ...p });
}
for (const id of ANY_LOG) {
    const f = path.join(ROOT, 'recipes', `${id}.json`);
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    r.ingredients = r.ingredients.map(i => (i.itemId === 'wood_log' ? { ...i, any: 'log' } : i));
    wrote += write(f, r);
}

// Every ingredient and every drop is an item there is.
const have = new Set(fs.readdirSync(path.join(ROOT, 'items')).map(f => f.replace(/\.json$/, '')));
const missing = new Set();
for (const r of recipes) for (const i of [...r.ingredients, r.result]) if (!have.has(i.itemId)) missing.add(i.itemId);
for (const b of blocks) for (const d of b.drops ?? []) if (!have.has(d.itemId)) missing.add(d.itemId);
if (missing.size) { console.error('no such item:', [...missing].join(', ')); process.exit(1); }

console.log(`${blocks.length} blocks, ${items.length} items, ${recipes.length} recipes (${wrote} files written); highest block id ${Math.max(...blocks.map(b => b.id))}`);
