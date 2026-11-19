/**
 * Ironworks-16 Research & Tech Tree State Machine (T20)
 *
 * Deterministic research state machine covering:
 * - automation
 * - logistics
 * - steel_processing
 * - solar_energy
 *
 * Gates locked recipes until their required technology is completed, enforces
 * prerequisite DAG validation, preserves science pack item conservation via
 * explicit accepted/rejected counts, and optionally emits `researchCompleted`
 * events on the simulation EventBus.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type ItemId,
  type RecipeId,
  type RecipeIngredient,
  type ResearchState,
  type TechDefinition,
  type TechId,
  SimulationError,
} from '../types/contracts';
import type { EventBus } from '../core/eventBus';

export const TECH_IDS: readonly TechId[] = [
  'automation',
  'logistics',
  'steel_processing',
  'solar_energy',
] as const;

export type TechStatus = 'locked' | 'available' | 'in_progress' | 'completed';

export interface ContributeScienceOptions {
  readonly tick?: number;
  readonly eventBus?: EventBus;
}

export interface ContributeResult {
  readonly techId: TechId;
  readonly itemId: ItemId;
  readonly accepted: number;
  readonly rejected: number;
  readonly completed: boolean;
}

function freezeTechDefinition(def: TechDefinition): TechDefinition {
  return Object.freeze({
    ...def,
    prerequisites: Object.freeze([...def.prerequisites]),
    cost: Object.freeze(def.cost.map((c) => Object.freeze({ ...c }))),
    unlocksRecipes: Object.freeze([...def.unlocksRecipes]),
  });
}

/**
 * Canonical technology definitions for Ironworks-16.
 *
 * Dependency DAG:
 *   automation (10 red_science) -> unlocks electronic_circuit, inserter
 *     ├── logistics (20 red_science) -> unlocks green_science
 *     └── steel_processing (25 red_science) -> unlocks steel_plate
 *           └── solar_energy (30 red_science, 30 green_science; requires logistics + steel_processing)
 *                 -> unlocks power_pole
 */
export const CANONICAL_TECH_DEFINITIONS: Readonly<Record<TechId, TechDefinition>> = Object.freeze({
  automation: freezeTechDefinition({
    id: 'automation',
    name: 'Automation',
    prerequisites: [],
    cost: [{ itemId: 'red_science', count: 10 }],
    unlocksRecipes: ['electronic_circuit', 'inserter'],
  }),
  logistics: freezeTechDefinition({
    id: 'logistics',
    name: 'Logistics',
    prerequisites: ['automation'],
    cost: [{ itemId: 'red_science', count: 20 }],
    unlocksRecipes: ['green_science'],
  }),
  steel_processing: freezeTechDefinition({
    id: 'steel_processing',
    name: 'Steel Processing',
    prerequisites: ['automation'],
    cost: [{ itemId: 'red_science', count: 25 }],
    unlocksRecipes: ['steel_plate'],
  }),
  solar_energy: freezeTechDefinition({
    id: 'solar_energy',
    name: 'Solar Energy',
    prerequisites: ['logistics', 'steel_processing'],
    cost: [
      { itemId: 'red_science', count: 30 },
      { itemId: 'green_science', count: 30 },
    ],
    unlocksRecipes: ['power_pole'],
  }),
});

/**
 * Creates a fresh, empty ResearchState for a new WorldState.
 */
export function createInitialResearchState(): ResearchState {
  return {
    activeTech: null,
    completedTechs: [],
    progress: {},
  };
}

export class TechTree {
  private readonly techs = new Map<TechId, TechDefinition>();
  private readonly recipeToTech = new Map<RecipeId, TechId>();

  constructor(definitions?: readonly TechDefinition[]) {
    const defs = definitions ?? TECH_IDS.map((id) => CANONICAL_TECH_DEFINITIONS[id]);
    this.validateAndLoad(defs);
  }

  private validateAndLoad(defs: readonly TechDefinition[]): void {
    const byId = new Map<TechId, TechDefinition>();

    for (const def of defs) {
      if (!def.id || typeof def.id !== 'string') {
        throw new SimulationError('INVALID_TECH', 'Tech definition id must be a non-empty string.');
      }
      if (byId.has(def.id)) {
        throw new SimulationError('DUPLICATE_TECH', `Duplicate tech definition "${def.id}".`);
      }
      if (!Array.isArray(def.cost) || def.cost.length === 0) {
        throw new SimulationError('INVALID_TECH', `Tech "${def.id}" must define at least one science cost.`);
      }
      const seenCostItems = new Set<ItemId>();
      for (const entry of def.cost) {
        if (!Number.isInteger(entry.count) || entry.count <= 0) {
          throw new SimulationError(
            'INVALID_TECH',
            `Tech "${def.id}" cost for "${entry.itemId}" must be a positive integer.`
          );
        }
        if (seenCostItems.has(entry.itemId)) {
          throw new SimulationError(
            'INVALID_TECH',
            `Tech "${def.id}" has duplicate cost entry for "${entry.itemId}".`
          );
        }
        seenCostItems.add(entry.itemId);
      }
      byId.set(def.id, freezeTechDefinition(def));
    }

    // Validate prerequisites exist
    for (const def of byId.values()) {
      for (const prereq of def.prerequisites) {
        if (!byId.has(prereq)) {
          throw new SimulationError(
            'UNKNOWN_TECH',
            `Tech "${def.id}" references unknown prerequisite "${prereq}".`
          );
        }
      }
    }

    // Detect cycles via deterministic DFS
    const visiting = new Set<TechId>();
    const visited = new Set<TechId>();

    const visit = (id: TechId): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new SimulationError('CIRCULAR_TECH_DEPENDENCY', `Circular prerequisite detected involving "${id}".`);
      }
      visiting.add(id);
      const def = byId.get(id)!;
      for (const prereq of def.prerequisites) {
        visit(prereq);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of byId.keys()) {
      visit(id);
    }

    // Build recipe gating index
    for (const def of byId.values()) {
      this.techs.set(def.id, def);
      for (const recipeId of def.unlocksRecipes) {
        const existingOwner = this.recipeToTech.get(recipeId);
        if (existingOwner !== undefined && existingOwner !== def.id) {
          throw new SimulationError(
            'DUPLICATE_RECIPE_UNLOCK',
            `Recipe "${recipeId}" is unlocked by multiple techs: "${existingOwner}" and "${def.id}".`
          );
        }
        this.recipeToTech.set(recipeId, def.id);
      }
    }
  }

  /** Number of technologies in the tree. */
  get size(): number {
    return this.techs.size;
  }

  /** Returns whether a tech ID exists in this tree. */
  hasTech(techId: string): boolean {
    return this.techs.has(techId as TechId);
  }

  /** Retrieves a tech definition. Fails closed with SimulationError('UNKNOWN_TECH') if missing. */
  getTech(techId: TechId | string): TechDefinition {
    const def = this.techs.get(techId as TechId);
    if (!def) {
      throw new SimulationError('UNKNOWN_TECH', `Unknown technology ID: "${techId}".`);
    }
    return def;
  }

  /** Returns all technologies in deterministic registration order. */
  listAll(): readonly TechDefinition[] {
    return Array.from(this.techs.values());
  }

  /** Checks whether a technology has been completed. */
  isCompleted(state: ResearchState, techId: TechId): boolean {
    this.getTech(techId);
    return state.completedTechs.includes(techId);
  }

  /** Checks whether all prerequisites for a technology are completed. */
  arePrerequisitesMet(state: ResearchState, techId: TechId): boolean {
    const def = this.getTech(techId);
    for (const prereq of def.prerequisites) {
      if (!state.completedTechs.includes(prereq)) {
        return false;
      }
    }
    return true;
  }

  /** Returns the current status of a technology in the given ResearchState. */
  getTechStatus(state: ResearchState, techId: TechId): TechStatus {
    this.getTech(techId);
    if (state.completedTechs.includes(techId)) {
      return 'completed';
    }
    if (state.activeTech === techId) {
      return 'in_progress';
    }
    if (this.arePrerequisitesMet(state, techId)) {
      return 'available';
    }
    return 'locked';
  }

  /** Returns all technologies that are currently available to start researching. */
  getAvailableTechs(state: ResearchState): readonly TechDefinition[] {
    const result: TechDefinition[] = [];
    for (const def of this.techs.values()) {
      if (this.getTechStatus(state, def.id) === 'available') {
        result.push(def);
      }
    }
    return result;
  }

  /**
   * Starts researching the specified technology.
   * Fails closed if the tech is unknown, already completed, or missing prerequisites.
   * Switching from another active tech resets progress for the new tech.
   */
  startResearch(state: ResearchState, techId: TechId): void {
    this.getTech(techId);

    if (state.completedTechs.includes(techId)) {
      throw new SimulationError(
        'TECH_ALREADY_COMPLETED',
        `Technology "${techId}" has already been completed.`
      );
    }

    if (!this.arePrerequisitesMet(state, techId)) {
      throw new SimulationError(
        'PREREQUISITES_NOT_MET',
        `Cannot start "${techId}": prerequisite technologies are not completed.`
      );
    }

    if (state.activeTech === techId) {
      return;
    }

    state.activeTech = techId;
    state.progress = {};
  }

  /**
   * Cancels the currently active technology and clears in-flight progress.
   */
  cancelResearch(state: ResearchState): void {
    state.activeTech = null;
    state.progress = {};
  }

  /**
   * Contributes science packs toward the currently active technology.
   *
   * Item conservation: returns exact `accepted` and `rejected` counts so callers
   * (e.g. ResearchLab T30) only consume `accepted` packs from inventory and never
   * silently lose excess or mismatched science packs.
   *
   * Fails closed if no technology is active or `count` is not a positive integer.
   */
  contributeScience(
    state: ResearchState,
    itemId: ItemId,
    count: number,
    options?: ContributeScienceOptions
  ): ContributeResult {
    if (state.activeTech === null) {
      throw new SimulationError(
        'NO_ACTIVE_RESEARCH',
        'Cannot contribute science packs when no technology is active.'
      );
    }

    if (!Number.isInteger(count) || count <= 0) {
      throw new SimulationError(
        'INVALID_SCIENCE_COUNT',
        `Science pack contribution count must be a positive integer; received ${String(count)}.`
      );
    }

    const techId = state.activeTech;
    const def = this.getTech(techId);

    const costEntry = def.cost.find((c) => c.itemId === itemId);
    if (!costEntry) {
      return {
        techId,
        itemId,
        accepted: 0,
        rejected: count,
        completed: false,
      };
    }

    const currentDelivered = state.progress[itemId] ?? 0;
    const remainingNeeded = Math.max(0, costEntry.count - currentDelivered);
    const accepted = Math.min(count, remainingNeeded);
    const rejected = count - accepted;

    if (accepted > 0) {
      state.progress[itemId] = currentDelivered + accepted;
    }

    const completed = def.cost.every(
      (entry) => (state.progress[entry.itemId] ?? 0) >= entry.count
    );

    if (completed) {
      if (!state.completedTechs.includes(techId)) {
        state.completedTechs.push(techId);
      }
      state.activeTech = null;
      state.progress = {};

      if (options?.eventBus) {
        options.eventBus.emit('researchCompleted', {
          tick: options.tick ?? 0,
          techId,
        });
      }
    }

    return {
      techId,
      itemId,
      accepted,
      rejected,
      completed,
    };
  }

  /**
   * Returns the normalized progress ratio in [0, 1] for the active technology.
   * Returns 0 when no technology is active.
   */
  getProgressRatio(state: ResearchState): number {
    if (state.activeTech === null) {
      return 0;
    }
    const def = this.getTech(state.activeTech);
    let totalRequired = 0;
    let totalDelivered = 0;
    for (const entry of def.cost) {
      totalRequired += entry.count;
      totalDelivered += Math.min(entry.count, state.progress[entry.itemId] ?? 0);
    }
    if (totalRequired <= 0) {
      return 1;
    }
    return totalDelivered / totalRequired;
  }

  /**
   * Returns the remaining science packs required to complete the active technology.
   */
  getRemainingCost(state: ResearchState): readonly RecipeIngredient[] {
    if (state.activeTech === null) {
      return [];
    }
    const def = this.getTech(state.activeTech);
    const remaining: RecipeIngredient[] = [];
    for (const entry of def.cost) {
      const delivered = state.progress[entry.itemId] ?? 0;
      const needed = Math.max(0, entry.count - delivered);
      if (needed > 0) {
        remaining.push({ itemId: entry.itemId, count: needed });
      }
    }
    return remaining;
  }

  /**
   * Returns the technology required to unlock a recipe, or null if the recipe
   * is unlocked by default.
   */
  getRequiredTechForRecipe(recipeId: RecipeId): TechId | null {
    return this.recipeToTech.get(recipeId) ?? null;
  }

  /**
   * Returns true if the recipe is either unlocked by default or its gating
   * technology has been completed.
   */
  isRecipeUnlocked(state: ResearchState, recipeId: RecipeId): boolean {
    const requiredTech = this.recipeToTech.get(recipeId);
    if (requiredTech === undefined) {
      return true;
    }
    return state.completedTechs.includes(requiredTech);
  }

  /**
   * Fails closed with SimulationError('RECIPE_LOCKED') if the recipe is currently locked.
   */
  assertRecipeUnlocked(state: ResearchState, recipeId: RecipeId): void {
    const requiredTech = this.recipeToTech.get(recipeId);
    if (requiredTech !== undefined && !state.completedTechs.includes(requiredTech)) {
      throw new SimulationError(
        'RECIPE_LOCKED',
        `Recipe "${recipeId}" is locked; requires technology "${requiredTech}".`
      );
    }
  }

  /**
   * Returns all currently locked recipe IDs in deterministic order.
   */
  getLockedRecipes(state: ResearchState): readonly RecipeId[] {
    const locked: RecipeId[] = [];
    for (const [recipeId, techId] of this.recipeToTech.entries()) {
      if (!state.completedTechs.includes(techId)) {
        locked.push(recipeId);
      }
    }
    return locked;
  }

  /**
   * Filters a list of recipe IDs to those currently unlocked, or returns all
   * tech-gated recipes that have been unlocked if `candidateRecipes` is omitted.
   */
  getUnlockedRecipes(
    state: ResearchState,
    candidateRecipes?: readonly RecipeId[]
  ): readonly RecipeId[] {
    if (candidateRecipes) {
      return candidateRecipes.filter((id) => this.isRecipeUnlocked(state, id));
    }
    const unlocked: RecipeId[] = [];
    for (const [recipeId, techId] of this.recipeToTech.entries()) {
      if (state.completedTechs.includes(techId)) {
        unlocked.push(recipeId);
      }
    }
    return unlocked;
  }
}

export function createTechTree(definitions?: readonly TechDefinition[]): TechTree {
  return new TechTree(definitions);
}
