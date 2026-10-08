/**
 * MobAnim — how the mob models of MobModelDefs.js move.
 *
 * Pure maths (no Three.js, no DOM). An animator is a function per model that
 * writes a **pose** — a turn, a shift and a scale for every bone — from an
 * **anim state** the entity manager fills in each frame (how fast the mob is
 * going, where it is looking, whether it is grazing, struck, in the air…).
 * `poseMatrices` then turns the pose into a matrix per bone, and the renderer
 * moves the skin with those.
 *
 * Legs are not swung, they are **placed**: a gait says where each foot is
 * through a stride — on the ground and going back under the body at exactly
 * the speed the mob goes forward, then lifted and carried ahead — and the leg
 * is folded at its joints to put the foot there (`makeLeg`). So a foot that is
 * down stays where it was put, knees and hocks bend as far as the step needs
 * and no further, and the same code walks a cow, a chicken and a Quiddle.
 */

import { MODELS } from './MobModelDefs.js';

const sin = Math.sin, cos = Math.cos, PI = Math.PI, TAU = Math.PI * 2;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
/** 0 below a, 1 above b, eased between. */
const ramp = (a, b, x) => smooth(clamp((x - a) / (b - a), 0, 1));
const fract = (x) => x - Math.floor(x);

/**
 * A pose: what each bone does on top of its rest position.
 *   r  turn about the pivot, radians, 3 per bone, about the model's axes as
 *      its parent has left them (applied yaw, then pitch, then roll:
 *      R = Ry · Rx · Rz). A positive x turn swings what hangs below a pivot
 *      backward and tips what is in front of it down.
 *   t  shift of the pivot, px, 3 per bone
 *   s  scale about the pivot, 1 per bone
 */
export function makePose(model) {
    const n = model.parts.length;
    return { r: new Float32Array(n * 3), t: new Float32Array(n * 3), s: new Float32Array(n).fill(1) };
}

export function resetPose(pose) {
    pose.r.fill(0); pose.t.fill(0); pose.s.fill(1);
}

/**
 * What an animator reads. The renderer owns one per mob and the entity
 * manager fills it in each frame.
 *   time     seconds, running
 *   phase    stride cycle, radians — advanced by distance covered (see GAITS)
 *   move     0 standing … 1 at walking speed or faster (eased)
 *   run      0 walking … 1 at its full running speed (eased)
 *   lookYaw, lookPitch   where the head turns, relative to the body, radians
 *   air      0 on the ground … 1 falling or jumping
 *   swim     0 … 1 in water
 *   graze    0 … 1 head down to eat (peck, for a chicken)
 *   attack   0 none, else 0 → 1 through one swing
 *   panic    0 … 1 running for its life
 *   hurt     1 when just hit, fading to 0
 *   seed     0 … 1, different for every mob, so a herd is not in step
 */
export function makeAnimState(seed = Math.random()) {
    return { time: seed * 100, phase: seed * TAU, move: 0, run: 0, lookYaw: 0, lookPitch: 0, air: 0, swim: 0,
             graze: 0, attack: 0, panic: 0, hurt: 0, seed };
}

// ── Skinning ─────────────────────────────────────────────────────────────────

/**
 * The matrix of every bone for a pose: `out` gets 12 numbers per bone, a 3 × 4
 * row-major transform from where the model stands at rest (px) to where the
 * pose puts it (px) — the identity for a bone nothing has moved. Parents come
 * before their children in `parts`, so one pass does it. `pivots`, three
 * numbers a bone, stands in for the model's own where a mob's build differs.
 */
export function poseMatrices(model, pose, out, pivots = null) {
    const parts = model.parts;
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ax = pose.r[i * 3], ay = pose.r[i * 3 + 1], az = pose.r[i * 3 + 2];
        const cx = cos(ax), sx = sin(ax), cy = cos(ay), sy = sin(ay), cz = cos(az), sz = sin(az);
        const k = pose.s[i];
        // R = Ry · Rx · Rz, scaled.
        const r00 = (cy * cz + sy * sx * sz) * k, r01 = (-cy * sz + sy * sx * cz) * k, r02 = (sy * cx) * k;
        const r10 = (cx * sz) * k,                r11 = (cx * cz) * k,                 r12 = (-sx) * k;
        const r20 = (-sy * cz + cy * sx * sz) * k, r21 = (sy * sz + cy * sx * cz) * k, r22 = (cy * cx) * k;
        // Local: x → pivot + shift + R · (x − pivot)
        // A build of its own (MobModelDefs: a Quiddle's) has moved some pivots sideways.
        const px = pivots ? pivots[i * 3] : p.pivot[0], py = p.pivot[1], pz = p.pivot[2];
        const tx = px + pose.t[i * 3]     - (r00 * px + r01 * py + r02 * pz);
        const ty = py + pose.t[i * 3 + 1] - (r10 * px + r11 * py + r12 * pz);
        const tz = pz + pose.t[i * 3 + 2] - (r20 * px + r21 * py + r22 * pz);
        const o = i * 12;
        if (p.parent < 0) {
            out[o] = r00; out[o + 1] = r01; out[o + 2] = r02;  out[o + 3] = tx;
            out[o + 4] = r10; out[o + 5] = r11; out[o + 6] = r12;  out[o + 7] = ty;
            out[o + 8] = r20; out[o + 9] = r21; out[o + 10] = r22; out[o + 11] = tz;
        } else {
            const q = p.parent * 12;
            const a00 = out[q], a01 = out[q + 1], a02 = out[q + 2], a03 = out[q + 3];
            const a10 = out[q + 4], a11 = out[q + 5], a12 = out[q + 6], a13 = out[q + 7];
            const a20 = out[q + 8], a21 = out[q + 9], a22 = out[q + 10], a23 = out[q + 11];
            out[o]      = a00 * r00 + a01 * r10 + a02 * r20;
            out[o + 1]  = a00 * r01 + a01 * r11 + a02 * r21;
            out[o + 2]  = a00 * r02 + a01 * r12 + a02 * r22;
            out[o + 3]  = a00 * tx + a01 * ty + a02 * tz + a03;
            out[o + 4]  = a10 * r00 + a11 * r10 + a12 * r20;
            out[o + 5]  = a10 * r01 + a11 * r11 + a12 * r21;
            out[o + 6]  = a10 * r02 + a11 * r12 + a12 * r22;
            out[o + 7]  = a10 * tx + a11 * ty + a12 * tz + a13;
            out[o + 8]  = a20 * r00 + a21 * r10 + a22 * r20;
            out[o + 9]  = a20 * r01 + a21 * r11 + a22 * r21;
            out[o + 10] = a20 * r02 + a21 * r12 + a22 * r22;
            out[o + 11] = a20 * tx + a21 * ty + a22 * tz + a23;
        }
    }
    return out;
}

/** model name → (pose, animState) => void. Poses start reset each frame. */
export const ANIMATORS = {};

/**
 * model name → { walk, run }: blocks covered in one stride at a walk and at a
 * full run. The entity manager advances `phase` by distance over the stride
 * for the pace the mob is going at, which is what keeps feet from sliding.
 */
export const GAITS = {};

/** model name → the bones that are its feet, for checking that a foot that is down stays put. */
export const FEET = {};

// ── Legs ─────────────────────────────────────────────────────────────────────

const _R = new Float64Array(9);
/** The turn a pose gives bone i, as a 3 × 3 (R = Ry · Rx · Rz). */
function boneTurn(pose, i, R) {
    const ax = pose.r[i * 3], ay = pose.r[i * 3 + 1], az = pose.r[i * 3 + 2];
    const cx = cos(ax), sx = sin(ax), cy = cos(ay), sy = sin(ay), cz = cos(az), sz = sin(az);
    R[0] = cy * cz + sy * sx * sz;  R[1] = -cy * sz + sy * sx * cz; R[2] = sy * cx;
    R[3] = cx * sz;                 R[4] = cx * cz;                 R[5] = -sx;
    R[6] = -sy * cz + cy * sx * sz; R[7] = sy * sz + cy * sx * cz;  R[8] = cy * cx;
    return R;
}

/**
 * A point of the model's space, seen from bone i as the pose has left it: the
 * place its children must reach for to end up at `p`. (Bone i hangs from the
 * root, which animators leave alone.)
 */
function intoBone(model, pose, i, p, out) {
    const piv = model.parts[i].pivot, R = boneTurn(pose, i, _R);
    const x = p[0] - piv[0] - pose.t[i * 3], y = p[1] - piv[1] - pose.t[i * 3 + 1], z = p[2] - piv[2] - pose.t[i * 3 + 2];
    out[0] = piv[0] + R[0] * x + R[3] * y + R[6] * z;
    out[1] = piv[1] + R[1] * x + R[4] * y + R[7] * z;
    out[2] = piv[2] + R[2] * x + R[5] * y + R[8] * z;
    return out;
}

const FOLD_STEPS = 32;

/**
 * A leg that can be placed. `names` are its bones from the hip down; the last
 * is the foot (hoof, shoe), and what is placed is the joint it turns on
 * (fetlock, ankle). `fold` says, for each joint between the hip and the foot,
 * how far it turns as the leg folds up, radians per unit of fold — its sign is
 * the way that joint bends (+ carries the limb below it backward: a knee;
 * − forward: a hock). The joints fold together, as those of an animal do, so
 * the leg has one length for each amount of fold: that is tabulated here, and
 * placing the foot is then a look-up and one turn at the hip.
 *
 * A leg that stands straight has nothing left to reach with when its foot is
 * ahead of or behind the hip, so the hip itself may give by up to `slide` px
 * toward the foot — as a shoulder blade does, riding on the ribs.
 */
function makeLeg(model, names, fold, opts = {}) {
    const idx = names.map(n => {
        if (model.index[n] === undefined) throw new Error(`${model.name}: no leg bone ${n}`);
        return model.index[n];
    });
    const piv = idx.map(i => model.parts[i].pivot), hip = piv[0], foot = piv[piv.length - 1];
    const joints = idx.length - 2;
    const reach = (f, out) => {
        // The place of the foot with every joint turned: the lowest joint first.
        let y = foot[1], z = foot[2];
        for (let j = joints; j >= 1; j--) {
            const a = fold[j - 1] * f, c = cos(a), s = sin(a), dy = y - piv[j][1], dz = z - piv[j][2];
            y = piv[j][1] + c * dy - s * dz;
            z = piv[j][2] + s * dy + c * dz;
        }
        out[0] = Math.hypot(y - hip[1], z - hip[2]);
        out[1] = Math.atan2(z - hip[2], hip[1] - y);
        return out;
    };
    // From as straight as it goes (which may be straighter than it stands) to folded right up.
    const o = [0, 0];
    let lo = 0, longest = reach(0, o)[0];
    for (let f = -0.02; f >= -1.2; f -= 0.02) {
        if (reach(f, o)[0] <= longest) break;
        longest = o[0]; lo = f;
    }
    let hi = opts.max ?? 1.5;
    const len = new Float32Array(FOLD_STEPS + 1), ang = new Float32Array(FOLD_STEPS + 1);
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i <= FOLD_STEPS; i++) {
            reach(lo + (hi - lo) * i / FOLD_STEPS, o);
            // Past the point where folding further no longer shortens it, stop.
            if (pass === 0 && i > 0 && o[0] >= len[i - 1]) { hi = lo + (hi - lo) * (i - 1) / FOLD_STEPS; break; }
            len[i] = o[0]; ang[i] = o[1];
        }
    }
    return { idx, fold, hip, foot, joints, lo, hi, len, ang, slide: opts.slide ?? 0, side: Math.sign(foot[0]) || 1, x: foot[0] - hip[0] };
}

/**
 * Put the foot joint of a leg at `p` (px, as seen from the bone the leg hangs
 * on), with the foot pitched `pitch` from where it stands (+ toe down). `lean`
 * is how far that bone has itself pitched, which the foot undoes to stay level.
 */
function placeLeg(leg, pose, p, pitch = 0, lean = 0) {
    const r = pose.r, t = pose.t, idx = leg.idx, hip = leg.hip, lx = leg.x;
    let tx = p[0] - hip[0], ty = p[1] - hip[1], tz = p[2] - hip[2];
    // How long the leg must be, measured in its own fore-and-aft plane, to reach that far.
    let D = Math.sqrt(Math.max(1e-9, tx * tx + ty * ty + tz * tz - lx * lx));
    const len = leg.len, ang = leg.ang;
    let f, a;
    if (D >= len[0]) {
        f = leg.lo; a = ang[0];
        const give = Math.min(leg.slide, D - len[0]) / Math.hypot(tx, ty, tz), o = idx[0] * 3;
        t[o] = tx * give; t[o + 1] = ty * give; t[o + 2] = tz * give;
        tx -= t[o]; ty -= t[o + 1]; tz -= t[o + 2];
        D = len[0];
    } else if (D <= len[FOLD_STEPS]) {
        f = leg.hi; a = ang[FOLD_STEPS];
        D = len[FOLD_STEPS];
    } else {
        let i0 = 0, i1 = FOLD_STEPS;
        while (i1 - i0 > 1) { const m = (i0 + i1) >> 1; if (len[m] > D) i0 = m; else i1 = m; }
        const k = (len[i0] - D) / (len[i0] - len[i1]);
        f = leg.lo + (leg.hi - leg.lo) * (i0 + k) / FOLD_STEPS;
        a = ang[i0] + (ang[i1] - ang[i0]) * k;
    }
    // The leg as folded hangs down and forward from the hip by (vy, vz). It
    // leans out from the hip until the foot is as far across as it should
    // be, and then swings fore or aft onto the spot.
    const vy = -D * cos(a), vz = D * sin(a);
    const roll = Math.asin(clamp(tx / Math.hypot(lx, vy), -0.7, 0.7)) - Math.atan2(lx, -vy);
    let turned = Math.atan2(vz, -(sin(roll) * lx + cos(roll) * vy)) - Math.atan2(tz, -ty);
    r[idx[0] * 3] = turned;
    r[idx[0] * 3 + 2] = roll;
    for (let j = 1; j <= leg.joints; j++) {
        const b = leg.fold[j - 1] * f;
        r[idx[j] * 3] = b;
        turned += b;
    }
    r[idx[leg.joints + 1] * 3] = pitch - turned - lean;
}

const _cy = { z: 0, lift: 0, swing: 0 };
/**
 * Where a foot is, a fraction `u` of the way through its stride. It is down
 * for the first `duty` of it, going back at a steady speed — the speed of the
 * ground — and then lifted and carried forward, leaving and landing at that
 * same speed so nothing jerks. out.z: 1 as far forward as it reaches … −1 as
 * far back; out.lift: 0 down … 1 at the top; out.swing: 0 while down, else
 * 0 → 1 through the swing.
 */
function footCycle(u, duty, out = _cy) {
    u = fract(u);
    if (u < duty) { out.z = 1 - 2 * u / duty; out.lift = 0; out.swing = 0; return out; }
    const s = (u - duty) / (1 - duty), m = -2 * (1 - duty) / duty, s2 = s * s, s3 = s2 * s;
    out.z = (3 * s2 - 2 * s3) * 2 - 1 + (2 * s3 - 3 * s2 + s) * m;
    out.lift = sin(PI * s) ** 2;
    out.swing = s;
    return out;
}

// 0 most of the time, a quick 0 → 1 → 0 once every `every` seconds or so.
function now_and_then(time, seed, every, length) {
    const k = Math.floor(time / every + seed * 7.3);
    const start = (k + 0.15 + 0.6 * fract(sin(k * 91.7 + seed * 311.1) * 43758.5)) * every;
    const x = (time + seed * 7.3 * every - start) / length;
    return x > 0 && x < 1 ? sin(x * PI) : 0;
}

/**
 * How far a neck and head must turn for the head to come down to feed: the
 * neck bone `n` pitches by the first number and the head bone `h` by the
 * second, which between them tip the head `tip` further nose-down than it is
 * carried and bring the point `muzzle` to height `y`, or as near as it gets.
 */
function feedAngles(model, n, h, muzzle, y, tip) {
    const pn = model.parts[n].pivot, ph = model.parts[h].pivot;
    const height = (tn) => {
        const th = tip - tn;
        const my = ph[1] + cos(th) * (muzzle[1] - ph[1]) - sin(th) * (muzzle[2] - ph[2]);
        const mz = ph[2] + sin(th) * (muzzle[1] - ph[1]) + cos(th) * (muzzle[2] - ph[2]);
        return pn[1] + cos(tn) * (my - pn[1]) - sin(tn) * (mz - pn[2]);
    };
    let best = 0, low = height(0);
    for (let tn = 0.02; tn <= 1.9; tn += 0.02) {
        const v = height(tn);
        if (v < low) { low = v; best = tn; }
        if (v <= y) break;
    }
    return [best, tip - best];
}

// ── Four legs: cow, pig, sheep ───────────────────────────────────────────────

/**
 * A walk and a trot. In the walk each foot comes down in turn — left hind,
 * left fore, right hind, right fore — and three are on the ground most of the
 * time; in the trot the diagonal pairs move together and the body is thrown
 * clear of the ground between them. `run` slides one into the other.
 *
 * Options, px unless said: walk / run: { stride, duty (the fraction of a
 * stride a foot is down), lift, bob, shift (how far behind the hip the middle
 * of a step is) }; feed: [the height the nose comes down to, radians the head
 * tips]; look: how much of a turn of the head the neck takes; tail:
 * how hard it swishes.
 */
function quadruped(model, o) {
    const P = model.index, body = P.body;
    const L = (names, fold, hind, at, opts) => ({ leg: makeLeg(model, names, fold, opts), hind, walk: at[0], trot: at[1] });
    const fore = o.fore ?? [1], back = o.hind ?? [1, -1.1];
    const legs = [
        L(['legBL', 'shinBL', 'hockBL', 'hoofBL'], back, true, [0, 0]),
        L(['legFL', 'kneeFL', 'hoofFL'], fore, false, [0.25, 0.5], { slide: o.slide ?? 1.6 }),
        L(['legBR', 'shinBR', 'hockBR', 'hoofBR'], back, true, [0.5, 0.5]),
        L(['legFR', 'kneeFR', 'hoofFR'], fore, false, [0.75, 1], { slide: o.slide ?? 1.6 }),
    ];
    const feed = feedAngles(model, P.neck, P.head, model.marks.nose, o.feed[0], o.feed[1]);
    const tails = ['tail0', 'tail1', 'tail2'].map(n => P[n]).filter(i => i !== undefined);
    const stretch = o.stretch ?? 0.12;
    const p = [0, 0, 0], q = [0, 0, 0];
    GAITS[model.name] = { walk: o.walk.stride / 16, run: o.run.stride / 16 };
    FEET[model.name] = legs.map(l => model.parts[l.leg.idx[l.leg.joints + 1]].name);

    return (pose, a) => {
        const r = pose.r, t = pose.t;
        const run = a.run, move = a.move, u = a.phase / TAU, ground = 1 - a.air;
        const W = o.walk, T = o.run;
        const duty = lerp(W.duty, T.duty, run);
        const half = lerp(W.stride * W.duty, T.stride * T.duty, run) / 2 * move;
        const lift = lerp(W.lift, T.lift, run) * move;
        const shift = lerp(W.shift ?? 0, T.shift ?? 0, run) * move;

        // The trunk: carried level at a walk, rising and falling with each pair
        // of legs at a trot; it rolls a little over the legs that carry it,
        // sinks at the front to feed, and flinches from a blow.
        const beat = cos(2 * a.phase - 0.5);
        const breath = sin(a.time * 1.5 + a.seed * 9);
        t[body * 3 + 1] = lerp(W.bob, T.bob, run) * beat * move * ground + breath * 0.05 - a.graze * (o.dip ?? 0.4) - a.hurt * 0.5;
        r[body * 3]     = lerp(0.012, 0.03, run) * sin(2 * a.phase + 0.6) * move + a.graze * 0.035 - a.hurt * 0.07 - a.air * 0.12;
        r[body * 3 + 2] = lerp(0.022, 0.012, run) * sin(a.phase + 0.8) * move;
        r[body * 3 + 1] = lerp(0.025, 0.012, run) * sin(a.phase) * move;
        const lean = r[body * 3];

        for (const l of legs) {
            const leg = l.leg, c = footCycle(u + lerp(l.walk, l.trot, run), duty);
            // Where the foot is over the ground …
            p[0] = leg.foot[0];
            p[1] = leg.foot[1] + lift * c.lift;
            p[2] = leg.foot[2] - shift + half * c.z;
            intoBone(model, pose, body, p, p);
            // … or, off it, hanging from the body: forelegs reaching and hind
            // legs trailing in a fall; all four paddling in water.
            if (a.air > 0 || a.swim > 0) {
                const w = a.time * 5.5 + (l.hind ? PI : 0) + (leg.side > 0 ? 0 : PI * 0.9);
                const loose = Math.max(a.air, a.swim), paddle = a.swim * (1 - a.air);
                q[0] = leg.foot[0];
                q[1] = leg.foot[1] + (o.tuck ?? 2) * (l.hind ? 0.7 : 1.1) + paddle * (1.2 + cos(w) * 1.3);
                q[2] = leg.foot[2] + a.air * (l.hind ? -2.2 : 2.2) * (1 - a.swim) + paddle * sin(w) * 2.4;
                for (let k = 0; k < 3; k++) p[k] = lerp(p[k], q[k], loose);
            }
            // A foot in the air hangs from its joint, toe down; one on the ground is level.
            const hang = sin(PI * c.swing) * (l.hind ? 0.55 : 0.8) * move + Math.max(a.air, a.swim) * 0.5;
            placeLeg(leg, pose, p, hang, lean);
        }

        // Neck and head: look about, nod with the stride, reach out at a run,
        // go down to feed and work the jaw.
        const g = a.graze, up = 1 - g;
        const nod = sin(2 * a.phase + 1.4) * lerp(0.035, 0.02, run) * move;
        const share = o.look ?? 0.45;
        r[P.neck * 3]     = a.lookPitch * share * up + g * feed[0] + nod + run * move * stretch - lean;
        r[P.neck * 3 + 1] = a.lookYaw * share * (1 - g * 0.6) + sin(a.time * 0.7 + a.seed * 5) * 0.12 * g;
        r[P.head * 3]     = a.lookPitch * (1 - share) * up + g * feed[1] - nod * 0.6 - run * move * stretch * 0.7;
        r[P.head * 3 + 1] = a.lookYaw * (1 - share) * (1 - g * 0.6);
        r[P.head * 3 + 2] = now_and_then(a.time, a.seed + 0.31, 9, 1.6) * 0.18 * up;
        if (P.jaw !== undefined) {
            // Chewing: the jaw drops and slides across, round and round.
            const chew = Math.max(g, now_and_then(a.time, a.seed + 0.6, 7, 3.5) * (1 - move)) * (o.chew ?? 1);
            r[P.jaw * 3]     = chew * (0.5 + 0.5 * sin(a.time * 8.5)) * 0.16 + a.hurt * 0.25;
            r[P.jaw * 3 + 1] = chew * cos(a.time * 8.5) * 0.06;
        }

        // Ears flick, and lie back when it runs for its life.
        const flickL = now_and_then(a.time, a.seed, 4.3, 0.28), flickR = now_and_then(a.time, a.seed + 0.5, 5.1, 0.28);
        if (P.earL !== undefined) {
            r[P.earL * 3 + 1] = flickL * 0.55 + a.panic * 0.5;
            r[P.earR * 3 + 1] = -flickR * 0.55 - a.panic * 0.5;
            r[P.earL * 3 + 2] = -flickL * 0.2 - a.hurt * 0.3;
            r[P.earR * 3 + 2] = flickR * 0.2 + a.hurt * 0.3;
        }

        // The tail: a swish that runs down it, harder on the move or when
        // struck, and now and then a flick; carried out behind at a run.
        for (let i = 0; i < tails.length; i++) {
            const k = o.tail * (0.5 + move * 0.6 + a.hurt * 2) * (0.7 + i * 0.5);
            r[tails[i] * 3 + 2] = sin(a.time * (2.4 + 3 * move) + a.seed * 20 - i * 0.9) * k
                                + now_and_then(a.time, a.seed + 0.77, 6, 0.9) * k * 2.2 * (i + 1) / tails.length;
            r[tails[i] * 3]     = (i === 0 ? run * move * 0.32 + a.panic * 0.2 : -run * move * 0.1) + sin(a.time * 1.3 + i) * 0.04;
        }
    };
}

// ── Chicken ──────────────────────────────────────────────────────────────────

function chickenAnim(model, o) {
    const P = model.index, body = P.body;
    const legs = [
        { leg: makeLeg(model, ['legL', 'shankL', 'footL'], [-1], { slide: 0.5 }), at: 0 },
        { leg: makeLeg(model, ['legR', 'shankR', 'footR'], [-1], { slide: 0.5 }), at: 0.5 },
    ];
    const p = [0, 0, 0], q = [0, 0, 0];
    GAITS.chicken = { walk: o.walk.stride / 16, run: o.run.stride / 16 };
    FEET.chicken = ['footL', 'footR'];

    return (pose, a) => {
        const r = pose.r, t = pose.t;
        const run = a.run, move = a.move, u = a.phase / TAU, ground = 1 - a.air;
        const W = o.walk, T = o.run;
        const duty = lerp(W.duty, T.duty, run);
        const half = lerp(W.stride * W.duty, T.stride * T.duty, run) / 2 * move;
        const lift = lerp(W.lift, T.lift, run) * move;
        const g = a.graze;

        // The body rides over the leg that is down, and tips forward to peck and to run.
        t[body * 3 + 1] = lerp(0.12, 0.25, run) * cos(2 * a.phase - 0.4) * move * ground - g * 0.25 - a.hurt * 0.3;
        t[body * 3]     = sin(a.phase + 0.6) * 0.18 * move;
        r[body * 3]     = g * 0.5 + run * move * 0.22 - a.air * 0.2 + a.hurt * 0.15;
        r[body * 3 + 2] = sin(a.phase + 0.6) * 0.05 * move;
        const lean = r[body * 3];

        for (const l of legs) {
            const leg = l.leg, c = footCycle(u + l.at, duty);
            p[0] = leg.foot[0];
            p[1] = leg.foot[1] + lift * c.lift;
            p[2] = leg.foot[2] + half * c.z;
            intoBone(model, pose, body, p, p);
            if (a.air > 0 || a.swim > 0) {
                const w = a.time * 9 + l.at * TAU, loose = Math.max(a.air, a.swim);
                q[0] = leg.foot[0];
                q[1] = leg.foot[1] + 0.9 + a.swim * cos(w) * 0.5;
                q[2] = leg.foot[2] - 0.5 * a.air + a.swim * sin(w) * 0.9;
                for (let k = 0; k < 3; k++) p[k] = lerp(p[k], q[k], loose);
            }
            // The toes close and trail as the foot is picked up.
            placeLeg(leg, pose, p, sin(PI * c.swing) * 0.9 * move + a.air * 0.6, lean);
        }

        // The walk of a hen: the head is held still in the air while the body
        // catches it up, then darts forward to its next place, twice a stride.
        // The two bones of the neck turn opposite ways, so the head moves
        // without tipping.
        const dart = (fract(2 * u + 0.15) - 0.5) * 2;                          // −1 → 1, then back at once
        const thrust = -dart * 0.42 * move * (1 - run * 0.6) * (1 - g);
        const peck = g * (0.5 + 0.5 * sin(a.time * 10.5)) ** 2;
        const down = g * 0.75 + peck * 0.55;
        r[P.neck0 * 3]     = thrust + down * 0.9 + a.lookPitch * 0.3 * (1 - g) - lean * 0.6 + run * move * 0.25;
        r[P.neck1 * 3]     = -thrust * 1.1 + down * 0.5 + a.lookPitch * 0.3 * (1 - g) - run * move * 0.15;
        r[P.head * 3]      = -thrust * 0.2 + down * 0.25 + a.lookPitch * 0.4 * (1 - g) - lean * 0.4 - run * move * 0.1;
        r[P.neck1 * 3 + 1] = a.lookYaw * 0.4 * (1 - g);
        r[P.head * 3 + 1]  = a.lookYaw * 0.6 * (1 - g);
        r[P.head * 3 + 2]  = now_and_then(a.time, a.seed + 0.2, 3.1, 0.5) * 0.4 * (1 - g);

        // Wings: folded; a shuffle now and then; out and beating in the air or in a fright.
        const flap = Math.max(a.air, a.panic * 0.75, a.swim * 0.6);
        const beat = (0.5 + 0.5 * sin(a.time * 27)) * flap + now_and_then(a.time, a.seed + 0.7, 6.5, 0.6) * 0.35;
        r[P.wingL * 3 + 2] = beat * 1.25 + flap * 0.25;
        r[P.wingR * 3 + 2] = -beat * 1.25 - flap * 0.25;
        r[P.wingL * 3 + 1] = -flap * 0.2; r[P.wingR * 3 + 1] = flap * 0.2;
        r[P.tail * 3]      = sin(a.time * 3 + a.seed * 9) * 0.05 - g * 0.3 - run * move * 0.15;
        r[P.tail * 3 + 1]  = sin(a.time * 5.5 + a.seed * 4) * 0.1 * (0.3 + move);
    };
}

// ── Fish ─────────────────────────────────────────────────────────────────────

function fishAnim(model) {
    const P = model.index;
    const spine = [P.body, P.rear, P.tail, P.fin], gain = [-0.35, 1, 1.5, 1.9];
    return (pose, a) => {
        const r = pose.r;
        // A wave runs down the body, growing toward the tail; out of water it flops on its side.
        const flop = 1 - a.swim, amp = 0.1 + 0.16 * a.move;
        for (let i = 0; i < 4; i++) {
            r[spine[i] * 3 + 1] = sin(a.phase - i * 0.95) * amp * gain[i] + flop * sin(a.time * 17 - i * 1.2) * 0.35 * (i ? 1 : 0.3);
        }
        r[P.body * 3 + 2] = flop * (1.45 + sin(a.time * 14) * 0.2);
        r[P.body * 3]     = a.lookPitch * 0.3 + sin(a.time * 1.1 + a.seed * 6) * 0.04;
        // The pectoral fins scull, and fold back at speed.
        const scull = sin(a.time * 6.5 + a.seed * 5) * 0.3;
        r[P.finL * 3 + 2] = scull - 0.15;          r[P.finR * 3 + 2] = -scull + 0.15;
        r[P.finL * 3 + 1] = -a.move * 0.55 - 0.1;  r[P.finR * 3 + 1] = a.move * 0.55 + 0.1;
    };
}

// ── Quiddle ──────────────────────────────────────────────────────────────────

/**
 * How a person walks and runs. The feet are placed (heel first, rolling to
 * the toe and pushing off it); the pelvis is lowest as the weight changes
 * legs, swings a hip forward with each step and sways over the standing leg;
 * the shoulders turn against the hips and the arms swing against the legs,
 * straighter behind than in front. Running leans into it, lifts the heels,
 * bends the elbows and leaves the ground between steps.
 */
function quiddleAnim(model, o) {
    const P = model.index, hips = P.hips;
    const legs = [
        { leg: makeLeg(model, ['legL', 'shinL', 'footL'], [1], { slide: 0.3 }), at: 0, side: 1 },
        { leg: makeLeg(model, ['legR', 'shinR', 'footR'], [1], { slide: 0.3 }), at: 0.5, side: -1 },
    ];
    const arms = [
        { up: P.armL, fore: P.foreL, hand: P.handL, fingers: P.fingersL, at: 0, side: 1 },
        { up: P.armR, fore: P.foreR, hand: P.handR, fingers: P.fingersR, at: 0.5, side: -1 },
    ];
    const p = [0, 0, 0], q = [0, 0, 0];
    GAITS.quiddle = { walk: o.walk.stride / 16, run: o.run.stride / 16 };
    FEET.quiddle = ['footL', 'footR'];

    return (pose, a) => {
        const r = pose.r, t = pose.t, s = pose.s;
        const run = a.run, move = a.move, u = a.phase / TAU, ground = 1 - a.air;
        const afloat = a.swim * (1 - a.air), loose = Math.max(a.air, a.swim);
        const W = o.walk, T = o.run;
        const duty = lerp(W.duty, T.duty, run);
        const half = lerp(W.stride * W.duty, T.stride * T.duty, run) / 2 * move;
        const lift = lerp(W.lift, T.lift, run) * move;
        const shift = lerp(W.shift, T.shift, run) * move;
        const swing = cos(a.phase - 0.3);                 // 1 as the left foot lands … −1 as the right does
        const idle = sin(a.time * 1.4 + a.seed * 12);

        // The pelvis. Down as the weight goes from one leg to the other, up over
        // the standing leg (a run turns that round: up is the flight between
        // steps); a hip forward with its leg; a sway toward the leg that stands.
        const beat = cos(2 * a.phase - lerp(3.76, 5.4, run));
        t[hips * 3 + 1] = (lerp(W.bob, T.bob, run) * (beat - 1) * 0.5 - run * 0.5) * move * ground
                        - a.hurt * 0.6 + idle * 0.03 - a.air * 0.3;
        t[hips * 3]     = -sin(a.phase - 0.9) * lerp(0.4, 0.2, run) * move;
        r[hips * 3 + 1] = -swing * lerp(0.08, 0.13, run) * move;
        r[hips * 3 + 2] = -sin(a.phase - 0.9) * 0.035 * move;
        r[hips * 3]     = run * move * 0.08 + afloat * 0.9;
        const lean = r[hips * 3];

        for (const l of legs) {
            const leg = l.leg, c = footCycle(u + l.at, duty);
            // A foot rolls: it lands on its heel, toe up, comes down flat, and
            // over the last part of its time down tips onto its toe to push
            // off. Tipped, it turns about the part of it that is on the ground
            // — the heel, or the ball — so the ankle rides up and over that.
            const down = fract(u + l.at) / duty;
            const push = c.swing > 0 ? 1 - ramp(0, 0.45, c.swing) : ramp(0.62, 1, down);
            const strike = c.swing > 0 ? ramp(0.6, 1, c.swing) : 1 - ramp(0, 0.14, down);
            const tip = (push * lerp(W.toe, T.toe, run) - strike * o.heelUp) * move;
            const on = tip > 0 ? o.ball : o.heel, ct = cos(tip), st = sin(tip);
            p[0] = leg.foot[0];
            p[1] = leg.foot[1] + lift * c.lift + on[0] * (1 - ct) + st * on[1];
            p[2] = leg.foot[2] - shift + half * c.z + on[1] * (1 - ct) - st * on[0];
            intoBone(model, pose, hips, p, p);
            if (loose > 0) {
                const w = a.time * 6 + l.at * TAU;
                q[0] = leg.foot[0] + l.side * a.air * 0.4;
                q[1] = leg.foot[1] + a.air * (l.side > 0 ? 1.2 : 2.4) + afloat * (0.8 + cos(w) * 0.8);
                q[2] = leg.foot[2] + a.air * (l.side > 0 ? 1.5 : -1.2) + afloat * sin(w) * 2.6;
                for (let k = 0; k < 3; k++) p[k] = lerp(p[k], q[k], loose);
            }
            placeLeg(leg, pose, p, tip * (1 - loose) + loose * 0.5, lean);
        }

        // The trunk above the waist: turned against the hips, leaning into a
        // run, upright again over a pelvis that has tipped; it breathes.
        r[P.torso * 3 + 1] = swing * lerp(0.15, 0.24, run) * move;
        r[P.torso * 3]     = move * lerp(0.03, 0.2, run) - a.hurt * 0.25 + idle * 0.008 - afloat * 0.55;
        r[P.torso * 3 + 2] = sin(a.phase - 0.9) * 0.03 * move;
        t[P.torso * 3 + 1] = idle * 0.03;

        // Arms. Each swings against the leg on its own side, from the shoulder,
        // the elbow closing as the hand comes forward. At rest they hang, a
        // little bent, hands by the thighs.
        for (const m of arms) {
            const sw = cos(a.phase - 0.3 + m.at * TAU) * move;                       // 1 with the leg of this side forward
            let sh = sw * lerp(0.42, 0.95, run) + run * move * 0.15;                 // + is back
            let out = m.side * (0.06 + idle * 0.012 + run * move * 0.1);
            let el = -(0.16 + lerp(0.12, 1.25, run) * move + Math.max(0, -sw) * lerp(0.3, 0.45, run));
            // Hands hang half open, close to run, and make a fist to strike or when hurt.
            let grip = 0.1 + idle * 0.04 + run * move * 0.9 + a.hurt * 0.6 + afloat * -0.1;
            if (a.air > 0) {                       // falling: out and up for balance
                sh = lerp(sh, -0.9 + m.side * 0.2, a.air); out += m.side * a.air * 0.7; el = lerp(el, -0.5, a.air);
            }
            if (afloat > 0) {                      // swimming: a crawl, one arm after the other
                const w = a.time * 4.2 + m.at * TAU;
                sh = lerp(sh, -1.9 + sin(w) * 1.1, afloat);
                el = lerp(el, -0.5 - 0.4 * cos(w), afloat);
                out += m.side * afloat * 0.25;
            }
            if (a.hurt > 0) { sh -= a.hurt * 0.5; out += m.side * a.hurt * 0.35; el -= a.hurt * 0.6; }
            if (m.side < 0 && a.attack > 0) {
                // A blow with the right hand: drawn back past the shoulder with
                // the elbow cocked, then thrown forward and straightened.
                const k = a.attack, back = 1 - ramp(0.25, 0.45, k), thrown = ramp(0.25, 0.5, k) * (1 - ramp(0.75, 1, k));
                const on = ramp(0, 0.12, k) * (1 - ramp(0.85, 1, k));
                sh = lerp(sh, back * 0.7 - thrown * 1.75, on);
                el = lerp(el, -(back * 1.9 + thrown * 0.25 + 0.15), on);
                out = lerp(out, -0.25 - thrown * 0.1, on);
                grip = lerp(grip, 1.3, on);
                // The shoulders turn into it.
                r[P.torso * 3 + 1] += on * (ramp(0.25, 0.5, k) * 0.75 - 0.35);
            }
            r[m.up * 3] = sh; r[m.up * 3 + 2] = out;
            r[m.fore * 3] = el;
            r[m.hand * 3] = el * 0.12;
            r[m.fingers * 3 + 2] = -m.side * grip;
        }

        // The head stays on what it is looking at whatever the body does.
        r[P.head * 3]     = a.lookPitch - r[P.torso * 3] * 0.8 - lean * 0.8 + cos(2 * a.phase) * 0.012 * move + a.hurt * 0.2;
        r[P.head * 3 + 1] = a.lookYaw - r[P.torso * 3 + 1] - r[hips * 3 + 1];
        r[P.head * 3 + 2] = now_and_then(a.time, a.seed + 0.13, 11, 2.2) * 0.12 - r[P.torso * 3 + 2];

        // A blink every few seconds; eyes shut when hurt.
        const blink = Math.max(now_and_then(a.time, a.seed, 3.7, 0.16), a.hurt > 0.5 ? 1 : 0);
        s[P.lids] = blink > 0.5 ? 1 : 0;

        // Long hair hangs straight whatever the head does, and streams back on the move.
        if (P.hairBack !== undefined) {
            r[P.hairBack * 3] = -r[P.head * 3] * 0.8 - r[P.torso * 3] * 0.6 + move * lerp(0.12, 0.5, run)
                              + sin(a.time * 2.1 + a.seed * 3) * 0.025 + beat * 0.04 * move;
            r[P.hairBack * 3 + 2] = sin(a.phase) * 0.05 * move;
        }
    };
}

// ── The animators ────────────────────────────────────────────────────────────

ANIMATORS.cow = quadruped(MODELS.cow, {
    walk: { stride: 21, duty: 0.63, lift: 2.4, bob: 0.12, shift: 0.6 },
    run:  { stride: 32, duty: 0.42, lift: 4.2, bob: 0.55, shift: 0.6 },
    feed: [1.3, 0.45], tail: 0.16,
});
ANIMATORS.pig = quadruped(MODELS.pig, {
    walk: { stride: 12, duty: 0.6, lift: 1.3, bob: 0.08, shift: 0.3 },
    run:  { stride: 21, duty: 0.4, lift: 2.3, bob: 0.4, shift: 0.3 },
    feed: [0.5, 0.3], tail: 0.35, look: 0.35, slide: 1.2, stretch: 0.05, tuck: 1.2, dip: 0.6,
});
ANIMATORS.sheep = quadruped(MODELS.sheep, {
    walk: { stride: 14, duty: 0.62, lift: 1.7, bob: 0.1, shift: 0.4 },
    run:  { stride: 24, duty: 0.42, lift: 3.0, bob: 0.5, shift: 0.4 },
    feed: [1.0, 0.5], tail: 0.3, tuck: 1.6,
});
ANIMATORS.chicken = chickenAnim(MODELS.chicken, {
    walk: { stride: 6.4, duty: 0.58, lift: 0.8 },
    run:  { stride: 10.5, duty: 0.4, lift: 1.3 },
});
ANIMATORS.fish = fishAnim(MODELS.fish);
ANIMATORS.quiddle = quiddleAnim(MODELS.quiddle, {
    walk: { stride: 22, duty: 0.6, lift: 0.7, bob: 0.8, shift: 1.5, toe: 0.6 },
    run:  { stride: 38, duty: 0.36, lift: 3.0, bob: 1.3, shift: 2.2, toe: 0.85 },
    // Where the ball of the foot and the heel are from the ankle, px down and
    // forward; and how far the toe is up as the heel lands, radians.
    ball: [-1.43, 2.7], heel: [-1.42, -0.6], heelUp: 0.28,
});
