/**
 * Ironworks-16 Two-Lane Conveyor Belt (T11)
 *
 * Implements a deterministic two-lane conveyor belt with fixed item spacing
 * and strict backpressure blocking (zero item loss, zero duplication).
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type BeltEntity,
  type BeltLane,
  type BeltLaneItem,
  type BeltShape,
  type Direction,
  type EntityId,
  type ItemId,
  type TileCoord,
  SimulationError,
} from '../types/contracts.js';
import { assertValidItemId } from '../core/itemRegistry.js';

export type BeltLaneSide = 'left' | 'right';

/**
 * Normalized belt speed in tile-lengths per tick (at 60 ticks/sec).
 * 1/32 = 0.03125 tiles/tick = 1.875 tiles/sec (exact IEEE-754 power of 2).
 */
export const BELT_SPEED = 0.03125;

/**
 * Minimum normalized center-to-center spacing between items on the same lane.
 * 1/4 = 0.25 tile-lengths (exact IEEE-754 power of 2).
 */
export const BELT_ITEM_SPACING = 0.25;

export const BELT_MIN_OFFSET = 0;
export const BELT_MAX_OFFSET = 1;

/**
 * Callback invoked when the front-most item on a lane reaches or crosses
 * `BELT_MAX_OFFSET` (1.0). Must return `true` if the downstream receiver
 * accepted the item (taking ownership), or `false` to apply backpressure.
 */
export type LaneHandoffFn = (
  itemId: ItemId,
  lane: BeltLaneSide,
  overflowOffset: number
) => boolean;

export interface BeltAdvanceOptions {
  speed?: number;
  spacing?: number;
  handoff?: LaneHandoffFn;
}

export interface BeltAdvanceResult {
  handedOff: number;
  moved: number;
  blocked: number;
}

/** Create an empty belt lane. */
export function createBeltLane(): BeltLane {
  return { items: [] };
}

/** Create a new two-lane BeltEntity with empty lanes. */
export function createBeltEntity(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'E',
  shape: BeltShape = 'straight'
): BeltEntity {
  return {
    id,
    type: 'transport_belt',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    shape,
    leftLane: createBeltLane(),
    rightLane: createBeltLane(),
  };
}

/** Return the requested lane of a belt entity. */
export function getBeltLane(belt: BeltEntity, side: BeltLaneSide): BeltLane {
  return side === 'left' ? belt.leftLane : belt.rightLane;
}

/** Count items on a single belt lane. */
export function countLaneItems(lane: BeltLane): number {
  return lane.items.length;
}

/** Count total items across both lanes of a belt entity. */
export function countBeltItems(belt: BeltEntity): number {
  return belt.leftLane.items.length + belt.rightLane.items.length;
}

function validatePositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SimulationError(
      'INVALID_BELT_PARAMETER',
      `${name} must be a finite positive number, received ${value}.`
    );
  }
}

/**
 * Check whether an item can be inserted at `offset` on `lane` without
 * violating minimum `spacing` against any existing item on that lane.
 */
export function canInsertOnLane(
  lane: BeltLane,
  offset: number = BELT_MIN_OFFSET,
  spacing: number = BELT_ITEM_SPACING
): boolean {
  if (!Number.isFinite(offset) || offset < BELT_MIN_OFFSET || offset > BELT_MAX_OFFSET) {
    return false;
  }
  validatePositiveFinite(spacing, 'spacing');

  for (let i = 0; i < lane.items.length; i++) {
    const existing = lane.items[i]!;
    if (Math.abs(existing.offset - offset) < spacing) {
      return false;
    }
  }
  return true;
}

/**
 * Insert an item onto `lane` at `offset`, maintaining descending `offset` order
 * (index 0 = front-most item closest to exit 1.0).
 *
 * Fail-closed: throws `UnknownItemError` if `itemId` is not in the item registry.
 * Returns `true` if inserted, or `false` if blocked by spacing or invalid offset.
 */
export function insertOnLane(
  lane: BeltLane,
  itemId: ItemId,
  offset: number = BELT_MIN_OFFSET,
  spacing: number = BELT_ITEM_SPACING
): boolean {
  assertValidItemId(itemId);

  if (!canInsertOnLane(lane, offset, spacing)) {
    return false;
  }

  const newItem: BeltLaneItem = { itemId, offset };

  // Insert in descending offset order (front-most first).
  let insertIdx = lane.items.length;
  for (let i = 0; i < lane.items.length; i++) {
    if (offset > lane.items[i]!.offset) {
      insertIdx = i;
      break;
    }
  }
  lane.items.splice(insertIdx, 0, newItem);
  return true;
}

/**
 * Insert an item onto the specified lane of a belt entity.
 * Returns `true` if inserted, `false` if blocked.
 */
export function insertOnBelt(
  belt: BeltEntity,
  side: BeltLaneSide,
  itemId: ItemId,
  offset: number = BELT_MIN_OFFSET,
  spacing: number = BELT_ITEM_SPACING
): boolean {
  const inserted = insertOnLane(getBeltLane(belt, side), itemId, offset, spacing);
  if (inserted) {
    belt.active = true;
  }
  return inserted;
}

/** Peek at the front-most item (largest offset) on a lane without removing it. */
export function peekFrontItem(lane: BeltLane): BeltLaneItem | null {
  return lane.items.length > 0 ? lane.items[0]! : null;
}

/**
 * Remove and return the front-most item on `lane` if its offset is at least
 * `minOffset` (default 0). Returns `null` if no qualifying item exists.
 */
export function takeFrontItem(
  lane: BeltLane,
  minOffset: number = BELT_MIN_OFFSET
): ItemId | null {
  if (lane.items.length === 0) {
    return null;
  }
  const front = lane.items[0]!;
  if (front.offset < minOffset) {
    return null;
  }
  lane.items.shift();
  return front.itemId;
}

/**
 * Remove and return the front-most item on `lane` matching `predicate`
 * (or the front-most item if `predicate` is omitted).
 */
export function takeItemFromLane(
  lane: BeltLane,
  predicate?: (item: BeltLaneItem) => boolean
): ItemId | null {
  for (let i = 0; i < lane.items.length; i++) {
    const item = lane.items[i]!;
    if (!predicate || predicate(item)) {
      lane.items.splice(i, 1);
      return item.itemId;
    }
  }
  return null;
}

/**
 * Deterministically remove and return the front-most matching item across both
 * lanes of a belt. Ties in offset are broken by preferring `'left'` over `'right'`.
 */
export function takeItemFromBelt(
  belt: BeltEntity,
  predicate?: (item: BeltLaneItem, side: BeltLaneSide) => boolean
): ItemId | null {
  let bestSide: BeltLaneSide | null = null;
  let bestIndex = -1;
  let bestOffset = -1;

  const sides: readonly BeltLaneSide[] = ['left', 'right'];
  for (const side of sides) {
    const lane = getBeltLane(belt, side);
    for (let i = 0; i < lane.items.length; i++) {
      const item = lane.items[i]!;
      if (!predicate || predicate(item, side)) {
        if (item.offset > bestOffset) {
          bestOffset = item.offset;
          bestSide = side;
          bestIndex = i;
        }
        // Lane is sorted descending, so the first match on this lane is its front-most.
        break;
      }
    }
  }

  if (bestSide === null || bestIndex < 0) {
    return null;
  }

  const chosenLane = getBeltLane(belt, bestSide);
  const [removed] = chosenLane.items.splice(bestIndex, 1);
  belt.active = countBeltItems(belt) > 0;
  return removed ? removed.itemId : null;
}

/**
 * Advance all items on a single belt lane by `speed` ticks, enforcing fixed
 * `spacing` and strict backpressure blocking.
 *
 * Items are processed front-to-back (descending offset). When the front-most
 * item reaches `>= BELT_MAX_OFFSET`, `handoff` is invoked if provided:
 * - If `handoff` returns `true`, the item is removed from this lane.
 * - If `handoff` returns `false` or is omitted, the item halts at `1.0`
 *   and all trailing items queue behind it at exact `spacing` intervals.
 */
export function advanceLane(
  lane: BeltLane,
  side: BeltLaneSide,
  options: BeltAdvanceOptions = {}
): BeltAdvanceResult {
  const speed = options.speed ?? BELT_SPEED;
  const spacing = options.spacing ?? BELT_ITEM_SPACING;
  const handoff = options.handoff;

  validatePositiveFinite(speed, 'speed');
  validatePositiveFinite(spacing, 'spacing');

  let handedOff = 0;
  let moved = 0;
  let blocked = 0;

  if (lane.items.length === 0) {
    return { handedOff, moved, blocked };
  }

  // Ensure descending order defensively in case external state was mutated.
  for (let i = 1; i < lane.items.length; i++) {
    if (lane.items[i]!.offset > lane.items[i - 1]!.offset) {
      lane.items.sort((a, b) => b.offset - a.offset);
      break;
    }
  }

  let idx = 0;
  while (idx < lane.items.length) {
    const item = lane.items[idx]!;
    const target = item.offset + speed;

    if (idx === 0) {
      // Front-most item on this lane.
      if (target >= BELT_MAX_OFFSET) {
        if (handoff) {
          const overflow = target - BELT_MAX_OFFSET;
          const accepted = handoff(item.itemId, side, overflow);
          if (accepted) {
            lane.items.splice(0, 1);
            handedOff += 1;
            // Next item is now at idx === 0; continue without incrementing idx.
            continue;
          }
        }
        // Backpressure: halt at BELT_MAX_OFFSET.
        if (item.offset < BELT_MAX_OFFSET) {
          item.offset = BELT_MAX_OFFSET;
          moved += 1;
        } else {
          blocked += 1;
        }
      } else {
        item.offset = target;
        moved += 1;
      }
    } else {
      // Trailing item bounded by the item immediately ahead of it.
      const ahead = lane.items[idx - 1]!;
      const maxAllowed = ahead.offset - spacing;
      const nextOffset = Math.min(target, maxAllowed);
      if (nextOffset > item.offset) {
        item.offset = nextOffset;
        moved += 1;
      } else {
        blocked += 1;
      }
    }

    idx += 1;
  }

  return { handedOff, moved, blocked };
}

/**
 * Advance both lanes (`left` then `right`) of a BeltEntity by one tick.
 * Updates `belt.active` and returns aggregated movement/handoff counts.
 */
export function advanceBelt(
  belt: BeltEntity,
  options: BeltAdvanceOptions = {}
): BeltAdvanceResult {
  const leftResult = advanceLane(belt.leftLane, 'left', options);
  const rightResult = advanceLane(belt.rightLane, 'right', options);

  const handedOff = leftResult.handedOff + rightResult.handedOff;
  const moved = leftResult.moved + rightResult.moved;
  const blocked = leftResult.blocked + rightResult.blocked;

  belt.active = countBeltItems(belt) > 0 || handedOff > 0;

  return { handedOff, moved, blocked };
}
