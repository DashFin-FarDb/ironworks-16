/**
 * Ironworks-16 Inserter State Machine (T15)
 *
 * Implements the deterministic inserter arm state machine:
 *   idle -> picking -> swinging -> dropping -> returning -> idle
 * moving 1 item at a time between source and target tiles with strict
 * item conservation under backpressure and zero-speed halts.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type Direction,
  type Entity,
  type EntityId,
  type FilterInserterEntity,
  type InserterEntity,
  type InserterPhase,
  type InventoryState,
  type ItemId,
  type TileCoord,
  type WorldState,
  SimulationError,
  clamp,
  isWithinBounds,
  oppositeDirection,
  stepCoord,
} from '../types/contracts.js';
import { assertValidItemId, getStackSize, isFuelItem } from '../core/itemRegistry.js';
import { insertItem, removeItem } from '../core/inventory.js';
import {
  type BeltLaneSide,
  insertOnBelt,
  takeItemFromBelt,
  takeItemFromLane,
} from './belt.js';

/** Union of standard and filter inserter entities. */
export type AnyInserterEntity = InserterEntity | FilterInserterEntity;

/** Predicate restricting which items an inserter is allowed to pick up. */
export type InserterItemFilter = (itemId: ItemId) => boolean;

/** Default phase durations in simulation ticks (exact IEEE-754 powers of 2). */
export const INSERTER_PICK_TICKS = 4;
export const INSERTER_SWING_TICKS = 16;
export const INSERTER_DROP_TICKS = 4;
export const INSERTER_RETURN_TICKS = 16;
export const INSERTER_CYCLE_TICKS =
  INSERTER_PICK_TICKS +
  INSERTER_SWING_TICKS +
  INSERTER_DROP_TICKS +
  INSERTER_RETURN_TICKS;

/** Threshold for phase completion to prevent IEEE-754 rounding stalls on non-power-of-2 timings. */
const PHASE_COMPLETE_THRESHOLD = 1 - 1e-9;

/** Default normalized offset on a target belt where an inserter drops items. */
export const INSERTER_BELT_DROP_OFFSET = 0.5;

export interface InserterTimingConfig {
  readonly pickTicks?: number;
  readonly swingTicks?: number;
  readonly dropTicks?: number;
  readonly returnTicks?: number;
}

export interface InserterIO {
  /**
   * Optional non-mutating check for whether a qualifying item is available
   * at the source tile. If omitted, the inserter transitions `idle -> picking`
   * immediately and attempts `pick()` at the end of the picking phase.
   */
  canPick?: (filter?: InserterItemFilter) => boolean;
  /**
   * Extract and return a single item from the source tile, or `null` if none
   * is available. Must only remove an item when returning a non-null `ItemId`.
   */
  pick: (filter?: InserterItemFilter) => ItemId | null;
  /**
   * Deposit `itemId` onto/into the target tile. Returns `true` if the target
   * accepted ownership of the item, or `false` if blocked (backpressure).
   */
  drop: (itemId: ItemId) => boolean;
}

export interface InserterStepOptions {
  /** Speed multiplier (default `1`). `0` halts cleanly with zero progress. */
  speed?: number;
  /** Optional item filter predicate (used by T16 FilterInserter). */
  filter?: InserterItemFilter;
  /** Optional custom phase durations in ticks. */
  timing?: InserterTimingConfig;
}

export interface InserterStepResult {
  readonly previousPhase: InserterPhase;
  readonly currentPhase: InserterPhase;
  readonly pickedItem: ItemId | null;
  readonly droppedItem: ItemId | null;
  readonly blocked: boolean;
}

/** Convert a cardinal Direction to its angle in radians (E=0, S=π/2, W=π, N=-π/2). */
export function directionToAngle(dir: Direction): number {
  switch (dir) {
    case 'E':
      return 0;
    case 'S':
      return Math.PI / 2;
    case 'W':
      return Math.PI;
    case 'N':
      return -Math.PI / 2;
  }
}

/** Compute the source (pickup) tile coordinate behind the inserter. */
export function getInserterSourceCoord(inserter: AnyInserterEntity): TileCoord {
  return stepCoord(inserter.position, oppositeDirection(inserter.direction), 1);
}

/** Compute the target (drop-off) tile coordinate in front of the inserter. */
export function getInserterTargetCoord(inserter: AnyInserterEntity): TileCoord {
  return stepCoord(inserter.position, inserter.direction, 1);
}

/**
 * Compute the deterministic arm angle in radians for the inserter's current
 * phase and `phaseProgress`.
 * - `idle` / `picking`: pointing at source (`sourceAngle`)
 * - `swinging`: interpolating from `sourceAngle` to `targetAngle` (+π * progress)
 * - `dropping`: pointing at target (`targetAngle`)
 * - `returning`: interpolating from `targetAngle` back to `sourceAngle` (+π * progress)
 */
export function computeInserterArmAngle(
  direction: Direction,
  phase: InserterPhase,
  phaseProgress: number
): number {
  const targetAngle = directionToAngle(direction);
  const sourceAngle = directionToAngle(oppositeDirection(direction));
  const p = clamp(phaseProgress, 0, 1);

  switch (phase) {
    case 'idle':
    case 'picking':
      return sourceAngle;
    case 'swinging':
      return sourceAngle + Math.PI * p;
    case 'dropping':
      return targetAngle;
    case 'returning':
      return targetAngle + Math.PI * p;
  }
}

/** Create a new standard `InserterEntity` in the `idle` phase. */
export function createInserterEntity(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'E'
): InserterEntity {
  return {
    id,
    type: 'inserter',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    phase: 'idle',
    phaseProgress: 0,
    heldItem: null,
    armAngle: computeInserterArmAngle(direction, 'idle', 0),
  };
}

function validateSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed < 0) {
    throw new SimulationError(
      'INVALID_INSERTER_SPEED',
      `Inserter speed must be a finite non-negative number, received ${String(speed)}.`
    );
  }
}

function validatePositiveTicks(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SimulationError(
      'INVALID_INSERTER_TIMING',
      `${name} must be a finite positive number, received ${String(value)}.`
    );
  }
}

/**
 * Advance an inserter's state machine by one simulation tick using the
 * supplied `InserterIO` callbacks.
 *
 * Conservation guarantees:
 * - At most 1 item is ever held (`heldItem`).
 * - An item is only removed from source when `heldItem === null`.
 * - `heldItem` is only cleared when `io.drop(heldItem)` returns `true`.
 * - Under target backpressure, the inserter halts cleanly in `dropping`
 *   with `phaseProgress = 1` and `heldItem` intact.
 */
export function stepInserter(
  inserter: AnyInserterEntity,
  io: InserterIO,
  options: InserterStepOptions = {}
): InserterStepResult {
  const speed = options.speed ?? 1;
  validateSpeed(speed);

  const pickTicks = options.timing?.pickTicks ?? INSERTER_PICK_TICKS;
  const swingTicks = options.timing?.swingTicks ?? INSERTER_SWING_TICKS;
  const dropTicks = options.timing?.dropTicks ?? INSERTER_DROP_TICKS;
  const returnTicks = options.timing?.returnTicks ?? INSERTER_RETURN_TICKS;

  validatePositiveTicks(pickTicks, 'pickTicks');
  validatePositiveTicks(swingTicks, 'swingTicks');
  validatePositiveTicks(dropTicks, 'dropTicks');
  validatePositiveTicks(returnTicks, 'returnTicks');

  const previousPhase = inserter.phase;
  let pickedItem: ItemId | null = null;
  let droppedItem: ItemId | null = null;
  let blocked = false;

  // Zero-speed (e.g. unpowered/brownout) halts cleanly with zero progress.
  if (speed === 0) {
    inserter.active = false;
    inserter.armAngle = computeInserterArmAngle(
      inserter.direction,
      inserter.phase,
      inserter.phaseProgress
    );
    return {
      previousPhase,
      currentPhase: inserter.phase,
      pickedItem: null,
      droppedItem: null,
      blocked: false,
    };
  }

  switch (inserter.phase) {
    case 'idle': {
      // Conservation guard: if an item is somehow already held in idle, resume swinging.
      if (inserter.heldItem !== null) {
        inserter.phase = 'swinging';
        inserter.phaseProgress = 0;
        inserter.active = true;
        break;
      }

      const available = io.canPick ? io.canPick(options.filter) : true;
      if (available) {
        inserter.phase = 'picking';
        inserter.phaseProgress = 0;
        inserter.active = true;
      } else {
        inserter.phaseProgress = 0;
        inserter.active = false;
      }
      break;
    }

    case 'picking': {
      inserter.active = true;
      inserter.phaseProgress = clamp(
        inserter.phaseProgress + speed / pickTicks,
        0,
        1
      );

      if (inserter.phaseProgress >= PHASE_COMPLETE_THRESHOLD) {
        const item = io.pick(options.filter);
        if (item !== null) {
          assertValidItemId(item);
          inserter.heldItem = item;
          pickedItem = item;
          inserter.phase = 'swinging';
          inserter.phaseProgress = 0;
        } else {
          // Source became empty before pickup completed; return to idle cleanly.
          inserter.phase = 'idle';
          inserter.phaseProgress = 0;
          inserter.active = false;
        }
      }
      break;
    }

    case 'swinging': {
      // Conservation guard: if no item is held, return cleanly instead of dropping nothing.
      if (inserter.heldItem === null) {
        inserter.phase = 'returning';
        inserter.phaseProgress = 0;
        inserter.active = true;
        break;
      }

      inserter.active = true;
      inserter.phaseProgress = clamp(
        inserter.phaseProgress + speed / swingTicks,
        0,
        1
      );

      if (inserter.phaseProgress >= PHASE_COMPLETE_THRESHOLD) {
        inserter.phase = 'dropping';
        inserter.phaseProgress = 0;
      }
      break;
    }

    case 'dropping': {
      if (inserter.heldItem === null) {
        inserter.phase = 'returning';
        inserter.phaseProgress = 0;
        inserter.active = true;
        break;
      }

      inserter.phaseProgress = clamp(
        inserter.phaseProgress + speed / dropTicks,
        0,
        1
      );

      if (inserter.phaseProgress >= PHASE_COMPLETE_THRESHOLD) {
        const accepted = io.drop(inserter.heldItem);
        if (accepted) {
          droppedItem = inserter.heldItem;
          inserter.heldItem = null;
          inserter.phase = 'returning';
          inserter.phaseProgress = 0;
          inserter.active = true;
        } else {
          // Backpressure: hold item at full drop progress until target has space.
          inserter.phaseProgress = 1;
          inserter.active = false;
          blocked = true;
        }
      } else {
        inserter.active = true;
      }
      break;
    }

    case 'returning': {
      inserter.active = true;
      inserter.phaseProgress = clamp(
        inserter.phaseProgress + speed / returnTicks,
        0,
        1
      );

      if (inserter.phaseProgress >= PHASE_COMPLETE_THRESHOLD) {
        inserter.phase = 'idle';
        inserter.phaseProgress = 0;
        inserter.active = false;
      }
      break;
    }
  }

  inserter.armAngle = computeInserterArmAngle(
    inserter.direction,
    inserter.phase,
    inserter.phaseProgress
  );

  return {
    previousPhase,
    currentPhase: inserter.phase,
    pickedItem,
    droppedItem,
    blocked,
  };
}

// ============================================================================
// World-Integrated Source & Target Resolution
// ============================================================================

function getEntityAtCoord(world: WorldState, coord: TileCoord): Entity | null {
  if (!isWithinBounds(coord, { width: world.width, height: world.height })) {
    return null;
  }
  const tile = world.tiles[coord.y * world.width + coord.x];
  if (!tile || tile.entityId === null) {
    return null;
  }
  return world.entities[tile.entityId] ?? null;
}

function hasMatchingItemInInventory(
  inv: InventoryState,
  filter?: InserterItemFilter
): boolean {
  for (const slot of inv.slots) {
    if (slot.item !== null && slot.item.count > 0) {
      if (!filter || filter(slot.item.itemId)) {
        return true;
      }
    }
  }
  return false;
}

function extractOneFromInventory(
  inv: InventoryState,
  filter?: InserterItemFilter
): ItemId | null {
  for (const slot of inv.slots) {
    if (slot.item !== null && slot.item.count > 0) {
      const candidate = slot.item.itemId;
      if (!filter || filter(candidate)) {
        const removed = removeItem(inv, candidate, 1);
        if (removed === 1) {
          return candidate;
        }
      }
    }
  }
  return null;
}

/** Check whether `entity` currently has an extractable item matching `filter`. */
export function canPickFromEntity(
  entity: Entity | null,
  filter?: InserterItemFilter
): boolean {
  if (!entity) return false;

  switch (entity.type) {
    case 'transport_belt':
    case 'splitter': {
      for (const item of entity.leftLane.items) {
        if (!filter || filter(item.itemId)) return true;
      }
      for (const item of entity.rightLane.items) {
        if (!filter || filter(item.itemId)) return true;
      }
      return false;
    }
    case 'wooden_chest':
    case 'iron_chest':
      return hasMatchingItemInInventory(entity.inventory, filter);
    case 'stone_furnace':
    case 'electric_furnace':
    case 'assembler_mk1':
    case 'assembler_mk2':
      return hasMatchingItemInInventory(entity.outputInventory, filter);
    default:
      return false;
  }
}

/** Extract a single item matching `filter` from `entity`, or `null` if unavailable. */
export function pickFromEntity(
  entity: Entity | null,
  filter?: InserterItemFilter
): ItemId | null {
  if (!entity) return null;

  switch (entity.type) {
    case 'transport_belt':
      return takeItemFromBelt(
        entity,
        filter ? (laneItem) => filter(laneItem.itemId) : undefined
      );
    case 'splitter': {
      const fromLeft = takeItemFromLane(
        entity.leftLane,
        filter ? (laneItem) => filter(laneItem.itemId) : undefined
      );
      if (fromLeft !== null) return fromLeft;
      return takeItemFromLane(
        entity.rightLane,
        filter ? (laneItem) => filter(laneItem.itemId) : undefined
      );
    }
    case 'wooden_chest':
    case 'iron_chest':
      return extractOneFromInventory(entity.inventory, filter);
    case 'stone_furnace':
    case 'electric_furnace':
    case 'assembler_mk1':
    case 'assembler_mk2':
      return extractOneFromInventory(entity.outputInventory, filter);
    default:
      return null;
  }
}

/**
 * Attempt to deposit a single `itemId` into `entity`.
 * Returns `true` if accepted, `false` if blocked or incompatible.
 */
export function dropIntoEntity(
  entity: Entity | null,
  itemId: ItemId
): boolean {
  if (!entity) return false;
  assertValidItemId(itemId);

  switch (entity.type) {
    case 'transport_belt': {
      // Standard inserter drops onto the far (right) lane first, falling back to left.
      const sides: readonly BeltLaneSide[] = ['right', 'left'];
      for (const side of sides) {
        if (insertOnBelt(entity, side, itemId, INSERTER_BELT_DROP_OFFSET)) {
          return true;
        }
      }
      return false;
    }
    case 'wooden_chest':
    case 'iron_chest':
      return insertItem(entity.inventory, itemId, 1, getStackSize) === 1;
    case 'stone_furnace':
      if (isFuelItem(itemId)) {
        return insertItem(entity.fuelInventory, itemId, 1, getStackSize) === 1;
      }
      return insertItem(entity.inputInventory, itemId, 1, getStackSize) === 1;
    case 'electric_furnace':
    case 'assembler_mk1':
    case 'assembler_mk2':
    case 'research_lab':
      return insertItem(entity.inputInventory, itemId, 1, getStackSize) === 1;
    case 'burner_drill':
    case 'boiler':
      if (!isFuelItem(itemId)) return false;
      return insertItem(entity.fuelInventory, itemId, 1, getStackSize) === 1;
    default:
      return false;
  }
}

/**
 * Advance a single inserter in `world` by one tick, automatically resolving
 * its source and target entities from `world.tiles` / `world.entities`.
 */
export function tickInserter(
  world: WorldState,
  inserter: AnyInserterEntity,
  options: InserterStepOptions = {}
): InserterStepResult {
  const sourceEntity = getEntityAtCoord(world, getInserterSourceCoord(inserter));
  const targetEntity = getEntityAtCoord(world, getInserterTargetCoord(inserter));

  return stepInserter(
    inserter,
    {
      canPick: (filter) => canPickFromEntity(sourceEntity, filter),
      pick: (filter) => pickFromEntity(sourceEntity, filter),
      drop: (itemId) => dropIntoEntity(targetEntity, itemId),
    },
    options
  );
}

/**
 * Deterministically tick all standard `'inserter'` entities in `world`
 * in ascending `EntityId` order.
 */
export function tickAllInserters(
  world: WorldState,
  options: InserterStepOptions = {}
): void {
  const ids = Object.keys(world.entities)
    .map(Number)
    .sort((a, b) => a - b);

  for (const id of ids) {
    const entity = world.entities[id];
    if (entity && entity.type === 'inserter') {
      tickInserter(world, entity, options);
    }
  }
}
