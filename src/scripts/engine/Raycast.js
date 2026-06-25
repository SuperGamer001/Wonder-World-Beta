/**
 * Raycast — DDA voxel traversal.
 *
 * Finds the first solid (non-passable) block hit by a ray from `origin`
 * in direction `dir` within `maxDist` blocks.
 *
 * Returns { x, y, z, blockId, face: {x,y,z} } or null.
 * `face` is the integer normal of the hit face (points back toward the ray origin).
 */
export function raycast(worldState, registry, origin, dir, maxDist = 6) {
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

    while (Math.min(tMaxX, tMaxY, tMaxZ) <= maxDist) {
        if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
            ix += stepX;  face = { x: -stepX, y: 0, z: 0 };  tMaxX += tDX;
        } else if (tMaxY <= tMaxZ) {
            iy += stepY;  face = { x: 0, y: -stepY, z: 0 };  tMaxY += tDY;
        } else {
            iz += stepZ;  face = { x: 0, y: 0, z: -stepZ };  tMaxZ += tDZ;
        }

        const id = worldState.getBlock(ix, iy, iz);
        if (id > 0 && !registry.isNoCollision(id)) {
            return { x: ix, y: iy, z: iz, blockId: id, face };
        }
    }
    return null;
}
