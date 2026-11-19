/**
 * Ironworks-16 Science Recipes (T34)
 *
 * Defines and registers the crafting recipes for Red Science (`red_science`)
 * and Green Science (`green_science`) packs.
 *
 * Strictly headless and deterministic; all recipe definitions are deeply frozen
 * and validated against the RecipeRegistry (T07) on registration.
 */

import { type RecipeDefinition } from '../types/contracts';
import { type RecipeRegistry } from '../core/recipeRegistry';

function freezeRecipeDefinition(recipe: RecipeDefinition): RecipeDefinition {
  return Object.freeze({
    ...recipe,
    ingredients: Object.freeze(recipe.ingredients.map((ing) => Object.freeze({ ...ing }))),
    outputs: Object.freeze(recipe.outputs.map((out) => Object.freeze({ ...out }))),
  });
}

/**
 * Red Science Pack recipe:
 * 1 Copper Plate + 1 Iron Gear -> 1 Red Science Pack (300 ticks / 5s base).
 * Available from the start (no requiredTech) and craftable in Assembler Mk1 (<= 2 ingredients).
 */
export const RED_SCIENCE_RECIPE: RecipeDefinition = freezeRecipeDefinition({
  id: 'red_science',
  name: 'Red Science Pack',
  category: 'assembling',
  ingredients: [
    { itemId: 'copper_plate', count: 1 },
    { itemId: 'iron_gear', count: 1 },
  ],
  outputs: [{ itemId: 'red_science', count: 1 }],
  craftingTicks: 300,
});

/**
 * Green Science Pack recipe:
 * 1 Inserter + 1 Transport Belt -> 1 Green Science Pack (360 ticks / 6s base).
 * Unlocked by the `logistics` technology (T20).
 */
export const GREEN_SCIENCE_RECIPE: RecipeDefinition = freezeRecipeDefinition({
  id: 'green_science',
  name: 'Green Science Pack',
  category: 'assembling',
  ingredients: [
    { itemId: 'inserter', count: 1 },
    { itemId: 'transport_belt', count: 1 },
  ],
  outputs: [{ itemId: 'green_science', count: 1 }],
  craftingTicks: 360,
  requiredTech: 'logistics',
});

/**
 * All science crafting recipes in deterministic registration order.
 */
export const SCIENCE_RECIPES: readonly RecipeDefinition[] = Object.freeze([
  RED_SCIENCE_RECIPE,
  GREEN_SCIENCE_RECIPE,
]);

/**
 * Registers all science recipes (`red_science`, `green_science`) into the given
 * RecipeRegistry atomically. Fails closed if any recipe is duplicate or if any
 * ingredient/output ItemId is invalid according to the registry's item validator.
 */
export function registerScienceRecipes(
  registry: RecipeRegistry
): readonly RecipeDefinition[] {
  registry.registerMany(SCIENCE_RECIPES);
  return SCIENCE_RECIPES;
}
