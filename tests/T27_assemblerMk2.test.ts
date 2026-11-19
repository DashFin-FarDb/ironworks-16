import { describe, expect, it } from 'vitest';
import {
  ASSEMBLER_MK2_CRAFTING_SPEED,
  ASSEMBLER_MK2_INPUT_SLOTS,
  ASSEMBLER_MK2_MAX_INGREDIENTS,
  ASSEMBLER_MK2_OUTPUT_SLOTS,
  ASSEMBLER_MK2_POWER_DEMAND_KW,
  canAcceptRecipeMk2,
  createAssemblerMk2,
  extractAssemblerMk2Output,
  insertAssemblerMk2Ingredient,
  setAssemblerMk2Recipe,
  tickAllAssemblersMk2,
  tickAssemblerMk2,
} from '../src/machines/assemblerMk2.js';
import { createEventBus } from '../src/core/eventBus.js';
import { getItemCount, insertItem } from '../src/core/inventory.js';
import { createRecipeRegistry } from '../src/core/recipeRegistry.js';
import {
  AssemblerEntity,
  ItemProducedEvent,
  RecipeDefinition,
  ResearchState,
  SimulationError,
  UnknownRecipeError,
  WorldState,
} from '../src/types/contracts.js';

function makeTestRegistry() {
  const registry = createRecipeRegistry();
  const recipes: RecipeDefinition[] = [
    {
      id: 'iron_plate',
      name: 'Iron Plate',
      category: 'smelting',
      ingredients: [{ itemId: 'iron_ore', count: 1 }],
      outputs: [{ itemId: 'iron_plate', count: 1 }],
      craftingTicks: 180,
    },
    {
      id: 'iron_gear',
      name: 'Iron Gear Wheel',
      category: 'assembling',
      ingredients: [{ itemId: 'iron_plate', count: 2 }],
      outputs: [{ itemId: 'iron_gear', count: 1 }],
      craftingTicks: 30,
    },
    {
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
    },
    {
      id: 'green_science',
      name: 'Green Science Pack',
      category: 'assembling',
      ingredients: [
        { itemId: 'iron_plate', count: 1 },
        { itemId: 'copper_plate', count: 1 },
        { itemId: 'iron_gear', count: 1 },
        { itemId: 'electronic_circuit', count: 1 },
      ],
      outputs: [{ itemId: 'green_science', count: 1 }],
      craftingTicks: 60,
    },
    {
      id: 'power_pole',
      name: 'Five-Ingredient Test Recipe',
      category: 'assembling',
      ingredients: [
        { itemId: 'iron_plate', count: 1 },
        { itemId: 'copper_plate', count: 1 },
        { itemId: 'iron_gear', count: 1 },
        { itemId: 'copper_cable', count: 1 },
        { itemId: 'electronic_circuit', count: 1 },
      ],
      outputs: [{ itemId: 'power_pole', count: 1 }],
      craftingTicks: 60,
    },
  ];
  registry.registerMany(recipes);
  return registry;
}

function makeMinimalWorld(
  assemblers: AssemblerEntity[],
  satisfaction: number
): WorldState {
  const entities: WorldState['entities'] = {};
  const consumerIds: number[] = [];
  for (const a of assemblers) {
    a.powerNetworkId = 1;
    entities[a.id] = a;
    consumerIds.push(a.id);
  }
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 10,
    width: 16,
    height: 16,
    tiles: [],
    entities,
    nextEntityId: assemblers.length + 1,
    powerGrid: {
      networks: {
        1: {
          id: 1,
          poleIds: [],
          producerIds: [],
          consumerIds,
          accumulatorIds: [],
          totalSupplyKw: satisfaction * consumerIds.length * 150,
          totalDemandKw: consumerIds.length * 150,
          satisfaction,
        },
      },
      nextNetworkId: 2,
    },
    research: {
      activeTech: null,
      completedTechs: ['automation'],
      progress: {},
    },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

describe('T27: Assembler Mk2 (src/machines/assemblerMk2.ts)', () => {
  it('creates an Assembler Mk2 with canonical 150 kW, 0.75 speed, <=4 ingredient specs', () => {
    const mk2 = createAssemblerMk2(1, { x: 4, y: 5 }, 'E');
    expect(mk2.type).toBe('assembler_mk2');
    expect(mk2.powerDemandKw).toBe(ASSEMBLER_MK2_POWER_DEMAND_KW);
    expect(mk2.powerDemandKw).toBe(150);
    expect(mk2.craftingSpeed).toBe(ASSEMBLER_MK2_CRAFTING_SPEED);
    expect(mk2.craftingSpeed).toBe(0.75);
    expect(mk2.maxIngredients).toBe(ASSEMBLER_MK2_MAX_INGREDIENTS);
    expect(mk2.maxIngredients).toBe(4);
    expect(mk2.inputInventory.capacity).toBe(ASSEMBLER_MK2_INPUT_SLOTS);
    expect(mk2.outputInventory.capacity).toBe(ASSEMBLER_MK2_OUTPUT_SLOTS);
    expect(mk2.recipeId).toBeNull();
    expect(mk2.craftingProgress).toBe(0);
    expect(mk2.active).toBe(false);
  });

  it('fails closed on invalid entity creation parameters', () => {
    expect(() => createAssemblerMk2(0, { x: 0, y: 0 })).toThrow(SimulationError);
    expect(() => createAssemblerMk2(1, { x: 1.5, y: 0 })).toThrow(SimulationError);
    expect(() =>
      createAssemblerMk2(1, { x: 0, y: 0 }, 'NE' as unknown as 'N')
    ).toThrow(SimulationError);
  });

  it('accepts <=4 ingredient assembling recipes and rejects smelting or >4 ingredient recipes', () => {
    const registry = makeTestRegistry();
    const mk2 = createAssemblerMk2(1, { x: 0, y: 0 });

    expect(canAcceptRecipeMk2(registry.get('iron_gear'))).toBe(true);
    expect(canAcceptRecipeMk2(registry.get('green_science'))).toBe(true);
    expect(canAcceptRecipeMk2(registry.get('iron_plate'))).toBe(false);
    expect(canAcceptRecipeMk2(registry.get('power_pole'))).toBe(false);

    // 4-ingredient assembling recipe succeeds
    setAssemblerMk2Recipe(mk2, 'green_science', registry);
    expect(mk2.recipeId).toBe('green_science');

    // Smelting recipe fails closed
    expect(() => setAssemblerMk2Recipe(mk2, 'iron_plate', registry)).toThrow(
      SimulationError
    );

    // 5-ingredient recipe fails closed
    expect(() => setAssemblerMk2Recipe(mk2, 'power_pole', registry)).toThrow(
      SimulationError
    );

    // Unknown recipe fails closed
    expect(() =>
      setAssemblerMk2Recipe(mk2, 'unknown_recipe' as 'iron_gear', registry)
    ).toThrow(UnknownRecipeError);
  });

  it('enforces tech-tree recipe gating when researchState is provided', () => {
    const registry = makeTestRegistry();
    const mk2 = createAssemblerMk2(1, { x: 0, y: 0 });
    const lockedResearch: ResearchState = {
      activeTech: 'automation',
      completedTechs: [],
      progress: {},
    };
    const unlockedResearch: ResearchState = {
      activeTech: null,
      completedTechs: ['automation'],
      progress: {},
    };

    expect(() =>
      setAssemblerMk2Recipe(mk2, 'inserter', registry, lockedResearch)
    ).toThrow(SimulationError);

    setAssemblerMk2Recipe(mk2, 'inserter', registry, unlockedResearch);
    expect(mk2.recipeId).toBe('inserter');
  });

  it('crafts a 4-ingredient recipe at speed 0.75 (60 ticks -> 80 simulation ticks) and emits itemProduced', () => {
    const registry = makeTestRegistry();
    const bus = createEventBus();
    const producedEvents: ItemProducedEvent[] = [];
    bus.on('itemProduced', (ev) => producedEvents.push(ev));

    const mk2 = createAssemblerMk2(7, { x: 2, y: 3 });
    setAssemblerMk2Recipe(mk2, 'green_science', registry);

    // Insert 4 distinct ingredients
    expect(insertAssemblerMk2Ingredient(mk2, 'iron_plate', 2, registry)).toBe(2);
    expect(insertAssemblerMk2Ingredient(mk2, 'copper_plate', 2, registry)).toBe(2);
    expect(insertAssemblerMk2Ingredient(mk2, 'iron_gear', 2, registry)).toBe(2);
    expect(insertAssemblerMk2Ingredient(mk2, 'electronic_circuit', 2, registry)).toBe(2);
    // Non-ingredient is rejected with 0 inserted
    expect(insertAssemblerMk2Ingredient(mk2, 'coal', 5, registry)).toBe(0);

    // 60 craftingTicks / 0.75 speed = 80 ticks
    for (let t = 1; t <= 79; t++) {
      const res = tickAssemblerMk2(mk2, {
        recipeRegistry: registry,
        powerSatisfaction: 1.0,
        eventBus: bus,
        tick: t,
      });
      expect(res.active).toBe(true);
      expect(res.crafted).toBe(false);
      expect(res.progressDelta).toBeCloseTo(0.75, 10);
    }

    const finalRes = tickAssemblerMk2(mk2, {
      recipeRegistry: registry,
      powerSatisfaction: 1.0,
      eventBus: bus,
      tick: 80,
    });
    expect(finalRes.crafted).toBe(true);
    expect(finalRes.outputsProduced).toEqual([{ itemId: 'green_science', count: 1 }]);
    expect(finalRes.craftingProgress).toBe(0);

    // Verify exact item conservation
    expect(getItemCount(mk2.inputInventory, 'iron_plate')).toBe(1);
    expect(getItemCount(mk2.inputInventory, 'copper_plate')).toBe(1);
    expect(getItemCount(mk2.inputInventory, 'iron_gear')).toBe(1);
    expect(getItemCount(mk2.inputInventory, 'electronic_circuit')).toBe(1);
    expect(getItemCount(mk2.outputInventory, 'green_science')).toBe(1);

    // Verify event emitted
    expect(producedEvents).toEqual([
      { tick: 80, itemId: 'green_science', count: 1, entityId: 7 },
    ]);

    // Extract output
    expect(extractAssemblerMk2Output(mk2)).toEqual({
      itemId: 'green_science',
      count: 1,
    });
    expect(extractAssemblerMk2Output(mk2)).toBeNull();
  });

  it('scales crafting speed proportionally under 50% brownout and halts cleanly at 0% power', () => {
    const registry = makeTestRegistry();
    const mk2 = createAssemblerMk2(2, { x: 1, y: 1 });
    setAssemblerMk2Recipe(mk2, 'iron_gear', registry); // 30 craftingTicks
    insertAssemblerMk2Ingredient(mk2, 'iron_plate', 4, registry);

    // 0% power -> clean halt, zero progress
    const blackout = tickAssemblerMk2(mk2, {
      recipeRegistry: registry,
      powerSatisfaction: 0,
    });
    expect(blackout.active).toBe(false);
    expect(blackout.haltReason).toBe('no_power');
    expect(blackout.progressDelta).toBe(0);
    expect(mk2.craftingProgress).toBe(0);

    // 50% brownout -> 0.375 progress/tick -> 80 ticks for 30 craftingTicks
    for (let t = 1; t <= 79; t++) {
      const res = tickAssemblerMk2(mk2, {
        recipeRegistry: registry,
        powerSatisfaction: 0.5,
      });
      expect(res.active).toBe(true);
      expect(res.crafted).toBe(false);
      expect(res.progressDelta).toBeCloseTo(0.375, 10);
    }

    const done = tickAssemblerMk2(mk2, {
      recipeRegistry: registry,
      powerSatisfaction: 0.5,
    });
    expect(done.crafted).toBe(true);
    expect(getItemCount(mk2.outputInventory, 'iron_gear')).toBe(1);
    expect(getItemCount(mk2.inputInventory, 'iron_plate')).toBe(2);

    // Invalid satisfaction fails closed
    expect(() =>
      tickAssemblerMk2(mk2, {
        recipeRegistry: registry,
        powerSatisfaction: Number.NaN,
      })
    ).toThrow(SimulationError);
  });

  it('halts cleanly on output backpressure and missing ingredients without losing items', () => {
    const registry = makeTestRegistry();
    const mk2 = createAssemblerMk2(3, { x: 0, y: 0 });
    setAssemblerMk2Recipe(mk2, 'iron_gear', registry);

    // Missing ingredients (only 1 of 2 iron_plate)
    insertAssemblerMk2Ingredient(mk2, 'iron_plate', 1, registry);
    const missing = tickAssemblerMk2(mk2, {
      recipeRegistry: registry,
      powerSatisfaction: 1,
    });
    expect(missing.active).toBe(false);
    expect(missing.haltReason).toBe('missing_ingredients');
    expect(getItemCount(mk2.inputInventory, 'iron_plate')).toBe(1);

    // Fill output inventory to stack limit (50) and supply ingredients
    insertAssemblerMk2Ingredient(mk2, 'iron_plate', 2, registry);
    insertItem(mk2.outputInventory, 'iron_gear', 50);
    const blocked = tickAssemblerMk2(mk2, {
      recipeRegistry: registry,
      powerSatisfaction: 1,
    });
    expect(blocked.active).toBe(false);
    expect(blocked.haltReason).toBe('output_full');
    expect(getItemCount(mk2.inputInventory, 'iron_plate')).toBe(3);
    expect(getItemCount(mk2.outputInventory, 'iron_gear')).toBe(50);
  });

  it('ticks all Mk2 assemblers deterministically in ascending EntityId order via WorldState', () => {
    const registry = makeTestRegistry();
    const a1 = createAssemblerMk2(5, { x: 1, y: 1 }, 'N', 'iron_gear');
    const a2 = createAssemblerMk2(2, { x: 2, y: 1 }, 'N', 'iron_gear');
    insertAssemblerMk2Ingredient(a1, 'iron_plate', 4, registry);
    insertAssemblerMk2Ingredient(a2, 'iron_plate', 4, registry);

    const world = makeMinimalWorld([a1, a2], 1.0);
    const results = tickAllAssemblersMk2(world, { recipeRegistry: registry });

    expect(results.map((r) => r.entityId)).toEqual([2, 5]);
    expect(results[0]!.progressDelta).toBe(0.75);
    expect(results[1]!.progressDelta).toBe(0.75);
  });
});
