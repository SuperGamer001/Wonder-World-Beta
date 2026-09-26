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

function makeDef(src) {
    let flags = 0;
    if (src.transparent)  flags |= BLOCK_FLAGS.TRANSPARENT;
    if (src.liquid)       flags |= BLOCK_FLAGS.LIQUID;
    if (src.noCollision)  flags |= BLOCK_FLAGS.NO_COLLISION;
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
        requiresTool: src.requiresTool ?? null,   // 'pickaxe' | 'axe' | 'shovel' — null = bare hand ok
        drops:        src.drops        ?? null,   // [{ item, count, chance }] on break
        interactType: src.interactType ?? null,   // 'chest' | 'crafting' | 'oven' | 'smelter' | 'anvil'
        terrainType:  resolveTerrainType(src),    // 'solid' | 'mesh' — see TERRAIN_TYPES
    };
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
    getByName(n) { return this._byName.get(n);                     }

    isTransparent(id)  { return id === 0 || !!(this._byId[id]?.flags & BLOCK_FLAGS.TRANSPARENT); }
    isLiquid(id)       { return              !!(this._byId[id]?.flags & BLOCK_FLAGS.LIQUID);      }
    isInteractable(id) { return              !!(this._byId[id]?.flags & BLOCK_FLAGS.INTERACTABLE);}
    isSolid(id)        { return id !== 0    && !this.isTransparent(id);                           }
    isMesh(id)         { return              this._byId[id]?.terrainType === 'mesh';              }

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
