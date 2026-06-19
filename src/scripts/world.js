// World.js - Handles the 3D world rendering and logic using Three.js
import * as THREE from "three";

let scene, camera, renderer, light;

const CHUNK_SIZE = 16;
const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
const BLOCK_TYPES = {
    0: { name: "Air", solid: false },

    1: { name: "Stone", solid: true },
    2: { name: "Dirt", solid: true },
    3: { name: "Grass", solid: true },
    4: { name: "Bedrock", solid: true }
};

const RENDER_DISTANCE = 10;

let lastPlayerChunk = {
    x: null,
    y: null,
    z: null
};

const chunkMaterial =
    new THREE.MeshLambertMaterial({
        color: 0xaaaaaa
    });

const WORKERS_COUNT = 4;
const workers = [];
for (let i = 0; i < WORKERS_COUNT; i++) {
    let newWorker = new Worker("src/scripts/meshWorker.js");
    workers.push({ worker: newWorker, busy: false });
    // Send a special message to the worker to let it know which block types are solid and what materials to use for them. This will allow the worker to generate the mesh for the chunk based on the block data and the neighboring chunks.
    newWorker.postMessage({ type: "init", blockTypes: BLOCK_TYPES });
}


class Chunk {
    constructor(x, y, z) {
        this.position = { x, y, z };
        this.blocks = new Uint8Array(CHUNK_VOLUME); // Placeholder for block data
        this.mesh = null; // Placeholder for the chunk's mesh
    }

    unload() {
        if (this.mesh) {
            scene.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.mesh = null;
        }
    }

    async generateMesh() {

        const meshData =
            await callNextAvailableWorker(
                this.blocks,
                this.getNeighboringChunks()
            );

        const geometry =
            new THREE.BufferGeometry();

        geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(
                meshData.vertices,
                3
            )
        );

        geometry.setIndex(meshData.indices);

        geometry.computeVertexNormals();

        const newMesh =
            new THREE.Mesh(
                geometry,
                chunkMaterial
            );

        newMesh.position.set(
            this.position.x * CHUNK_SIZE,
            this.position.y * CHUNK_SIZE,
            this.position.z * CHUNK_SIZE
        );

        if (this.mesh) {
            scene.remove(this.mesh);
            this.mesh.geometry.dispose();
        }

        this.mesh = newMesh;

        scene.add(this.mesh);
    }  

    getNeighboringChunks() {

        const result = {
            nx: null,
            px: null,
            ny: null,
            py: null,
            nz: null,
            pz: null
        };

        result.nx =
            World.chunks.get(
                `${this.position.x - 1},${this.position.y},${this.position.z}`
            )?.blocks ?? null;

        result.px =
            World.chunks.get(
                `${this.position.x + 1},${this.position.y},${this.position.z}`
            )?.blocks ?? null;

        result.ny =
            World.chunks.get(
                `${this.position.x},${this.position.y - 1},${this.position.z}`
            )?.blocks ?? null;

        result.py =
            World.chunks.get(
                `${this.position.x},${this.position.y + 1},${this.position.z}`
            )?.blocks ?? null;

        result.nz =
            World.chunks.get(
                `${this.position.x},${this.position.y},${this.position.z - 1}`
            )?.blocks ?? null;

        result.pz =
            World.chunks.get(
                `${this.position.x},${this.position.y},${this.position.z + 1}`
            )?.blocks ?? null;

        return result;
    }
}


async function callNextAvailableWorker(
    blockData,
    neighborBlocks
) {

    return new Promise((resolve) => {

        const check = () => {

            const workerWrapper =
                workers.find(w => !w.busy);

            if (!workerWrapper) {
                setTimeout(check, 1);
                return;
            }

            workerWrapper.busy = true;

            workerWrapper.worker.onmessage =
                (event) => {

                    workerWrapper.busy = false;

                    resolve(event.data.meshData);
                };

            workerWrapper.worker.postMessage({
                type: "generateMesh",
                blockData,
                neighborBlocks
            });
        };

        check();
    });
}


const World = {
    chunks: new Map(),  

    modifyBlock(x, y, z, blockID) {
        const chunkX = Math.floor(x / CHUNK_SIZE);
        const chunkY = Math.floor(y / CHUNK_SIZE);
        const chunkZ = Math.floor(z / CHUNK_SIZE);
        const chunkKey = `${chunkX},${chunkY},${chunkZ}`;
        const chunk = this.chunks.get(chunkKey);
        if (chunk) {
            const localX = x - chunkX * CHUNK_SIZE;
            const localY = y - chunkY * CHUNK_SIZE;
            const localZ = z - chunkZ * CHUNK_SIZE;
            const index = localX + localY * CHUNK_SIZE + localZ * CHUNK_SIZE * CHUNK_SIZE;
            chunk.blocks[index] = blockID;
            chunk.generateMesh();
        }
    },

    generateChunk(x, y, z) {
        // Placeholder for world generation logic
        // This will create chunks and populate them with blocks based on some algorithm (e.g., Perlin noise)
        // For simplicity, we'll just create a flat world with:
        // - bedrock at Y = -126
        // - stone from Y = -125 to Y = -4
        // - dirt from Y = -3 to Y = -1
        // - grass at Y = 0, with the rest being air.


        // First: Create the chunk.
        const chunk = new Chunk(x, y, z);

        // Then: Populate the chunk with blocks based on the Y level.
        for (let localX = 0; localX < CHUNK_SIZE; localX++) {
            for (let localY = 0; localY < CHUNK_SIZE; localY++) {
                for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
                    const worldX = x * CHUNK_SIZE + localX;
                    const worldY = y * CHUNK_SIZE + localY;
                    const worldZ = z * CHUNK_SIZE + localZ;
                    let blockID = 0; // Air
                    if (worldY < -126) {
                        blockID = 1; // Bedrock
                    } else if (worldY >= -125 && worldY <= -4) {
                        blockID = 2; // Stone
                    } else if (worldY >= -3 && worldY <= -1) {
                        blockID = 3; // Dirt
                    } else if (worldY === 0) {
                        blockID = 4; // Grass
                    }
                    chunk.blocks[localX + localY * CHUNK_SIZE + localZ * CHUNK_SIZE * CHUNK_SIZE] = blockID;
                }
            }
        }

        this.chunks.set(`${x},${y},${z}`, chunk);

        chunk.generateMesh();
    },

    updateLoadedChunks(playerX, playerY, playerZ) {

        const centerChunkX = Math.floor(playerX / CHUNK_SIZE);
        const centerChunkY = Math.floor(playerY / CHUNK_SIZE);
        const centerChunkZ = Math.floor(playerZ / CHUNK_SIZE);

        // Generate nearby chunks
        for (let x = centerChunkX - RENDER_DISTANCE; x <= centerChunkX + RENDER_DISTANCE; x++) {
            for (let z = centerChunkZ - RENDER_DISTANCE; z <= centerChunkZ + RENDER_DISTANCE; z++) {

                // Flat world for now
                const y = 0;

                const key = `${x},${y},${z}`;

                if (!this.chunks.has(key)) {
                    this.generateChunk(x, y, z);
                }
            }
        }

        // Unload distant chunks
        for (const [key, chunk] of this.chunks.entries()) {

            const dx = chunk.position.x - centerChunkX;
            const dz = chunk.position.z - centerChunkZ;

            if (
                Math.abs(dx) > RENDER_DISTANCE + 1 ||
                Math.abs(dz) > RENDER_DISTANCE + 1
            ) {
                chunk.unload();
                this.chunks.delete(key);
            }
        }
    }


}


























































































const worldTick = () => {

    if (!me || me.health <= 0)
        return;

    const chunkX = Math.floor(me.position.x / CHUNK_SIZE);
    const chunkY = Math.floor(me.position.y / CHUNK_SIZE);
    const chunkZ = Math.floor(me.position.z / CHUNK_SIZE);

    if (
        chunkX !== lastPlayerChunk.x ||
        chunkY !== lastPlayerChunk.y ||
        chunkZ !== lastPlayerChunk.z
    ) {

        lastPlayerChunk.x = chunkX;
        lastPlayerChunk.y = chunkY;
        lastPlayerChunk.z = chunkZ;

        World.updateLoadedChunks(
            me.position.x,
            me.position.y,
            me.position.z
        );
    }

    camera.position.x = me.position.x;
    camera.position.y = me.position.y + 1.5;
    camera.position.z = me.position.z;
};

document.addEventListener("DOMContentLoaded", () => {
    let canvas = document.getElementById("gameCanvas");

    // Prepare Three.js scene, camera, and renderer
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB);
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });

    renderer.setSize(window.innerWidth, window.innerHeight);

    let light = new THREE.DirectionalLight(0xffffff, 1, 0);

    camera.position.z = 5;
    scene.add(light);
});

// Begin world gen and loading when the "WorldJS_startWorldLoad" event is fired
document.addEventListener("WorldJS_startWorldLoad", () => {

    me.position = {
        x: 0,
        y: 1.01,
        z: 0
    };

    World.updateLoadedChunks(
        me.position.x,
        me.position.y,
        me.position.z
    );

    camera.position.x = me.position.x;
    camera.position.y = me.position.y + 1.5;
    camera.position.z = me.position.z;
});

// Listen for the "WorldJS_quitWorld" event to clean up Three.js resources
document.addEventListener("WorldJS_quitWorld", () => {
    // Clean up Three.js resources
    if (renderer) {
        renderer.dispose();
    }
});

// Listen for the "WorldJS_tick" event to update the world and render the scene
document.addEventListener("WorldJS_tick", () => {

    worldTick();

    renderer.render(
        scene,
        camera
    );
});

// Prevent the context menu from appearing on right-click
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Detect when the window is resized and adjust the camera and renderer accordingly
window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});