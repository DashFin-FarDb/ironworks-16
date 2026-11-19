/**
 * Ironworks-16 Smelting Recipes (T31)
 *
 * Canonical smelting recipe definitions for iron_plate, copper_plate,
 * stone_brick, and steel_plate, plus registration helper for RecipeRegistry (T07).
 * Strictly headless and deterministic.
 */

import type { RecipeDefinition } from '../types/contracts';
import type { RecipeRegistry } from '../core/recipeRegistry';

export type SmeltingRecipeId =
  | 'iron_plate'
  | 'copper_plate'
  | 'stone_brick'
  | 'steel_plate';

function freezeRecipe(recipe: RecipeDefinition): RecipeDefinition {
  return Object.freeze({
    ...recipe,
    ingredients: Object.freeze(recipe.ingredients.map((ing) => Object.freeze({ ...ing }))),
    outputs: Object.freeze(recipe.outputs.map((out) => Object.freeze({ ...out }))),
  });
}

export const IRON_PLATE_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'iron_plate',
  name: 'Iron Plate',
  category: 'smelting',
  ingredients: [{ itemId: 'iron_ore', count: 1 }],
  outputs: [{ itemId: 'iron_plate', count: 1 }],
  craftingTicks: 192,
});

export const COPPER_PLATE_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'copper_plate',
  name: 'Copper Plate',
  category: 'smelting',
  ingredients: [{ itemId: 'copper_ore', count: 1 }],
  outputs: [{ itemId: 'copper_plate', count: 1 }],
  craftingTicks: 192,
});

export const STONE_BRICK_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'stone_brick',
  name: 'Stone Brick',
  category: 'smelting',
  ingredients: [{ itemId: 'stone', count: 2 }],
  outputs: [{ itemId: 'stone_brick', count: 1 }],
  craftingTicks: 192,
});

export const STEEL_PLATE_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'steel_plate',
  name: 'Steel Plate',
  category: 'smelting',
  ingredients: [{ itemId: 'iron_plate', count: 5 }],
  outputs: [{ itemId: 'steel_plate', count: 1 }],
  craftingTicks: 960,
  requiredTech: 'steel_processing',
});

/**
 * All canonical smelting recipes in deterministic registration order.
 */
export const SMELTING_RECIPES: readonly RecipeDefinition[] = Object.freeze([
  IRON_PLATE_RECIPE,
  COPPER_PLATE_RECIPE,
  STONE_BRICK_RECIPE,
  STEEL_PLATE_RECIPE,
]);

/**
 * Lookup map of canonical smelting recipes keyed by SmeltingRecipeId.
 */
export const SMELTING_RECIPE_BY_ID: Readonly<Record<SmeltingRecipeId, RecipeDefinition>> =
  Object.freeze({
    iron_plate: IRON_PLATE_RECIPE,
    copper_plate: COPPER_PLATE_RECIPE,
    stone_brick: STONE_BRICK_RECIPE,
    steel_plate: STEEL_PLATE_RECIPE,
  });

/**
 * Atomically registers all canonical smelting recipes into the given RecipeRegistry.
 * Fails closed if any recipe is already registered or if the registry's item validator
 * rejects any ingredient/output ItemId.
 */
export function registerSmeltingRecipes(
  registry: RecipeRegistry
): readonly RecipeDefinition[] {
  registry.registerMany(SMELTING_RECIPES);
  return SMELTING_RECIPES;
}
