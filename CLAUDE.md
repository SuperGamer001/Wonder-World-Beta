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
    Atmosphere.js                Day cycle + weather → sky, clouds, rain, light, sound
    AtmosGLSL.js                 Uniforms + GLSL shared by terrain, sky, clouds, rain
    Sky.js                       Sky dome, sun, moon, stars (simple / pretty)
    Clouds.js                    Weather-driven cloud layer (fast / fancy)
    Precipitation.js             Rain, snow, sleet, hail, splashes, dust, ash
    Lightning.js                 Bolts and flashes
    Tornado.js                   Funnel + debris
    WeatherAudio.js              Procedural rain, wind and thunder (WebAudio)
    Shadows.js / Particles.js    Sun shadow map / block-break debris
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
      SmoothShape.js             Smooth-terrain Mesh block shapes + collision (shared)
      Sun.js                     Sun direction, face shading, sky-light constants (shared)
      DayCycle.js                World clock, sun/moon path, light and sky palette
      Weather.js                 Weather types, Markov chain, climate localisation
      Climate.js                 Temperature/humidity/biome weather at a position
      CloudField.js              The cloud pattern — CPU twin of the GPU cloud field
    workers/                     Worker-thread modules (no Three.js, no DOM)
      worldWorker.js             Worker entry point — handles generate and mesh jobs
      noise.js                   Seeded simplex noise, FBM, ridged, domain warp, PRNG
      TerrainGenerator.js        Layered terrain, caves, and ore placement
      StructurePlacer.js         Cross-chunk structures (trees, houses)
      GreedyMesher.js            Greedy meshing algorithm
      SmoothMesher.js            Smooth-terrain pass for deformed Mesh blocks
      Skylight.js                Sky-light propagation for one chunk (+ its neighbours)
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
  smooth.test.mjs                Smooth-terrain bounds, watertightness, collision, walking
  light.test.mjs                 Sky-light rules and seam agreement between chunks
  weather.test.mjs               Day cycle, cloud coverage/rain placement, weather chain, climate
  worker.test.mjs                worldWorker replies vs. the mesher/solver on fresh arrays
  chunkmanager.test.mjs          Chunk scheduling through WorkerPool with fake workers
  pipelinebench.mjs              Stage timings + output hashes for the worker pipeline
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
    "terrainType": "mesh",
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
- `terrainType` is `"mesh"` or `"solid"` — see *Smooth Terrain* below. Every
  shipped block declares it. Transparent and liquid blocks are always forced to
  `"solid"`; when the field is missing, opaque non-interactable blocks default to
  `"mesh"`.
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
4. Give it a `terrainType`: `"mesh"` for natural ground, `"solid"` for anything
   built, see-through or interactive.

---

## Smooth Terrain (hidden world setting)

Each world has a `terrainStyle` of `"smooth"` (the default) or `"blocky"`. It is
on no settings screen: it lives in the world's `user/worlds/<id>/world.json`,
and `TERRAIN_STYLE` in `server/server.js` picks the value stamped into new
worlds. `PUT /api/worlds/:id/settings` also accepts it, though no UI sends it.
It is read only in `startWorldLoad`, so a change applies the next time the world
loads. Worlds created before the setting existed have no value and load blocky,
which is how they were built. Voxel data and the save format are identical in
both styles, so a world can be switched back and forth freely.

In a blocky world none of the code below runs: the worker builds no
`SmoothMesher`, `ChunkManager.smooth` is false, and the physics/entity
`smooth` collider is null.

### Block types

`terrainType` is permanent per block type. Neighbours change a Mesh block's
*geometry*, never its type.

| Type | Blocks |
|---|---|
| `mesh` | GRASS, DIRT, STONE, SAND, GRAVEL, the three ores, SNOW, SANDSTONE, CLAY, SNOW_DIRT, GRANITE, DIORITE |
| `solid` | AIR, WATER, LEAVES, ICE, GLASS (see-through/liquid); WOOD, BEDROCK; the interactables; all crafted building blocks |

Structures built from Mesh blocks (the house's stone frame) are smoothed too.

### Shape model (`engine/SmoothShape.js`)

A deformed Mesh voxel is its unit cube cut from above by a smooth **top
surface** and from below by a smooth **bottom surface**, both heightfields over
the footprint with heights in `[0, 1]` of the voxel. Each surface is pinned at
the four vertical edges (corner heights), joined along each side by an **edge
curve** (a monotone Hermite cubic), and filled in by a smoothstep-blended
**Coons patch**. Three properties hold everything together; keep them:

1. **Nothing leaves the voxel.** Corner heights are in `[0, 1]`, edge curves
   are monotone (Fritsch–Carlson slope limits) so they never overshoot their
   ends, and interior samples are clamped.
2. **Neighbours meet exactly.** Everything an edge curve depends on (its two
   corner heights and slopes, whether it carries a crest, whether it is drawn
   straight) is computed from the edge's own neighbourhood, never from the
   voxel asking, so both voxels sharing a side draw it bit for bit the same.
   Boundary samples come from `edgeSample` — the polyline through the edge's
   own samples — never from the patch formula.
3. **Surfaces are C1 across voxels.** Smoothstep has zero slope at 0 and 1, so
   the slope across a side depends only on that side's two corner slopes.

Corner heights (the edge rule), for the four voxels around a vertical edge at
one level:

- any Solid block among them → edge is full (`t=1, b=0`), so terrain meets a
  cube flush and a placed Solid block reads as part of the terrain
- any of them has a block directly above → `t = 1`; directly below → `b = 0`
- all four filled → `t = 1, b = 0` (flat interior)
- otherwise the corner drops (`t = 0`) — **including inside corners**, which is
  what keeps diagonal terrace edges from becoming a sawtooth
- `b > t` (thin floating sheet) → both meet at 0.5

"Filled" means non-air and non-liquid, so the sea floor smooths like dry land.

Corner slopes (`SmoothField.cornerSlope`): the sheet slope comes from the
surface heights on the neighbouring lattice lines, found **across levels**
(`topCrossNear`), so a staircase of one-block steps renders as one straight
slope rather than a row of S-bends. It is then limited by every same-level
stretch of visible top surface running from that corner, so both voxels at a
seam agree on it. A stretch that is covered (the surface continues on another
level) does not count, or it would flatten the staircase again.

Thin features (**crests**): a voxel whose four top corners all drop — a
one-wide line, bend, T, cross or ring, or a lone block — would flatten away. It
becomes a *crest voxel* instead: a rounded crest runs from its centre to the
middle of every side it shares with a neighbour. A side carries the crest (a
hump in its edge curve, height 1 at its middle) when **both** voxels beside it
are open-topped Mesh voxels on the same level **and either one** is a crest
voxel. That test is symmetric, so both voxels always agree, and thin features
join up: a ring with no middle block is one continuous loop, a plus is four
arms meeting in a raised centre, a line end gets a rounded cap, a lone block a
round dome, and a thin arm flows into the wider ground it is attached to (that
ground voxel carries the crest on its shared side too). The crest profile is
`bump(½ − d)` for distance `d` to the crest lines, with `bump(s) = 16s²(1−s)²`,
so it is 0 with zero slope at unlinked sides and never disturbs a neighbour.
Diagonal neighbours do not join: they share only a corner line, so a join
there could only be a zero-width pinch.

Bottoms use exactly the same rules through a second `SmoothField` that sees the
world upside down (`flipped`), so `shape.bot.c` holds `1 − bottom height`.

A Mesh voxel with a block both above and below is always a full cube (fast path),
and so is the flat interior of terrain. Full-cube Mesh voxels stay in the greedy
pass, so flat ground is still merged into large quads.

Cost controls, both in `SmoothShape.js`:

- `SMOOTH_SAMPLES` — where edges and patch axes are sampled: `[0, 1]` for a
  straight edge, thirds for a curved one, thirds plus the middle for one that
  carries a crest (so the crest is drawn at full height, not cut flat between
  samples). The sets are **nested**: a patch samples each axis at its finest
  edge's set, and `edgeSample` evaluates any extra sample on the edge's own
  polyline, so voxels sampling a shared edge at different resolutions still
  draw the same line — no cracks, at worst a T-junction on a straight segment.
  Flat and evenly sloped patches stay 2 triangles; crest voxels take 32.
- `SMOOTH_MIN_BEND` (0.05 blocks) — an edge bending less than this is drawn
  straight. Bottoms (cave ceilings, overhang undersides) are always straight;
  otherwise they cost as many triangles as all the visible terrain.

Measured on generated terrain: about 3.5× the triangles of the blocky mesh
(mountains 5.7k vs 1.6k per chunk, plains 3.6k vs 1.0k), and 15–22 ms to mesh
a chunk. Straightening loses geometry only; normals are always computed from
the unstraightened surface (`es` slopes), so lighting stays smooth either way.

### Meshing (`workers/SmoothMesher.js`)

`prepare()` classifies each Mesh voxel. Deformed ones are flagged in `partial`,
skipped by `GreedyMesher`, and emitted into the chunk's opaque geometry: a
sampled top patch, a sampled bottom patch, and a strip on each open side
between the two edge curves. `meshGroup(…, smooth)` takes `{ occ, partial, emit }`; without it
the greedy path is exactly the blocky one.

- **Every Mesh voxel is an occluder** (`occ`), including deformed ones: two Mesh
  voxels sharing a side draw identical edge curves there, so their
  cross-sections match and the face between them can never be visible.
- **Transparent faces are never drawn against Mesh voxels.** Drawing water faces
  there would double-tint the sea floor wherever voxels are partially filled.
- **Smooth shading:** each patch vertex gets `sunBrightness` of the surface
  normal there (see *Lighting*). Neighbours compute the same normal along a
  shared side.
- **Texture per patch**, from the face closest to the patch's overall
  direction (the plane through its corners). A top patch therefore always shows
  the top texture — a curved slope never switches texture half way across a
  block — and side strips show the side texture.
- Patches and strips are indexed; each patch's triangulation (`surfaceGrid`'s
  per-cell diagonal) is exactly the one collision uses.

### Chunk edges

A voxel's shape reads up to `SMOOTH_REACH` (2) blocks away horizontally —
corner slopes look one lattice line past the corners — **including into the
diagonal chunks**. In smooth worlds `ChunkManager`:

- sends `corners`: a `SMOOTH_REACH × SMOOTH_REACH` block of columns from each
  diagonal chunk (`ChunkData.cornerBlock`) with each mesh job
- re-meshes all eight neighbours when a chunk loads, diagonals included (a
  diagonal neighbour deforms voxels near the shared corner); blocky worlds
  only relight the diagonals. See *Re-mesh on Neighbour Load* for how these
  are coalesced.
- `markEdited` re-meshes a neighbouring chunk for an edit within
  `SMOOTH_REACH` of the seam, and the diagonal chunk near a corner

Missing neighbours read as `SENTINEL` (a filled cube) on both sides, just as in
blocky meshing. In the worker, `SmoothField` memoises edge spans and corner
slopes in flat typed arrays sized to the chunk plus that reach.

### Collision

`SmoothTerrain` (in `SmoothShape.js`) builds shapes with the **same functions**
the mesher uses — the same sampled grids and the same triangulation — so what
you collide with is what is drawn. A box hits a deformed voxel when the highest
point of its top surface under the box footprint is above the box bottom (exact,
by clipping each triangle to the footprint, allocation-free). Shapes and edge
spans are cached and dropped whenever `WorldState.editVersion` changes — bumped
on every edit and chunk load/unload.

`PlayerPhysics` adds `STEP_HEIGHT` (0.6) step-up for blocked grounded moves and
`SNAP_DOWN` (0.6) to keep the player on a descending slope. Both stay below one
block, so a full cube or an un-smoothed cliff still needs a jump. Mobs step up
the same way; dropped items and the suffocation/head checks test the point
against the shape.

The raycast and selection outline still work on whole voxels.

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
hands the worker the compressed `{ palette, indices, minY, maxY }` pair. The
buffers are fresh copies so they can be **transferred** rather than
structure-cloned, and the palette expansion runs on the worker.
`toUint16Array()` remains for tooling and tests; do not reintroduce it on the
mesh path — expanding five chunks per mesh job on the main thread was the
single largest source of frame-time churn.

`snapshot().indices` holds **only the filled band** `[minY, maxY]`, packed one
block per z slice: `indices[(ly − minY)·16 + lx + lz·bandSize]`, with
`bandSize = (maxY − minY + 1)·16`. Everything outside the band is AIR by the
`minFilledY`/`maxFilledY` invariant, so it need not be sent — the sky above the
terrain is most of a column, so this halves the bytes and the allocation. Every
mesh or light job copies nine of these on the main thread, which made
`snapshot()` the largest main-thread cost while loading.

**Arriving from generation:** the worker palette-compresses a new chunk itself
(`compressVoxels`, in `ChunkData.js`) and the main thread only calls
`adoptCompressed()` — no per-voxel work and no copy on the render thread.
`loadVoxels(Uint16Array)` wraps the same two for tools and tests.

---

## Worker Pool (`WorkerPool.js`)

Workers are created as **module workers** (`{ type: 'module' }`), which allows the worker files to use ES module `import` statements.

**Worker count:** `max(2, min(hardwareConcurrency - 1, 8))`

**Lifecycle:**
1. Construct: `new WorkerPool(workerUrl)` — workers are created but idle.
2. Init: `await pool.init({ seed, blockRegistry, biomes })` — broadcasts init to all workers, resolves when all respond `{ type: 'ready' }`.
3. Dispatch: `pool.dispatch(job, callback, xfer, priority)` — queues job; when a worker is free it picks up the next job.
4. Clear: `pool.clearQueue()` — cancels pending (not yet started) jobs.

**Lazy payloads:** `job` may be a function `() => ({ job, xfer }) | null`, called
when a worker actually takes the job. `ChunkManager` uses this for every job:
chunk snapshots (~1 MB per mesh job) are copied only when they are about to be
used, so they are current rather than as old as the queue, the queue holds no
copies, and a job whose chunk has since unloaded returns `null` and costs
nothing — its callback gets `{ type: 'cancelled' }`.

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
| 0 | Re-mesh or relight of a chunk already on screen — a stale seam is the most noticeable wait |
| 1 | First mesh — a new chunk appearing |
| 2 | Terrain generation — slowest, can wait behind mesh work |

### Callbacks (wired in `world.js`)

```js
chunkManager.onMeshReady   = (cx, cz, geo, light) => { /* build meshes */ }
chunkManager.onLightReady  = (cx, cz, light)      => { /* new light texture */ }
chunkManager.onChunkUnload = (key)                => { /* dispose meshes */ }
```

### Re-mesh on Neighbour Load

A chunk's faces at its seams and its sky light depend on its neighbours, so
when a chunk arrives its eight neighbours need updating: a full re-mesh for the
face neighbours (and, in smooth worlds, the diagonals too), a light-only job for
blocky diagonals, whose geometry is unaffected.

These go through **`_schedule`**, which holds a chunk (in `_gated`) while any
neighbour that is due to load — inside the render distance — has not been
generated yet. Its job would only have to be redone when that neighbour
arrives. A held chunk is re-examined when a neighbour arrives or when the
residency set changes, so it cannot be stranded; neighbours outside the render
distance are not waited for, so edge chunks still appear. Without this a chunk
was meshed once when it arrived and again for every neighbour arriving after
it: on average 4.4 times while an area loaded in smooth worlds, and up to 8.
Now it is once. `test/chunkmanager.test.mjs` measures this and checks that
every chunk ends up meshed however the player moves.

Block edits (`markDirty` / `markEdited`) bypass the hold and mesh at once.

There is **one geometry group per chunk** (all six face directions): one opaque
and one transparent mesh, so at most two draw calls. There used to be a ±Y
group and a ±X/±Z group, so a horizontal neighbour could replace just the
sides; with neighbour work coalesced the partial re-mesh was rare, and it cost
a whole extra draw call on every chunk (render distance 8: 435 → 247 draw
calls in smooth worlds, 516 → 344 in blocky).

### Generation requests

Each generation request carries a token (`_pendingGen`: key → token), and its
result is only used if the token is still current. The unload sweep also drops
pending requests that left the render distance — they are not in
`world.chunks` yet, so the chunk sweep never saw them. A job still in the pool
queue is then skipped entirely (lazy payload), and one already running is
discarded on arrival. Previously a cancellation set missed both cases: chunks
left behind while generating were installed out of range anyway, then meshed
and uploaded for nothing.

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
{ type: 'init', seed: number, blockRegistry: object[], biomes: object[], blockFaceMap: object,
  terrainStyle: 'blocky' | 'smooth' }
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
{ type: 'chunkGenerated', taskId, cx, cz,
  palette: Uint16Array, indices: Uint8Array /* CHUNK_VOLUME */, minY, maxY }
// both buffers are transferred; the main thread adopts them as-is
```

### `meshChunk`

Chunk voxels cross the boundary **palette-compressed**, not expanded, and only
over each chunk's filled band (see *Chunk Data*). The copies are transferred
rather than structure-cloned, and the palette expansion happens on the worker
instead of blocking the frame. `ChunkData.snapshot()` produces these;
`worldWorker` expands them into reusable scratch buffers, expanding only the
band and clearing just the rows a previous job left outside it.

**Main → Worker:**
```js
{
    type: 'meshChunk', taskId, cx, cz,
    chunk: { palette: Uint16Array, indices: Uint8Array, minY, maxY },
    neighbors: { "1,0": <same shape>, ... },   // four horizontal keys only:
                                               // "1,0" "-1,0" "0,1" "0,-1"
    diagonals: { "1,1": <same shape>, ... },   // the four diagonal chunks, for sky light
    corners: { "1,1": Uint16Array, ... },      // smooth worlds only: the diagonal
                                               // chunks' SMOOTH_REACH² corner columns
}
// every palette + indices buffer is transferred
```
**Worker → Main:**
```js
{ type: 'chunkMeshed', taskId, cx, cz, geo, light }
// light: { data: Uint8Array, y0, h } — see Lighting; data.buffer is transferred

// geo holds all six face directions:
{
    positions, colors, uvs, layers, indices,                      // opaque mesh
    transparentPositions, transparentColors, transparentUVs,      // transparent mesh
    transparentLayers, transparentIndices,
    yMin, yMax,        // local-Y extent, used for the mesh bounding sphere
}
// all geometry ArrayBuffers are transferred
```

There is **no `normals` attribute** — the chunk shaders bake directional
brightness into vertex colour and take the normal from screen-space
derivatives where they need one, so emitting it would be 12 bytes per vertex of
waste.

### `lightChunk`
Sky light only, for a chunk whose geometry is current but whose light changed
(an edit or a load up to 15 blocks away in a neighbour).
```js
{ type: 'lightChunk', taskId, cx, cz, chunk, neighbors, diagonals }   // Main → Worker
{ type: 'chunkLit', taskId, cx, cz, light }                           // Worker → Main
```

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

When generating any chunk, the placer scans all cells within `MAX_STRUCTURE_RADIUS = 12` blocks. For each cell with a structure, it applies any blocks that fall within the current chunk's bounds. Every chunk independently reconstructs the same structure decisions (deterministic, no inter-chunk state).

**Known gap: structures are clipped at chunk borders.** A structure is only
placed if its origin column is inside the chunk being generated, because the
spawn frequency is read from that column's biome blend, which exists only for
the chunk's own columns. So the part of a tree that overhangs into a
neighbouring chunk is never generated there. Fixing it means computing the
origin's blend and height outside the chunk (`_estimateHeight` is a start),
and it changes newly generated terrain next to saved chunks. The placer bails
out early for outside origins, since that estimate used to be computed and
then thrown away for every one of them.

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

- **No allocation in the mask-fill loop or per quad.** Array destructuring
  (`const [x,y,z] = coord`) allocates an iterator and was previously costing
  ~1.1M allocations per mesh.
- **Voxels are addressed by flat index with per-axis strides** (`STRIDE`), not
  through coordinate arrays. Within one slice every voxel's neighbour in the
  face direction is in the same array at the same index offset — this chunk,
  or one neighbour chunk for the boundary slice — so that is resolved once per
  slice and the inner loop is a plain read. A slice whose neighbour is outside
  the world or an unloaded chunk (`SOLID_SENTINEL`) can emit nothing and is
  skipped.
- **The fill walks memory in order** (the smaller-stride axis innermost) and
  writes every in-range mask cell, so masks never need clearing.
- **Merged cells are zeroed in the mask itself**, so there is no separate
  `done` table, and a slice with an empty mask (most transparent ones) is not
  merged at all.
- **Solidity comes from `this._solid`**, a `Uint8Array(65536)` lookup, not a
  registry call. It is sized across the full id space so the lookup stays
  branch-free even for the `SOLID_SENTINEL` value.
- **Output goes into growable typed arrays** (`F32Buf` / `U32Buf`), kept by the
  mesher across jobs so they stop growing after the first few chunks; quads are
  written into `reserve()`d space. `trim()` copies the result out for transfer.

Measured against the previous version in one process on the same 81 chunks of
real terrain (identical output): blocky 4.13 → 2.07 ms per chunk, smooth
12.0 → 9.7 ms (the rest of smooth is the smooth-shape pass).

`test/mesher.test.mjs` checks the output against a brute-force per-face
reference (emitted area must match exactly, indices must be in range) across
flat, solid, transparent, neighbour-culled and checkerboard cases. Run it with
`npm test` after touching this file. `npm run bench:pipeline` prints a hash of
every stage's output, so an optimisation can be checked for changing nothing
but speed.

### Two Output Meshes

| Mesh | Material | Blocks |
|---|---|---|
| Opaque | `ShaderMaterial` (GLSL3) — texture array + baked brightness + fog | All non-transparent blocks |
| Transparent | Same shader, `transparent`, `depthWrite: false`, `DoubleSide`, alpha 0.72 | Water, leaves, ice, glass |

The transparent material **must stay `DoubleSide`**: the mesher emits only the
outward-facing shell of a transparent volume, so culling backfaces makes the
water surface disappear when the camera is underneath it.

### Face brightness

Baked into vertex colour from the sun's direction — `sunBrightness(normal)` in
`engine/Sun.js`, see *Lighting*. With the shipped sun: top 1.00, +Z 0.77,
+X 0.70, and −X / −Z / bottom 0.54 (faces turned away from the sun get the
ambient part only).
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
`chunkUniforms` object, so one write updates all terrain. Each chunk has its own
material pair (for its light texture, below), built with `{ ...chunkUniforms,
uLight… }` — the spread copies references to the same uniform objects, so the
one-write rule still holds. Never `material.clone()` them: that deep-copies the
uniforms and cuts the chunk off from fog, brightness and shadow updates.

### Lighting

The sky and one moving light — the sun by day, the moon by night (see *Day
Cycle and Weather*). A surface's brightness is

```
texture × skyLight × (A·ambient + (1−A)·max(0, n·L)·lit·direct) / baked
```

- **`baked`** is `sunBrightness(n)` (`engine/Sun.js`), which the meshers still
  bake per vertex for the *fixed* `SUN_DIR`:
  `(SUN_AMBIENT + (1 − SUN_AMBIENT)·max(0, n·SUN_DIR))`. The chunk shader
  (`lighting()` in `world.js`) divides it back out using the derivative normal
  and relights for the real light direction `L` (`uSunDir`). `A` is
  `SUN_AMBIENT` (0.5), the sky's share — what a face turned away from the
  light, or in shadow, keeps. At noon under a clear sky the result matches the
  old baked shading; on smooth terrain the ratio varies slightly per triangle,
  which is invisible at noon and subtle elsewhere.
- **`ambient` / `direct`** (`uAmbient`, `uDirect`) come from `DayCycle`
  (time of day) and the weather (storms dim, dust and ash tint).
- **`lit`** = shadow map × **cloud shadow** (`cloudShade()`: the cloud field
  sampled where the light ray crosses the cloud base, so shadows drift under
  the visible clouds).
- Lightning adds `uFlash` on open ground; `weatherSurface()` darkens wet ground
  and glazes it in freezing rain (open sky only — `gExposed`).
- **Sky light** (`workers/Skylight.js`, Minecraft rules, levels 0–15): full
  strength straight down each column to the first opaque block (transparent
  blocks let it through), then a breadth-first spread through non-opaque cells,
  one level per block. Brightness is `max(SKY_FALLOFF^(15 − level), SKY_MIN)`
  (0.8, 0.05), so a sealed cave is nearly black and a cave mouth fades out over
  about a dozen blocks.
  - Solved in the worker on every mesh job and on `lightChunk` jobs, over the
    chunk plus a 15-block margin read from all **eight** neighbours (hence
    `diagonals`). That margin makes neighbouring chunks agree exactly on shared
    cells — `test/light.test.mjs` checks it. About 0.3 ms per chunk.
  - **The solve stops at a floor.** Below its column top a cell is lit only by
    the spread, which starts at level 14 from cells above the lowest column top
    in the region (`minTop`) and loses a level per block, so nothing below
    `minTop − 13` can be lit. The region is filled, spread through and output
    only down to `minTop − 16`; below that the output keeps its zeros. The
    bedrock floor puts every chunk's `minFilledY` at 0, so without this each job
    scanned ~250 levels of solid rock across 46×46 columns — 80% of its time.
    Output is byte-identical (checked on generated terrain and on random worlds
    full of caves and overhangs); 1.2 → 0.3 ms per chunk.
  - Output is the chunk plus a one-block border over its filled Y band, stored
    ×17 so it uploads as a normalised R8 `Data3DTexture` with linear filtering.
    Opaque cells hold their brightest open neighbour, so interpolation never pulls
    a surface toward black and smooth slopes (which cut through opaque cells) get
    the light of the air above.
  - The shader samples it half a block in front of the surface along the
    derivative normal (flipped toward the camera, so double-sided water and
    leaves read the viewer's side; guarded against the degenerate normal at some
    triangle edges, which otherwise reads NaN light as bright sparkles).
  - `ChunkManager` numbers light jobs per chunk and drops a result older than the
    one shown (`_freshLight`). An edit relights all eight neighbours — at 15
    blocks' reach and 16-wide chunks, every edit reaches them.
- **Shadow** (Graphics → Shadows): `sunShadow()` returns the lit fraction; in
  full shadow only the ambient part is left. The pass is skipped when there is
  no direct light (deep twilight).
- **Sky and fog colour** follow the sky light at the camera (Atmosphere,
  `_skyLit`), eased over ~0.5 s. Underground a sky-blue background would show
  through sub-pixel gaps between triangles and fog distant tunnels to blue.
- **Mobs and debris** are drawn with Lambert materials, so they read the light
  on the CPU (`_skyBrightnessAt` × `Atmosphere.mobLight`) and scale their
  colour; each mob has its own material copies for this. Dropped item sprites
  are not dimmed yet.
### Graphics presets (Settings → Video → Graphics)

`GRAPHICS_PRESETS` in `main.js` sets every graphics-quality option at once:

| Preset | Render dist. | Resolution | Fog | Shadows | Clouds | Sky | Particles | Max FPS |
|---|---|---|---|---|---|---|---|---|
| Simple | 5 | 75% | 65% | off | fast | simple | low | 60 |
| Classic (default, the original) | 8 | 100% | 75% | off | fast | simple | medium | unlimited |
| Normal | 10 | 100% | 80% | medium | fast | pretty | medium | unlimited |
| Pro | 14 | 100% | 88% | high | fancy | pretty | high | unlimited |
| Custom | whatever the player sets | | | | | | | |

`GRAPHICS_CONTROLS` maps each value to its form control and type; adding an
option is a row there plus its markup in `game.html`. Moving any of those
controls switches the dropdown to Custom (seeded from what was showing); picking
a preset moves the controls. A saved Custom set is merged over Classic, so
options added later start at Classic's value. `main.js` resolves the choice and
sends the values in `applySettings`; all apply live.

- **Fog distance** is `_fogStart`, the clear fraction of the render distance.
- **Max frame rate** (`_maxFps`, 0 = unlimited) is enforced in `gameLoop` by
  skipping display refreshes; dt is measured from the last frame actually run.
  The 2 ms tolerance stops a 60 cap on a 60 Hz display dropping every other frame.
- **Shadows** (`src/scripts/Shadows.js`) — a shadow map for the current light
  (sun or moon, `setLightDir`). `ShadowMapper` renders render layer
  `SHADOW_LAYER` (1) from an orthographic camera centred on the player (snapped
  to whole shadow texels so edges don't shimmer), using an override depth
  material that alpha-tests leaves and skips water and ice. The light is
  re-aimed in ~0.35° steps, not every frame — continuous re-aiming makes every
  shadow edge shimmer — and never below y 0.12. Chunk meshes and mobs enable
  layer 1. The chunk shaders call `sunShadow()` (`SHADOW_GLSL`): normal offset,
  3×3 PCF on medium/high, fade toward the map edge. Its uniforms are spread into
  `chunkUniforms`. Levels (`SHADOW_LEVELS`) set map size and covered radius;
  off skips the pass entirely.
- **Clouds** (`src/scripts/Clouds.js`) — `fast` | `fancy`, no off (the weather
  decides the cloud; Fully Clear is the cloudless sky). See *Day Cycle and
  Weather*.
- **Sky** (`src/scripts/Sky.js`) — `simple` | `pretty`. See *Day Cycle and
  Weather*.
- **Particles** (`src/scripts/Particles.js`) — one fixed `InstancedMesh` pool
  (a single draw call, no allocation per burst) for debris when a block breaks:
  8 pieces at high, 5 medium, 3 low, lit by the sky light there and blown by
  the wind. `particles.scale` (0 off … 1 high) is also the density of weather
  particles (Precipitation.js); off means no rain/snow particles, though fog,
  sound and wet ground remain.
- **Weather Volume** (Settings → Audio) and **Reduce Motion** (which also damps
  lightning flashes — rapid flicker is a photosensitivity trigger) are sent in
  `applySettings` too.

---

## Day Cycle and Weather

`Atmosphere.js` runs both each frame from `_render()` and writes one shared set
of uniforms (`makeAtmosUniforms()` in `AtmosGLSL.js`) that the chunk, sky,
cloud and particle materials all spread in — one write reaches everything.
All colours are raw display values: the chunk shaders write without colour-
space conversion, so sky, fog and terrain must agree in that space
(`scene.background`/`scene.fog` are set with `SRGBColorSpace` for that reason).

### Day cycle (`engine/DayCycle.js`)

- `DAY_LENGTH` 1200 s (20 min). `time` is a fraction of a day, `day` counts
  days for the moon (`MOON_CYCLE` 8, full on day 0). Sunrise at 6:00 in the
  east (+X), sunset at 18:00; the path leans `SUN_TILT` toward +Z so noon sits
  near `SUN_DIR`.
- `sample()` fills a reused state: sun/moon/light directions, palette keyframes
  interpolated on the sun's height (zenith, horizon, flat, ambient, sun colour),
  glow, stars. Direct light switches from sun to moon where both are zero, so
  the handover is invisible (`test/weather.test.mjs` checks it).
- The clock stops while the pause menu is up (`tick` carries `paused`) and when
  the world's Daylight Cycle is off.

### Weather (`engine/Weather.js`, `Climate.js`, `CloudField.js`)

- 26 types, each a vector of targets (`cover`, `dark`, `precip` + `form`,
  `rainBase`, `wind`, `gust`, ground `fog` visibility + `fogScale`, `haze`
  visibility, `lightning`/min, `dust`, `ash`). The live vector `P` eases toward
  the current type's, so weather rolls in; a manual change eases faster.
- **Dynamic** mode walks a Markov chain (`NEXT`) of generic types with
  realistic durations; fog is 3× likelier at dawn and burns off at midday,
  convective storms prefer the afternoon. Supercells spawn a tornado 22% of the
  time. The generic type is **localised** by the climate at the player
  (`Climate.at`: blended biome temperature/humidity, −0.0022 per block above
  y 90): below `COLD_TEMP` rain becomes snow, below `MARGINAL_TEMP` sleet or
  freezing rain, and where a biome's `weather.precipitation` is below
  `DRY_PRECIP` rain becomes dry cloud and wind becomes dust.
- **Fixed** mode holds one type exactly, no localisation.
- Biome JSON may add `"weather": { "precipitation": 0.12, "dusty": 1 }` —
  precipitation multiplier plus extra chain weights. Ash only happens where a
  biome declares `"ashy"`; no shipped biome does.
- **One cloud field.** `CloudField` is a tiling noise texture plus wind offsets
  and a coverage threshold (from a quantile table, so `cover` 0.4 really is 40%
  of the sky). `CLOUD_GLSL` in `AtmosGLSL.js` reads the same texture; the CPU
  twin places lightning and measures rain on the player. Rain falls where
  `rainMask` says: open sky and thin cloud stay dry unless `rainBase` > 0
  (heavy rain), thicker cloud rains harder. **Keep the GLSL and CPU versions
  identical**, and remember the CPU field only reaches the GPU through the
  uniforms written in `Atmosphere.update` — that copy being missing once left
  every cloud and raindrop invisible; the smoke test now asserts `gpuClouds`.

### What draws it

| Module | Draw calls | Notes |
|---|---|---|
| `Sky` | 1 | Camera sphere, no depth. Simple: flat colour, square sun/moon/stars. Pretty: gradient, glow toward the sun, halo, sphere-lit moon with the real phase terminator, twinkling stars rotating with the sky. Horizon is always `fogColorFor(dir)`, so terrain never seams against the sky. |
| `Clouds` | 0–1 | Camera-following plane at the base (or top, from above). Fast: thickness-shaded soft layer. Fancy: 14-step ray march through `CLOUD_BASE`–`CLOUD_TOP`. Hidden when the sky is clear. |
| `Precipitation` | 0–6 | Instanced quads positioned entirely in the vertex shader from fixed seeds + wrapped fall/drift offsets. A particle shows when its rank is below the rain intensity at its column. `RainHeightmap` (highest block per column around the player, 9×9 chunks, ≤2 chunks computed per frame, dropped on re-mesh) hides particles under roofs, trees and in caves and seats splashes. |
| `Lightning` | 0–1 | Midpoint-displaced channel + branches, 1–4 return strokes. Pool of 3 bolts. Flashes light sky, clouds and open ground. |
| `Tornado` | 0–2 | Rope-bending funnel + orbiting debris. Pulls and lifts the player within 45 blocks. |

**Fog** is the thicker of the render-distance fog (linear, hides the load edge)
and `weatherFog()`: uniform haze (rain, snow, dust) plus exponential ground
fog thinning with height from y 62, so mist settles in valleys. Clouds only
count 70 blocks of haze so dark cloud stays visible overhead in rain.

**Gameplay:** freezing rain makes open ground slippery (`PlayerPhysics.slip`),
gales lean on an exposed player and tornadoes pull (`PlayerPhysics.external`),
lightning hurts within 4 blocks. Leaves sway with the wind in `CHUNK_VERT`
(position-only displacement, so merged quads never crack).

**Audio** (`WeatherAudio`) is synthesised filtered noise — no files. It waits
for user activation, updates at 10 Hz, muffles under a roof, and thunder
arrives `distance / 343` seconds after the flash.

### Persistence and settings

- Clock, weather state and cloud offsets are saved in the player state
  (`atmosphere` key of `player-state.json`).
- **World Settings → Daylight Cycle / Weather** (`daylightCycle`, `weather`
  in `world.json`; `weather` is `'dynamic'` or a type id), plus a one-shot
  **Time of Day** in the in-game World tab. Applied live via
  `callWorldJS("setAtmosphere", { daylightCycle, weather, hours })`.
- `window.__wwDebug().atmosphere` reports time, weather, cover, wind, active
  particle layers and `gpuClouds`; `window.__wwAtmos()` returns the Atmosphere.

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
| `npm test` | Mesher correctness, smooth-terrain invariants, sky-light rules and seams, day cycle and weather (coverage, rain only under cloud, climate localisation, lightning placement), worker replies vs. the mesher and solver, chunk scheduling (every chunk meshed, once, however the player moves), chunk-persistence round-trip, semver precedence, and the update status bridge. Fast, no browser. |
| `npm run bench:load` | Saves 225 chunks of real terrain, then times a cold re-open against generating them fresh. |
| `npm run bench:pipeline [radius] [seed]` | Times each worker stage (generate, compress, mesh blocky/smooth, light) on real terrain and prints a hash of each stage's output — compare hashes before and after an optimisation to prove it changed nothing else. |
| `npm run test:smoke` | Boots the server, drives the real game in headless Edge/Chrome into a smooth world (the default) and then one switched to blocky, and fails on any console error, page exception, failed request, or a world loading in the wrong terrain style. Also drives the update banner through its states. Set `BROWSER=<path>` to pick the browser, and `SMOKE_SHOTS=<dir>` to save a screenshot of each world. |

`test/smooth.test.mjs` checks the smooth-terrain rules directly: every smooth
triangle stays inside one voxel and faces out of the solid; the surface is closed
across chunk seams and corners (ray parity, with rays aimed at the shared
corner); the collider's surface equals the rendered one; Mesh/Solid interaction;
the smoothing itself (straight staircases, tangential ramp feet, continuous
ridges, domes, dropped inside corners, matching normals at seams); thin
features joining up (a ring with no middle, a plus, an L, a T, an arm attached
to wider ground), with the full bounds/closed/winding/collision battery run on
a scene of them including one across a chunk corner; and a
scripted walk up and down a hill.

The smoke test also cycles ten time-of-day/weather scenes (both skies, both
cloud levels, rain, snow, hail, fog, dust, a tornado) and fails if one does not
take effect or its clouds are missing on the GPU.

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
| Lighting | Moving sun/moon, propagated sky light, weather tint | Block light (torches), dim dropped-item sprites |
| Weather | Visual + audio + light gameplay (ice, wind, lightning, tornado pull) | Snow accumulating on the ground, lightning fires, tornado block damage |
| Water | Incremental BFS spread (`WaterSimulator`) | Proper fluid levels / pressure |
| Structures | Hardcoded builders | GamePack-defined structure blueprints |
| Biome transitions | Smooth blend | River / beach edge generation |
| Multiplayer | Architecture ready | Server/peer connection layer |
| Mipmaps | Off — `NearestFilter`, no mips | Needs `textureGrad` with derivatives from the untiled UV; naive mips bleed at tile seams because `fract(uv)` has a discontinuous derivative |
| Draw calls | ~250 (smooth) / ~345 (blocky) at render distance 8 — one opaque + one transparent mesh per chunk | Merge chunks into regions, or `BatchedMesh` |
| Smooth meshing | ~75% of a smooth mesh job is the smooth-shape pass (`describeVoxel` runs twice per deformed voxel, once in `prepare` and again at emit) | Keep the shapes from `prepare`; inline `SmoothField.get` for in-chunk reads |
| Chunk transfer | Palette snapshot, copied per job | `SharedArrayBuffer` voxel store (needs COOP/COEP headers on the server) |
| Code signing | Unsigned — SmartScreen warns | OV/EV certificate or Azure Trusted Signing |
