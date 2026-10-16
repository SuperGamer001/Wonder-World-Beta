/**
 * Raycast — DDA voxel traversal.
 *
 * Finds the first targetable block (BlockRegistry.isTargetable: anything
 * solid, plus torches and lanterns) hit by a ray from `origin` in direction
 * `dir` within `maxDist` blocks.
 *
 * A voxel is not always a cube: in a smooth world a Mesh voxel is cut to a
 * shape. `inside(x, y, z)`, if given, says whether a point is in what is
 * drawn of the voxel it lies in; a targetable voxel is then only hit where
 * the ray, on its way through it, comes to such a point — so the ray passes
 * over the cut-away part of a slope to what lies behind it.
 *
 * Returns { x, y, z, blockId, face: {x,y,z}, t } or null.
 * `face` is the integer normal of the face the ray came in by (points back
 * toward the ray origin); `t` is how far along the ray the hit is.
 */
const STEP = 0.04;      // blocks between the points tried inside a voxel

export function raycast(worldState, registry, origin, dir, maxDist = 6, inside = null) {
    const { x: ox, y: oy, z: oz } = origin;
    const { x: dx, y: dy, z: dz } = dir;

    if (dx === 0 && dy === 0 && dz === 0) return null;

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    let ix = Math.floor(ox);
    let iy = Math.floor(oy);
    let iz = Math.floor(oz);

    const tDX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

    let tMaxX = dx > 0 ? (ix + 1 - ox) * tDX : (ox - ix) * tDX;
    let tMaxY = dy > 0 ? (iy + 1 - oy) * tDY : (oy - iy) * tDY;
    let tMaxZ = dz > 0 ? (iz + 1 - oz) * tDZ : (oz - iz) * tDZ;

    let face = null;

    // The voxel the ray starts in: a ladder, an open door or a plant the
    // player is standing in can be met (a cube they are inside cannot).
    if (inside) {
        const id = worldState.getBlock(ix, iy, iz);
        if (id > 0 && registry.isTargetable(id) && registry.hasModel?.(id)) {
            const t1 = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);
            for (let t = STEP; t < t1; t += STEP) {
                if (!inside(ox + dx * t, oy + dy * t, oz + dz * t)) continue;
                // It is met from the side the look comes from: the axis it runs along most.
                const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
                const f = ax >= ay && ax >= az ? { x: -stepX, y: 0, z: 0 } : ay >= az ? { x: 0, y: -stepY, z: 0 } : { x: 0, y: 0, z: -stepZ };
                return { x: ix, y: iy, z: iz, blockId: id, face: f, t, within: true };
            }
        }
    }

    while (Math.min(tMaxX, tMaxY, tMaxZ) <= maxDist) {
        // Where the ray comes into the next voxel …
        const t0 = Math.min(tMaxX, tMaxY, tMaxZ);
        if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
            ix += stepX;  face = { x: -stepX, y: 0, z: 0 };  tMaxX += tDX;
        } else if (tMaxY <= tMaxZ) {
            iy += stepY;  face = { x: 0, y: -stepY, z: 0 };  tMaxY += tDY;
        } else {
            iz += stepZ;  face = { x: 0, y: 0, z: -stepZ };  tMaxZ += tDZ;
        }

        const id = worldState.getBlock(ix, iy, iz);
        if (id > 0 && registry.isTargetable(id)) {
            if (!inside) return { x: ix, y: iy, z: iz, blockId: id, face, t: t0 };
            // … and where it leaves: is anything of the voxel on the way between?
            const t1 = Math.min(tMaxX, tMaxY, tMaxZ, maxDist);
            for (let t = t0 + 1e-3; t < t1; t += STEP) {
                if (inside(ox + dx * t, oy + dy * t, oz + dz * t)) return { x: ix, y: iy, z: iz, blockId: id, face, t };
            }
        }
    }
    return null;
}
