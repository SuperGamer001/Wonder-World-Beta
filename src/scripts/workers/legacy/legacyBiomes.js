// The biome definitions worlds made before the world-generation overhaul were
// generated with (data/biomes/ as it was then), frozen so those worlds keep
// generating the same terrain. Do not edit.
export const LEGACY_BIOMES = [
  {
    "name": "DESERT",
    "temperature": 0.9,
    "humidity": 0.1,
    "baseHeight": 62,
    "heightVariation": 14,
    "heightOctaves": 4,
    "heightFrequency": 0.002,
    "mountainBlend": 0.03,
    "surfaceBlock": "SAND",
    "subsurfaceBlock": "SAND",
    "stoneBlock": "SANDSTONE",
    "deepBlock": "STONE",
    "weather": {
      "precipitation": 0.12,
      "dusty": 1
    },
    "structures": {
      "tree": {
        "frequency": 0.0002,
        "minSpacing": 20,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0043,
        "minSize": 3,
        "maxSize": 10
      },
      {
        "block": "GOLD_ORE",
        "minY": -128,
        "maxY": -90,
        "frequency": 0.004,
        "minSize": 2,
        "maxSize": 7
      }
    ]
  },
  {
    "name": "FOREST",
    "temperature": 0.58,
    "humidity": 0.72,
    "baseHeight": 66,
    "heightVariation": 24,
    "heightOctaves": 5,
    "heightFrequency": 0.0022,
    "mountainBlend": 0.08,
    "surfaceBlock": "GRASS",
    "subsurfaceBlock": "DIRT",
    "stoneBlock": "STONE",
    "deepBlock": "STONE",
    "structures": {
      "tree": {
        "frequency": 0.028,
        "minSpacing": 3,
        "spawnInWater": false
      },
      "house": {
        "frequency": 0.0001,
        "minSpacing": 48,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0072,
        "minSize": 4,
        "maxSize": 14
      },
      {
        "block": "IRON_ORE",
        "minY": -128,
        "maxY": 200,
        "frequency": 0.007,
        "minSize": 3,
        "maxSize": 9
      }
    ]
  },
  {
    "name": "MOUNTAINS",
    "temperature": 0.3,
    "humidity": 0.4,
    "baseHeight": 90,
    "heightVariation": 90,
    "heightOctaves": 6,
    "heightFrequency": 0.004,
    "mountainBlend": 0.8,
    "surfaceBlock": "STONE",
    "subsurfaceBlock": "STONE",
    "stoneBlock": "STONE",
    "deepBlock": "GRANITE",
    "structures": {
      "tree": {
        "frequency": 0.001,
        "minSpacing": 8,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0079,
        "minSize": 4,
        "maxSize": 14
      },
      {
        "block": "IRON_ORE",
        "minY": -128,
        "maxY": 200,
        "frequency": 0.009,
        "minSize": 3,
        "maxSize": 10
      },
      {
        "block": "GOLD_ORE",
        "minY": -128,
        "maxY": -90,
        "frequency": 0.005,
        "minSize": 2,
        "maxSize": 7
      }
    ]
  },
  {
    "name": "OCEAN",
    "temperature": 0.5,
    "humidity": 1,
    "baseHeight": 36,
    "heightVariation": 12,
    "heightOctaves": 3,
    "heightFrequency": 0.002,
    "mountainBlend": 0.02,
    "surfaceBlock": "GRAVEL",
    "subsurfaceBlock": "CLAY",
    "stoneBlock": "STONE",
    "deepBlock": "STONE",
    "structures": {
      "tree": {
        "frequency": 0,
        "minSpacing": 99,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0043,
        "minSize": 3,
        "maxSize": 10
      }
    ]
  },
  {
    "name": "PLAINS",
    "temperature": 0.6,
    "humidity": 0.5,
    "baseHeight": 64,
    "heightVariation": 22,
    "heightOctaves": 5,
    "heightFrequency": 0.0022,
    "mountainBlend": 0.05,
    "surfaceBlock": "GRASS",
    "subsurfaceBlock": "DIRT",
    "stoneBlock": "STONE",
    "deepBlock": "STONE",
    "structures": {
      "tree": {
        "frequency": 0.0035,
        "minSpacing": 5,
        "spawnInWater": false
      },
      "house": {
        "frequency": 0.00015,
        "minSpacing": 48,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0072,
        "minSize": 4,
        "maxSize": 14
      },
      {
        "block": "IRON_ORE",
        "minY": -128,
        "maxY": 200,
        "frequency": 0.007,
        "minSize": 3,
        "maxSize": 9
      },
      {
        "block": "GOLD_ORE",
        "minY": -128,
        "maxY": -90,
        "frequency": 0.003,
        "minSize": 2,
        "maxSize": 6
      }
    ]
  },
  {
    "name": "SNOWY_MOUNTAINS",
    "temperature": 0.05,
    "humidity": 0.35,
    "baseHeight": 88,
    "heightVariation": 80,
    "heightOctaves": 6,
    "heightFrequency": 0.004,
    "mountainBlend": 0.85,
    "surfaceBlock": "SNOW",
    "subsurfaceBlock": "STONE",
    "stoneBlock": "STONE",
    "deepBlock": "GRANITE",
    "structures": {
      "tree": {
        "frequency": 0.0005,
        "minSpacing": 12,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0072,
        "minSize": 4,
        "maxSize": 14
      },
      {
        "block": "IRON_ORE",
        "minY": -128,
        "maxY": 200,
        "frequency": 0.008,
        "minSize": 3,
        "maxSize": 10
      },
      {
        "block": "GOLD_ORE",
        "minY": -128,
        "maxY": -90,
        "frequency": 0.005,
        "minSize": 2,
        "maxSize": 7
      }
    ]
  },
  {
    "name": "SNOWY_PLAINS",
    "temperature": 0.1,
    "humidity": 0.3,
    "baseHeight": 64,
    "heightVariation": 20,
    "heightOctaves": 5,
    "heightFrequency": 0.0022,
    "mountainBlend": 0.06,
    "surfaceBlock": "SNOW",
    "subsurfaceBlock": "SNOW_DIRT",
    "stoneBlock": "STONE",
    "deepBlock": "DIORITE",
    "structures": {
      "tree": {
        "frequency": 0.004,
        "minSpacing": 6,
        "spawnInWater": false
      }
    },
    "ores": [
      {
        "block": "COAL_ORE",
        "minY": -90,
        "maxY": 279,
        "frequency": 0.0072,
        "minSize": 4,
        "maxSize": 14
      },
      {
        "block": "IRON_ORE",
        "minY": -128,
        "maxY": 200,
        "frequency": 0.008,
        "minSize": 3,
        "maxSize": 10
      }
    ]
  }
];
