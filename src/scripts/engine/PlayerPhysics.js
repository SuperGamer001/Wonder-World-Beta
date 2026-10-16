/**
 * PlayerPhysics — AABB collision physics for the player character.
 *
 * Does NOT read input or KEYS directly — the caller provides a normalized
 * input object each frame.  Has no Three.js dependency.
 */

import { WORLD_MIN_Y, CHUNK_SHIFT } from './ChunkData.js';

const PLAYER_WIDTH  = 0.6;
const PLAYER_HEIGHT = 1.8;
const PLAYER_HALF_W = PLAYER_WIDTH / 2;

// ── Vertical motion ───────────────────────────────────────────────────────────
// Jump velocity is derived from the target height so gravity can be retuned
// without silently changing what the player can climb. Raising gravity alone
// shortens the arc (less floaty) while JUMP_HEIGHT keeps reachability fixed.
const GRAVITY     = -34;     // m/s²
// 1.25: onto a block with a little to spare, and not over a fence (BlockShapes FENCE_TOP, 1.5).
const JUMP_HEIGHT = 1.25;    // blocks — apex above the takeoff point
const JUMP_VEL    = Math.sqrt(2 * -GRAVITY * JUMP_HEIGHT);   // ≈9.2 m/s
const TERMINAL_VEL = -50;    // m/s (air)

// ── Water ─────────────────────────────────────────────────────────────────────
// Vertical motion in water is a drag model, not a hard velocity clamp. The old
// `max(vel + g*dt, terminal)` snapped a -40 m/s fall to -3 in a single frame,
// so entering water killed all momentum instantly. Now velocity relaxes toward
// the sink speed exponentially, which reads as the water catching you.
const WATER_SINK_SPEED = -3;    // m/s — terminal speed when not swimming
const WATER_DRAG       =  4.5;  // 1/s — how fast vertical velocity relaxes
const WATER_SWIM_SPEED =  5.0;  // m/s — max upward swim velocity
const WATER_SWIM_ACCEL = 34;    // m/s² — upward pulse while holding jump

// ── Horizontal motion ─────────────────────────────────────────────────────────
// Horizontal movement runs through velocity with exponential smoothing rather
// than writing position directly from the input vector, which started and
// stopped the player instantly. Each constant is a rate in 1/s; the time
// constant is its reciprocal (ACCEL_GROUND 14 -> ~0.07 s to close 63% of the
// gap, ~0.2 s to reach full speed).
const SPRINT_SPEED       =  8;     // m/s
const WALK_SPEED         =  5;     // m/s
const ACCEL_GROUND       = 14;     // spinning up on solid ground
const ACCEL_STOP         = 12;     // slowing to a halt on solid ground
// Air control is deliberately slower than ground so a jump carries weight, but
// not so slow that you cannot steer: the jump arc is only ~0.62 s, and at rate 4
// a standing jump would land before you reached walking speed.
const ACCEL_AIR          =  8;
const ACCEL_WATER        =  6;     // swimming feels heavier than walking
// Crouching (the sneak key, on the ground): slow, and never off an edge —
// a step that would leave nothing under the feet within CROUCH_DROP is not
// taken, so the player can lean out over a drop to build. The drop is what a
// slope may fall away by in one step in a smooth world (SNAP_DOWN), and next
// to nothing in a blocky one, where the ground is level or it is an edge.
const CROUCH_SPEED       =  1.8;   // m/s
const CROUCH_DROP_SMOOTH =  0.65;  // blocks
const CROUCH_DROP_BLOCKY =  0.1;
const FLY_SPEED_CREATIVE = 16;     // m/s (creative fly)
const FLY_SPEED_SPECTATOR= 12;     // m/s (spectator)

// ── Fall damage ───────────────────────────────────────────────────────────────
// Both values are derived from GRAVITY so the damage curve stays fixed in terms
// of *fall height* when gravity changes. A given drop reaches a higher speed
// under stronger gravity, so a hardcoded velocity threshold would silently make
// short falls start hurting.
const SAFE_FALL_BLOCKS      = 4;
const FALL_DAMAGE_THRESHOLD = -Math.sqrt(2 * -GRAVITY * SAFE_FALL_BLOCKS);  // ≈-16.5 m/s
// Tuned so damage per block of fall matches the original curve: the old build
// used 0.2 at gravity 24, and excess velocity scales with sqrt(gravity).
// … and then made 2.5 times as hard (FALL_DAMAGE_SCALE): a fall hardly hurt.
const FALL_DAMAGE_SCALE     = 2.5;
const FALL_DAMAGE_FACTOR    = 0.2 * Math.sqrt(24 / -GRAVITY) * FALL_DAMAGE_SCALE;   // ≈0.42
const DOUBLE_TAP_MS         = 300; // ms window for double-tap

// ── Slopes and steps ──────────────────────────────────────────────────────────
// Axis-separated movement blocks the player on any slope — walking into a
// ramp is a horizontal move into a surface — so a blocked grounded move may
// lift the player by up to STEP_HEIGHT. It is below one block on purpose: a
// full cube (or an un-smoothed one-block cliff) still needs a jump. SNAP_DOWN
// keeps a grounded player glued to a downward slope instead of launching into
// a string of tiny falls, which would otherwise flicker onGround and swap in
// air acceleration. Made for smooth terrain, and what walks the player up and
// down a flight of stairs or onto a slab in any world: in a blocky world of
// cubes alone nothing is ever half a block high, and neither does anything.
const STEP_HEIGHT = 0.6;
const SNAP_DOWN   = 0.6;
const STEP_ITERS  = 10;    // binary-search steps — resolves to ~0.0006 blocks

// ── Slow frames ───────────────────────────────────────────────────────────────
// Collision tests the box where a move ends, not the way there, and a move
// that ends inside something is refused whole. At ten frames a second a long
// fall covers five blocks a frame: the player stopped dead up to that far
// above the ground, was hurt there, and then fell the rest — or, when the move
// was longer than the box is thick, ended on the far side of a one-block floor
// (or, flying, a wall) without ever touching it. So a frame in which the
// player would move further than MAX_MOVE is taken in several equal steps. At a steady sixty frames a
// second only a fall of ten blocks or more is that fast (it lands within half
// a point of the damage it always did), so nothing else about how the game
// plays changes; what changes is that a slow machine plays by the same rules
// as a fast one.
const MAX_MOVE     = 0.45;   // blocks a step; the player is 0.6 wide
const MAX_SUBSTEPS = 8;

// ── Contact ───────────────────────────────────────────────────────────────────
// A move that would end inside something used to be refused whole, so the
// player stopped wherever the frame before had left them: up to a frame's
// travel short of a wall, and — falling — up to a third of a block above the
// ground, where they "landed", hung for a frame, and fell the rest. Against a
// wall the speed was zeroed and built up again over the gap, a little less
// each time: a shudder. Now a blocked move goes as far as it can
// (`_moveAxis`: the last clear place along it, found by halving), so the
// player comes to rest touching what stopped them.
const CONTACT_ITERS = 12;    // of at most MAX_MOVE: to within 0.0001 of a block

// ── Jumping ───────────────────────────────────────────────────────────────────
// Two small allowances, each a tenth of a second, that every platform game
// makes because without them a jump pressed at the right moment as the player
// sees it is dropped: the ground still counts just after it is walked off
// (COYOTE), and a jump asked for just before landing is made on landing
// (JUMP_BUFFER). Holding the key still jumps again on every landing.
const COYOTE      = 0.1;     // seconds
const JUMP_BUFFER = 0.1;     // seconds

// ── Ladders ───────────────────────────────────────────────────────────────────
// In a block that is climbed (BlockRegistry `climb`) nothing falls: the player
// goes up while they jump or walk into what the ladder is on, slides down
// slowly otherwise, and stays put while they sneak.
const CLIMB_SPEED = 3.4;     // m/s up
const CLIMB_SLIDE = -2.4;    // m/s down, hands off
const CLIMB_RATE  = 18;      // 1/s — how fast the speed comes to those

/**
 * Frame-rate independent exponential approach factor.
 * Returns the fraction of the remaining gap to close this frame for a given
 * rate, so behaviour is identical at 30 and 144 fps.
 */
function approach(rate, dt) {
    return 1 - Math.exp(-rate * dt);
}

export class PlayerPhysics {
    constructor(worldState, blockRegistry) {
        this.world = worldState;
        this.reg   = blockRegistry;

        this.vel      = { x: 0, y: 0, z: 0 };
        this.onGround = false;
        this.inWater  = false;
        this.flying   = false;   // creative fly mode toggle
        this.crouching = false;  // the sneak key is held with feet on the ground

        this._prevFallVel  = 0;  // y-vel just before landing
        this._lastJumpTime = 0;  // ms — double-tap detection
        this._jumpWasDown  = false;
        this._sinceGround  = 1;  // seconds since there was ground underfoot (COYOTE)
        this._jumpWant     = 0;  // seconds a jump that was asked for is still wanted (JUMP_BUFFER)

        // How far the last update() lifted (+) or dropped (−) the player in no
        // time at all — a step up a slope's edge, a snap down onto one. The
        // caller eases the camera over it instead of jumping with the feet.
        this.stepped = 0;

        // SmoothTerrain collider in smooth worlds; null keeps blocky collision.
        this.smooth = null;
        // The blocks that are not cubes (slabs, stairs, fences, doors): what
        // of each stops a body (BlockShapes.ShapeSet). Null with a registry
        // that has none.
        this.shapes = blockRegistry.shapes ?? null;
        this.climbing = false;   // on a ladder
        this._blockedH = false;  // the last step ran into something sideways
        // Doors and gates that have shut on the player where they stood (in
        // the doorway): x, y, z of each. Walked through until the player is
        // out of them (_shutOn).
        this._through = [];

        // Set by the caller from the weather each frame:
        //   external — velocity the surroundings push the player toward (a
        //              tornado's pull, a gale); x/z join the walking target,
        //              y is an upward acceleration (m/s²)
        //   slip     — 0..1, how icy the ground underfoot is (an ice block, or
        //              freezing rain); scales down grip, so the player slides
        this.external = { x: 0, y: 0, z: 0 };
        this.slip     = 0;
    }

    /**
     * Advance physics one frame.
     *
     * @param {{ x,y,z }}   pos       Player foot position — mutated in place
     * @param {object}      input     { forward, backward, left, right, jump, sneak, sprint,
     *                                  fwd:{x,z}, right:{x,z} }
     * @param {number}      dt        Delta-time in seconds
     * @param {string}      gameMode  'SURVIVAL' | 'CREATIVE' | 'SPECTATOR'
     * @param {object}      stats     { hunger, energy } for sprint restriction
     * @returns {{ onGround, inWater, fallDamage, fellIntoVoid }}
     */
    update(pos, input, dt, gameMode, stats = {}) {
        const isSpectator = gameMode === 'SPECTATOR';
        const isCreative  = gameMode === 'CREATIVE';
        const isSurvival  = gameMode === 'SURVIVAL';
        this.stepped = 0;

        // Creative double-tap jump → toggle fly
        if (isCreative) this._checkDoubleTap(input);

        if (isSpectator || (isCreative && this.flying)) {
            const speed = isSpectator ? FLY_SPEED_SPECTATOR : FLY_SPEED_CREATIVE;
            // A spectator collides with nothing, so there is nothing to miss.
            const n = isSpectator ? 1 : this._substeps(speed, dt);
            let result = null;
            for (let i = 0; i < n; i++) result = this._flyUpdate(pos, input, dt / n, speed, isSpectator);
            return result;
        }

        // The fastest the player can be going by the end of the frame.
        const v = this.vel;
        const fastest = Math.max(Math.abs(v.x), Math.abs(v.z), SPRINT_SPEED, Math.abs(v.y) - GRAVITY * dt);
        const n = this._substeps(fastest, dt);
        if (n === 1) return this._groundUpdate(pos, input, dt, isCreative, isSurvival, stats);

        let fallDamage = 0, fellIntoVoid = false, result = null;
        for (let i = 0; i < n; i++) {
            result = this._groundUpdate(pos, input, dt / n, isCreative, isSurvival, stats);
            if (result.fallDamage > fallDamage) fallDamage = result.fallDamage;   // it lands in one of them
            fellIntoVoid ||= result.fellIntoVoid;
        }
        result.fallDamage = fallDamage;
        result.fellIntoVoid = fellIntoVoid;
        return result;
    }

    /** How many equal steps a frame of `dt` seconds at `speed` blocks a second is taken in (see MAX_MOVE). */
    _substeps(speed, dt) {
        const n = Math.ceil(speed * dt / MAX_MOVE);
        return n < 1 ? 1 : n > MAX_SUBSTEPS ? MAX_SUBSTEPS : n;
    }

    // ── Fly / spectator movement ───────────────────────────────────────────────

    _flyUpdate(pos, input, dt, speed, noClip) {
        const { fwd, rightDir: rd } = input;
        if (!noClip) this._shutOn(pos);
        let dx = 0, dy = 0, dz = 0;

        if (input.forward)  { dx += fwd.x; dz += fwd.z;   }
        if (input.backward) { dx -= fwd.x; dz -= fwd.z;   }
        if (input.left)     { dx += rd.x;  dz += rd.z;    }
        if (input.right)    { dx -= rd.x;  dz -= rd.z;    }
        if (input.jump)     dy += 1;
        if (input.sneak)    dy -= 1;
        // A controller's stick (see _groundUpdate).
        const mf = input.moveF ?? 0, mr = input.moveR ?? 0;
        dx += fwd.x * mf - rd.x * mr;
        dz += fwd.z * mf - rd.z * mr;

        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 1) { dx /= len; dz /= len; }

        const nx = pos.x + dx * speed * dt;
        const ny = pos.y + dy * speed * dt;
        const nz = pos.z + dz * speed * dt;

        if (noClip) {
            pos.x = nx; pos.y = ny; pos.z = nz;
        } else {
            this._moveAxis(pos, 'x', nx);
            this._moveAxis(pos, 'y', ny);
            this._moveAxis(pos, 'z', nz);
        }

        this.vel = { x: dx * speed, y: dy * speed, z: dz * speed };
        this.onGround = false;
        this.inWater  = false;
        return { onGround: false, inWater: false, fallDamage: 0, fellIntoVoid: false };
    }

    // ── Standard gravity + AABB movement ─────────────────────────────────────

    _groundUpdate(pos, input, dt, isCreative, isSurvival, stats) {
        const { fwd, rightDir: rd } = input;
        this._shutOn(pos);

        // Sprint requires the key in every mode. Previously `!isSurvival || …`
        // made canSprint unconditionally true outside survival, so Creative and
        // the loading-screen modes always ran at sprint speed and the walk
        // speed was unreachable there.
        const canSprint = input.sprint
            && (!isSurvival || ((stats.hunger ?? 100) > 15 && (stats.energy ?? 100) > 10));
        const crouch = !!input.sneak && this.onGround && !this.inWater;
        this.crouching = crouch;
        const speed = crouch ? CROUCH_SPEED : canSprint ? SPRINT_SPEED : WALK_SPEED;

        let dx = 0, dz = 0;
        if (input.forward)  { dx += fwd.x; dz += fwd.z; }
        if (input.backward) { dx -= fwd.x; dz -= fwd.z; }
        if (input.left)     { dx += rd.x;  dz += rd.z;  }
        if (input.right)    { dx -= rd.x;  dz -= rd.z;  }
        // A controller's stick: forward and right, −1 … 1, as far as it is
        // pushed. (`rightDir` points to the player's left, hence the minus.)
        const mf = input.moveF ?? 0, mr = input.moveR ?? 0;
        dx += fwd.x * mf - rd.x * mr;
        dz += fwd.z * mf - rd.z * mr;
        // Never faster than full speed (two keys at once, a stick in a corner);
        // a stick pushed part way walks slower. Keys alone are 0, 1 or √2 long,
        // so for them this is what it always was.
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 1) { dx /= len; dz /= len; }

        this.inWater = this._isLiquidAt(pos.x, pos.y + 0.5, pos.z);
        this.climbing = !this.inWater && this._climbAt(pos);

        // ── Horizontal velocity ──────────────────────────────────────────────
        // Ease toward the target instead of snapping to it. Stopping uses its
        // own rate so the player can be given a slightly longer skid than the
        // spin-up without making acceleration feel sluggish.
        const moving = len > 0;
        let rate = this.inWater ? ACCEL_WATER
                 : !this.onGround ? ACCEL_AIR
                 : moving ? ACCEL_GROUND
                 : ACCEL_STOP;
        // Ice: much less grip, so starting, stopping and turning all slide.
        if (this.onGround && !this.inWater) rate *= 1 - 0.85 * Math.min(1, Math.max(0, this.slip));
        const kh = approach(rate, dt);
        const ext = this.external;
        this.vel.x += (dx * speed + ext.x - this.vel.x) * kh;
        this.vel.z += (dz * speed + ext.z - this.vel.z) * kh;

        // ── Vertical velocity ────────────────────────────────────────────────
        if (this.inWater) {
            // Drag toward the passive sink speed. Applied every frame, including
            // while swimming up, so it also bleeds off downward momentum from a
            // fall gradually rather than cancelling it in one step.
            this.vel.y += (WATER_SINK_SPEED - this.vel.y) * approach(WATER_DRAG, dt);
            if (input.jump) {
                this.vel.y = Math.min(this.vel.y + WATER_SWIM_ACCEL * dt, WATER_SWIM_SPEED);
            }
        } else if (this.climbing) {
            const want = input.jump || (moving && this._blockedH) ? CLIMB_SPEED : input.sneak || this.onGround ? 0 : CLIMB_SLIDE;
            this.vel.y += (want - this.vel.y) * approach(CLIMB_RATE, dt);
            this._sinceGround = 0;
            this._jumpWant = 0;
        } else {
            this._sinceGround = this.onGround ? 0 : this._sinceGround + dt;
            this._jumpWant = input.jump ? JUMP_BUFFER : Math.max(0, this._jumpWant - dt);
            if (this._jumpWant > 0 && this.vel.y <= 0 && (this.onGround || this._sinceGround < COYOTE)) {
                this.vel.y = JUMP_VEL;
                this._jumpWant = 0;
                this._sinceGround = COYOTE;     // one jump for one piece of ground
            }
            // Gravity applies unconditionally; the collision test below is what
            // re-establishes onGround each frame.
            //
            // This used to be skipped while grounded, which left vel.y at exactly
            // 0, so the vertical move became a no-op that "succeeded" and cleared
            // onGround — then gravity ran, the move was blocked, and onGround came
            // back. Standing still therefore flip-flopped onGround every frame,
            // which made air/ground acceleration alternate and let a single-frame
            // jump tap land on a false frame and be dropped.
            this.vel.y = Math.max(this.vel.y + (GRAVITY + ext.y) * dt, TERMINAL_VEL);
        }

        // Store pre-landing velocity for fall-damage computation
        const prevOnGround = this.onGround;
        if (!this.onGround) this._prevFallVel = this.vel.y;

        // Stepping is for walking on slopes and stairs, so it needs footing (or water).
        const canStep = prevOnGround || this.inWater;
        let blockedH = false;

        // Crouching, a step that would leave the ground behind is not taken.
        const drop = crouch && prevOnGround && this.vel.y <= 0 ? (this.smooth !== null ? CROUCH_DROP_SMOOTH : CROUCH_DROP_BLOCKY) : 0;

        // Move X
        const nx = pos.x + this.vel.x * dt;
        if (drop > 0 && this._canMoveTo(nx, pos.y, pos.z) && this._canMoveTo(nx, pos.y - drop, pos.z)) this.vel.x = 0;
        else if (this._canMoveTo(nx, pos.y, pos.z))         pos.x = nx;
        else if (!(canStep && this._stepUp(pos, nx, pos.z))) { this._moveAxis(pos, 'x', nx); this.vel.x = 0; blockedH = true; }

        // Move Z
        const nz = pos.z + this.vel.z * dt;
        if (drop > 0 && this._canMoveTo(pos.x, pos.y, nz) && this._canMoveTo(pos.x, pos.y - drop, nz)) this.vel.z = 0;
        else if (this._canMoveTo(pos.x, pos.y, nz))         pos.z = nz;
        else if (!(canStep && this._stepUp(pos, pos.x, nz))) { this._moveAxis(pos, 'z', nz); this.vel.z = 0; blockedH = true; }
        this._blockedH = blockedH;

        if (prevOnGround && !this.inWater && !this.climbing && this.vel.y <= 0) {
            this._snapDown(pos);
        }

        // Move Y
        const ny = pos.y + this.vel.y * dt;
        if (this._moveAxis(pos, 'y', ny)) {
            this.onGround = false;
        } else {
            // Down onto the ground, or up against a ceiling: as far as it goes.
            this.onGround = this.vel.y < 0;
            this.vel.y    = 0;
        }

        // Fall damage (survival + creative creative = no damage, survival = yes)
        let fallDamage = 0;
        // (Nor from one that ends in water, however thin: a flow too shallow to swim in still breaks a fall.)
        if (!isCreative && this.onGround && !prevOnGround && !this.inWater &&
            !this.reg.isLiquid(this.world.getBlock(Math.floor(pos.x), Math.floor(pos.y + 0.05), Math.floor(pos.z)))) {
            if (this._prevFallVel < FALL_DAMAGE_THRESHOLD) {
                const excess = Math.abs(this._prevFallVel - FALL_DAMAGE_THRESHOLD);
                fallDamage   = excess * FALL_DAMAGE_FACTOR * 10;
            }
        }

        return {
            onGround:     this.onGround,
            inWater:      this.inWater,
            fallDamage,
            fellIntoVoid: pos.y < WORLD_MIN_Y - 20,
        };
    }

    // ── Creative fly toggle ────────────────────────────────────────────────────

    _checkDoubleTap(input) {
        if (input.jump && !this._jumpWasDown) {
            const now = Date.now();
            if (now - this._lastJumpTime < DOUBLE_TAP_MS) {
                this.flying = !this.flying;
                this.vel.y  = 0;
            }
            this._lastJumpTime = now;
        }
        this._jumpWasDown = input.jump;
    }

    // ── Collision helpers ─────────────────────────────────────────────────────

    _canMoveTo(x, y, z) { return !this._collidesAt(x, y, z); }

    /** Is there room for the player standing at (x, y, z)? */
    fits(x, y, z) { return !this._collidesAt(x, y, z); }

    /**
     * Which doors and gates (BlockShapes `closes`) the player is inside now: one
     * that shut on them as they stood in the doorway does not hold them there —
     * it is walked through until they are out of it. Asked at the start of
     * every step.
     */
    _shutOn(pos) {
        const t = this._through, shapes = this.shapes;
        t.length = 0;
        if (!shapes) return;
        const x0 = pos.x - PLAYER_HALF_W, x1 = pos.x + PLAYER_HALF_W - 0.001, y0 = pos.y, y1 = pos.y + PLAYER_HEIGHT - 0.001;
        const z0 = pos.z - PLAYER_HALF_W, z1 = pos.z + PLAYER_HALF_W - 0.001;
        for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) {
            for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
                for (let by = Math.floor(y0) - 1; by <= Math.floor(y1); by++) {
                    const sh = shapes.of(this.world.getBlock(bx, by, bz));
                    if (sh?.closes && shapes.boxHits(sh, this.world, bx, by, bz, x0, y0, z0, x1, y1, z1)) t.push(bx, by, bz);
                }
            }
        }
    }

    /**
     * Move along one axis to `to`, or — if something is in the way — as far
     * toward it as is clear (see *Contact*). Returns whether it got there.
     */
    _moveAxis(pos, axis, to) {
        const from = pos[axis];
        const clear = (v) => axis === 'x' ? this._canMoveTo(v, pos.y, pos.z)
                           : axis === 'y' ? this._canMoveTo(pos.x, v, pos.z)
                           : this._canMoveTo(pos.x, pos.y, v);
        if (clear(to)) { pos[axis] = to; return true; }
        if (to === from || !clear(from)) return false;      // already inside something: stay put
        let lo = from, hi = to;                              // lo clear, hi blocked
        for (let i = 0; i < CONTACT_ITERS; i++) {
            const mid = (lo + hi) * 0.5;
            if (clear(mid)) lo = mid; else hi = mid;
        }
        pos[axis] = lo;
        return false;
    }

    /**
     * Try to climb onto what blocked a horizontal move (a slope, a stair, a slab). Succeeds
     * when the destination is clear at most STEP_HEIGHT higher (with headroom
     * both here and there), then settles at the lowest clear height.
     */
    _stepUp(pos, nx, nz) {
        const top = pos.y + STEP_HEIGHT;
        if (!this._canMoveTo(pos.x, top, pos.z) || !this._canMoveTo(nx, top, nz)) return false;
        let lo = pos.y, hi = top;          // lo blocked, hi clear
        for (let i = 0; i < STEP_ITERS; i++) {
            const mid = (lo + hi) * 0.5;
            if (this._canMoveTo(nx, mid, nz)) hi = mid; else lo = mid;
        }
        this.stepped += hi - pos.y;
        pos.x = nx; pos.y = hi; pos.z = nz;
        return true;
    }

    /**
     * After walking off the high side of a slope (or down a stair), drop straight
     * onto the surface if it is within SNAP_DOWN. Leaves the player a hair
     * above it, so gravity's move this frame is what registers the landing.
     */
    _snapDown(pos) {
        const bottom = pos.y - SNAP_DOWN;
        if (this._canMoveTo(pos.x, bottom, pos.z)) return;   // real drop — fall normally
        let lo = bottom, hi = pos.y;       // lo blocked, hi clear
        if (!this._canMoveTo(pos.x, hi, pos.z)) return;
        for (let i = 0; i < STEP_ITERS; i++) {
            const mid = (lo + hi) * 0.5;
            if (this._canMoveTo(pos.x, mid, pos.z)) hi = mid; else lo = mid;
        }
        this.stepped += hi - pos.y;
        pos.y = hi;
    }

    _collidesAt(x, y, z) {
        const x0 = x - PLAYER_HALF_W, x1 = x + PLAYER_HALF_W - 0.001;
        const y0 = y,                 y1 = y + PLAYER_HEIGHT  - 0.001;
        const z0 = z - PLAYER_HALF_W, z1 = z + PLAYER_HALF_W - 0.001;

        const smooth = this.smooth, shapes = this.shapes, yLo = Math.floor(y0);
        for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) {
            for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
                // Unloaded chunk → treat as solid wall to prevent walking into void
                if (!this.world.getChunk(bx >> CHUNK_SHIFT, bz >> CHUNK_SHIFT)?.generated) return true;
                // (From one block lower: a fence stands half a block above its own.)
                for (let by = yLo - 1; by <= Math.floor(y1); by++) {
                    const id = this.world.getBlock(bx, by, bz);
                    if (id === 0 || this.reg.isNoCollision(id)) continue;
                    // A block that is not a cube stops a body with its own boxes.
                    const sh = shapes?.of(id);
                    if (sh) {
                        if (sh.closes && this._isThrough(bx, by, bz)) continue;
                        if ((by >= yLo || sh.tall) && shapes.boxHits(sh, this.world, bx, by, bz, x0, y0, z0, x1, y1, z1)) return true;
                        continue;
                    }
                    if (by < yLo) continue;
                    // Mesh blocks collide with their rendered shape, not their cube.
                    if (smooth === null || !smooth.isMesh(id)) return true;
                    if (smooth.cellBlocks(bx, by, bz, x0, y0, z0, x1, y1, z1)) return true;
                }
            }
        }
        return false;
    }

    _isThrough(bx, by, bz) {
        const t = this._through;
        for (let i = 0; i < t.length; i += 3) if (t[i] === bx && t[i + 1] === by && t[i + 2] === bz) return true;
        return false;
    }

    /** Is the point in water — under the surface of the block of it there, which a thin flow does not fill? */
    _isLiquidAt(x, y, z) {
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        const id = this.world.getBlock(bx, by, bz);
        if (!this.reg.isLiquid(id)) return false;
        const h = this.reg.fluidHeight?.(id) ?? 1;
        return h >= 1 || y - by < h || this.reg.isLiquid(this.world.getBlock(bx, by + 1, bz));
    }

    /** Is the player on a ladder: a block that is climbed at their feet or their middle? */
    _climbAt(pos) {
        const reg = this.reg;
        if (!reg.isClimb) return false;
        const bx = Math.floor(pos.x), bz = Math.floor(pos.z);
        return reg.isClimb(this.world.getBlock(bx, Math.floor(pos.y + 0.1), bz)) || reg.isClimb(this.world.getBlock(bx, Math.floor(pos.y + 1), bz));
    }
}
