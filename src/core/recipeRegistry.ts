/**
 * Ironworks-16 Recipe Registry (T07)
 *
 * Manages recipe definitions and validates that every ingredient and output
 * ItemId exists in the canonical item registry (T06).
 * Strictly headless and deterministic; fails closed on invalid or unknown IDs.
 */

import {
  type ItemId,
  type RecipeCategory,
  type RecipeDefinition,
  type RecipeId,
  type TechId,
  SimulationError,
  UnknownItemError,
  UnknownRecipeError,
} from '../types/contracts';

/**
 * Canonical set of ItemIds matching T01 contracts and T06 itemRegistry.
 * Used as the default validator when no custom T06 registry instance is injected.
 */
export const CANONICAL_ITEM_IDS: ReadonlySet<ItemId> = new Set<ItemId>([
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
  'iron_plate',
  'copper_plate',
  'stone_brick',
  'steel_plate',
  'iron_gear',
  'copper_cable',
  'electronic_circuit',
  'transport_belt',
  'underground_belt',
  'splitter',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'red_science',
  'green_science',
]);

/**
 * Flexible validator interface allowing callers to inject the T06 ItemRegistry
 * (via `has` or `hasItem`), a `Set<string>`, or a plain predicate function.
 */
export type ItemValidator =
  | ((itemId: string) => boolean)
  | ReadonlySet<string>
  | { readonly has: (itemId: string) => boolean }
  | { readonly hasItem: (itemId: string) => boolean };

function normalizeItemValidator(validator?: ItemValidator): (itemId: string) => boolean {
  if (!validator) {
    return (itemId: string) => CANONICAL_ITEM_IDS.has(itemId as ItemId);
  }
  if (typeof validator === 'function') {
    return validator;
  }
  if ('hasItem' in validator && typeof validator.hasItem === 'function') {
    return (itemId: string) => validator.hasItem(itemId);
  }
  if ('has' in validator && typeof validator.has === 'function') {
    return (itemId: string) => validator.has(itemId);
  }
  throw new SimulationError('INVALID_ITEM_VALIDATOR', 'Invalid item validator provided to RecipeRegistry.');
}

function freezeRecipe(recipe: RecipeDefinition): RecipeDefinition {
  return Object.freeze({
    ...recipe,
    ingredients: Object.freeze(recipe.ingredients.map((ing) => Object.freeze({ ...ing }))),
    outputs: Object.freeze(recipe.outputs.map((out) => Object.freeze({ ...out }))),
  });
}

export class RecipeRegistry {
  private readonly recipes = new Map<RecipeId, RecipeDefinition>();
  private readonly hasValidItem: (itemId: string) => boolean;

  constructor(itemValidator?: ItemValidator, initialRecipes?: readonly RecipeDefinition[]) {
    this.hasValidItem = normalizeItemValidator(itemValidator);
    if (initialRecipes && initialRecipes.length > 0) {
      this.registerMany(initialRecipes);
    }
  }

  /** Number of registered recipes. */
  get size(): number {
    return this.recipes.size;
  }

  /**
   * Validates a recipe definition without mutating registry state.
   * Throws UnknownItemError if any ingredient or output ItemId is unknown.
   * Throws SimulationError on malformed recipe metadata or duplicate ID.
   */
  validateRecipe(recipe: RecipeDefinition, existingIds?: ReadonlySet<string>): void {
    if (!recipe.id || typeof recipe.id !== 'string') {
      throw new SimulationError('INVALID_RECIPE', 'Recipe id must be a non-empty string.');
    }
    const alreadyExists = existingIds
      ? existingIds.has(recipe.id)
      : this.recipes.has(recipe.id);
    if (alreadyExists) {
      throw new SimulationError('DUPLICATE_RECIPE', `Recipe "${recipe.id}" is already registered.`);
    }
    if (!Number.isFinite(recipe.craftingTicks) || recipe.craftingTicks <= 0) {
      throw new SimulationError(
        'INVALID_RECIPE',
        `Recipe "${recipe.id}" must have a positive finite craftingTicks value.`
      );
    }
    if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      throw new SimulationError(
        'INVALID_RECIPE',
        `Recipe "${recipe.id}" must define at least one ingredient.`
      );
    }
    if (!Array.isArray(recipe.outputs) || recipe.outputs.length === 0) {
      throw new SimulationError(
        'INVALID_RECIPE',
        `Recipe "${recipe.id}" must define at least one output.`
      );
    }

    for (const ingredient of recipe.ingredients) {
      if (!this.hasValidItem(ingredient.itemId)) {
        throw new UnknownItemError(ingredient.itemId);
      }
      if (!Number.isInteger(ingredient.count) || ingredient.count <= 0) {
        throw new SimulationError(
          'INVALID_RECIPE',
          `Recipe "${recipe.id}" ingredient "${ingredient.itemId}" must have a positive integer count.`
        );
      }
    }

    for (const output of recipe.outputs) {
      if (!this.hasValidItem(output.itemId)) {
        throw new UnknownItemError(output.itemId);
      }
      if (!Number.isInteger(output.count) || output.count <= 0) {
        throw new SimulationError(
          'INVALID_RECIPE',
          `Recipe "${recipe.id}" output "${output.itemId}" must have a positive integer count.`
        );
      }
    }
  }

  /**
   * Registers a single recipe after validating all ingredient and output ItemIds.
   */
  register(recipe: RecipeDefinition): void {
    this.validateRecipe(recipe);
    this.recipes.set(recipe.id, freezeRecipe(recipe));
  }

  /**
   * Atomically validates and registers a batch of recipes.
   * If any recipe is invalid, no recipes from the batch are added.
   */
  registerMany(recipes: readonly RecipeDefinition[]): void {
    const seen = new Set<string>(this.recipes.keys());
    for (const recipe of recipes) {
      this.validateRecipe(recipe, seen);
      seen.add(recipe.id);
    }
    for (const recipe of recipes) {
      this.recipes.set(recipe.id, freezeRecipe(recipe));
    }
  }

  /**
   * Returns whether a recipe ID is registered.
   */
  has(recipeId: string): boolean {
    return this.recipes.has(recipeId as RecipeId);
  }

  /**
   * Retrieves a recipe by ID. Fails closed with UnknownRecipeError if missing.
   */
  get(recipeId: RecipeId | string): RecipeDefinition {
    const recipe = this.recipes.get(recipeId as RecipeId);
    if (!recipe) {
      throw new UnknownRecipeError(recipeId);
    }
    return recipe;
  }

  /**
   * Returns all registered recipes in deterministic registration order.
   */
  listAll(): readonly RecipeDefinition[] {
    return Array.from(this.recipes.values());
  }

  /**
   * Returns all registered recipes matching the given category.
   */
  getByCategory(category: RecipeCategory): readonly RecipeDefinition[] {
    const result: RecipeDefinition[] = [];
    for (const recipe of this.recipes.values()) {
      if (recipe.category === category) {
        result.push(recipe);
      }
    }
    return result;
  }

  /**
   * Returns all registered recipes that produce the specified ItemId.
   */
  getByOutput(itemId: ItemId): readonly RecipeDefinition[] {
    if (!this.hasValidItem(itemId)) {
      throw new UnknownItemError(itemId);
    }
    const result: RecipeDefinition[] = [];
    for (const recipe of this.recipes.values()) {
      if (recipe.outputs.some((out) => out.itemId === itemId)) {
        result.push(recipe);
      }
    }
    return result;
  }

  /**
   * Finds the first smelting recipe whose single input matches the given ItemId.
   * Used by Stone Furnace (T24) and Electric Furnace (T25) for auto-recipe selection.
   */
  findSmeltingRecipeForInput(itemId: ItemId): RecipeDefinition | null {
    if (!this.hasValidItem(itemId)) {
      throw new UnknownItemError(itemId);
    }
    for (const recipe of this.recipes.values()) {
      if (
        recipe.category === 'smelting' &&
        recipe.ingredients.length === 1 &&
        recipe.ingredients[0]?.itemId === itemId
      ) {
        return recipe;
      }
    }
    return null;
  }

  /**
   * Checks whether a registered recipe is unlocked given the completed technologies.
   * Fails closed with UnknownRecipeError if the recipe does not exist.
   */
  isRecipeUnlocked(
    recipeId: RecipeId,
    completedTechs: ReadonlySet<TechId> | readonly TechId[]
  ): boolean {
    const recipe = this.get(recipeId);
    if (!recipe.requiredTech) {
      return true;
    }
    if (completedTechs instanceof Set) {
      return completedTechs.has(recipe.requiredTech);
    }
    return (completedTechs as readonly TechId[]).includes(recipe.requiredTech);
  }

  /**
   * Returns all recipes unlocked by the given set/list of completed technologies.
   */
  getUnlockedRecipes(
    completedTechs: ReadonlySet<TechId> | readonly TechId[]
  ): readonly RecipeDefinition[] {
    const completedSet =
      completedTechs instanceof Set ? completedTechs : new Set<TechId>(completedTechs);
    const result: RecipeDefinition[] = [];
    for (const recipe of this.recipes.values()) {
      if (!recipe.requiredTech || completedSet.has(recipe.requiredTech)) {
        result.push(recipe);
      }
    }
    return result;
  }
}

export function createRecipeRegistry(
  itemValidator?: ItemValidator,
  initialRecipes?: readonly RecipeDefinition[]
): RecipeRegistry {
  return new RecipeRegistry(itemValidator, initialRecipes);
}
