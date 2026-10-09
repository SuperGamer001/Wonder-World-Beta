# Wonder World V7 — Engine Documentation

## Project Overview

Minecraft-inspired voxel sandbox game built with JavaScript ES modules, Three.js (v0.184), and Web Workers. Runs in a browser iframe (`index.html` → `game.html`; `index.js` adds a frame beside it for each further player of a split screen). No build step — served via HTTP.

---

## File Structure

```
src/
  main.js                        Game state, UI, event bus, game loop
  players.js                     Names (and the keypad a controller types them on), the Players panel, joining (see *Playing together*)
  gamepad.js                     Controller support: play and every menu (see *Controller*)
  css/game.css                   The look of every menu and the HUD (see *User Interface*)
  scripts/
    world.js                     Three.js render layer + first-person controls
    Atmosphere.js                Day cycle + weather → sky, clouds, rain, light, sound
    AtmosGLSL.js                 Uniforms + GLSL shared by terrain, sky, clouds, rain
    Sky.js                       Sky dome, sun, moon, stars (simple / pretty)
    Clouds.js                    The cloud layer: one picture a frame, shared by sky and terrain (fast / fancy)
    Precipitation.js             Rain, snow, sleet, hail, splashes, dust, ash
    Lightning.js                 Bolts and flashes
    Tornado.js                   Funnel + debris
    WeatherAudio.js              Rain and wind, made as they fall; thunder from files
    Sound.js                     The one mixer: sound files by name, loops, the music (see *Sound*)
    GameSounds.js                When the world makes which sound: footsteps, mining, ambience
    PlayerModel.js               A player's body: the Quiddle in their look, moved by what they do
    Players.js                   The other players, as this game draws them
    Character.js                 The figure on the Character screen (its own small renderer)
    MenuScene.js                 The place behind the menus: draws the baked model (its own small renderer)
    Shadows.js / Particles.js    Sun shadow map / block-break debris
    MobModels.js                 Draws the mob models: one mesh per mob, skinned on the CPU
    PostFX.js                    Eye Adaptation: auto-exposure + bloom (post-processing)
    FarTerrain.js                Far Terrain: low-detail land, trees and buildings beyond the render distance
    engine/                      Main-thread engine modules (no Three.js dependency)
      BlockRegistry.js           Block type definitions loaded from GamePack
      BlockTextures.js           Which texture file is which layer of the block texture array (shared)
      ItemRegistry.js            Item definitions loaded from GamePack
      ChunkData.js               16×448×16 column storage (palette-compressed, filled rows only)
      MeshFormat.js              How chunk-mesh vertices are packed (meshers + shaders, shared)
      Visibility.js              Which parts of the loaded chunks the camera could see at all (shared)
      WorldState.js              Authoritative chunk map and block get/set
      WorkerPool.js              Auto-sized worker pool with job queue
      ChunkManager.js            Chunk load/unload lifecycle and priority scheduling
      WorldClient.js             WebSocket chunk persistence client
      Multiplayer.js             This game's line to the others in the same world (see *Playing together*)
      PlayerPhysics.js           AABB collision, gravity, jump, fall damage
      Inventory.js               Slots, hotbar, equipment, quiver
      CraftingSystem.js          Recipe matching
      EntityManager.js           Mob spawning and upkeep, dropped items
      FlatWorld.js               What a Flat world is made of: its settings, checked (shared)
      MobShapes.js               What a mob model is built from: bones, lofts, boxes, texel layout
      MobModelDefs.js            The mob models themselves: their bones and shapes (no Three.js)
      MobAnim.js                 How they move: poses, gaits, legs placed on the ground, animators
      MobNav.js                  Where a mob can stand, and A* paths between places
      MobAI.js                   What a mob decides to do, and how its body moves
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
      noise.js                   Seeded simplex noise (Simplex class per field), FBM, ridged, PRNG
      Geography.js               The shape of the land: continents, mountains, rivers, lakes, climate
      Biomes.js                  Biome definitions, per-column biome choice, block-name fallbacks
      TerrainGenerator.js        Voxels from the geography: rock, soil, water, caves, blobs, ores
      Caves.js                   Tunnels, noodles, caverns, underground valleys, shafts, ravines
      StructurePlacer.js         Cross-chunk structures (trees, plants, boulders, houses)
      legacy/                    The generator worlds made before `worldGen` 2 keep using (frozen)
      GreedyMesher.js            Greedy meshing algorithm
      BlockModels.js             Small shapes: torches, wall torches, lanterns
      SmoothMesher.js            Smooth-terrain pass for deformed Mesh blocks
      Skylight.js                Sky-light propagation for one chunk (+ its neighbours)
      Blocklight.js              Block light (torches, lanterns, lamps), same rules and layout
      FarTiles.js                Far-terrain tiles: the geography as a heightfield, with its trees, buildings and the player's edits
data/
  gamepack.json                  Legacy fallback GamePack (blocks + biomes in one file)
  blocks/ items/ biomes/         Live definitions, one JSON per entry, discovered
  entities/ recipes/ terrain/    via GET /api/data/manifest (terrain/: geology.json)
  textures/                      Block, item, UI and mob (entities/) textures
  sounds/                        blocks/ entities/ ambiant/ ui/ (made by tools/gen_sounds.mjs) and music/
  menu/scene.glb                 The place behind the menus, baked (tools/gen_menu_scene.mjs)
tools/
  gen_block_textures.py          Paints every block texture, 32 × 32, tiling (Pillow + numpy)
  gen_mob_textures.mjs           Paints the mob textures from the model definitions
  gen_sounds.mjs                 Makes the sounds in data/sounds/ (see *Sound*)
  gen_menu_scene.mjs             Bakes the place behind the menus into one glTF model (see *The place behind the menus*)
gamepacks/                       Optional add-on packs (HD, Minecraft, Pre-Release)
server/
  server.js                      Express static host + REST API + WebSocket chunk I/O; the listener for guests
  multiplayer.js                 Sessions: who is in which world, and what they are told
electron/
  main.js                        Desktop launcher (boots the server, opens the window)
test/
  chunkdata.test.mjs             Chunk storage vs a plain array: edits, snapshots, the save format
  mesher.test.mjs                Greedy-mesher correctness vs a brute-force reference
  smooth.test.mjs                Smooth-terrain bounds, watertightness, collision, walking
  light.test.mjs                 Sky-light rules and seam agreement between chunks
  visibility.test.mjs            What is left out of the draw: no line of sight through real terrain ends on it
  physics.test.mjs               Long frames: a fall or a flight ends where it should at 10 to 144 frames a second
  weather.test.mjs               Day cycle, cloud coverage/rain placement, weather chain, climate
  worker.test.mjs                worldWorker replies vs. the mesher/solver on fresh arrays
  terrain.test.mjs               World generation: legacy hash, determinism, seams, water, balance
  chunkmanager.test.mjs          Chunk scheduling through WorkerPool with fake workers
  mobai.test.mjs                 Mob paths and behaviour in hand-made worlds; model geometry and gaits
  multiplayer.test.mjs           Sessions, each player's own state, and what a guest from the network may reach
  mobshots.mjs                   Screenshots of the mob models on a stage (mob_viewer.html)
  pipelinebench.mjs              Stage timings + output hashes for the worker pipeline
  renderbench.mjs                Frame times of the real game on the real GPU, per preset
  smoke.mjs                      Headless end-to-end run of the real game
  worldmap.mjs                   Top-down map or vertical section of a seed's world (PNG)
  terrainshots.mjs               Screenshots of landscapes on a seed, in the real game
```

---

## Architecture

### Layer Separation

The engine is split into four layers that have no upward dependencies:

| Layer | Files | Depends On |
|---|---|---|
| World State | `WorldState`, `ChunkData` | Nothing (no Three.js, no workers) |
| Engine | `BlockRegistry`, `WorkerPool`, `ChunkManager` | World State |
| Workers | `Geography`, `Biomes`, `TerrainGenerator`, `Caves`, `StructurePlacer`, `GreedyMesher`, `noise` | Engine data types only |
| Render | `world.js` | Everything above via callbacks |

This separation means world state is fully independent of rendering — a prerequisite for future multiplayer support.

### Event Bus (main.js → world.js)

`main.js` communicates with `world.js` through custom DOM events:

```js
callWorldJS("startWorldLoad", { gamepackData })   // begin generation
callWorldJS("tick", { dt })                        // every animation frame
callWorldJS("quitWorld")                           // cleanup
```

A load can be overtaken — a world quit, or another started, while one is still
waiting on the server or the workers — so `startWorldLoad` takes a token
(`_loadToken`) and looks, after every wait, whether it is still the load that
is wanted.

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
| Default render distance | 8 chunks | Adjustable on `ChunkManager`; UI range 2–16. The loaded area is the square of chunks within that many of the player's chunk on both axes, (2rd+1)² |
| `WORLD_GEN` | 2 | World generator version stamped into new worlds (see *World Generation*) |

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

Light sources and small shapes (all optional, `BlockRegistry.makeDef`):

| Field | Meaning |
|---|---|
| `light` | Block light given off, 0–15 on the sky-light scale (`workers/Blocklight.js`) |
| `glow` | 0–1: drawn full-bright, ignoring the light around it. Defaults to 1 when `light` > 0. With Eye Adaptation its bright texels also go past white and bloom |
| `model` | A small shape instead of a cube (`workers/BlockModels.js`): `torch`, `wall_torch`, `lantern`, `hanging_lantern`. Forces `transparent` — a model never fills its voxel |
| `facing` | For directional models: `east` / `west` / `south` / `north` (the way a wall torch leans) |
| `placement` | Which block goes down for the face clicked, by name: `{ floor, ceiling, east, west, south, north }`. A face with no entry refuses it. The torch item places `TORCH` on a floor and `WALL_TORCH_*` on a wall |
| `support` | `[dx, dy, dz]` of the block it rests or hangs on. Breaking that block breaks this one too, and drops it (`_breakUnsupported` in `world.js`) |
| `render` | How a see-through block is drawn: `"cutout"` (with the opaque blocks, each texel there or not, writing depth — leaves, glass) or `"translucent"` (blended over the scene — water, ice). Without it liquids are translucent, leaves and `GLASS` cutout (by flag or name), anything else translucent. See *Two Output Meshes* |
| `blend` | Natural ground only: how readily it spreads over the edge of the ground next to it in a smooth world, 1–255 (0 or absent: takes no part). Higher creeps onto lower — snow 90, grass 62, dirt 40, sand 30, stone 9, ores 4. See *Ground blending* |

Textures (optional; `BlockRegistry.resolveTextures`):

| Field | Meaning |
|---|---|
| `texture` | One file in `data/textures/blocks/` for every face |
| `textures` | `{ top, side, bottom }` — a missing face falls back to `top` |
| `leaves` | Sways in the wind like leaves (`uSwayLayer` / `uSwayRange` in `CHUNK_VERT`) |

At world load `_extendBlockTextures` (`world.js`) adds a texture-array layer for
every such file the built-in `BLOCK_TEX_LAYERS` / `BLOCK_FACE_MAP` do not already
cover (blocks 0–24 and 36–43 use the built-in map), with leaves' layers in one
run so the vertex shader can test a range. The tables and the rule are in
`engine/BlockTextures.js` (`blockTextureLayers`), which has no Three.js in it:
the tool that bakes the menu's scene numbers the layers the same way. The inventory icon of a textured
block is its texture.

**The textures** are 32 × 32 (`BLOCK_TEX_SIZE`; one of another size — the torch
and lantern sheets, a pack's 16-pixel art — is scaled to it, unsmoothed), and
all of them are painted by `tools/gen_block_textures.py` (`npm run blocktex`).
Each is drawn from tiling noise: it repeats without a seam and has **no frame
round its edge**, because on smooth terrain a block is no longer a cube and
the ground must not show where one ends and the next begins (the 16-pixel art
they replace had a bevel on every block, which drew a grid over every hill).
What gives a material its look is its grain — blades, pebbles, strata, bark,
crystals — and colours taken from the real thing. Large features are kept
faint, since whatever is in a texture comes round again every block; variation
on a larger scale is added in the chunk shader (`ground()`). Blocks people
build with (planks, bricks, the workstations) do line up with the block. The
tool is deterministic (a seed per texture name); `WW_TEX_OUT=<dir>` writes
somewhere else to look at a change first. Leaves are painted solid — lit leaves
over the shade between them — and glass is a thin frame and a few glints with
nothing between (alpha 0), which is all a cutout needs.

The array is sampled with repeat wrapping and **mipmaps** (nearest when
magnified, so texels stay crisp up close; trilinear and up to 4× anisotropic
when minified): the shaders hand it tile coordinates as they are. Wrapping the
coordinate by hand with `fract()`, as they used to, is what ruled mipmaps out —
it breaks the derivatives a mip level is chosen from at every block edge.

Items may add `heldLight` (the level of light around the player while it is in
the hotbar slot or offhand — torch 13, lantern 14) and `icon` (the image path
the inventory shows; it wins over the generated colour swatches).

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

20–35 are the interactables and crafted building blocks (`data/blocks/`), all
textured (25–35 by a `"texture"` in their JSON). Light sources:

| ID | Name | Light | Notes |
|---|---|---|---|
| 36 | TORCH | 14 | Standing; `placement` picks a wall variant for a wall |
| 37–40 | WALL_TORCH_EAST / WEST / SOUTH / NORTH | 14 | Lean away from the wall; drop `torch` |
| 41 | LANTERN | 15 | Standing; hung under a ceiling as 42 |
| 42 | HANGING_LANTERN | 15 | Drops `lantern` |
| 43 | LAMP | 15 | Full glowing cube (opaque, still lights around it) |

Torch recipes: coal (or charcoal) + stick → 4 torches, by hand. Charcoal: 2 logs
in the oven. Lantern: 2 iron ingots + a torch; lamp: 4 glass + 4 torches + an
iron ingot → 2 (crafting table).

Terrain, tree and mushroom blocks (world generation; all textured by JSON):

| ID | Name | ID | Name |
|---|---|---|---|
| 44 | ANDESITE | 58 | RED_TERRACOTTA |
| 45 | SLATE (the deep stone, below y ≈ 0) | 59 | PACKED_ICE |
| 46 | LIMESTONE | 60 | DRY_GRASS |
| 47 | COARSE_DIRT | 61 | MYCELIUM |
| 48 | PODZOL | 62 | SPRUCE_LOG |
| 49 | MUD | 63 | SPRUCE_LEAVES |
| 50 | MOSS | 64 | BIRCH_LOG |
| 51 | RED_SAND | 65 | BIRCH_LEAVES |
| 52 | RED_SANDSTONE | 66 | JUNGLE_LEAVES |
| 53 | TERRACOTTA | 67 | ACACIA_LEAVES |
| 54 | WHITE_TERRACOTTA | 68 | CACTUS |
| 55 | ORANGE_TERRACOTTA | 69 | MUSHROOM_STEM |
| 56 | YELLOW_TERRACOTTA | 70 | RED_MUSHROOM_BLOCK |
| 57 | BROWN_TERRACOTTA | 71 | BROWN_MUSHROOM_BLOCK |

The natural ground among them is `mesh`; logs, leaves, cactus and mushroom
blocks are `solid`. Spruce and birch logs drop `wood_log`; the stones, sands,
mud, moss, terracottas and cactus drop items of their own (`data/items/`).

IDs are also mirrored in `BLOCK_TYPES` in `src/main.js`.

### Adding a Block

1. Add `data/blocks/<id>_<name>.json` with the next available `id`.
2. Add the name to `BLOCK_TYPES` in `src/main.js`.
3. Reference it by name in biome surfaces, geology or structures. Add a stand-in
   to `FALLBACK` in `workers/Biomes.js` if generation uses it, for packs that
   lack it.
4. Give it a `terrainType`: `"mesh"` for natural ground, `"solid"` for anything
   built, see-through or interactive.
5. Give it a texture: `"texture"` / `"textures"` in its JSON (above), painted
   by a recipe added to `tools/gen_block_textures.py`. A model uses one layer
   as a sheet and picks rectangles of it per face (`BlockModels.js`).
6. Natural ground: give it a `blend`. See-through: say how it is drawn with
   `render` unless the default is right.

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
| `mesh` | GRASS, DIRT, STONE, SAND, GRAVEL, the three ores, SNOW, SANDSTONE, CLAY, SNOW_DIRT, GRANITE, DIORITE; ANDESITE, SLATE, LIMESTONE, COARSE_DIRT, PODZOL, MUD, MOSS, RED_SAND, RED_SANDSTONE, the terracottas, PACKED_ICE, DRY_GRASS, MYCELIUM |
| `solid` | AIR, WATER, LEAVES and the other leaves, ICE, GLASS (see-through/liquid); WOOD and the other logs, CACTUS, the mushroom blocks, BEDROCK; the interactables; all crafted building blocks; torches, lanterns and the lamp |

Structures built from Mesh blocks (the house's stone frame) are smoothed too.

### Shape model (`engine/SmoothShape.js`)

A deformed Mesh voxel is its unit cube cut from above by a smooth **top
surface** and from below by a smooth **bottom surface**, both heightfields over
the footprint. Each surface is pinned at
the four vertical edges (corner heights), joined along each side by an **edge
curve** (a monotone Hermite cubic), and filled in by a smoothstep-blended
**Coons patch**. Three properties hold everything together; keep them:

1. **Nothing leaves the ground.** Corner heights are at most 1, edge curves
   are monotone (Fritsch–Carlson slope limits) so they never overshoot their
   ends, and interior samples are clamped. A top surface never rises into the
   air over its voxel; on a diagonal slope (below) it may dip under its own
   voxel, by at most a block, into Mesh ground it stands on.
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

- a Solid block among them, with another block beside it (of either kind) →
  edge is full (`t=1, b=0`), so terrain meets a cube flush and a placed Solid
  block reads as part of the terrain. A Solid block that only touches the
  ground corner to corner, with nothing beside it, does not count: ground
  reached up across the diagonal to the block's corner in a spike
- any of them has a block directly above → `t = 1`; directly below → `b = 0`
- all four filled → `t = 1, b = 0` (flat interior)
- otherwise the corner drops (`t = 0`) — **including inside corners**, which is
  what keeps diagonal terrace edges from becoming a sawtooth
- `b > t` (thin floating sheet) → both meet at 0.5

"Filled" means non-air and non-liquid, so the sea floor smooths like dry land.

**Diagonal steps.** Those heights alone pin every corner along a step line to
a whole level. On a slope running diagonally the step lines are zigzags, so it
came out as a row of dimples — each block a cube with a corner cut off and a
triangle of wall beside it — and a lone block on its peak as a spike. Two
cases are therefore one *sheet* across the levels, a corner on it shared by
the voxels of all of them (`SmoothField.top`, `at`, `delta`, `_join2`):

- The sheet at a lattice point has a **base level**: all four voxels round the
  point are Mesh there, at least one is open above, and no Solid block stands
  on any of them (`AT_SHEET`). A floor with a Solid block in it counts as a
  base too, for the first case (`_floor`), so a hill on a built floor has no
  teeth round its foot.
- **One block up per block, on the diagonal** (columns stepping 0, 1, 1, 2
  round the point). The highest column comes down to the lowest there: its
  corner is at −1, a whole block below its own voxel, in the ground it stands
  on. All four meet in one point and the slope is a plane. Only when the high
  ground is diagonal to the low; right beside it, it stays a wall. And never
  through a Solid block: where one is buried in the slope the ground over it
  stays up, and the block's corner stands out of the hill (it was hidden
  inside the slope, and still stopped the player).
- **Steps two blocks wide on the diagonal.** The tip of each tooth of the
  zigzag is lowered by half a block (`delta`): ½ from the base level, −½ from
  the level above — one height, so both draw the same edge. `delta` is looked
  for along the four lattice lines through the point (x, z, both diagonals,
  `SMOOTH_SPREAD` 2 steps each way): a drop one step one way and higher ground
  two steps the other, at a point with ground standing on the base. In 1024ths,
  so `1 − delta` and `−delta` name exactly one height.

**Nothing else leans.** Flat ground, steps along x or z of any width, the edge
of a plateau and the ground round a dug block are exactly what the edge rule
makes them. (A version that leaned every terrace up to four blocks wide into a
slope, and rounded every edge off over four blocks, changed the look of all
terrain and was taken out again; this is what was kept of it.)

Corner slopes (`SmoothField.cornerSlope`): the sheet slope comes from the
surface heights on the neighbouring lattice lines, found **across levels**
(`topCrossNear`), so a staircase of one-block steps renders as one straight
slope rather than a row of S-bends. It is then limited by every stretch of
visible top surface running from that corner *at that height* — on this level
or on another whose surface is at the same height there — so every voxel at
the corner agrees on it. A stretch that is covered (the surface continues on
another level) does not count, or it would flatten the staircase again.

Thin features (**crests**): a voxel whose four top corners all drop (by the
edge rule) — a one-wide line, bend, T, cross or ring, or a lone block — would
flatten away. It
becomes a *crest voxel* instead: a rounded crest runs from its centre to the
middle of every side it shares with a neighbour. A side carries the crest (a
hump in its edge curve, `SMOOTH_CREST` high at its middle) when **both** voxels beside it
are open-topped Mesh voxels on the same level **and either one** is a crest
voxel. That test is symmetric, so both voxels always agree, and thin features
join up: a ring with no middle block is one continuous loop, a plus is four
arms meeting in a raised centre, a line end gets a rounded cap, a lone block a
low mound, and a thin arm flows into the wider ground it is attached to (that
ground voxel carries the crest on its shared side too). Diagonal neighbours do
not join: they share only a corner line, so a join there could only be a
zero-width pinch.

A crest is **`SMOOTH_CREST` (0.6) of a block high**, with the profile
`(1 − (2d)³)²` for distance `d` to the crest lines: level on top, 0 with zero
slope at unlinked sides (so it never disturbs a neighbour), and still half its
height two thirds of the way out. From the centre of the voxel `d` is the
4-norm, so a lone block fills its square. It used to stand the whole block
high on a bell that had lost half its height half way out — one block placed
on the ground was a spike. At the peak of a diagonal hill the corners are a
block down, and the crest rises `SMOOTH_CREST` over them: a rounded cap on the
slopes that meet under it.

Bottoms use the same edge rule through a second `SmoothField` that sees the
world upside down (`flipped`), so `shape.bot.c` holds `1 − bottom height`.
Bottoms have no diagonal sheets.

A **sheet with air on both sides** (a floating slab, a one-block bridge) shows
its top and its bottom, and they must not cross. Its top edges are drawn
straight like bottom edges (`thin`, decided per edge from the voxels either
side, so they agree), both surfaces are sampled at the same places, and the
bottom is split into triangles the way the top is (`surfaceGrid`'s `like`).

A Mesh voxel with a block both above and below is always a full cube (fast path),
and so is the flat interior of terrain. Full-cube Mesh voxels stay in the greedy
pass, so flat ground is still merged into large quads.

Cost controls, both in `SmoothShape.js`:

- `SMOOTH_SAMPLES` — where edges and patch axes are sampled: `[0, 1]` for a
  straight edge, thirds for a curved one, sixths for one that carries a crest
  (so the crest is drawn at full height and a mound is round). The sets are **nested**: a patch samples each axis at its finest
  edge's set, and `edgeSample` evaluates any extra sample on the edge's own
  polyline, so voxels sampling a shared edge at different resolutions still
  draw the same line — no cracks, at worst a T-junction on a straight segment.
  Flat and evenly sloped patches stay 2 triangles; crest voxels take 72.
- `SMOOTH_MIN_BEND` (0.05 blocks) — an edge bending less than this is drawn
  straight. Bottoms (cave ceilings, overhang undersides) are always straight;
  otherwise they cost as many triangles as all the visible terrain.

Measured on generated terrain (`npm run bench:pipeline`): about 2.7× the
triangles of the blocky mesh (3.9k vs 1.5k a chunk round the bench's spawn)
and 9–10 ms to mesh a chunk. `at`, `delta`, `top` and the corner slopes are
memoised per lattice cell, in flat arrays re-based to the levels a job's chunk
has ground on (`rebase`). Straightening loses geometry only; normals are
always computed from the unstraightened surface (`es` slopes), so lighting
stays smooth either way.

### Meshing (`workers/SmoothMesher.js`)

`prepare()` classifies each Mesh voxel (`isDeformed`: its corners only — the
shapes are worked out once, when they are emitted). Deformed ones are flagged
in `partial`, skipped by `GreedyMesher`, and emitted into the chunk's opaque
geometry: a sampled top patch, a sampled bottom patch, and a strip on each open
side between the two edge curves. `meshGroup(…, smooth)` takes
`{ occ, partial, emit }`; without it the greedy path is exactly the blocky one.

- **Walls between columns** (`_emitWall`). Where two columns do not draw the
  same line along the edge between them — one is a wall, or its corner is
  pinned by a Solid block — the higher one's side shows above the lower one's
  edge. The lower one's top voxel draws it, from its own top edge up to the
  top of its level (above that its column is air, and the higher column's own
  faces and strips take over). Nothing in the shape rules therefore has to
  make two columns agree for the mesh to be closed: they agree where the
  ground is a sheet, and where they do not, the gap is drawn.
- **Strips end exactly where their two lines cross** (`_strip`): a strip is
  drawn only where its upper line is above its lower one, and a stretch where
  they cross ends in a point on both, so it leaves no crack and nothing pokes
  out.
- A voxel a surface dips into stays a cube in the greedy pass: every face of
  it beside the dip is against more ground, and is never drawn. Texture
  heights go two tiles up (`y + 2`) on side-textured patches and strips, since
  a packed texture coordinate cannot be below 0.
- **Every Mesh voxel is an occluder** (`occ`), including deformed ones: the
  greedy pass never draws a face between two Mesh voxels. On one level they
  draw identical edge curves along the side they share; where a voxel's top
  edge is lower than the ground beside it, what shows of that ground is a
  wall, drawn as above.
- **Transparent faces are never drawn against Mesh voxels.** Drawing water faces
  there would double-tint the sea floor wherever voxels are partially filled.
- **Smooth shading:** each patch vertex carries the surface normal there (the
  `normals` attribute), and the chunk shader lights every pixel from the
  interpolated normal (see *Lighting*). Neighbours compute the same normal along
  a shared side, so light and wet-ground glints run smoothly across triangles
  and voxels alike. Side strips are flat, with their face's normal.
- **Texture per patch**, from the face closest to the patch's overall
  direction (the plane through its corners), so a curved slope never switches
  texture half way across a block: a top patch shows the top texture unless it
  is steeper than 45° overall, and side strips show the side texture.
- Patches and strips are indexed; each patch's triangulation (`surfaceGrid`'s
  per-cell diagonal) is exactly the one collision uses.

### Ground blending

Smooth ground of two kinds used to meet along the sides of blocks: a lawn ended
on a beach in a staircase of right angles. Now the ground with the higher
`blend` (see *Block Definition Fields*) spreads a little way over the other,
along a ragged line.

- **The mesher says who and from where** (`GreedyMesher.blendCode`). For the top
  of a natural-ground voxel it looks at the surface voxel of each of the eight
  columns around — a step up, level, or a step down, since that is how the
  smooth surface runs on — and takes the highest-ranking ground above the
  voxel's own. The answer is two bytes: that ground's top texture layer, and a
  bit for each of the eight sides it lies on. They ride in the vertex's colour
  bytes, which a textured face has no other use for (`MeshFormat.js`), so the
  vertex is no bigger and the patch's triangles — the ones collision uses —
  do not change. One ground per voxel: where three kinds meet, the middle one
  keeps a hard edge against the lowest.
- **The shader draws it** (`ground()` in `CHUNK_FRAG`): from the position inside
  the voxel (`fract` of the tile coordinates) it finds the distance to the
  nearest side the other ground lies on, and within `BLEND_REACH` (0.7 blocks)
  a noise decides which ground a pixel shows — not a fade, so it reads as one
  lying over the other. At the shared side it is always the neighbour, which
  is what makes the line continuous from voxel to voxel.
- **A block alone keeps its face.** Where the other ground lies on two
  opposite sides (or two opposite corners) of a voxel — a single block of dirt
  in a lawn, an ore in a stone floor, a path one block wide — it reaches only
  `BLEND_REACH_HEMMED` (0.2) in: the full reach from every side left a lone
  block looking like the ground round it (an ore in sand vanished altogether).
  So it is still plainly itself, with a frayed edge.
- Flat ground is greedy-meshed, so the code is part of what faces must share to
  merge: it goes in the high half of the (now 32-bit) opaque mask. Tops along a
  straight border all carry the same code and still merge into one quad.
- The same function gives all natural ground **a little variation on a scale
  larger than a block** (±12%, from the cloud noise texture at 64 blocks a
  tile), so a wide stretch of one ground does not look stamped out. Both read
  the world position from `tilePos()` (see *Chunk Shaders*).
- Blocky worlds blend nothing (the code is only computed with the smooth
  mesher's `read`); `test/mesher.test.mjs` checks both.

### Chunk edges

A voxel's shape reads up to `SMOOTH_REACH` (`SMOOTH_SPREAD + 2` = 4) blocks
away horizontally — corner slopes look one lattice line past the corners, and
each of those `SMOOTH_SPREAD` lines further for a diagonal step — **including
into the diagonal chunks**. In smooth worlds `ChunkManager`:

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
by clipping each triangle to the footprint, allocation-free). A voxel under
ground whose surface dips into it (a diagonal slope) is cut to that surface:
its shape is the same grid, in its own terms (`_build`).

Shapes and what they are worked out from are cached **chunk by chunk**, and a
change drops only the chunk it happened in and the eight round it
(`WorldState.changeLog` — the chunk of each of the last 256 changes, with
`changeSeq` counting them; `editVersion` still says that something changed).
Nothing reads further than `SMOOTH_REACH`. Dropping everything on every edit
and chunk load had the player's and every mob's footing worked out again each
frame while chunks streamed in.

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
`_indices`, a `Uint8Array` of palette slots — **for the chunk's filled rows
only**. `setVoxel` refuses and logs rather than overflowing the palette —
wrapping to slot 0 would punch an AIR hole in the column.

A generated or loaded chunk stores exactly its filled band
`[minFilledY, maxFilledY]`, as rows `[_lo, _lo + _rows)` in the layout below
(the one `snapshot()` sends); every voxel outside them is AIR. The sky above
the terrain is most of a column, so the whole column (`CHUNK_VOLUME` bytes, as
it used to be) was about twice the memory: 92 → 55 MB of voxels at render
distance 14. A block placed outside the stored rows grows them (`_cover`, 8
rows of slack); `getVoxel` answers AIR there. The palette's slot 0 is whatever
block came first — usually bedrock, not AIR — so anything that fills the rows
left out uses AIR's own slot (`_airSlot`). Nothing outside `ChunkData` may read
`_indices` by `voxelIndex`: use `getVoxel`, `toUint16Array()`, or
`writeIndices(target, offset)` for the whole column in the save format.
`test/chunkdata.test.mjs` checks all of it against a plain array.

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
`snapshot()` the largest main-thread cost while loading. It is the layout the
chunk is stored in, so for a chunk nobody has built above or below, a snapshot
is one copy of `_indices`.

**Arriving from generation:** the worker palette-compresses a new chunk itself
(`compressVoxels`, in `ChunkData.js`, which returns only the filled rows) and
the main thread only calls `adoptCompressed()` — no per-voxel work and no copy
on the render thread. `loadVoxels(Uint16Array)` wraps the same two for tools
and tests. A chunk loaded from the server arrives as the whole column
(`ChunkData.deserialize`), which keeps its filled rows and lets the rest go.

**Chunk lookups** (`WorldState.getChunk`) keep the last chunk looked up, since
voxel reads come in runs within one chunk (collision, raycasts, smooth shapes,
mob AI) and building the `"cx,cz"` string was most of each lookup — every
`getBlock` used to allocate one. `setChunk` / `removeChunk*` reset it, so the
chunk map must only be changed through them. ChunkManager's per-frame scan
likewise reuses the keys it builds when the residency set changes.

---

## Worker Pool (`WorkerPool.js`)

Workers are created as **module workers** (`{ type: 'module' }`), which allows the worker files to use ES module `import` statements.

**Worker count:** `max(2, min(hardwareConcurrency - 1, 8))`

**Lifecycle:**
1. Construct: `new WorkerPool(workerUrl)` — workers are created but idle.
2. Init: `await pool.init({ seed, blockRegistry, biomes })` — broadcasts init to all workers, resolves when all respond `{ type: 'ready' }`. A worker that fails before it answers is started again, twice at most, and after that the pool goes on without it: a load used to wait for ever on one (seen once, on six of seven workers together, and never again).
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

### Which chunks are loaded

A **square**: every chunk within `renderDistance` of the player's chunk on both
axes — (2rd+1)², 289 at the default 8. It used to be the circle inside that
square, which hid the corners the player could otherwise see down a diagonal;
the chunk fog is shaped to match the square (see *Scene Setup*). The player's
chunk is `floor(x / 16)` (a `| 0` truncation put the sliver x ∈ (−1, 0) in
chunk 0). Jobs are still ordered by Euclidean distance, nearest first.

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
  terrainStyle: 'blocky' | 'smooth',
  flat: object | null,     // a Flat world's settings (see Flat worlds), else null
  terrain: object[],       // data/terrain definitions (geology.json)
  worldGen: number,        // the world's generator version; missing = 1 (legacy/)
  farPalette: Float32Array }  // far terrain's colour per block id, r g b (see Far Terrain)
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
  palette: Uint16Array, indices: Uint8Array /* rows minY … maxY only */, minY, maxY }
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
                                               // chunks' SMOOTH_REACH² (4 × 4) corner columns
}
// every palette + indices buffer is transferred
```
**Worker → Main:**
```js
{ type: 'chunkMeshed', taskId, cx, cz, geo, light }
// light: { data: Uint8Array, y0, h, block } — sky light, see Lighting; `block` is
// the block light in the same layout ({ data, y0, h }) or null when no light
// source is in reach. Both data buffers are transferred.

// geo holds all six face directions:
{
    positions, tints, uvs, normals, indices,                      // opaque mesh (and cutouts)
    transparentPositions, transparentTints, transparentUVs,       // transparent mesh: water, ice —
    transparentNormals, transparentIndices,                       // every face twice, indices back to front
    yMin, yMax,        // local-Y extent, used for the chunk's culling box
    rain,              // Float32Array(256): where rain stops in each column, x fastest —
                       // world Y of the top block's top, or of a deformed Mesh voxel's
                       // surface at the column centre; NaN for an empty column
    sections,          // Uint32Array(29): the opaque indices are in order of 16-level
                       // section, and section s is indices sections[s] … sections[s + 1]
    conn,              // Uint8Array(28 × 6): for each section and each of its faces, a bit
                       // for every face open space joins it to (see *What the camera cannot see*)
}
// all geometry ArrayBuffers are transferred
```

`rain` feeds the render thread's `RainHeightmap` (Precipitation.js). It used to
be computed there, a couple of chunks per frame, and in smooth worlds that meant
hundreds of smooth-shape evaluations per chunk against the live world — a third
of the main thread while new terrain streamed in. The worker has those shapes
memoised from meshing the chunk (`SmoothMesher.topHeight`).
`test/worker.test.mjs` checks the heights against the collider.

**A vertex is 24 bytes** (`engine/MeshFormat.js`, shared by the meshers and
the shaders):

| Array | Type | Holds |
|---|---|---|
| `positions` | `Float32Array`, 3 | Chunk-local position |
| `tints` | `Uint8Array`, 4, normalised (`tint`) | a: the texture layer, `NO_LAYER` (255) for an untextured face. r g b: an untextured face's colour (no light baked in); on a textured face, which has no colour of its own, how it blends — r the texture layer that spreads over its edges, g a bit for each of the eight sides it comes from (0: none), b 255 on natural ground (see *Ground blending*) |
| `uvs` | `Uint16Array`, 2, normalised (`uv`) | Tile coordinates × `UV_SCALE` (128) — they run from 0 to the world height |
| `normals` | `Int8Array`, 4, normalised (`nrm`) | The surface normal × 127, and the block's glow × 127 |
| `indices` | `Uint16Array`, or `Uint32Array` past 65,535 vertices | 65535 itself is WebGL 2's primitive-restart index |

It was 40 bytes — colour, layer and uv as floats — with 32-bit indices, and
chunk geometry was by far the most memory the game held: about 560 KB a chunk
on the GPU (which on integrated graphics is the machine's RAM), 184 MB at
render distance 8 and 473 MB at 14. Now 107 and 275 MB. The meshers still build
in float sinks and pack once when a mesh is finished (`_sinkArrays`); the
vertex shaders unpack with `tintLayer()` and `tileUV()` (`MESH_VERT_GLSL`).
Keep every attribute a format Direct3D has natively — normalised bytes and
shorts, four bytes rather than three: ANGLE converts anything else to floats on
the CPU at every upload, and a non-normalised integer attribute read as a float
is one of those. At most 255 texture layers can be addressed (`world.js` logs
an error past that). A geometry with no `tint` (a mob in the shadow pass) reads
the default alpha 1: no texture, so it casts.

The chunk shader lights from the normal (see *Lighting*). The colour used to
carry baked sun brightness, with the shader taking its normal from screen-space
derivatives — one flat normal per triangle, which is what made smooth terrain
look faceted, most of all when wet.

Model blocks (torches, lanterns) are drawn only if the chunk's palette has one
(`GreedyMesher.hasModels`), so other chunks skip the scan.

### `lightChunk`
Light only (sky and block), for a chunk whose geometry is current but whose light changed
(an edit or a load up to 15 blocks away in a neighbour).
```js
{ type: 'lightChunk', taskId, cx, cz, chunk, neighbors, diagonals }   // Main → Worker
{ type: 'chunkLit', taskId, cx, cz, light }                           // Worker → Main
```

### `farTile`
One far-terrain tile (`workers/FarTiles.js`): the square at `(x0, z0)`,
`cells × step` blocks wide, as a heightfield with its trees and buildings
standing on it. No chunk data goes either way; `edits` are the surfaces of the
chunks in it that the player has changed (see *Far Terrain*).
```js
{ type: 'farTile', taskId, x0, z0, step, cells,
  edits /* optional: [{ cx, cz, heights: Int16Array(256), ids: Uint16Array(256) }] */ }   // Main → Worker
{ type: 'farTileBuilt', taskId, x0, z0, step,
  positions /* Float32 xyz, tile-relative */, colors /* Uint8 rgb + foot z */,
  normals /* Int8 xyz + foot x */, indices /* Uint16, or Uint32 past 65,535 vertices */,
  yMin, yMax, features /* shapes standing on the ground */ }                               // Worker → Main
// every buffer is transferred
```
The ground's vertices come first ((cells+1)², then the skirts), the shapes
after. A vertex's two spare bytes are the offset to the foot of what it belongs
to, in sixteenths of a block (0 for the ground).

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

The current generator uses **`Simplex`**: one instance per noise field, each
with its own permutation from `hashSeed(seed, …)`. Fields are then independent
patterns rather than one lattice read at offsets (which line up whenever two
offsets differ by a multiple of the 256-cell period), and there is no module
state, so the main thread (`Climate`, spawn search) and every worker can hold
the same fields. Methods: `noise2`, `noise3` (the same algorithm as below,
`[-1, 1]`), `fbm2(x, z, octaves, freq, gain, lacunarity)` (octaves shifted apart
so they do not all cross zero at the origin) and `ridged2` (squared ridges,
`[0, 1]`). A single octave has a spread (s.d.) of about 0.44, three octaves
about 0.29 — thresholds in `Geography.js` are set against those.

The module-level functions below keep one seed in module state; only the legacy
generator uses them. Call `setSeed(worldSeed)` before generating with them.

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

## World Generation

The land is shaped first, from world-wide fields that know nothing about
biomes; biomes are then chosen from where each column ended up and decide only
what it is made of and what grows on it. One mountain range can therefore run
from forest through taiga to snow, or cross from desert into grassland.

| File | Role |
|---|---|
| `workers/Geography.js` | The shape of the land: continents, mountains, hills, plateaus, coasts, rivers, fjords, lakes, climate. Picks each column's biome. Pure functions of world (x, z) and the seed. |
| `workers/Biomes.js` | Biome definitions: normalising the JSON, choosing a biome for a column, block-name fallbacks (`blockIdOf`) |
| `workers/TerrainGenerator.js` | Voxels: rock layers, soil and snow, water and ice, then caves, rock blobs and ores; `generate()` adds the structures |
| `workers/Caves.js` | Tunnels, noodles, caverns, underground valleys, shafts, ravines |
| `workers/StructurePlacer.js` | Trees, cacti, huge mushrooms, boulders, houses |
| `workers/legacy/` | The generator from before this one, frozen, for worlds made with it (below) |
| `data/biomes/*.json` | 28 biomes |
| `data/terrain/geology.json` | World-wide materials: deep stone, rock blobs, ores, cave densities |
| `engine/Climate.js` | The climate at the player, for weather — from the same geography |

Everything is deterministic in the seed and world position, so a chunk is the
same whenever it is generated and matches its neighbours at every seam: a river
or a mountain range carries on into the next chunk because the field it comes
from does. `test/terrain.test.mjs` checks determinism, seams and more.

### Which generator a world uses (`worldGen`)

New worlds are stamped `"worldGen": 2` (`WORLD_GEN` in `server/server.js`,
matching `TerrainGenerator.WORLD_GEN`). A world with no value predates this
generator and keeps using the one it was made with —
`workers/legacy/LegacyTerrainGenerator.js` with its structure placer and a
frozen copy of the biomes of that time (`legacyBiomes.js`) — so unexplored land
still matches what the player already has, with no seam. `worldWorker` picks by
the `worldGen` sent in `init`; `Climate` does the same. **Do not change what the
legacy generator produces**: `test/terrain.test.mjs` pins it to a hash of its
output. To change terrain for existing worlds, bump `WORLD_GEN` and keep the
current generator as the next legacy one.

### Flat worlds (`engine/FlatWorld.js`, New World → World Type)

A world made with **World Type: Flat** has `"worldType": "flat"` and a `flat`
object in its `world.json` (fixed when it is made, like the seed), and no land
is shaped for it at all: every column is level, its top block at `FLAT_TOP`
(64, sea level — the fog, clouds and weather are set against that height), dry,
with no caves, rock blobs or ores. Two kinds (`flat.mode`):

| Mode | The ground | Biomes |
|---|---|---|
| `layers` | The player's own stack, `flat.layers`: `[{ block, depth }]`, top first, up to 16 layers of up to 64 blocks. Under the last there is nothing (so a stack without bedrock can be dug through) | One for the whole world, `flat.biome`: its weather and what grows |
| `biomes` | Each column is its biome's own ground — top, layers, stone, deep stone, bedrock — as in a normal world | By climate, land biomes only: the same climate fields, so a seed has its hot and cold country where a normal world of that seed has them |

`flat.decorations` (trees, plants, boulders) and `flat.structures` (buildings)
turn the structure placer's two kinds on and off (`StructurePlacer.plants` /
`.buildings`, tested in `_typeAt`, so far terrain follows). The placer still
wants its ground: nothing grows on a top layer of stone.

It is the ordinary generator with the geography switched off, not a second
one: `Geography` takes `flat` and answers `region()` / `column()` from
`_flatRegion` (level, dry, no slope; biome fixed or chosen by climate), and
`TerrainGenerator` skips caves, blobs and ores and, in `layers` mode, fills a
column from `flatLayers` and reports its top layer as the cover. Everything
that reads the geography therefore just works: far terrain, the weather's
climate (`Climate` takes `flat` too), and the spawn search (`findSpawn`
answers at once — it is all dry, level land). `flat` travels
`world.json` → `startWorldLoad` → the workers' `init`; `normaliseFlat` checks
it wherever it arrives, and the server checks it when the world is made
(`cleanFlat`, the same rules — it cannot import the game's source).

The form (`game.html`, `main.js`: `FLAT_PRESETS`, `_renderFlatLayers`,
`readFlatForm`) offers stacks to start from and a row per layer — block,
thickness, up, down, remove. About 0.3–0.6 ms a chunk to generate.

### Geography (`workers/Geography.js`)

Three passes per column:

| Pass | Needs | Makes |
|---|---|---|
| A `_raw` | noise only | continentalness, erosion, climate, mountain belts, hills, highlands, plateaus/mesas, dunes, islands, the river / creek / fjord noises |
| B `_shape` | A at the four neighbours (gradients) | distance to the coastline, to a river's or fjord's centre line, in blocks; coastal cliffs and beaches, swamps, fjords, rivers |
| C `_applyLakes` | the height after B | lakes |

`region(ox, oz, w)` runs them over a chunk plus a ring (for slopes and
neighbouring water), then picks biomes. `column(x, z)` does the same for one
column and is **bit-for-bit** the chunk's value there (the test checks it): the
structure placer asks it about trees rooted in the next chunk, `Climate` about
the player's column, and world load about a spawn point (`findSpawn`: the
nearest dry, gentle land, so a new world never starts in the sea). A single
column evaluates only the 13 raw points it needs, ~28 µs.
`region(ox, oz, w, step)` with a step above 1 samples a lattice that many
blocks apart instead, taking every gradient across the lattice — far terrain
(see *Far Terrain*); at step 1 it is exactly the chunk's.

**Continents.** Continentalness `C` (5-octave fbm at 1/5200, domain-warped by
650 blocks so coasts form bays and peninsulas) runs through a monotone spline
to the bare land height; `C = 0` is the coast, about 55% of the world is land.
Rare inland seas pull `C` below zero deep inside continents; archipelagos rise
from some stretches of sea. Hills, mountains and highlands fade in with
distance from the coast (`land`), so coasts are low unless a cliff says
otherwise.

**Erosion** `e` (0 rugged … 1 worn flat, 1/2400) decides where mountains may
rise, how hilly the ground is, and how wide river valleys are.

**Mountains** are a landform, not a biome. Belts follow the zero lines of a
warped noise (long ranges thousands of blocks long, ~400 wide) where erosion is
low and well inland; lone massifs sit elsewhere. Height is a broad massif plus
ridged noise (1/640), kept to slopes smooth terrain can draw — past a rise of
~1.5 per block it breaks up into spikes, so cliffs are left to the features
meant to have them. The very highest peaks ease toward `MAX_HEIGHT` (292).

**Hills and detail**: 3-octave hills (1/700), local relief (1/170) and micro
detail (1/30), all scaled by erosion and kept low in the fine octaves — each
octave adds its own slope.

**Plateaus and mesas**: flat-topped tiers with cliff sides in plateau regions
(commoner in dry climates, never on mountains); the badlands biome stripes them.
**Dunes** ripple sandy deserts. **Swamps** pull warm, wet lowland to the water
line into a patchwork of land and shallow pools.

**Coasts**: distance to the coastline in blocks is `C / |∇C|`. Where the cliff
field is high the land rises sheer within a few blocks of the water and the
sea deepens at its foot; elsewhere the coast is drawn toward a shallow ramp —
wide beaches and a sandy shelf.

**Fjords**: in cold, rugged country the coast is raised and cut by U-shaped
channels 24–32 blocks below sea level, fading inland into dry glacial valleys.

**Rivers**: along the zero lines of two noises — rivers (every ~1000 blocks)
and finer creeks in lower, wetter country. The water sits just below sea level,
so rivers meet the sea and each other; the valley's width follows the land
(broad floodplains in worn lowland, gorges in rugged ground, canyons in dry
plateau country). On high ground (above ~110–160) the valley stays but runs
dry — that is where a river rises. Distance to a centre line is `|R| / |∇R|`.

**Lakes** are placed one per cell for three sizes (ponds, lakes, large lakes;
cells 144 / 416 / 1408 blocks), their centres kept in from the cell edge so two
of a size never touch, and a smaller one dropped where a bigger one reaches.
Each has one flat water level, taken from the land around it (just under the
lowest point of its rim), so lakes can sit high above the sea. A lake is
rejected in the sea, on a river, on ground too uneven, or where it would be a
pit in a hill. Inside the shore every column is under the level; a flat shore
ring 3 blocks wide is held at the level (it gets the biome's lakebed cover,
`COL_SHORE`); beyond it the land slopes down to the shore at 0.8 per block, so
the lake lies in a basin. The shore wobbles on noise scaled to the lake. The
water is always enclosed — a valley running past becomes a dam.

**Climate**: temperature and humidity (3-octave fbm at 1/5200 and 1/4400, on
their own warp), humidity leaning against temperature (hot country is drier).
Temperature cools above `LAPSE_START` (96) at `LAPSE_RATE` (0.0038/block): the
snow line is near y 190 in a temperate climate and y 150 in a cool one.

**Water**: a column below sea level holds sea water up to 64; a lake column up
to the lake's level; anything else is dry. `wetFloor` records the lowest top
among a column's side neighbours that hold water, which caves stay below.

### Biomes (`workers/Biomes.js`, `data/biomes/*.json`)

A column's **category** comes from the geography: `ocean` (under sea-level
water, seaward), `river` (in a channel or on its banks), `beach` (low coastal
ground), else `land` (lake beds included). Within the category, the biome whose
soft ranges the column is closest to wins: temperature (after altitude),
humidity, elevation, slope and plateau, each distance weighted (elevation per
60 blocks). Rare biomes add hard `require` ranges and a `priority`.

Climate is so smooth that over a few hundred blocks it is nearly linear, and a
biome bounded by "hotter than a, drier than b" came out as a straight-sided
polygon. The selection therefore reads climate a little way off (a two-scale
warp of ~45 blocks) and jitters the plateau value, which winds every border.
The terrain itself uses the unwarped values.

```json
{
  "name": "TAIGA",
  "category": "land",
  "temperature": 0.25, "humidity": 0.55,          // representative climate
  "select": { "temperature": [0.14, 0.34], "humidity": [0.3, 0.9], "elevation": [58, 165] },
  "require": { "weirdness": [0.55, 10], "island": [0.3, 2] },   // hard; rare biomes only
  "priority": 0,
  "mapColor": "#0b6659",
  "surface": {
    "top": "GRASS",
    "layers": [{ "block": "DIRT", "depth": 3 }],
    "stone": "STONE",
    "deep": null,
    "snow": "SNOW_DIRT",
    "steep": { "top": "STONE", "layers": [{ "block": "STONE", "depth": 2 }] },
    "underwater": { "top": "GRAVEL", "layers": [{ "block": "GRAVEL", "depth": 2 }] },
    "patches": [{ "block": "PODZOL", "scale": 16, "threshold": 0.3, "under": false }],
    "underwaterPatches": [],
    "bands": ["TERRACOTTA", "..."], "bandDepth": 40,
    "topDepth": 1
  },
  "structures": { "spruce_tree": { "frequency": 0.03 }, "boulder": { "frequency": 0.0004 } },
  "ores": [],
  "weather": { "precipitation": 1.0 }
}
```

| Field | Effect |
|---|---|
| `category` | `land` / `beach` / `river` / `ocean` |
| `select` | Soft `[min, max]` ranges: `temperature`, `humidity`, `elevation`, `slope`, `plateau` |
| `require` | Hard ranges (also `weirdness`, `island`) — a candidate only inside all of them |
| `surface.top`, `layers` | The ground: top block, then layers down to the stone |
| `surface.stone`, `deep` | The rest of the column; `deep` replaces the world's deep stone |
| `surface.snow` | What `top` becomes above the snow line (SNOW_DIRT keeps grass-like ground) |
| `surface.steep` | The cover where the slope is too steep for soil (default: the stone) |
| `surface.underwater` | Sea, river and lake beds, and lake shores |
| `patches`, `underwaterPatches` | Noise patches replacing the top (`under`: the first layer too) |
| `bands`, `bandDepth` | Badlands: stripes by world Y from the surface down, reaching the surface on cliffs |
| `topDepth` | How deep the top block goes on flat ground (dunes, snowfields) |
| `structures` | Plants and buildings and their frequency per block (see below) |
| `ores` | Extra ores for the chunk's commonest biome, on top of the geology's |
| `weather` | `precipitation` multiplier and weather-type weights (see *Weather*) |

Old-style definitions (`surfaceBlock`, `subsurfaceBlock`, `stoneBlock`,
`deepBlock`) still load; their height fields are ignored. A pack with no biome
for a category gets a plain default, and any block name a pack lacks resolves
to a similar block (`blockIdOf`) — never to AIR, which would punch holes.

### Current biomes

| Category | Biomes |
|---|---|
| land, temperate | PLAINS, FOREST, DENSE_FOREST (large oaks, podzol and moss), BIRCH_FOREST, MEADOW (open highland grass) |
| land, cold | TAIGA (spruce, podzol), SNOWY_TAIGA, SNOWY_PLAINS, TUNDRA (coarse dirt, gravel, boulders), COLD_HIGHLANDS |
| land, warm | SAVANNA (dry grass, acacias), JUNGLE (giant 2×2 trees), SWAMP (mud, pools, swamp oaks), DESERT (dunes, cacti), BADLANDS (red sand, terracotta mesas), WARM_HIGHLANDS |
| land, high | STONY_PEAKS, SNOWY_PEAKS |
| land, rare | MUSHROOM_FIELDS (islands in weird seas; mycelium, huge mushrooms) |
| beach | BEACH, SNOWY_BEACH, STONY_SHORE |
| river | RIVER, FROZEN_RIVER |
| ocean | OCEAN, DEEP_OCEAN, WARM_OCEAN, FROZEN_OCEAN |

Snow, ice and bare rock are not biomes: snow lies wherever the cooled
temperature is below 0.14 (packed ice builds up under it below −0.12 on gentle
ground), water freezes over where its surface is that cold, and any slope past
~1.25 shows the biome's `steep` cover. So a taiga slope above the snow line is
snowy, and a peak's sheer faces are rock.

`test/worldmap.mjs` (`npm run map`) draws a region from above — heights with
hill shading or biome colours — and prints the land/sea/biome balance;
`--mode slice` cuts a vertical section through real generated chunks.
`test/terrainshots.mjs` (`npm run shots`) flies the real game to a mountain
range, river valley, lake, coast, fjord and a dozen biomes on a seed and
screenshots each.

### Voxels (`workers/TerrainGenerator.js`)

Per column, bottom up, written as contiguous bands: bedrock (3), the deep stone
(`geology.deepStone`: SLATE below y ≈ 0 on a wavy, ragged boundary), the
biome's stone, its layers, its top — chosen as the underwater, steep, snowy or
ordinary cover, with patches — then water, and ice on it where cold. Badlands
stripe the stone below the cover. Then:

1. **Caves** (`Caves.js`, below).
2. **Rock blobs** (`geology.rockBlobs`): granite, diorite, andesite, dirt,
   gravel and limestone in stone and slate, with ragged edges. The blobs of the
   eight neighbouring chunks are placed too where they reach in, so a blob is
   whole across a seam.
3. **Ores**: `geology.ores` plus the commonest biome's `ores`, as random-walk
   veins (see *Ore / Vein System*), only into `oreHosts` and never within 4
   blocks of the surface.
4. **Structures** (`generate()` only; `generateChunk()` stops before them).

About 3 ms per chunk on a 15 W laptop CPU: geography ~1.0, caves ~0.6–1.3,
structures ~0.5, fill 0.2, blobs and ores 0.2 (`npm run bench:pipeline`).

### Caves (`workers/Caves.js`)

| Kind | How | Where |
|---|---|---|
| Tunnels | Two 3D noises (1/104 across, 1/70 up) both near zero: two sheets crossing in a line | Everywhere from 8 above bedrock to the surface (they may open onto it) |
| Noodles | The same at 1/38, thinner | Noodle regions (about half the world) |
| Caverns | A squashed 3D noise above a threshold | Rare cavern regions, never close under the surface |
| Underground valleys | Long tall galleries along the zero line of a 2D noise, y ≈ −60 … −30 | Rare regions |
| Shafts | Wandering vertical pits 20–70 deep from the surface, one per 72-block cell at most | ~30% of cells |
| Ravines | V-shaped cuts 20–55 deep along a 2D zero line | Ravine regions |

The 3D noises are sampled on a **world-aligned 4-block lattice** (neighbouring
chunks share its points) and interpolated; at their wavelengths that loses
almost nothing, and replaces a noise call per voxel with one per 64. Each
column is walked in 4-block segments, along which every field is linear, so a
segment that cannot carve is skipped without touching its voxels. Nothing is
carved above `cap`: under water a 2-block floor stays, and beside water caves
stay below the neighbouring water's bed (`wetFloor`), so no cave or ravine ever
opens next to standing water — `test/terrain.test.mjs` checks water in lake,
river, coast, swamp and fjord country across seams.

Every cave wall is drawn (nothing culls geometry underground), so caves set
most of a chunk's triangles: around spawn 5.0k smooth triangles per chunk, 1.8k
of them without caves. The tunnel scales are the main lever. `geology.caves`
scales each kind (0 turns it off).

---

## Ore / Vein System

Ores come from `data/terrain/geology.json` (`ores`, for the whole world) plus
the `ores` of the chunk's commonest biome (badlands add gold high up, the peaks
iron). They only replace blocks listed in `oreHosts`.

```json
{ "block": "COAL_ORE", "minY": 0, "maxY": 260, "frequency": 0.0062, "minSize": 4, "maxSize": 14 }
```

| Field | Meaning |
|---|---|
| `block` | Block name to place (must exist in block registry) |
| `minY`, `maxY` | World Y range where this ore can spawn |
| `frequency` | Vein attempts per unit volume of the ore band (`attempts = freq × 16 × 16 × bandHeight`, where `bandHeight = maxY − minY + 1` clamped to the world) |
| `minSize`, `maxSize` | Random vein length range (random walk) |

The vein algorithm is a deterministic random walk from a seed point. The walk
direction is chosen from the 6 cardinal directions using `hashSeed`. Veins stay
inside the chunk that starts them.

**Y sampling.** Each attempt samples its Y *inside* the ore's clamped band, from
disjoint bit fields of one hash (4 bits X, 4 bits Z, 20 bits Y offset). An older
version sampled across the whole world height and discarded anything outside
the band, and was biased toward the bottom of the world.

---

## Structure System (`workers/StructurePlacer.js`)

Structures are placed after terrain, caves and ores.

**Vegetation cells.** The ground is cut into 5×5 cells; each holds at most one
plant. A hash of the seed and the cell gives its spot and a roll; the biome at
that spot shares the cell out among its plant types by their frequencies
(`frequency × 25` — above 1 the cell always grows something), so a forest of
oak and birch picks one per cell, never two trunks in one place. Buildings use
48-block cells. A type also needs its ground (`on`: soil for trees, sand for
cacti, any for boulders), a gentle enough slope, and dry land (swamp trees may
stand in one block of water).

**Across chunk borders.** A plant near a chunk edge reaches into the next
chunk. Both chunks reach the same decision about it: the chunk it is rooted in
reads its own columns, the other asks `Geography.column()` for the root — the
same values bit for bit — and each places the blocks inside itself. Canopies
run on across seams (the old placer cut them off there).

Each type is prebuilt in 8 variants from a seeded RNG (`BUILDERS`), as flat
`[dx, dy, dz, id, rule]` lists with dy 0 the first block above the ground. The
rule says what a block may replace: air only (leaves), air or leaves (trunks),
or also ground (boulders, the house). A cave that broke through under a root
gets two blocks of dirt put back so the trunk does not hang.

| Type | Description |
|---|---|
| `oak_tree` | 4–6 trunk, round crown |
| `large_oak_tree` | 7–10 trunk, big blob crown and low branches |
| `birch_tree` | Birch log, tall narrow crown |
| `spruce_tree` | 7–12 trunk, ringed cone of spruce leaves |
| `acacia_tree` | Leaning trunk, wide flat canopy |
| `jungle_tree` | 9–13 trunk, or a 15–20 giant with a 2×2 trunk; leafy tufts down the trunk |
| `swamp_tree` | Wide crown with hanging strands |
| `cactus` | 1–3 tall, on sand |
| `huge_mushroom` | Red dome or brown flat cap |
| `boulder` | Mossy stone or andesite, half sunk |
| `house` | Stone-framed plank house with glass windows and a gabled roof, 7×9 |

Biome JSON written for the old placer says `tree`; it means `oak_tree`.

### Adding a structure type

1. Write a builder `(rng, b) => Shape` in `BUILDERS` (see the others; `b` holds
   block ids by name) and keep its reach within `VEG_REACH` (5) of the root.
2. Add a row to `TYPES` with the ground it grows on and its steepest slope.
3. Give it a `frequency` in some biome's `structures`.

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

This is the hottest code in the engine. When editing it, preserve these:

- **No allocation in the sweep or per quad.** Array destructuring
  (`const [x,y,z] = coord`) allocates an iterator and was previously costing
  ~1.1M allocations per mesh.
- **Only the cells that can have a face are read** (`_buildRows`). Once a job,
  every row of sixteen cells along x gets two words with a bit a cell:
  `_rowSrc` (something is there, and it is not a Mesh voxel the smooth pass
  draws) and `_rowOcc` (it hides a face drawn against it). Rows are numbered
  y · 16 + z, so the row beside one is ± 1 and the one above or below ± 16; the
  cells of the four neighbouring chunks that touch this one are noted the same
  way. A sweep then finds its candidates sixteen at a time — `src & ~occ` of
  the row it faces — and reads the block and the block it faces only for
  those. It used to read every voxel and its neighbour for each of the six
  directions, 2.3M reads a chunk, and that was half of meshing a blocky chunk:
  nearly all of a chunk is air or buried rock, which has no face.
- **Voxels are addressed by flat index with per-axis strides** (`STRIDE`), not
  through coordinate arrays. Within one slice every voxel's neighbour in the
  face direction is in the same array at the same index offset — this chunk,
  or one neighbour chunk for the boundary slice — so that is resolved once per
  slice. A slice whose neighbour is outside the world or an unloaded chunk
  (`SOLID_SENTINEL`) can emit nothing and is skipped.
- **The masks are never cleared and never filled.** A merge zeroes every cell
  it takes, and takes every cell that was set, so a mask is all zero again when
  the next slice begins (`meshGroup` clears both once a job, for a job that
  stopped half way). So there is no separate `done` table either, a slice
  with nothing set (most transparent ones) is not merged at all, and a merge
  is given the box of the cells that were set, not the whole slice.
- **No quad spans two sections, and the opaque indices are in order of
  section** (`markSection`, `_sortSections`), for *What the camera cannot
  see*: a side face stops growing at the top of its 16-level section (about 1%
  more triangles), and a face belongs to the section of the cell in front of
  it — the one it is seen from. Everything that writes to the opaque sink says
  which section first.
- **Solidity comes from `this._solid`**, a `Uint8Array(65536)` lookup, not a
  registry call. It is sized across the full id space so the lookup stays
  branch-free even for the `SOLID_SENTINEL` value.
- **The opaque mask is 32-bit**: the block id in the low half, a top face's
  blend code (smooth worlds) in the high half, so the merge compares one number
  and only joins faces that blend the same way.
- **Output goes into growable typed arrays** (`F32Buf` / `U32Buf`), kept by the
  mesher across jobs so they stop growing after the first few chunks; quads are
  written into `reserve()`d space. `_sinkArrays` copies the result out for
  transfer, packing colour + layer, uv and indices on the way
  (`engine/MeshFormat.js`, see *Worker Protocol*).

Measured against the previous version in one process on the same 81 chunks of
real terrain (identical output): blocky 4.13 → 2.07 ms per chunk, smooth
12.0 → 9.7 ms (the rest of smooth is the smooth-shape pass). The row words then
took blocky from 2.7–3.1 to 1.7–1.8 ms and smooth from 9.2–10.0 to 7.4–8.1
(runs alternated on a warm laptop; again the same output, hash for hash).

`test/mesher.test.mjs` checks the output against a brute-force per-face
reference (emitted area must match exactly, indices must be in range) across
flat, solid, transparent, neighbour-culled and checkerboard cases. Run it with
`npm test` after touching this file. `npm run bench:pipeline` prints a hash of
every stage's output, so an optimisation can be checked for changing nothing
but speed.

### Two Output Meshes

| Mesh | Material | Blocks |
|---|---|---|
| Opaque | `ShaderMaterial` (GLSL3) — texture array + per-pixel lighting + fog, alpha-tested at 0.5 | All opaque blocks; **cutouts** (leaves, glass — `render: "cutout"`); models |
| Transparent | Same shader, `transparent`, `depthWrite: false`, front faces only, 0.72 of the texture's alpha | **Translucent** blocks: water, ice |

See-through blocks used to be one class, all blended at 0.72 with no depth
written and in no particular order — so the far side of a tree showed through
its near side, and water behind a window was painted over the glass. They are
two now:

- **Cutouts** go in the opaque mesh. A texel is drawn or it is not, and what is
  drawn writes depth like any block, so there is nothing to sort and nothing
  can be drawn over them wrongly. Leaves are painted solid (a crown is a mass
  of leaves); glass is its frame and a few glints, with what is behind it
  simply seen. A cutout shows a face against anything that does not hide it,
  except more of itself.
- **Translucent** blocks are blended, so they must be drawn far to near.
  - *Within a chunk* the mesher does it (`_orderTranslucent`). Every face is in
    the mesh twice, once facing each way, and back faces are culled. Among
    faces turned the same way the camera only sees those it is in front of, so
    drawing them by rising position along their normal (falling, for those
    turned toward −) is back to front **from any viewpoint**; a face turned
    toward + and one toward − on the same axis are never both in one line of
    sight. That is exact for everything on one axis — every water and ice
    surface, which is nearly all there is. The three axes follow one another
    (horizontal first), which is only approximate between a surface and the
    side of something standing in it.
  - *Between chunks* `_cullChunks` sets each transparent mesh's `renderOrder`
    to minus its distance from the camera's chunk, counted along x plus along
    z: for columns on a grid that is a correct far-to-near order (a line of
    sight never comes back toward the camera's chunk on either axis). Three.js
    would sort by the depth of each mesh's origin, a corner at the bottom of
    the world, which is wrong when looking down.
  - The surface is still there from underneath (its other copy), which is what
    `DoubleSide` used to be for. A translucent face shows against air, a model
    or a cutout; water and ice hide each other's faces.

`test/mesher.test.mjs` checks the classes against each other and the order from
viewpoints above, below and between two sheets of water.

### Normals and model blocks

Every quad gets its face normal in `normals` (`FACE_NORMAL8`), with the block's
glow in the fourth byte. The shader does the face shading; under the noon sun it
comes out as it always was: top 1.00, +Z 0.77, +X 0.70, and −X / −Z / bottom
0.54.

Model blocks are skipped by the mask fill and drawn by `BlockModels.js` after the
sweep: a few boxes each, textured from rectangles of the block's texture sheet,
entirely inside the voxel. They never hide a neighbour's face, and water, leaves
and glass draw their faces against them as against air (`_glassy` / `_airLike`,
read only on the transparent branch of the mask fill).
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
| V or F5 | The view: your own eyes, over your shoulder, from in front (see *The player's body and the view*) |
| F11 | Toggle fullscreen (desktop app) |

Movement runs through `PlayerPhysics` (AABB collision, gravity, jump, fall
damage), with free-fly in Creative and Spectator.

### Controller (`src/gamepad.js`)

The browser's Gamepad API, standard layout (Xbox, PlayStation, Switch Pro).

| Controller | In play | In a menu |
|---|---|---|
| Left stick | Move, as far as it is pushed; click it to sprint | Move the focus ring |
| Right stick | Look | |
| D-pad | Left / right: hotbar | Move the focus ring; left / right change a slider or a list |
| A / B | Jump (go up) / sneak (go down) | Choose / back |
| RT / LT | Mine and attack / place, use, eat, draw a bow | |
| LB / RB | Previous / next hotbar slot | Previous / next settings section |
| Y / X | Inventory / crafting | Y closes the inventory; X on a slot takes half |
| Right stick, pressed | Change the view | |
| Start | Pause | Resume, or close the menu |

- **In play** it publishes what the sticks and buttons ask for in
  `window.__wwPad`, which `world.js` reads each tick beside the keyboard and
  mouse: `moveF` / `moveR` go to the physics as they are (below), the right
  stick turns the camera at a rate (`PAD_LOOK_RATE` 2.6 rad/s at Look
  Sensitivity 1, scaled by dt — unlike the mouse, it is a rate), and the
  triggers go through `_padButtons`, which does what the mouse buttons going
  down and coming up do.
- **In a menu** it moves a focus ring (`.padFocus`) from control to control by
  where they are on screen (`toward`: the nearest in that direction, straight
  on preferred), presses the one it is on, and knows what "back" means on each
  screen (`SCOPES`, topmost first). No screen is written for it: it finds the
  controls of whatever is on top (`FOCUSABLE`), so a new button or setting
  works with a controller as soon as it exists. A new *screen* needs a row in
  `SCOPES`. A screen that has only just come up, or a controller only just
  picked up, first shows where the ring is (on the screen's main button:
  `firstFocus`); the press that brought it does not also move the ring or
  press what it landed on. The inventory rebuilds its slots on every change, so the ring is
  put back on the same slot by its `data-slot-*`; a carried item rides on the
  slot the ring is on.
- **No pointer lock.** The game normally plays only while the pointer is
  locked to it, and a page may take the pointer only in answer to a click or a
  key — which a controller button is not. So while the controller is the
  device in use (`__wwPad.active`: the last input came from it) play does not
  wait for the lock: `world.js` takes `__wwPad.play` as leave to run the
  controls, pausing and resuming set `paused` themselves, and
  `requestGameLock` does nothing. Touch the mouse or a key and the controller
  steps back until its next input; with no lock held, Esc pauses by itself.
- **A split screen's further panes** are each one controller's (`?pad=<index>`,
  `MY_PAD`): that pane reads only that controller, is "the device in use"
  from the start, and never hands over to a mouse or keys. The first pane
  takes any controller that has not been given a pane (`__wwSplit.padTaken`).
  `__wwPad.index` says which controller a pane is using.
- **Typing a name** is on a telephone keypad (see *Names*): on that screen X
  rubs out, Y is a space and Start is Done.
- Nothing runs unless a controller is connected (the frame loop starts on
  `gamepadconnected`). The controller is read once a frame, so a press shorter
  than a frame can be missed — the smoke test holds its made-up buttons for
  whole frames for that reason.

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

- **A stick moves as far as it is pushed.** `input.moveF` / `moveR` (forward
  and right, −1 … 1) are added to the keys' direction, and the result is only
  cut back to length 1, not stretched to it: keys alone are 0, 1 or √2 long,
  so for them nothing changed, and a stick pushed half way walks at half
  speed.
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
- **A long frame is taken in steps** (`MAX_MOVE`, `_substeps`). Collision
  tests the box where a move ends, not the way there, and a move that would
  end inside something is refused whole. At ten frames a second a long fall
  covers five blocks a frame: the player stopped dead up to that far above the
  ground, took the fall's damage there, and then fell the rest — or ended
  beyond a floor one block thick without touching it. A frame that would move
  the player further than 0.45 blocks is therefore split into equal steps (at
  most 8). At a steady sixty frames a second only a fall of ten blocks or more
  is that fast, so nothing else changes; a slow machine now plays by the same
  rules as a fast one (`test/physics.test.mjs`: the same landing and the same
  damage at 10, 20, 30, 60 and 144 frames a second).
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
  - fog far  = `view × 16 × FOG_END` (1.00)
  - fog near = `min(view × 16 × fogStart, far − FOG_MIN_FADE)`
    (`fogStart` is the Fog Distance setting, 0.82 by default; the fade is never
    narrower than 12 blocks)
  - `view` (`_viewChunksOut()`) is the render distance, plus the Far Terrain
    distance while that is on — the fog then hides the end of the far terrain,
    not of the chunks. Far terrain covers its square to the same guarantee as
    the chunks (below), so everything said here holds for either edge.

  The chunk shader measures fog **horizontally, as `(x⁴ + z⁴)^¼`** from the
  camera (`edgeDistance`) — a rounded square, like the square of loaded chunks.
  That distance is never less than the larger of |x| and |z|, and from anywhere
  in the player's chunk the loaded square reaches at least `renderDistance × 16`
  along both axes, so fog is complete before the load edge in every direction,
  while the square's corners, which a circle would hide, stay visible. Chunks
  that unload as the player crosses a chunk boundary, and the new ones that
  arrive, are all beyond that distance, so they come and go unseen. It used to
  be view depth, which also changed with where the camera pointed: a turn of
  the head fogged or unfogged the same hillside. Weather fog (`weatherFog`) is
  separate and physical.

  Fog — not the far plane — is what limits how far the player can see.
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
fragment shader applies it from `vWorldPos` (`applyFog`). Shading the terrain
is the largest part of a frame on integrated graphics (see *Where a frame
goes*), so what a pixel does not need it does not work out: no weather fog in
clear weather, no fog colour inside the distance the fog begins at, nothing
of `weatherSurface` on dry ground. Each of those gives exactly what the full
sum would. It also applies brightness
and the colourblind transforms via `uBrightness` / `uColorMode`. Those used to be
a CSS `filter` on `<body>`, which pushed the whole page — canvas included —
through an extra compositing pass every frame, so enabling an accessibility
option cost frame rate.

Everything the terrain shares — fog, sky, weather, shadows, display settings —
lives in the `chunkUniforms` object, so one write updates all terrain. Each
chunk has its own material pair (for its light textures, below), but **a chunk
material does not carry `chunkUniforms`**. Three.js uploads a material's whole
uniform list whenever the material changes, so every chunk draw used to re-send
some eighty shared uniforms: 15% of the main thread at render distance 14, more
than the draw calls themselves. Uniforms belong to the GL program, and all
chunk materials of one kind run the same program, so:

- **Two primer meshes** (`_makePrimers`: one opaque, one transparent, a single
  zero-area triangle each, `renderOrder` −1e9 so they sort first in their pass)
  carry the full `chunkUniforms` and upload it once per `render()`.
- **A chunk's materials carry only** its two light textures, `uChunk` (below)
  **and the shared samplers** (`_perDrawUniforms`). A sampler takes its texture
  unit from its place in the material's upload, so one left out would keep the
  primer's unit while the chunk's light textures took the same one. They are
  picked out of `chunkUniforms` by value (a texture, or not set yet), so adding
  a sampler to the shared GLSL needs no change there.

A new uniform that differs per chunk must go in the per-chunk set; anything
else added to `chunkUniforms` reaches the chunks through the primers. Never
`material.clone()` a chunk material: that deep-copies the uniforms and cuts the
chunk off from its samplers. The far-terrain material still spreads
`chunkUniforms` itself (one material, one upload).

What differs per chunk is its two light textures — `uLight` (sky) and `uBlock`
(block light; a shared empty texture for the many chunks with none) — and one
array uniform, **`uChunk`** (`vec4[2]`, a `Float32Array(8)`, one upload per
draw), which the shaders read through macros (`CHUNK_UNIFORM_GLSL`):
`uChunkRel` (the chunk's origin relative to the camera), `uChunkTile` (below),
`uLightY` (the sky-light volume's first level and height) and `uBlockY` (the
block-light volume's; height 0 = none). As separate uniforms they were up to
three GL calls per draw. The shaders never read `modelMatrix` or `modelViewMatrix`, so
Three.js uploads neither: chunks are only ever translated, and `_viewChunks`
works out `uChunkRel` in doubles each frame, so the vertex shader stays
camera-relative (`mat3(viewMatrix) * rel`) and is as precise far from the
origin as the matrices were. Two 4×4 matrix uploads per draw were once the
largest single cost of submitting a frame. The light lookup uses chunk-local
position (`vLocal`) for the same reason.

**Patterns laid over the ground** (the blend line, the large-scale variation)
need a world position that is exact however far the player has walked, and
`vWorldPos` is a float sum that is not: `tilePos()` builds one from `vLocal`
and `uChunkTile`, the chunk's place in a tile of 64 × 64 chunks (x + 64·z, one
float). It repeats every 1024 blocks, so anything read with it must too.

### Drawing chunks cheaply

A frame's main-thread cost is mostly draw submission — about 35 µs per draw on
a low-power laptop CPU — so the chunk path keeps draws few and each one light:

- **Culling by box, per pass** (`_cullChunks`). A chunk column's geometry runs
  from cave floors to peaks, so its bounding sphere is ~100 blocks across and
  Three.js's sphere test let through most chunks beside and behind the camera
  and far outside the shadow box. Chunk meshes have `frustumCulled = false` and
  are shown or hidden against their real box (`_chunkBox`, 1 block of margin for
  swaying leaves) — for the shadow camera (`ShadowMapper.onCull`), then the view.
  At render distance 10 that took the view from 331 draws to 209.
- **Only what the camera could see.** Half the triangles of a frame and more
  were cave walls nobody could see; they are left out, a range of indices a
  chunk. See *What the camera cannot see* below.
- **The sky last, not first** (`Sky.js`). It is at the far plane and drawn
  after the terrain, so it is only shaded where no land is. Drawn first,
  without depth, it was worked out for every pixel of the screen and then
  painted over.
- **Water far to near**, by chunk (see *Two Output Meshes*).
- **Front to back.** `renderer.setOpaqueSort` orders opaque objects by depth
  only. Three.js sorts by material first, and every chunk has its own material,
  so the default order was simply creation order; nearest-first lets the GPU
  reject hidden fragments before running the chunk shader.
- **Static matrices.** Chunk meshes have `matrixAutoUpdate = false` and hang
  under `chunkGroup`, whose `updateMatrixWorld` does nothing: each mesh's world
  matrix is set once when it is made, and Three.js no longer walks every chunk
  mesh on each `render()` to find nothing changed. In the view pass
  (`_viewPass`) a chunk mesh's `modelViewMatrix` and `normalMatrix` are not
  composed either (`_chunkModelView`) — the chunk shaders read neither; the
  shadow pass, whose depth shader does, still gets them.
- **Shared uniforms once a frame, not once a draw** — the primers (see *Chunk
  Shaders*).
- **Upload queue** (`_meshQueue`, `_drainMeshQueue`). Worker results arrive in
  bursts; each is a geometry upload, a light texture and, for a new chunk, two
  materials. They are installed nearest-first, at least 4 per frame (more as a
  backlog grows, all of them while the loading screen is up). Chunks within 2 of
  the player skip the queue so edits show at once. A queued mesh's light is
  dropped if a newer light-only result is applied first.
- **No CPU copy of the vertices.** Chunk attributes release their arrays once
  uploaded (`_releaseArray`); nothing reads them on the CPU. That removed about
  a third of the JS heap at long render distances. Anything that needs chunk
  vertices on the CPU later must get them from the worker instead.
- **Shaders warmed at load** (`_warmShaders`). ANGLE finishes a shader on its
  first draw — 100–550 ms on integrated graphics — so everything that can appear
  later (selection outline, mob and item materials, precipitation, lightning,
  tornado, fancy-cloud march) is drawn once into a 1-pixel scissor while the
  loading screen is up. `renderer.compile()` alone does not do it.

`npm run bench:render` measures all of this on the real GPU.

### Where a frame goes

Measured on an Intel integrated GPU at 1920 × 1080 with the frame cap off, by
switching one thing off at a time (uniform branches in the chunk shader, put
in for the measurement and taken out again). Of a Classic frame of about 8 ms:

| Part | ms |
|---|---|
| Lighting and shading the terrain's pixels — the sky-light lookup 0.9, the ground's blend and large-scale variation 0.7, cloud shadows 0.3, the rest of the sum 1.5 | 3.4 |
| The sky — all of the screen, most of it under terrain that then covered it | 0.8 |
| Cave walls nobody could see, as triangles (1.8 of Pro's 10) | 0.3 |
| Everything else: the visible triangles, filling the screen, and the browser putting the canvas on it | about 3.5 |

So the pixels are what a frame costs: at half the resolution a Classic frame
took 3.7 ms instead of 9, and Pro 6.1 instead of 10.1. Texture filtering (4×
anisotropic or none) made no difference that could be measured, nor did the
fog, the Simple or Pretty sky, Far Terrain, or fast against fancy clouds on a
sunny day; shadows cost Pro about 0.9 ms. Simple, at a short render distance,
is nearly all pixels: leaving the caves out of it changes nothing there.

That makes the screen's pixel count the thing to watch. The drawing buffer is
`min(devicePixelRatio, 2) × resolutionScale`, so a laptop panel at 150% or
200% scaling draws two to four times the pixels of the 1080p these numbers
were taken at, at every preset.

With 60 Hz pacing (`BENCH_VSYNC=1`) every preset holds 60 here with no frame
over 18 ms, the fly-over included, and the main thread is busy 0.8 ms a frame
at Simple, 1.1 at Classic, 1.9 at Normal and 2.2 at Pro. (With the cap off the
main thread outruns the GPU and stalls for hundreds of milliseconds waiting
for it — inside whatever GL call it happens to be making. That is the
benchmark, not something a player sees: the frame rate it prints is how fast
the GPU gets through frames.)

### What the camera cannot see (`engine/Visibility.js`)

Caves are 58–66% of a chunk's triangles (see *Caves*), and a chunk is one mesh
from its cave floors to its peaks: every one of them was drawn whenever its
column was in view, though from the surface none can be seen. Now a chunk
draws only the part of itself the camera could see at all. It is worked out
from where the camera is, not from where it looks, so turning costs nothing.

- **Sections.** A column is cut into 28 sections of 16 levels. The mesher puts
  the opaque triangles in order of section (`geo.sections`), so a run of
  sections is one range of indices and a chunk is still one draw.
- **What is open inside each** (`geo.conn`, with every mesh job). A cell is
  open when sight can pass through any of it: everything but a full opaque
  cube, so in a smooth world a Mesh voxel cut to a shape is open however
  little is cut away. For each section the worker finds the regions of open
  cells and the faces of the section each touches: every face a region
  touches is joined to the others it touches. Six bytes a section. It reads
  no voxel for it — the mesher's row words (`closedRows`) say which cells
  are closed — and gathers the open cells into runs along x, joining runs
  that touch in the row beside or below (union–find over a few hundred runs,
  where a flood cell by cell was four thousand cells a section):
  about 0.2 ms a chunk.
- **The search** (`SectionVisibility`, on the render thread). A straight line
  never turns back along any axis, and inside each section it passes it runs
  through open cells from the face it came in by to the face it leaves by. So
  every section a line of sight reaches is reached by a walk from section to
  section that only crosses faces joined by open space and never steps back
  toward the camera on any axis. All such walks are followed, breadth first:
  0.1 ms at render distance 8, 0.3 at 14. What they do not reach cannot be
  seen.
- **When.** When the camera moves into another section, and when a chunk's
  mesh comes or goes — at most every 0.15 s for that, since while terrain
  streams in one does every frame, but at once for an edit beside the player
  (it may have opened a cave). A chunk meshed since the last search is drawn
  whole until the next.
- **It errs on the side of drawing.** A face belongs to the section of the
  open cell in front of it, which for a face on a chunk's edge is in the next
  chunk: a section is drawn when it, or the one beside it in any of the four
  chunks round it, is reached. One section more is drawn above the highest
  reached: on a diagonal slope a smooth surface belongs to the voxel over the
  one it dips into. A chunk draws everything from its lowest section needed to
  its highest, as one range. Chunks not there yet are open.
- **Only in the open.** Sight is followed through open cells, so a spectator
  flying through rock — who looks out through it — gets everything drawn
  (`_cameraInRock`).
- **Only the view.** The shadow pass draws every chunk whole, as it always
  has: what casts a shadow into view need not be in view itself. Water and
  ice are drawn wherever their chunk is in view. The view frustum is tested
  against the box round the sections drawn (`viewBox`), so a chunk whose only
  part in view is caves nobody can see is not drawn at all.

From the surface 23–75% of the triangles are left (38–48% round the
benchmark's spawn); deep in a sealed cave, 1–5%, with most chunks not drawn
at all. On integrated graphics that is +21% frames at Pro (95 → 116
with it switched off and on in one session), which is limited by its
triangles, and +4% at Classic and Normal, which are limited by their pixels.

**What must hold**: nothing that shows is left out. `test/visibility.test.mjs`
follows 30,000 lines of sight cell by cell from each of a dozen cameras —
over the land, high above it and down in its caves — through real generated
terrain, blocky and smooth, and whatever each ends on must be in the range
its chunk draws; and it checks the section order of every triangle, and the
joined faces against a cell-by-cell flood. `npm run shots -- --cull-check`
is the same question asked of the real game: it draws each view with and
without leaving things out and compares the frames (378 of them, over twenty
landscapes and the caves under them: nothing missing from any). Lone pixels
do differ, a few a frame, and must: the mesh has pinholes — gaps a pixel wide
where triangles meet — and through one you see whatever comes next behind the
land, which with everything drawn can be a cave wall nobody could otherwise
see. The check counts the pinholes that open onto the sky, and leaving things
out opens no more of them. `window.__wwCaveCull(false)` draws everything, and
`__wwDebug().visibility` says what is being left out.

### Far Terrain (`src/scripts/FarTerrain.js`, Graphics → Far Terrain)

Past the last loaded chunk the land goes on at low detail for another 16, 32
or 64 chunks (`farTerrain`; `_farExtra` in `world.js`, 0 = off). No voxels are
generated there: it is the geography drawn as a heightfield, with the trees
and buildings the chunks there have standing on it as simple shapes, and what
the player has built showing too. Nothing under the surface is in it — no
caves, no overhangs: a column is its top.

- **Tiles** (`workers/FarTiles.js`, the `farTile` job) are 64 × 64 cells. A
  cell is 4 blocks in the nearest tiles (256 blocks across) and doubles with
  each level of a quadtree further out (`selectFarTiles`): a tile splits while
  the player's chunk is nearer it than its own size, so a cell always spans
  about 1/64–1/128 of its distance, and the ground of every tile costs the
  same to build and to draw. One draw call each, before culling.
- **A tile stays until the chunks that replace it are there.** The selection
  covers the whole view, the loaded area included, and each tile is drawn until
  every chunk over it is meshed — chunk by chunk, through the mask below. So
  land that is still loading, ahead of a player flying faster than chunks
  arrive, shows as far terrain rather than as a hole. (Tiles under the loaded
  area used to be dropped two chunks in from its edge whether the chunks there
  had arrived or not.) A tile that lies wholly under meshed chunks is not
  drawn (`_hideCovered`), and one that does so well inside the loaded area is
  not even built (`_needed`); within `LEAD` (3) chunks of the load edge they
  are built anyway, to be ready the moment chunks there unload. While the
  loading screen is up the tiles under the player wait: that land is about to
  arrive as chunks.
- **Trees and buildings** (`FEATURE_STEPS`, the two finest levels). The
  generator's `farFeatures` walks the structure placer's own cells and makes
  its own choice (`StructurePlacer.farScan` → `_typeAt`, the rule the chunks
  use), so a far tree stands where the chunk will have one — the worker test
  generates the chunks under a tile and finds a trunk or leaves under 98% of
  them. What the rule is told about a spot comes from the tile's lattice (the
  nearest point's biome and slope, the height between points), which is where
  the rest come from. Each prebuilt shape is boiled down to boxes
  (`StructurePlacer.proxies`): a trunk and a crown narrowing toward its top
  (a pyramid for a conifer), walls and a roof drawn in to its ridge. A wood has
  a tree every few blocks, which is where the triangles would go, so there
  the trunks are left out and every other tree, the rest drawn a little
  bigger; one level out everything is a pyramid and one in two (one in four
  in a wood). Further still a forest is its canopy, raised and tinted, as
  before. A shape's vertices carry the offset to its foot, and the shader
  asks about the chunk *there*, so a whole tree gives way to the real one at
  once.
- **What the player has changed.** Far terrain is drawn from the generator,
  which knows nothing of it. So an edited chunk leaves a summary of its
  surface behind when it is saved or unloaded (`_summariseEdited` in
  `world.js`: each column's highest block and which block it is, 1 KB a
  chunk; `WorldState.edited` marks the chunks). `FarTerrain.setEdit` lays
  them over the tiles they fall in — the tile is built again with them in the
  job (`edits`), replacing the generated surface and its trees there — and
  the server keeps them with the world (`far-edits.json`, `GET` / `PUT
  /api/worlds/:id/far-edits`), so a tower shows from far off the next time the
  world is opened too.
- **Heights and colours** are the surface the chunk there would have
  (`farSample`, and `farGrid` for a whole lattice): its top block — snow, rock
  on steep ground, sand, patches — in its top texture's average colour
  (`farPalette`, from `_farPalette` in `world.js`, sent in `init`); water at
  the chunk shader's 0.72 over its bed; ice; and forest as a canopy, raised by
  the trees' height and tinted by their leaves (`StructurePlacer.canopy`).
  The current generator samples a tile's lattice in one pass of
  `Geography.region(ox, oz, w, step)`, whose coarse mode takes gradients
  (coast and river distances, slope) across the lattice: exact at step 1 (the
  worker test checks it), within 2 blocks of the chunks at step 4 almost
  everywhere. 35–50 ms a tile on a laptop CPU, a quarter of the cost per point
  of sampling column by column. Jobs run at priority 2.5, behind all chunk
  work, at most three at a time. Legacy worlds sample the old generator the
  same way (`LegacyWorldGen.farSample`).
- **Between tiles**: neighbours of one step share their edge vertices exactly
  (heights, colours, and normals taken from one sample beyond the edge); where
  the step changes, skirts hanging from every edge cover the cracks — emitted
  in both windings, since the material culls back faces.
- **Giving way to the chunks.** `uFarMask` is a 64 × 64 R8 texture, one texel
  per chunk around the player, set where `chunkMeshes` has a mesh and redrawn
  when one comes or goes. The fragment shader discards inside those chunks;
  the vertex shader sinks every vertex touching one by `SINK` (32) blocks, so
  from the last vertex outside, the surface dips under the chunk edge. That
  closes the seam wherever far terrain comes out higher than the chunk edge it
  meets (a canopy, a valley narrower than a cell), which would otherwise show
  the sky through a crack. A chunk loaded but not yet meshed shows far
  terrain, so a hole in the world fills in.
- **Swapped as a set.** A new selection (the player crossed a chunk) goes on
  screen only once every tile it needs is built; until then the old one
  stays up, so no gap opens while tiles are on their way. Tiles out of use are
  kept (least recently used first out, at least 24) for when the player turns
  back.
- **Drawing**: one shared `ShaderMaterial` (`FAR_VERT` / `FAR_FRAG` in
  `world.js`) on the chunk uniforms plus the mask's, ending in the chunks' own
  fragment tail (`CHUNK_COMMON`) — the same fog, sun and moon, cloud shadows,
  lightning, wet ground and display settings, lit as open sky, without sun
  shadows. `renderOrder` 1, after the chunks, so their depth hides most of it
  before it is shaded; not on the shadow layer. It uses `modelViewMatrix`
  (composed in doubles on the CPU, so camera-relative and precise far out) and
  recovers the offset in world axes with `transpose(mat3(viewMatrix))`.
- **Fog and clouds** move out to its end (`_viewChunksOut()`, see *Scene
  Setup*); `camera.far` (4096) already reaches it.
- **Cost.** The ground is what it was (about 11k triangles a tile). The shapes
  add to it where there are woods: at render distance 6 with +32, looking over
  dense forest, about 100k triangles across all 32 tiles on top of the
  ground's 360k (20k shapes), a third to a half of them in view. Drawn in full
  — every tree, with its trunk, at both levels — it was 840k, which is why
  they are thinned. The main thread only uploads finished tiles.
- `__wwDebug().far` reports `extra`, `wanted` (tiles the selection needs
  built), `shown` (how many of them are on show — equal to `wanted` once far
  terrain has caught up), `selected`, `drawn`, `cached`, `inflight`, `built`,
  `tris`, `features` and `edits`. `npm run shots -- --far 32` screenshots with it on (the
  `panorama`, `far-range` and `edge` views look into the distance), and the
  smoke test runs its weather scenes with it on and checks every tile was
  built and shown and the fog moved out.

### Lighting

The sky, one moving light — the sun by day, the moon by night (see *Day
Cycle and Weather*) — and block light from torches, lanterns and lamps. All of
it is worked out per pixel in the chunk shader (`lighting()` in `world.js`) from
the mesher's per-vertex normal `n`, interpolated, so smooth terrain is shaded
smoothly. A surface's brightness is

```
sky    = skyLight × (A·ambient + (1−A)·max(0, n·L)·lit·direct) / SUN_TOP
result = texture × (sky + torch × shade × max(0, 1 − luminance(sky)))
```

- `A` is `SUN_AMBIENT` (0.5), the sky's share — what a face turned away from
  the light, or in shadow, keeps. `SUN_TOP` (`engine/Sun.js`) scales a flat top
  at noon under a clear sky to exactly 1, so noon looks as it always has.
- **Block light** (`torch`) fills the headroom the sky leaves: all of it at
  night or underground, nothing at noon. Adding it, rather than taking the
  brighter of the two per channel, keeps the edge of a torch's pool from
  turning lilac against moonlight. `shade` (0.8 + 0.2·n.y − 0.1·n.x²) keeps
  blocks' shape readable in torchlight. It is warm (`TORCH_COLOR`), independent
  of the time of day, and flickers a few percent (steady with Reduce Motion).
- **Glowing blocks** (`glow`, in the normal's fourth byte) skip lighting and are
  drawn full-bright; with Eye Adaptation their bright texels go to `GLOW_HDR`
  (2.6× white) so flames and lamps bloom and pull the exposure down.
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
  - Output is the chunk plus a one-block border over its filled Y band — **from
    the floor up**: the levels below it are all 0 and are left out. The row at
    the floor is all 0 too, so the shader's lookup, which clamps to the bottom
    row, and the CPU's (`_skyBrightnessAt`, darkest below the volume) read what
    those rows would hold. With bedrock at local y 0 they were about three
    quarters of every volume (`npm run bench:pipeline` prints both counts: 60
    levels of 260 around the bench's spawn), held on the CPU and again as a
    texture; what is left is 14 MB each at render distance 14. Stored ×17 so
    it uploads as a normalised R8 `Data3DTexture` with linear filtering.
    Opaque cells hold their brightest open neighbour, so interpolation never pulls
    a surface toward black and smooth slopes (which cut through opaque cells) get
    the light of the air above. One with no open neighbour takes what the opaque
    cell over it holds, or the one over that: on a diagonal slope the surface
    over a block is in the block under it, which would otherwise be a dark
    spot. Block light does the same.
  - The shader samples it, in chunk-local coordinates (`vLocal`, `uLightY`),
    half a block in front of the surface along the normal. The normal is never
    turned toward the camera: a smooth normal can lean a little away from it
    near a silhouette, and flipping it would blacken the edge. Water and ice
    need no turning: each of their faces is in the mesh once for each side,
    with that side's normal, so the surface seen from below reads the light
    under it.
  - `ChunkManager` numbers light jobs per chunk and drops a result older than the
    one shown (`_freshLight`). An edit relights all eight neighbours — at 15
    blocks' reach and 16-wide chunks, every edit reaches them.
- **Block light** (`workers/Blocklight.js`): a light source holds its level in
  its own cell and spreads through non-opaque cells, one level per block — the
  sky-light spread without the sky. A lamp is opaque but still shines out.
  - Same region (chunk + 15-block margin from all eight neighbours) and output
    layout as sky light, so seams agree (`test/light.test.mjs` checks shared
    cells across edges and corners) and an edit's eight relights cover it.
  - Almost every chunk has none: the worker checks the nine chunks' palettes
    first (`paletteHasLight`) and sends `light.block = null`. Otherwise only the
    slice of levels the light can reach is solved and sent — a torch lights about
    thirty levels, not the column.
  - The CPU reads it too (`_blockLevelAt`), so mobs and block-break debris are
    lit by torches (`_lightAt`).
- **The light in the player's hand** (`uHandLight`): an item's `heldLight` in
  the selected hotbar slot or the offhand, eased in and out. It falls off one
  level per block of straight-line distance from just below the eye. It is not
  blocked by walls, but it sits at the camera, so any surface the player can see
  is one it can reach — nothing visible is lit through a wall.
- **Shadow** (Graphics → Shadows): `sunShadow()` returns the lit fraction; in
  full shadow only the ambient part is left. The pass is skipped when there is
  no direct light (deep twilight).
- **Sky and fog colour** follow the sky light at the camera (Atmosphere,
  `_skyLit`), eased over ~0.5 s. Underground a sky-blue background would show
  through sub-pixel gaps between triangles and fog distant tunnels to blue.
- **Mobs and debris** are drawn with Lambert materials, so they read the light
  on the CPU (`_lightAt`: `_skyBrightnessAt` × `Atmosphere.mobLight`, plus block
  and held light the same way the shader adds them) and scale their colour;
  each mob has its own material copies for this. Dropped item sprites are not
  dimmed yet.

### Eye Adaptation (`src/scripts/PostFX.js`, Graphics → Eye Adaptation)

Auto-exposure with a little bloom. It changes only how the frame is displayed —
light levels, and everything the game reads from them, are untouched.

- **The scene goes to a float target** instead of the canvas, in linear light
  with nothing clipped: R11G11B10F (4 bytes a pixel) where
  `EXT_color_buffer_float` allows, else RGBA half float. Without either the
  setting does nothing.
- **Colour space.** The game's own shaders write display (sRGB) values; that is
  what the canvas wants. Every one of them hands its colour over through
  `displayOut()` (`OUTPUT_GLSL` in `AtmosGLSL.js`), which converts to linear
  while `uLinearOut` is set — one shared atmosphere uniform that `_render()`
  sets around the scene pass. Three.js's own materials (mobs, dropped items,
  debris, the outline) make the same switch themselves: a program compiled for
  a render target writes linear. The fancy clouds' half-resolution target holds
  premultiplied display values; its composite un-premultiplies to convert.
  **A new shader must end in `displayOut(…)`**, or it will look too bright with
  Eye Adaptation on.
- **Downsample**: five levels, 1/4 … 1/64. Scene → 1/4 is an exact 4×4 box
  (four bilinear taps, firefly-clamped); each later level a 13-tap filter.
  Starting at a quarter keeps the effect cheap: a 13-tap 1/2-resolution level
  cost more than everything else in it.
- **Meter**: one pixel reads the 1/64 level over a 16×9 grid, four taps a cell,
  centre-weighted. It takes the *mean* luminance, with anything brighter than
  white (flames, lamps, the sun) counting `GLARE` (2) times over — looking at a
  light pulls exposure down, so the dark around it looks darker and the light
  does not wash out the frame. It eases toward that at 3/s getting brighter and
  0.6/s getting darker, in a ping-ponged 1×1 target. Nothing is read back to
  the CPU (`__wwExposure()` does, for diagnostics only).
- **Exposure**: 1 between `METER_LO` and `METER_HI` (0.05–0.45 linear), so
  daylight looks exactly as it always has; below, up to +1.6 stops (×3); above,
  down to −1.5. Measured: daylight 1.0; night looking away from a torch ≈ 3,
  looking at it from four blocks ≈ 1.2–1.5, up close 1.0; a sealed dark room 3.0.
  World load and respawn snap to the right exposure instead of adapting.
- **Bloom**: the levels are added back up the chain (9-tap tent) and 5% of the
  result is mixed in — no threshold, so only very bright pixels show a glow.
- **Composite**: scene + bloom, × exposure, a soft shoulder above 0.7 (bright
  lights keep a little colour instead of clipping), sRGB, ±½/255 dither.
- **Cost**: about 0.4–1 ms a frame at 1080p on an Intel iGPU (Normal preset,
  `normal` vs `normal+eyeAdaptation=off` in `npm run bench:render`).
- Toggling it re-runs `_warmShaders`, since every material now draws into a
  different kind of target and would otherwise compile on the next frame.
  `__wwDebug().drawCalls` counts the scene pass only (it is read right after it),
  not the post passes.
### Graphics presets (Settings → Video → Graphics)

`GRAPHICS_PRESETS` in `main.js` sets every graphics-quality option at once:

| Preset | Render dist. | Far Terrain | Resolution | Fog | Shadows | Clouds | Sky | Particles | Eye Adaptation | Max FPS |
|---|---|---|---|---|---|---|---|---|---|---|
| Simple | 5 | off | 75% | 72% | off | fast | simple | low | off | 60 |
| Classic (default, the original) | 8 | off | 100% | 82% | off | fast | simple | medium | off | unlimited |
| Normal | 10 | 16 | 100% | 86% | medium | fast | pretty | medium | on | unlimited |
| Pro | 14 | 32 | 100% | 90% | high | fancy | pretty | high | on | unlimited |
| Custom | whatever the player sets | | | | | | | | | |

`GRAPHICS_CONTROLS` maps each value to its form control and type; adding an
option is a row there plus its markup in `game.html`. Moving any of those
controls switches the dropdown to Custom (seeded from what was showing); picking
a preset moves the controls. A saved Custom set is merged over Classic, so
options added later start at Classic's value. `main.js` resolves the choice and
sends the values in `applySettings`; all apply live.

- **Fog distance** is `_fogStart`, the clear fraction of the render distance (see *Scene Setup*). The presets were raised when fog became square and started ending at the nearest the load edge can be.
- **Far Terrain** (`farTerrain`, chunks past the render distance: off / 16 / 32 / 64) — see *Far Terrain*. The fog moves out to its end.
- **Max frame rate** (`_maxFps`, 0 = unlimited) is enforced in `gameLoop` by
  skipping display refreshes; dt is measured from the last frame actually run.
  The 2 ms tolerance stops a 60 cap on a 60 Hz display dropping every other frame.
- **Shadows** (`src/scripts/Shadows.js`) — a shadow map for the current light
  (sun or moon, `setLightDir`), from an orthographic camera around the player,
  using an override depth material that alpha-tests textures (glass casts its
  frame) and skips water and ice. The chunk shaders call `sunShadow()` (`SHADOW_GLSL`): normal offset, 3×3
  PCF on medium/high, fading out toward the covered radius around the player
  (`uShadowFocus`, `uShadowFade`). Its uniforms are spread into `chunkUniforms`.
  Levels (`SHADOW_LEVELS`) set map size and covered radius; off skips the pass.

  **The terrain's depth is cached** in its own target and redrawn only when it
  changes: the light re-aims (in ~0.35° steps — continuous re-aiming makes edges
  shimmer — never below y 0.12), the box moves (in steps of radius/8, whole
  texels; the box is half a step wider than the radius so the player is always
  covered), or `invalidate(box)` reports a chunk change inside it. Chunk changes
  redraw at most every 0.25 s (`TERRAIN_REDRAW_MIN`) — streaming changes some
  chunk in the box almost every frame — except `urgent` ones next to the player,
  which redraw on the next frame. Chunks are on `SHADOW_LAYER` (1); mobs are on
  `SHADOW_DYNAMIC_LAYER` (2), because they move every frame: while any stand
  inside the box they are drawn each frame over a copy of the terrain depth,
  and only the patches of that copy a mob was drawn into are put back from the
  terrain map before the next frame's are drawn (`_restore`: one small blit a
  mob, from the sphere round it that `EntityManager.shadowCasters` gives). It
  used to copy the whole map every frame there was a mob anywhere in the
  world — 4 million texels at medium, 9 at high — which took 8–27% off the
  frame rate whenever shadows were on and a mob was about; now mobs cost the
  shadows nothing that can be measured.
  (Three.js's `copyTextureToTexture` cannot copy part of a depth texture: it
  hands `blitFramebuffer` a width and height where corners are wanted. The
  blits are made directly, through the renderer's own binding cache.)
  Standing still or looking around, the terrain pass costs nothing;
  `__wwDebug().shadowRedraws` counts them, and `shadowCopies` the whole-map
  copies (one after each terrain redraw while there are mobs).
- **Clouds** (`src/scripts/Clouds.js`) — `fast` | `fancy`: how many steps the
  march takes and how the cloud is lit. No off (the weather decides the cloud;
  Fully Clear is the cloudless sky). See *Clouds* under *Day Cycle and
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
  (`Climate.at`: in current worlds the temperature and humidity of the column
  the player is over — `Geography.column`, the same values the terrain used —
  cooled to the player's height at the terrain's lapse rate, and that column's
  biome's `weather`; in legacy worlds the old blend of the old biomes, −0.0022
  per block above y 90): below `COLD_TEMP` rain becomes snow, below `MARGINAL_TEMP` sleet or
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
| `Sky` | 1 | Camera sphere at the far plane, drawn after the terrain and depth-tested, so only the pixels no land covers are shaded (it used to be drawn first, over the whole screen); everything blended — clouds, water, rain — still comes after it. Simple: flat colour, square sun/moon/stars. Pretty: gradient, glow toward the sun, halo, sphere-lit moon with the real phase terminator, twinkling stars rotating with the sky. Horizon is always `fogColorFor(dir)`, so terrain never seams against the sky. |
| `Clouds` | 0–2 | A slab of air from `CLOUD_BASE` to `CLOUD_TOP` with cloud in it, drawn once a frame off screen by following every line of sight through it (fast: 6 steps, shaded by thickness; fancy: 14, lit through the cloud above each point), at half resolution into a premultiplied target. See *Clouds* below. Nothing when the sky is clear. |
| `Precipitation` | 0–6 | Instanced quads positioned entirely in the vertex shader from fixed seeds + wrapped fall/drift offsets. A particle shows when its rank is below the rain intensity at its column. `RainHeightmap` (highest block per column around the player, 9×9 chunks, from each mesh job's `geo.rain`) hides particles under roofs, trees and in caves and seats splashes. |
| `Lightning` | 0–1 | Midpoint-displaced channel + branches, 1–4 return strokes. Pool of 3 bolts. Flashes light sky, clouds and open ground. |
| `Tornado` | 0–2 | Rope-bending funnel + orbiting debris. Pulls and lifts the player within 45 blocks. |

### Clouds (`Clouds.js`, `CLOUD_VEIL_GLSL` in `AtmosGLSL.js`)

The cloud layer used to be one plane — at the layer's base, or at its top once
the camera was past the middle — drawn after everything else. Flying or
building at that height put the plane on one side of you and flipped it to the
other half way up, and since it was drawn last it was painted over every piece
of water or ice whether or not the cloud was in front of it.

Now the clouds are a volume, and **one picture of them serves everything**:

- **The picture** (`uCloudRT`, `Clouds.prerender`): a full-screen triangle
  marches each line of sight through the slab, from wherever the camera is —
  below, above or inside it (`cloudSpan`: at most `CLOUD_REACH` 360 blocks of
  it; from inside, the steps start short and lengthen, and that change-over is
  gradual so entering the layer shifts nothing). It holds the cloud along the
  *whole* of each line, premultiplied, at half resolution: soft cloud looks the
  same from a quarter of the pixels, and at full resolution the fancy march
  cost a third of a frame on integrated graphics.
- **The sky** shows it as it is: the backdrop, one triangle at the far plane,
  depth-tested, so it lands only where no terrain was drawn. It is the first
  of the blended things (`renderOrder` −1e8), under water and everything else.
- **Every terrain surface** — the chunk shaders, far terrain — takes the share
  of it that lies between the camera and itself (`cloudVeil`, the last step of
  `grade()`): none if the surface is on the camera's side of the layer, all of
  it if the surface is beyond the layer, and in between the part of the way
  through that the surface is, as if the cloud were even along the line. So a
  peak in the cloud fades into it, a wall two blocks away inside a cloud is
  barely veiled, and water is behind or in front of cloud as it should be —
  each blended surface carries its own veil, which composes exactly with
  ordinary alpha blending, so **nothing depends on draw order**. No depth
  buffer is read, so it costs the same with Eye Adaptation off.
- What does not go through the chunk shaders gets no veil: mobs, dropped
  items, debris, rain. In cloud they show a little too clearly.
- The picture is a sampler in `chunkUniforms`, picked up per draw like the
  others (`_perDrawUniforms`); `uCloudOn` is 0 when there is no cloud, and the
  shaders then skip it. `cloudNoise` uses `textureLod`: it is read inside loops
  and branches, where a lookup that needs screen derivatives is not allowed.

**Fog** is the thicker of the render-distance fog (linear, hides the load edge)
and `weatherFog()`: uniform haze (rain, snow, dust) plus exponential ground
fog thinning with height from y 62, so mist settles in valleys. Clouds only
count 70 blocks of haze so dark cloud stays visible overhead in rain.

**Gameplay:** freezing rain makes open ground slippery (`PlayerPhysics.slip`),
gales lean on an exposed player and tornadoes pull (`PlayerPhysics.external`),
lightning hurts within 4 blocks. Leaves sway with the wind in `CHUNK_VERT`
(position-only displacement, so merged quads never crack).

**Audio** (`WeatherAudio`): rain and wind are filtered noise, made as they
fall; thunder is a file (`thunder_close` / `_mid` / `_far` by distance — see
*Sound*; a made rumble where a pack has none). It plays through the game's
mixer, updates at 10 Hz, muffles under a roof, and thunder arrives
`distance / 343` seconds after the flash.

### Persistence and settings

- Clock, weather state and cloud offsets are saved in the player state
  (`atmosphere` key of `player-state.json`).
- **World Settings → Daylight Cycle / Weather** (`daylightCycle`, `weather`
  in `world.json`; `weather` is `'dynamic'` or a type id), plus a one-shot
  **Time of Day** in the in-game This World section. Applied when the settings
  screen closes (see *User Interface*), via
  `callWorldJS("setAtmosphere", { daylightCycle, weather, hours })` — `weather`
  only when it was changed, since sending the same one again would restart it.
- `window.__wwDebug().atmosphere` reports time, weather, cover, wind, active
  particle layers and `gpuClouds`; `window.__wwAtmos()` returns the Atmosphere.

---

## Mobs

Six kinds: cow, pig, sheep, chicken, fish, and the **Quiddle** — the people of
Wonder World. `data/entities/*.json` gives each its numbers (health, speed,
hitbox `width` / `height`, drops, spawn rules) and:

| Field | Meaning |
|---|---|
| `model` | A key of `MODELS` in `engine/MobModelDefs.js` (default: the entity's id). An entity with no model of that name is drawn as two plain boxes |
| `modelScale` | Stretches the model (default 1) |
| `behavior` | `"passive"` (default: runs when hurt) or `"defensive"` (comes for whoever hurt it; Quiddles) |
| `attackDamage` | What a defensive mob's blow does |
| `grazes` | Puts its head down to eat when idle (pecks, for a chicken) |
| `maxDrop` | The deepest drop it will take on purpose, in blocks (default 3) |
| `aquatic` | A fish: swims, spawns in water |

### Models (`engine/MobShapes.js`, `MobModelDefs.js`, `MobAnim.js`, `MobModels.js`)

The animals are anatomy, to scale: a block is a metre, a cow stands 1.35 m at
the shoulder. **The Quiddle is a drawn character**, as tall as a person
(1.8 m) but about four heads high where a person is seven and a half: a big
round head with big eyes on a short neck, a person's trunk and shoulders, and
short sturdy arms and legs ending in big hands (the four fingers one shape,
with a thumb) and boots. It is still made as a body is — one skin from the
shoulder to the knuckles and from the hip to the ankle, bending at real
joints. (It was first a person to scale, and then that same thin body under a
head nearly twice life size, which read as lanky and wrong.) Its numbers are
named: `QUIDDLE_Y` (the heights of its joints and edges), `QUIDDLE_HEAD`
(the head is modelled in a head's own measure, 4.2 px chin to crown, then
enlarged `scale` 1.7× and set on the neck) and `QUIDDLE_FACE` (the eye's size
and place on the skull's grid of texels, which the eyelids are cut to).
Everything is in **pixels, 16 to a block**; +Y is up, +Z the way the mob
faces, +X its left; feet on y = 0.

The Quiddle's painters did not have to be redrawn for the new figure, and
will not for the next: a texel on the head is taken back to the head's own
measure (`lifeSize`), and one on the body to where it would be on a person's
proportions (`body()` in the texture tool: each limb by its joints, the trunk
as it is but narrower), which are the lines the clothes and hair were cut to.
Only the face is drawn for this head: on the skull's own grid, eyes six texels
square set low and wide, each with a dot of light on the same side, brows, a
small mouth that turns up, colour in the cheeks.

A model is a tree of **parts — its bones** — each turning about a pivot (a
shin about the knee), with shapes on them. Two kinds of shape (`MobShapes.js`):

- A **loft** is a skin over a row of cross-sections ("stations") along a path:
  a leg from shoulder to hoof, a body from rump to chest, a head from poll to
  muzzle. A station gives the middle of the section, half its width, how far
  it reaches above and below (or before and behind) that middle, and how square
  it is (`sq`: 2 an ellipse … 4 a rounded box). Stations are joined by monotone
  cubics, which never overshoot them, so a shape has the profile it was given —
  a topline, a deep chest, a tucked flank, a knee, a jaw — not the outline of a
  ball. Ends are left open (buried in another shape), closed flat, or domed.
- A **box**, its edges rounded and tapered as asked: fins, a comb, eyelids.

**Joints are connected: a station also says which bone it follows, and may
follow two.** The ring of skin at a knee goes half with the thigh and half
with the shin; the top of a leg is buried in the body and follows the body, so
one skin runs unbroken from inside the shoulder to the sole and from the chest
through the neck into the skull, and bends like skin where the bones turn. A Quiddle's arm begins in the slope of
the shoulder, following the trunk more than the arm there, and ends in a hand
with a palm, a thumb and four fingers that close from the knuckles (`fingers`
bones: half open at rest, closed to run, a fist to strike).
A `bone` may also be a function of where a vertex is round its ring: the
underside of a muzzle goes with the `jaw`, and each side of a skirt with the
leg under it, so a stride swings the cloth instead of coming through it.

Sections follow the turns of the path unless a loft says `along`: bodies are
cut in upright slices and legs in level ones, so a station is exactly the
outline at that place, and a tight bend cannot fold the skin over on itself.
(`test/mobai.test.mjs` checks no triangle faces inward.)

- **Texels.** A model has `density` texels to the pixel — 2 for the animals
  (32 to a block, twice the ground's), 3 for the Quiddle — and a shape may ask
  for more: heads have about twice their body's (a Quiddle's face is some 66
  to a block, `QUIDDLE_FACE.density` 7 to a pixel of the head's own measure).
- **Texture layout** comes from the definition: each shape is unwrapped into
  **patches** (`shape.patches`) — a loft's side as one sheet wrapped round it,
  with texels spaced evenly round its widest section, plus one for each closed
  end; a box one per face — packed into the model's atlas with a texel of space
  between them. `surfacePoint` says where on the model a place in a patch is;
  the renderer (`shapeMesh`) and the painter both go through it, so they cannot
  disagree (the test checks every vertex against it). **Changing a model's
  shapes moves its texels: repaint (`npm run mobtex`).**
- **Textures** (`data/textures/entities/*.png`) are painted by
  `tools/gen_mob_textures.mjs`. A painter is asked for the colour at a point
  *on the model* ("the texel at (x, y, z), facing this way, on the head"), not
  at a place in the atlas — which is why a cow's patches and the hem of a dress
  run from one shape onto the next without a seam. Features that have a place
  are put at the model's **marks** (`Builder.mark`: an eye, the nose), the same
  points the animators use; eyes are drawn texel by texel on the shape's own
  grid (`pixelEye`), so they are sharp and the same on both sides. The painter
  fills the space between patches with the colour beside it, so nothing bleeds
  at an edge. The PNGs are ordinary files: they can be touched up by hand or
  replaced by a gamepack, but running the tool repaints them.
- **Variants.** A model lists its `variants` (name → how many choices); a part
  with `show: { hair: 2 }` (or a list, `{ hair: [0, 3] }`) is drawn only for
  those choices, and `layers(variant)` names the texture files to stack.
  Animals have three coats each. A Quiddle (`QUIDDLE_LOOKS`) is four layers —
  skin (5 tones), outfit (6: tunic, overalls, dress, waistcoat, blouse and
  skirt, jumper), eyes (3), and hair (6: short, long, straw hat, cropped, bun,
  short with a beard) in each of 5 colours — plus the parts an outfit or a
  head of hair brings. Some are for one sex: `model.only` (`QUIDDLE_ONLY`)
  says which, and `randomVariant` / `choiceAllowed` honour it.
- **Builds.** A Quiddle's first five variants are how it is made: `sex`,
  `build` (slight / medium / broad), `arms`, `legs` (lean → heavy) and `height`
  (±7%). `model.build(variant)` (`quiddleBuild`) turns them into a shape: the
  one model with its vertices moved — the trunk widened by height, shoulders,
  waist and hips each by their own amount (which is where a man and a woman
  differ), limbs thickened about their own middles and moved out to stay
  beside it — and a scale. Texels do not move, so every outfit fits every
  build and no texture is repainted. `MobModels` builds the geometry once per
  build (`buildStatic`) and hands `poseMatrices` the bones' moved pivots; the
  entity manager scales the stride with the mob. A missing choice is 0: the
  slightest, shortest build.
- **Stale textures say so.** The painter writes `layout.json` beside the
  textures (`layoutKey`: where every patch is), and `MobModels.load` warns in
  the console when a model's layout no longer matches — "run npm run mobtex" —
  instead of the mob simply looking scrambled. Changing `QUIDDLE_HEAD.scale`
  is such a change.
  Hair and skirts are parts: hair is its own shape over the
  skull, cut to its edge by the texture (the material is alpha-tested), with a
  length down the back or a brimmed hat; a tunic has a skirt and a dress a long
  one. `MobModels` draws a variant's layers into one small canvas texture the
  first time that combination appears, and keeps it. `randomVariant(model)`
  picks a look at spawn.
- **One mesh, one draw call per mob.** The shapes of a model share one
  geometry; each frame `poseMatrices` turns the pose into a matrix per bone and
  `MobModels.pose` writes every vertex's posed position on the CPU — 800 to
  1,400 vertices a mob (a fish 240), about one in seven of them mixed between
  two bones; 13–23 µs a mob on a 15 W laptop CPU, animation included. That is far cheaper
  than a draw call per part, needs no skinning variant of any shader, and the
  shadow pass draws the animated shape with its ordinary depth material.
  Instance geometries are pooled per model. A part's `rot` is only how its
  shapes were laid out: it is baked into the geometry, so at rest every bone's
  matrix is the identity — which is what lets a vertex follow two.
- **Posed only where it can be seen** (`EntityManager.seen`, `_mobSeen` in
  `world.js`). A mob out of view still thinks, moves and keeps its stride, so
  it steps back into view mid-stride, but its vertices are not worked out —
  which is most of what a mob costs. "In view" is the sphere round it against
  the last frame's view frustum, two blocks wider (mobs are updated before the
  camera is), and wider again by the length of its shadow while shadows are
  on: a mob behind the player whose shadow falls in front is still posed.
  In the benchmark's scene — twenty mobs round a camera looking at the
  horizon — two are posed with shadows off, and from two to fourteen with
  them on, as the mobs wander.
- **Light is baked into the vertex colours** in the same pass: each vertex is
  shaded by the sun or moon from its own normal (`EntityManager.lightDir`, set
  from the atmosphere each frame) and scaled by the light where the mob stands
  (`lightAt`: sky, time of day, torches). The material is an unlit
  `MeshBasicMaterial`, shared by every mob wearing the same texture. Vertex
  colours multiply in linear light and the terrain shader multiplies display
  values, hence `GAMMA` in `MobModels.js`.
- **Animation** (`MobAnim.js`) is procedural: a function per model
  (`ANIMATORS`) writes turns, shifts and scales for its bones from an **anim
  state** (`makeAnimState`) that `EntityManager._animate` fills in each frame —
  `phase` (the stride), `move`, `run` (0 walking … 1 at full speed), `lookYaw`
  / `lookPitch`, `air`, `swim`, `graze`, `attack`, `panic`, `hurt`, and a
  `seed` so a herd is not in step. A turn is `Ry · Rx · Rz` about the model's
  axes; a positive x turn swings what hangs below a pivot backward and tips
  what is in front of it down.
  - **Legs are placed, not swung.** A gait says where each foot is through a
    stride (`footCycle`): down for a `duty` of it and going back under the body
    at exactly the speed the mob goes forward, then lifted and carried ahead.
    `makeLeg` tabulates how long a leg is for each amount of fold — its joints
    fold together, each its own way (a knee back, a hock forward) — and
    `placeLeg` looks that up and turns the hip, so knees and hocks bend as far
    as the step needs. A foot that is down therefore **does not slide**: the
    test holds it to a fiftieth of a pixel a step. `GAITS` gives each model's
    stride in blocks at a walk and at a run, and the entity manager advances
    `phase` by distance over that.
  - Cow, pig and sheep **walk** (each foot in turn, three down most of the
    time) and **trot** when they flee (diagonal pairs); the neck and head look
    about, reach the ground to graze (`feedAngles`), the jaw chews, ears flick,
    a swish runs down the tail. A hen holds her head still while her body
    catches it up, then darts it forward. A fish swims with a wave down four
    bones. A Quiddle lands on the heel, rolls onto the ball of the foot and
    pushes off it; the pelvis sinks as the weight changes legs, a hip swings
    forward with each step, the shoulders turn against the hips, the arms swing
    against the legs with elbows that bend; running leans into it and leaves
    the ground. They blink (eyelid parts scaled away except in a blink), look
    at the player, draw an arm back and throw a blow; a dying mob keels over
    (`inst.death`) and lies a moment before it is removed.
- **The player is a Quiddle** — the same model, in the look the player chose
  (see *The player's body and the view*).

Adding a mob: a builder function in `MobModelDefs.js` (bones, then the lofts
over them — the others show the conventions: stations as `[x, y, z, half
width, up, down, { sq, bone }]`, a leg's joints named for the real ones), an
entry in `MODELS`, an animator in `MobAnim.js` (a four-legged animal needs
only its numbers for `quadruped`), a painter in the texture tool, `npm run
mobtex`, then `npm run mobshots` to look at it from every side, in clay and
painted, through a stride and in every pose before trying it in the game.

### Navigation and behaviour (`engine/MobNav.js`, `engine/MobAI.js`)

`MobNav` reads the world as columns of cells. A mob stands in a cell (solid
under it, room for its body) and can walk to any of the eight around it if the
ground there is level, **one block up** (a jump: it needs the headroom) or **no
more than `maxDrop` down**; never through a wall, under a ceiling too low for
it (`body.clear` cells), or across the corner of a wall or pit (a diagonal
needs both its sides open at the same height). Water is a cell it can be in at
a heavy cost, so land mobs go round a pond but one that falls in can find the
way out. `findPath` is A* over that, capped at 420 expanded cells (a few
tenths of a millisecond); past the cap, or with no way through, it returns the
path to the nearest cell it reached. At most two searches run per frame across
all mobs (`MobAI._budget`); a mob that is refused asks again next frame.

`MobAI` is a state machine — IDLE (stands, looks at the player, grazes),
WANDER, FLEE, ATTACK — and **every move is along a path**, so wandering,
running away and chasing all avoid pits and walls the same way. Following a
path, a mob jumps as it reaches a ledge (blocky worlds) or when something
actually stops it (smooth worlds, where a rise is a slope it walks up), and
gives a path up after two hops have not freed it. Under all of it sits one
rule in the physics step: **a mob on the ground never walks off an edge deeper
than `maxDrop`**, whatever is driving it — that is what holds when a path goes
stale (the block it was routed over is gone).

The body: gravity, collision against the rendered shape in smooth worlds,
`STEP_HEIGHT` up slopes and `SNAP_DOWN` to stay on them going down (as the
player has), floating in water. A mob whose chunk has unloaded waits where it
is. Fish are the other kind of body: weightless in water, steering in three
dimensions to points they can swim straight to, kept under the surface,
flopping when stranded.

`test/mobai.test.mjs` runs all of this in worlds made of plain functions — round
a pit, up a staircase of ledges, not over a cliff, round a pond and out of one,
headroom, corner cutting, three minutes of wandering on a plateau with a sheer
drop all round, fleeing beside a pit, a Quiddle pathing round a wall to strike,
a fish staying in its pool — and checks the models: patches keep clear of one
another in the atlas, bones are ordered and at rest in the rest pose; every
triangle faces out and every vertex stands exactly where the painter is told
its texel is; and through a stride, at a walk and at a run, a foot that is
down stays where it was put, every foot takes its turn off the ground, and at
a walk something is always on it.

Test hooks: `__wwSpawnMob(type, x, y, z)`, `__wwMobs()` (what each is doing),
`__wwHitMob(x, y, z, damage)`.

---

## The player's body and the view (`src/scripts/PlayerModel.js`, `world.js`)

A player is a Quiddle, in the look they chose (their "skin": a choice for each
of `QUIDDLE_LOOKS`, kept with their name — see *Names* and *The Character
screen*). `PlayerModel` is that body for every player there is: yourself, the
other players (*Playing together*), and the figures on the Character screen
and behind the menus. It is told a handful of things each frame — where the
player is, which way they look, how fast they move, whether they are on the
ground, in water, striking, hurt, dead — and the Quiddle's own animator does
the rest (the stride follows the ground covered, so feet that are down stay
down). The head follows the look at once; the body comes round after it when
the player moves, or has looked further to the side than a neck goes (`NECK`).

**The view** (`_camMode`; V or F5, or a controller's right stick pressed in):

| Mode | The camera |
|---|---|
| 0 | The player's own eyes. The body is not drawn, but casts its shadow (it is on the shadow layer only) |
| 1 | Over the right shoulder, from `CAM_BACK` (4.2) blocks behind |
| 2 | From in front, looking back at the player |

- **What the player does is the same in all three.** Blocks are aimed at,
  mined and placed from the eyes, along the look, as they always were. In the
  shoulder view the camera is half a block to one side of that line, so it is
  turned to look at the very point the eyes are aimed at (`_aimDist` along the
  look: the block or mob targeted, eased) — and the crosshair lies on the
  block that will be hit.
- **The camera does not go through the ground** (`_clearAlong`): the line from
  the head out to where it would sit is walked, with room either side and
  above and below (`CAM_ROOM` — a wall it only just missed filled half the
  screen), and it stops short of the first thing in the way. It comes in at
  once and goes back out slowly. Nearer the head than `CAM_HEAD` the body is
  not drawn. Leaves and glass do not stop it.
- The arm swings (`_swingArm`) when the player mines, places or strikes.
- What is held is not shown yet (see *Known Limitations*).

---

## Sound (`src/scripts/Sound.js`, `GameSounds.js`, `tools/gen_sounds.mjs`)

**The files** are in `data/sounds/` — `blocks/`, `entities/`, `ambiant/`,
`ui/`, `music/` — and are found through the data manifest (`sounds`: every
audio file one folder deep). A sound is asked for by name: its file's name
without the folder, the number and the extension (`grass_step`). Files that
differ only in that number are takes of one sound; one is picked each time
(never the same twice running), a little higher or lower. **A name with no
file is silence**, so a pack may leave any out, and any file can be replaced
by a recording of the same name.

| Sounds | Names |
|---|---|
| A block's, by its family | `<family>_step`, `_hit` (a knock while mining), `_break`, `_place` — families `grass dirt stone sand gravel wood snow leaves glass`, from the block's `"sound"` or guessed from its name (`blockSoundFamily`) |
| Water | `water_splash` (falling in), `water_swim` |
| Mobs | `<type>_idle`, `<type>_hurt` (cow, pig, sheep, chicken, quiddle) |
| The player | `player_hurt`, `fall`, `eat`, `pickup`, `swing`, `punch`, `bow_draw`, `bow_shoot`, `arrow_hit` |
| Ambience (loops) | `birds` (day, in the open, dry), `crickets` (night), `cave` (no sky light), `water` (open water near), `underwater` |
| Thunder | `thunder_close`, `thunder_mid`, `thunder_far` — picked by distance (see *Day Cycle and Weather*) |
| Menus | `click` |

**They are made, not recorded** (`npm run sounds`): each is built the way the
thing itself makes it, at 44.1 kHz, which is what stops them sounding like a
game console (the clap of raw noise that lightning used to make did). A
footstep is a heel and then the ball of the foot, each the dull knock of a
weight plus what that ground does — blades brushing, grit turning, a board
ringing in its few modes, snow squeaking. A voice is a larynx (a pulse train
with a real one's jitter and roughness) through resonances that move as a
mouth does. Thunder is a lightning channel some kilometres long, every few
metres of which goes off at once; what arrives is each of those bangs, later
and duller the further up the channel it was — a crack from the nearest part,
then the roll from the rest — heard from two ears apart. Deterministic (a
seed per name); Ogg Vorbis when `ffmpeg` is on the PATH, else WAV. The
spectrogram of a take is the quick way to see what a change did.

**The mixer** (`Sound.js`, one `AudioContext` for the game):

```
sfx ─┐
ambience ─┼─ muffle (a low-pass, shut down with the head under water) ─ master ─ out
weather ─┘        (WeatherAudio.js plays into the weather bus)
```

- Volumes are Settings → Audio: Master, Music, Sounds, Ambience, Weather.
- **A browser lets a page make sound only after a click or a key.** Until
  then nothing plays, and the music starts on that first click (the desktop
  app starts it at once). The short sounds are decoded then; ambience and
  thunder, tens of megabytes decoded, when first wanted (`wait` plays a sound
  when it has arrived, for thunder, which is late anyway).
- **Positional sounds** are placed by ear, cheaply: quieter with distance,
  panned by where they are from the way the listener faces, nothing beyond
  `reach`.
- **Music** is an `<audio>` element (the track is minutes long): "Adventure
  Awaits" (`MENU_MUSIC`) plays in the menus from the moment the game starts,
  fades out as a world comes up and is there again on the way out.
- In a split screen the first pane plays what everyone hears — music,
  ambience, weather (`sound.shared`); every pane plays its own player's
  sounds.

`GameSounds` decides when: a footstep for every stride on the ground walked on
(longer strides running, a harder one for landing), a knock every quarter
second while mining, a splash going into water, a bite while eating, and the
ambience eased toward how much of each there should be. It is handed what it
needs each tick (`_tickSounds`) and reads nothing of the world itself. Mobs
speak through `EntityManager.onSound`: now and then, when near, and when hit.

---

## Playing together (`server/multiplayer.js`, `engine/Multiplayer.js`, `src/players.js`, `index.js`)

Two ways, and under both the same thing. **Every world played through the
server is a session there** — one player alone is a session of one — and
another player joins it: a second pane of a split screen, or a guest from
another machine. So the game has no multiplayer mode: it always tells the
session what it does and listens, and alone, nothing is sent but the blocks.

### What is shared, and who runs it

All the games hold the whole world and each runs its own player, with its own
camera, inventory, health and menus. **The first to join is the host**; its
game also runs what there must be only one of.

| | Run by | The others |
|---|---|---|
| Players | each their own | are told where each is, 15 times a second (`packState`: place, look, speed, a few flags, blows begun), and draw them (`Players.js`: a `PlayerModel` and a name over it, eased toward the latest) |
| Blocks | whoever changes one (`WorldState.onSet`) | put it down (`_applyRemoteBlock`). A chunk not loaded there keeps it in `pendingChanges`, which is put down when the chunk arrives — the mechanism that already carried a player's own edits across an unload |
| Mobs | the host | are replicas (`EntityManager.replica`): they spawn nothing and decide nothing, and show the host's snapshots (ten a second, eleven numbers a mob, each mob's look sent once). A guest's blow goes to the host (`hit`); a mob's blow on a guest, and the drops of a mob a guest killed, go to that guest |
| Clock and weather | the host | take the host's every two seconds (`Atmosphere.sync`). One player's pause menu does not stop the clock while others are there |
| Dropped items, lightning strikes | each game its own | — |

- **The journal.** The server keeps the latest block for every place changed
  in the session and hands it to whoever joins: the chunk it was in may not
  have been saved yet, and without it the newcomer would generate that land
  afresh, without the change — and could later save its copy over the
  original.
- **Saving.** Every game saves the chunks it has changed or been told were
  changed, as it always did. A copy saved a moment too early is put right by
  that game's next save, since it holds the later change too.
- **Guests.** Every player after the first is a guest of the world: their
  place, health and inventory in it are kept in a file of their own
  (`players/<key>.json`, by name — `?player=` on the player-state requests),
  the clock is the world's, and the world's settings are not theirs to change.
  Someone new starts beside the host.
- **When the host leaves, the session ends** for everybody (`mp:closed`): its
  game was the one running the world.
- The server passes everything on without looking inside (`mp:all`,
  `mp:host`, `mp:to`) except the join, the journal and the host's
  clock, which it keeps for newcomers. The protocol is at the top of
  `server/multiplayer.js`; `test/multiplayer.test.mjs` checks it.

### Split screen (`index.js`, controllers only)

From the pause menu's **Players** panel: while it is open, a controller
nobody is using that presses A joins on this screen. `index.js` — the page
round the game — opens a second copy of the game beside the first
(`game.html?pane=1&pad=<controller>&world=<id>`), which asks who is playing
(*Names*) while the first plays on, and then joins the world as a guest.

- **Each pane is a whole game**: its own renderer, chunks, workers (a share of
  the cores: `workers`) and menus, drawn in its own frame. That is what made
  it possible without rewriting a game built round one player and one
  camera — and it is what it costs: two panes hold the world twice. The
  pixels drawn are the same in total, which on integrated graphics is what
  limits a frame.
- **Two players stand side by side, three or four take a quarter each.** The
  game lays itself out in fractions of its own frame's width (`vw`), so it
  fits any of them without knowing; side by side keeps a pane tall enough for
  the menus, and a quarter is 16:9 again.
- A pane is its controller's alone (see *Controller*); the mouse and the keys
  are the first player's. The frame-rate cap for a window in the background
  goes by the whole window (`appFocused`), since only one frame has the
  keyboard.
- **A shared screen is kept light** (`limitForSplit` in `main.js`). Whatever a
  player's graphics settings say, with two players the render distance is at
  most 6 and with three or four at most 4, and Far Terrain, shadows, fancy
  clouds and Eye Adaptation are off, particles at most medium (low for three
  or four) and the frame rate capped at 60. `index.js` tells every pane how
  many share the screen (`__wwSplitCount`; a new pane reads it from its
  address, `of=`), and what a player chose is back the moment the screen is
  theirs alone. Settings → Video says so while it holds
  (`#splitGraphicsNote`). Measured on the Normal preset: 441 chunks alone, 169
  each for two players, 81 each for three.
- A pane closes when its player leaves, and all of them when the first player
  leaves the world.

### On the network (`server.js`: *On the network*)

The Players panel's **Open to the network** starts a second listener, on every
interface (`WW_LAN_PORT`, 25599, or any port if that one is taken), and shows
the address. **What comes in through it is a guest**, and may fetch the game
itself and play in the one world that is open — its chunks, its own player
file, its session — and nothing else: not the list of worlds, not another
world, not the owner's state or settings, not a way to make, delete or open
anything (the middleware at the top of the app; the test goes through each).
The player's own listener is as it was, this machine only.

- **A guest runs the host's copy of the game**, served by that listener, so
  both ends are always the same version. In the app, and from the game's own
  page, **Play → Join a game** lists the games on the network (each open
  world announces itself by UDP broadcast, port 25598) or takes an address;
  `index.js` swaps its frame for the host's page and hands it the guest's own
  settings. Anyone else can simply open the address in a browser. A guest's
  page knows what it is (`GET /api/lan/info`) and goes straight into the
  world.
- The world closes to the network when its last player has gone, or when the
  toggle is turned off (the guests are sent away; the host plays on).
- Windows asks, the first time, whether to let the game through the firewall:
  that is this listener.

---

## User Interface (`game.html`, `src/css/game.css`, `src/main.js`)

**The look** is graphite: dark grey panels (`.panel`), soft at the corners
and quiet, so the world behind them stays the bright thing on screen. Nothing
is outlined in ink, leans or bounces; a control shows what it is by being a
shade lighter than what it sits on (`--bg-2` set in, `--bg` the panel, `--bg-3`
raised, `--bg-4` under the pointer). Three colours mean something and are used
for nothing else — gold for the thing you most likely want and for whatever is
selected, green for on, red for what cannot be undone — and a short gold bar
marks every heading. Buttons are `.menuButton`, with `.primary`, `.danger`,
`.quiet`, `.small`, `.big`. The colours, the line, the radius and the shadow
are custom properties at the top of `game.css`; restyle there. Over the world
the HUD is the same grey, see-through (`.chip`, the status bars, the hotbar
tray). (It was a storybook of cream paper and ink outlines for a day, which
read as too much of a cartoon.)

**Every length is in `vw`.** The game is shown in a 16:9 frame (`index.html`),
so a size in `vw` is the same share of the screen on any display. Keep to it:
no `px`, and `vh` only as a cap on a panel's height.

How it is put together:

- **Screens** are top-level elements toggled with `.hidden`; anything that
  covers the screen behind a panel is a `.scrim`. Behind the menus is a place
  (see *The place behind the menus*); until it has loaded — and for a page
  that has none — the pack's title gradient, set on `<body>`
  (`loadTitleBackground`).
- **The title screen leaves the picture alone.** The logo is top left, who is
  playing top right (`.titleProfile`), and at the bottom there is one thing to
  do — **Play** — over a row of the lesser ones: Character, Settings, How to
  Play, Credits (`.titleDock`, `.titleRow`). It was a column of equal buttons
  down the middle of the screen. **The pause menu** follows it: Resume, a grid
  of the rest (`.pauseGrid`), and Save & Quit by itself underneath.
- **Credits** (`#CreditsScreen`, from the title) says who made the game and
  its music.
- **Short choices are buttons side by side.** A `<select class="seg">` is
  shown as a row of buttons, all in view and one click each
  (`buildSegments()`): the select stays in the page, hidden, and keeps the
  value, so everything that reads or sets it works as before. A click fires
  the `input` / `change` a real choice would; after code sets a value, call
  `syncSegments()`. Long lists (weather, colourblind mode) stay drop-downs.
- **Settings** is one section at a time, picked from the list down its left
  side: each `.settingsPanel` and its `.settingsTab` share a `data-section`
  (`switchSettingsTab`). It reopens on the section it was left at. This World
  is listed only in a game.
- **Player settings take effect as they are moved and are kept by the server**
  (below). **World settings have no Apply or Save button:** they are saved,
  and applied to the running world, when their screen closes —
  `applyWorldSettings()` from `closeSettings()` in a game,
  `closeWorldSettingsModal()` from the world list. Both go through
  `saveWorldSettingsFor`, which sends only what changed.
- **The world list** plays a world in one click (Play on its card); the rest of
  the card opens its options.
- **The HUD** shows health, hunger and energy as bars with the number beside
  each (`_hudMeter` in `world.js` moves the fill and rewrites the number only
  when it changes).
- **A controller** drives every screen through a focus ring (`.padFocus`,
  gold); see *Controller*. While it is the device in use `<body>` has
  `usingPad` and the mouse pointer is put away. Settings → Controls lists
  every control for the keyboard and mouse and for the controller side by
  side (`.keyGrid.pad`; a controller button is a `kbd.pad`).
- **Accessibility**: `a11y-contrast` swaps the palette for white on black with
  heavier lines, `a11y-large-text` scales the text, `a11y-reduce` stops
  animation — all classes on `<body>`.

### The place behind the menus (`src/scripts/MenuScene.js`, `tools/gen_menu_scene.mjs`)

The menus' background is a place, not a picture: a meadow with a couple of
houses on it under a mountain, the sea round to one side, the player's own
Quiddle standing in it and a few animals grazing. (It was the pack's gradient,
flat; and then, for a while, a world loaded for the purpose — the workers and
a few hundred chunks generated, meshed and lit, to look at two views of it.)

- **It is a model, baked once** (`npm run menuscene` → `data/menu/scene.glb`,
  19 MB). The tool generates the real terrain round a spot on a seed with the
  game's own generator, smooth mesher and sky-light solver — real chunks only,
  out to 17 of them, and no far terrain — and writes what the menu's cameras
  can see as one binary glTF with the block textures inside it. The menu loads
  that file and draws it: no workers, no chunks, nothing generated. It is on
  screen a fraction of a second after the title.
- **Only what the cameras can see is in it.** A chunk no view faces and a face
  turned away from every place the camera will be are dropped; then the scene
  is drawn in software from each of those places (the two views at
  2560 × 1440, and 23 places on the way between them at 1280 × 720): a depth
  picture, then every triangle asked whether any of it is at the front
  (`visible`). What is hidden from all of them — the far side of every ridge,
  the land behind a house, nearly all of every cave — is left out: about 490
  thousand triangles are kept of nearly 4 million. So **the views are part of
  the bake**: move a camera (`SCENE`, at the top of the tool) and bake again.
  `--all` keeps every face the sky lights instead — the whole place, to look
  round in a viewer, at many times the size.
- **The file** is glTF 2.0 with two common extensions
  (`KHR_mesh_quantization`, `KHR_texture_transform`), so three.js, Blender and
  Babylon open it, textured and unlit. There is a material for each block
  texture (a 32 × 32 image, repeating) and a primitive for every 65,535
  vertices of it, so indices are shorts; a vertex is 24 bytes, packed as the
  game's own are (*Worker Protocol*). As floats with 32-bit indices the same
  scene was 34 MB. What only the game's shader reads rides along where a
  viewer ignores it: `_BLEND` on each vertex (the texture of the ground that
  spreads over this one's edges, the sides it comes from, the baked sky light,
  and its glow with one bit for natural ground), and `extras` on each material
  (leaves, water) and on the scene (`wonderWorld`: the views, where the figure
  and each animal stands, the hour, the fog).
- **It is drawn to look like the game**, by a small renderer of its own on a
  canvas of its own (`#menuCanvas`): the textures as one array, the game's
  light sum from the baked sky light and the sun of the scene's hour
  (`DayCycle`), ground of one kind spreading over the next along the same
  ragged line (`ground()`, carried over from the chunk shader), leaves moving,
  haze toward the edge of what was baked, and a sky with the sun and slow
  cloud. They are not the game's shaders: its weather, shadows and clouds are
  not here.
- **The camera does not move unless it is sent.** It rests at one of the
  file's views — `title` behind the title screen, `worlds` behind the list of
  worlds. **Play** puts the menu away, sends the camera to the other view
  (`goToWorlds` → `__wwMenuScene.goto('worlds')`: 2.4 seconds, eased, along
  the straight line the bake looked along) and then brings up the list;
  **Back** does the same the other way (`backToTitle`). Leaving a world
  arrives at `worlds`.
- **The bake is for a 16:9 picture.** On a wider one the view is cut at top
  and bottom instead of reaching further to the sides, where nothing was kept
  (`place()`).
- **Who stands in it**: the player's figure (a `PlayerModel` in their look,
  watching the camera; a change on the Character screen shows at once) and
  the animals the file lists, which breathe, look about and graze. They do not
  walk: there is no world under them. The tool puts each on the highest
  ground under its feet, and says when one is on a slope or its feet cannot be
  seen from its view — on ground that falls away beyond a rise only an
  animal's back shows, and it looks sunk in the ground.
- **It shows** by `body.menuWorld`, and fades in over the gradient at
  `menuReady`. It is drawn 30 times a second, 12 with the window in the
  background, 60 while the camera travels. With no such file the menus keep
  the gradient.
- **It ends** when a world is started (`stopMenuWorld` → `hide()`, which gives
  its geometry and textures back to the graphics card: a world is about to
  want the room) and is there again on the way out.
- A split screen's further panes and a guest's page have none (they go
  straight into a world). `window.__wwMenuWorld(false)` turns it off for a
  test.

### Where the player's settings are kept

In `user/settings.json` under the data directory, through `GET` / `PUT
/api/settings` (`loadSettings`, `saveSettings` in `main.js`; a change is sent
a quarter of a second after the last one, and on `pagehide`). They used to
live only in `localStorage`, which belongs to the page's *origin* — and the
desktop app serves the game from a port the system picks afresh at every
launch (see *Desktop App*), so every launch was a new origin with empty
storage and every setting went back to its default. `localStorage` is still
written, as the fallback for a page with no server behind it, and read once to
carry over what a player had before.

The settings there are the first player's. A split screen's further panes
start from them but keep their own changes only for as long as they play, and
a guest from the network keeps theirs in their own browser (and brings them
along: `index.js` hands them to the host's page in its address, `#me=…`).
The names (below) are the exception: they are changed one at a time
(`POST /api/profiles`, `DELETE /api/profiles/:name`), never with the rest —
a whole list sent with the settings may be an old one, from before another
pane added a name — so `PUT /api/settings` leaves `profiles` alone.

### Names (`src/players.js`)

A player has a name, and the names used on this machine are kept in a list
with the look that goes with each (`profiles`: `[{ name, skin }]`).

- **The first time the game is opened it asks for one**, before the title
  screen (`enterGame`); after that it starts with the name chosen last
  (`playerName`). The title screen says who is playing, and that button opens
  the list to pick another, add one or remove one.
- **Each further player of a split screen is asked too**, in their own pane,
  while the others play on: the list, without the names already playing on
  this screen. A new name begins with a look of its own (a random one).
- **A keyboard just types it. A controller uses a telephone keypad** (`t9Press`,
  `.t9Pad`, shown while a controller is the device in use): twelve big keys to
  move between, not forty small ones. A key is a few letters and its digit,
  and pressing it again within a second goes on to the next (`T9_AGAIN`); ⇧
  changes the case of the letter being chosen, or of the next; a name begins
  with a capital anyway. X rubs out, Y is a space, Start is Done.
- A name is up to 16 of letters, digits, spaces and `. _ ' -`.

### The Character screen (`src/scripts/Character.js`)

The look that goes with the name: a choice for each of the Quiddle's
`QUIDDLE_LOOKS` (hair and its colour, eyes, skin, clothes, frame, build, arms,
legs, height), each a row of buttons, colours as patches of the colour
(`data-swatch` on the option; `buildSegments`). The figure beside them turns
slowly (drag, or the shoulder buttons, to turn it) on a small renderer of its
own, so the screen works from the title as from a game. A change is kept
(`settings.skin`, and with the name) and sent to the game at once. For a
player nothing is tied to anything else — any hair with any clothes on any
frame; the Quiddles of the world keep `QUIDDLE_ONLY`.

---

## GamePack System

GamePacks are JSON + asset bundles loaded at startup. Multiple packs can be active simultaneously — later packs do not override earlier ones (first-registered wins for blocks and biomes).

World generation parameters (blocks, biomes, and `terrain` — the world-wide
settings in `data/terrain/geology.json`) from all loaded packs are merged into
`mergedGamePackData` in `main.js` and passed to `world.js` via the
`startWorldLoad` event, and from there to the workers' `init`. A pack that
leaves out `terrain` gets the generator's built-in geology; one that lacks a
block the generator asks for gets a similar block (`blockIdOf`).

The engine owns all generation algorithms. GamePacks provide configuration data only — no executable code.

---

## Desktop App (`electron/main.js`, `electron-builder.yml`)

The packaged app boots the bundled Express + WebSocket server in-process, then
opens a window pointed at it.

- **Sound may start without a click** (`autoplay-policy`), so the menu music
  starts with the game; a browser makes a page wait for the first click.
- **The server binds an OS-assigned port** (`PORT=0`) on **loopback only**
  (a second listener, for guests, only while a world is open to the network:
  see *Playing together*). A
  fixed 3000 meant the app failed to launch with no window and no message
  whenever anything else held that port, and binding all interfaces exposed the
  world-save API to the whole network. The launcher reads the real port back
  from `serverReady` — nothing may assume a port number, including the client,
  which derives its URLs from `location.origin`.
- **Startup failures surface** via `dialog.showErrorBox` instead of a silent
  `app.quit()`.
- **It runs on the discrete GPU** of a dual-GPU laptop
  (`force_high_performance_gpu`). Chromium otherwise puts WebGL on the
  integrated GPU even for a `high-performance` context. On an Intel iGPU + RTX
  2050 laptop that switch took the Normal preset from ~160 to ~440 fps and Pro
  from ~105 to ~160 (`BENCH_GPU=discrete npm run bench:render` reproduces it).
  The browser build cannot choose; players there can assign their browser to
  the high-performance GPU in Windows' Graphics settings.
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
| `npm test` | Chunk storage (filled rows only, edits anywhere, snapshots, the save format), mob navigation and behaviour (paths round pits, walls and water, jumps, no walking off cliffs, fleeing, chasing, fish), mob models (texel layout, geometry facing out and agreeing with the painter) and gaits (feet that are down do not slide), mesher correctness (incl. normals facing out, packed vertices, torch/lantern models inside their voxel, cutout and translucent blocks against each other, translucent faces in back-to-front order from any viewpoint, and the ground-blend codes), smooth-terrain invariants, sky- and block-light rules and seams, what is left out of the draw (lines of sight through real terrain never end on it; the mesher's section order; joined faces against a cell-by-cell flood), long frames in the player's physics (the same landing and damage at 10 to 144 frames a second), day cycle and weather (coverage, rain only under cloud, climate localisation, lightning placement), worker replies vs. the mesher and solver (for both generators), far-terrain tiles (well formed, deterministic, seamless between neighbours, equal to the chunks' surface at step 1 and close at step 4, their trees standing where the generated chunks have them, a changed chunk's surface replacing the generated one), world generation (legacy worlds unchanged, flat worlds of both kinds, determinism, one column equal to the chunk's, no water beside or above air in lake/river/coast/swamp/fjord country across seams, every named block and texture exists, land/sea and biome balance on four seeds, time per chunk), current-world climate, chunk scheduling (every chunk meshed, once, however the player moves; the loaded area is the square), multiplayer on the server's side (sessions: host, journal, who is told what; each player's own state file; everything a guest from the network may and may not reach), chunk-persistence round-trip (the server's, and the game's own `WorldClient` + `ChunkData` against it), semver precedence, and the update status bridge. Fast, no browser. |
| `npm run bench:load` | Saves 225 chunks of real terrain, then times a cold re-open against generating them fresh. |
| `npm run bench:pipeline [radius] [seed]` | Times each worker stage (generate, compress, mesh blocky/smooth, section connectivity, light) on real terrain and prints a hash of each stage's output — compare hashes before and after an optimisation to prove it changed nothing else. |
| `npm run bench:render [scenario …]` | Runs the real game on the real GPU (headless, vsync and frame cap off) and prints fps, frame-time percentiles, main-thread tick time, draw calls, heap and shadow redraws for each graphics preset, a thunderstorm, the Normal preset with twenty mobs round the camera (`mobs`: how many were posed, and how often the whole shadow map was copied for them) and a fly-over that streams terrain in. `preset+key=value` changes one setting (`normal+shadows=off`) to price it, and `fly+key=value` does the same for the fly-over. `BENCH_PROFILE=1` adds a main-thread CPU profile with the longest busy stretches, `BENCH_UNMIN=1` serves unminified Three.js so the profile names its functions, `BENCH_TRACE=1` breaks down every main-thread task over `BENCH_TRACE_MS` (50), and `BENCH_VSYNC=1` keeps 60 Hz pacing — the test for hitches as a player sees them, since with the cap off the main thread stalls waiting for the GPU — and `BENCH_EVAL="window.__wwMemory()"` prints, after each scenario, where the world's memory is (voxels, light volumes, chunk geometry on the GPU) and how many chunk meshes are visible. Laptop results swing with heat and background load: compare runs made in one session, and prefer `BROWSER=<chrome.exe>` — headless Edge can be marked hidden (no frames) when the display is off. |
| `npm run map -- [--seed N] [--x X --z Z] [--size S] [--px P] [--mode height/biome/slice]` | Draws a seed's world from above (heights with hill shading, or biome colours) and prints the land/sea/lake/river and biome shares; `slice` cuts a vertical section through real generated chunks (caves, strata, ores, water). No browser. |
| `npm run mobshots -- [--only cow,quiddle] [--out dir] [--clay]` | Stands the mob models on a stage (`test/mob_viewer.html`, real GPU) and screenshots each from all round (painted, and in plain clay to judge the shapes), square on from the side, the front and above, in its variants, through a stride at a walk and at a run, and in its poses (grazing, looking round, striking, falling, swimming, dead). `--clay` draws every shot unpainted. Open `/test/mob_viewer.html?model=cow` through the dev server to turn one by hand. |
| `npm run mobtex` | Repaints `data/textures/entities/*.png` from the model definitions (see *Mobs*). |
| `npm run menuscene [-- --all] [--out file.glb]` | Bakes the place behind the menus (`data/menu/scene.glb`) from the game's own terrain: prints how much of it was kept, and where the figure and each animal was put — with a warning for one on a slope, or whose feet cannot be seen from its view. About half a minute. See *The place behind the menus*. |
| `npm run sounds [-- name …] [--wav]` | Makes the sounds in `data/sounds/` (see *Sound*); `WW_SOUND_OUT=<dir>` writes somewhere else to listen first. |
| `npm run blocktex [-- name …]` | Repaints the block textures (`tools/gen_block_textures.py`; Python with Pillow and numpy). See *Block System*. |
| `npm run shots -- [--seed N] [--only a,b] [--preset normal/far/classic] [--far chunks] [--terrain blocky] [--mobs] [--pitch r] [--cull-check]` | Finds a mountain range, river valley, lake, coast, fjord and a dozen biomes on the seed's geography, flies the real game (GPU) to each, and screenshots it (into the system temp folder unless `--out` says otherwise); reports each view's load time and draw calls. `panorama`, `far-range` and `edge` look into the distance, for Far Terrain (`--far` overrides the preset's: normal 16, far 64, classic off). `--mobs` stands one of every mob in front of each view. `--cull-check` draws each view — and looking down from it, and from inside the caves under it — with and without leaving out what the camera cannot see, and fails if a patch of pixels differs or more pinholes open onto the sky (see *What the camera cannot see*; best with `--preset classic`). |
| `npm run test:smoke` | Boots the server, drives the real game in headless Edge/Chrome into a smooth world (the default) and then one switched to blocky, and fails on any console error, page exception, failed request, or a world loading in the wrong terrain style. Also drives the update banner through its states. Set `BROWSER=<path>` to pick the browser, and `SMOKE_SHOTS=<dir>` to save a screenshot of each world. |

`test/smooth.test.mjs` checks the smooth-terrain rules directly: every smooth
triangle stays inside its column and faces out of the solid, and a surface
dips only into the ground it stands on; the surface is closed across chunk
seams and corners (ray parity, with rays aimed at the shared corner); the
collider's surface equals the rendered one; Mesh/Solid interaction; the
smoothing itself (straight staircases, tangential ramp feet, continuous
ridges, low mounds, dropped inside corners, matching normals at seams);
**diagonal slopes** (two-wide diagonal steps and a slope climbing in x and z
at once are flat planes, also standing on a Solid floor, with a low cap for a
peak; and nothing else leans — steps along an axis, a plateau's edge and the
ground round a dug block are as the edge rule makes them; no dip opens into a
pocket under the ground beside it); thin features joining up (a ring with no
middle, a plus, an L, a T, an arm attached to wider ground), with the full
bounds/closed/winding/collision battery run on a scene of them including one
across a chunk corner — and again on **rough ground**: columns of any height
side by side, with Solid blocks and water among them and a floor only a block
or two thick, which is where a wall the mesher failed to draw, or a thin
sheet whose two surfaces crossed, would show; and a scripted walk up and down
a hill.

The smoke test starts from an empty data folder, so it begins where a new
player does: it must be asked for a name, types one on the controller's
keypad, and reach the title with it chosen and kept. Then the place behind the
menus must load and show, with no chunk generated for it; Play must put the
menu away, send the camera to the other view and only then bring up the list
of worlds; Back must return; and the scene must have been let go once a world
is up. The tools that are not about that (the benchmarks, the screenshots) say
who is playing before they open the page (`POST /api/profiles`).

The smoke test also cycles ten time-of-day/weather scenes (both skies, both
cloud levels, rain, snow, hail, fog, dust, a tornado) with Eye Adaptation on, and
fails if one does not take effect or its clouds are missing on the GPU. Then it
places torches, a lantern and a lamp around the player at night
(`__wwSetBlock`) and checks that block light arrives. Then it stands one of
each mob around the player and checks that each has its model and is on the
ground, that a struck pig runs, a struck Quiddle attacks, and a killed chicken
falls and is removed. Then it plugs in a made-up controller (a stand-in for
`navigator.getGamepads`) and checks that it plays with no pointer lock, moves
the player, pauses with the ring on Resume, resumes, and steps back when the
mouse is used. Test hooks on `window`:
`__wwSetBlock(x, y, z, name)`, `__wwBlockAt`, `__wwLightAt` (sky and block
levels), `__wwLook(yaw, pitch)`, `__wwPadLook()` (where the camera points),
`__wwExposure()`, `__wwMemory()`, `__wwCaveCull(on)` (draw everything, or only
what the camera could see), `__wwGrabFrame()` (the next frame drawn, as
ImageData, for comparing frames in the page), `__wwPlayers()` (who is in the
world), `__wwSound.debug()` (the mixer: what is loaded, looping and playing),
`__wwName.pad(key)` (a press of the name keypad), `__wwMenuWorld(on)` and
`__wwMenuScene.state()` (the place behind the menus: ready, which view,
travelling, how many triangles).

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
| Lighting | Moving sun/moon, propagated sky and block light (torches, lanterns, lamps), held light, weather tint, eye adaptation | Coloured block light (one warm colour for now), dim dropped-item sprites, light for dropped torches |
| Weather | Visual + audio + light gameplay (ice, wind, lightning, tornado pull) | Snow accumulating on the ground, lightning fires, tornado block damage |
| Water | Incremental BFS spread (`WaterSimulator`) | Proper fluid levels / pressure |
| Structures | Hardcoded builders (trees, plants, boulders, a house), frequencies per biome | GamePack-defined structure blueprints; villages |
| Mobs | Six kinds with jointed, skinned limbs, variants, and gaits that plant their feet; A* paths, jumps, no walking into pits; passive or defensive; voices | Hands that hold things (a player's too: what they hold is not shown); ears and tails that hang by their weight; a gallop; feet that find the height of the ground on a slope (they are placed on the level the mob stands at); spawning by biome (`spawnRules.biomes` is not enforced yet); herds that keep together; Quiddle villages, trades and talk; mobs that are hostile unprovoked |
| Playing together | Split screen (2–4, a controller each) and other machines on the network, in one session a world; blocks, players, the host's mobs, clock and weather are shared | Mobs live round the host: a guest far from the host meets none. Dropped items are each game's own (a mob's drops go to whoever killed it; what a player throws down the others do not see). Players cannot hurt each other. Each pane of a split screen is a whole game — its own chunks, meshes and workers — so two cost twice the memory. When the host leaves, the session ends. No chat. The network is the local one: no way through a router |
| Menu scene | A model baked from real terrain (19 MB, 490 thousand triangles): two views of it and the way between them | Only what those cameras see is in it, so a new view means a new bake, and a screen wider than 16:9 is cropped, not widened. One afternoon's light: no weather, no shadows, still water. The animals graze but do not walk. It does not follow the game: after a change to the generator, the mesher or a block texture it goes on looking as the game did until it is baked again |
| Sound | Footsteps, blocks, animals, ambience and thunder from files made by a script; rain and wind made as they fall; menu music | The voices are built, not recorded (a cow is a larynx and a mouth in arithmetic): recordings dropped in under the same names replace them. No music in the world itself. Nothing is muffled by walls; other players' footsteps are not heard |
| World generation | Continents, mountain belts, rivers and creeks at sea level, elevated lakes, fjords, cliffs, mesas, 28 biomes chosen after the terrain, six kinds of cave | Waterfalls (rivers all run at sea level, so none are needed yet — a spring feature would add them); grass tufts and flowers (needs a cross-shaped model that sits on the smooth surface); per-biome grass tint; mobs spawning by biome (entity `spawnRules.biomes` is not enforced yet) |
| Far terrain | The geography as a heightfield, with trees and buildings as boxes in the two nearest levels (thinned in woods) and the surfaces of chunks the player has changed; no caves or overhangs; a river narrower than a cell shows only where a sample falls in it; a new level of detail pops in when tiles swap, and trees become a tinted canopy at the third level | Blend (geomorph) between levels; a changed chunk shows only its highest blocks (a bridge is a wall down to the ground) |
| Underground geometry | Every cave wall is meshed, and the sections of a chunk the camera could not see are left out of the draw (*What the camera cannot see*): about half the triangles from the surface | A chunk draws one range, from the lowest section it needs to the highest: one visible cave deep down brings everything above it with it. Ranges of sections a chunk (multi-draw) would leave more out. The pinholes in the mesh, which are there with or without this |
| Multiplayer | Architecture ready | Server/peer connection layer |
| See-through blocks | Leaves and glass are cutouts in the opaque pass; water and ice are blended, ordered exactly along each axis and chunk by chunk | Between axes the order is fixed (horizontal faces first), so the side of an ice block standing in water can blend in the wrong order; glass is clear with a frame, not tinted; nothing but terrain is veiled by cloud (mobs, items, rain) |
| Smooth terrain | Diagonal slopes of one block or half a block a block are planes; a lone block is a low mound; ground of different kinds blends along a ragged line, and a lone block keeps its face; shading is smooth | A gentle slope is still terraces joined by one-block ramps (leaning every terrace was tried and taken out: it changed the look of all terrain); diagonal steps three or more wide still zigzag; a step of two blocks right beside low ground is a wall, so ground steeper than the diagonal breaks into teeth; a slope between an axis and a diagonal is close to a plane, not one |
| Controller | Play and every menu, analog movement, no pointer lock needed; names typed on a keypad | No rumble; no remapping; the other text boxes (a world's name, the creative search, a network address) still need a keyboard; sensitivity is shared with the mouse |
| Textures | 32 × 32, painted by a script, mipmapped | Item icons are still the 16 × 16 originals; block textures repeat every block (hidden by the shader's large-scale variation, not removed) |
| Draw calls | ~105 at render distance 8 and ~280 on Pro, looking at the horizon — one opaque + one transparent mesh per chunk, each a draw. What a draw costs is now mostly its own GL calls (bind the vertex array and the light texture, one `uChunk` upload, draw). On integrated graphics Pro is still the preset limited by its triangles (1.1 M now, 2.1 M before the caves were left out) | Merge chunks into 2×2 regions (one light volume per region) — about a quarter of the draws |
| Pixels | What a frame costs on integrated graphics is mostly its pixels (*Where a frame goes*): half the resolution more than doubles Classic's frame rate. The drawing buffer follows the screen's pixel ratio up to 2, so a laptop at 150–200% scaling draws two to four times the pixels of a 1080p panel at every preset, Simple included | Resolution that follows the frame time, or a cap on the pixel count rather than on the ratio — both change how sharp the picture is, so they are choices to make, not optimisations. Cheaper sky-light lookup (it is the dearest single thing in the chunk shader) |
| Memory | Chunk geometry is the largest holder: ~330 KB a chunk on the GPU, 107 MB at render distance 8 and 275 MB on Pro (`__wwMemory()`), then voxels (55 MB on Pro) and light volumes | Quantise positions (they are floats, half of each vertex); fewer cave triangles (below) |
| Smooth meshing | 7–8 ms a chunk, nearly all of it the smooth-shape pass now that the greedy sweep reads only the cells with faces; each voxel is described once (`prepare` only looks at its corners) | `topCrossNear` reads five levels for every slope; inline `SmoothField.get` for in-chunk reads |
| Chunk transfer | Palette snapshot, copied per job | `SharedArrayBuffer` voxel store (needs COOP/COEP headers on the server) |
| Code signing | Unsigned — SmartScreen warns | OV/EV certificate or Azure Trusted Signing |
