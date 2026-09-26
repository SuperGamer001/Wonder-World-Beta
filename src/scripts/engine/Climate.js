/**
 * Climate — the local climate at a world position, for the weather system.
 *
 * The weather is one world-wide state (Weather.js), but what falls out of it
 * depends on where the player is: the same storm is rain in the plains, snow on
 * a snowy peak and nothing but dry clouds over the desert. This works that out
 * from the same noise fields and biome blend the terrain generator uses, so the
 * climate always matches the ground underneath.
 *
 * Temperature and humidity are the blended biome values (the ones in the biome
 * JSON), not the raw noise, so a biome's configured climate is what counts.
 * Temperature also falls with altitude — about 0.1 per 45 blocks above y 90 —
 * so it snows on mountain tops while it rains in the valleys below.
 *
 * Biomes may carry an optional `weather` object:
 *   "weather": { "precipitation": 0.15, "dusty": 2 }
 *   precipitation — multiplier on how much rain/snow actually reaches the ground
 *                   (default 1). Low values give dry clouds (virga) instead.
 *   <type>        — an extra weight for a weather type that only happens where a
 *                   biome allows it: "dusty", "ashy". No shipped biome has ash —
 *                   a volcanic biome would add "ashy" here.
 *
 * Uses the worker noise module on the main thread. It is pure (no DOM, no
 * workers) and its seed is module state, which on this thread nothing else sets.
 */

import { setSeed, noise2D, fbm2D } from '../workers/noise.js';
import { TEMP_FREQ, HUMI_FREQ, CONTINENT_FREQ, CONTINENT_OCTAVE } from '../workers/TerrainGenerator.js';

const LAPSE_START = 90;       // world Y above which it gets colder
const LAPSE_RATE  = 0.0022;   // temperature lost per block above that

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
     * @param {number}   seed    world seed (the one the terrain was generated with)
     * @param {object[]} biomes  biome definitions from the GamePack
     */
    constructor(seed, biomes) {
        setSeed(seed);
        this.biomes = (biomes ?? []).map(b => ({
            name: b.name,
            temperature: b.temperature ?? 0.5,
            humidity: b.humidity ?? 0.5,
            weather: b.weather ?? {},
        }));
        if (!this.biomes.length) this.biomes.push({ name: 'DEFAULT', temperature: 0.5, humidity: 0.5, weather: {} });
        this._w = new Float64Array(this.biomes.length);
    }

    /** Climate at world (x, y, z), written into `out` (see newClimate). */
    at(x, y, z, out = newClimate()) {
        const continent = fbm2D(x + 8000, z + 8000, CONTINENT_OCTAVE, CONTINENT_FREQ, 0.5, 2.0);
        const temp = (noise2D(x * TEMP_FREQ + 1000, z * TEMP_FREQ + 1000) + 1) * 0.5;
        const humi = (noise2D(x * HUMI_FREQ + 5000, z * HUMI_FREQ + 5000) + 1) * 0.5;

        // Same weighting as TerrainGenerator._biomeBlend.
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
        out.temp = t - Math.max(0, y - LAPSE_START) * LAPSE_RATE;
        out.humidity = h;
        out.precipitation = p;
        return out;
    }
}
