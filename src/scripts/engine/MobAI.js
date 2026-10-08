/**
 * MobAI — what a mob decides to do, and how its body then moves.
 *
 * Deciding (`_think`): a mob is IDLE (standing, looking about, grazing),
 * WANDERing to somewhere nearby, FLEEing from whoever hurt it, or — for a mob
 * that fights back — ATTACKing them. Wherever it goes it goes along a path
 * from MobNav, so it walks round walls, pits and ponds, jumps up a block where
 * it has to and takes a drop only when the drop is one it would choose.
 *
 * Moving (`_physics`): gravity, collision with the world (the rendered shape
 * in smooth worlds, as for the player), stepping up slopes and staying on
 * them going down, floating in water. One rule sits under all of it: a mob on
 * the ground never walks off an edge deeper than it would drop on purpose. A
 * path already avoids such edges; this is what holds when something else —
 * a block removed under its route, a path gone stale — would walk it into a
 * pit anyway.
 *
 * Fish are the other kind of body: they swim, steer in three dimensions, stay
 * under the surface, and flop when stranded.
 *
 * No Three.js and no DOM: test/mobai.test.mjs runs mobs through worlds made
 * of plain arrays.
 */

import { MobNav, NONE } from './MobNav.js';

export const MOB_GRAVITY = -18;                  // m/s²
const TERMINAL    = -30;
const JUMP_HEIGHT = 1.3;                         // blocks: one block, with room to spare
export const MOB_JUMP_VEL = Math.sqrt(2 * -MOB_GRAVITY * JUMP_HEIGHT);
const STEP_HEIGHT = 0.6;                         // smooth worlds: climb onto a slope
const SNAP_DOWN   = 0.6;                         // … and stay on one going down
export const WALK = 0.5, RUN = 1.25;             // of the mob's `speed`
const TURN_RATE = 9;                             // rad/s the body turns toward where it is going
const ACCEL = 10;                                // 1/s: how quickly it reaches the speed it wants
const SEARCHES_PER_FRAME = 2;                    // path searches, across all mobs
const LOOK_RANGE = 8;                            // blocks: notices the player this close
const MELEE_RANGE = 1.9;

const MOVING = 0, ARRIVED = 1, STUCK = 2;

export class MobAI {
    /**
     * @param {{ getBlock(x, y, z): number }} world
     * @param {BlockRegistry} blockRegistry
     */
    constructor(world, blockRegistry) {
        this.world = world;
        this.reg = blockRegistry;
        this.nav = new MobNav(world, blockRegistry);
        this.smooth = null;          // SmoothTerrain collider in smooth worlds
        this.rnd = Math.random;
        this._budget = SEARCHES_PER_FRAME;
    }

    /** Give `mob` ({ pos, def }) everything this module keeps on it. */
    init(mob) {
        const def = mob.def;
        mob.vel = { x: 0, y: 0, z: 0 };
        mob.onGround = false;
        mob.inWater = false;
        mob.yaw = this.rnd() * Math.PI * 2;      // the way it faces: +Z turned by yaw about Y
        mob.state = 'IDLE';
        mob.stateTimer = 0.5 + this.rnd() * 3;
        mob.path = null; mob.pathI = 0; mob.repath = 0;
        mob.stuck = 0; mob.progT = 0; mob.progX = mob.pos.x; mob.progZ = mob.pos.z;
        mob.blocked = false; mob.blockedT = 0;
        mob.grazing = false;
        mob.look = null;             // { x, y, z } it is looking at, or null
        mob.threat = null;           // where the danger was
        mob.attackT = 0;             // seconds until it may strike again
        mob.swing = 0;               // 0 = not striking, else 0 → 1 through the blow
        mob.hitPending = false;
        mob.panic = false;
        mob.swimTarget = null;
        mob.fleeTry = 6;             // _goFlee: which direction it tried last
        mob.body = {
            clear: Math.max(1, Math.ceil((def.height ?? 1.4) - 0.1)),
            maxDrop: def.maxDrop ?? 3,
            swims: !!def.aquatic,
        };
        return mob;
    }

    /** Once per frame, before the mobs are updated. */
    beginFrame() { this._budget = SEARCHES_PER_FRAME; }

    /**
     * @param {object} ctx  { player: {x, y, z} feet position, playerVisible: boolean,
     *                        onAttack(damage) — a mob's blow landed }
     */
    update(mob, dt, ctx) {
        if (!this._loaded(mob)) return;          // its chunk is gone: wait where it is
        this._think(mob, dt, ctx);
        this._physics(mob, dt);
    }

    /** Something at `from` hurt the mob. */
    hurt(mob, from) {
        mob.threat = { x: from.x, y: from.y, z: from.z };
        mob.grazing = false;
        mob.path = null;
        if ((mob.def.behavior ?? 'passive') === 'defensive') {
            mob.state = 'ATTACK'; mob.stateTimer = 10; mob.attackT = Math.min(mob.attackT, 0.3);
        } else {
            mob.state = 'FLEE'; mob.stateTimer = 6;
        }
        mob.repath = 0;
    }

    _loaded(mob) {
        const w = this.world;
        if (typeof w.getChunk !== 'function') return true;
        return !!w.getChunk(Math.floor(mob.pos.x) >> 4, Math.floor(mob.pos.z) >> 4)?.generated;
    }

    // ── Deciding ──────────────────────────────────────────────────────────────

    _think(mob, dt, ctx) {
        const def = mob.def, rnd = this.rnd;
        mob.stateTimer -= dt; mob.repath -= dt; mob.attackT -= dt;
        if (mob.swing > 0) {
            mob.swing += dt / 0.45;
            if (mob.hitPending && mob.swing >= 0.5) {
                mob.hitPending = false;
                const p = ctx.player;
                if (ctx.playerVisible && Math.hypot(p.x - mob.pos.x, p.z - mob.pos.z) < MELEE_RANGE + 0.5 &&
                    Math.abs(p.y - mob.pos.y) < 2) ctx.onAttack?.(def.attackDamage ?? 4);
            }
            if (mob.swing >= 1) mob.swing = 0;
        }
        if (mob.body.swims) return this._thinkFish(mob, dt, ctx);

        const p = ctx.player;
        const pdx = p.x - mob.pos.x, pdz = p.z - mob.pos.z;
        const pdist = Math.hypot(pdx, pdz);
        const sees = ctx.playerVisible && pdist < LOOK_RANGE && Math.abs(p.y - mob.pos.y) < 5;
        mob.look = sees ? p : null;
        mob.panic = false;

        switch (mob.state) {
            case 'IDLE':
                this._drive(mob, 0, 0, 0, dt);
                if (mob.grazing) mob.look = null;
                // People turn to face whoever comes up to them.
                if (sees && def.behavior === 'defensive' && pdist < 5) this._face(mob, pdx, pdz, dt * 0.5);
                if (mob.stateTimer <= 0) {
                    if (def.grazes && !mob.grazing && rnd() < 0.4) {
                        mob.grazing = true;
                        mob.stateTimer = 2.5 + rnd() * 4;
                    } else {
                        mob.grazing = false;
                        if (this._goWander(mob)) { mob.state = 'WANDER'; mob.stateTimer = 14; }
                        else mob.stateTimer = 0.6 + rnd() * 1.5;
                    }
                }
                break;

            case 'WANDER':
                if (this._follow(mob, (def.speed ?? 3) * WALK, dt) !== MOVING || mob.stateTimer <= 0) this._idle(mob, 2 + rnd() * 5);
                break;

            case 'FLEE':
                mob.panic = true;
                mob.look = null;
                if (mob.stateTimer <= 0) { this._idle(mob, 1 + rnd() * 2); break; }
                if (!mob.path || mob.repath <= 0) {
                    if (this._goFlee(mob, mob.threat ?? p)) mob.repath = 1.5;
                }
                if (mob.path) { if (this._follow(mob, (def.speed ?? 3) * RUN, dt) !== MOVING) mob.path = null; }
                else this._drive(mob, 0, 0, 0, dt);
                break;

            case 'ATTACK': {
                if (mob.stateTimer <= 0 || !ctx.playerVisible) { this._idle(mob, 1.5); break; }
                mob.look = p;
                if (pdist < MELEE_RANGE && Math.abs(p.y - mob.pos.y) < 1.6) {
                    this._drive(mob, 0, 0, 0, dt);
                    this._face(mob, pdx, pdz, dt);
                    mob.path = null;
                    if (mob.attackT <= 0 && mob.swing === 0) { mob.attackT = 1.2; mob.swing = 0.001; mob.hitPending = true; }
                    break;
                }
                const goal = mob.pathGoal;
                if (!mob.path || mob.repath <= 0 || (goal && Math.hypot(goal.x - p.x, goal.z - p.z) > 1.5)) {
                    const path = this._path(mob, p.x, p.y, p.z);
                    if (path !== undefined) {
                        mob.path = path; mob.pathI = 0; mob.repath = 0.7;
                        mob.pathGoal = { x: p.x, z: p.z };
                    }
                }
                if (mob.path) { if (this._follow(mob, (def.speed ?? 3) * RUN * 0.92, dt) !== MOVING) mob.path = null; }
                else { this._drive(mob, 0, 0, 0, dt); this._face(mob, pdx, pdz, dt); }
                break;
            }
        }
    }

    _idle(mob, seconds) {
        mob.state = 'IDLE';
        mob.stateTimer = seconds;
        mob.path = null;
        mob.grazing = false;
    }

    /** The cell the mob stands in. On a smooth slope its feet are part-way up a block: that block is its floor. */
    _cell(mob) {
        return { x: Math.floor(mob.pos.x), y: Math.ceil(mob.pos.y - 0.01), z: Math.floor(mob.pos.z) };
    }

    /**
     * A path from where the mob is to (tx, ty, tz): the path, null if there is
     * none, or undefined if this frame's searches are used up (ask again).
     */
    _path(mob, tx, ty, tz) {
        if (this._budget <= 0) return undefined;
        this._budget--;
        const c = this._cell(mob);
        mob.stuck = 0; mob.progT = 0; mob.progX = mob.pos.x; mob.progZ = mob.pos.z;
        return this.nav.findPath(c.x, c.y, c.z, tx, Math.ceil(ty - 0.01), tz, mob.body);
    }

    /** Somewhere dry, a short walk away. */
    _goWander(mob) {
        const c = this._cell(mob), rnd = this.rnd;
        for (let tries = 0; tries < 3; tries++) {
            const a = rnd() * Math.PI * 2, r = 4 + rnd() * 7;
            const tx = Math.floor(mob.pos.x + Math.cos(a) * r), tz = Math.floor(mob.pos.z + Math.sin(a) * r);
            // A quick look first: is there ground there at all, about this height?
            let ty = NONE;
            for (const y of [c.y, c.y + 2, c.y - 2]) { ty = this.nav.stand(tx, tz, y, mob.body); if (ty !== NONE) break; }
            if (ty === NONE || this.nav.wet) continue;
            const path = this._path(mob, tx, ty, tz);
            if (path === undefined) return false;
            if (path && path.length >= 2 && !path[path.length - 1].wet) { mob.path = path; mob.pathI = 0; return true; }
        }
        return false;
    }

    /**
     * Away from `threat`: the first direction, starting with more or less
     * straight away, that leads somewhere farther off. Searches are rationed
     * per frame, so it carries on down the list from where it stopped.
     */
    _goFlee(mob, threat) {
        const c = this._cell(mob);
        const away = Math.atan2(mob.pos.z - threat.z, mob.pos.x - threat.x);
        const now = Math.hypot(mob.pos.x - threat.x, mob.pos.z - threat.z);
        const spread = [0, 0.7, -0.7, 1.4, -1.4, 2.2, -2.2];
        for (let n = 0; n < spread.length; n++) {
            const i = (mob.fleeTry = ((mob.fleeTry ?? 0) + 1) % spread.length);
            const a = away + spread[i];
            const tx = Math.floor(mob.pos.x + Math.cos(a) * 11), tz = Math.floor(mob.pos.z + Math.sin(a) * 11);
            const path = this._path(mob, tx, c.y, tz);
            if (path === undefined) { mob.fleeTry = (i + spread.length - 1) % spread.length; return false; }
            if (!path) continue;
            const end = path[path.length - 1];
            if (Math.hypot(end.x + 0.5 - threat.x, end.z + 0.5 - threat.z) > now + 2) {
                mob.path = path; mob.pathI = 0; mob.fleeTry = spread.length - 1;   // next time, straight away first
                return true;
            }
        }
        return false;
    }

    /** Walk the mob's path at `speed`. MOVING, ARRIVED at its end, or STUCK (the path is dropped). */
    _follow(mob, speed, dt) {
        const path = mob.path;
        if (!path) { this._drive(mob, 0, 0, 0, dt); return STUCK; }
        let w = path[mob.pathI];
        let dx = w.x + 0.5 - mob.pos.x, dz = w.z + 0.5 - mob.pos.z, d = Math.hypot(dx, dz);
        // Reached this cell (near its middle, and at its height): on to the next.
        while (d < 0.35 && Math.abs(mob.pos.y - w.y) < 1.1) {
            if (++mob.pathI >= path.length) { mob.path = null; this._drive(mob, 0, 0, 0, dt); return ARRIVED; }
            w = path[mob.pathI];
            dx = w.x + 0.5 - mob.pos.x; dz = w.z + 0.5 - mob.pos.z; d = Math.hypot(dx, dz);
        }
        if (mob.inWater) speed *= 0.6;
        this._drive(mob, dx / (d || 1), dz / (d || 1), speed, dt);

        // Up a block: jump as it comes to the ledge. On smooth terrain a rise is
        // a slope it walks up, so there it jumps only at what actually stops it.
        const rise = w.y - mob.pos.y;
        const ledge = !this.smooth && rise > 0.6 && d < 1.35;
        if ((ledge || mob.blockedT > 0.12) && rise > 0.3) this._jump(mob);

        // Getting nowhere? Try a hop; if that does not free it, give the path up.
        mob.progT += dt;
        if (mob.progT >= 0.8) {
            const moved = Math.hypot(mob.pos.x - mob.progX, mob.pos.z - mob.progZ);
            mob.progT = 0; mob.progX = mob.pos.x; mob.progZ = mob.pos.z;
            if (moved < speed * 0.8 * 0.25) {
                if (++mob.stuck >= 2) { mob.path = null; mob.stuck = 0; this._drive(mob, 0, 0, 0, dt); return STUCK; }
                this._jump(mob);
            } else mob.stuck = 0;
        }
        return MOVING;
    }

    _jump(mob) {
        if (mob.onGround) { mob.vel.y = MOB_JUMP_VEL; mob.onGround = false; }
        else if (mob.inWater) mob.vel.y = Math.max(mob.vel.y, 5.5);    // out onto the bank
    }

    /** Ease the mob's horizontal speed toward `speed` along (dx, dz), and turn it that way. */
    _drive(mob, dx, dz, speed, dt) {
        const k = 1 - Math.exp(-ACCEL * dt);
        mob.vel.x += (dx * speed - mob.vel.x) * k;
        mob.vel.z += (dz * speed - mob.vel.z) * k;
        mob.wantSpeed = speed;
        if (speed > 0.05) this._face(mob, dx, dz, dt);
    }

    _face(mob, dx, dz, dt) {
        if (dx === 0 && dz === 0) return;
        let turn = Math.atan2(dx, dz) - mob.yaw;
        turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
        const max = TURN_RATE * dt;
        mob.yaw += Math.max(-max, Math.min(max, turn));
    }

    // ── Fish ──────────────────────────────────────────────────────────────────

    _thinkFish(mob, dt, ctx) {
        const rnd = this.rnd, nav = this.nav, pos = mob.pos;
        mob.look = null;
        mob.panic = mob.state === 'FLEE';
        if (mob.panic && mob.stateTimer <= 0) { mob.state = 'IDLE'; mob.swimTarget = null; }
        if (!mob.inWater) {
            // Stranded: flop about.
            if (mob.onGround && mob.stateTimer <= 0) {
                mob.vel.y = 3.2 + rnd() * 1.5;
                mob.vel.x = (rnd() - 0.5) * 2.5; mob.vel.z = (rnd() - 0.5) * 2.5;
                mob.onGround = false;
                if (!mob.panic) mob.stateTimer = 0.5 + rnd() * 0.7;
            }
            mob.swimTarget = null;
            return;
        }
        let t = mob.swimTarget;
        if (t && (Math.hypot(t.x - pos.x, t.y - pos.y, t.z - pos.z) < 0.6 || mob.repath <= 0)) t = null;
        if (!t) {
            // Somewhere in open water it can swim straight to.
            const threat = mob.panic ? (mob.threat ?? ctx.player) : null;
            for (let tries = 0; tries < 6 && !t; tries++) {
                let a = rnd() * Math.PI * 2;
                if (threat) a = Math.atan2(pos.z - threat.z, pos.x - threat.x) + (rnd() - 0.5) * 1.6;
                const r = 2 + rnd() * (threat ? 7 : 5);
                const c = { x: pos.x + Math.cos(a) * r, y: pos.y + (rnd() - 0.5) * 3, z: pos.z + Math.sin(a) * r };
                let open = true;
                for (let s = 1; s <= 4 && open; s++) {
                    const k = s / 4;
                    const x = Math.floor(pos.x + (c.x - pos.x) * k), y = Math.floor(pos.y + (c.y - pos.y) * k), z = Math.floor(pos.z + (c.z - pos.z) * k);
                    open = nav.liquid(x, y, z) && (s < 4 || nav.liquid(x, y + 1, z));   // ends a block under the surface
                }
                if (open) t = c;
            }
            mob.swimTarget = t;
            mob.repath = 2 + rnd() * 3;
        }
        const speed = (mob.def.speed ?? 3) * (mob.panic ? 1.2 : 0.4);
        const k = 1 - Math.exp(-4 * dt);
        if (t) {
            const dx = t.x - pos.x, dy = t.y - pos.y, dz = t.z - pos.z, d = Math.hypot(dx, dy, dz) || 1;
            mob.vel.x += (dx / d * speed - mob.vel.x) * k;
            mob.vel.y += (dy / d * speed - mob.vel.y) * k;
            mob.vel.z += (dz / d * speed - mob.vel.z) * k;
            this._face(mob, dx, dz, dt * 0.6);
            mob.wantSpeed = speed;
        } else {
            mob.vel.x -= mob.vel.x * k; mob.vel.y -= mob.vel.y * k; mob.vel.z -= mob.vel.z * k;
            mob.wantSpeed = 0;
        }
    }

    // ── Moving ────────────────────────────────────────────────────────────────

    _physics(mob, dt) {
        const def = mob.def, pos = mob.pos, vel = mob.vel, nav = this.nav;
        const hw = (def.width ?? 0.8) / 2, h = def.height ?? 1.4;
        const cx = Math.floor(pos.x), cz = Math.floor(pos.z);
        const feetWet = nav.liquid(cx, Math.floor(pos.y + 0.15), cz);
        mob.inWater = feetWet;

        if (mob.body.swims) {
            if (feetWet) {
                // Weightless under water; never out through the surface.
                if (vel.y > 0 && !nav.liquid(cx, Math.floor(pos.y + h + 0.35), cz)) vel.y = Math.min(vel.y, -0.3);
            } else vel.y = Math.max(vel.y + MOB_GRAVITY * dt, TERMINAL);
        } else if (feetWet) {
            // Float: rise while the chest is under, settle once it is clear.
            const deep = nav.liquid(cx, Math.floor(pos.y + h * 0.62), cz);
            const k = 1 - Math.exp(-5 * dt);
            vel.y += ((deep ? 2.4 : -0.8) - vel.y) * k;
        } else {
            vel.y = Math.max(vel.y + MOB_GRAVITY * dt, TERMINAL);
        }

        const wasGround = mob.onGround;
        mob.blocked = false;

        // Never off an edge deeper than it would drop.
        const sp = Math.hypot(vel.x, vel.z);
        if (wasGround && !feetWet && sp > 0.05) {
            const ax = Math.floor(pos.x + vel.x / sp * (hw + 0.3)), az = Math.floor(pos.z + vel.z / sp * (hw + 0.3));
            if (nav.dropBelow(ax, Math.ceil(pos.y - 0.01), az, mob.body.maxDrop + 1) > mob.body.maxDrop) {
                vel.x = 0; vel.z = 0; mob.blocked = true;
            }
        }

        // Horizontal, an axis at a time.
        const nx = pos.x + vel.x * dt;
        if (vel.x !== 0) {
            if (!this._collides(nx, pos.y, pos.z, hw, h)) pos.x = nx;
            else if (!this._stepUp(mob, nx, pos.z, hw, h)) { vel.x = 0; mob.blocked = true; }
        }
        const nz = pos.z + vel.z * dt;
        if (vel.z !== 0) {
            if (!this._collides(pos.x, pos.y, nz, hw, h)) pos.z = nz;
            else if (!this._stepUp(mob, pos.x, nz, hw, h)) { vel.z = 0; mob.blocked = true; }
        }

        // Vertical.
        const ny = pos.y + vel.y * dt;
        if (!this._collides(pos.x, ny, pos.z, hw, h)) {
            pos.y = ny;
            mob.onGround = false;
        } else {
            mob.onGround = vel.y <= 0;
            vel.y = 0;
        }

        // Smooth terrain: going down a slope, stay on it instead of stepping
        // out into the air and falling a little on every block.
        if (this.smooth && wasGround && !mob.onGround && vel.y <= 0 && !feetWet &&
            this._collides(pos.x, pos.y - SNAP_DOWN, pos.z, hw, h)) {
            let lo = pos.y - SNAP_DOWN, hi = pos.y;
            for (let i = 0; i < 8; i++) {
                const mid = (lo + hi) * 0.5;
                if (this._collides(pos.x, mid, pos.z, hw, h)) lo = mid; else hi = mid;
            }
            pos.y = hi; vel.y = 0; mob.onGround = true;
        }

        mob.blockedT = mob.blocked && (mob.wantSpeed ?? 0) > 0.05 ? mob.blockedT + dt : 0;
    }

    /** Smooth worlds: climb a grounded mob onto a slope (see PlayerPhysics._stepUp). */
    _stepUp(mob, nx, nz, hw, h) {
        if (!this.smooth || !mob.onGround) return false;
        const pos = mob.pos, top = pos.y + STEP_HEIGHT;
        if (this._collides(pos.x, top, pos.z, hw, h) || this._collides(nx, top, nz, hw, h)) return false;
        let lo = pos.y, hi = top;
        for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) * 0.5;
            if (this._collides(nx, mid, nz, hw, h)) lo = mid; else hi = mid;
        }
        pos.x = nx; pos.y = hi; pos.z = nz;
        return true;
    }

    _collides(x, y, z, hw, h) {
        const smooth = this.smooth, world = this.world, reg = this.reg;
        const x0 = x - hw, x1 = x + hw - 0.001;
        const y0 = y,      y1 = y + h  - 0.001;
        const z0 = z - hw, z1 = z + hw - 0.001;
        for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) {
            for (let by = Math.floor(y0); by <= Math.floor(y1); by++) {
                for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
                    const id = world.getBlock(bx, by, bz);
                    if (id === 0 || reg.isNoCollision(id)) continue;
                    // Mesh blocks collide with their rendered shape, not their cube.
                    if (!smooth || !smooth.isMesh(id)) return true;
                    if (smooth.cellBlocks(bx, by, bz, x0, y0, z0, x1, y1, z1)) return true;
                }
            }
        }
        return false;
    }
}
