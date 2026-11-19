import { describe, expect, it } from 'vitest';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import { createTechTree } from '../src/logistics/techTree';
import { SimulationError, UnknownItemError } from '../src/types/contracts';
import {
  INSERTER_RECIPE,
  LOGISTICS_RECIPES,
  LOGISTICS_RECIPE_IDS,
  POWER_POLE_RECIPE,
  TRANSPORT_BELT_RECIPE,
  registerLogisticsRecipes,
} from '../src/recipes/logisticsRecipes';

describe('T33: Logistics Recipes (src/recipes/logisticsRecipes.ts)', () => {
  it('registers transport_belt, inserter, and power_pole in RecipeRegistry', () => {
    const registry = createRecipeRegistry();
    const registered = registerLogisticsRecipes(registry);

    expect(registered).toHaveLength(3);
    expect(registry.size).toBe(3);
    expect(LOGISTICS_RECIPE_IDS).toEqual(['transport_belt', 'inserter', 'power_pole']);

    for (const id of LOGISTICS_RECIPE_IDS) {
      expect(registry.has(id)).toBe(true);
    }

    const belt = registry.get('transport_belt');
    expect(belt.category).toBe('assembling');
    expect(belt.ingredients).toEqual([
      { itemId: 'iron_plate', count: 1 },
      { itemId: 'iron_gear', count: 1 },
    ]);
    expect(belt.outputs).toEqual([{ itemId: 'transport_belt', count: 2 }]);
    expect(belt.craftingTicks).toBe(30);
    expect(belt.requiredTech).toBeUndefined();

    const inserter = registry.get('inserter');
    expect(inserter.category).toBe('assembling');
    expect(inserter.ingredients).toEqual([
      { itemId: 'iron_plate', count: 1 },
      { itemId: 'iron_gear', count: 1 },
      { itemId: 'electronic_circuit', count: 1 },
    ]);
    expect(inserter.outputs).toEqual([{ itemId: 'inserter', count: 1 }]);
    expect(inserter.craftingTicks).toBe(30);
    expect(inserter.requiredTech).toBe('automation');

    const pole = registry.get('power_pole');
    expect(pole.category).toBe('assembling');
    expect(pole.ingredients).toEqual([
      { itemId: 'iron_plate', count: 2 },
      { itemId: 'copper_cable', count: 2 },
    ]);
    expect(pole.outputs).toEqual([{ itemId: 'power_pole', count: 2 }]);
    expect(pole.craftingTicks).toBe(30);
    expect(pole.requiredTech).toBe('solar_energy');
  });

  it('aligns requiredTech metadata with canonical TechTree (T20)', () => {
    const registry = createRecipeRegistry();
    registerLogisticsRecipes(registry);
    const techTree = createTechTree();

    for (const recipe of LOGISTICS_RECIPES) {
      const expectedTech = techTree.getRequiredTechForRecipe(recipe.id);
      expect(recipe.requiredTech ?? null).toBe(expectedTech);
    }

    // Before any tech is completed, only transport_belt is unlocked
    expect(registry.isRecipeUnlocked('transport_belt', [])).toBe(true);
    expect(registry.isRecipeUnlocked('inserter', [])).toBe(false);
    expect(registry.isRecipeUnlocked('power_pole', [])).toBe(false);

    // After automation, inserter is unlocked
    expect(registry.isRecipeUnlocked('inserter', ['automation'])).toBe(true);
    expect(registry.isRecipeUnlocked('power_pole', ['automation'])).toBe(false);

    // After solar_energy, power_pole is unlocked
    expect(registry.isRecipeUnlocked('power_pole', ['solar_energy'])).toBe(true);
  });

  it('produces immutable frozen recipe definitions', () => {
    expect(Object.isFrozen(LOGISTICS_RECIPES)).toBe(true);
    expect(Object.isFrozen(LOGISTICS_RECIPE_IDS)).toBe(true);
    for (const recipe of [TRANSPORT_BELT_RECIPE, INSERTER_RECIPE, POWER_POLE_RECIPE]) {
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.ingredients)).toBe(true);
      expect(Object.isFrozen(recipe.outputs)).toBe(true);
    }
  });

  it('fails closed on duplicate registration without corrupting registry', () => {
    const registry = createRecipeRegistry();
    registerLogisticsRecipes(registry);

    expect(() => registerLogisticsRecipes(registry)).toThrow(SimulationError);
    expect(registry.size).toBe(3);
  });

  it('fails closed atomically if item validator rejects any ingredient or output', () => {
    const restrictedRegistry = createRecipeRegistry(
      new Set(['iron_plate', 'iron_gear', 'transport_belt'])
    );

    expect(() => registerLogisticsRecipes(restrictedRegistry)).toThrow(UnknownItemError);
    expect(restrictedRegistry.size).toBe(0);
  });

  it('registers deterministically in identical order across independent registries', () => {
    const regA = createRecipeRegistry();
    const regB = createRecipeRegistry();

    registerLogisticsRecipes(regA);
    registerLogisticsRecipes(regB);

    expect(JSON.stringify(regA.listAll())).toBe(JSON.stringify(regB.listAll()));
  });
});
