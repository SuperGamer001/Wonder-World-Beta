/**
 * EntityManager — mob spawning and upkeep, and dropped items.
 *
 * A mob's mind and body are engine/MobAI.js (what it decides, how it moves,
 * the paths it takes: engine/MobNav.js); how it looks is MobModels.js (the
 * models of engine/MobModelDefs.js, one mesh per mob, posed on the CPU). This
 * class brings them together each frame: it runs the AI, turns what the mob
 * is doing into the animation state its model reads, and lights it.
 *
 * An entity names its model with `model` (default: its id). One with no model
 * of that name — a gamepack's own creature — is drawn as two plain boxes, as
 * every mob used to be.
 *
 * Dropped items: sprites that fall, bob and are picked up on proximity.
 */

import * as THREE from 'three';
import { WORLD_MIN_Y } from './ChunkData.js';
import { MobAI, WALK, RUN } from './MobAI.js';
import { MobModels } from '../MobModels.js';
import { randomVariant } from './MobShapes.js';
import { GAITS } from './MobAnim.js';

const SPAWN_RADIUS  = 32;   // chunks from player to attempt spawn
const DESPAWN_RADIUS= 80;   // blocks from player to despawn
const PICKUP_RADIUS = 1.5;  // blocks from player to auto-pickup
const SPAWN_INTERVAL= 8;    // seconds between spawn attempts
const MAX_MOBS      = 24;   // hard cap per world
const ITEM_LIFETIME = 300;  // seconds before dropped items expire
const DEATH_TIME    = 0.9;  // seconds a mob lies where it fell before it is gone

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

        this.ai     = new MobAI(worldState, blockRegistry);
        this.models = new MobModels();

        // (x, y, z) => 0..1 sky-light brightness at a point, set by world.js, so
        // mobs are as dark as the cave they stand in. null = always full light.
        this.lightAt = null;
        // Unit vector toward the sun or moon, set by world.js each frame: the
        // faces of a mob turned to it are the bright ones, as on the terrain.
        this.lightDir = [0.35, 0.87, 0.35];
        // (x, y, z, radius) => whether anything in that sphere can be seen (a
        // mob, or the shadow it casts), set by world.js; null = always. A mob
        // that cannot be seen still thinks, moves and keeps its stride, but its
        // vertices are not worked out — and that is most of what a mob costs.
        this.seen = null;
        // (name, { x, y, z }, options) => play a sound there, set by world.js
        // (Sound.js). A mob speaks now and then, and cries out when it is hit.
        this.onSound = null;
        this.posed = 0;      // mobs posed in the last update (diagnostics)
        this._casters = { count: 0, data: new Float32Array(4 * MAX_MOBS) };
        // Other things that cast a moving shadow (the players' own bodies):
        // each a function (data, offset) that writes its sphere there.
        this.extraCasters = [];

        // ── With other players (see *Multiplayer* in CLAUDE.md) ──────────────
        // The host's game runs the mobs. A guest's is a `replica`: it spawns
        // nothing and decides nothing, and shows what the host's snapshots
        // say (snapshot / applySnapshot). The callbacks carry what has to
        // cross: a guest's blow to the host, and from the host a mob's blow
        // or a dead mob's drops to the player they are for.
        this.replica = false;
        this.others = [];              // the other players: [{ id, x, y, z }], set by world.js each frame
        this.onRemoteHit = null;       // (mobId, damage, from) — a guest struck a mob
        this.onRemoteAttack = null;    // (playerId, damage) — a mob struck another player
        this.onRemoteDrops = null;     // (playerId, pos, [[itemId, count], …]) — another player's kill
        this._netInfo = new Map();     // replica: mob id → the look it was announced with
        this._seen = new Set();

        this._player = { x: 0, y: 0, z: 0 };
        this._target = null;           // the player a mob's blow would land on: null = this one
        this._ctx = { player: this._player, playerVisible: true, onAttack: (damage) => {
            if (this._target) this.onRemoteAttack?.(this._target.id, damage);
            else window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage } }));
        } };
        this._near = { x: 0, y: 0, z: 0 };
        this._dir = [0, 1, 0];
    }

    // SmoothTerrain collider in smooth worlds; null keeps blocky collision.
    get smooth() { return this.ai.smooth; }
    set smooth(v) { this.ai.smooth = v; }

    /** Fetch the mob textures. Awaited by world.js while the loading screen is up. */
    loadModels() { return this.models.load(); }

    loadEntityTypes(entities) {
        for (const def of entities) this._types.set(def.id, def);
    }

    setBiomeData(biomes) { this._biomeData = biomes; }

    /** Live mobs. */
    get mobCount() { return this._mobs.size; }

    /**
     * A sphere round each mob, whatever its pose, for the shadow mapper — what
     * it redraws every frame: `{ count, data: [x, y, z, radius, …] }`, reused
     * from call to call.
     */
    shadowCasters() {
        const out = this._casters;
        const most = this._mobs.size + this.extraCasters.length;
        if (out.data.length < most * 4) out.data = new Float32Array(most * 8);
        const d = out.data;
        let n = 0;
        for (const mob of this._mobs.values()) {
            d[n] = mob.pos.x; d[n + 2] = mob.pos.z;
            if (mob.inst) {
                const s = mob.inst.mesh.geometry.boundingSphere;
                d[n + 1] = mob.pos.y + s.center.y; d[n + 3] = s.radius;
            } else {
                const h = mob.def.height ?? 1.4;
                d[n + 1] = mob.pos.y + h / 2; d[n + 3] = Math.max(h, mob.def.width ?? 0.8);
            }
            n += 4;
        }
        for (const write of this.extraCasters) { write(d, n); n += 4; }
        out.count = n >> 2;
        return out;
    }

    /**
     * Throwaway objects drawn with the same kinds of material as mobs and
     * dropped items, so world.js can compile their shaders during the loading
     * screen rather than on the frame the first one appears. Their materials
     * stay alive until dispose(): Three.js deletes a program once no material
     * uses it, and the next mob would then compile it all over again.
     */
    warmupObjects() {
        const out = [...this.models.warmupMeshes()];
        const def = this._types.values().next().value;
        if (def) out.push(this._buildMesh(def));   // the per-type shared parts, kept in _mobParts
        if (!this._warmSprite) {
            const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
            tex.needsUpdate = true;
            this._warmSprite = new THREE.SpriteMaterial({ map: tex, transparent: true });
        }
        out.push(new THREE.Sprite(this._warmSprite));
        return out;
    }

    // ── Main update ───────────────────────────────────────────────────────────

    update(dt, playerPos, inventory, gameMode) {
        if (this.replica) {
            this._player.x = playerPos.x; this._player.y = playerPos.y; this._player.z = playerPos.z;
            this._updateReplicas(dt);
            this._updateDrops(dt, playerPos, inventory, gameMode);
            return;
        }
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

            // Find ground at this XZ. Bounded to a window around the player
            // instead of scanning to the world floor — a mob that would spawn
            // hundreds of blocks below is out of range anyway, and the old scan
            // cost up to a full world-height of getBlock calls per attempt, per
            // entity type, on every spawn tick.
            let sy = null;
            const scanTop    = Math.floor(playerPos.y) + 10;
            const scanBottom = Math.max(WORLD_MIN_Y + 1, scanTop - (DESPAWN_RADIUS + 16));
            const needsWater = def.aquatic ?? false;
            for (let y = scanTop; y > scanBottom; y--) {
                const id  = this.world.getBlock(sx, y, sz);
                const idy = this.world.getBlock(sx, y - 1, sz);
                if (id !== 0 || idy === 0) continue;
                // The first thing under open air: water, or ground.
                const isWater = this.blkReg.isLiquid(idy);
                if (!isWater && this.blkReg.isNoCollision(idy)) continue;
                if (needsWater !== isWater) break;
                if (needsWater) {
                    // A fish goes a little way under, where the water is deep enough to swim in.
                    if (!this.blkReg.isLiquid(this.world.getBlock(sx, y - 3, sz))) break;
                    y -= 2;
                }
                if (rules.minY !== undefined && y < rules.minY) break;
                if (rules.maxY !== undefined && y > rules.maxY) break;
                sy = y;
                break;
            }
            if (sy === null) continue;

            const count = 1 + Math.floor(Math.random() * ((rules.maxGroupSize ?? 1) - (rules.minGroupSize ?? 1) + 1));
            for (let i = 0; i < count; i++) {
                if (this._mobs.size >= MAX_MOBS) break;
                // The others of a group stand nearby — each on its own ground, or in its own water.
                let gx = sx + 0.5, gy = sy, gz = sz + 0.5;
                if (i > 0) {
                    gx += (Math.random() - 0.5) * 8; gz += (Math.random() - 0.5) * 8;
                    if (needsWater) { if (!this.blkReg.isLiquid(this.world.getBlock(Math.floor(gx), sy, Math.floor(gz)))) continue; }
                    else {
                        const y = this.ai.nav.stand(Math.floor(gx), Math.floor(gz), sy, { clear: 2, maxDrop: 3, swims: false });
                        if (y < -9000 || this.ai.nav.wet) continue;
                        gy = y;
                    }
                }
                this._spawnMob(typeId, { x: gx, y: gy, z: gz });
            }
        }
    }

    _spawnMob(typeId, pos, id = uid(), variant = null) {
        const def = this._types.get(typeId);
        if (!def) return;

        // Its model, in a look of its own; or the plain boxes if it has none.
        const name = def.model ?? def.id;
        const model = this.models.model(name);
        const inst = model ? this.models.create(name, variant ?? randomVariant(model), def.modelScale ?? 1) : null;
        const mesh = inst ? inst.mesh : this._buildMesh(def);
        mesh.position.set(pos.x, pos.y, pos.z);
        // Render layer 2 = shadow caster that moves every frame (SHADOW_DYNAMIC_LAYER
        // in Shadows.js, drawn over the cached terrain shadows); mobs cast shadows.
        mesh.traverse(o => {
            o.layers.enable(2);
            // The plain boxes are Lambert: each mob gets its own copy of the
            // (shared) materials so it can be dimmed by the light where it stands.
            if (!inst && o.material) {
                o.material = o.material.clone();
                o.userData.baseColor = o.material.color.clone();
            }
        });
        this.scene.add(mesh);

        const mob = this.ai.init({
            id, typeId, def, mesh, inst,
            pos: { ...pos },
            health: def.health ?? 10,
            maxHealth: def.health ?? 10,
            dying: 0,            // 0 alive, else seconds since it died
            hurt: 0,             // 1 when just hit, fading
            lookYaw: 0, lookPitch: 0,
        });
        mesh.rotation.y = mob.yaw;
        this._mobs.set(id, mob);
        return id;
    }

    // ── Mob update ────────────────────────────────────────────────────────────

    _updateMobs(dt, playerPos, gameMode) {
        const ai = this.ai, ctx = this._ctx;
        this._player.x = playerPos.x; this._player.y = playerPos.y; this._player.z = playerPos.z;
        ctx.playerVisible = gameMode !== 'SPECTATOR';
        ai.beginFrame();
        this.posed = 0;

        for (const [id, mob] of this._mobs) {
            const dx = mob.pos.x - playerPos.x;
            const dz = mob.pos.z - playerPos.z;

            // Despawn if too far, or fallen out of the world.
            if (dx * dx + dz * dz > DESPAWN_RADIUS * DESPAWN_RADIUS || mob.pos.y < WORLD_MIN_Y - 16) {
                this._removeMob(id);
                continue;
            }
            if (mob.dying > 0) {
                mob.dying += dt;
                if (mob.dying > DEATH_TIME) { this._removeMob(id); continue; }
            } else {
                // The player this mob minds — looks at, runs from, strikes — is the nearest one.
                this._target = null;
                ctx.player = this._player;
                if (this.others.length) {
                    let best = dx * dx + dz * dz;
                    for (const o of this.others) {
                        const d = (mob.pos.x - o.x) ** 2 + (mob.pos.z - o.z) ** 2;
                        if (d < best) { best = d; this._target = o; }
                    }
                    if (this._target) {
                        const n = this._near, o = this._target;
                        n.x = o.x; n.y = o.y; n.z = o.z;
                        ctx.player = n;
                    }
                }
                ai.update(mob, dt, ctx);
                // Its voice, every so often — not all at once, and not from far off.
                mob.voiceT = (mob.voiceT ?? 4 + Math.random() * 20) - dt;
                if (mob.voiceT <= 0) {
                    mob.voiceT = 9 + Math.random() * 22;
                    if (dx * dx + dz * dz < 28 * 28) this._voice(mob, 'idle', 0.55);
                }
            }
            mob.hurt = Math.max(0, mob.hurt - dt * 3);
            mob.mesh.position.set(mob.pos.x, mob.pos.y, mob.pos.z);
            mob.mesh.rotation.y = mob.yaw;
            if (mob.inst) this._animate(mob, dt);
            else this._applyLight(mob);
        }
    }

    /** Turn what the mob is doing into its model's animation state, and pose and light it. */
    _animate(mob, dt) {
        const a = mob.inst.anim, def = mob.def, alive = mob.dying === 0;
        const ease = (from, to, rate) => from + (to - from) * (1 - Math.exp(-rate * dt));
        const speed = alive ? Math.hypot(mob.vel.x, mob.vel.z) : 0;
        const walk = (def.speed ?? 3) * WALK, full = (def.speed ?? 3) * RUN;

        a.time += dt;
        a.move = ease(a.move, Math.min(1, speed / walk), 10);
        a.run  = ease(a.run, Math.min(1, Math.max(0, (speed - walk) / (full - walk))), 6);
        // The stride follows the ground covered — its length is the model's own,
        // for the pace it is going at — so a foot that is down stays where it
        // was put. A fish beats its tail all the time.
        const gait = GAITS[mob.inst.name];
        const stride = (gait ? gait.walk + (gait.run - gait.walk) * a.run : Math.max(0.4, (def.height ?? 1.4) * 0.8)) * mob.inst.scale;
        if (def.aquatic) a.phase += dt * (3.5 + 7 * Math.min(1, speed / walk));
        else a.phase += speed * dt * (Math.PI * 2) / stride;
        a.air   = ease(a.air, alive && !mob.onGround && !mob.inWater ? 1 : 0, 12);
        a.swim  = ease(a.swim, mob.inWater ? 1 : 0, 6);
        a.graze = ease(a.graze, alive && mob.grazing ? 1 : 0, 4);
        a.panic = ease(a.panic, alive && mob.panic ? 1 : 0, 6);
        a.attack = alive ? mob.swing : 0;
        a.hurt = mob.hurt;

        // Where the head turns: toward what it is looking at, as far as a neck goes.
        let yaw = 0, pitch = 0;
        const look = alive ? mob.look : null;
        if (mob.net) { yaw = alive ? mob.net.lookYaw : 0; pitch = alive ? mob.net.lookPitch : 0; }
        else if (look) {
            const h = def.height ?? 1.4;
            const lx = look.x - mob.pos.x, lz = look.z - mob.pos.z;
            const ly = (look.y + 1.5) - (mob.pos.y + h * 0.85);
            yaw = Math.atan2(lx, lz) - mob.yaw;
            yaw -= Math.round(yaw / (Math.PI * 2)) * Math.PI * 2;
            yaw = Math.max(-1.15, Math.min(1.15, yaw));
            pitch = Math.max(-0.6, Math.min(0.6, -Math.atan2(ly, Math.hypot(lx, lz))));
        }
        mob.lookYaw = ease(mob.lookYaw, yaw, 7);
        mob.lookPitch = ease(mob.lookPitch, pitch, 7);
        a.lookYaw = mob.lookYaw; a.lookPitch = mob.lookPitch;

        const inst = mob.inst;
        inst.death = alive ? 0 : Math.min(1, mob.dying / 0.45);
        // Struck: a flush of red.
        const flush = Math.max(mob.hurt, alive ? 0 : 0.5);
        inst.tint[1] = inst.tint[2] = 1 - 0.55 * flush;

        // Out of sight, shadow and all: everything above has been kept up, so
        // it steps back into view mid-stride, but there is nothing to draw.
        const bs = inst.mesh.geometry.boundingSphere;
        if (this.seen && !this.seen(mob.pos.x, mob.pos.y + bs.center.y, mob.pos.z, bs.radius)) return;
        this.posed++;

        const l = this.lightAt ? this.lightAt(mob.pos.x, mob.pos.y + 0.5, mob.pos.z) : 1;
        this.models.pose(inst, l, MobModels.toModelSpace(this.lightDir, mob.yaw, this._dir));
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
            if (mob.dying > 0) continue;
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

    /** The mob says something: `<type>_idle` or `<type>_hurt`, from where its head is. */
    _voice(mob, kind, volume, pitch = 1) {
        if (!this.onSound) return;
        const size = mob.inst?.scale ?? 1;
        this.onSound(`${mob.typeId}_${kind}`, { x: mob.pos.x, y: mob.pos.y + (mob.def.height ?? 1) * 0.8, z: mob.pos.z },
            { volume, pitch: pitch / size ** 0.6, reach: 30 });
    }

    // ── With other players ────────────────────────────────────────────────────

    /**
     * The host's mobs as they are now, for the guests: eleven numbers a mob in
     * `list` (id, type, x, y, z, yaw, flags, where the head is turned, how
     * far through a blow, how lately hurt) and, in `info`, the look of each
     * mob not announced yet — or of all of them, when someone has just joined
     * (`full`).
     */
    snapshot(full = false) {
        const list = [], info = {}, r = (v) => Math.round(v * 100) / 100;
        for (const mob of this._mobs.values()) {
            const flags = (mob.onGround ? 1 : 0) | (mob.inWater ? 2 : 0) | (mob.grazing ? 4 : 0) | (mob.panic ? 8 : 0) | (mob.dying > 0 ? 16 : 0);
            list.push(mob.id, mob.typeId, r(mob.pos.x), r(mob.pos.y), r(mob.pos.z), r(mob.yaw), flags,
                r(mob.lookYaw), r(mob.lookPitch), r(mob.swing ?? 0), r(mob.hurt));
            if (full || !mob.told) { info[mob.id] = mob.inst?.variant ?? null; mob.told = true; }
        }
        return { list, info };
    }

    /** A guest: make the mobs what the host's snapshot says (they are moved there smoothly by update). */
    applySnapshot(snap, interval = 0.1) {
        const list = snap.list ?? [], seen = this._seen;
        seen.clear();
        for (const id in snap.info ?? {}) this._netInfo.set(Number(id), snap.info[id]);
        for (let i = 0; i + 10 < list.length; i += 11) {
            const id = list[i], x = list[i + 2], y = list[i + 3], z = list[i + 4], flags = list[i + 6];
            let mob = this._mobs.get(id);
            if (!mob) {
                if (!this._netInfo.has(id) || !this._types.has(list[i + 1])) continue;       // not announced yet
                this._spawnMob(list[i + 1], { x, y, z }, id, this._netInfo.get(id));
                mob = this._mobs.get(id);
                if (!mob) continue;
                mob.net = { x, y, z, yaw: list[i + 5], lookYaw: 0, lookPitch: 0 };
                mob.yaw = list[i + 5];
            }
            seen.add(id);
            const n = mob.net;
            mob.vel.x = (x - n.x) / interval; mob.vel.z = (z - n.z) / interval;
            n.x = x; n.y = y; n.z = z; n.yaw = list[i + 5]; n.lookYaw = list[i + 7]; n.lookPitch = list[i + 8];
            mob.onGround = !!(flags & 1); mob.inWater = !!(flags & 2); mob.grazing = !!(flags & 4); mob.panic = !!(flags & 8);
            mob.swing = list[i + 9];
            mob.hurt = Math.max(mob.hurt, list[i + 10]);
            if ((flags & 16) && mob.dying === 0) mob.dying = 0.0001;
        }
        for (const id of [...this._mobs.keys()]) if (!seen.has(id)) { this._removeMob(id); this._netInfo.delete(id); }
    }

    /** A guest's mobs: eased to where the host last said they were, and animated. */
    _updateReplicas(dt) {
        const k = 1 - Math.exp(-dt * 14);
        this.posed = 0;
        for (const mob of this._mobs.values()) {
            const n = mob.net;
            if (!n) continue;
            mob.pos.x += (n.x - mob.pos.x) * k; mob.pos.y += (n.y - mob.pos.y) * k; mob.pos.z += (n.z - mob.pos.z) * k;
            let turn = n.yaw - mob.yaw;
            turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
            mob.yaw += turn * k;
            if (mob.dying > 0) mob.dying += dt;
            else {
                // Its voice is this game's own to play: what is heard depends on where the listener is.
                mob.voiceT = (mob.voiceT ?? 4 + Math.random() * 20) - dt;
                if (mob.voiceT <= 0) {
                    mob.voiceT = 9 + Math.random() * 22;
                    if ((mob.pos.x - this._player.x) ** 2 + (mob.pos.z - this._player.z) ** 2 < 28 * 28) this._voice(mob, 'idle', 0.55);
                }
            }
            mob.hurt = Math.max(0, mob.hurt - dt * 3);
            mob.mesh.position.set(mob.pos.x, mob.pos.y, mob.pos.z);
            mob.mesh.rotation.y = mob.yaw;
            if (mob.inst) this._animate(mob, dt);
            else this._applyLight(mob);
        }
    }

    /** The host: a guest (`from`: their player id and where they stand) struck the mob `id`. */
    hitById(id, damage, from) {
        const mob = this._mobs.get(id);
        if (!mob || mob.dying > 0 || !(damage > 0)) return;
        mob.health -= damage;
        mob.hurt = 1;
        this._voice(mob, 'hurt', 0.9, mob.health <= 0 ? 0.82 : 1);
        mob.voiceT = 6 + Math.random() * 10;
        if (mob.health <= 0) this._killMob(mob, from.id);
        else this.ai.hurt(mob, from);
    }

    /** Damage the mob nearest to `hitPos` within `radius`. Returns damage dealt. */
    hitNearest(hitPos, damage, radius = 3) {
        let closest = null, bestDist = radius * radius;
        for (const mob of this._mobs.values()) {
            if (mob.dying > 0) continue;
            const dx = mob.pos.x - hitPos.x;
            const dy = mob.pos.y - hitPos.y;
            const dz = mob.pos.z - hitPos.z;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < bestDist) { bestDist = d2; closest = mob; }
        }
        if (!closest) return 0;
        if (this.replica) {
            // Not ours to hurt: the host is told, and its next snapshot shows what came of it.
            closest.hurt = 1;
            this._voice(closest, 'hurt', 0.9);
            this.onRemoteHit?.(closest.id, damage, hitPos);
            return damage;
        }

        closest.health -= damage;
        closest.hurt = 1;
        this._voice(closest, 'hurt', 0.9, closest.health <= 0 ? 0.82 : 1);
        closest.voiceT = 6 + Math.random() * 10;
        if (closest.health <= 0) {
            this._killMob(closest);
        } else {
            // Whoever is hit runs from the player — or, if it is the kind that
            // fights back, comes for them (MobAI.hurt). Lightning is its own threat.
            const p = this._player;
            const byPlayer = Math.hypot(p.x - hitPos.x, p.y - hitPos.y, p.z - hitPos.z) < 12;
            this.ai.hurt(closest, byPlayer ? p : hitPos);
        }
        return damage;
    }

    _killMob(mob, by = null) {
        // Drop items — in the game of whoever killed it: a drop is picked up by
        // the game it lies in, and lying in everyone's it would be picked up twice.
        const theirs = [];
        for (const drop of (mob.def.drops ?? [])) {
            const chance = drop.chance ?? 1;
            if (Math.random() > chance) continue;
            const count = drop.minCount + Math.floor(Math.random() * (drop.maxCount - drop.minCount + 1));
            if (count <= 0) continue;
            if (by != null) theirs.push([drop.itemId, count]);
            else this.dropItem({ ...mob.pos }, drop.itemId, count);
        }
        if (theirs.length) this.onRemoteDrops?.(by, { ...mob.pos }, theirs);
        // A model keels over and lies a moment before it goes; plain boxes just go.
        if (mob.inst) mob.dying = 0.0001;
        else this._removeMob(mob.id);
    }

    _removeMob(id) {
        const mob = this._mobs.get(id);
        if (!mob) return;
        this.scene.remove(mob.mesh);
        if (mob.inst) {
            // Its geometry goes back to the pool; the material is shared.
            this.models.release(mob.inst);
        } else {
            // Plain boxes: geometries are shared per entity type and released in
            // dispose(); the materials are per-mob copies (see _spawnMob).
            mob.mesh.traverse(o => o.material?.dispose());
        }
        this._mobs.delete(id);
    }

    /** Plain-box mobs: dim the colours by the light at its middle. */
    _applyLight(mob) {
        const l = this.lightAt ? this.lightAt(mob.pos.x, mob.pos.y + 0.5, mob.pos.z) : 1;
        if (mob.light === l) return;
        mob.light = l;
        for (const o of mob.mesh.children) {
            if (o.userData.baseColor) o.material.color.copy(o.userData.baseColor).multiplyScalar(l);
        }
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

    /**
     * SpriteMaterials are cached per item id alongside the textures. Previously
     * every dropped item allocated its own material and none were ever disposed,
     * so a long session leaked one GPU material per item ever dropped.
     */
    _getDropMaterial(itemId) {
        if (!this._dropMats) this._dropMats = new Map();
        let mat = this._dropMats.get(itemId);
        if (!mat) {
            mat = new THREE.SpriteMaterial({ map: this._getDropTex(itemId), transparent: true });
            this._dropMats.set(itemId, mat);
        }
        return mat;
    }

    dropItem(pos, itemId, count = 1) {
        const mat  = this._getDropMaterial(itemId);
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
                // Sprite geometry is a Three.js singleton and the material is cached per
                // item id, so removing it from the scene is the whole cleanup.
                this._drops.splice(i, 1);
                continue;
            }

            // Physics (simple gravity, bounce)
            d.vel.y -= 12 * dt;
            d.pos.x += d.vel.x * dt;
            d.pos.z += d.vel.z * dt;
            const ny = d.pos.y + d.vel.y * dt;
            const below = this.world.getBlock(Math.floor(d.pos.x), Math.floor(ny), Math.floor(d.pos.z));
            const landed = below > 0 && !this.blkReg.isNoCollision(below) &&
                (!this.smooth?.isMesh(below) || this.smooth.pointInMesh(d.pos.x, ny, d.pos.z));
            if (landed) {
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
                    // Sprite geometry is a Three.js singleton and the material is cached per
                    // item id, so removing it from the scene is the whole cleanup.
                    this._drops.splice(i, 1);
                    this.onSound?.('pickup', null, { volume: 0.5 });
                    window.dispatchEvent(new CustomEvent('ww_itemPickup', {
                        detail: { itemId: d.itemId, count: d.count }
                    }));
                }
            }
        }
    }

    // ── Three.js mesh builder ─────────────────────────────────────────────────

    /**
     * The plain two-box mob, for an entity with no model, reusing one geometry
     * + material pair per entity type.
     *
     * Every mob of a given type has identical dimensions and colour, so there is
     * no reason to allocate fresh BoxGeometry and MeshLambertMaterial objects
     * per spawn. Each mob clones the materials (so it can be dimmed by the light
     * where it stands); _removeMob frees those clones.
     */
    _buildMesh(def) {
        const shared = this._sharedMobParts(def);
        const body = new THREE.Mesh(shared.bodyGeo, shared.bodyMat);
        const head = new THREE.Mesh(shared.headGeo, shared.headMat);

        // Offset so the bottom of the body sits at y=0 (foot position)
        body.position.y = shared.bodyH / 2;
        head.position.y = shared.bodyH + shared.headH / 2;

        const group = new THREE.Group();
        group.add(body);
        group.add(head);
        return group;
    }

    _sharedMobParts(def) {
        if (!this._mobParts) this._mobParts = new Map();
        const key = def.id ?? def.name ?? JSON.stringify(def);
        const hit = this._mobParts.get(key);
        if (hit) return hit;

        const w = def.width ?? 0.8;
        const h = def.height ?? 1.4;

        const bodyColor = new THREE.Color(...(def.color ?? [0.6, 0.5, 0.4]));
        // Head is slightly lighter to distinguish it from the body
        const headColor = new THREE.Color(
            Math.min(1, (def.color?.[0] ?? 0.6) * 1.25),
            Math.min(1, (def.color?.[1] ?? 0.5) * 1.25),
            Math.min(1, (def.color?.[2] ?? 0.4) * 1.25),
        );

        const bodyH = h * 0.55;
        const headH = h * 0.38;
        const parts = {
            bodyH, headH,
            bodyGeo: new THREE.BoxGeometry(w, bodyH, w * 0.7),
            headGeo: new THREE.BoxGeometry(w * 0.65, headH, w * 0.65),
            bodyMat: new THREE.MeshLambertMaterial({ color: bodyColor }),
            headMat: new THREE.MeshLambertMaterial({ color: headColor }),
        };
        this._mobParts.set(key, parts);
        return parts;
    }

    /**
     * Release every shared GPU resource this manager owns.
     * Called from world.js when leaving a world.
     */
    dispose() {
        for (const id of [...this._mobs.keys()]) this._removeMob(id);
        for (const d of this._drops) this.scene.remove(d.mesh);
        this._drops.length = 0;

        for (const p of (this._mobParts?.values() ?? [])) {
            p.bodyGeo.dispose(); p.headGeo.dispose();
            p.bodyMat.dispose(); p.headMat.dispose();
        }
        this._mobParts?.clear();
        this.models.dispose();

        for (const m of (this._dropMats?.values() ?? [])) m.dispose();
        this._dropMats?.clear();

        if (this._warmSprite) {
            this._warmSprite.map?.dispose();
            this._warmSprite.dispose();
            this._warmSprite = null;
        }

        for (const t of (this._texCache?.values() ?? [])) t.dispose();
        this._texCache?.clear();
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
