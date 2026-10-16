/**
 * Hands — the player's own hands, seen in first person: one at the bottom
 * left of the screen and one at the bottom right, as if held out a little in
 * front.
 *
 * They are the player's body (the Quiddle in their look: their skin, their
 * sleeves), not a drawing of hands: a second copy of the model, of which only
 * the arms are drawn (the triangles whose vertices follow an arm's bones), held
 * up in front of its own eyes and drawn over the world with a camera of its
 * own. So they need nothing kept in step with the model or its textures, and
 * an outfit with long sleeves shows them.
 *
 * They move as the player does: they bob with each stride, sway a little at
 * rest, come forward when crouching, and the right one swings when the player
 * mines, strikes or puts something down (`swing`). They are lit by the light
 * where the player stands, as the body is.
 *
 * The camera is fixed (`FOV`): the hands are the same size whatever field of
 * view the player has chosen, and do not swim when the bow zooms.
 */
import * as THREE from 'three';
import { MobModels } from './MobModels.js';
import { PX } from './engine/MobShapes.js';

const FOV = 62;                          // degrees, the hands' own camera
// How they are held, and seen: the camera's place in the model (px) and how far
// it looks down (radians); the upper arm's lift forward and turn out (radians;
// 0 hangs, −π/2 straight ahead), and the elbow's bend.
const HOLD = { eye: [0, 24.2, -2.4], down: 0.02, lift: -1.33, out: 0.26, elbow: -0.5 };
const ARMS = ['armL', 'foreL', 'handL', 'fingersL', 'armR', 'foreR', 'handR', 'fingersR'];
const SWING_TIME = 0.28;                 // seconds a swing of the right hand takes
const ease = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));

export class Hands {
    /** @param {MobModels} models  loaded (the EntityManager's) */
    constructor(models) {
        this.models = models;
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.02, 8);
        this.inst = null;
        this.visible = true;
        this._swing = 0;                 // 0, or seconds into a swing
        this._walk = 0;                  // eased: 0 still … 1 walking or faster
        this._crouch = 0;
        this._phase = 0;                 // the stride, radians
        this._t = 0;
        this._dir = [0, 1, 0];
        this._skinKey = '';
        this.hold = { ...HOLD };
    }

    /** Where the camera is in the model, and where it looks (after a change to `hold`). */
    _aim() {
        if (!this.inst) return;
        const k = PX * this.inst.scale, e = this.hold.eye;
        this.camera.position.set(e[0] * k, e[1] * k, e[2] * k);
        this.camera.lookAt(e[0] * k, e[1] * k - Math.tan(this.hold.down), e[2] * k + 1);
    }

    /** Wear this look (the player's skin). */
    setSkin(skin) {
        const key = JSON.stringify(skin ?? {});
        if (key === this._skinKey && this.inst) return;
        this._skinKey = key;
        this._drop();
        const inst = this.models.create('quiddle', skin ?? {}, 1);
        if (!inst) return;
        this.inst = inst;
        // Only the arms: a triangle all of whose corners follow an arm's bones.
        const P = inst.model.index, st = inst.st;
        const arm = new Uint8Array(inst.model.parts.length);
        for (const n of ARMS) if (P[n] !== undefined) arm[P[n]] = 1;
        const bone = new Int16Array(st.verts);
        for (let r = 0; r < st.runs.length; r += 4) bone.fill(st.runs[r], st.runs[r + 2], st.runs[r + 3]);
        const all = st.index.array, keep = [];
        for (let i = 0; i < all.length; i += 3) {
            if (arm[bone[all[i]]] && arm[bone[all[i + 1]]] && arm[bone[all[i + 2]]]) keep.push(all[i], all[i + 1], all[i + 2]);
        }
        const g = inst.mesh.geometry;
        g.setIndex(new THREE.BufferAttribute(st.verts > 65535 ? new Uint32Array(keep) : new Uint16Array(keep), 1));
        // … and only their vertices are posed each frame (a run is the vertices of one bone).
        const runs = [];
        for (let r = 0; r < st.runs.length; r += 4) if (arm[st.runs[r]]) runs.push(st.runs[r], st.runs[r + 1], st.runs[r + 2], st.runs[r + 3]);
        inst.runs = Int32Array.from(runs);
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e4);
        inst.mesh.frustumCulled = false;
        inst.mesh.name = 'hands';
        inst.after = (pose, a) => this._hold(pose, a);
        this.scene.add(inst.mesh);
        this._aim();
    }

    /** The right hand swings (mining, a blow, putting something down). */
    swing() {
        if (this._swing === 0 || this._swing > SWING_TIME * 0.7) this._swing = 1e-4;
    }

    /**
     * @param {object} s { speed (blocks/s), crouch, light (0 … 1), lightDir (toward the sun or moon, world), yaw (the look), still }
     */
    update(dt, s) {
        const inst = this.inst;
        if (!inst) return;
        if (!s.still) {
            this._t += dt;
            this._walk = ease(this._walk, Math.min(1, (s.speed ?? 0) / 5), 8, dt);
            this._crouch = ease(this._crouch, s.crouch ? 1 : 0, 10, dt);
            this._phase += (s.speed ?? 0) * dt * Math.PI / 1.1;
            if (this._swing > 0) { this._swing += dt; if (this._swing >= SWING_TIME) this._swing = 0; }
        }
        // A bob with each stride, a sway at rest.
        const m = inst.mesh, w = this._walk;
        m.position.set(Math.sin(this._phase) * 0.018 * w, -Math.abs(Math.cos(this._phase)) * 0.022 * w + Math.sin(this._t * 1.3) * 0.004, 0);
        const ld = s.lightDir ? MobModels.toModelSpace(s.lightDir, (s.yaw ?? 0) + Math.PI, this._dir) : null;
        this.models.pose(inst, s.light ?? 1, ld);
    }

    /** The arms held out in front of the eyes, a little bent; the right one swinging. */
    _hold(pose, a) {
        const P = this.inst.model.index, r = pose.r, t = pose.t;
        // Nothing below the shoulders moves them: the walk is in the bob (update).
        for (const b of ['hips', 'torso']) { const i = P[b]; if (i === undefined) continue; r[i * 3] = r[i * 3 + 1] = r[i * 3 + 2] = 0; t[i * 3] = t[i * 3 + 1] = t[i * 3 + 2] = 0; }
        const k = this._swing > 0 ? this._swing / SWING_TIME : 0, arc = Math.sin(k * Math.PI), c = this._crouch, h = this.hold;
        for (const [side, up, fore, hand, fingers] of [[1, 'armL', 'foreL', 'handL', 'fingersL'], [-1, 'armR', 'foreR', 'handR', 'fingersR']]) {
            const swing = side < 0 ? arc : 0;
            r[P[up] * 3] = h.lift - 0.08 * c + swing * 0.7;             // forward from the shoulder; down through a swing
            r[P[up] * 3 + 1] = side * (h.out - swing * 0.45);            // out from the middle (+ turns toward the model's left), in to strike
            r[P[up] * 3 + 2] = side * 0.12;
            r[P[fore] * 3] = h.elbow + swing * 0.3;                      // the elbow a little bent, straightening as it strikes
            r[P[hand] * 3] = -0.18 - swing * 0.2;
            r[P[fingers] * 3 + 2] = -side * (0.55 + swing * 0.5);       // loosely closed
            const sway = Math.sin(this._t * 1.6 + side) * 0.012;
            r[P[up] * 3] += sway;
        }
    }

    /** Draw them over what has been drawn (the depth is cleared first). */
    render(renderer, aspect) {
        if (!this.inst || !this.visible) return;
        if (this.camera.aspect !== aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
        const clear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClear = clear;
    }

    _drop() {
        if (!this.inst) return;
        const inst = this.inst;
        this.scene.remove(inst.mesh);
        // The geometry goes back to the pool for the next Quiddle: with all of it drawn again.
        inst.mesh.geometry.setIndex(inst.st.index);
        inst.after = null; inst.runs = null;
        this.models.release(inst);
        this.inst = null;
    }

    dispose() { this._drop(); this._skinKey = ''; }
}
