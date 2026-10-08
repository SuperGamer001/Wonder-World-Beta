/**
 * Biomes — what a place looks like and grows, chosen *after* the landscape.
 *
 * Geography.js shapes the land from world-wide fields (continents, mountain
 * belts, rivers …) that know nothing about biomes. A biome is then picked per
 * column from where that column ended up: its category (land, beach, river,
 * ocean — decided by the geography), its temperature after altitude cooling,
 * humidity, elevation, slope and a few region fields. The biome decides the
 * surface blocks, trees and other structures, extra ores and weather, never the
 * height. That is what lets one mountain range run from forest through taiga to
 * snowy peaks, or cross from a desert into grassland.
 *
 * Biome JSON (data/biomes/*.json), all fields optional except name:
 *
 *   category    "land" | "beach" | "river" | "ocean"
 *   select      soft ranges, each [min, max]: temperature, humidity, elevation,
 *               slope, plateau. The biome whose ranges a column is closest to
 *               wins (distance 0 inside every range).
 *   require     hard ranges, same keys plus weirdness and island: a biome is
 *               only a candidate where the column is inside all of them. For
 *               rare biomes.
 *   priority    breaks ties (higher wins)
 *   temperature, humidity   the biome's representative climate (weather)
 *   surface     { top, filler, fillerDepth, stone, deep, snow, steep,
 *                 underwater, patches, bands } — see normaliseSurface
 *   structures  { type: { frequency, spawnInWater } } (StructurePlacer)
 *   ores        extra ore veins on top of the world's (data/terrain)
 *   weather     { precipitation, <weather type>: weight } (Climate.js)
 *   mapColor    "#rrggbb" for test/worldmap.mjs
 *
 * Biomes written for the old generator (surfaceBlock, subsurfaceBlock,
 * stoneBlock, deepBlock, baseHeight …) still load: their blocks become the
 * surface, their temperature/humidity a selection range, and the height fields
 * are ignored.
 */

export const CATEGORIES = ['land', 'beach', 'river', 'ocean'];

// What to use when a pack has no block of a name the generator or a biome asks
// for. Unknown names used to resolve to 0 — AIR — which punched holes in the
// ground; this walks down to something similar instead, and to STONE at worst.
const FALLBACK = {
    SLATE: 'STONE', ANDESITE: 'STONE', LIMESTONE: 'DIORITE', DIORITE: 'STONE', GRANITE: 'STONE',
    COARSE_DIRT: 'DIRT', PODZOL: 'DIRT', MUD: 'DIRT', MOSS: 'GRASS', DRY_GRASS: 'GRASS', MYCELIUM: 'GRASS',
    RED_SAND: 'SAND', RED_SANDSTONE: 'SANDSTONE', SANDSTONE: 'STONE', SAND: 'DIRT', GRAVEL: 'STONE',
    WHITE_TERRACOTTA: 'TERRACOTTA', ORANGE_TERRACOTTA: 'TERRACOTTA', YELLOW_TERRACOTTA: 'TERRACOTTA',
    BROWN_TERRACOTTA: 'TERRACOTTA', RED_TERRACOTTA: 'TERRACOTTA', TERRACOTTA: 'CLAY', CLAY: 'DIRT',
    PACKED_ICE: 'ICE', ICE: 'SNOW', SNOW_DIRT: 'SNOW', SNOW: 'STONE', GRASS: 'DIRT', DIRT: 'STONE',
    SPRUCE_LOG: 'WOOD', BIRCH_LOG: 'WOOD', SPRUCE_LEAVES: 'LEAVES', BIRCH_LEAVES: 'LEAVES',
    JUNGLE_LEAVES: 'LEAVES', ACACIA_LEAVES: 'LEAVES', CACTUS: 'LEAVES', LEAVES: 'WOOD',
    MUSHROOM_STEM: 'WOOD', RED_MUSHROOM_BLOCK: 'WOOD', BROWN_MUSHROOM_BLOCK: 'WOOD',
    MOSSY_STONE: 'STONE', WOODEN_PLANKS: 'WOOD', GLASS: 'WOODEN_PLANKS', WOOD: 'STONE',
};

/** The id of block `name` in `reg`, or of its nearest stand-in (never AIR). */
export function blockIdOf(reg, name) {
    for (let n = name, hops = 0; n && hops < 8; n = FALLBACK[n], hops++) {
        const def = reg.getByName(n);
        if (def) return def.id;
    }
    return reg.getByName('STONE')?.id ?? reg.serialize().find(b => b.id !== 0)?.id ?? 0;
}

// Weight of each soft dimension in the distance (per unit of its range). A
// column 60 blocks outside a biome's elevation range counts as much as one
// 1.0 outside its temperature range.
const W_TEMP  = 1.0;
const W_HUMI  = 1.0;
const W_ELEV  = 1 / 60;
const W_SLOPE = 0.6;
const W_PLAT  = 1.0;

const range = (r, lo, hi) => Array.isArray(r) && r.length === 2 ? [Number(r[0]), Number(r[1])] : [lo, hi];

/**
 * A cover: the top block and the layers under it, down to the stone.
 * Accepts a block name (top and all layers alike, `depth` deep), or
 * { top, layers: [{ block, depth }] }, or the older { top, filler, depth }.
 */
function normaliseCover(v, fallbackTop, fallbackLayer, depth) {
    if (typeof v === 'string') return { top: v, layers: [{ block: v, depth }] };
    const top = v?.top ?? fallbackTop;
    if (Array.isArray(v?.layers)) {
        return { top, layers: v.layers.map(l => ({ block: l.block, depth: Math.max(0, l.depth ?? 1) })) };
    }
    return { top, layers: [{ block: v?.filler ?? v?.top ?? fallbackLayer, depth: v?.depth ?? depth }] };
}

const normalisePatches = (list) => (list ?? []).map(p => ({
    block: p.block, scale: p.scale ?? 24, threshold: p.threshold ?? 0.5, under: !!p.under,
}));

/**
 * Normalise a biome's surface; the old generator's fields fill the gaps.
 *
 *   top, layers | filler + fillerDepth   the ground: top block, then layers
 *   stone        what the rest of the column is, down to the deep stone
 *   deep         replaces the world's deep stone (geology.json), if set
 *   snow         what `top` becomes above the snow line (default SNOW)
 *   steep        the cover on slopes too steep to hold soil (default: stone)
 *   underwater   the cover of sea, river and lake beds
 *   patches, underwaterPatches
 *                [{ block, scale, threshold, under }] — noise patches that
 *                replace the top (and the first layer too with `under`)
 *   bands        badlands: stripes of these blocks by world Y, from the
 *                surface down `bandDepth`, instead of stone and layers
 *   topDepth     how many blocks deep the top block goes (dunes, snowfields)
 */
function normaliseSurface(b) {
    const s = b.surface ?? {};
    const stone = s.stone ?? b.stoneBlock ?? 'STONE';
    const ground = normaliseCover(
        { top: s.top ?? b.surfaceBlock, layers: s.layers, filler: s.filler ?? b.subsurfaceBlock, depth: s.fillerDepth },
        'GRASS', 'DIRT', 3,
    );
    return {
        top: ground.top,
        layers: ground.layers,
        stone,
        deep:  s.deep ?? null,
        snow:  s.snow ?? 'SNOW',
        steep: normaliseCover(s.steep ?? stone, stone, stone, 2),
        underwater: normaliseCover(s.underwater ?? 'GRAVEL', 'GRAVEL', 'GRAVEL', 3),
        patches: normalisePatches(s.patches),
        underwaterPatches: normalisePatches(s.underwaterPatches),
        bands: Array.isArray(s.bands) && s.bands.length ? s.bands.slice() : null,
        bandDepth: s.bandDepth ?? 40,
        topDepth: Math.max(1, s.topDepth ?? 1),
    };
}

function inferCategory(b) {
    if (b.category && CATEGORIES.includes(b.category)) return b.category;
    const n = String(b.name ?? '').toUpperCase();
    if (n.includes('OCEAN')) return 'ocean';
    if (n.includes('RIVER')) return 'river';
    if (n.includes('BEACH') || n.includes('SHORE')) return 'beach';
    return 'land';
}

export function normaliseBiome(b, index) {
    const t = b.temperature ?? 0.5, h = b.humidity ?? 0.5;
    const sel = b.select ?? {};
    const req = b.require ?? {};
    return {
        index,
        name: b.name ?? `BIOME_${index}`,
        category: inferCategory(b),
        temperature: t,
        humidity: h,
        priority: b.priority ?? 0,
        select: {
            temperature: range(sel.temperature, t - 0.15, t + 0.15),
            humidity:    range(sel.humidity,    h - 0.15, h + 0.15),
            elevation:   range(sel.elevation, -1e9, 1e9),
            slope:       range(sel.slope,     0, 1e9),
            plateau:     range(sel.plateau,   0, 1),
        },
        require: {
            temperature: range(req.temperature, -1e9, 1e9),
            humidity:    range(req.humidity,    -1e9, 1e9),
            elevation:   range(req.elevation,   -1e9, 1e9),
            weirdness:   range(req.weirdness,   -1e9, 1e9),
            island:      range(req.island,      -1e9, 1e9),
        },
        surface: normaliseSurface(b),
        structures: b.structures ?? {},
        ores: b.ores ?? [],
        weather: b.weather ?? {},
        mapColor: b.mapColor ?? null,
        // Kept for the old generator's worlds (LegacyTerrainGenerator reads the
        // raw definitions itself; nothing here uses them).
        legacy: b,
    };
}

const out = (v, r) => v < r[0] ? r[0] - v : v > r[1] ? v - r[1] : 0;
const inside = (v, r) => v >= r[0] && v <= r[1];

export class BiomeSet {
    /** @param {object[]} defs biome definitions from the GamePack */
    constructor(defs) {
        this.list = (defs ?? []).map(normaliseBiome);
        // A pack with no biomes, or none for a category, still generates: every
        // category falls back to a plain default rather than leaving holes.
        const fallback = {
            land:  { name: 'DEFAULT_LAND' },
            beach: { name: 'DEFAULT_BEACH', category: 'beach', surface: { top: 'SAND', filler: 'SAND' } },
            river: { name: 'DEFAULT_RIVER', category: 'river', surface: { underwater: 'GRAVEL' } },
            ocean: { name: 'DEFAULT_OCEAN', category: 'ocean', surface: { underwater: 'GRAVEL' } },
        };
        for (const cat of CATEGORIES) {
            if (!this.list.some(b => b.category === cat)) {
                // The old gamepack has no beach/river biomes: borrow the closest
                // thing it has before inventing one.
                const borrow = cat === 'river' || cat === 'beach'
                    ? this.list.find(b => b.category === 'ocean') : null;
                const def = borrow ? { ...borrow.legacy, name: `${borrow.name}_${cat.toUpperCase()}`, category: cat } : fallback[cat];
                this.list.push(normaliseBiome(def, this.list.length));
            }
        }
        this.byCategory = {};
        this.fallback = {};
        const open = (b) => Object.values(b.require).every(r => r[0] <= -1e9 && r[1] >= 1e9);
        for (const cat of CATEGORIES) {
            this.byCategory[cat] = this.list.filter(b => b.category === cat);
            // Used when no candidate's requirements are met; never a rare biome.
            this.fallback[cat] = this.byCategory[cat].find(open) ?? this.byCategory[cat][0];
        }
        this.byName = new Map(this.list.map(b => [b.name, b]));
    }

    /**
     * The biome for one column. `p` holds temperature (after altitude),
     * humidity, elevation, slope, plateau, weirdness, island. Returns an index
     * into `list`.
     */
    select(category, p) {
        const cands = this.byCategory[category];
        let best = this.fallback[category], bestD = Infinity;
        for (let i = 0; i < cands.length; i++) {
            const b = cands[i];
            const q = b.require;
            if (!inside(p.temperature, q.temperature) || !inside(p.humidity, q.humidity) ||
                !inside(p.elevation, q.elevation) || !inside(p.weirdness, q.weirdness) ||
                !inside(p.island, q.island)) continue;
            const s = b.select;
            const dt = out(p.temperature, s.temperature) * W_TEMP;
            const dh = out(p.humidity,    s.humidity)    * W_HUMI;
            const de = out(p.elevation,   s.elevation)   * W_ELEV;
            const ds = out(p.slope,       s.slope)       * W_SLOPE;
            const dp = out(p.plateau,     s.plateau)     * W_PLAT;
            const d = dt * dt + dh * dh + de * de + ds * ds + dp * dp - b.priority * 1e-6;
            if (d < bestD) { bestD = d; best = b; }
        }
        return best.index;
    }
}
