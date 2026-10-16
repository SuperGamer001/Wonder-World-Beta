"""
Paints the item icons (data/textures/items/*.png), 64 × 64.

    python tools/gen_item_textures.py [name ...]        (npm run itemtex; needs Pillow and numpy)

The look is the one of the raw and cooked beef and chicken, which were drawn
by hand and are left alone (KEEP): the thing fills its square, seen a little
from above; it is lit from the upper left, so the edge toward the light is
pale and the far side dark, and it has some body to it — a soft roundness
across it, a few distinct tones rather than a smooth gradient — and the grain
of what it is made of (wood, stone, iron, gold, leather, wool, food) over that.
No black outline: a shape stands out by its own shadow.

How: each thing is a few shapes (polygons, ellipses, thick lines) on a 64 × 64
grid. A shape is given a material, which is a ramp of colours from its
darkest to its brightest; where on the ramp a pixel is comes from a light
falling on a soft height made of the shape itself (its outline blurred: high
in the middle, falling away at the edges), banded into a few tones, with the
material's grain over it. Shapes are painted back to front.

Deterministic: a seed per name. WW_ITEM_OUT writes somewhere else, to look
first.
"""
import hashlib
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

S = 64
OUT = os.environ.get('WW_ITEM_OUT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'textures', 'items')
KEEP = {'raw_beef', 'cooked_beef', 'raw_chicken', 'cooked_chicken'}     # drawn by hand: the reference
LIGHT = np.array([-0.55, -0.65, 0.75])
LIGHT = LIGHT / np.linalg.norm(LIGHT)
YY, XX = np.mgrid[0:S, 0:S] + 0.5


def seed_of(name, k=0):
    return int(hashlib.md5(f'{name}:{k}'.encode()).hexdigest()[:8], 16)


# ── Masks ────────────────────────────────────────────────────────────────────

def _mask(draw_fn):
    im = Image.new('L', (S, S), 0)
    draw_fn(ImageDraw.Draw(im))
    return np.asarray(im) > 127


def poly(*pts):
    return _mask(lambda d: d.polygon([tuple(p) for p in pts], fill=255))


def ellipse(cx, cy, rx, ry=None):
    ry = rx if ry is None else ry
    return ((XX - cx) / rx) ** 2 + ((YY - cy) / ry) ** 2 <= 1


def rellipse(cx, cy, rx, ry, angle):
    """An ellipse turned by `angle` degrees (its rx axis along that direction on screen)."""
    a = math.radians(angle)
    u = (XX - cx) * math.cos(a) + (YY - cy) * math.sin(a)
    v = -(XX - cx) * math.sin(a) + (YY - cy) * math.cos(a)
    return (u / rx) ** 2 + (v / ry) ** 2 <= 1


def rect(x0, y0, x1, y1):
    return (XX >= x0) & (XX < x1) & (YY >= y0) & (YY < y1)


def seg(x0, y0, x1, y1, w):
    """A thick line with square ends: the band within w/2 of the segment."""
    dx, dy = x1 - x0, y1 - y0
    L = dx * dx + dy * dy or 1e-9
    t = np.clip(((XX - x0) * dx + (YY - y0) * dy) / L, 0, 1)
    return np.hypot(XX - (x0 + t * dx), YY - (y0 + t * dy)) <= w / 2


def arc(cx, cy, r, w, a0, a1):
    """A band of width w along a circle of radius r, from angle a0 to a1 (degrees, 0 = +x, clockwise on screen)."""
    ang = (np.degrees(np.arctan2(YY - cy, XX - cx)) + 360) % 360
    a0, a1 = a0 % 360, a1 % 360
    inside = (ang >= a0) & (ang <= a1) if a0 <= a1 else (ang >= a0) | (ang <= a1)
    return (np.abs(np.hypot(XX - cx, YY - cy) - r) <= w / 2) & inside


def grow(mask, n=1):
    im = Image.fromarray((mask * 255).astype(np.uint8))
    for _ in range(n):
        im = im.filter(ImageFilter.MaxFilter(3))
    return np.asarray(im) > 127


def shrink(mask, n=1):
    im = Image.fromarray((mask * 255).astype(np.uint8))
    for _ in range(n):
        im = im.filter(ImageFilter.MinFilter(3))
    return np.asarray(im) > 127


# ── Noise ────────────────────────────────────────────────────────────────────

def noise(seed, cell=8.0, sx=1.0, sy=1.0):
    """Smooth value noise, 0 … 1; sx, sy stretch it (grain along x: sx > 1)."""
    r = np.random.default_rng(seed)
    gw, gh = int(S / (cell * sx)) + 3, int(S / (cell * sy)) + 3
    v = r.random((gh, gw))
    fx, fy = XX / (cell * sx), YY / (cell * sy)
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - x0, fy - y0
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    a = v[y0, x0] * (1 - tx) + v[y0, x0 + 1] * tx
    b = v[y0 + 1, x0] * (1 - tx) + v[y0 + 1, x0 + 1] * tx
    return a * (1 - ty) + b * ty


def fbm(seed, cells=(16, 8, 4), sx=1.0, sy=1.0):
    out, amp, tot = np.zeros((S, S)), 1.0, 0.0
    for i, c in enumerate(cells):
        out += noise(seed + i * 17, c, sx, sy) * amp
        tot += amp
        amp *= 0.55
    return out / tot


def along(angle, seed, cell=6.0, stretch=5.0):
    """Grain running along a direction (degrees on screen): wood fibres, brushed metal."""
    a = math.radians(angle)
    c, s = math.cos(a), math.sin(a)
    u = (XX - 32) * c + (YY - 32) * s + 32
    v = -(XX - 32) * s + (YY - 32) * c + 32
    r = np.random.default_rng(seed)
    gw, gh = int(S * 2 / (cell * stretch)) + 4, int(S * 2 / cell) + 4
    g = r.random((gh, gw))
    fx, fy = (u + 32) / (cell * stretch), (v + 32) / cell
    x0, y0 = np.clip(np.floor(fx).astype(int), 0, gw - 2), np.clip(np.floor(fy).astype(int), 0, gh - 2)
    tx, ty = np.clip(fx - x0, 0, 1), np.clip(fy - y0, 0, 1)
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    a_ = g[y0, x0] * (1 - tx) + g[y0, x0 + 1] * tx
    b_ = g[y0 + 1, x0] * (1 - tx) + g[y0 + 1, x0 + 1] * tx
    return a_ * (1 - ty) + b_ * ty


# ── Materials ────────────────────────────────────────────────────────────────
# A ramp from shadow to highlight, how much its grain shows, and what grain.

def ramp(t, stops):
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    pos = [p for p, _ in stops]
    for ch in range(3):
        out[..., ch] = np.interp(t, pos, [c[ch] for _, c in stops])
    return out


M = {
    'wood':    [(0, (78, 48, 26)), (0.3, (120, 78, 42)), (0.62, (164, 112, 62)), (0.85, (198, 148, 90)), (1, (226, 184, 124))],
    'darkwood': [(0, (54, 34, 20)), (0.35, (88, 58, 34)), (0.7, (122, 84, 50)), (1, (160, 116, 72))],
    'stone':   [(0, (62, 62, 66)), (0.35, (102, 102, 106)), (0.65, (138, 138, 142)), (0.88, (170, 170, 174)), (1, (202, 202, 206))],
    'iron':    [(0, (78, 82, 92)), (0.3, (128, 134, 146)), (0.6, (180, 186, 196)), (0.85, (220, 224, 232)), (1, (250, 252, 255))],
    'gold':    [(0, (132, 76, 16)), (0.3, (196, 132, 30)), (0.6, (238, 186, 56)), (0.85, (252, 224, 106)), (1, (255, 250, 196))],
    'leather': [(0, (74, 38, 20)), (0.3, (118, 66, 34)), (0.62, (160, 98, 54)), (0.88, (196, 136, 84)), (1, (222, 172, 118))],
    'string':  [(0, (150, 146, 140)), (0.5, (212, 208, 200)), (1, (252, 250, 246))],
    'wool':    [(0, (150, 146, 140)), (0.35, (196, 192, 186)), (0.7, (230, 228, 222)), (1, (252, 252, 250))],
    'coal':    [(0, (18, 18, 20)), (0.4, (40, 40, 44)), (0.75, (70, 70, 76)), (1, (118, 118, 126))],
    'flint':   [(0, (34, 34, 40)), (0.4, (66, 66, 74)), (0.75, (104, 104, 114)), (1, (160, 160, 172))],
    'clay':    [(0, (102, 108, 122)), (0.35, (142, 148, 162)), (0.7, (176, 182, 194)), (1, (210, 214, 224))],
    'paper':   [(0, (170, 146, 102)), (0.4, (210, 188, 140)), (0.75, (234, 218, 174)), (1, (248, 238, 206))],
    'bread':   [(0, (122, 66, 24)), (0.3, (172, 104, 40)), (0.6, (212, 148, 70)), (0.85, (234, 186, 110)), (1, (246, 220, 160))],
    'crumb':   [(0, (206, 168, 110)), (0.5, (236, 210, 158)), (1, (252, 238, 200))],
    'apple':   [(0, (98, 12, 14)), (0.3, (160, 22, 24)), (0.6, (214, 40, 36)), (0.85, (240, 86, 70)), (1, (255, 176, 156))],
    'leaf':    [(0, (34, 74, 24)), (0.4, (62, 120, 40)), (0.75, (98, 158, 58)), (1, (150, 200, 96))],
    'pork':    [(0, (178, 78, 84)), (0.3, (220, 116, 120)), (0.6, (244, 156, 158)), (0.85, (252, 196, 196)), (1, (255, 230, 230))],
    'fat':     [(0, (214, 196, 184)), (0.5, (242, 230, 222)), (1, (255, 252, 248))],
    'cpork':   [(0, (92, 44, 24)), (0.3, (140, 74, 38)), (0.6, (184, 112, 60)), (0.85, (214, 152, 96)), (1, (236, 196, 140))],
    'fish':    [(0, (52, 82, 112)), (0.3, (86, 126, 156)), (0.6, (134, 172, 196)), (0.85, (184, 210, 224)), (1, (232, 244, 248))],
    'cfish':   [(0, (112, 64, 28)), (0.3, (164, 104, 50)), (0.6, (208, 150, 86)), (0.85, (232, 194, 132)), (1, (248, 228, 186))],
    'flame':   [(0, (200, 64, 16)), (0.35, (240, 120, 30)), (0.65, (252, 190, 60)), (1, (255, 250, 210))],
    'water':   [(0, (24, 70, 150)), (0.4, (44, 110, 196)), (0.75, (88, 156, 226)), (1, (176, 216, 248))],
    'red':     [(0, (96, 20, 18)), (0.4, (156, 38, 32)), (0.75, (200, 64, 52)), (1, (236, 128, 110))],
    'glass':   [(0, (150, 110, 40)), (0.5, (250, 200, 90)), (1, (255, 248, 210))],
    'feather': [(0, (170, 170, 170)), (0.5, (226, 226, 226)), (1, (255, 255, 255))],
    'blue':    [(0, (30, 50, 110)), (0.45, (52, 84, 160)), (1, (110, 150, 214))],
}
GRAIN = {'wood': ('along', 0.22), 'darkwood': ('along', 0.18), 'stone': ('speck', 0.22), 'iron': ('along', 0.08), 'gold': ('along', 0.06),
         'leather': ('blot', 0.16), 'wool': ('blot', 0.14), 'coal': ('speck', 0.18), 'flint': ('blot', 0.14), 'clay': ('blot', 0.12),
         'paper': ('blot', 0.08), 'bread': ('blot', 0.14), 'crumb': ('speck', 0.12), 'apple': ('blot', 0.06), 'pork': ('blot', 0.1),
         'cpork': ('blot', 0.16), 'fish': ('blot', 0.08), 'cfish': ('blot', 0.14), 'leaf': ('blot', 0.1)}


class Icon:
    def __init__(self, name):
        self.name = name
        self.s = seed_of(name)
        self.rgb = np.zeros((S, S, 3))
        self.a = np.zeros((S, S), bool)
        self.k = 0

    def paint(self, mask, mat, bulge=5.0, gain=1.0, base=0.5, grain_dir=0.0, tones=7, lift=0.0, flat=False):
        """Paint `mask` in material `mat`, shaded as a soft body: `bulge` how round (px of blur), `lift` lighter or darker."""
        self.k += 1
        if not mask.any():
            return self
        m = mask.astype(np.float32)
        if flat:
            t = np.full((S, S), base + lift)
        else:
            h = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(bulge)), dtype=np.float32) / 255
            gy, gx = np.gradient(h)
            n = np.dstack([-gx * bulge * 2.2, -gy * bulge * 2.2, np.ones_like(h)])
            n /= np.linalg.norm(n, axis=2, keepdims=True)
            lam = n @ LIGHT
            t = base + (lam - 0.68) * 1.9 * gain + (h - 0.5) * 0.25 + lift
        kind, amt = GRAIN.get(mat, ('blot', 0.06))
        sd = self.s + self.k * 101
        if kind == 'along':
            g = along(grain_dir, sd, 3.0, 4.0) - 0.5
        elif kind == 'speck':
            g = (noise(sd, 2.0) - 0.5) * 0.7 + (noise(sd + 1, 6.0) - 0.5) * 0.6
        else:
            g = (fbm(sd, (10, 5, 2.5)) - 0.5) * 1.2
        t = t + g * amt
        # A few tones, as a painter would lay them, not a smooth airbrush.
        t = np.round(np.clip(t, 0, 1) * (tones - 1)) / (tones - 1)
        col = ramp(t, M[mat])
        self.rgb = np.where(mask[..., None], col, self.rgb)
        self.a |= mask
        return self

    def tint(self, mask, colour, amount):
        """Mix a colour over what is painted (a gem, a stain, a glow)."""
        c = np.array(colour, dtype=float)
        k = (amount if np.ndim(amount) else np.full((S, S), amount))[..., None] * mask[..., None]
        self.rgb = self.rgb * (1 - k) + c * k
        return self

    def shade(self, mask, k):
        """Darken (k < 0) or lighten (k > 0) what is painted under `mask`."""
        f = 1 + (k if np.ndim(k) else np.full((S, S), k))
        self.rgb = np.where(mask[..., None], np.clip(self.rgb * f[..., None], 0, 255), self.rgb)
        return self

    def put(self, mask, colour):
        self.rgb = np.where(mask[..., None], np.array(colour, dtype=float), self.rgb)
        self.a |= mask
        return self

    def save(self):
        # The edge away from the light is a little darker (the thing's own shadow at its rim).
        a = self.a
        rim = a & ~np.roll(np.roll(a, -1, 0), -1, 1)
        self.shade(rim, -0.18)
        out = np.dstack([np.clip(np.rint(self.rgb), 0, 255).astype(np.uint8), np.where(a, 255, 0).astype(np.uint8)])
        os.makedirs(OUT, exist_ok=True)
        Image.fromarray(out, 'RGBA').save(os.path.join(OUT, self.name + '.png'))


ICONS = {}


def icon(*names):
    def deco(fn):
        for n in names:
            ICONS[n] = fn
        return fn
    return deco


# ── Tools and weapons: a handle from the lower left to the upper right ──────

TIERS = {'wooden': 'wood', 'stone': 'stone', 'iron': 'iron', 'gold': 'gold'}


def handle(p, x0=9, y0=56, x1=40, y1=25, w=7.5):
    p.paint(seg(x0, y0, x1, y1, w), 'wood', bulge=2.0, grain_dir=-45)
    p.shade(seg(x0, y0, x0 + 4, y0 - 4, w + 0.5), -0.15)                 # the worn end
    return p


def tool_head(p, kind, mat):
    if kind == 'pickaxe':
        head = arc(38, 40, 27, 9, 205, 335) | ellipse(38, 13.5, 6.5, 6)
        p.paint(head, mat, bulge=3.0)
        p.paint(ellipse(38, 14, 5, 5) & ~shrink(ellipse(38, 14, 5, 5), 2), mat, bulge=1.5, lift=-0.18)
    elif kind == 'axe':
        # A bearded blade: its cutting edge a curve away from the haft, its back hollowed.
        blade = (ellipse(47, 22, 14, 18) & ~ellipse(28, 24, 12, 22) & (XX > 33)) | poly((34, 12), (44, 10), (44, 24), (36, 26))
        p.paint(blade, mat, bulge=4.0)
        p.paint(blade & ~shrink(blade, 3) & (XX > 50), mat, bulge=1.0, lift=0.32)    # the edge, ground bright
        p.paint(rellipse(38, 18, 6, 4.5, -45), mat, bulge=1.5, lift=-0.15)          # where it is fixed to the haft
    elif kind == 'shovel':
        # A spade along the haft, coming to a point.
        spade = rellipse(47, 16, 15, 10, -45) | poly((40, 10), (56, 8), (54, 24))
        p.paint(spade, mat, bulge=4.5)
        p.paint(rellipse(38, 25, 5, 4, -45), mat, bulge=1.5, lift=-0.2)
    return p


@icon('wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'gold_pickaxe')
def _(name):
    p = Icon(name)
    handle(p, 12, 58, 44, 18, 7.5)
    return tool_head(p, 'pickaxe', TIERS[name.split('_')[0]])


@icon('wooden_axe', 'stone_axe', 'iron_axe', 'gold_axe')
def _(name):
    p = Icon(name)
    handle(p, 8, 60, 40, 14, 7.5)
    return tool_head(p, 'axe', TIERS[name.split('_')[0]])


@icon('wooden_shovel', 'stone_shovel', 'iron_shovel', 'gold_shovel')
def _(name):
    p = Icon(name)
    handle(p, 6, 60, 40, 26, 7)
    return tool_head(p, 'shovel', TIERS[name.split('_')[0]])


@icon('wooden_sword', 'stone_sword', 'iron_sword', 'gold_sword')
def _(name):
    p = Icon(name)
    mat = TIERS[name.split('_')[0]]
    blade = poly((17, 39), (25, 47), (58, 14), (61, 3), (50, 6))
    p.paint(blade, mat, bulge=3.0)
    p.paint(seg(21, 43, 57, 7, 2.0), mat, bulge=0.8, lift=0.28)          # the edge along the middle, catching the light
    p.paint(seg(6, 58, 18, 46, 7.5), 'leather' if mat != 'wood' else 'darkwood', bulge=2.0)
    p.paint(seg(10, 35, 29, 54, 6.5), 'darkwood' if mat == 'wood' else ('gold' if mat == 'iron' else 'iron'), bulge=2.0)
    p.paint(ellipse(6, 58, 5.5), 'darkwood' if mat == 'wood' else ('gold' if mat == 'iron' else 'iron'), bulge=2.0)
    return p


@icon('wooden_spear', 'stone_spear', 'iron_spear', 'gold_spear')
def _(name):
    p = Icon(name)
    mat = TIERS[name.split('_')[0]]
    p.paint(seg(4, 60, 42, 22, 6.5), 'wood', bulge=1.8, grain_dir=-45)
    p.paint(seg(34, 30, 41, 23, 8.5), 'leather', bulge=1.5)                 # the binding
    tip = rellipse(50, 14, 15, 7, -45) | poly((40, 22), (46, 16), (62, 2))
    p.paint(tip, mat, bulge=2.8)
    p.paint(seg(43, 21, 60, 4, 1.8), mat, bulge=0.6, lift=0.3)
    return p


@icon('bow')
def _(name):
    p = Icon(name)
    p.paint(arc(8, 56, 47, 6.5, 270, 360), 'wood', bulge=2.0, grain_dir=45)
    p.paint(seg(8, 9, 55, 56, 1.3), 'string', flat=True, base=0.8)
    for cx, cy in ((8, 10), (55, 56)):
        p.paint(ellipse(cx, cy, 3.4), 'darkwood', bulge=1.2)
    p.paint(seg(33, 24, 40, 31, 7.5) & arc(8, 56, 47, 7.5, 270, 360), 'leather', bulge=1.5)   # the grip
    return p


@icon('arrow')
def _(name):
    p = Icon(name)
    p.paint(seg(10, 54, 50, 14, 3.4), 'wood', bulge=1.2, grain_dir=-45)
    p.paint(poly((46, 12), (52, 18), (61, 3)) | poly((44, 16), (50, 10), (61, 3)), 'flint', bulge=2.0)
    for d in (0, 5, 10):
        p.paint(poly((6 + d, 50 - d), (13 + d, 43 - d), (12 + d, 52 - d), (4 + d, 60 - d)), 'feather', bulge=1.2)
        p.paint(poly((14 + d, 58 - d), (21 + d, 51 - d), (12 + d, 52 - d), (4 + d, 60 - d)), 'feather', bulge=1.2, lift=-0.15)
    return p


@icon('iron_shield')
def _(name):
    p = Icon(name)
    shape = poly((8, 8), (56, 8), (56, 30), (48, 46), (32, 58), (16, 46), (8, 30))
    p.paint(shape, 'iron', bulge=6.0)
    inner = shrink(shape, 4)
    p.paint(inner, 'blue', bulge=6.0)
    p.paint((rect(29, 12, 35, 54) | rect(12, 24, 52, 30)) & inner, 'gold', bulge=2.0)
    p.paint(ellipse(32, 27, 5), 'gold', bulge=2.5, lift=0.1)
    return p


# ── Armour ───────────────────────────────────────────────────────────────────

ARMOUR = {'leather': 'leather', 'iron': 'iron', 'gold': 'gold'}


@icon('leather_helmet', 'iron_helmet', 'gold_helmet')
def _(name):
    p = Icon(name)
    mat = ARMOUR[name.split('_')[0]]
    dome = ellipse(32, 34, 26, 24) & (YY < 44)
    p.paint(dome, mat, bulge=7.0)
    p.paint(dome & ~shrink(dome, 3) & (YY > 40), mat, bulge=1.5, lift=-0.2)       # the rim
    p.paint(ellipse(32, 46, 16, 10) & (YY > 40) & (YY < 50) & ~ellipse(32, 52, 14, 10), mat, bulge=3, lift=-0.1)
    p.put(ellipse(32, 52, 15, 10) & (YY > 43) & (YY < 56) & dome, (40, 30, 26))      # the inside, seen under it
    if mat != 'leather':
        p.paint(seg(32, 12, 32, 42, 3) & dome, mat, bulge=1.0, lift=0.18)              # a ridge over the top
        for x in (12, 52):
            p.paint(ellipse(x, 38, 1.8), mat, bulge=0.6, lift=0.3)
    else:
        p.shade(seg(8, 38, 56, 38, 1) & dome, -0.25)
    return p


@icon('leather_chestplate', 'iron_chestplate', 'gold_chestplate')
def _(name):
    p = Icon(name)
    mat = ARMOUR[name.split('_')[0]]
    body = poly((10, 10), (22, 6), (27, 12), (37, 12), (42, 6), (54, 10), (60, 26), (50, 30), (50, 58), (14, 58), (14, 30), (4, 26))
    p.paint(body, mat, bulge=6.0)
    neck = ellipse(32, 8, 8, 7)
    p.put(neck & body, (40, 30, 26))
    p.paint(seg(32, 16, 32, 56, 2) & body, mat, bulge=0.8, lift=-0.22)
    if mat == 'leather':
        for y in (26, 34, 42):
            p.paint(ellipse(36, y, 1.6), 'iron', bulge=0.6)
    else:
        p.paint(seg(16, 32, 48, 32, 2) & body, mat, bulge=0.8, lift=-0.18)
        p.paint(seg(16, 46, 48, 46, 2) & body, mat, bulge=0.8, lift=-0.18)
    return p


@icon('leather_leggings', 'iron_leggings', 'gold_leggings')
def _(name):
    p = Icon(name)
    mat = ARMOUR[name.split('_')[0]]
    legs = poly((12, 8), (52, 8), (54, 58), (38, 58), (32, 24), (26, 58), (10, 58))
    p.paint(legs, mat, bulge=5.0)
    p.paint(rect(12, 8, 52, 15) & legs, mat, bulge=2, lift=-0.12)                     # the belt
    p.paint(rect(28, 9, 36, 14), 'gold' if mat != 'gold' else 'iron', bulge=1.0)
    p.paint(seg(32, 16, 32, 26, 1.5), mat, bulge=0.6, lift=-0.25)
    return p


@icon('leather_boots', 'iron_boots', 'gold_boots')
def _(name):
    p = Icon(name)
    mat = ARMOUR[name.split('_')[0]]
    for ox, k in ((0, -0.12), (24, 0.0)):
        boot = poly((8 + ox, 14), (24 + ox, 14), (24 + ox, 42), (36 + ox, 46), (36 + ox, 56), (6 + ox, 56), (8 + ox, 40))
        p.paint(boot, mat, bulge=4.0, lift=k)
        p.paint(rect(6 + ox, 52, 37 + ox, 57) & boot, 'darkwood' if mat == 'leather' else mat, bulge=1.2, lift=-0.15)   # the sole
        p.paint(rect(8 + ox, 14, 24 + ox, 19) & boot, mat, bulge=1.2, lift=-0.1)
    return p


@icon('leather_quiver', 'iron_quiver')
def _(name):
    p = Icon(name)
    mat = 'leather' if name.startswith('leather') else 'iron'
    for x, y in ((22, 6), (30, 3), (38, 7)):
        p.paint(seg(x, y + 14, x, y + 2, 2.2), 'wood', bulge=0.8)
        p.paint(poly((x - 3, y + 7), (x + 3, y + 7), (x, y)), 'feather', bulge=1.0)
    case = poly((16, 18), (46, 18), (44, 60), (18, 60))
    p.paint(case, mat, bulge=5.0)
    p.paint(rect(16, 18, 46, 23) & case, 'darkwood' if mat == 'leather' else 'leather', bulge=1.5)
    p.paint(seg(48, 16, 20, 60, 3), 'leather', bulge=1.0, lift=-0.1)                     # the strap
    return p


# ── Materials ────────────────────────────────────────────────────────────────

@icon('stick')
def _(name):
    p = Icon(name)
    p.paint(seg(12, 54, 52, 10, 5.5), 'wood', bulge=1.8, grain_dir=-45)
    p.paint(seg(30, 34, 38, 34, 3) & seg(12, 54, 52, 10, 7), 'wood', bulge=1.0, lift=-0.15)   # a knot
    return p


@icon('string')
def _(name):
    p = Icon(name)
    t = np.linspace(0, 1, 400)
    m = np.zeros((S, S), bool)
    for u in t:
        x = 32 + 20 * math.sin(u * math.pi * 3.2) * (1 - u * 0.4)
        y = 6 + u * 52
        m |= ellipse(x, y, 1.9)
    p.paint(m, 'string', bulge=1.0)
    return p


@icon('leather')
def _(name):
    p = Icon(name)
    hide = poly((10, 14), (22, 8), (32, 12), (44, 7), (56, 14), (52, 30), (58, 46), (46, 56), (32, 52), (18, 57), (8, 46), (12, 30))
    p.paint(hide, 'leather', bulge=6.0)
    p.paint(hide & ~shrink(hide, 2), 'leather', bulge=1.0, lift=-0.18)
    return p


@icon('wool')
def _(name):
    p = Icon(name)
    ball = ellipse(32, 34, 24, 22)
    p.paint(ball, 'wool', bulge=8.0)
    for k in range(6):
        a = k * 0.55 + 0.3
        p.shade(arc(32, 34, 8 + k * 2.6, 1.1, 200 + k * 20, 340 + k * 15) & ball, -0.12)
    p.paint(seg(46, 52, 58, 58, 2.2), 'wool', bulge=0.8)
    return p


@icon('flint')
def _(name):
    p = Icon(name)
    shard = poly((14, 20), (34, 6), (54, 18), (50, 46), (30, 58), (10, 44))
    p.paint(shard, 'flint', bulge=5.0)
    p.paint(poly((34, 6), (54, 18), (36, 26)), 'flint', bulge=2.0, lift=0.2)              # a flaked face
    p.paint(poly((10, 44), (30, 58), (26, 40)), 'flint', bulge=2.0, lift=-0.2)
    return p


@icon('coal', 'charcoal')
def _(name):
    p = Icon(name)
    lump = poly((12, 24), (26, 10), (44, 12), (56, 28), (52, 48), (34, 58), (14, 50), (8, 36))
    p.paint(lump, 'coal', bulge=6.0)
    if name == 'charcoal':
        for y in (22, 30, 38, 46):
            p.shade(seg(12, y, 54, y - 4, 1.1) & lump, -0.3)
        p.tint(lump, (60, 40, 30), 0.12)
    else:
        for x, y in ((24, 22), (40, 32), (28, 42)):
            p.paint(ellipse(x, y, 2.4) & lump, 'coal', bulge=0.8, lift=0.3)
    return p


@icon('iron_ingot', 'gold_ingot')
def _(name):
    p = Icon(name)
    mat = name.split('_')[0]
    top = poly((14, 22), (44, 14), (56, 22), (26, 32))
    front = poly((26, 32), (56, 22), (58, 34), (28, 46))
    side = poly((14, 22), (26, 32), (28, 46), (8, 36))
    p.paint(side, mat, bulge=3.0, lift=-0.18)
    p.paint(front, mat, bulge=3.0, lift=-0.04)
    p.paint(top, mat, bulge=3.0, lift=0.14)
    return p


@icon('raw_iron', 'raw_gold')
def _(name):
    p = Icon(name)
    mat = name.split('_')[1]
    p.paint(poly((10, 28), (24, 12), (42, 10), (56, 24), (54, 46), (36, 56), (14, 50)), 'stone', bulge=6.0)
    r = np.random.default_rng(seed_of(name))
    for _k in range(9):
        x, y = r.uniform(18, 48), r.uniform(18, 48)
        rr = r.uniform(3.5, 6)
        p.paint(ellipse(x, y, rr, rr * 0.85), mat, bulge=2.2)
    return p


@icon('clay_ball')
def _(name):
    p = Icon(name)
    ball = ellipse(32, 34, 20, 18)
    p.paint(ball, 'clay', bulge=7.0)
    p.shade(arc(26, 26, 9, 1.2, 100, 200) & ball, -0.12)
    p.shade(arc(40, 40, 7, 1.2, 280, 20) & ball, -0.1)
    return p


@icon('map')
def _(name):
    p = Icon(name)
    sheet = poly((6, 12), (58, 8), (60, 52), (8, 58))
    p.paint(sheet, 'paper', bulge=4.0)
    land = sheet & ~grow(sheet & ~shrink(sheet, 4), 0)
    p.tint(land & ellipse(22, 36, 12, 10), (110, 156, 80), 0.75)
    p.tint(land & ellipse(44, 22, 10, 8), (122, 166, 90), 0.7)
    river = np.abs(YY - (30 + 7 * np.sin(XX * 0.14))) < 1.6
    p.tint(land & river, (70, 120, 196), 0.85)
    x = (np.abs((XX - 44) - (YY - 42)) < 1.4) | (np.abs((XX - 44) + (YY - 42)) < 1.4)
    p.tint(land & x & (np.abs(XX - 44) < 4), (190, 40, 36), 0.95)
    p.shade(seg(32, 9, 34, 55, 1.2) & sheet, -0.12)                                    # where it was folded
    return p


@icon('bucket', 'water_bucket')
def _(name):
    p = Icon(name)
    body = poly((12, 20), (52, 20), (46, 56), (18, 56))
    p.paint(arc(32, 22, 20, 3, 190, 350), 'iron', bulge=1.0)                             # the handle
    p.paint(body, 'iron', bulge=6.0, grain_dir=90)
    rim = ellipse(32, 20, 21, 6)
    p.paint(rim, 'iron', bulge=2.0, lift=0.1)
    p.paint(ellipse(32, 20, 17, 4.2), 'water' if name == 'water_bucket' else 'stone', bulge=2.0, lift=-0.1 if name == 'bucket' else 0.0)
    for y in (32, 46):
        p.paint(seg(14, y, 50, y, 2) & body, 'iron', bulge=0.8, lift=-0.18)
    return p


@icon('flint_and_steel')
def _(name):
    p = Icon(name)
    p.paint(arc(26, 24, 15, 7, 70, 380 - 50), 'iron', bulge=2.5)
    p.paint(poly((32, 36), (52, 28), (58, 46), (40, 58)), 'flint', bulge=4.0)
    p.paint(poly((52, 28), (58, 46), (54, 36)), 'flint', bulge=1.5, lift=0.2)
    return p


@icon('torch')
def _(name):
    p = Icon(name)
    p.paint(seg(32, 60, 32, 24, 7), 'wood', bulge=1.8, grain_dir=90)
    p.paint(rect(28, 22, 36, 28), 'coal', bulge=1.5)
    flame = ellipse(32, 15, 8, 11) | poly((26, 14), (38, 14), (32, 1))
    p.paint(flame, 'flame', bulge=4.0, base=0.62, lift=0.15)
    p.tint(ellipse(32, 17, 3.5, 5), (255, 255, 230), 0.7)
    return p


@icon('lantern')
def _(name):
    p = Icon(name)
    p.paint(arc(32, 14, 7, 3, 180, 360), 'iron', bulge=1.0)
    p.paint(rect(20, 12, 44, 18), 'iron', bulge=2.0, lift=-0.1)
    glass = rect(22, 18, 42, 50)
    p.paint(glass, 'glass', bulge=5.0, base=0.6, lift=0.1)
    p.tint(ellipse(32, 34, 5, 8), (255, 250, 220), 0.75)
    for x in (21, 31, 41):
        p.paint(rect(x - 1, 18, x + 2, 50), 'iron', bulge=1.0, lift=-0.05)
    p.paint(rect(18, 50, 46, 56), 'iron', bulge=2.0, lift=-0.1)
    return p


# ── Food ─────────────────────────────────────────────────────────────────────

@icon('apple')
def _(name):
    p = Icon(name)
    body = ellipse(24, 38, 17, 18) | ellipse(40, 38, 17, 18)
    body &= ~ellipse(32, 18, 6, 4)
    p.paint(body, 'apple', bulge=8.0)
    p.paint(seg(32, 21, 35, 8, 3), 'darkwood', bulge=1.0)
    p.paint(poly((35, 12), (48, 6), (54, 12), (42, 17)), 'leaf', bulge=2.0)
    p.paint(ellipse(22, 30, 3.5, 5) & body, 'apple', bulge=1.0, lift=0.4)
    return p


@icon('bread')
def _(name):
    p = Icon(name)
    loaf = ellipse(32, 36, 28, 18) & (YY < 52) | rect(6, 36, 58, 52) & ellipse(32, 40, 28, 20)
    p.paint(loaf, 'bread', bulge=7.0)
    for x in (18, 30, 42):
        cut = seg(x - 4, 30, x + 4, 22, 3)
        p.paint(cut & loaf, 'crumb', bulge=1.0, base=0.55)
    return p


@icon('raw_pork', 'cooked_pork')
def _(name):
    p = Icon(name)
    cooked = name.startswith('cooked')
    chop = ellipse(30, 34, 24, 20) | ellipse(46, 46, 12, 10)
    p.paint(chop, 'cpork' if cooked else 'pork', bulge=7.0)
    rind = chop & ~shrink(chop, 4) & (XX + YY < 74)
    p.paint(rind, 'cpork' if cooked else 'fat', bulge=2.0, lift=0.12 if cooked else 0.0)
    p.paint(ellipse(40, 44, 4, 3.5), 'fat', bulge=1.5, lift=-0.1 if cooked else 0.0)        # the bone
    if cooked:
        for k in range(3):
            p.shade(seg(16 + k * 10, 24, 30 + k * 10, 44, 1.6) & chop, -0.25)               # grill marks
    else:
        p.tint(chop & (fbm(seed_of(name, 3), (6, 3)) > 0.62), (250, 210, 210), 0.5)
    return p


@icon('raw_fish', 'cooked_fish')
def _(name):
    p = Icon(name)
    cooked = name.startswith('cooked')
    body = ellipse(28, 34, 22, 13)
    tail = poly((46, 34), (60, 20), (58, 34), (60, 48))
    p.paint(tail, 'cfish' if cooked else 'fish', bulge=2.0, lift=-0.08)
    p.paint(body, 'cfish' if cooked else 'fish', bulge=6.0)
    p.paint(poly((22, 22), (34, 20), (40, 24)), 'cfish' if cooked else 'fish', bulge=1.5, lift=-0.1)    # the fin
    if not cooked:
        p.tint(body & (YY > 36), (236, 240, 236), 0.55)
        p.put(ellipse(14, 31, 2.2), (20, 22, 30))
        p.put(ellipse(13.4, 30.4, 0.8), (240, 240, 240))
    else:
        for k in range(3):
            p.shade(seg(16 + k * 9, 24, 24 + k * 9, 44, 1.5) & body, -0.22)
        p.put(ellipse(14, 31, 2), (40, 26, 16))
    return p


# ── Blocks shown as things (in case a block's picture is not there) ─────────

def box_icon(p, top_mat, front_mat, side_mat, top_lift=0.15):
    top = poly((32, 6), (58, 18), (32, 30), (6, 18))
    left = poly((6, 18), (32, 30), (32, 60), (6, 48))
    right = poly((32, 30), (58, 18), (58, 48), (32, 60))
    p.paint(left, front_mat, bulge=3.0, lift=-0.12, flat=False)
    p.paint(right, side_mat, bulge=3.0, lift=-0.28)
    p.paint(top, top_mat, bulge=3.0, lift=top_lift)
    return p, top, left, right


@icon('crafting_table')
def _(name):
    p, top, left, right = box_icon(Icon(name), 'wood', 'wood', 'wood')
    for k in range(1, 3):
        p.shade(seg(6 + k * 26 / 3, 18 + k * 12 / 3, 32 + k * 26 / 3, 6 + k * 12 / 3, 1.2) & top, -0.3)
        p.shade(seg(32 - k * 26 / 3, 6 + k * 12 / 3, 58 - k * 26 / 3, 18 + k * 12 / 3, 1.2) & top, -0.3)
    return p


@icon('chest')
def _(name):
    p, top, left, right = box_icon(Icon(name), 'wood', 'wood', 'wood')
    p.shade(seg(6, 30, 32, 42, 2) & left, -0.35)
    p.paint(poly((16, 33), (22, 36), (22, 42), (16, 39)), 'gold', bulge=1.0)
    return p


@icon('oven', 'smelter')
def _(name):
    p, top, left, right = box_icon(Icon(name), 'stone', 'stone', 'stone')
    mouth = poly((11, 30), (27, 38), (27, 50), (11, 42))
    p.put(mouth, (36, 24, 20))
    p.paint(shrink(mouth, 2), 'flame', bulge=2.0, base=0.6)
    return p


@icon('anvil')
def _(name):
    p = Icon(name)
    p.paint(poly((14, 50), (50, 50), (54, 58), (10, 58)), 'iron', bulge=2.0, lift=-0.2)
    p.paint(rect(24, 34, 40, 50), 'iron', bulge=2.0, lift=-0.1)
    p.paint(poly((4, 20), (60, 20), (56, 34), (14, 34), (4, 26)), 'iron', bulge=3.0)
    p.paint(rect(4, 20, 60, 24), 'iron', bulge=1.0, lift=0.2)
    return p


def main(argv):
    names = argv or sorted(ICONS)
    done = 0
    for n in names:
        if n in KEEP:
            print('left as it is (drawn by hand):', n)
            continue
        if n not in ICONS:
            print('no such icon:', n)
            continue
        ICONS[n](n).save()
        done += 1
    print(f'wrote {done} icons to', os.path.normpath(OUT))


if __name__ == '__main__':
    main(sys.argv[1:])
