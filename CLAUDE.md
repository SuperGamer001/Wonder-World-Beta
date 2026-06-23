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
      ChunkData.js               16×640×16 column storage (palette-compressed)
      WorldState.js              Authoritative chunk map and block get/set
      WorkerPool.js              Auto-sized worker pool with job queue
      ChunkManager.js            Chunk load/unload lifecycle and priority scheduling
    workers/                     Worker-thread modules (no Three.js, no DOM)
      worldWorker.js             Worker entry point — handles generate and mesh jobs
      noise.js                   Seeded simplex noise, FBM, ridged, domain warp, PRNG
      TerrainGenerator.js        Layered terrain, caves, and ore placement
      StructurePlacer.js         Cross-chunk structures (trees, houses)
      GreedyMesher.js            Greedy meshing algorithm
data/
  gamepack.json                  Default GamePack — blocks (IDs 0–19), biomes (7 types)
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
| `CHUNK_SIZE_Y` | 640 | Full world height in blocks (480 − (−160)) |
| `WORLD_MIN_Y` | -160 | Bottom of the world (bedrock floor) |
| `CHUNK_VOLUME` | 163,840 | `16 × 640 × 16` — voxels per chunk column |
| `SEA_LEVEL` | 64 | World Y coordinate of ocean surface |
| World max Y | 480 | Maximum world Y |
| World X/Z range | ±2,000,000 | |
| Default render distance | 6 chunks | Adjustable on `ChunkManager` |

**Chunk columns:** Each chunk is a 16×640×16 column spanning the full world height.
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

Each chunk column is 16×640×16 voxels (`CHUNK_VOLUME = 163,840`).

**Voxel index formula:**
```js
index = lx + ly * CHUNK_SIZE + lz * (CHUNK_SIZE * CHUNK_SIZE_Y)
// lx ∈ [0,15]  ly ∈ [0,639]  lz ∈ [0,15]
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
- `mesh`, `transparentMesh` — Three.js Mesh handles, owned by `world.js`

Note: `ChunkData` has no `cy` field. The constructor is `new ChunkData(cx, cz)`.

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

Drives the chunk lifecycle every frame via `chunkManager.update(playerPos, viewDir, moveDir)`.

### Priority Formula

```
priority = euclideanDistance × viewFactor × moveFactor

viewFactor = 1.0 - dot(chunkDir, viewDir) × 0.40
moveFactor = 1.0 - dot(chunkDir, moveDir) × 0.20
```

Chunks directly in front of the player load at `0.60×` the base distance cost. Chunks in the travel direction get an additional `0.80×` multiplier. Chunks behind the player load last.

### Callbacks (wired in `world.js`)

```js
chunkManager.onMeshReady   = (cx, cz, geometry) => { /* build Three.js mesh */ }
chunkManager.onChunkUnload = (key) => { /* dispose Three.js mesh */ }
```

### Re-mesh on Neighbour Load

When a chunk finishes generating, all six face-adjacent neighbours that are already generated are also queued for re-meshing. This ensures boundary faces are correct (a freshly loaded chunk's edge faces depend on its neighbours' voxel data).

---

## Worker Protocol

All communication uses `postMessage`. Typed array buffers are transferred (zero-copy) where noted.

### `init`
**Main → Worker:**
```js
{ type: 'init', seed: number, blockRegistry: object[], biomes: object[] }
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
// voxels.buffer is transferred (163,840 elements)
```

### `meshChunk`
**Main → Worker:**
```js
{
    type: 'meshChunk', taskId, cx, cz,
    voxels: ArrayBuffer,                        // copy, not transfer (163,840 × 2 bytes)
    neighbors: { "1,0": ArrayBuffer, ... }      // four horizontal neighbors only: "1,0" "-1,0" "0,1" "0,-1"
}
```
**Worker → Main:**
```js
{
    type: 'chunkMeshed', taskId, cx, cz,
    geometry: {
        positions, normals, colors, indices,               // opaque mesh
        transparentPositions, transparentNormals,          // transparent mesh
        transparentColors, transparentIndices
    }
}
// all geometry ArrayBuffers are transferred
```

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
6. **Block fill** — Per voxel column:
   - `worldY > terrainHeight && worldY <= SEA_LEVEL` → WATER
   - `worldY > terrainHeight` → AIR
   - `worldY == terrainHeight && worldY > SEA_LEVEL - 2` → surface block
   - `terrainHeight - worldY <= 4` → subsurface block
   - `worldY < -80` → deep block (e.g. granite, diorite)
   - else → stone block
   - `worldY <= BEDROCK_Y + 2` → BEDROCK (always)
7. **Cave carving** — Two 3D noise fields (`freq = 0.040` and `0.065`). Where `abs(noiseA) < 0.55 AND abs(noiseB) < 0.55`, the voxel is carved. Deep caves (`worldY < SEA_LEVEL - 16`) fill with water instead of air. Never carves above `terrainHeight - 4`.
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
| `frequency` | Vein attempts per unit volume (`attempts = freq × 16 × 640 × 16`) |
| `minSize`, `maxSize` | Random vein length range (random walk) |

The vein algorithm is a deterministic random walk from a seed point, replacing non-air/water/bedrock blocks. The walk direction is chosen from the 6 cardinal directions using `hashSeed`.

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
   - ±X: 16 slices, each mask is 640×16 (Y×Z)
   - ±Y: 640 slices, each mask is 16×16 (Z×X)
   - ±Z: 16 slices, each mask is 16×640 (X×Y)
2. Build an integer mask: `mask[u][v] = blockId` if the face is visible, else `0`.
3. Walk the mask greedily: expand each non-zero run in `v`, then `u`, marking cells consumed.
4. Emit one quad per rectangle.

Y values outside `[0, CHUNK_SIZE_Y)` return `0xFFFF` (solid) so world-edge faces are culled.
Only 4 horizontal neighbors are needed (`±X`, `±Z`) — no vertical chunk boundaries exist.

### Two Output Meshes

| Mesh | Material | Blocks |
|---|---|---|
| Opaque | `MeshLambertMaterial({ vertexColors: true })` | All non-transparent blocks |
| Transparent | `MeshLambertMaterial({ vertexColors, transparent, opacity: 0.72, DoubleSide })` | Water, leaves, ice, glass |

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
| Space | Move up |
| Ctrl / Q | Move down |
| Shift | Move faster (3×) |
| Mouse | Look (requires pointer lock) |

### Scene Setup

- Fog: `THREE.Fog(0x87CEEB, 160, 280)` — fades at 5–9 chunks
- Camera far clip: `512` units (16 chunks)
- Pixel ratio: capped at 2 for performance

---

## GamePack System

GamePacks are JSON + asset bundles loaded at startup. Multiple packs can be active simultaneously — later packs do not override earlier ones (first-registered wins for blocks and biomes).

World generation parameters (blocks, biomes) from all loaded packs are merged into `mergedGamePackData` in `main.js` and passed to `world.js` via the `startWorldLoad` event.

The engine owns all generation algorithms. GamePacks provide configuration data only — no executable code.

---

## Known Limitations / Future Work

| Area | Current State | Next Step |
|---|---|---|
| Player physics | Fly/noclip only | Add AABB collision against loaded voxels |
| Lighting | Directional brightness only | Sunlight propagation, block light |
| Water | Static fill | Fluid simulation pass |
| Block interaction | None | Raycast + block break/place pipeline |
| Structures | Hardcoded builders | GamePack-defined structure blueprints |
| Biome transitions | Smooth blend | River / beach edge generation |
| Multiplayer | Architecture ready | Server/peer connection layer |
| Texture atlas | Vertex colors | UV generation in greedy mesher |
