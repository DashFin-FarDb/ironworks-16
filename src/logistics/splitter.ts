/**
 * Ironworks-16 2-Tile-Wide 50/50 Alternating Splitter (T13)
 *
 * Implements a deterministic 2-tile-wide 50/50 alternating splitter that
 * preserves strict item conservation when one or both output lanes are blocked.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type BeltEntity,
  type Direction,
  type EntityFootprint,
  type EntityId,
  type ItemId,
  type SplitterEntity,
  type TileCoord,
  oppositeDirection,
  stepCoord,
} from '../types/contracts.js';
import {
  BELT_ITEM_SPACING,
  BELT_MAX_OFFSET,
  BELT_MIN_OFFSET,
  BELT_SPEED,
  type BeltLaneSide,
  advanceLane,
  createBeltLane,
  insertOnBelt,
  insertOnLane,
} from './belt.js';

export type SplitterOutputIndex = 0 | 1;

/**
 * Callback invoked when an item exits the splitter toward `outputIndex` (0 or 1).
 * Must return `true` if the downstream receiver accepted the item, or `false`
 * to signal backpressure on that output.
 */
export type SplitterOutputFn = (
  outputIndex: SplitterOutputIndex,
  itemId: ItemId,
  lane: BeltLaneSide,
  overflowOffset: number
) => boolean;

export interface SplitterAdvanceOptions {
  speed?: number;
  spacing?: number;
  handoff?: SplitterOutputFn;
}

export interface SplitterAdvanceResult {
  handedOff: number;
  handedOffByOutput: [number, number];
  moved: number;
  blocked: number;
}

/**
 * Return the 2-tile-wide footprint of a splitter based on its facing direction:
 * - `'N'` / `'S'` flow vertically, so width is 2 and height is 1.
 * - `'E'` / `'W'` flow horizontally, so width is 1 and height is 2.
 */
export function getSplitterFootprint(direction: Direction): EntityFootprint {
  if (direction === 'E' || direction === 'W') {
    return { width: 1, height: 2 };
  }
  return { width: 2, height: 1 };
}

/** Create a new 2-tile-wide SplitterEntity with empty internal lanes. */
export function createSplitterEntity(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N'
): SplitterEntity {
  return {
    id,
    type: 'splitter',
    position: { x: position.x, y: position.y },
    direction,
    footprint: getSplitterFootprint(direction),
    powerNetworkId: null,
    active: false,
    nextOutputIndex: 0,
    leftLane: createBeltLane(),
    rightLane: createBeltLane(),
  };
}

/**
 * Return the two tile coordinates occupied by the splitter:
 * - Index 0: primary anchor tile `(x, y)`
 * - Index 1: secondary tile `(x + 1, y)` for `'N'|'S'`, or `(x, y + 1)` for `'E'|'W'`.
 */
export function getSplitterTiles(
  splitter: SplitterEntity
): readonly [TileCoord, TileCoord] {
  const { x, y } = splitter.position;
  if (splitter.direction === 'E' || splitter.direction === 'W') {
    return [
      { x, y },
      { x, y: y + 1 },
    ];
  }
  return [
    { x, y },
    { x: x + 1, y },
  ];
}

/** Return the two input tile coordinates immediately behind the splitter. */
export function getSplitterInputCoords(
  splitter: SplitterEntity
): readonly [TileCoord, TileCoord] {
  const [tile0, tile1] = getSplitterTiles(splitter);
  const backDir = oppositeDirection(splitter.direction);
  return [stepCoord(tile0, backDir), stepCoord(tile1, backDir)];
}

/** Return the two output tile coordinates immediately in front of the splitter. */
export function getSplitterOutputCoords(
  splitter: SplitterEntity
): readonly [TileCoord, TileCoord] {
  const [tile0, tile1] = getSplitterTiles(splitter);
  return [stepCoord(tile0, splitter.direction), stepCoord(tile1, splitter.direction)];
}

/** Count total items currently held inside both lanes of a splitter. */
export function countSplitterItems(splitter: SplitterEntity): number {
  return splitter.leftLane.items.length + splitter.rightLane.items.length;
}

/**
 * Insert an item onto the specified internal lane of a splitter.
 * Fail-closed: throws `UnknownItemError` if `itemId` is invalid.
 * Returns `true` if inserted, `false` if blocked by spacing or invalid offset.
 */
export function insertIntoSplitter(
  splitter: SplitterEntity,
  side: BeltLaneSide,
  itemId: ItemId,
  offset: number = BELT_MIN_OFFSET,
  spacing: number = BELT_ITEM_SPACING
): boolean {
  const lane = side === 'left' ? splitter.leftLane : splitter.rightLane;
  const inserted = insertOnLane(lane, itemId, offset, spacing);
  if (inserted) {
    splitter.active = true;
  }
  return inserted;
}

/**
 * Advance both internal lanes (`left` then `right`) of a splitter by one tick.
 *
 * Routing contract:
 * - Each exiting item first attempts `splitter.nextOutputIndex` (0 or 1).
 * - If accepted, `splitter.nextOutputIndex` toggles to the other output (50/50 alternation).
 * - If the preferred output is blocked, the splitter falls back to the alternate
 *   output without losing or duplicating the item, keeping `nextOutputIndex`
 *   pointed at the blocked output so it receives priority once unblocked.
 * - If both outputs are blocked (or `handoff` is omitted), the item halts at
 *   `BELT_MAX_OFFSET` (1.0) and trailing items queue cleanly under backpressure.
 */
export function advanceSplitter(
  splitter: SplitterEntity,
  options: SplitterAdvanceOptions = {}
): SplitterAdvanceResult {
  const speed = options.speed ?? BELT_SPEED;
  const spacing = options.spacing ?? BELT_ITEM_SPACING;
  const outputHandoff = options.handoff;

  const handedOffByOutput: [number, number] = [0, 0];

  const laneHandoff = outputHandoff
    ? (itemId: ItemId, lane: BeltLaneSide, overflowOffset: number): boolean => {
        const preferred: SplitterOutputIndex = splitter.nextOutputIndex;
        const alternate: SplitterOutputIndex = preferred === 0 ? 1 : 0;

        if (outputHandoff(preferred, itemId, lane, overflowOffset)) {
          splitter.nextOutputIndex = alternate;
          handedOffByOutput[preferred] += 1;
          return true;
        }

        if (outputHandoff(alternate, itemId, lane, overflowOffset)) {
          handedOffByOutput[alternate] += 1;
          return true;
        }

        return false;
      }
    : undefined;

  const leftResult = advanceLane(splitter.leftLane, 'left', {
    speed,
    spacing,
    handoff: laneHandoff,
  });
  const rightResult = advanceLane(splitter.rightLane, 'right', {
    speed,
    spacing,
    handoff: laneHandoff,
  });

  const handedOff = leftResult.handedOff + rightResult.handedOff;
  const moved = leftResult.moved + rightResult.moved;
  const blocked = leftResult.blocked + rightResult.blocked;

  splitter.active = countSplitterItems(splitter) > 0 || handedOff > 0;

  return {
    handedOff,
    handedOffByOutput,
    moved,
    blocked,
  };
}

/**
 * Convenience helper to advance a splitter directly into two optional output
 * `BeltEntity` targets `[output0, output1]`, preserving lane side and sub-tile
 * overflow offset while enforcing strict backpressure conservation.
 */
export function advanceSplitterToBelts(
  splitter: SplitterEntity,
  outputs: readonly [BeltEntity | null, BeltEntity | null],
  options: { speed?: number; spacing?: number } = {}
): SplitterAdvanceResult {
  const spacing = options.spacing ?? BELT_ITEM_SPACING;

  return advanceSplitter(splitter, {
    speed: options.speed,
    spacing,
    handoff: (outputIndex, itemId, lane, overflowOffset) => {
      const target = outputs[outputIndex];
      if (!target) {
        return false;
      }
      const clampedOffset = Math.min(
        Math.max(overflowOffset, BELT_MIN_OFFSET),
        BELT_MAX_OFFSET
      );
      return insertOnBelt(target, lane, itemId, clampedOffset, spacing);
    },
  });
}
