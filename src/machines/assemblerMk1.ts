/**
 * Ironworks-16 Assembler Mk1 (T26)
 *
 * Behavioral contract:
 * - 75 kW electric assembling machine
 * - Supports assembling recipes with <= 2 distinct ingredients
 * - Base crafting speed: 0.5 (scales proportionally with power satisfaction)
 * - Strict determinism, item/mass conservation, fail-closed execution, headless purity.
 */

import {
  SimulationError,
  type AssemblerEntity,
  type Direction,
  type EntityFootprint,
  type EntityId,
  type ItemId,
  type RecipeDefinition,
  type RecipeId,
  type RecipeOutput,
  type ResearchState,
  type TileCoord,
  type WorldState,
} from '../types/contracts';
import type { EventBus } from '../core/eventBus';
import {
  canInsert,
  clearSlotFilter,
  cloneInventoryState,
  consumeIngredients,
  createInventoryState,
  defaultStackSizeResolver,
  hasItems,
  insertItem,
  setSlotFilter,
  type StackSizeResolver,
} from '../core/inventory';
import type { RecipeRegistry } from '../core/recipeRegistry';
import { getEntityPowerSatisfaction, scaleMachineSpeed } from '../logistics/powerSolver';

// ============================================================================
// Constants
// ============================================================================

export const ASSEMBLER_MK1_POWER_DEMAND_KW = 75;
export const ASSEMBLER_MK1_CRAFTING_SPEED = 0.5;
export const ASSEMBLER_MK1_MAX_INGREDIENTS = 2;
export const ASSEMBLER_MK1_INPUT_SLOTS = 2;
export const ASSEMBLER_MK1_OUTPUT_SLOTS = 1;
export const ASSEMBLER_MK1_FOOTPRINT: EntityFootprint = { width: 1, height: 1 };

const PROGRESS_EPSILON = 1e-9;

// ============================================================================
// Types
// ============================================================================

export interface CreateAssemblerMk1Options {
  direction?: Direction;
  recipeId?: RecipeId | null;
  recipeRegistry?: RecipeRegistry;
  researchState?: ResearchState;
  applyInputFilters?: boolean;
}

export interface SetAssemblerRecipeOptions {
  researchState?: ResearchState;
  /**
   * When true (default), sets per-slot filters on empty input slots to match
   * recipe ingredients so inserters cannot starve one ingredient with another.
   */
  applyInputFilters?: boolean;
}

export type AssemblerStepReason =
  | 'crafted'
  | 'crafting'
  | 'no_power'
  | 'no_recipe'
  | 'recipe_locked'
  | 'missing_ingredients'
  | 'output_full';

export interface AssemblerStepContext {
  recipeRegistry: RecipeRegistry;
  /** Power network satisfaction in [0, 1]. */
  powerSatisfaction: number;
  tick?: number;
  eventBus?: EventBus;
  stackSizeResolver?: StackSizeResolver;
  /** Optional research state; when provided, locked recipes halt cleanly. */
  researchState?: ResearchState;
}

export interface AssemblerStepResult {
  readonly crafted: boolean;
  readonly active: boolean;
  readonly reason: AssemblerStepReason;
  readonly progressDelta: number;
  readonly outputsProduced: readonly RecipeOutput[];
}

export interface TickAssemblerMk1Options {
  recipeRegistry: RecipeRegistry;
  eventBus?: EventBus;
  stackSizeResolver?: StackSizeResolver;
  /** When true, checks `world.research` before crafting locked recipes. */
  enforceResearch?: boolean;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function assertAssemblerMk1(entity: AssemblerEntity): void {
  if (entity.type !== 'assembler_mk1') {
    throw new SimulationError(
      'INVALID_ENTITY_TYPE',
      `Expected entity of type "assembler_mk1", received "${entity.type}".`
    );
  }
}

function assertValidSatisfaction(satisfaction: number): void {
  if (!Number.isFinite(satisfaction) || satisfaction < 0 || satisfaction > 1) {
    throw new SimulationError(
      'INVALID_POWER_SATISFACTION',
      `Power satisfaction must be a finite number in [0, 1], received: ${String(satisfaction)}.`
    );
  }
}

/**
 * Pure check for whether a recipe can be crafted by an Assembler Mk1
 * (`category === 'assembling'` and `ingredients.length <= maxIngredients`).
 */
export function canAssemblerMk1CraftRecipe(
  recipe: RecipeDefinition,
  maxIngredients = ASSEMBLER_MK1_MAX_INGREDIENTS
): boolean {
  return recipe.category === 'assembling' && recipe.ingredients.length <= maxIngredients;
}

function assertRecipeCompatibleWithMk1(
  recipe: RecipeDefinition,
  maxIngredients: number
): void {
  if (recipe.category !== 'assembling') {
    throw new SimulationError(
      'INVALID_RECIPE_CATEGORY',
      `Assembler Mk1 cannot craft recipe "${recipe.id}" with category "${recipe.category}".`
    );
  }
  if (recipe.ingredients.length > maxIngredients) {
    throw new SimulationError(
      'TOO_MANY_INGREDIENTS',
      `Assembler Mk1 supports at most ${maxIngredients} ingredients, but recipe "${recipe.id}" requires ${recipe.ingredients.length}.`
    );
  }
}

function canAcceptAllOutputs(
  entity: AssemblerEntity,
  outputs: readonly RecipeOutput[],
  stackSizeResolver: StackSizeResolver
): boolean {
  if (outputs.length === 0) {
    return true;
  }
  if (outputs.length === 1) {
    const out = outputs[0] as RecipeOutput;
    return canInsert(entity.outputInventory, out.itemId, out.count, stackSizeResolver) >= out.count;
  }

  // Multi-output atomic space verification on a cloned inventory.
  const probe = cloneInventoryState(entity.outputInventory);
  for (const out of outputs) {
    const inserted = insertItem(probe, out.itemId, out.count, stackSizeResolver);
    if (inserted !== out.count) {
      return false;
    }
  }
  return true;
}

function applyRecipeInputFilters(
  entity: AssemblerEntity,
  recipe: RecipeDefinition | null
): void {
  const slotCount = entity.inputInventory.slots.length;
  for (let i = 0; i < slotCount; i++) {
    const slot = entity.inputInventory.slots[i];
    if (!slot) continue;
    if (recipe === null) {
      clearSlotFilter(entity.inputInventory, i);
    } else if (slot.item === null) {
      const ingredient = recipe.ingredients[i];
      if (ingredient) {
        setSlotFilter(entity.inputInventory, i, ingredient.itemId);
      } else {
        clearSlotFilter(entity.inputInventory, i);
      }
    }
  }
}

// ============================================================================
// Factory & Configuration
// ============================================================================

/**
 * Creates a new `assembler_mk1` entity with canonical T26 specs:
 * 75 kW power demand, 0.5 crafting speed, <= 2 ingredients.
 */
export function createAssemblerMk1(
  id: EntityId,
  position: TileCoord,
  options: CreateAssemblerMk1Options = {}
): AssemblerEntity {
  if (!Number.isInteger(id) || id < 1) {
    throw new SimulationError(
      'INVALID_ENTITY_ID',
      `Entity ID must be a positive integer, received: ${String(id)}.`
    );
  }

  const entity: AssemblerEntity = {
    id,
    type: 'assembler_mk1',
    position: { x: position.x, y: position.y },
    direction: options.direction ?? 'N',
    footprint: { ...ASSEMBLER_MK1_FOOTPRINT },
    powerNetworkId: null,
    active: false,
    powerDemandKw: ASSEMBLER_MK1_POWER_DEMAND_KW,
    craftingSpeed: ASSEMBLER_MK1_CRAFTING_SPEED,
    maxIngredients: ASSEMBLER_MK1_MAX_INGREDIENTS,
    recipeId: null,
    inputInventory: createInventoryState(ASSEMBLER_MK1_INPUT_SLOTS),
    outputInventory: createInventoryState(ASSEMBLER_MK1_OUTPUT_SLOTS),
    craftingProgress: 0,
  };

  if (options.recipeId !== undefined && options.recipeId !== null) {
    if (options.recipeRegistry) {
      setAssemblerMk1Recipe(entity, options.recipeId, options.recipeRegistry, {
        researchState: options.researchState,
        applyInputFilters: options.applyInputFilters,
      });
    } else {
      entity.recipeId = options.recipeId;
    }
  }

  return entity;
}

/**
 * Sets or clears the active recipe on an `assembler_mk1`.
 * Fails closed on unknown recipes, non-assembling recipes, >2 ingredients,
 * or locked recipes (when `researchState` is provided).
 * Preserves all items already in `inputInventory` and `outputInventory`.
 */
export function setAssemblerMk1Recipe(
  entity: AssemblerEntity,
  recipeId: RecipeId | null,
  recipeRegistry: RecipeRegistry,
  options: SetAssemblerRecipeOptions = {}
): void {
  assertAssemblerMk1(entity);

  const shouldFilter = options.applyInputFilters ?? true;

  if (recipeId === null) {
    entity.recipeId = null;
    entity.craftingProgress = 0;
    entity.active = false;
    if (shouldFilter) {
      applyRecipeInputFilters(entity, null);
    }
    return;
  }

  const recipe = recipeRegistry.get(recipeId);
  assertRecipeCompatibleWithMk1(recipe, entity.maxIngredients);

  if (
    options.researchState &&
    !recipeRegistry.isRecipeUnlocked(recipeId, options.researchState.completedTechs)
  ) {
    throw new SimulationError(
      'RECIPE_LOCKED',
      `Recipe "${recipeId}" is locked by technology "${String(recipe.requiredTech)}".`
    );
  }

  if (entity.recipeId !== recipeId) {
    entity.recipeId = recipeId;
    entity.craftingProgress = 0;
    entity.active = false;
  }

  if (shouldFilter) {
    applyRecipeInputFilters(entity, recipe);
  }
}

// ============================================================================
// Simulation Step
// ============================================================================

/**
 * Advances a single `assembler_mk1` by one simulation tick.
 *
 * - Scales crafting progress by `entity.craftingSpeed * powerSatisfaction`.
 * - Halts cleanly (`active = false`, zero progress) on zero power, missing recipe,
 *   locked recipe, missing ingredients, or full output inventory.
 * - Atomically consumes ingredients and inserts outputs on completion to guarantee
 *   strict item/mass conservation.
 */
export function stepAssemblerMk1(
  entity: AssemblerEntity,
  context: AssemblerStepContext
): AssemblerStepResult {
  assertAssemblerMk1(entity);
  assertValidSatisfaction(context.powerSatisfaction);

  const stackSizeResolver = context.stackSizeResolver ?? defaultStackSizeResolver;

  if (entity.recipeId === null) {
    entity.active = false;
    entity.craftingProgress = 0;
    return {
      crafted: false,
      active: false,
      reason: 'no_recipe',
      progressDelta: 0,
      outputsProduced: [],
    };
  }

  const recipe = context.recipeRegistry.get(entity.recipeId);
  assertRecipeCompatibleWithMk1(recipe, entity.maxIngredients);

  if (
    context.researchState &&
    !context.recipeRegistry.isRecipeUnlocked(recipe.id, context.researchState.completedTechs)
  ) {
    entity.active = false;
    return {
      crafted: false,
      active: false,
      reason: 'recipe_locked',
      progressDelta: 0,
      outputsProduced: [],
    };
  }

  if (context.powerSatisfaction === 0) {
    entity.active = false;
    return {
      crafted: false,
      active: false,
      reason: 'no_power',
      progressDelta: 0,
      outputsProduced: [],
    };
  }

  if (!canAcceptAllOutputs(entity, recipe.outputs, stackSizeResolver)) {
    entity.active = false;
    return {
      crafted: false,
      active: false,
      reason: 'output_full',
      progressDelta: 0,
      outputsProduced: [],
    };
  }

  if (!hasItems(entity.inputInventory, recipe.ingredients)) {
    entity.active = false;
    return {
      crafted: false,
      active: false,
      reason: 'missing_ingredients',
      progressDelta: 0,
      outputsProduced: [],
    };
  }

  const progressDelta = scaleMachineSpeed(entity.craftingSpeed, context.powerSatisfaction);
  entity.active = true;
  entity.craftingProgress += progressDelta;

  if (entity.craftingProgress + PROGRESS_EPSILON >= recipe.craftingTicks) {
    const consumed = consumeIngredients(entity.inputInventory, recipe.ingredients);
    if (!consumed) {
      // Defensive fail-closed guard; should be unreachable after hasItems check.
      entity.active = false;
      return {
        crafted: false,
        active: false,
        reason: 'missing_ingredients',
        progressDelta: 0,
        outputsProduced: [],
      };
    }

    const produced: RecipeOutput[] = [];
    for (const out of recipe.outputs) {
      const inserted = insertItem(
        entity.outputInventory,
        out.itemId,
        out.count,
        stackSizeResolver
      );
      if (inserted !== out.count) {
        throw new SimulationError(
          'OUTPUT_INSERTION_FAILED',
          `Assembler Mk1 #${entity.id} failed to insert ${out.count}x "${out.itemId}" into output inventory.`
        );
      }
      produced.push({ itemId: out.itemId, count: out.count });

      if (context.eventBus) {
        context.eventBus.emit('itemProduced', {
          tick: context.tick ?? 0,
          itemId: out.itemId as ItemId,
          count: out.count,
          entityId: entity.id,
        });
      }
    }

    entity.craftingProgress = 0;
    return {
      crafted: true,
      active: true,
      reason: 'crafted',
      progressDelta,
      outputsProduced: produced,
    };
  }

  return {
    crafted: false,
    active: true,
    reason: 'crafting',
    progressDelta,
    outputsProduced: [],
  };
}

/**
 * Convenience wrapper that resolves power satisfaction from `world` (via T18 `powerSolver`)
 * and steps a single `assembler_mk1`.
 */
export function tickAssemblerMk1(
  world: WorldState,
  entity: AssemblerEntity,
  options: TickAssemblerMk1Options
): AssemblerStepResult {
  assertAssemblerMk1(entity);
  const powerSatisfaction = getEntityPowerSatisfaction(world, entity);
  return stepAssemblerMk1(entity, {
    recipeRegistry: options.recipeRegistry,
    powerSatisfaction,
    tick: world.tick,
    eventBus: options.eventBus,
    stackSizeResolver: options.stackSizeResolver,
    researchState: options.enforceResearch ? world.research : undefined,
  });
}

/**
 * Steps all `assembler_mk1` entities in `world` in deterministic ascending `EntityId` order.
 */
export function tickAllAssemblersMk1(
  world: WorldState,
  options: TickAssemblerMk1Options
): Map<EntityId, AssemblerStepResult> {
  const results = new Map<EntityId, AssemblerStepResult>();
  const assemblers = Object.values(world.entities)
    .filter((e): e is AssemblerEntity => e.type === 'assembler_mk1')
    .sort((a, b) => a.id - b.id);

  for (const assembler of assemblers) {
    results.set(assembler.id, tickAssemblerMk1(world, assembler, options));
  }

  return results;
}
