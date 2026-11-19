/**
 * Ironworks-16 Conveyor Belt Network (T12)
 *
 * Implements auto-curved corners, sideloading merges, and seamless cross-tile
 * item handoff across connected conveyor belts with strict backpressure and
 * 100% item conservation.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type BeltEntity,
  type BeltShape,
  type Direction,
  type Entity,
  type EntityId,
  type ItemId,
  type TileCoord,
  type WorldState,
  isWithinBounds,
  oppositeDirection,
  rotateDirection,
  stepCoord,
} from '../types/contracts.js';
import {
  BELT_ITEM_SPACING,
  BELT_MAX_OFFSET,
  BELT_MIN_OFFSET,
  BELT_SPEED,
  type BeltLaneSide,
  advanceBelt,
  countBeltItems,
  insertOnBelt,
} from './belt.js';

/**
 * Normalized entry offset when a belt sideloads into the side of a straight belt.
 * 0.5 is an exact IEEE-754 power of 2 and aligns with the center of the target tile.
 */
export const SIDELOAD_ENTRY_OFFSET = 0.5;

export type BeltHandoffTarget =
  | {
      readonly kind: 'straight' | 'curve' | 'sideload';
      readonly target: BeltEntity;
      readonly targetLane: BeltLaneSide;
      readonly entryOffset: number;
    }
  | {
      readonly kind: 'blocked';
    };

/**
 * Optional callback invoked when a belt's front tile does not contain a
 * `transport_belt` (e.g. a splitter, underground belt, or chest).
 * Must return `true` if the external entity accepted the item.
 */
export type ExternalHandoffFn = (
  sourceBelt: BeltEntity,
  targetCoord: TileCoord,
  itemId: ItemId,
  lane: BeltLaneSide,
  overflowOffset: number
) => boolean;

export interface BeltNetworkStepOptions {
  speed?: number;
  spacing?: number;
  externalHandoff?: ExternalHandoffFn;
}

export interface BeltNetworkStepResult {
  beltsUpdated: number;
  handedOff: number;
  moved: number;
  blocked: number;
}

/**
 * Return the entity occupying `coord` in `world`, or `null` if out of bounds
 * or unoccupied.
 */
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

/**
 * Return the `BeltEntity` at `coord` in `world`, or `null` if out of bounds,
 * unoccupied, or occupied by a non-belt entity.
 */
export function getBeltAt(world: WorldState, coord: TileCoord): BeltEntity | null {
  const entity = getEntityAtCoord(world, coord);
  if (!entity || entity.type !== 'transport_belt') {
    return null;
  }
  return entity;
}

/**
 * Check whether the entity at `neighborCoord` feeds items in `requiredDirection`
 * (i.e. into the adjacent belt tile).
 */
function isFeederFacing(
  world: WorldState,
  neighborCoord: TileCoord,
  requiredDirection: Direction
): boolean {
  const entity = getEntityAtCoord(world, neighborCoord);
  if (!entity) {
    return false;
  }
  if (entity.type === 'transport_belt') {
    return entity.direction === requiredDirection;
  }
  if (entity.type === 'underground_belt' && entity.mode === 'output') {
    return entity.direction === requiredDirection;
  }
  return false;
}

/**
 * Compute the auto-curved `BeltShape` for `belt` based on its adjacent feeders:
 * - If a feeder enters from behind -> `'straight'`.
 * - If feeders enter from both left and right -> `'straight'`.
 * - If a feeder enters only from the left side -> `'curve_left'`.
 * - If a feeder enters only from the right side -> `'curve_right'`.
 * - Otherwise (no feeders) -> `'straight'`.
 */
export function computeBeltShape(world: WorldState, belt: BeltEntity): BeltShape {
  const dir = belt.direction;
  const backDir = oppositeDirection(dir);
  const leftDir = rotateDirection(dir, -1);
  const rightDir = rotateDirection(dir, 1);

  const hasBackFeeder = isFeederFacing(world, stepCoord(belt.position, backDir), dir);
  if (hasBackFeeder) {
    return 'straight';
  }

  // A feeder on the belt's left side must face rightDir (towards belt.position).
  const hasLeftFeeder = isFeederFacing(world, stepCoord(belt.position, leftDir), rightDir);
  // A feeder on the belt's right side must face leftDir (towards belt.position).
  const hasRightFeeder = isFeederFacing(world, stepCoord(belt.position, rightDir), leftDir);

  if (hasLeftFeeder && !hasRightFeeder) {
    return 'curve_left';
  }
  if (hasRightFeeder && !hasLeftFeeder) {
    return 'curve_right';
  }
  return 'straight';
}

/**
 * Recompute and assign `belt.shape` based on its current neighbors in `world`.
 */
export function updateBeltShape(world: WorldState, belt: BeltEntity): BeltShape {
  const shape = computeBeltShape(world, belt);
  belt.shape = shape;
  return shape;
}

/**
 * Update `shape` for the belt at `coord` (if any) and all 4 orthogonal
 * neighbor belts. Call after placing, rotating, or removing a belt.
 */
export function updateBeltShapesAround(world: WorldState, coord: TileCoord): void {
  const coords: TileCoord[] = [
    coord,
    stepCoord(coord, 'N'),
    stepCoord(coord, 'E'),
    stepCoord(coord, 'S'),
    stepCoord(coord, 'W'),
  ];

  for (let i = 0; i < coords.length; i++) {
    const belt = getBeltAt(world, coords[i]!);
    if (belt) {
      updateBeltShape(world, belt);
    }
  }
}

/**
 * Recompute `shape` for every `transport_belt` in `world` in deterministic
 * ascending `EntityId` order.
 */
export function updateAllBeltShapes(world: WorldState): void {
  const belts = getSortedBelts(world);
  for (let i = 0; i < belts.length; i++) {
    updateBeltShape(world, belts[i]!);
  }
}

/**
 * Clamp a handoff entry offset to `[BELT_MIN_OFFSET, BELT_MAX_OFFSET]`.
 */
function clampOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset < BELT_MIN_OFFSET) {
    return BELT_MIN_OFFSET;
  }
  if (offset > BELT_MAX_OFFSET) {
    return BELT_MAX_OFFSET;
  }
  return offset;
}

/**
 * Resolve how an item leaving `source` on `sourceLane` should hand off onto
 * `target` (which is located at `stepCoord(source.position, source.direction)`).
 *
 * - Same direction: straight handoff preserving lane at `overflowOffset`.
 * - Opposite direction: head-on collision -> `'blocked'`.
 * - Perpendicular into a matching curved corner (`curve_left` / `curve_right`):
 *   seamless corner handoff preserving lane at `overflowOffset`.
 * - Perpendicular into a `'straight'` (or non-matching) belt:
 *   sideloading merge onto the near lane (`'left'` if entering from target's left,
 *   `'right'` if entering from target's right) at `SIDELOAD_ENTRY_OFFSET`.
 */
export function resolveBeltHandoff(
  source: BeltEntity,
  target: BeltEntity,
  sourceLane: BeltLaneSide,
  overflowOffset: number = 0
): BeltHandoffTarget {
  const srcDir = source.direction;
  const dstDir = target.direction;

  if (srcDir === dstDir) {
    return {
      kind: 'straight',
      target,
      targetLane: sourceLane,
      entryOffset: clampOffset(overflowOffset),
    };
  }

  if (srcDir === oppositeDirection(dstDir)) {
    return { kind: 'blocked' };
  }

  // Entering from target's left side: source faces rotateDirection(dstDir, 1).
  const enteringFromLeft = srcDir === rotateDirection(dstDir, 1);
  // Entering from target's right side: source faces rotateDirection(dstDir, -1).
  const enteringFromRight = srcDir === rotateDirection(dstDir, -1);

  if (enteringFromLeft) {
    if (target.shape === 'curve_left') {
      return {
        kind: 'curve',
        target,
        targetLane: sourceLane,
        entryOffset: clampOffset(overflowOffset),
      };
    }
    return {
      kind: 'sideload',
      target,
      targetLane: 'left',
      entryOffset: clampOffset(SIDELOAD_ENTRY_OFFSET + overflowOffset),
    };
  }

  if (enteringFromRight) {
    if (target.shape === 'curve_right') {
      return {
        kind: 'curve',
        target,
        targetLane: sourceLane,
        entryOffset: clampOffset(overflowOffset),
      };
    }
    return {
      kind: 'sideload',
      target,
      targetLane: 'right',
      entryOffset: clampOffset(SIDELOAD_ENTRY_OFFSET + overflowOffset),
    };
  }

  return { kind: 'blocked' };
}

/** Return all transport belts in `world` sorted by ascending `id`. */
function getSortedBelts(world: WorldState): BeltEntity[] {
  const belts: BeltEntity[] = [];
  const entities = world.entities;
  for (const key in entities) {
    const entity = entities[key];
    if (entity && entity.type === 'transport_belt') {
      belts.push(entity);
    }
  }
  belts.sort((a, b) => a.id - b.id);
  return belts;
}

/**
 * Compute a deterministic downstream-first topological update order for all
 * belts in `world`.
 *
 * Processing downstream belts before upstream belts ensures:
 * 1. An item handed off to a downstream belt does not move twice in the same tick.
 * 2. Full-but-moving chains advance without artificial 1-tick stalls.
 * 3. Belt cycles (loops) are broken deterministically by ascending `EntityId`.
 */
export function getBeltUpdateOrder(world: WorldState): BeltEntity[] {
  const belts = getSortedBelts(world);
  const visited = new Set<EntityId>();
  const visiting = new Set<EntityId>();
  const order: BeltEntity[] = [];

  const visit = (belt: BeltEntity): void => {
    if (visited.has(belt.id) || visiting.has(belt.id)) {
      return;
    }
    visiting.add(belt.id);

    const frontCoord = stepCoord(belt.position, belt.direction);
    const downstream = getBeltAt(world, frontCoord);
    // Avoid following head-on opposing belts as downstream dependencies.
    if (downstream && downstream.direction !== oppositeDirection(belt.direction)) {
      visit(downstream);
    }

    visiting.delete(belt.id);
    visited.add(belt.id);
    order.push(belt);
  };

  for (let i = 0; i < belts.length; i++) {
    visit(belts[i]!);
  }

  return order;
}

/**
 * Advance all belts in `world` by one simulation tick in deterministic
 * downstream-first order, handling straight handoffs, auto-curved corners,
 * sideloading merges, and optional external handoffs.
 */
export function stepBeltNetwork(
  world: WorldState,
  options: BeltNetworkStepOptions = {}
): BeltNetworkStepResult {
  const speed = options.speed ?? BELT_SPEED;
  const spacing = options.spacing ?? BELT_ITEM_SPACING;
  const externalHandoff = options.externalHandoff;

  const orderedBelts = getBeltUpdateOrder(world);

  let handedOff = 0;
  let moved = 0;
  let blocked = 0;

  for (let i = 0; i < orderedBelts.length; i++) {
    const belt = orderedBelts[i]!;
    const frontCoord = stepCoord(belt.position, belt.direction);
    const targetBelt = getBeltAt(world, frontCoord);

    const result = advanceBelt(belt, {
      speed,
      spacing,
      handoff: (itemId, lane, overflowOffset) => {
        if (targetBelt) {
          const resolution = resolveBeltHandoff(belt, targetBelt, lane, overflowOffset);
          if (resolution.kind === 'blocked') {
            return false;
          }
          return insertOnBelt(
            resolution.target,
            resolution.targetLane,
            itemId,
            resolution.entryOffset,
            spacing
          );
        }
        if (externalHandoff) {
          return externalHandoff(belt, frontCoord, itemId, lane, overflowOffset);
        }
        return false;
      },
    });

    handedOff += result.handedOff;
    moved += result.moved;
    blocked += result.blocked;
  }

  return {
    beltsUpdated: orderedBelts.length,
    handedOff,
    moved,
    blocked,
  };
}

/**
 * Count the total number of items currently on all `transport_belt` entities
 * in `world`.
 */
export function countAllBeltItems(world: WorldState): number {
  let total = 0;
  const entities = world.entities;
  for (const key in entities) {
    const entity = entities[key];
    if (entity && entity.type === 'transport_belt') {
      total += countBeltItems(entity);
    }
  }
  return total;
}
