/**
 * Inventory — weight-based item storage.
 *
 * Layout:
 *   hotbar[0..9]   — 10 fixed slots: { itemId, count } | null
 *   offhand        — { itemId, count } | null
 *   equipment      — { head, chest, legs, feet, ears, hands, arms, quiver } each or null
 *   slots[]        — general inventory: { itemId, count }[]
 *   quiverArrows   — arrows stored in the equipped quiver (separate, weight-free)
 *
 * Weight rules:
 *   Each hotbar/offhand/equipment item contributes item.weight once.
 *   Each general inventory section (slot) contributes item.weight once, regardless of stack size.
 *   Arrows IN the equipped quiver do NOT count toward weight.
 */
export class Inventory {
    constructor(maxWeight = 100) {
        this.maxWeight = maxWeight;
        this.hotbar    = new Array(10).fill(null);
        this.offhand   = null;
        this.equipment = {
            head: null, chest: null, legs: null,
            feet: null, ears:  null, hands: null,
            arms: null, quiver: null,
        };
        this.slots        = [];   // [{ itemId, count }]
        this.quiverArrows = 0;

        this._itemReg = null;   // ItemRegistry — set via setItemRegistry()
    }

    setItemRegistry(reg) { this._itemReg = reg; }

    // ── Weight ────────────────────────────────────────────────────────────────

    get currentWeight() {
        let w = 0;
        for (const s of this.hotbar)                 { if (s) w += this._wt(s.itemId); }
        if (this.offhand)                             w += this._wt(this.offhand.itemId);
        for (const [k, s] of Object.entries(this.equipment)) {
            if (s) w += this._wt(s.itemId);           // quiver itself counts, not its arrows
        }
        for (const s of this.slots)                  { w += this._wt(s.itemId); }
        return w;
    }

    get availableWeight() { return this.maxWeight - this.currentWeight; }

    _wt(itemId)       { return this._itemReg?.getItem(itemId)?.weight   ?? 1; }
    _maxStack(itemId) { return this._itemReg?.getItem(itemId)?.maxStack ?? 64; }

    // ── Add / remove items ─────────────────────────────────────────────────────

    /**
     * Add items to inventory: hotbar first, then general slots.
     * Returns how many items could NOT be added (overflow).
     */
    addItem(itemId, count = 1) {
        let remaining = count;

        // Stack into existing hotbar stacks first (no weight cost)
        for (const s of this.hotbar) {
            if (!s || s.itemId !== itemId) continue;
            const space = this._maxStack(itemId) - s.count;
            const take  = Math.min(space, remaining);
            s.count    += take;
            remaining  -= take;
            if (remaining === 0) return 0;
        }

        // Stack into existing general inventory slots (no weight cost)
        for (const s of this.slots) {
            if (s.itemId !== itemId) continue;
            const space = this._maxStack(itemId) - s.count;
            const take  = Math.min(space, remaining);
            s.count    += take;
            remaining  -= take;
            if (remaining === 0) return 0;
        }

        // Fill empty hotbar slots before general inventory
        for (let i = 0; i < this.hotbar.length && remaining > 0; i++) {
            if (this.hotbar[i]) continue;
            const take = Math.min(this._maxStack(itemId), remaining);
            this.hotbar[i] = { itemId, count: take };
            remaining -= take;
        }

        // Create new general inventory slots
        while (remaining > 0) {
            const wt = this._wt(itemId);
            if (this.availableWeight < wt) break;
            const take = Math.min(this._maxStack(itemId), remaining);
            this.slots.push({ itemId, count: take });
            remaining -= take;
        }
        return remaining;
    }

    /**
     * Remove items from all sources (slots → hotbar → offhand).
     * Returns how many were actually removed.
     */
    removeItem(itemId, count = 1) {
        let need = count;

        for (let i = this.slots.length - 1; i >= 0 && need > 0; i--) {
            const s = this.slots[i];
            if (s.itemId !== itemId) continue;
            const take = Math.min(s.count, need);
            s.count -= take;
            need    -= take;
            if (s.count === 0) this.slots.splice(i, 1);
        }
        for (let i = 0; i < this.hotbar.length && need > 0; i++) {
            const s = this.hotbar[i];
            if (!s || s.itemId !== itemId) continue;
            const take = Math.min(s.count, need);
            s.count -= take;
            need    -= take;
            if (s.count === 0) this.hotbar[i] = null;
        }
        if (this.offhand?.itemId === itemId && need > 0) {
            const take = Math.min(this.offhand.count, need);
            this.offhand.count -= take;
            need -= take;
            if (this.offhand.count === 0) this.offhand = null;
        }
        return count - need;
    }

    /** Count all items of a type across all storage. */
    countItem(itemId) {
        let n = 0;
        for (const s of this.slots)  { if (s.itemId === itemId) n += s.count; }
        for (const s of this.hotbar) { if (s?.itemId === itemId) n += s.count; }
        if (this.offhand?.itemId === itemId) n += this.offhand.count;
        return n;
    }

    /** True if the player has enough of every ingredient. */
    hasIngredients(requirements) {
        for (const [itemId, count] of Object.entries(requirements)) {
            if (this.countItem(itemId) < count) return false;
        }
        return true;
    }

    // ── Equipment ─────────────────────────────────────────────────────────────

    equip(slot, itemId, count = 1) {
        this.equipment[slot] = { itemId, count };
    }

    unequip(slot) {
        const prev = this.equipment[slot];
        this.equipment[slot] = null;
        return prev;
    }

    // ── Hotbar / offhand ──────────────────────────────────────────────────────

    setHotbar(index, itemId, count = 1) {
        this.hotbar[index] = itemId ? { itemId, count } : null;
    }

    getHotbar(index) { return this.hotbar[index] ?? null; }

    // ── Quiver arrows ─────────────────────────────────────────────────────────

    /** Move arrows from inventory into equipped quiver. Call after equipping a quiver. */
    consolidateArrowsIntoQuiver() {
        const quiver = this.equipment.quiver;
        if (!quiver) return;
        const maxArrows = this._itemReg?.getItem(quiver.itemId)?.maxArrows ?? 64;
        const space     = maxArrows - this.quiverArrows;
        if (space <= 0) return;
        const inv   = this.countItem('arrow');
        const take  = Math.min(space, inv);
        if (take > 0) {
            this.removeItem('arrow', take);
            this.quiverArrows += take;
        }
    }

    /**
     * Consume one arrow for a bow shot.
     * Returns 'fast' (from quiver), 'slow' (from inventory), or null (none).
     */
    takeArrow() {
        if (this.quiverArrows > 0) { this.quiverArrows--; return 'fast'; }
        if (this.countItem('arrow') > 0) { this.removeItem('arrow', 1); return 'slow'; }
        return null;
    }

    // ── Derived stats ──────────────────────────────────────────────────────────

    get totalProtection() {
        let p = 0;
        for (const [k, s] of Object.entries(this.equipment)) {
            if (!s || k === 'quiver') continue;
            p += this._itemReg?.getItem(s.itemId)?.protection ?? 0;
        }
        return Math.min(p, 95);
    }

    get hasAnyArmor() {
        return ['head','chest','legs','feet','ears','hands','arms']
            .some(k => !!this.equipment[k]);
    }

    get hasQuiver() { return !!this.equipment.quiver; }

    // ── Serialization ─────────────────────────────────────────────────────────

    toJSON() {
        return {
            maxWeight:    this.maxWeight,
            hotbar:       this.hotbar,
            offhand:      this.offhand,
            equipment:    this.equipment,
            slots:        this.slots,
            quiverArrows: this.quiverArrows,
        };
    }

    fromJSON(data) {
        if (!data) return;
        this.maxWeight    = data.maxWeight    ?? 100;
        this.hotbar       = data.hotbar       ?? new Array(10).fill(null);
        this.offhand      = data.offhand      ?? null;
        this.equipment    = data.equipment    ?? {
            head:null,chest:null,legs:null,feet:null,ears:null,hands:null,arms:null,quiver:null
        };
        this.slots        = data.slots        ?? [];
        this.quiverArrows = data.quiverArrows ?? 0;
    }
}
