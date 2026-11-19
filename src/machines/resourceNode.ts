/**
 * Ironworks-16 Resource Node (T21)
 *
 * Finite ore deposits supporting mineOne() and clean depletion.
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 * Fail-closed: invalid resource types, negative/non-integer/NaN amounts,
 * and out-of-bounds tile queries throw typed SimulationError / OutOfBoundsError.
 */

import {
  EntityFootprint,
  ResourceNode,
  ResourceType,
  SimulationError,
  Tile,
  TileCoord,
  clamp,
} from '../types/contracts';
import { TileMap } from '../core/tilemap';

export const RESOURCE_TYPES: readonly ResourceType[] = [
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
] as const;

const RESOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(RESOURCE_TYPES);

export interface MineResult {
  readonly mined: boolean;
  readonly itemId: ResourceType | null;
  readonly remaining: number;
  readonly depleted: boolean;
}

const EMPTY_MINE_RESULT: MineResult = Object.freeze({
  mined: false,
  itemId: null,
  remaining: 0,
  depleted: true,
});

/** Type guard checking whether a value is a valid canonical ResourceType. */
export function isValidResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && RESOURCE_TYPE_SET.has(value);
}

/**
 * Fail-closed invariant check for a ResourceNode.
 * Ensures valid resource type and finite non-negative integer amounts.
 */
export function assertValidResourceNode(node: ResourceNode): void {
  if (!isValidResourceType(node.type)) {
    throw new SimulationError(
      'INVALID_RESOURCE_TYPE',
      `Unknown resource type: "${String(node.type)}".`
    );
  }
  if (!Number.isInteger(node.amount) || node.amount < 0) {
    throw new SimulationError(
      'INVALID_RESOURCE_AMOUNT',
      `Resource node amount must be a non-negative integer; received ${node.amount}.`
    );
  }
  if (!Number.isInteger(node.initialAmount) || node.initialAmount < 0) {
    throw new SimulationError(
      'INVALID_RESOURCE_AMOUNT',
      `Resource node initialAmount must be a non-negative integer; received ${node.initialAmount}.`
    );
  }
}

/**
 * Create a new finite ResourceNode deposit.
 * Fails closed if type is invalid or amount is not a positive integer.
 */
export function createResourceNode(type: ResourceType, amount: number): ResourceNode {
  if (!isValidResourceType(type)) {
    throw new SimulationError(
      'INVALID_RESOURCE_TYPE',
      `Unknown resource type: "${String(type)}".`
    );
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new SimulationError(
      'INVALID_RESOURCE_AMOUNT',
      `Initial resource amount must be a positive integer; received ${amount}.`
    );
  }
  return {
    type,
    amount,
    initialAmount: amount,
  };
}

/** Returns true if the resource node is absent or has 0 remaining ore. */
export function isDepleted(node: ResourceNode | null | undefined): boolean {
  if (node == null) {
    return true;
  }
  assertValidResourceNode(node);
  return node.amount === 0;
}

/** Returns remaining ore count (0 if absent). Fails closed on corrupted node state. */
export function getRemainingAmount(node: ResourceNode | null | undefined): number {
  if (node == null) {
    return 0;
  }
  assertValidResourceNode(node);
  return node.amount;
}

/**
 * Returns remaining fraction in [0, 1] (0 when absent, depleted, or initialAmount === 0).
 * Never returns NaN.
 */
export function getRemainingRatio(node: ResourceNode | null | undefined): number {
  if (node == null) {
    return 0;
  }
  assertValidResourceNode(node);
  if (node.initialAmount === 0 || node.amount === 0) {
    return 0;
  }
  return clamp(node.amount / node.initialAmount, 0, 1);
}

/**
 * Mine exactly 1 unit of ore from a finite ResourceNode.
 * - Decrements `node.amount` by 1 when `node.amount > 0`.
 * - Never decrements below 0.
 * - Returns `{ mined: false, itemId: null, remaining: 0, depleted: true }` when already depleted.
 */
export function mineOne(node: ResourceNode): MineResult {
  assertValidResourceNode(node);

  if (node.amount === 0) {
    return EMPTY_MINE_RESULT;
  }

  node.amount -= 1;
  const depleted = node.amount === 0;

  return {
    mined: true,
    itemId: node.type,
    remaining: node.amount,
    depleted,
  };
}

/**
 * Mine 1 unit of ore from a Tile's resource deposit.
 * Cleans up the tile (`tile.resource = null`) immediately upon depletion.
 */
export function mineOneFromTile(tile: Tile): MineResult {
  if (tile.resource === null) {
    return EMPTY_MINE_RESULT;
  }

  const result = mineOne(tile.resource);
  if (result.depleted) {
    tile.resource = null;
  }
  return result;
}

/**
 * Mine 1 unit of ore from the tile at `coord` in `tileMap`.
 * Fails closed with OutOfBoundsError if `coord` is outside the map bounds.
 * Cleans up `tile.resource = null` upon depletion.
 */
export function mineOneAt(tileMap: TileMap, coord: TileCoord): MineResult {
  const tile = tileMap.getTileAt(coord);
  return mineOneFromTile(tile);
}

/**
 * Deterministically mine 1 unit of ore from the first non-depleted tile
 * within a machine's footprint (row-major order: dy then dx).
 * Fails closed with OutOfBoundsError if any footprint tile is out of bounds.
 */
export function mineOneFromFootprint(
  tileMap: TileMap,
  origin: TileCoord,
  footprint: EntityFootprint = { width: 1, height: 1 }
): MineResult {
  if (
    !Number.isInteger(footprint.width) ||
    footprint.width <= 0 ||
    !Number.isInteger(footprint.height) ||
    footprint.height <= 0
  ) {
    throw new SimulationError(
      'INVALID_FOOTPRINT',
      `Footprint dimensions must be positive integers; received (${footprint.width}x${footprint.height}).`
    );
  }

  // Validate all footprint tiles are in bounds before mutating (fail-closed).
  const tiles: Tile[] = [];
  for (let dy = 0; dy < footprint.height; dy++) {
    for (let dx = 0; dx < footprint.width; dx++) {
      tiles.push(tileMap.getTile(origin.x + dx, origin.y + dy));
    }
  }

  for (const tile of tiles) {
    if (tile.resource !== null) {
      const result = mineOneFromTile(tile);
      if (result.mined) {
        return result;
      }
    }
  }

  return EMPTY_MINE_RESULT;
}
