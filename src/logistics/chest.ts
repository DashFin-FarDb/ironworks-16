/**
 * Ironworks-16 Storage Chests (T19)
 *
 * Implements Wooden (16-slot) and Iron (32-slot) storage chests backed by
 * T08 slot-based inventory and T06 canonical item stack sizes.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 * Fail-closed: unknown item IDs, invalid chest types, invalid coordinates,
 * and out-of-bounds slot indices throw typed SimulationErrors.
 */

import {
  canInsert,
  clearSlotFilter,
  createInventoryState,
  getFirstAvailableItem,
  getItemCount,
  getSlotFilter,
  getTotalItemCount,
  insertItem,
  isEmpty,
  isFull,
  removeItem,
  setSlotFilter,
  type StackSizeResolver,
} from '../core/inventory';
import { assertValidItemId, getStackSize } from '../core/itemRegistry';
import {
  DIRECTIONS,
  InvalidPlacementError,
  SimulationError,
  type ChestEntity,
  type Direction,
  type Entity,
  type EntityId,
  type ItemId,
  type ItemStack,
  type TileCoord,
} from '../types/contracts';

// ============================================================================
// Constants & Type Guards
// ============================================================================

export type ChestType = 'wooden_chest' | 'iron_chest';

export const WOODEN_CHEST_SLOTS = 16;
export const IRON_CHEST_SLOTS = 32;

export const CHEST_CAPACITIES: Readonly<Record<ChestType, number>> = Object.freeze({
  wooden_chest: WOODEN_CHEST_SLOTS,
  iron_chest: IRON_CHEST_SLOTS,
});

export function isChestType(type: string): type is ChestType {
  return type === 'wooden_chest' || type === 'iron_chest';
}

export function isChestEntity(entity: Entity): entity is ChestEntity {
  return entity.type === 'wooden_chest' || entity.type === 'iron_chest';
}

export function getChestCapacity(type: ChestType): number {
  if (!isChestType(type)) {
    throw new SimulationError(
      'INVALID_CHEST_TYPE',
      `Unknown chest type: "${String(type)}".`
    );
  }
  return CHEST_CAPACITIES[type];
}

// ============================================================================
// Validation Helpers
// ============================================================================

function assertChestEntity(chest: ChestEntity): void {
  if (!isChestType(chest.type)) {
    throw new SimulationError(
      'INVALID_CHEST_TYPE',
      `Entity ${chest.id} is not a valid chest type: "${String(chest.type)}".`
    );
  }
  const expectedCapacity = CHEST_CAPACITIES[chest.type];
  if (
    chest.inventory.capacity !== expectedCapacity ||
    chest.inventory.slots.length !== expectedCapacity
  ) {
    throw new SimulationError(
      'INVALID_CHEST_INVENTORY',
      `Chest ${chest.id} (${chest.type}) expected ${expectedCapacity} slots, found capacity=${chest.inventory.capacity}, slots=${chest.inventory.slots.length}.`
    );
  }
}

// ============================================================================
// Chest Factory Functions
// ============================================================================

/**
 * Creates a deterministic ChestEntity (16-slot wooden_chest or 32-slot iron_chest).
 * Fails closed on invalid ID, chest type, non-integer coordinates, invalid direction,
 * or invalid filter ItemIds.
 */
export function createChestEntity(
  id: EntityId,
  type: ChestType,
  position: TileCoord,
  direction: Direction = 'N',
  filters?: ReadonlyArray<ItemId | null>
): ChestEntity {
  if (!Number.isInteger(id) || id < 1) {
    throw new SimulationError(
      'INVALID_ENTITY_ID',
      `Chest entity ID must be a positive integer, received ${String(id)}.`
    );
  }
  if (!isChestType(type)) {
    throw new SimulationError(
      'INVALID_CHEST_TYPE',
      `Unknown chest type: "${String(type)}".`
    );
  }
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new InvalidPlacementError(
      type,
      position,
      'Chest coordinates must be integers.'
    );
  }
  if (!DIRECTIONS.includes(direction)) {
    throw new InvalidPlacementError(
      type,
      position,
      `Invalid direction "${String(direction)}".`
    );
  }

  if (filters !== undefined) {
    for (const filter of filters) {
      if (filter !== null) {
        assertValidItemId(filter);
      }
    }
  }

  const capacity = CHEST_CAPACITIES[type];
  return {
    id,
    type,
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    inventory: createInventoryState(capacity, filters),
  };
}

export function createWoodenChest(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N',
  filters?: ReadonlyArray<ItemId | null>
): ChestEntity {
  return createChestEntity(id, 'wooden_chest', position, direction, filters);
}

export function createIronChest(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N',
  filters?: ReadonlyArray<ItemId | null>
): ChestEntity {
  return createChestEntity(id, 'iron_chest', position, direction, filters);
}

// ============================================================================
// Chest Storage Operations
// ============================================================================

/**
 * Returns how many of `count` units of `itemId` can be inserted into the chest
 * without mutating state.
 */
export function canInsertIntoChest(
  chest: ChestEntity,
  itemId: ItemId,
  count = 1,
  stackSizeResolver: StackSizeResolver = getStackSize
): number {
  assertChestEntity(chest);
  assertValidItemId(itemId);
  return canInsert(chest.inventory, itemId, count, stackSizeResolver);
}

/**
 * Inserts up to `count` units of `itemId` into the chest.
 * Returns the exact number of items inserted (`0 <= inserted <= count`).
 * Under full-inventory backpressure, returns 0 without losing items.
 */
export function insertIntoChest(
  chest: ChestEntity,
  itemId: ItemId,
  count = 1,
  stackSizeResolver: StackSizeResolver = getStackSize
): number {
  assertChestEntity(chest);
  assertValidItemId(itemId);
  return insertItem(chest.inventory, itemId, count, stackSizeResolver);
}

/**
 * Extracts up to `count` units of `itemId` (or the first available item in ascending
 * slot order if `itemId` is omitted) from the chest.
 * Returns the extracted `ItemStack`, or `null` if nothing could be extracted.
 */
export function extractFromChest(
  chest: ChestEntity,
  itemId?: ItemId,
  count = 1
): ItemStack | null {
  assertChestEntity(chest);
  if (count === 0) {
    if (itemId !== undefined) {
      assertValidItemId(itemId);
    }
    return null;
  }

  let targetItemId: ItemId | null;
  if (itemId !== undefined) {
    assertValidItemId(itemId);
    targetItemId = itemId;
  } else {
    targetItemId = getFirstAvailableItem(chest.inventory);
  }

  if (targetItemId === null) {
    return null;
  }

  const removed = removeItem(chest.inventory, targetItemId, count);
  if (removed === 0) {
    return null;
  }
  return { itemId: targetItemId, count: removed };
}

/**
 * Extracts up to `count` units of the first available item matching `whitelist`
 * (ascending slot order). Useful for filter inserters pulling from chests.
 */
export function extractMatchingFromChest(
  chest: ChestEntity,
  whitelist: readonly ItemId[],
  count = 1
): ItemStack | null {
  assertChestEntity(chest);
  for (const id of whitelist) {
    assertValidItemId(id);
  }
  if (count === 0 || whitelist.length === 0) {
    return null;
  }

  const targetItemId = getFirstAvailableItem(chest.inventory, whitelist);
  if (targetItemId === null) {
    return null;
  }

  const removed = removeItem(chest.inventory, targetItemId, count);
  if (removed === 0) {
    return null;
  }
  return { itemId: targetItemId, count: removed };
}

/**
 * Transfers up to `count` units of `itemId` from `source` chest to `target` chest
 * with strict item conservation (partial transfer when target has limited space;
 * zero items lost or duplicated).
 */
export function transferBetweenChests(
  source: ChestEntity,
  target: ChestEntity,
  itemId: ItemId,
  count: number,
  stackSizeResolver: StackSizeResolver = getStackSize
): number {
  assertChestEntity(source);
  assertChestEntity(target);
  assertValidItemId(itemId);

  if (!Number.isInteger(count) || count < 0) {
    throw new SimulationError(
      'INVALID_ITEM_COUNT',
      `Transfer count must be a non-negative integer, received: ${String(count)}.`
    );
  }
  if (count === 0 || source === target) {
    return 0;
  }

  const available = getItemCount(source.inventory, itemId);
  const desired = Math.min(available, count);
  if (desired === 0) {
    return 0;
  }

  const movable = canInsert(target.inventory, itemId, desired, stackSizeResolver);
  if (movable === 0) {
    return 0;
  }

  const removed = removeItem(source.inventory, itemId, movable);
  const inserted = insertItem(target.inventory, itemId, removed, stackSizeResolver);
  if (removed !== movable || inserted !== removed) {
    throw new SimulationError(
      'CHEST_CONSERVATION_ERROR',
      `Conservation violation transferring "${itemId}": expected=${movable}, removed=${removed}, inserted=${inserted}.`
    );
  }

  return inserted;
}

// ============================================================================
// Inspection & Slot Filter Helpers
// ============================================================================

export function getChestItemCount(chest: ChestEntity, itemId: ItemId): number {
  assertChestEntity(chest);
  assertValidItemId(itemId);
  return getItemCount(chest.inventory, itemId);
}

export function getChestTotalItems(chest: ChestEntity): number {
  assertChestEntity(chest);
  return getTotalItemCount(chest.inventory);
}

export function getChestUsedSlots(chest: ChestEntity): number {
  assertChestEntity(chest);
  let used = 0;
  for (const slot of chest.inventory.slots) {
    if (slot.item !== null && slot.item.count > 0) {
      used += 1;
    }
  }
  return used;
}

export function getChestFreeSlots(chest: ChestEntity): number {
  assertChestEntity(chest);
  return chest.inventory.capacity - getChestUsedSlots(chest);
}

export function isChestEmpty(chest: ChestEntity): boolean {
  assertChestEntity(chest);
  return isEmpty(chest.inventory);
}

export function isChestFull(
  chest: ChestEntity,
  itemId?: ItemId,
  stackSizeResolver: StackSizeResolver = getStackSize
): boolean {
  assertChestEntity(chest);
  if (itemId !== undefined) {
    assertValidItemId(itemId);
  }
  return isFull(chest.inventory, itemId, stackSizeResolver);
}

export function setChestSlotFilter(
  chest: ChestEntity,
  slotIndex: number,
  filter: ItemId | null
): void {
  assertChestEntity(chest);
  if (filter !== null) {
    assertValidItemId(filter);
  }
  setSlotFilter(chest.inventory, slotIndex, filter);
}

export function getChestSlotFilter(
  chest: ChestEntity,
  slotIndex: number
): ItemId | null {
  assertChestEntity(chest);
  return getSlotFilter(chest.inventory, slotIndex);
}

export function clearChestSlotFilter(chest: ChestEntity, slotIndex: number): void {
  assertChestEntity(chest);
  clearSlotFilter(chest.inventory, slotIndex);
}
