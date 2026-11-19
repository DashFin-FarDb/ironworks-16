import { describe, expect, it } from 'vitest';
import {
  CANONICAL_ITEM_IDS,
  RecipeRegistry,
  createRecipeRegistry,
} from '../src/core/recipeRegistry';
import {
  type ItemId,
  type RecipeDefinition,
  SimulationError,
  UnknownItemError,
  UnknownRecipeError,
} from '../src/types/contracts';

const IRON_PLATE_RECIPE: RecipeDefinition = {
  id: 'iron_plate',
  name: 'Iron Plate',
  category: 'smelting',
  ingredients: [{ itemId: 'iron_ore', count: 1 }],
  outputs: [{ itemId: 'iron_plate', count: 1 }],
  craftingTicks: 192,
};

const STEEL_PLATE_RECIPE: RecipeDefinition = {
  id: 'steel_plate',
  name: 'Steel Plate',
  category: 'smelting',
  ingredients: [{ itemId: 'iron_plate', count: 5 }],
  outputs: [{ itemId: 'steel_plate', count: 1 }],
  craftingTicks: 960,
  requiredTech: 'steel_processing',
};

const IRON_GEAR_RECIPE: RecipeDefinition = {
  id: 'iron_gear',
  name: 'Iron Gear Wheel',
  category: 'assembling',
  ingredients: [{ itemId: 'iron_plate', count: 2 }],
  outputs: [{ itemId: 'iron_gear', count: 1 }],
  craftingTicks: 30,
};

const RED_SCIENCE_RECIPE: RecipeDefinition = {
  id: 'red_science',
  name: 'Automation Science Pack',
  category: 'assembling',
  ingredients: [
    { itemId: 'copper_plate', count: 1 },
    { itemId: 'iron_gear', count: 1 },
  ],
  outputs: [{ itemId: 'red_science', count: 1 }],
  craftingTicks: 300,
};

describe('T07 RecipeRegistry', () => {
  it('registers and retrieves valid recipes deterministically', () => {
    const registry = createRecipeRegistry();
    registry.register(IRON_PLATE_RECIPE);
    registry.register(IRON_GEAR_RECIPE);

    expect(registry.size).toBe(2);
    expect(registry.has('iron_plate')).toBe(true);
    expect(registry.has('copper_plate')).toBe(false);
    expect(registry.get('iron_plate')).toEqual(IRON_PLATE_RECIPE);
    expect(registry.listAll().map((r) => r.id)).toEqual(['iron_plate', 'iron_gear']);
  });

  it('fails closed with UnknownItemError when an ingredient ItemId is unknown', () => {
    const registry = new RecipeRegistry();
    const invalidRecipe: RecipeDefinition = {
      id: 'iron_plate',
      name: 'Invalid Smelt',
      category: 'smelting',
      ingredients: [{ itemId: 'unobtanium' as ItemId, count: 1 }],
      outputs: [{ itemId: 'iron_plate', count: 1 }],
      craftingTicks: 60,
    };

    expect(() => registry.register(invalidRecipe)).toThrowError(UnknownItemError);
    expect(registry.size).toBe(0);
  });

  it('fails closed with UnknownItemError when an output ItemId is unknown', () => {
    const registry = new RecipeRegistry();
    const invalidRecipe: RecipeDefinition = {
      id: 'iron_plate',
      name: 'Invalid Output',
      category: 'smelting',
      ingredients: [{ itemId: 'iron_ore', count: 1 }],
      outputs: [{ itemId: 'mythril_plate' as ItemId, count: 1 }],
      craftingTicks: 60,
    };

    expect(() => registry.register(invalidRecipe)).toThrowError(UnknownItemError);
    expect(registry.size).toBe(0);
  });

  it('validates against an injected T06-style ItemRegistry (hasItem / has / predicate / Set)', () => {
    const limitedRegistry = {
      hasItem: (id: string) => id === 'iron_ore' || id === 'iron_plate',
    };
    const registry = new RecipeRegistry(limitedRegistry);

    registry.register(IRON_PLATE_RECIPE);
    expect(registry.has('iron_plate')).toBe(true);

    // copper_plate is not in limitedRegistry, so RED_SCIENCE_RECIPE must fail closed
    expect(() => registry.register(RED_SCIENCE_RECIPE)).toThrowError(UnknownItemError);

    // Also works with predicate function
    const predicateRegistry = new RecipeRegistry((id) => CANONICAL_ITEM_IDS.has(id as ItemId));
    predicateRegistry.register(RED_SCIENCE_RECIPE);
    expect(predicateRegistry.has('red_science')).toBe(true);
  });

  it('registerMany is atomic and leaves no partial state on failure', () => {
    const registry = new RecipeRegistry();
    const badRecipe: RecipeDefinition = {
      id: 'copper_plate',
      name: 'Bad Copper',
      category: 'smelting',
      ingredients: [{ itemId: 'fake_ore' as ItemId, count: 1 }],
      outputs: [{ itemId: 'copper_plate', count: 1 }],
      craftingTicks: 192,
    };

    expect(() => registry.registerMany([IRON_PLATE_RECIPE, badRecipe])).toThrowError(
      UnknownItemError
    );
    expect(registry.size).toBe(0);
    expect(registry.has('iron_plate')).toBe(false);
  });

  it('fails closed with UnknownRecipeError on missing recipe lookup', () => {
    const registry = new RecipeRegistry();
    expect(() => registry.get('iron_plate')).toThrowError(UnknownRecipeError);
    expect(() => registry.isRecipeUnlocked('iron_plate', [])).toThrowError(UnknownRecipeError);
  });

  it('rejects duplicate recipe IDs and malformed recipe definitions', () => {
    const registry = new RecipeRegistry(undefined, [IRON_PLATE_RECIPE]);

    expect(() => registry.register(IRON_PLATE_RECIPE)).toThrowError(SimulationError);

    expect(() =>
      registry.register({
        ...IRON_GEAR_RECIPE,
        craftingTicks: 0,
      })
    ).toThrowError(SimulationError);

    expect(() =>
      registry.register({
        ...IRON_GEAR_RECIPE,
        ingredients: [],
      })
    ).toThrowError(SimulationError);

    expect(() =>
      registry.register({
        ...IRON_GEAR_RECIPE,
        ingredients: [{ itemId: 'iron_plate', count: 0 }],
      })
    ).toThrowError(SimulationError);

    expect(() =>
      registry.register({
        ...IRON_GEAR_RECIPE,
        outputs: [{ itemId: 'iron_gear', count: 1.5 }],
      })
    ).toThrowError(SimulationError);
  });

  it('supports category, output, smelting auto-selection, and tech-unlock queries', () => {
    const registry = new RecipeRegistry(undefined, [
      IRON_PLATE_RECIPE,
      STEEL_PLATE_RECIPE,
      IRON_GEAR_RECIPE,
      RED_SCIENCE_RECIPE,
    ]);

    expect(registry.getByCategory('smelting').map((r) => r.id)).toEqual([
      'iron_plate',
      'steel_plate',
    ]);
    expect(registry.getByCategory('assembling').map((r) => r.id)).toEqual([
      'iron_gear',
      'red_science',
    ]);

    expect(registry.getByOutput('iron_gear').map((r) => r.id)).toEqual(['iron_gear']);
    expect(() => registry.getByOutput('bogus' as ItemId)).toThrowError(UnknownItemError);

    expect(registry.findSmeltingRecipeForInput('iron_ore')?.id).toBe('iron_plate');
    expect(registry.findSmeltingRecipeForInput('iron_plate')?.id).toBe('steel_plate');
    expect(registry.findSmeltingRecipeForInput('coal')).toBeNull();

    expect(registry.isRecipeUnlocked('iron_plate', [])).toBe(true);
    expect(registry.isRecipeUnlocked('steel_plate', [])).toBe(false);
    expect(registry.isRecipeUnlocked('steel_plate', ['steel_processing'])).toBe(true);

    expect(registry.getUnlockedRecipes([]).map((r) => r.id)).toEqual([
      'iron_plate',
      'iron_gear',
      'red_science',
    ]);
    expect(registry.getUnlockedRecipes(new Set(['steel_processing'])).map((r) => r.id)).toEqual([
      'iron_plate',
      'steel_plate',
      'iron_gear',
      'red_science',
    ]);
  });

  it('freezes registered recipes to prevent external mutation', () => {
    const registry = new RecipeRegistry();
    registry.register(IRON_PLATE_RECIPE);

    const stored = registry.get('iron_plate');
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.ingredients)).toBe(true);
    expect(Object.isFrozen(stored.outputs)).toBe(true);
  });
});
