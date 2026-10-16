import { shapeFlags, ShapeSet } from './BlockShapes.js';

// Block flag bitmasks
export const BLOCK_FLAGS = {
    TRANSPARENT:  1 << 0,
    LIQUID:       1 << 1,
    NO_COLLISION: 1 << 2,
    INTERACTABLE: 1 << 3,
};

// How a block takes part in a smooth-terrain world. Permanent per block type —
// neighbours change a Mesh block's generated geometry, never its type.
//   'solid' — always a plain cube (building blocks, liquids, see-through blocks)
//   'mesh'  — deforms inside its own voxel to form smooth terrain
// Blocky worlds ignore this entirely.
export const TERRAIN_TYPES = ['solid', 'mesh'];

function resolveTerrainType(src) {
    const seeThrough = !!(src.transparent || src.liquid) || src.id === 0;
    if (src.terrainType === 'mesh' && seeThrough) {
        // A deformed see-through block would expose the un-smoothed faces
        // behind it, and liquids are driven by the water simulator as cubes.
        console.warn(`[BlockRegistry] ${src.name} is transparent/liquid and cannot be 'mesh'; using 'solid'`);
        return 'solid';
    }
    if (TERRAIN_TYPES.includes(src.terrainType)) return src.terrainType;
    // Definitions that predate the field: natural opaque blocks smooth, anything
    // see-through or interactive stays a cube.
    return seeThrough || src.interactable ? 'solid' : 'mesh';
}

// How a see-through block is drawn (GreedyMesher, the chunk shaders):
//   'cutout'      — with the opaque blocks: each texel is there or it is not
//                   (alpha test), and it writes depth, so nothing needs
//                   sorting. Leaves and glass.
//   'translucent' — blended over what is behind it, in a second pass: water, ice.
// Blocks that are not see-through are 'opaque'. Definitions may say
// "render": "cutout" | "translucent"; without it liquids are translucent,
// leaves and glass (by flag or name) cutout, anything else translucent.
export const RENDER_MODES = ['opaque', 'cutout', 'translucent'];

function resolveRender(src, seeThrough) {
    if (!seeThrough || src.model) return 'opaque';
    if (src.render === 'cutout' || src.render === 'translucent') return src.liquid ? 'translucent' : src.render;
    if (src.liquid) return 'translucent';
    return src.leaves || /LEAVES$|^GLASS$/.test(src.name ?? '') ? 'cutout' : 'translucent';
}

// Directional models face one of these ways (the way a wall torch leans).
export const FACINGS = ['east', 'west', 'south', 'north'];   // +X -X +Z -Z

// How much water a liquid block is (`fluid`): 1 … 7 a flow of that level
// (7 beside its source, 1 at the end of its reach), FLUID_FALL water coming
// down from the block above, FLUID_SOURCE a block of standing water — any
// liquid that does not say. 0: not water at all. See WaterSimulator.js.
export const FLUID_FALL = 8, FLUID_SOURCE = 9;

function resolveFluid(src) {
    if (!src.liquid) return 0;
    const f = src.fluid;
    if (f === 'fall') return FLUID_FALL;
    return Number.isInteger(f) && f >= 1 && f <= 7 ? f : FLUID_SOURCE;
}

function makeDef(src) {
    let flags = 0;
    // What the block's model (BlockShapes.js) says of it: whether it stops a
    // body, is climbed, is washed away … Null for a cube.
    const shaped = src.model ? shapeFlags({ model: src.model, facing: src.facing, shape: src.shape ?? {} }) : null;
    // A model block (torch, lantern) never fills its voxel, so it can never
    // hide a face behind it or stop light: it is see-through by definition.
    if (src.transparent || src.model) flags |= BLOCK_FLAGS.TRANSPARENT;
    if (src.liquid)       flags |= BLOCK_FLAGS.LIQUID;
    // A model with nothing in it to walk into is walked through, whatever its file says.
    if (src.noCollision || (shaped && !shaped.collides)) flags |= BLOCK_FLAGS.NO_COLLISION;
    if (src.interactable) flags |= BLOCK_FLAGS.INTERACTABLE;
    return {
        id:           src.id,
        name:         src.name,
        flags,
        color:        src.color        ?? [0.7, 0.7, 0.7],
        topColor:     src.topColor     ?? null,
        bottomColor:  src.bottomColor  ?? null,
        sideColor:    src.sideColor    ?? null,
        // Individual horizontal face colors (override sideColor when set)
        leftColor:    src.leftColor    ?? null,   // -X face
        rightColor:   src.rightColor   ?? null,   // +X face
        frontColor:   src.frontColor   ?? null,   // -Z face
        backColor:    src.backColor    ?? null,   // +Z face
        hardness:     src.hardness     ?? 1.0,    // mining time multiplier
        // How little grip it gives a foot, 0 (ground) … 1 (none): ice.
        slippery:     Math.max(0, Math.min(1, +(src.slippery ?? 0) || 0)),
        requiresTool: src.requiresTool ?? null,   // 'pickaxe' | 'axe' | 'shovel' — null = bare hand ok
        // The tool that is quick at it — the only one whose mining speed
        // counts on this block. The one it needs, unless it says another:
        // earth is a shovel's and wood an axe's, though a hand will do.
        tool:         src.tool ?? src.requiresTool ?? null,
        drops:        src.drops        ?? null,   // [{ item, count, chance }] on break
        interactType: src.interactType ?? null,   // 'chest' | 'crafting' | 'oven' | 'smelter' | 'anvil'
        // Which sounds it makes (Sound.js: blockSoundFamily); else guessed from its name.
        sound:        typeof src.sound === 'string' ? src.sound : null,
        terrainType:  resolveTerrainType({ ...src, transparent: !!(flags & BLOCK_FLAGS.TRANSPARENT) }),
        // Light the block gives off, 0..15 on the sky-light scale (Blocklight.js).
        light:        Math.max(0, Math.min(15, Math.round(src.light ?? 0))),
        // Drawn full-bright, ignoring the light around it (0..1). Defaults to on
        // for anything that gives off light. With Eye Adaptation on, its bright
        // texels also glow (HDR) and bloom.
        glow:         Math.max(0, Math.min(1, +(src.glow ?? (src.light > 0 ? 1 : 0)) || 0)),
        // A small shape instead of a cube (workers/BlockModels.js): 'torch',
        // 'wall_torch', 'lantern', 'hanging_lantern'. Model blocks are not
        // greedy-meshed and never hide their neighbours' faces.
        model:        src.model        ?? null,
        facing:       FACINGS.includes(src.facing) ? src.facing : null,   // directional models
        // What else changes the model: { half, open, part, stage, plant, lit … } (BlockShapes.js).
        shape:        src.shape && typeof src.shape === 'object' ? src.shape : null,
        // From the model: it stops a body with its own boxes (`shaped`), which
        // may stand above its voxel (`tall`); it is climbed; water takes it
        // away; the ground beside it takes no notice of it and it stands on
        // the ground's own surface (`soft`, smooth worlds); it stops light and
        // rain as a cube does (`shade`); fences reach out to it (`joins`); its
        // own shape depends on its neighbours (`connect`); and where rain
        // stops on it, in sixteenths (0: it falls through).
        shaped:       !!shaped?.collides,
        tall:         !!shaped?.tall,
        climb:        !!shaped?.climb,
        wash:         !!shaped?.wash,
        soft:         !!shaped?.soft,
        shade:        !!shaped?.shade,
        joins:        !!shaped?.joins,
        connect:      !!shaped?.connect,
        rain:         shaped ? shaped.rain : 16,
        // It can shut on whoever is in it (a door, a gate), who may then walk on out of it.
        closes:       !!shaped?.closes,
        // Sixteenths up to where someone sits on it (a chair) or lies on it (a bed); 0: nobody does.
        seat:         shaped?.seat ?? 0,
        lie:          shaped?.lie ?? 0,
        // Water: see resolveFluid.
        fluid:        resolveFluid(src),
        // One of several blocks an item puts down (a stair turned another
        // way, a door standing open): it has no entry of its own in the
        // creative inventory, and no item of its own.
        variant:      !!src.variant,
        // Which of them goes down, and how: { mode, … } (world.js: _placementFor).
        place:        src.place && typeof src.place === 'object' ? src.place : null,
        // What using it (the right button) does: { toggle | eat | sleep | … } (world.js: _useBlock).
        use:          src.use && typeof src.use === 'object' ? src.use : null,
        // [dx, dy, dz] of its other half (a door's top, a bed's head): the two are used and broken as one.
        twin:         Array.isArray(src.twin) && src.twin.length === 3 ? src.twin.map(Number) : null,
        // A thing of many blocks (a painting several blocks across): [[dx, dy, dz], …] of its other
        // pieces, and its name (`piece`), which every one of them has. Used and broken as one.
        group:        Array.isArray(src.group) ? src.group.filter(o => Array.isArray(o) && o.length === 3).map(o => o.map(Number)) : null,
        piece:        typeof src.piece === 'string' ? src.piece : null,
        // How readily it catches fire, 0 (never) … 100.
        flammable:    Math.max(0, Math.min(100, +src.flammable || 0)),
        // What it does by itself in time: 'fire' | 'sapling' | 'bomb' (world.js: *Things that happen by themselves*).
        tick:         typeof src.tick === 'string' ? src.tick : null,
        // What grows from a sapling (a StructurePlacer tree type).
        grows:        typeof src.grows === 'string' ? src.grows : null,
        // Which block goes down for the face that was clicked, by block name:
        // { floor, ceiling, east, west, south, north } (the clicked face's
        // direction; "floor" is the top of a block). A face with no entry
        // cannot take it. Without this, the block itself is placed on any face.
        placement:    src.placement    ?? null,
        // [dx, dy, dz] of the block this one rests or hangs on. Breaking that
        // block breaks this one too, and drops it.
        support:      Array.isArray(src.support) && src.support.length === 3 ? src.support.map(Number) : null,
        // Texture files in data/textures/blocks/: "texture" for every face, or
        // "textures": { top, side, bottom } (a missing face falls back to top).
        // Blocks without either keep world.js's built-in face map, or their
        // vertex colour.
        textures:     resolveTextures(src),
        // Leaves: sway in the wind (world.js).
        leaves:       !!src.leaves,
        // How a see-through block is drawn (see RENDER_MODES).
        render:       resolveRender(src, !!(flags & BLOCK_FLAGS.TRANSPARENT)),
        // Smooth worlds: how readily this ground spreads over the edge of the
        // ground next to it (0 = takes no part). Where two kinds of ground
        // meet, the one with the higher number creeps a little way onto the
        // other, so grass ends in a ragged edge on sand rather than along the
        // side of a block. Natural ground only (GreedyMesher.blendCode).
        blend:        Math.max(0, Math.min(255, Math.round(+src.blend || 0))),
    };
}

function resolveTextures(src) {
    if (typeof src.texture === 'string') return { top: src.texture, side: src.texture, bottom: src.texture };
    const t = src.textures;
    if (!t || typeof t.top !== 'string') return null;
    return { top: t.top, side: t.side ?? t.top, bottom: t.bottom ?? t.top };
}

export class BlockRegistry {
    constructor() {
        this._byId   = [];
        this._byName = new Map();
    }

    register(src) {
        const def = makeDef(src);
        this._byId[def.id] = def;
        this._byName.set(def.name, def);
        return def;
    }

    get(id)      { return this._byId[id]        ?? this._byId[0]; }

    /**
     * The shapes of the blocks that are not cubes, for collision and the
     * crosshair (BlockShapes.ShapeSet). Made when first asked for: register
     * every block first.
     */
    get shapes() { return this._shapes ?? (this._shapes = new ShapeSet(this)); }
    getByName(n) { return this._byName.get(n);                     }

    isTransparent(id)  { return id === 0 || !!(this._byId[id]?.flags & BLOCK_FLAGS.TRANSPARENT); }
    isLiquid(id)       { return              !!(this._byId[id]?.flags & BLOCK_FLAGS.LIQUID);      }
    isInteractable(id) { return              !!(this._byId[id]?.flags & BLOCK_FLAGS.INTERACTABLE);}
    isSolid(id)        { return id !== 0    && !this.isTransparent(id);                           }
    isMesh(id)         { return              this._byId[id]?.terrainType === 'mesh';              }
    hasModel(id)       { return              !!this._byId[id]?.model;                            }
    /** How much water block `id` is: 0 none, 1 … 7 a flow, FLUID_FALL, FLUID_SOURCE. */
    fluidOf(id)        { return              this._byId[id]?.fluid ?? 0;                          }
    /** How high the water stands in a block of it, 0 … 1. */
    fluidHeight(id)    { const f = this._byId[id]?.fluid ?? 0; return f >= FLUID_FALL ? 1 : f / 8; }
    isClimb(id)        { return              !!this._byId[id]?.climb;                            }
    isTall(id)         { return              !!this._byId[id]?.tall;                             }
    lightOf(id)        { return              this._byId[id]?.light ?? 0;                         }

    /**
     * Whether the crosshair can target it. Anything with collision, plus
     * model blocks (torches, lanterns), which the player walks through but
     * still has to be able to pick up.
     */
    isTargetable(id) {
        return id !== 0 && (!this.isNoCollision(id) || this.hasModel(id));
    }

    // No collision = liquid OR explicitly flagged. Leaves etc. are transparent but DO stop you.
    isNoCollision(id) {
        if (id === 0) return true;
        const flags = this._byId[id]?.flags ?? 0;
        return !!(flags & BLOCK_FLAGS.NO_COLLISION) || !!(flags & BLOCK_FLAGS.LIQUID);
    }

    // Flat array safe to clone into workers via postMessage
    serialize() {
        return this._byId.filter(Boolean).map(b => ({ ...b }));
    }

    static deserialize(arr) {
        const reg = new BlockRegistry();
        for (const b of arr) {
            reg._byId[b.id] = b;
            reg._byName.set(b.name, b);
        }
        return reg;
    }
}

// Populate a registry from merged gamepack JSON
export function buildRegistryFromGamePack(gamepackData) {
    const reg = new BlockRegistry();
    for (const def of (gamepackData.blocks ?? [])) reg.register(def);
    return reg;
}
