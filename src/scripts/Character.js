/**
 * Character — the figure on the Character screen: the player's Quiddle in the
 * look being chosen, turning slowly so all of it can be seen.
 *
 * It has a small renderer of its own (one canvas, one mesh), because the
 * screen is used from the title menu as well as from a game: nothing here
 * needs a world. main.js drives it through `window.__wwCharacter`:
 *
 *   looks()             what can be chosen: { hair: 6, outfit: 6, … } (QUIDDLE_LOOKS)
 *   show(canvas, skin)  start drawing `skin` on that canvas
 *   set(skin)           change the look
 *   turn(radians)       turn the figure by hand (it stops turning by itself for a while)
 *   hide()              stop
 *   random()            a look picked at random
 */

import * as THREE from 'three';
import { MobModels, MODELS } from './MobModels.js';
import { PlayerModel, cleanSkin, DEFAULT_SKIN } from './PlayerModel.js';

const TURN_RATE = 0.5;          // radians a second, by itself
const SUN = [0.45, 0.8, 0.4];   // where the light is, for the figure's shading

let models = null, loading = null;
let renderer = null, scene = null, camera = null, figure = null;
let canvasEl = null, active = false, raf = 0, last = 0, angle = 0.5, held = 0;

async function ensureModels() {
    if (!models) { models = new MobModels(); loading = models.load(); }
    await loading;
}

function frame(now) {
    if (!active) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000 || 0.016);
    last = now;
    // Follow the canvas: it is sized by the page (in vw), not by us.
    const w = canvasEl.clientWidth, h = canvasEl.clientHeight;
    if (w === 0 || h === 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvasEl.width !== Math.round(w * ratio) || canvasEl.height !== Math.round(h * ratio)) {
        renderer.setPixelRatio(ratio);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    if (held > 0) held -= dt; else angle += TURN_RATE * dt;
    if (figure) {
        figure.bodyYaw = angle;
        // Looking the way it faces, standing still.
        figure.update(dt, { x: 0, y: 0, z: 0, yaw: angle - Math.PI, pitch: 0, speed: 0, onGround: true, inWater: false, light: 1, lightDir: SUN });
    }
    renderer.render(scene, camera);
}

const api = {
    looks: () => ({ ...MODELS.quiddle.variants }),
    defaultSkin: () => ({ ...DEFAULT_SKIN }),
    clean: (skin) => cleanSkin(skin, MODELS.quiddle),

    async show(canvas, skin) {
        await ensureModels();
        if (canvasEl !== canvas) {
            renderer?.dispose();
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
            renderer.setClearColor(0x000000, 0);
            scene = new THREE.Scene();
            // Far off and through a long lens, so the figure is not distorted.
            camera = new THREE.PerspectiveCamera(22, 1, 0.1, 50);
            camera.position.set(0, 1.12, 5.3);
            camera.lookAt(0, 0.94, 0);
            figure = null;
        }
        canvasEl = canvas;
        active = true;
        api.set(skin);
        cancelAnimationFrame(raf);
        last = performance.now();
        raf = requestAnimationFrame(frame);
    },

    set(skin) {
        if (!scene || !models?.loaded) return;
        if (!figure) { figure = new PlayerModel(models, skin); scene.add(figure.mesh); }
        else scene.add(figure.setSkin(skin));
    },

    turn(by) { angle += by; held = 2.5; },

    hide() {
        cancelAnimationFrame(raf);
        active = false;
    },

    /** A look at random — every choice any, whatever the others are. */
    random() {
        const out = {};
        for (const [k, n] of Object.entries(MODELS.quiddle.variants)) out[k] = Math.floor(Math.random() * n);
        return out;
    },
};

window.__wwCharacter = api;
