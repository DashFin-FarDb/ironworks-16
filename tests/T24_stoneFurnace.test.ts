import { describe, it, expect } from 'vitest';
import {
  createStoneFurnace,
  extractFurnaceOutput,
  insertFurnaceFuel,
  insertFurnaceInput,
  STONE_FURNACE_FUEL_BURN_KJ_PER_TICK,
  tickStoneFurnace,
} from '../src/machines/stoneFurnace';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import { getItemCount, insertItem } from '../src/core/inventory';
import { getFuelValueKj, getStackSize } from '../src/core/itemRegistry';
import { EventBus } from '../src/core/eventBus';
import {
  SimulationError,
  type ItemProducedEvent,
  type RecipeDefinition,
} from '../src/types/contracts';

const TEST_SMELTING_RECIPES: readonly RecipeDefinition[] = [
  {
    id: 'iron_plate',
    name: 'Iron Plate',
    category: 'smelting',
    ingredients: [{ itemId: 'iron_ore', count: 1 }],
    outputs: [{ itemId: 'iron_plate', count: 1 }],
    craftingTicks: 10,
  },
  {
    id: 'copper_plate',
    name: 'Copper Plate',
    category: 'smelting',
    ingredients: [{ itemId: 'copper_ore', count: 1 }],
    outputs: [{ itemId: 'copper_plate', count: 1 }],
    craftingTicks: 10,
  },
  {
    id: 'stone_brick',
    name: 'Stone Brick',
    category: 'smelting',
    ingredients: [{ itemId: 'stone', count: 2 }],
    outputs: [{ itemId: 'stone_brick', count: 1 }],
    craftingTicks: 10,
  },
  {
    id: 'steel_plate',
    name: 'Steel Plate',
    category: 'smelting',
    ingredients: [{ itemId: 'iron_plate', count: 5 }],
    outputs: [{ itemId: 'steel_plate', count: 1 }],
    craftingTicks: 20,
    requiredTech: 'steel_processing',
  },
];

describe('T24: Stone Furnace', () => {
  it('auto-selects iron_plate recipe and smelts iron_ore using coal fuel', () => {
    const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
    const furnace = createStoneFurnace(1, { x: 4, y: 4 });
    const eventBus = new EventBus();
    const events: ItemProducedEvent[] = [];
    eventBus.on('itemProduced', (e) => events.push(e));

    insertFurnaceInput(furnace, 'iron_ore', 3);
    insertFurnaceFuel(furnace, 'coal', 1);

    for (let tick = 1; tick <= 10; tick++) {
      const res = tickStoneFurnace(furnace, {
        recipeRegistry: registry,
        tick,
        eventBus,
      });
      expect(res.active).toBe(true);
      expect(res.activeRecipe).toBe('iron_plate');
      expect(res.haltReason).toBeNull();
      if (tick < 10) {
        expect(res.completed).toBe(false);
      } else {
        expect(res.completed).toBe(true);
        expect(res.produced).toEqual([{ itemId: 'iron_plate', count: 1 }]);
      }
    }

    // 1 coal burned (4000 kJ) minus 10 ticks * 1.5 kJ/tick
    expect(getItemCount(furnace.fuelInventory, 'coal')).toBe(0);
    expect(furnace.fuelEnergyKj).toBeCloseTo(
      getFuelValueKj('coal') - 10 * STONE_FURNACE_FUEL_BURN_KJ_PER_TICK,
      9
    );
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(2);
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(1);
    expect(events).toEqual([
      { tick: 10, itemId: 'iron_plate', count: 1, entityId: 1 },
    ]);

    const extracted = extractFurnaceOutput(furnace, 1);
    expect(extracted).toEqual({ itemId: 'iron_plate', count: 1 });
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(0);
  });

  it('auto-switches recipes when input changes (iron_ore -> copper_ore -> stone)', () => {
    const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
    const furnace = createStoneFurnace(2, { x: 5, y: 5 });
    insertFurnaceFuel(furnace, 'coal', 2);

    // Smelt 1 copper_ore
    insertFurnaceInput(furnace, 'copper_ore', 1);
    for (let t = 0; t < 10; t++) {
      tickStoneFurnace(furnace, { recipeRegistry: registry });
    }
    expect(furnace.activeRecipe).toBe('copper_plate');
    expect(extractFurnaceOutput(furnace)).toEqual({ itemId: 'copper_plate', count: 1 });

    // Now insert 2 stone -> auto-selects stone_brick
    insertFurnaceInput(furnace, 'stone', 2);
    for (let t = 0; t < 10; t++) {
      tickStoneFurnace(furnace, { recipeRegistry: registry });
    }
    expect(furnace.activeRecipe).toBe('stone_brick');
    expect(extractFurnaceOutput(furnace)).toEqual({ itemId: 'stone_brick', count: 1 });
  });

  it('respects tech-gated smelting recipes (steel_plate requires steel_processing)', () => {
    const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
    const furnace = createStoneFurnace(3, { x: 6, y: 6 });
    insertFurnaceInput(furnace, 'iron_plate', 5);
    insertFurnaceFuel(furnace, 'coal', 1);

    // Locked without steel_processing
    const lockedRes = tickStoneFurnace(furnace, {
      recipeRegistry: registry,
      completedTechs: [],
    });
    expect(lockedRes.active).toBe(false);
    expect(lockedRes.haltReason).toBe('recipe_locked');
    expect(lockedRes.fuelBurnedKj).toBe(0);
    expect(getItemCount(furnace.fuelInventory, 'coal')).toBe(1);

    // Unlocked with steel_processing
    for (let t = 0; t < 20; t++) {
      tickStoneFurnace(furnace, {
        recipeRegistry: registry,
        completedTechs: ['steel_processing'],
      });
    }
    expect(getItemCount(furnace.inputInventory, 'iron_plate')).toBe(0);
    expect(getItemCount(furnace.outputInventory, 'steel_plate')).toBe(1);
  });

  it('halts cleanly without burning fuel on insufficient ingredients, no_input, no_recipe, or output_full', () => {
    const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
    const furnace = createStoneFurnace(4, { x: 7, y: 7 });
    insertFurnaceFuel(furnace, 'coal', 1);

    // 1. no_input
    const r1 = tickStoneFurnace(furnace, { recipeRegistry: registry });
    expect(r1.haltReason).toBe('no_input');
    expect(r1.fuelBurnedKj).toBe(0);

    // 2. insufficient_ingredients (1 stone, needs 2)
    insertFurnaceInput(furnace, 'stone', 1);
    const r2 = tickStoneFurnace(furnace, { recipeRegistry: registry });
    expect(r2.haltReason).toBe('insufficient_ingredients');
    expect(r2.fuelBurnedKj).toBe(0);

    // 3. output_full (fill output slot to stackSize = 100)
    insertFurnaceInput(furnace, 'stone', 1); // now 2 stone
    insertItem(furnace.outputInventory, 'stone_brick', getStackSize('stone_brick'), getStackSize);
    const r3 = tickStoneFurnace(furnace, { recipeRegistry: registry });
    expect(r3.haltReason).toBe('output_full');
    expect(r3.active).toBe(false);
    expect(r3.fuelBurnedKj).toBe(0);
    // Coal was never consumed during any of the halted ticks
    expect(getItemCount(furnace.fuelInventory, 'coal')).toBe(1);
    expect(getItemCount(furnace.inputInventory, 'stone')).toBe(2);
  });

  it('pauses progress cleanly when out of fuel and resumes when refueled', () => {
    const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
    const furnace = createStoneFurnace(5, { x: 8, y: 8 });
    insertFurnaceInput(furnace, 'iron_ore', 1);

    // Give exactly 5 ticks worth of fuel energy
    furnace.fuelEnergyKj = 5 * STONE_FURNACE_FUEL_BURN_KJ_PER_TICK;

    for (let t = 0; t < 5; t++) {
      const res = tickStoneFurnace(furnace, { recipeRegistry: registry });
      expect(res.active).toBe(true);
    }
    expect(furnace.craftingProgress).toBe(5);
    expect(furnace.fuelEnergyKj).toBe(0);

    // 6th tick: out of fuel -> halts with progress preserved
    const halted = tickStoneFurnace(furnace, { recipeRegistry: registry });
    expect(halted.active).toBe(false);
    expect(halted.haltReason).toBe('no_fuel');
    expect(furnace.craftingProgress).toBe(5);
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(1);

    // Refuel and finish remaining 5 ticks
    insertFurnaceFuel(furnace, 'coal', 1);
    for (let t = 0; t < 5; t++) {
      tickStoneFurnace(furnace, { recipeRegistry: registry });
    }
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(0);
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(1);
  });

  it('fails closed on non-fuel items and corrupted furnace state', () => {
    const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
    const furnace = createStoneFurnace(6, { x: 9, y: 9 });

    expect(() => insertFurnaceFuel(furnace, 'iron_ore', 1)).toThrow(SimulationError);

    furnace.fuelEnergyKj = Number.NaN;
    expect(() => tickStoneFurnace(furnace, { recipeRegistry: registry })).toThrow(
      SimulationError
    );
  });

  it('is strictly deterministic across two independent runs', () => {
    const run = () => {
      const registry = createRecipeRegistry(undefined, TEST_SMELTING_RECIPES);
      const furnace = createStoneFurnace(10, { x: 2, y: 3 });
      insertFurnaceInput(furnace, 'iron_ore', 5);
      insertFurnaceFuel(furnace, 'coal', 1);
      for (let t = 0; t < 35; t++) {
        tickStoneFurnace(furnace, { recipeRegistry: registry, tick: t });
      }
      return JSON.stringify(furnace);
    };

    expect(run()).toBe(run());
  });
});
