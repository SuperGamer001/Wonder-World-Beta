// Draws a top-down map of a world's geography: heights with hill shading,
// water, and optionally the biomes, so terrain changes can be judged from
// above over thousands of blocks without loading the game.
//
//   node test/worldmap.mjs [--seed 4242] [--x 0] [--z 0] [--size 4096]
//                          [--px 512] [--mode height|biome|slice] [--out map.png]
//
// Also prints how the area divides between land, sea, lakes, rivers and each
// biome, and the time per column.
//
// --mode slice cuts a vertical section instead: `size` blocks along x through
// (x, z), the whole world height, one pixel per block, every block in its
// colour — caves, strata, ores and water as the generator really makes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { Geography, SEA_LEVEL, NO_WATER, COL_LAKE, COL_RIVER } from '../src/scripts/workers/Geography.js';
import { BiomeSet } from '../src/scripts/workers/Biomes.js';
import { TerrainGenerator } from '../src/scripts/workers/TerrainGenerator.js';
import { BlockRegistry } from '../src/scripts/engine/BlockRegistry.js';
import { CHUNK_SIZE, CHUNK_SIZE_Y, WORLD_MIN_Y } from '../src/scripts/engine/ChunkData.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
};
const SEED = Number(arg('seed', 4242));
const CX = Number(arg('x', 0)), CZ = Number(arg('z', 0));
const SIZE = Number(arg('size', 4096));
const PX = Number(arg('px', 512));
const MODE = arg('mode', 'biome');
const OUT = arg('out', path.join(os.tmpdir(), `worldmap-${SEED}-${MODE}.png`));

const readDir = (d) => fs.readdirSync(path.join(root, d)).map(f => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8')));
const biomeDefs = readDir('data/biomes');
const biomes = new BiomeSet(biomeDefs);
const geo = new Geography(SEED, biomes);

function writePng(file, w, h, rgb) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc(h * (w * 3 + 1));
    for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

if (MODE === 'slice') {
    const reg = new BlockRegistry();
    for (const b of readDir('data/blocks')) reg.register(b);
    const gen = new TerrainGenerator(SEED, reg, biomeDefs, readDir('data/terrain'));
    const W = SIZE, H = CHUNK_SIZE_Y, x0 = CX - Math.floor(W / 2);
    const rgb = Buffer.alloc(W * H * 3);
    const colour = reg.serialize().map(b => (b.topColor ?? b.color ?? [1, 0, 1]).map(v => Math.round(v * 255)));
    const lz = ((CZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, cz = Math.floor(CZ / CHUNK_SIZE);
    const counts = new Map();
    for (let cx = Math.floor(x0 / CHUNK_SIZE); cx * CHUNK_SIZE < x0 + W; cx++) {
        const v = gen.generate(cx, cz);
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const px = cx * CHUNK_SIZE + lx - x0;
            if (px < 0 || px >= W) continue;
            let seenSolid = false;
            for (let ly = CHUNK_SIZE_Y - 1; ly >= 0; ly--) {
                const id = v[lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE_Y];
                const py = CHUNK_SIZE_Y - 1 - ly;
                let c;
                if (id === 0) c = seenSolid ? [18, 18, 22] : [150, 190, 235];   // cave air / sky
                else { c = colour[id] ?? [255, 0, 255]; if (!reg.isTransparent(id)) seenSolid = true; }
                if (id) counts.set(reg.get(id).name, (counts.get(reg.get(id).name) ?? 0) + 1);
                const o = (py * W + px) * 3;
                rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
            }
        }
    }
    writePng(OUT, W, H, rgb);
    console.log(`slice through z=${CZ}, x ${x0}..${x0 + W - 1}, y ${WORLD_MIN_Y}..${WORLD_MIN_Y + H - 1} → ${OUT}`);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    console.log([...counts].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([n, k]) => `${n} ${(100 * k / total).toFixed(1)}%`).join('  '));
    process.exit(0);
}

// ── Sample ───────────────────────────────────────────────────────────────────
const step = SIZE / PX;
const top = new Float32Array(PX * PX), water = new Int16Array(PX * PX);
const biome = new Uint8Array(PX * PX), flags = new Uint8Array(PX * PX);
const t0 = performance.now();
for (let py = 0; py < PX; py++) {
    for (let px = 0; px < PX; px++) {
        const x = Math.round(CX - SIZE / 2 + px * step), z = Math.round(CZ - SIZE / 2 + py * step);
        const c = geo.column(x, z);
        const i = py * PX + px;
        top[i] = c.top; water[i] = c.water; biome[i] = c.biome; flags[i] = c.flags;
    }
}
const ms = performance.now() - t0;

// ── Colour ───────────────────────────────────────────────────────────────────
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const biomeColour = biomes.list.map((b, i) => b.mapColor ? hex(b.mapColor)
    : [(i * 97) % 200 + 40, (i * 57) % 200 + 40, (i * 151) % 200 + 40]);
const ramp = [[60, [70, 130, 60]], [90, [110, 150, 70]], [130, [160, 150, 90]], [180, [140, 120, 100]],
              [220, [170, 170, 170]], [290, [245, 245, 250]]];
function heightColour(h) {
    if (h <= ramp[0][0]) return ramp[0][1];
    for (let k = 1; k < ramp.length; k++) {
        if (h <= ramp[k][0]) {
            const [h0, c0] = ramp[k - 1], [h1, c1] = ramp[k], t = (h - h0) / (h1 - h0);
            return c0.map((v, j) => v + (c1[j] - v) * t);
        }
    }
    return ramp[ramp.length - 1][1];
}

const rgb = Buffer.alloc(PX * PX * 3);
for (let py = 0; py < PX; py++) {
    for (let px = 0; px < PX; px++) {
        const i = py * PX + px;
        const h = top[i];
        // Hill shade from the north-west.
        const hx = top[py * PX + Math.min(PX - 1, px + 1)] - top[py * PX + Math.max(0, px - 1)];
        const hz = top[Math.min(PX - 1, py + 1) * PX + px] - top[Math.max(0, py - 1) * PX + px];
        const shade = Math.max(0.45, Math.min(1.3, 1 + (-hx - hz) / (step * 3.5)));
        let c;
        if (water[i] !== NO_WATER) {
            const depth = water[i] - h;
            const lake = flags[i] & COL_LAKE, river = flags[i] & COL_RIVER;
            const base = lake ? [60, 120, 200] : river ? [60, 110, 210] : [30, 70, 150];
            const k = Math.max(0.35, 1 - depth / 60);
            c = base.map(v => v * k);
            if (MODE === 'biome') c = c.map((v, j) => v * 0.8 + biomeColour[biome[i]][j] * 0.2);
        } else {
            c = MODE === 'biome' ? biomeColour[biome[i]] : heightColour(h);
            c = c.map(v => v * shade);
        }
        rgb[i * 3] = Math.max(0, Math.min(255, c[0]));
        rgb[i * 3 + 1] = Math.max(0, Math.min(255, c[1]));
        rgb[i * 3 + 2] = Math.max(0, Math.min(255, c[2]));
    }
}

// ── PNG ──────────────────────────────────────────────────────────────────────
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(PX, 0); ihdr.writeUInt32BE(PX, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(PX * (PX * 3 + 1));
for (let y = 0; y < PX; y++) rgb.copy(raw, y * (PX * 3 + 1) + 1, y * PX * 3, (y + 1) * PX * 3);
fs.writeFileSync(OUT, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));

// ── Stats ────────────────────────────────────────────────────────────────────
let sea = 0, lake = 0, river = 0, landN = 0, hmax = -1e9;
const byBiome = new Map();
for (let i = 0; i < PX * PX; i++) {
    if (flags[i] & COL_LAKE) lake++;
    else if (flags[i] & COL_RIVER && water[i] !== NO_WATER) river++;
    else if (water[i] !== NO_WATER) sea++;
    else landN++;
    if (top[i] > hmax) hmax = top[i];
    byBiome.set(biome[i], (byBiome.get(biome[i]) ?? 0) + 1);
}
const pct = (n) => (100 * n / (PX * PX)).toFixed(1).padStart(5) + '%';
console.log(`seed ${SEED}  ${SIZE}×${SIZE} blocks around ${CX},${CZ}  → ${OUT}`);
console.log(`${(ms * 1000 / (PX * PX)).toFixed(1)} µs/column   highest ${hmax}`);
console.log(`land ${pct(landN)}  sea ${pct(sea)}  lakes ${pct(lake)}  rivers ${pct(river)}`);
for (const [b, n] of [...byBiome].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${biomes.list[b].name.padEnd(18)} ${pct(n)}`);
}
