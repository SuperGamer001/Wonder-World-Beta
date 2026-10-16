/**
 * Water: a source spreads, a flow thins out to nothing, falls, comes to rest,
 * and goes when its source is taken (engine/WaterSimulator.js) — in small
 * worlds made by hand. And how it is drawn: one sloping sheet, with no step
 * between one block of it and the next (workers/GreedyMesher.js).
 *
 *     node test/water.test.mjs
 */
import { BlockRegistry, FLUID_FALL, FLUID_SOURCE } from '../src/scripts/engine/BlockRegistry.js';
import { WaterSimulator } from '../src/scripts/engine/WaterSimulator.js';
import { GreedyMesher } from '../src/scripts/workers/GreedyMesher.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, CHUNK_VOLUME, WORLD_MIN_Y } from '../src/scripts/engine/ChunkData.js';
import { UV_SCALE } from '../src/scripts/engine/MeshFormat.js';

let failed = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failed++;
}

const AIR = 0, STONE = 1, WATER = 5, FALL = 79, FLOWER = 90, GLASS = 91;
function registry() {
    const reg = new BlockRegistry();
    reg.register({ id: AIR, name: 'AIR', transparent: true, noCollision: true });
    reg.register({ id: STONE, name: 'STONE', terrainType: 'solid' });
    reg.register({ id: WATER, name: 'WATER', transparent: true, liquid: true, noCollision: true });
    for (let l = 1; l <= 7; l++) reg.register({ id: 71 + l, name: `WATER_${l}`, transparent: true, liquid: true, noCollision: true, fluid: l });
    reg.register({ id: FALL, name: 'WATER_FALL', transparent: true, liquid: true, noCollision: true, fluid: 'fall' });
    reg.register({ id: FLOWER, name: 'POPPY', model: 'cross' });
    reg.register({ id: GLASS, name: 'GLASS', transparent: true, render: 'cutout' });
    return reg;
}
const reg = registry();
const flow = (l) => 71 + l;

/** A world of plain blocks: a stone floor at y = 0 and below, air above, and whatever is put in it. */
function world(floor = true) {
    const m = new Map();
    const w = {
        getChunk: () => ({ generated: true }),
        getBlock: (x, y, z) => m.get(`${x},${y},${z}`) ?? (floor && y <= 0 ? STONE : AIR),
        setBlock: (x, y, z, id) => { m.set(`${x},${y},${z}`, id); return true; },
        m,
    };
    return w;
}
function settle(sim, max = 400) {
    let n = 0;
    while (sim.pending > 0 && n < max) { sim.step(); n++; }
    return n;
}
const level = (sim, w, x, y, z) => sim.level[w.getBlock(x, y, z)];

// ── A source on flat ground ──────────────────────────────────────────────────
{
    const w = world(), sim = new WaterSimulator(w, reg);
    check('the registry\'s water is found', sim.enabled && sim.sourceId === WATER && sim.fallId === FALL && sim.flowId[7] === flow(7));
    w.setBlock(0, 1, 0, WATER); sim.touch(0, 1, 0);
    const steps = settle(sim);
    let ok = true, cells = 0;
    for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) {
        const d = Math.abs(x) + Math.abs(z), l = level(sim, w, x, 1, z);
        const want = d === 0 ? FLUID_SOURCE : d <= 7 ? 8 - d : 0;
        if (l !== want) ok = false;
        if (l) cells++;
    }
    check('a source spreads seven blocks, a level less each block', ok, `${cells} blocks of water after ${steps} steps`);
    check('… and nothing above or below the floor it runs on', level(sim, w, 3, 2, 0) === 0 && w.getBlock(3, 0, 0) === STONE);

    // Take the source: all of it goes.
    w.setBlock(0, 1, 0, AIR); sim.touch(0, 1, 0);
    const gone = settle(sim);
    let left = 0;
    for (const id of w.m.values()) if (sim.level[id]) left++;
    check('with its source taken, the water goes', left === 0, `${left} left after ${gone} steps`);
}

// ── Over an edge ─────────────────────────────────────────────────────────────
{
    // A ledge: floor at y = 5 for x ≤ 2, and the ground far below (y = 0) beyond.
    const w = world();
    for (let x = -12; x <= 2; x++) for (let z = -12; z <= 12; z++) for (let y = 1; y <= 5; y++) w.setBlock(x, y, z, STONE);
    const sim = new WaterSimulator(w, reg);
    w.setBlock(1, 6, 0, WATER); sim.touch(1, 6, 0);
    settle(sim);
    check('water runs off an edge and falls', level(sim, w, 3, 6, 0) === 6 && [5, 4, 3, 2, 1].every(y => level(sim, w, 3, y, 0) === FLUID_FALL),
        [6, 5, 4, 3, 2, 1].map(y => level(sim, w, 3, y, 0)).join(' '));
    check('… and does not run on sideways in the air', level(sim, w, 4, 6, 0) === 0 && level(sim, w, 4, 3, 0) === 0);
    check('… and spreads again where it lands', level(sim, w, 4, 1, 0) === 7 && level(sim, w, 5, 1, 0) === 6);
    w.setBlock(1, 6, 0, AIR); sim.touch(1, 6, 0);
    settle(sim);
    let left = 0;
    for (const id of w.m.values()) if (sim.level[id]) left++;
    check('the whole fall goes with its source', left === 0, `${left} left`);
}

// ── Sources ──────────────────────────────────────────────────────────────────
{
    const w = world(), sim = new WaterSimulator(w, reg);
    // A trench one wide, walled: two sources with a gap between them.
    for (let x = -3; x <= 3; x++) for (const z of [-1, 1]) w.setBlock(x, 1, z, STONE);
    w.setBlock(-3, 1, 0, STONE); w.setBlock(3, 1, 0, STONE);
    w.setBlock(-1, 1, 0, WATER); w.setBlock(1, 1, 0, WATER);
    sim.touch(-1, 1, 0); sim.touch(1, 1, 0);
    settle(sim);
    check('a gap between two sources becomes a source', w.getBlock(0, 1, 0) === WATER);
    w.setBlock(0, 1, 0, AIR); sim.touch(0, 1, 0);
    settle(sim);
    check('… and fills again when it is taken (a pool does not run dry)', w.getBlock(0, 1, 0) === WATER);

    // A lake, and a hole dug beside it: it fills with flowing water, and a block dug under the lake with falling water.
    const w2 = world(), sim2 = new WaterSimulator(w2, reg);
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
        const edge = Math.max(Math.abs(x), Math.abs(z)) === 4;
        w2.setBlock(x, 1, z, edge ? STONE : WATER);
    }
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) if (Math.max(Math.abs(x), Math.abs(z)) > 4) w2.setBlock(x, 1, z, STONE);
    sim2.touch(0, 1, 0);
    settle(sim2);
    let still = true;
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (w2.getBlock(x, 1, z) !== WATER) still = false;
    check('a lake that is touched stays as it is', still && sim2.pending === 0);
    w2.setBlock(4, 1, 0, AIR); sim2.touch(4, 1, 0);          // the bank
    w2.setBlock(5, 1, 0, AIR); sim2.touch(5, 1, 0);
    settle(sim2);
    check('a breach in its bank lets it out', level(sim2, w2, 4, 1, 0) === 7 && level(sim2, w2, 5, 1, 0) === 6);
    w2.setBlock(0, 0, 0, AIR); sim2.touch(0, 0, 0);
    settle(sim2);
    check('a hole under it fills with falling water', level(sim2, w2, 0, 0, 0) === FLUID_FALL);
}

// ── What water takes, and what stops it ──────────────────────────────────────
{
    const w = world(), sim = new WaterSimulator(w, reg);
    const washed = [];
    sim.onWash = (x, y, z, id) => washed.push(`${x},${y},${z}:${id}`);
    w.setBlock(2, 1, 0, FLOWER);
    w.setBlock(0, 1, 2, GLASS);
    w.setBlock(0, 1, 0, WATER); sim.touch(0, 1, 0);
    settle(sim);
    check('water washes a flower away', level(sim, w, 2, 1, 0) === 6 && washed.join() === `2,1,0:${FLOWER}`, washed.join());
    check('… and goes round what it cannot enter', w.getBlock(0, 1, 2) === GLASS && level(sim, w, 0, 1, 3) === 3, String(level(sim, w, 0, 1, 3)));
}

// ── Land that is not there ───────────────────────────────────────────────────
{
    const w = world(), sim = new WaterSimulator(w, reg);
    w.getChunk = (cx) => (cx >= 1 ? undefined : { generated: true });      // nothing east of x = 16
    w.setBlock(13, 1, 0, WATER); sim.touch(13, 1, 0);
    settle(sim);
    check('water waits at the edge of the land that is loaded', level(sim, w, 14, 1, 0) === 7 && level(sim, w, 15, 1, 0) === 0 && !w.m.has('16,1,0'),
        `${level(sim, w, 14, 1, 0)} ${level(sim, w, 15, 1, 0)}`);
}

// ── Drawn as one sheet ───────────────────────────────────────────────────────
{
    const w = world(), sim = new WaterSimulator(w, reg);
    w.setBlock(8, 1, 8, WATER); sim.touch(8, 1, 8);
    settle(sim);
    // The same water as a chunk's voxels (the floor at local y = 10).
    const SY = CHUNK_SIZE, SZ = CHUNK_SIZE * CHUNK_SIZE_Y;
    const vox = new Uint16Array(CHUNK_VOLUME);
    const Y0 = 10;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        for (let y = 0; y <= Y0; y++) vox[x + y * SY + z * SZ] = STONE;
        vox[x + (Y0 + 1) * SY + z * SZ] = w.getBlock(x, 1, z);
    }
    const mesher = new GreedyMesher(reg, { [WATER]: { top: 5, side: 5, bottom: 5 }, ...Object.fromEntries([...Array(8)].map((_, i) => [72 + i, { top: 5, side: 5, bottom: 5 }])) });
    check('a chunk with flowing water in it says so', mesher.hasFluids([0, STONE, flow(3)]) && !mesher.hasFluids([0, STONE, WATER]));
    const air = new Uint16Array(CHUNK_VOLUME);
    const geo = mesher.meshGroup(vox, { '1,0': air, '-1,0': air, '0,1': air, '0,-1': air }, [0, 1, 2, 3, 4, 5], { min: 0, max: Y0 + 1 }, null, false,
        { fluids: true, diagonals: { '1,1': air, '1,-1': air, '-1,1': air, '-1,-1': air } });
    const pos = geo.transparentPositions, nrm = geo.transparentNormals, idx = geo.transparentIndices;
    check('flowing water is drawn', pos.length > 0 && idx.length % 6 === 0, `${pos.length / 3} vertices`);

    // Every vertex of the surface: one height at each place, whichever block's quad it belongs to.
    const at = new Map();
    let split = 0, low = 0, high = 0, n = 0;
    for (let i = 0; i < pos.length; i += 3) {
        if (nrm[(i / 3) * 4 + 1] <= 60) continue;            // not a surface facing up
        const y = pos[i + 1] - (Y0 + 1);
        if (y < 0.001) continue;                              // an underside
        const k = `${pos[i]},${pos[i + 2]}`;
        if (at.has(k) && Math.abs(at.get(k) - y) > 1e-5) split++;
        at.set(k, y);
        n++;
        if (y < 0.02) low++;
        if (y > 1.0001) high++;
    }
    check('its surface is one sheet: blocks meet at one height at every corner', split === 0 && n > 100, `${n} surface vertices at ${at.size} places, ${split} that disagree`);
    check('… never above the top of its block, never under its floor', high === 0 && low === 0);
    // It slopes: next to the source the surface is full height, and it falls away from there.
    const h = (x, z) => at.get(`${x},${z}`);
    check('… full at the source and falling away from it', h(8, 8) === 1 && h(9, 9) === 1 && h(10, 8) < 1 && h(11, 8) < h(10, 8) && h(13, 8) < h(12, 8) && h(15, 8) < 0.2,
        [8, 9, 10, 11, 12, 13, 14, 15].map(x => (h(x, 8) ?? NaN).toFixed(2)).join(' '));
    // Each quad twice (seen from above and from under), in range.
    let bad = 0;
    for (let i = 0; i < idx.length; i++) if (idx[i] >= pos.length / 3) bad++;
    check('indices in range, and every face there from both sides', bad === 0 && (pos.length / 3) % 8 === 0);
    void UV_SCALE;
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
