const CHUNK_SIZE = 16;

self.onmessage = (event) => {
    const data = event.data;

    if (data.type === "generateMesh") {
        const meshData = generateMesh(
            data.blockData,
            data.neighborBlocks
        );

        self.postMessage({
            type: "meshGenerated",
            meshData
        });
    }
};

function index(x, y, z) {
    return x +
        y * CHUNK_SIZE +
        z * CHUNK_SIZE * CHUNK_SIZE;
}

function generateMesh(blocks, neighbors) {

    const vertices = [];
    const indices = [];

    let vertexIndex = 0;

    function getBlock(x, y, z) {

        if (
            x >= 0 &&
            x < CHUNK_SIZE &&
            y >= 0 &&
            y < CHUNK_SIZE &&
            z >= 0 &&
            z < CHUNK_SIZE
        ) {
            return blocks[index(x, y, z)];
        }

        if (x < 0 && neighbors.nx)
            return neighbors.nx[index(CHUNK_SIZE - 1, y, z)];

        if (x >= CHUNK_SIZE && neighbors.px)
            return neighbors.px[index(0, y, z)];

        if (y < 0 && neighbors.ny)
            return neighbors.ny[index(x, CHUNK_SIZE - 1, z)];

        if (y >= CHUNK_SIZE && neighbors.py)
            return neighbors.py[index(x, 0, z)];

        if (z < 0 && neighbors.nz)
            return neighbors.nz[index(x, y, CHUNK_SIZE - 1)];

        if (z >= CHUNK_SIZE && neighbors.pz)
            return neighbors.pz[index(x, y, 0)];

        return 1;
    }

    function addQuad(v0, v1, v2, v3) {

        vertices.push(...v0);
        vertices.push(...v1);
        vertices.push(...v2);
        vertices.push(...v3);

        indices.push(
            vertexIndex,
            vertexIndex + 1,
            vertexIndex + 2,

            vertexIndex + 2,
            vertexIndex + 1,
            vertexIndex + 3
        );

        vertexIndex += 4;
    }

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y < CHUNK_SIZE; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {

                const block = getBlock(x, y, z);

                if (block === 0)
                    continue;

                // LEFT
                if (getBlock(x - 1, y, z) === 0) {
                    addQuad(
                        [x, y, z],
                        [x, y + 1, z],
                        [x, y, z + 1],
                        [x, y + 1, z + 1]
                    );
                }

                // RIGHT
                if (getBlock(x + 1, y, z) === 0) {
                    addQuad(
                        [x + 1, y, z + 1],
                        [x + 1, y + 1, z + 1],
                        [x + 1, y, z],
                        [x + 1, y + 1, z]
                    );
                }

                // BOTTOM
                if (getBlock(x, y - 1, z) === 0) {
                    addQuad(
                        [x, y, z + 1],
                        [x + 1, y, z + 1],
                        [x, y, z],
                        [x + 1, y, z]
                    );
                }

                // TOP
                if (getBlock(x, y + 1, z) === 0) {
                    addQuad(
                        [x, y + 1, z],
                        [x + 1, y + 1, z],
                        [x, y + 1, z + 1],
                        [x + 1, y + 1, z + 1]
                    );
                }

                // BACK
                if (getBlock(x, y, z - 1) === 0) {
                    addQuad(
                        [x + 1, y, z],
                        [x + 1, y + 1, z],
                        [x, y, z],
                        [x, y + 1, z]
                    );
                }

                // FRONT
                if (getBlock(x, y, z + 1) === 0) {
                    addQuad(
                        [x, y, z + 1],
                        [x, y + 1, z + 1],
                        [x + 1, y, z + 1],
                        [x + 1, y + 1, z + 1]
                    );
                }
            }
        }
    }

    return {
        vertices,
        indices
    };
}