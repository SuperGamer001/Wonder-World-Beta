// Mob navigation and behaviour (engine/MobNav.js, engine/MobAI.js), in worlds
// made of plain functions: paths go round pits, walls and water, up a block and
// down a small drop; a mob that follows them gets there, jumps where it must,
// and never ends up at the bottom of a pit — walking, fleeing, wandering for
// minutes, or chasing the player.
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { MobNav, NONE } from '../src/scripts/engine/MobNav.js';
import { MobAI } from '../src/scripts/engine/MobAI.js';
import { MODELS } from '../src/scripts/engine/MobModelDefs.js';
import { shapeMesh, surfacePoint } from '../src/scripts/engine/MobShapes.js';
import { ANIMATORS, GAITS, FEET, makePose, resetPose, makeAnimState, poseMatrices } from '../src/scripts/engine/MobAnim.js';

let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

const reg = new BlockRegistry();
reg.register({ id: 0, name: 'AIR', transparent: true, noCollision: true });
reg.register({ id: 3, name: 'STONE' });
reg.register({ id: 5, name: 'WATER', transparent: true, liquid: true, noCollision: true });
const STONE = 3, WATER = 5;
const G = 10;   // mobs stand in cells at y = G: the ground's top block is G − 1

/** A world from height(x, z) → top block's y, and optional extras(x, y, z) → id | undefined. */
function world(height, extra = null) {
    return { getBlock(x, y, z) {
        const e = extra?.(x, y, z);
        if (e !== undefined) return e;
        return y <= height(x, z) ? STONE : 0;
    } };
}
const QUIDDLE = { id: 'quiddle', width: 0.6, height: 1.8, speed: 3, behavior: 'defensive', attackDamage: 4 };
const PIG     = { id: 'pig', width: 0.9, height: 0.9, speed: 3.5, grazes: true };
const COW     = { id: 'cow', width: 0.9, height: 1.4, speed: 3, grazes: true };
const FISH    = { id: 'fish', width: 0.4, height: 0.3, speed: 4, aquatic: true };

let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

function spawn(w, def, x, y, z) {
    const ai = new MobAI(w, reg);
    ai.rnd = rnd;
    const mob = ai.init({ pos: { x, y, z }, def });
    return { ai, mob };
}
const FAR = { player: { x: 1000, y: G, z: 1000 }, playerVisible: true };
/** Run the mob for `seconds`; returns the lowest it got and whether it ever stood in water. */
function run(ai, mob, seconds, ctx = FAR, each = null) {
    let minY = Infinity, wet = false;
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
        ai.beginFrame();
        ai.update(mob, dt, ctx);
        if (mob.pos.y < minY) minY = mob.pos.y;
        if (mob.inWater) wet = true;
        if (each?.(t) === false) break;
    }
    return { minY, wet };
}
/** Send the mob to (tx, tz) along a path and let it walk. */
function go(ai, mob, tx, ty, tz, seconds = 30) {
    const c = ai._cell(mob);
    mob.path = ai.nav.findPath(c.x, c.y, c.z, tx, ty, tz, mob.body);
    mob.pathI = 0; mob.state = 'WANDER'; mob.stateTimer = 999;
    const path = mob.path;
    const r = run(ai, mob, seconds, FAR, () => mob.state === 'WANDER');
    return { ...r, path, at: Math.hypot(mob.pos.x - (tx + 0.5), mob.pos.z - (tz + 0.5)) };
}

// ── Paths ────────────────────────────────────────────────────────────────────
{
    // A pit six deep across the direct line.
    const pit = (x, z) => x >= 5 && x <= 7 && z >= -3 && z <= 3;
    const w = world((x, z) => pit(x, z) ? G - 7 : G - 1);
    const nav = new MobNav(w, reg);
    const body = { clear: 2, maxDrop: 3, swims: false };
    const path = nav.findPath(0, G, 0, 12, G, 0, body);
    check('a path goes round a pit', !!path && path.reached && path.every(n => !pit(n.x, n.z) && n.y === G), `${path?.length} cells`);
    check('there is nowhere to stand in a pit deeper than the drop', nav.stand(6, 0, G, body) === NONE && nav.stand(4, 0, G, body) === G);

    const { ai, mob } = spawn(w, QUIDDLE, 0.5, G, 0.5);
    const r = go(ai, mob, 12, G, 0);
    check('a mob walks it and arrives without going down the pit', r.at < 1.95 && r.minY > G - 0.2, `ended ${r.at.toFixed(2)} away, lowest y ${r.minY.toFixed(2)}`);
}
{
    // A ledge one block up, then another: a staircase to climb.
    const w = world((x) => x >= 8 ? G + 1 : x >= 4 ? G : G - 1);
    const { ai, mob } = spawn(w, COW, 0.5, G, 0.5);
    const r = go(ai, mob, 11, G + 2, 0);
    check('a mob jumps up ledges one block high', r.at < 1.95 && Math.abs(mob.pos.y - (G + 2)) < 0.1, `at y ${mob.pos.y.toFixed(2)}, ${r.at.toFixed(2)} away`);

    // Two blocks up is a wall.
    const wall = world((x) => x >= 4 ? G + 1 : G - 1);
    const nav = new MobNav(wall, reg);
    const path = nav.findPath(0, G, 0, 8, G + 2, 0, { clear: 2, maxDrop: 3, swims: false });
    check('a two-block rise is not climbed', !path || !path.reached);
}
{
    // A cliff: the target is at the bottom of a drop of eight. A drop of two is fine.
    const cliff = world((x) => x >= 6 ? G - 9 : G - 1);
    const a = spawn(cliff, QUIDDLE, 0.5, G, 0.5);
    const r = go(a.ai, a.mob, 12, G - 8, 0, 12);
    check('a mob sent over a cliff stops at the edge', r.minY > G - 0.2 && a.mob.pos.x < 6, `x ${a.mob.pos.x.toFixed(2)}, lowest y ${r.minY.toFixed(2)}`);

    const step = world((x) => x >= 6 ? G - 3 : G - 1);
    const b = spawn(step, QUIDDLE, 0.5, G, 0.5);
    const r2 = go(b.ai, b.mob, 12, G - 2, 0, 12);
    check('… but takes a drop of two', r2.at < 1.95 && Math.abs(b.mob.pos.y - (G - 2)) < 0.1);
}
{
    // Even with no path at all — pushed straight at the edge — it will not step off.
    const cliff = world((x) => x >= 6 ? G - 9 : G - 1);
    const { ai, mob } = spawn(cliff, PIG, 3.5, G, 0.5);
    let minY = Infinity;
    for (let t = 0; t < 6; t += 1 / 60) {
        ai.beginFrame();
        mob.wantSpeed = 4; mob.vel.x = 4; mob.vel.z = 0;       // as if something drove it east regardless
        ai._physics(mob, 1 / 60);
        minY = Math.min(minY, mob.pos.y);
    }
    check('the edge guard holds without a path', minY > G - 0.2 && mob.pos.x < 6.2, `x ${mob.pos.x.toFixed(2)}`);
}
{
    // A pond three wide in the way, with dry land round it.
    const pond = (x, z) => x >= 4 && x <= 6 && z >= -4 && z <= 4;
    const w = world((x, z) => pond(x, z) ? G - 4 : G - 1, (x, y, z) => pond(x, z) && y > G - 4 && y <= G - 1 ? WATER : undefined);
    const nav = new MobNav(w, reg);
    const body = { clear: 2, maxDrop: 3, swims: false };
    const path = nav.findPath(0, G, 0, 10, G, 0, body);
    check('a path goes round water when it can', !!path && path.reached && path.every(n => !n.wet), `${path?.length} cells`);
    const { ai, mob } = spawn(w, COW, 0.5, G, 0.5);
    const r = go(ai, mob, 10, G, 0);
    check('… and the mob arrives dry', r.at < 1.95 && !r.wet, `${r.at.toFixed(2)} away, wet ${r.wet}`);

    // Dropped in the middle of it, it swims out.
    const s = spawn(w, COW, 5.5, G - 1.5, 0.5);
    run(s.ai, s.mob, 2);
    const out = go(s.ai, s.mob, 0, G, 0, 20);
    check('a mob in the water gets out', !s.mob.inWater && s.mob.pos.y > G - 0.2 && !pond(Math.floor(s.mob.pos.x), Math.floor(s.mob.pos.z)),
          `at ${s.mob.pos.x.toFixed(1)}, ${s.mob.pos.y.toFixed(1)}, ${s.mob.pos.z.toFixed(1)}`);
    check('… and floats rather than sinking', out.minY > G - 3.2, `lowest y ${out.minY.toFixed(2)}`);
}
{
    // A tunnel one block high through a wall: a pig fits, a person does not.
    const tunnel = (x, y, z) => x >= 4 && x <= 6 ? (y === G && z === 0 ? 0 : y <= G + 4 ? STONE : 0) : undefined;
    const w = world(() => G - 1, tunnel);
    const nav = new MobNav(w, reg);
    const low = nav.findPath(0, G, 0, 10, G, 0, { clear: 1, maxDrop: 3, swims: false }, 2000);
    const tall = nav.findPath(0, G, 0, 10, G, 0, { clear: 2, maxDrop: 3, swims: false }, 2000);
    check('headroom: a low mob takes the tunnel', !!low && low.reached && low.some(n => n.x === 5 && n.z === 0));
    check('headroom: a tall one cannot', !tall || !tall.reached || !tall.some(n => n.x === 5 && n.z === 0));
}
{
    // Two pillars corner to corner: no squeezing between them.
    const w = world(() => G - 1, (x, y, z) => ((x === 3 && z === 0) || (x === 4 && z === 1)) && y >= G && y <= G + 3 ? STONE : undefined);
    const nav = new MobNav(w, reg);
    // The straight diagonal from (1, 3) to (6, −2) runs through the gap between them.
    const path = nav.findPath(1, G, 3, 6, G, -2, { clear: 2, maxDrop: 3, swims: false });
    let cut = false, prev = { x: 1, z: 3 };
    for (const n of path ?? []) { if (prev.x === 3 && prev.z === 1 && n.x === 4 && n.z === 0) cut = true; prev = n; }
    check('no cutting the corner between two walls', !!path && path.reached && !cut, `${path?.length} cells`);
}

// ── Behaviour ────────────────────────────────────────────────────────────────
{
    // A plateau 13 × 13 with a sheer drop all round: wander on it for three minutes.
    const w = world((x, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 ? G - 1 : G - 12);
    let worst = Infinity, moved = 0;
    for (const def of [COW, PIG, QUIDDLE]) {
        const { ai, mob } = spawn(w, def, 0.5, G, 0.5);
        const from = { ...mob.pos };
        let far = 0;
        const r = run(ai, mob, 180, FAR, () => { far = Math.max(far, Math.hypot(mob.pos.x - from.x, mob.pos.z - from.z)); });
        worst = Math.min(worst, r.minY);
        moved += far;
    }
    check('wandering mobs never fall off a plateau', worst > G - 0.2, `lowest y ${worst.toFixed(2)}`);
    check('… and do wander', moved > 6, `${moved.toFixed(1)} blocks between them`);
}
{
    // Hurt beside a pit, a pig runs — away from the threat, and not into the pit behind it.
    const pit = (x, z) => x >= 3 && x <= 8 && z >= -2 && z <= 2;
    const w = world((x, z) => pit(x, z) ? G - 8 : G - 1);
    const { ai, mob } = spawn(w, PIG, 1.5, G, 0.5);
    run(ai, mob, 0.5);
    const threat = { x: -1.5, y: G, z: 0.5 };
    ai.hurt(mob, threat);
    const r = run(ai, mob, 6, { player: threat, playerVisible: true });
    const away = Math.hypot(mob.pos.x - threat.x, mob.pos.z - threat.z);
    check('a hurt animal flees', mob.panic || away > 8, `${away.toFixed(1)} blocks away`);
    check('… round the pit, not into it', r.minY > G - 0.2 && away > 6, `lowest y ${r.minY.toFixed(2)}`);
}
{
    // A person who is hit comes after the player, round a wall, and lands a blow.
    const w = world(() => G - 1, (x, y, z) => x === 5 && z >= -3 && z <= 3 && y >= G && y <= G + 2 ? STONE : undefined);
    const { ai, mob } = spawn(w, QUIDDLE, 1.5, G, 0.5);
    const player = { x: 9.5, y: G, z: 0.5 };
    let hits = 0;
    const ctx = { player, playerVisible: true, onAttack: () => { hits++; } };
    ai.hurt(mob, player);
    run(ai, mob, 9, ctx);
    check('a defensive mob paths to the player and strikes', hits >= 1 && Math.hypot(mob.pos.x - player.x, mob.pos.z - player.z) < 2.6,
          `${hits} hits, ${Math.hypot(mob.pos.x - player.x, mob.pos.z - player.z).toFixed(1)} away`);
    const before = hits;
    run(ai, mob, 12, ctx);
    check('… and stops in time', mob.state !== 'ATTACK' && hits - before < 12, `state ${mob.state}`);
}
{
    // A pool: the fish swims about in it for two minutes and stays in.
    const pool = (x, z) => Math.abs(x) <= 5 && Math.abs(z) <= 5;
    const w = world((x, z) => pool(x, z) ? G - 6 : G - 1, (x, y, z) => pool(x, z) && y > G - 6 && y <= G - 1 ? WATER : undefined);
    const { ai, mob } = spawn(w, FISH, 0.5, G - 3, 0.5);
    let maxY = -Infinity, dry = 0, far = 0;
    run(ai, mob, 120, FAR, () => {
        maxY = Math.max(maxY, mob.pos.y);
        if (!mob.inWater) dry++;
        far = Math.max(far, Math.hypot(mob.pos.x - 0.5, mob.pos.z - 0.5));
    });
    check('a fish stays in the water, under the surface', dry === 0 && maxY < G - 0.3, `highest y ${maxY.toFixed(2)}, ${dry} frames out`);
    check('… and swims about', far > 2, `${far.toFixed(1)} blocks`);
}

// ── Models: the definitions the renderer and the texture tool share ──────────
{
    let ok = true, why = '';
    const fail = (msg) => { if (ok) { ok = false; why = msg; } };
    for (const [name, m] of Object.entries(MODELS)) {
        // No two patches share texels, each has a clear texel all round it, and none leaves the atlas.
        const W = m.atlas.width, H = m.atlas.height, used = new Int32Array(W * H);
        let id = 0;
        for (const sh of m.shapes) for (const f of sh.patches) {
            id++;
            for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
                const x = f.x + i, y = f.y + j;
                if (x >= W || y >= H) fail(`${name}: a patch leaves the atlas`);
                else if (used[y * W + x]) fail(`${name}: two patches share a texel`);
                else used[y * W + x] = id;
            }
        }
        for (let y = 0; y < H && ok; y++) for (let x = 0; x < W; x++) {
            const u = used[y * W + x];
            if (!u) continue;
            for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
                const v = used[(y + dy) * W + x + dx];
                if (x + dx < W && y + dy >= 0 && y + dy < H && v && v !== u) fail(`${name}: two patches touch`);
            }
        }
        // Parents come before children, and at rest no bone moves anything.
        m.parts.forEach((p, i) => { if (p.parent >= i) fail(`${name}: ${p.name} comes before its parent`); });
        const pose = makePose(m), mats = new Float32Array(m.parts.length * 12);
        resetPose(pose);
        poseMatrices(m, pose, mats);
        m.parts.forEach((p, i) => {
            const id12 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
            if (mats.subarray(i * 12, i * 12 + 12).some((v, k) => Math.abs(v - id12[k]) > 1e-6)) fail(`${name}: ${p.name} moves in the rest pose`);
        });
        if (m.layers(Object.fromEntries(Object.keys(m.variants).map(k => [k, 0]))).length === 0) fail(`${name}: no texture layers`);
    }
    check('model definitions: patches keep clear of one another, bones are ordered, the rest pose is at rest', ok, why);
}

{
    // The geometry: whole numbers, triangles facing out, every vertex on one bone or shared between
    // two — and standing exactly where the painter is told its texel is.
    let ok = true, why = '', verts = 0, shared = 0;
    const fail = (msg) => { if (ok) { ok = false; why = msg; } };
    const pt = [];
    for (const [name, m] of Object.entries(MODELS)) {
        for (const sh of m.shapes) {
            const g = shapeMesh(m, sh), n = g.pos.length / 3;
            verts += n;
            if (![...g.pos, ...g.nrm, ...g.uv].every(Number.isFinite)) { fail(`${name}/${sh.tag}: not a number`); continue; }
            for (let v = 0; v < n; v++) {
                if (Math.abs(Math.hypot(g.nrm[v * 3], g.nrm[v * 3 + 1], g.nrm[v * 3 + 2]) - 1) > 1e-3) fail(`${name}/${sh.tag}: a normal is not of length 1`);
                const a = g.ba[v], b = g.bb[v], w = g.bw[v];
                if (!(a >= 0 && a < m.parts.length) || (w > 0 && !(b >= 0 && b < m.parts.length && b !== a)) || w < 0 || w > 0.5 + 1e-6) fail(`${name}/${sh.tag}: a vertex follows no bone, or more than its share`);
                if (w > 0) shared++;
                // Its texel is in one of its shape's patches, and that texel is this place.
                const u = g.uv[v * 2], t = g.uv[v * 2 + 1];
                const patch = sh.patches.filter(f => u >= f.x - 1e-6 && u <= f.x + f.w + 1e-6 && t >= f.y - 1e-6 && t <= f.y + f.h + 1e-6);
                if (patch.length === 0) { fail(`${name}/${sh.tag}: a vertex has texels outside its patches`); continue; }
                const near = Math.min(...patch.map((f) => {
                    surfacePoint(m, sh, f, (u - f.x) / f.w, (t - f.y) / f.h, pt);
                    return Math.hypot(pt[0] - g.pos[v * 3], pt[1] - g.pos[v * 3 + 1], pt[2] - g.pos[v * 3 + 2]);
                }));
                if (near > 1e-4) fail(`${name}/${sh.tag}: a vertex is ${near.toFixed(4)} px from where its texel is painted`);
            }
            let inward = 0, faces = 0;
            for (let i = 0; i < g.idx.length; i += 3) {
                const [a, b, c] = [g.idx[i], g.idx[i + 1], g.idx[i + 2]];
                if (Math.max(a, b, c) >= n) { fail(`${name}/${sh.tag}: an index past the last vertex`); break; }
                const e1 = [0, 1, 2].map(k => g.pos[b * 3 + k] - g.pos[a * 3 + k]), e2 = [0, 1, 2].map(k => g.pos[c * 3 + k] - g.pos[a * 3 + k]);
                const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                if (Math.hypot(...fn) < 1e-7) continue;
                const vn = [0, 1, 2].map(k => g.nrm[a * 3 + k] + g.nrm[b * 3 + k] + g.nrm[c * 3 + k]);
                faces++;
                if (fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2] <= 0) inward++;
            }
            if (inward > 0) fail(`${name}/${sh.tag}: ${inward} of ${faces} triangles face inward`);
        }
    }
    check('model geometry: finite, facing out, every vertex on its bones and where its texel is painted', ok, why || `${verts} vertices, ${shared} of them shared between two bones`);
}

{
    // Animation. Any state poses without a NaN. And through a stride, at a walk and at a run, a
    // foot that is down stays down and goes back under the body at exactly the pace the mob goes
    // forward — it does not slide — while every foot takes its turn off the ground.
    let ok = true, why = '', worst = 0;
    const fail = (msg) => { if (ok) { ok = false; why = msg; } };
    for (const [name, m] of Object.entries(MODELS)) {
        const pose = makePose(m), mats = new Float32Array(m.parts.length * 12);
        const a = makeAnimState(0.4);
        Object.assign(a, { move: 1, run: 0.6, phase: 2, air: 0.5, graze: 0.5, attack: 0.4, panic: 1, hurt: 1, swim: 0.5, lookYaw: 0.5, lookPitch: -0.3 });
        resetPose(pose);
        ANIMATORS[name](pose, a);
        poseMatrices(m, pose, mats);
        if (!mats.every(Number.isFinite)) fail(`${name}: the animator produced a NaN`);

        const feet = (FEET[name] ?? []).map(n => m.index[n]);
        if (feet.length === 0) continue;
        // What each foot is made of: every vertex that follows its bone alone.
        const soles = feet.map(() => []);
        for (const sh of m.shapes) {
            const g = shapeMesh(m, sh);
            for (let v = 0; v < g.ba.length; v++) {
                const k = feet.indexOf(g.ba[v]);
                if (k >= 0 && g.bw[v] === 0) soles[k].push(g.pos[v * 3], g.pos[v * 3 + 1], g.pos[v * 3 + 2]);
            }
        }
        if (!(GAITS[name]?.walk > 0 && GAITS[name]?.run > GAITS[name]?.walk)) fail(`${name}: no gait`);
        const STEPS = 96;
        for (const run of [0, 1]) {
            const stride = (run ? GAITS[name].run : GAITS[name].walk) * 16;       // px
            const down = feet.map(() => 0), prev = feet.map(() => null), was = feet.map(() => 9);
            let fewest = feet.length;
            for (let i = 0; i <= STEPS; i++) {
                const s = makeAnimState(0.4);
                Object.assign(s, { time: 0, phase: i / STEPS * Math.PI * 2, move: 1, run });
                resetPose(pose);
                ANIMATORS[name](pose, s);
                poseMatrices(m, pose, mats);
                let standing = 0;
                feet.forEach((f, k) => {
                    const p = m.parts[f].pivot, o = f * 12;
                    const y = mats[o + 4] * p[0] + mats[o + 5] * p[1] + mats[o + 6] * p[2] + mats[o + 7] - p[1];
                    const z = mats[o + 8] * p[0] + mats[o + 9] * p[1] + mats[o + 10] * p[2] + mats[o + 11];
                    // The lowest point of the foot itself: on the ground, or clear of it, but not far into it.
                    let low = Infinity;
                    for (let v = 0; v < soles[k].length; v += 3) low = Math.min(low, mats[o + 4] * soles[k][v] + mats[o + 5] * soles[k][v + 1] + mats[o + 6] * soles[k][v + 2] + mats[o + 7]);
                    if (low < -0.6) fail(`${name}: a foot goes ${(-low).toFixed(2)} px into the ground`);
                    if (low < 0.2) standing++;
                    // Planted: its joint at the height it stands at, and no longer coming down onto it.
                    const on = y < 0.02 && Math.abs(y - was[k]) < 0.004;
                    was[k] = y;
                    if (on) {
                        down[k]++;
                        if (prev[k] !== null) {
                            const slip = Math.abs(z - prev[k] + stride / STEPS);
                            worst = Math.max(worst, slip);
                            if (slip > 0.02) fail(`${name}: a foot on the ground slides ${slip.toFixed(3)} px in a step`);
                        }
                    }
                    prev[k] = on ? z : null;
                });
                if (i > 0) fewest = Math.min(fewest, standing);
            }
            down.forEach((d, k) => { if (d < STEPS * 0.15 || d > STEPS * 0.8) fail(`${name}: foot ${FEET[name][k]} is planted for ${d} of ${STEPS} steps of a ${run ? 'run' : 'walk'}`); });
            // At a walk something is always on the ground: two feet of four, one of two.
            if (!run && fewest < feet.length / 2) fail(`${name}: only ${fewest} feet down at one point of its walk`);
        }
    }
    check('animation: poses are finite; a foot on the ground stays put, at a walk and at a run', ok, why || `worst slip ${worst.toFixed(4)} px`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
