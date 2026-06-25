/**
 * ItemRegistry — looks up item definitions by string ID.
 * Populated from gamepack data/items/ JSON files.
 */
export class ItemRegistry {
    constructor() {
        this._items = new Map(); // id -> definition
    }

    register(def) {
        this._items.set(def.id, def);
    }

    getItem(id)   { return this._items.get(id) ?? null; }
    getAllItems()  { return [...this._items.values()];   }
    hasItem(id)   { return this._items.has(id);          }
}

export function buildItemRegistryFromGamePack(gamepackData) {
    const reg = new ItemRegistry();
    for (const def of (gamepackData.items ?? [])) reg.register(def);
    return reg;
}
