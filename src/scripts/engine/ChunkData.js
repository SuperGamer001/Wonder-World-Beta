export const CHUNK_SIZE   = 32;
export const CHUNK_SHIFT  = 5;           // log2(CHUNK_SIZE)
export const CHUNK_MASK   = 0x1F;        // CHUNK_SIZE - 1
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE; // 32768

// Packs local (0-31) coords into a flat array index.
// Layout: x in bits 0-4, y in bits 5-9, z in bits 10-14.
export function voxelIndex(lx, ly, lz) {
    return lx | (ly << CHUNK_SHIFT) | (lz << (CHUNK_SHIFT * 2));
}

// Unpacks a flat index back to local coords.
export function voxelCoords(idx) {
    return {
        lx: idx & CHUNK_MASK,
        ly: (idx >> CHUNK_SHIFT)          & CHUNK_MASK,
        lz: (idx >> (CHUNK_SHIFT * 2))    & CHUNK_MASK,
    };
}

export class ChunkData {
    constructor(cx, cy, cz) {
        this.cx = cx;
        this.cy = cy;
        this.cz = cz;

        // Uint16 supports up to 65 535 block IDs — plenty of future headroom.
        this.voxels = new Uint16Array(CHUNK_VOLUME);

        this.generated = false;  // terrain pass complete
        this.meshed    = false;  // geometry sent to main thread at least once
        this.dirty     = false;  // needs re-mesh (block modified after initial mesh)

        // Three.js Mesh handles, owned by world.js — null until first mesh upload.
        this.mesh            = null;
        this.transparentMesh = null;
    }

    getVoxel(lx, ly, lz) {
        return this.voxels[voxelIndex(lx, ly, lz)];
    }

    setVoxel(lx, ly, lz, id) {
        this.voxels[voxelIndex(lx, ly, lz)] = id;
        this.dirty = true;
    }

    // World-space origin (bottom-south-west corner) of this chunk.
    get worldX() { return this.cx << CHUNK_SHIFT; }
    get worldY() { return this.cy << CHUNK_SHIFT; }
    get worldZ() { return this.cz << CHUNK_SHIFT; }
}
