/**
 * Climate — the local climate at a world position, for the weather system.
 *
 * The weather is one world-wide state (Weather.js), but what falls out of it
 * depends on where the player is: the same storm is rain in the plains, snow on
 * a snowy peak and nothing but dry clouds over the desert. This works that out
 * from the same fields the terrain generator uses, so the climate always
 * matches the ground underneath.
 *
 * Current worlds (worldGen ≥ 2) ask Geography for the column the player is
 * over: its temperature and humidity, and its biome's weather settings.
 * Temperature falls with height above LAPSE_START at LAPSE_RATE (Geography.js)
 * — the same cooling that puts snow on the peaks — taken at the player's own
 * height, so it snows on a mountain top while it rains in the valley below.
 *
 * Worlds made with the old generator (worldGen 1) blend the old biomes'
 * configured climates by the old noise, as that generator did, with the old
 * biome list (legacy/legacyBiomes.js) — data/biomes/ no longer matches them.
 *
 * Biomes may carry an optional `weather` object:
 *   "weather": { "precipitation": 0.15, "dusty": 2 }
 *   precipitation — multiplier on how much rain/snow actually reaches the ground
 *                   (default 1). Low values give dry clouds (virga) instead.
 *   <type>        — an extra weight for a weather type that only happens where a
 *                   biome allows it: "dusty", "ashy". No shipped biome has ash —
 *                   a volcanic biome would add "ashy" here.
 *
 * Uses worker modules on the main thread. They are pure (no DOM, no workers);
 * the old path's noise seed is module state, which on this thread only it sets.
 */

import { setSeed, noise2D, fbm2D } from '../workers/noise.js';
import { TEMP_FREQ, HUMI_FREQ, CONTINENT_FREQ, CONTINENT_OCTAVE } from '../workers/legacy/LegacyTerrainGenerator.js';
import { LEGACY_BIOMES } from '../workers/legacy/legacyBiomes.js';
import { Geography, LAPSE_START, LAPSE_RATE } from '../workers/Geography.js';
import { BiomeSet } from '../workers/Biomes.js';
import { normaliseFlat } from './FlatWorld.js';

// The old generator's altitude cooling.
const LEGACY_LAPSE_START = 90;
const LEGACY_LAPSE_RATE  = 0.0022;

export function newClimate() {
    return {
        temp: 0.6,            // 0 frozen … 1 scorching, after altitude
        humidity: 0.5,
        precipitation: 1,     // biome multiplier on precipitation reaching the ground
        affinity: {},         // extra weather weights from the biomes here
    };
}

export class Climate {
    /**
     * @param {number}   seed      world seed (the one the terrain was generated with)
     * @param {object[]} biomes    biome definitions from the GamePack
     * @param {number}   worldGen  the world's generator version
     * @param {object}   [flat]    a Flat world's settings (FlatWorld.js), or null
     */
    constructor(seed, biomes, worldGen = 1, flat = null) {
        if (worldGen >= 2) {
            this.geo = new Geography(seed, new BiomeSet(biomes), normaliseFlat(flat));
            return;
        }
        setSeed(seed);
        this.biomes = LEGACY_BIOMES.map(b => ({
            name: b.name,
            temperature: b.temperature ?? 0.5,
            humidity: b.humidity ?? 0.5,
            weather: b.weather ?? {},
        }));
        this._w = new Float64Array(this.biomes.length);
    }

    /** Climate at world (x, y, z), written into `out` (see newClimate). */
    at(x, y, z, out = newClimate()) {
        return this.geo ? this._current(x, y, z, out) : this._legacy(x, y, z, out);
    }

    _current(x, y, z, out) {
        const c = this.geo.column(Math.floor(x), Math.floor(z));
        const b = this.geo.biomes.list[c.biome];
        // The column's temperature is taken at its surface; move it to y.
        const above = (h) => (h > LAPSE_START ? h - LAPSE_START : 0);
        out.temp = c.temp + (above(c.top) - above(y)) * LAPSE_RATE;
        out.humidity = c.humid;
        out.precipitation = b.weather.precipitation ?? 1;
        for (const k in out.affinity) out.affinity[k] = 0;
        for (const k in b.weather) if (k !== 'precipitation') out.affinity[k] = b.weather[k] ?? 0;
        return out;
    }

    _legacy(x, y, z, out) {
        const continent = fbm2D(x + 8000, z + 8000, CONTINENT_OCTAVE, CONTINENT_FREQ, 0.5, 2.0);
        const temp = (noise2D(x * TEMP_FREQ + 1000, z * TEMP_FREQ + 1000) + 1) * 0.5;
        const humi = (noise2D(x * HUMI_FREQ + 5000, z * HUMI_FREQ + 5000) + 1) * 0.5;

        // Same weighting as LegacyTerrainGenerator._biomeBlend.
        const cf = Math.max(0, Math.min(1, (continent + 0.15) / 0.30));
        const w = this._w;
        let total = 0;
        for (let i = 0; i < this.biomes.length; i++) {
            const b = this.biomes[i];
            const dt = temp - b.temperature, dh = humi - b.humidity;
            const dist = Math.sqrt(dt * dt + dh * dh) + 0.0001;
            let wi = 1 / (dist * dist);
            if (b.name === 'OCEAN') wi *= (1 - cf) * 4 + 0.1;
            else                    wi *= cf;
            w[i] = wi;
            total += wi;
        }

        let t = 0, h = 0, p = 0;
        for (const k in out.affinity) out.affinity[k] = 0;
        for (let i = 0; i < this.biomes.length; i++) {
            const wi = total > 0 ? w[i] / total : 1 / this.biomes.length;
            const b = this.biomes[i];
            t += b.temperature * wi;
            h += b.humidity * wi;
            p += (b.weather.precipitation ?? 1) * wi;
            for (const k in b.weather) {
                if (k === 'precipitation') continue;
                out.affinity[k] = (out.affinity[k] ?? 0) + (b.weather[k] ?? 0) * wi;
            }
        }
        out.temp = t - Math.max(0, y - LEGACY_LAPSE_START) * LEGACY_LAPSE_RATE;
        out.humidity = h;
        out.precipitation = p;
        return out;
    }
}
