// Block flag bitmasks
export const BLOCK_FLAGS = {
    TRANSPARENT:  1 << 0,
    LIQUID:       1 << 1,
    NO_COLLISION: 1 << 2,
};

// A block definition as stored in the registry
function makeDef(src) {
    let flags = 0;
    if (src.transparent)  flags |= BLOCK_FLAGS.TRANSPARENT;
    if (src.liquid)       flags |= BLOCK_FLAGS.LIQUID;
    if (src.noCollision)  flags |= BLOCK_FLAGS.NO_COLLISION;
    return {
        id:           src.id,
        name:         src.name,
        flags,
        color:        src.color        ?? [0.7, 0.7, 0.7],
        topColor:     src.topColor     ?? null,
        bottomColor:  src.bottomColor  ?? null,
        sideColor:    src.sideColor    ?? null,
    };
}

export class BlockRegistry {
    constructor() {
        this._byId   = [];      // blockDef[]  indexed by id
        this._byName = new Map(); // name -> blockDef
    }

    register(src) {
        const def = makeDef(src);
        this._byId[def.id] = def;
        this._byName.set(def.name, def);
        return def;
    }

    get(id)       { return this._byId[id]        ?? this._byId[0]; }
    getByName(n)  { return this._byName.get(n);                      }

    isTransparent(id) { return id === 0 || !!(this._byId[id]?.flags & BLOCK_FLAGS.TRANSPARENT); }
    isLiquid(id)      { return              !!(this._byId[id]?.flags & BLOCK_FLAGS.LIQUID);      }
    isSolid(id)       { return id !== 0    && !this.isTransparent(id);                           }

    // Flat array safe to clone into workers via postMessage
    serialize() {
        return this._byId.map(b => ({ ...b }));
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

// Populate a registry from gamepack JSON
export function buildRegistryFromGamePack(gamepackData) {
    const reg = new BlockRegistry();
    const blocks = gamepackData.blocks ?? [];
    for (const def of blocks) reg.register(def);
    return reg;
}
