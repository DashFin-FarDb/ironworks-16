import { describe, expect, it } from 'vitest';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import { isValidItemId } from '../src/core/itemRegistry';
import {
  GREEN_SCIENCE_RECIPE,
  RED_SCIENCE_RECIPE,
  SCIENCE_RECIPES,
  registerScienceRecipes,
} from '../src/recipes/scienceRecipes';
import { SimulationError, UnknownItemError } from '../src/types/contracts';

describe('T34: Science Recipes (src/recipes/scienceRecipes.ts)', () => {
  it('defines immutable red_science and green_science recipes', () => {
    expect(SCIENCE_RECIPES).toHaveLength(2);
    expect(Object.isFrozen(SCIENCE_RECIPES)).toBe(true);
    expect(Object.isFrozen(RED_SCIENCE_RECIPE)).toBe(true);
    expect(Object.isFrozen(RED_SCIENCE_RECIPE.ingredients)).toBe(true);
    expect(Object.isFrozen(RED_SCIENCE_RECIPE.outputs)).toBe(true);
    expect(Object.isFrozen(GREEN_SCIENCE_RECIPE)).toBe(true);
    expect(Object.isFrozen(GREEN_SCIENCE_RECIPE.ingredients)).toBe(true);
    expect(Object.isFrozen(GREEN_SCIENCE_RECIPE.outputs)).toBe(true);
  });

  it('registers red_science and green_science into RecipeRegistry with canonical T06 item validation', () => {
    const registry = createRecipeRegistry(isValidItemId);
    const registered = registerScienceRecipes(registry);

    expect(registered).toEqual(SCIENCE_RECIPES);
    expect(registry.size).toBe(2);
    expect(registry.has('red_science')).toBe(true);
    expect(registry.has('green_science')).toBe(true);
  });

  it('defines accurate red_science recipe properties', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerScienceRecipes(registry);

    const red = registry.get('red_science');
    expect(red.id).toBe('red_science');
    expect(red.category).toBe('assembling');
    expect(red.ingredients).toEqual([
      { itemId: 'copper_plate', count: 1 },
      { itemId: 'iron_gear', count: 1 },
    ]);
    expect(red.outputs).toEqual([{ itemId: 'red_science', count: 1 }]);
    expect(red.craftingTicks).toBe(300);
    expect(red.requiredTech).toBeUndefined();
    expect(registry.isRecipeUnlocked('red_science', [])).toBe(true);
  });

  it('defines accurate green_science recipe properties gated by logistics tech', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerScienceRecipes(registry);

    const green = registry.get('green_science');
    expect(green.id).toBe('green_science');
    expect(green.category).toBe('assembling');
    expect(green.ingredients).toEqual([
      { itemId: 'inserter', count: 1 },
      { itemId: 'transport_belt', count: 1 },
    ]);
    expect(green.outputs).toEqual([{ itemId: 'green_science', count: 1 }]);
    expect(green.craftingTicks).toBe(360);
    expect(green.requiredTech).toBe('logistics');
    expect(registry.isRecipeUnlocked('green_science', [])).toBe(false);
    expect(registry.isRecipeUnlocked('green_science', ['automation'])).toBe(false);
    expect(registry.isRecipeUnlocked('green_science', ['automation', 'logistics'])).toBe(true);
  });

  it('queries science recipes deterministically by category and output', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerScienceRecipes(registry);

    const assembling = registry.getByCategory('assembling');
    expect(assembling.map((r) => r.id)).toEqual(['red_science', 'green_science']);

    expect(registry.getByOutput('red_science').map((r) => r.id)).toEqual(['red_science']);
    expect(registry.getByOutput('green_science').map((r) => r.id)).toEqual(['green_science']);
  });

  it('fails closed on duplicate registration', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerScienceRecipes(registry);

    expect(() => registerScienceRecipes(registry)).toThrow(SimulationError);
    expect(registry.size).toBe(2);
  });

  it('fails closed atomically if item validator rejects any ingredient or output', () => {
    const restrictedValidator = (itemId: string) => itemId !== 'transport_belt';
    const registry = createRecipeRegistry(restrictedValidator);

    expect(() => registerScienceRecipes(registry)).toThrow(UnknownItemError);
    // Atomic registerMany ensures red_science is not partially registered
    expect(registry.size).toBe(0);
    expect(registry.has('red_science')).toBe(false);
    expect(registry.has('green_science')).toBe(false);
  });
});
