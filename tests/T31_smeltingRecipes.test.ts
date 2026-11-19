import { describe, expect, it } from 'vitest';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import { isValidItemId } from '../src/core/itemRegistry';
import { SimulationError, UnknownItemError } from '../src/types/contracts';
import {
  COPPER_PLATE_RECIPE,
  IRON_PLATE_RECIPE,
  SMELTING_RECIPES,
  SMELTING_RECIPE_BY_ID,
  STEEL_PLATE_RECIPE,
  STONE_BRICK_RECIPE,
  registerSmeltingRecipes,
} from '../src/recipes/smeltingRecipes';

describe('T31: Smelting Recipes', () => {
  it('registers all four canonical smelting recipes into a RecipeRegistry', () => {
    const registry = createRecipeRegistry(isValidItemId);
    const registered = registerSmeltingRecipes(registry);

    expect(registered).toHaveLength(4);
    expect(registry.size).toBe(4);
    expect(registry.getByCategory('smelting').map((r) => r.id)).toEqual([
      'iron_plate',
      'copper_plate',
      'stone_brick',
      'steel_plate',
    ]);
  });

  it('defines exact ingredients, outputs, and crafting ticks for each smelting recipe', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerSmeltingRecipes(registry);

    expect(registry.get('iron_plate')).toEqual({
      id: 'iron_plate',
      name: 'Iron Plate',
      category: 'smelting',
      ingredients: [{ itemId: 'iron_ore', count: 1 }],
      outputs: [{ itemId: 'iron_plate', count: 1 }],
      craftingTicks: 192,
    });

    expect(registry.get('copper_plate')).toEqual({
      id: 'copper_plate',
      name: 'Copper Plate',
      category: 'smelting',
      ingredients: [{ itemId: 'copper_ore', count: 1 }],
      outputs: [{ itemId: 'copper_plate', count: 1 }],
      craftingTicks: 192,
    });

    expect(registry.get('stone_brick')).toEqual({
      id: 'stone_brick',
      name: 'Stone Brick',
      category: 'smelting',
      ingredients: [{ itemId: 'stone', count: 2 }],
      outputs: [{ itemId: 'stone_brick', count: 1 }],
      craftingTicks: 192,
    });

    expect(registry.get('steel_plate')).toEqual({
      id: 'steel_plate',
      name: 'Steel Plate',
      category: 'smelting',
      ingredients: [{ itemId: 'iron_plate', count: 5 }],
      outputs: [{ itemId: 'steel_plate', count: 1 }],
      craftingTicks: 960,
      requiredTech: 'steel_processing',
    });
  });

  it('supports furnace auto-recipe selection via findSmeltingRecipeForInput', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerSmeltingRecipes(registry);

    expect(registry.findSmeltingRecipeForInput('iron_ore')?.id).toBe('iron_plate');
    expect(registry.findSmeltingRecipeForInput('copper_ore')?.id).toBe('copper_plate');
    expect(registry.findSmeltingRecipeForInput('stone')?.id).toBe('stone_brick');
    expect(registry.findSmeltingRecipeForInput('iron_plate')?.id).toBe('steel_plate');
    expect(registry.findSmeltingRecipeForInput('coal')).toBeNull();
  });

  it('gates steel_plate behind steel_processing while keeping base smelting unlocked', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerSmeltingRecipes(registry);

    expect(registry.isRecipeUnlocked('iron_plate', [])).toBe(true);
    expect(registry.isRecipeUnlocked('copper_plate', [])).toBe(true);
    expect(registry.isRecipeUnlocked('stone_brick', [])).toBe(true);
    expect(registry.isRecipeUnlocked('steel_plate', [])).toBe(false);
    expect(registry.isRecipeUnlocked('steel_plate', ['steel_processing'])).toBe(true);
  });

  it('fails closed on duplicate registration or missing item definitions', () => {
    const registry = createRecipeRegistry(isValidItemId);
    registerSmeltingRecipes(registry);

    expect(() => registerSmeltingRecipes(registry)).toThrow(SimulationError);

    const restrictedRegistry = createRecipeRegistry(new Set(['iron_ore', 'iron_plate']));
    expect(() => registerSmeltingRecipes(restrictedRegistry)).toThrow(UnknownItemError);
    expect(restrictedRegistry.size).toBe(0);
  });

  it('exports deeply frozen recipe definitions and lookup map', () => {
    expect(Object.isFrozen(SMELTING_RECIPES)).toBe(true);
    expect(Object.isFrozen(SMELTING_RECIPE_BY_ID)).toBe(true);
    expect(SMELTING_RECIPE_BY_ID.iron_plate).toBe(IRON_PLATE_RECIPE);
    expect(SMELTING_RECIPE_BY_ID.copper_plate).toBe(COPPER_PLATE_RECIPE);
    expect(SMELTING_RECIPE_BY_ID.stone_brick).toBe(STONE_BRICK_RECIPE);
    expect(SMELTING_RECIPE_BY_ID.steel_plate).toBe(STEEL_PLATE_RECIPE);

    for (const recipe of SMELTING_RECIPES) {
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.ingredients)).toBe(true);
      expect(Object.isFrozen(recipe.outputs)).toBe(true);
    }
  });
});
