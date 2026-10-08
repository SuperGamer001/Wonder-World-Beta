/**
 * StructurePlacer — trees, plants, boulders and houses, placed after the
 * terrain, caves and ores.
 *
 * Where things grow
 * ─────────────────
 * The ground is cut into small vegetation cells (VEG_CELL blocks square) and
 * larger building cells. Each cell holds at most one plant: its spot in the
 * cell and whether anything grows there come from a hash of the seed and the
 * cell, and what grows from the biome at that spot — the biome's structure
 * frequencies share out the cell (a forest of oak and birch picks one of the
 * two per cell, never both on one trunk). A cell with nothing chosen stays
 * empty, so sparse biomes have sparse trees.
 *
 * Across chunk borders
 * ────────────────────
 * A tree near a chunk edge reaches into the next chunk. Both chunks reach the
 * same decision about it: the chunk it is rooted in reads its own columns,
 * the other asks Geography.column() — bit-for-bit the same values — for the
 * root column, and each places the blocks that fall inside itself. So canopies
 * run on across chunk seams instead of being cut off at them (which the old
 * placer did).
 *
 * Adding a structure: write a builder (rng, ids) → [dx, dy, dz, id, rule, …]
 * with dy = 0 the first block above the ground, add it to TYPES, and give it a
 * frequency in some biome's "structures".
 *
 * Far terrain (FarTiles.js) draws the same plants and buildings, in the same
 * places, as a box or two each: farScan() walks the same cells and makes the
 * same choice (_typeAt), and `proxies` holds each prebuilt shape boiled down
 * to its crown and its trunk.
 */

import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y, WORLD_MAX_Y } from '../engine/ChunkData.js';
import { hashSeed } from './noise.js';
import { NO_WATER } from './Geography.js';
import { blockIdOf } from './Biomes.js';

const N = CHUNK_SIZE;
const SZ = N * CHUNK_SIZE_Y;

const VEG_CELL  = 5;      // one plant per cell at most
const VEG_REACH = 5;      // widest a plant reaches from its root, in blocks
const BUILD_CELL  = 48;
const BUILD_REACH = 10;
const VARIANTS = 8;       // prebuilt shapes per type

// How a block goes in: into air only; also over leaves (a trunk through a
// neighbour's crown); or also over soil and stone (boulders, foundations).
const INTO_AIR = 0, OVER_LEAVES = 1, OVER_GROUND = 2;

// Ground a plant can root in.
const SOIL = ['GRASS', 'DIRT', 'PODZOL', 'COARSE_DIRT', 'SNOW_DIRT', 'DRY_GRASS', 'MOSS', 'MUD', 'MYCELIUM'];
const SAND = ['SAND', 'RED_SAND'];

// ── Small deterministic RNG for building variants ────────────────────────────

function rngFor(seed) {
    let s = seed >>> 0;
    const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
    next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
    return next;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Collects blocks; a later block at the same spot replaces an earlier one. */
class Shape {
    constructor() { this.map = new Map(); }
    set(dx, dy, dz, id, rule) {
        if (id == null) return;
        this.map.set(`${dx},${dy},${dz}`, [dx, dy, dz, id, rule]);
    }
    leaf(dx, dy, dz, id) {
        const k = `${dx},${dy},${dz}`;
        if (!this.map.has(k)) this.map.set(k, [dx, dy, dz, id, INTO_AIR]);
    }
    list() { return Int32Array.from([...this.map.values()].flat()); }
}

function disk(s, cy, r, id, rng, ragged = 0.35) {
    const R = Math.ceil(r);
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const d = dx * dx + dz * dz;
        if (d > r * r + 0.5) continue;
        // Knock a few leaves off the rim so crowns are not perfect discs.
        if (d > (r - 1) * (r - 1) && rng() < ragged) continue;
        s.leaf(dx, cy, dz, id);
    }
}

/** An ellipsoid centred on (cx, cy, cz), which may fall between blocks. */
function blob(s, cx, cy, cz, rx, ry, rz, id, rng, rule = INTO_AIR) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
            for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++) {
                const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
                if (q > 1 || (q > 0.7 && rng() < 0.3)) continue;
                if (Math.abs(x) > VEG_REACH || Math.abs(z) > VEG_REACH) continue;
                if (rule === INTO_AIR) s.leaf(x, y, z, id);
                else s.set(x, y, z, id, rule);
            }
}

function trunk(s, h, id, dx = 0, dz = 0) {
    for (let y = 0; y < h; y++) s.set(dx, y, dz, id, OVER_LEAVES);
}

const BUILDERS = {
    oak_tree(rng, b) {
        const s = new Shape(), h = rng.int(4, 6);
        trunk(s, h, b.WOOD);
        disk(s, h - 2, 2, b.LEAVES, rng);
        disk(s, h - 1, 2, b.LEAVES, rng);
        disk(s, h, 1.2, b.LEAVES, rng, 0.2);
        disk(s, h + 1, 0.8, b.LEAVES, rng, 0);
        return s;
    },
    large_oak_tree(rng, b) {
        const s = new Shape(), h = rng.int(7, 10);
        trunk(s, h, b.WOOD);
        blob(s, 0, h - 1, 0, 3.4, 2.6, 3.4, b.LEAVES, rng);
        // A couple of low branches with their own leaf clumps.
        for (let i = 0; i < 2; i++) {
            const a = rng() * Math.PI * 2, y = h - 3 - i;
            const bx = Math.round(Math.cos(a) * 2), bz = Math.round(Math.sin(a) * 2);
            s.set(Math.sign(bx), y, Math.sign(bz), b.WOOD, OVER_LEAVES);
            blob(s, bx, y + 1, bz, 1.6, 1.2, 1.6, b.LEAVES, rng);
        }
        return s;
    },
    birch_tree(rng, b) {
        const s = new Shape(), h = rng.int(5, 7);
        trunk(s, h, b.BIRCH_LOG);
        disk(s, h - 3, 1.6, b.BIRCH_LEAVES, rng, 0.4);
        disk(s, h - 2, 2, b.BIRCH_LEAVES, rng);
        disk(s, h - 1, 2, b.BIRCH_LEAVES, rng);
        disk(s, h, 1.2, b.BIRCH_LEAVES, rng, 0.2);
        disk(s, h + 1, 0.8, b.BIRCH_LEAVES, rng, 0);
        return s;
    },
    spruce_tree(rng, b) {
        const s = new Shape(), h = rng.int(7, 12);
        const base = rng.int(2, 3), rMax = h > 9 ? 3 : 2.3;
        trunk(s, h, b.SPRUCE_LOG);
        for (let y = base; y <= h; y++) {
            const t = (y - base) / (h - base);
            let r = (1 - t) * rMax + 0.4;
            if ((h - y) % 2 === 1) r -= 0.9;          // rings: a wide layer, then a narrow one
            if (r > 0.5) disk(s, y, r, b.SPRUCE_LEAVES, rng, 0.15);
        }
        disk(s, h, 0.8, b.SPRUCE_LEAVES, rng, 0);
        s.leaf(0, h + 1, 0, b.SPRUCE_LEAVES);
        return s;
    },
    acacia_tree(rng, b) {
        // Straight up, then leaning off to one side, then a flat, wide canopy.
        const s = new Shape(), up = rng.int(2, 3), lean = rng.int(1, 2);
        const step = rng() < 0.5 ? 1 : -1, alongX = rng() < 0.5;
        trunk(s, up, b.WOOD);
        let x = 0, z = 0, y = up;
        for (let i = 0; i < lean; i++, y++) {
            if (alongX) x += step; else z += step;
            s.set(x, y, z, b.WOOD, OVER_LEAVES);
        }
        s.set(x, y, z, b.WOOD, OVER_LEAVES);
        for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
            const d = dx * dx + dz * dz;
            if (d > 9.5 || (d > 6 && rng() < 0.35)) continue;
            if (Math.abs(x + dx) > VEG_REACH || Math.abs(z + dz) > VEG_REACH) continue;
            s.leaf(x + dx, y + 1, z + dz, b.ACACIA_LEAVES);
        }
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) s.leaf(x + dx, y + 2, z + dz, b.ACACIA_LEAVES);
        return s;
    },
    jungle_tree(rng, b) {
        const s = new Shape();
        const giant = rng() < 0.35;
        const h = giant ? rng.int(15, 20) : rng.int(9, 13);
        trunk(s, h, b.WOOD);
        if (giant) { trunk(s, h, b.WOOD, 1, 0); trunk(s, h, b.WOOD, 0, 1); trunk(s, h, b.WOOD, 1, 1); }
        const off = giant ? 0.5 : 0;     // centred on the 2×2 trunk
        blob(s, off, h, off, giant ? 4.2 : 3.2, 2.2, giant ? 4.2 : 3.2, b.JUNGLE_LEAVES, rng);
        // Leafy tufts down the trunk.
        for (let y = 4; y < h - 3; y += rng.int(3, 4)) {
            const a = rng() * Math.PI * 2;
            blob(s, Math.round(Math.cos(a) * 2), y, Math.round(Math.sin(a) * 2), 1.5, 1, 1.5, b.JUNGLE_LEAVES, rng);
        }
        return s;
    },
    swamp_tree(rng, b) {
        const s = new Shape(), h = rng.int(5, 7);
        trunk(s, h, b.WOOD);
        disk(s, h - 2, 3.2, b.LEAVES, rng, 0.25);
        disk(s, h - 1, 3, b.LEAVES, rng, 0.25);
        disk(s, h, 1.8, b.LEAVES, rng, 0.2);
        // Hanging strands off the rim of the crown.
        for (let i = 0; i < 7; i++) {
            const a = rng() * Math.PI * 2;
            const dx = Math.round(Math.cos(a) * 3), dz = Math.round(Math.sin(a) * 3);
            const len = rng.int(1, 3);
            for (let k = 1; k <= len; k++) s.leaf(dx, h - 2 - k, dz, b.LEAVES);
        }
        return s;
    },
    cactus(rng, b) {
        const s = new Shape(), h = rng.int(1, 3);
        trunk(s, h, b.CACTUS);
        return s;
    },
    huge_mushroom(rng, b) {
        const s = new Shape(), h = rng.int(4, 7);
        trunk(s, h, b.MUSHROOM_STEM);
        if (rng() < 0.5) {
            // Red: a dome.
            disk(s, h, 1.6, b.RED_MUSHROOM_BLOCK, rng, 0);
            for (let y = h - 3; y < h; y++) {
                for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
                    if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
                    if (Math.abs(dx) === 2 || Math.abs(dz) === 2) s.leaf(dx, y, dz, b.RED_MUSHROOM_BLOCK);
                }
            }
        } else {
            // Brown: a wide flat cap.
            disk(s, h, 3.2, b.BROWN_MUSHROOM_BLOCK, rng, 0);
        }
        return s;
    },
    boulder(rng, b) {
        const s = new Shape();
        const r = 1.3 + rng() * 1.2;
        const id = rng() < 0.6 ? b.MOSSY_STONE : b.ANDESITE;
        blob(s, 0, Math.floor(r * 0.4) - 1, 0, r, r * 0.85, r * (0.8 + rng() * 0.4), id, rng, OVER_GROUND);
        return s;
    },
    house(rng, b) {
        const s = new Shape();
        const W = 7, H = 5, D = 9;
        const ox = -3, oz = -4;
        for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) {
            s.set(ox + dx, -1, oz + dz, b.STONE, OVER_GROUND);
            for (let dy = 0; dy < H + 4; dy++) s.set(ox + dx, dy, oz + dz, 0, OVER_GROUND);   // clear the inside
        }
        for (let dy = 0; dy < H - 1; dy++) {
            for (let dx = 0; dx < W; dx++) for (let dz = 0; dz < D; dz++) {
                const ex = dx === 0 || dx === W - 1, ez = dz === 0 || dz === D - 1;
                if (!ex && !ez) continue;
                const corner = ex && ez;
                const door = dz === 0 && dx === 3 && dy < 2;
                const window = !corner && dy === 2 && ((ex && dz % 3 === 1) || (ez && dx % 3 === 1));
                if (door) continue;
                s.set(ox + dx, dy, oz + dz, window ? b.GLASS : corner ? b.STONE : b.WOODEN_PLANKS, OVER_GROUND);
            }
        }
        const mid = Math.floor(W / 2);
        for (let dz = 0; dz < D; dz++) {
            for (let layer = 0; layer <= mid; layer++) {
                const roofY = H - 1 + layer;
                s.set(ox + mid - layer, roofY, oz + dz, b.WOOD, OVER_GROUND);
                s.set(ox + mid + layer, roofY, oz + dz, b.WOOD, OVER_GROUND);
                // Gable ends
                if (dz === 0 || dz === D - 1) for (let k = mid - layer + 1; k < mid + layer; k++) s.set(ox + k, roofY, oz + dz, b.WOODEN_PLANKS, OVER_GROUND);
            }
        }
        return s;
    },
};

// Type → where it grows. `cell` groups types that compete for one cell.
const TYPES = {
    oak_tree:       { on: SOIL, maxSlope: 1.4 },
    large_oak_tree: { on: SOIL, maxSlope: 1.2 },
    birch_tree:     { on: SOIL, maxSlope: 1.4 },
    spruce_tree:    { on: SOIL, maxSlope: 1.6 },
    acacia_tree:    { on: SOIL, maxSlope: 1.2 },
    jungle_tree:    { on: SOIL, maxSlope: 1.3 },
    swamp_tree:     { on: SOIL, maxSlope: 1.2, inShallowWater: true },
    cactus:         { on: SAND, maxSlope: 0.9 },
    huge_mushroom:  { on: SOIL, maxSlope: 1.0 },
    boulder:        { on: null, maxSlope: 1.2 },
    house:          { on: SOIL, maxSlope: 0.45, building: true },
};
// Biome JSON written for the old placer says "tree".
const ALIASES = { tree: 'oak_tree' };

// How much narrower a crown is at its top than at its widest, as far terrain
// draws it (1 = a box, near 0 = a cone).
const FAR_TAPER = {
    oak_tree: 0.5, large_oak_tree: 0.55, birch_tree: 0.45, spruce_tree: 0.1, acacia_tree: 0.75,
    jungle_tree: 0.55, swamp_tree: 0.6, huge_mushroom: 0.7, boulder: 0.55, cactus: 1,
};

// How each plant reads from further off still, where it is no longer drawn as
// a shape (FarTiles.js): its leaves, and how high the top of its crown stands
// above the ground.
const CANOPY = {
    oak_tree:       ['LEAVES', 6],
    large_oak_tree: ['LEAVES', 10],
    birch_tree:     ['BIRCH_LEAVES', 8],
    spruce_tree:    ['SPRUCE_LEAVES', 10],
    acacia_tree:    ['ACACIA_LEAVES', 6],
    jungle_tree:    ['JUNGLE_LEAVES', 13],
    swamp_tree:     ['LEAVES', 6],
    huge_mushroom:  ['RED_MUSHROOM_BLOCK', 6],
};

const BLOCKS = ['WOOD', 'LEAVES', 'BIRCH_LOG', 'BIRCH_LEAVES', 'SPRUCE_LOG', 'SPRUCE_LEAVES', 'ACACIA_LEAVES',
    'JUNGLE_LEAVES', 'CACTUS', 'MUSHROOM_STEM', 'RED_MUSHROOM_BLOCK', 'BROWN_MUSHROOM_BLOCK', 'MOSSY_STONE',
    'ANDESITE', 'STONE', 'WOODEN_PLANKS', 'GLASS'];

export class StructurePlacer {
    /**
     * @param {number}        seed
     * @param {BlockRegistry} reg
     * @param {BiomeSet}      biomes
     * @param {Geography}     geo      for roots outside the chunk
     * @param {(x, z, col) => number} topBlockAt  the surface block the terrain
     *        generator puts on a column (for "grows on sand" and the like)
     */
    constructor(seed, reg, biomes, geo, topBlockAt) {
        this.seed = seed | 0;
        this.geo = geo;
        this.topBlockAt = topBlockAt;
        // A Flat world may leave either kind out (TerrainGenerator sets these).
        this.plants = true;
        this.buildings = true;
        const b = {};
        for (const name of BLOCKS) b[name] = blockIdOf(reg, name);
        this._leaves = new Uint8Array(65536);
        for (const d of reg.serialize()) if (d.leaves || d.name === 'LEAVES' || /MUSHROOM_BLOCK$/.test(d.name)) this._leaves[d.id] = 1;
        this._ground = new Uint8Array(65536);
        for (const d of reg.serialize()) if (d.terrainType === 'mesh') this._ground[d.id] = 1;
        this._water = blockIdOf(reg, 'WATER');
        this._dirt  = blockIdOf(reg, 'DIRT');

        this.variants = {};
        this.onIds = {};
        for (const [type, spec] of Object.entries(TYPES)) {
            this.variants[type] = [];
            for (let v = 0; v < VARIANTS; v++) {
                this.variants[type].push(BUILDERS[type](rngFor(hashSeed(this.seed, 0x7e3e, v, type.length * 31 + v)), b).list());
            }
            this.onIds[type] = spec.on ? new Set(spec.on.map(n => blockIdOf(reg, n))) : null;
        }

        // Per biome: the plants sharing a vegetation cell, and building chances.
        this.veg = biomes.list.map(bm => {
            const list = [];
            let total = 0;
            for (const [key, cfg] of Object.entries(bm.structures ?? {})) {
                const type = ALIASES[key] ?? key;
                const spec = TYPES[type];
                if (!spec || spec.building) continue;
                const f = Math.max(0, cfg?.frequency ?? 0) * VEG_CELL * VEG_CELL;
                if (f <= 0) continue;
                total += f;
                list.push({ type, cum: total, spawnInWater: !!cfg.spawnInWater });
            }
            return { list, total };
        });
        this.build = biomes.list.map(bm => {
            const cfg = bm.structures?.house;
            return cfg ? Math.max(0, cfg.frequency ?? 0) * BUILD_CELL * BUILD_CELL : 0;
        });
        this.maxBuild = Math.max(0, ...this.build);
        this._col = { top: 0, water: 0, biome: 0, slope: 0, flags: 0, topBlock: 0 };

        // Each prebuilt shape as far terrain draws it: a few boxes, in blocks
        // from the root, [x0, y0, z0, x1, y1, z1, block id, taper, stem] each.
        // A plant is its trunk (stem = 1) and the box round its leaves; a
        // house its walls and a roof drawn in to a ridge.
        this.proxies = {};
        for (const type of Object.keys(TYPES)) {
            this.proxies[type] = this.variants[type].map(shape => this._proxy(type, shape, b));
        }

        // Per biome, the tree cover as far terrain draws it: the share of the
        // ground under crowns (one plant per cell, a crown filling most of it),
        // their mean height, and their leaves with each one's share.
        this.soil = this.onIds.oak_tree;
        this.canopy = this.veg.map(({ list }) => {
            let cover = 0, height = 0;
            const leaves = [];
            let prev = 0;
            for (const e of list) {
                const share = e.cum - prev;
                prev = e.cum;
                const c = CANOPY[e.type];
                if (!c) continue;
                cover += share;
                height += share * c[1];
                leaves.push([blockIdOf(reg, c[0]), share]);
            }
            return { cover: Math.min(1, cover), height: cover > 0 ? height / cover : 0, leaves };
        });
    }

    /**
     * Place everything that reaches into chunk (cx, cz).
     * @param {Uint16Array} voxels
     * @param {object} cols     Geography.region() output for this chunk
     * @param {Uint16Array} topBlocks  the surface block of each column (lx * 16 + lz)
     */
    apply(voxels, cx, cz, cols, topBlocks) {
        const ox = cx * N, oz = cz * N;
        this._scan(voxels, ox, oz, cols, topBlocks, VEG_CELL, VEG_REACH, false);
        if (this.maxBuild > 0) this._scan(voxels, ox, oz, cols, topBlocks, BUILD_CELL, BUILD_REACH, true);
    }

    /**
     * What stands on a cell's spot, if anything: the type of plant or building,
     * given the column there and the cell's roll. One rule for the chunks and
     * for far terrain, so both put the same things in the same places.
     */
    _typeAt(col, roll, building) {
        if (building ? !this.buildings : !this.plants) return null;
        if (col.top + 24 > WORLD_MAX_Y) return null;
        let type = null;
        if (building) {
            if (roll < this.build[col.biome]) type = 'house';
        } else {
            const v = this.veg[col.biome];
            if (v.total > 0) {
                // A crowded cell (total > 1) always grows something; the
                // types share it in proportion.
                const r = v.total > 1 ? roll * v.total : roll;
                for (const e of v.list) if (r < e.cum) { type = e.type; break; }
                if (type && col.water !== NO_WATER) {
                    const e = v.list.find(q => q.type === type);
                    const shallow = TYPES[type].inShallowWater && col.water - col.top <= 1;
                    if (!e.spawnInWater && !shallow) type = null;
                }
            }
        }
        if (!type) return null;
        const spec = TYPES[type];
        if (col.slope > spec.maxSlope) return null;
        if (building && col.water !== NO_WATER) return null;
        const on = this.onIds[type];
        if (on && !on.has(col.topBlock)) return null;
        return type;
    }

    /**
     * Far terrain: every plant and building rooted in the square of `size`
     * blocks at (x0, z0), as emit(x, z, col, proxy, hash, dense) — `proxy` the
     * boxes it is drawn with (see `proxies`), `col` the column it stands on.
     *
     * @param {(x, z) => object} at   the column at a spot: { top, water, biome,
     *        slope, flags, topBlock }. Far terrain answers from its lattice, so
     *        near the edge of a biome or a slope the odd tree differs from
     *        what the chunk will have.
     * @param {number} thin   keep one plant in `thin` (the rest are too small
     *        to tell apart from that far); buildings are always kept
     */
    farScan(x0, z0, size, at, emit, thin = 1) {
        for (const building of [false, true]) {
            if (building && this.maxBuild <= 0) continue;
            const cell = building ? BUILD_CELL : VEG_CELL;
            const gx0 = Math.floor(x0 / cell), gx1 = Math.floor((x0 + size - 1) / cell);
            const gz0 = Math.floor(z0 / cell), gz1 = Math.floor((z0 + size - 1) / cell);
            for (let gx = gx0; gx <= gx1; gx++) {
                for (let gz = gz0; gz <= gz1; gz++) {
                    const h = hashSeed(this.seed, gx, gz, building ? 0xb017d : 0x7e9);
                    const x = gx * cell + (h & 0xff) % cell;
                    const z = gz * cell + ((h >>> 8) & 0xff) % cell;
                    if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
                    const roll = (h >>> 16) / 0x10000;
                    if (building && roll >= this.maxBuild) continue;
                    if (!building && thin > 1 && hashSeed(h, 9) % thin !== 0) continue;
                    const col = at(x, z);
                    const type = this._typeAt(col, roll, building);
                    // `dense`: in a wood, where the trunks are lost among the crowns.
                    if (type) emit(x, z, col, this.proxies[type][hashSeed(h, 5) % VARIANTS], h,
                                   !building && this.veg[col.biome].total >= 0.5);
                }
            }
        }
    }

    /** A prebuilt shape as the boxes far terrain draws (see `proxies`). */
    _proxy(type, shape, b) {
        const box = () => ({ x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity, ids: new Map() });
        const add = (g, k) => {
            const x = shape[k], y = shape[k + 1], z = shape[k + 2], id = shape[k + 3];
            g.x0 = Math.min(g.x0, x); g.x1 = Math.max(g.x1, x + 1);
            g.y0 = Math.min(g.y0, y); g.y1 = Math.max(g.y1, y + 1);
            g.z0 = Math.min(g.z0, z); g.z1 = Math.max(g.z1, z + 1);
            g.ids.set(id, (g.ids.get(id) ?? 0) + 1);
        };
        const out = (g, taper, id, stem = 0) => {
            if (g.ids.size === 0) return [];
            const top = id ?? [...g.ids].sort((p, q) => q[1] - p[1])[0][0];
            return [[g.x0, g.y0, g.z0, g.x1, g.y1, g.z1, top, taper, stem]];
        };
        if (type === 'house') {
            // Walls up to the eaves, then the roof, drawn in along x to its ridge.
            const walls = box(), roof = box();
            for (let k = 0; k < shape.length; k += 5) {
                if (shape[k + 3] === 0 || shape[k + 1] < 0) continue;
                add(shape[k + 1] < 4 ? walls : roof, k);
            }
            return [...out(walls, 1, b.WOODEN_PLANKS), ...out(roof, -0.08, b.WOOD)];
        }
        if (type === 'boulder') {
            const rock = box();
            for (let k = 0; k < shape.length; k += 5) if (shape[k + 3] !== 0) add(rock, k);
            rock.y0 = Math.max(rock.y0, -0.5);      // half sunk: only what stands clear
            return out(rock, FAR_TAPER.boulder);
        }
        // A plant: the box round its leaves, and its trunk — as wide as it is
        // at the foot (branches and a lean are lost) and as tall as it shows
        // below the crown.
        const crown = box(), stem = box(), foot = box();
        for (let k = 0; k < shape.length; k += 5) {
            const id = shape[k + 3];
            if (id === 0) continue;
            if (this._leaves[id]) add(crown, k);
            else { add(stem, k); if (shape[k + 1] === 0) add(foot, k); }
        }
        if (foot.ids.size > 0) { stem.x0 = foot.x0; stem.x1 = foot.x1; stem.z0 = foot.z0; stem.z1 = foot.z1; }
        if (crown.ids.size > 0 && stem.ids.size > 0) stem.y1 = Math.min(stem.y1, crown.y0 + 1);
        // A cactus is all trunk, and drawn as a box like a crown.
        return [...out(stem, 1, undefined, crown.ids.size > 0 ? 1 : 0), ...out(crown, FAR_TAPER[type] ?? 0.6)];
    }

    _scan(voxels, ox, oz, cols, topBlocks, cell, reach, building) {
        const gx0 = Math.floor((ox - reach) / cell), gx1 = Math.floor((ox + N - 1 + reach) / cell);
        const gz0 = Math.floor((oz - reach) / cell), gz1 = Math.floor((oz + N - 1 + reach) / cell);
        for (let gx = gx0; gx <= gx1; gx++) {
            for (let gz = gz0; gz <= gz1; gz++) {
                const h = hashSeed(this.seed, gx, gz, building ? 0xb017d : 0x7e9);
                const x = gx * cell + (h & 0xff) % cell;
                const z = gz * cell + ((h >>> 8) & 0xff) % cell;
                if (x < ox - reach || x >= ox + N + reach || z < oz - reach || z >= oz + N + reach) continue;
                const roll = (h >>> 16) / 0x10000;
                if (building && roll >= this.maxBuild) continue;

                const col = this._column(x, z, ox, oz, cols, topBlocks);
                const type = this._typeAt(col, roll, building);
                if (!type) continue;

                const shape = this.variants[type][hashSeed(h, 5) % VARIANTS];
                // Rooted in the ground, also under shallow water (swamps): a
                // trunk replaces water, leaves never do.
                this._place(voxels, ox, oz, x, col.top + 1, z, shape, x >= ox && x < ox + N && z >= oz && z < oz + N);
            }
        }
    }

    /** What decides a plant at (x, z): from this chunk's columns, or computed. */
    _column(x, z, ox, oz, cols, topBlocks) {
        const c = this._col;
        const lx = x - ox, lz = z - oz;
        if (lx >= 0 && lx < N && lz >= 0 && lz < N) {
            const i = lx * N + lz;
            c.top = cols.top[i]; c.water = cols.water[i]; c.biome = cols.biome[i];
            c.slope = cols.slope[i]; c.flags = cols.flags[i];
            c.topBlock = topBlocks[i];
        } else {
            const g = this.geo.column(x, z);
            c.top = g.top; c.water = g.water; c.biome = g.biome; c.slope = g.slope; c.flags = g.flags;
            c.topBlock = this.topBlockAt(x, z, g);
        }
        return c;
    }

    _place(voxels, ox, oz, x0, y0, z0, shape, rooted) {
        const water = this._water;
        for (let k = 0; k < shape.length; k += 5) {
            const lx = x0 + shape[k] - ox, lz = z0 + shape[k + 2] - oz;
            if (lx < 0 || lx >= N || lz < 0 || lz >= N) continue;
            const y = y0 + shape[k + 1];
            if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) continue;
            const i = lx + (y - WORLD_MIN_Y) * N + lz * SZ;
            const id = shape[k + 3], rule = shape[k + 4];
            const cur = voxels[i];
            let ok;
            if (cur === 0) ok = true;
            else if (cur === water) ok = rule !== INTO_AIR && id !== 0;
            else if (this._leaves[cur]) ok = rule >= OVER_LEAVES;
            else ok = rule === OVER_GROUND;
            if (ok) voxels[i] = id;
        }
        // A cave that broke through right under the root would leave the trunk
        // hanging; put a little ground back under it.
        if (rooted) {
            const lx = x0 - ox, lz = z0 - oz;
            for (let d = 1; d <= 2; d++) {
                const y = y0 - d;
                if (y <= WORLD_MIN_Y) break;
                const i = lx + (y - WORLD_MIN_Y) * N + lz * SZ;
                if (voxels[i] === 0) voxels[i] = this._dirt;
                else break;
            }
        }
    }
}
