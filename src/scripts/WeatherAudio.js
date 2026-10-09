/**
 * WeatherAudio — rain, wind and thunder. Rain and wind are made here as they
 * are needed — filtered noise, which is what they are — so they never repeat
 * audibly. Thunder is played from data/sounds/ambiant/thunder_*.ogg (a stroke
 * worked out a pulse at a time by tools/gen_sounds.mjs; a clap of raw noise,
 * as it used to be, sounded like a game console), with a made rumble as the
 * fallback where a pack has no such files.
 *
 *   rain    pink noise, band-limited; louder and lower as it gets heavier, and
 *           muffled under a roof or in a cave
 *   hail    the rain loop, brighter, rattling
 *   wind    brown noise through a band-pass that sweeps with the gusts
 *   thunder a near, a middling or a far-off take by the distance; it arrives
 *           after distance / 343 seconds (one block = one metre) and the
 *           farther the strike, the quieter and more muffled it is
 *
 * It plays through the game's one mixer (Sound.js: its context and its weather
 * bus), which exists once the player has clicked into the game, and its volume
 * is Settings → Audio → Weather.
 */

import { sound } from './Sound.js';

const SPEED_OF_SOUND = 343;   // blocks (metres) per second

function noiseBuffer(ctx, seconds, kind) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'pink') {
            b0 = 0.99765 * b0 + w * 0.0990460;
            b1 = 0.96300 * b1 + w * 0.2965164;
            b2 = 0.57000 * b2 + w * 1.0526913;
            d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        } else {
            last = (last + 0.02 * w) / 1.02;
            d[i] = last * 3.5;
        }
    }
    // Crossfade the ends so the loop point does not click.
    const fade = Math.min(2048, n >> 3);
    for (let i = 0; i < fade; i++) {
        const t = i / fade;
        d[i] = d[i] * t + d[n - fade + i] * (1 - t);
    }
    return buf;
}

export class WeatherAudio {
    constructor() {
        this.ctx = null;
        this.volume = 0.8;
        this.failed = false;
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v ?? 0.8));
        if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.1);
    }

    _init() {
        if (this.ctx || this.failed) return !!this.ctx;
        // The mixer exists once the player has done something (browsers refuse
        // to start audio before that, and warn every time it is tried).
        const mixer = sound.weatherBus();
        if (!mixer) return false;
        const ctx = this.ctx = mixer.ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(mixer.bus);

        const pink = noiseBuffer(ctx, 4, 'pink');
        const brown = noiseBuffer(ctx, 5, 'brown');
        const loop = (buf) => {
            const s = ctx.createBufferSource();
            s.buffer = buf; s.loop = true;
            s.start(0, Math.random() * buf.duration);
            return s;
        };

        // Rain: high-passed pink noise, low-passed by how exposed the player is.
        this.rainHp = ctx.createBiquadFilter(); this.rainHp.type = 'highpass'; this.rainHp.frequency.value = 350;
        this.rainLp = ctx.createBiquadFilter(); this.rainLp.type = 'lowpass'; this.rainLp.frequency.value = 7000;
        this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
        loop(pink).connect(this.rainHp).connect(this.rainLp).connect(this.rainGain).connect(this.master);

        // Heavy-rain body: the low roar under a downpour.
        this.roarLp = ctx.createBiquadFilter(); this.roarLp.type = 'lowpass'; this.roarLp.frequency.value = 420;
        this.roarGain = ctx.createGain(); this.roarGain.gain.value = 0;
        loop(brown).connect(this.roarLp).connect(this.roarGain).connect(this.master);

        // Wind: brown noise through a moving band-pass.
        this.windBp = ctx.createBiquadFilter(); this.windBp.type = 'bandpass'; this.windBp.Q.value = 0.8; this.windBp.frequency.value = 300;
        this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
        loop(brown).connect(this.windBp).connect(this.windGain).connect(this.master);
        return true;
    }

    /**
     * @param {object} s {
     *   rain     liquid precipitation at the player, 0..1
     *   pellet   sleet/hail share of it, 0..1
     *   wind     wind speed, blocks/s
     *   exposure 0 (deep underground) … 1 (open sky)
     *   covered  true under a roof or tree
     * }
     */
    update(dt, s) {
        // Ten times a second is plenty for ambience, and every setTargetAtTime
        // adds an event to the parameter's automation timeline.
        this._tick = (this._tick ?? 0) + dt;
        if (this._tick < 0.1) return;
        dt = this._tick;
        this._tick = 0;
        const audible = (s.rain > 0.01 || s.wind > 3) && this.volume > 0;
        if (!this.ctx && !audible) return;
        if (!this._init()) return;
        const ctx = this.ctx, t = ctx.currentTime;
        // A context can be suspended (tab in the background, OS audio change);
        // ask for it back now and then, not every frame.
        this._resumeT = (this._resumeT ?? 0) - dt;
        if (ctx.state === 'suspended' && this._resumeT <= 0) {
            this._resumeT = 2;
            ctx.resume().catch(() => {});
        }
        this.exposure = s.exposure;

        const ex = Math.max(0, Math.min(1, s.exposure));
        const r = s.rain;
        const muffle = s.covered ? 0.55 : 1;
        this.rainGain.gain.setTargetAtTime((0.32 * r + 0.3 * r * r) * ex * muffle, t, 0.4);
        this.rainLp.frequency.setTargetAtTime(s.covered ? 1100 : 4200 + 5000 * s.pellet - 1500 * r, t, 0.4);
        this.rainHp.frequency.setTargetAtTime(350 + 1400 * s.pellet, t, 0.4);
        this.roarGain.gain.setTargetAtTime(Math.max(0, r - 0.4) * 0.5 * ex, t, 0.6);

        const w = Math.max(0, Math.min(1, (s.wind - 2) / 18));
        this.windGain.gain.setTargetAtTime(Math.pow(w, 1.4) * 0.55 * (0.3 + 0.7 * ex), t, 0.5);
        this.windBp.frequency.setTargetAtTime(220 + w * 520, t, 0.3);
    }

    /** Thunder for a strike `dist` blocks away. */
    thunder(dist) {
        if (this.volume <= 0 || !this._init()) return;
        const ctx = this.ctx;
        // A recorded stroke: near ones crack, far ones only roll. Underground
        // it comes through the rock, quieter and with the top off.
        const take = dist < 260 ? 'thunder_close' : dist < 900 ? 'thunder_mid' : 'thunder_far';
        if (sound.has(take)) {
            const ex = Math.max(0, Math.min(1, this.exposure ?? 1));
            sound.play(take, {
                volume: this.volume * Math.min(1, 1.25 / (1 + dist / 420)) * (0.35 + 0.65 * ex),
                delay: dist / SPEED_OF_SOUND, wait: true, vary: 0.04, pitch: ex < 0.3 ? 0.9 : 1, bus: 'weather',
            });
            return;
        }
        const close = false;
        const dur = 3.5 + Math.min(4, dist / 90);
        const n = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        const sr = ctx.sampleRate;
        // A rumble is several overlapping rolls, each a decaying burst of brown noise.
        const rolls = [];
        const count = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) rolls.push([Math.random() * dur * 0.45, 0.4 + Math.random() * 0.6, 0.6 + Math.random() * 1.4]);
        // The envelope moves slowly, so it is evaluated once per 32-sample block;
        // per sample this would be millions of exp() calls and a frame hitch.
        let last = 0, env = 0;
        for (let i = 0; i < n; i++) {
            const tt = i / sr;
            if ((i & 31) === 0) {
                env = 0;
                for (const [start, amp, decay] of rolls) {
                    if (tt >= start) env += amp * Math.exp(-(tt - start) / decay) * Math.min(1, (tt - start) * 20);
                }
            }
            const w = Math.random() * 2 - 1;
            last = (last + 0.03 * w) / 1.03;
            let v = last * 3.2 * env;
            if (close && tt < 0.25) v += w * Math.exp(-tt * 18) * 0.9;   // the crack
            d[i] = v;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = close ? 3500 : Math.max(180, 1400 - dist * 2.5);
        const g = ctx.createGain();
        g.gain.value = Math.min(1, 1.1 / (1 + dist / 160));
        src.connect(lp).connect(g).connect(this.master);
        src.start(ctx.currentTime + dist / SPEED_OF_SOUND);
    }

    /** Fade everything out (leaving a world). */
    silence() {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        for (const g of [this.rainGain, this.roarGain, this.windGain]) g.gain.setTargetAtTime(0, t, 0.2);
    }

    dispose() {
        this.master?.disconnect();      // the context is the mixer's, and stays
        this.ctx = null;
    }
}
