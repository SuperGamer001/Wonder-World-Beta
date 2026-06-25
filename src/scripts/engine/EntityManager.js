/**
 * EntityManager — mob spawning, AI, Three.js rendering, and dropped-item management.
 *
 * Mob visual: a simple colored box (body) + smaller box (head) per entity.
 * Dropped items: rotating glowing cubes that auto-pickup on proximity.
 */

import * as THREE from 'three';
import { WORLD_MIN_Y } from './ChunkData.js';

const SPAWN_RADIUS  = 32;   // chunks from player to attempt spawn
const DESPAWN_RADIUS= 80;   // blocks from player to despawn
const PICKUP_RADIUS = 1.5;  // blocks from player to auto-pickup
const GRAVITY       = -18;  // m/s²
const SPAWN_INTERVAL= 8;    // seconds between spawn attempts
const MAX_MOBS      = 24;   // hard cap per world
const ITEM_LIFETIME = 300;  // seconds before dropped items expire

let _nextId = 0;

function uid() { return ++_nextId; }

export class EntityManager {
    /**
     * @param {WorldState}    worldState
     * @param {BlockRegistry} blockRegistry
     * @param {ItemRegistry}  itemRegistry
     * @param {THREE.Scene}   scene
     */
    constructor(worldState, blockRegistry, itemRegistry, scene) {
        this.world    = worldState;
        this.blkReg   = blockRegistry;
        this.itemReg  = itemRegistry;
        this.scene    = scene;

        this._types   = new Map();   // typeId -> definition
        this._mobs    = new Map();   // id -> mob instance
        this._drops   = [];          // { id, pos, vel, itemId, count, mesh, age }
        this._spawnT  = 0;
        this._biomeData = [];        // from gamepack
    }

    loadEntityTypes(entities) {
        for (const def of entities) this._types.set(def.id, def);
    }

    setBiomeData(biomes) { this._biomeData = biomes; }

    // ── Main update ───────────────────────────────────────────────────────────

    update(dt, playerPos, inventory, gameMode) {
        this._spawnT += dt;
        if (this._spawnT >= SPAWN_INTERVAL) {
            this._spawnT = 0;
            if (gameMode !== 'SPECTATOR') this._trySpawn(playerPos);
        }

        this._updateMobs(dt, playerPos, gameMode);
        this._updateDrops(dt, playerPos, inventory, gameMode);
    }

    // ── Mob spawning ──────────────────────────────────────────────────────────

    _trySpawn(playerPos) {
        if (this._mobs.size >= MAX_MOBS) return;

        for (const [typeId, def] of this._types) {
            if (Math.random() > 0.25) continue;
            const rules = def.spawnRules ?? {};
            // Random position within spawn radius
            const angle = Math.random() * Math.PI * 2;
            const dist  = 20 + Math.random() * (SPAWN_RADIUS - 20);
            const sx = Math.floor(playerPos.x + Math.cos(angle) * dist);
            const sz = Math.floor(playerPos.z + Math.sin(angle) * dist);

            // Find ground at this XZ
            let sy = null;
            for (let y = Math.floor(playerPos.y) + 10; y > WORLD_MIN_Y; y--) {
                const id  = this.world.getBlock(sx, y, sz);
                const idy = this.world.getBlock(sx, y - 1, sz);
                if (id === 0 && idy !== 0 && !this.blkReg.isNoCollision(idy)) {
                    // Check Y range
                    if (rules.minY !== undefined && y < rules.minY) break;
                    if (rules.maxY !== undefined && y > rules.maxY) break;
                    // Check spawn in water
                    const needsWater = def.aquatic ?? false;
                    const isWater = this.blkReg.isLiquid(idy);
                    if (needsWater !== isWater) break;
                    sy = y;
                    break;
                }
            }
            if (sy === null) continue;

            const count = 1 + Math.floor(Math.random() * ((rules.maxGroupSize ?? 1) - (rules.minGroupSize ?? 1) + 1));
            for (let i = 0; i < count; i++) {
                if (this._mobs.size >= MAX_MOBS) break;
                const spread = (rules.minGroupSize ?? 1) > 1 ? (Math.random() - 0.5) * 8 : 0;
                this._spawnMob(typeId, { x: sx + spread, y: sy, z: sz + spread });
            }
        }
    }

    _spawnMob(typeId, pos) {
        const def = this._types.get(typeId);
        if (!def) return;
        const id   = uid();
        const mesh = this._buildMesh(def);
        mesh.position.set(pos.x, pos.y, pos.z);
        this.scene.add(mesh);

        this._mobs.set(id, {
            id, typeId,
            pos:   { ...pos },
            vel:   { x: 0, y: 0, z: 0 },
            health: def.health ?? 10,
            maxHealth: def.health ?? 10,
            onGround: false,
            state: 'IDLE',
            wanderTarget: null,
            stateTimer: 0,
            mesh,
            def,
        });
        return id;
    }

    // ── Mob AI + physics ──────────────────────────────────────────────────────

    _updateMobs(dt, playerPos, gameMode) {
        for (const [id, mob] of this._mobs) {
            const dx = mob.pos.x - playerPos.x;
            const dz = mob.pos.z - playerPos.z;
            const dist2 = dx * dx + dz * dz;

            // Despawn if too far
            if (dist2 > DESPAWN_RADIUS * DESPAWN_RADIUS) {
                this._removeMob(id);
                continue;
            }

            mob.stateTimer -= dt;
            this._updateAI(mob, dt, playerPos);
            this._physicsStep(mob, dt);

            mob.mesh.position.set(mob.pos.x, mob.pos.y, mob.pos.z);
            mob.mesh.rotation.y += dt * 0.5; // gentle idle rotate (temp)
        }
    }

    _updateAI(mob, dt, playerPos) {
        if (mob.health <= 0) return;

        if (mob.state === 'IDLE') {
            if (mob.stateTimer <= 0) {
                mob.state = 'WANDER';
                const angle = Math.random() * Math.PI * 2;
                const r     = 4 + Math.random() * 8;
                mob.wanderTarget = {
                    x: mob.pos.x + Math.cos(angle) * r,
                    z: mob.pos.z + Math.sin(angle) * r,
                };
                mob.stateTimer = 3 + Math.random() * 5;
            }
        } else if (mob.state === 'WANDER') {
            if (!mob.wanderTarget || mob.stateTimer <= 0) {
                mob.state = 'IDLE';
                mob.stateTimer = 2 + Math.random() * 4;
                return;
            }
            const speed = mob.def.speed ?? 3;
            const tdx   = mob.wanderTarget.x - mob.pos.x;
            const tdz   = mob.wanderTarget.z - mob.pos.z;
            const dist  = Math.sqrt(tdx * tdx + tdz * tdz);
            if (dist < 0.5) { mob.state = 'IDLE'; mob.stateTimer = 2; return; }
            mob.vel.x = (tdx / dist) * speed;
            mob.vel.z = (tdz / dist) * speed;

        } else if (mob.state === 'FLEE') {
            if (mob.stateTimer <= 0) { mob.state = 'IDLE'; mob.stateTimer = 2; return; }
            const speed = (mob.def.speed ?? 3) * 1.5;
            const tdx   = mob.pos.x - playerPos.x;
            const tdz   = mob.pos.z - playerPos.z;
            const dist  = Math.sqrt(tdx * tdx + tdz * tdz);
            if (dist > 0) {
                mob.vel.x = (tdx / dist) * speed;
                mob.vel.z = (tdz / dist) * speed;
            }

        } else if (mob.state === 'ATTACK') {
            if (mob.stateTimer <= 0) {
                mob.state = 'FLEE';
                mob.stateTimer = 4;
                return;
            }
            // Chase player
            const speed = (mob.def.speed ?? 3) * 1.2;
            const tdx   = playerPos.x - mob.pos.x;
            const tdz   = playerPos.z - mob.pos.z;
            const dist  = Math.sqrt(tdx * tdx + tdz * tdz);
            if (dist > 0) {
                mob.vel.x = (tdx / dist) * speed;
                mob.vel.z = (tdz / dist) * speed;
            }
            // Deal damage when in melee range
            mob.attackCooldown = (mob.attackCooldown ?? 0) - dt;
            if (dist < 1.8 && mob.attackCooldown <= 0) {
                mob.attackCooldown = 1.5;
                const dmg = mob.def.attackDamage ?? 4;
                window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage: dmg } }));
            }
        }
    }

    _physicsStep(mob, dt) {
        const hw = (mob.def.width ?? 0.8) / 2;
        const h  = mob.def.height ?? 1.4;

        // Gravity
        if (!mob.onGround) mob.vel.y = Math.max(mob.vel.y + GRAVITY * dt, -30);

        // Move X
        const nx = mob.pos.x + mob.vel.x * dt;
        if (!this._collidesAABB(nx, mob.pos.y, mob.pos.z, hw, h)) mob.pos.x = nx;
        else mob.vel.x = 0;

        // Move Z
        const nz = mob.pos.z + mob.vel.z * dt;
        if (!this._collidesAABB(mob.pos.x, mob.pos.y, nz, hw, h)) mob.pos.z = nz;
        else mob.vel.z = 0;

        // Move Y
        const ny = mob.pos.y + mob.vel.y * dt;
        if (!this._collidesAABB(mob.pos.x, ny, mob.pos.z, hw, h)) {
            mob.pos.y = ny;
            mob.onGround = false;
        } else {
            mob.onGround = mob.vel.y < 0;
            mob.vel.y = 0;
        }

        // Dampen horizontal when on ground
        if (mob.onGround) {
            if (mob.state === 'IDLE') { mob.vel.x *= 0.7; mob.vel.z *= 0.7; }
        }
    }

    _collidesAABB(x, y, z, hw, h) {
        for (let bx = Math.floor(x - hw); bx <= Math.floor(x + hw - 0.001); bx++) {
            for (let by = Math.floor(y);    by <= Math.floor(y + h - 0.001); by++) {
                for (let bz = Math.floor(z - hw); bz <= Math.floor(z + hw - 0.001); bz++) {
                    const id = this.world.getBlock(bx, by, bz);
                    if (id > 0 && !this.blkReg.isNoCollision(id)) return true;
                }
            }
        }
        return false;
    }

    // ── Damage / death ────────────────────────────────────────────────────────

    /**
     * Return { mob, t } for the closest mob whose AABB the ray intersects,
     * or null if none. `origin` and `dir` are {x,y,z} objects; `maxDist` in blocks.
     */
    getClosestMobInRay(origin, dir, maxDist) {
        let closest = null;
        let bestT   = maxDist;

        for (const mob of this._mobs.values()) {
            const hw = (mob.def.width  ?? 0.8) / 2 + 0.05;
            const h  = (mob.def.height ?? 1.4) + 0.05;
            const t  = this._rayAABB(origin, dir,
                mob.pos.x - hw, mob.pos.y - 0.05, mob.pos.z - hw,
                mob.pos.x + hw, mob.pos.y + h,    mob.pos.z + hw);
            if (t !== null && t < bestT) { bestT = t; closest = mob; }
        }
        return closest ? { mob: closest, t: bestT } : null;
    }

    _rayAABB(origin, dir, minX, minY, minZ, maxX, maxY, maxZ) {
        const { x: ox, y: oy, z: oz } = origin;
        const { x: dx, y: dy, z: dz } = dir;
        let tmin = -Infinity, tmax = Infinity;

        for (const [o, d, mn, mx] of [[ox,dx,minX,maxX],[oy,dy,minY,maxY],[oz,dz,minZ,maxZ]]) {
            if (Math.abs(d) < 1e-8) {
                if (o < mn || o > mx) return null;
            } else {
                const t1 = (mn - o) / d, t2 = (mx - o) / d;
                tmin = Math.max(tmin, Math.min(t1, t2));
                tmax = Math.min(tmax, Math.max(t1, t2));
            }
        }
        if (tmin > tmax || tmax < 0) return null;
        return tmin >= 0 ? tmin : tmax;
    }

    /** Damage the mob nearest to `hitPos` within `radius`. Returns damage dealt. */
    hitNearest(hitPos, damage, radius = 3) {
        let closest = null, bestDist = radius * radius;
        for (const mob of this._mobs.values()) {
            const dx = mob.pos.x - hitPos.x;
            const dy = mob.pos.y - hitPos.y;
            const dz = mob.pos.z - hitPos.z;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < bestDist) { bestDist = d2; closest = mob; }
        }
        if (!closest) return 0;

        closest.health -= damage;
        // Quiddles retaliate; other mobs flee
        if (closest.typeId === 'quiddle') {
            closest.state      = 'ATTACK';
            closest.stateTimer = 8;
            closest.attackCooldown = 0;
        } else {
            closest.state      = 'FLEE';
            closest.stateTimer = 5;
        }

        if (closest.health <= 0) {
            this._killMob(closest);
        }
        return damage;
    }

    _killMob(mob) {
        // Drop items
        for (const drop of (mob.def.drops ?? [])) {
            const chance = drop.chance ?? 1;
            if (Math.random() > chance) continue;
            const count = drop.minCount + Math.floor(Math.random() * (drop.maxCount - drop.minCount + 1));
            if (count > 0) this.dropItem({ ...mob.pos }, drop.itemId, count);
        }
        this._removeMob(mob.id);
    }

    _removeMob(id) {
        const mob = this._mobs.get(id);
        if (!mob) return;
        this.scene.remove(mob.mesh);
        mob.mesh.geometry?.dispose();
        this._mobs.delete(id);
    }

    // ── Dropped items ─────────────────────────────────────────────────────────

    _getDropTex(itemId) {
        if (!this._texCache) this._texCache = new Map();
        if (this._texCache.has(itemId)) return this._texCache.get(itemId);

        const src = (window._itemTextureSrc ?? (id => `data/textures/items/${id}.png`))(itemId);
        const loader = new THREE.TextureLoader();
        const tex = loader.load(src, t => {
            t.magFilter = THREE.NearestFilter;
            t.minFilter = THREE.NearestFilter;
            t.needsUpdate = true;
        }, undefined, () => {
            // Fallback: draw a small coloured square with the item's dropColor
            const def = this.itemReg?.getItem(itemId);
            const col = def?.dropColor ?? [1, 0.8, 0.2];
            const cv  = document.createElement('canvas'); cv.width = cv.height = 16;
            const cx  = cv.getContext('2d');
            cx.fillStyle = `rgb(${(col[0]*255)|0},${(col[1]*255)|0},${(col[2]*255)|0})`;
            cx.fillRect(0, 0, 16, 16);
            cx.fillStyle = 'rgba(255,255,255,0.6)';
            cx.font = 'bold 9px monospace';
            cx.fillText((itemId[0] ?? '?').toUpperCase(), 3, 12);
            const fb = new THREE.CanvasTexture(cv);
            fb.magFilter = THREE.NearestFilter; fb.minFilter = THREE.NearestFilter;
            tex.image = fb.image; tex.needsUpdate = true;
        });
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        this._texCache.set(itemId, tex);
        return tex;
    }

    dropItem(pos, itemId, count = 1) {
        const tex  = this._getDropTex(itemId);
        const mat  = new THREE.SpriteMaterial({ map: tex, transparent: true });
        const mesh = new THREE.Sprite(mat);
        mesh.scale.set(0.45, 0.45, 0.45);
        mesh.position.set(pos.x + (Math.random() - 0.5) * 0.5,
                          pos.y + 0.5,
                          pos.z + (Math.random() - 0.5) * 0.5);
        this.scene.add(mesh);

        this._drops.push({
            id: uid(),
            pos: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
            vel: { x: (Math.random() - 0.5) * 2, y: 3, z: (Math.random() - 0.5) * 2 },
            itemId, count, mesh, age: 0,
        });
    }

    _updateDrops(dt, playerPos, inventory, gameMode) {
        for (let i = this._drops.length - 1; i >= 0; i--) {
            const d = this._drops[i];
            d.age += dt;

            // Expire
            if (d.age > ITEM_LIFETIME) {
                this.scene.remove(d.mesh);
                d.mesh.geometry?.dispose();
                this._drops.splice(i, 1);
                continue;
            }

            // Physics (simple gravity, bounce)
            d.vel.y -= 12 * dt;
            d.pos.x += d.vel.x * dt;
            d.pos.z += d.vel.z * dt;
            const ny = d.pos.y + d.vel.y * dt;
            const below = this.world.getBlock(Math.floor(d.pos.x), Math.floor(ny), Math.floor(d.pos.z));
            if (below > 0 && !this.blkReg.isNoCollision(below)) {
                d.vel.y = Math.abs(d.vel.y) * 0.3;
                d.vel.x *= 0.6; d.vel.z *= 0.6;
            } else {
                d.pos.y = ny;
            }

            // Bob animation
            d.mesh.position.set(d.pos.x, d.pos.y + Math.sin(d.age * 2) * 0.05, d.pos.z);
            d.mesh.rotation.y += dt;

            // Auto-pickup
            if (gameMode === 'SPECTATOR') continue;
            const pdx = d.pos.x - playerPos.x;
            const pdy = d.pos.y - playerPos.y - 0.9;
            const pdz = d.pos.z - playerPos.z;
            if (pdx*pdx + pdy*pdy + pdz*pdz < PICKUP_RADIUS * PICKUP_RADIUS) {
                const overflow = inventory.addItem(d.itemId, d.count);
                if (overflow === 0) {
                    this.scene.remove(d.mesh);
                    d.mesh.geometry?.dispose();
                    this._drops.splice(i, 1);
                    window.dispatchEvent(new CustomEvent('ww_itemPickup', {
                        detail: { itemId: d.itemId, count: d.count }
                    }));
                }
            }
        }
    }

    // ── Three.js mesh builder ─────────────────────────────────────────────────

    _buildMesh(def) {
        const w = def.width ?? 0.8;
        const h = def.height ?? 1.4;

        const bodyColor = new THREE.Color(...(def.color ?? [0.6, 0.5, 0.4]));
        // Head is slightly lighter to distinguish it from the body
        const headColor = new THREE.Color(
            Math.min(1, (def.color?.[0] ?? 0.6) * 1.25),
            Math.min(1, (def.color?.[1] ?? 0.5) * 1.25),
            Math.min(1, (def.color?.[2] ?? 0.4) * 1.25),
        );

        const bodyH   = h * 0.55;
        const headH   = h * 0.38;
        const bodyGeo = new THREE.BoxGeometry(w, bodyH, w * 0.7);
        const headGeo = new THREE.BoxGeometry(w * 0.65, headH, w * 0.65);
        const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
        const headMat = new THREE.MeshLambertMaterial({ color: headColor });

        const body = new THREE.Mesh(bodyGeo, bodyMat);
        const head = new THREE.Mesh(headGeo, headMat);

        // Offset so the bottom of the body sits at y=0 (foot position)
        body.position.y = bodyH / 2;
        head.position.y = bodyH + headH / 2;

        const group = new THREE.Group();
        group.add(body);
        group.add(head);
        return group;
    }

    // ── Death pack (player death) ─────────────────────────────────────────────

    spawnDeathPack(pos, inventory) {
        const packPos = { ...pos };
        const drops   = [];

        // Collect all inventory contents
        for (const slot of inventory.slots) {
            drops.push({ itemId: slot.itemId, count: slot.count });
        }
        for (const slot of inventory.hotbar) {
            if (slot) drops.push({ itemId: slot.itemId, count: slot.count });
        }
        if (inventory.offhand) drops.push({ ...inventory.offhand });

        // Scatter armor and quiver near death location
        for (const [key, slot] of Object.entries(inventory.equipment)) {
            if (!slot) continue;
            const scatterPos = {
                x: pos.x + (Math.random() - 0.5) * 4,
                y: pos.y,
                z: pos.z + (Math.random() - 0.5) * 4,
            };
            this.dropItem(scatterPos, slot.itemId, 1);
        }

        // Create a glowing "backpack" item representing the player's contents
        this.dropItem(packPos, '_death_pack_', drops.length > 0 ? 1 : 0);
        // (A real implementation would store the pack contents separately)

        return packPos;
    }
}
