/**
 * Particles — small debris cubes (Graphics → Particles).
 *
 * A burst of fragments when a block breaks, blown by the wind (`wind`, set by
 * world.js from the weather). The level is also the density knob for weather
 * (Precipitation.js reads `particles.scale`, 0 off … 1 high).
 *
 * Every particle is an instance of one InstancedMesh — a single draw call
 * however many are alive — and the pool is fixed, so a burst never allocates.
 */

import * as THREE from 'three';

export const PARTICLE_LEVELS = { off: 0, low: 0.35, medium: 0.6, high: 1 };

const MAX       = 1024;   // pool size
const BURST     = 8;      // fragments per broken block at level "high" (medium 5, low 3)
const GRAVITY   = -22;
const LIFETIME  = 0.6;    // seconds, ± 30%
const SIZE      = 0.14;
const WIND_DRAG = 1.5;    // 1/s — how quickly airborne debris picks up the wind

export class Particles {
    /**
     * @param {THREE.Scene} scene
     * @param {(x:number, y:number, z:number) => boolean} solidAt  collision test
     */
    constructor(scene, solidAt) {
        this.scene   = scene;
        this.solidAt = solidAt;
        this.level   = 'medium';
        this.scale   = PARTICLE_LEVELS.medium;

        this.mesh = new THREE.InstancedMesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshLambertMaterial({ color: 0xffffff }),
            MAX);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);

        // Struct-of-arrays pool: position, velocity, age, lifetime.
        this.p    = new Float32Array(MAX * 3);
        this.v    = new Float32Array(MAX * 3);
        this.age  = new Float32Array(MAX);
        this.life = new Float32Array(MAX);
        this.live = 0;
        this.wind = [0, 0];      // blocks/s

        this._m = new THREE.Matrix4();
        this._c = new THREE.Color();
    }

    setLevel(level) {
        this.level = level in PARTICLE_LEVELS ? level : 'medium';
        this.scale = PARTICLE_LEVELS[this.level];
        if (this.scale === 0) { this.live = 0; this.mesh.count = 0; }
    }

    /** Debris from a broken block centred at (x, y, z), in the block's colour [r,g,b]. */
    burst(x, y, z, rgb) {
        const n = Math.round(BURST * this.scale);
        for (let k = 0; k < n && this.live < MAX; k++) {
            const i = this.live++;
            this.p[i * 3]     = x + (Math.random() - 0.5) * 0.7;
            this.p[i * 3 + 1] = y + (Math.random() - 0.5) * 0.7;
            this.p[i * 3 + 2] = z + (Math.random() - 0.5) * 0.7;
            this.v[i * 3]     = (Math.random() - 0.5) * 4;
            this.v[i * 3 + 1] = 2 + Math.random() * 4;
            this.v[i * 3 + 2] = (Math.random() - 0.5) * 4;
            this.age[i]  = 0;
            this.life[i] = LIFETIME * (0.7 + Math.random() * 0.6);
            const shade = 0.8 + Math.random() * 0.3;
            this.mesh.setColorAt(i, this._c.setRGB(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade));
        }
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    update(dt) {
        if (!this.live) return;
        const p = this.p, v = this.v;
        const wk = 1 - Math.exp(-WIND_DRAG * dt), wx = this.wind[0], wz = this.wind[1];
        let i = 0;
        while (i < this.live) {
            this.age[i] += dt;
            if (this.age[i] >= this.life[i]) { this._kill(i); continue; }
            const o = i * 3;
            v[o + 1] += GRAVITY * dt;
            v[o] += (wx - v[o]) * wk;
            v[o + 2] += (wz - v[o + 2]) * wk;
            const nx = p[o] + v[o] * dt, ny = p[o + 1] + v[o + 1] * dt, nz = p[o + 2] + v[o + 2] * dt;
            if (this.solidAt(nx, ny, nz)) {
                // Land: bounce a little and skid.
                v[o] *= 0.4; v[o + 2] *= 0.4; v[o + 1] *= -0.25;
            } else {
                p[o] = nx; p[o + 1] = ny; p[o + 2] = nz;
            }
            const s = SIZE * (1 - 0.6 * (this.age[i] / this.life[i]));
            this._m.makeScale(s, s, s).setPosition(p[o], p[o + 1], p[o + 2]);
            this.mesh.setMatrixAt(i, this._m);
            i++;
        }
        this.mesh.count = this.live;
        this.mesh.instanceMatrix.needsUpdate = true;
        if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    // Swap the last live particle into slot i.
    _kill(i) {
        const last = --this.live;
        if (i === last) return;
        for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[last * 3 + k]; this.v[i * 3 + k] = this.v[last * 3 + k]; }
        this.age[i] = this.age[last];
        this.life[i] = this.life[last];
        this.mesh.getColorAt(last, this._c);
        this.mesh.setColorAt(i, this._c);
    }

    clear() { this.live = 0; this.mesh.count = 0; }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.mesh.dispose();
    }
}
