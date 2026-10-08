"""
Paints the block textures (data/textures/blocks/*.png), 32 x 32 texels each.

    python tools/gen_block_textures.py [name ...]      (needs Pillow and numpy)

Every texture is drawn from tiling noise, so it repeats without a seam in both
directions and has no frame round its edge: laid over smooth terrain, where a
block is no longer a cube, the ground must not show where one block ends and
the next begins. What gives a material its look is its grain — blades, pebbles,
strata, fibres, crystals — and its colours, taken from the real thing rather
than a bright palette. Large features are kept faint, because whatever is in a
texture comes round again every block; variation on a larger scale than that
is added by the chunk shader (ground() in world.js).

Blocks people build with (planks, bricks, the workstations) do line up with the
block: that is what they are.

Deterministic: each texture has its own seed, so running this again changes
nothing unless a recipe below is changed. With names, only those are written
(without the .png).
"""
import os
import sys

import numpy as np
from PIL import Image

N = 32
# WW_TEX_OUT: write somewhere else, to look at a change before it replaces the game's textures.
OUT = os.environ.get('WW_TEX_OUT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'textures', 'blocks')


# ── Noise ────────────────────────────────────────────────────────────────────

def _rng(seed):
    return np.random.default_rng(abs(hash(seed)) % (2 ** 32) if isinstance(seed, str) else seed)


def _seed(name, k=0):
    """A stable seed from a texture's name (Python's hash() is salted per run)."""
    h = 2166136261
    for ch in f'{name}#{k}':
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h


def value_noise(cx, cy, seed):
    """Smooth tiling noise, 0..1: a cx x cy lattice of random values across the tile."""
    g = np.random.default_rng(seed).random((cy, cx))
    ys = (np.arange(N) + 0.5) / N * cy
    xs = (np.arange(N) + 0.5) / N * cx
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    fy = ys - y0
    fx = xs - x0
    sy = fy * fy * (3 - 2 * fy)
    sx = fx * fx * (3 - 2 * fx)
    y1 = (y0 + 1) % cy
    x1 = (x0 + 1) % cx
    y0 %= cy
    x0 %= cx
    a = g[np.ix_(y0, x0)]
    b = g[np.ix_(y0, x1)]
    c = g[np.ix_(y1, x0)]
    d = g[np.ix_(y1, x1)]
    top = a + (b - a) * sx[None, :]
    bot = c + (d - c) * sx[None, :]
    return top + (bot - top) * sy[:, None]


def norm(a):
    lo, hi = a.min(), a.max()
    return (a - lo) / (hi - lo) if hi > lo else np.zeros_like(a)


def fbm(seed, cells=(4, 8, 16, 32), gain=0.55, sx=1.0, sy=1.0):
    """Layered noise, 0..1. sx / sy stretch the lattice (sy < 1: features run tall)."""
    out = np.zeros((N, N))
    amp = 1.0
    for i, c in enumerate(cells):
        cx = max(1, min(N, int(round(c * sx))))
        cy = max(1, min(N, int(round(c * sy))))
        out += value_noise(cx, cy, seed + i * 7919) * amp
        amp *= gain
    return norm(out)


def grain(seed, amount=1.0):
    """Per-texel noise, -amount..amount."""
    return (np.random.default_rng(seed).random((N, N)) * 2 - 1) * amount


def worley(count, seed, jitter=1.0):
    """
    Tiling cells: distance to the nearest and second nearest of `count` points,
    and which point is nearest. Points sit on a jittered grid so cells are even.
    """
    r = np.random.default_rng(seed)
    side = int(np.ceil(np.sqrt(count)))
    pts = []
    for i in range(side):
        for j in range(side):
            pts.append(((i + 0.5 + (r.random() - 0.5) * jitter) * N / side,
                        (j + 0.5 + (r.random() - 0.5) * jitter) * N / side))
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    d = np.empty((len(pts), N, N))
    for k, (px, py) in enumerate(pts):
        dx = np.abs(xx - px)
        dx = np.minimum(dx, N - dx)
        dy = np.abs(yy - py)
        dy = np.minimum(dy, N - dy)
        d[k] = np.hypot(dx, dy)
    order = np.argsort(d, axis=0)
    ds = np.take_along_axis(d, order, axis=0)
    return ds[0], ds[1], order[0]


def wrap_shift(a, dx, dy):
    return np.roll(np.roll(a, dy, axis=0), dx, axis=1)


def blur(a, passes=1):
    """A small tiling blur."""
    for _ in range(passes):
        a = (a * 4 + wrap_shift(a, 1, 0) + wrap_shift(a, -1, 0) + wrap_shift(a, 0, 1) + wrap_shift(a, 0, -1)) / 8
    return a


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ── Colour ───────────────────────────────────────────────────────────────────

def ramp(t, stops):
    """Colour for each value of t (0..1) along `stops`: [(position, (r, g, b)), ...]."""
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    pos = [s[0] for s in stops]
    for ch in range(3):
        out[..., ch] = np.interp(t, pos, [s[1][ch] for s in stops])
    return out


def shade(rgb, k):
    """Brighten (k > 0) or darken (k < 0) by a fraction; k is a field or a number."""
    k = np.asarray(k)
    if k.ndim == 2:
        k = k[..., None]
    return rgb * (1 + k)


def mix(a, b, t):
    t = np.asarray(t, dtype=float)
    if t.ndim == 2:
        t = t[..., None]
    return a + (np.asarray(b, dtype=float) - a) * t


def flat(colour):
    return np.tile(np.asarray(colour, dtype=float), (N, N, 1))


def save(name, rgb, alpha=None):
    rgb = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    a = np.full((N, N), 255, np.uint8) if alpha is None else np.clip(np.rint(alpha), 0, 255).astype(np.uint8)
    Image.fromarray(np.dstack([rgb, a]), 'RGBA').save(os.path.join(OUT, name + '.png'))


# ── Materials ────────────────────────────────────────────────────────────────

def stone(name, base, dark, light, vein=0.5, speck=0.0, speck_colour=None, cells=(3, 6, 12, 24), contrast=1.0):
    """Rock: mottled, with faint darker seams and a fine tooth."""
    s = _seed(name)
    body = fbm(s, cells, 0.6)
    fine = fbm(s + 11, (16, 32), 0.7)
    t = np.clip(0.5 + (body - 0.5) * 0.8 * contrast + (fine - 0.5) * 0.35, 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    # Seams: thin lines where a broad noise crosses its middle.
    seam_n = fbm(s + 23, (2, 4, 8), 0.5)
    seam = 1 - smooth(0.0, 0.035, np.abs(seam_n - 0.5))
    rgb = shade(rgb, -0.22 * vein * seam * (0.5 + fbm(s + 31, (4, 8))))
    rgb = shade(rgb, grain(s + 5, 0.035))
    if speck > 0:
        r = np.random.default_rng(s + 41).random((N, N))
        rgb = mix(rgb, speck_colour, (r < speck) * 0.85)
    return rgb


def soil(name, base, dark, light, clods=0.5, stones=0.0, stone_colour=(150, 142, 130)):
    """Earth: crumbly, with small clods and the odd stone."""
    s = _seed(name)
    body = fbm(s, (4, 8, 16, 32), 0.7)
    d1, d2, _ = worley(40, s + 3)
    crumb = smooth(0.4, 1.6, d2 - d1)           # dark between crumbs
    t = np.clip(0.5 + (body - 0.5) * 0.9 - (1 - crumb) * 0.25 * clods, 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    rgb = shade(rgb, grain(s + 5, 0.05))
    if stones > 0:
        p1, p2, pid = worley(16, s + 9, 0.9)
        keep = (np.random.default_rng(s + 10).random(64)[pid % 64] < stones)
        size = 1.2 + np.random.default_rng(s + 12).random(64)[pid % 64] * 1.5
        m = (p1 < size) & keep
        lit = smooth(size, 0, p1)
        rgb = mix(rgb, shade(flat(stone_colour), (lit - 0.6) * 0.35), m * 0.9)
    return rgb


def sand(name, base, dark, light, ripple=0.5):
    """Sand: fine grain, with a hint of wind ripple and scattered darker grains."""
    s = _seed(name)
    body = fbm(s, (4, 8, 16), 0.6)
    warp = fbm(s + 2, (2, 4), 0.5) * 2 * np.pi
    yy, xx = np.mgrid[0:N, 0:N]
    wave = 0.5 + 0.5 * np.sin((yy * 3 + xx) * (2 * np.pi / N) * 1 + warp * 1.5 + np.sin(xx * 2 * np.pi / N) * 0.8)
    t = np.clip(0.5 + (body - 0.5) * 0.45 + (wave - 0.5) * 0.22 * ripple, 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    rgb = shade(rgb, grain(s + 5, 0.045))
    r = np.random.default_rng(s + 7).random((N, N))
    rgb = shade(rgb, (r < 0.035) * -0.16 + (r > 0.975) * 0.10)
    return rgb


def blades(name, base, dark, light, tip, dry=0.0, length=5):
    """Grass seen from above: short blades lying every which way over shaded gaps."""
    s = _seed(name)
    r = np.random.default_rng(s)
    under = fbm(s + 1, (4, 8, 16), 0.65)
    t = 0.32 + (under - 0.5) * 0.35
    canvas = np.clip(t, 0, 1)
    # Blades: short strokes, each a little brighter toward its tip.
    for _ in range(170):
        x, y = r.random() * N, r.random() * N
        ang = r.normal(-np.pi / 2, 0.75)
        ln = length * (0.5 + r.random())
        b0 = 0.38 + r.random() * 0.34
        for k in range(int(ln * 2)):
            f = k / (ln * 2)
            px = int(x + np.cos(ang) * ln * f) % N
            py = int(y + np.sin(ang) * ln * f) % N
            canvas[py, px] = max(canvas[py, px], b0 + f * 0.3)
    canvas = np.clip(canvas + grain(s + 5, 0.04), 0, 1)
    rgb = ramp(canvas, [(0, dark), (0.5, base), (0.85, light), (1, tip)])
    if dry > 0:
        d = fbm(s + 9, (3, 6, 12), 0.6)
        rgb = mix(rgb, shade(flat((176, 158, 96)), (canvas - 0.5) * 0.5), smooth(0.45, 0.8, d) * dry)
    return rgb


def side_of(name, top_rgb, dirt_rgb, depth=7, ragged=3):
    """The side of turf: soil below, the top growing over its upper edge."""
    s = _seed(name)
    r = np.random.default_rng(s)
    edge = depth + (value_noise(8, 1, s + 1)[0] - 0.5) * 2 * ragged
    edge = edge + (r.random(N) - 0.5) * 2.2
    yy = np.mgrid[0:N, 0:N][0]
    over = yy < edge[None, :]
    rgb = np.where(over[..., None], top_rgb, dirt_rgb)
    # A shadow under the overhang.
    under = (yy >= edge[None, :]) & (yy < edge[None, :] + 2)
    rgb = shade(rgb, -0.22 * under)
    return rgb


def bark(name, base, dark, light, ridges=9, rough=1.0):
    """Tree bark: long vertical plates split by dark furrows. Tiles round the trunk and up it."""
    s = _seed(name)
    furrow = fbm(s, (ridges, ridges * 2), 0.5, sx=1.0, sy=0.18)
    plate = fbm(s + 3, (ridges * 2, 32), 0.6, sx=1.0, sy=0.3)
    t = np.clip(0.5 + (furrow - 0.5) * 1.5 * rough + (plate - 0.5) * 0.35, 0, 1)
    rgb = ramp(t, [(0, dark), (0.45, base), (1, light)])
    return shade(rgb, grain(s + 5, 0.04))


def rings(name, wood, wood_dark, bark_rgb, count=5.5):
    """The cut end of a log: growth rings inside a rim of bark."""
    s = _seed(name)
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    cx, cy = N / 2 + 0.6, N / 2 - 0.4
    wob = (fbm(s, (3, 6), 0.5) - 0.5) * 2.4
    d = np.hypot(xx - cx, yy - cy) + wob
    ring = 0.5 + 0.5 * np.cos(d / (N / 2) * count * 2 * np.pi)
    rgb = mix(flat(wood_dark), wood, smooth(0.15, 0.9, ring))
    rgb = shade(rgb, (fbm(s + 2, (8, 16)) - 0.5) * 0.12 + grain(s + 5, 0.03))
    # Rays out from the pith.
    ang = np.arctan2(yy - cy, xx - cx)
    rays = 0.5 + 0.5 * np.cos(ang * 23 + fbm(s + 4, (4, 8)) * 6)
    rgb = shade(rgb, -0.06 * smooth(0.7, 1, rays))
    edge = np.maximum(np.abs(xx - N / 2), np.abs(yy - N / 2))
    rim = smooth(N / 2 - 3.2, N / 2 - 1.6, edge + wob * 0.25)
    return mix(rgb, bark_rgb, rim)


def foliage(name, base, dark, light, leaf=3.0, count=64, needles=False):
    """
    Leaves, opaque: lit leaves over the shade between them. Drawn solid — a
    crown is a mass of leaves, and the dark between them reads as depth.
    """
    s = _seed(name)
    r = np.random.default_rng(s)
    depth = fbm(s + 1, (4, 8, 16), 0.6)
    canvas = 0.12 + depth * 0.22
    if needles:
        for _ in range(260):
            x, y = r.random() * N, r.random() * N
            ang = r.choice([0.6, -0.6, 2.5, -2.5]) + r.normal(0, 0.25)
            ln = 2.5 + r.random() * 3
            b0 = 0.35 + r.random() * 0.5
            for k in range(int(ln * 2)):
                f = k / (ln * 2)
                px = int(x + np.cos(ang) * ln * f) % N
                py = int(y + np.sin(ang) * ln * f) % N
                canvas[py, px] = max(canvas[py, px], b0 * (0.75 + 0.25 * f))
    else:
        yy, xx = np.mgrid[0:N, 0:N] + 0.5
        for _ in range(count):
            x, y = r.random() * N, r.random() * N
            ang = r.random() * np.pi
            a, b = leaf * (0.7 + r.random() * 0.6), leaf * (0.35 + r.random() * 0.25)
            b0 = 0.4 + r.random() * 0.5
            dx = (xx - x + N / 2) % N - N / 2
            dy = (yy - y + N / 2) % N - N / 2
            u = dx * np.cos(ang) + dy * np.sin(ang)
            v = -dx * np.sin(ang) + dy * np.cos(ang)
            q = (u / a) ** 2 + (v / b) ** 2
            inside = q < 1
            # Lit along one edge, with a midrib.
            val = b0 * (0.78 + 0.3 * (v / b) * 0.5) - 0.07 * (np.abs(v) < 0.35)
            canvas = np.where(inside, np.maximum(canvas, val), canvas)
    canvas = np.clip(canvas + grain(s + 5, 0.035), 0, 1)
    return ramp(canvas, [(0, dark), (0.5, base), (1, light)])


def strata(name, base, dark, light, bands=7, grainy=1.0):
    """Layered rock: thin beds, a little uneven, with a sandy tooth."""
    s = _seed(name)
    yy = np.mgrid[0:N, 0:N][0]
    wob = (fbm(s, (2, 4), 0.5) - 0.5) * 3.0
    r = np.random.default_rng(s + 1)
    tone = r.random(bands)
    edges = np.sort(r.choice(np.arange(1, N), bands - 1, replace=False))
    idx = np.searchsorted(edges, (yy + wob) % N)
    t = tone[idx % bands]
    body = fbm(s + 3, (8, 16, 32), 0.7)
    t = np.clip(0.5 + (t - 0.5) * 0.55 + (body - 0.5) * 0.4, 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    return shade(rgb, grain(s + 5, 0.04 * grainy))


def baked(name, base, spread=0.10):
    """Fired clay: one earth colour, streaked and a little uneven."""
    s = _seed(name)
    body = fbm(s, (3, 6, 12), 0.6, sx=1.0, sy=0.5)
    fine = fbm(s + 1, (16, 32), 0.7)
    rgb = shade(flat(base), (body - 0.5) * 2 * spread + (fine - 0.5) * 0.07)
    return shade(rgb, grain(s + 5, 0.025))


def ore(name, rock, nugget, nugget_dark, nugget_light, count=5, size=2.6, metallic=False):
    """Ore in its rock: irregular grains gathered along a seam, not evenly sprinkled."""
    s = _seed(name)
    r = np.random.default_rng(s)
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    mask = np.zeros((N, N))
    # Clusters strung along a wandering line across the tile.
    y0, slope = r.random() * N, r.normal(0, 0.5)
    for i in range(count):
        cx = (i + r.random() * 0.7) * N / count
        cy = (y0 + slope * cx + r.normal(0, 3.0)) % N
        for _ in range(r.integers(2, 5)):
            px, py = cx + r.normal(0, 1.8), cy + r.normal(0, 1.8)
            a, b = size * (0.5 + r.random() * 0.6), size * (0.35 + r.random() * 0.4)
            ang = r.random() * np.pi
            dx = (xx - px + N / 2) % N - N / 2
            dy = (yy - py + N / 2) % N - N / 2
            u = dx * np.cos(ang) + dy * np.sin(ang)
            v = -dx * np.sin(ang) + dy * np.cos(ang)
            mask = np.maximum(mask, 1 - ((u / a) ** 2 + (v / b) ** 2))
    mask = np.clip(mask + (fbm(s + 3, (8, 16)) - 0.5) * 0.5, 0, 1)
    inside = mask > 0.15
    t = fbm(s + 7, (8, 16, 32), 0.7)
    if metallic:
        t = np.clip(t * 0.6 + smooth(0.2, 0.9, mask) * 0.5, 0, 1)
    n_rgb = ramp(t, [(0, nugget_dark), (0.5, nugget), (1, nugget_light)])
    out = np.where(inside[..., None], n_rgb, rock)
    # The rock darkens a touch right round each grain.
    halo = (mask > 0.02) & ~inside
    return shade(out, -0.12 * halo)


def boards(name, base, dark, light, rows=4, vertical=False, joints=True):
    """Sawn boards with grain running along them and a thin dark gap between."""
    s = _seed(name)
    h = N // rows
    g = fbm(s, (4, 8, 16, 32), 0.6, sx=0.25, sy=1.6)
    yy, xx = np.mgrid[0:N, 0:N]
    row = yy // h
    tone = np.random.default_rng(s + 1).random(rows)[row % rows]
    t = np.clip(0.5 + (g - 0.5) * 0.7 + (tone - 0.5) * 0.25, 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    gap = (yy % h == h - 1)
    rgb = shade(rgb, -0.38 * gap - 0.10 * (yy % h == 0))
    if joints:
        jr = np.random.default_rng(s + 2)
        for k in range(rows):
            jx = int(jr.integers(3, N - 3))
            sel = (row == k) & (xx == jx)
            rgb = shade(rgb, -0.30 * sel)
    rgb = shade(rgb, grain(s + 5, 0.03))
    return np.transpose(rgb, (1, 0, 2)) if vertical else rgb


def brickwork(name, brick, brick_dark, brick_light, mortar, rows=4, per_row=2, rough=1.0, varied=0.35):
    """Bricks in running bond, each its own shade, in recessed mortar."""
    s = _seed(name)
    h, w = N // rows, N // per_row
    yy, xx = np.mgrid[0:N, 0:N]
    row = yy // h
    off = (row % 2) * (w // 2)
    col = ((xx + off) % N) // w
    tone = np.random.default_rng(s).random((rows, per_row))[row % rows, col % per_row]
    body = fbm(s + 1, (8, 16, 32), 0.7)
    t = np.clip(0.5 + (tone - 0.5) * varied * 2 + (body - 0.5) * 0.45 * rough, 0, 1)
    rgb = ramp(t, [(0, brick_dark), (0.5, brick), (1, brick_light)])
    joint = (yy % h == h - 1) | (((xx + off) % w) == w - 1)
    lit = (yy % h == 0) | (((xx + off) % w) == 0)
    rgb = shade(rgb, 0.07 * (lit & ~joint))
    m = shade(flat(mortar), (fbm(s + 2, (16, 32)) - 0.5) * 0.2)
    rgb = np.where(joint[..., None], m, rgb)
    return shade(rgb, grain(s + 5, 0.03 * rough))


def metal(name, base, dark, light, brushed=True, plates=2):
    """Worked metal: brushed, in plates with a seam between them."""
    s = _seed(name)
    g = fbm(s, (8, 16, 32), 0.7, sx=0.2 if brushed else 1.0, sy=2.0 if brushed else 1.0)
    yy, xx = np.mgrid[0:N, 0:N]
    sheen = 0.5 + 0.5 * np.cos((xx + yy) / N * 2 * np.pi)
    t = np.clip(0.5 + (g - 0.5) * 0.4 + (sheen - 0.5) * 0.25, 0, 1)
    rgb = ramp(t, [(0, dark), (0.5, base), (1, light)])
    if plates:
        h = N // plates
        seam = (yy % h == h - 1) | (xx % h == h - 1)
        hi = (yy % h == 0) | (xx % h == 0)
        rgb = shade(rgb, -0.3 * seam + 0.12 * (hi & ~seam))
    return shade(rgb, grain(s + 5, 0.02))


# ── The textures ─────────────────────────────────────────────────────────────

T = {}


def tex(name):
    def deco(fn):
        T[name] = fn
        return fn
    return deco


# Colours used by more than one texture.
DIRT = dict(base=(121, 88, 60), dark=(84, 60, 41), light=(150, 113, 80))
STONE = dict(base=(128, 129, 128), dark=(94, 96, 98), light=(158, 158, 155))
GRASS = dict(base=(88, 132, 54), dark=(46, 82, 34), light=(124, 164, 70), tip=(160, 190, 96))
OAK_BARK = dict(base=(104, 80, 54), dark=(58, 44, 30), light=(138, 110, 78))
SPRUCE_BARK = dict(base=(78, 58, 42), dark=(40, 29, 22), light=(108, 84, 62))


def dirt_rgb():
    return soil('Dirt', **DIRT, clods=0.6, stones=0.12)


def stone_rgb():
    return stone('Stone', **STONE, vein=0.7)


@tex('Dirt')
def _():
    save('Dirt', dirt_rgb())


@tex('Coarse_Dirt')
def _():
    save('Coarse_Dirt', soil('Coarse_Dirt', (128, 100, 74), (88, 68, 50), (160, 132, 102), clods=0.9, stones=0.55,
                             stone_colour=(156, 148, 136)))


@tex('Mud')
def _():
    s = _seed('Mud')
    rgb = soil('Mud', (78, 62, 50), (50, 39, 32), (104, 86, 70), clods=0.25)
    wet = smooth(0.62, 0.85, fbm(s + 20, (3, 6, 12), 0.6))
    save('Mud', mix(rgb, (128, 116, 104), wet * 0.35))


@tex('Grass')
def _():
    save('Grass', blades('Grass', **GRASS))


@tex('Grass_Side')
def _():
    save('Grass_Side', side_of('Grass_Side', blades('Grass', **GRASS), dirt_rgb()))


@tex('Dry_Grass')
def _():
    save('Dry_Grass', dry_grass_rgb())


def dry_grass_rgb():
    return blades('Dry_Grass', (150, 142, 78), (98, 88, 48), (184, 172, 100), (208, 196, 128), dry=0.5)


@tex('Dry_Grass_Side')
def _():
    save('Dry_Grass_Side', side_of('Dry_Grass_Side', dry_grass_rgb(), dirt_rgb(), depth=6))


def moss_rgb():
    s = _seed('Moss')
    d1, d2, _ = worley(48, s)
    cushion = smooth(3.2, 0.2, d1)
    body = fbm(s + 1, (8, 16, 32), 0.7)
    t = np.clip(0.25 + cushion * 0.5 + (body - 0.5) * 0.35, 0, 1)
    return shade(ramp(t, [(0, (38, 68, 30)), (0.5, (76, 118, 44)), (1, (126, 160, 66))]), grain(s + 5, 0.04))


@tex('Moss')
def _():
    save('Moss', moss_rgb())


def podzol_rgb():
    s = _seed('Podzol_Top')
    r = np.random.default_rng(s)
    rgb = soil('Podzol_Top', (96, 70, 44), (60, 43, 28), (124, 94, 60), clods=0.5)
    # Fallen needles and bits of bark.
    canvas = np.zeros((N, N))
    for _ in range(70):
        x, y, ang, ln = r.random() * N, r.random() * N, r.random() * np.pi, 2 + r.random() * 3
        for k in range(int(ln * 2)):
            f = k / (ln * 2)
            canvas[int(y + np.sin(ang) * ln * f) % N, int(x + np.cos(ang) * ln * f) % N] = 0.5 + r.random() * 0.5
    return mix(rgb, ramp(canvas, [(0, (120, 78, 40)), (1, (176, 124, 66))]), (canvas > 0) * 0.8)


@tex('Podzol_Top')
def _():
    save('Podzol_Top', podzol_rgb())


@tex('Podzol_Side')
def _():
    save('Podzol_Side', side_of('Podzol_Side', podzol_rgb(), dirt_rgb(), depth=5, ragged=2))


def mycelium_rgb():
    s = _seed('Mycelium_Top')
    body = fbm(s, (4, 8, 16, 32), 0.7)
    rgb = ramp(body, [(0, (92, 82, 98)), (0.5, (128, 116, 132)), (1, (160, 150, 160))])
    thread = fbm(s + 3, (5, 10, 20), 0.6)
    web = 1 - smooth(0.0, 0.05, np.abs(thread - 0.5))
    rgb = mix(rgb, (206, 200, 206), web * 0.6)
    return shade(rgb, grain(s + 5, 0.04))


@tex('Mycelium_Top')
def _():
    save('Mycelium_Top', mycelium_rgb())


@tex('Mycelium_Side')
def _():
    save('Mycelium_Side', side_of('Mycelium_Side', mycelium_rgb(), dirt_rgb(), depth=5, ragged=2))


@tex('Sand')
def _():
    save('Sand', sand('Sand', (218, 200, 152), (190, 170, 122), (236, 222, 180)))


@tex('Red_Sand')
def _():
    save('Red_Sand', sand('Red_Sand', (190, 108, 60), (156, 84, 44), (214, 134, 82)))


@tex('gravel')
def _():
    s = _seed('gravel')
    d1, d2, pid = worley(56, s, 1.0)
    r = np.random.default_rng(s + 1)
    tone = r.random(128)[pid % 128]
    hue = r.random(128)[pid % 128]
    lit = smooth(0.2, 2.6, d2 - d1)                    # dark in the gaps between pebbles
    dome = smooth(3.5, 0, d1)
    grey = ramp(tone, [(0, (96, 96, 98)), (0.5, (134, 132, 128)), (1, (170, 166, 158))])
    warm = ramp(tone, [(0, (112, 96, 82)), (1, (164, 146, 124))])
    rgb = mix(grey, warm, (hue > 0.7) * 1.0)
    rgb = shade(rgb, (lit - 1) * 0.3 + (dome - 0.5) * 0.16)
    save('gravel', shade(rgb, grain(s + 5, 0.04)))


@tex('Stone')
def _():
    save('Stone', stone_rgb())


@tex('Andesite')
def _():
    save('Andesite', stone('Andesite', (136, 138, 136), (104, 106, 106), (166, 168, 164), vein=0.25,
                           speck=0.05, speck_colour=(196, 196, 190), cells=(6, 12, 24)))


@tex('Diorite')
def _():
    rgb = stone('Diorite', (200, 200, 198), (164, 164, 166), (228, 228, 224), vein=0.15, speck=0.10,
                speck_colour=(74, 74, 78), cells=(8, 16, 32), contrast=0.8)
    save('Diorite', rgb)


@tex('Granite')
def _():
    s = _seed('Granite')
    rgb = stone('Granite', (160, 116, 100), (124, 86, 74), (192, 150, 132), vein=0.15, speck=0.08,
                speck_colour=(74, 58, 56), cells=(8, 16, 32), contrast=0.9)
    r = np.random.default_rng(s + 50).random((N, N))
    save('Granite', mix(rgb, (220, 198, 186), (r > 0.93) * 0.8))


@tex('Slate')
def _():
    s = _seed('Slate')
    rgb = strata('Slate', (74, 78, 88), (50, 53, 62), (100, 104, 114), bands=11, grainy=0.8)
    save('Slate', shade(rgb, (fbm(s + 9, (3, 6)) - 0.5) * 0.12))


@tex('Limestone')
def _():
    s = _seed('Limestone')
    rgb = stone('Limestone', (206, 196, 170), (172, 162, 138), (228, 220, 198), vein=0.35, cells=(4, 8, 16))
    pit = np.random.default_rng(s + 60).random((N, N))
    save('Limestone', shade(rgb, (pit < 0.03) * -0.2))


@tex('Bedrock')
def _():
    save('Bedrock', stone('Bedrock', (58, 58, 62), (24, 24, 28), (98, 98, 102), vein=1.0, cells=(4, 8, 16),
                          contrast=1.5))


@tex('Sandstone')
def _():
    save('Sandstone', strata('Sandstone', (212, 190, 138), (182, 160, 110), (232, 214, 168), bands=8))


@tex('Red_Sandstone')
def _():
    save('Red_Sandstone', strata('Red_Sandstone', (184, 98, 54), (150, 74, 40), (208, 126, 78), bands=8))


@tex('Clay')
def _():
    s = _seed('Clay')
    body = fbm(s, (3, 6, 12, 24), 0.55)
    rgb = ramp(body, [(0, (136, 144, 156)), (0.5, (160, 166, 176)), (1, (182, 186, 194))])
    crack = 1 - smooth(0.0, 0.03, np.abs(fbm(s + 3, (3, 6), 0.5) - 0.5))
    save('Clay', shade(shade(rgb, -0.12 * crack), grain(s + 5, 0.02)))


for _name, _c in [('Terracotta', (150, 92, 68)), ('White_Terracotta', (208, 178, 160)),
                  ('Orange_Terracotta', (164, 86, 40)), ('Yellow_Terracotta', (186, 134, 38)),
                  ('Brown_Terracotta', (80, 54, 38)), ('Red_Terracotta', (142, 60, 46))]:
    T[_name] = (lambda n, c: lambda: save(n, baked(n, c)))(_name, _c)


def snow_rgb(name='snow'):
    s = _seed(name)
    body = fbm(s, (3, 6, 12), 0.55)
    rgb = ramp(body, [(0, (214, 224, 238)), (0.55, (238, 243, 250)), (1, (252, 253, 255))])
    sparkle = np.random.default_rng(s + 3).random((N, N))
    rgb = mix(rgb, (255, 255, 255), (sparkle > 0.965) * 0.9)
    return shade(rgb, grain(s + 5, 0.012))


@tex('snow')
def _():
    save('snow', snow_rgb())


@tex('SnowDirt')
def _():
    # The top of snowy ground: snow, with last year's grass showing through here and there.
    s = _seed('SnowDirt')
    rgb = snow_rgb('SnowDirt')
    tuft = smooth(0.78, 0.92, fbm(s + 9, (8, 16, 32), 0.7))
    save('SnowDirt', mix(rgb, (168, 176, 140), tuft * 0.4))


@tex('SnowDirt_Side')
def _():
    save('SnowDirt_Side', side_of('SnowDirt_Side', snow_rgb('SnowDirt'), dirt_rgb(), depth=8, ragged=2))


def ice_rgb(name, base, dark, light, cracks=1.0):
    s = _seed(name)
    body = fbm(s, (2, 4, 8), 0.5)
    rgb = ramp(body, [(0, dark), (0.5, base), (1, light)])
    c1 = 1 - smooth(0.0, 0.022, np.abs(fbm(s + 3, (2, 4, 8), 0.5) - 0.5))
    c2 = 1 - smooth(0.0, 0.016, np.abs(fbm(s + 4, (3, 6), 0.5) - 0.5))
    rgb = mix(rgb, (240, 250, 255), np.maximum(c1, c2 * 0.5) * 0.55 * cracks)
    bub = np.random.default_rng(s + 6).random((N, N))
    return mix(rgb, (236, 246, 252), (bub > 0.985) * 0.7)


@tex('Ice')
def _():
    save('Ice', ice_rgb('Ice', (150, 196, 226), (112, 164, 206), (190, 224, 242)))


@tex('Packed_Ice')
def _():
    save('Packed_Ice', ice_rgb('Packed_Ice', (176, 206, 232), (146, 180, 214), (212, 232, 246), cracks=0.6))


@tex('Water')
def _():
    # Soft swells, and light along the lines where two of them meet.
    s = _seed('Water')
    body = fbm(s + 1, (2, 4, 8), 0.5)
    rgb = ramp(body, [(0, (38, 100, 150)), (0.5, (50, 120, 166)), (1, (68, 142, 180))])
    a = 1 - smooth(0.0, 0.09, np.abs(fbm(s + 2, (3, 6, 12), 0.55) - 0.5))
    b = 1 - smooth(0.0, 0.07, np.abs(fbm(s + 3, (4, 8), 0.5) - 0.5))
    save('Water', mix(rgb, (140, 196, 216), blur(np.maximum(a, b * 0.7), 1) * 0.32))


@tex('Log_Side')
def _():
    save('Log_Side', bark('Log_Side', **OAK_BARK))


@tex('Log_Top')
def _():
    save('Log_Top', rings('Log_Top', (186, 150, 100), (150, 114, 72), bark('Log_Side', **OAK_BARK)))


@tex('Spruce_Log')
def _():
    save('Spruce_Log', bark('Spruce_Log', **SPRUCE_BARK, ridges=11))


@tex('Spruce_Log_Top')
def _():
    save('Spruce_Log_Top', rings('Spruce_Log_Top', (168, 128, 84), (128, 92, 58),
                                 bark('Spruce_Log', **SPRUCE_BARK, ridges=11), count=7))


def birch_bark():
    s = _seed('Birch_Log')
    body = fbm(s, (4, 8, 16), 0.6, sx=0.5, sy=1.5)
    rgb = ramp(body, [(0, (204, 202, 192)), (0.5, (228, 226, 216)), (1, (244, 243, 236))])
    # Dark lenticels: short horizontal dashes, and the odd scar.
    r = np.random.default_rng(s + 1)
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    mark = np.zeros((N, N))
    for _ in range(15):
        x, y = r.random() * N, r.random() * N
        a, b = 1.5 + r.random() * 4.5, 0.5 + r.random() * 0.7
        dx = (xx - x + N / 2) % N - N / 2
        dy = (yy - y + N / 2) % N - N / 2
        mark = np.maximum(mark, 1 - ((dx / a) ** 2 + (dy / b) ** 2))
    rgb = mix(rgb, (52, 48, 46), smooth(0.0, 0.5, mark) * 0.9)
    return shade(rgb, grain(s + 5, 0.025))


@tex('Birch_Log')
def _():
    save('Birch_Log', birch_bark())


@tex('Birch_Log_Top')
def _():
    save('Birch_Log_Top', rings('Birch_Log_Top', (222, 200, 154), (190, 164, 118), birch_bark(), count=6))


@tex('leaves')
def _():
    save('leaves', foliage('leaves', (62, 112, 44), (22, 48, 22), (112, 158, 64)))


@tex('Birch_Leaves')
def _():
    save('Birch_Leaves', foliage('Birch_Leaves', (104, 146, 58), (40, 70, 30), (158, 188, 84), leaf=2.4, count=80))


@tex('Spruce_Leaves')
def _():
    save('Spruce_Leaves', foliage('Spruce_Leaves', (40, 82, 58), (14, 32, 26), (72, 118, 82), needles=True))


@tex('Jungle_Leaves')
def _():
    save('Jungle_Leaves', foliage('Jungle_Leaves', (42, 118, 40), (12, 44, 18), (92, 172, 60), leaf=4.6, count=40))


@tex('Acacia_Leaves')
def _():
    save('Acacia_Leaves', foliage('Acacia_Leaves', (108, 128, 52), (48, 62, 26), (156, 172, 78), leaf=2.0, count=100))


@tex('Cactus_Side')
def _():
    s = _seed('Cactus_Side')
    xx = np.mgrid[0:N, 0:N][1]
    rib = 0.5 + 0.5 * np.cos(xx / N * 2 * np.pi * 4)
    body = fbm(s, (8, 16, 32), 0.7, sx=1.0, sy=0.4)
    t = np.clip(0.25 + rib * 0.5 + (body - 0.5) * 0.25, 0, 1)
    rgb = ramp(t, [(0, (36, 78, 38)), (0.5, (72, 124, 56)), (1, (116, 162, 78))])
    # Spines along the crest of each rib.
    r = np.random.default_rng(s + 1)
    for k in range(4):
        x = k * 8
        for y in range(int(r.integers(0, 4)), N, 5):
            for dx, dy in ((0, 0), (-1, -1), (1, -1)):
                rgb[(y + dy) % N, (x + dx) % N] = (226, 220, 184)
    save('Cactus_Side', shade(rgb, grain(s + 5, 0.03)))


@tex('Cactus_Top')
def _():
    s = _seed('Cactus_Top')
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    ang = np.arctan2(yy - N / 2, xx - N / 2)
    d = np.hypot(xx - N / 2, yy - N / 2) / (N / 2)
    rib = 0.5 + 0.5 * np.cos(ang * 8)
    t = np.clip(0.3 + rib * 0.3 * smooth(0.1, 0.7, d) + (1 - d) * 0.25 + (fbm(s, (8, 16)) - 0.5) * 0.15, 0, 1)
    save('Cactus_Top', ramp(t, [(0, (40, 84, 40)), (0.5, (78, 130, 58)), (1, (134, 176, 88))]))


@tex('Mushroom_Stem')
def _():
    s = _seed('Mushroom_Stem')
    body = fbm(s, (6, 12, 24), 0.6, sx=1.0, sy=0.2)
    save('Mushroom_Stem', shade(ramp(body, [(0, (196, 186, 164)), (0.5, (222, 214, 196)), (1, (240, 234, 220))]),
                                grain(s + 5, 0.02)))


@tex('Red_Mushroom_Block')
def _():
    s = _seed('Red_Mushroom_Block')
    body = fbm(s, (3, 6, 12), 0.6)
    rgb = ramp(body, [(0, (140, 30, 26)), (0.5, (176, 44, 34)), (1, (204, 68, 50))])
    d1, _, pid = worley(7, s + 1, 1.0)
    size = 1.6 + np.random.default_rng(s + 2).random(32)[pid % 32] * 2.4
    wart = smooth(size, size - 1.4, d1)
    save('Red_Mushroom_Block', shade(mix(rgb, (236, 226, 204), wart * 0.92), grain(s + 5, 0.025)))


@tex('Brown_Mushroom_Block')
def _():
    s = _seed('Brown_Mushroom_Block')
    body = fbm(s, (3, 6, 12, 24), 0.55)
    rgb = ramp(body, [(0, (112, 82, 58)), (0.5, (146, 110, 80)), (1, (176, 140, 104))])
    save('Brown_Mushroom_Block', shade(rgb, grain(s + 5, 0.03)))


@tex('Coal_Ore')
def _():
    save('Coal_Ore', ore('Coal_Ore', stone_rgb(), (38, 38, 42), (16, 16, 20), (74, 74, 82), count=6, size=2.1))


@tex('Iron_Ore')
def _():
    save('Iron_Ore', ore('Iron_Ore', stone_rgb(), (168, 116, 84), (116, 72, 52), (212, 168, 134), count=6, size=2.0))


@tex('Gold_Ore')
def _():
    save('Gold_Ore', ore('Gold_Ore', stone_rgb(), (224, 176, 52), (160, 112, 24), (255, 232, 132), count=4,
                         size=2.2, metallic=True))


# ── Blocks people build with ─────────────────────────────────────────────────

PLANK = dict(base=(172, 132, 84), dark=(128, 94, 58), light=(204, 166, 114))


@tex('Wooden_Planks')
def _():
    save('Wooden_Planks', boards('Wooden_Planks', **PLANK))


@tex('Stone_Bricks')
def _():
    save('Stone_Bricks', brickwork('Stone_Bricks', (130, 130, 128), (104, 105, 106), (156, 156, 152),
                                   (84, 84, 84), rows=2, per_row=1, varied=0.25))


@tex('Bricks')
def _():
    save('Bricks', brickwork('Bricks', (156, 78, 60), (118, 56, 44), (188, 108, 84), (176, 168, 152),
                             rows=4, per_row=2, varied=0.5))


@tex('Mossy_Stone')
def _():
    s = _seed('Mossy_Stone')
    patch = smooth(0.5, 0.66, fbm(s + 4, (4, 8, 16), 0.6))
    save('Mossy_Stone', mix(stone('Mossy_Stone', **STONE, vein=0.9), moss_rgb(), patch * 0.92))


@tex('Polished_Granite')
def _():
    s = _seed('Polished_Granite')
    rgb = stone('Polished_Granite', (170, 124, 108), (140, 100, 88), (196, 154, 138), vein=0.0, speck=0.06,
                speck_colour=(88, 68, 64), cells=(8, 16, 32), contrast=0.6)
    save('Polished_Granite', _slab(rgb))


@tex('Polished_Diorite')
def _():
    rgb = stone('Polished_Diorite', (208, 208, 206), (182, 182, 184), (230, 230, 228), vein=0.0, speck=0.07,
                speck_colour=(96, 96, 100), cells=(8, 16, 32), contrast=0.6)
    save('Polished_Diorite', _slab(rgb))


def _slab(rgb):
    """A cut and polished face: a soft sheen across it and a fine joint round the edge."""
    yy, xx = np.mgrid[0:N, 0:N]
    sheen = 0.5 + 0.5 * np.cos((xx - yy) / N * 2 * np.pi)
    rgb = shade(rgb, (sheen - 0.5) * 0.08)
    edge = (xx == N - 1) | (yy == N - 1)
    return shade(rgb, -0.2 * edge + 0.06 * (((xx == 0) | (yy == 0)) & ~edge))


@tex('Gold_Block')
def _():
    save('Gold_Block', metal('Gold_Block', (232, 184, 60), (176, 124, 28), (255, 236, 140)))


@tex('Iron_Block')
def _():
    save('Iron_Block', metal('Iron_Block', (188, 190, 194), (140, 144, 150), (228, 230, 232)))


@tex('Coal_Block')
def _():
    s = _seed('Coal_Block')
    d1, d2, pid = worley(12, s, 1.0)
    facet = np.random.default_rng(s + 1).random(64)[pid % 64]
    t = np.clip(facet * 0.7 + smooth(0, 2.5, d2 - d1) * 0.2 + fbm(s + 2, (16, 32)) * 0.15, 0, 1)
    save('Coal_Block', ramp(t, [(0, (14, 14, 18)), (0.6, (38, 38, 44)), (1, (84, 84, 94))]))


@tex('Wool_Block')
def _():
    s = _seed('Wool_Block')
    yy, xx = np.mgrid[0:N, 0:N]
    weave = 0.5 + 0.25 * np.cos(xx * np.pi) * np.cos(yy * np.pi / 2) + 0.25 * np.cos((xx + yy) * np.pi / 2)
    fuzz = fbm(s, (8, 16, 32), 0.7)
    t = np.clip(0.55 + (weave - 0.5) * 0.3 + (fuzz - 0.5) * 0.4, 0, 1)
    save('Wool_Block', ramp(t, [(0, (196, 192, 184)), (0.5, (226, 223, 216)), (1, (246, 244, 240))]))


@tex('Glass')
def _():
    # A pane: clear, with a thin frame and a couple of glints. The clear part is
    # not drawn at all (the block is a cutout), so what is behind it — water,
    # more glass — is simply seen.
    yy, xx = np.mgrid[0:N, 0:N]
    frame = (xx == 0) | (yy == 0) | (xx == N - 1) | (yy == N - 1)
    glint = (((xx + yy) == 13) & (xx > 3) & (xx < 10)) | (((xx + yy) == 17) & (xx > 4) & (xx < 9)) | \
            (((xx + yy) == 44) & (xx > 19) & (xx < 25))
    rgb = flat((206, 228, 236))
    rgb = np.where(glint[..., None], (244, 250, 252), rgb)
    save('Glass', rgb, (frame | glint) * 255)


@tex('Lamp')
def _():
    s = _seed('Lamp')
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    d = np.maximum(np.abs(xx - N / 2), np.abs(yy - N / 2)) / (N / 2)
    glow = 1 - smooth(0.2, 0.95, d)
    rgb = ramp(glow, [(0, (196, 128, 44)), (0.5, (248, 202, 104)), (1, (255, 244, 204))])
    cross = (np.abs(xx - N / 2) < 1) | (np.abs(yy - N / 2) < 1)
    rgb = shade(rgb, -0.25 * cross)
    frame = d > 0.875
    rgb = np.where(frame[..., None], shade(flat((84, 62, 40)), (fbm(s, (8, 16)) - 0.5) * 0.3), rgb)
    save('Lamp', rgb)


# ── Workstations ─────────────────────────────────────────────────────────────

def _rect(rgb, x0, y0, x1, y1, colour, k=1.0):
    rgb[y0:y1, x0:x1] = mix(rgb[y0:y1, x0:x1], colour, k)


def _frame(rgb, x0, y0, x1, y1, colour):
    _rect(rgb, x0, y0, x1, y0 + 1, colour)
    _rect(rgb, x0, y1 - 1, x1, y1, colour)
    _rect(rgb, x0, y0, x0 + 1, y1, colour)
    _rect(rgb, x1 - 1, y0, x1, y1, colour)


def _furnace_stone(name, tint=1.0):
    return brickwork(name, (118 * tint, 116 * tint, 114 * tint), (90 * tint, 90 * tint, 92 * tint),
                     (146 * tint, 144 * tint, 140 * tint), (66 * tint, 66 * tint, 68 * tint), rows=4, per_row=2,
                     varied=0.3)


def _fire(rgb, x0, y0, x1, y1, seed):
    """An opening with embers in it."""
    _rect(rgb, x0 - 1, y0 - 1, x1 + 1, y1 + 1, (40, 38, 38))
    _rect(rgb, x0, y0, x1, y1, (24, 16, 14))
    r = np.random.default_rng(seed)
    w = x1 - x0
    for i in range(w):
        h = int(2 + r.random() * (y1 - y0 - 3))
        for j in range(h):
            f = j / max(h - 1, 1)
            rgb[y1 - 1 - j, x0 + i] = mix(np.array((255, 226, 120.0)), (214, 78, 24), f)


@tex('Oven_Side')
def _():
    save('Oven_Side', _furnace_stone('Oven_Side'))


@tex('Oven_Top')
def _():
    rgb = _furnace_stone('Oven_Top')
    _rect(rgb, 10, 10, 22, 22, (52, 50, 50))
    _frame(rgb, 10, 10, 22, 22, (34, 33, 33))
    for x in range(12, 21, 3):
        _rect(rgb, x, 12, x + 1, 20, (22, 20, 20))
    save('Oven_Top', rgb)


@tex('Oven_Front')
def _():
    rgb = _furnace_stone('Oven_Side')
    _fire(rgb, 8, 16, 24, 27, _seed('Oven_Front'))
    _rect(rgb, 7, 6, 25, 11, (60, 58, 58))            # the oven door above the fire
    _frame(rgb, 7, 6, 25, 11, (36, 35, 35))
    _rect(rgb, 14, 8, 18, 9, (150, 146, 138))
    save('Oven_Front', rgb)


@tex('Smelter_Side')
def _():
    save('Smelter_Side', _furnace_stone('Smelter_Side', 0.72))


@tex('Smelter_Top')
def _():
    rgb = _furnace_stone('Smelter_Top', 0.72)
    yy, xx = np.mgrid[0:N, 0:N] + 0.5
    d = np.hypot(xx - N / 2, yy - N / 2)
    rgb = np.where((d < 8.5)[..., None], (30, 28, 28), rgb)
    melt = d < 6.5
    heat = ramp(1 - d / 6.5, [(0, (190, 60, 20)), (0.6, (248, 150, 40)), (1, (255, 226, 130))])
    save('Smelter_Top', np.where(melt[..., None], heat, rgb))


@tex('Smelter_Front')
def _():
    rgb = _furnace_stone('Smelter_Side', 0.72)
    _fire(rgb, 9, 14, 23, 26, _seed('Smelter_Front'))
    for x in range(10, 23, 3):                         # a grate across the mouth
        _rect(rgb, x, 14, x + 1, 26, (22, 22, 24))
    _rect(rgb, 12, 4, 20, 8, (34, 32, 32))             # the pouring spout
    _rect(rgb, 14, 8, 18, 10, (236, 150, 48))
    save('Smelter_Front', rgb)


@tex('Crafting_Table_Top')
def _():
    rgb = boards('Crafting_Table_Top', (182, 142, 92), (140, 104, 64), (212, 176, 122), rows=4)
    _frame(rgb, 0, 0, N, N, (98, 70, 44))
    _frame(rgb, 1, 1, N - 1, N - 1, (124, 92, 58))
    # A scored grid for laying work out on.
    for k in (11, 21):
        _rect(rgb, k, 3, k + 1, N - 3, (112, 82, 50), 0.6)
        _rect(rgb, 3, k, N - 3, k + 1, (112, 82, 50), 0.6)
    save('Crafting_Table_Top', rgb)


@tex('Crafting_Table_Side')
def _():
    rgb = boards('Crafting_Table_Side', **PLANK, rows=4, vertical=True, joints=False)
    _rect(rgb, 0, 0, N, 5, (120, 88, 54))             # the top's edge
    _rect(rgb, 0, 5, N, 6, (82, 58, 36))
    _rect(rgb, 0, 0, 3, N, (104, 76, 48), 0.8)        # legs
    _rect(rgb, N - 3, 0, N, N, (104, 76, 48), 0.8)
    # Tools hung on the side: a saw and a hammer.
    _rect(rgb, 7, 11, 17, 15, (176, 180, 186))
    for x in range(7, 17, 2):
        _rect(rgb, x, 15, x + 1, 16, (176, 180, 186))
    _rect(rgb, 17, 11, 20, 14, (88, 60, 38))
    _rect(rgb, 22, 10, 27, 13, (120, 122, 128))
    _rect(rgb, 24, 13, 25, 24, (96, 68, 42))
    save('Crafting_Table_Side', rgb)


def _chest(name, front=False, top=False):
    rgb = boards(name, (150, 108, 62), (108, 76, 44), (184, 140, 88), rows=4, joints=False)
    band = (70, 66, 62)
    if top:
        _frame(rgb, 0, 0, N, N, band)
        _rect(rgb, 14, 0, 18, N, band)
    else:
        _rect(rgb, 0, 0, N, 2, band)
        _rect(rgb, 0, N - 2, N, N, band)
        _rect(rgb, 0, 0, 2, N, band)
        _rect(rgb, N - 2, 0, N, N, band)
        _rect(rgb, 0, 10, N, 12, (58, 42, 26))        # where the lid closes
        if front:
            _rect(rgb, 13, 8, 19, 16, (196, 164, 72))
            _frame(rgb, 13, 8, 19, 16, (120, 96, 36))
            _rect(rgb, 15, 11, 17, 14, (60, 46, 20))
    return rgb


@tex('Chest_Side')
def _():
    save('Chest_Side', _chest('Chest_Side'))


@tex('Chest_Front')
def _():
    save('Chest_Front', _chest('Chest_Side', front=True))


@tex('Chest_Top')
def _():
    save('Chest_Top', _chest('Chest_Top', top=True))


@tex('Anvil')
def _():
    s = _seed('Anvil')
    rgb = metal('Anvil', (74, 76, 82), (44, 45, 50), (112, 114, 122), plates=0)
    scuff = np.random.default_rng(s + 1).random((N, N))
    rgb = mix(rgb, (150, 152, 160), (scuff > 0.975) * 0.6)
    save('Anvil', rgb)


# ── Run ──────────────────────────────────────────────────────────────────────

def main(argv):
    names = argv or sorted(T)
    for n in names:
        if n not in T:
            print('no such texture:', n)
            continue
        T[n]()
    print(f'wrote {len(names)} textures to', os.path.normpath(OUT))


if __name__ == '__main__':
    main(sys.argv[1:])
