/**
 * MenuScene — the place behind the menus.
 *
 * It is a model, not a world: data/menu/scene.glb, baked from the game's own
 * terrain by tools/gen_menu_scene.mjs (which says what is in it and why). So
 * the menu generates nothing — no workers, no chunks — it loads one file and
 * draws it, on a small renderer of its own that is thrown away when a world
 * starts. With no such file (a pack without one) the menus keep the pack's
 * gradient, as they always could.
 *
 * It is drawn to look like the game: the same block textures (the file's
 * images, as one texture array), the same light sum from the baked sky light
 * and the afternoon's sun (engine/DayCycle.js: the game's own palette at the
 * scene's hour), the ground of one kind spreading over the next along a
 * ragged line (`_BLEND`, see *Ground blending*), leaves moving, haze toward
 * the edge. The sky is a gradient with the sun's glow and slow cloud — the
 * game's sky and weather are not here.
 *
 * In it stand the player's own Quiddle, in the look they chose, and a few
 * animals, where the file says. They do not walk (there is no world under
 * them to walk on): they breathe, look about and graze.
 *
 * **The camera does not move unless it is sent** (`goto`): it rests at one of
 * the file's views — `title` behind the title screen, `worlds` behind the
 * list of worlds — and goes from one to the other along the straight line
 * the bake looked along, so everything it passes was kept. main.js hides the
 * menu while it travels.
 *
 * main.js drives it through `window.__wwMenuScene`:
 *   show(view?)   load (the first time) and start drawing; resolves when it is on screen, false if there is no scene
 *   hide()        stop, and give the graphics memory back
 *   goto(view)    travel to a view; resolves on arrival (at once if there is no scene)
 *   setSkin(skin) the player's look has changed
 *   state()       for tests
 */

import * as THREE from 'three';
import { MobModels } from './MobModels.js';
import { PlayerModel } from './PlayerModel.js';
import { randomVariant } from './engine/MobShapes.js';
import { DayCycle, newSkyState } from './engine/DayCycle.js';
import { SUN_AMBIENT, SUN_TOP } from './engine/Sun.js';

const URL_SCENE = 'data/menu/scene.glb';
const TEX = 32;                 // block textures are this square (others are scaled to it, unsmoothed)
const TRAVEL = 2.4;             // seconds from one view to another
const WIDE = 16 / 9;            // the shape of the picture the scene was baked for
const FPS = 30, FPS_AWAY = 12;  // a backdrop's frame rate; and with the window in the background
const BLEND_REACH = 0.7, BLEND_REACH_HEMMED = 0.2;   // as the chunk shader's (world.js)

// ── The file ─────────────────────────────────────────────────────────────────

/** Read a binary glTF: its JSON and its one buffer. */
function readGlb(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a glb');
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
    const binAt = 20 + jsonLen + 8;
    return { json, bin: buf.slice(binAt, binAt + dv.getUint32(20 + jsonLen, true)) };
}
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
/**
 * One of the file's arrays, as it lies there (nothing is copied). Three bytes
 * kept on a 4-byte step are handed over as four: the shader takes the three.
 * `fraction`: whole numbers go to the graphics card as fractions of their
 * largest, which every card takes natively (see `uUV`).
 */
function attribute({ json, bin }, index, fraction = false) {
    const a = json.accessors[index], v = json.bufferViews[a.bufferView], Type = ARRAYS[a.componentType];
    const n = v.byteStride ? v.byteStride / Type.BYTES_PER_ELEMENT : SIZES[a.type];
    const array = new Type(bin, (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * n);
    return new THREE.BufferAttribute(array, n, !!a.normalized || fraction);
}
/** What a texture coordinate in the file is multiplied by to count in tiles, handed over as `attribute(…, true)`. */
function uvScale(json, prim) {
    const a = json.accessors[prim.attributes.TEXCOORD_0];
    const by = json.materials[prim.material].pbrMetallicRoughness?.baseColorTexture?.extensions?.KHR_texture_transform?.scale?.[0] ?? 1;
    const whole = a.componentType !== 5126 && !a.normalized;
    return by * (whole ? (a.componentType === 5123 ? 65535 : a.componentType === 5121 ? 255 : 1) : 1);
}

/** The file's images as one texture array, a layer each, in the file's order. */
async function textureArray(glb) {
    const { json, bin } = glb, n = json.images.length;
    const data = new Uint8Array(TEX * TEX * 4 * n);
    const cv = new OffscreenCanvas(TEX, TEX), cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingEnabled = false;
    await Promise.all(json.images.map(async (img, i) => {
        const v = json.bufferViews[img.bufferView];
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bin, v.byteOffset ?? 0, v.byteLength)], { type: img.mimeType }));
        return [i, bitmap];
    })).then((list) => {
        for (const [i, bitmap] of list) {
            cx.clearRect(0, 0, TEX, TEX);
            cx.drawImage(bitmap, 0, 0, TEX, TEX);
            data.set(cx.getImageData(0, 0, TEX, TEX).data, i * TEX * TEX * 4);
            bitmap.close?.();
        }
    });
    const tex = new THREE.DataArrayTexture(data, TEX, TEX, n);
    tex.format = THREE.RGBAFormat;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
}

/** A square of smooth noise that repeats: for the ragged edge of ground on ground, and for cloud. */
function noiseTexture(size = 128) {
    const cells = 16, grid = new Float32Array(cells * cells);
    let s = 12345;
    for (let i = 0; i < grid.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; grid[i] = s / 4294967296; }
    const at = (x, y) => grid[((y % cells + cells) % cells) * cells + ((x % cells + cells) % cells)];
    const fade = (t) => t * t * (3 - 2 * t);
    const sample = (u, v, k) => {
        const x = u * cells * k, y = v * cells * k, xi = Math.floor(x), yi = Math.floor(y), fx = fade(x - xi), fy = fade(y - yi);
        // Wrapped at the texture's edge whatever the octave.
        const w = (a) => ((a % (cells * k)) + cells * k) % (cells * k);
        const a = at(w(xi), w(yi)), b = at(w(xi + 1), w(yi)), c = at(w(xi), w(yi + 1)), d = at(w(xi + 1), w(yi + 1));
        return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    };
    const data = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size;
        data[y * size + x] = Math.round((sample(u, v, 0.25) * 0.55 + sample(u, v, 0.5) * 0.3 + sample(u, v, 1) * 0.15) * 255);
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

// ── Its look ─────────────────────────────────────────────────────────────────

const VERT = `
in vec4 color;      // with no texture: the face's own colour, in the light there
in vec4 blend;      // texture of the ground that spreads over this one, the sides it comes from, the sky light, glow (+1: natural ground)
uniform float uTime, uSway, uUV;
out vec2 vUV;
out vec3 vNormal, vWorld;
out vec4 vColor, vBlend;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    // Leaves move in the wind: by where they are, so faces that meet stay met.
    if (uSway > 0.5) {
        float t = uTime * 1.3;
        w.x += sin(t + w.z * 0.9 + w.y * 0.7) * 0.035;
        w.z += sin(t * 0.8 + w.x * 0.8 + w.y * 0.5) * 0.035;
    }
    vWorld = w.xyz;
    vUV = uv * uUV;
    vNormal = normal;
    vColor = color;
    vBlend = blend;
    gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = `
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray uTex;
uniform sampler2D uNoise;
uniform float uLayer, uAlpha;
uniform vec3 uSunDir, uAmbient, uDirect, uFogColor, uSunColor;
uniform vec2 uFog;
in vec2 vUV;
in vec3 vNormal, vWorld;
in vec4 vColor, vBlend;
out vec4 fragColor;

// Natural ground: the ground beside it spreads over its edges along a ragged
// line, and a wide stretch of one ground is a little uneven (world.js: ground()).
vec3 ground(vec3 c, vec2 bl, vec2 gx, vec2 gy) {
    if (bl.y > 0.5) {
        vec2 f = fract(vUV * 0.9995 + 0.00025);
        float x0 = f.y, x1 = 1.0 - f.y, z0 = f.x, z1 = 1.0 - f.x;
        int m = int(bl.y + 0.5);
        float d = 9.0;
        if ((m & 1) != 0)   d = min(d, x0);
        if ((m & 2) != 0)   d = min(d, x1);
        if ((m & 4) != 0)   d = min(d, z0);
        if ((m & 8) != 0)   d = min(d, z1);
        if ((m & 16) != 0)  d = min(d, length(vec2(x0, z0)));
        if ((m & 32) != 0)  d = min(d, length(vec2(x1, z0)));
        if ((m & 64) != 0)  d = min(d, length(vec2(x0, z1)));
        if ((m & 128) != 0) d = min(d, length(vec2(x1, z1)));
        bool hemmed = (m & 3) == 3 || (m & 12) == 12 || (m & 144) == 144 || (m & 96) == 96;
        float e = 1.0 - d / (hemmed ? ${BLEND_REACH_HEMMED.toFixed(2)} : ${BLEND_REACH.toFixed(2)});
        if (e > 0.0) {
            float n = smoothstep(0.3, 0.7, textureLod(uNoise, vWorld.xz * 0.125, 0.0).r);
            float k = smoothstep(0.42, 0.58, e * 1.25 + (n - 0.5) - 0.1);
            if (k > 0.0) c = mix(c, textureGrad(uTex, vec3(vUV, bl.x), gx, gy).rgb, k);
        }
    }
    float v = textureLod(uNoise, (vWorld.xz + vWorld.y * vec2(0.375, 0.625)) * ${(1 / 64).toFixed(6)}, 0.0).r;
    return c * (0.88 + 0.24 * v);
}

void main() {
    vec3 n = normalize(vNormal);
    vec3 c;
    float a = uAlpha, sky = 1.0;
    // The last byte: how much it glows, in twos, and one more on natural ground.
    float flags = floor(vBlend.a * 255.0 + 0.5);
    if (uLayer >= 0.0) {
        vec2 gx = dFdx(vUV), gy = dFdy(vUV);
        vec4 t = texture(uTex, vec3(vUV, uLayer));
        if (uAlpha >= 1.0 && t.a < 0.5) discard;
        c = t.rgb;
        a *= t.a;
        if (mod(flags, 2.0) > 0.5) c = ground(c, floor(vBlend.rg * 255.0 + 0.5), gx, gy);
        sky = vBlend.b;
    } else {
        c = vColor.rgb;             // its own colour, already in the light there
    }
    // The game's light: the sky's share, and the sun's on what faces it.
    if (flags < 2.0) {
        float facing = max(dot(n, uSunDir), 0.0);
        c *= (${SUN_AMBIENT.toFixed(4)} * uAmbient + ${(1 - SUN_AMBIENT).toFixed(4)} * facing * uDirect) * (sky / ${SUN_TOP.toFixed(6)});
    }
    // Haze toward the edge of what there is, a little warmer toward the sun.
    vec3 to = vWorld - cameraPosition;
    float f = smoothstep(uFog.x, uFog.y, length(to.xz));
    vec3 fog = mix(uFogColor, uSunColor, 0.18 * pow(max(dot(normalize(to), uSunDir), 0.0), 6.0));
    fragColor = vec4(mix(c, fog, f), a);
}`;

const SKY_VERT = `
out vec3 vDir;
void main() {
    vDir = position;
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    gl_Position = p.xyww;       // at the far plane: only where no land is
}`;
const SKY_FRAG = `
precision highp float;
uniform sampler2D uNoise;
uniform vec3 uZenith, uHorizon, uFogColor, uSunDir, uSunColor;
uniform float uTime;
in vec3 vDir;
out vec4 fragColor;
void main() {
    vec3 d = normalize(vDir);
    float up = max(d.y, 0.0), toSun = max(dot(d, uSunDir), 0.0);
    vec3 c = mix(uFogColor, uZenith, pow(up, 0.55));
    c = mix(c, uHorizon, 0.5 * pow(1.0 - up, 6.0));
    c += uSunColor * (0.16 * pow(toSun, 8.0) + 0.5 * pow(toSun, 220.0) + step(0.9993, toSun));
    // Cloud: a level sheet far overhead, drifting.
    if (d.y > 0.02) {
        vec2 p = d.xz / (d.y + 0.12) * 0.11 + vec2(uTime * 0.0022, uTime * 0.0009);
        float n = texture(uNoise, p).r * 0.65 + texture(uNoise, p * 2.7 + 0.31).r * 0.35;
        float cloud = smoothstep(0.54, 0.74, n) * smoothstep(0.02, 0.2, d.y);
        vec3 lit = mix(vec3(0.82, 0.85, 0.9), vec3(1.0), smoothstep(0.6, 0.85, n)) * (0.82 + 0.18 * uSunColor);
        c = mix(c, lit, cloud * 0.88);
    }
    fragColor = vec4(c, 1.0);
}`;

// ── The scene ────────────────────────────────────────────────────────────────

let canvas = null, renderer = null, scene = null, camera = null;
let info = null;                   // the file's own account of itself (extras.wonderWorld)
let shared = null;                 // uniforms every material shares
let models = null, figure = null, animals = [];
let skin = null;
let running = false, raf = 0, lastT = 0, lastDraw = 0, clock = 0;
let loading = null, failed = false, triangles = 0;
let at = 'title', travel = null;   // the view the camera rests at; or { from, to, t, done } on its way
const sky = newSkyState();
const _dir = [0, 1, 0], _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qx = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0), AXIS_X = new THREE.Vector3(1, 0, 0);

function place(v) {
    camera.position.set(v.at[0], v.at[1], v.at[2]);
    _q.identity().multiply(_qy.setFromAxisAngle(AXIS_Y, v.yaw)).multiply(_qx.setFromAxisAngle(AXIS_X, v.pitch));
    camera.quaternion.copy(_q);
    // The bake kept what a 16:9 picture shows. On a wider one the view is cut
    // at top and bottom instead of reaching further to the sides, where there
    // is nothing; a narrower one simply sees less.
    const fov = camera.aspect > WIDE
        ? 2 * Math.atan(Math.tan(v.fov * Math.PI / 360) * WIDE / camera.aspect) * 180 / Math.PI : v.fov;
    if (Math.abs(camera.fov - fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

async function build() {
    const res = await fetch(URL_SCENE);
    if (!res.ok) throw new Error(`no menu scene (${res.status})`);
    const glb = readGlb(await res.arrayBuffer());
    const { json } = glb;
    info = json.scenes[json.scene ?? 0].extras?.wonderWorld;
    if (!info?.views?.title) throw new Error('the menu scene has no views');

    // One renderer for as long as the page lives (a canvas has one context);
    // what is drawn with it is made here and let go in hide().
    if (!renderer) {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        camera = new THREE.PerspectiveCamera(info.views.title.fov, window.innerWidth / window.innerHeight, 0.1, 2000);
    }
    const made = new THREE.Scene();

    // The afternoon it always is there, in the game's own colours.
    const day = new DayCycle();
    day.setHours(info.hours ?? 16);
    day.sample(sky);
    const col = (c) => new THREE.Vector3(c[0], c[1], c[2]);
    shared = {
        uTex: { value: await textureArray(glb) }, uNoise: { value: noiseTexture() }, uTime: { value: 0 },
        uSunDir: { value: col(sky.lightDir) }, uAmbient: { value: col(sky.ambient) }, uDirect: { value: col(sky.direct) },
        uSunColor: { value: col(sky.sunColor) }, uFogColor: { value: col(sky.flat).lerp(col(sky.horizon), 0.6) },
        uFog: { value: new THREE.Vector2(info.fog?.[0] ?? 230, info.fog?.[1] ?? 265) },
        uZenith: { value: col(sky.zenith) }, uHorizon: { value: col(sky.horizon) },
    };

    // The land: a mesh for each texture.
    const node = json.nodes[json.scenes[json.scene ?? 0].nodes[0]];
    const land = new THREE.Group();
    land.position.fromArray(node.translation ?? [0, 0, 0]);
    const materials = new Map();
    triangles = 0;
    for (const prim of json.meshes[node.mesh].primitives) {
        const m = json.materials[prim.material], x = m.extras ?? {};
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', attribute(glb, prim.attributes.POSITION));
        geo.setAttribute('normal', attribute(glb, prim.attributes.NORMAL));
        geo.setAttribute('uv', attribute(glb, prim.attributes.TEXCOORD_0, true));
        if (prim.attributes.COLOR_0 !== undefined) geo.setAttribute('color', attribute(glb, prim.attributes.COLOR_0));
        geo.setAttribute('blend', attribute(glb, prim.attributes._BLEND));
        geo.setIndex(attribute(glb, prim.indices));
        triangles += geo.index.count / 3;
        // One material for each of the file's: a texture with many vertices is several primitives of it.
        let mat = materials.get(prim.material);
        if (!mat) materials.set(prim.material, mat = new THREE.ShaderMaterial({
            glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
            uniforms: { ...shared, uLayer: { value: x.image ?? -1 }, uSway: { value: x.leaves ? 1 : 0 }, uAlpha: { value: x.water ? 0.72 : 1 },
                        uUV: { value: uvScale(json, prim) } },
            transparent: !!x.water, depthWrite: !x.water,
        }));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;                  // it is all in front of one view or another
        mesh.renderOrder = x.water ? 2 : 0;
        land.add(mesh);
    }
    made.add(land);

    const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: shared,
        side: THREE.BackSide, depthWrite: false,
    }));
    dome.frustumCulled = false;
    dome.renderOrder = 1;
    made.add(dome);

    // Who stands in it.
    models = new MobModels();
    await models.load();
    figure = new PlayerModel(models, skin);
    made.add(figure.mesh);
    animals = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const a of info.animals ?? []) {
        const model = models.model(a.type);
        const inst = model ? models.create(a.type, randomVariant(model)) : null;
        if (!inst) continue;
        inst.mesh.position.set(a.at[0], a.at[1], a.at[2]);
        const yaw = rnd() * Math.PI * 2;
        inst.mesh.rotation.y = yaw;
        inst.anim.seed = rnd();
        made.add(inst.mesh);
        animals.push({ inst, yaw, grazes: a.type !== 'chicken' ? 1 : 0.6, next: 2 + rnd() * 8, graze: rnd() < 0.5 });
    }
    scene = made;
}

function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    // A backdrop's frame rate; less with the window in the background.
    let focused = true;
    try { focused = !document.hidden && window.top.document.hasFocus(); } catch { focused = !document.hidden; }
    if (now - lastDraw < 1000 / (travel ? 60 : focused ? FPS : FPS_AWAY) - 2) return;
    const dt = Math.min(0.1, (now - (lastT || now)) / 1000);
    lastT = lastDraw = now;
    clock += dt;
    shared.uTime.value = clock;

    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h && (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio()) || camera.aspect !== w / h)) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        if (!travel) place(info.views[at]);
    }

    // The camera: at rest, or on its way — along the straight line the bake looked along.
    if (travel) {
        travel.t = Math.min(1, travel.t + dt / TRAVEL);
        const k = travel.t * travel.t * (3 - 2 * travel.t), a = travel.from, b = travel.to;
        place({ at: [0, 1, 2].map(i => a.at[i] + (b.at[i] - a.at[i]) * k), yaw: a.yaw + (b.yaw - a.yaw) * k,
                pitch: a.pitch + (b.pitch - a.pitch) * k, fov: a.fov + (b.fov - a.fov) * k });
        if (travel.t >= 1) { const done = travel.done; at = travel.name; travel = null; done(); }
    }

    // The player's figure watches the camera; the animals graze and look up.
    const light = MobModels.toModelSpace(sky.lightDir, 0, _dir);
    if (figure && info.figure) {
        const f = info.figure.at, dx = camera.position.x - f[0], dz = camera.position.z - f[2];
        figure.update(dt, { x: f[0], y: f[1], z: f[2], yaw: Math.atan2(-dx, -dz), pitch: 0.04, speed: 0, onGround: true, inWater: false, light: 1, lightDir: sky.lightDir });
    }
    for (const a of animals) {
        const s = a.inst.anim;
        s.time += dt;
        a.next -= dt;
        if (a.next <= 0) { a.graze = !a.graze; a.next = 4 + Math.random() * 9; }
        s.graze += ((a.graze ? a.grazes : 0) - s.graze) * (1 - Math.exp(-dt * 3));
        s.lookYaw = a.graze ? 0 : Math.sin(s.time * 0.35 + s.seed * 9) * 0.5;
        models.pose(a.inst, 1, MobModels.toModelSpace(sky.lightDir, a.yaw, light));
    }
    renderer.render(scene, camera);
}

const api = {
    /** Start showing the place, resting at `view`. Resolves true once it is drawn, false if there is none to show. */
    async show(view = 'title') {
        canvas ??= document.getElementById('menuCanvas');
        if (!canvas || failed) return false;
        if (!scene) {
            loading ??= build().catch((e) => { failed = true; console.warn('[menu] no scene behind the menus:', e.message); });
            await loading;
            loading = null;
            if (failed || !scene) return false;
        }
        if (!travel && info.views[view]) { at = view; place(info.views[view]); }
        if (!running) { running = true; lastT = 0; lastDraw = 0; raf = requestAnimationFrame(frame); }
        return true;
    },

    /** Stop, and let go of everything on the graphics card: a world is about to want it. */
    hide() {
        running = false;
        cancelAnimationFrame(raf);
        if (travel) { const done = travel.done; travel = null; done(); }
        if (!scene) return;
        scene.traverse((o) => { o.geometry?.dispose(); if (o.material?.isShaderMaterial) o.material.dispose(); });
        shared.uTex.value.dispose(); shared.uNoise.value.dispose();
        figure?.dispose(); figure = null; animals = [];
        models?.dispose(); models = null;
        renderer.renderLists.dispose();
        scene = shared = null;
    },

    /** Travel to a view. Resolves when the camera is there (at once if it already is, or there is no scene). */
    goto(view) {
        return new Promise((resolve) => {
            if (!running || !info?.views[view] || (at === view && !travel)) return resolve();
            const from = { at: camera.position.toArray(), yaw: travel ? travel.from.yaw + (travel.to.yaw - travel.from.yaw) * travel.t : info.views[at].yaw,
                           pitch: info.views[at].pitch, fov: camera.fov };
            if (travel) travel.done();
            travel = { from, to: info.views[view], name: view, t: 0, done: resolve };
        });
    },

    setSkin(next) {
        skin = next;
        if (figure && scene) scene.add(figure.setSkin(next));
    },

    state: () => ({ ready: running && !!scene, failed, view: at, travelling: !!travel, triangles, animals: animals.length }),
};

window.__wwMenuScene = api;
