/**
 * MobModels — draws the mob models of engine/MobModelDefs.js.
 *
 * One mesh, one draw call per mob. A model is a skeleton of bones with skins
 * drawn over them (engine/MobShapes.js), but it is not drawn as a tree of
 * meshes (a cow would be two dozen draw calls): its shapes share one geometry,
 * and each frame the posed position of every vertex is worked out here on the
 * CPU — a matrix per bone (poseMatrices), a thousand or two vertices per mob —
 * and uploaded. A vertex near a joint follows two bones, each by its share, so
 * the skin bends there instead of parting. That is far cheaper than the draw
 * calls it saves, needs no skinning variant of any shader, and the shadow pass
 * draws the animated shape with its ordinary depth material.
 *
 * Light is baked into the vertex colours in the same pass: every vertex is
 * shaded by the sun or moon from its own normal, so a rounded flank is shaded
 * round (and a mob sits in the world's light rather than its own), and scaled
 * by the light where the mob stands (EntityManager: sky, time of day,
 * torches). The material is therefore an unlit MeshBasicMaterial, shared by
 * every mob that wears the same texture. Position and colour live in one
 * interleaved buffer: one upload per mob per frame.
 *
 * Textures: a model's look is a stack of layers (data/textures/entities/,
 * painted by tools/gen_mob_textures.mjs) — a Quiddle is skin + outfit + eyes
 * + hair. The layers of a variant are drawn over one another into one small
 * canvas texture the first time that combination appears, and kept.
 */

import * as THREE from 'three';
import { MODELS } from './engine/MobModelDefs.js';
import { PX, shapeMesh, partShown, layoutKey } from './engine/MobShapes.js';
import { ANIMATORS, makePose, resetPose, makeAnimState, poseMatrices } from './engine/MobAnim.js';

// How a vertex is shaded, as terrain is: SHADE_AMBIENT is what the sky gives a
// surface turned away from the light, SHADE_SKY how much of that an underside
// loses (bellies and chins are darker than backs), and the rest comes with
// facing the sun or moon. One facing it squarely from above is 1.
const SHADE_AMBIENT = 0.62;
const SHADE_SKY = 0.05;
const SHADE_DIRECT = 1 - SHADE_AMBIENT;
// Vertex colours multiply the texture in linear light; the terrain shader
// multiplies display values. This exponent makes the two dim alike.
const GAMMA = 2.2;
// shade ^ GAMMA, looked up: a pow() per vertex was most of the cost of a pose.
const SHADE_STEPS = 512;
const SHADE_LUT = new Float32Array(SHADE_STEPS + 1);
for (let i = 0; i <= SHADE_STEPS; i++) SHADE_LUT[i] = Math.pow(i / SHADE_STEPS, GAMMA);

const STRIDE = 6;   // x y z r g b

/**
 * The static half of a model's geometry — what does not change with the pose —
 * for the parts that are not `hidden`: a variant's own hair and no other.
 */
function buildStatic(model, hidden, build) {
    const rest = [], normal = [], uv = [], index = [], ba = [], bb = [], bw = [];
    const W = model.atlas.width, H = model.atlas.height;
    model.parts.forEach((p, pi) => {
        if (hidden[pi]) return;
        for (const shape of p.shapes) {
            const m = shapeMesh(model, shape), base = rest.length / 3, pt = [0, 0, 0];
            // A build moves the model's own vertices: broader here, thicker there.
            if (build) for (let i = 0; i < m.pos.length; i += 3) {
                pt[0] = m.pos[i]; pt[1] = m.pos[i + 1]; pt[2] = m.pos[i + 2];
                build.point(pt, shape.tag);
                m.pos[i] = pt[0]; m.pos[i + 1] = pt[1]; m.pos[i + 2] = pt[2];
            }
            for (const v of m.pos) rest.push(v);
            for (const v of m.nrm) normal.push(v);
            for (let i = 0; i < m.uv.length; i += 2) uv.push(m.uv[i] / W, 1 - m.uv[i + 1] / H);
            for (const i of m.idx) index.push(base + i);
            for (let i = 0; i < m.ba.length; i++) { ba.push(m.ba[i]); bb.push(m.bw[i] > 0 ? m.bb[i] : -1); bw.push(m.bw[i]); }
        }
    });
    // Vertices one after another that follow the same bone, or the same two,
    // are a run: its matrices are fetched once.
    const verts = rest.length / 3, runs = [];
    for (let v = 0; v < verts;) {
        let e = v + 1;
        while (e < verts && ba[e] === ba[v] && bb[e] === bb[v]) e++;
        runs.push(ba[v], bb[v], v, e);
        v = e;
    }
    let reach = 0, halfWidth = 0;
    for (let i = 0; i < rest.length; i++) {
        reach = Math.max(reach, Math.abs(rest[i]));
        if (i % 3 === 0) halfWidth = Math.max(halfWidth, Math.abs(rest[i]));
    }
    let pivots = null;
    if (build) {
        pivots = new Float32Array(model.parts.length * 3);
        model.parts.forEach((p, i) => pivots.set(build.pivot(p.name, [...p.pivot]), i * 3));
    }
    return {
        pivots,
        rest: new Float32Array(rest),
        normal: new Float32Array(normal),
        runs: new Int32Array(runs),            // bone, second bone or −1, first vertex, one past the last
        share: new Float32Array(bw),           // how much of each vertex follows the second bone
        uv: new THREE.BufferAttribute(new Float32Array(uv), 2),
        index: new THREE.BufferAttribute(verts > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1),
        verts, triangles: index.length / 3,
        reach, halfWidth,
    };
}

export class MobModels {
    /** @param {string} dir where the texture layers are (with a trailing slash) */
    constructor(dir = 'data/textures/entities/') {
        this.dir = dir;
        this._static = new Map();     // model name + shown parts → buildStatic
        this._images = new Map();     // layer name → HTMLImageElement | null (missing)
        this._materials = new Map();  // "model:layer+layer" → { material, texture }
        this._pool = new Map();       // the same key as _static → spare instance geometries
        this._mat = new Float32Array(64 * 12);
        this.loaded = false;
    }

    has(name) { return !!MODELS[name]; }
    model(name) { return MODELS[name] ?? null; }

    /**
     * Fetch and decode every texture layer of every model, so the first mob
     * of a kind costs nothing when it appears. A missing file is not an
     * error: that layer is simply left out.
     */
    async load() {
        const names = new Set();
        for (const m of Object.values(MODELS)) {
            if (m.allLayers) { for (const l of m.allLayers()) names.add(l); continue; }
            const counts = Object.entries(m.variants);
            // Every choice of every variant, one at a time, names every layer.
            const base = Object.fromEntries(counts.map(([k]) => [k, 0]));
            for (const l of m.layers(base)) names.add(l);
            for (const [k, n] of counts) for (let i = 1; i < n; i++) for (const l of m.layers({ ...base, [k]: i })) names.add(l);
        }
        await Promise.all([...names].map((name) => new Promise((resolve) => {
            const img = new Image();
            img.onload = () => { this._images.set(name, img); resolve(); };
            img.onerror = () => { this._images.set(name, null); resolve(); };
            img.src = `${this.dir}${name}.png`;
        })));
        // Textures painted for another layout of a model are wrong for this one.
        try {
            const painted = await (await fetch(`${this.dir}layout.json`)).json();
            for (const [name, m] of Object.entries(MODELS)) {
                if (painted[name] !== undefined && painted[name] !== layoutKey(m)) {
                    console.warn(`[mobs] the ${name} model has changed since its textures were painted: run "npm run mobtex"`);
                }
            }
        } catch { /* no record: nothing to compare */ }
        this.loaded = true;
    }

    _materialFor(model, variant) {
        const layers = model.layers(variant);
        const key = `${model.name}:${layers.join('+')}`;
        let hit = this._materials.get(key);
        if (hit) return hit.material;

        const cv = document.createElement('canvas');
        cv.width = model.atlas.width; cv.height = model.atlas.height;
        const cx = cv.getContext('2d');
        let drawn = 0;
        for (const l of layers) {
            const img = this._images.get(l);
            if (img) { cx.drawImage(img, 0, 0); drawn++; }
        }
        if (drawn === 0) {
            // No texture at all: a plain clay figure rather than nothing.
            cx.fillStyle = '#b9a79a';
            cx.fillRect(0, 0, cv.width, cv.height);
        }
        const texture = new THREE.CanvasTexture(cv);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, alphaTest: 0.5 });
        material.name = `mob-${model.name}`;
        this._materials.set(key, { material, texture });
        return material;
    }

    /**
     * A new mob of `name` (a key of MODELS) wearing `variant`. `scale`
     * stretches the whole model. Returns null for an unknown model.
     */
    create(name, variant = {}, scale = 1) {
        const model = MODELS[name];
        if (!model) return null;
        // A choice for every variant the model has; anything left out is the first.
        const chosen = {};
        for (const [k, n] of Object.entries(model.variants)) chosen[k] = Math.max(0, Math.min(n - 1, (variant?.[k] ?? 0) | 0));
        variant = chosen;
        // Parts this variant does not wear have no vertices at all.
        const hidden = model.parts.map(p => !partShown(p, variant));
        // A model may give each look a build of its own: a shape, and a size.
        const build = model.build?.(variant) ?? null;
        const key = `${name}:${hidden.map(h => h ? 0 : 1).join('')}:${build?.key ?? ''}`;
        let st = this._static.get(key);
        if (!st) this._static.set(key, st = buildStatic(model, hidden, build));
        scale *= build?.scale ?? 1;

        let geometry = this._pool.get(key)?.pop();
        if (!geometry) {
            geometry = new THREE.BufferGeometry();
            const buffer = new THREE.InterleavedBuffer(new Float32Array(st.verts * STRIDE), STRIDE);
            buffer.setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
            geometry.setAttribute('color', new THREE.InterleavedBufferAttribute(buffer, 3, 3));
            geometry.setAttribute('uv', st.uv);
            geometry.setIndex(st.index);
        }
        // Wide enough for any pose (a death roll swings the whole body about its feet).
        const reach = st.reach * PX * scale * 1.6;
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, reach * 0.4, 0), reach);

        const mesh = new THREE.Mesh(geometry, this._materialFor(model, variant));
        mesh.name = `mob:${name}`;
        const inst = {
            name, model, variant, scale, mesh, st, key,
            buffer: geometry.attributes.position.data,
            pose: makePose(model),
            anim: makeAnimState(),
            death: 0,           // 0 alive … 1 lying on its side
            tint: [1, 1, 1],
        };
        this.pose(inst, 1, null);
        return inst;
    }

    /**
     * Pose `inst` from its anim state and write the vertices.
     * @param {number} light           how lit the mob is (0 … 1+)
     * @param {number[]|null} lightDir unit vector toward the sun or moon, in the
     *                                 model's own space (see toModelSpace); null = from above
     */
    pose(inst, light = 1, lightDir = null) {
        const { model, st, pose } = inst;
        resetPose(pose);
        ANIMATORS[inst.name]?.(pose, inst.anim);
        if (inst.death > 0) {
            // Keel over sideways about the feet, and settle onto the ground.
            const k = inst.death * inst.death * (3 - 2 * inst.death);
            pose.r[2] += k * Math.PI * 0.5 * (inst.anim.seed > 0.5 ? 1 : -1);
            pose.t[1] += k * st.halfWidth * 0.8;
        }
        if (this._mat.length < model.parts.length * 12) this._mat = new Float32Array(model.parts.length * 12);
        const M = poseMatrices(model, pose, this._mat, st.pivots);

        const k = PX * inst.scale;
        const lx = lightDir ? lightDir[0] : 0.35, ly = lightDir ? lightDir[1] : 0.87, lz = lightDir ? lightDir[2] : 0.35;
        const lit = Math.pow(Math.max(0, light), GAMMA);
        const tr = lit * inst.tint[0], tg = lit * inst.tint[1], tb = lit * inst.tint[2];
        const base = SHADE_AMBIENT - SHADE_SKY;
        const rest = st.rest, nrm = st.normal, runs = st.runs, share = st.share, out = inst.buffer.array;
        for (let r = 0; r < runs.length; r += 4) {
            const m = runs[r] * 12, second = runs[r + 1], n = second * 12;
            const m0 = M[m], m1 = M[m + 1], m2 = M[m + 2], m3 = M[m + 3];
            const m4 = M[m + 4], m5 = M[m + 5], m6 = M[m + 6], m7 = M[m + 7];
            const m8 = M[m + 8], m9 = M[m + 9], m10 = M[m + 10], m11 = M[m + 11];
            for (let v = runs[r + 2], end = runs[r + 3]; v < end; v++) {
                const i = v * 3, o = v * STRIDE;
                const x = rest[i], y = rest[i + 1], z = rest[i + 2];
                const nx = nrm[i], ny = nrm[i + 1], nz = nrm[i + 2];
                let wx, wy, wz;
                if (second < 0) {
                    out[o]     = (m0 * x + m1 * y + m2 * z + m3) * k;
                    out[o + 1] = (m4 * x + m5 * y + m6 * z + m7) * k;
                    out[o + 2] = (m8 * x + m9 * y + m10 * z + m11) * k;
                    // The vertex's normal, turned with it.
                    wx = m0 * nx + m1 * ny + m2 * nz;
                    wy = m4 * nx + m5 * ny + m6 * nz;
                    wz = m8 * nx + m9 * ny + m10 * nz;
                } else {
                    // Between two bones: where each would put it, mixed by their shares.
                    const w = share[v], u = 1 - w;
                    const a0 = m0 * u + M[n] * w, a1 = m1 * u + M[n + 1] * w, a2 = m2 * u + M[n + 2] * w, a3 = m3 * u + M[n + 3] * w;
                    const a4 = m4 * u + M[n + 4] * w, a5 = m5 * u + M[n + 5] * w, a6 = m6 * u + M[n + 6] * w, a7 = m7 * u + M[n + 7] * w;
                    const a8 = m8 * u + M[n + 8] * w, a9 = m9 * u + M[n + 9] * w, a10 = m10 * u + M[n + 10] * w, a11 = m11 * u + M[n + 11] * w;
                    out[o]     = (a0 * x + a1 * y + a2 * z + a3) * k;
                    out[o + 1] = (a4 * x + a5 * y + a6 * z + a7) * k;
                    out[o + 2] = (a8 * x + a9 * y + a10 * z + a11) * k;
                    wx = a0 * nx + a1 * ny + a2 * nz;
                    wy = a4 * nx + a5 * ny + a6 * nz;
                    wz = a8 * nx + a9 * ny + a10 * nz;
                    // Two turns mixed come out a little short of a turn.
                    const l = 1 / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1);
                    wx *= l; wy *= l; wz *= l;
                }
                const facing = wx * lx + wy * ly + wz * lz;
                let s = base + SHADE_SKY * wy + (facing > 0 ? SHADE_DIRECT * facing : 0);
                s = s > 1 ? 1 : s < 0 ? 0 : s;
                const c = SHADE_LUT[(s * SHADE_STEPS + 0.5) | 0];
                out[o + 3] = c * tr; out[o + 4] = c * tg; out[o + 5] = c * tb;
            }
        }
        inst.buffer.needsUpdate = true;
    }

    /** A world-space direction turned into the space of a model facing `yaw`. */
    static toModelSpace(dir, yaw, out) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        out[0] = dir[0] * c - dir[2] * s;
        out[1] = dir[1];
        out[2] = dir[0] * s + dir[2] * c;
        return out;
    }

    /** Give back an instance's geometry for the next mob of its kind and look. */
    release(inst) {
        let pool = this._pool.get(inst.key);
        if (!pool) this._pool.set(inst.key, pool = []);
        pool.push(inst.mesh.geometry);
    }

    /** One instance of every model, for warming up shaders (world.js). */
    warmupMeshes() {
        const first = Object.keys(MODELS)[0];
        const inst = first ? this.create(first) : null;
        if (!inst) return [];
        inst.mesh.userData.warmupGeometry = false;
        this.release(inst);
        return [inst.mesh];
    }

    dispose() {
        for (const pool of this._pool.values()) for (const g of pool) g.dispose();
        this._pool.clear();
        for (const { material, texture } of this._materials.values()) { material.dispose(); texture.dispose(); }
        this._materials.clear();
    }
}

export { MODELS };
