/**
 * GameSounds — when the world makes which sound. Sound.js plays them; this
 * decides: a footstep for every stride on the ground walked on, the knock of
 * a tool while a block is being mined, a splash on going into water, and the
 * ambience — birds by day in the open, crickets by night, the air of a cave,
 * water where there is water, and the world gone dull with the head under it.
 *
 * world.js calls `tick` once a frame with what the player is doing, and the
 * one-shot methods where things happen. Nothing here reads the world itself:
 * what it needs to know is handed in, so it can be driven by a test.
 */

import { sound, blockSoundFamily } from './Sound.js';

const STRIDE_WALK = 2.1;     // blocks between footfalls, walking …
const STRIDE_RUN  = 2.9;     // … and running (longer strides, not just faster ones)
const HIT_EVERY   = 0.26;    // seconds between knocks while mining
const SWIM_EVERY  = 1.1;     // … and between strokes while swimming

const ease = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));

export class GameSounds {
    constructor() {
        this._walked = 0;
        this._wasGround = true;
        this._wasWater = false;
        this._airTime = 0;
        this._hitT = 0;
        this._swimT = 0;
        this._eatT = 0;
        this._amb = { birds: 0, crickets: 0, cave: 0, water: 0, underwater: 0 };
        this._preloaded = false;
    }

    /**
     * @param {object} s {
     *   x, y, z      the player's feet;  eyeY  the height of the eyes above them
     *   yaw          the way the camera faces
     *   speed        over the ground, blocks/s;  vy  upward speed
     *   onGround, inWater, headInWater, silent (a spectator, or flying: no feet)
     *   ground       the block definition underfoot, or null
     *   skyLight     0 (sealed in) … 1 (open sky) at the head
     *   sun          sine of the sun's height (below 0: night)
     *   rain         what is falling on the player, 0 … 1
     *   nearWater    0 … 1: how much open water is close by
     *   paused
     * }
     */
    tick(dt, s) {
        // The short sounds are decoded as soon as the mixer exists (the first click).
        if (!this._preloaded) sound.preload().then((ok) => { this._preloaded = this._preloaded || ok; });
        sound.setListener(s.x, s.y + s.eyeY, s.z, s.yaw);
        sound.setMuffled(s.headInWater);
        this._ambience(dt, s);
        if (s.paused) return;

        const at = { x: s.x, y: s.y, z: s.z };
        // Into the water, or out of it.
        if (s.inWater !== this._wasWater) {
            if (s.inWater && !s.silent) sound.play(s.vy < -6 ? 'water_splash' : 'water_swim', { volume: Math.min(1, 0.4 + Math.abs(s.vy) / 14), at });
            this._wasWater = s.inWater;
        }
        if (s.silent) { this._wasGround = s.onGround; this._walked = 0; return; }

        if (s.inWater) {
            this._swimT += dt * (0.4 + Math.min(1, s.speed / 3));
            if (this._swimT >= SWIM_EVERY) { this._swimT = 0; sound.play('water_swim', { volume: 0.45, at }); }
        } else if (s.onGround) {
            const family = blockSoundFamily(s.ground);
            if (!this._wasGround) {
                // Landing: both feet at once, harder the longer the drop.
                const hard = Math.min(1, this._airTime / 0.7);
                if (this._airTime > 0.18) sound.play(`${family}_step`, { volume: 0.55 + 0.45 * hard, pitch: 1 - 0.12 * hard, at });
                if (hard > 0.75) sound.play('fall', { volume: 0.5 * hard, at });
                this._walked = 0;
            }
            const run = Math.min(1, Math.max(0, (s.speed - 4.4) / 2.5));
            this._walked += s.speed * dt;
            if (s.speed > 0.6 && this._walked >= STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * run) {
                this._walked = 0;
                sound.play(`${family}_step`, { volume: (s.sneaking ? 0.2 : 0.42) + 0.22 * run, at });
            }
        }
        this._airTime = s.onGround || s.inWater ? 0 : this._airTime + dt;
        this._wasGround = s.onGround;
    }

    /** The loops: each eased toward how much of it there should be. */
    _ambience(dt, s) {
        const a = this._amb;
        const open = Math.max(0, Math.min(1, (s.skyLight - 0.35) / 0.5));       // out of doors
        const dry = Math.max(0, 1 - s.rain * 2.5);
        const day = Math.max(0, Math.min(1, (s.sun + 0.02) / 0.22));
        const night = Math.max(0, Math.min(1, (-s.sun - 0.06) / 0.2));
        const under = s.headInWater ? 1 : 0;
        // Under ground: no sky light to speak of.
        const deep = Math.max(0, Math.min(1, (0.16 - s.skyLight) / 0.14));
        a.birds = ease(a.birds, 0.55 * day * open * dry * (1 - under), 0.6, dt);
        a.crickets = ease(a.crickets, 0.5 * night * open * dry * (1 - under), 0.5, dt);
        a.cave = ease(a.cave, 0.6 * deep * (1 - under), 0.5, dt);
        a.water = ease(a.water, 0.45 * s.nearWater * (1 - under), 0.8, dt);
        a.underwater = ease(a.underwater, 0.7 * under, 3, dt);
        // Ten times a second is plenty: each call writes to an audio parameter.
        this._ambT = (this._ambT ?? 0) + dt;
        if (this._ambT < 0.1) return;
        this._ambT = 0;
        for (const name in a) sound.loop(name, a[name] < 0.01 ? 0 : a[name], 0.6);
    }

    /** A block is being mined: a knock every quarter of a second. Call each frame it is. */
    mining(dt, def, at) {
        this._hitT += dt;
        if (this._hitT < HIT_EVERY) return;
        this._hitT = 0;
        sound.play(`${blockSoundFamily(def)}_hit`, { volume: 0.55, at });
    }
    /** Nothing is being mined: the next knock comes at once. */
    miningStopped() { this._hitT = HIT_EVERY; }

    blockBroken(def, at, volume = 0.9) { sound.play(`${blockSoundFamily(def)}_break`, { volume, at }); }
    blockPlaced(def, at, volume = 0.8) {
        if (def?.liquid) sound.play('water_swim', { volume: 0.6, at });
        else sound.play(`${blockSoundFamily(def)}_place`, { volume, at });
    }

    /** Eating: a bite now and then while the food goes down. */
    eating(dt, on) {
        if (!on) { this._eatT = 0.2; return; }
        this._eatT += dt;
        if (this._eatT >= 0.3) { this._eatT = 0; sound.play('eat', { volume: 0.55 }); }
    }

    hurt(amount) { sound.play('player_hurt', { volume: Math.min(1, 0.5 + amount / 20) }); }
    swing() { sound.play('swing', { volume: 0.5 }); }
    struck(at) { sound.play('punch', { volume: 0.8, at }); }
    pickup() { sound.play('pickup', { volume: 0.5 }); }
    bowDraw() { sound.play('bow_draw', { volume: 0.5 }); }
    bowShoot() { sound.play('bow_shoot', { volume: 0.7 }); }
    arrowHit(at) { sound.play('arrow_hit', { volume: 0.8, at, reach: 40 }); }

    /** Leaving the world: the loops stop. */
    end() {
        for (const name in this._amb) this._amb[name] = 0;
        sound.stopLoops();
        sound.setMuffled(false);
    }
}
