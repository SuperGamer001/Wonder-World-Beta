/**
 * FlatWorld — what a Flat world is made of (a world's `flat` in world.json).
 *
 * A flat world has no geography: the ground is level everywhere, with its top
 * block at FLAT_TOP, and nothing under the surface but what its layers say —
 * no caves, rock blobs or ores. It comes in two kinds (`mode`):
 *
 *   'layers'  The player's own stack of layers, top first, each a block and a
 *             thickness; under the last there is nothing. One biome for the
 *             whole world, which sets its weather and what grows on it.
 *   'biomes'  Biomes come and go as in a normal world (the same climate, so
 *             the same seed has its deserts and its taiga in the same places),
 *             and each column is its biome's own ground, down to bedrock.
 *
 * Either kind may have `decorations` (trees, plants, boulders) and
 * `structures` (buildings), placed by the ordinary structure placer — which
 * still wants its ground: no trees on a top layer of stone.
 *
 * Shared by the generator (workers/), the climate (main thread) and the tests;
 * no Three.js, no DOM. The server keeps its own copy of the checks
 * (server.js, cleanFlat), since it cannot import from the game's source.
 */

// The top block of every column, at sea level: the ground fog, the clouds and
// the weather are all set against that height.
export const FLAT_TOP = 64;

export const FLAT_MAX_LAYERS = 16;
export const FLAT_MAX_DEPTH  = 64;    // of one layer

/**
 * A world's `flat`, checked: null for a world that is not flat, else
 * { mode, layers: [{ block, depth }], biome, decorations, structures } with
 * every field present. Anything out of range is put right, not refused.
 */
export function normaliseFlat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const mode = raw.mode === 'biomes' ? 'biomes' : 'layers';
    const layers = [];
    if (mode === 'layers') {
        for (const l of Array.isArray(raw.layers) ? raw.layers : []) {
            if (layers.length >= FLAT_MAX_LAYERS) break;
            const block = String(l?.block ?? '').toUpperCase();
            const depth = Math.max(1, Math.min(FLAT_MAX_DEPTH, Math.round(Number(l?.depth) || 1)));
            if (block && block !== 'AIR') layers.push({ block, depth });
        }
        if (layers.length === 0) layers.push({ block: 'GRASS', depth: 1 }, { block: 'DIRT', depth: 3 }, { block: 'BEDROCK', depth: 1 });
    }
    return {
        mode,
        layers,
        biome: mode === 'layers' ? String(raw.biome ?? 'PLAINS').toUpperCase() : null,
        decorations: raw.decorations !== false,
        structures: !!raw.structures,
    };
}
