/**
 * PlayerModel — a player's body: the Quiddle model in the look the player
 * chose (their "skin": engine/MobModelDefs.js `QUIDDLE_LOOKS`), moved by what
 * the player is doing.
 *
 * The one class draws every player there is: yourself in third person (and
 * your shadow in first person, where the body itself is not drawn), the other
 * players of a LAN or split-screen game, and the figure on the character
 * screen and in the menu. It is told a handful of things each frame — where
 * the player is, which way they face and look, how fast they move, whether
 * they are on the ground, in water, striking, hurt — and the Quiddle's own
 * animator (MobAnim.js) does the rest: the stride follows the ground covered,
 * so feet that are down stay down, the head turns to where the player looks.
 *
 * A body turns more slowly than a head: the head follows the look at once,
 * and the body comes round after it when the player moves or has looked more
 * than a little way to the side.
 */

import { MobModels } from './MobModels.js';
import { GAITS } from './engine/MobAnim.js';

/** The look a new player starts with. */
export const DEFAULT_SKIN = { sex: 0, build: 1, arms: 1, legs: 1, height: 2, skin: 1, outfit: 0, eyes: 0, hair: 0, hairColor: 0 };

/** A skin with every choice in range (anything missing or wrong is the default's). */
export function cleanSkin(raw, model) {
    const out = {};
    for (const [k, n] of Object.entries(model.variants)) {
        const v = Number(raw?.[k]);
        out[k] = Number.isInteger(v) && v >= 0 && v < n ? v : (DEFAULT_SKIN[k] ?? 0);
    }
    return out;
}

const WALK = 5, SPRINT = 8;          // PlayerPhysics: blocks a second
const NECK = 1.0;                    // how far the head turns from the body before the body follows, radians
const SWING_TIME = 0.32;             // seconds a blow takes
const SHADOW_LAYER_DYNAMIC = 2;      // Shadows.js: casters that move every frame
const ease = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

export class PlayerModel {
    /**
     * @param {MobModels} models  loaded (EntityManager's, or one of your own)
     * @param {object} skin       the look: a choice for each of QUIDDLE_LOOKS
     */
    constructor(models, skin) {
        this.models = models;
        this.inst = null;
        this.mesh = null;
        this.bodyYaw = null;         // which way the body faces (the model's yaw), once known
        this._swing = 0;             // 0, or seconds into a blow
        this._dir = [0, 1, 0];
        this.setSkin(skin);
    }

    /** Change the look. The mesh is a new one: add `mesh` to the scene again. */
    setSkin(skin) {
        const parent = this.mesh?.parent ?? null, visible = this.mesh?.visible ?? true, layers = this.mesh?.layers.mask;
        const anim = this.inst?.anim;
        this._drop();
        const model = this.models.model('quiddle');
        this.skin = cleanSkin(skin, model);
        this.inst = this.models.create('quiddle', this.skin, 1);
        if (anim) Object.assign(this.inst.anim, anim);       // keep the stride it was in
        this.mesh = this.inst.mesh;
        this.mesh.name = 'player';
        this.mesh.visible = visible;
        if (layers != null) this.mesh.layers.mask = layers;
        parent?.add(this.mesh);
        return this.mesh;
    }

    /**
     * Whether the body is drawn in the view, and whether it casts a shadow.
     * In first person it is not drawn but its shadow is.
     */
    show(inView, shadow = true) {
        const l = this.mesh.layers;
        if (inView) l.enable(0); else l.disable(0);
        if (shadow) l.enable(SHADOW_LAYER_DYNAMIC); else l.disable(SHADOW_LAYER_DYNAMIC);
        this.mesh.visible = inView || shadow;
    }

    /** How tall this player stands, blocks. */
    get height() { return 1.81 * this.inst.scale; }

    /** A sphere round the body for the shadow mapper: [x, y, z, radius] into `out` at `o`. */
    caster(out, o) {
        const s = this.mesh.geometry.boundingSphere, p = this.mesh.position;
        out[o] = p.x; out[o + 1] = p.y + s.center.y; out[o + 2] = p.z; out[o + 3] = s.radius;
    }

    /** Begin a blow (the right arm drawn back and thrown). False if one is still under way. */
    swing() {
        if (this._swing !== 0 && this._swing <= SWING_TIME * 0.6) return false;
        this._swing = 1e-4;
        return true;
    }

    /**
     * @param {number} dt
     * @param {object} s {
     *   x, y, z     the feet
     *   yaw, pitch  the way the player looks (the camera's: yaw 0 is −z)
     *   speed       over the ground, blocks/s
     *   onGround, inWater
     *   hurt        0 … 1, just struck
     *   dead        lying where they fell
     *   light       how lit the body is, 0 … 1 (default 1)
     *   lightDir    unit vector toward the sun or moon, or null
     *   still       do not advance the animation (the game is paused)
     * }
     */
    update(dt, s) {
        const inst = this.inst, a = inst.anim;
        // The model faces +z; a camera yaw of 0 looks along −z.
        const look = s.yaw + Math.PI;
        if (this.bodyYaw == null) this.bodyYaw = look;
        if (!s.still) {
            // The body follows the head: at once when moving, lazily when
            // standing — and never lets the head turn further than a neck does.
            let off = wrap(look - this.bodyYaw);
            const moving = s.speed > 0.4 || this._swing > 0;
            if (moving) this.bodyYaw += off * (1 - Math.exp(-12 * dt));
            else if (Math.abs(off) > NECK) this.bodyYaw += off - Math.sign(off) * NECK;
            off = wrap(look - this.bodyYaw);

            a.time += dt;
            a.move = ease(a.move, Math.min(1, s.speed / WALK), 10, dt);
            a.run = ease(a.run, Math.min(1, Math.max(0, (s.speed - WALK) / (SPRINT - WALK))), 6, dt);
            const gait = GAITS.quiddle;
            // The walk's stride is the model's own; a player walks faster than
            // a Quiddle does, so the stride lengthens with the pace.
            const stride = (gait.walk + (gait.run - gait.walk) * Math.max(a.run, Math.min(1, s.speed / WALK) * 0.45)) * inst.scale;
            a.phase += s.speed * dt * (Math.PI * 2) / stride;
            a.air = ease(a.air, !s.dead && !s.onGround && !s.inWater ? 1 : 0, 12, dt);
            a.swim = ease(a.swim, s.inWater ? 1 : 0, 6, dt);
            a.hurt = s.hurt ?? 0;
            if (this._swing > 0) {
                this._swing += dt;
                if (this._swing >= SWING_TIME) this._swing = 0;
            }
            a.attack = this._swing / SWING_TIME;
            a.lookYaw = ease(a.lookYaw, Math.max(-NECK, Math.min(NECK, off)), 14, dt);
            a.lookPitch = ease(a.lookPitch, Math.max(-0.9, Math.min(0.9, -s.pitch * 0.8)), 14, dt);
            inst.death = ease(inst.death, s.dead ? 1 : 0, 6, dt);
            inst.tint[1] = inst.tint[2] = 1 - 0.5 * (s.hurt ?? 0);
        }
        this.mesh.position.set(s.x, s.y, s.z);
        this.mesh.rotation.y = this.bodyYaw;
        this.models.pose(inst, s.light ?? 1, s.lightDir ? MobModels.toModelSpace(s.lightDir, this.bodyYaw, this._dir) : null);
    }

    _drop() {
        if (!this.inst) return;
        this.mesh.parent?.remove(this.mesh);
        this.models.release(this.inst);
        this.inst = this.mesh = null;
    }

    dispose() { this._drop(); }
}
