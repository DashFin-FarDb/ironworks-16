/**
 * Ironworks-16 Slot-Based Inventory (T08)
 *
 * Deterministic, headless, fail-closed slot-based inventory supporting:
 * - Item stacking with configurable per-item stack size resolution
 * - Optional per-slot ItemId filters
 * - Atomic all-or-nothing `consumeIngredients`
 * - Strict item conservation (never loses, duplicates, or produces NaN counts)
 */

import {
  InsufficientIngredientsError,
  SimulationError,
  type InventorySlot,
  type InventoryState,
  type ItemId,
  type RecipeId,
  type RecipeIngredient,
} from '../types/contracts';

export type StackSizeResolver = (itemId: ItemId) => number;

export const DEFAULT_STACK_SIZE = 50;

export const defaultStackSizeResolver: StackSizeResolver = () => DEFAULT_STACK_SIZE;

function assertValidCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new SimulationError(
      'INVALID_INVENTORY_CAPACITY',
      `Inventory capacity must be a non-negative integer, received: ${String(capacity)}.`
    );
  }
}

function assertValidCount(count: number, allowZero = false): void {
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(count) || count < min) {
    throw new SimulationError(
      'INVALID_ITEM_COUNT',
      `Item count must be an integer >= ${min}, received: ${String(count)}.`
    );
  }
}

function assertValidSlotIndex(state: InventoryState, slotIndex: number): InventorySlot {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= state.slots.length) {
    throw new SimulationError(
      'INVALID_SLOT_INDEX',
      `Slot index ${String(slotIndex)} is out of bounds for inventory of capacity ${state.slots.length}.`
    );
  }
  return state.slots[slotIndex] as InventorySlot;
}

function resolveStackSize(
  itemId: ItemId,
  getStackSize: StackSizeResolver = defaultStackSizeResolver
): number {
  const stackSize = getStackSize(itemId);
  if (!Number.isInteger(stackSize) || stackSize <= 0) {
    throw new SimulationError(
      'INVALID_STACK_SIZE',
      `Stack size for item "${itemId}" must be a positive integer, received: ${String(stackSize)}.`
    );
  }
  return stackSize;
}

/**
 * Creates a new empty `InventoryState` with `capacity` slots and optional per-slot filters.
 */
export function createInventoryState(
  capacity: number,
  filters?: ReadonlyArray<ItemId | null>
): InventoryState {
  assertValidCapacity(capacity);
  if (filters !== undefined && filters.length > capacity) {
    throw new SimulationError(
      'INVALID_SLOT_INDEX',
      `Provided ${filters.length} slot filters for inventory of capacity ${capacity}.`
    );
  }

  const slots: InventorySlot[] = [];
  for (let i = 0; i < capacity; i++) {
    slots.push({
      item: null,
      filter: filters?.[i] ?? null,
    });
  }

  return {
    capacity,
    slots,
  };
}

/**
 * Deep-clones an `InventoryState` for deterministic snapshots or rollback.
 */
export function cloneInventoryState(state: InventoryState): InventoryState {
  return {
    capacity: state.capacity,
    slots: state.slots.map((slot) => ({
      item: slot.item ? { itemId: slot.item.itemId, count: slot.item.count } : null,
      filter: slot.filter,
    })),
  };
}

/**
 * Sets or clears the item filter on a specific slot.
 * Fails closed if the slot currently holds a different item than the requested filter.
 */
export function setSlotFilter(
  state: InventoryState,
  slotIndex: number,
  filter: ItemId | null
): void {
  const slot = assertValidSlotIndex(state, slotIndex);
  if (filter !== null && slot.item !== null && slot.item.itemId !== filter) {
    throw new SimulationError(
      'FILTER_CONFLICT',
      `Cannot set filter "${filter}" on slot ${slotIndex} currently containing "${slot.item.itemId}".`
    );
  }
  slot.filter = filter;
}

/**
 * Returns the filter configured on a specific slot, or `null` if unfiltered.
 */
export function getSlotFilter(state: InventoryState, slotIndex: number): ItemId | null {
  return assertValidSlotIndex(state, slotIndex).filter;
}

/**
 * Clears the filter on a specific slot.
 */
export function clearSlotFilter(state: InventoryState, slotIndex: number): void {
  assertValidSlotIndex(state, slotIndex).filter = null;
}

/**
 * Returns the total count of `itemId` across all slots.
 */
export function getItemCount(state: InventoryState, itemId: ItemId): number {
  let total = 0;
  for (const slot of state.slots) {
    if (slot.item !== null && slot.item.itemId === itemId) {
      total += slot.item.count;
    }
  }
  return total;
}

/**
 * Returns the total count of all items across all slots.
 */
export function getTotalItemCount(state: InventoryState): number {
  let total = 0;
  for (const slot of state.slots) {
    if (slot.item !== null) {
      total += slot.item.count;
    }
  }
  return total;
}

/**
 * Returns true if the inventory contains zero items.
 */
export function isEmpty(state: InventoryState): boolean {
  for (const slot of state.slots) {
    if (slot.item !== null && slot.item.count > 0) {
      return false;
    }
  }
  return true;
}

/**
 * Computes how many of `count` units of `itemId` can be inserted without mutating state.
 */
export function canInsert(
  state: InventoryState,
  itemId: ItemId,
  count: number,
  getStackSize: StackSizeResolver = defaultStackSizeResolver
): number {
  assertValidCount(count, true);
  if (count === 0) return 0;

  const maxStack = resolveStackSize(itemId, getStackSize);
  let capacityLeft = 0;

  // 1. Existing partial stacks of itemId
  for (const slot of state.slots) {
    if (slot.item !== null && slot.item.itemId === itemId) {
      if (slot.filter !== null && slot.filter !== itemId) continue;
      const room = maxStack - slot.item.count;
      if (room > 0) {
        capacityLeft += room;
        if (capacityLeft >= count) return count;
      }
    }
  }

  // 2. Empty filtered slots matching itemId, then empty unfiltered slots
  for (const slot of state.slots) {
    if (slot.item === null && (slot.filter === itemId || slot.filter === null)) {
      capacityLeft += maxStack;
      if (capacityLeft >= count) return count;
    }
  }

  return capacityLeft;
}

/**
 * Returns true if the inventory cannot accept any more of `itemId` (or if no `itemId` is
 * provided, if every slot is occupied and at its max stack size).
 */
export function isFull(
  state: InventoryState,
  itemId?: ItemId,
  getStackSize: StackSizeResolver = defaultStackSizeResolver
): boolean {
  if (itemId !== undefined) {
    return canInsert(state, itemId, 1, getStackSize) === 0;
  }
  for (const slot of state.slots) {
    if (slot.item === null) return false;
    const maxStack = resolveStackSize(slot.item.itemId, getStackSize);
    if (slot.item.count < maxStack) return false;
  }
  return true;
}

/**
 * Deterministically inserts up to `count` units of `itemId` into the inventory.
 * Placement priority:
 *   1. Existing partial stacks of `itemId` (ascending slot index)
 *   2. Empty slots filtered to `itemId` (ascending slot index)
 *   3. Empty unfiltered slots (ascending slot index)
 *
 * Returns the exact number of items inserted (`0 <= inserted <= count`).
 */
export function insertItem(
  state: InventoryState,
  itemId: ItemId,
  count: number,
  getStackSize: StackSizeResolver = defaultStackSizeResolver
): number {
  assertValidCount(count, true);
  if (count === 0) return 0;

  const maxStack = resolveStackSize(itemId, getStackSize);
  let remaining = count;

  // Pass 1: top up existing partial stacks of the same item
  for (const slot of state.slots) {
    if (remaining === 0) break;
    if (slot.item !== null && slot.item.itemId === itemId) {
      if (slot.filter !== null && slot.filter !== itemId) continue;
      const room = maxStack - slot.item.count;
      if (room > 0) {
        const added = Math.min(room, remaining);
        slot.item.count += added;
        remaining -= added;
      }
    }
  }

  // Pass 2: fill empty slots explicitly filtered to itemId
  for (const slot of state.slots) {
    if (remaining === 0) break;
    if (slot.item === null && slot.filter === itemId) {
      const added = Math.min(maxStack, remaining);
      slot.item = { itemId, count: added };
      remaining -= added;
    }
  }

  // Pass 3: fill empty unfiltered slots
  for (const slot of state.slots) {
    if (remaining === 0) break;
    if (slot.item === null && slot.filter === null) {
      const added = Math.min(maxStack, remaining);
      slot.item = { itemId, count: added };
      remaining -= added;
    }
  }

  return count - remaining;
}

/**
 * Deterministically removes up to `count` units of `itemId` from the inventory,
 * draining from the highest-index matching slots first.
 * Returns the exact number of items removed (`0 <= removed <= count`).
 */
export function removeItem(
  state: InventoryState,
  itemId: ItemId,
  count: number
): number {
  assertValidCount(count, true);
  if (count === 0) return 0;

  let remaining = count;

  for (let i = state.slots.length - 1; i >= 0 && remaining > 0; i--) {
    const slot = state.slots[i];
    if (slot !== undefined && slot.item !== null && slot.item.itemId === itemId) {
      const taken = Math.min(slot.item.count, remaining);
      slot.item.count -= taken;
      remaining -= taken;
      if (slot.item.count === 0) {
        slot.item = null;
      }
    }
  }

  return count - remaining;
}

/**
 * Aggregates duplicate ingredient entries into a deterministic ordered list of (ItemId, totalCount).
 * Validates all ingredient counts fail-closed.
 */
function aggregateIngredients(
  ingredients: readonly RecipeIngredient[]
): Array<{ itemId: ItemId; count: number }> {
  const totals = new Map<ItemId, number>();
  for (const ingredient of ingredients) {
    assertValidCount(ingredient.count, true);
    if (ingredient.count === 0) continue;
    totals.set(ingredient.itemId, (totals.get(ingredient.itemId) ?? 0) + ingredient.count);
  }
  const result: Array<{ itemId: ItemId; count: number }> = [];
  for (const [itemId, count] of totals.entries()) {
    result.push({ itemId, count });
  }
  return result;
}

/**
 * Returns true iff the inventory contains at least the required count of every ingredient
 * (correctly aggregating duplicate `itemId` entries).
 */
export function hasItems(
  state: InventoryState,
  ingredients: readonly RecipeIngredient[]
): boolean {
  const aggregated = aggregateIngredients(ingredients);
  for (const req of aggregated) {
    if (getItemCount(state, req.itemId) < req.count) {
      return false;
    }
  }
  return true;
}

/**
 * Atomically consumes all `ingredients` from the inventory (all-or-nothing).
 * If any ingredient is insufficient, the inventory is NOT mutated and `false` is returned.
 * If all ingredients are present, they are removed and `true` is returned.
 */
export function consumeIngredients(
  state: InventoryState,
  ingredients: readonly RecipeIngredient[]
): boolean {
  const aggregated = aggregateIngredients(ingredients);
  for (const req of aggregated) {
    if (getItemCount(state, req.itemId) < req.count) {
      return false;
    }
  }

  for (const req of aggregated) {
    const removed = removeItem(state, req.itemId, req.count);
    if (removed !== req.count) {
      // Defensive invariant check: should be unreachable because we pre-verified counts.
      throw new SimulationError(
        'INVENTORY_CONSERVATION_ERROR',
        `Expected to remove ${req.count} of "${req.itemId}", but removed ${removed}.`
      );
    }
  }

  return true;
}

/**
 * Atomically consumes all `ingredients` for `recipeId`, or throws `InsufficientIngredientsError`
 * without mutating the inventory.
 */
export function consumeIngredientsOrThrow(
  state: InventoryState,
  recipeId: RecipeId,
  ingredients: readonly RecipeIngredient[]
): void {
  if (!consumeIngredients(state, ingredients)) {
    throw new InsufficientIngredientsError(recipeId);
  }
}

/**
 * Returns the first available `ItemId` in ascending slot order, optionally restricted
 * to a `whitelist`. Returns `null` if no matching item is present.
 */
export function getFirstAvailableItem(
  state: InventoryState,
  whitelist?: readonly ItemId[]
): ItemId | null {
  for (const slot of state.slots) {
    if (slot.item !== null && slot.item.count > 0) {
      if (whitelist === undefined || whitelist.includes(slot.item.itemId)) {
        return slot.item.itemId;
      }
    }
  }
  return null;
}

/**
 * Stateful class wrapper around `InventoryState` and an optional `StackSizeResolver`.
 */
export class Inventory {
  readonly state: InventoryState;
  private readonly getStackSize: StackSizeResolver;

  constructor(
    capacityOrState: number | InventoryState,
    options?: {
      filters?: ReadonlyArray<ItemId | null>;
      getStackSize?: StackSizeResolver;
    }
  ) {
    this.getStackSize = options?.getStackSize ?? defaultStackSizeResolver;
    this.state =
      typeof capacityOrState === 'number'
        ? createInventoryState(capacityOrState, options?.filters)
        : capacityOrState;
  }

  get capacity(): number {
    return this.state.capacity;
  }

  get slots(): readonly InventorySlot[] {
    return this.state.slots;
  }

  setFilter(slotIndex: number, filter: ItemId | null): void {
    setSlotFilter(this.state, slotIndex, filter);
  }

  getFilter(slotIndex: number): ItemId | null {
    return getSlotFilter(this.state, slotIndex);
  }

  clearFilter(slotIndex: number): void {
    clearSlotFilter(this.state, slotIndex);
  }

  getCount(itemId: ItemId): number {
    return getItemCount(this.state, itemId);
  }

  getTotalCount(): number {
    return getTotalItemCount(this.state);
  }

  isEmpty(): boolean {
    return isEmpty(this.state);
  }

  isFull(itemId?: ItemId): boolean {
    return isFull(this.state, itemId, this.getStackSize);
  }

  canInsert(itemId: ItemId, count: number): number {
    return canInsert(this.state, itemId, count, this.getStackSize);
  }

  insert(itemId: ItemId, count: number): number {
    return insertItem(this.state, itemId, count, this.getStackSize);
  }

  remove(itemId: ItemId, count: number): number {
    return removeItem(this.state, itemId, count);
  }

  hasItems(ingredients: readonly RecipeIngredient[]): boolean {
    return hasItems(this.state, ingredients);
  }

  consumeIngredients(ingredients: readonly RecipeIngredient[]): boolean {
    return consumeIngredients(this.state, ingredients);
  }

  consumeIngredientsOrThrow(
    recipeId: RecipeId,
    ingredients: readonly RecipeIngredient[]
  ): void {
    consumeIngredientsOrThrow(this.state, recipeId, ingredients);
  }

  getFirstAvailableItem(whitelist?: readonly ItemId[]): ItemId | null {
    return getFirstAvailableItem(this.state, whitelist);
  }

  clone(): Inventory {
    return new Inventory(cloneInventoryState(this.state), {
      getStackSize: this.getStackSize,
    });
  }
}
