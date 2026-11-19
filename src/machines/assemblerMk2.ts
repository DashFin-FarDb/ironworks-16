/**
 * Ironworks-16 Assembling Machine Mk2 (T27)
 *
 * Behavioral contract:
 * - 150 kW electric assembler supporting assembling recipes with <= 4 ingredients.
 * - Base crafting speed: 0.75 (scaled proportionally by power satisfaction in [0, 1]).
 * - Strictly deterministic, headless, fail-closed, and item-conserving.
 */

import {
  AssemblerEntity,
  Direction,
  DIRECTIONS,
  EntityFootprint,
  EntityId,
  ItemId,
  RecipeDefinition,
  RecipeId,
  ResearchState,
  SimulationError,
  TileCoord,
  WorldState,
} from '../types/contracts.js';
import { EventBus } from '../core/eventBus.js';
import {
  canInsert,
  cloneInventoryState,
  consumeIngredients,
  createInventoryState,
  getFirstAvailableItem,
  hasItems,
  insertItem,
  removeItem,
  StackSizeResolver,
} from '../core/inventory.js';
import { RecipeRegistry } from '../core/recipeRegistry.js';
import {
  getEntityPowerSatisfaction,
  scaleMachineSpeed,
} from '../logistics/powerSolver.js';

// ============================================================================
// Constants
// ============================================================================

export const ASSEMBLER_MK2_POWER_DEMAND_KW = 150;
export const ASSEMBLER_MK2_CRAFTING_SPEED = 0.75;
export const ASSEMBLER_MK2_MAX_INGREDIENTS = 4;
export const ASSEMBLER_MK2_INPUT_SLOTS = 4;
export const ASSEMBLER_MK2_OUTPUT_SLOTS = 1;
export const ASSEMBLER_MK2_FOOTPRINT: EntityFootprint = {
  width: 1,
  height: 1,
} as const;

const PROGRESS_EPSILON = 1e-12;

// ============================================================================
// Types
// ============================================================================

export type AssemblerMk2HaltReason =
  | 'none'
  | 'no_recipe'
  | 'recipe_locked'
  | 'no_power'
  | 'output_full'
  | 'missing_ingredients';

export interface TickAssemblerMk2Options {
  readonly recipeRegistry: RecipeRegistry;
  /**
   * Explicit power satisfaction override in [0, 1].
   * When omitted, resolved via `getEntityPowerSatisfaction(world, assembler)` if `world` is provided,
   * otherwise defaults to 0 (fail-closed unpowered halt).
   */
  readonly powerSatisfaction?: number;
  /** Optional WorldState used for power satisfaction lookup, research gating, and tick timestamp. */
  readonly world?: WorldState;
  /** Optional ResearchState override for recipe unlock gating. */
  readonly researchState?: ResearchState;
  /** Optional EventBus to emit `itemProduced` events upon craft completion. */
  readonly eventBus?: EventBus;
  /** Optional tick number override for emitted events (defaults to `world?.tick ?? 0`). */
  readonly tick?: number;
  /** Optional stack size resolver for inventory capacity checks. */
  readonly getStackSize?: StackSizeResolver;
}

export interface ProducedOutput {
  readonly itemId: ItemId;
  readonly count: number;
}

export interface AssemblerMk2TickResult {
  readonly entityId: EntityId;
  readonly active: boolean;
  readonly crafted: boolean;
  readonly powerSatisfaction: number;
  readonly progressDelta: number;
  readonly craftingProgress: number;
  readonly outputsProduced: readonly ProducedOutput[];
  readonly haltReason: AssemblerMk2HaltReason;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function assertAssemblerMk2(entity: AssemblerEntity): void {
  if (entity.type !== 'assembler_mk2') {
    throw new SimulationError(
      'INVALID_ENTITY_TYPE',
      `Expected entity type "assembler_mk2", received "${entity.type}".`
    );
  }
}

function assertValidRecipeForMk2(recipe: RecipeDefinition): void {
  if (recipe.category !== 'assembling') {
    throw new SimulationError(
      'INVALID_RECIPE_CATEGORY',
      `Assembler Mk2 only supports "assembling" recipes; "${recipe.id}" has category "${recipe.category}".`
    );
  }
  if (recipe.ingredients.length > ASSEMBLER_MK2_MAX_INGREDIENTS) {
    throw new SimulationError(
      'RECIPE_TOO_MANY_INGREDIENTS',
      `Assembler Mk2 supports at most ${ASSEMBLER_MK2_MAX_INGREDIENTS} ingredients; recipe "${recipe.id}" requires ${recipe.ingredients.length}.`
    );
  }
  if (!Number.isFinite(recipe.craftingTicks) || recipe.craftingTicks <= 0) {
    throw new SimulationError(
      'INVALID_RECIPE_DURATION',
      `Recipe "${recipe.id}" has invalid craftingTicks: ${recipe.craftingTicks}.`
    );
  }
}

function canAcceptAllOutputs(
  assembler: AssemblerEntity,
  recipe: RecipeDefinition,
  getStackSize?: StackSizeResolver
): boolean {
  if (recipe.outputs.length === 0) {
    return true;
  }
  if (recipe.outputs.length === 1) {
    const out = recipe.outputs[0]!;
    return (
      canInsert(assembler.outputInventory, out.itemId, out.count, getStackSize) >=
      out.count
    );
  }
  const simulated = cloneInventoryState(assembler.outputInventory);
  for (const out of recipe.outputs) {
    const inserted = insertItem(simulated, out.itemId, out.count, getStackSize);
    if (inserted < out.count) {
      return false;
    }
  }
  return true;
}

function resolveSatisfaction(
  assembler: AssemblerEntity,
  options: TickAssemblerMk2Options
): number {
  if (options.powerSatisfaction !== undefined) {
    const sat = options.powerSatisfaction;
    if (!Number.isFinite(sat) || sat < 0 || sat > 1) {
      throw new SimulationError(
        'INVALID_POWER_SATISFACTION',
        `Power satisfaction must be a finite number in [0, 1], received ${sat}.`
      );
    }
    return sat;
  }
  if (options.world) {
    return getEntityPowerSatisfaction(options.world, assembler);
  }
  return 0;
}

// ============================================================================
// Factory & Configuration
// ============================================================================

export function createAssemblerMk2(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N',
  recipeId: RecipeId | null = null
): AssemblerEntity {
  if (!Number.isInteger(id) || id < 1) {
    throw new SimulationError(
      'INVALID_ENTITY_ID',
      `Assembler Mk2 entity ID must be a positive integer, received ${id}.`
    );
  }
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new SimulationError(
      'INVALID_POSITION',
      `Assembler Mk2 position must have integer coordinates, received (${position.x}, ${position.y}).`
    );
  }
  if (!DIRECTIONS.includes(direction)) {
    throw new SimulationError(
      'INVALID_DIRECTION',
      `Invalid direction "${String(direction)}".`
    );
  }

  return {
    id,
    type: 'assembler_mk2',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { ...ASSEMBLER_MK2_FOOTPRINT },
    powerNetworkId: null,
    active: false,
    powerDemandKw: ASSEMBLER_MK2_POWER_DEMAND_KW,
    craftingSpeed: ASSEMBLER_MK2_CRAFTING_SPEED,
    maxIngredients: ASSEMBLER_MK2_MAX_INGREDIENTS,
    recipeId,
    inputInventory: createInventoryState(ASSEMBLER_MK2_INPUT_SLOTS),
    outputInventory: createInventoryState(ASSEMBLER_MK2_OUTPUT_SLOTS),
    craftingProgress: 0,
  };
}

export function canAcceptRecipeMk2(recipe: RecipeDefinition): boolean {
  return (
    recipe.category === 'assembling' &&
    recipe.ingredients.length <= ASSEMBLER_MK2_MAX_INGREDIENTS &&
    Number.isFinite(recipe.craftingTicks) &&
    recipe.craftingTicks > 0
  );
}

/**
 * Assigns or clears the recipe on an Assembler Mk2.
 * Fails closed on unknown recipes, non-assembling recipes, >4 ingredients, or locked recipes.
 * Never destroys existing items in input/output inventories.
 */
export function setAssemblerMk2Recipe(
  assembler: AssemblerEntity,
  recipeId: RecipeId | null,
  recipeRegistry: RecipeRegistry,
  researchState?: ResearchState
): void {
  assertAssemblerMk2(assembler);

  if (recipeId === null) {
    assembler.recipeId = null;
    assembler.craftingProgress = 0;
    assembler.active = false;
    return;
  }

  const recipe = recipeRegistry.get(recipeId);
  assertValidRecipeForMk2(recipe);

  if (
    researchState &&
    !recipeRegistry.isRecipeUnlocked(recipeId, researchState.completedTechs)
  ) {
    throw new SimulationError(
      'RECIPE_LOCKED',
      `Recipe "${recipeId}" is locked by technology "${recipe.requiredTech}".`
    );
  }

  if (assembler.recipeId !== recipeId) {
    assembler.recipeId = recipeId;
    assembler.craftingProgress = 0;
    assembler.active = false;
  }
}

// ============================================================================
// Inventory Helpers
// ============================================================================

/**
 * Inserts ingredient items into the Assembler Mk2 input inventory.
 * When a recipe is assigned and `recipeRegistry` is provided, rejects non-ingredient items
 * by returning 0 (preserving item conservation).
 */
export function insertAssemblerMk2Ingredient(
  assembler: AssemblerEntity,
  itemId: ItemId,
  count: number,
  recipeRegistry?: RecipeRegistry,
  getStackSize?: StackSizeResolver
): number {
  assertAssemblerMk2(assembler);

  if (assembler.recipeId !== null && recipeRegistry) {
    const recipe = recipeRegistry.get(assembler.recipeId);
    const isIngredient = recipe.ingredients.some((ing) => ing.itemId === itemId);
    if (!isIngredient) {
      return 0;
    }
  }

  return insertItem(assembler.inputInventory, itemId, count, getStackSize);
}

/**
 * Extracts crafted output items from the Assembler Mk2 output inventory.
 */
export function extractAssemblerMk2Output(
  assembler: AssemblerEntity,
  itemId?: ItemId,
  maxCount = 1
): ProducedOutput | null {
  assertAssemblerMk2(assembler);

  if (!Number.isInteger(maxCount) || maxCount <= 0) {
    throw new SimulationError(
      'INVALID_EXTRACT_COUNT',
      `Extract count must be a positive integer, received ${maxCount}.`
    );
  }

  const targetItem = itemId ?? getFirstAvailableItem(assembler.outputInventory);
  if (targetItem === null) {
    return null;
  }

  const removed = removeItem(assembler.outputInventory, targetItem, maxCount);
  if (removed === 0) {
    return null;
  }

  return { itemId: targetItem, count: removed };
}

// ============================================================================
// Simulation Tick
// ============================================================================

/**
 * Advances a single Assembler Mk2 by one simulation tick.
 */
export function tickAssemblerMk2(
  assembler: AssemblerEntity,
  options: TickAssemblerMk2Options
): AssemblerMk2TickResult {
  assertAssemblerMk2(assembler);

  const { recipeRegistry, eventBus, getStackSize } = options;
  const researchState = options.researchState ?? options.world?.research;
  const tick = options.tick ?? options.world?.tick ?? 0;

  // 1. No recipe selected -> idle halt
  if (assembler.recipeId === null) {
    assembler.active = false;
    assembler.craftingProgress = 0;
    return {
      entityId: assembler.id,
      active: false,
      crafted: false,
      powerSatisfaction: 0,
      progressDelta: 0,
      craftingProgress: 0,
      outputsProduced: [],
      haltReason: 'no_recipe',
    };
  }

  // 2. Validate recipe (fail closed on unknown/invalid recipe)
  const recipe = recipeRegistry.get(assembler.recipeId);
  assertValidRecipeForMk2(recipe);

  // 3. Tech-tree gating
  if (
    researchState &&
    !recipeRegistry.isRecipeUnlocked(recipe.id, researchState.completedTechs)
  ) {
    assembler.active = false;
    return {
      entityId: assembler.id,
      active: false,
      crafted: false,
      powerSatisfaction: 0,
      progressDelta: 0,
      craftingProgress: assembler.craftingProgress,
      outputsProduced: [],
      haltReason: 'recipe_locked',
    };
  }

  // 4. Power satisfaction check (fail closed on 0 power -> clean zero-progress halt)
  const satisfaction = resolveSatisfaction(assembler, options);
  if (satisfaction <= 0) {
    assembler.active = false;
    return {
      entityId: assembler.id,
      active: false,
      crafted: false,
      powerSatisfaction: 0,
      progressDelta: 0,
      craftingProgress: assembler.craftingProgress,
      outputsProduced: [],
      haltReason: 'no_power',
    };
  }

  // 5. Output capacity check (backpressure halt, zero item loss)
  if (!canAcceptAllOutputs(assembler, recipe, getStackSize)) {
    assembler.active = false;
    return {
      entityId: assembler.id,
      active: false,
      crafted: false,
      powerSatisfaction: satisfaction,
      progressDelta: 0,
      craftingProgress: assembler.craftingProgress,
      outputsProduced: [],
      haltReason: 'output_full',
    };
  }

  // 6. Ingredient availability check
  if (!hasItems(assembler.inputInventory, recipe.ingredients)) {
    assembler.active = false;
    return {
      entityId: assembler.id,
      active: false,
      crafted: false,
      powerSatisfaction: satisfaction,
      progressDelta: 0,
      craftingProgress: assembler.craftingProgress,
      outputsProduced: [],
      haltReason: 'missing_ingredients',
    };
  }

  // 7. Advance crafting progress scaled by power satisfaction
  const progressDelta = scaleMachineSpeed(assembler.craftingSpeed, satisfaction);
  assembler.active = true;
  assembler.craftingProgress += progressDelta;

  // 8. Complete craft when progress reaches recipe.craftingTicks
  const outputsProduced: ProducedOutput[] = [];
  if (assembler.craftingProgress + PROGRESS_EPSILON >= recipe.craftingTicks) {
    const consumed = consumeIngredients(assembler.inputInventory, recipe.ingredients);
    if (consumed) {
      assembler.craftingProgress = Math.max(
        0,
        assembler.craftingProgress - recipe.craftingTicks
      );

      for (const out of recipe.outputs) {
        const inserted = insertItem(
          assembler.outputInventory,
          out.itemId,
          out.count,
          getStackSize
        );
        if (inserted !== out.count) {
          throw new SimulationError(
            'OUTPUT_INSERTION_FAILED',
            `Failed to insert full output (${out.count}x ${out.itemId}) into Assembler Mk2 #${assembler.id}.`
          );
        }
        outputsProduced.push({ itemId: out.itemId, count: out.count });
        if (eventBus) {
          eventBus.emit('itemProduced', {
            tick,
            itemId: out.itemId,
            count: out.count,
            entityId: assembler.id,
          });
        }
      }
    }
  }

  return {
    entityId: assembler.id,
    active: assembler.active,
    crafted: outputsProduced.length > 0,
    powerSatisfaction: satisfaction,
    progressDelta,
    craftingProgress: assembler.craftingProgress,
    outputsProduced,
    haltReason: 'none',
  };
}

/**
 * Ticks all Assembler Mk2 entities in a WorldState in deterministic ascending EntityId order.
 */
export function tickAllAssemblersMk2(
  world: WorldState,
  options: Omit<TickAssemblerMk2Options, 'world' | 'tick'>
): AssemblerMk2TickResult[] {
  const assemblers = Object.values(world.entities)
    .filter((e): e is AssemblerEntity => e.type === 'assembler_mk2')
    .sort((a, b) => a.id - b.id);

  const results: AssemblerMk2TickResult[] = [];
  for (const assembler of assemblers) {
    results.push(
      tickAssemblerMk2(assembler, {
        ...options,
        world,
        tick: world.tick,
      })
    );
  }
  return results;
}
