// PlayerPhysics on a slow machine: a long frame must play by the same rules as
// a short one. Collision tests where a move ends, not the way there. So at ten
// frames a second, when a long fall covers five blocks a frame, the player
// stopped dead four blocks above the floor (the move that would have ended in
// it was refused whole), took the fall's damage up there, and then fell the
// rest — or, from another height, ended beyond a floor one block thick without
// touching it. A frame that would move further than the player is thick is now
// taken in steps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { ChunkData, CHUNK_SIZE, WORLD_MIN_Y } from '../src/scripts/engine/ChunkData.js';
import { WorldState }    from '../src/scripts/engine/WorldState.js';
import { PlayerPhysics } from '../src/scripts/engine/PlayerPhysics.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
}

const reg = new BlockRegistry();
for (const f of fs.readdirSync(path.join(root, 'data/blocks')))
    reg.register(JSON.parse(fs.readFileSync(path.join(root, 'data/blocks', f), 'utf8')));
const STONE = reg.getByName('STONE').id;

// A floor one block thick at world y 64 with nothing under it, and a wall one
// block thick across x = 20, over 3 × 3 chunks.
const FLOOR = 64;
const world = new WorldState();
for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) {
    const c = new ChunkData(cx, cz);
    for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        c.setVoxel(lx, FLOOR - WORLD_MIN_Y, lz, STONE);
        if (cx * CHUNK_SIZE + lx === 20) for (let y = FLOOR + 1; y <= FLOOR + 12; y++) c.setVoxel(lx, y - WORLD_MIN_Y, lz, STONE);
    }
    c.generated = true;
    world.setChunk(cx, cz, c);
}

const still = { forward: false, backward: false, left: false, right: false, jump: false, sneak: false, sprint: false,
                moveF: 0, moveR: 0, fwd: { x: 1, z: 0 }, rightDir: { x: 0, z: -1 } };

// ── A long fall onto the floor, at every frame rate ──────────────────────────
console.log('--- a fall of 120 blocks onto a floor one block thick ---');
const landings = [];
for (const fps of [144, 60, 30, 20, 10]) {
    const phys = new PlayerPhysics(world, reg);
    const pos = { x: 4.5, y: FLOOR + 1 + 120, z: 4.5 };
    let damage = 0, frames = 0;
    while (frames++ < 20 * fps && !phys.onGround && pos.y > FLOOR - 30) {
        damage += phys.update(pos, still, 1 / fps, 'SURVIVAL', {}).fallDamage;
    }
    landings.push({ fps, damage });
    check(`${fps} frames a second: lands on the floor`, phys.onGround && Math.abs(pos.y - (FLOOR + 1)) < 0.6,
        `feet at y ${pos.y.toFixed(2)}, ${damage.toFixed(1)} damage`);
}
{
    const d = landings.map(l => l.damage), lo = Math.min(...d), hi = Math.max(...d);
    check('the fall hurts the same at every frame rate', lo > 0 && hi - lo < 0.06 * hi, `${lo.toFixed(1)} … ${hi.toFixed(1)}`);
}

// ── Flying into a wall ───────────────────────────────────────────────────────
console.log('--- flying at a wall one block thick ---');
for (const fps of [60, 20, 10]) {
    const phys = new PlayerPhysics(world, reg);
    phys.flying = true;
    const pos = { x: 4.5, y: FLOOR + 3, z: 4.5 };
    for (let i = 0; i < 4 * fps; i++) phys.update(pos, { ...still, forward: true }, 1 / fps, 'CREATIVE', {});
    check(`${fps} frames a second: stops at the wall`, pos.x < 20, `x ${pos.x.toFixed(2)} (the wall is at 20)`);
}

// ── Ordinary frames are one step, exactly as before ──────────────────────────
console.log('--- an ordinary frame ---');
{
    const a = new PlayerPhysics(world, reg), b = new PlayerPhysics(world, reg);
    const pa = { x: 4.5, y: FLOOR + 1, z: 4.5 }, pb = { ...pa };
    const walk = { ...still, forward: true };
    let same = true;
    for (let i = 0; i < 240; i++) {
        const input = i === 60 ? { ...walk, jump: true } : walk;
        a.update(pa, input, 1 / 60, 'SURVIVAL', {});
        b._groundUpdate(pb, input, 1 / 60, false, true, {});      // one step, as update() used to be
        if (pa.x !== pb.x || pa.y !== pb.y || pa.z !== pb.z) same = false;
    }
    check('walking and jumping at 60 frames a second is what one step gives', same, `x ${pa.x.toFixed(3)} / ${pb.x.toFixed(3)}`);
    check('… and it got somewhere', pa.x > 10 && pa.x < 20);
}

// ── Contact: a blocked move goes as far as it can ────────────────────────────
// It used to be refused whole: the player stopped a frame's travel short of a
// wall and crept up on it, and landed in the air above the ground.
console.log('--- coming to rest against things ---');
for (const fps of [144, 60, 30]) {
    const phys = new PlayerPhysics(world, reg), pos = { x: 17.5, y: FLOOR + 1, z: 4.5 };
    const walk = { ...still, forward: true, sprint: true };
    let touchedAt = -1, crept = 0, flicker = 0;
    for (let i = 0; i < 3 * fps; i++) {
        const before = pos.x;
        phys.update(pos, walk, 1 / fps, 'SURVIVAL', {});
        if (touchedAt < 0 && phys.vel.x === 0 && i > 5) touchedAt = i;
        else if (touchedAt >= 0) crept = Math.max(crept, Math.abs(pos.x - before));
        if (i > 5 && !phys.onGround) flicker++;
    }
    check(`${fps} frames a second: walks up to the wall and touches it`, Math.abs(pos.x - 19.7) < 0.002, `x ${pos.x.toFixed(4)} (touching is 19.7)`);
    check('… at once, with no creeping up on it after', crept < 0.001, `moved ${crept.toFixed(4)} after first contact`);
    check('… on the ground the whole way', flicker === 0, `${flicker} frames in the air`);
}
{
    // A short drop: the feet end on the floor in the frame they reach it.
    const phys = new PlayerPhysics(world, reg), pos = { x: 4.5, y: FLOOR + 1 + 0.83, z: 4.5 };
    let landed = -1, after = 0;
    for (let i = 0; i < 120; i++) {
        phys.update(pos, still, 1 / 60, 'SURVIVAL', {});
        if (landed < 0 && phys.onGround) { landed = i; check('a drop ends on the floor, not above it', Math.abs(pos.y - (FLOOR + 1)) < 0.001, `y ${pos.y.toFixed(4)}`); }
        else if (landed >= 0 && !phys.onGround) after++;
    }
    check('… and stays landed', landed >= 0 && after === 0, `${after} frames in the air after landing`);
}
{
    // Up into a ceiling: the head reaches it. (A ceiling two blocks over the floor's top… one is put there.)
    const c = world.getChunk(0, 0);
    for (let lx = 2; lx <= 6; lx++) for (let lz = 8; lz <= 12; lz++) c.setVoxel(lx, FLOOR + 3 - WORLD_MIN_Y + 0, lz, STONE);   // underside at FLOOR + 3: 2 clear blocks
    const phys = new PlayerPhysics(world, reg), pos = { x: 4.5, y: FLOOR + 1, z: 10.5 };
    let top = 0;
    for (let i = 0; i < 60; i++) { phys.update(pos, { ...still, jump: i < 3 }, 1 / 60, 'SURVIVAL', {}); top = Math.max(top, pos.y); }
    check('a jump under a low roof goes up to the roof', Math.abs(top - (FLOOR + 3 - 1.8)) < 0.002, `feet reached ${top.toFixed(4)} (the roof allows ${(FLOOR + 3 - 1.8).toFixed(1)})`);
}

// ── Jumping: the two allowances ──────────────────────────────────────────────
console.log('--- jumping ---');
{
    // Off the edge of the slab put up above (its top is at FLOOR + 4, its edge at x = 7): a jump a twentieth of a second late still goes.
    const run = (late) => {
        const phys = new PlayerPhysics(world, reg), pos = { x: 5.5, y: FLOOR + 4, z: 10.5 };
        const walk = { ...still, forward: true };
        let off = -1, top = pos.y;
        for (let i = 0; i < 180; i++) {
            const jump = off >= 0 && i - off === late;
            phys.update(pos, { ...walk, jump }, 1 / 60, 'SURVIVAL', {});
            if (off < 0 && i > 5 && !phys.onGround) off = i;
            top = Math.max(top, pos.y);
        }
        return top - (FLOOR + 4);
    };
    check('a jump just after walking off an edge still jumps', run(3) > 1.2, `rose ${run(3).toFixed(2)} blocks`);
    check('… but not long after', run(12) < 0.1, `rose ${run(12).toFixed(2)} blocks`);
}
{
    // A jump pressed for one frame just before landing is made on landing.
    const run = (early) => {
        const phys = new PlayerPhysics(world, reg), pos = { x: 4.5, y: FLOOR + 1 + 1.2, z: 4.5 };
        let frames = 0;
        const probe = new PlayerPhysics(world, reg), pp = { ...pos };
        while (!probe.onGround) { probe.update(pp, still, 1 / 60, 'SURVIVAL', {}); frames++; }      // when it lands
        let top = 0, landed = false;
        for (let i = 0; i < 120; i++) {
            phys.update(pos, { ...still, jump: i === frames - 1 - early }, 1 / 60, 'SURVIVAL', {});
            if (phys.onGround) landed = true;
            if (landed || i >= frames) top = Math.max(top, pos.y - (FLOOR + 1));
        }
        return top;
    };
    check('a jump pressed just before landing is made on landing', run(4) > 1.2, `rose ${run(4).toFixed(2)} blocks`);
    check('… but one pressed well before is forgotten', run(20) < 0.1, `rose ${run(20).toFixed(2)} blocks`);
    const phys = new PlayerPhysics(world, reg), pos = { x: 4.5, y: FLOOR + 1, z: 4.5 };
    let top = 0;
    for (let i = 0; i < 90; i++) { phys.update(pos, { ...still, jump: i === 10 }, 1 / 60, 'SURVIVAL', {}); top = Math.max(top, pos.y - (FLOOR + 1)); }
    check('a jump is as high as it was', Math.abs(top - 1.7) < 0.12, `${top.toFixed(2)} blocks`);
}

// ── Crouching ────────────────────────────────────────────────────────────────
console.log('--- crouching ---');
{
    // On the slab put up above (its top at FLOOR + 4, x 2 … 6): toward its edge at x = 7.
    const walkOff = (sneak) => {
        const phys = new PlayerPhysics(world, reg), pos = { x: 4.5, y: FLOOR + 4, z: 10.5 };
        for (let i = 0; i < 300; i++) phys.update(pos, { ...still, forward: true, sneak }, 1 / 60, 'SURVIVAL', {});
        return { pos, phys };
    };
    const a = walkOff(true), b = walkOff(false);
    check('crouching, the player does not walk off an edge', Math.abs(a.pos.y - (FLOOR + 4)) < 0.001 && a.phys.onGround, `x ${a.pos.x.toFixed(2)}, y ${a.pos.y.toFixed(2)}`);
    check('… but goes out to it: the feet still on, the body over the drop', a.pos.x > 7 && a.pos.x < 7.31, `x ${a.pos.x.toFixed(3)} (the edge is at 7)`);
    check('… and standing, does', b.pos.y < FLOOR + 2, `y ${b.pos.y.toFixed(2)}`);
    const speed = (sneak) => {
        const phys = new PlayerPhysics(world, reg), pos = { x: 2.5, y: FLOOR + 1, z: 4.5 };
        for (let i = 0; i < 120; i++) phys.update(pos, { ...still, forward: true, sneak, sprint: true }, 1 / 60, 'SURVIVAL', {});
        return Math.hypot(phys.vel.x, phys.vel.z);
    };
    check('crouching is slow, sprint key or not', speed(true) < 2 && speed(false) > 7, `${speed(true).toFixed(1)} against ${speed(false).toFixed(1)} blocks a second`);
    const phys = new PlayerPhysics(world, reg), pos = { x: 4.5, y: FLOOR + 1, z: 4.5 };
    let top = 0;
    for (let i = 0; i < 90; i++) { phys.update(pos, { ...still, sneak: true, jump: i === 10 }, 1 / 60, 'SURVIVAL', {}); top = Math.max(top, pos.y - (FLOOR + 1)); }
    check('a crouching player can still jump', top > 1.2, `${top.toFixed(2)} blocks`);
}

// ── Ice ──────────────────────────────────────────────────────────────────────
console.log('--- ice ---');
{
    check('ice says it is slippery', reg.getByName('ICE').slippery > 0.5 && reg.getByName('PACKED_ICE').slippery > 0.5 && reg.getByName('STONE').slippery === 0);
    const slide = (slip) => {
        const phys = new PlayerPhysics(world, reg), pos = { x: 2.5, y: FLOOR + 1, z: 4.5 };
        phys.slip = slip;
        for (let i = 0; i < 90; i++) phys.update(pos, { ...still, forward: true }, 1 / 60, 'SURVIVAL', {});
        const from = pos.x;
        for (let i = 0; i < 240; i++) phys.update(pos, still, 1 / 60, 'SURVIVAL', {});
        return pos.x - from;
    };
    const ground = slide(0), ice = slide(reg.getByName('ICE').slippery);
    check('letting go on ice, the player slides on', ice > 1.2 && ice > ground * 3, `${ice.toFixed(2)} blocks on ice, ${ground.toFixed(2)} on stone`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
