/**
 * Atmosphere — the day cycle and the weather, turned into what you see and hear.
 *
 * Each frame it advances the clock (DayCycle) and the weather (WeatherSystem),
 * samples the climate at the player (Climate), and writes the shared atmosphere
 * uniforms (AtmosGLSL) that the terrain, sky, clouds and precipitation all read.
 * It owns the effect modules:
 *
 *   Sky            dome, sun, moon, stars          Graphics → Sky (simple/pretty)
 *   Clouds         the cloud layer                 Graphics → Clouds (fast/fancy)
 *   Precipitation  rain, snow, sleet, hail, dust, ash, splashes  × Graphics → Particles
 *   Lightning      bolts and flashes
 *   Tornado        funnel and debris
 *   WeatherAudio   rain, wind, thunder             Audio → Weather Volume
 *
 * world.js reads back what the rest of the game needs: the light direction and
 * strength for shadows (`state`), `mobLight` for Lambert-lit mobs and debris,
 * `wind` for leaves and particles, `ice` for slippery ground, and `push`, the
 * tornado's pull on the player.
 *
 * The GPU objects live as long as the renderer; startWorld/endWorld bind a world.
 */

import * as THREE from 'three';
import { DayCycle, newSkyState, SUNRISE_HOUR, smoothstep } from './engine/DayCycle.js';
import {
    WeatherSystem, COVER, DARK, RAIN_BASE, FOG, FOG_SCALE, HAZE, GUST,
    TINT_R, TINT_G, TINT_B, TINT, precipShares,
} from './engine/Weather.js';
import { Climate, newClimate } from './engine/Climate.js';
import { CloudField } from './engine/CloudField.js';
import { CHUNK_SHIFT, CHUNK_MASK, WORLD_MIN_Y } from './engine/ChunkData.js';
import { makeAtmosUniforms, CLOUD_BASE } from './AtmosGLSL.js';
import { Sky } from './Sky.js';
import { Clouds } from './Clouds.js';
import { Precipitation } from './Precipitation.js';
import { Lightning } from './Lightning.js';
import { Tornado } from './Tornado.js';
import { WeatherAudio } from './WeatherAudio.js';

const CLOUD_WIND = 1.8;       // clouds move faster than the wind at the ground
const FOG_BASE   = 62;        // ground fog is densest at about sea level
const TORNADO_REACH = 45;     // blocks within which a tornado pulls the player

const lum = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

export class Atmosphere {
    constructor(scene) {
        this.scene = scene;
        this.uniforms = makeAtmosUniforms();
        this.field = new CloudField();
        this.sky = new Sky(scene, this.uniforms);
        this.clouds = new Clouds(scene, this.uniforms, this.field);
        this.precip = new Precipitation(scene, this.uniforms);
        this.lightning = new Lightning(scene, this.uniforms);
        this.tornado = new Tornado(scene, this.uniforms);
        this.audio = new WeatherAudio();

        this.day = new DayCycle();
        this.weather = new WeatherSystem(1);
        this.state = newSkyState();
        this.climate = newClimate();
        this.climateModel = null;
        this.world = null;
        this.active = false;

        this.skyMode = 'simple';
        this.particleScale = 0.6;
        this.onStrike = null;            // (x, y, z) => void — world.js: damage near a strike

        // Read by world.js
        this.mobLight = 1;
        this.wind = [0, 0];
        this.ice = 0;
        this.push = { x: 0, y: 0, z: 0 };
        this.baseFogNear = 160;
        this.baseFogFar = 280;

        this._skyLit = 1;
        this._climateT = 0;
        this._time = 0;
        this._tor = { on: false, x: 0, z: 0, heading: 0, alpha: 0 };
        this._shares = [1, 0, 0];
        this._light = [1, 1, 1];
        this._fog = [0, 0, 0];
        this._ovc = [0, 0, 0];
        this._amb = [0, 0, 0];
    }

    // ── World binding ────────────────────────────────────────────────────────

    /**
     * @param {object} o { seed, biomes, world (WorldState),
     *                     saved (toJSON() output or null), daylightCycle, weather,
     *                     worldGen (the world's generator version, for its climate) }
     */
    startWorld(o) {
        this.world = o.world;
        this.climateModel = new Climate(o.seed ?? 0, o.biomes ?? [], o.worldGen ?? 1, o.flat ?? null);
        this.day = new DayCycle();
        this.weather = new WeatherSystem((o.seed ?? 1) | 0);
        const mode = o.weather ?? 'dynamic';
        if (o.saved) {
            this.day.fromJSON(o.saved.day);
            this.weather.fromJSON(o.saved.weather);
            const c = o.saved.clouds;
            if (c?.a?.length === 2) { this.field.offA[0] = +c.a[0] || 0; this.field.offA[1] = +c.a[1] || 0; }
            if (c?.b?.length === 2) { this.field.offB[0] = +c.b[0] || 0; this.field.offB[1] = +c.b[1] || 0; }
        }
        if (!o.saved || o.saved.weather?.mode !== mode) this.weather.setMode(mode, true);
        else this.weather.mode = mode;
        this.day.running = o.daylightCycle !== false;
        this.precip.heightmap.reset();
        this.precip.enabled = true;
        this._tor.on = false; this._tor.alpha = 0;
        this._climateT = 0;
        this.active = true;
    }

    endWorld() {
        this.active = false;
        this.world = null;
        this.climateModel = null;
        this.precip.enabled = false;
        this.precip.heightmap.reset();
        this.lightning.clear();
        this._tor.on = false; this._tor.alpha = 0;
        this.tornado.update(0, 0, 0, 0, this._light);
        this.audio.silence();
        this.push.x = this.push.y = this.push.z = 0;
    }

    toJSON() {
        return {
            day: this.day.toJSON(),
            weather: this.weather.toJSON(),
            clouds: { a: [...this.field.offA], b: [...this.field.offB] },
        };
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    setSkyMode(mode) { this.skyMode = mode === 'pretty' ? 'pretty' : 'simple'; this.sky.setMode(this.skyMode); }
    setCloudLevel(level) { this.clouds.setLevel(level); }
    setParticleScale(s) { this.particleScale = s; this.precip.setScale(s); }
    setVolume(v) { this.audio.setVolume(v); }
    setReduceMotion(on) { this.lightning.reduce = !!on; }
    setDaylightCycle(on) { this.day.running = !!on; }
    /** `immediate` skips the roll-in (tests); from the settings screen it rolls in. */
    setWeatherMode(mode, immediate = false) { this.weather.setMode(mode, immediate); }
    setHours(h) { this.day.setHours(h); }

    /** Offscreen work for this frame (fancy clouds), after update() and before the scene renders. */
    prerender(renderer, camera) { this.clouds.prerender(renderer, camera); }
    /** Compile shaders that are drawn off screen, ahead of first use. */
    warm(renderer, camera) { this.clouds.warm(renderer, camera); }

    /** A chunk was (re-)meshed: `heights` is where rain stops in it (geo.rain from the worker). */
    setColumnHeights(cx, cz, heights) { this.precip.heightmap.setChunk(cx, cz, heights); }
    /** Chunk `key` unloaded. */
    dropColumns(key) { this.precip.heightmap.drop(key); }

    /** Ground height at a column: the rain heightmap, else a column scan, else sea level. */
    groundAt(x, z) {
        const h = this.precip.heightmap.heightAt(x, z);
        if (h !== null) return h;
        const bx = Math.floor(x), bz = Math.floor(z);
        const chunk = this.world?.getChunk(bx >> CHUNK_SHIFT, bz >> CHUNK_SHIFT);
        if (!chunk?.generated) return 64;
        const ly = chunk.columnTop(bx & CHUNK_MASK, bz & CHUNK_MASK);
        return ly < 0 ? 64 : WORLD_MIN_Y + ly + 1;
    }

    // ── Frame ────────────────────────────────────────────────────────────────

    /**
     * @param {number} dt
     * @param {object} f { camera, paused, px, py, pz, skyLight (0..1 sky light at the
     *                     camera), fade (cloud fade distance), fog (THREE.Fog|null),
     *                     background (THREE.Color|null) }
     */
    update(dt, f) {
        const cam = f.camera.position;
        const paused = !!f.paused || !this.active;
        this._time = (this._time + dt) % 3600;
        this.uniforms.uTime.value = this._time;

        if (!paused) this.day.advance(dt);
        const st = this.day.sample(this.state);

        // Climate at the player, twice a second (a few noise samples).
        this._climateT -= dt;
        if (this.climateModel && this._climateT <= 0) {
            this._climateT = 0.5;
            this.climateModel.at(f.px, f.py, f.pz, this.climate);
        }

        const W = this.weather;
        W.update(dt, { hours: st.hours, climate: this.climateModel ? this.climate : null,
            field: this.field, px: f.px, pz: f.pz, paused });
        const P = W.P;
        this.wind[0] = W.wind[0]; this.wind[1] = W.wind[1];
        this.ice = W.ice;

        // Cloud field follows the weather and drifts on the wind.
        const field = this.field;
        field.setCoverage(P[COVER]);
        field.rainBase = P[RAIN_BASE];
        if (!paused) field.drift(W.wind[0] * CLOUD_WIND * dt, W.wind[1] * CLOUD_WIND * dt, dt);
        // The GPU reads the same field: clouds, their shadows and rain placement.
        const u = this.uniforms;
        u.uCloudThresh.value = field.threshold;
        u.uRainBase.value = field.rainBase;
        u.uCloudOffA.value.set(field.offA[0], field.offA[1]);
        u.uCloudOffB.value.set(field.offB[0], field.offB[1]);

        this._skyLit += ((f.skyLight ?? 1) - this._skyLit) * (1 - Math.exp(-dt * 4));
        const lit = this._skyLit;

        // Lightning first: its flash feeds every colour below.
        for (const ev of W.events) {
            const gy = this.groundAt(ev.x, ev.z);
            if (ev.cloud) this.lightning.cloudFlash(ev.x, ev.z, CLOUD_BASE, ev.dist, W.rand);
            else {
                this.lightning.strike(ev.x, ev.z, gy, CLOUD_BASE - 2, ev.dist, W.rand);
                this.onStrike?.(ev.x, gy, ev.z);
            }
            this.audio.thunder(ev.dist + (ev.cloud ? 60 : 0));
        }
        this.lightning.update(dt);
        const flash = this.lightning.flash;

        this._colours(st, P, lit, flash, f);
        this._tornado(dt, paused, f);

        // Effects
        this.sky.update(cam, (st.hours - SUNRISE_HOUR) / 12 * Math.PI);
        this.clouds.update(cam, f.fade);
        this.precip.update(dt, P, W.wind, this._light, f.px, f.pz);

        // Sound, from what is actually falling on the player.
        const shares = precipShares(P, this._shares);
        const here = this.active ? W.precipAt(field, f.px, f.pz) : 0;
        const roof = this.precip.heightmap.heightAt(f.px, f.pz);
        const tor = this._tor.alpha * Math.max(0, 1 - Math.hypot(this._tor.x - f.px, this._tor.z - f.pz) / 300);
        this.audio.update(dt, {
            rain: here * (shares[0] + shares[2]),
            pellet: shares[2],
            wind: this.active ? Math.max(W.windSpeed, tor * 30) : 0,
            exposure: (f.skyLight ?? 1),
            covered: roof !== null && roof > f.py + 2.2,
        });
    }

    /** Sky, fog, light and cloud colours for this frame. All raw display values. */
    _colours(st, P, lit, flash, f) {
        const u = this.uniforms;
        const pretty = this.skyMode === 'pretty';
        const cover = Math.min(1.15, Math.max(0, P[COVER]));
        const dark = P[DARK];
        const overcast = smoothstep(0.35, 1.05, cover);
        const tint = P[TINT];
        const tR = P[TINT_R], tG = P[TINT_G], tB = P[TINT_B];
        const dayLum = lum(st.ambient);

        // Overcast sky: grey, darker for storms, scaled with daylight.
        const ovc = this._ovc;
        const g = (1 - 0.45 * dark) * dayLum;
        ovc[0] = 0.60 * g; ovc[1] = 0.63 * g; ovc[2] = 0.68 * g;

        // Fog / horizon colour.
        const base = pretty ? st.horizon : st.flat;
        const fog = this._fog;
        for (let i = 0; i < 3; i++) {
            let c = base[i] + (ovc[i] - base[i]) * overcast;
            c += ((i === 0 ? tR : i === 1 ? tG : tB) * dayLum - c) * tint;
            fog[i] = c * lit;
        }
        u.uFogColor.value.set(fog[0], fog[1], fog[2]);
        const glow = pretty ? 0.6 * (1 - overcast) * (1 - tint * 0.5) * lit : 0;
        u.uFogSun.value.set(st.glow[0] * glow, st.glow[1] * glow, st.glow[2] * glow);
        f.background?.setRGB(fog[0], fog[1], fog[2], THREE.SRGBColorSpace);
        if (f.fog) f.fog.color.setRGB(fog[0], fog[1], fog[2], THREE.SRGBColorSpace);

        // Fog density. (Being inside a cloud needs nothing here: the cloud
        // itself is drawn over everything seen through it — Clouds.js.)
        u.uFogDensity.value = P[FOG];
        u.uFogScale.value = Math.max(8, P[FOG_SCALE]);
        u.uFogBase.value = FOG_BASE;
        const haze = P[HAZE];
        u.uHaze.value = haze;
        if (f.fog) {
            const dens = haze + P[FOG] * Math.exp(-Math.max(-40, f.py - FOG_BASE) / Math.max(8, P[FOG_SCALE]));
            const vis = dens > 1e-4 ? 3 / dens : Infinity;
            f.fog.far = Math.min(this.baseFogFar, vis);
            f.fog.near = Math.min(this.baseFogNear, f.fog.far * 0.25);
        }

        // Directions
        u.uSkySunDir.value.fromArray(st.sunDir);
        u.uMoonDir.value.fromArray(st.moonDir);

        // Light on terrain: storms dim the sky light; dust and ash tint it.
        const stormDim = 1 - 0.4 * overcast * dark;
        const amb = this._amb;
        for (let i = 0; i < 3; i++) {
            const t = i === 0 ? tR : i === 1 ? tG : tB;
            amb[i] = st.ambient[i] * stormDim * (1 + (t - 1) * tint * 0.6);
        }
        u.uAmbient.value.set(amb[0], amb[1], amb[2]);
        const dimDirect = 1 - tint * 0.5;
        u.uDirect.value.set(st.direct[0] * dimDirect, st.direct[1] * dimDirect, st.direct[2] * dimDirect);
        u.uFlash.value = flash * 0.8;
        u.uWet.value = this.weather.wet;
        u.uIce.value = this.weather.ice;
        u.uWind.value.set(this.weather.wind[0], this.weather.wind[1], P[GUST], 0);

        this.mobLight = Math.min(1.2, lum(amb) * 0.75 + lum(st.direct) * 0.25 + flash * 0.4);
        const pl = this._light;
        // Falling water and ice catch the light: particles read a little brighter than the air.
        for (let i = 0; i < 3; i++) pl[i] = ((amb[i] * 0.85 + st.direct[i] * 0.15) * lit) * 1.25 + 0.04 + flash * 0.6;

        // Sky dome
        const s = this.sky.uniforms;
        s.uZenith.value.set(
            (st.zenith[0] + (tR * dayLum - st.zenith[0]) * tint),
            (st.zenith[1] + (tG * dayLum - st.zenith[1]) * tint),
            (st.zenith[2] + (tB * dayLum - st.zenith[2]) * tint));
        s.uOvercast.value.set(ovc[0], ovc[1], ovc[2]);
        s.uOvercastAmt.value = overcast;
        s.uSkyLit.value = lit;
        const red = tint > 0 ? 1 - tint * 0.4 : 1;    // dust and ash redden the sun
        s.uSunColor.value.set(st.sunColor[0], st.sunColor[1] * red, st.sunColor[2] * red * red);
        const vis = (1 - smoothstep(0.7, 1.08, cover)) * (1 - tint * 0.6) * lit;
        s.uSunVis.value = vis;
        s.uMoonVis.value = vis;
        s.uMoonPhase.value = st.moonPhase;
        s.uStars.value = st.stars * (1 - smoothstep(0.3, 0.9, cover)) * (1 - tint);
        s.uSkyFlash.value.set(0.5, 0.55, 0.7).multiplyScalar(flash * 0.45 * lit);

        // Clouds: sunlit tops take the sun's colour, undersides the sky's.
        const c = this.clouds.uniforms;
        const sunUp = smoothstep(-0.05, 0.2, st.sunHeight);
        const litMul = 1 - 0.45 * dark;
        c.uCloudLit.value.set(
            (amb[0] * 0.5 + st.sunColor[0] * sunUp * 0.55) * litMul * lit,
            (amb[1] * 0.5 + st.sunColor[1] * sunUp * 0.55) * litMul * lit,
            (amb[2] * 0.5 + st.sunColor[2] * sunUp * 0.55) * litMul * lit);
        const sh = (0.78 - 0.5 * dark) * lit;
        c.uCloudShade.value.set(amb[0] * sh, amb[1] * sh, amb[2] * sh);
        c.uCloudDark.value = dark;
        const sil = sunUp * 0.5 * (1 - dark) * lit;
        c.uSilver.value.set(st.sunColor[0] * sil, st.sunColor[1] * sil, st.sunColor[2] * sil);
        c.uFlashPos.value.copy(this.lightning.flashPos);
        c.uFlashAmt.value = this.lightning.flashAmt;
    }

    /** Move the tornado (if any), draw it, and work out its pull on the player. */
    _tornado(dt, paused, f) {
        const T = this._tor, W = this.weather;
        const want = this.active && W.tornadoActive;
        const pu = this.push;
        pu.x = pu.y = pu.z = 0;

        if (want && !T.on) {
            // Spawn upwind, heading roughly toward the player.
            const a = W.windAngle, side = (W.rand() - 0.5) * 140;
            T.x = f.px - Math.cos(a) * 170 - Math.sin(a) * side;
            T.z = f.pz - Math.sin(a) * 170 + Math.cos(a) * side;
            T.heading = Math.atan2(f.pz - T.z, f.px - T.x) + (W.rand() - 0.5) * 0.7;
            T.on = true;
        }
        if (!T.on) { this.tornado.update(0, 0, 0, 0, this._light); return; }

        if (!paused) {
            T.heading += (W.rand() - 0.5) * 0.5 * dt;
            T.x += Math.cos(T.heading) * 7 * dt;
            T.z += Math.sin(T.heading) * 7 * dt;
        }
        const dx = T.x - f.px, dz = T.z - f.pz, d = Math.hypot(dx, dz);
        if (d > 520) {
            if (want) { T.on = false; return; }     // passed by: a new one forms upwind
            T.alpha = 0;
        }
        T.alpha += ((want ? 1 : 0) - T.alpha) * (1 - Math.exp(-dt / 4));
        if (!want && T.alpha < 0.01) { T.on = false; T.alpha = 0; }

        const gy = this.groundAt(T.x, T.z);
        this.tornado.update(T.x, gy, T.z, T.alpha, this._light, this.particleScale);

        if (!paused && d < TORNADO_REACH && T.alpha > 0.5 && d > 0.01) {
            const k = (1 - d / TORNADO_REACH) ** 2;
            const nx = dx / d, nz = dz / d;
            pu.x = nx * 14 * k - nz * 12 * k;         // inward, and around
            pu.z = nz * 14 * k + nx * 12 * k;
            if (d < 10 && f.py < gy + 40) pu.y = 60 * k;     // beats gravity (34) near the core
        }
    }

    /** Snapshot for the debug overlay and the smoke test. */
    info() {
        const h = this.day.hours;
        const W = this.weather;
        return {
            time: `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`,
            day: this.day.day,
            cycle: this.day.running,
            weather: W.local,
            weatherLabel: W.label,
            weatherMode: W.mode,
            cover: +W.P[COVER].toFixed(2),
            wind: +W.windSpeed.toFixed(1),
            sky: this.skyMode,
            clouds: this.clouds.level,
            tornado: this._tor.on,
            // Whether the GPU side sees any cloud (the uniform, not the CPU field).
            gpuClouds: this.uniforms.uCloudThresh.value < 1.5,
            // Weather particles being drawn, per kind (instances).
            particles: Object.fromEntries(Object.entries(this.precip.layers)
                .filter(([, l]) => l.mesh.visible)
                .map(([k, l]) => [k, l.geometry.instanceCount])),
        };
    }

    dispose() {
        this.endWorld();
        this.sky.dispose();
        this.clouds.dispose();
        this.precip.dispose();
        this.lightning.dispose();
        this.tornado.dispose();
        this.audio.dispose();
    }
}
