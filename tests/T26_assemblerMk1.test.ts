import { describe, expect, it } from 'vitest';
import {
  SimulationError,
  UnknownRecipeError,
  type ItemProducedEvent,
  type RecipeDefinition,
  type ResearchState,
  type WorldState,
} from '../src/types/contracts';
import { EventBus } from '../src/core/eventBus';
import { getItemCount, insertItem, removeItem } from '../src/core/inventory';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import {
  ASSEMBLER_MK1_CRAFTING_SPEED,
  ASSEMBLER_MK1_MAX_INGREDIENTS,
  ASSEMBLER_MK1_POWER_DEMAND_KW,
  canAssemblerMk1CraftRecipe,
  createAssemblerMk1,
  setAssemblerMk1Recipe,
  stepAssemblerMk1,
  tickAllAssemblersMk1,
  tickAssemblerMk1,
} from '../src/machines/assemblerMk1';

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
  craftingTicks: 60,
};

const IRON_PLATE_SMELTING: RecipeDefinition = {
  id: 'iron_plate',
  name: 'Iron Plate',
  category: 'smelting',
  ingredients: [{ itemId: 'iron_ore', count: 1 }],
  outputs: [{ itemId: 'iron_plate', count: 1 }],
  craftingTicks: 120,
};

const THREE_INGREDIENT_RECIPE: RecipeDefinition = {
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
};

const LOCKED_TWO_INGREDIENT_RECIPE: RecipeDefinition = {
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
};

function createTestRegistry() {
  return createRecipeRegistry(undefined, [
    IRON_GEAR_RECIPE,
    RED_SCIENCE_RECIPE,
    IRON_PLATE_SMELTING,
    THREE_INGREDIENT_RECIPE,
    LOCKED_TWO_INGREDIENT_RECIPE,
  ]);
}

function createMinimalWorld(satisfaction: number): WorldState {
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 10,
    width: 8,
    height: 8,
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
          totalSupplyKw: 900 * satisfaction,
          totalDemandKw: 900,
          satisfaction,
        },
      },
      nextNetworkId: 2,
    },
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

describe('T26: Assembler Mk1 (75 kW, <=2 ingredients, speed 0.5)', () => {
  it('initializes with canonical T26 specifications', () => {
    const asm = createAssemblerMk1(1, { x: 4, y: 5 });
    expect(asm.type).toBe('assembler_mk1');
    expect(asm.powerDemandKw).toBe(ASSEMBLER_MK1_POWER_DEMAND_KW);
    expect(asm.powerDemandKw).toBe(75);
    expect(asm.craftingSpeed).toBe(ASSEMBLER_MK1_CRAFTING_SPEED);
    expect(asm.craftingSpeed).toBe(0.5);
    expect(asm.maxIngredients).toBe(ASSEMBLER_MK1_MAX_INGREDIENTS);
    expect(asm.maxIngredients).toBe(2);
    expect(asm.inputInventory.capacity).toBe(2);
    expect(asm.outputInventory.capacity).toBe(1);
    expect(asm.footprint).toEqual({ width: 1, height: 1 });
    expect(asm.recipeId).toBeNull();
    expect(asm.craftingProgress).toBe(0);
    expect(asm.active).toBe(false);
  });

  it('validates recipe compatibility and fails closed on invalid recipes', () => {
    const registry = createTestRegistry();
    const asm = createAssemblerMk1(1, { x: 0, y: 0 });

    expect(canAssemblerMk1CraftRecipe(IRON_GEAR_RECIPE)).toBe(true);
    expect(canAssemblerMk1CraftRecipe(RED_SCIENCE_RECIPE)).toBe(true);
    expect(canAssemblerMk1CraftRecipe(IRON_PLATE_SMELTING)).toBe(false);
    expect(canAssemblerMk1CraftRecipe(THREE_INGREDIENT_RECIPE)).toBe(false);

    // Unknown recipe -> UnknownRecipeError
    expect(() =>
      setAssemblerMk1Recipe(asm, 'nonexistent_recipe' as never, registry)
    ).toThrow(UnknownRecipeError);

    // Smelting recipe -> INVALID_RECIPE_CATEGORY
    expect(() => setAssemblerMk1Recipe(asm, 'iron_plate', registry)).toThrow(
      SimulationError
    );

    // >2 ingredients -> TOO_MANY_INGREDIENTS
    expect(() => setAssemblerMk1Recipe(asm, 'inserter', registry)).toThrow(
      SimulationError
    );

    // Locked recipe when researchState provided -> RECIPE_LOCKED
    const lockedResearch: ResearchState = {
      activeTech: null,
      completedTechs: [],
      progress: {},
    };
    expect(() =>
      setAssemblerMk1Recipe(asm, 'electronic_circuit', registry, {
        researchState: lockedResearch,
      })
    ).toThrow(SimulationError);

    // Unlocked recipe succeeds and sets input slot filters on empty slots
    const unlockedResearch: ResearchState = {
      activeTech: null,
      completedTechs: ['automation'],
      progress: {},
    };
    setAssemblerMk1Recipe(asm, 'electronic_circuit', registry, {
      researchState: unlockedResearch,
    });
    expect(asm.recipeId).toBe('electronic_circuit');
    expect(asm.inputInventory.slots[0]?.filter).toBe('iron_plate');
    expect(asm.inputInventory.slots[1]?.filter).toBe('copper_cable');
  });

  it('crafts a 1-ingredient recipe at speed 0.5 (60 ticks for 30-tick recipe) and emits itemProduced', () => {
    const registry = createTestRegistry();
    const bus = new EventBus();
    const producedEvents: ItemProducedEvent[] = [];
    bus.on('itemProduced', (e) => producedEvents.push(e));

    const asm = createAssemblerMk1(7, { x: 2, y: 3 }, {
      recipeId: 'iron_gear',
      recipeRegistry: registry,
    });
    insertItem(asm.inputInventory, 'iron_plate', 4);

    // 59 ticks: still crafting, ingredients not yet consumed
    for (let t = 1; t <= 59; t++) {
      const res = stepAssemblerMk1(asm, {
        recipeRegistry: registry,
        powerSatisfaction: 1.0,
        tick: t,
        eventBus: bus,
      });
      expect(res.crafted).toBe(false);
      expect(res.active).toBe(true);
      expect(res.reason).toBe('crafting');
      expect(res.progressDelta).toBe(0.5);
    }
    expect(getItemCount(asm.inputInventory, 'iron_plate')).toBe(4);
    expect(getItemCount(asm.outputInventory, 'iron_gear')).toBe(0);

    // Tick 60: completes craft
    const done = stepAssemblerMk1(asm, {
      recipeRegistry: registry,
      powerSatisfaction: 1.0,
      tick: 60,
      eventBus: bus,
    });
    expect(done.crafted).toBe(true);
    expect(done.reason).toBe('crafted');
    expect(done.outputsProduced).toEqual([{ itemId: 'iron_gear', count: 1 }]);
    expect(asm.craftingProgress).toBe(0);
    expect(getItemCount(asm.inputInventory, 'iron_plate')).toBe(2);
    expect(getItemCount(asm.outputInventory, 'iron_gear')).toBe(1);
    expect(producedEvents).toEqual([
      { tick: 60, itemId: 'iron_gear', count: 1, entityId: 7 },
    ]);
  });

  it('crafts a 2-ingredient recipe (red_science) with strict item conservation', () => {
    const registry = createTestRegistry();
    const asm = createAssemblerMk1(2, { x: 1, y: 1 }, {
      recipeId: 'red_science',
      recipeRegistry: registry,
    });
    insertItem(asm.inputInventory, 'copper_plate', 2);
    insertItem(asm.inputInventory, 'iron_gear', 1);

    // 60 craftingTicks / 0.5 speed = 120 ticks
    let crafts = 0;
    for (let t = 1; t <= 120; t++) {
      const res = stepAssemblerMk1(asm, {
        recipeRegistry: registry,
        powerSatisfaction: 1.0,
        tick: t,
      });
      if (res.crafted) crafts++;
    }
    expect(crafts).toBe(1);
    expect(getItemCount(asm.inputInventory, 'copper_plate')).toBe(1);
    expect(getItemCount(asm.inputInventory, 'iron_gear')).toBe(0);
    expect(getItemCount(asm.outputInventory, 'red_science')).toBe(1);

    // Next tick halts cleanly due to missing iron_gear without consuming copper_plate
    const halted = stepAssemblerMk1(asm, {
      recipeRegistry: registry,
      powerSatisfaction: 1.0,
      tick: 121,
    });
    expect(halted.crafted).toBe(false);
    expect(halted.active).toBe(false);
    expect(halted.reason).toBe('missing_ingredients');
    expect(getItemCount(asm.inputInventory, 'copper_plate')).toBe(1);
  });

  it('scales crafting speed proportionally under 50% brownout and halts cleanly at 0% power', () => {
    const registry = createTestRegistry();
    const asm = createAssemblerMk1(3, { x: 0, y: 0 }, {
      recipeId: 'iron_gear',
      recipeRegistry: registry,
    });
    insertItem(asm.inputInventory, 'iron_plate', 2);

    // Zero power -> clean zero-progress halt
    const blackout = stepAssemblerMk1(asm, {
      recipeRegistry: registry,
      powerSatisfaction: 0,
      tick: 1,
    });
    expect(blackout.active).toBe(false);
    expect(blackout.reason).toBe('no_power');
    expect(blackout.progressDelta).toBe(0);
    expect(asm.craftingProgress).toBe(0);

    // 50% brownout -> 0.25 ticks/tick -> 120 ticks for 30-tick recipe
    let craftedAtTick = -1;
    for (let t = 1; t <= 120; t++) {
      const res = stepAssemblerMk1(asm, {
        recipeRegistry: registry,
        powerSatisfaction: 0.5,
        tick: t,
      });
      if (res.crafted) craftedAtTick = t;
    }
    expect(craftedAtTick).toBe(120);
    expect(getItemCount(asm.outputInventory, 'iron_gear')).toBe(1);

    // Invalid satisfaction fails closed
    expect(() =>
      stepAssemblerMk1(asm, {
        recipeRegistry: registry,
        powerSatisfaction: Number.NaN,
      })
    ).toThrow(SimulationError);
    expect(() =>
      stepAssemblerMk1(asm, {
        recipeRegistry: registry,
        powerSatisfaction: 1.2,
      })
    ).toThrow(SimulationError);
  });

  it('halts cleanly on output backpressure without losing ingredients and resumes when cleared', () => {
    const registry = createTestRegistry();
    const asm = createAssemblerMk1(4, { x: 0, y: 0 }, {
      recipeId: 'iron_gear',
      recipeRegistry: registry,
    });
    insertItem(asm.inputInventory, 'iron_plate', 4);
    // Fill output slot to default stack size (50)
    insertItem(asm.outputInventory, 'iron_gear', 50);

    const blocked = stepAssemblerMk1(asm, {
      recipeRegistry: registry,
      powerSatisfaction: 1.0,
      tick: 1,
    });
    expect(blocked.crafted).toBe(false);
    expect(blocked.active).toBe(false);
    expect(blocked.reason).toBe('output_full');
    expect(asm.craftingProgress).toBe(0);
    expect(getItemCount(asm.inputInventory, 'iron_plate')).toBe(4);
    expect(getItemCount(asm.outputInventory, 'iron_gear')).toBe(50);

    // Remove 1 gear -> assembler resumes
    removeItem(asm.outputInventory, 'iron_gear', 1);
    const resumed = stepAssemblerMk1(asm, {
      recipeRegistry: registry,
      powerSatisfaction: 1.0,
      tick: 2,
    });
    expect(resumed.active).toBe(true);
    expect(resumed.reason).toBe('crafting');
    expect(asm.craftingProgress).toBe(0.5);
  });

  it('preserves items when clearing or changing recipe', () => {
    const registry = createTestRegistry();
    const asm = createAssemblerMk1(5, { x: 0, y: 0 }, {
      recipeId: 'iron_gear',
      recipeRegistry: registry,
    });
    insertItem(asm.inputInventory, 'iron_plate', 5);
    stepAssemblerMk1(asm, { recipeRegistry: registry, powerSatisfaction: 1.0 });
    expect(asm.craftingProgress).toBe(0.5);

    setAssemblerMk1Recipe(asm, null, registry);
    expect(asm.recipeId).toBeNull();
    expect(asm.craftingProgress).toBe(0);
    expect(asm.active).toBe(false);
    expect(getItemCount(asm.inputInventory, 'iron_plate')).toBe(5);
  });

  it('integrates with WorldState powerGrid via tickAssemblerMk1 and tickAllAssemblersMk1 deterministically', () => {
    const registry = createTestRegistry();

    const runSim = () => {
      const world = createMinimalWorld(1.0);
      const a1 = createAssemblerMk1(10, { x: 1, y: 1 }, {
        recipeId: 'iron_gear',
        recipeRegistry: registry,
      });
      a1.powerNetworkId = 1;
      insertItem(a1.inputInventory, 'iron_plate', 4);

      const a2 = createAssemblerMk1(2, { x: 3, y: 1 }, {
        recipeId: 'iron_gear',
        recipeRegistry: registry,
      });
      // a2 is unconnected (powerNetworkId = null) -> should halt with no_power
      insertItem(a2.inputInventory, 'iron_plate', 4);

      world.entities[a1.id] = a1;
      world.entities[a2.id] = a2;

      const firstTick = tickAllAssemblersMk1(world, { recipeRegistry: registry });
      expect([...firstTick.keys()]).toEqual([2, 10]); // ascending EntityId order
      expect(firstTick.get(2)?.reason).toBe('no_power');
      expect(firstTick.get(10)?.reason).toBe('crafting');

      for (let i = 0; i < 59; i++) {
        world.tick++;
        tickAssemblerMk1(world, a1, { recipeRegistry: registry });
      }
      return JSON.stringify(world);
    };

    const runA = runSim();
    const runB = runSim();
    expect(runA).toBe(runB);
    expect(JSON.parse(runA).entities['10'].outputInventory.slots[0].item).toEqual({
      itemId: 'iron_gear',
      count: 1,
    });
  });
});
