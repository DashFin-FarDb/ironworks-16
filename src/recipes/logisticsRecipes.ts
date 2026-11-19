/**
 * Ironworks-16 Logistics Recipes (T33)
 *
 * Registers crafting recipes for logistics infrastructure:
 * - transport_belt
 * - inserter
 * - power_pole
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: immutable frozen recipe definitions.
 */

import type { RecipeDefinition, RecipeId } from '../types/contracts';
import type { RecipeRegistry } from '../core/recipeRegistry';

function freezeRecipeDefinition(recipe: RecipeDefinition): RecipeDefinition {
  return Object.freeze({
    ...recipe,
    ingredients: Object.freeze(recipe.ingredients.map((ing) => Object.freeze({ ...ing }))),
    outputs: Object.freeze(recipe.outputs.map((out) => Object.freeze({ ...out }))),
  });
}

export const LOGISTICS_RECIPE_IDS: readonly RecipeId[] = Object.freeze([
  'transport_belt',
  'inserter',
  'power_pole',
] as const);

export const TRANSPORT_BELT_RECIPE: RecipeDefinition = freezeRecipeDefinition({
  id: 'transport_belt',
  name: 'Transport Belt',
  category: 'assembling',
  ingredients: [
    { itemId: 'iron_plate', count: 1 },
    { itemId: 'iron_gear', count: 1 },
  ],
  outputs: [{ itemId: 'transport_belt', count: 2 }],
  craftingTicks: 30,
});

export const INSERTER_RECIPE: RecipeDefinition = freezeRecipeDefinition({
  id: 'inserter',
  name: 'Inserter',
  category: 'assembling',
  ingredients: [
    { itemId: 'iron_plate', count: 1 },
    { itemId: 'iron_gear', count: 1 },
    { itemId: 'electronic_circuit', count: 1 },
  ],
  outputs: [{ itemId: 'inserter', count: 1 }],
  craftingTicks: 30,
  requiredTech: 'automation',
});

export const POWER_POLE_RECIPE: RecipeDefinition = freezeRecipeDefinition({
  id: 'power_pole',
  name: 'Power Pole',
  category: 'assembling',
  ingredients: [
    { itemId: 'iron_plate', count: 2 },
    { itemId: 'copper_cable', count: 2 },
  ],
  outputs: [{ itemId: 'power_pole', count: 2 }],
  craftingTicks: 30,
  requiredTech: 'solar_energy',
});

export const LOGISTICS_RECIPES: readonly RecipeDefinition[] = Object.freeze([
  TRANSPORT_BELT_RECIPE,
  INSERTER_RECIPE,
  POWER_POLE_RECIPE,
]);

/**
 * Atomically registers all logistics recipes (`transport_belt`, `inserter`, `power_pole`)
 * into the provided RecipeRegistry. Fails closed on duplicate IDs or unknown ItemIds.
 */
export function registerLogisticsRecipes(
  registry: RecipeRegistry
): readonly RecipeDefinition[] {
  registry.registerMany(LOGISTICS_RECIPES);
  return LOGISTICS_RECIPES;
}
