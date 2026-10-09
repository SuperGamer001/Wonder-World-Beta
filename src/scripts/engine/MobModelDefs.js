/**
 * MobModelDefs — the mob models: their bones and the shapes on them.
 *
 * Pure data (no Three.js, no DOM), built with engine/MobShapes.js, which
 * explains parts, lofts, boxes and texels. How they move is MobAnim.js; how
 * they are drawn MobModels.js; their textures are painted from these same
 * definitions by tools/gen_mob_textures.mjs — **changing a shape moves its
 * texels: repaint (`npm run mobtex`)**.
 *
 * Everything is in pixels, 16 to a block. The animals are to scale — a block
 * is a metre, a cow stands 1.35 m at the shoulder — and a Quiddle is as tall
 * as a person (1.8 m) but drawn as a character, with a head a quarter of that.
 * +Y is up, +Z the way the mob faces, +X its left; feet stand on y = 0.
 *
 * The models are anatomy, not solids: a body is one skin with a topline, a
 * chest and a flank; a leg is one skin from inside the shoulder to the hoof
 * that bends at the knee and the fetlock; a neck runs out of the chest and
 * into the skull. Where a comment names a joint (stifle, hock, fetlock) it is
 * the real one, and the bone that turns there is named for it.
 */

import { Builder } from './MobShapes.js';

/** The underside of a head, from the mouth down, goes with the jaw. */
const JAW = (u, v) => v < -0.3 ? ['head', 'jaw', Math.min(1, (-v - 0.3) / 0.45)] : 'head';

/** Stations in a straight row: from `o` along the unit vector `d`, each [distance, across, up, …]. */
const row = (o, d, list) => list.map(([s, ...rest]) => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s, ...rest]);
/** Stations for one side of the body: x times `sx` (1 the left, −1 the right). */
const sided = (sx, list) => list.map(([x, ...rest]) => [x * sx, ...rest]);
const SIDES = [['L', 1], ['R', -1]];
// A loft's sections follow the turns of its path unless it is told to cut
// them all one way. Bodies are cut in upright slices and legs in level ones:
// a station is then exactly the outline at that place, however the middle
// line wanders, and a tight bend cannot fold the skin over on itself.
const FWD = [0, 0, 1], DOWN = [0, -1, 0];

function cow() {
    const b = new Builder('cow', { variants: { coat: 3 }, layers: v => [`cow_${v.coat + 1}`] });

    // The trunk, rump to brisket: [x, y, z, half width, above the middle, below it].
    // A level back with the withers and the hip bones standing a little proud of
    // it, slab sides, the belly deepest behind the ribs and tucked up at the flank.
    b.part('body', 'root', [0, 15, -1]).loft([
        [0, 17.6, -11.9, 1.5, 2.3, 2.6],
        [0, 17.0, -11.0, 3.3, 3.8, 4.6],
        [0, 16.5,  -8.2, 4.7, 5.1, 5.2, { sq: 2.8 }],
        [0, 16.0,  -4.0, 5.0, 5.4, 5.7],
        [0, 15.5,   0.0, 5.3, 5.8, 5.9],
        [0, 15.8,   4.0, 4.9, 5.7, 5.7],
        [0, 16.0,   7.0, 4.4, 5.8, 5.4, { sq: 2.8 }],
        [0, 15.6,   9.2, 3.4, 4.9, 4.3],
        [0, 15.2,  10.4, 2.0, 3.0, 2.8],
    ], { along: FWD, sq: 2.5, caps: [0.7, 0.6], step: 2.6 });
    b.loft([
        [0, 10.7, -7.8, 1.1, 0.9, 0.9],
        [0, 10.1, -6.6, 2.0, 1.4, 1.8],
        [0, 10.0, -4.9, 2.0, 1.4, 1.9],
        [0, 10.5, -3.5, 1.1, 0.8, 1.0],
    ], { along: FWD, caps: [0.4, 0.4], seg: 8, tag: 'udder' });

    // The neck: out of the chest and into the skull, crest above, dewlap below.
    b.part('neck', 'body', [0, 15.6, 8.8]).loft([
        [0, 15.6,  6.4, 3.6, 5.3, 4.5, { bone: 'body' }],
        [0, 16.4,  9.6, 3.0, 4.4, 4.7, { bone: ['body', 'neck', 0.5] }],
        [0, 18.0, 12.0, 2.3, 3.1, 3.5],
        [0, 19.4, 13.9, 2.0, 2.4, 2.7, { bone: ['neck', 'head', 0.5] }],
        [0, 20.2, 15.0, 1.9, 1.8, 2.2, { bone: 'head' }],
    ], { sq: 2.3, seg: 12 });

    // The head, poll to muzzle, carried nose down: long and narrow, widest and
    // deepest at the eyes and the angle of the jaw, with a broad square muzzle.
    // The underside from the cheek forward goes with the jaw, which chews.
    const AXIS = [0, -0.70, 0.714];
    b.part('head', 'neck', [0, 20.3, 13.9]).loft(row([0, 20.4, 13.6], AXIS, [
        [-0.4, 1.3, 1.2, 1.3],
        [0.5, 2.15, 1.75, 2.2, { sq: 2.7 }],
        [2.3, 2.4, 1.8, 3.1, { sq: 2.7 }],
        [4.3, 1.9, 1.5, 2.5, { bone: JAW }],
        [6.1, 1.7, 1.35, 1.95, { bone: JAW }],
        [7.5, 1.9, 1.35, 1.7, { sq: 3.2, bone: JAW }],
        [8.2, 1.65, 1.1, 1.4, { sq: 3.2, bone: JAW }],
    ]), { sq: 2.4, caps: [0.4, 0.3], seg: 12, step: 1.9, density: 4 });
    b.part('jaw', 'head', [0, 18.2, 14.6]);
    b.mark('poll', [0, 20.4, 13.6]).mark('nose', [0, 14.66, 19.45]).mark('eye', [2.29, 19.36, 15.8]);
    for (const [s, sx] of SIDES) {
        b.on('head').loft(sided(sx, [
            [1.3, 21.0, 13.5, 0.75, 0.75],
            [2.8, 21.7, 13.4, 0.62, 0.62],
            [3.6, 22.9, 13.8, 0.42, 0.42],
            [3.5, 24.0, 14.5, 0.14, 0.14],
        ]), { side: [0, 0, 1], seg: 6, caps: [false, 0.1], tag: 'horn' });
        // An ear: a leaf, set out sideways below the horn, its hollow to the front.
        b.part(`ear${s}`, 'head', [1.9 * sx, 20.2, 13.7]).loft(sided(sx, [
            [1.7, 20.2, 13.7, 0.45, 0.3],
            [3.2, 20.3, 13.6, 0.95, 0.3],
            [4.4, 20.0, 13.5, 0.8, 0.22],
            [5.2, 19.7, 13.45, 0.25, 0.12],
        ]), { side: [0, 1, 0], seg: 6, caps: [false, 0.1], tag: 'ear' });
    }

    for (const [s, sx] of SIDES) {
        // Foreleg: one skin from the shoulder, buried in the body, to the sole.
        // It swings from high on the shoulder and bends at the knee and the fetlock.
        const leg = `legF${s}`, knee = `kneeF${s}`, hoof = `hoofF${s}`;
        b.part(leg, 'body', [3.4 * sx, 17.6, 7.2]);
        b.part(knee, leg, [3.5 * sx, 6.4, 7.25]);
        b.part(hoof, knee, [3.5 * sx, 2.4, 7.2]);
        b.on(leg).loft(sided(sx, [
            [3.1, 17.6, 7.3, 1.3, 3.2, 3.2, { bone: 'body' }],
            [3.25, 14.6, 7.3, 1.45, 2.9, 3.0, { bone: ['body', leg, 0.6] }],
            [3.5, 11.6, 7.1, 1.45, 2.1, 2.5],
            [3.5, 9.0, 7.2, 1.2, 1.5, 1.6],
            [3.5, 7.2, 7.25, 1.0, 1.15, 1.1],
            [3.5, 6.4, 7.3, 1.15, 1.35, 1.1, { bone: [leg, knee, 0.5] }],
            [3.5, 5.6, 7.25, 0.95, 1.0, 1.0, { bone: knee }],
            [3.5, 3.6, 7.2, 0.85, 0.85, 0.95, { bone: knee }],
            [3.5, 2.5, 7.2, 1.05, 1.0, 1.25, { bone: [knee, hoof, 0.5] }],
            [3.5, 1.75, 7.45, 0.95, 0.95, 0.95, { bone: hoof }],
            [3.5, 1.2, 7.6, 1.25, 1.4, 1.15, { bone: hoof }],
            [3.5, 0, 7.75, 1.4, 1.75, 1.25, { bone: hoof }],
        ]), { along: DOWN, sq: 2.3, seg: 8, caps: [false, true], crease: true, tag: 'leg' });

        // Hind leg: thigh from the hip down and forward to the stifle, gaskin
        // back to the hock, cannon down to the fetlock.
        const thigh = `legB${s}`, shin = `shinB${s}`, hock = `hockB${s}`, hind = `hoofB${s}`;
        b.part(thigh, 'body', [3.4 * sx, 17.2, -8.4]);
        b.part(shin, thigh, [3.6 * sx, 11.4, -6.4]);
        b.part(hock, shin, [3.6 * sx, 7.0, -9.6]);
        b.part(hind, hock, [3.6 * sx, 2.4, -8.9]);
        b.on(thigh).loft(sided(sx, [
            [3.1, 18.0, -8.4, 1.3, 3.4, 3.2, { bone: 'body' }],
            [3.3, 15.0, -8.0, 1.55, 3.6, 3.3, { bone: ['body', thigh, 0.6] }],
            [3.5, 12.2, -7.4, 1.55, 2.9, 2.9],
            [3.6, 11.0, -7.6, 1.45, 2.2, 2.4, { bone: [thigh, shin, 0.5] }],
            [3.6, 9.2, -8.5, 1.2, 1.5, 1.6, { bone: shin }],
            [3.6, 7.8, -9.3, 1.0, 1.1, 1.3, { bone: shin }],
            [3.6, 7.0, -9.6, 1.05, 1.1, 1.6, { bone: [shin, hock, 0.5] }],
            [3.6, 6.0, -9.5, 0.9, 0.95, 1.1, { bone: hock }],
            [3.6, 3.7, -9.1, 0.85, 0.85, 0.95, { bone: hock }],
            [3.6, 2.5, -8.9, 1.05, 1.0, 1.25, { bone: [hock, hind, 0.5] }],
            [3.6, 1.75, -8.65, 0.95, 0.95, 0.95, { bone: hind }],
            [3.6, 1.2, -8.5, 1.25, 1.4, 1.15, { bone: hind }],
            [3.6, 0, -8.35, 1.4, 1.75, 1.25, { bone: hind }],
        ]), { along: DOWN, sq: 2.3, seg: 8, caps: [false, true], crease: true, tag: 'leg' });
    }

    // The tail: a rope from the tail head to the hocks, in three lengths, with a switch.
    b.part('tail0', 'body', [0, 20.4, -12.0]);
    b.part('tail1', 'tail0', [0, 15.5, -13.0]);
    b.part('tail2', 'tail1', [0, 10.5, -13.0]);
    b.on('tail0').loft([
        [0, 20.7, -11.0, 0.9, 0.9, { bone: 'body' }],
        [0, 19.9, -12.2, 0.7, 0.7, { bone: ['body', 'tail0', 0.6] }],
        [0, 18.2, -12.8, 0.55, 0.55],
        [0, 15.5, -13.0, 0.45, 0.45, { bone: ['tail0', 'tail1', 0.5] }],
        [0, 12.5, -13.0, 0.4, 0.4, { bone: 'tail1' }],
        [0, 10.5, -13.0, 0.4, 0.4, { bone: ['tail1', 'tail2', 0.5] }],
        [0, 8.8, -13.0, 0.75, 0.8, { bone: 'tail2' }],
        [0, 6.6, -13.0, 0.8, 0.85, { bone: 'tail2' }],
        [0, 5.2, -13.0, 0.3, 0.3, { bone: 'tail2' }],
    ], { seg: 6, caps: [false, 0.2], tag: 'tail' });
    return b.done();
}

function pig() {
    const b = new Builder('pig', { variants: { coat: 3 }, layers: v => [`pig_${v.coat + 1}`] });

    // The trunk: long, deep and round-sided, the back a low arch, heavy at the hams.
    b.part('body', 'root', [0, 8.6, -1]).loft([
        [0, 9.0, -10.3, 1.4, 1.8, 2.2],
        [0, 8.7,  -9.4, 3.0, 3.2, 3.7],
        [0, 8.5,  -6.6, 3.9, 4.2, 4.3],
        [0, 8.6,  -2.0, 4.1, 4.6, 4.6],
        [0, 8.6,   2.5, 4.0, 4.4, 4.5],
        [0, 8.6,   5.6, 3.7, 4.0, 4.1],
        [0, 8.7,   7.6, 3.0, 3.3, 3.4],
        [0, 8.8,   8.6, 1.8, 2.0, 2.1],
    ], { along: FWD, sq: 2.3, caps: [0.6, 0.4], step: 2.4 });

    // Hardly a neck at all: the shoulders run into the jowls.
    b.part('neck', 'body', [0, 8.8, 6.2]).loft([
        [0, 8.7, 4.6, 3.5, 3.8, 3.9, { bone: 'body' }],
        [0, 8.9, 7.0, 3.1, 3.3, 3.6, { bone: ['body', 'neck', 0.5] }],
        [0, 9.2, 8.6, 2.8, 2.8, 3.3, { bone: ['neck', 'head', 0.5] }],
        [0, 9.4, 9.6, 2.5, 2.3, 2.9, { bone: 'head' }],
    ], { sq: 2.3, seg: 12 });

    // The head: a wedge, broad across the cheeks and drawn out into a snout
    // that ends in a flat disc.
    const AXIS = [0, -0.45, 0.893];
    b.part('head', 'neck', [0, 9.8, 8.4]).loft(row([0, 9.9, 8.2], AXIS, [
        [-0.3, 1.6, 1.5, 1.6],
        [0.8, 2.8, 2.3, 2.9],
        [2.4, 2.75, 2.1, 3.0],
        [4.2, 2.0, 1.6, 2.3],
        [5.8, 1.5, 1.25, 1.5, { sq: 2.8 }],
        [7.0, 1.45, 1.25, 1.4, { sq: 2.8 }],
        [7.35, 1.65, 1.4, 1.5, { sq: 2.8 }],
        [7.6, 1.65, 1.4, 1.5, { sq: 2.8 }],
    ]), { sq: 2.3, caps: [false, true], crease: true, seg: 12, step: 1.5, density: 4 });
    for (const [s, sx] of SIDES) {
        // Ears: big triangles, pricked and tipped forward over the eyes.
        b.part(`ear${s}`, 'head', [1.8 * sx, 11.5, 9.0]).loft(sided(sx, [
            [1.6, 11.3, 8.9, 1.0, 0.4],
            [2.2, 12.8, 9.5, 1.4, 0.38],
            [2.5, 13.8, 10.6, 1.0, 0.26],
            [2.6, 14.0, 11.7, 0.2, 0.1],
        ]), { side: [0.98 * sx, 0, -0.2], seg: 6, caps: [false, 0.1], tag: 'ear' });
    }
    b.mark('poll', [0, 9.9, 8.2]).mark('nose', [0, 6.48, 14.99]).mark('eye', [2.6, 9.48, 10.9]);

    for (const [s, sx] of SIDES) {
        const leg = `legF${s}`, knee = `kneeF${s}`, hoof = `hoofF${s}`;
        b.part(leg, 'body', [2.7 * sx, 8.6, 4.8]);
        b.part(knee, leg, [2.8 * sx, 3.3, 4.9]);
        b.part(hoof, knee, [2.8 * sx, 1.25, 4.9]);
        b.on(leg).loft(sided(sx, [
            [2.5, 9.0, 4.9, 1.2, 2.4, 2.4, { bone: 'body' }],
            [2.7, 6.8, 4.9, 1.45, 2.2, 2.3, { bone: ['body', leg, 0.6] }],
            [2.8, 5.0, 4.85, 1.3, 1.6, 1.7],
            [2.8, 3.9, 4.9, 1.05, 1.15, 1.15],
            [2.8, 3.3, 4.95, 1.0, 1.1, 1.0, { bone: [leg, knee, 0.5] }],
            [2.8, 2.3, 4.9, 0.8, 0.8, 0.85, { bone: knee }],
            [2.8, 1.35, 4.9, 0.85, 0.85, 0.95, { bone: [knee, hoof, 0.5] }],
            [2.8, 0.8, 5.05, 0.95, 1.1, 0.9, { bone: hoof }],
            [2.8, 0, 5.15, 1.0, 1.3, 0.9, { bone: hoof }],
        ]), { along: DOWN, sq: 2.3, seg: 8, caps: [false, true], crease: true, tag: 'leg' });

        // The ham: a thigh as deep as the body is.
        const thigh = `legB${s}`, shin = `shinB${s}`, hock = `hockB${s}`, hind = `hoofB${s}`;
        b.part(thigh, 'body', [2.7 * sx, 9.2, -7.0]);
        b.part(shin, thigh, [2.9 * sx, 5.6, -5.4]);
        b.part(hock, shin, [2.9 * sx, 3.4, -8.1]);
        b.part(hind, hock, [2.9 * sx, 1.25, -7.5]);
        b.on(thigh).loft(sided(sx, [
            [2.5, 9.8, -7.0, 1.2, 2.8, 2.6, { bone: 'body' }],
            [2.8, 7.4, -6.8, 1.6, 2.8, 2.7, { bone: ['body', thigh, 0.6] }],
            [2.9, 5.8, -6.4, 1.5, 2.2, 2.2],
            [2.9, 5.0, -6.6, 1.3, 1.6, 1.7, { bone: [thigh, shin, 0.5] }],
            [2.9, 4.0, -7.5, 1.0, 1.05, 1.1, { bone: shin }],
            [2.9, 3.4, -8.0, 0.95, 0.95, 1.2, { bone: [shin, hock, 0.5] }],
            [2.9, 2.5, -7.85, 0.8, 0.8, 0.85, { bone: hock }],
            [2.9, 1.35, -7.5, 0.85, 0.85, 0.95, { bone: [hock, hind, 0.5] }],
            [2.9, 0.8, -7.35, 0.95, 1.1, 0.9, { bone: hind }],
            [2.9, 0, -7.25, 1.0, 1.3, 0.9, { bone: hind }],
        ]), { along: DOWN, sq: 2.3, seg: 8, caps: [false, true], crease: true, tag: 'leg' });
    }

    // The tail: out, and once round on itself.
    const curl = [[0, 10.5, -9.6, 0.5, 0.5, { bone: 'body' }], [0, 10.9, -10.6, 0.42, 0.42, { bone: ['body', 'tail0', 0.6] }]];
    for (let i = 0; i <= 7; i++) {
        const a = (-90 + i * 55) * Math.PI / 180, r = 0.4 - i * 0.03;
        curl.push([-0.3 + i * 0.16, 11.9 + 0.95 * Math.sin(a), -11.3 - 0.95 * Math.cos(a), r, r]);
    }
    b.part('tail0', 'body', [0, 10.8, -10.4]).loft(curl, { seg: 6, caps: [false, 0.1], tag: 'tail' });
    return b.done();
}

function sheep() {
    const b = new Builder('sheep', { variants: { coat: 3 }, layers: v => [`sheep_${v.coat + 1}`] });

    // The trunk in its fleece: a deep oblong, a little flat along the back.
    b.part('body', 'root', [0, 11.2, -1]).loft([
        [0, 11.6, -9.6, 1.8, 2.2, 2.6],
        [0, 11.3, -8.6, 3.7, 3.8, 4.1],
        [0, 11.2, -5.6, 4.6, 4.5, 4.7],
        [0, 11.2, -1.0, 4.9, 4.6, 4.9],
        [0, 11.3,  3.0, 4.7, 4.5, 4.8],
        [0, 11.6,  6.0, 4.1, 4.3, 4.5],
        [0, 12.0,  7.9, 3.1, 3.5, 3.7],
        [0, 12.3,  8.9, 1.9, 2.2, 2.3],
    ], { along: FWD, sq: 2.5, caps: [0.6, 0.5], step: 2.4, tag: 'wool' });

    // The neck, woolly to the jaw.
    b.part('neck', 'body', [0, 12.6, 6.6]).loft([
        [0, 12.2, 5.2, 3.2, 3.6, 3.6, { bone: 'body' }],
        [0, 13.2, 7.4, 2.7, 3.0, 3.2, { bone: ['body', 'neck', 0.5] }],
        [0, 14.8, 8.9, 2.1, 2.2, 2.4],
        [0, 16.0, 9.9, 1.8, 1.8, 2.0, { bone: ['neck', 'head', 0.5] }],
        [0, 16.6, 10.6, 1.6, 1.4, 1.6, { bone: 'head' }],
    ], { sq: 2.3, seg: 12, tag: 'wool' });

    // The head: bare, narrow, the line of the nose a little arched.
    const AXIS = [0, -0.62, 0.785], UP = [0, 0.785, 0.62];
    b.part('head', 'neck', [0, 16.8, 9.8]).loft(row([0, 17.0, 9.6], AXIS, [
        [-0.3, 1.2, 1.1, 1.2],
        [0.6, 1.85, 1.5, 1.8],
        [2.0, 1.95, 1.5, 2.2],
        [3.6, 1.5, 1.3, 1.75, { bone: JAW }],
        [5.0, 1.2, 1.05, 1.25, { bone: JAW }],
        [5.9, 1.15, 0.9, 1.05, { sq: 3, bone: JAW }],
        [6.4, 0.95, 0.7, 0.85, { sq: 3, bone: JAW }],
    ]), { sq: 2.4, caps: [0.3, 0.25], seg: 12, step: 1.4, density: 4 });
    b.part('jaw', 'head', [0, 15.2, 10.6]);
    b.mark('poll', [0, 17.0, 9.6]).mark('nose', [0, 13.03, 14.62]).mark('eye', [1.85, 16.29, 11.59]);
    // A cap of wool on the poll.
    b.on('head').loft(row([0, 17.0 + UP[1] * 0.9, 9.6 + UP[2] * 0.9], AXIS, [
        [-0.7, 1.2, 0.7, 0.7],
        [0.3, 1.95, 1.05, 1.0],
        [1.3, 1.85, 0.95, 0.9],
        [2.1, 1.0, 0.5, 0.5],
    ]), { caps: [0.3, 0.3], seg: 8, tag: 'woolcap' });
    for (const [s, sx] of SIDES) {
        b.part(`ear${s}`, 'head', [1.7 * sx, 16.8, 9.9]).loft(sided(sx, [
            [1.6, 16.8, 9.9, 0.35, 0.22],
            [2.9, 16.6, 9.8, 0.72, 0.22],
            [3.9, 16.2, 9.75, 0.55, 0.18],
            [4.5, 15.9, 9.7, 0.18, 0.1],
        ]), { side: [0, 1, 0], seg: 6, caps: [false, 0.1], tag: 'ear' });
    }

    for (const [s, sx] of SIDES) {
        // Legs: in wool to the knee and the hock, bare and fine below.
        const leg = `legF${s}`, knee = `kneeF${s}`, hoof = `hoofF${s}`;
        b.part(leg, 'body', [2.9 * sx, 11.0, 5.0]);
        b.part(knee, leg, [3.0 * sx, 4.6, 5.1]);
        b.part(hoof, knee, [3.0 * sx, 1.5, 5.1]);
        b.on(leg).loft(sided(sx, [
            [2.6, 11.4, 5.1, 1.3, 2.6, 2.6, { bone: 'body' }],
            [2.9, 8.8, 5.1, 1.6, 2.3, 2.3, { bone: ['body', leg, 0.6] }],
            [3.0, 6.9, 5.05, 1.35, 1.6, 1.6],
            [3.0, 5.6, 5.1, 0.8, 0.85, 0.85],
            [3.0, 4.6, 5.15, 0.8, 0.9, 0.75, { bone: [leg, knee, 0.5] }],
            [3.0, 3.6, 5.1, 0.62, 0.62, 0.66, { bone: knee }],
            [3.0, 1.6, 5.1, 0.7, 0.7, 0.85, { bone: [knee, hoof, 0.5] }],
            [3.0, 0.9, 5.25, 0.75, 0.85, 0.7, { bone: hoof }],
            [3.0, 0, 5.35, 0.85, 1.1, 0.75, { bone: hoof }],
        ]), { along: DOWN, sq: 2.3, seg: 8, caps: [false, true], crease: true, tag: 'leg' });

        const thigh = `legB${s}`, shin = `shinB${s}`, hock = `hockB${s}`, hind = `hoofB${s}`;
        b.part(thigh, 'body', [2.8 * sx, 11.6, -6.6]);
        b.part(shin, thigh, [3.0 * sx, 7.6, -4.9]);
        b.part(hock, shin, [3.0 * sx, 4.9, -7.7]);
        b.part(hind, hock, [3.0 * sx, 1.5, -7.1]);
        b.on(thigh).loft(sided(sx, [
            [2.6, 12.0, -6.6, 1.3, 2.9, 2.7, { bone: 'body' }],
            [2.9, 9.6, -6.3, 1.7, 2.9, 2.7, { bone: ['body', thigh, 0.6] }],
            [3.0, 7.8, -5.9, 1.55, 2.2, 2.2],
            [3.0, 6.9, -6.2, 1.3, 1.5, 1.6, { bone: [thigh, shin, 0.5] }],
            [3.0, 5.7, -7.1, 0.85, 0.9, 0.95, { bone: shin }],
            [3.0, 4.9, -7.6, 0.8, 0.8, 1.05, { bone: [shin, hock, 0.5] }],
            [3.0, 3.9, -7.5, 0.62, 0.62, 0.68, { bone: hock }],
            [3.0, 1.6, -7.1, 0.7, 0.7, 0.85, { bone: [hock, hind, 0.5] }],
            [3.0, 0.9, -6.95, 0.75, 0.85, 0.7, { bone: hind }],
            [3.0, 0, -6.85, 0.85, 1.1, 0.75, { bone: hind }],
        ]), { along: DOWN, sq: 2.3, seg: 8, caps: [false, true], crease: true, tag: 'leg' });
    }

    b.part('tail0', 'body', [0, 13.4, -9.4]).loft([
        [0, 13.6, -8.8, 1.1, 1.0, { bone: 'body' }],
        [0, 13.0, -9.9, 1.0, 0.9, { bone: ['body', 'tail0', 0.6] }],
        [0, 11.2, -10.3, 0.9, 0.8],
        [0, 9.6, -10.2, 0.55, 0.5],
    ], { along: DOWN, seg: 6, caps: [false, 0.25], tag: 'wool' });
    return b.done();
}

function chicken() {
    const b = new Builder('chicken', { variants: { coat: 3 }, layers: v => [`chicken_${v.coat + 1}`] });

    // The body: a boat, the breast full and carried forward, the back rising to the tail.
    b.part('body', 'root', [0, 4.9, 0]).loft([
        [0, 6.4, -3.5, 0.7, 0.8, 0.8],
        [0, 5.8, -2.6, 1.5, 1.4, 1.6],
        [0, 5.1, -1.0, 2.0, 1.85, 2.15],
        [0, 4.8,  0.9, 2.1, 1.95, 2.25],
        [0, 5.0,  2.3, 1.75, 1.8, 1.9],
        [0, 5.3,  3.3, 1.0, 1.1, 1.1],
    ], { along: FWD, sq: 2.2, caps: [0.4, 0.5], seg: 12, step: 1.2 });

    // The neck: thick with hackles at the shoulders, slim under the head; two
    // bones, so it can reach and draw back.
    b.part('neck0', 'body', [0, 6.1, 2.0]);
    b.part('neck1', 'neck0', [0, 7.4, 2.7]);
    b.part('head', 'neck1', [0, 8.5, 3.0]);
    b.on('neck0').loft([
        [0, 5.5, 1.4, 1.5, 1.4, 1.5, { bone: 'body' }],
        [0, 6.4, 2.2, 1.15, 1.1, 1.2, { bone: ['body', 'neck0', 0.5] }],
        [0, 7.4, 2.75, 0.85, 0.85, 0.9, { bone: ['neck0', 'neck1', 0.5] }],
        [0, 8.2, 3.0, 0.75, 0.75, 0.8, { bone: ['neck1', 'head', 0.5] }],
        [0, 8.7, 3.1, 0.7, 0.7, 0.7, { bone: 'head' }],
    ], { seg: 8, tag: 'neck' });
    b.on('head').loft([
        [0, 8.8, 2.3, 0.5, 0.5, 0.5],
        [0, 8.8, 2.8, 0.85, 0.85, 0.8],
        [0, 8.75, 3.5, 0.8, 0.8, 0.8],
        [0, 8.6, 4.05, 0.5, 0.5, 0.5],
    ], { caps: [0.25, 0.15], seg: 8, density: 4, tag: 'skull' });
    b.loft([
        [0, 8.55, 3.95, 0.42, 0.32, 0.3],
        [0, 8.37, 4.6, 0.26, 0.2, 0.18],
        [0, 8.12, 5.1, 0.06, 0.05, 0.05],
    ], { seg: 6, density: 4, tag: 'beak' });
    // A comb, cut to its points by the texture, and a wattle under each side of the beak.
    b.box([-0.15, 9.35, 2.5], [0.3, 1.1, 1.8], { density: 4, tag: 'comb' });
    for (const [, sx] of SIDES) {
        b.loft(sided(sx, [
            [0.27, 8.3, 3.85, 0.15, 0.22],
            [0.27, 7.85, 3.85, 0.17, 0.32],
            [0.27, 7.45, 3.85, 0.1, 0.18],
        ]), { seg: 6, caps: [false, 0.06], density: 4, tag: 'wattle' });
    }
    b.mark('eye', [0.8, 8.88, 3.35]).mark('nose', [0, 8.12, 5.1]);

    for (const [s, sx] of SIDES) {
        // A wing, folded flat to the side: its "across" is its height.
        b.part(`wing${s}`, 'body', [1.9 * sx, 6.1, 1.6]).loft(sided(sx, [
            [1.95, 5.8, 2.0, 0.7, 0.3],
            [2.15, 5.4, 0.9, 1.45, 0.36],
            [2.1, 5.3, -0.8, 1.3, 0.33],
            [1.8, 5.7, -2.4, 0.7, 0.22],
            [1.5, 6.0, -3.1, 0.25, 0.1],
        ]), { along: [0, 0, -1], side: [0, 1, 0], seg: 8, caps: [0.15, 0.05], tag: 'wing' });

        // A leg: the drumstick, in feathers, back to the hock; the bare shank
        // forward and down from it; and the toes, cut out of a plate.
        const leg = `leg${s}`, shank = `shank${s}`, foot = `foot${s}`;
        b.part(leg, 'body', [0.95 * sx, 4.1, 0.3]);
        b.part(shank, leg, [0.95 * sx, 2.1, -0.55]);
        b.part(foot, shank, [0.95 * sx, 0.35, 0]);
        b.on(leg).loft(sided(sx, [
            [0.95, 4.4, 0.3, 0.8, 0.9, 0.9, { bone: 'body' }],
            [0.95, 3.3, -0.05, 0.7, 0.75, 0.8, { bone: ['body', leg, 0.6] }],
            [0.95, 2.5, -0.42, 0.42, 0.42, 0.5],
            [0.95, 2.1, -0.55, 0.3, 0.3, 0.38, { bone: [leg, shank, 0.5] }],
            [0.95, 1.2, -0.28, 0.24, 0.24, 0.24, { bone: shank }],
            [0.95, 0.45, -0.02, 0.28, 0.3, 0.28, { bone: [shank, foot, 0.5] }],
            [0.95, 0.12, 0, 0.3, 0.3, 0.3, { bone: foot }],
        ]), { along: DOWN, seg: 6, caps: [false, true], tag: 'leg' });
        b.on(foot).box([0.95 * sx - 0.9, 0, -0.75], [1.8, 0.22, 2.4], { density: 4, tag: 'toes' });
    }

    // The tail: a fan on edge, carried high.
    b.part('tail', 'body', [0, 6.4, -3.0]).loft([
        [0, 6.4, -3.0, 0.7, 0.8, 0.8, { bone: 'body' }],
        [0, 7.8, -4.2, 0.5, 1.2, 1.1],
        [0, 9.1, -5.0, 0.35, 1.0, 0.9],
        [0, 9.8, -5.3, 0.15, 0.4, 0.4],
    ], { seg: 8, caps: [false, 0.1], tag: 'tail' });
    return b.done();
}

function fish() {
    const b = new Builder('fish', { variants: { coat: 3 }, layers: v => [`fish_${v.coat + 1}`] });

    // One skin, tail to nose, over four bones: it swims with its whole length.
    // Deeper than it is wide, deepest behind the head and drawn out to the tail.
    b.part('body', 'root', [0, 2.2, 1.6]);
    b.part('rear', 'body', [0, 2.2, -0.4]);
    b.part('tail', 'rear', [0, 2.2, -2.4]);
    b.part('fin', 'tail', [0, 2.2, -3.7]);
    b.on('body').loft([
        [0, 2.2, -4.0, 0.14, 0.4, 0.4, { bone: 'fin' }],
        [0, 2.2, -3.3, 0.2, 0.42, 0.42, { bone: ['tail', 'fin', 0.5] }],
        [0, 2.2, -2.4, 0.36, 0.7, 0.7, { bone: ['rear', 'tail', 0.5] }],
        [0, 2.25, -1.3, 0.55, 1.05, 1.05, { bone: 'rear' }],
        [0, 2.3, -0.3, 0.66, 1.3, 1.25, { bone: ['body', 'rear', 0.5] }],
        [0, 2.3, 1.0, 0.7, 1.4, 1.3],
        [0, 2.25, 2.4, 0.66, 1.2, 1.15],
        [0, 2.15, 3.5, 0.5, 0.8, 0.8],
        [0, 2.1, 4.2, 0.28, 0.4, 0.42],
        [0, 2.08, 4.5, 0.12, 0.15, 0.18],
    ], { along: FWD, caps: [true, 0.1], seg: 8, density: 4 });
    b.mark('eye', [0.6, 2.55, 3.3]);
    // Fins: thin plates, cut to shape by the texture.
    b.box([-0.07, 3.3, -0.7], [0.14, 1.5, 2.9], { density: 4, tag: 'dorsal' });
    b.on('rear').box([-0.06, 0.45, -2.5], [0.12, 1.0, 1.5], { density: 4, tag: 'anal' });
    b.on('fin').box([-0.07, 0.45, -6.5], [0.14, 3.5, 2.8], { density: 4, tag: 'tailfin' });
    for (const [s, sx] of SIDES) {
        b.part(`fin${s}`, 'body', [0.62 * sx, 1.75, 2.0], { rot: [0, 28 * sx, -38 * sx] })
            .box([sx > 0 ? 0.6 : -2.2, 1.68, 0.8], [1.6, 0.14, 1.3], { density: 4, tag: 'fin' });
    }
    return b.done();
}

/**
 * What can be chosen about a Quiddle. The first five are its build — how it is
 * made — and move the model's own vertices (`quiddleBuild`); the rest are what
 * it wears, each a texture layer and the parts that go with it. Some hair and
 * some clothes are for one sex (`QUIDDLE_ONLY`).
 *   sex        0 a man, 1 a woman: where the width is — shoulders or hips
 *   build      slight, medium, broad
 *   arms, legs from lean to heavy
 *   height     five, from 7% under to 7% over
 *   skin       five tones
 *   outfit     0 tunic, 1 overalls, 2 dress, 3 waistcoat, 4 blouse and skirt, 5 jumper
 *   eyes       brown, blue, green
 *   hair       0 short, 1 long, 2 straw hat, 3 cropped, 4 bun, 5 short with a beard
 *   hairColor  brown, fair, black, auburn, grey
 */
export const QUIDDLE_LOOKS = { sex: 2, build: 3, arms: 3, legs: 3, height: 5, skin: 5, outfit: 6, eyes: 3, hair: 6, hairColor: 5 };
const MAN = { sex: 0 }, WOMAN = { sex: 1 };
export const QUIDDLE_ONLY = {
    outfit: { 2: WOMAN, 3: MAN, 4: WOMAN },
    hair: { 1: WOMAN, 3: MAN, 4: WOMAN, 5: MAN },
};

/**
 * Where a Quiddle's joints and edges are, px above the ground — for the model
 * below, for the build, and for the painters (which draw clothes to these
 * lines). The figure is a drawn character's: about four heads tall where a
 * person is seven and a half, with a person's trunk on short, sturdy legs.
 */
export const QUIDDLE_Y = {
    ankle: 1.5, knee: 5.9, crotch: 10.2, hip: 11.0, waist: 14.25, chest: 17.85, shoulder: 19.3, neck: 20.4, chin: 21.5,
    elbow: 15.65, wrist: 12.25, knuckle: 10.95, tip: 9.75,
};

/**
 * A Quiddle's build: the one model, with its vertices moved. The trunk is
 * widened by height — shoulders, waist and hips each by their own amount, which
 * is where a man and a woman differ — the arms and legs are thickened about
 * their own middles and moved out to stay beside it, and the whole is scaled
 * for height. Texels stay where they were, so every outfit fits every build.
 * Returns what MobModels asks for: `point(p, tag)` moves a vertex of a shape,
 * `pivot(bone, p)` a bone's pivot (sideways only: legs are placed in their own
 * fore-and-aft plane, wherever that is), `scale` and a `key` for the shape.
 */
function quiddleBuild(v) {
    const Y = QUIDDLE_Y, sex = v.sex ?? 0, b = [0.94, 1, 1.07][v.build ?? 1];
    // Limbs go with the frame they are on: a slight build has slighter ones.
    const arm = [1, 1.12, 1.26][v.arms ?? 0] * (1 + (b - 1) * 0.5), leg = [1, 1.09, 1.2][v.legs ?? 0] * b;
    const shoulders = (sex ? 0.92 : 1.05) * b, waist = (sex ? 0.9 : 1.03) * b, hips = (sex ? 1.06 : 0.97) * b;
    const ease = (t) => t * t * (3 - 2 * t);
    const top = Y.shoulder - 0.45, low = Y.waist - 2;
    const wide = (y) => y >= top ? shoulders : y >= Y.waist ? waist + (shoulders - waist) * ease((y - Y.waist) / (top - Y.waist))
        : y >= low ? hips + (waist - hips) * (y - low) / 2 : hips;
    const armOut = 3.95 * (shoulders - 1) + 0.5 * (arm - 1), legOut = 1.2 * (hips - 1) + 0.6 * (leg - 1);
    return {
        key: `${sex}${v.build ?? 1}${v.arms ?? 0}${v.legs ?? 0}`,
        scale: [0.93, 0.965, 1, 1.035, 1.07][v.height ?? 2],
        point(p, tag) {
            const side = p[0] < 0 ? -1 : 1, y = p[1];
            if (tag === 'torso' || tag === 'skirt') {
                // A woman's chest is fuller in front.
                if (sex && tag === 'torso' && p[2] > 0) {
                    const up = 1 - Math.abs(y - (Y.chest - 0.3)) / 1.4, across = 1 - (p[0] / 3.5) ** 2;
                    if (up > 0 && across > 0) p[2] += 0.5 * ease(up) * across;
                }
                // A skirt has to go round the legs under it, however heavy they are.
                const round = tag === 'skirt' ? 1 + (leg / b - 1) * Math.min(1, Math.max(0, (Y.waist - y) / 1.7)) : 1;
                p[0] *= wide(y) * round;
                p[2] *= b * round;
            } else if (tag === 'arm' || tag === 'finger') {
                // Thickest from the shoulder to the wrist; a hand grows less than the arm it is on.
                const k = y > Y.shoulder - 0.6 ? 1 + (arm - 1) * 0.6 : y > Y.wrist ? arm : 1 + (arm - 1) * 0.4;
                const ax = 4.6 * side, az = y > Y.wrist ? 0.05 : 0.4;
                p[0] = ax + (p[0] - ax) * k + armOut * side;
                p[2] = az + (p[2] - az) * k;
            } else if (tag === 'leg' || tag === 'shoe') {
                const k = tag === 'shoe' ? 1 + (leg - 1) * 0.4 : y > 2.8 ? leg : 1 + (leg - 1) * 0.5, lx = 1.8 * side;
                p[0] = lx + (p[0] - lx) * k + legOut * side;
                if (tag === 'leg') p[2] = 0.05 + (p[2] - 0.05) * k;
            }
        },
        pivot(bone, p) {
            const side = bone.endsWith('R') ? -1 : 1;
            if (/^(arm|fore|hand|fingers)[LR]$/.test(bone)) p[0] += armOut * side;
            else if (/^(leg|shin|foot)[LR]$/.test(bone)) p[0] += legOut * side;
            return p;
        },
    };
}

/**
 * A Quiddle's head is drawn in a head's own measure — a skull four and a bit
 * px from chin to crown standing on `from`, as a life-size one would — and
 * then made `scale` times bigger and set on the neck at `at`. That is most of
 * what makes a Quiddle a character and not a small person: the head is nearly
 * a quarter of its height, and the face on it is big enough to read across a
 * field. The painters work in the head's own measure (the texture tool takes
 * a texel back with these numbers), so the head can be resized without
 * touching them.
 */
export const QUIDDLE_HEAD = { scale: 1.7, from: [0, 24.5, 0], at: [0, 21.63, 0] };
const headPoint = (p) => p.map((v, i) => QUIDDLE_HEAD.at[i] + (v - QUIDDLE_HEAD.from[i]) * QUIDDLE_HEAD.scale);
/** Stations of something on the head, enlarged with it. */
const onHead = (list) => list.map((s) => {
    const n = s.filter(v => typeof v === 'number'), rest = s.filter(v => typeof v !== 'number');
    return [...headPoint(n.slice(0, 3)), ...n.slice(3).map(v => v * QUIDDLE_HEAD.scale), ...rest];
});
/**
 * The face, in texels of the skull's own grid (the painters draw it there, so
 * it is sharp and the same both sides): an eye is `w` texels across and `h`
 * down and begins `gap` texels out from the middle of the face. The eyelids
 * are cut to the same numbers.
 */
export const QUIDDLE_FACE = { density: 7, eye: { w: 6, h: 6, gap: 3 } };

/**
 * The people of Wonder World, and the player. A drawn character, not a small
 * person: a big round head with big eyes on a short neck, a person's trunk
 * and shoulders, and short sturdy arms and legs ending in big hands and
 * boots — about four heads tall. Under that it is still made as a body is:
 * one skin from the shoulder to the knuckles and from the hip to the ankle,
 * bending at real joints. What it wears and how it is built are choices
 * (`QUIDDLE_LOOKS`), each a texture layer or a set of parts, so they combine
 * freely.
 */
function quiddle() {
    const Y = QUIDDLE_Y;
    const b = new Builder('quiddle', {
        variants: QUIDDLE_LOOKS,
        layers: v => [`quiddle_skin_${v.skin + 1}`, `quiddle_outfit_${v.outfit + 1}`,
                      `quiddle_eyes_${v.eyes + 1}`, `quiddle_hair_${v.hair + 1}_${v.hairColor + 1}`],
        density: 3,
    });
    // The head and all that is on it has more texels than the body: enough for
    // a face that is drawn, not suggested.
    const FACE = QUIDDLE_FACE.density / QUIDDLE_HEAD.scale, EYE = QUIDDLE_FACE.eye;
    // The middle of an eye, out from the middle of the face by its place on the grid.
    const eyeX = (EYE.gap + EYE.w / 2) / QUIDDLE_FACE.density, eyeY = 26.18, eyeZ = 1.79;
    b.mark('eye', headPoint([eyeX, eyeY, eyeZ])).mark('mouth', headPoint([0, 25.12, 1.9]))
        .mark('brow', headPoint([0, 27.0, 1.9])).mark('noseBase', headPoint([0, 25.66, 1.86]));

    // The trunk, shoulders to crotch, in level slices: [x, y, z, half width,
    // to the front, to the back]. Above the waist it follows the torso, below
    // it the hips, so it can turn and bend there.
    b.part('hips', 'root', [0, 12.05, 0]);
    b.part('torso', 'hips', [0, Y.waist, 0]).loft([
        [0, 20.75, -0.1, 1.55, 1.3, 1.35],
        [0, 20.15, -0.05, 3.2, 1.7, 1.85],
        [0, 19.35, 0, 3.95, 2.05, 2.15],
        [0, Y.chest, 0.1, 3.7, 2.4, 2.15],
        [0, 15.95, 0.1, 3.35, 2.2, 2.0],
        [0, Y.waist, 0.05, 3.1, 2.0, 1.9, { bone: ['torso', 'hips', 0.5] }],
        [0, 12.65, 0, 3.4, 2.1, 2.2, { bone: 'hips' }],
        [0, 11.05, 0, 3.35, 2.0, 2.25, { bone: 'hips' }],
        [0, 10.15, 0, 2.0, 1.4, 1.6, { bone: 'hips' }],
    ], { along: DOWN, sq: 2.8, seg: 12, caps: [true, 0.4] });

    // A short, sturdy neck, from between the shoulders up into the skull.
    b.part('head', 'torso', [0, 21.45, -0.1]);
    b.on('torso').loft([
        [0, 20.2, -0.2, 1.5, 1.4, 1.35],
        [0, 21.0, -0.1, 1.4, 1.35, 1.3, { bone: ['torso', 'head', 0.5] }],
        [0, 21.95, 0, 1.45, 1.35, 1.3, { bone: 'head' }],
    ], { along: [0, 1, 0], seg: 8, tag: 'neck' });

    // The head, crown to chin, in level slices: a round skull, full in the
    // cheek, the jaw soft and the chin small.
    b.on('head').loft(onHead([
        [0, 28.62, 0.05, 0.95, 0.95, 1.05],
        [0, 28.3, 0.05, 1.42, 1.45, 1.58],
        [0, 27.7, 0.08, 1.72, 1.74, 1.88],
        [0, 27.0, 0.1, 1.84, 1.82, 1.96],
        [0, 26.4, 0.1, 1.86, 1.82, 1.92],
        [0, 25.8, 0.12, 1.82, 1.8, 1.74],
        [0, 25.25, 0.15, 1.66, 1.74, 1.44, { sq: 2.5 }],
        [0, 24.8, 0.22, 1.34, 1.54, 1.04, { sq: 2.5 }],
        [0, 24.45, 0.3, 0.86, 1.1, 0.58, { sq: 2.5 }],
    ]), { along: DOWN, sq: 2.35, seg: 16, caps: [0.22, 0.1], density: FACE, tag: 'skull' });
    // A small, round nose.
    b.loft(onHead([
        [0, 26.02, 1.8, 0.15, 0.15, 0.1],
        [0, 25.82, 1.87, 0.26, 0.33, 0.1],
        [0, 25.66, 1.85, 0.23, 0.25, 0.1],
    ]), { along: DOWN, seg: 6, caps: [false, true], density: FACE, tag: 'nose' });
    for (const [, sx] of SIDES) {
        // An ear, from the brow down to the base of the nose: [x, y, z, half depth, half height].
        b.loft(onHead(sided(sx, [
            [1.72, 26.2, -0.1, 0.3, 0.5],
            [1.98, 26.22, -0.2, 0.4, 0.62],
            [2.1, 26.22, -0.26, 0.28, 0.48],
        ])), { side: [0, 0, 1], seg: 8, caps: [false, 0.05], density: FACE, tag: 'ear' });
    }
    // Eyelids: a patch of skin over each eye, scaled away except in a blink.
    const lidW = (EYE.w + 0.6) / QUIDDLE_FACE.density, lidH = (EYE.h + 1.6) / QUIDDLE_FACE.density;
    b.part('lids', 'head', headPoint([0, eyeY, 1.2]));
    for (const [s, sx] of SIDES) {
        b.part(`lid${s}`, 'lids', headPoint([eyeX * sx, eyeY, eyeZ]), { rot: [0, 21 * sx, 0] })
            .box(headPoint([eyeX * sx - lidW / 2, eyeY - lidH / 2, eyeZ - 0.03]), [lidW, lidH, 0.1].map(v => v * QUIDDLE_HEAD.scale), { faces: ['pz'], density: FACE, tag: 'lid' });
    }

    // Hair is its own shape over the skull, fuller than it at the crown and
    // the back; the texture cuts its edge — the fringe, round the ears, the nape.
    const hair = (tag) => b.loft(onHead([
        [0, 28.86, 0.03, 1.0, 1.0, 1.1],
        [0, 28.5, 0.03, 1.56, 1.58, 1.72],
        [0, 27.85, 0.06, 1.9, 1.88, 2.06],
        [0, 27.05, 0.08, 2.02, 1.95, 2.14],
        [0, 26.35, 0.08, 2.03, 1.94, 2.1],
        [0, 25.7, 0.1, 1.96, 1.9, 1.92],
        [0, 25.1, 0.12, 1.76, 1.82, 1.58],
    ]), { along: DOWN, sq: 2.35, seg: 16, caps: [0.25, false], density: FACE, tag });
    // Hair 1: short.
    b.part('hairShort', 'head', headPoint([0, 28, 0]), { show: { hair: [0, 3, 5] } });
    hair('hairShort');
    // Hair 2: long, with a length down the back that swings.
    b.part('hairLong', 'head', headPoint([0, 28, 0]), { show: { hair: [1, 4] } });
    hair('hairLong');
    // It leaves the back of the head and falls from there to the shoulder blades.
    const nape = headPoint([0, 24.9, -1.6]), fall = nape[2] - 0.25;
    b.part('hairBack', 'head', [0, nape[1] + 0.6, nape[2]], { show: { hair: 1 } }).loft([
        ...onHead([[0, 26.2, -1.25, 1.9, 0.7, 0.9, { bone: 'head' }]]),
        [0, nape[1], nape[2], 3.0, 0.6, 0.75, { bone: ['head', 'hairBack', 0.6] }],
        [0, 19.4, fall, 3.05, 0.45, 0.6],
        [0, 17.5, fall - 0.1, 2.6, 0.3, 0.45],
        [0, 16.5, fall - 0.1, 1.7, 0.15, 0.25],
    ], { along: DOWN, sq: 2.6, seg: 8, caps: [false, 0.1], density: FACE });
    // Hair 5: drawn back into a bun.
    b.part('bun', 'head', headPoint([0, 27.6, -1.9]), { show: { hair: 4 } }).loft(onHead([
        [0, 27.55, -1.7, 0.6, 0.6],
        [0, 27.65, -2.3, 0.86, 0.86],
        [0, 27.6, -2.85, 0.54, 0.54],
    ]), { along: [0, 0, -1], seg: 8, caps: [0.2, 0.2], density: FACE });
    // Hair 3: a brimmed straw hat, with hair showing under it.
    b.part('hat', 'head', headPoint([0, 28, 0]), { show: { hair: 2 } });
    hair('hairUnderHat');
    b.loft(onHead([
        [0, 29.95, 0.05, 1.62, 1.66, 1.8],
        [0, 29.5, 0.05, 2.04, 2.04, 2.2],
        [0, 28.35, 0.05, 2.12, 2.1, 2.26],
    ]), { along: DOWN, seg: 12, caps: [0.15, false], density: FACE, tag: 'hatCrown' });
    b.loft(onHead([
        [0, 28.42, 0.05, 2.12, 2.1, 2.26],
        [0, 28.3, 0.05, 3.8, 3.95, 3.85],
        [0, 28.14, 0.05, 3.85, 4.0, 3.9],
        [0, 28.1, 0.05, 2.02, 2.0, 2.16],
    ]), { along: DOWN, seg: 12, smooth: false, density: FACE, tag: 'hatBrim' });

    for (const [s, sx] of SIDES) {
        // An arm: one skin from the shoulder to the knuckles, turning at the
        // shoulder, the elbow and the wrist. [x, y, z, half depth, half width].
        // Its top lies in the slope of the shoulder and goes mostly with the
        // trunk, so the arm grows out of the body rather than being set on it.
        const arm = `arm${s}`, fore = `fore${s}`, hand = `hand${s}`, fingers = `fingers${s}`;
        b.part(arm, 'torso', [4.15 * sx, Y.shoulder, 0]);
        b.part(fore, arm, [4.6 * sx, Y.elbow, -0.05]);
        b.part(hand, fore, [4.75 * sx, Y.wrist, 0.15]);
        b.part(fingers, hand, [4.72 * sx, Y.knuckle, 0.45]);
        b.on(arm).loft(sided(sx, [
            [3.7, 19.75, 0, 0.9, 0.5, { bone: ['torso', arm, 0.3] }],
            [4.15, 19.2, 0, 1.2, 0.9, { bone: ['torso', arm, 0.65] }],
            [4.5, 18.4, 0, 1.2, 0.98],
            [4.6, 17.3, 0, 1.12, 0.96],
            [4.6, 16.3, 0, 1.0, 0.9],
            [4.6, Y.elbow, -0.05, 0.96, 0.86, { bone: [arm, fore, 0.5] }],
            [4.65, 14.8, 0.05, 1.0, 0.9, { bone: fore }],
            [4.7, 13.2, 0.15, 0.8, 0.74, { bone: fore }],
            [4.75, Y.wrist, 0.18, 0.62, 0.6, { bone: [fore, hand, 0.5] }],
            [4.77, 11.7, 0.3, 0.8, 0.44, { bone: hand }],
            [4.75, 11.2, 0.4, 0.86, 0.42, { bone: hand }],
            [4.72, 10.9, 0.45, 0.8, 0.36, { bone: hand }],
        ]), { along: DOWN, side: [0, 0, 1], seg: 8, caps: [0.12, 0.05], tag: 'arm' });
        // The hand: a big one, with a palm turned to the thigh, the four
        // fingers together as one (the texture draws the lines between them)
        // and a thumb set forward of them. The fingers close from the knuckles.
        b.on(hand).loft(sided(sx, [
            [4.72, 11.0, 0.42, 0.74, 0.3],
            [4.66, 10.35, 0.44, 0.7, 0.28, { bone: [hand, fingers, 0.6] }],
            [4.5, Y.tip, 0.46, 0.54, 0.2, { bone: fingers }],
        ]), { side: [0, 0, 1], seg: 6, caps: [false, 0.12], tag: 'finger' });
        b.on(hand).loft(sided(sx, [
            [4.66, 11.75, 0.95, 0.3, 0.28],
            [4.52, 11.2, 1.3, 0.26, 0.24],
            [4.42, 10.75, 1.42, 0.2, 0.18],
        ]), { side: [0, 0, 1], seg: 4, caps: [false, 0.08], tag: 'finger' });

        // A leg: from inside the hip to the ankle, turning at the hip and the
        // knee; the boot turns at the ankle.
        const leg = `leg${s}`, shin = `shin${s}`, foot = `foot${s}`;
        b.part(leg, 'hips', [1.75 * sx, Y.hip, 0]);
        b.part(shin, leg, [1.8 * sx, Y.knee, 0.1]);
        b.part(foot, shin, [1.8 * sx, Y.ankle, -0.2]);
        b.on(leg).loft(sided(sx, [
            [1.7, 12.3, 0, 1.6, 1.85, 2.05, { bone: 'hips' }],
            [1.76, 10.6, 0, 1.64, 1.8, 1.95, { bone: ['hips', leg, 0.6] }],
            [1.8, 9.4, 0.05, 1.6, 1.75, 1.7],
            [1.8, 7.6, 0.1, 1.42, 1.5, 1.4],
            [1.8, 6.4, 0.15, 1.28, 1.3, 1.2],
            [1.8, Y.knee, 0.2, 1.28, 1.34, 1.14, { bone: [leg, shin, 0.5] }],
            [1.8, 5.2, 0.1, 1.24, 1.16, 1.24, { bone: shin }],
            [1.8, 4.1, 0, 1.26, 1.08, 1.42, { bone: shin }],
            [1.8, 2.6, -0.1, 1.06, 0.98, 1.06, { bone: shin }],
            [1.8, 1.6, -0.2, 0.96, 0.92, 0.96, { bone: [shin, foot, 0.5] }],
            [1.8, 0.9, -0.2, 1.0, 0.95, 1.0, { bone: foot }],
        ]), { along: DOWN, seg: 8, tag: 'leg' });
        // A boot, round at the toe and broad across the ball.
        b.on(foot).loft(sided(sx, [
            [1.8, 0.85, -1.5, 0.7, 0.75, 0.75],
            [1.8, 0.92, -0.9, 1.0, 1.05, 0.9],
            [1.82, 0.9, 0.3, 1.08, 0.95, 0.88],
            [1.86, 0.76, 1.5, 1.14, 0.76, 0.74],
            [1.88, 0.64, 2.4, 1.06, 0.62, 0.62],
            [1.88, 0.54, 2.95, 0.7, 0.44, 0.52],
        ]), { along: FWD, sq: 3, seg: 8, caps: [0.25, 0.25], tag: 'shoe' });
    }

    // Skirts hang from the hips, and each side goes with the leg under it —
    // more the further down and the further round from the middle — so a
    // stride swings the cloth instead of coming through it.
    const cloth = (bone, share) => (u) => {
        const k = share * Math.min(1, Math.max(0, (Math.abs(u) - 0.08) / 0.27));
        return ['hips', `${bone}${u > 0 ? 'L' : 'R'}`, k];
    };
    // The skirt of a tunic, to mid thigh.
    b.part('tunic', 'hips', [0, 13.6, 0], { show: { outfit: 0 } }).loft([
        [0, 14.15, 0.05, 3.2, 2.1, 2.0, { bone: ['torso', 'hips', 0.5] }],
        [0, 12.45, 0, 3.7, 2.35, 2.5],
        [0, 10.3, 0, 3.95, 2.6, 2.7, { bone: cloth('leg', 0.4) }],
        [0, 9.1, 0, 4.05, 2.7, 2.8, { bone: cloth('leg', 0.6) }],
    ], { along: DOWN, sq: 2.6, seg: 12, tag: 'skirt' });
    // A dress, to the shins.
    b.part('dress', 'hips', [0, 13.6, 0], { show: { outfit: [2, 4] } }).loft([
        [0, 14.15, 0.05, 3.2, 2.1, 2.0, { bone: ['torso', 'hips', 0.5] }],
        [0, 12.45, 0, 3.75, 2.4, 2.55],
        [0, 9.4, 0, 4.15, 2.85, 2.95, { bone: cloth('leg', 0.5) }],
        [0, 6.05, 0, 4.5, 3.2, 3.2, { bone: cloth('leg', 0.85) }],
        [0, 4.0, 0, 4.7, 3.4, 3.4, { bone: cloth('shin', 0.9) }],
    ], { along: DOWN, sq: 2.6, seg: 12, tag: 'skirt' });
    const m = b.done();
    m.only = QUIDDLE_ONLY;
    m.build = quiddleBuild;
    // Every texture file: hair comes in every colour.
    m.allLayers = () => {
        const all = [];
        for (let i = 1; i <= QUIDDLE_LOOKS.skin; i++) all.push(`quiddle_skin_${i}`);
        for (let i = 1; i <= QUIDDLE_LOOKS.outfit; i++) all.push(`quiddle_outfit_${i}`);
        for (let i = 1; i <= QUIDDLE_LOOKS.eyes; i++) all.push(`quiddle_eyes_${i}`);
        for (let i = 1; i <= QUIDDLE_LOOKS.hair; i++) for (let c = 1; c <= QUIDDLE_LOOKS.hairColor; c++) all.push(`quiddle_hair_${i}_${c}`);
        return all;
    };
    return m;
}

export const MODELS = {
    cow: cow(), pig: pig(), sheep: sheep(), chicken: chicken(), fish: fish(), quiddle: quiddle(),
};
