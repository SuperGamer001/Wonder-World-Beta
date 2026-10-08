/**
 * MeshFormat — how a chunk mesh's vertices are packed (shared by the meshers,
 * which pack them, and the shaders that draw them).
 *
 * A vertex is 24 bytes:
 *   position  3 × float32   chunk-local
 *   tint      4 × uint8     a: the texture layer, NO_LAYER for an untextured face.
 *                           r g b: an untextured face's colour. A textured face
 *                           has none of its own, so there they say how it blends
 *                           with the ground around it (GreedyMesher.blendCode):
 *                             r  the texture layer that spreads over its edges
 *                             g  from which of the eight sides, a bit each (0: none)
 *                             b  255 on natural ground, which also gets a little
 *                                large-scale variation in the shader; else 0
 *   uv        2 × uint16    tile coordinates × UV_SCALE (they run 0 … world height)
 *   nrm       4 × int8      surface normal × 127, and the block's glow
 * and indices are 16-bit wherever a mesh has few enough vertices.
 *
 * It used to be 40 bytes — colour, layer and uv as floats — with 32-bit
 * indices throughout, and chunk geometry was by far the most memory the game
 * held: about 560 KB a chunk, 470 MB at render distance 14, all of it on the
 * GPU (which on integrated graphics is the machine's own RAM).
 *
 * Every attribute is a format Direct3D has natively (normalised bytes and
 * shorts), so ANGLE uploads them as they are. A non-normalised integer
 * attribute read as a float is not: that one would be converted to floats on
 * the CPU at every upload.
 */

/** uv is stored × this. 448 (the world height) × 128 still fits 16 bits; 1/128 of a block is 1/8 of a texel at 16 px. */
export const UV_SCALE = 128;

/** The tint's layer byte for a face with no texture. Layers 0 … 254 are addressable. */
export const NO_LAYER = 255;

/** Most vertices a mesh may have and still use 16-bit indices (65535 itself is WebGL 2's primitive-restart index). */
export const MAX_INDEX16_VERTS = 65535;

/**
 * Vertex-shader GLSL: declares `tint` and unpacks it and Three.js's `uv`.
 * A geometry with no `tint` attribute (a mob in the shadow pass) reads the
 * default (0, 0, 0, 1): alpha 1, so no texture.
 */
export const MESH_VERT_GLSL = `
in vec4 tint;   // rgb block colour, a texture layer — bytes, normalised by the GPU
float tintLayer() { return tint.a > 0.998 ? -1.0 : floor(tint.a * 255.0 + 0.5); }
vec2  tileUV()    { return uv * ${(65535 / UV_SCALE).toFixed(8)}; }
`;

/**
 * Pack a mesher's float colours (r g b per vertex, or the blend bytes / 255
 * of a textured face) and layers (one per vertex, −1 = none) into the tint bytes.
 */
export function packTints(colors, layers, count) {
    const out = new Uint8Array(count * 4);
    for (let v = 0, c = 0, o = 0; v < count; v++, c += 3, o += 4) {
        const r = colors[c], g = colors[c + 1], b = colors[c + 2], l = layers[v];
        out[o]     = r >= 1 ? 255 : r <= 0 ? 0 : r * 255 + 0.5;
        out[o + 1] = g >= 1 ? 255 : g <= 0 ? 0 : g * 255 + 0.5;
        out[o + 2] = b >= 1 ? 255 : b <= 0 ? 0 : b * 255 + 0.5;
        out[o + 3] = l < 0 || l >= NO_LAYER ? NO_LAYER : l;
    }
    return out;
}

/** Pack a mesher's float uvs (`n` values) to 16 bits. */
export function packUVs(uvs, n) {
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
        const u = uvs[i] * UV_SCALE + 0.5;
        out[i] = u >= 65535 ? 65535 : u <= 0 ? 0 : u;
    }
    return out;
}

/** The first `n` indices, as 16-bit where `vertexCount` allows. */
export function packIndices(indices, n, vertexCount) {
    const view = indices.subarray(0, n);
    return vertexCount <= MAX_INDEX16_VERTS ? new Uint16Array(view) : view.slice();
}
