import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STACK_SIZE,
  Inventory,
  canInsert,
  clearSlotFilter,
  cloneInventoryState,
  consumeIngredients,
  consumeIngredientsOrThrow,
  createInventoryState,
  getFirstAvailableItem,
  getItemCount,
  getSlotFilter,
  getTotalItemCount,
  hasItems,
  insertItem,
  isEmpty,
  isFull,
  removeItem,
  setSlotFilter,
  type StackSizeResolver,
} from '../src/core/inventory';
import {
  InsufficientIngredientsError,
  SimulationError,
  type ItemId,
} from '../src/types/contracts';

const customStackSizes: StackSizeResolver = (itemId: ItemId): number => {
  switch (itemId) {
    case 'iron_ore':
      return 10;
    case 'iron_plate':
      return 20;
    case 'coal':
      return 5;
    default:
      return DEFAULT_STACK_SIZE;
  }
};

describe('T08: Slot-based Inventory', () => {
  describe('creation & fail-closed validation', () => {
    it('creates an empty inventory with optional initial filters', () => {
      const state = createInventoryState(3, ['iron_ore', null, 'coal']);
      expect(state.capacity).toBe(3);
      expect(state.slots).toHaveLength(3);
      expect(isEmpty(state)).toBe(true);
      expect(getSlotFilter(state, 0)).toBe('iron_ore');
      expect(getSlotFilter(state, 1)).toBeNull();
      expect(getSlotFilter(state, 2)).toBe('coal');
    });

    it('rejects invalid capacities and out-of-bounds filters', () => {
      expect(() => createInventoryState(-1)).toThrow(SimulationError);
      expect(() => createInventoryState(1.5)).toThrow(SimulationError);
      expect(() => createInventoryState(Number.NaN)).toThrow(SimulationError);
      expect(() => createInventoryState(1, ['coal', 'iron_ore'])).toThrow(SimulationError);
    });

    it('rejects invalid item counts and invalid stack sizes', () => {
      const state = createInventoryState(2);
      expect(() => insertItem(state, 'iron_ore', -1)).toThrow(SimulationError);
      expect(() => insertItem(state, 'iron_ore', Number.NaN)).toThrow(SimulationError);
      expect(() => insertItem(state, 'iron_ore', 2.5)).toThrow(SimulationError);
      expect(() => removeItem(state, 'iron_ore', -5)).toThrow(SimulationError);
      expect(() => insertItem(state, 'iron_ore', 1, () => 0)).toThrow(SimulationError);
      expect(() => insertItem(state, 'iron_ore', 1, () => Number.NaN)).toThrow(SimulationError);
    });
  });

  describe('stacking & item conservation', () => {
    it('stacks items up to stackSize and spills into subsequent slots', () => {
      const state = createInventoryState(3);
      const inserted = insertItem(state, 'iron_ore', 25, customStackSizes);
      expect(inserted).toBe(25);
      expect(state.slots[0]?.item).toEqual({ itemId: 'iron_ore', count: 10 });
      expect(state.slots[1]?.item).toEqual({ itemId: 'iron_ore', count: 10 });
      expect(state.slots[2]?.item).toEqual({ itemId: 'iron_ore', count: 5 });
      expect(getItemCount(state, 'iron_ore')).toBe(25);
      expect(isFull(state, 'iron_ore', customStackSizes)).toBe(false);
    });

    it('halts cleanly at capacity and returns exact inserted count without item loss', () => {
      const state = createInventoryState(2);
      expect(canInsert(state, 'iron_ore', 25, customStackSizes)).toBe(20);
      const inserted = insertItem(state, 'iron_ore', 25, customStackSizes);
      expect(inserted).toBe(20);
      expect(getItemCount(state, 'iron_ore')).toBe(20);
      expect(isFull(state, 'iron_ore', customStackSizes)).toBe(true);
      expect(isFull(state, undefined, customStackSizes)).toBe(true);
      expect(insertItem(state, 'iron_ore', 1, customStackSizes)).toBe(0);
    });

    it('tops up partial stacks before occupying new empty slots', () => {
      const state = createInventoryState(3);
      insertItem(state, 'iron_ore', 4, customStackSizes);
      insertItem(state, 'coal', 2, customStackSizes);
      insertItem(state, 'iron_ore', 8, customStackSizes);

      expect(state.slots[0]?.item).toEqual({ itemId: 'iron_ore', count: 10 });
      expect(state.slots[1]?.item).toEqual({ itemId: 'coal', count: 2 });
      expect(state.slots[2]?.item).toEqual({ itemId: 'iron_ore', count: 2 });
      expect(getTotalItemCount(state)).toBe(14);
    });
  });

  describe('per-slot filters', () => {
    it('prioritizes matching filtered slots over unfiltered slots and blocks mismatched items', () => {
      const state = createInventoryState(3, [null, 'coal', 'iron_ore']);
      expect(insertItem(state, 'coal', 3, customStackSizes)).toBe(3);
      // Should go to slot 1 (filtered to coal), not slot 0 (unfiltered)
      expect(state.slots[0]?.item).toBeNull();
      expect(state.slots[1]?.item).toEqual({ itemId: 'coal', count: 3 });

      // Copper ore cannot enter slot 1 or 2, only slot 0
      expect(insertItem(state, 'copper_ore', 60)).toBe(DEFAULT_STACK_SIZE);
      expect(state.slots[0]?.item).toEqual({ itemId: 'copper_ore', count: DEFAULT_STACK_SIZE });
      expect(state.slots[2]?.item).toBeNull();
    });

    it('fails closed when setting a conflicting filter on an occupied slot', () => {
      const state = createInventoryState(2);
      insertItem(state, 'iron_plate', 5);
      expect(() => setSlotFilter(state, 0, 'copper_plate')).toThrow(SimulationError);
      // Setting matching filter or clearing filter succeeds
      setSlotFilter(state, 0, 'iron_plate');
      expect(getSlotFilter(state, 0)).toBe('iron_plate');
      clearSlotFilter(state, 0);
      expect(getSlotFilter(state, 0)).toBeNull();
    });
  });

  describe('removal & inspection', () => {
    it('drains trailing stacks first and clears empty slots to null', () => {
      const state = createInventoryState(3);
      insertItem(state, 'iron_ore', 23, customStackSizes); // 10, 10, 3
      const removed = removeItem(state, 'iron_ore', 5);
      expect(removed).toBe(5);
      expect(state.slots[2]?.item).toBeNull();
      expect(state.slots[1]?.item).toEqual({ itemId: 'iron_ore', count: 8 });
      expect(state.slots[0]?.item).toEqual({ itemId: 'iron_ore', count: 10 });
    });

    it('returns first available item with optional whitelist', () => {
      const state = createInventoryState(3);
      expect(getFirstAvailableItem(state)).toBeNull();
      insertItem(state, 'iron_ore', 2);
      insertItem(state, 'coal', 3);
      expect(getFirstAvailableItem(state)).toBe('iron_ore');
      expect(getFirstAvailableItem(state, ['coal'])).toBe('coal');
      expect(getFirstAvailableItem(state, ['copper_ore'])).toBeNull();
    });
  });

  describe('atomic consumeIngredients', () => {
    it('consumes all ingredients atomically when sufficient', () => {
      const state = createInventoryState(4);
      insertItem(state, 'iron_plate', 10);
      insertItem(state, 'iron_gear', 5);

      const ok = consumeIngredients(state, [
        { itemId: 'iron_plate', count: 4 },
        { itemId: 'iron_gear', count: 2 },
      ]);
      expect(ok).toBe(true);
      expect(getItemCount(state, 'iron_plate')).toBe(6);
      expect(getItemCount(state, 'iron_gear')).toBe(3);
    });

    it('mutates NOTHING when any ingredient is missing (all-or-nothing)', () => {
      const state = createInventoryState(4);
      insertItem(state, 'iron_plate', 10);
      insertItem(state, 'iron_gear', 1);
      const snapshot = cloneInventoryState(state);

      const ok = consumeIngredients(state, [
        { itemId: 'iron_plate', count: 4 },
        { itemId: 'iron_gear', count: 2 },
      ]);
      expect(ok).toBe(false);
      expect(state).toEqual(snapshot);
    });

    it('aggregates duplicate ItemId entries in ingredients before checking/consuming', () => {
      const state = createInventoryState(2);
      insertItem(state, 'iron_plate', 5);
      const snapshot = cloneInventoryState(state);

      const ingredients = [
        { itemId: 'iron_plate' as const, count: 3 },
        { itemId: 'iron_plate' as const, count: 3 },
      ];
      expect(hasItems(state, ingredients)).toBe(false);
      expect(consumeIngredients(state, ingredients)).toBe(false);
      expect(state).toEqual(snapshot);

      insertItem(state, 'iron_plate', 1);
      expect(consumeIngredients(state, ingredients)).toBe(true);
      expect(getItemCount(state, 'iron_plate')).toBe(0);
    });

    it('consumeIngredientsOrThrow throws InsufficientIngredientsError without mutating', () => {
      const state = createInventoryState(2);
      insertItem(state, 'copper_plate', 1);
      const snapshot = cloneInventoryState(state);

      expect(() =>
        consumeIngredientsOrThrow(state, 'red_science', [
          { itemId: 'copper_plate', count: 1 },
          { itemId: 'iron_gear', count: 1 },
        ])
      ).toThrow(InsufficientIngredientsError);
      expect(state).toEqual(snapshot);
    });
  });

  describe('Inventory class wrapper', () => {
    it('wraps InventoryState operations and supports deep cloning', () => {
      const inv = new Inventory(2, { getStackSize: customStackSizes });
      expect(inv.insert('coal', 7)).toBe(7);
      expect(inv.getCount('coal')).toBe(7);

      const cloned = inv.clone();
      expect(cloned.remove('coal', 3)).toBe(3);
      expect(cloned.getCount('coal')).toBe(4);
      expect(inv.getCount('coal')).toBe(7);
    });
  });
});
