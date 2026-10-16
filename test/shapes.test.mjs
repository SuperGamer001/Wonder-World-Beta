/**
 * The blocks that are not cubes: that the definitions hang together (every
 * door has its top, every toggle comes back, every texture and item named is
 * there), that what stops a body is what is drawn (engine/BlockShapes.js), and
 * that the mesher draws each of them inside its own block.
 *
 *     node test/shapes.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistryFromGamePack } from '../src/scripts/engine/BlockRegistry.js';
import { isModel, compileShape, CONN_E, CONN_W, CONN_S, CONN_N, FACINGS, SIDE_L, SIDE_R, STAIR_OUTER_L, STAIR_INNER_R, STAIR_STRAIGHT, SOFA_INNER_L, SOFA_OUTER_L } from '../src/scripts/engine/BlockShapes.js';
import { blockTextureLayers } from '../src/scripts/engine/BlockTextures.js';
import { GreedyMesher } from '../src/scripts/workers/GreedyMesher.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME } from '../src/scripts/engine/ChunkData.js';
import { treeBlocks } from '../src/scripts/workers/StructurePlacer.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = (d) => fs.readdirSync(path.join(ROOT, 'data', d)).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', d, f), 'utf8')));

let failed = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed++;
}
const few = (a) => a.slice(0, 6).join(', ') + (a.length > 6 ? ` … (${a.length})` : '');

const blocks = dir('blocks'), items = dir('items'), recipes = dir('recipes');
const reg = buildRegistryFromGamePack({ blocks });
const byName = new Map(blocks.map(b => [b.name, b]));
const itemIds = new Set(items.map(i => i.id));
const def = (n) => reg.getByName(n);

// ── The definitions ──────────────────────────────────────────────────────────
{
    const ids = blocks.map(b => b.id);
    check('block ids and names are unique', new Set(ids).size === ids.length && byName.size === blocks.length, `${blocks.length} blocks`);
    const models = blocks.filter(b => b.model);
    check('every model named is one there is', models.every(b => isModel(b.model)), few(models.filter(b => !isModel(b.model)).map(b => `${b.name}: ${b.model}`)));

    const noTex = [];
    for (const b of models) {
        const files = b.texture ? [b.texture] : Object.values(b.textures ?? {});
        if (files.length === 0 && !reg.get(b.id).light && b.id > 43) noTex.push(b.name);
        for (const f of files) if (!fs.existsSync(path.join(ROOT, 'data', 'textures', 'blocks', f))) noTex.push(`${b.name}: ${f}`);
    }
    check('every model has its textures, and they are there', noTex.length === 0, few(noTex));

    // Names that one block gives for another.
    const named = [];
    const want = (b, n, what) => { if (n !== 'AIR' && !byName.has(n)) named.push(`${b.name} ${what} ${n}`); };
    for (const b of blocks) {
        for (const n of Object.values(b.placement ?? {})) want(b, n, 'places');
        const p = b.place ?? {};
        for (const k of ['bottom', 'top', 'full']) if (p[k]) want(b, p[k], 'places');
        for (const t of [p.names, p.up, p.down, p.lower, p.upper, p.foot, p.head]) for (const n of Object.values(t ?? {})) want(b, n, 'places');
        const u = b.use ?? {};
        for (const k of ['toggle', 'light', 'ignite', 'douse', 'to']) if (typeof u[k] === 'string') want(b, u[k], 'becomes');
        if (u.eat?.to) want(b, u.eat.to, 'becomes');
        for (const n of Object.values(u.pot ?? {})) want(b, n, 'becomes');
    }
    check('every block a block names is one there is', named.length === 0, few(named));

    // What is used goes round: a door opened can be shut, a painting comes back to the first picture.
    // (A gate opened away from whoever opens it shuts to the gate it was: that one comes round.)
    const stuck = [];
    for (const b of blocks) {
        if (!b.use?.toggle) continue;
        const start = byName.get(b.use.toggle)?.use?.away === b.name ? b.use.toggle : b.name;
        let n = start, k = 0;
        do { n = byName.get(n)?.use?.toggle; k++; } while (n && n !== start && k < 20);
        if (n !== start) stuck.push(b.name);
    }
    check('whatever is toggled comes round to what it was', stuck.length === 0, few(stuck));
    const away = blocks.filter(b => b.use?.away).map(b => [b, byName.get(b.use.away)]);
    check('a gate opens either way: away from whoever opens it', away.length >= 12 && away.every(([b, o]) => o?.shape?.open && o.shape.back && o.use?.toggle === b.name), `${away.length} gates`);

    // A thing of many blocks: every piece knows where every other is, and they are one picture.
    const pieces = blocks.filter(b => b.group);
    const torn = [];
    for (const b of pieces) {
        for (const o of b.group) {
            // The other piece, the same picture, the same way round: does it say where this one is?
            const mate = pieces.find(q => q.piece === b.piece && q.facing === b.facing && q.group.some(g => g[0] === -o[0] && g[1] === -o[1] && g[2] === -o[2])
                && q.name !== b.name && JSON.stringify(q.group.map(g => [g[0] - o[0], g[1] - o[1], g[2] - o[2]]).sort()) !== '');
            if (!mate) { torn.push(b.name); break; }
        }
    }
    const sizes = new Set(pieces.map(b => b.group.length + 1));
    check('paintings of several blocks: every piece knows where the others are', torn.length === 0 && [2, 4, 8, 12].every(n => sizes.has(n)), few(torn) || [...sizes].join(' '));

    // Two halves: each says where the other is, and they change together.
    const halves = [];
    for (const b of blocks) {
        const p = b.place;
        if (p?.mode === 'door') for (const f of FACINGS) {
            const lo = byName.get(p.lower[f]), up = byName.get(p.upper[f]);
            if (!lo || !up || String(lo.twin) !== '0,1,0' || String(up.twin) !== '0,-1,0' || lo.facing !== f || up.facing !== f) halves.push(`${b.name} ${f}`);
            else if (byName.get(lo.use.toggle)?.shape?.open !== true || String(byName.get(up.use.toggle)?.twin) !== '0,-1,0') halves.push(`${b.name} ${f} open`);
        }
        if (p?.mode === 'bed') for (const f of FACINGS) {
            const foot = byName.get(p.foot[f]), head = byName.get(p.head[f]);
            if (!foot || !head || foot.twin[0] !== -head.twin[0] || foot.twin[2] !== -head.twin[2] || foot.twin[0] ** 2 + foot.twin[2] ** 2 !== 1) halves.push(`${b.name} ${f}`);
        }
    }
    check('a door and its top, a bed and its head: each knows where the other is', halves.length === 0, few(halves));

    // One of several an item puts down is not offered by itself; the one that is, has an item of its name.
    const orphans = models.filter(b => !b.variant && !itemIds.has(b.name.toLowerCase()) && b.name !== 'FIRE' && b.id > 43).map(b => b.name);
    check('every block a player can be handed has an item', orphans.length === 0, few(orphans));
    const lost = [];
    for (const b of blocks) for (const d of b.drops ?? []) if (!itemIds.has(d.itemId ?? d.item)) lost.push(`${b.name} drops ${d.itemId ?? d.item}`);
    for (const r of recipes) for (const i of [...r.ingredients, r.result]) if (!itemIds.has(i.itemId)) lost.push(`recipe ${r.id}: ${i.itemId}`);
    check('every item dropped, made or needed is one there is', lost.length === 0, few(lost));
    const icons = items.filter(i => i.icon && !fs.existsSync(path.join(ROOT, i.icon))).map(i => i.id);
    check('every icon an item names is there', icons.length === 0, few(icons));

    const { layers } = blockTextureLayers(reg);
    check('the block textures fit the texture array (255 layers)', layers.length <= 255, `${layers.length} layers`);

    const water = [1, 2, 3, 4, 5, 6, 7].map(l => blocks.find(b => b.fluid === l)).every(Boolean) && !!blocks.find(b => b.fluid === 'fall');
    check('water has its seven levels of flow and its fall', water && reg.fluidOf(def('WATER').id) === 9 && reg.fluidHeight(def('WATER_4').id) === 0.5);
    const tree = ['OAK_SAPLING', 'BIRCH_SAPLING', 'SPRUCE_SAPLING'].map(n => treeBlocks(def(n).grows, reg, 7));
    check('every sapling grows into a tree the generator knows', tree.every(t => t && t.length > 40), tree.map(t => t?.length ?? 0).join(' '));
}

// ── What stops a body ────────────────────────────────────────────────────────
{
    const shapes = reg.shapes;
    const world = (cells) => ({ getBlock: (x, y, z) => cells[`${x},${y},${z}`] ?? 0 });
    const hits = (name, w, x0, y0, z0, x1, y1, z1) => shapes.boxHits(shapes.of(def(name).id), w, 0, 0, 0, x0, y0, z0, x1, y1, z1);
    const none = world({});

    check('a slab stops a body in its half and not in the other',
        hits('WOODEN_SLAB', none, 0.2, 0.1, 0.2, 0.8, 0.4, 0.8) && !hits('WOODEN_SLAB', none, 0.2, 0.55, 0.2, 0.8, 0.95, 0.8) &&
        hits('WOODEN_SLAB_TOP', none, 0.2, 0.55, 0.2, 0.8, 0.95, 0.8) && !hits('WOODEN_SLAB_TOP', none, 0.2, 0.05, 0.2, 0.8, 0.45, 0.8));
    // Stairs facing east: the low step to the west, the high one to the east.
    const high = (name, x, z) => hits(name, none, x - 0.1, 0.6, z - 0.1, x + 0.1, 0.9, z + 0.1);
    check('stairs are turned to their facing',
        high('WOODEN_STAIRS', 0.75, 0.5) && !high('WOODEN_STAIRS', 0.25, 0.5) &&
        high('WOODEN_STAIRS_WEST', 0.25, 0.5) && !high('WOODEN_STAIRS_WEST', 0.75, 0.5) &&
        high('WOODEN_STAIRS_SOUTH', 0.5, 0.75) && !high('WOODEN_STAIRS_SOUTH', 0.5, 0.25) &&
        high('WOODEN_STAIRS_NORTH', 0.5, 0.25) && !high('WOODEN_STAIRS_NORTH', 0.5, 0.75));
    check('… and upside down, the other way up', hits('WOODEN_STAIRS_TOP', none, 0.1, 0.6, 0.4, 0.3, 0.9, 0.6) && !hits('WOODEN_STAIRS_TOP', none, 0.1, 0.1, 0.4, 0.3, 0.4, 0.6));

    // A door: a leaf on one side, and when it is open, on the side beside that.
    const leaf = (name) => { const b = shapes.of(def(name).id).hit; return [...b].map(v => Math.round(v * 16)).join(','); };
    const leaves = new Set(FACINGS.flatMap(f => [leaf(f === 'east' ? 'WOODEN_DOOR' : `WOODEN_DOOR_${f.toUpperCase()}`), leaf(f === 'east' ? 'WOODEN_DOOR_OPEN' : `WOODEN_DOOR_${f.toUpperCase()}_OPEN`)]));
    check('a door is a thin leaf: four ways shut, and four ways open that are the same four', leaves.size === 4 && leaf('WOODEN_DOOR') === '0,0,0,3,16,16' && leaf('WOODEN_DOOR_OPEN') === '0,0,0,16,16,3', [...leaves].join(' | '));
    check('… and a body goes through the doorway beside it', !hits('WOODEN_DOOR_OPEN', none, 0.2, 0, 0.3, 0.8, 1, 0.9) && hits('WOODEN_DOOR', none, 0.0, 0, 0.3, 0.3, 1, 0.9));

    // A fence joins what stands beside it, and stops a jump.
    const fence = def('WOODEN_FENCE').id, stone = def('STONE').id, glass = def('GLASS').id, gate = def('FENCE_GATE').id;
    const w = world({ '1,0,0': fence, '-1,0,0': stone, '0,0,1': glass, '0,0,-1': gate });
    const fenceShape = shapes.of(fence);
    check('a fence reaches out to fences, gates and solid blocks, not to glass', shapes.conn(w, 0, 0, 0, fenceShape) === (CONN_E | CONN_W | CONN_N), String(shapes.conn(w, 0, 0, 0, fenceShape)));
    check('… its arm stops a body, and where it has none there is a way past', hits('WOODEN_FENCE', w, 0.7, 0.2, 0.45, 0.95, 0.8, 0.55) && !hits('WOODEN_FENCE', w, 0.3, 0.2, 0.7, 0.7, 0.8, 0.95));
    // (PlayerPhysics: a jump is 1.25 blocks.)
    check('… and it stands higher than a jump', hits('WOODEN_FENCE', none, 0.4, 1.3, 0.4, 0.6, 1.45, 0.6) && !hits('WOODEN_FENCE', none, 0.4, 1.55, 0.4, 0.6, 1.9, 0.6) && reg.isTall(fence) && reg.isTall(gate) && !reg.isTall(def('FENCE_GATE_OPEN').id));

    // Stairs make corners; chairs side by side are a bench; tables side by side one table.
    const st = (n) => def(n).id;
    const stairsAt = (cells) => shapes.conn(world(cells), 0, 0, 0, shapes.of(cells['0,0,0']));
    check('stairs with stairs behind them turned across them are an outer corner',
        stairsAt({ '0,0,0': st('WOODEN_STAIRS'), '1,0,0': st('WOODEN_STAIRS_NORTH') }) === STAIR_OUTER_L &&
        hits('WOODEN_STAIRS', world({ '1,0,0': st('WOODEN_STAIRS_NORTH') }), 0.6, 0.6, 0.1, 0.9, 0.9, 0.3) &&
        !hits('WOODEN_STAIRS', world({ '1,0,0': st('WOODEN_STAIRS_NORTH') }), 0.6, 0.6, 0.7, 0.9, 0.9, 0.9));
    check('… in front of them, an inner one; and in a straight run, neither',
        stairsAt({ '0,0,0': st('WOODEN_STAIRS'), '-1,0,0': st('WOODEN_STAIRS_SOUTH') }) === STAIR_INNER_R &&
        stairsAt({ '0,0,0': st('WOODEN_STAIRS'), '1,0,0': st('WOODEN_STAIRS_NORTH'), '0,0,1': st('WOODEN_STAIRS') }) === STAIR_STRAIGHT &&
        stairsAt({ '0,0,0': st('WOODEN_STAIRS'), '1,0,0': st('STONE_STAIRS_TOP_NORTH') }) === STAIR_STRAIGHT);
    const chair = st('CHAIR');
    check('chairs side by side, the same way round, are a bench; turned another way, not',
        shapes.conn(world({ '0,0,0': chair, '0,0,-1': chair, '0,0,1': chair }), 0, 0, 0) === (SIDE_L | SIDE_R) &&
        shapes.conn(world({ '0,0,0': chair, '0,0,1': st('CHAIR_WEST') }), 0, 0, 0) === 0 &&
        hits('CHAIR', world({ '0,0,1': chair }), 0.3, 0.3, 0.9, 0.7, 0.5, 0.99) && !hits('CHAIR', none, 0.3, 0.3, 0.9, 0.7, 0.5, 0.99));
    const table = st('TABLE'), legsOf = (cells) => [...shapes.of(table).hit[shapes.conn(world(cells), 0, 0, 0, shapes.of(table))]].length / 6 - 1;
    check('a table stands on its corners, and tables side by side on theirs', legsOf({}) === 4 && legsOf({ '1,0,0': table }) === 2 && legsOf({ '1,0,0': table, '-1,0,0': table }) === 0 && legsOf({ '1,0,0': table, '0,0,1': st('SPRUCE_TABLE') }) === 1);

    // Sofas turn corners as stairs do; chairs do not. (A sofa faces the way its sitter looks: its back is behind.)
    const sofaE = st('SOFA'), sofaS = st('SOFA_SOUTH'), sofaN = st('SOFA_NORTH'), sofaW = st('SOFA_WEST');
    const sofaAt = (cells, at = '0,0,0') => { const [x, y, z] = at.split(',').map(Number); return shapes.conn(world(cells), x, y, z, shapes.of(cells[at])); };
    // An L facing into a room's corner: the corner sofa faces east, the row in front of it faces south, the row beside it east.
    const inner = { '0,0,0': sofaE, '1,0,0': sofaS, '2,0,0': sofaS, '0,0,1': sofaE };
    check('a sofa with one turned across it in front is an inner corner, its back running on along that side',
        sofaAt(inner) === SOFA_INNER_L + 1 && sofaAt(inner, '1,0,0') === (SIDE_L | SIDE_R) && sofaAt(inner, '0,0,1') === SIDE_L &&
        hits('SOFA', world(inner), 0.5, 0.6, 0.05, 0.7, 0.8, 0.25), String(sofaAt(inner)));
    // An L round a pillar: the corner faces west, the row behind it faces north, the row beside it west.
    const outer = { '0,0,0': sofaW, '1,0,0': sofaN, '0,0,1': sofaW };
    check('… one behind it, an outer corner: only a post where the backs meet, and no arms',
        sofaAt(outer) === SOFA_OUTER_L && !hits('SOFA_WEST', world(outer), 0.4, 0.6, 0.05, 0.6, 0.8, 0.2) && hits('SOFA_WEST', world(outer), 0.75, 0.6, 0.75, 0.95, 0.8, 0.95),
        String(sofaAt(outer)));
    check('… and in a straight run past it, neither; chairs make no corners',
        sofaAt({ '0,0,0': sofaE, '0,0,-1': sofaE, '0,0,1': sofaE, '1,0,0': sofaS }) === (SIDE_L | SIDE_R) &&
        shapes.conn(world({ '0,0,0': chair, '1,0,0': st('CHAIR_SOUTH') }), 0, 0, 0) === 0);
    // An open curtain is still met across its whole width, so it can be drawn shut by looking through it.
    check('an open curtain is met by a look through the middle of it', shapes.pointIn(shapes.of(def('RED_CURTAIN_OPEN').id), none, 0.08, 0.5, 0.5) && shapes.pointIn(shapes.of(def('RED_CURTAIN').id), none, 0.08, 0.5, 0.5));

    // A door hung on the other side; a gate open the other way still met across its gateway.
    check('a door can be hung on either side', leaf('WOODEN_DOOR_RIGHT_OPEN') === '0,0,13,16,16,16' && leaf('WOODEN_DOOR_RIGHT') === '0,0,0,3,16,16');
    const gateway = (n) => shapes.pointIn(shapes.of(def(n).id), none, 0.5, 0.5, 0.5);
    check('a gate, shut or open either way, is met by a look through the middle of it', gateway('FENCE_GATE') && gateway('FENCE_GATE_OPEN') && gateway('FENCE_GATE_OPEN_BACK'));

    const soft = ['POPPY', 'TALL_GRASS', 'OAK_SAPLING'].every(n => { const d = def(n); return reg.isNoCollision(d.id) && d.soft && d.wash && d.rain === 0 && reg.isTargetable(d.id); });
    check('a plant is walked through, washed away, rained through — and can still be picked', soft);
    check('a ladder is climbed, and walked through', reg.isClimb(def('LADDER').id) && reg.isNoCollision(def('LADDER').id) && !reg.isClimb(def('WOODEN_FENCE').id));
    check('slabs and stairs stop light and rain; a fence does neither, a table only rain', def('WOODEN_SLAB').shade && def('STONE_STAIRS').shade && !def('WOODEN_FENCE').shade && def('WOODEN_SLAB').rain === 8 && def('TABLE').rain === 16 && !def('TABLE').shade);

    // The face a look comes in by.
    const slab = shapes.of(def('WOODEN_SLAB').id);
    const top = shapes.faceAt(slab, none, 0.5, 0.49, 0.5, 0, -0.8, -0.6), side = shapes.faceAt(slab, none, 0.5, 0.3, 0.98, 0, -0.2, -0.98);
    check('a slab looked down on is met on its top, though that is in the middle of its block', String(top) === '0,1,0' && String(side) === '0,0,1', `${top} / ${side}`);
    check('… and a look into the empty half of its block meets nothing', !shapes.pointIn(slab, none, 0.5, 0.8, 0.5) && shapes.pointIn(slab, none, 0.5, 0.2, 0.5));
}

// ── Drawn inside its own block ───────────────────────────────────────────────
{
    const { faceMap } = blockTextureLayers(reg);
    const mesher = new GreedyMesher(reg, faceMap);
    const SY = CHUNK_SIZE, SZ = CHUNK_SIZE * CHUNK_SIZE_Y;
    const models = blocks.filter(b => b.model);
    const vox = new Uint16Array(CHUNK_VOLUME);
    // One of each, three blocks apart, on a floor — in layers of 25.
    const where = new Map();
    models.forEach((b, i) => {
        const x = 1 + (i % 5) * 3, z = 1 + (Math.floor(i / 5) % 5) * 3, y = 4 + Math.floor(i / 25) * 4;
        vox[x + (y - 1) * SY + z * SZ] = def('STONE').id;
        vox[x + y * SY + z * SZ] = b.id;
        where.set(`${x},${y},${z}`, b);
    });
    const yMax = 4 + Math.ceil(models.length / 25) * 4;
    const air = new Uint16Array(CHUNK_VOLUME);
    const geo = mesher.meshGroup(vox, { '1,0': air, '-1,0': air, '0,1': air, '0,-1': air }, [0, 1, 2, 3, 4, 5], { min: 0, max: yMax }, null, true);
    const pos = geo.positions, drawn = new Set();
    let outside = 0, flat = 0;
    // Every vertex that is not one of the floor's cubes belongs to the model whose block it is in.
    for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        // A vertex on a block's boundary belongs to the block on either side: look for a model on both.
        let b = null, key = '';
        for (const fx of [Math.floor(x), Math.ceil(x) - 1]) for (const fy of [Math.floor(y), Math.ceil(y) - 1]) for (const fz of [Math.floor(z), Math.ceil(z) - 1]) {
            const k = `${fx},${fy},${fz}`;
            if (where.has(k)) { b = where.get(k); key = k; }
        }
        if (!b) {
            // The floor's own cubes, or something drawn outside every model's block?
            const onFloor = [Math.floor(y), Math.ceil(y) - 1].some(fy => (fy - 3) % 4 === 0);
            if (!onFloor) outside++;
            continue;
        }
        drawn.add(key);
        const n = geo.normals;
        if (n[(i / 3) * 4] === 0 && n[(i / 3) * 4 + 1] === 0 && n[(i / 3) * 4 + 2] === 0) flat++;
    }
    check('every model is drawn', drawn.size === models.length, `${drawn.size} of ${models.length}`);
    check('… inside its own block, and facing somewhere', outside === 0 && flat === 0, `${outside} vertices outside, ${flat} with no normal`);
    let bad = 0;
    for (let i = 0; i < geo.indices.length; i++) if (geo.indices[i] >= pos.length / 3) bad++;
    check('… with indices in range', bad === 0 && geo.indices.length % 3 === 0, `${geo.indices.length / 3} triangles`);
    check('a chunk with models in it says so, and one without does not', mesher.hasModels([0, def('POPPY').id]) && !mesher.hasModels([0, def('STONE').id, def('WATER').id]));

    // A compiled shape is the same boxes whoever asks: the drawing and the collision go by one description.
    const sc = compileShape(reg.get(def('WOODEN_STAIRS_NORTH').id));
    check('stairs: two boxes drawn, two that stop a body', sc.els(STAIR_STRAIGHT).length === 2 && sc.hit[STAIR_STRAIGHT].length === 12 && sc.hit[STAIR_INNER_R].length === 18 && sc.shade && !sc.tall);
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
