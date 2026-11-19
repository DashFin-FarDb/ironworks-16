/**
 * Ironworks-16 Intermediate Crafting Recipes (T32)
 *
 * Defines and registers intermediate assembling recipes:
 * - iron_gear (2 iron_plate -> 1 iron_gear, 30 ticks)
 * - copper_cable (1 copper_plate -> 2 copper_cable, 30 ticks)
 * - electronic_circuit (1 iron_plate + 3 copper_cable -> 1 electronic_circuit, 30 ticks, requires 'automation')
 *
 * Strictly headless and deterministic; zero DOM/Canvas/PRNG dependencies.
 */

import type { RecipeRegistry } from '../core/recipeRegistry';
import type { RecipeDefinition, RecipeId } from '../types/contracts';

function freezeRecipe(recipe: RecipeDefinition): RecipeDefinition {
  return Object.freeze({
    ...recipe,
    ingredients: Object.freeze(recipe.ingredients.map((ing) => Object.freeze({ ...ing }))),
    outputs: Object.freeze(recipe.outputs.map((out) => Object.freeze({ ...out }))),
  });
}

export const IRON_GEAR_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'iron_gear',
  name: 'Iron Gear Wheel',
  category: 'assembling',
  ingredients: [{ itemId: 'iron_plate', count: 2 }],
  outputs: [{ itemId: 'iron_gear', count: 1 }],
  craftingTicks: 30,
});

export const COPPER_CABLE_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'copper_cable',
  name: 'Copper Cable',
  category: 'assembling',
  ingredients: [{ itemId: 'copper_plate', count: 1 }],
  outputs: [{ itemId: 'copper_cable', count: 2 }],
  craftingTicks: 30,
});

export const ELECTRONIC_CIRCUIT_RECIPE: RecipeDefinition = freezeRecipe({
  id: 'electronic_circuit',
  name: 'Electronic Circuit',
  category: 'assembling',
  ingredients: [
    { itemId: 'iron_plate', count: 1 },
    { itemId: 'copper_cable', count: 3 },
  ],
  outputs: [{ itemId: 'electronic_circuit', count: 1 }],
  craftingTicks: 30,
  requiredTech: 'automation',
});

export const INTERMEDIATE_RECIPES: readonly RecipeDefinition[] = Object.freeze([
  IRON_GEAR_RECIPE,
  COPPER_CABLE_RECIPE,
  ELECTRONIC_CIRCUIT_RECIPE,
]);

export const INTERMEDIATE_RECIPE_IDS: readonly RecipeId[] = Object.freeze([
  'iron_gear',
  'copper_cable',
  'electronic_circuit',
]);

/**
 * Atomically registers all intermediate crafting recipes into the given RecipeRegistry.
 * Fails closed via RecipeRegistry.registerMany if any item ID is invalid or any recipe ID is duplicated.
 */
export function registerIntermediateRecipes(
  registry: RecipeRegistry
): readonly RecipeDefinition[] {
  registry.registerMany(INTERMEDIATE_RECIPES);
  return INTERMEDIATE_RECIPES;
}
