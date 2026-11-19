import { describe, expect, it } from 'vitest';
import {
  ALL_ITEM_IDS,
  ITEM_REGISTRY,
  assertValidItemId,
  getAllItems,
  getFuelValueKj,
  getItemDefinition,
  getItemsByCategory,
  getStackSize,
  isFuelItem,
  isValidItemId,
} from '../src/core/itemRegistry';
import {
  type ItemCategory,
  type ItemId,
  UnknownItemError,
} from '../src/types/contracts';

const EXPECTED_ITEMS: readonly ItemId[] = [
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
  'iron_plate',
  'copper_plate',
  'stone_brick',
  'steel_plate',
  'iron_gear',
  'copper_cable',
  'electronic_circuit',
  'transport_belt',
  'underground_belt',
  'splitter',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'red_science',
  'green_science',
];

describe('T06: Canonical Item Registry', () => {
  it('registers every canonical ItemId with consistent metadata', () => {
    expect(ALL_ITEM_IDS).toEqual(EXPECTED_ITEMS);
    expect(getAllItems()).toHaveLength(EXPECTED_ITEMS.length);

    for (const id of EXPECTED_ITEMS) {
      expect(isValidItemId(id)).toBe(true);
      const def = getItemDefinition(id);
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(def.stackSize)).toBe(true);
      expect(def.stackSize).toBeGreaterThan(0);
      expect(Number.isFinite(def.fuelValueKj)).toBe(true);
      expect(def.fuelValueKj).toBeGreaterThanOrEqual(0);
    }
  });

  it('defines canonical stack sizes and coal fuel value', () => {
    expect(getStackSize('iron_ore')).toBe(50);
    expect(getStackSize('coal')).toBe(50);
    expect(getStackSize('iron_plate')).toBe(100);
    expect(getStackSize('steel_plate')).toBe(100);
    expect(getStackSize('iron_gear')).toBe(100);
    expect(getStackSize('copper_cable')).toBe(200);
    expect(getStackSize('electronic_circuit')).toBe(200);
    expect(getStackSize('transport_belt')).toBe(100);
    expect(getStackSize('inserter')).toBe(50);
    expect(getStackSize('power_pole')).toBe(50);
    expect(getStackSize('red_science')).toBe(200);
    expect(getStackSize('green_science')).toBe(200);

    expect(getFuelValueKj('coal')).toBe(4000);
    expect(isFuelItem('coal')).toBe(true);

    expect(getFuelValueKj('iron_ore')).toBe(0);
    expect(isFuelItem('iron_ore')).toBe(false);
    expect(isFuelItem('iron_plate')).toBe(false);
    expect(isFuelItem('red_science')).toBe(false);
  });

  it('partitions all items cleanly across categories in deterministic order', () => {
    const categories: readonly ItemCategory[] = [
      'raw',
      'smelted',
      'intermediate',
      'logistics',
      'science',
    ];

    const collected: ItemId[] = [];
    for (const category of categories) {
      const items = getItemsByCategory(category);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.category).toBe(category);
        collected.push(item.id);
      }
    }

    expect(collected).toEqual(EXPECTED_ITEMS);
  });

  it('fails closed with UnknownItemError on unknown or prototype-pollution keys', () => {
    const invalidIds = ['', 'uranium_ore', 'IRON_ORE', 'toString', '__proto__', 'constructor'];

    for (const badId of invalidIds) {
      expect(isValidItemId(badId)).toBe(false);
      expect(() => assertValidItemId(badId)).toThrow(UnknownItemError);
      expect(() => getItemDefinition(badId)).toThrow(UnknownItemError);
      expect(() => getStackSize(badId)).toThrow(UnknownItemError);
      expect(() => getFuelValueKj(badId)).toThrow(UnknownItemError);
      expect(() => isFuelItem(badId)).toThrow(UnknownItemError);
    }
  });

  it('freezes the registry and its item definitions against mutation', () => {
    expect(Object.isFrozen(ITEM_REGISTRY)).toBe(true);
    expect(Object.isFrozen(ALL_ITEM_IDS)).toBe(true);
    for (const id of ALL_ITEM_IDS) {
      expect(Object.isFrozen(ITEM_REGISTRY[id])).toBe(true);
    }
  });
});
