/**
 * Ironworks-16 Stone Furnace (T24)
 *
 * Coal-fueled smelter that automatically selects smelting recipes from its
 * input inventory. Strictly headless, deterministic, and fail-closed.
 *
 * Invariants:
 * - Zero DOM / Window / Canvas imports.
 * - No Math.random() or Date.now().
 * - Strict item conservation: ingredients are only consumed atomically upon
 *   craft completion when output inventory has guaranteed capacity.
 * - Halts cleanly (active = false, zero fuel burn) when out of fuel, missing
 *   input, locked recipe, insufficient ingredients, or output full.
 */

import {
  SimulationError,
  type Direction,
  type EntityId,
  type ItemId,
  type ItemStack,
  type RecipeDefinition,
  type RecipeId,
  type StoneFurnaceEntity,
  type TechId,
  type TileCoord,
  type WorldState,
} from '../types/contracts';
import {
  getFuelValueKj,
  getStackSize,
  isFuelItem,
} from '../core/itemRegistry';
import {
  canInsert,
  consumeIngredients,
  createInventoryState,
  getFirstAvailableItem,
  hasItems,
  insertItem,
  removeItem,
} from '../core/inventory';
import { type RecipeRegistry } from '../core/recipeRegistry';
import { type EventBus } from '../core/eventBus';

// ============================================================================
// Constants
// ============================================================================

/** Base smelting speed multiplier for Stone Furnace (Electric Furnace is 2x). */
export const STONE_FURNACE_CRAFTING_SPEED = 1;

/** Burner thermal power draw in kW (90 kW => 1.5 kJ/tick at 60 TPS). */
export const STONE_FURNACE_POWER_KW = 90;

/** Fuel energy consumed per active simulation tick in kJ (at 60 ticks/sec). */
export const STONE_FURNACE_FUEL_BURN_KJ_PER_TICK = STONE_FURNACE_POWER_KW / 60;

export const STONE_FURNACE_INPUT_SLOTS = 1;
export const STONE_FURNACE_OUTPUT_SLOTS = 1;
export const STONE_FURNACE_FUEL_SLOTS = 1;

const COMPLETION_EPSILON = 1e-9;

// ============================================================================
// Types
// ============================================================================

export type StoneFurnaceHaltReason =
  | 'no_input'
  | 'no_recipe'
  | 'recipe_locked'
  | 'insufficient_ingredients'
  | 'output_full'
  | 'no_fuel';

export interface StoneFurnaceTickOptions {
  readonly recipeRegistry: RecipeRegistry;
  /** Completed technologies used to check recipe unlock status. */
  readonly completedTechs?: ReadonlySet<TechId> | readonly TechId[];
  /** Current simulation tick (used when emitting itemProduced events). */
  readonly tick?: number;
  /** Optional event bus for emitting itemProduced events. */
  readonly eventBus?: Pick<EventBus, 'emit'>;
  /** Optional crafting speed override (defaults to STONE_FURNACE_CRAFTING_SPEED). */
  readonly craftingSpeed?: number;
  /** Optional fuel burn rate override in kJ/tick (defaults to STONE_FURNACE_FUEL_BURN_KJ_PER_TICK). */
  readonly fuelBurnKjPerTick?: number;
}

export interface StoneFurnaceTickResult {
  readonly entityId: EntityId;
  readonly active: boolean;
  readonly completed: boolean;
  readonly activeRecipe: RecipeId | null;
  readonly produced: readonly ItemStack[];
  readonly fuelBurnedKj: number;
  readonly haltReason: StoneFurnaceHaltReason | null;
}

// ============================================================================
// Factory & Inventory Helpers
// ============================================================================

/**
 * Creates a new StoneFurnaceEntity with empty 1-slot input, output, and fuel inventories.
 */
export function createStoneFurnace(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N'
): StoneFurnaceEntity {
  return {
    id,
    type: 'stone_furnace',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    inputInventory: createInventoryState(STONE_FURNACE_INPUT_SLOTS),
    outputInventory: createInventoryState(STONE_FURNACE_OUTPUT_SLOTS),
    fuelInventory: createInventoryState(STONE_FURNACE_FUEL_SLOTS),
    fuelEnergyKj: 0,
    activeRecipe: null,
    craftingProgress: 0,
  };
}

/**
 * Inserts smeltable input items into the furnace's input inventory.
 * Returns the number of items actually inserted.
 */
export function insertFurnaceInput(
  furnace: StoneFurnaceEntity,
  itemId: ItemId,
  count: number
): number {
  return insertItem(furnace.inputInventory, itemId, count, getStackSize);
}

/**
 * Inserts burnable fuel items into the furnace's fuel inventory.
 * Fails closed with SimulationError if itemId is not a valid fuel item.
 * Returns the number of fuel items actually inserted.
 */
export function insertFurnaceFuel(
  furnace: StoneFurnaceEntity,
  itemId: ItemId,
  count: number
): number {
  if (!isFuelItem(itemId)) {
    throw new SimulationError(
      'INVALID_FUEL_ITEM',
      `Item "${itemId}" has no fuel value and cannot be inserted as furnace fuel.`
    );
  }
  return insertItem(furnace.fuelInventory, itemId, count, getStackSize);
}

/**
 * Extracts up to `count` items (defaults to 1) from the furnace's output inventory.
 * Returns the extracted ItemStack or null if the output inventory is empty.
 */
export function extractFurnaceOutput(
  furnace: StoneFurnaceEntity,
  count = 1
): ItemStack | null {
  if (!Number.isInteger(count) || count <= 0) {
    throw new SimulationError(
      'INVALID_EXTRACT_COUNT',
      `Extract count must be a positive integer, received ${count}.`
    );
  }
  const available = getFirstAvailableItem(furnace.outputInventory);
  if (!available) {
    return null;
  }
  const removed = removeItem(furnace.outputInventory, available, count);
  return removed > 0 ? { itemId: available, count: removed } : null;
}

// ============================================================================
// Internal Helpers
// ============================================================================

function assertValidFurnaceState(furnace: StoneFurnaceEntity): void {
  if (!Number.isFinite(furnace.fuelEnergyKj) || furnace.fuelEnergyKj < 0) {
    throw new SimulationError(
      'INVALID_FURNACE_STATE',
      `Stone furnace ${furnace.id} has invalid fuelEnergyKj: ${furnace.fuelEnergyKj}.`
    );
  }
  if (!Number.isFinite(furnace.craftingProgress) || furnace.craftingProgress < 0) {
    throw new SimulationError(
      'INVALID_FURNACE_STATE',
      `Stone furnace ${furnace.id} has invalid craftingProgress: ${furnace.craftingProgress}.`
    );
  }
}

function canAcceptAllOutputs(
  furnace: StoneFurnaceEntity,
  recipe: RecipeDefinition
): boolean {
  for (const output of recipe.outputs) {
    if (canInsert(furnace.outputInventory, output.itemId, output.count, getStackSize) < output.count) {
      return false;
    }
  }
  return true;
}

/**
 * Finds the first burnable fuel item in the furnace's fuel inventory,
 * consumes 1 unit, and adds its fuel energy (kJ) to `furnace.fuelEnergyKj`.
 * Returns true if a fuel item was burned.
 */
function refuelFromInventory(furnace: StoneFurnaceEntity): boolean {
  for (const slot of furnace.fuelInventory.slots) {
    if (slot.item && slot.item.count > 0) {
      const fuelValue = getFuelValueKj(slot.item.itemId);
      if (fuelValue > 0) {
        const removed = removeItem(furnace.fuelInventory, slot.item.itemId, 1);
        if (removed === 1) {
          furnace.fuelEnergyKj += fuelValue;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Auto-selects the smelting recipe for the current input inventory.
 */
export function selectSmeltingRecipe(
  furnace: StoneFurnaceEntity,
  recipeRegistry: RecipeRegistry,
  completedTechs?: ReadonlySet<TechId> | readonly TechId[]
): { recipe: RecipeDefinition | null; reason: StoneFurnaceHaltReason | null } {
  const inputItem = getFirstAvailableItem(furnace.inputInventory);
  if (!inputItem) {
    return { recipe: null, reason: 'no_input' };
  }

  const recipe = recipeRegistry.findSmeltingRecipeForInput(inputItem);
  if (!recipe) {
    return { recipe: null, reason: 'no_recipe' };
  }

  if (completedTechs !== undefined && !recipeRegistry.isRecipeUnlocked(recipe.id, completedTechs)) {
    return { recipe: null, reason: 'recipe_locked' };
  }

  return { recipe, reason: null };
}

// ============================================================================
// Simulation Tick
// ============================================================================

/**
 * Advances a single StoneFurnaceEntity by one deterministic simulation tick.
 */
export function tickStoneFurnace(
  furnace: StoneFurnaceEntity,
  options: StoneFurnaceTickOptions
): StoneFurnaceTickResult {
  assertValidFurnaceState(furnace);

  const craftingSpeed = options.craftingSpeed ?? STONE_FURNACE_CRAFTING_SPEED;
  const fuelBurnKjPerTick = options.fuelBurnKjPerTick ?? STONE_FURNACE_FUEL_BURN_KJ_PER_TICK;

  if (!Number.isFinite(craftingSpeed) || craftingSpeed <= 0) {
    throw new SimulationError(
      'INVALID_FURNACE_CONFIG',
      `craftingSpeed must be a positive finite number, received ${craftingSpeed}.`
    );
  }
  if (!Number.isFinite(fuelBurnKjPerTick) || fuelBurnKjPerTick <= 0) {
    throw new SimulationError(
      'INVALID_FURNACE_CONFIG',
      `fuelBurnKjPerTick must be a positive finite number, received ${fuelBurnKjPerTick}.`
    );
  }

  // 1. Auto-select smelting recipe from input inventory.
  const { recipe, reason } = selectSmeltingRecipe(
    furnace,
    options.recipeRegistry,
    options.completedTechs
  );

  if (!recipe) {
    furnace.active = false;
    furnace.activeRecipe = null;
    furnace.craftingProgress = 0;
    return {
      entityId: furnace.id,
      active: false,
      completed: false,
      activeRecipe: null,
      produced: [],
      fuelBurnedKj: 0,
      haltReason: reason,
    };
  }

  // If the input switched to a different recipe, reset progress cleanly.
  if (furnace.activeRecipe !== recipe.id) {
    furnace.activeRecipe = recipe.id;
    furnace.craftingProgress = 0;
  }

  // 2. Verify sufficient ingredients (e.g., stone_brick requires 2 stone, steel_plate requires 5 iron_plate).
  if (!hasItems(furnace.inputInventory, recipe.ingredients)) {
    furnace.active = false;
    furnace.craftingProgress = 0;
    return {
      entityId: furnace.id,
      active: false,
      completed: false,
      activeRecipe: recipe.id,
      produced: [],
      fuelBurnedKj: 0,
      haltReason: 'insufficient_ingredients',
    };
  }

  // 3. Verify output space (backpressure: halt cleanly without burning fuel or losing items).
  if (!canAcceptAllOutputs(furnace, recipe)) {
    furnace.active = false;
    return {
      entityId: furnace.id,
      active: false,
      completed: false,
      activeRecipe: recipe.id,
      produced: [],
      fuelBurnedKj: 0,
      haltReason: 'output_full',
    };
  }

  // 4. Consume fuel energy (refueling from fuelInventory if needed).
  if (furnace.fuelEnergyKj < fuelBurnKjPerTick) {
    refuelFromInventory(furnace);
  }

  if (furnace.fuelEnergyKj <= 0) {
    furnace.active = false;
    return {
      entityId: furnace.id,
      active: false,
      completed: false,
      activeRecipe: recipe.id,
      produced: [],
      fuelBurnedKj: 0,
      haltReason: 'no_fuel',
    };
  }

  // Burn up to fuelBurnKjPerTick; if only partial residual energy remains, scale progress proportionally.
  let fuelBurnedKj: number;
  let progressDelta: number;
  if (furnace.fuelEnergyKj >= fuelBurnKjPerTick) {
    furnace.fuelEnergyKj -= fuelBurnKjPerTick;
    fuelBurnedKj = fuelBurnKjPerTick;
    progressDelta = craftingSpeed;
  } else {
    const fraction = furnace.fuelEnergyKj / fuelBurnKjPerTick;
    fuelBurnedKj = furnace.fuelEnergyKj;
    furnace.fuelEnergyKj = 0;
    progressDelta = craftingSpeed * fraction;
  }

  furnace.active = true;
  furnace.craftingProgress += progressDelta;

  // 5. Complete craft if progress reached craftingTicks.
  if (furnace.craftingProgress + COMPLETION_EPSILON >= recipe.craftingTicks) {
    const consumed = consumeIngredients(furnace.inputInventory, recipe.ingredients);
    if (!consumed) {
      // Defensive fail-closed guard: should never happen since hasItems was verified above.
      furnace.active = false;
      furnace.craftingProgress = 0;
      return {
        entityId: furnace.id,
        active: false,
        completed: false,
        activeRecipe: recipe.id,
        produced: [],
        fuelBurnedKj,
        haltReason: 'insufficient_ingredients',
      };
    }

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
          `Stone furnace ${furnace.id} failed to insert ${output.count}x ${output.itemId} (inserted ${inserted}).`
        );
      }
      produced.push({ itemId: output.itemId, count: inserted });
      if (options.eventBus) {
        options.eventBus.emit('itemProduced', {
          tick: options.tick ?? 0,
          itemId: output.itemId,
          count: inserted,
          entityId: furnace.id,
        });
      }
    }

    furnace.craftingProgress = 0;

    return {
      entityId: furnace.id,
      active: true,
      completed: true,
      activeRecipe: recipe.id,
      produced,
      fuelBurnedKj,
      haltReason: null,
    };
  }

  return {
    entityId: furnace.id,
    active: true,
    completed: false,
    activeRecipe: recipe.id,
    produced: [],
    fuelBurnedKj,
    haltReason: null,
  };
}

/**
 * Ticks all stone_furnace entities in the world in deterministic ascending EntityId order.
 */
export function tickAllStoneFurnaces(
  world: WorldState,
  recipeRegistry: RecipeRegistry,
  eventBus?: Pick<EventBus, 'emit'>
): StoneFurnaceTickResult[] {
  const furnaceIds = Object.keys(world.entities)
    .map(Number)
    .filter((id) => world.entities[id]?.type === 'stone_furnace')
    .sort((a, b) => a - b);

  const results: StoneFurnaceTickResult[] = [];
  for (const id of furnaceIds) {
    const entity = world.entities[id];
    if (entity && entity.type === 'stone_furnace') {
      results.push(
        tickStoneFurnace(entity, {
          recipeRegistry,
          completedTechs: world.research.completedTechs,
          tick: world.tick,
          eventBus,
        })
      );
    }
  }
  return results;
}
