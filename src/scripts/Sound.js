/**
 * Sound — everything the game plays that is a recording: footsteps, blocks,
 * animals, ambience, thunder and the music. (Rain and wind are made as they
 * are needed, in WeatherAudio.js, and come out through this module's mixer.)
 *
 * **The files** are in data/sounds/, found through the data manifest:
 *
 *   blocks/    <material>_step_1.ogg, _hit_, _break_, _place_, water_splash_ …
 *   entities/  cow_idle_1.ogg, cow_hurt_1.ogg, player_hurt_1.ogg, eat_1.ogg …
 *   ambiant/   birds.ogg, crickets.ogg, cave.ogg, water.ogg, thunder_close_1.ogg …
 *   ui/        click.ogg
 *   music/     Adventure Awaits.m4a
 *
 * A sound is asked for by name — its file's name without the folder, the
 * number and the extension ("grass_step"). Files that differ only in that
 * number are takes of one sound, and one is picked each time (never the same
 * twice running), a little higher or lower, so a walk is not one step played
 * over and over. A name with no file is silence: a pack may leave any out,
 * and any file can be replaced by a recording of the same name.
 * tools/gen_sounds.mjs makes the ones that ship (`npm run sounds`).
 *
 * **The mixer.** One AudioContext for the whole game:
 *
 *   sfx ─┐
 *   ambience ─┼─ muffle (a low-pass, shut down under water) ─ master ─ out
 *   weather ─┘
 *
 * Music is an <audio> element — the track is minutes long, and decoding it
 * whole would hold some seventy megabytes — so it has its own volume, worked
 * out from the same settings.
 *
 * A browser lets a page make sound only after the player has clicked or
 * pressed something. Until then nothing here plays; the music starts on that
 * first click (in the desktop app, which allows it, at once).
 *
 * Positional sounds are placed by ear, cheaply: quieter with distance and
 * panned by where they are from the way the listener faces. Beyond `reach`
 * nothing is played at all.
 */

const EXT = /\.(ogg|wav|mp3|m4a|flac)$/i;
const TAKE = /_(\d+)$/;

/** How long the music takes to come up and go down, seconds. */
const MUSIC_FADE_IN = 2.5, MUSIC_FADE_OUT = 3.5;

class SoundEngine {
    constructor() {
        this.ctx = null;
        this.volumes = { master: 1, music: 0.6, sfx: 0.9, ambience: 0.7 };
        /** False in a split-screen pane other than the first: what everyone hears — music, ambience, weather — comes from the first. */
        this.shared = true;
        this._takes = new Map();     // name → [url, …]
        this._buffers = new Map();   // url → AudioBuffer | Promise | null (failed)
        this._last = new Map();      // name → index of the take last played
        this._loops = new Map();     // name → { gain, src, want }
        this._lx = 0; this._ly = 0; this._lz = 0; this._rx = 1; this._rz = 0;
        this._muffled = false;
        this._music = null;          // { el, name, fade, target, timer }
        this._musicWant = null;
        this._ready = this._loadManifest();
        // The first click or key lets sound through.
        const wake = () => this._wake();
        for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, wake, { capture: true, passive: true });
    }

    // ── Files ────────────────────────────────────────────────────────────────

    async _loadManifest() {
        try {
            const res = await fetch(`${location.origin}/api/data/manifest`);
            if (!res.ok) return;
            this.register((await res.json()).sounds ?? []);
        } catch { /* no server: silence */ }
    }

    /** Take in a list of file paths ("data/sounds/blocks/grass_step_1.ogg"). */
    register(paths) {
        for (const p of paths) {
            if (!EXT.test(p)) continue;
            const file = p.slice(p.lastIndexOf('/') + 1).replace(EXT, '');
            const name = file.replace(TAKE, '');
            const url = p.split('/').map(encodeURIComponent).join('/');
            const list = this._takes.get(name);
            if (list) { if (!list.includes(url)) list.push(url); }
            else this._takes.set(name, [url]);
        }
        for (const list of this._takes.values()) list.sort();
    }

    has(name) { return this._takes.has(name); }

    /** The decoded take, or null while it is on its way (it is asked for then). */
    _buffer(url) {
        const got = this._buffers.get(url);
        if (got !== undefined) return got instanceof Promise ? null : got;
        const p = fetch(url).then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))
            .then(data => this.ctx.decodeAudioData(data))
            .then(buf => { this._buffers.set(url, buf); return buf; })
            .catch(() => { this._buffers.set(url, null); return null; });
        this._buffers.set(url, p);
        return null;
    }

    /**
     * Fetch and decode the short sounds ahead of need, so the first footstep is
     * not missed. Ambience and thunder are long (tens of megabytes decoded) and
     * are left until they are wanted; the music is never decoded whole.
     */
    async preload() {
        await this._ready;
        if (!this._context()) return false;
        for (const list of this._takes.values()) {
            if (list[0].includes('/music/') || list[0].includes('/ambiant/')) continue;
            for (const url of list) this._buffer(url);
        }
        return true;
    }

    // ── The mixer ────────────────────────────────────────────────────────────

    /** The AudioContext, made on first use; null until the player has done something. */
    _context() {
        if (this.ctx) return this.ctx;
        const AC = window.AudioContext ?? window.webkitAudioContext;
        if (!AC) return null;
        // Chromium warns in the console about a context made before any gesture.
        if (navigator.userActivation && !navigator.userActivation.hasBeenActive && !window.__wwAutoplay) return null;
        let ctx;
        try { ctx = new AC({ latencyHint: 'interactive' }); } catch { return null; }
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.connect(ctx.destination);
        this.muffle = ctx.createBiquadFilter();
        this.muffle.type = 'lowpass';
        this.muffle.frequency.value = 20000;
        this.muffle.Q.value = 0.5;
        this.muffle.connect(this.master);
        this.buses = {};
        for (const name of ['sfx', 'ambience', 'weather']) {
            const g = ctx.createGain();
            g.connect(this.muffle);
            this.buses[name] = g;
        }
        this._applyVolumes();
        return ctx;
    }

    /** Where WeatherAudio connects: the context and its bus, or null for now. */
    weatherBus() {
        const ctx = this._context();
        return ctx ? { ctx, bus: this.buses.weather } : null;
    }

    _wake() {
        const ctx = this._context();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        if (ctx) for (const url of this._takes.get('click') ?? []) this._buffer(url);    // the menus' one sound
        if (this._musicWant && (!this._music || this._music.el.paused)) this.playMusic(this._musicWant);
    }

    setVolumes(v) {
        for (const k of ['master', 'music', 'sfx', 'ambience']) {
            if (Number.isFinite(v[k])) this.volumes[k] = Math.max(0, Math.min(1, v[k]));
        }
        this._applyVolumes();
    }

    _applyVolumes() {
        const v = this.volumes;
        if (this.ctx) {
            const t = this.ctx.currentTime;
            this.master.gain.setTargetAtTime(v.master, t, 0.03);
            this.buses.sfx.gain.setTargetAtTime(v.sfx, t, 0.03);
            this.buses.ambience.gain.setTargetAtTime(this.shared ? v.ambience : 0, t, 0.03);
            this.buses.weather.gain.setTargetAtTime(this.shared ? 1 : 0, t, 0.03);
        }
        this._musicVolume();
    }

    /** Head under water: everything but the music goes dull. */
    setMuffled(on) {
        if (on === this._muffled || !this.ctx) { this._muffled = on && !!this.ctx; return; }
        this._muffled = on;
        this.muffle.frequency.setTargetAtTime(on ? 650 : 20000, this.ctx.currentTime, on ? 0.05 : 0.15);
    }

    /** Where the player's ears are and which way they face (yaw as the camera's). */
    setListener(x, y, z, yaw) {
        this._lx = x; this._ly = y; this._lz = z;
        this._rx = Math.cos(yaw); this._rz = -Math.sin(yaw);
    }

    // ── One-shots ────────────────────────────────────────────────────────────

    /**
     * Play a sound once.
     *   volume   0 … 1 (default 1)
     *   pitch    playback rate (default 1); `vary` spreads it (default ±6%)
     *   at       { x, y, z } — where it is; without it, at the listener
     *   reach    how far it carries in blocks (default 24)
     *   delay    seconds from now
     *   bus      'sfx' (default), 'ambience' or 'weather'
     *   wait     if it is not decoded yet, play it when it is (else it is missed)
     * Returns false when nothing was played.
     */
    play(name, o = null) {
        const list = this._takes.get(name);
        if (!list) return false;
        const ctx = this._context();
        if (!ctx || ctx.state !== 'running') return false;

        let gain = o?.volume ?? 1, pan = 0;
        const at = o?.at;
        if (at) {
            const dx = at.x - this._lx, dy = at.y - this._ly, dz = at.z - this._lz;
            const d = Math.hypot(dx, dy, dz), reach = o.reach ?? 24;
            if (d >= reach) return false;
            // Full within two blocks, then falling away, and to nothing at the reach.
            const near = 2, fall = d <= near ? 1 : near / d;
            gain *= fall * (1 - (d / reach) ** 2);
            if (d > 0.5) pan = Math.max(-1, Math.min(1, (dx * this._rx + dz * this._rz) / d)) * 0.75;
        }
        if (gain <= 0.003) return false;

        let i = o?._take ?? (list.length > 1 ? Math.floor(Math.random() * list.length) : 0);
        if (o?._take == null && list.length > 1 && i === this._last.get(name)) i = (i + 1) % list.length;
        this._last.set(name, i);
        const buf = this._buffer(list[i]);
        if (!buf) {
            // Still decoding: this one is missed and the next is not — unless it
            // is worth waiting for (thunder, which is late anyway).
            const pending = this._buffers.get(list[i]);
            if (o?.wait && pending instanceof Promise) {
                const t0 = ctx.currentTime;
                pending.then((b) => {
                    if (b) this.play(name, { ...o, wait: false, _take: i, delay: Math.max(0, (o.delay ?? 0) - (ctx.currentTime - t0)) });
                });
            }
            return false;
        }

        const src = ctx.createBufferSource();
        src.buffer = buf;
        const vary = o?.vary ?? 0.06;
        src.playbackRate.value = (o?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * vary);
        const g = ctx.createGain();
        g.gain.value = gain;
        src.connect(g);
        let out = g;
        if (pan !== 0 && ctx.createStereoPanner) {
            const p = ctx.createStereoPanner();
            p.pan.value = pan;
            g.connect(p);
            out = p;
        }
        out.connect(this.buses[o?.bus ?? 'sfx'] ?? this.buses.sfx);
        src.start(ctx.currentTime + (o?.delay ?? 0));
        return true;
    }

    // ── Loops ────────────────────────────────────────────────────────────────

    /**
     * Set how loud a looping sound is (0 stops it once it has faded). Call as
     * often as you like; it eases there over `ease` seconds.
     */
    loop(name, volume, ease = 1.2) {
        let l = this._loops.get(name);
        if (!l) {
            if (volume <= 0 || !this._takes.has(name)) return;
            l = { gain: null, src: null, want: 0 };
            this._loops.set(name, l);
        }
        l.want = volume;
        const ctx = this._context();
        if (!ctx || ctx.state !== 'running') return;
        if (!l.src) {
            if (volume <= 0) return;
            const buf = this._buffer(this._takes.get(name)[0]);
            if (!buf) return;                // asked for; started on a later call
            l.gain = ctx.createGain();
            l.gain.gain.value = 0;
            l.gain.connect(this.buses.ambience);
            l.src = ctx.createBufferSource();
            l.src.buffer = buf;
            l.src.loop = true;
            l.src.connect(l.gain);
            // Not from the top every time: a loop met twice should not open the same way.
            l.src.start(0, Math.random() * buf.duration);
        }
        l.gain.gain.setTargetAtTime(volume, ctx.currentTime, ease / 3);
        if (volume <= 0) {
            const { src, gain } = l;
            l.src = l.gain = null;
            setTimeout(() => { try { src.stop(); } catch { /* already */ } src.disconnect(); gain.disconnect(); }, ease * 1500);
        }
    }

    /** Stop every loop (leaving a world). */
    stopLoops() {
        for (const name of this._loops.keys()) this.loop(name, 0, 0.3);
    }

    // ── Music ────────────────────────────────────────────────────────────────

    _musicVolume() {
        const m = this._music;
        if (!m) return;
        const v = this.shared ? this.volumes.master * this.volumes.music * m.fade : 0;
        m.el.volume = Math.max(0, Math.min(1, v));
    }

    /** Play a track from data/sounds/music/ by name, looping, fading in. */
    async playMusic(name) {
        this._musicWant = name;
        if (!this.shared) return;
        await this._ready;
        if (this._musicWant !== name) return;
        const list = this._takes.get(name);
        if (!list) return;
        let m = this._music;
        if (!m || m.name !== name) {
            m?.el.pause();
            const el = new Audio(list[0]);
            el.loop = true;
            el.preload = 'auto';
            m = this._music = { el, name, fade: 0, target: 1, timer: 0 };
        }
        this._fadeMusic(1, MUSIC_FADE_IN);
        if (m.el.paused) {
            try { await m.el.play(); }
            catch { /* not allowed yet: _wake() tries again on the first click */ }
        }
    }

    /** Fade the music out and stop it (a world has started). */
    stopMusic(seconds = MUSIC_FADE_OUT) {
        this._musicWant = null;
        if (this._music) this._fadeMusic(0, seconds);
    }

    _fadeMusic(target, seconds) {
        const m = this._music;
        if (!m) return;
        m.target = target;
        clearInterval(m.timer);
        const step = 0.05 / Math.max(0.05, seconds);
        m.timer = setInterval(() => {
            m.fade += Math.sign(m.target - m.fade) * Math.min(step, Math.abs(m.target - m.fade));
            this._musicVolume();
            if (m.fade === m.target) {
                clearInterval(m.timer);
                if (m.target === 0) m.el.pause();
            }
        }, 50);
        this._musicVolume();
    }

    /** What is going on, for tests. */
    debug() {
        return {
            context: this.ctx?.state ?? 'none', sounds: this._takes.size,
            decoded: [...this._buffers.values()].filter(b => b && !(b instanceof Promise)).length,
            loops: [...this._loops].filter(([, l]) => l.src).map(([n, l]) => `${n}:${l.want.toFixed(2)}`),
            music: this._music ? { name: this._music.name, playing: !this._music.el.paused, volume: +this._music.el.volume.toFixed(3) } : null,
            wantMusic: this._musicWant,
        };
    }
}

export const sound = new SoundEngine();
window.__wwSound = sound;

/**
 * Which sounds a block makes: the family named by its "sound" in the block's
 * JSON, or one guessed from its name. Every family has `_step`, `_hit`,
 * `_break` and `_place`.
 */
const FAMILY_BY_NAME = [
    [/SNOW/, 'snow'], [/LEAVES|CACTUS/, 'leaves'], [/GLASS|ICE|LANTERN|LAMP/, 'glass'],
    [/GRASS|PODZOL|MYCELIUM|MOSS/, 'grass'], [/SAND(?!STONE)/, 'sand'], [/GRAVEL/, 'gravel'],
    [/DIRT|MUD|CLAY/, 'dirt'], [/WOOD|LOG|PLANK|CRAFT|CHEST|STEM|MUSHROOM|TORCH|LADDER|DOOR/, 'wood'],
];
export function blockSoundFamily(def) {
    if (!def) return 'stone';
    if (def.sound) return def.sound;
    const name = String(def.name ?? '').toUpperCase();
    for (const [re, family] of FAMILY_BY_NAME) if (re.test(name)) return family;
    return 'stone';
}
