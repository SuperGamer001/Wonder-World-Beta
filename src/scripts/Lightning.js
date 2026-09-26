/**
 * Lightning — bolts, and the flashes that light the sky, clouds and ground.
 *
 * A strike is a jagged channel from the cloud base to the ground, built by
 * midpoint displacement, with a few forked branches that fade out before
 * reaching the ground. Like real lightning it flickers: one to four return
 * strokes down the same channel a few hundredths of a second apart, then a
 * short afterglow. Cloud-to-cloud discharges light the cloud from inside with
 * no visible bolt.
 *
 * Bolts are camera-facing ribbons, one instance per segment, drawn additively
 * in one draw call from a fixed pool — a strike writes into preallocated
 * buffers and allocates nothing but its tiny stroke list.
 *
 * `flash` (0..~1) is the brightness the rest of the atmosphere adds, already
 * reduced with distance; `flashPos` is where the brightest discharge is, for
 * the clouds. The Reduce Motion accessibility setting damps every flash — rapid
 * bright flicker is a photosensitivity trigger.
 */

import * as THREE from 'three';
import { ATMOS_GLSL } from './AtmosGLSL.js';

const MAX_BOLTS = 3;
const SEGS_PER_BOLT = 256;
const MAX_SEGS = MAX_BOLTS * SEGS_PER_BOLT;

const VERT = ATMOS_GLSL + `
in vec3 aA;
in vec3 aB;
in vec3 aW;               // width, brightness, bolt index
uniform float uBolt[${MAX_BOLTS}];
out vec2 vUv;
out float vB;
void main() {
    vec3 p = mix(aA, aB, position.y + 0.5);
    vec3 dir = normalize(aB - aA + vec3(1e-5));
    vec3 side = cross(dir, normalize(cameraPosition - p));
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
    float dist = length(cameraPosition - p);
    p += side * position.x * aW.x * (1.0 + 0.004 * dist);   // stays visible far away
    vUv = uv;
    vB = aW.y * uBolt[int(aW.z + 0.5)] * (1.0 - 0.75 * weatherFog(cameraPosition, p - cameraPosition));
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = `
in vec2 vUv;
in float vB;
out vec4 fragColor;
void main() {
    float core = 1.0 - abs(vUv.x * 2.0 - 1.0);
    float a = core * core * vB;
    if (a < 0.003) discard;
    fragColor = vec4(vec3(0.82, 0.87, 1.0) * a * 2.5, 1.0);
}
`;

export class Lightning {
    constructor(scene, atmos) {
        this.scene = scene;
        const quad = new THREE.PlaneGeometry(1, 1);
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        geo.setAttribute('uv', quad.getAttribute('uv'));
        this.aA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGS * 3), 3);
        this.aB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGS * 3), 3);
        this.aW = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SEGS * 3), 3);
        for (const a of [this.aA, this.aB, this.aW]) a.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute('aA', this.aA);
        geo.setAttribute('aB', this.aB);
        geo.setAttribute('aW', this.aW);
        geo.instanceCount = MAX_SEGS;
        this.geometry = geo;
        this.uniforms = { ...atmos, uBolt: { value: new Float32Array(MAX_BOLTS) } };
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: this.uniforms,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 12;
        this.mesh.visible = false;
        scene.add(this.mesh);

        // Per-bolt state; a free slot has age < 0.
        this.bolts = Array.from({ length: MAX_BOLTS }, () => ({ age: -1, strokes: [], end: 0, x: 0, y: 0, z: 0, dist: 1, cloud: false }));
        this.flash = 0;
        this.flashPos = new THREE.Vector3();
        this.flashAmt = 0;
        this.reduce = false;           // Reduce Motion
        this._pts = new Float32Array(130 * 3);
        this._tmp = new Float32Array(130 * 3);
    }

    _slot() {
        let best = this.bolts[0];
        for (const b of this.bolts) {
            if (b.age < 0) return b;
            if (b.age > best.age) best = b;
        }
        return best;
    }

    /** Stroke times for one discharge. */
    _strokes(b, rand) {
        b.strokes.length = 0;
        const n = 1 + Math.floor(rand() * 3.2);
        let t = 0;
        for (let i = 0; i < n; i++) {
            b.strokes.push(t);
            t += 0.04 + rand() * 0.09;
        }
        b.end = t + 0.45;
        b.age = 0;
    }

    /** A cloud-to-ground strike from (x, cloudY, z) to the ground at gy. */
    strike(x, z, gy, cloudY, dist, rand = Math.random) {
        const b = this._slot();
        const idx = this.bolts.indexOf(b);
        b.x = x; b.y = gy; b.z = z; b.dist = dist; b.cloud = false;
        this._strokes(b, rand);

        // Main channel: start under the cloud a little off the strike point.
        const top = [x + (rand() - 0.5) * 30, cloudY, z + (rand() - 0.5) * 30];
        let seg = idx * SEGS_PER_BOLT;
        const end = seg + SEGS_PER_BOLT;
        const n = this._channel(top, [x, gy, z], 7, 0.32, rand);
        seg = this._emit(this._pts, n, seg, end, 0.42, 1.0, idx);

        // Branches: fork off the upper part of the channel and die away.
        const branches = 3 + Math.floor(rand() * 4);
        const main = this._pts.slice(0, n * 3);
        for (let k = 0; k < branches && seg < end - 20; k++) {
            const at = Math.floor((0.1 + rand() * 0.55) * (n - 1));
            const s = [main[at * 3], main[at * 3 + 1], main[at * 3 + 2]];
            const len = 14 + rand() * 38;
            const a = rand() * Math.PI * 2;
            const e = [s[0] + Math.cos(a) * len * 0.8, s[1] - len * (0.4 + rand() * 0.5), s[2] + Math.sin(a) * len * 0.8];
            if (e[1] < gy + 4) e[1] = gy + 4;
            const m = this._channel(s, e, 4, 0.4, rand);
            seg = this._emit(this._pts, m, seg, end, 0.2, 0.55, idx, true);
        }
        // Park the rest of this bolt's segments.
        for (; seg < end; seg++) this.aW.array[seg * 3 + 1] = 0;
        this._touch();
    }

    /** A discharge inside the cloud: light, no bolt. */
    cloudFlash(x, z, cloudY, dist, rand = Math.random) {
        const b = this._slot();
        const idx = this.bolts.indexOf(b);
        b.x = x; b.y = cloudY + 10; b.z = z; b.dist = dist; b.cloud = true;
        this._strokes(b, rand);
        for (let s = idx * SEGS_PER_BOLT, e = s + SEGS_PER_BOLT; s < e; s++) this.aW.array[s * 3 + 1] = 0;
        this._touch();
    }

    /** Midpoint displacement from a to b into this._pts; returns the point count. */
    _channel(a, b, levels, rough, rand) {
        let pts = this._pts, tmp = this._tmp;
        pts[0] = a[0]; pts[1] = a[1]; pts[2] = a[2];
        pts[3] = b[0]; pts[4] = b[1]; pts[5] = b[2];
        let n = 2;
        for (let l = 0; l < levels; l++) {
            let m = 0;
            for (let i = 0; i < n - 1; i++) {
                const o = i * 3;
                const ax = pts[o], ay = pts[o + 1], az = pts[o + 2];
                const bx = pts[o + 3], by = pts[o + 4], bz = pts[o + 5];
                const len = Math.hypot(bx - ax, by - ay, bz - az);
                tmp[m++] = ax; tmp[m++] = ay; tmp[m++] = az;
                tmp[m++] = (ax + bx) / 2 + (rand() - 0.5) * len * rough;
                tmp[m++] = (ay + by) / 2 + (rand() - 0.5) * len * rough * 0.4;
                tmp[m++] = (az + bz) / 2 + (rand() - 0.5) * len * rough;
            }
            const o = (n - 1) * 3;
            tmp[m++] = pts[o]; tmp[m++] = pts[o + 1]; tmp[m++] = pts[o + 2];
            n = m / 3;
            const s = pts; pts = tmp; tmp = s;
        }
        if (pts !== this._pts) this._pts.set(pts.subarray(0, n * 3));
        return n;
    }

    _emit(pts, n, seg, end, width, bright, idx, taper = false) {
        const A = this.aA.array, B = this.aB.array, W = this.aW.array;
        for (let i = 0; i < n - 1 && seg < end; i++, seg++) {
            const o = i * 3, f = taper ? 1 - i / (n - 1) : 1;
            A[seg * 3] = pts[o]; A[seg * 3 + 1] = pts[o + 1]; A[seg * 3 + 2] = pts[o + 2];
            B[seg * 3] = pts[o + 3]; B[seg * 3 + 1] = pts[o + 4]; B[seg * 3 + 2] = pts[o + 5];
            W[seg * 3] = width * (0.4 + 0.6 * f);
            W[seg * 3 + 1] = bright * f;
            W[seg * 3 + 2] = idx;
        }
        return seg;
    }

    _touch() {
        this.aA.needsUpdate = this.aB.needsUpdate = this.aW.needsUpdate = true;
        this.mesh.visible = true;
    }

    update(dt) {
        let flash = 0, best = 0;
        const I = this.uniforms.uBolt.value;
        let any = false;
        for (let i = 0; i < MAX_BOLTS; i++) {
            const b = this.bolts[i];
            if (b.age < 0) { I[i] = 0; continue; }
            b.age += dt;
            if (b.age > b.end) { b.age = -1; I[i] = 0; continue; }
            any = true;
            let v = 0;
            for (const t of b.strokes) if (b.age >= t) v += Math.exp(-(b.age - t) * 28);
            v = Math.min(1.4, v + 0.25 * Math.exp(-b.age * 5));
            I[i] = b.cloud ? 0 : v;
            const lit = v * (b.cloud ? 0.5 : 1) / (1 + b.dist / 140);
            flash += lit;
            if (lit > best) { best = lit; this.flashPos.set(b.x, b.y, b.z); }
        }
        this.mesh.visible = any;
        const damp = this.reduce ? 0.2 : 1;
        this.flash = Math.min(1, flash) * damp;
        this.flashAmt = Math.min(1.2, best * 1.6) * damp;
    }

    clear() {
        for (const b of this.bolts) b.age = -1;
        this.uniforms.uBolt.value.fill(0);
        this.flash = this.flashAmt = 0;
        this.mesh.visible = false;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.geometry.dispose();
        this.material.dispose();
    }
}
