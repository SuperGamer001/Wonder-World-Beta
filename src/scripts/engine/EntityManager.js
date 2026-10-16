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

const FOOTSTEP_REACH = 20;      // blocks: a mob's footfalls are not made, let alone heard, beyond this

const SPAWN_RADIUS  = 32;   // blocks from the player to attempt spawn
const DESPAWN_RADIUS= 80;   // blocks from the player to despawn
const PICKUP_RADIUS = 1.5;  // blocks from player to auto-pickup
const SPAWN_INTERVAL= 8;    // seconds between spawn attempts
const MAX_MOBS      = 24;   // the most within DESPAWN_RADIUS of a player
const MAX_FISH      = 10;   // … and fish, counted apart: in the water they take no room from the animals
const ITEM_LIFETIME = 300;  // seconds before dropped items expire
const DEATH_TIME    = 0.9;  // seconds a mob lies where it fell before it is gone
const HIGHLIGHT_GLOW = 0.2;  // light added to the mob under the crosshair
// Time passing at once (fastForward): the most of it the mobs live through, and in steps of what.
const FAST_MOST = 30, FAST_STEP = 0.1;
// Pushing (see _push): m/s of push for each block one body is in another; the most it comes to.
const PUSH_RATE = 6, PUSH_MOST = 3;
// A player's box (PlayerPhysics), and its "mass" for pushing: as a mob's, its width squared times its height.
const PLAYER_HALF = 0.3, PLAYER_TALL = 1.8, PLAYER_MASS = PLAYER_HALF * PLAYER_HALF * PLAYER_TALL;

// With other players in the world (see "With other players", below).
const SHARE_RADIUS   = 2 * SPAWN_RADIUS;    // players this near each other fill one neighbourhood between them
const WORD_RADIUS    = DESPAWN_RADIUS + 16; // a mob is told of to a player this near it (a little past where theirs end)
const HANDOFF_EVERY  = 0.5;   // seconds between looks at whose each mob should be
const HANDOFF_MARGIN = 6;     // blocks nearer another player than this one before a mob is theirs to run
const REPLICA_TTL    = 1.5;   // seconds another game's mob is kept with no word of it
const WAKE_RADIUS    = DESPAWN_RADIUS - 10; // a mob asleep wakes when a player comes this near (nearer than it fell asleep at)
const ASLEEP_MAX     = 20000;  // the most mobs kept asleep in one world
const ID_SPAN        = 1_000_000;   // a mob's id is its first game's number × this, plus a count

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
        // The mob under the player's crosshair, set by world.js each frame: it glows a little.
        this.highlight = null;
        this._casters = { count: 0, data: new Float32Array(4 * MAX_MOBS) };
        // Other things that cast a moving shadow (the players' own bodies):
        // each a function (data, offset) that writes its sphere there.
        this.extraCasters = [];

        // ── With other players (see *Playing together* in CLAUDE.md) ─────────
        // A mob is run by one game — the game of the player nearest it — and
        // shown by the rest. Every game spawns round its own player, as it
        // does alone, and tells the others of the mobs it runs (snapshot);
        // theirs it shows as they say (applySnapshot: such a mob has `net`).
        // A mob that ends up nearer another player is handed to that
        // player's game (onGive / adopt), so whoever is beside a mob is the
        // one whose game — with that land loaded — is moving it. (The host's
        // game used to run them all, round the host: a guest who walked off
        // met none.) The callbacks carry what has to cross: a blow on a mob
        // to the game that runs it, and from there a mob's blow, or a dead
        // mob's drops, to the player they are for.
        this.owner = 0;                // this game's number in the session (world.js); 0 alone
        this.others = [];              // the other players: [{ id, x, y, z }], set by world.js each frame
        this.onRemoteHit = null;       // (ownerId, mobId, damage) — this player struck a mob another game runs
        this.onRemoteAttack = null;    // (playerId, damage) — a mob struck another player
        this.onRemoteDrops = null;     // (playerId, pos, [[itemId, count], …]) — another player's kill
        this.onGive = null;            // (playerId, [id, type, x, y, z, yaw, health, look]) — a mob is theirs to run now
        this._netInfo = new Map();     // mob id → the look it was announced with
        this._heard = new Map();       // player id → when their last word of their mobs came
        this._count = 0;               // mobs this game has made (for their ids)
        this._clock = 0;               // seconds this manager has run
        this._handT = 0;

        // ── Asleep (see *Mobs that are left behind*, below) ──────────────────
        this.keeper = true;            // this game keeps the world's sleeping mobs (world.js: the world's owner)
        this.onSleep = null;           // (record) — not the keeper: a mob left behind goes to the keeper's game
        this._asleep = new Map();      // "cx,cz" → [[type, x, y, z, yaw, health, look], …]
        this._asleepCount = 0;

        this._player = { x: 0, y: 0, z: 0 };
        this._target = null;           // the player a mob's blow would land on: null = this one
        this._ctx = { player: this._player, playerVisible: true, onAttack: (damage) => {
            if (this._target) this.onRemoteAttack?.(this._target.id, damage);
            else window.dispatchEvent(new CustomEvent('ww_mobAttack', { detail: { damage } }));
        } };
        this._near = { x: 0, y: 0, z: 0 };
        this._dir = [0, 1, 0];
        this._fast = false;            // time is passing at once (fastForward): nothing drawn or heard
        this._live = [];               // _push: the living mobs this frame
        this._pv = { x: 0, z: 0 };     // _push / pushOn: the push being added up
        this._pushAt = { x: 0, y: 0, z: 0 };
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
        this._clock += dt;
        this._spawnT += dt;
        if (this._spawnT >= SPAWN_INTERVAL) {
            this._spawnT = 0;
            if (gameMode !== 'SPECTATOR') this._trySpawn(playerPos);
        }
        // Now and then, with others about: whose is each mob?
        this._handT += dt;
        const hand = this._handT >= HANDOFF_EVERY;
        if (hand) this._handT = 0;

        if (hand && this.keeper && this._asleepCount) this._wake(playerPos, gameMode);
        this._push(playerPos, gameMode);
        this._updateMobs(dt, playerPos, gameMode, hand);
        this._updateDrops(dt, playerPos, inventory, gameMode);
    }

    /**
     * `seconds` pass at once (players asleep: world.js _cut). The mobs this
     * game runs live through them — wander, graze, fall, appear — in steps of
     * a tenth of a second, for at most FAST_MOST seconds of it (what they did
     * after that, they would only have gone on doing), not drawn meanwhile;
     * and what lies on the ground grows that much older.
     */
    fastForward(seconds, playerPos, inventory, gameMode) {
        const most = Math.min(seconds, FAST_MOST);
        this._fast = true;
        try {
            for (let t = 0; t < most; t += FAST_STEP) this.update(Math.min(FAST_STEP, most - t), playerPos, inventory, gameMode);
        } finally { this._fast = false; }
        for (const d of this._drops) d.age += seconds - most;
    }

    // ── Pushing ───────────────────────────────────────────────────────────────
    // Bodies that stand in one another are pushed apart: a mob by the other
    // mobs and by the players, a player by the mobs (pushOn, for world.js) —
    // each by the game that moves it, so in a shared world a mob another game
    // runs is pushed there, from where that game has the players. The push is
    // faster the further one is in the other, and the lighter one (by the
    // size of its box) is pushed the more: a hen gives way to a cow, a cow
    // hardly to a hen. It is a velocity on top of the walking one, through the
    // same collision (MobAI._physics), so nothing is pushed into a wall — nor
    // a mob off an edge it would not take.

    /** Each of this game's living mobs: how it is pushed this frame (mob.pushX / pushZ). */
    _push(playerPos, gameMode) {
        const live = this._live;
        live.length = 0;
        for (const m of this._mobs.values()) if (m.dying === 0) live.push(m);
        const v = this._pv;
        for (const a of live) {
            if (a.net) continue;                       // another game's: pushed there
            const ra = (a.def.width ?? 0.8) / 2, ha = a.def.height ?? 1.4, ma = ra * ra * ha;
            v.x = v.z = 0;
            for (const b of live) {
                if (b === a) continue;
                const rb = (b.def.width ?? 0.8) / 2, hb = b.def.height ?? 1.4;
                this._pushBy(a.pos, ra, ha, ma, b.pos, rb, hb, rb * rb * hb, a.id * 2.399);
            }
            if (gameMode !== 'SPECTATOR') this._pushBy(a.pos, ra, ha, ma, playerPos, PLAYER_HALF, PLAYER_TALL, PLAYER_MASS, a.id * 2.399);
            for (const o of this.others) this._pushBy(a.pos, ra, ha, ma, o, PLAYER_HALF, PLAYER_TALL, PLAYER_MASS, a.id * 2.399);
            const s = Math.hypot(v.x, v.z), k = s > PUSH_MOST ? PUSH_MOST / s : 1;
            a.pushX = v.x * k; a.pushZ = v.z * k;
        }
    }

    /**
     * How the mobs — and `players`, the other players' feet ({ x, y, z }) —
     * push a player whose feet are at (x, y, z): { x, z }, m/s, reused from
     * call to call.
     */
    pushOn(x, y, z, players = null) {
        const v = this._pv, at = this._pushAt, half = PLAYER_HALF, tall = PLAYER_TALL, m = PLAYER_MASS;
        v.x = v.z = 0;
        at.x = x; at.y = y; at.z = z;
        for (const b of this._mobs.values()) {
            if (b.dying > 0) continue;
            const rb = (b.def.width ?? 0.8) / 2, hb = b.def.height ?? 1.4;
            this._pushBy(at, half, tall, m, b.pos, rb, hb, rb * rb * hb, 0.7);
        }
        if (players) for (const o of players) this._pushBy(at, half, tall, m, o, half, tall, m, 0.7);
        const s = Math.hypot(v.x, v.z), k = s > PUSH_MOST ? PUSH_MOST / s : 1;
        v.x *= k; v.z *= k;
        return v;
    }

    /** Add to `_pv` how a body at `b` pushes one at `a` (feet; half widths, heights, masses). `spin`: which way, when they stand exactly together. */
    _pushBy(a, ra, ha, ma, b, rb, hb, mb, spin) {
        if (a.y >= b.y + hb || b.y >= a.y + ha) return;
        let dx = a.x - b.x, dz = a.z - b.z;
        const reach = ra + rb;
        if (dx >= reach || dx <= -reach || dz >= reach || dz <= -reach) return;
        let d = Math.hypot(dx, dz);
        const over = reach - d;
        if (over <= 0) return;
        if (d < 1e-4) { dx = Math.cos(spin); dz = Math.sin(spin); d = 1; }
        const share = Math.min(1.8, Math.max(0.2, 2 * mb / (ma + mb)));
        const k = PUSH_RATE * over * share / d;
        this._pv.x += dx * k; this._pv.z += dz * k;
    }

    // ── Mob spawning ──────────────────────────────────────────────────────────

    /**
     * Mobs appear round this game's player. Every game does this for its own
     * player, so wherever a player is there are mobs — and where players are
     * together they fill the place between them, no faster and no fuller than
     * one would: the mobs already there count whoever's game runs them, and
     * each game takes only its share of the turns.
     */
    _trySpawn(playerPos) {
        // Fish are counted apart (MAX_FISH): the animals on land filled the
        // place first, and no fish was ever left room to appear.
        let near = 0, fish = 0;
        for (const mob of this._mobs.values()) {
            if ((mob.pos.x - playerPos.x) ** 2 + (mob.pos.z - playerPos.z) ** 2 >= DESPAWN_RADIUS * DESPAWN_RADIUS) continue;
            if (mob.def.aquatic) fish++; else near++;
        }
        if (near >= MAX_MOBS && fish >= MAX_FISH) return;
        let sharing = 1;
        for (const o of this.others) {
            if ((o.x - playerPos.x) ** 2 + (o.z - playerPos.z) ** 2 < SHARE_RADIUS * SHARE_RADIUS) sharing++;
        }
        if (sharing > 1 && Math.random() * sharing >= 1) return;

        for (const [typeId, def] of this._types) {
            if (Math.random() > 0.25) continue;
            const water = !!def.aquatic;
            if (water ? fish >= MAX_FISH : near >= MAX_MOBS) continue;
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

            const least = rules.minGroupSize ?? 1, most = Math.max(least, rules.maxGroupSize ?? least);
            const count = least + Math.floor(Math.random() * (most - least + 1));
            for (let i = 0; i < count; i++) {
                if (water ? fish >= MAX_FISH : near >= MAX_MOBS) break;
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
                if (water) fish++; else near++;
            }
        }
    }

    /** An id no other game's mob has: this game's number in the session, and a count. */
    _newId() { return this.owner * ID_SPAN + (++this._count); }

    _spawnMob(typeId, pos, id = this._newId(), variant = null) {
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

    _updateMobs(dt, playerPos, gameMode, hand = false) {
        const ai = this.ai, ctx = this._ctx;
        this._player.x = playerPos.x; this._player.y = playerPos.y; this._player.z = playerPos.z;
        ctx.playerVisible = gameMode !== 'SPECTATOR';
        ai.beginFrame();
        this.posed = 0;
        const far2 = DESPAWN_RADIUS * DESPAWN_RADIUS;

        for (const [id, mob] of this._mobs) {
            // Another game's: shown as that game says.
            // (Not while time passes at once: another game's word of it comes when it comes.)
            if (mob.net) { if (!this._fast) this._updateReplica(mob, dt); continue; }

            const dx = mob.pos.x - playerPos.x;
            const dz = mob.pos.z - playerPos.z;
            const d2 = dx * dx + dz * dz;

            // Nearer another player now (or this one has gone off and left it
            // beside them): it is that player's game's to run.
            if (mob.dying === 0 && this.others.length && (hand || d2 > far2)) {
                const to = this._nearerPlayer(mob, ctx.playerVisible ? Math.sqrt(d2) : Infinity);
                if (to) { this._give(mob, to); continue; }
            }

            // Fallen out of the world: gone. Left behind: asleep, until someone comes back.
            if (mob.pos.y < WORLD_MIN_Y - 16) { this._removeMob(id); continue; }
            if (d2 > far2) {
                if (mob.dying === 0) this._sleep(mob);
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
                // A fall that hurt it (MobAI._landed).
                if (mob.fallHurt > 0) {
                    const d = mob.fallHurt;
                    mob.fallHurt = 0;
                    this._fallHurt(mob, d);
                    if (mob.dying > 0) continue;
                }
                // Its voice, every so often — not all at once, and not from far off.
                mob.voiceT = (mob.voiceT ?? 4 + Math.random() * 20) - dt;
                if (mob.voiceT <= 0) {
                    mob.voiceT = 9 + Math.random() * 22;
                    if (dx * dx + dz * dz < 28 * 28) this._voice(mob, 'idle', 0.55);
                }
            }
            mob.hurt = Math.max(0, mob.hurt - dt * 3);
            if (this._fast) continue;                 // time passing at once: nothing drawn meanwhile
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
        else {
            // Two footfalls to a stride are heard (a walking cow's four come in two pairs).
            const beat = Math.floor(a.phase / Math.PI);
            a.phase += speed * dt * (Math.PI * 2) / stride;
            if (Math.floor(a.phase / Math.PI) !== beat && alive && mob.onGround && !mob.inWater && speed > 0.4) this._footstep(mob, a.run);
        }
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
        inst.glow = mob === this.highlight && alive ? HIGHLIGHT_GLOW : 0;

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
     * Return { mob, t } for the first mob the ray meets, or null. `origin` and
     * `dir` (a unit vector) are {x,y,z} objects; `maxDist` in blocks.
     *
     * A mob is met where its body is, as it is posed (MobModels.rayHit): the
     * ray is taken into the mob's own space — its place off, turned back by
     * the way it faces — and tried against its skin. So what can be struck is
     * what can be seen, whichever way the mob is turned. (It was a box as wide
     * as the mob is across and square to the world: a cow side on was struck
     * through the air before its nose and missed at its rump.) An entity with
     * no model is the two boxes it is drawn as, turned with it.
     */
    getClosestMobInRay(origin, dir, maxDist) {
        let closest = null;
        let bestT   = maxDist;

        for (const mob of this._mobs.values()) {
            if (mob.dying > 0) continue;
            const rx = origin.x - mob.pos.x, ry = origin.y - mob.pos.y, rz = origin.z - mob.pos.z;
            const c = Math.cos(mob.yaw), s = Math.sin(mob.yaw);
            let t = -1;
            if (mob.inst) {
                // Not near the ray at all: most mobs, most of the time.
                const bs = mob.inst.mesh.geometry.boundingSphere;
                const cy = ry - bs.center.y;
                const along = -(rx * dir.x + cy * dir.y + rz * dir.z);
                if (along < -bs.radius || along > bestT + bs.radius) continue;
                const off2 = rx * rx + cy * cy + rz * rz - along * along;
                if (off2 > bs.radius * bs.radius) continue;
                t = this.models.rayHit(mob.inst,
                    rx * c - rz * s, ry, rx * s + rz * c,
                    dir.x * c - dir.z * s, dir.y, dir.x * s + dir.z * c, bestT);
            } else {
                const hw = (mob.def.width ?? 0.8) / 2, h = mob.def.height ?? 1.4;
                const hit = this._rayAABB(
                    { x: rx * c - rz * s, y: ry, z: rx * s + rz * c },
                    { x: dir.x * c - dir.z * s, y: dir.y, z: dir.x * s + dir.z * c },
                    -hw, 0, -hw * 0.7, hw, h, hw * 0.7);
                if (hit !== null) t = hit;
            }
            if (t >= 0 && t < bestT) { bestT = t; closest = mob; }
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

    /**
     * The mob says something: `<type>_idle` or `<type>_hurt`, from where its
     * head is. Each take of those is a different call; on top of that every
     * one is a little higher or lower each time (`vary`), and by the animal's size.
     */
    _voice(mob, kind, volume, pitch = 1) {
        if (!this.onSound || this._fast) return;      // (time passing at once: not all its calls together)
        const size = mob.inst?.scale ?? 1;
        this.onSound(`${mob.typeId}_${kind}`, { x: mob.pos.x, y: mob.pos.y + (mob.def.height ?? 1) * 0.8, z: mob.pos.z },
            { volume, pitch: pitch / size ** 0.6, vary: 0.09, reach: 30 });
    }

    /**
     * A foot comes down: `step`, with what the listener needs to pick the sound —
     * the mob's own kind of foot (`footstep` in its JSON: hoof, trotter, chicken;
     * none: a shoe, which sounds of the ground alone) and the block under it.
     */
    _footstep(mob, run) {
        if (!this.onSound) return;
        const p = mob.pos, dx = p.x - this._player.x, dz = p.z - this._player.z;
        if (dx * dx + dz * dz > FOOTSTEP_REACH * FOOTSTEP_REACH) return;
        const x = Math.floor(p.x), z = Math.floor(p.z);
        const ground = this.world.getBlock(x, Math.floor(p.y - 0.2), z) || this.world.getBlock(x, Math.floor(p.y - 1.2), z);
        // A heavy animal is heard further than a hen.
        const weight = Math.sqrt(Math.min(1, Math.max(0.25, (mob.def.width ?? 0.8) * (mob.def.height ?? 1.4))));
        this.onSound('step', { x: p.x, y: p.y, z: p.z }, { footstep: mob.def.footstep ?? null, ground, volume: (0.3 + 0.2 * run) * weight, reach: FOOTSTEP_REACH });
    }

    // ── With other players ────────────────────────────────────────────────────

    /** The mobs this game runs (the rest are other games', shown here). */
    get ownCount() {
        let n = 0;
        for (const mob of this._mobs.values()) if (!mob.net) n++;
        return n;
    }

    /**
     * Whether there is anything to tell and anyone near enough to be told: a
     * mob this game runs, with another player near enough to it to see it.
     * (Players far apart say nothing of their mobs to each other: every word
     * of an online game is counted.)
     */
    get hasWord() {
        for (const mob of this._mobs.values()) {
            if (mob.net) continue;
            for (const o of this.others) if ((o.x - mob.pos.x) ** 2 + (o.z - mob.pos.z) ** 2 < WORD_RADIUS * WORD_RADIUS) return true;
        }
        return false;
    }

    /** The other player this mob is nearer to than to this game's own (`dMe` blocks off), by enough to be theirs; or null. */
    _nearerPlayer(mob, dMe) {
        let best = null, bestD = Math.min(DESPAWN_RADIUS, dMe - HANDOFF_MARGIN);
        for (const o of this.others) {
            const d = Math.hypot(mob.pos.x - o.x, mob.pos.z - o.z);
            if (d < bestD) { bestD = d; best = o; }
        }
        return best;
    }

    /** Hand a mob to another player's game. Here it becomes one of theirs: shown where it is until their word of it comes. */
    _give(mob, to) {
        const r = (v) => Math.round(v * 100) / 100, look = mob.inst?.variant ?? null;
        this.onGive?.(to.id, [mob.id, mob.typeId, r(mob.pos.x), r(mob.pos.y), r(mob.pos.z), r(mob.yaw), mob.health, look]);
        this._netInfo.set(mob.id, look);
        mob.net = { x: mob.pos.x, y: mob.pos.y, z: mob.pos.z, yaw: mob.yaw, lookYaw: mob.lookYaw, lookPitch: mob.lookPitch, owner: to.id, seen: this._clock };
    }

    /** A mob handed to this game by another (`m`: what _give sent): it is run here from now on. */
    adopt(m) {
        if (!Array.isArray(m) || m.length < 8) return;
        const [id, typeId, x, y, z, yaw, health, look] = m;
        if (!Number.isSafeInteger(id) || !this._types.has(typeId) || ![x, y, z].every(Number.isFinite)) return;
        const old = this._mobs.get(id);
        if (old && !old.net) return;                    // this game's already
        if (old) this._removeMob(id);
        this._spawnMob(typeId, { x, y, z }, id, look ?? this._netInfo.get(id) ?? null);
        const mob = this._mobs.get(id);
        if (!mob) return;
        if (Number.isFinite(yaw)) { mob.yaw = yaw; mob.mesh.rotation.y = yaw; }
        if (health > 0) mob.health = Math.min(mob.maxHealth, health);
    }

    /** A player has left: the mobs their game ran went with it — asleep, in the keeper's game, where they were last seen. */
    dropOwner(playerId) {
        this._heard.delete(playerId);
        for (const [id, mob] of [...this._mobs]) {
            if (mob.net?.owner !== playerId) continue;
            if (this.keeper && mob.dying === 0) this.store(this._record(mob));
            this._removeMob(id);
            this._netInfo.delete(id);
        }
    }

    // ── Mobs that are left behind ─────────────────────────────────────────────
    //
    // A mob the players have all walked away from is not done away with: it
    // goes to sleep where it stands — a line of what it is (its kind, place,
    // the way it faced, its health and its look), kept by the chunk it is in —
    // and wakes, the same animal, when a player comes back. The world's
    // owner's game keeps them all (`keeper`), saves them with the world, and
    // has them back when the world is next opened, along with every mob that
    // was up and about when it was left. (They used to be deleted eighty
    // blocks from the player, and all of them on the way out of the world.)
    //
    // With other players: a mob left behind in another game is sent to the
    // keeper's (onSleep → store), and the keeper's game wakes the ones near
    // any player — its own it wakes itself, another's it hands to that
    // player's game (onGive), which is the game with that land loaded.

    /** What is kept of a mob: [type, x, y, z, yaw, health, look]. */
    _record(mob) {
        const r = (v) => Math.round(v * 100) / 100;
        return [mob.typeId, r(mob.pos.x), r(mob.pos.y), r(mob.pos.z), r(mob.yaw), r(mob.health), mob.inst?.variant ?? null];
    }

    _sleep(mob) {
        const rec = this._record(mob);
        if (this.keeper) this.store(rec); else this.onSleep?.(rec);
    }

    /** Keep a sleeping mob (the keeper's game: its own, or one another game sent). Returns whether it was taken. */
    store(rec) {
        if (!Array.isArray(rec) || rec.length < 6 || this._asleepCount >= ASLEEP_MAX) return false;
        const [typeId, x, y, z, yaw, health] = rec;
        if (!this._types.has(typeId) || ![x, y, z, yaw, health].every(Number.isFinite) || !(health > 0)) return false;
        const look = rec[6] && typeof rec[6] === 'object' && !Array.isArray(rec[6]) ? rec[6] : null;
        const key = `${Math.floor(x) >> 4},${Math.floor(z) >> 4}`;
        let list = this._asleep.get(key);
        if (!list) this._asleep.set(key, list = []);
        list.push([typeId, x, y, z, yaw, health, look]);
        this._asleepCount++;
        return true;
    }

    /** How many mobs are asleep (diagnostics). */
    get asleepCount() { return this._asleepCount; }

    /** The keeper's game, now and then: the sleeping mobs a player has come near wake. */
    _wake(playerPos, gameMode) {
        const reach = Math.ceil(WAKE_RADIUS / 16), near2 = WAKE_RADIUS * WAKE_RADIUS;
        const round = (p, other) => {
            const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
            for (let cz = pcz - reach; cz <= pcz + reach; cz++) for (let cx = pcx - reach; cx <= pcx + reach; cx++) {
                const key = `${cx},${cz}`, list = this._asleep.get(key);
                if (!list) continue;
                // This game's own wake on land that is there to stand on; another's game has its own land.
                if (!other && typeof this.world.getChunk === 'function' && !this.world.getChunk(cx, cz)?.generated) continue;
                for (let i = list.length - 1; i >= 0; i--) {
                    const [typeId, x, y, z, yaw, health, look] = list[i];
                    if ((x - p.x) ** 2 + (z - p.z) ** 2 > near2) continue;
                    list.splice(i, 1);
                    this._asleepCount--;
                    const id = this._newId();
                    if (other) { this.onGive?.(other.id, [id, typeId, x, y, z, yaw, health, look]); continue; }
                    this._spawnMob(typeId, { x, y, z }, id, look);
                    const mob = this._mobs.get(id);
                    if (!mob) continue;
                    mob.yaw = yaw; mob.mesh.rotation.y = yaw;
                    mob.health = Math.min(mob.maxHealth, health);
                }
                if (!list.length) this._asleep.delete(key);
            }
        };
        if (gameMode !== 'SPECTATOR') round(playerPos, null);
        for (const o of this.others) round(o, o);
    }

    /** Every mob there is to keep, for saving with the world: those asleep, and those up and about (whoever's game runs them). */
    serialize() {
        const out = [];
        for (const list of this._asleep.values()) for (const rec of list) out.push(rec);
        for (const mob of this._mobs.values()) if (mob.dying === 0) out.push(this._record(mob));
        return out.length > ASLEEP_MAX ? out.slice(out.length - ASLEEP_MAX) : out;
    }

    /** The world's mobs as they were saved: all asleep, to wake as the players come to them. */
    loadAsleep(list) {
        this._asleep.clear();
        this._asleepCount = 0;
        if (Array.isArray(list)) for (const rec of list) this.store(rec);
    }

    /**
     * The mobs this game runs as they are now, for the other games: eleven
     * numbers a mob in `list` (id, type, x, y, z, yaw, flags, where the head
     * is turned, how far through a blow, how lately hurt) and, in `info`, the
     * look of each mob not announced yet — or of all of them (`full`: someone
     * has just joined, or it is a while since they were last all told).
     */
    snapshot(full = false) {
        const list = [], info = {}, r = (v) => Math.round(v * 100) / 100;
        for (const mob of this._mobs.values()) {
            if (mob.net) continue;
            const flags = (mob.onGround ? 1 : 0) | (mob.inWater ? 2 : 0) | (mob.grazing ? 4 : 0) | (mob.panic ? 8 : 0) | (mob.dying > 0 ? 16 : 0);
            list.push(mob.id, mob.typeId, r(mob.pos.x), r(mob.pos.y), r(mob.pos.z), r(mob.yaw), flags,
                r(mob.lookYaw), r(mob.lookPitch), r(mob.swing ?? 0), r(mob.hurt));
            if (full || !mob.told) { info[mob.id] = mob.inst?.variant ?? null; mob.told = true; }
        }
        return { list, info };
    }

    /** Another game's word of the mobs it runs (`from`: its player): they are made so here, and moved there smoothly by update. */
    applySnapshot(from, snap) {
        const list = Array.isArray(snap?.list) ? snap.list : [], now = this._clock;
        // How long since their last word: it is what says how fast each mob is going.
        const last = this._heard.get(from);
        const interval = Math.min(1, Math.max(0.05, last === undefined ? 0.1 : now - last));
        this._heard.set(from, now);
        if (snap?.info && typeof snap.info === 'object') for (const id in snap.info) this._netInfo.set(Number(id), snap.info[id]);
        for (let i = 0; i + 10 < list.length; i += 11) {
            const id = list[i], x = list[i + 2], y = list[i + 3], z = list[i + 4], flags = list[i + 6];
            if (!Number.isSafeInteger(id) || ![x, y, z, list[i + 5]].every(Number.isFinite)) continue;
            let mob = this._mobs.get(id);
            if (mob && !mob.net) continue;              // this game's own: a word from before it was handed over
            if (!mob) {
                if (!this._netInfo.has(id) || !this._types.has(list[i + 1])) continue;       // not announced yet
                this._spawnMob(list[i + 1], { x, y, z }, id, this._netInfo.get(id));
                mob = this._mobs.get(id);
                if (!mob) continue;
                mob.net = { x, y, z, yaw: list[i + 5], lookYaw: 0, lookPitch: 0, owner: from, seen: now };
                mob.yaw = list[i + 5];
            }
            const n = mob.net;
            mob.vel.x = (x - n.x) / interval; mob.vel.z = (z - n.z) / interval;
            n.x = x; n.y = y; n.z = z; n.yaw = list[i + 5]; n.lookYaw = +list[i + 7] || 0; n.lookPitch = +list[i + 8] || 0;
            n.owner = from; n.seen = now;
            mob.onGround = !!(flags & 1); mob.inWater = !!(flags & 2); mob.grazing = !!(flags & 4); mob.panic = !!(flags & 8);
            mob.swing = +list[i + 9] || 0;
            mob.hurt = Math.max(mob.hurt, +list[i + 10] || 0);
            if ((flags & 16) && mob.dying === 0) mob.dying = 0.0001;
        }
    }

    /**
     * Another game's mob: eased to where that game last said it was, and
     * animated. It is gone when it has lain dead its moment — or when nothing
     * has been said of it for a while: its game has left, or let it go, or
     * the two players are too far apart to be telling each other.
     */
    _updateReplica(mob, dt) {
        const n = mob.net;
        if (this._clock - n.seen > REPLICA_TTL || mob.dying > DEATH_TIME) {
            this._netInfo.delete(mob.id);
            this._removeMob(mob.id);
            return;
        }
        const k = 1 - Math.exp(-dt * 14);
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

    /** Another player (`from`: their id and where they stand) struck the mob `id`, which this game runs. */
    hitById(id, damage, from) {
        const mob = this._mobs.get(id);
        if (!mob || mob.net || mob.dying > 0 || !(damage > 0)) return;
        mob.health -= damage;
        mob.hurt = 1;
        this._voice(mob, 'hurt', 0.9, mob.health <= 0 ? 0.82 : 1);
        mob.voiceT = 6 + Math.random() * 10;
        if (mob.health <= 0) this._killMob(mob, from.id);
        else this.ai.hurt(mob, from);
    }

    /**
     * A blow lands on this mob. `by`: where it came from (whoever is hit runs
     * from there — or, if it is the kind that fights back, comes for it:
     * MobAI.hurt). Returns the damage dealt.
     */
    hitMob(mob, damage, by = null) {
        if (!mob || mob.dying > 0 || !(damage > 0) || this._mobs.get(mob.id) !== mob) return 0;
        mob.hurt = 1;
        if (mob.net) {
            // Not this game's to hurt: the game that runs it is told, and its next word of the mob shows what came of it.
            this._voice(mob, 'hurt', 0.9);
            this.onRemoteHit?.(mob.net.owner, mob.id, damage);
            return damage;
        }
        mob.health -= damage;
        this._voice(mob, 'hurt', 0.9, mob.health <= 0 ? 0.82 : 1);
        mob.voiceT = 6 + Math.random() * 10;
        if (mob.health <= 0) this._killMob(mob);
        else this.ai.hurt(mob, by ?? this._player);
        return damage;
    }

    /** It fell, and hurt itself: no one to run from; it may die of it, and drops what it would. */
    _fallHurt(mob, damage) {
        mob.health -= damage;
        mob.hurt = 1;
        if (!this._fast) this.onSound?.('fall', { ...mob.pos }, { volume: Math.min(1, 0.4 + damage / 10), reach: 24 });
        this._voice(mob, 'hurt', 0.9, mob.health <= 0 ? 0.82 : 1);
        mob.voiceT = 6 + Math.random() * 10;
        if (mob.health <= 0) this._killMob(mob);
    }

    /**
     * Damage the mob nearest to `hitPos` within `radius` — of those `ok(mob)`
     * allows, if given (the ones the striker can see). Returns damage dealt.
     */
    hitNearest(hitPos, damage, radius = 3, ok = null) {
        let closest = null, bestDist = radius * radius;
        for (const mob of this._mobs.values()) {
            if (mob.dying > 0) continue;
            const dx = mob.pos.x - hitPos.x;
            const dy = mob.pos.y - hitPos.y;
            const dz = mob.pos.z - hitPos.z;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < bestDist && (!ok || ok(mob))) { bestDist = d2; closest = mob; }
        }
        if (!closest) return 0;
        // The player's doing, if they are near where it landed. Lightning is its own threat.
        const p = this._player;
        const byPlayer = Math.hypot(p.x - hitPos.x, p.y - hitPos.y, p.z - hitPos.z) < 12;
        return this.hitMob(closest, damage, byPlayer ? p : hitPos);
    }

    /** Is a living mob standing where `inside(x, y, z, halfWidth, height)` says its box would be in the way? */
    mobIn(inside) {
        for (const mob of this._mobs.values()) {
            if (mob.dying > 0) continue;
            // Its body, not only the box it collides with: an animal is longer
            // than it is wide (`length` in its JSON, nose to tail), the way it faces.
            const w = mob.def.width ?? 0.8, scale = mob.inst?.scale ?? 1;
            if (inside(mob.pos.x, mob.pos.y, mob.pos.z, w / 2 * scale, (mob.def.height ?? 1.4) * scale, Math.max(w, mob.def.length ?? w) / 2 * scale, mob.yaw)) return true;
        }
        return false;
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
            const shaped = below > 0 ? this.blkReg.shapes?.of(below) : null;
            const landed = below > 0 && !this.blkReg.isNoCollision(below) &&
                (shaped ? this.blkReg.shapes.pointIn(shaped, this.world, d.pos.x, ny, d.pos.z, true)
                        : (!this.smooth?.isMesh(below) || this.smooth.pointInMesh(d.pos.x, ny, d.pos.z)));
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
                const left = inventory.addItem(d.itemId, d.count);
                if (left < d.count || d.count === 0) {
                    // What was taken is the player's; what there was no room for
                    // stays on the ground. (All of it stayed, with what had been
                    // taken: a stack topped up from a drop was made from nothing.)
                    const taken = d.count - left;
                    d.count = left;
                    if (left === 0) {
                        this.scene.remove(d.mesh);
                        // Sprite geometry is a Three.js singleton and the material is cached per
                        // item id, so removing it from the scene is the whole cleanup.
                        this._drops.splice(i, 1);
                    }
                    this.onSound?.('pickup', null, { volume: 0.5 });
                    window.dispatchEvent(new CustomEvent('ww_itemPickup', {
                        detail: { itemId: d.itemId, count: taken }
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
