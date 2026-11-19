import { describe, expect, it } from 'vitest';
import { EntityManager } from '../src/core/entityManager';
import {
  CHEST_CAPACITIES,
  IRON_CHEST_SLOTS,
  WOODEN_CHEST_SLOTS,
  canInsertIntoChest,
  clearChestSlotFilter,
  createChestEntity,
  createIronChest,
  createWoodenChest,
  extractFromChest,
  extractMatchingFromChest,
  getChestCapacity,
  getChestFreeSlots,
  getChestItemCount,
  getChestSlotFilter,
  getChestTotalItems,
  getChestUsedSlots,
  insertIntoChest,
  isChestEmpty,
  isChestEntity,
  isChestFull,
  isChestType,
  setChestSlotFilter,
  transferBetweenChests,
} from '../src/logistics/chest';
import {
  InvalidPlacementError,
  SimulationError,
  UnknownItemError,
  type ChestEntity,
  type ItemId,
} from '../src/types/contracts';

describe('T19: Storage Chests (Wooden 16-slot & Iron 32-slot)', () => {
  it('defines canonical capacities for wooden (16) and iron (32) chests', () => {
    expect(WOODEN_CHEST_SLOTS).toBe(16);
    expect(IRON_CHEST_SLOTS).toBe(32);
    expect(CHEST_CAPACITIES.wooden_chest).toBe(16);
    expect(CHEST_CAPACITIES.iron_chest).toBe(32);
    expect(getChestCapacity('wooden_chest')).toBe(16);
    expect(getChestCapacity('iron_chest')).toBe(32);
    expect(isChestType('wooden_chest')).toBe(true);
    expect(isChestType('iron_chest')).toBe(true);
    expect(isChestType('transport_belt')).toBe(false);
  });

  it('creates wooden and iron chests with proper footprints, capacities, and type guards', () => {
    const wooden = createWoodenChest(1, { x: 4, y: 5 });
    const iron = createIronChest(2, { x: 6, y: 7 }, 'E');

    expect(wooden.type).toBe('wooden_chest');
    expect(wooden.inventory.capacity).toBe(16);
    expect(wooden.inventory.slots).toHaveLength(16);
    expect(wooden.footprint).toEqual({ width: 1, height: 1 });
    expect(wooden.direction).toBe('N');
    expect(isChestEntity(wooden)).toBe(true);
    expect(isChestEmpty(wooden)).toBe(true);
    expect(getChestUsedSlots(wooden)).toBe(0);
    expect(getChestFreeSlots(wooden)).toBe(16);

    expect(iron.type).toBe('iron_chest');
    expect(iron.inventory.capacity).toBe(32);
    expect(iron.inventory.slots).toHaveLength(32);
    expect(iron.direction).toBe('E');
    expect(isChestEntity(iron)).toBe(true);
    expect(getChestFreeSlots(iron)).toBe(32);
  });

  it('interoperates seamlessly with EntityManager.spawn', () => {
    const manager = new EntityManager({ bounds: { width: 64, height: 64 } });
    const wooden = manager.spawn('wooden_chest', { x: 10, y: 10 });
    const iron = manager.spawn('iron_chest', { x: 11, y: 10 });
    const belt = manager.spawn('transport_belt', { x: 12, y: 10 });

    expect(isChestEntity(wooden)).toBe(true);
    expect(isChestEntity(iron)).toBe(true);
    expect(isChestEntity(belt)).toBe(false);

    expect(insertIntoChest(wooden, 'iron_ore', 75)).toBe(75);
    expect(getChestItemCount(wooden, 'iron_ore')).toBe(75);
    expect(getChestUsedSlots(wooden)).toBe(2); // 50 + 25
    expect(getChestFreeSlots(wooden)).toBe(14);
  });

  it('enforces exact slot capacity and backpressure without item loss', () => {
    const wooden = createWoodenChest(1, { x: 0, y: 0 });
    const iron = createIronChest(2, { x: 1, y: 0 });

    // iron_ore stackSize = 50 -> wooden max = 16 * 50 = 800
    expect(canInsertIntoChest(wooden, 'iron_ore', 1000)).toBe(800);
    expect(insertIntoChest(wooden, 'iron_ore', 1000)).toBe(800);
    expect(getChestItemCount(wooden, 'iron_ore')).toBe(800);
    expect(isChestFull(wooden, 'iron_ore')).toBe(true);
    expect(isChestFull(wooden)).toBe(true);
    expect(insertIntoChest(wooden, 'iron_ore', 1)).toBe(0);
    expect(getChestTotalItems(wooden)).toBe(800);

    // iron_plate stackSize = 100 -> iron chest max = 32 * 100 = 3200
    expect(canInsertIntoChest(iron, 'iron_plate', 4000)).toBe(3200);
    expect(insertIntoChest(iron, 'iron_plate', 4000)).toBe(3200);
    expect(getChestItemCount(iron, 'iron_plate')).toBe(3200);
    expect(isChestFull(iron, 'iron_plate')).toBe(true);
    expect(insertIntoChest(iron, 'copper_plate', 10)).toBe(0);
  });

  it('extracts specific items, first available items, and whitelisted items deterministically', () => {
    const chest = createWoodenChest(1, { x: 2, y: 2 });
    insertIntoChest(chest, 'coal', 10);
    insertIntoChest(chest, 'iron_plate', 5);
    insertIntoChest(chest, 'copper_plate', 3);

    // Default extraction takes from first available slot's item ('coal')
    expect(extractFromChest(chest, undefined, 4)).toEqual({
      itemId: 'coal',
      count: 4,
    });
    expect(getChestItemCount(chest, 'coal')).toBe(6);

    // Specific item extraction
    expect(extractFromChest(chest, 'iron_plate', 10)).toEqual({
      itemId: 'iron_plate',
      count: 5,
    });
    expect(getChestItemCount(chest, 'iron_plate')).toBe(0);
    expect(extractFromChest(chest, 'iron_plate', 1)).toBeNull();

    // Whitelisted extraction (e.g., filter inserter)
    expect(extractMatchingFromChest(chest, ['copper_plate', 'steel_plate'], 2)).toEqual({
      itemId: 'copper_plate',
      count: 2,
    });
    expect(getChestItemCount(chest, 'copper_plate')).toBe(1);
    expect(extractMatchingFromChest(chest, ['red_science'], 1)).toBeNull();
  });

  it('supports per-slot filters and enforces filter rules', () => {
    const chest = createWoodenChest(1, { x: 3, y: 3 });
    setChestSlotFilter(chest, 0, 'red_science');
    expect(getChestSlotFilter(chest, 0)).toBe('red_science');

    // Non-matching item skips filtered slot 0 and lands in slot 1
    expect(insertIntoChest(chest, 'coal', 5)).toBe(5);
    expect(chest.inventory.slots[0]?.item).toBeNull();
    expect(chest.inventory.slots[1]?.item).toEqual({ itemId: 'coal', count: 5 });

    // Matching item prefers filtered slot 0
    expect(insertIntoChest(chest, 'red_science', 2)).toBe(2);
    expect(chest.inventory.slots[0]?.item).toEqual({ itemId: 'red_science', count: 2 });

    clearChestSlotFilter(chest, 0);
    expect(getChestSlotFilter(chest, 0)).toBeNull();
  });

  it('conserves 100% of items during chest-to-chest transfers under backpressure', () => {
    const source = createIronChest(1, { x: 0, y: 0 });
    const target = createWoodenChest(2, { x: 1, y: 0 });

    insertIntoChest(source, 'iron_ore', 1000); // 20 stacks in 32-slot iron chest
    const initialTotal = getChestTotalItems(source) + getChestTotalItems(target);

    // Target wooden chest can only hold 800 iron_ore (16 * 50)
    const moved = transferBetweenChests(source, target, 'iron_ore', 950);
    expect(moved).toBe(800);
    expect(getChestItemCount(target, 'iron_ore')).toBe(800);
    expect(getChestItemCount(source, 'iron_ore')).toBe(200);
    expect(getChestTotalItems(source) + getChestTotalItems(target)).toBe(initialTotal);

    // Self-transfer is a safe no-op
    expect(transferBetweenChests(source, source, 'iron_ore', 50)).toBe(0);
    expect(getChestItemCount(source, 'iron_ore')).toBe(200);
  });

  it('fails closed on unknown items, invalid chest types, and invalid parameters', () => {
    const chest = createWoodenChest(1, { x: 0, y: 0 });

    expect(() => insertIntoChest(chest, 'unobtanium' as ItemId, 1)).toThrow(
      UnknownItemError
    );
    expect(() => extractFromChest(chest, 'unobtanium' as ItemId, 1)).toThrow(
      UnknownItemError
    );
    expect(() => setChestSlotFilter(chest, 0, 'unobtanium' as ItemId)).toThrow(
      UnknownItemError
    );
    expect(() => getChestCapacity('diamond_chest' as 'wooden_chest')).toThrow(
      SimulationError
    );
    expect(() => createChestEntity(0, 'wooden_chest', { x: 0, y: 0 })).toThrow(
      SimulationError
    );
    expect(() => createWoodenChest(1, { x: 1.5, y: 0 })).toThrow(
      InvalidPlacementError
    );
    expect(() => setChestSlotFilter(chest, 16, 'coal')).toThrow(SimulationError);

    // Corrupted inventory capacity fails closed
    const corrupted: ChestEntity = {
      ...chest,
      inventory: { capacity: 4, slots: chest.inventory.slots.slice(0, 4) },
    };
    expect(() => getChestTotalItems(corrupted)).toThrow(SimulationError);
  });

  it('produces bit-for-bit identical serialized state across independent runs', () => {
    const runSequence = () => {
      const a = createWoodenChest(1, { x: 5, y: 5 });
      const b = createIronChest(2, { x: 6, y: 5 });
      setChestSlotFilter(a, 0, 'iron_plate');
      insertIntoChest(a, 'iron_ore', 120);
      insertIntoChest(a, 'iron_plate', 45);
      transferBetweenChests(a, b, 'iron_ore', 70);
      extractFromChest(a, undefined, 10);
      return JSON.stringify({ a, b });
    };

    expect(runSequence()).toBe(runSequence());
  });
});
