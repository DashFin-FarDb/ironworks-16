import { describe, expect, it } from 'vitest';
import { isValidItemId } from '../src/core/itemRegistry';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import {
  COPPER_CABLE_RECIPE,
  ELECTRONIC_CIRCUIT_RECIPE,
  INTERMEDIATE_RECIPES,
  INTERMEDIATE_RECIPE_IDS,
  IRON_GEAR_RECIPE,
  registerIntermediateRecipes,
} from '../src/recipes/intermediateRecipes';
import { SimulationError, UnknownItemError } from '../src/types/contracts';

describe('T32: Intermediate Crafting Recipes (src/recipes/intermediateRecipes.ts)', () => {
  it('registers iron_gear, copper_cable, and electronic_circuit into RecipeRegistry', () => {
    const registry = createRecipeRegistry(isValidItemId);
    const registered = registerIntermediateRecipes(registry);

    expect(registered).toBe(INTERMEDIATE_RECIPES);
    expect(registry.size).toBe(3);
    expect(INTERMEDIATE_RECIPE_IDS).toEqual([
      'iron_gear',
      'copper_cable',
      'electronic_circuit',
    ]);
    expect(registry.listAll().map((r) => r.id)).toEqual([
      'iron_gear',
      'copper_cable',
      'electronic_circuit',
    ]);
    expect(registry.getByCategory('assembling')).toHaveLength(3);
  });

  it('defines canonical ingredients, outputs, and crafting ticks for iron_gear', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerIntermediateRecipes(registry);

    const recipe = registry.get('iron_gear');
    expect(recipe).toEqual(IRON_GEAR_RECIPE);
    expect(recipe.category).toBe('assembling');
    expect(recipe.ingredients).toEqual([{ itemId: 'iron_plate', count: 2 }]);
    expect(recipe.outputs).toEqual([{ itemId: 'iron_gear', count: 1 }]);
    expect(recipe.craftingTicks).toBe(30);
    expect(recipe.requiredTech).toBeUndefined();
  });

  it('defines canonical ingredients, outputs, and crafting ticks for copper_cable', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerIntermediateRecipes(registry);

    const recipe = registry.get('copper_cable');
    expect(recipe).toEqual(COPPER_CABLE_RECIPE);
    expect(recipe.category).toBe('assembling');
    expect(recipe.ingredients).toEqual([{ itemId: 'copper_plate', count: 1 }]);
    expect(recipe.outputs).toEqual([{ itemId: 'copper_cable', count: 2 }]);
    expect(recipe.craftingTicks).toBe(30);
    expect(recipe.requiredTech).toBeUndefined();
  });

  it('defines canonical ingredients, outputs, crafting ticks, and automation tech gate for electronic_circuit', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerIntermediateRecipes(registry);

    const recipe = registry.get('electronic_circuit');
    expect(recipe).toEqual(ELECTRONIC_CIRCUIT_RECIPE);
    expect(recipe.category).toBe('assembling');
    expect(recipe.ingredients).toEqual([
      { itemId: 'iron_plate', count: 1 },
      { itemId: 'copper_cable', count: 3 },
    ]);
    expect(recipe.outputs).toEqual([{ itemId: 'electronic_circuit', count: 1 }]);
    expect(recipe.craftingTicks).toBe(30);
    expect(recipe.requiredTech).toBe('automation');
  });

  it('aligns recipe unlock gating with T20 TechTree (automation unlocks electronic_circuit)', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerIntermediateRecipes(registry);

    expect(registry.isRecipeUnlocked('iron_gear', [])).toBe(true);
    expect(registry.isRecipeUnlocked('copper_cable', [])).toBe(true);
    expect(registry.isRecipeUnlocked('electronic_circuit', [])).toBe(false);
    expect(registry.isRecipeUnlocked('electronic_circuit', ['automation'])).toBe(true);

    expect(registry.getUnlockedRecipes([]).map((r) => r.id)).toEqual([
      'iron_gear',
      'copper_cable',
    ]);
    expect(registry.getUnlockedRecipes(['automation']).map((r) => r.id)).toEqual([
      'iron_gear',
      'copper_cable',
      'electronic_circuit',
    ]);
  });

  it('keeps all intermediate recipes within Assembler Mk1 ingredient limit (<= 2) and deeply frozen', () => {
    expect(Object.isFrozen(INTERMEDIATE_RECIPES)).toBe(true);
    expect(Object.isFrozen(INTERMEDIATE_RECIPE_IDS)).toBe(true);

    for (const recipe of INTERMEDIATE_RECIPES) {
      expect(recipe.ingredients.length).toBeLessThanOrEqual(2);
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.ingredients)).toBe(true);
      expect(Object.isFrozen(recipe.outputs)).toBe(true);
      for (const ing of recipe.ingredients) {
        expect(Object.isFrozen(ing)).toBe(true);
      }
      for (const out of recipe.outputs) {
        expect(Object.isFrozen(out)).toBe(true);
      }
    }
  });

  it('fails closed on duplicate registration and invalid item validators (atomic)', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerIntermediateRecipes(registry);

    expect(() => registerIntermediateRecipes(registry)).toThrow(SimulationError);

    const restrictedRegistry = createRecipeRegistry(
      (itemId) => itemId !== 'copper_cable'
    );
    expect(() => registerIntermediateRecipes(restrictedRegistry)).toThrow(UnknownItemError);
    expect(restrictedRegistry.size).toBe(0);
  });
});
