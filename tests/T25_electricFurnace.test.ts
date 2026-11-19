import { describe, expect, it } from 'vitest';
import {
  SimulationError,
  UnknownRecipeError,
  type ItemProducedEvent,
  type RecipeDefinition,
  type WorldState,
} from '../src/types/contracts';
import { createEventBus } from '../src/core/eventBus';
import { getItemCount } from '../src/core/inventory';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import {
  ELECTRIC_FURNACE_CRAFTING_SPEED,
  ELECTRIC_FURNACE_POWER_DEMAND_KW,
  createElectricFurnace,
  extractElectricFurnaceOutput,
  insertElectricFurnaceInput,
  tickAllElectricFurnaces,
  tickElectricFurnace,
} from '../src/machines/electricFurnace';

const SMELTING_RECIPES: readonly RecipeDefinition[] = [
  {
    id: 'iron_plate',
    name: 'Iron Plate',
    category: 'smelting',
    ingredients: [{ itemId: 'iron_ore', count: 1 }],
    outputs: [{ itemId: 'iron_plate', count: 1 }],
    craftingTicks: 180,
  },
  {
    id: 'steel_plate',
    name: 'Steel Plate',
    category: 'smelting',
    ingredients: [{ itemId: 'iron_plate', count: 5 }],
    outputs: [{ itemId: 'steel_plate', count: 1 }],
    craftingTicks: 300,
    requiredTech: 'steel_processing',
  },
  {
    id: 'iron_gear',
    name: 'Iron Gear',
    category: 'assembling',
    ingredients: [{ itemId: 'iron_plate', count: 2 }],
    outputs: [{ itemId: 'iron_gear', count: 1 }],
    craftingTicks: 30,
  },
];

function createTestWorld(satisfaction: number, completedTechs: WorldState['research']['completedTechs'] = []): WorldState {
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width: 16,
    height: 16,
    tiles: [],
    entities: {},
    nextEntityId: 1,
    powerGrid: {
      networks: {
        1: {
          id: 1,
          poleIds: [],
          producerIds: [],
          consumerIds: [],
          accumulatorIds: [],
          totalSupplyKw: 180 * satisfaction,
          totalDemandKw: 180,
          satisfaction,
        },
      },
      nextNetworkId: 2,
    },
    research: {
      activeTech: null,
      completedTechs: [...completedTechs],
      progress: {},
    },
    dayNight: {
      cycleTick: 0,
      solarFactor: 1,
    },
    stats: {
      byItem: {},
    },
  };
}

describe('T25: Electric Furnace', () => {
  it('creates an electric furnace with 180 kW power demand and 2x crafting speed', () => {
    const furnace = createElectricFurnace(1, { x: 4, y: 5 }, 'E');
    expect(furnace.type).toBe('electric_furnace');
    expect(furnace.powerDemandKw).toBe(180);
    expect(ELECTRIC_FURNACE_POWER_DEMAND_KW).toBe(180);
    expect(ELECTRIC_FURNACE_CRAFTING_SPEED).toBe(2);
    expect(furnace.inputInventory.capacity).toBe(1);
    expect(furnace.outputInventory.capacity).toBe(1);
    expect(furnace.activeRecipe).toBeNull();
    expect(furnace.craftingProgress).toBe(0);
    expect(furnace.active).toBe(false);
  });

  it('smelts at 2x Stone Furnace speed (90 ticks for a 180-tick recipe) at 100% power', () => {
    const world = createTestWorld(1.0);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);
    const eventBus = createEventBus();
    const producedEvents: ItemProducedEvent[] = [];
    eventBus.on('itemProduced', (ev) => producedEvents.push(ev));

    const furnace = createElectricFurnace(1, { x: 2, y: 2 });
    furnace.powerNetworkId = 1;
    world.entities[furnace.id] = furnace;

    expect(insertElectricFurnaceInput(furnace, 'iron_ore', 2)).toBe(2);

    // Tick 1..89: in progress
    for (let t = 1; t <= 89; t++) {
      world.tick = t;
      const res = tickElectricFurnace(furnace, { world, recipeRegistry: registry, eventBus });
      expect(res.active).toBe(true);
      expect(res.effectiveSpeed).toBe(2);
      expect(res.completedRecipe).toBeNull();
    }
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(1);
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(0);

    // Tick 90: completes first iron_plate
    world.tick = 90;
    const completion = tickElectricFurnace(furnace, { world, recipeRegistry: registry, eventBus });
    expect(completion.active).toBe(true);
    expect(completion.completedRecipe).toBe('iron_plate');
    expect(completion.producedItems).toEqual([{ itemId: 'iron_plate', count: 1 }]);
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(1);
    expect(producedEvents).toEqual([
      { tick: 90, itemId: 'iron_plate', count: 1, entityId: 1 },
    ]);

    expect(extractElectricFurnaceOutput(furnace, 'iron_plate', 1)).toBe(1);
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(0);
  });

  it('scales smelting speed proportionally under a 50% brownout (180 ticks for 180-tick recipe)', () => {
    const world = createTestWorld(0.5);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);
    const furnace = createElectricFurnace(2, { x: 3, y: 3 });
    furnace.powerNetworkId = 1;
    world.entities[furnace.id] = furnace;

    insertElectricFurnaceInput(furnace, 'iron_ore', 1);

    for (let t = 1; t <= 179; t++) {
      world.tick = t;
      const res = tickElectricFurnace(furnace, { world, recipeRegistry: registry });
      expect(res.active).toBe(true);
      expect(res.satisfaction).toBe(0.5);
      expect(res.effectiveSpeed).toBe(1);
      expect(res.completedRecipe).toBeNull();
    }

    world.tick = 180;
    const res = tickElectricFurnace(furnace, { world, recipeRegistry: registry });
    expect(res.completedRecipe).toBe('iron_plate');
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(1);
  });

  it('halts cleanly with zero progress and zero consumption under blackout or disconnected power', () => {
    const world = createTestWorld(0.0);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);
    const furnace = createElectricFurnace(3, { x: 1, y: 1 });
    furnace.powerNetworkId = 1;
    world.entities[furnace.id] = furnace;

    insertElectricFurnaceInput(furnace, 'iron_ore', 5);

    const resBlackout = tickElectricFurnace(furnace, { world, recipeRegistry: registry });
    expect(resBlackout.active).toBe(false);
    expect(resBlackout.haltReason).toBe('no_power');
    expect(resBlackout.effectiveSpeed).toBe(0);
    expect(furnace.craftingProgress).toBe(0);
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(5);

    // Unconnected furnace also halts cleanly
    furnace.powerNetworkId = null;
    world.powerGrid.networks[1]!.satisfaction = 1.0;
    const resDisconnected = tickElectricFurnace(furnace, { world, recipeRegistry: registry });
    expect(resDisconnected.active).toBe(false);
    expect(resDisconnected.haltReason).toBe('no_power');
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(5);
  });

  it('preserves item conservation when output is full before or during crafting', () => {
    const world = createTestWorld(1.0);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);
    const furnace = createElectricFurnace(4, { x: 2, y: 2 });
    furnace.powerNetworkId = 1;
    world.entities[furnace.id] = furnace;

    const smallStack = () => 1;
    insertElectricFurnaceInput(furnace, 'iron_ore', 1, smallStack);

    // Fill output with a different item so iron_plate cannot fit
    furnace.outputInventory.slots[0]!.item = { itemId: 'copper_plate', count: 1 };

    const blockedStart = tickElectricFurnace(furnace, {
      world,
      recipeRegistry: registry,
      getStackSize: smallStack,
    });
    expect(blockedStart.active).toBe(false);
    expect(blockedStart.haltReason).toBe('output_full');
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(1);

    // Clear output, run 89 ticks so craft is almost done, then fill output mid-craft
    furnace.outputInventory.slots[0]!.item = null;
    for (let t = 1; t <= 89; t++) {
      tickElectricFurnace(furnace, { world, recipeRegistry: registry, getStackSize: smallStack });
    }
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(0);

    furnace.outputInventory.slots[0]!.item = { itemId: 'copper_plate', count: 1 };
    const blockedEnd = tickElectricFurnace(furnace, {
      world,
      recipeRegistry: registry,
      getStackSize: smallStack,
    });
    expect(blockedEnd.active).toBe(false);
    expect(blockedEnd.haltReason).toBe('output_full');
    expect(furnace.craftingProgress).toBe(180);

    // Free output slot -> delivers the waiting iron_plate with zero loss
    furnace.outputInventory.slots[0]!.item = null;
    const delivered = tickElectricFurnace(furnace, {
      world,
      recipeRegistry: registry,
      getStackSize: smallStack,
    });
    expect(delivered.completedRecipe).toBe('iron_plate');
    expect(getItemCount(furnace.outputInventory, 'iron_plate')).toBe(1);
  });

  it('respects tech-tree recipe unlocks and insufficient ingredient checks', () => {
    const world = createTestWorld(1.0, []);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);
    const furnace = createElectricFurnace(5, { x: 5, y: 5 });
    furnace.powerNetworkId = 1;
    world.entities[furnace.id] = furnace;

    insertElectricFurnaceInput(furnace, 'iron_plate', 3);

    // Locked before steel_processing is researched
    const lockedRes = tickElectricFurnace(furnace, { world, recipeRegistry: registry });
    expect(lockedRes.active).toBe(false);
    expect(lockedRes.haltReason).toBe('recipe_locked');
    expect(getItemCount(furnace.inputInventory, 'iron_plate')).toBe(3);

    // Unlock steel_processing -> still needs 5 iron_plate, only 3 available
    world.research.completedTechs.push('steel_processing');
    const insufficientRes = tickElectricFurnace(furnace, { world, recipeRegistry: registry });
    expect(insufficientRes.active).toBe(false);
    expect(insufficientRes.haltReason).toBe('insufficient_ingredients');
    expect(getItemCount(furnace.inputInventory, 'iron_plate')).toBe(3);

    // Add 2 more iron_plate -> begins smelting steel_plate (300 ticks / 2 = 150 ticks)
    insertElectricFurnaceInput(furnace, 'iron_plate', 2);
    for (let t = 1; t <= 150; t++) {
      world.tick = t;
      tickElectricFurnace(furnace, { world, recipeRegistry: registry });
    }
    expect(getItemCount(furnace.inputInventory, 'iron_plate')).toBe(0);
    expect(getItemCount(furnace.outputInventory, 'steel_plate')).toBe(1);
  });

  it('fails closed on corrupted craftingProgress, unknown activeRecipe, or non-smelting recipe', () => {
    const world = createTestWorld(1.0);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);
    const furnace = createElectricFurnace(6, { x: 0, y: 0 });
    furnace.powerNetworkId = 1;

    furnace.craftingProgress = Number.NaN;
    expect(() => tickElectricFurnace(furnace, { world, recipeRegistry: registry })).toThrow(
      SimulationError
    );

    furnace.craftingProgress = 10;
    furnace.activeRecipe = 'nonexistent_recipe' as never;
    expect(() => tickElectricFurnace(furnace, { world, recipeRegistry: registry })).toThrow(
      UnknownRecipeError
    );

    furnace.activeRecipe = 'iron_gear';
    expect(() => tickElectricFurnace(furnace, { world, recipeRegistry: registry })).toThrow(
      SimulationError
    );
  });

  it('ticks all electric furnaces in deterministic ascending EntityId order', () => {
    const world = createTestWorld(1.0);
    const registry = createRecipeRegistry(undefined, SMELTING_RECIPES);

    const f10 = createElectricFurnace(10, { x: 1, y: 1 });
    const f2 = createElectricFurnace(2, { x: 2, y: 2 });
    f10.powerNetworkId = 1;
    f2.powerNetworkId = 1;
    world.entities[10] = f10;
    world.entities[2] = f2;

    const results = tickAllElectricFurnaces(world, registry);
    expect(results.map((r) => r.entityId)).toEqual([2, 10]);
  });
});
