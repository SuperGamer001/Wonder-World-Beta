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
const JUMP_HEIGHT = 1.7;     // blocks — apex above the takeoff point
const JUMP_VEL    = Math.sqrt(2 * -GRAVITY * JUMP_HEIGHT);   // ≈10.75 m/s
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
const FALL_DAMAGE_FACTOR    = 0.2 * Math.sqrt(24 / -GRAVITY);               // ≈0.168
const DOUBLE_TAP_MS         = 300; // ms window for double-tap

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

        this._prevFallVel  = 0;  // y-vel just before landing
        this._lastJumpTime = 0;  // ms — double-tap detection
        this._jumpWasDown  = false;
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

        // Creative double-tap jump → toggle fly
        if (isCreative) this._checkDoubleTap(input);

        if (isSpectator || (isCreative && this.flying)) {
            const speed = isSpectator ? FLY_SPEED_SPECTATOR : FLY_SPEED_CREATIVE;
            return this._flyUpdate(pos, input, dt, speed, isSpectator);
        }

        return this._groundUpdate(pos, input, dt, isCreative, isSurvival, stats);
    }

    // ── Fly / spectator movement ───────────────────────────────────────────────

    _flyUpdate(pos, input, dt, speed, noClip) {
        const { fwd, rightDir: rd } = input;
        let dx = 0, dy = 0, dz = 0;

        if (input.forward)  { dx += fwd.x; dz += fwd.z;   }
        if (input.backward) { dx -= fwd.x; dz -= fwd.z;   }
        if (input.left)     { dx += rd.x;  dz += rd.z;    }
        if (input.right)    { dx -= rd.x;  dz -= rd.z;    }
        if (input.jump)     dy += 1;
        if (input.sneak)    dy -= 1;

        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) { dx /= len; dz /= len; }

        const nx = pos.x + dx * speed * dt;
        const ny = pos.y + dy * speed * dt;
        const nz = pos.z + dz * speed * dt;

        if (noClip) {
            pos.x = nx; pos.y = ny; pos.z = nz;
        } else {
            if (this._canMoveTo(nx, pos.y, pos.z)) pos.x = nx;
            if (this._canMoveTo(pos.x, ny, pos.z)) pos.y = ny;
            if (this._canMoveTo(pos.x, pos.y, nz)) pos.z = nz;
        }

        this.vel = { x: dx * speed, y: dy * speed, z: dz * speed };
        this.onGround = false;
        this.inWater  = false;
        return { onGround: false, inWater: false, fallDamage: 0, fellIntoVoid: false };
    }

    // ── Standard gravity + AABB movement ─────────────────────────────────────

    _groundUpdate(pos, input, dt, isCreative, isSurvival, stats) {
        const { fwd, rightDir: rd } = input;

        // Sprint requires the key in every mode. Previously `!isSurvival || …`
        // made canSprint unconditionally true outside survival, so Creative and
        // the loading-screen modes always ran at sprint speed and the walk
        // speed was unreachable there.
        const canSprint = input.sprint
            && (!isSurvival || ((stats.hunger ?? 100) > 15 && (stats.energy ?? 100) > 10));
        const speed = canSprint ? SPRINT_SPEED : WALK_SPEED;

        let dx = 0, dz = 0;
        if (input.forward)  { dx += fwd.x; dz += fwd.z; }
        if (input.backward) { dx -= fwd.x; dz -= fwd.z; }
        if (input.left)     { dx += rd.x;  dz += rd.z;  }
        if (input.right)    { dx -= rd.x;  dz -= rd.z;  }
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) { dx /= len; dz /= len; }

        this.inWater = this._isLiquidAt(pos.x, pos.y + 0.5, pos.z);

        // ── Horizontal velocity ──────────────────────────────────────────────
        // Ease toward the target instead of snapping to it. Stopping uses its
        // own rate so the player can be given a slightly longer skid than the
        // spin-up without making acceleration feel sluggish.
        const moving = len > 0;
        const rate = this.inWater ? ACCEL_WATER
                   : !this.onGround ? ACCEL_AIR
                   : moving ? ACCEL_GROUND
                   : ACCEL_STOP;
        const kh = approach(rate, dt);
        this.vel.x += (dx * speed - this.vel.x) * kh;
        this.vel.z += (dz * speed - this.vel.z) * kh;

        // ── Vertical velocity ────────────────────────────────────────────────
        if (this.inWater) {
            // Drag toward the passive sink speed. Applied every frame, including
            // while swimming up, so it also bleeds off downward momentum from a
            // fall gradually rather than cancelling it in one step.
            this.vel.y += (WATER_SINK_SPEED - this.vel.y) * approach(WATER_DRAG, dt);
            if (input.jump) {
                this.vel.y = Math.min(this.vel.y + WATER_SWIM_ACCEL * dt, WATER_SWIM_SPEED);
            }
        } else {
            if (input.jump && this.onGround) this.vel.y = JUMP_VEL;
            // Gravity applies unconditionally; the collision test below is what
            // re-establishes onGround each frame.
            //
            // This used to be skipped while grounded, which left vel.y at exactly
            // 0, so the vertical move became a no-op that "succeeded" and cleared
            // onGround — then gravity ran, the move was blocked, and onGround came
            // back. Standing still therefore flip-flopped onGround every frame,
            // which made air/ground acceleration alternate and let a single-frame
            // jump tap land on a false frame and be dropped.
            this.vel.y = Math.max(this.vel.y + GRAVITY * dt, TERMINAL_VEL);
        }

        // Store pre-landing velocity for fall-damage computation
        const prevOnGround = this.onGround;
        if (!this.onGround) this._prevFallVel = this.vel.y;

        // Move X
        const nx = pos.x + this.vel.x * dt;
        if (this._canMoveTo(nx, pos.y, pos.z)) pos.x = nx;
        else                                    this.vel.x = 0;

        // Move Z
        const nz = pos.z + this.vel.z * dt;
        if (this._canMoveTo(pos.x, pos.y, nz)) pos.z = nz;
        else                                    this.vel.z = 0;

        // Move Y
        const ny = pos.y + this.vel.y * dt;
        if (this._canMoveTo(pos.x, ny, pos.z)) {
            pos.y = ny;
            this.onGround = false;
        } else {
            this.onGround = this.vel.y < 0;
            this.vel.y    = 0;
        }

        // Fall damage (survival + creative creative = no damage, survival = yes)
        let fallDamage = 0;
        if (!isCreative && this.onGround && !prevOnGround && !this.inWater) {
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

    _collidesAt(x, y, z) {
        const x0 = x - PLAYER_HALF_W, x1 = x + PLAYER_HALF_W - 0.001;
        const y0 = y,                 y1 = y + PLAYER_HEIGHT  - 0.001;
        const z0 = z - PLAYER_HALF_W, z1 = z + PLAYER_HALF_W - 0.001;

        for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) {
            for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
                // Unloaded chunk → treat as solid wall to prevent walking into void
                if (!this.world.getChunk(bx >> CHUNK_SHIFT, bz >> CHUNK_SHIFT)?.generated) return true;
                for (let by = Math.floor(y0); by <= Math.floor(y1); by++) {
                    const id = this.world.getBlock(bx, by, bz);
                    if (id > 0 && !this.reg.isNoCollision(id)) return true;
                }
            }
        }
        return false;
    }

    _isLiquidAt(x, y, z) {
        return this.reg.isLiquid(
            this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))
        );
    }
}
