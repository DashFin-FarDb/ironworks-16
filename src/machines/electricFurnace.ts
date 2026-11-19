/**
 * Ironworks-16 Electric Furnace (T25)
 *
 * 180 kW electric smelter operating at 2x Stone Furnace speed, scaled
 * proportionally by power network satisfaction. Auto-selects smelting recipes
 * from its input inventory and respects tech-tree recipe unlocks.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 * Fail-closed: throws typed SimulationError on invalid state; halts cleanly
 * on zero power, locked recipes, missing ingredients, or full output.
 */

import {
  SimulationError,
  type Direction,
  type ElectricFurnaceEntity,
  type EntityFootprint,
  type EntityId,
  type ItemId,
  type ItemStack,
  type RecipeDefinition,
  type RecipeId,
  type TileCoord,
  type WorldState,
} from '../types/contracts';
import type { EventBus } from '../core/eventBus';
import {
  canInsert,
  consumeIngredients,
  createInventoryState,
  defaultStackSizeResolver,
  getFirstAvailableItem,
  hasItems,
  insertItem,
  removeItem,
  type StackSizeResolver,
} from '../core/inventory';
import type { RecipeRegistry } from '../core/recipeRegistry';
import {
  getEntityPowerSatisfaction,
  scaleMachineSpeed,
} from '../logistics/powerSolver';

// ============================================================================
// Constants
// ============================================================================

export const ELECTRIC_FURNACE_POWER_DEMAND_KW = 180;
export const ELECTRIC_FURNACE_CRAFTING_SPEED = 2;
export const ELECTRIC_FURNACE_INPUT_SLOTS = 1;
export const ELECTRIC_FURNACE_OUTPUT_SLOTS = 1;
export const ELECTRIC_FURNACE_FOOTPRINT: EntityFootprint = {
  width: 1,
  height: 1,
};

// ============================================================================
// Types
// ============================================================================

export type ElectricFurnaceHaltReason =
  | 'no_power'
  | 'no_input'
  | 'no_recipe'
  | 'recipe_locked'
  | 'insufficient_ingredients'
  | 'output_full';

export interface ElectricFurnaceTickContext {
  readonly world: WorldState;
  readonly recipeRegistry: RecipeRegistry;
  readonly eventBus?: EventBus;
  readonly getStackSize?: StackSizeResolver;
}

export interface ElectricFurnaceTickResult {
  readonly entityId: EntityId;
  readonly active: boolean;
  readonly satisfaction: number;
  readonly effectiveSpeed: number;
  readonly completedRecipe: RecipeId | null;
  readonly producedItems: readonly ItemStack[];
  readonly haltReason: ElectricFurnaceHaltReason | null;
}

// ============================================================================
// Factory & Inventory Helpers
// ============================================================================

/**
 * Creates a new ElectricFurnaceEntity with canonical 180 kW demand and 1-slot
 * input/output inventories.
 */
export function createElectricFurnace(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N'
): ElectricFurnaceEntity {
  return {
    id,
    type: 'electric_furnace',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { ...ELECTRIC_FURNACE_FOOTPRINT },
    powerNetworkId: null,
    active: false,
    powerDemandKw: ELECTRIC_FURNACE_POWER_DEMAND_KW,
    inputInventory: createInventoryState(ELECTRIC_FURNACE_INPUT_SLOTS),
    outputInventory: createInventoryState(ELECTRIC_FURNACE_OUTPUT_SLOTS),
    activeRecipe: null,
    craftingProgress: 0,
  };
}

/**
 * Inserts items into an Electric Furnace's input inventory.
 * Returns the number of items actually inserted.
 */
export function insertElectricFurnaceInput(
  furnace: ElectricFurnaceEntity,
  itemId: ItemId,
  count: number,
  getStackSize: StackSizeResolver = defaultStackSizeResolver
): number {
  return insertItem(furnace.inputInventory, itemId, count, getStackSize);
}

/**
 * Extracts items from an Electric Furnace's output inventory.
 * Returns the number of items actually removed.
 */
export function extractElectricFurnaceOutput(
  furnace: ElectricFurnaceEntity,
  itemId: ItemId,
  count: number
): number {
  return removeItem(furnace.outputInventory, itemId, count);
}

// ============================================================================
// Internal Validation & Output Helpers
// ============================================================================

function assertValidFurnaceState(furnace: ElectricFurnaceEntity): void {
  if (!Number.isFinite(furnace.craftingProgress) || furnace.craftingProgress < 0) {
    throw new SimulationError(
      'INVALID_CRAFTING_PROGRESS',
      `Electric furnace ${furnace.id} has invalid craftingProgress: ${String(furnace.craftingProgress)}.`
    );
  }
  if (!Number.isFinite(furnace.powerDemandKw) || furnace.powerDemandKw < 0) {
    throw new SimulationError(
      'INVALID_POWER_VALUE',
      `Electric furnace ${furnace.id} has invalid powerDemandKw: ${String(furnace.powerDemandKw)}.`
    );
  }
}

function assertSmeltingRecipe(
  furnace: ElectricFurnaceEntity,
  recipe: RecipeDefinition
): void {
  if (recipe.category !== 'smelting') {
    throw new SimulationError(
      'INVALID_FURNACE_RECIPE',
      `Electric furnace ${furnace.id} cannot execute non-smelting recipe "${recipe.id}" (category: "${recipe.category}").`
    );
  }
}

function canFitRecipeOutputs(
  furnace: ElectricFurnaceEntity,
  recipe: RecipeDefinition,
  getStackSize: StackSizeResolver
): boolean {
  for (const output of recipe.outputs) {
    if (
      canInsert(furnace.outputInventory, output.itemId, output.count, getStackSize) <
      output.count
    ) {
      return false;
    }
  }
  return true;
}

function deliverRecipeOutputs(
  furnace: ElectricFurnaceEntity,
  recipe: RecipeDefinition,
  world: WorldState,
  getStackSize: StackSizeResolver,
  eventBus?: EventBus
): ItemStack[] {
  const produced: ItemStack[] = [];
  for (const output of recipe.outputs) {
    const inserted = insertItem(
      furnace.outputInventory,
      output.itemId,
      output.count,
      getStackSize
    );
    if (inserted !== output.count) {
      throw new SimulationError(
        'OUTPUT_CONSERVATION_VIOLATION',
        `Electric furnace ${furnace.id} failed to insert full output (${inserted}/${output.count}) of "${output.itemId}".`
      );
    }
    produced.push({ itemId: output.itemId, count: inserted });
    if (eventBus) {
      eventBus.emit('itemProduced', {
        tick: world.tick,
        itemId: output.itemId,
        count: inserted,
        entityId: furnace.id,
      });
    }
  }
  return produced;
}

// ============================================================================
// Simulation Tick
// ============================================================================

/**
 * Advances a single Electric Furnace by one simulation tick.
 *
 * - Speed is `ELECTRIC_FURNACE_CRAFTING_SPEED (2.0) * powerSatisfaction`.
 * - Zero power satisfaction (unconnected or blackout) halts cleanly with zero progress.
 * - Ingredients are consumed atomically when a craft begins; if output fills
 *   before completion, progress clamps at `craftingTicks` and waits without
 *   losing items.
 */
export function tickElectricFurnace(
  furnace: ElectricFurnaceEntity,
  context: ElectricFurnaceTickContext
): ElectricFurnaceTickResult {
  assertValidFurnaceState(furnace);

  const { world, recipeRegistry, eventBus } = context;
  const getStackSize = context.getStackSize ?? defaultStackSizeResolver;

  const satisfaction = getEntityPowerSatisfaction(world, furnace);
  const effectiveSpeed = scaleMachineSpeed(
    ELECTRIC_FURNACE_CRAFTING_SPEED,
    satisfaction
  );

  if (effectiveSpeed <= 0) {
    furnace.active = false;
    return {
      entityId: furnace.id,
      active: false,
      satisfaction,
      effectiveSpeed: 0,
      completedRecipe: null,
      producedItems: [],
      haltReason: 'no_power',
    };
  }

  let recipe: RecipeDefinition | null = null;

  // Case 1: Mid-craft (ingredients already consumed)
  if (furnace.activeRecipe !== null && furnace.craftingProgress > 0) {
    recipe = recipeRegistry.get(furnace.activeRecipe);
    assertSmeltingRecipe(furnace, recipe);
  } else {
    // Case 2: Idle — select or validate smelting recipe from input inventory
    const inputItem = getFirstAvailableItem(furnace.inputInventory);
    if (inputItem === null) {
      furnace.activeRecipe = null;
      furnace.craftingProgress = 0;
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'no_input',
      };
    }

    recipe = recipeRegistry.findSmeltingRecipeForInput(inputItem);
    if (recipe === null) {
      furnace.activeRecipe = null;
      furnace.craftingProgress = 0;
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'no_recipe',
      };
    }

    assertSmeltingRecipe(furnace, recipe);

    if (!recipeRegistry.isRecipeUnlocked(recipe.id, world.research.completedTechs)) {
      furnace.activeRecipe = null;
      furnace.craftingProgress = 0;
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'recipe_locked',
      };
    }

    if (!hasItems(furnace.inputInventory, recipe.ingredients)) {
      furnace.activeRecipe = recipe.id;
      furnace.craftingProgress = 0;
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'insufficient_ingredients',
      };
    }

    if (!canFitRecipeOutputs(furnace, recipe, getStackSize)) {
      furnace.activeRecipe = recipe.id;
      furnace.craftingProgress = 0;
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'output_full',
      };
    }

    // Atomically consume ingredients to begin the craft
    const consumed = consumeIngredients(furnace.inputInventory, recipe.ingredients);
    if (!consumed) {
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'insufficient_ingredients',
      };
    }

    furnace.activeRecipe = recipe.id;
    furnace.craftingProgress = 0;
  }

  // Advance crafting progress
  furnace.craftingProgress += effectiveSpeed;

  if (furnace.craftingProgress >= recipe.craftingTicks) {
    if (!canFitRecipeOutputs(furnace, recipe, getStackSize)) {
      // Output became full mid-craft: clamp progress and wait without losing items
      furnace.craftingProgress = recipe.craftingTicks;
      furnace.active = false;
      return {
        entityId: furnace.id,
        active: false,
        satisfaction,
        effectiveSpeed,
        completedRecipe: null,
        producedItems: [],
        haltReason: 'output_full',
      };
    }

    const producedItems = deliverRecipeOutputs(
      furnace,
      recipe,
      world,
      getStackSize,
      eventBus
    );
    const completedRecipe = recipe.id;
    furnace.craftingProgress = 0;
    furnace.activeRecipe = null;
    furnace.active = true;

    return {
      entityId: furnace.id,
      active: true,
      satisfaction,
      effectiveSpeed,
      completedRecipe,
      producedItems,
      haltReason: null,
    };
  }

  furnace.active = true;
  return {
    entityId: furnace.id,
    active: true,
    satisfaction,
    effectiveSpeed,
    completedRecipe: null,
    producedItems: [],
    haltReason: null,
  };
}

/**
 * Ticks all Electric Furnaces in the world in deterministic ascending EntityId order.
 */
export function tickAllElectricFurnaces(
  world: WorldState,
  recipeRegistry: RecipeRegistry,
  options: {
    readonly eventBus?: EventBus;
    readonly getStackSize?: StackSizeResolver;
  } = {}
): ElectricFurnaceTickResult[] {
  const furnaces: ElectricFurnaceEntity[] = [];
  for (const entity of Object.values(world.entities)) {
    if (entity.type === 'electric_furnace') {
      furnaces.push(entity);
    }
  }
  furnaces.sort((a, b) => a.id - b.id);

  const results: ElectricFurnaceTickResult[] = [];
  for (const furnace of furnaces) {
    results.push(
      tickElectricFurnace(furnace, {
        world,
        recipeRegistry,
        eventBus: options.eventBus,
        getStackSize: options.getStackSize,
      })
    );
  }
  return results;
}
