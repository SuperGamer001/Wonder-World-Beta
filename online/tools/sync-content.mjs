/**
 * Tell the server which blocks the game has.
 *
 * The server checks every block a player places against the game's own list
 * (is there such a block, is it water, may this edition place it), and keeps
 * games with different blocks and biomes out of each other's worlds. It is
 * deployed by itself and cannot read the game's data/ folder, so this copies
 * what it needs into src/content/known.json, under the fingerprint the game
 * computes for the same data (contentHash, src/scripts/engine/net/OnlineProtocol.js).
 *
 * Run it (npm run content) whenever data/blocks, data/biomes or data/terrain
 * change, and deploy the server before the game that has the change. Entries
 * for older versions of the game stay in the file, so players who have not
 * updated yet keep their rooms; take one out when its version is retired.
 *
 *   node tools/sync-content.mjs [--label 0.2.0] [--prune <hash>] [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const game = path.join(here, '..', '..');
const out = path.join(here, '..', 'src', 'content', 'known.json');
const { contentHash, blockTable } = await import(new URL('../../src/scripts/engine/net/OnlineProtocol.js', import.meta.url));

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const readAll = (dir) => !fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

// The game merges packs first-come: one block an id, one biome a name (main.js).
const first = (list, key) => { const seen = new Set(); return list.filter(d => !seen.has(d[key]) && seen.add(d[key])); };
const gamepack = {
    blocks: first(readAll(path.join(game, 'data', 'blocks')), 'id'),
    biomes: first(readAll(path.join(game, 'data', 'biomes')), 'name'),
    terrain: first(readAll(path.join(game, 'data', 'terrain')), 'name'),
};
const hash = contentHash(gamepack);
const version = arg('--label') ?? JSON.parse(fs.readFileSync(path.join(game, 'package.json'), 'utf8')).version;

let known = {};
try { known = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* the first run */ }

if (process.argv.includes('--check')) {
    const ok = !!known[hash];
    console.log(ok ? `content ${hash} is known to the server` : `content ${hash} is NOT in src/content/known.json — run: npm run content`);
    process.exit(ok ? 0 : 1);
}

const prune = arg('--prune');
if (prune) delete known[prune];
known[hash] = { version, blocks: blockTable(gamepack) };

fs.mkdirSync(path.dirname(out), { recursive: true });
// One content a line: a new one is one line of diff.
fs.writeFileSync(out, `{\n${Object.entries(known).map(([h, c]) => ` ${JSON.stringify(h)}: ${JSON.stringify(c)}`).join(',\n')}\n}\n`);
console.log(`content ${hash} (game ${version}): ${gamepack.blocks.length} blocks, ${gamepack.biomes.length} biomes`);
console.log(`known contents: ${Object.entries(known).map(([h, c]) => `${h.slice(0, 8)}… (${c.version})`).join(', ')}`);
