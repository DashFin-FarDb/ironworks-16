/**
 * Ironworks-16 Underground Belt (T14)
 *
 * Implements entry/exit underground belt pairing (bridging up to 4 gap tiles,
 * i.e. 1..5 tiles center-to-center distance), accurate transit delay matched
 * to surface belt speed, and strict backpressure conservation.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type Direction,
  type Entity,
  type EntityId,
  type ItemId,
  type TileCoord,
  type UndergroundBeltEntity,
  type UndergroundBeltItem,
  type UndergroundBeltMode,
  DIRECTION_VECTORS,
  InvalidPlacementError,
  SimulationError,
  oppositeDirection,
  stepCoord,
} from '../types/contracts.js';
import { assertValidItemId } from '../core/itemRegistry.js';
import {
  type BeltLaneSide,
  type LaneHandoffFn,
  BELT_ITEM_SPACING,
  BELT_SPEED,
} from './belt.js';

/**
 * Maximum number of underground gap tiles bridged between entry and exit.
 * A gap of 4 tiles means entry at x=0 and exit at x=5 (distance = 5 tiles).
 */
export const UNDERGROUND_MAX_SPAN = 4;

/** Maximum center-to-center tile distance between paired entry and exit. */
export const UNDERGROUND_MAX_DISTANCE = UNDERGROUND_MAX_SPAN + 1;

export interface UndergroundBeltOptions {
  speed?: number;
  spacing?: number;
}

export interface UndergroundAdvanceOptions extends UndergroundBeltOptions {
  handoff?: LaneHandoffFn;
}

export interface UndergroundAdvanceResult {
  exited: number;
  inTransit: number;
  blocked: number;
}

function validatePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SimulationError(
      'INVALID_UNDERGROUND_PARAMETER',
      `${name} must be a finite positive number, received ${value}.`
    );
  }
}

/**
 * Create a new UndergroundBeltEntity.
 * Fail-closed: throws InvalidPlacementError if mode is not 'input' | 'output'.
 */
export function createUndergroundBeltEntity(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'E',
  mode: UndergroundBeltMode = 'input'
): UndergroundBeltEntity {
  if (mode !== 'input' && mode !== 'output') {
    throw new InvalidPlacementError(
      'underground_belt',
      position,
      `Invalid underground belt mode "${String(mode)}".`
    );
  }
  return {
    id,
    type: 'underground_belt',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    mode,
    pairedEntityId: null,
    transitQueue: [],
  };
}

/** Count total items currently in transit inside an underground belt. */
export function countUndergroundItems(belt: UndergroundBeltEntity): number {
  return belt.transitQueue.length;
}

/**
 * Compute the center-to-center tile distance from `entry` to `exit` if they
 * form a valid underground belt pair (matching direction, input -> output,
 * aligned along `entry.direction`, distance in `1..UNDERGROUND_MAX_DISTANCE`).
 * Returns `null` if they cannot be paired.
 */
export function getUndergroundDistance(
  entry: UndergroundBeltEntity,
  exit: UndergroundBeltEntity
): number | null {
  if (entry.id === exit.id) return null;
  if (entry.mode !== 'input' || exit.mode !== 'output') return null;
  if (entry.direction !== exit.direction) return null;

  const vec = DIRECTION_VECTORS[entry.direction];
  const dx = exit.position.x - entry.position.x;
  const dy = exit.position.y - entry.position.y;

  // Must be strictly aligned along the belt's forward axis.
  if (vec.x === 0) {
    if (dx !== 0) return null;
    const dist = dy * vec.y;
    if (!Number.isInteger(dist) || dist < 1 || dist > UNDERGROUND_MAX_DISTANCE) {
      return null;
    }
    return dist;
  } else {
    if (dy !== 0) return null;
    const dist = dx * vec.x;
    if (!Number.isInteger(dist) || dist < 1 || dist > UNDERGROUND_MAX_DISTANCE) {
      return null;
    }
    return dist;
  }
}

/**
 * Compute the transit duration in ticks for a given tile distance and belt speed.
 * At default BELT_SPEED (0.03125 = 1/32 tile/tick), 1 tile = 32 ticks.
 */
export function computeTransitTicks(
  distanceTiles: number,
  speed: number = BELT_SPEED
): number {
  validatePositiveFinite(speed, 'speed');
  if (
    !Number.isInteger(distanceTiles) ||
    distanceTiles < 1 ||
    distanceTiles > UNDERGROUND_MAX_DISTANCE
  ) {
    throw new SimulationError(
      'INVALID_UNDERGROUND_DISTANCE',
      `Underground distance must be an integer in [1, ${UNDERGROUND_MAX_DISTANCE}], received ${distanceTiles}.`
    );
  }
  return Math.max(1, Math.round(distanceTiles / speed));
}

/**
 * Compute minimum tick spacing between consecutive items on the same lane.
 * At default BELT_SPEED (1/32) and BELT_ITEM_SPACING (1/4), this is 8 ticks.
 */
export function computeLaneTickSpacing(
  speed: number = BELT_SPEED,
  spacing: number = BELT_ITEM_SPACING
): number {
  validatePositiveFinite(speed, 'speed');
  validatePositiveFinite(spacing, 'spacing');
  return Math.max(1, Math.round(spacing / speed));
}

/**
 * Explicitly pair an input underground belt with an output underground belt.
 * Fail-closed: throws SimulationError if the pair is invalid or out of range.
 * Returns the center-to-center tile distance.
 */
export function pairUndergroundBelts(
  entry: UndergroundBeltEntity,
  exit: UndergroundBeltEntity
): number {
  const distance = getUndergroundDistance(entry, exit);
  if (distance === null) {
    throw new SimulationError(
      'INVALID_UNDERGROUND_PAIR',
      `Cannot pair underground belt ${entry.id} (${entry.mode}, ${entry.direction} at ${entry.position.x},${entry.position.y}) with ${exit.id} (${exit.mode}, ${exit.direction} at ${exit.position.x},${exit.position.y}).`
    );
  }
  entry.pairedEntityId = exit.id;
  exit.pairedEntityId = entry.id;
  return distance;
}

/**
 * Unpair an underground belt and clear its partner's back-reference if present.
 */
export function unpairUndergroundBelt(
  belt: UndergroundBeltEntity,
  entities: Readonly<Record<EntityId, Entity>>
): void {
  const partnerId = belt.pairedEntityId;
  belt.pairedEntityId = null;
  if (partnerId !== null) {
    const partner = entities[partnerId];
    if (
      partner &&
      partner.type === 'underground_belt' &&
      partner.pairedEntityId === belt.id
    ) {
      partner.pairedEntityId = null;
    }
  }
}

/**
 * Find the closest valid matching partner for `belt` within `UNDERGROUND_MAX_DISTANCE`.
 * Stops scanning if an intervening same-direction underground belt of the same mode
 * is encountered (preventing overlapping segments from crossing).
 */
export function findMatchingUndergroundPair(
  belt: UndergroundBeltEntity,
  entities: Readonly<Record<EntityId, Entity>>
): UndergroundBeltEntity | null {
  const scanDir =
    belt.mode === 'input' ? belt.direction : oppositeDirection(belt.direction);

  // Build quick lookup by coordinate for underground belts.
  const byCoord = new Map<string, UndergroundBeltEntity>();
  for (const entity of Object.values(entities)) {
    if (entity.type === 'underground_belt' && entity.id !== belt.id) {
      byCoord.set(`${entity.position.x},${entity.position.y}`, entity);
    }
  }

  for (let dist = 1; dist <= UNDERGROUND_MAX_DISTANCE; dist++) {
    const coord = stepCoord(belt.position, scanDir, dist);
    const candidate = byCoord.get(`${coord.x},${coord.y}`);
    if (!candidate) continue;
    if (candidate.direction !== belt.direction) continue;

    if (candidate.mode === belt.mode) {
      // Another belt of the same mode and direction blocks further pairing.
      return null;
    }
    return candidate;
  }

  return null;
}

/**
 * Deterministically reconcile all underground belt pairings in an entity map.
 * Clears stale/invalid links and pairs unpaired inputs with their closest valid
 * unpaired output in ascending entity ID order.
 */
export function reconcileUndergroundPairs(
  entities: Record<EntityId, Entity>
): void {
  const undergrounds: UndergroundBeltEntity[] = [];
  for (const entity of Object.values(entities)) {
    if (entity.type === 'underground_belt') {
      undergrounds.push(entity);
    }
  }
  undergrounds.sort((a, b) => a.id - b.id);

  // 1. Clear stale or invalid existing pairs.
  for (const belt of undergrounds) {
    if (belt.pairedEntityId === null) continue;
    const partner = entities[belt.pairedEntityId];
    if (!partner || partner.type !== 'underground_belt') {
      belt.pairedEntityId = null;
      continue;
    }
    const valid =
      belt.mode === 'input'
        ? getUndergroundDistance(belt, partner) !== null &&
          partner.pairedEntityId === belt.id
        : getUndergroundDistance(partner, belt) !== null &&
          partner.pairedEntityId === belt.id;
    if (!valid) {
      belt.pairedEntityId = null;
    }
  }

  // 2. Pair unpaired inputs with their closest unpaired output.
  for (const belt of undergrounds) {
    if (belt.mode !== 'input' || belt.pairedEntityId !== null) continue;
    const partner = findMatchingUndergroundPair(belt, entities);
    if (partner && partner.pairedEntityId === null) {
      pairUndergroundBelts(belt, partner);
    }
  }
}

/**
 * Check whether an item can enter `entry` on `lane` given its paired `exit`.
 * Enforces pairing validity, per-lane capacity, and minimum tick spacing.
 */
export function canInsertIntoUndergroundBelt(
  entry: UndergroundBeltEntity,
  exit: UndergroundBeltEntity | null,
  lane: BeltLaneSide,
  options: UndergroundBeltOptions = {}
): boolean {
  if (!exit || entry.pairedEntityId !== exit.id) return false;
  const distance = getUndergroundDistance(entry, exit);
  if (distance === null) return false;

  const speed = options.speed ?? BELT_SPEED;
  const spacing = options.spacing ?? BELT_ITEM_SPACING;
  const transitTicks = computeTransitTicks(distance, speed);
  const minTickSpacing = computeLaneTickSpacing(speed, spacing);
  const maxLaneCapacity = Math.max(1, Math.floor(distance / spacing));

  let laneCount = 0;
  for (let i = 0; i < entry.transitQueue.length; i++) {
    const item = entry.transitQueue[i]!;
    if (item.lane !== lane) continue;
    laneCount += 1;
    if (item.remainingTicks > transitTicks - minTickSpacing) {
      return false;
    }
  }

  return laneCount < maxLaneCapacity;
}

/**
 * Insert an item into the input underground belt on the specified lane.
 * Fail-closed: throws UnknownItemError if `itemId` is invalid.
 * Returns `true` if accepted, or `false` if unpaired or blocked by backpressure.
 */
export function insertIntoUndergroundBelt(
  entry: UndergroundBeltEntity,
  exit: UndergroundBeltEntity | null,
  itemId: ItemId,
  lane: BeltLaneSide,
  options: UndergroundBeltOptions = {}
): boolean {
  assertValidItemId(itemId);

  if (!canInsertIntoUndergroundBelt(entry, exit, lane, options)) {
    return false;
  }

  const distance = getUndergroundDistance(entry, exit!)!;
  const speed = options.speed ?? BELT_SPEED;
  const transitTicks = computeTransitTicks(distance, speed);

  const transitItem: UndergroundBeltItem = {
    itemId,
    remainingTicks: transitTicks,
    lane,
  };
  entry.transitQueue.push(transitItem);
  entry.active = true;
  if (exit) {
    exit.active = true;
  }
  return true;
}

/**
 * Advance all items in transit inside `entry` by one tick and attempt to hand
 * off arrived items (`remainingTicks === 0`) through `exit` via `options.handoff`.
 *
 * Strict conservation: items are only removed from `transitQueue` when
 * `handoff` returns `true`. Under backpressure, arrived items halt at
 * `remainingTicks = 0` and trailing items on the same lane queue behind them
 * at `minTickSpacing` intervals.
 */
export function advanceUndergroundBelt(
  entry: UndergroundBeltEntity,
  exit: UndergroundBeltEntity | null,
  options: UndergroundAdvanceOptions = {}
): UndergroundAdvanceResult {
  const speed = options.speed ?? BELT_SPEED;
  const spacing = options.spacing ?? BELT_ITEM_SPACING;
  const minTickSpacing = computeLaneTickSpacing(speed, spacing);
  const handoff = options.handoff;

  let exited = 0;
  let blocked = 0;

  if (entry.mode !== 'input' || entry.transitQueue.length === 0) {
    entry.active = entry.transitQueue.length > 0;
    if (exit) {
      exit.active = entry.active;
    }
    return { exited: 0, inTransit: entry.transitQueue.length, blocked: 0 };
  }

  const isPaired =
    exit !== null &&
    entry.pairedEntityId === exit.id &&
    getUndergroundDistance(entry, exit) !== null;

  // Process each lane independently in FIFO order (left then right).
  const sides: readonly BeltLaneSide[] = ['left', 'right'];
  const toRemove = new Set<UndergroundBeltItem>();

  for (const side of sides) {
    let prevRemaining: number | null = null;

    for (let i = 0; i < entry.transitQueue.length; i++) {
      const item = entry.transitQueue[i]!;
      if (item.lane !== side) continue;

      const minAllowed: number = prevRemaining === null ? 0 : prevRemaining + minTickSpacing;

      if (item.remainingTicks > minAllowed) {
        item.remainingTicks = Math.max(minAllowed, item.remainingTicks - 1);
      }

      if (prevRemaining === null && item.remainingTicks === 0) {
        if (isPaired && handoff && handoff(item.itemId, side, 0)) {
          toRemove.add(item);
          exited += 1;
          // Front item exited; next item on this lane becomes the new front.
          continue;
        } else {
          blocked += 1;
          prevRemaining = 0;
        }
      } else {
        if (item.remainingTicks === minAllowed && prevRemaining !== null) {
          blocked += 1;
        }
        prevRemaining = item.remainingTicks;
      }
    }
  }

  if (toRemove.size > 0) {
    entry.transitQueue = entry.transitQueue.filter((item) => !toRemove.has(item));
  }

  const inTransit = entry.transitQueue.length;
  entry.active = inTransit > 0 || exited > 0;
  if (exit) {
    exit.active = entry.active;
  }

  return { exited, inTransit, blocked };
}
