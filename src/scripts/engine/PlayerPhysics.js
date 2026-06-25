/**
 * PlayerPhysics — AABB collision physics for the player character.
 *
 * Does NOT read input or KEYS directly — the caller provides a normalized
 * input object each frame.  Has no Three.js dependency.
 */

import { WORLD_MIN_Y } from './ChunkData.js';

const PLAYER_WIDTH  = 0.6;
const PLAYER_HEIGHT = 1.8;
const PLAYER_HALF_W = PLAYER_WIDTH / 2;

const GRAVITY            = -24;    // m/s²
const JUMP_VEL           =  9;     // initial jump velocity (m/s)
const WATER_GRAVITY      = -4;     // gravity while submerged
const WATER_SWIM_SPEED   =  2.5;   // max upward swim velocity
const TERMINAL_VEL       = -50;    // m/s (air)
const WATER_TERMINAL_VEL = -3;     // m/s (water)
const SPRINT_SPEED       =  8;     // m/s
const WALK_SPEED         =  5;     // m/s
const FLY_SPEED_CREATIVE = 16;     // m/s (creative fly)
const FLY_SPEED_SPECTATOR= 12;     // m/s (spectator)

const FALL_DAMAGE_THRESHOLD = -14; // ~4-block drop before damage starts (sqrt(2*24*4)≈13.9)
const FALL_DAMAGE_FACTOR    =  0.2; // health damage per extra m/s above threshold
const DOUBLE_TAP_MS         = 300; // ms window for double-tap

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

        const canSprint = !isSurvival
            || ((stats.hunger ?? 100) > 15 && (stats.energy ?? 100) > 10 && input.sprint);
        const speed = canSprint ? SPRINT_SPEED : WALK_SPEED;

        let dx = 0, dz = 0;
        if (input.forward)  { dx += fwd.x; dz += fwd.z; }
        if (input.backward) { dx -= fwd.x; dz -= fwd.z; }
        if (input.left)     { dx += rd.x;  dz += rd.z;  }
        if (input.right)    { dx -= rd.x;  dz -= rd.z;  }
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) { dx /= len; dz /= len; }

        this.inWater = this._isLiquidAt(pos.x, pos.y + 0.5, pos.z);

        const gravity   = this.inWater ? WATER_GRAVITY      : GRAVITY;
        const terminalV = this.inWater ? WATER_TERMINAL_VEL : TERMINAL_VEL;

        // Jump / swim
        if (input.jump) {
            if (this.onGround && !this.inWater) {
                this.vel.y = JUMP_VEL;
            } else if (this.inWater) {
                this.vel.y = Math.min(this.vel.y + 8 * dt, WATER_SWIM_SPEED);
            }
        }

        // Apply gravity
        if (!this.onGround || this.vel.y > 0) {
            this.vel.y = Math.max(this.vel.y + gravity * dt, terminalV);
        }

        // Store pre-landing velocity for fall-damage computation
        const prevOnGround = this.onGround;
        if (!this.onGround) this._prevFallVel = this.vel.y;

        // Move X
        const nx = pos.x + dx * speed * dt;
        if (this._canMoveTo(nx, pos.y, pos.z)) pos.x = nx;
        else                                    this.vel.x = 0;

        // Move Z
        const nz = pos.z + dz * speed * dt;
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
            for (let by = Math.floor(y0); by <= Math.floor(y1); by++) {
                for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
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
