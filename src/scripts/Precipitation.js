/**
 * Precipitation — rain, snow, sleet and hail, splashes, and airborne dust and ash.
 *
 * Every particle is an instance of one quad and each kind is one draw call.
 * Nothing moves on the CPU: the instances carry fixed random seeds, and the
 * vertex shader places each one inside a box around the camera from the seed,
 * an accumulated fall distance and wind drift (both wrapped to the box, so the
 * wrap is seamless). Per frame the CPU writes a handful of uniforms.
 *
 * Where it falls is decided per particle on the GPU from the shared cloud field
 * (rainMask — AtmosGLSL): a particle only shows when its random rank is below
 * the precipitation intensity at its column, so clear patches stay dry and dark
 * cloud cores rain hardest, exactly under the clouds that are drawn.
 *
 * Nothing falls through roofs, trees or into caves: a heightmap of the highest
 * block in each column around the player (RainHeightmap, fed by the mesh
 * workers) hides particles below it, and splashes sit on it — on water too.
 *
 * Density scales with Graphics → Particles (particles.scale), as Particles.js
 * asks of weather. Off means no weather particles; the fog, sound and wet
 * ground still say it is raining.
 */

import * as THREE from 'three';
import { ATMOS_GLSL, OUTPUT_GLSL } from './AtmosGLSL.js';
import { CHUNK_SIZE, CHUNK_SHIFT } from './engine/ChunkData.js';
import { WorldState } from './engine/WorldState.js';
import { PRECIP, PELLET_SIZE, DUST, ASH, precipShares } from './engine/Weather.js';

// ── Heightmap ─────────────────────────────────────────────────────────────────

const HM_CHUNKS = 9;                       // window of chunks around the player
const HM_SIZE   = HM_CHUNKS * CHUNK_SIZE;  // 144 columns per side
const NO_GROUND = -1e4;

/**
 * Height of the rain-stopping surface in each column around the player: the top
 * of the highest non-air block (leaves, glass and water included). In smooth
 * worlds a deformed top voxel contributes its actual surface height at the
 * column centre.
 *
 * The heights are worked out by the worker with each mesh job (`geo.rain`, see
 * worldWorker) and handed in through setChunk. They used to be computed here,
 * on the render thread, a couple of chunks per frame — in smooth worlds that
 * meant evaluating hundreds of smooth shapes per chunk against the live world,
 * which was a third of the main thread's time while new terrain streamed in.
 * The worker has those shapes already from meshing the chunk.
 */
export class RainHeightmap {
    constructor() {
        this.data = new Float32Array(HM_SIZE * HM_SIZE).fill(NO_GROUND);
        this.texture = new THREE.DataTexture(this.data, HM_SIZE, HM_SIZE, THREE.RedFormat, THREE.FloatType);
        this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
        this.texture.generateMipmaps = false;
        this.texture.needsUpdate = true;
        this.rect = new THREE.Vector4(0, 0, HM_SIZE, 0);   // x0, z0, size
        this.cache = new Map();                             // chunk key → Float32Array(256)
        this.cx0 = null; this.cz0 = null;
        this._stale = true;
    }

    /** Forget every chunk (world load / quit). */
    reset() {
        this.cache.clear();
        this.data.fill(NO_GROUND);
        this.texture.needsUpdate = true;
        this.cx0 = this.cz0 = null;
        this._stale = true;
    }

    _inWindow(cx, cz) {
        return this.cx0 !== null && cx >= this.cx0 && cx < this.cx0 + HM_CHUNKS &&
               cz >= this.cz0 && cz < this.cz0 + HM_CHUNKS;
    }

    /**
     * Rain heights of chunk (cx, cz), from its latest mesh job: world Y per
     * column, x fastest, NaN where the column is empty.
     */
    setChunk(cx, cz, heights) {
        if (!heights) return;
        const out = new Float32Array(CHUNK_SIZE * CHUNK_SIZE);
        for (let i = 0; i < out.length; i++) {
            const h = heights[i];
            out[i] = h === h ? h : NO_GROUND;
        }
        this.cache.set(WorldState.key(cx, cz), out);
        if (this._inWindow(cx, cz)) this._stale = true;
    }

    /** Chunk `key` ("cx,cz") unloaded. */
    drop(key) {
        if (!this.cache.delete(key)) return;
        const c = key.indexOf(',');
        if (this._inWindow(+key.slice(0, c), +key.slice(c + 1))) this._stale = true;
    }

    /** Recentre on the player; rebuild the texture if anything in the window changed. */
    update(px, pz) {
        const half = HM_CHUNKS >> 1;
        const cx0 = (Math.floor(px) >> CHUNK_SHIFT) - half;
        const cz0 = (Math.floor(pz) >> CHUNK_SHIFT) - half;
        if (cx0 !== this.cx0 || cz0 !== this.cz0) {
            this.cx0 = cx0; this.cz0 = cz0;
            this.rect.set(cx0 * CHUNK_SIZE, cz0 * CHUNK_SIZE, HM_SIZE, 0);
            this._stale = true;
        }
        if (this._stale) this._assemble();
    }

    _assemble() {
        this._stale = false;
        const d = this.data;
        for (let j = 0; j < HM_CHUNKS; j++) {
            for (let i = 0; i < HM_CHUNKS; i++) {
                const src = this.cache.get(WorldState.key(this.cx0 + i, this.cz0 + j));
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    const row = (j * CHUNK_SIZE + lz) * HM_SIZE + i * CHUNK_SIZE;
                    if (src) d.set(src.subarray(lz * CHUNK_SIZE, lz * CHUNK_SIZE + CHUNK_SIZE), row);
                    else d.fill(NO_GROUND, row, row + CHUNK_SIZE);
                }
            }
        }
        this.texture.needsUpdate = true;
    }

    /** Surface height at a world column, or null if outside the window / not loaded. */
    heightAt(x, z) {
        if (this.cx0 === null) return null;
        const i = Math.floor(x) - this.rect.x, j = Math.floor(z) - this.rect.y;
        if (i < 0 || j < 0 || i >= HM_SIZE || j >= HM_SIZE) return null;
        const h = this.data[j * HM_SIZE + i];
        return h <= NO_GROUND ? null : h;
    }

    dispose() { this.texture.dispose(); this.cache.clear(); }
}

// ── Particle layers ───────────────────────────────────────────────────────────

const KIND = { rain: 0, snow: 1, pellet: 2, dust: 3, ash: 4, splash: 5 };

const VERT = ATMOS_GLSL + `
in vec4 aSeed;
uniform int   uKind;
uniform vec3  uBox;
uniform vec2  uDrift;
uniform float uFall;
uniform vec3  uVel;
uniform float uAmount;
uniform float uSize;
uniform float uLen;
uniform float uUseMask;
uniform sampler2D uHeight;
uniform vec4  uHeightRect;
out vec2  vUv;
out float vAlpha;
out float vFog;
out vec3  vFogCol;

float groundAt(vec2 xz) {
    vec2 t = (floor(xz) - uHeightRect.xy + 0.5) / uHeightRect.z;
    if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) return -1e4;
    return texture(uHeight, t).r;
}
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

void main() {
    vUv = uv;
    vAlpha = 0.0; vFog = 0.0; vFogCol = vec3(0.0);
    vec3 lo = cameraPosition - uBox * 0.5;
    vec3 wp;
    if (uKind == 5) {
        // Splash: each instance reappears at a new random spot every cycle.
        float cyc = uTime * 1.7 + aSeed.w * 17.0;
        float k = floor(cyc), life = fract(cyc);
        vec2 r = vec2(hash11(k * 13.1 + aSeed.x * 97.0), hash11(k * 7.7 + aSeed.y * 131.0));
        vec3 p = vec3(lo.x + r.x * uBox.x, 0.0, lo.z + r.y * uBox.z);
        p.y = groundAt(p.xz);
        float I = uAmount * rainMask(cloudNoise(p.xz));
        if (p.y < -1000.0 || abs(p.y - cameraPosition.y) > 30.0 || hash11(k * 3.3 + aSeed.z * 71.0) >= I) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
        }
        float s = uSize * (0.3 + life * 0.9);
        wp = p + vec3(position.x * s, 0.03, -position.y * s);
        vAlpha = (1.0 - life);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    } else {
        vec3 p = aSeed.xyz * uBox;
        p.xz += uDrift;
        p.y -= uFall;
        if (uKind == 1 || uKind == 4) {          // snow and ash flutter
            float ph = aSeed.w * 60.0;
            p.x += sin(uTime * 0.9 + ph) * 0.5;
            p.z += cos(uTime * 0.7 + ph * 1.3) * 0.5;
        } else if (uKind == 3) {                 // dust swirls
            p.y += sin(uTime * 0.5 + aSeed.w * 40.0) * 1.5;
        }
        p = lo + mod(p - lo, uBox);
        float I = uAmount;
        if (uUseMask > 0.5) {
            if (p.y > uCloudBase) I = 0.0;
            else I *= rainMask(cloudNoise(p.xz));
        }
        if (aSeed.w >= I || p.y < groundAt(p.xz)) {
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            return;
        }
        vec3 q = abs(p - cameraPosition) / (uBox * 0.5);
        vAlpha = 1.0 - smoothstep(0.65, 1.0, max(max(q.x, q.z), q.y));
        vAlpha *= smoothstep(1.0, 2.5, length(p - cameraPosition));   // no giant streaks across the lens
        if (uKind == 0) {
            // A streak along the drop's velocity, turned to face the camera.
            vec3 ax = normalize(uVel);
            vec3 side = cross(ax, normalize(cameraPosition - p));
            float sl = length(side);
            side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
            wp = p + side * position.x * uSize + ax * position.y * uLen * (0.8 + 0.4 * fract(aSeed.w * 53.0));
            gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        } else {
            vec4 mv = viewMatrix * vec4(p, 1.0);
            mv.xy += position.xy * uSize * (0.75 + 0.5 * fract(aSeed.w * 37.0));
            gl_Position = projectionMatrix * mv;
            wp = p;
        }
    }
    vec3 r = wp - cameraPosition;
    vFog = weatherFog(cameraPosition, r);
    vFogCol = fogColorFor(normalize(r));
}
`;

const FRAG = OUTPUT_GLSL + `
uniform int   uKind;
uniform vec3  uColor;
uniform float uOpacity;
in vec2  vUv;
in float vAlpha;
in float vFog;
in vec3  vFogCol;
out vec4 fragColor;
void main() {
    vec2 c = vUv * 2.0 - 1.0;
    float a;
    if (uKind == 0)      a = (1.0 - abs(c.x)) * (1.0 - smoothstep(0.5, 1.0, abs(c.y)));
    else if (uKind == 5) { float r = length(c); a = smoothstep(0.5, 0.78, r) * (1.0 - smoothstep(0.84, 1.0, r)); }
    else if (uKind == 4) a = step(max(abs(c.x), abs(c.y * 1.4)), 0.8);
    else                 a = 1.0 - smoothstep(0.3, 1.0, length(c));
    a *= vAlpha * uOpacity * (1.0 - vFog * 0.75);
    if (a < 0.01) discard;
    fragColor = displayOut(vec4(mix(uColor, vFogCol, vFog), a));
}
`;

// count: instances at Particles "high". box: the volume around the camera.
// speed: fall speed (blocks/s). wind: share of the wind a particle drifts with.
const LAYERS = {
    rain:   { count: 14000, box: [56, 36, 56], speed: 11,  wind: 0.45, size: 0.035, len: 0.95, mask: 1, color: [0.78, 0.84, 0.92], opacity: 0.55 },
    snow:   { count: 12000, box: [44, 30, 44], speed: 1.6, wind: 0.8,  size: 0.12,  len: 0,    mask: 1, color: [1.0, 1.0, 1.0],   opacity: 0.9 },
    pellet: { count: 6000,  box: [44, 30, 44], speed: 8,   wind: 0.35, size: 0.055, len: 0,    mask: 1, color: [0.92, 0.95, 1.0], opacity: 0.9 },
    splash: { count: 2600,  box: [36, 1, 36],  speed: 0,   wind: 0,    size: 0.34,  len: 0,    mask: 1, color: [0.78, 0.82, 0.88], opacity: 0.45 },
    dust:   { count: 7000,  box: [48, 24, 48], speed: -0.1, wind: 1.0, size: 0.07,  len: 0,    mask: 0, color: [0.80, 0.66, 0.46], opacity: 0.4 },
    ash:    { count: 5000,  box: [44, 30, 44], speed: 0.8, wind: 0.6,  size: 0.075, len: 0,    mask: 0, color: [0.30, 0.29, 0.28], opacity: 0.85 },
};

class Layer {
    constructor(name, cfg, atmos, heightmap) {
        this.name = name;
        this.cfg = cfg;
        const quad = new THREE.PlaneGeometry(1, 1);
        const geo = new THREE.InstancedBufferGeometry();
        geo.index = quad.index;
        geo.setAttribute('position', quad.getAttribute('position'));
        geo.setAttribute('uv', quad.getAttribute('uv'));
        const seeds = new Float32Array(cfg.count * 4);
        for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
        geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
        geo.instanceCount = 0;
        this.geometry = geo;

        this.uniforms = {
            ...atmos,
            uKind:       { value: KIND[name] },
            uBox:        { value: new THREE.Vector3(...cfg.box) },
            uDrift:      { value: new THREE.Vector2() },
            uFall:       { value: 0 },
            uVel:        { value: new THREE.Vector3(0, -1, 0) },
            uAmount:     { value: 0 },
            uSize:       { value: cfg.size },
            uLen:        { value: cfg.len },
            uUseMask:    { value: cfg.mask },
            uHeight:     { value: heightmap.texture },
            uHeightRect: { value: heightmap.rect },
            uColor:      { value: new THREE.Vector3(...cfg.color) },
            uOpacity:    { value: cfg.opacity },
        };
        this.material = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: this.uniforms,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;   // positions are made in the shader
        this.mesh.renderOrder = 11;        // after the clouds
        this.mesh.visible = false;
        this.speed = cfg.speed;
        this.wind = cfg.wind;
    }

    /** amount 0..1, scale = particle setting, wind [x, z] blocks/s. */
    update(dt, amount, scale, wind, light) {
        const on = amount > 0.004 && scale > 0;
        this.mesh.visible = on;
        if (!on) return;
        const u = this.uniforms, box = this.cfg.box;
        this.geometry.instanceCount = Math.round(this.cfg.count * scale);
        u.uAmount.value = amount;
        const wx = wind[0] * this.wind, wz = wind[1] * this.wind;
        u.uDrift.value.set((u.uDrift.value.x + wx * dt) % box[0], (u.uDrift.value.y + wz * dt) % box[2]);
        u.uFall.value = ((u.uFall.value + this.speed * dt) % box[1] + box[1]) % box[1];
        u.uVel.value.set(wx, -Math.max(this.speed, 0.1), wz);
        const c = this.cfg.color;
        u.uColor.value.set(c[0] * light[0], c[1] * light[1], c[2] * light[2]);
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
    }
}

export class Precipitation {
    constructor(scene, atmos) {
        this.scene = scene;
        this.heightmap = new RainHeightmap();
        this.scale = 0.6;
        this.layers = {};
        for (const name in LAYERS) {
            const l = new Layer(name, LAYERS[name], atmos, this.heightmap);
            this.layers[name] = l;
            scene.add(l.mesh);
        }
        this._shares = [1, 0, 0];
        this.enabled = false;
    }

    setScale(scale) { this.scale = scale; }

    /**
     * @param {Float64Array} P    Weather parameters
     * @param {number[]} wind     [x, z] blocks/s
     * @param {number[]} light    RGB multiplier for particle colour (sky light, lightning)
     */
    update(dt, P, wind, light, px, pz) {
        const on = this.enabled;
        if (on) this.heightmap.update(px, pz);
        const s = precipShares(P, this._shares);
        const pr = on ? P[PRECIP] : 0;
        const L = this.layers;
        L.rain.update(dt, pr * s[0], this.scale, wind, light);
        L.snow.update(dt, pr * s[1], this.scale, wind, light);
        // Sleet pellets are small and quick; hail is bigger and falls hard.
        const big = P[PELLET_SIZE];
        L.pellet.speed = 8 + 8 * big;
        L.pellet.uniforms.uSize.value = 0.05 + 0.07 * big;
        L.pellet.update(dt, pr * s[2], this.scale, wind, light);
        L.splash.update(dt, pr * (s[0] + s[2]), this.scale, wind, light);
        L.dust.update(dt, on ? P[DUST] : 0, this.scale, wind, light);
        L.ash.update(dt, on ? P[ASH] : 0, this.scale, wind, light);
    }

    dispose() {
        for (const name in this.layers) {
            this.scene.remove(this.layers[name].mesh);
            this.layers[name].dispose();
        }
        this.heightmap.dispose();
    }
}
