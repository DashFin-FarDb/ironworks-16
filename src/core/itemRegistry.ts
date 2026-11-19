/**
 * Ironworks-16 Canonical Item Registry (T06)
 *
 * Defines all canonical ItemId entries with stack sizes, categories, and fuel values.
 * Strictly headless (zero DOM/Canvas imports), deterministic, immutable, and fail-closed.
 */

import {
  type ItemCategory,
  type ItemDefinition,
  type ItemId,
  UnknownItemError,
} from '../types/contracts';

const RAW_ITEM_DEFINITIONS: Record<ItemId, ItemDefinition> = {
  // Raw ores & fuel
  iron_ore: Object.freeze({
    id: 'iron_ore',
    name: 'Iron Ore',
    category: 'raw',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  copper_ore: Object.freeze({
    id: 'copper_ore',
    name: 'Copper Ore',
    category: 'raw',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  coal: Object.freeze({
    id: 'coal',
    name: 'Coal',
    category: 'raw',
    stackSize: 50,
    fuelValueKj: 4000,
  }),
  stone: Object.freeze({
    id: 'stone',
    name: 'Stone',
    category: 'raw',
    stackSize: 50,
    fuelValueKj: 0,
  }),

  // Smelted plates & bricks
  iron_plate: Object.freeze({
    id: 'iron_plate',
    name: 'Iron Plate',
    category: 'smelted',
    stackSize: 100,
    fuelValueKj: 0,
  }),
  copper_plate: Object.freeze({
    id: 'copper_plate',
    name: 'Copper Plate',
    category: 'smelted',
    stackSize: 100,
    fuelValueKj: 0,
  }),
  stone_brick: Object.freeze({
    id: 'stone_brick',
    name: 'Stone Brick',
    category: 'smelted',
    stackSize: 100,
    fuelValueKj: 0,
  }),
  steel_plate: Object.freeze({
    id: 'steel_plate',
    name: 'Steel Plate',
    category: 'smelted',
    stackSize: 100,
    fuelValueKj: 0,
  }),

  // Intermediates
  iron_gear: Object.freeze({
    id: 'iron_gear',
    name: 'Iron Gear',
    category: 'intermediate',
    stackSize: 100,
    fuelValueKj: 0,
  }),
  copper_cable: Object.freeze({
    id: 'copper_cable',
    name: 'Copper Cable',
    category: 'intermediate',
    stackSize: 200,
    fuelValueKj: 0,
  }),
  electronic_circuit: Object.freeze({
    id: 'electronic_circuit',
    name: 'Electronic Circuit',
    category: 'intermediate',
    stackSize: 200,
    fuelValueKj: 0,
  }),

  // Logistics & infrastructure
  transport_belt: Object.freeze({
    id: 'transport_belt',
    name: 'Transport Belt',
    category: 'logistics',
    stackSize: 100,
    fuelValueKj: 0,
  }),
  underground_belt: Object.freeze({
    id: 'underground_belt',
    name: 'Underground Belt',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  splitter: Object.freeze({
    id: 'splitter',
    name: 'Splitter',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  inserter: Object.freeze({
    id: 'inserter',
    name: 'Inserter',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  filter_inserter: Object.freeze({
    id: 'filter_inserter',
    name: 'Filter Inserter',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  power_pole: Object.freeze({
    id: 'power_pole',
    name: 'Power Pole',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  wooden_chest: Object.freeze({
    id: 'wooden_chest',
    name: 'Wooden Chest',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),
  iron_chest: Object.freeze({
    id: 'iron_chest',
    name: 'Iron Chest',
    category: 'logistics',
    stackSize: 50,
    fuelValueKj: 0,
  }),

  // Science packs
  red_science: Object.freeze({
    id: 'red_science',
    name: 'Red Science Pack',
    category: 'science',
    stackSize: 200,
    fuelValueKj: 0,
  }),
  green_science: Object.freeze({
    id: 'green_science',
    name: 'Green Science Pack',
    category: 'science',
    stackSize: 200,
    fuelValueKj: 0,
  }),
};

export const ITEM_REGISTRY: Readonly<Record<ItemId, ItemDefinition>> =
  Object.freeze(RAW_ITEM_DEFINITIONS);

export const ALL_ITEM_IDS: readonly ItemId[] = Object.freeze(
  Object.keys(ITEM_REGISTRY) as ItemId[]
);

/**
 * Type guard verifying whether an arbitrary string is a registered canonical ItemId.
 * Uses hasOwnProperty to reject prototype keys such as "toString" or "__proto__".
 */
export function isValidItemId(id: string): id is ItemId {
  return Object.prototype.hasOwnProperty.call(ITEM_REGISTRY, id);
}

/**
 * Fail-closed assertion that an item ID exists in the canonical registry.
 * Throws UnknownItemError if invalid.
 */
export function assertValidItemId(id: string): asserts id is ItemId {
  if (!isValidItemId(id)) {
    throw new UnknownItemError(id);
  }
}

/**
 * Returns the canonical ItemDefinition for a given ItemId.
 * Fails closed with UnknownItemError for unknown IDs.
 */
export function getItemDefinition(id: string): ItemDefinition {
  assertValidItemId(id);
  return ITEM_REGISTRY[id];
}

/**
 * Returns the maximum stack size for a registered item.
 * Fails closed with UnknownItemError for unknown IDs.
 */
export function getStackSize(id: string): number {
  return getItemDefinition(id).stackSize;
}

/**
 * Returns the fuel energy value in kJ for a registered item (0 if non-burnable).
 * Fails closed with UnknownItemError for unknown IDs.
 */
export function getFuelValueKj(id: string): number {
  return getItemDefinition(id).fuelValueKj;
}

/**
 * Returns true if the registered item has a positive fuel value.
 * Fails closed with UnknownItemError for unknown IDs.
 */
export function isFuelItem(id: string): boolean {
  return getFuelValueKj(id) > 0;
}

/**
 * Returns all canonical ItemDefinitions in deterministic registration order.
 */
export function getAllItems(): readonly ItemDefinition[] {
  return ALL_ITEM_IDS.map((id) => ITEM_REGISTRY[id]);
}

/**
 * Returns all canonical ItemDefinitions belonging to a given category,
 * preserving deterministic registration order.
 */
export function getItemsByCategory(category: ItemCategory): readonly ItemDefinition[] {
  return ALL_ITEM_IDS.map((id) => ITEM_REGISTRY[id]).filter(
    (def) => def.category === category
  );
}
