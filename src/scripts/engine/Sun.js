/**
 * Sun — the world's one light source, shared by the meshers (workers), the
 * shadow mapper and the chunk shaders, so every part of the lighting agrees on
 * where the sun is.
 *
 * Two things light a surface:
 *
 *   • Sky light (Skylight.js): how much of the sky can reach the air in front of
 *     the surface — 15 under open sky, one less per block of travel, 0 deep in a
 *     cave. It scales everything.
 *   • The sun: a surface facing the sun gets direct light on top of the ambient
 *     sky glow; one facing away (or in shadow) gets the ambient part only.
 *
 * No Three.js and no DOM here — the workers import this.
 */

// Direction toward the sun (unit length). Fixed: there is no day cycle yet.
const _l = Math.hypot(0.35, 1.0, 0.5);
export const SUN_DIR = [0.35 / _l, 1.0 / _l, 0.5 / _l];

// Share of a sunlit surface's light that comes from the sky rather than the sun.
// It is also the brightness of a surface facing away from the sun, relative to
// one facing it — so it sets how strong directional shading and shadows look.
export const SUN_AMBIENT = 0.5;

// Scale so that a flat, sunlit top face is exactly 1.
const TOP = SUN_AMBIENT + (1 - SUN_AMBIENT) * SUN_DIR[1];

/** Brightness of a surface with unit normal (nx, ny, nz) under open sky. */
export function sunBrightness(nx, ny, nz) {
    const d = nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2];
    return (SUN_AMBIENT + (1 - SUN_AMBIENT) * (d > 0 ? d : 0)) / TOP;
}

// Sky light: levels 0..15, and how a level turns into brightness. Each level
// below full is SKY_FALLOFF times as bright as the one above, so light fades
// quickly into a cave mouth and level 0 is nearly black.
export const SKY_MAX     = 15;
export const SKY_FALLOFF = 0.8;
export const SKY_MIN     = 0.05;   // brightness at level 0: very dark, shapes just readable
