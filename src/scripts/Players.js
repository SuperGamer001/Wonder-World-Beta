/**
 * Players — the other players of the world, as this game shows them: each a
 * Quiddle in the look they chose (PlayerModel.js), with their name over it.
 *
 * What is known of another player is what their game last said (engine/
 * Multiplayer.js: about fifteen times a second): where they are, which way
 * they look, how fast they move and a few yes-or-noes. Between one telling
 * and the next they are moved smoothly toward the latest, so a player walks
 * rather than hops; a jump of more than a few blocks (they were sent
 * somewhere, or have only just arrived) is taken at once.
 *
 * `packState` and the reading of it in `state()` are the two ends of that
 * message, kept side by side here.
 */

import * as THREE from 'three';
import { PlayerModel } from './PlayerModel.js';

const ON_GROUND = 1, IN_WATER = 2, DEAD = 4, HIDDEN = 8;
const SNAP = 6;              // blocks: a move longer than this is not walked
const r2 = (v) => Math.round(v * 100) / 100;

/** What this game tells the others about its player, as an array. */
export function packState(p, yaw, pitch, speed, o) {
    return [r2(p.x), r2(p.y), r2(p.z), r2(yaw), r2(pitch), r2(speed),
        (o.onGround ? ON_GROUND : 0) | (o.inWater ? IN_WATER : 0) | (o.dead ? DEAD : 0) | (o.hidden ? HIDDEN : 0),
        o.swings | 0, r2(o.hurt ?? 0)];
}

/** A name on a little board, to hang over a head. */
function nameTag(name) {
    const cv = document.createElement('canvas'), cx = cv.getContext('2d');
    const font = '600 30px system-ui, "Segoe UI", sans-serif';
    cx.font = font;
    cv.width = Math.min(512, Math.ceil(cx.measureText(name).width) + 28);
    cv.height = 44;
    cx.font = font;
    cx.fillStyle = 'rgba(24, 25, 28, 0.62)';
    cx.beginPath();
    cx.roundRect(0, 0, cv.width, cv.height, 10);
    cx.fill();
    cx.fillStyle = '#f2f2f0';
    cx.textBaseline = 'middle';
    cx.fillText(name, 14, cv.height / 2 + 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
    sprite.scale.set(0.3 * cv.width / cv.height, 0.3, 1);
    sprite.renderOrder = 5;
    return sprite;
}

export class RemotePlayers {
    /**
     * @param {THREE.Scene} scene
     * @param {MobModels} models   loaded (the EntityManager's)
     */
    constructor(scene, models) {
        this.scene = scene;
        this.models = models;
        this.map = new Map();        // id → { id, name, model, tag, x, y, z, yaw, pitch, speed, flags, hurt, swings, at }
    }

    get size() { return this.map.size; }

    add(p) {
        if (this.map.has(p.id)) this.remove(p.id);
        const model = new PlayerModel(this.models, p.skin);
        model.show(false, false);                           // until it is known where they are
        this.scene.add(model.mesh);
        const tag = nameTag(p.name);
        tag.visible = false;
        this.scene.add(tag);
        const e = { id: p.id, name: p.name, model, tag, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, flags: 0, hurt: 0, swings: -1, at: null };
        this.map.set(p.id, e);
        if (p.state) this.state(p.id, p.state);
        return e;
    }

    /** A new name or a new look. */
    profile(p) {
        const e = this.map.get(p.id);
        if (!e) return;
        if (p.name !== e.name) {
            this._dropTag(e);
            e.name = p.name;
            e.tag = nameTag(p.name);
            this.scene.add(e.tag);
        }
        this.scene.add(e.model.setSkin(p.skin));
    }

    /** What their game last said. */
    state(id, s) {
        const e = this.map.get(id);
        if (!e || !Array.isArray(s)) return;
        const first = e.at === null;
        e.at = { x: s[0], y: s[1], z: s[2] };
        e.yaw = s[3]; e.pitch = s[4]; e.speed = s[5]; e.flags = s[6] | 0; e.hurt = s[8] ?? 0;
        if (first || Math.hypot(s[0] - e.x, s[1] - e.y, s[2] - e.z) > SNAP) { e.x = s[0]; e.y = s[1]; e.z = s[2]; }
        // A blow is counted by its player; a new count is a new blow.
        if (e.swings !== -1 && s[7] !== e.swings) e.model.swing();
        e.swings = s[7];
    }

    remove(id) {
        const e = this.map.get(id);
        if (!e) return;
        e.model.dispose();
        this._dropTag(e);
        this.map.delete(id);
    }

    _dropTag(e) {
        this.scene.remove(e.tag);
        e.tag.material.map.dispose();
        e.tag.material.dispose();
    }

    /**
     * Move, animate and light them.
     * @param {(x, y, z) => number} lightAt  how lit a place is
     * @param {number[]|null} lightDir       toward the sun or moon
     * @param {boolean} shadows              whether they cast one
     */
    update(dt, lightAt, lightDir, shadows = true) {
        const k = 1 - Math.exp(-dt * 16);
        for (const e of this.map.values()) {
            if (!e.at) continue;
            e.x += (e.at.x - e.x) * k; e.y += (e.at.y - e.y) * k; e.z += (e.at.z - e.z) * k;
            const hidden = !!(e.flags & HIDDEN);
            e.model.show(!hidden, !hidden && shadows);
            e.tag.visible = !hidden;
            e.model.update(dt, {
                x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, speed: e.speed,
                onGround: !!(e.flags & ON_GROUND), inWater: !!(e.flags & IN_WATER), dead: !!(e.flags & DEAD), hurt: e.hurt,
                light: lightAt ? lightAt(e.x, e.y + 1, e.z) : 1, lightDir,
            });
            e.tag.position.set(e.x, e.y + e.model.height + 0.38, e.z);
        }
    }

    /** Where they are, for the mobs to mind: [{ id, x, y, z }] (reused). */
    positions(out) {
        out.length = 0;
        for (const e of this.map.values()) if (e.at && !(e.flags & (HIDDEN | DEAD))) out.push({ id: e.id, x: e.x, y: e.y, z: e.z });
        return out;
    }

    /** Their spheres, for the shadow mapper: writers for EntityManager.extraCasters. */
    casters() {
        return [...this.map.values()].filter(e => e.at && !(e.flags & HIDDEN)).map(e => (out, o) => e.model.caster(out, o));
    }

    dispose() {
        for (const id of [...this.map.keys()]) this.remove(id);
    }
}
