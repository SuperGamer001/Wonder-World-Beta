# Wonder World V7 — Engine Documentation

## Project Overview

Minecraft-inspired voxel sandbox game built with JavaScript ES modules, Three.js (v0.184), and Web Workers. Runs in a browser iframe (`index.html` → `game.html`). No build step — served via HTTP.

---

## File Structure

```
src/
  main.js                        Game state, UI, event bus, game loop
  scripts/
    world.js                     Three.js render layer + first-person controls
    engine/                      Main-thread engine modules (no Three.js dependency)
      BlockRegistry.js           Block type definitions loaded from GamePack
      ItemRegistry.js            Item definitions loaded from GamePack
      ChunkData.js               16×448×16 column storage (palette-compressed)
      WorldState.js              Authoritative chunk map and block get/set
      WorkerPool.js              Auto-sized worker pool with job queue
      ChunkManager.js            Chunk load/unload lifecycle and priority scheduling
      WorldClient.js             WebSocket chunk persistence client
      PlayerPhysics.js           AABB collision, gravity, jump, fall damage
      Inventory.js               Slots, hotbar, equipment, quiver
      CraftingSystem.js          Recipe matching
      EntityManager.js           Mob spawn/AI/despawn and dropped items
      WaterSimulator.js          Incremental BFS water spread
      Raycast.js                 DDA voxel raycast for block targeting
    workers/                     Worker-thread modules (no Three.js, no DOM)
      worldWorker.js             Worker entry point — handles generate and mesh jobs
      noise.js                   Seeded simplex noise, FBM, ridged, domain warp, PRNG
      TerrainGenerator.js        Layered terrain, caves, and ore placement
      StructurePlacer.js         Cross-chunk structures (trees, houses)
      GreedyMesher.js            Greedy meshing algorithm
data/
  gamepack.json                  Legacy fallback GamePack (blocks + biomes in one file)
  blocks/ items/ biomes/         Live definitions, one JSON per entry, discovered
  entities/ recipes/             via GET /api/data/manifest
  textures/                      Block, item and UI textures
gamepacks/                       Optional add-on packs (HD, Minecraft, Pre-Release)
server/
  server.js                      Express static host + REST API + WebSocket chunk I/O
electron/
  main.js                        Desktop launcher (boots the server, opens the window)
test/
  mesher.test.mjs                Greedy-mesher correctness vs a brute-force reference
  smoke.mjs                      Headless end-to-end run of the real game
```

---

## Architecture

### Layer Separation

The engine is split into four layers that have no upward dependencies:

| Layer | Files | Depends On |
|---|---|---|
| World State | `WorldState`, `ChunkData` | Nothing (no Three.js, no workers) |
| Engine | `BlockRegistry`, `WorkerPool`, `ChunkManager` | World State |
| Workers | `TerrainGenerator`, `GreedyMesher`, `StructurePlacer`, `noise` | Engine data types only |
| Render | `world.js` | Everything above via callbacks |

This separation means world state is fully independent of rendering — a prerequisite for future multiplayer support.

### Event Bus (main.js → world.js)

`main.js` communicates with `world.js` through custom DOM events:

```js
callWorldJS("startWorldLoad", { gamepackData })   // begin generation
callWorldJS("tick", { dt })                        // every animation frame
callWorldJS("quitWorld")                           // cleanup
```

---

## World Constants

| Constant | Value | Notes |
|---|---|---|
| `CHUNK_SIZE` | 16 | Blocks per XZ axis per chunk column |
| `CHUNK_SHIFT` | 4 | `log2(CHUNK_SIZE)`, used for fast bit-shift math |
| `CHUNK_SIZE_Y` | 448 | Full world height in blocks (319 − (−128) + 1) |
| `WORLD_MIN_Y` | -128 | Bottom of the world (bedrock floor) |
| `CHUNK_VOLUME` | 114,688 | `16 × 448 × 16` — voxels per chunk column |
| `SEA_LEVEL` | 64 | World Y coordinate of ocean surface |
| `WORLD_MAX_Y` | 319 | Maximum world Y |
| `WORLD_FORMAT` | 2 | Save-format version; bump when dimensions change |
| `MAX_PALETTE` | 256 | Distinct block types per chunk (`_indices` is Uint8) |
| World X/Z range | ±2,000,000 | |
| Default render distance | 8 chunks | Adjustable on `ChunkManager`; UI range 2–16 |

**Chunk columns:** Each chunk is a 16×448×16 column spanning the full world height.
Chunks are addressed by `(cx, cz)` only — there is no vertical chunk coordinate.
The chunk key format is `"cx,cz"` (a 2-component string).

---

## Block System (`BlockRegistry.js`, `data/gamepack.json`)

### Block Definition Fields

```json
{
    "id": 1,
    "name": "GRASS",
    "transparent": false,
    "liquid": false,
    "noCollision": false,
    "color": [0.38, 0.32, 0.18],
    "topColor": [0.32, 0.58, 0.18],
    "bottomColor": null,
    "sideColor": null
}
```

- `color` is the default for all faces. `topColor`, `bottomColor`, `sideColor` override specific faces.
- Colors are `[r, g, b]` floats in `[0, 1]`.
- `id` must match the numeric ID used everywhere in the engine — do not change IDs after world data exists.

### Block Flags

| Flag | Value | Meaning |
|---|---|---|
| `TRANSPARENT` | `1 << 0` | Face visible through this block; drawn in transparent pass |
| `LIQUID` | `1 << 1` | Water, lava etc. |
| `NO_COLLISION` | `1 << 2` | Player passes through (future use) |

### Current Block IDs

| ID | Name | ID | Name |
|---|---|---|---|
| 0 | AIR | 10 | IRON_ORE |
| 1 | GRASS | 11 | GOLD_ORE |
| 2 | DIRT | 12 | SNOW |
| 3 | STONE | 13 | ICE |
| 4 | SAND | 14 | SANDSTONE |
| 5 | WATER | 15 | CLAY |
| 6 | WOOD | 16 | SNOW_DIRT |
| 7 | LEAVES | 17 | GRANITE |
| 8 | GRAVEL | 18 | DIORITE |
| 9 | COAL_ORE | 19 | BEDROCK |

IDs are also mirrored in `BLOCK_TYPES` in `src/main.js`.

### Adding a Block

1. Add an entry to `data/gamepack.json` under `"blocks"` with the next available `id`.
2. Add the name to `BLOCK_TYPES` in `src/main.js`.
3. Reference it by name string in biome configs (`surfaceBlock`, `ores[].block`, etc.).

---

## Chunk Data (`ChunkData.js`)

Each chunk column is 16×448×16 voxels (`CHUNK_VOLUME = 114,688`).

**Voxel index formula:**
```js
index = lx + ly * CHUNK_SIZE + lz * (CHUNK_SIZE * CHUNK_SIZE_Y)
// lx ∈ [0,15]  ly ∈ [0,447]  lz ∈ [0,15]
```

**Chunk-to-world XZ coordinate conversion:**
```js
worldX = cx << 4    // cx * 16
cx = worldX >> 4    // Math.floor(worldX / 16)
// Y is absolute — local Y = worldY - WORLD_MIN_Y
```

**ChunkData properties:**
- `generated: boolean` — terrain pass complete
- `meshed: boolean` — at least one mesh has been uploaded
- `dirty: boolean` — needs re-mesh (set true after block edit)
- `minFilledY`, `maxFilledY` — local-Y extent of non-air voxels. Lets the mesher
  skip the empty sky and keeps mesh bounding spheres tight. Widened (never
  narrowed) by `setVoxel`; recomputed on load.
- `mesh`, `transparentMesh` — Three.js Mesh handles, owned by `world.js`

Note: `ChunkData` has no `cy` field. The constructor is `new ChunkData(cx, cz)`.

**Storage:** `_palette` (unique block ids, at most `MAX_PALETTE`) plus
`_indices`, a `Uint8Array(CHUNK_VOLUME)` of palette slots. `setVoxel` refuses
and logs rather than overflowing the palette — wrapping to slot 0 would punch an
AIR hole in the column.

**`snapshot()` vs `toUint16Array()`:** the mesh path uses `snapshot()`, which
hands the worker the compressed `{ palette, indices, minY, maxY }` pair. That is
`CHUNK_VOLUME` bytes instead of `2 × CHUNK_VOLUME`, the buffers are fresh copies
so they can be **transferred** rather than structure-cloned, and the palette
expansion runs on the worker. `toUint16Array()` remains for tooling and tests;
do not reintroduce it on the mesh path — expanding five chunks per mesh job on
the main thread was the single largest source of frame-time churn.

---

## Worker Pool (`WorkerPool.js`)

Workers are created as **module workers** (`{ type: 'module' }`), which allows the worker files to use ES module `import` statements.

**Worker count:** `max(2, min(hardwareConcurrency - 1, 8))`

**Lifecycle:**
1. Construct: `new WorkerPool(workerUrl)` — workers are created but idle.
2. Init: `await pool.init({ seed, blockRegistry, biomes })` — broadcasts init to all workers, resolves when all respond `{ type: 'ready' }`.
3. Dispatch: `pool.dispatch(job, callback)` — queues job; when a worker is free it picks up the next job.
4. Clear: `pool.clearQueue()` — cancels pending (not yet started) jobs.

**Important:** Transferable buffers sent **to** workers for meshing are copies — `WorldState` retains ownership. Only geometry output buffers are transferred back (zero-copy).

---

## Chunk Manager (`ChunkManager.js`)

Drives the chunk lifecycle every frame via `chunkManager.update(playerPos)`.

### Residency set caching

Building the set of chunks that should be resident allocates roughly 500 string
keys, so it is rebuilt **only when the player crosses a chunk boundary or the
render distance changes** — not on all 60 `update()` calls per second. The
unload sweep is gated on the same condition, since the set is the only thing
that can make a chunk unnecessary. A cached parallel `[cx, cz, …]` array lets
the missing-chunk scan run without parsing keys back out of strings.

### Priority

```
priority = euclideanDistance(chunk, player)
```

Lower sorts first. Job priority within the worker pool is separate:

| Priority | Job |
|---|---|
| 0 | Partial XZ re-mesh — fixes a visible seam, cheapest and most noticeable |
| 1 | Initial full mesh — a new chunk appearing |
| 2 | Terrain generation — slowest, can wait behind mesh work |

### Callbacks (wired in `world.js`)

```js
chunkManager.onMeshReady        = (cx, cz, yGeo, xzGeo) => { /* build meshes */ }
chunkManager.onPartialMeshReady = (cx, cz, xzGeo)       => { /* replace XZ group */ }
chunkManager.onChunkUnload      = (key)                 => { /* dispose meshes */ }
```

### Re-mesh on Neighbour Load

When a chunk finishes generating, the four horizontally adjacent neighbours that
are already generated are queued for re-meshing, so boundary faces are correct
(a freshly loaded chunk's edge faces depend on its neighbours' voxel data).
Neighbours already on screen get a **partial** re-mesh that rebuilds only the
±X/±Z faces — ±Y faces cannot change when a horizontal neighbour loads.

### Failure handling

A job that comes back with `{ type: 'error' }` clears the chunk's pending flag
(and marks it dirty for mesh jobs) so `update()` retries it on a later frame,
rather than leaving a permanently missing chunk.

---

## Worker Protocol

All communication uses `postMessage`. Typed array buffers are transferred (zero-copy) where noted.

### `init`
**Main → Worker:**
```js
{ type: 'init', seed: number, blockRegistry: object[], biomes: object[], blockFaceMap: object }
```
**Worker → Main:**
```js
{ type: 'ready' }
```

### `generateChunk`
**Main → Worker:**
```js
{ type: 'generateChunk', taskId, cx, cz }
```
**Worker → Main:**
```js
{ type: 'chunkGenerated', taskId, cx, cz, voxels: Uint16Array }
// voxels.buffer is transferred (114,688 elements)
```

### `meshChunk`

Chunk voxels cross the boundary **palette-compressed**, not expanded. A snapshot
is `CHUNK_VOLUME` bytes rather than `2 × CHUNK_VOLUME`, the copies are
transferred rather than structure-cloned, and the palette expansion happens on
the worker instead of blocking the frame. `ChunkData.snapshot()` produces these;
`worldWorker` expands them into reusable scratch buffers.

**Main → Worker:**
```js
{
    type: 'meshChunk', taskId, cx, cz,
    chunk: { palette: Uint16Array, indices: Uint8Array, minY, maxY },
    neighbors: { "1,0": <same shape>, ... },   // four horizontal keys only:
                                               // "1,0" "-1,0" "0,1" "0,-1"
    partial: boolean,                          // true = rebuild ±X/±Z faces only
}
// every palette + indices buffer is transferred
```
**Worker → Main:**
```js
// partial: false
{ type: 'chunkMeshed', taskId, cx, cz, yGeo, xzGeo }
// partial: true
{ type: 'chunkMeshed', taskId, cx, cz, xzGeo }

// each geo is:
{
    positions, colors, uvs, layers, indices,                      // opaque mesh
    transparentPositions, transparentColors, transparentUVs,      // transparent mesh
    transparentLayers, transparentIndices,
    yMin, yMax,        // local-Y extent, used for the mesh bounding sphere
}
// all geometry ArrayBuffers are transferred
```

There is **no `normals` attribute** — the chunk shaders bake directional
brightness into vertex colour and never read one, so emitting it would be 12
bytes per vertex of waste.

### `error`
Any handler that throws is caught in `worldWorker` and reported:
```js
{ type: 'error', taskId, message: string }
```
`WorkerPool` releases the worker slot and invokes the job callback with
`{ type: 'error', error }`. `ChunkManager` clears its pending flag so the chunk
is retried on a later frame. Without this an uncaught worker throw left the pool
believing the worker was still busy — losing both the worker and the chunk
permanently, which showed up as a hole in the world that never filled in.

---

## Noise System (`workers/noise.js`)

All noise functions are seeded. Call `setSeed(worldSeed)` once at worker init before generating any terrain.

| Function | Description |
|---|---|
| `setSeed(seed)` | Rebuilds the permutation table from a 32-bit integer seed |
| `noise2D(x, z)` | Raw 2D simplex noise, returns `[-1, 1]` |
| `noise3D(x, y, z)` | Raw 3D simplex noise, returns `[-1, 1]` |
| `fbm2D(x, z, octaves, freq, persistence, lacunarity)` | Fractional Brownian Motion — layered 2D noise, returns `≈[-1, 1]` |
| `fbm3D(x, y, z, octaves, freq, persistence, lacunarity)` | Layered 3D noise |
| `ridged2D(x, z, octaves, freq, persistence, lacunarity)` | Inverted absolute value — produces sharp ridges, returns `[0, 1]` |
| `warpedFbm2D(x, z, octaves, freq)` | Domain-warped FBM — dramatic cliffs and overhangs |
| `hashSeed(seed, a, b, c, d)` | Deterministic PRNG — returns unsigned 32-bit integer |
| `randFloat(seed, a, b, c)` | Deterministic float in `[0, 1)` |

**Important:** `hashSeed` always returns an **unsigned** 32-bit integer (`>>> 0` applied to final result). JavaScript bitwise XOR produces signed integers — missing this `>>> 0` will cause negative modulo results and index-out-of-bounds bugs.

---

## Terrain Generation (`workers/TerrainGenerator.js`)

### Pipeline (per chunk)

1. **Continental noise** — Very low frequency FBM (`freq = 0.00008`, 5 octaves) determines land vs. ocean. Values below `−0.05` push ocean biome weight up.
2. **Temperature + humidity** — Two independent noise fields (`freq ≈ 0.00035`) map each XZ column to a point in biome parameter space.
3. **Biome blending** — All biomes are weighted by inverse-squared distance in temperature/humidity space. Weights sum to 1. Ocean biomes gain extra weight when continental noise is low.
4. **Height field** — Per column: blended weighted average of each biome's height calculation.
5. **Per-biome height** — FBM noise blended with ridged noise by the biome's `mountainBlend` factor. High-variation biomes additionally apply domain warping.
6. **Block fill** — written as contiguous vertical **bands**, not a per-voxel
   branch chain. Each band walks the column with `idx += CHUNK_SIZE` rather than
   recomputing `voxelIndex`, and the air above the terrain is skipped entirely
   because the buffer starts zero-filled (AIR is id 0). Bands, bottom-up:
   - `[BEDROCK_Y, BEDROCK_Y + 2]` → BEDROCK (always wins)
   - up to `terrainHeight - 5` → deep block where `worldY < -80`, else stone block
   - `[terrainHeight - 4, terrainHeight - 1]` → subsurface block
   - `terrainHeight` → surface block, or stone when `terrainHeight <= SEA_LEVEL - 2`
   - `(terrainHeight, SEA_LEVEL]` → WATER
   - above that → AIR (left as-is)
7. **Cave carving** — two 3D noise fields. Carved where `abs(noiseA) < CAVE_THRESH
   AND abs(noiseB) < CAVE_THRESH`. The loop is **bounded** to
   `[CAVE_MIN_Y, columnSurface]` rather than scanning all of `N_Y` and filtering,
   and `noiseB` is only sampled when `noiseA` already passed — the second sample
   is skipped for ~80% of candidates. This is the most expensive step in
   generation, so keep both bounds when editing.
8. **Ore placement** — Vein-based, fully data-driven from biome config (see Biomes section).

### Biome Definition Fields

```json
{
    "name": "PLAINS",
    "temperature": 0.60,
    "humidity": 0.50,
    "baseHeight": 64,
    "heightVariation": 12,
    "heightOctaves": 4,
    "heightFrequency": 0.003,
    "mountainBlend": 0.05,
    "surfaceBlock": "GRASS",
    "subsurfaceBlock": "DIRT",
    "stoneBlock": "STONE",
    "deepBlock": "STONE",
    "structures": {
        "tree": { "frequency": 0.0035, "minSpacing": 5 }
    },
    "ores": [
        { "block": "COAL_ORE", "minY": -32, "maxY": 96, "frequency": 0.020, "minSize": 4, "maxSize": 14 }
    ]
}
```

| Field | Effect |
|---|---|
| `temperature`, `humidity` | Position in biome selection space `[0, 1]` |
| `baseHeight` | Y level of flat terrain in this biome |
| `heightVariation` | Amplitude of terrain noise (blocks) |
| `mountainBlend` | `0` = pure FBM plains, `1` = pure ridged mountains |
| `heightFrequency` | Noise frequency — lower = broader hills |
| `surfaceBlock` | Top visible block |
| `subsurfaceBlock` | 2–4 blocks below surface |
| `stoneBlock` | Default underground fill |
| `deepBlock` | Fill below Y `−80` |

### Current Biomes

| Name | Temp | Humidity | Character |
|---|---|---|---|
| PLAINS | 0.60 | 0.50 | Flat to rolling grass |
| FOREST | 0.58 | 0.72 | Plains with dense trees |
| DESERT | 0.90 | 0.10 | Sandy, low variation |
| MOUNTAINS | 0.30 | 0.40 | High ridged peaks, stone surface |
| OCEAN | 0.50 | 1.00 | Deep water, gravel/clay floor |
| SNOWY_PLAINS | 0.10 | 0.30 | Snow-covered flat terrain |
| SNOWY_MOUNTAINS | 0.05 | 0.35 | Snow-capped high ridges |

### Adding a Biome

Add an entry to `data/gamepack.json` under `"biomes"`. All fields are optional and have safe defaults. The engine picks it up automatically — no code changes needed.

---

## Ore / Vein System

Ores are fully data-driven. Each biome's `"ores"` array lists vein configurations:

```json
{ "block": "COAL_ORE", "minY": -32, "maxY": 96, "frequency": 0.020, "minSize": 4, "maxSize": 14 }
```

| Field | Meaning |
|---|---|
| `block` | Block name to place (must exist in block registry) |
| `minY`, `maxY` | World Y range where this ore can spawn |
| `frequency` | Vein attempts per unit volume of the ore band (`attempts = freq × 16 × 16 × bandHeight`, where `bandHeight = maxY − minY + 1` clamped to the world) |
| `minSize`, `maxSize` | Random vein length range (random walk) |

The vein algorithm is a deterministic random walk from a seed point, replacing non-air/water/bedrock blocks. The walk direction is chosen from the 6 cardinal directions using `hashSeed`.

**Y sampling.** Each attempt samples its Y *inside* the ore's clamped band, from
disjoint bit fields of one hash (4 bits X, 4 bits Z, 20 bits Y offset). The
previous version sampled across the whole world height and discarded anything
outside the band — over 80% wasted work for a narrow band — and took a 10-bit
value modulo the world height, which biased placement toward the bottom of the
world and under-generated any ore whose band sat high up.

Because that bias is gone, a given `frequency` now produces more ore than it
used to for high bands. The shipped coal frequencies were scaled by ~0.72 to
keep coal at the density it actually had in play. If you retune ores, note that
`frequency` now means what the table says it means.

---

## Structure System (`workers/StructurePlacer.js`)

### Cross-Chunk Strategy

The world is divided into **24×24 block cells** (X/Z only). Each cell deterministically decides whether a structure spawns in it:

```
spawnDecision = hashSeed(worldSeed, cellX, cellZ, structureType.length)
spawnRoll = (hash >>> 16) / 0x10000
spawn = spawnRoll < (frequency × CELL_SIZE²)
```

When generating any chunk, the placer scans all cells within `MAX_STRUCTURE_RADIUS = 12` blocks. For each cell with a structure, it applies any blocks that fall within the current chunk's bounds. This means:

- Every chunk independently reconstructs the same structure decisions (deterministic, no inter-chunk state).
- Structures naturally span chunk boundaries.

### Adding a Structure Type

1. Write a builder function in `StructurePlacer.js`:
   ```js
   function buildMyStructure(reg) {
       const STONE = reg.getByName('STONE').id;
       return [
           { dx: 0, dy: 0, dz: 0, blockId: STONE },
           // ... more blocks relative to ground origin
       ];
   }
   ```
2. Register it in `STRUCTURE_BUILDERS`:
   ```js
   const STRUCTURE_BUILDERS = {
       tree:  buildOakTree,
       house: buildSmallHouse,
       myStructure: buildMyStructure,   // add here
   };
   ```
3. Add a frequency to the relevant biome in `gamepack.json`:
   ```json
   "structures": { "myStructure": { "frequency": 0.001, "minSpacing": 10 } }
   ```

### Current Structures

| Type | Description |
|---|---|
| `tree` | Oak tree — 4-block trunk, 3-layer leaf crown, 1-block apex |
| `house` | Rare stone-frame wooden house with gabled roof, 7×9 footprint |

---

## Greedy Meshing (`workers/GreedyMesher.js`)

Groups adjacent same-block visible faces into rectangles, outputting one quad per rectangle instead of one quad per face. Drastically reduces vertex count for flat terrain.

### Algorithm Summary

For each of the 6 face directions:
1. Sweep through each perpendicular slice. Slice counts and mask sizes differ by axis:
   - ±X: 16 slices, each mask is 448×16 (Y×Z)
   - ±Y: 448 slices, each mask is 16×16 (Z×X)
   - ±Z: 16 slices, each mask is 16×448 (X×Y)
2. Build an integer mask: `mask[u][v] = blockId` if the face is visible, else `0`.
3. Walk the mask greedily: expand each non-zero run in `v`, then `u`, marking cells consumed.
4. Emit one quad per rectangle.

Y values outside `[0, CHUNK_SIZE_Y)` return `0xFFFF` (solid) so world-edge faces are culled.
Only 4 horizontal neighbors are needed (`±X`, `±Z`) — no vertical chunk boundaries exist.

### Y-range bounding

`meshGroup(voxels, neighbors, faceDefIndices, yRange)` sweeps only the local-Y
band that contains blocks. A face can only exist on a solid voxel, so sweeping
the empty sky above the terrain can never produce geometry — and in a 448-tall
column that is most of it. `ChunkData` tracks the extent as
`minFilledY` / `maxFilledY` and ships it in `snapshot()`. Measured saving on
realistic terrain: **39–46%** of total mesh time.

### Hot-path constraints

This is the hottest code in the engine — roughly 2.3M voxel reads per full chunk
mesh. When editing it, preserve these:

- **No allocation in the mask-fill loop.** Array destructuring (`const [x,y,z] = coord`)
  allocates an iterator and was previously costing ~1.1M allocations per mesh.
- **Voxel reads are inlined**, not routed through a method that builds a
  `"dx,dz"` template-literal key per lookup. Neighbour arrays are resolved once
  per sweep into `nbr.px/nx/pz/nz`.
- **Solidity comes from `this._solid`**, a `Uint8Array(65536)` lookup, not a
  registry call. It is sized across the full id space so the lookup stays
  branch-free even for the `SOLID_SENTINEL` value.
- **Output goes into growable typed arrays** (`F32Buf` / `U32Buf`), not JS arrays
  converted at the end.

`test/mesher.test.mjs` checks the output against a brute-force per-face
reference (emitted area must match exactly, indices must be in range) across
flat, solid, transparent, neighbour-culled and checkerboard cases. Run it with
`npm test` after touching this file.

### Two Output Meshes

| Mesh | Material | Blocks |
|---|---|---|
| Opaque | `ShaderMaterial` (GLSL3) — texture array + baked brightness + fog | All non-transparent blocks |
| Transparent | Same shader, `transparent`, `depthWrite: false`, `DoubleSide`, alpha 0.72 | Water, leaves, ice, glass |

The transparent material **must stay `DoubleSide`**: the mesher emits only the
outward-facing shell of a transparent volume, so culling backfaces makes the
water surface disappear when the camera is underneath it.

### Directional Brightness

Simulates directional lighting without a real light pass:

| Face | Brightness |
|---|---|
| Top (+Y) | 1.00 |
| Bottom (-Y) | 0.45 |
| Side (+Z / -Z) | 0.85 / 0.80 |
| Side (+X / -X) | 0.70 / 0.70 |

### Winding Order

- Positive faces (+X, +Y, +Z): index order `0,1,2, 0,2,3`
- Negative faces (-X, -Y, -Z): index order `0,2,1, 0,3,2`

This ensures CCW front-face winding consistent with Three.js defaults.

### Face / Axis Mapping

| Face | faceAxis | uAxis | vAxis |
|---|---|---|---|
| ±X | 0 (X) | 1 (Y) | 2 (Z) |
| ±Y | 1 (Y) | 2 (Z) | 0 (X) |
| ±Z | 2 (Z) | 0 (X) | 1 (Y) |

---

## Render Layer (`world.js`)

### Responsibilities

- Three.js scene, camera, renderer, lighting (ambient + directional sun).
- Creates `BufferGeometry` from worker-produced typed arrays.
- Manages `chunkMeshes` map (`key → { opaque: Mesh, transparent: Mesh }`).
- First-person fly controls (WASD + mouse look via Pointer Lock API).
- Calls `chunkManager.update()` every frame.

### Controls

| Key | Action |
|---|---|
| W/A/S/D | Move horizontally relative to look direction |
| Space | Jump (or ascend while flying) |
| Ctrl / Q | Sneak (or descend while flying) |
| Shift | Sprint |
| Mouse | Look (requires pointer lock) |
| LMB / RMB | Break / place block, attack, use item |
| 1–0 | Select hotbar slot |
| E | Inventory |
| C | Craft menu / creative inventory |
| F11 | Toggle fullscreen (desktop app) |

Movement runs through `PlayerPhysics` (AABB collision, gravity, jump, fall
damage), with free-fly in Creative and Spectator.

### Mouse look

Pointer lock is acquired through `lockPointer()` in `main.js`, which requests
`unadjustedMovement: true`. Without it the browser feeds pointer-lock deltas
through the OS pointer-acceleration curve ("Enhance pointer precision" on
Windows), so identical physical motion yields different deltas depending on
speed — which is what makes a mouse-look camera feel jittery and unpredictable.
It falls back to a plain lock where the option is unsupported.

Rotation is applied directly in the `mousemove` handler and is **never scaled by
dt** — the camera should track the mouse, not the frame clock. The renderer reads
`yaw`/`pitch` at draw time, so all events since the last frame are already
integrated; accumulating and flushing per frame would only add latency.

The slider → radians mapping is linear on purpose. Minecraft applies a cubic
response curve, which does give better fine control at low settings, but adding
one would change what every already-saved sensitivity value means — and would
make a raised setting faster rather than calmer.

### Player physics (`PlayerPhysics.js`)

Everything is tuned through named constants at the top of the file, and the
derived ones exist so retuning one value cannot silently change something else.

- **Horizontal motion is velocity-based**, eased toward the input target with
  `approach(rate, dt)` — a frame-rate independent exponential, so 30 fps and
  144 fps feel identical. Position used to be written directly from the input
  vector, which started and stopped the player instantly. Rates: `ACCEL_GROUND`
  14, `ACCEL_STOP` 12, `ACCEL_AIR` 8, `ACCEL_WATER` 6 (all 1/s; time constant is
  the reciprocal).
- **`JUMP_VEL` is derived from `JUMP_HEIGHT`**, not hardcoded. Raising `GRAVITY`
  shortens the arc without changing what the player can climb onto.
- **Fall damage constants are derived from `GRAVITY`** for the same reason: a
  fixed velocity threshold would make short falls start hurting the moment
  gravity changed, because a given drop reaches a higher speed.
- **Water is a drag model**, not a velocity clamp. `vel.y` relaxes toward
  `WATER_SINK_SPEED` at `WATER_DRAG`, so entering water bleeds off a fall over
  about a second. The previous `max(vel + g·dt, terminal)` snapped a -40 m/s
  fall to -3 in a single frame. `WATER_SWIM_ACCEL` / `WATER_SWIM_SPEED` are
  layered on top while jump is held.
- **Gravity is applied unconditionally**; the collision test is what
  re-establishes `onGround`. Skipping gravity while grounded left `vel.y` at
  exactly 0, making the vertical move a no-op that "succeeded" and cleared
  `onGround` — so standing still flip-flopped the flag every frame, alternating
  air and ground acceleration and occasionally swallowing a single-frame jump.

### Scene Setup

- **Renderer:** `powerPreference: 'high-performance'` — without it, Windows
  laptops with switchable graphics may bind the integrated GPU for the session.
  `preserveDrawingBuffer` is deliberately **off**: it costs a full-framebuffer
  copy every frame. World thumbnails are captured in the same task as a render
  instead — see `_render()` / `_capturePendingScreenshot()`.
- **Pixel ratio:** `min(devicePixelRatio, 2) × resolutionScale`, where the scale
  is a player setting (0.5–1.0).
- **Fog** is derived from the render distance in `_applyViewDistance()`, so a
  lower render distance fades out instead of showing a hard edge:
  - fog near = `renderDistance × 16 × FOG_START` (0.75)
  - fog far  = `renderDistance × 16 × FOG_END` (1.00)

  Fog — not the far plane — is what limits how far the player can see. Widen
  `FOG_START` toward 1.0 to reveal more of the loaded area; the trade is that
  the load boundary becomes more visible.
- **`camera.far` is a fixed `CAMERA_FAR` (4096)**, set once at camera creation
  and deliberately *not* scaled with render distance. Scaling it clipped the far
  corners of the outermost chunks, because a chunk centred at the render radius
  extends past that radius diagonally. If a long-range view mode pushes this much
  further, the limit to watch is depth precision (governed by the far/near ratio,
  and near is 0.1 because the camera sits inside the player's AABB) — the lever
  there is `logarithmicDepthBuffer: true`, not a larger far value.

### Chunk Shaders

The chunk materials are a custom `ShaderMaterial` (GLSL3), so **WebGL 2 is
required** — `_checkWebGL2()` raises `ww_fatalError` if it is missing, and
`_warnIfSoftwareRenderer()` raises `ww_gpuWarning` when Chromium has fallen back
to SwiftShader.

A custom `ShaderMaterial` gets no fog from Three.js automatically, so the
fragment shader applies it from a `vDepth` varying. It also applies brightness
and the colourblind transforms via `uBrightness` / `uColorMode`. Those used to be
a CSS `filter` on `<body>`, which pushed the whole page — canvas included —
through an extra compositing pass every frame, so enabling an accessibility
option cost frame rate.

Uniforms are shared between the opaque and transparent materials via the
`chunkUniforms` object, so one write updates all terrain.

---

## GamePack System

GamePacks are JSON + asset bundles loaded at startup. Multiple packs can be active simultaneously — later packs do not override earlier ones (first-registered wins for blocks and biomes).

World generation parameters (blocks, biomes) from all loaded packs are merged into `mergedGamePackData` in `main.js` and passed to `world.js` via the `startWorldLoad` event.

The engine owns all generation algorithms. GamePacks provide configuration data only — no executable code.

---

## Desktop App (`electron/main.js`, `electron-builder.yml`)

The packaged app boots the bundled Express + WebSocket server in-process, then
opens a window pointed at it.

- **The server binds an OS-assigned port** (`PORT=0`) on **loopback only**. A
  fixed 3000 meant the app failed to launch with no window and no message
  whenever anything else held that port, and binding all interfaces exposed the
  world-save API to the whole network. The launcher reads the real port back
  from `serverReady` — nothing may assume a port number, including the client,
  which derives its URLs from `location.origin`.
- **Startup failures surface** via `dialog.showErrorBox` instead of a silent
  `app.quit()`.
- **Window geometry persists** to `window-state.json` in `userData`, and a saved
  position that no longer lands on a connected display is discarded. F11 toggles
  fullscreen.
- **Updates** — see the section below.
- **The installer is not code signed.** See the comment block in
  `electron-builder.yml` for what to set (`CSC_LINK` / `CSC_KEY_PASSWORD`).
  Until then Windows SmartScreen warns on every install.

### Chunk persistence (`server/server.js`)

Three layers keep loading a saved world faster than regenerating it. All three
matter — dropping any one puts the cost back.

1. **Regions are cached decoded, in memory**, keyed by world + region coords
   under a byte budget (`REGION_CACHE_MAX_BYTES`, 96 MB) with LRU eviction.
   Previously every chunk request decoded the whole region file again, so the 64
   chunks in one region meant 64 full decodes of the same data, serialised behind
   the region lock. That made loading a saved world **~13x slower than
   generating it from scratch** (31 ms/chunk vs 2.3 ms).
2. **The region file is a flat binary blob** (`WWR2` magic), gzipped. The old
   format was JSON with base64-encoded indices, which inflated the payload by a
   third and made each read a multi-megabyte string parse. Decoding is 2.3x
   faster and files are ~38% smaller. Legacy JSON regions are still read
   transparently and get rewritten as binary on the next save.
3. **A `chunk-index.json` sidecar lists saved chunk keys.** `getManifest` used to
   decode every region file in the world just to enumerate keys — a full-world
   scan on every open, growing with how much the player had explored. Worlds
   without an index are scanned once and then get one written.

Measured on 225 chunks of real terrain, cold process:

| | before | after |
|---|---|---|
| load saved chunks | 31 ms/chunk | 0.89 ms/chunk |
| `getManifest` | 115 ms | 7 ms |
| generate fresh (reference) | 2.67 ms/chunk | — |

Entries are replaced wholesale rather than mutated in place, so a reader always
sees a consistent region and cache hits need no lock. `npm run bench:load`
re-runs this measurement; `test/persistence.test.mjs` covers round-trip fidelity,
the legacy format, and the wrong-world-height rejection.

### Updates

Two mechanisms, because no single one works everywhere.

| | Mechanism | Platforms | What the player sees |
|---|---|---|---|
| 1 | `electron-updater` via `latest.yml` | Windows | Downloads silently, installs on quit |
| 2 | The website's `wonderworld-app.json` | everything else | "Update available — Download" |

Where 1 is available it is used and 2 never runs. Where it is absent or errors,
2 is the fallback, so the player still finds out an update exists.

**macOS cannot auto-update while the build is unsigned.** Squirrel.Mac validates
the signature of the downloaded update against the running app, so enabling it
unsigned produces downloads that always fail to install. `MAC_AUTO_UPDATE_SIGNED`
in `electron/main.js` is the switch to flip once the app is signed and notarised;
the `zip` mac target it needs is already built.

**How the UI hears about it.** The window runs with `contextIsolation` and
`sandbox` on and no preload, so there is no IPC channel to the renderer — an
earlier `webContents.send()` here went nowhere. The launcher and the embedded
server share a process, so the launcher publishes state through
`setUpdateState()` and the renderer reads `GET /api/update-status` like any
other data. This also sidesteps CORS: the remote manifest sends no
`access-control-allow-origin`, so the renderer could not fetch it directly even
if it wanted to.

Version comparison is `isNewerVersion()` in `electron/main.js`, written out
rather than pulled from electron-updater's transitive `semver`. It implements
semver precedence, which matters here: every shipped version is a prerelease, and
a string compare puts `beta.10` *below* `beta.9`. `test/version.test.mjs` covers it.

The banner only appears on the title and pause screens. An update is never worth
interrupting play for, and it installs on quit regardless.

#### Releasing

`publish.provider` is `generic` pointing at the library host, which
electron-builder cannot upload to — so CI builds with `--publish never` and
attaches assets to the GitHub Release, which is where you fetch them from.

Upload **all** of these to the installers directory:

```
WonderWorld-<version>-x64.exe
WonderWorld-<version>-x64.exe.blockmap    <- do not skip
beta.yml                                  <- name varies, see below
WonderWorld-<version>-universal-mac.zip   (macOS)
beta-mac.yml                              (macOS)
```

then update `wonderworld-app.json`.

**The feed file is named after the channel, not always `latest`.**
electron-builder derives the channel from the version's prerelease tag and bakes
it into the installed app's `app-update.yml`. At `1.0.0-beta.1` the build emits
`beta.yml` and the app requests `beta.yml`; a stable `1.0.0` would produce
`latest.yml`. Upload whatever name appears in `dist/` — uploading the wrong one
means the app requests a URL that 404s and silently never updates.

This also makes channels sticky: a player on a `-beta` build keeps asking for
`beta.yml` indefinitely. To move beta players onto a stable release, keep
publishing a `beta.yml` that points at it.

The feed file carries the sha512 the updater verifies against. The `.blockmap` is
what makes updates cheap — with it the updater fetches only the changed blocks of
the ~111 MB installer instead of all of it. Omitting it silently falls back to a
full download every release, which still works, so it will not look broken.

Distribute the **`.exe`**, not a zip: Windows auto-update runs the NSIS installer,
and an extracted portable copy cannot update itself.

### Save format compatibility

The on-disk chunk payload is exactly `CHUNK_VOLUME` bytes, so **changing
`CHUNK_SIZE_Y` or `WORLD_MIN_Y` invalidates every saved world.** Bump
`WORLD_FORMAT` when you do. The server compares each stored chunk's length
against `CHUNK_VOLUME` and treats a mismatch as "not saved" (regenerating it)
rather than letting `Buffer.copy` silently truncate it into corrupt terrain.
New worlds record `format`, `worldHeight` and `worldMinY` in their metadata.

---

## Testing

| Command | What it does |
|---|---|
| `npm test` | Mesher correctness, chunk-persistence round-trip, semver precedence, and the update status bridge. Fast, no browser. |
| `npm run bench:load` | Saves 225 chunks of real terrain, then times a cold re-open against generating them fresh. |
| `npm run test:smoke` | Boots the server, drives the real game in headless Edge/Chrome into a live world, and fails on any console error, page exception or failed request. Also drives the update banner through its states. Set `BROWSER=<path>` to pick the browser. |

The smoke test is the one that catches renderer regressions — shader compile
failures, bad geometry attributes, worker crashes — none of which show up in a
syntax check. It also quits and re-enters a world, so teardown leaks show up as
geometry or texture counts that fail to return to zero.

A clean run reports zero console errors, zero page exceptions and zero failed
requests. Treat any of those being non-zero as a failure, not as noise.

---

## Known Limitations / Future Work

| Area | Current State | Next Step |
|---|---|---|
| Lighting | Baked directional brightness in vertex colour | Sunlight propagation, block light |
| Water | Incremental BFS spread (`WaterSimulator`) | Proper fluid levels / pressure |
| Structures | Hardcoded builders | GamePack-defined structure blueprints |
| Biome transitions | Smooth blend | River / beach edge generation |
| Multiplayer | Architecture ready | Server/peer connection layer |
| Mipmaps | Off — `NearestFilter`, no mips | Needs `textureGrad` with derivatives from the untiled UV; naive mips bleed at tile seams because `fract(uv)` has a discontinuous derivative |
| Draw calls | ~440 at render distance 8 | Merge the Y/XZ mesh split once a chunk's neighbours have settled |
| Chunk transfer | Palette snapshot, copied per job | `SharedArrayBuffer` voxel store (needs COOP/COEP headers on the server) |
| Code signing | Unsigned — SmartScreen warns | OV/EV certificate or Azure Trusted Signing |
