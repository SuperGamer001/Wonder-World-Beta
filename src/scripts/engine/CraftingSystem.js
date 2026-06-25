/**
 * CraftingSystem — recipe lookup and execution.
 *
 * Recipes are loaded from gamepack data/recipes/ JSON files.
 * Each recipe specifies a crafting station, ingredients, and result.
 */
export class CraftingSystem {
    constructor() {
        this._recipes = [];   // all recipe definitions
    }

    /** Load all recipe definitions (called during gamepack load). */
    loadRecipes(recipes) {
        this._recipes.push(...recipes);
    }

    /**
     * Return all recipes craftable at the given station.
     * @param {string|null} station  e.g. 'hand' | 'crafting_table' | 'oven' | 'smelter' | null
     */
    getRecipesForStation(station) {
        return this._recipes.filter(r => r.station === (station ?? 'hand'));
    }

    /** All recipes the player can currently craft (ingredients met). */
    getCraftableRecipes(inventory, station = null) {
        return this.getRecipesForStation(station).filter(r =>
            inventory.hasIngredients(this._ingredientMap(r))
        );
    }

    /**
     * Attempt to craft a recipe.
     * Returns the result { itemId, count } on success, or null on failure.
     * Removes ingredients from inventory and tries to add result.
     */
    craft(recipeId, inventory) {
        const recipe = this._recipes.find(r => r.id === recipeId);
        if (!recipe) return null;

        const needs = this._ingredientMap(recipe);
        if (!inventory.hasIngredients(needs)) return null;

        // Remove ingredients
        for (const [itemId, count] of Object.entries(needs)) {
            inventory.removeItem(itemId, count);
        }

        // Add result — if no room, the caller should drop the item in the world
        const overflow = inventory.addItem(recipe.result.itemId, recipe.result.count);
        return { itemId: recipe.result.itemId, count: recipe.result.count, overflow };
    }

    _ingredientMap(recipe) {
        const map = {};
        for (const ing of recipe.ingredients) {
            map[ing.itemId] = (map[ing.itemId] ?? 0) + ing.count;
        }
        return map;
    }

    getAllRecipes() { return this._recipes; }
}
