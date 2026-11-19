/**
 * Ironworks-16 Research Lab Machine (T30)
 *
 * 60 kW electric research lab consuming science packs from its input inventory
 * to advance the currently active technology in `world.research` via `TechTree`.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 * Item-conserving & fail-closed: only consumes packs accepted by `TechTree`,
 * halts cleanly with zero progress under 0% power or missing science packs.
 */

import {
  clamp,
  SimulationError,
  TICKS_PER_SECOND,
  type Direction,
  type EntityId,
  type ItemId,
  type ResearchLabEntity,
  type TechId,
  type TileCoord,
  type WorldState,
} from '../types/contracts';
import type { EventBus } from '../core/eventBus';
import {
  canInsert,
  createInventoryState,
  getItemCount,
  insertItem,
  removeItem,
} from '../core/inventory';
import { getItemDefinition, getStackSize } from '../core/itemRegistry';
import {
  getEntityPowerSatisfaction,
  scaleMachineSpeed,
} from '../logistics/powerSolver';
import type { TechTree } from '../logistics/techTree';

// ============================================================================
// Constants
// ============================================================================

export const RESEARCH_LAB_POWER_DEMAND_KW = 60;
export const RESEARCH_LAB_INPUT_SLOTS = 2;
/** Base simulation ticks required to consume 1 science pack at 100% power. */
export const RESEARCH_LAB_TICKS_PER_PACK = TICKS_PER_SECOND;

export const SCIENCE_PACK_ITEMS: readonly ItemId[] = [
  'red_science',
  'green_science',
] as const;

// ============================================================================
// Types
// ============================================================================

export interface ResearchLabUpdateOptions {
  /** Ticks required to consume 1 science pack at 100% power (default 60). */
  readonly ticksPerPack?: number;
  /** Optional explicit power satisfaction override in [0, 1] for isolated tests. */
  readonly powerSatisfactionOverride?: number;
  /** Optional simulation event bus for emitting `researchCompleted` events. */
  readonly eventBus?: EventBus;
  /** Optional callback invoked whenever a science pack is consumed. */
  readonly onPackConsumed?: (
    itemId: ItemId,
    count: number,
    labId: EntityId
  ) => void;
}

export interface ConsumedSciencePack {
  readonly itemId: ItemId;
  readonly count: number;
}

export interface ResearchLabTickResult {
  readonly labId: EntityId;
  readonly active: boolean;
  readonly satisfaction: number;
  readonly progressDelta: number;
  readonly packsConsumed: readonly ConsumedSciencePack[];
  readonly completedTech: TechId | null;
}

// ============================================================================
// Construction & Science Pack Helpers
// ============================================================================

/**
 * Creates a standalone `ResearchLabEntity` matching T01/T04 contracts.
 */
export function createResearchLab(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N'
): ResearchLabEntity {
  return {
    id,
    type: 'research_lab',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    powerDemandKw: RESEARCH_LAB_POWER_DEMAND_KW,
    inputInventory: createInventoryState(RESEARCH_LAB_INPUT_SLOTS),
    researchProgress: 0,
  };
}

/**
 * Returns true if `itemId` is a valid science pack item.
 */
export function isSciencePack(itemId: ItemId): boolean {
  return getItemDefinition(itemId).category === 'science';
}

/**
 * Returns how many units of `itemId` can be inserted into the lab's input inventory.
 * Non-science items are rejected (returns 0).
 */
export function canInsertSciencePack(
  lab: ResearchLabEntity,
  itemId: ItemId,
  count: number
): number {
  if (!isSciencePack(itemId)) {
    return 0;
  }
  return canInsert(lab.inputInventory, itemId, count, getStackSize);
}

/**
 * Inserts up to `count` science packs into the lab's input inventory.
 * Fails closed with `SimulationError('INVALID_SCIENCE_PACK')` if `itemId` is not a science pack.
 * Returns the exact number of packs inserted (preserving item conservation).
 */
export function insertSciencePack(
  lab: ResearchLabEntity,
  itemId: ItemId,
  count: number
): number {
  if (!isSciencePack(itemId)) {
    throw new SimulationError(
      'INVALID_SCIENCE_PACK',
      `Research lab only accepts science packs; cannot insert "${itemId}".`
    );
  }
  return insertItem(lab.inputInventory, itemId, count, getStackSize);
}

// ============================================================================
// Per-Tick Simulation Update
// ============================================================================

function validateUpdateOptions(options?: ResearchLabUpdateOptions): {
  ticksPerPack: number;
  powerSatisfactionOverride: number | undefined;
} {
  const ticksPerPack = options?.ticksPerPack ?? RESEARCH_LAB_TICKS_PER_PACK;
  if (!Number.isFinite(ticksPerPack) || ticksPerPack <= 0) {
    throw new SimulationError(
      'INVALID_RESEARCH_DURATION',
      `ticksPerPack must be a finite positive number, received ${String(ticksPerPack)}.`
    );
  }

  const override = options?.powerSatisfactionOverride;
  if (override !== undefined && (!Number.isFinite(override) || override < 0)) {
    throw new SimulationError(
      'INVALID_POWER_SATISFACTION',
      `powerSatisfactionOverride must be a non-negative finite number, received ${String(override)}.`
    );
  }

  return { ticksPerPack, powerSatisfactionOverride: override };
}

function findNextConsumableSciencePack(
  lab: ResearchLabEntity,
  world: WorldState,
  techTree: TechTree
): ItemId | null {
  if (world.research.activeTech === null) {
    return null;
  }
  const remaining = techTree.getRemainingCost(world.research);
  for (const req of remaining) {
    if (getItemCount(lab.inputInventory, req.itemId) >= 1) {
      return req.itemId;
    }
  }
  return null;
}

/**
 * Advances a single `ResearchLabEntity` by one simulation tick.
 *
 * Behavior:
 * - Halts cleanly (`active = false`, zero progress) if no tech is active,
 *   no required science pack is in `inputInventory`, or power satisfaction is 0.
 * - Scales progress proportionally to power satisfaction in [0, 1].
 * - Consumes 1 required science pack from `inputInventory` each time
 *   `researchProgress >= ticksPerPack`, contributing it to `techTree`.
 * - Never loses excess or unrequired science packs.
 */
export function updateResearchLab(
  lab: ResearchLabEntity,
  world: WorldState,
  techTree: TechTree,
  options?: ResearchLabUpdateOptions
): ResearchLabTickResult {
  const { ticksPerPack, powerSatisfactionOverride } = validateUpdateOptions(options);

  const satisfaction =
    powerSatisfactionOverride !== undefined
      ? clamp(powerSatisfactionOverride, 0, 1)
      : getEntityPowerSatisfaction(world, lab);

  if (world.research.activeTech === null) {
    lab.active = false;
    lab.researchProgress = 0;
    return {
      labId: lab.id,
      active: false,
      satisfaction,
      progressDelta: 0,
      packsConsumed: [],
      completedTech: null,
    };
  }

  const nextPack = findNextConsumableSciencePack(lab, world, techTree);
  if (nextPack === null || satisfaction <= 0) {
    lab.active = false;
    return {
      labId: lab.id,
      active: false,
      satisfaction,
      progressDelta: 0,
      packsConsumed: [],
      completedTech: null,
    };
  }

  lab.active = true;
  const progressDelta = scaleMachineSpeed(1, satisfaction);
  lab.researchProgress += progressDelta;

  const packsConsumed: ConsumedSciencePack[] = [];
  let completedTech: TechId | null = null;

  while (lab.researchProgress >= ticksPerPack && world.research.activeTech !== null) {
    const targetItem = findNextConsumableSciencePack(lab, world, techTree);
    if (targetItem === null) {
      // Clamp progress below a full cycle until another required pack arrives.
      lab.researchProgress = Math.min(lab.researchProgress, ticksPerPack);
      break;
    }

    const result = techTree.contributeScience(world.research, targetItem, 1, {
      tick: world.tick,
      eventBus: options?.eventBus,
    });

    if (result.accepted > 0) {
      const removed = removeItem(lab.inputInventory, targetItem, result.accepted);
      if (removed !== result.accepted) {
        throw new SimulationError(
          'INVENTORY_CONSERVATION_ERROR',
          `Research lab ${lab.id} expected to remove ${result.accepted} "${targetItem}", removed ${removed}.`
        );
      }
      packsConsumed.push({ itemId: targetItem, count: result.accepted });
      options?.onPackConsumed?.(targetItem, result.accepted, lab.id);
    }

    lab.researchProgress = Math.max(0, lab.researchProgress - ticksPerPack);

    if (result.completed) {
      completedTech = result.techId;
      lab.researchProgress = 0;
      break;
    }
  }

  return {
    labId: lab.id,
    active: true,
    satisfaction,
    progressDelta,
    packsConsumed,
    completedTech,
  };
}

/**
 * Updates all `research_lab` entities in `world.entities` in deterministic ascending ID order.
 */
export function updateAllResearchLabs(
  world: WorldState,
  techTree: TechTree,
  options?: ResearchLabUpdateOptions
): ResearchLabTickResult[] {
  const labs: ResearchLabEntity[] = [];
  const sortedIds = Object.keys(world.entities)
    .map((key) => Number(key))
    .sort((a, b) => a - b);

  for (const id of sortedIds) {
    const entity = world.entities[id];
    if (entity && entity.type === 'research_lab') {
      labs.push(entity);
    }
  }

  const results: ResearchLabTickResult[] = [];
  for (const lab of labs) {
    results.push(updateResearchLab(lab, world, techTree, options));
  }
  return results;
}
