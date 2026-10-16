"""
Paints the textures of the decoration blocks (tools/gen_decor.mjs): coloured
wool, plants, doors, ladders, furniture, paintings, fire, food, the plate.
(The item icons are tools/gen_item_textures.py's.)

    python tools/gen_decor_textures.py [name ...]      (needs Pillow and numpy)

It is the block texture tool's second half (gen_block_textures.py: its noise,
its colours and its way of saving are used here), kept apart because these are
a different kind of picture. A terrain texture is a material: it tiles, and
has nothing in it that says where a block begins. These are things. A model's
texture is laid over its voxel (BlockShapes.js), so each is a view of the whole
model from one side, 32 texels to the block: the part of a cake's side that is
cake is the part of the picture the cake covers. Whatever a model does not
cover is never seen. Plants, ladders, bunting and fire are cut out: a texel is
there or it is not.

Deterministic, like the other: a seed per name. WW_TEX_OUT writes the block
textures somewhere else, to look at a change first.
"""
import os
import sys

import numpy as np
from PIL import Image

import gen_block_textures as g
from gen_block_textures import N, fbm, grain, shade, mix, ramp, flat, smooth, save


YY, XX = np.mgrid[0:N, 0:N] + 0.5          # texel centres; y runs down the image

T = {}


def tex(name):
    def deco(fn):
        T[name] = fn
        return fn
    return deco


# ── Drawing ──────────────────────────────────────────────────────────────────

class Pic:
    """A picture being painted: colour and, for a cutout, which texels are there."""

    def __init__(self, name, rgb=None, clear=False):
        self.name = name
        self.s = g._seed(name)
        self.rgb = flat((0, 0, 0)) if rgb is None else np.array(rgb, dtype=float)
        self.a = np.zeros((N, N), bool) if clear else np.ones((N, N), bool)

    def put(self, mask, colour, k=0.0):
        """Paint `colour` where `mask`; k shades it (a field or a number)."""
        c = shade(flat(colour), k) if np.ndim(k) or k else flat(colour)
        self.rgb = np.where(mask[..., None], c, self.rgb)
        self.a = self.a | mask
        return self

    def cut(self, mask):
        self.a = self.a & ~mask
        return self

    def noise(self, amount=0.05):
        self.rgb = shade(self.rgb, grain(self.s + 77, amount))
        return self

    def save(self):
        save(self.name, self.rgb, np.where(self.a, 255, 0))


def rect(x0, y0, x1, y1):
    return (XX >= x0) & (XX < x1) & (YY >= y0) & (YY < y1)


def disc(cx, cy, r, ry=None):
    return ((XX - cx) / r) ** 2 + ((YY - cy) / (ry or r)) ** 2 <= 1


def seg_dist(x0, y0, x1, y1):
    """Distance of every texel from the segment (x0, y0)-(x1, y1)."""
    dx, dy = x1 - x0, y1 - y0
    L = dx * dx + dy * dy or 1e-9
    t = np.clip(((XX - x0) * dx + (YY - y0) * dy) / L, 0, 1)
    return np.hypot(XX - (x0 + t * dx), YY - (y0 + t * dy))


def line(x0, y0, x1, y1, w=1.0):
    return seg_dist(x0, y0, x1, y1) <= w / 2


def tri(ax, ay, bx, by, cx, cy):
    def side(px, py, qx, qy):
        return (XX - px) * (qy - py) - (YY - py) * (qx - px)
    d1, d2, d3 = side(ax, ay, bx, by), side(bx, by, cx, cy), side(cx, cy, ax, ay)
    return ((d1 >= 0) & (d2 >= 0) & (d3 >= 0)) | ((d1 <= 0) & (d2 <= 0) & (d3 <= 0))


def lit(cx, cy, r):
    """A shading field: brighter toward the upper left of a round thing at (cx, cy)."""
    return np.clip(((cx - XX) + (cy - YY)) / (r * 2.4), -0.5, 0.5) * 0.5


GREEN = (74, 124, 48)
GREEN_D = (46, 86, 36)
GREEN_L = (112, 158, 66)
WOOD = g.PLANK['base']
WOOD_D = g.PLANK['dark']
WOOD_L = g.PLANK['light']


def planks(name, vertical=False, wood=None):
    return g.boards(name, **(wood or g.PLANK), vertical=vertical)


# The woods things are made of (gen_block_textures.py has their planks).
WOODS = {'': g.PLANK, 'Spruce_': g.SPRUCE_PLANK, 'Birch_': g.BIRCH_PLANK}


# ── Wool, and what is made of it ─────────────────────────────────────────────

WOOLS = {
    'Red': (176, 52, 46), 'Orange': (214, 126, 44), 'Yellow': (226, 196, 68), 'Green': (92, 138, 62),
    'Blue': (62, 96, 178), 'Purple': (126, 78, 166), 'Black': (40, 40, 44), 'Brown': (114, 80, 52),
}


def wool(name, colour):
    s = g._seed('Wool_Block')
    weave = 0.5 + 0.25 * np.cos((XX - 0.5) * np.pi) * np.cos((YY - 0.5) * np.pi / 2) + 0.25 * np.cos((XX + YY - 1) * np.pi / 2)
    fuzz = fbm(s, (8, 16, 32), 0.7)
    t = np.clip(0.55 + (weave - 0.5) * 0.3 + (fuzz - 0.5) * 0.4, 0, 1)
    c = np.array(colour, dtype=float)
    return ramp(t, [(0, tuple(c * 0.78)), (0.5, tuple(c)), (1, tuple(np.minimum(255, c * 1.14 + 8)))])


for _c, _rgb in WOOLS.items():
    def _w(c=_c, rgb=_rgb):
        save(f'Wool_{c}', wool(f'Wool_{c}', rgb))
    T[f'Wool_{_c}'] = _w


def curtain(name, colour):
    c = np.array(colour, dtype=float)
    fold = 0.5 + 0.5 * np.cos(XX / N * 2 * np.pi * 4 + 0.6 * np.sin(YY / N * 2 * np.pi))
    t = np.clip(0.25 + fold * 0.6 + (fbm(g._seed(name), (8, 16), 0.6) - 0.5) * 0.15, 0, 1)
    rgb = ramp(t, [(0, tuple(c * 0.62)), (0.55, tuple(c)), (1, tuple(np.minimum(255, c * 1.18 + 10)))])
    p = Pic(name, rgb)
    p.put(rect(0, 0, N, 2), (86, 62, 40))                              # the rod
    p.put(rect(0, 2, N, 3) & (XX.astype(int) % 4 == 1), (196, 170, 96))  # rings
    p.rgb = shade(p.rgb, -0.18 * rect(0, N - 2, N, N))                 # the hem
    p.noise(0.03).save()


@tex('Curtain_Red')
def _():
    curtain('Curtain_Red', (168, 44, 44))


@tex('Curtain_Blue')
def _():
    curtain('Curtain_Blue', (58, 92, 170))


@tex('Curtain_White')
def _():
    curtain('Curtain_White', (232, 228, 218))


CURTAINS = {'Orange': (200, 112, 40), 'Yellow': (214, 182, 60), 'Green': (78, 126, 58),
            'Purple': (116, 70, 156), 'Black': (46, 46, 52), 'Brown': (112, 76, 48)}
for _c, _rgb in CURTAINS.items():
    def _cu(c=_c, rgb=_rgb):
        curtain(f'Curtain_{c}', rgb)
    T[f'Curtain_{_c}'] = _cu


# ── Blocks for building and for show ─────────────────────────────────────────

@tex('Bookshelf')
def _():
    p = Pic('Bookshelf', planks('Bookshelf'))
    r = np.random.default_rng(p.s)
    spines = [(150, 50, 44), (52, 84, 138), (60, 112, 66), (196, 160, 70), (112, 66, 124), (176, 104, 52), (70, 70, 78), (150, 128, 100)]
    for top in (2, 17):                       # two shelves of books, each 13 tall, on a board
        p.put(rect(0, top, N, top + 13), (46, 32, 22))
        x = 0
        while x < N:
            w = int(r.integers(2, 5))
            h = int(r.integers(9, 13))
            col = spines[int(r.integers(len(spines)))]
            m = rect(x, top + 13 - h, min(N, x + w), top + 13)
            p.put(m, col, -0.22 * (XX.astype(int) == x) + 0.1 * (XX.astype(int) == x + 1))
            if w >= 3:
                p.put(rect(x, top + 13 - h + 2, min(N, x + w), top + 13 - h + 3), (226, 208, 150))
            x += w
    p.noise(0.03).save()


def straw(name, base, dark, light, along=True, ties=False):
    s = g._seed(name)
    f = fbm(s, (4, 8, 16, 32), 0.7, sx=3.0 if along else 0.2, sy=0.2 if along else 3.0)
    t = np.clip(0.5 + (f - 0.5) * 1.5 + grain(s + 3, 0.12), 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    if ties:
        band = ((XX.astype(int) % 16) == 5) | ((XX.astype(int) % 16) == 6)
        rgb = np.where(band[..., None], shade(flat((150, 118, 60)), (fbm(s + 9, (16, 32)) - 0.5) * 0.3), rgb)
    return rgb


@tex('Hay_Side')
def _():
    save('Hay_Side', straw('Hay_Side', (206, 172, 66), (150, 118, 40), (236, 208, 108), along=True, ties=True))


@tex('Hay_Top')
def _():
    s = g._seed('Hay_Top')
    d1, d2, _ = g.worley(150, s)
    t = np.clip(0.35 + smooth(0, 1.6, d1) * 0.6 + grain(s + 1, 0.1), 0, 1)
    save('Hay_Top', ramp(t, [(0, (236, 208, 108)), (0.5, (206, 172, 66)), (1, (142, 110, 38))]))


@tex('Thatch')
def _():
    s = g._seed('Thatch')
    rgb = straw('Thatch', (188, 156, 78), (120, 94, 44), (220, 194, 118), along=False)
    # Laid in courses, each overlapping the one below.
    course = (YY.astype(int) % 8)
    rgb = shade(rgb, -0.3 * (course == 7) - 0.14 * (course == 6) + 0.08 * (course == 0))
    save('Thatch', rgb)


@tex('Chiseled_Stone')
def _():
    rgb = g.stone('Chiseled_Stone', (136, 137, 136), (104, 106, 108), (164, 164, 160), vein=0.2)
    p = Pic('Chiseled_Stone', rgb)
    for inset, k in ((2, -0.3), (3, 0.14), (9, -0.3), (10, 0.14)):
        ring = rect(inset, inset, N - inset, N - inset) & ~rect(inset + 1, inset + 1, N - inset - 1, N - inset - 1)
        p.rgb = shade(p.rgb, k * ring)
    p.rgb = shade(p.rgb, -0.22 * (disc(16, 16, 3.2) & ~disc(16, 16, 1.6)))
    p.save()


@tex('Tiles')
def _():
    s = g._seed('Tiles')
    a = g.stone('Tiles#a', (206, 202, 192), (178, 174, 166), (228, 226, 218), vein=0.15)
    b = g.stone('Tiles#b', (98, 108, 118), (74, 82, 92), (124, 134, 144), vein=0.15)
    cell = ((XX.astype(int) // 16) + (YY.astype(int) // 16)) % 2 == 0
    rgb = np.where(cell[..., None], a, b)
    grout = (XX.astype(int) % 16 == 15) | (YY.astype(int) % 16 == 15)
    edge = (XX.astype(int) % 16 == 0) | (YY.astype(int) % 16 == 0)
    rgb = shade(rgb, 0.1 * (edge & ~grout))
    rgb = np.where(grout[..., None], shade(flat((84, 82, 80)), (fbm(s, (16, 32)) - 0.5) * 0.2), rgb)
    save('Tiles', rgb)


# ── Plants: cut out, growing from the middle of the bottom edge ──────────────

def stem(p, x0, y0, x1, y1, w=1.6, colour=GREEN):
    p.put(line(x0, y0, x1, y1, w), colour, (fbm(p.s + 5, (8, 16)) - 0.5) * 0.3)


def leaf(p, cx, cy, rx, ry, colour=GREEN):
    p.put(disc(cx, cy, rx, ry), colour, lit(cx, cy, max(rx, ry)) + (fbm(p.s + 6, (16, 32)) - 0.5) * 0.2)


def flower(name, petal, centre, height, head, petals='round', leaves=2):
    p = Pic(name, clear=True)
    top = N - height
    stem(p, 16, N, 16.3, top + head)
    if leaves >= 1:
        leaf(p, 12.4, N - height * 0.36, 3.4, 1.5)
    if leaves >= 2:
        leaf(p, 19.8, N - height * 0.52, 3.4, 1.5, GREEN_D)
    cx, cy = 16.3, top + head
    dark = tuple(np.array(petal) * 0.72)
    if petals == 'round':
        for dx, dy in ((-head * 0.55, 0), (head * 0.55, 0), (0, -head * 0.55), (0, head * 0.55)):
            p.put(disc(cx + dx, cy + dy, head * 0.62), petal, lit(cx + dx, cy + dy, head))
        p.put(disc(cx, cy, head * 0.36), centre)
    elif petals == 'rays':
        for k in range(10):
            a = k * np.pi / 5
            p.put(line(cx, cy, cx + np.cos(a) * head, cy + np.sin(a) * head, 1.9), petal if k % 2 else dark)
        p.put(disc(cx, cy, head * 0.4), centre, lit(cx, cy, head))
    elif petals == 'puff':
        p.put(disc(cx, cy, head), petal, lit(cx, cy, head) + (fbm(p.s, (16, 32)) - 0.5) * 0.35)
        p.put(disc(cx + 0.6, cy + 0.6, head * 0.45), dark)
    elif petals == 'cup':
        p.put(disc(cx, cy, head * 0.8, head * 1.15) & (YY > cy - head * 0.9), petal, lit(cx, cy, head))
        p.put(tri(cx - head * 0.8, cy - head * 0.4, cx - head * 0.2, cy - head * 1.3, cx, cy - head * 0.2), petal)
        p.put(tri(cx + head * 0.8, cy - head * 0.4, cx + head * 0.2, cy - head * 1.3, cx, cy - head * 0.2), dark)
    return p


@tex('Poppy')
def _():
    flower('Poppy', (200, 44, 36), (40, 30, 30), 21, 4.6).noise().save()


@tex('Dandelion')
def _():
    flower('Dandelion', (238, 204, 52), (214, 160, 30), 17, 3.6, 'puff').noise().save()


@tex('Cornflower')
def _():
    flower('Cornflower', (76, 110, 214), (40, 50, 120), 23, 4.6, 'rays').noise().save()


@tex('Daisy')
def _():
    flower('Daisy', (240, 240, 232), (232, 190, 50), 20, 4.8, 'rays').noise(0.03).save()


@tex('Tulip')
def _():
    flower('Tulip', (232, 128, 46), (232, 128, 46), 22, 4.2, 'cup', leaves=2).noise().save()


@tex('Violet')
def _():
    p = Pic('Violet', clear=True)
    for x, h in ((10, 9), (16, 13), (22, 10)):
        stem(p, 16, N, x, N - h, 1.4)
        p.put(disc(x, N - h, 2.6), (132, 84, 184), lit(x, N - h, 2.6))
        p.put(disc(x, N - h, 0.9), (236, 212, 90))
    leaf(p, 11, N - 3, 4.2, 2.0)
    leaf(p, 21, N - 3.4, 4.2, 2.0, GREEN_D)
    p.noise().save()


@tex('Tall_Grass')
def _():
    p = Pic('Tall_Grass', clear=True)
    r = np.random.default_rng(p.s)
    for k in range(13):
        x0 = 5 + k * 1.8 + r.random() * 1.2
        h = 12 + r.random() * 15
        lean = (r.random() - 0.5) * 9
        col = [GREEN_D, GREEN, GREEN_L, (96, 142, 58)][int(r.integers(4))]
        mid = (x0 + lean * 0.45, N - h * 0.55)
        p.put(line(x0, N, mid[0], mid[1], 1.8), col)
        p.put(line(mid[0], mid[1], x0 + lean, N - h, 1.2), col, 0.12)
    p.noise(0.06).save()


@tex('Fern')
def _():
    p = Pic('Fern', clear=True)
    for side in (-1, 1):
        for k, (reach, rise) in enumerate(((13, 13), (9, 21), (5, 26))):
            x1, y1 = 16 + side * reach, N - rise
            col = (GREEN_D, GREEN, GREEN_L)[k]
            p.put(line(16, N, x1, y1, 1.3), col)
            for t in np.linspace(0.25, 0.95, 7):
                bx, by = 16 + (x1 - 16) * t, N + (y1 - N) * t
                p.put(line(bx, by, bx + side * 1.2 - 2.2 * (1 - t), by - 3.2 * (1 - t * 0.5), 1.5), col, 0.08)
                p.put(line(bx, by, bx + side * 2.6 * (1 - t * 0.4), by + 1.6, 1.5), col, -0.1)
    p.noise(0.06).save()


@tex('Dead_Bush')
def _():
    p = Pic('Dead_Bush', clear=True)
    tw, tw_d = (122, 92, 58), (88, 64, 40)
    p.put(line(16, N, 16, N - 9, 2.0), tw_d)
    for x1, y1, w in ((7, N - 20, 1.5), (25, N - 22, 1.5), (13, N - 26, 1.3), (21, N - 15, 1.2), (4, N - 12, 1.2), (28, N - 11, 1.1)):
        p.put(line(16, N - 8, x1, y1, w), tw)
        p.put(line((16 + x1) / 2, (N - 8 + y1) / 2, x1 + (3 if x1 > 16 else -3), y1 + 5, 1.0), tw_d)
    p.noise(0.06).save()


def mushroom(name, cap, spots):
    p = Pic(name, clear=True)
    p.put(rect(14, N - 9, 18.5, N), (226, 214, 190), -0.14 * (XX > 17))
    capm = disc(16.2, N - 9, 8.2, 6.2) & (YY < N - 8.6)
    p.put(capm, cap, lit(16, N - 12, 8))
    p.put(rect(9, N - 9.4, 23.6, N - 8.4) & disc(16.2, N - 9, 8.2, 6.2), tuple(np.array(cap) * 0.6))
    if spots:
        for x, y, r in ((12.4, N - 12.4, 1.3), (17.4, N - 13.6, 1.5), (21, N - 11.2, 1.0)):
            p.put(disc(x, y, r) & capm, (240, 236, 224))
    return p


@tex('Red_Mushroom')
def _():
    mushroom('Red_Mushroom', (196, 50, 40), True).noise(0.04).save()


@tex('Brown_Mushroom')
def _():
    mushroom('Brown_Mushroom', (150, 108, 74), False).noise(0.04).save()


def sapling(name, trunk, leaves, dark, shape):
    p = Pic(name, clear=True)
    p.put(line(16, N, 16, N - 13, 1.9), trunk, -0.15 * (XX > 16))
    if shape == 'cone':
        for k, (half, y) in enumerate(((8, N - 7), (6.2, N - 13), (4.2, N - 19), (2.4, N - 24))):
            p.put(tri(16 - half, y, 16 + half, y, 16, y - 9), dark if k % 2 else leaves, lit(16, y - 4, half))
    else:
        for x, y, r, c in ((12, N - 16, 5, dark), (20.4, N - 17, 5, leaves), (16, N - 22, 6, leaves), (16, N - 13.5, 4, dark)):
            p.put(disc(x, y, r), c, lit(x, y, r) + (fbm(p.s + int(x), (8, 16, 32)) - 0.5) * 0.4)
    return p


@tex('Oak_Sapling')
def _():
    sapling('Oak_Sapling', (104, 80, 54), (74, 124, 48), (48, 90, 38), 'round').noise().save()


@tex('Birch_Sapling')
def _():
    sapling('Birch_Sapling', (214, 210, 198), (118, 158, 66), (84, 126, 52), 'round').noise().save()


@tex('Spruce_Sapling')
def _():
    sapling('Spruce_Sapling', (78, 58, 42), (48, 92, 60), (32, 68, 46), 'cone').noise().save()


# ── Pots ─────────────────────────────────────────────────────────────────────

def clay(name, base=(168, 96, 66)):
    s = g._seed(name)
    b = np.array(base, dtype=float)
    f = fbm(s, (4, 8, 16, 32), 0.6, sx=2.5, sy=0.6)
    t = np.clip(0.5 + (f - 0.5) * 0.9, 0, 1)
    return ramp(t, [(0, tuple(b * 0.8)), (0.5, tuple(b)), (1, tuple(np.minimum(255, b * 1.14)))])


@tex('Flower_Pot')
def _():
    p = Pic('Flower_Pot', clay('Flower_Pot'))
    # The pot is 6 high (12 texels from the bottom): a rim along its top.
    p.rgb = shade(p.rgb, 0.12 * rect(0, N - 13, N, N - 10) - 0.2 * rect(0, N - 10, N, N - 9))
    p.noise(0.03).save()


@tex('Vase')
def _():
    p = Pic('Vase', clay('Vase', (176, 150, 116)))
    # A painted band round the body, and a dark line under the rim.
    band = rect(0, N - 14, N, N - 8)
    p.put(band, (62, 96, 150), (fbm(p.s, (8, 16)) - 0.5) * 0.2)
    zig = band & (((XX.astype(int) + (YY.astype(int) % 6 < 3) * 2) % 4) < 2) & (YY > N - 13) & (YY < N - 9)
    p.put(zig, (226, 214, 180))
    p.rgb = shade(p.rgb, -0.25 * rect(0, N - 25, N, N - 24))
    p.noise(0.03).save()


# ── Fire, the campfire, the bomb ─────────────────────────────────────────────

@tex('Fire')
def _():
    s = g._seed('Fire')
    p = Pic('Fire', clear=True)
    # Tongues of flame: how far up the fire reaches in each column.
    reach = np.zeros(N)
    for cx, h, w in ((6, 17, 5), (13, 27, 6), (20, 22, 5.5), (26, 15, 4.5), (16, 12, 14)):
        reach = np.maximum(reach, h * np.exp(-((np.arange(N) + 0.5 - cx) / w) ** 2 * 1.6))
    wob = (fbm(s, (4, 8, 16), 0.6) - 0.5) * 7
    up = (N - YY)                                            # height above the bottom
    inside = up < reach[None, :] + wob
    t = np.clip(up / np.maximum(reach[None, :] + wob, 1), 0, 1)
    edge = np.abs(XX - 16) / 17
    heat = np.clip(1 - t * 0.95 - edge * 0.35 + (fbm(s + 3, (8, 16)) - 0.5) * 0.3, 0, 1)
    rgb = ramp(heat, [(0, (176, 40, 20)), (0.35, (236, 104, 24)), (0.7, (252, 190, 52)), (1, (255, 244, 176))])
    p.rgb = rgb
    p.a = inside
    p.save()


@tex('Campfire_Log')
def _():
    rgb = g.bark('Campfire_Log', (96, 70, 46), (48, 34, 24), (132, 100, 66), ridges=7)
    s = g._seed('Campfire_Log')
    char = smooth(0.55, 0.8, fbm(s + 4, (3, 6, 12), 0.6))
    rgb = mix(rgb, (34, 30, 28), char * 0.8)
    save('Campfire_Log', np.transpose(rgb, (1, 0, 2)))


def bomb_side(name, body, band, glow=0.0):
    p = Pic(name, flat(body))
    # The body: 3 … 13 across, 10 high — a round-shouldered iron shell.
    shell = fbm(p.s, (4, 8, 16), 0.6)
    p.rgb = shade(p.rgb, (shell - 0.5) * 0.3 + np.clip((16 - XX) / 26, -0.4, 0.4) + np.clip((22 - YY) / 40, -0.3, 0.3))
    p.put(rect(0, N - 12, N, N - 9), band, (fbm(p.s + 1, (16, 32)) - 0.5) * 0.2)
    p.rgb = shade(p.rgb, -0.3 * rect(0, N - 13, N, N - 12) - 0.3 * rect(0, N - 9, N, N - 8))
    for x in (9, 15, 21):
        p.put(disc(x + 0.5, N - 4.5, 1.2), tuple(np.array(body) * 1.6 + 30))
    if glow:
        p.rgb = mix(p.rgb, (255, 236, 200), glow * smooth(0.2, 0.9, fbm(p.s + 2, (4, 8), 0.5)))
    return p


@tex('Bomb_Side')
def _():
    bomb_side('Bomb_Side', (44, 46, 52), (150, 44, 38)).noise(0.03).save()


@tex('Bomb_Lit')
def _():
    bomb_side('Bomb_Lit', (150, 60, 44), (250, 220, 150), glow=0.75).noise(0.03).save()


@tex('Bomb_Top')
def _():
    p = Pic('Bomb_Top', flat((44, 46, 52)))
    p.rgb = shade(p.rgb, (fbm(p.s, (4, 8, 16), 0.6) - 0.5) * 0.3 + lit(16, 16, 12))
    p.rgb = shade(p.rgb, -0.3 * (disc(16, 16, 9) & ~disc(16, 16, 8)))
    p.put(disc(16, 16, 3), (30, 30, 34))
    # The fuse: seen end on in the middle, and from the side by the fuse's own faces (texels 15-17 across, rows 6-12).
    p.put(rect(15, 6, 17, 13), (196, 170, 118), -0.2 * (XX > 16))
    p.put(disc(16, 16, 1.2), (196, 170, 118))
    p.noise(0.03).save()


# ── Food ─────────────────────────────────────────────────────────────────────

def sponge(name, with_icing=True):
    s = g._seed(name)
    crumb = fbm(s, (8, 16, 32), 0.75)
    rgb = ramp(crumb, [(0, (196, 150, 84)), (0.5, (226, 184, 112)), (1, (240, 206, 138))])
    p = Pic(name, rgb)
    # The cake is 7 high: texel rows 18 … 32. Cream through its middle, icing over the top and running down.
    p.put(rect(0, N - 8, N, N - 6), (250, 240, 224))
    if with_icing:
        drip = 3 + np.round(2.2 * (0.5 + 0.5 * np.sin(XX * 1.3 + 2 * np.sin(XX * 0.37))))
        p.put((YY >= N - 14) & (YY < N - 14 + drip), (248, 236, 232), -0.08 * (YY > N - 13))
    return p


@tex('Cake_Side')
def _():
    sponge('Cake_Side').noise(0.03).save()


@tex('Cake_Inside')
def _():
    p = sponge('Cake_Inside', with_icing=False)
    p.put(rect(0, N - 14, N, N - 12), (248, 236, 232))
    p.noise(0.03).save()


@tex('Cake_Top')
def _():
    p = Pic('Cake_Top', flat((248, 236, 232)))
    p.rgb = shade(p.rgb, (fbm(p.s, (4, 8, 16), 0.6) - 0.5) * 0.08)
    for k in range(8):
        a = k * np.pi / 4 + 0.2
        cx, cy = 16 + np.cos(a) * 9.5, 16 + np.sin(a) * 9.5
        p.put(disc(cx, cy, 2.1), (242, 222, 214))
        p.put(disc(cx, cy, 1.3), (190, 40, 48), lit(cx, cy, 1.3))
    p.put(disc(16, 16, 2.6), (242, 222, 214))
    p.put(disc(16, 16, 1.6), (190, 40, 48), lit(16, 16, 1.6))
    p.save()


@tex('Pie_Top')
def _():
    s = g._seed('Pie_Top')
    p = Pic('Pie_Top', flat((150, 44, 40)))
    p.rgb = shade(p.rgb, (fbm(s, (8, 16, 32), 0.7) - 0.5) * 0.4)
    crust = (214, 160, 84)
    lattice = ((XX.astype(int) + YY.astype(int)) % 8 < 3) | ((XX.astype(int) - YY.astype(int)) % 8 < 3)
    p.put(lattice, crust, (fbm(s + 1, (8, 16, 32), 0.7) - 0.5) * 0.3)
    p.put(~rect(7, 7, N - 7, N - 7), crust, (fbm(s + 2, (8, 16, 32), 0.7) - 0.5) * 0.3 + 0.06)
    p.save()


@tex('Pie_Side')
def _():
    s = g._seed('Pie_Side')
    t = np.clip(fbm(s, (8, 16, 32), 0.7) + (N - 4 - YY) / 30, 0, 1)
    save('Pie_Side', ramp(t, [(0, (150, 100, 50)), (0.5, (204, 150, 78)), (1, (232, 186, 110))]))


@tex('Pie_Inside')
def _():
    s = g._seed('Pie_Inside')
    p = Pic('Pie_Inside', ramp(fbm(s, (8, 16, 32), 0.7), [(0, (118, 28, 30)), (0.5, (160, 46, 42)), (1, (198, 78, 60))]))
    p.put(rect(0, N - 9, N, N - 7) | rect(0, N - 2, N, N), (214, 160, 84), (fbm(s + 1, (16, 32)) - 0.5) * 0.25)
    p.save()


# ── The ladder, the door ─────────────────────────────────────────────────────

@tex('Ladder')
def _():
    w = planks('Ladder', vertical=True)
    p = Pic('Ladder', w, clear=True)
    rails = rect(4, 0, 8, N) | rect(24, 0, 28, N)
    rungs = (YY.astype(int) % 8 >= 3) & (YY.astype(int) % 8 <= 5) & (XX >= 4) & (XX < 28)
    p.a = rails | rungs
    p.rgb = shade(p.rgb, -0.22 * (rungs & ~rails & (YY.astype(int) % 8 == 5)) + 0.1 * (rungs & ~rails & (YY.astype(int) % 8 == 3))
                  - 0.18 * (rails & ((XX.astype(int) == 7) | (XX.astype(int) == 27))))
    p.save()


def door(name, top, wood=None):
    p = Pic(name, planks(name, vertical=True, wood=wood))
    dark = lambda m, k=-0.28: setattr(p, 'rgb', shade(p.rgb, k * m))
    # A frame all round the leaf (the two halves meet with none between them), and panels set into it.
    frame = ~rect(3, 3 if top else 0, N - 3, N if top else N - 3)
    dark(frame, -0.12)
    if top:
        pane = rect(7, 7, N - 7, 22)
        p.cut(pane & ~(rect(15, 7, 17, 22) | rect(7, 14, N - 7, 16)))        # a window of four panes
        dark(rect(6, 6, N - 6, 23) & ~pane)
        dark(rect(6, 26, N - 6, N - 1) & ~rect(7, 27, N - 7, N - 2))
    else:
        for y0, y1 in ((2, 14), (17, N - 5)):
            dark(rect(6, y0, N - 6, y1) & ~rect(7, y0 + 1, N - 7, y1 - 1))
            dark(rect(7, y0 + 1, N - 7, y1 - 1), -0.08)
        p.put(disc(25.5, 4.5, 1.7), (198, 170, 84), lit(25.5, 4.5, 1.7))     # the handle
    for y in ((5, 26) if top else (8, 24)):
        p.put(rect(0, y, 4, y + 3), (70, 70, 76))                            # hinges
    p.noise(0.02).save()


for _w, _pal in WOODS.items():
    for _part, _top in (('Top', True), ('Bottom', False)):
        def _d(n=f'{_w}Door_{_part}', top=_top, pal=_pal):
            door(n, top, pal)
        T[f'{_w}Door_{_part}'] = _d


# ── The bed ──────────────────────────────────────────────────────────────────

# ── Furniture ────────────────────────────────────────────────────────────────

def cabinet_front(name, wood):
    p = Pic(name, planks(name, vertical=True, wood=wood))
    p.rgb = shade(p.rgb, -0.14 * ~rect(2, 2, N - 2, N - 2))
    for x0, x1 in ((3, 15), (17, 29)):
        doorm = rect(x0, 3, x1, N - 3)
        p.rgb = shade(p.rgb, -0.3 * (doorm & ~rect(x0 + 1, 4, x1 - 1, N - 4)))
        p.rgb = shade(p.rgb, -0.22 * (rect(x0 + 3, 7, x1 - 3, N - 7) & ~rect(x0 + 4, 8, x1 - 4, N - 8)))
    for x in (13, 19):
        p.put(disc(x, 16, 1.4), (198, 170, 84), lit(x, 16, 1.4))
    p.noise(0.02).save()


for _w, _pal in WOODS.items():
    def _cab(n=f'{_w}Cabinet_Front', pal=_pal):
        cabinet_front(n, pal)
    T[f'{_w}Cabinet_Front'] = _cab


# ── What is hung across a room ───────────────────────────────────────────────

@tex('Bunting')
def _():
    # Drawn on a plane 5 … 16 up: the string is along the top of the picture.
    p = Pic('Bunting', clear=True)
    sag = 1.5 + 2.2 * np.sin(XX / N * np.pi)                      # the string hangs a little
    p.put(np.abs(YY - sag) <= 0.75, (232, 226, 206))
    flags = [(196, 52, 46), (236, 196, 60), (62, 104, 190), (86, 150, 74)]
    for k in range(4):
        cx = 4 + k * 8
        y0 = 1.5 + 2.2 * np.sin(cx / N * np.pi) + 0.6
        p.put(tri(cx - 3.6, y0, cx + 3.6, y0, cx, y0 + 12), flags[k], lit(cx, y0 + 4, 5) * 0.6)
    p.noise(0.04).save()


@tex('Streamers')
def _():
    p = Pic('Streamers', clear=True)
    for k, col in enumerate(((232, 96, 150), (88, 176, 220), (242, 206, 74))):
        y = 3 + k * 2.2 + 3.2 * np.sin(XX / N * 2 * np.pi * (1 + k * 0.5) + k * 1.7)
        p.put(np.abs(YY - y) <= 1.1, col, 0.14 * np.sin(XX * 0.9 + k))
    for k, (x, col) in enumerate(((5, (232, 96, 150)), (13, (242, 206, 74)), (21, (88, 176, 220)), (28, (134, 200, 110)))):
        # A curl of paper hanging down.
        ys = np.arange(4, 18 + (k % 2) * 4)
        for y in ys:
            p.put(disc(x + 1.6 * np.sin(y * 0.9 + k), y, 0.95), col, 0.16 * np.sin(y * 0.9))
    p.noise(0.03).save()


# ── Paintings ────────────────────────────────────────────────────────────────

def framed(name):
    p = Pic(name, planks(name))
    edge = ~rect(2, 2, N - 2, N - 2)
    p.rgb = shade(p.rgb, -0.3 * edge)
    p.rgb = shade(p.rgb, 0.25 * (edge & ((XX < 1) | (YY < 1))))
    return p, rect(2, 2, N - 2, N - 2)


def canvas_grain(p, inner, amount=0.05):
    p.rgb = shade(p.rgb, grain(p.s + 9, amount) * inner)


@tex('Painting_1')
def _():
    # A valley: sky, sun, far hills, a lake.
    p, inner = framed('Painting_1')
    sky = ramp(np.clip((YY - 2) / 16, 0, 1), [(0, (120, 170, 220)), (1, (226, 226, 206))])
    p.rgb = np.where(inner[..., None], sky, p.rgb)
    p.put(disc(23, 8, 2.6) & inner, (252, 236, 150))
    p.put((YY > 15 + 3 * np.sin(XX * 0.33) + 1.5 * np.sin(XX * 0.9)) & inner, (96, 128, 150))
    p.put((YY > 18 + 2.5 * np.sin(XX * 0.25 + 2)) & inner, (72, 124, 66))
    p.put((YY > 23) & inner, (84, 142, 190), 0.1 * np.sin(XX * 1.5 + YY))
    p.put((YY > 27 + np.sin(XX * 0.5)) & inner, (98, 148, 70))
    canvas_grain(p, inner)
    p.save()


@tex('Painting_2')
def _():
    # A Quiddle, from the shoulders up.
    p, inner = framed('Painting_2')
    p.put(inner, (64, 110, 108), (fbm(p.s, (4, 8, 16)) - 0.5) * 0.25)
    p.put(disc(16, 30, 10, 7) & inner, (176, 62, 52))                      # shoulders
    p.put(disc(16, 15.5, 7.6, 7.2) & inner, (232, 186, 148), lit(16, 15, 8) * 0.5)
    p.put(disc(16, 11, 8.2, 5.6) & (YY < 12.5) & inner, (98, 62, 36))      # hair
    for x in (12.6, 19.4):
        p.put(rect(x - 1.2, 14.5, x + 1.2, 18), (40, 36, 44))
        p.put(rect(x - 1.2, 14.5, x, 15.6), (246, 246, 246))
    p.put(rect(14.4, 20.6, 17.6, 21.4), (150, 70, 60))
    canvas_grain(p, inner)
    p.save()


@tex('Painting_3')
def _():
    # Flowers in a jug, on a table.
    p, inner = framed('Painting_3')
    p.put(inner, (206, 188, 150), (fbm(p.s, (4, 8, 16)) - 0.5) * 0.15)
    p.put((YY > 23) & inner, (120, 84, 54))
    p.put((rect(12, 16, 20, 25) | disc(16, 21, 5.4, 4.2)) & inner, (70, 110, 170), lit(16, 20, 6) * 0.6)
    for x, y, c in ((11, 9, (206, 60, 50)), (16, 6.5, (240, 206, 70)), (21.5, 9.5, (226, 226, 236)), (13.5, 12.5, (230, 140, 60)), (19, 12.5, (150, 96, 190))):
        p.put(line(16, 17, x, y, 1.0) & inner, (70, 112, 52))
        p.put(disc(x, y, 2.4) & inner, c, lit(x, y, 2.4) * 0.6)
    canvas_grain(p, inner)
    p.save()


@tex('Painting_4')
def _():
    # A boat going home at sunset.
    p, inner = framed('Painting_4')
    sky = ramp(np.clip((YY - 2) / 17, 0, 1), [(0, (84, 70, 130)), (0.6, (226, 120, 80)), (1, (250, 200, 110))])
    p.rgb = np.where(inner[..., None], sky, p.rgb)
    p.put(disc(11, 19, 3.4) & (YY < 19) & inner, (255, 232, 160))
    sea = (YY >= 19) & inner
    p.put(sea, (50, 74, 124), 0.25 * (np.sin(YY * 2.2 + XX * 0.4) > 0.5))
    p.put(rect(9, 19, 13, N) & sea & ((YY.astype(int) % 2) == 0), (236, 170, 110))
    p.put(tri(17, 22, 27, 22, 25, 25.5) & inner, (60, 40, 30))
    p.put(rect(21.5, 10, 22.5, 22) & inner, (60, 40, 30))
    p.put(tri(23, 11, 23, 21, 28, 21) & inner, (240, 232, 214))
    p.put(tri(21, 13, 21, 21, 17.5, 21) & inner, (224, 212, 190))
    canvas_grain(p, inner)
    p.save()


@tex('Painting_5')
def _():
    # Mountains at night.
    p, inner = framed('Painting_5')
    sky = ramp(np.clip((YY - 2) / 22, 0, 1), [(0, (16, 22, 52)), (1, (52, 70, 120))])
    p.rgb = np.where(inner[..., None], sky, p.rgb)
    r = np.random.default_rng(p.s)
    for _k in range(16):
        x, y = r.integers(3, N - 3), r.integers(3, 15)
        p.put(rect(x, y, x + 1, y + 1) & inner, (240, 240, 220))
    p.put(disc(22.5, 8, 3.2) & ~disc(24, 7, 2.8) & inner, (244, 240, 206))
    far = (YY > 24 - np.maximum(0, 9 - np.abs(XX - 11)) * 1.25) | (YY > 26 - np.maximum(0, 8 - np.abs(XX - 23)) * 1.1)
    p.put(far & inner, (58, 66, 96))
    p.put(far & (YY < 17 + np.abs(XX - 11) * 0.3) & (np.abs(XX - 11) < 4) & inner, (226, 230, 240))
    p.put((YY > 26 + np.sin(XX * 0.6)) & inner, (28, 44, 46))
    canvas_grain(p, inner, 0.03)
    p.save()


@tex('Painting_6')
def _():
    # Colour, in blocks.
    p, inner = framed('Painting_6')
    p.put(inner, (236, 230, 214))
    for x0, y0, x1, y1, c in ((2, 2, 14, 12, (196, 60, 48)), (22, 2, 30, 8, (62, 96, 170)), (2, 20, 9, 30, (236, 196, 70)),
                              (17, 14, 30, 30, (236, 230, 214)), (11, 22, 15, 30, (40, 40, 46)), (22, 10, 30, 12, (86, 150, 110))):
        p.put(rect(x0, y0, x1, y1) & inner, c)
    for x in (14, 21):
        p.put(rect(x, 2, x + 1.2, N - 2) & inner, (30, 30, 34))
    for y in (12, 19):
        p.put(rect(2, y, N - 2, y + 1.2) & inner, (30, 30, 34))
    canvas_grain(p, inner)
    p.save()


@tex('Painting_7')
def _():
    # Apples in a bowl, on a cloth.
    p, inner = framed('Painting_7')
    p.put(inner, (92, 70, 96), (fbm(p.s, (4, 8, 16)) - 0.5) * 0.2)
    p.put((YY > 21) & inner, (128, 88, 56), (fbm(p.s + 2, (4, 8, 16), 0.6, sx=3, sy=0.4) - 0.5) * 0.3)
    for x, y, c in ((11, 15.5, (196, 48, 40)), (16.5, 13.5, (214, 172, 52)), (21.5, 15.5, (120, 168, 56)), (14, 18, (180, 40, 36)), (19.5, 18.5, (204, 70, 44))):
        p.put(disc(x, y, 3.1) & inner, c, lit(x, y, 3.1) * 0.7)
        p.put(rect(x - 0.4, y - 4, x + 0.6, y - 2.6) & inner, (80, 56, 34))
    bowl = disc(16, 19, 9, 5) & (YY > 19) & inner
    p.put(bowl, (86, 120, 178), lit(16, 19, 9) * 0.5)
    p.put(rect(7, 19, 25, 20) & inner, (150, 176, 214))
    canvas_grain(p, inner)
    p.save()


@tex('Painting_8')
def _():
    # A cottage at night, its window lit.
    p, inner = framed('Painting_8')
    sky = ramp(np.clip((YY - 2) / 18, 0, 1), [(0, (20, 26, 58)), (1, (48, 62, 108))])
    p.rgb = np.where(inner[..., None], sky, p.rgb)
    r = np.random.default_rng(p.s)
    for _k in range(12):
        x, y = r.integers(3, N - 3), r.integers(3, 12)
        p.put(rect(x, y, x + 1, y + 1) & inner, (236, 234, 210))
    p.put((YY > 22 + 1.5 * np.sin(XX * 0.3)) & inner, (34, 58, 44))
    p.put(rect(9, 16, 23, 25) & inner, (150, 126, 96))
    p.put(tri(7, 16.5, 25, 16.5, 16, 9) & inner, (92, 52, 40))
    p.put(rect(18, 18, 21, 21) & inner, (252, 210, 110))
    p.put(rect(11, 19, 14, 25) & inner, (74, 50, 34))
    p.put(rect(20, 8, 22, 13) & inner, (96, 84, 80))
    canvas_grain(p, inner, 0.03)
    p.save()


# ── Paintings of several blocks ──────────────────────────────────────────────
#
# Painted at 16 texels to a block, a picture of w × h blocks is 16w × 16h
# texels, cut into textures two blocks square (gen_decor.mjs says which piece
# shows which part of which: wide ones two to a texture one over the other,
# tall ones two side by side, grand ones on two textures, huge ones on four).

class Canvas:
    """A picture of any size, with a frame round it, painted like Pic."""

    def __init__(self, name, w, h, frame=2):
        self.name, self.w, self.h = name, w, h
        self.s = g._seed(name)
        self.Y, self.X = np.mgrid[0:h, 0:w] + 0.5
        self.rgb = np.zeros((h, w, 3)) + 128
        self.inner = (self.X >= frame) & (self.X < w - frame) & (self.Y >= frame) & (self.Y < h - frame)
        self.frame = frame

    def noise(self, k, cell=6.0):
        """Smooth value noise over the canvas, 0 … 1 (k: which)."""
        r = np.random.default_rng(self.s + k)
        gw, gh = int(self.w / cell) + 3, int(self.h / cell) + 3
        v = r.random((gh, gw))
        fx, fy = self.X / cell, self.Y / cell
        x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
        tx, ty = fx - x0, fy - y0
        tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
        a = v[y0, x0] * (1 - tx) + v[y0, x0 + 1] * tx
        b = v[y0 + 1, x0] * (1 - tx) + v[y0 + 1, x0 + 1] * tx
        return a * (1 - ty) + b * ty

    def put(self, mask, colour, k=0.0):
        c = np.array(colour, dtype=float)
        if np.ndim(k):
            c = shade(np.broadcast_to(c, self.rgb.shape).copy(), k)
        elif k:
            c = shade(np.broadcast_to(c, self.rgb.shape).copy(), k)
        m = mask & self.inner
        self.rgb = np.where(m[..., None], c, self.rgb)

    def sky(self, stops, y0=0, y1=None):
        y1 = self.h if y1 is None else y1
        t = np.clip((self.Y - y0) / max(1, y1 - y0), 0, 1)
        rgb = ramp(t, stops)
        self.rgb = np.where(self.inner[..., None], rgb, self.rgb)

    def disc(self, cx, cy, r, ry=None):
        return ((self.X - cx) / r) ** 2 + ((self.Y - cy) / (ry or r)) ** 2 <= 1

    def rect(self, x0, y0, x1, y1):
        return (self.X >= x0) & (self.X < x1) & (self.Y >= y0) & (self.Y < y1)

    def tri(self, ax, ay, bx, by, cx, cy):
        X, Y = self.X, self.Y
        def side(px, py, qx, qy):
            return (X - px) * (qy - py) - (Y - py) * (qx - px)
        d1, d2, d3 = side(ax, ay, bx, by), side(bx, by, cx, cy), side(cx, cy, ax, ay)
        return ((d1 >= 0) & (d2 >= 0) & (d3 >= 0)) | ((d1 <= 0) & (d2 <= 0) & (d3 <= 0))

    def below(self, f):
        """Everything under the line y = f(x)."""
        return self.Y > f(self.X)

    def lit(self, cx, cy, r):
        return np.clip(((cx - self.X) + (cy - self.Y)) / (r * 2.4), -0.5, 0.5) * 0.5

    def stars(self, n, y1, colour=(238, 236, 214)):
        r = np.random.default_rng(self.s + 99)
        for _k in range(n):
            x, y = r.integers(self.frame + 1, self.w - self.frame - 1), r.integers(self.frame + 1, int(y1))
            self.put(self.rect(x, y, x + 1, y + 1), colour)

    def pine(self, x, base, h, colour=(36, 76, 52)):
        self.put(self.tri(x - h * 0.32, base, x + h * 0.32, base, x, base - h), colour, self.lit(x, base - h / 2, h / 2) * 0.5)
        self.put(self.rect(x - 0.5, base, x + 0.5, base + 1.5), (70, 50, 34))

    def round_tree(self, x, base, h, colour=(70, 120, 52)):
        self.put(self.rect(x - 0.6, base - h * 0.45, x + 0.6, base), (92, 64, 40))
        self.put(self.disc(x, base - h * 0.62, h * 0.38, h * 0.36), colour, self.lit(x, base - h * 0.62, h * 0.38) * 0.8)

    def house(self, x, base, w, h, wall=(222, 206, 170), roof=(150, 56, 44)):
        self.put(self.rect(x, base - h, x + w, base), wall, self.lit(x + w / 2, base - h / 2, w) * 0.3)
        self.put(self.tri(x - 1, base - h + 0.5, x + w + 1, base - h + 0.5, x + w / 2, base - h - w * 0.5), roof)
        self.put(self.rect(x + w * 0.5 - 0.5, base - 2, x + w * 0.5 + 0.5, base), (84, 58, 38))

    def save(self, cut):
        """Frame it, then write the textures `cut` names: {file: (x0, y0) of its 32 × 32 piece, in texels}."""
        f = self.frame
        wood = ramp(self.noise(7, 3.0), [(0, (96, 66, 40)), (1, (136, 98, 60))])
        edge = ~self.inner
        self.rgb = np.where(edge[..., None], wood, self.rgb)
        outer = (self.X < 1) | (self.Y < 1) | (self.X > self.w - 1) | (self.Y > self.h - 1)
        self.rgb = shade(self.rgb, -0.28 * outer + 0.16 * (edge & ~outer & ((self.X < f) | (self.Y < f))))
        self.rgb = shade(self.rgb, (self.noise(11, 1.0) - 0.5) * 0.06 * self.inner)
        for file, (x0, y0) in cut.items():
            out = np.zeros((N, N, 3))
            a = np.zeros((N, N))
            h, w = min(N, self.h - y0), min(N, self.w - x0)
            out[:h, :w] = self.rgb[y0:y0 + h, x0:x0 + w]
            a[:h, :w] = 255
            save(file, out, a)


def wide_pair(name, first, second):
    """Two pictures 2 × 1, one over the other in one texture."""
    def run():
        a, b = first(Canvas(f'{name}_1', 32, 16)), second(Canvas(f'{name}_2', 32, 16))
        both = Canvas(name, 32, 32)
        both.rgb[:16], both.rgb[16:] = a._framed(), b._framed()
        save(name, both.rgb, np.full((N, N), 255))
    T[name] = run


def tall_pair(name, first, second):
    def run():
        a, b = first(Canvas(f'{name}_1', 16, 32)), second(Canvas(f'{name}_2', 16, 32))
        both = np.zeros((N, N, 3))
        both[:, :16], both[:, 16:] = a._framed(), b._framed()
        save(name, both, np.full((N, N), 255))
    T[name] = run


def _framed(self):
    """The picture with its frame, as an array (for packing two to a texture)."""
    keep = self.rgb.copy()
    files = {}
    self.save(files)                      # frames self.rgb; writes nothing
    out, self.rgb = self.rgb, keep
    return out


Canvas._framed = _framed


def single(name, w, h, cut, paint):
    def run():
        paint(Canvas(name, w, h)).save(cut)
    T[name] = run


# The scenes. Each is given a blank canvas and paints it.

def lighthouse(c):
    c.sky([(0, (118, 168, 220)), (1, (214, 228, 236))], 2, 10)
    c.put(c.disc(9, 6, 2), (252, 240, 176))
    c.put(c.below(lambda x: 10.5 + 0 * x), (56, 96, 150), 0.12 * np.sin(c.X * 1.3 + c.Y))
    c.put(c.below(lambda x: 12.5 + 0 * x) & (np.sin(c.X * 0.9 + c.Y * 2) > 0.6), (150, 186, 214))
    c.put(c.below(lambda x: 14 - np.clip((x - 18) * 1.1, 0, 6)) & (c.X > 18), (84, 104, 70))
    c.put(c.rect(23, 4, 25, 9), (236, 232, 222))
    c.put(c.rect(23, 5.5, 25, 6.5) | c.rect(23, 7.5, 25, 8.5), (196, 52, 44))
    c.put(c.rect(22.5, 3, 25.5, 4), (60, 60, 64))
    c.put(c.rect(23.4, 3.2, 24.6, 3.9), (255, 226, 120))
    return c


def evening_hills(c):
    c.sky([(0, (232, 120, 84)), (0.6, (246, 190, 120)), (1, (250, 226, 160))], 2, 11)
    c.put(c.disc(20, 10, 2.6) & (c.Y < 10.5), (255, 236, 170))
    c.put(c.below(lambda x: 9 + 1.5 * np.sin(x * 0.25 + 1)), (150, 96, 120))
    c.put(c.below(lambda x: 11 + 1.2 * np.sin(x * 0.4 + 3)), (98, 70, 96))
    c.put(c.below(lambda x: 12.5 + np.sin(x * 0.7)), (58, 46, 62))
    for x in (6, 9, 27):
        c.round_tree(x, 12.6, 4, (52, 40, 56))
    return c


def snowy_peaks(c):
    c.sky([(0, (86, 136, 210)), (1, (196, 220, 240))], 2, 12)
    peak = lambda x: 12 - np.maximum(0, 8 - np.abs(x - 10) * 1.1) - np.maximum(0, 6 - np.abs(x - 21) * 0.9)
    c.put(c.below(peak), (110, 118, 140), c.lit(15, 7, 8) * 0.4)
    c.put(c.below(peak) & (c.Y < 7.5), (238, 242, 248))
    c.put(c.below(lambda x: 12.5 + 0.6 * np.sin(x)), (52, 92, 60))
    for x in range(4, 30, 3):
        c.pine(x + 0.5, 13.5, 4 + (x % 2), (34, 70, 48))
    return c


def village(c):
    c.sky([(0, (110, 170, 230)), (1, (208, 230, 244))], 2, 10)
    c.put(c.disc(7, 6, 3, 1.4), (246, 248, 250))
    c.put(c.below(lambda x: 9.5 + 1.5 * np.sin(x * 0.2)), (98, 150, 74), (c.noise(3, 4) - 0.5) * 0.2)
    c.house(5, 12.5, 5, 3)
    c.house(13, 11.5, 4, 3, roof=(110, 70, 50))
    c.house(20, 12.5, 6, 3, wall=(236, 226, 200), roof=(70, 96, 150))
    c.round_tree(28, 13, 5)
    return c


def waterfall(c):
    c.sky([(0, (120, 176, 226)), (1, (206, 228, 240))], 2, 8)
    c.put(c.rect(0, 6, 16, 32), (92, 108, 92), (c.noise(1, 3) - 0.5) * 0.5)
    c.put(c.rect(5, 6, 11, 26), (196, 222, 240), 0.18 * np.sin(c.Y * 1.7 + c.X))
    c.put(c.rect(6.5, 6, 7.5, 26) | c.rect(9, 8, 9.8, 26), (240, 248, 252))
    c.put(c.below(lambda x: 25 + 0 * x), (70, 120, 160), 0.1 * np.sin(c.X * 2))
    c.put(c.disc(8, 25.5, 5, 1.5), (230, 240, 246))
    c.put(c.rect(0, 4, 4, 7) | c.rect(12, 4, 16, 7), (60, 110, 60))
    return c


def great_oak(c):
    c.sky([(0, (98, 160, 224)), (1, (204, 228, 242))], 2, 24)
    c.put(c.below(lambda x: 25 + 0.6 * np.sin(x)), (92, 146, 68), (c.noise(2, 3) - 0.5) * 0.3)
    c.put(c.rect(7, 13, 9.5, 26), (98, 70, 44), c.lit(8, 18, 2) * 0.6)
    c.put(c.disc(8, 10, 6, 6.5) | c.disc(4.5, 13, 3.5) | c.disc(11.5, 13, 3.5), (64, 116, 52), (c.noise(4, 2.5) - 0.5) * 0.5 + c.lit(8, 10, 6) * 0.6)
    return c


def sunset_tower(c):
    c.sky([(0, (70, 54, 112)), (0.55, (224, 110, 82)), (1, (250, 196, 112))], 2, 26)
    c.put(c.disc(11, 22, 3) & (c.Y < 24), (255, 230, 150))
    c.put(c.below(lambda x: 26 + 0 * x), (48, 40, 52))
    c.put(c.rect(4, 8, 9, 27), (66, 58, 70))
    c.put(c.tri(3, 8.5, 10, 8.5, 6.5, 3.5), (40, 34, 46))
    c.put(c.rect(6, 12, 7, 14), (255, 214, 120))
    c.put(c.rect(4, 7, 9, 8) & (c.X.astype(int) % 2 == 0), (66, 58, 70))
    return c


def moonlit_birch(c):
    c.sky([(0, (14, 20, 48)), (1, (40, 58, 100))], 2, 28)
    c.stars(10, 18)
    c.put(c.disc(11, 6, 2.2) & ~c.disc(12, 5.5, 1.8), (240, 236, 200))
    c.put(c.below(lambda x: 27 + 0 * x), (30, 50, 40))
    c.put(c.rect(5, 6, 7, 28), (220, 218, 208))
    for y in (9, 13, 18, 22):
        c.put(c.rect(5, y, 6.5, y + 1), (50, 48, 46))
    c.put(c.disc(6, 7, 4, 3), (56, 92, 60), (c.noise(5, 2) - 0.5) * 0.6)
    return c


def sunflowers(c):
    c.sky([(0, (78, 140, 222)), (1, (192, 220, 244))], 2, 16)
    c.put(c.disc(24, 8, 3.4, 1.4), (248, 250, 252))
    c.put(c.below(lambda x: 15 + np.sin(x * 0.3)), (78, 132, 56), (c.noise(6, 3) - 0.5) * 0.4)
    for x, y, s in ((6, 17, 2.6), (13, 15, 2.2), (20, 18, 2.8), (26, 15.5, 2.1), (9, 23, 3.2), (17, 24, 3.4), (25, 23, 3.1)):
        c.put(c.rect(x - 0.4, y, x + 0.6, 30), (60, 112, 46))
        c.put(c.disc(x, y, s), (240, 192, 40), c.lit(x, y, s) * 0.5)
        c.put(c.disc(x, y, s * 0.45), (110, 70, 34))
    return c


def forest_lake(c):
    c.sky([(0, (126, 180, 226)), (1, (226, 236, 236))], 2, 12)
    for x in range(3, 30, 3):
        c.pine(x + 0.5, 15, 7 + (x * 7) % 4, (34, 74 + (x * 5) % 20, 50))
    c.put(c.below(lambda x: 14.6 + 0 * x), (70, 116, 150), 0.12 * np.sin(c.X * 1.1 + c.Y * 2))
    for x in range(3, 30, 3):
        c.put(c.tri(x - 2, 16, x + 3, 16, x + 0.5, 16 + (7 + (x * 7) % 4) * 0.6), (52, 92, 104))
    c.put(c.below(lambda x: 27 + np.sin(x * 0.5)), (86, 128, 64))
    return c


def volcano(c):
    c.sky([(0, (60, 30, 40)), (0.6, (170, 70, 46)), (1, (230, 140, 70))], 2, 20)
    c.put(c.disc(9, 6, 4, 2.4) | c.disc(16, 4, 3.5, 2) | c.disc(22, 7, 4, 2.2), (90, 70, 74))
    c.put(c.below(lambda x: 9 + np.abs(x - 16) * 1.25) & (c.Y > 9), (52, 38, 40), c.lit(16, 16, 10) * 0.4)
    c.put(c.disc(16, 9.5, 2.4, 1.2), (255, 170, 60))
    c.put((np.abs(c.X - (16 + np.sin(c.Y * 0.6) * 2)) < 1.2) & (c.Y > 10) & (c.Y < 26), (240, 104, 40))
    c.put(c.below(lambda x: 26 + np.sin(x * 0.6)), (40, 30, 30))
    return c


def stormy_ship(c):
    c.sky([(0, (64, 70, 86)), (1, (140, 150, 160))], 2, 18)
    c.put(c.disc(10, 8, 6, 3) | c.disc(22, 6, 7, 3), (92, 98, 112))
    c.put(c.below(lambda x: 18 + 1.5 * np.sin(x * 0.5)), (40, 70, 96), 0.15 * np.sin(c.X * 0.9 + c.Y * 1.5))
    c.put(c.below(lambda x: 18 + 1.5 * np.sin(x * 0.5)) & (np.sin(c.X * 0.9 + c.Y * 1.5) > 0.7), (200, 214, 222))
    c.put(c.tri(9, 19, 23, 19, 21, 22) | c.rect(11, 19, 21, 21), (84, 56, 36))
    c.put(c.rect(15.5, 7, 16.5, 19), (70, 50, 34))
    c.put(c.tri(16.6, 8, 16.6, 17, 22, 17), (236, 228, 208))
    c.put(c.tri(15.4, 9, 15.4, 17, 11, 17), (224, 214, 192))
    return c


def river_valley(c):
    c.sky([(0, (96, 160, 226)), (1, (214, 232, 242))], 2, 14)
    c.put(c.disc(50, 7, 2.6), (252, 240, 180))
    c.put(c.disc(14, 6, 5, 1.6) | c.disc(34, 5, 6, 1.6), (248, 250, 252))
    c.put(c.below(lambda x: 13 - 4 * np.exp(-((x - 18) / 9) ** 2) - 3 * np.exp(-((x - 44) / 8) ** 2)), (110, 132, 150))
    c.put(c.below(lambda x: 15 + np.sin(x * 0.15) * 1.5), (96, 148, 70), (c.noise(8, 4) - 0.5) * 0.3)
    river = np.abs(c.X - (30 + (c.Y - 15) * 1.6 + np.sin(c.Y * 0.5) * 3)) < (0.6 + (c.Y - 15) * 0.25)
    c.put(river & (c.Y > 15), (84, 136, 190), 0.1 * np.sin(c.Y * 2))
    for x in (6, 10, 47, 52, 56):
        c.round_tree(x, 25 - (x % 3), 6)
    for x in (16, 40):
        c.pine(x, 20, 6)
    return c


def night_town(c):
    c.sky([(0, (12, 16, 40)), (1, (44, 54, 96))], 2, 22)
    c.stars(22, 14)
    c.put(c.disc(48, 7, 3) & ~c.disc(49.5, 6.3, 2.6), (240, 236, 200))
    c.put(c.below(lambda x: 22 + 0 * x), (36, 44, 66), 0.1 * np.sin(c.X * 2 + c.Y * 3))
    r = np.random.default_rng(c.s + 3)
    x = 4
    while x < 58:
        w, hgt = int(r.integers(4, 8)), int(r.integers(5, 10))
        c.put(c.rect(x, 22 - hgt, x + w, 22), (40 + r.integers(0, 20), 40 + r.integers(0, 16), 56 + r.integers(0, 20)))
        c.put(c.tri(x - 0.5, 22 - hgt + 0.2, x + w + 0.5, 22 - hgt + 0.2, x + w / 2, 22 - hgt - 2.5), (30, 28, 40))
        for wx in range(x + 1, x + w - 1, 2):
            for wy in range(22 - hgt + 2, 21, 3):
                if r.random() < 0.6:
                    c.put(c.rect(wx, wy, wx + 1, wy + 1), (252, 214, 120))
                    c.put(c.rect(wx, 44 - wy - 1, wx + 1, 44 - wy) & (c.Y > 22), (150, 130, 90))
        x += w + 1
    return c


def castle(c):
    c.sky([(0, (100, 162, 228)), (1, (218, 234, 244))], 2, 30)
    c.put(c.disc(12, 8, 7, 2.2) | c.disc(46, 6, 8, 2.4), (248, 250, 252))
    c.put(c.below(lambda x: 30 - 9 * np.exp(-((x - 32) / 13) ** 2)), (92, 146, 70), (c.noise(9, 5) - 0.5) * 0.3)
    c.put(c.below(lambda x: 36 + np.sin(x * 0.2) * 2), (78, 130, 60))
    stone = (150, 146, 140)
    c.put(c.rect(22, 13, 42, 22), stone, c.lit(32, 17, 10) * 0.3)
    for tx in (19, 30, 41):
        c.put(c.rect(tx, 7 if tx == 30 else 10, tx + 4, 22), (138, 134, 130), c.lit(tx + 2, 14, 3) * 0.4)
        top = 7 if tx == 30 else 10
        c.put(c.tri(tx - 0.8, top + 0.2, tx + 4.8, top + 0.2, tx + 2, top - 5), (110, 60, 54))
        c.put(c.rect(tx + 1.5, top + 3, tx + 2.5, top + 5), (40, 36, 40))
    c.put(c.rect(22, 12, 42, 13) & (c.X.astype(int) % 2 == 0), stone)
    c.put(c.rect(30, 17, 34, 22), (70, 48, 34))
    c.put(c.rect(32, 0, 32.6, 3) & (c.Y > 1), (90, 70, 50))
    c.put(c.tri(32.6, 2, 32.6, 4, 36, 3), (196, 52, 44))
    road = np.abs(c.X - (32 + (c.Y - 22) * 0.8 * np.sin(c.Y * 0.25))) < (0.8 + (c.Y - 22) * 0.18)
    c.put(road & (c.Y > 22), (176, 156, 112))
    for x in (6, 10, 52, 57):
        c.round_tree(x, 38 - (x % 2), 7)
    return c


def great_tree(c):
    c.sky([(0, (120, 176, 230)), (1, (226, 236, 240))], 2, 30)
    c.put(c.below(lambda x: 26 - 7 * np.exp(-((x - 12) / 8) ** 2) - 9 * np.exp(-((x - 50) / 9) ** 2)), (130, 140, 168))
    c.put(c.below(lambda x: 26 - 7 * np.exp(-((x - 12) / 8) ** 2) - 9 * np.exp(-((x - 50) / 9) ** 2)) & (c.Y < 22), (236, 240, 246))
    c.put(c.below(lambda x: 30 + np.sin(x * 0.2)), (98, 154, 70), (c.noise(10, 4) - 0.5) * 0.3)
    c.put(c.rect(29, 18, 34, 38), (96, 66, 42), c.lit(31, 28, 4) * 0.6)
    c.put(c.tri(25, 38, 38, 38, 31.5, 32), (96, 66, 42))
    crown = c.disc(31.5, 14, 14, 9) | c.disc(21, 18, 7, 5) | c.disc(42, 18, 7, 5)
    c.put(crown, (66, 120, 52), (c.noise(12, 3) - 0.5) * 0.6 + c.lit(31, 12, 14) * 0.5)
    r = np.random.default_rng(c.s + 5)
    for _k in range(26):
        x, y = r.integers(4, 60), r.integers(31, 44)
        c.put(c.rect(x, y, x + 1, y + 1), [(236, 72, 60), (246, 220, 80), (240, 240, 246), (150, 110, 220)][_k % 4])
    return c


wide_pair('Painting_Wide_A', lighthouse, evening_hills)
wide_pair('Painting_Wide_B', snowy_peaks, village)
tall_pair('Painting_Tall_A', waterfall, great_oak)
tall_pair('Painting_Tall_B', sunset_tower, moonlit_birch)
for _i, _scene in enumerate((sunflowers, forest_lake, volcano, stormy_ship)):
    single(f'Painting_Large_{_i + 1}', 32, 32, {f'Painting_Large_{_i + 1}': (0, 0)}, _scene)
for _i, _scene in enumerate((river_valley, night_town)):
    single(f'Painting_Grand_{_i + 1}', 64, 32, {f'Painting_Grand_{_i + 1}_L': (0, 0), f'Painting_Grand_{_i + 1}_R': (32, 0)}, _scene)
for _i, _scene in enumerate((castle, great_tree)):
    n = f'Painting_Huge_{_i + 1}'
    single(n, 64, 48, {f'{n}_TL': (0, 0), f'{n}_TR': (32, 0), f'{n}_BL': (0, 32), f'{n}_BR': (32, 32)}, _scene)


# ── The plate ────────────────────────────────────────────────────────────────

@tex('Plate')
def _():
    # White glaze, a blue line round the rim, and the middle a little in shadow.
    p = Pic('Plate', flat((238, 236, 230)))
    d = np.maximum(np.abs(XX - 16), np.abs(YY - 16))
    p.rgb = shade(p.rgb, -0.07 * smooth(9, 4, d) + 0.05 * smooth(10, 11.5, d))
    p.put((d > 9.6) & (d < 10.6), (70, 104, 176))
    p.noise(0.015).save()


# ── Run ──────────────────────────────────────────────────────────────────────

def main(argv):
    names = argv or sorted(T)
    for n in names:
        if n not in T:
            print('no such texture:', n)
            continue
        T[n]()
    print(f'wrote {len(names)} textures to', os.path.normpath(g.OUT))


if __name__ == '__main__':
    main(sys.argv[1:])
