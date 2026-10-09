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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
