"""
Generates the 16x16 textures for the terrain, tree and mushroom blocks added
with the world-generation overhaul (data/blocks/44_* ... 71_*).

Most are derived from the existing textures, so they share their hand-drawn
look: the source's light pattern is kept and recoloured to a new palette
(recolour), or the grass-side band is recoloured separately from its dirt
(banded). A few with no close source (birch bark, cactus, mushroom caps) are
drawn from simple deterministic patterns.

    python tools/gen_terrain_textures.py

Needs Pillow. Writes into data/textures/blocks/, overwriting its own outputs
only; tweak a palette below and re-run to adjust a block's colour.
"""
import os
import random
import sys
from PIL import Image

# Superseded by tools/gen_block_textures.py, which paints every block texture
# from scratch. This one recolours the 16-pixel art that used to be in
# data/textures/blocks/ and would overwrite the new textures with versions
# derived from them, so it only runs when asked twice.
if '--force' not in sys.argv:
    sys.exit('gen_terrain_textures.py is superseded by gen_block_textures.py (npm run blocktex). '
             'Pass --force to run it anyway.')

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'data', 'textures', 'blocks')
N = 16


def load(name):
    return Image.open(os.path.join(SRC, name)).convert('RGBA').resize((N, N), Image.NEAREST)


def save(img, name):
    img.save(os.path.join(SRC, name))
    print('wrote', name)


def lum(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def recolour(src, colour, contrast=1.0, seed=None, speckle=0.0, speckle_colour=None):
    """Keep src's light pattern, around a new average colour."""
    px = [src.getpixel((x, y)) for y in range(N) for x in range(N)]
    mean = sum(lum(p) for p in px) / len(px)
    out = Image.new('RGBA', (N, N))
    rnd = random.Random(seed)
    for y in range(N):
        for x in range(N):
            p = src.getpixel((x, y))
            k = 1 + contrast * (lum(p) - mean) / max(mean, 1)
            c = [max(0, min(255, int(v * k))) for v in colour]
            if speckle and rnd.random() < speckle:
                c = list(speckle_colour)
            out.putpixel((x, y), (c[0], c[1], c[2], 255))
    return out


def is_green(p):
    return p[1] > p[0] * 1.05 and p[1] > p[2] * 1.2


def banded(side, top_colour, dirt_colour=None, contrast=1.0):
    """Grass-side style: recolour the green band, and optionally the dirt."""
    out = side.copy()
    greens = [side.getpixel((x, y)) for y in range(N) for x in range(N) if is_green(side.getpixel((x, y)))]
    dirts = [side.getpixel((x, y)) for y in range(N) for x in range(N) if not is_green(side.getpixel((x, y)))]
    gm = sum(lum(p) for p in greens) / max(len(greens), 1)
    dm = sum(lum(p) for p in dirts) / max(len(dirts), 1)
    for y in range(N):
        for x in range(N):
            p = side.getpixel((x, y))
            if is_green(p):
                k = 1 + contrast * (lum(p) - gm) / max(gm, 1)
                c = [max(0, min(255, int(v * k))) for v in top_colour]
            elif dirt_colour:
                k = 1 + (lum(p) - dm) / max(dm, 1)
                c = [max(0, min(255, int(v * k))) for v in dirt_colour]
            else:
                continue
            out.putpixel((x, y), (c[0], c[1], c[2], 255))
    return out


def streaks(img, rows, factor):
    """Darken whole rows (slate's bedding planes)."""
    out = img.copy()
    for y in rows:
        for x in range(N):
            p = out.getpixel((x, y))
            out.putpixel((x, y), (int(p[0] * factor), int(p[1] * factor), int(p[2] * factor), 255))
    return out


def noise_tile(seed, base, spread, blobs=None):
    rnd = random.Random(seed)
    out = Image.new('RGBA', (N, N))
    for y in range(N):
        for x in range(N):
            k = 1 + (rnd.random() - 0.5) * spread
            c = [max(0, min(255, int(v * k))) for v in base]
            out.putpixel((x, y), (c[0], c[1], c[2], 255))
    return out


def birch_side():
    rnd = random.Random(64)
    out = noise_tile(64, (218, 214, 204), 0.10)
    for _ in range(7):
        y = rnd.randrange(N)
        x0 = rnd.randrange(N)
        for dx in range(rnd.randrange(2, 6)):
            x = (x0 + dx) % N
            out.putpixel((x, y), (38, 36, 34, 255))
            if rnd.random() < 0.4 and y + 1 < N:
                out.putpixel((x, y + 1), (70, 66, 60, 255))
    return out


def cactus_side():
    out = Image.new('RGBA', (N, N))
    for y in range(N):
        for x in range(N):
            rib = x % 4
            base = (70, 128, 44) if rib in (1, 2) else (46, 96, 30)
            if x in (0, 15):
                base = (36, 78, 24)
            if (x % 4 == 0) and (y % 4 == 2):
                base = (228, 222, 190)        # spines
            k = 1 + ((x * 7 + y * 13) % 5 - 2) * 0.03
            out.putpixel((x, y), tuple(int(v * k) for v in base) + (255,))
    return out


def cactus_top():
    out = Image.new('RGBA', (N, N))
    for y in range(N):
        for x in range(N):
            d = max(abs(x - 7.5), abs(y - 7.5))
            base = (36, 78, 24) if d > 6.5 else (64, 120, 40) if d > 3 else (84, 146, 56)
            out.putpixel((x, y), base + (255,))
    return out


def mushroom_cap(seed, base, spot, spots):
    rnd = random.Random(seed)
    out = noise_tile(seed, base, 0.12)
    for _ in range(spots):
        cx, cy = rnd.randrange(N), rnd.randrange(N)
        r = rnd.choice((1, 1, 2))
        for y in range(cy - r, cy + r + 1):
            for x in range(cx - r, cx + r + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.5:
                    out.putpixel((x % N, y % N), spot + (255,))
    return out


def main():
    stone, dirt, grass = load('Stone.png'), load('Dirt.png'), load('Grass.png')
    grass_side, sand, sandstone = load('Grass_Side.png'), load('Sand.png'), load('Sandstone.png')
    gravel, granite, diorite = load('gravel.png'), load('Granite.png'), load('Diorite.png')
    clay, ice, leaves = load('Clay.png'), load('Ice.png'), load('leaves.png')
    log_side, log_top = load('Log_Side.png'), load('Log_Top.png')

    # Stone family
    save(recolour(granite, (128, 128, 124), 1.1), 'Andesite.png')
    save(streaks(recolour(stone, (74, 74, 82), 1.2), (3, 8, 13), 0.78), 'Slate.png')
    save(recolour(diorite, (214, 206, 184), 0.8), 'Limestone.png')
    save(recolour(ice, (140, 172, 222), 0.9), 'Packed_Ice.png')

    # Soils
    save(recolour(dirt, (118, 86, 58), 1.0, seed=47, speckle=0.18, speckle_colour=(86, 84, 80)), 'Coarse_Dirt.png')
    save(recolour(dirt, (116, 78, 34), 1.2, seed=48, speckle=0.12, speckle_colour=(74, 50, 22)), 'Podzol_Top.png')
    save(banded(grass_side, (116, 78, 34)), 'Podzol_Side.png')
    save(recolour(dirt, (66, 54, 48), 0.7), 'Mud.png')
    save(recolour(grass, (84, 116, 40), 1.1, seed=50, speckle=0.08, speckle_colour=(62, 90, 30)), 'Moss.png')
    save(recolour(grass, (164, 158, 76), 1.0), 'Dry_Grass.png')
    save(banded(grass_side, (164, 158, 76)), 'Dry_Grass_Side.png')
    save(recolour(grass, (118, 100, 112), 1.0, seed=61, speckle=0.1, speckle_colour=(150, 140, 148)), 'Mycelium_Top.png')
    save(banded(grass_side, (118, 100, 112)), 'Mycelium_Side.png')

    # Sands and badlands
    save(recolour(sand, (190, 104, 48), 1.0), 'Red_Sand.png')
    save(recolour(sandstone, (178, 98, 48), 1.0), 'Red_Sandstone.png')
    terracotta = {
        'Terracotta.png':        (152, 94, 68),
        'White_Terracotta.png':  (210, 178, 160),
        'Orange_Terracotta.png': (162, 84, 38),
        'Yellow_Terracotta.png': (186, 134, 54),
        'Brown_Terracotta.png':  (78, 52, 36),
        'Red_Terracotta.png':    (144, 62, 46),
    }
    for name, colour in terracotta.items():
        save(recolour(clay, colour, 0.45), name)

    # Trees
    save(recolour(log_side, (76, 52, 32), 1.0), 'Spruce_Log.png')
    save(recolour(log_top, (112, 84, 52), 1.0), 'Spruce_Log_Top.png')
    save(birch_side(), 'Birch_Log.png')
    save(recolour(log_top, (196, 176, 128), 1.0), 'Birch_Log_Top.png')
    save(recolour(leaves, (36, 70, 44), 1.1), 'Spruce_Leaves.png')
    save(recolour(leaves, (92, 128, 50), 1.0), 'Birch_Leaves.png')
    save(recolour(leaves, (38, 118, 24), 1.15), 'Jungle_Leaves.png')
    save(recolour(leaves, (98, 116, 34), 1.0), 'Acacia_Leaves.png')
    save(cactus_side(), 'Cactus_Side.png')
    save(cactus_top(), 'Cactus_Top.png')

    # Mushrooms
    save(recolour(diorite, (212, 202, 184), 0.5), 'Mushroom_Stem.png')
    save(mushroom_cap(70, (176, 36, 30), (236, 230, 220), 6), 'Red_Mushroom_Block.png')
    save(mushroom_cap(71, (138, 104, 74), (164, 128, 94), 9), 'Brown_Mushroom_Block.png')


if __name__ == '__main__':
    main()
