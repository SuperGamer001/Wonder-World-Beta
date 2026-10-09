/**
 * BlockTextures — which texture file each face of each block shows.
 *
 * The first blocks are listed here (BLOCK_TEX_LAYERS, BLOCK_FACE_MAP); every
 * other names its own in its JSON ("texture" / "textures", see BlockRegistry).
 * `blockTextureLayers` puts the two together for a registry: the list of
 * files, in the order of their layers in the texture array, and for each block
 * the layer of its top, side and bottom.
 *
 * No Three.js and no DOM: the game (world.js) and the tool that bakes the
 * place behind the menus (tools/gen_menu_scene.mjs) both go by it.
 */

// Ordered list of PNG paths; index = layer number in the DataArrayTexture
export const BLOCK_TEX_LAYERS = [
    'data/textures/blocks/Dirt.png',        // 0
    'data/textures/blocks/Grass.png',       // 1  (grass top)
    'data/textures/blocks/Grass_Side.png',  // 2  (grass side)
    'data/textures/blocks/Stone.png',       // 3
    'data/textures/blocks/Sand.png',        // 4
    'data/textures/blocks/Water.png',       // 5
    'data/textures/blocks/Log_Side.png',    // 6
    'data/textures/blocks/Log_Top.png',     // 7
    'data/textures/blocks/leaves.png',      // 8
    'data/textures/blocks/gravel.png',      // 9
    'data/textures/blocks/Coal_Ore.png',    // 10
    'data/textures/blocks/Iron_Ore.png',    // 11
    'data/textures/blocks/Gold_Ore.png',    // 12
    'data/textures/blocks/snow.png',        // 13
    'data/textures/blocks/Ice.png',         // 14
    'data/textures/blocks/Sandstone.png',   // 15
    'data/textures/blocks/Clay.png',        // 16
    'data/textures/blocks/Bedrock.png',     // 17
    'data/textures/blocks/SnowDirt.png',    // 18
    'data/textures/blocks/Diorite.png',     // 19
    'data/textures/blocks/Granite.png',           // 20
    'data/textures/blocks/Crafting_Table_Top.png', // 21
    'data/textures/blocks/Crafting_Table_Side.png',// 22
    'data/textures/blocks/Oven_Top.png',           // 23
    'data/textures/blocks/Oven_Front.png',         // 24
    'data/textures/blocks/Oven_Side.png',          // 25
    'data/textures/blocks/Smelter_Top.png',        // 26
    'data/textures/blocks/Smelter_Front.png',      // 27
    'data/textures/blocks/Smelter_Side.png',       // 28
    'data/textures/blocks/Chest_Top.png',          // 29
    'data/textures/blocks/Chest_Front.png',        // 30
    'data/textures/blocks/Chest_Side.png',         // 31
    'data/textures/blocks/Anvil.png',              // 32
    'data/textures/blocks/Torch.png',              // 33  (model sheet: BlockModels.js)
    'data/textures/blocks/Lantern.png',            // 34  (model sheet)
    'data/textures/blocks/Lamp.png',               // 35
    'data/textures/blocks/SnowDirt_Side.png',      // 36
];

// blockId → { top, side, bottom } texture layer index (-1 = vertex color fallback)
export const BLOCK_FACE_MAP = {
    1:  { top: 1,  side: 2,  bottom: 0  },  // GRASS
    2:  { top: 0,  side: 0,  bottom: 0  },  // DIRT
    3:  { top: 3,  side: 3,  bottom: 3  },  // STONE
    4:  { top: 4,  side: 4,  bottom: 4  },  // SAND
    5:  { top: 5,  side: 5,  bottom: 5  },  // WATER
    6:  { top: 7,  side: 6,  bottom: 7  },  // WOOD LOG
    7:  { top: 8,  side: 8,  bottom: 8  },  // LEAVES
    8:  { top: 9,  side: 9,  bottom: 9  },  // GRAVEL
    9:  { top: 10, side: 10, bottom: 10 },  // COAL_ORE
    10: { top: 11, side: 11, bottom: 11 },  // IRON_ORE
    11: { top: 12, side: 12, bottom: 12 },  // GOLD_ORE
    12: { top: 13, side: 13, bottom: 13 },  // SNOW
    13: { top: 14, side: 14, bottom: 14 },  // ICE
    14: { top: 15, side: 15, bottom: 15 },  // SANDSTONE
    15: { top: 16, side: 16, bottom: 16 },  // CLAY
    16: { top: 18, side: 36, bottom: 0  },  // SNOW_DIRT
    17: { top: 20, side: 20, bottom: 20 },  // GRANITE
    18: { top: 19, side: 19, bottom: 19 },  // DIORITE
    19: { top: 17, side: 17, bottom: 17 },  // BEDROCK
    20: { top: 21, side: 22, bottom: 0  },  // CRAFTING_TABLE
    21: { top: 23, side: 25, bottom: 3  },  // OVEN
    22: { top: 26, side: 28, bottom: 3  },  // SMELTER
    23: { top: 29, side: 31, bottom: 31 },  // CHEST
    24: { top: 32, side: 32, bottom: 32 },  // ANVIL
    36: { top: 33, side: 33, bottom: 33 },  // TORCH
    37: { top: 33, side: 33, bottom: 33 },  // WALL_TORCH_EAST
    38: { top: 33, side: 33, bottom: 33 },  // WALL_TORCH_WEST
    39: { top: 33, side: 33, bottom: 33 },  // WALL_TORCH_SOUTH
    40: { top: 33, side: 33, bottom: 33 },  // WALL_TORCH_NORTH
    41: { top: 34, side: 34, bottom: 34 },  // LANTERN
    42: { top: 34, side: 34, bottom: 34 },  // HANGING_LANTERN
    43: { top: 35, side: 35, bottom: 35 },  // LAMP
};


/**
 * The layers and face map for a registry: the built-in ones above plus a layer
 * for every texture a block's JSON names that the built-in map does not
 * already cover. Leaves sway in the wind: `swayRange` is the contiguous run of
 * layers added for blocks flagged `leaves` (the built-in leaves layer is
 * the shader's own to know).
 */
export function blockTextureLayers(reg) {
    const layers = BLOCK_TEX_LAYERS.slice();
    const faceMap = { ...BLOCK_FACE_MAP };
    const index = new Map(layers.map((p, i) => [p, i]));
    const layerOf = (file) => {
        const p = `data/textures/blocks/${file}`;
        if (!index.has(p)) { index.set(p, layers.length); layers.push(p); }
        return index.get(p);
    };
    const defs = reg.serialize().filter(b => b.textures && !BLOCK_FACE_MAP[b.id]);
    // Leaves first, so their layers form one run the vertex shader can test.
    defs.sort((a, b) => (b.leaves ? 1 : 0) - (a.leaves ? 1 : 0));
    let lo = -10, hi = -10;
    for (const b of defs) {
        const face = { top: layerOf(b.textures.top), side: layerOf(b.textures.side), bottom: layerOf(b.textures.bottom) };
        faceMap[b.id] = face;
        if (b.leaves) {
            if (lo < 0) lo = face.top;
            hi = Math.max(hi, face.top, face.side, face.bottom);
        }
    }
    return { layers, faceMap, swayRange: [lo, hi] };
}
