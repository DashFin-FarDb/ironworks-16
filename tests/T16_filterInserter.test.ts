import { describe, expect, it } from 'vitest';
import {
  type ChestEntity,
  type ItemId,
  type Tile,
  type WorldState,
  SimulationError,
  UnknownItemError,
} from '../src/types/contracts.js';
import { createInventoryState, getItemCount, insertItem } from '../src/core/inventory.js';
import { getStackSize } from '../src/core/itemRegistry.js';
import { createBeltEntity, insertOnBelt, countBeltItems } from '../src/logistics/belt.js';
import { INSERTER_CYCLE_TICKS } from '../src/logistics/inserter.js';
import {
  MAX_FILTER_SLOTS,
  addFilterInserterFilter,
  clearFilterInserterFilters,
  createFilterInserterEntity,
  isItemAllowedByFilter,
  removeFilterInserterFilter,
  setFilterInserterFilters,
  stepFilterInserter,
  tickAllFilterInserters,
  tickFilterInserter,
} from '../src/logistics/filterInserter.js';

function createTestWorld(width = 10, height = 10): WorldState {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        terrain: 'grass',
        resource: null,
        entityId: null,
      });
    }
  }
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width,
    height,
    tiles,
    entities: {},
    nextEntityId: 1,
    powerGrid: { networks: {}, nextNetworkId: 1 },
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

function placeEntity(world: WorldState, entity: WorldState['entities'][number]): void {
  world.entities[entity.id] = entity;
  const tile = world.tiles[entity.position.y * world.width + entity.position.x];
  if (tile) {
    tile.entityId = entity.id;
  }
}

function createChest(id: number, x: number, y: number, capacity = 16): ChestEntity {
  return {
    id,
    type: 'wooden_chest',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    inventory: createInventoryState(capacity),
  };
}

describe('T16: Filter Inserter', () => {
  it('creates a filter inserter with up to 3 deduplicated valid ItemIds', () => {
    const fi = createFilterInserterEntity(1, { x: 2, y: 2 }, 'E', [
      'iron_ore',
      'copper_ore',
      'iron_ore',
      'coal',
    ]);
    expect(fi.type).toBe('filter_inserter');
    expect(fi.phase).toBe('idle');
    expect(fi.filters).toEqual(['iron_ore', 'copper_ore', 'coal']);
    expect(fi.filters.length).toBe(MAX_FILTER_SLOTS);
    expect(isItemAllowedByFilter(fi, 'iron_ore')).toBe(true);
    expect(isItemAllowedByFilter(fi, 'stone')).toBe(false);
  });

  it('fails closed when exceeding 3 unique filters or using unknown ItemIds', () => {
    expect(() =>
      createFilterInserterEntity(1, { x: 0, y: 0 }, 'E', [
        'iron_ore',
        'copper_ore',
        'coal',
        'stone',
      ])
    ).toThrow(SimulationError);

    expect(() =>
      createFilterInserterEntity(1, { x: 0, y: 0 }, 'E', [
        'not_a_real_item' as ItemId,
      ])
    ).toThrow(UnknownItemError);

    const fi = createFilterInserterEntity(2, { x: 1, y: 1 }, 'E', [
      'iron_ore',
      'copper_ore',
      'coal',
    ]);
    expect(addFilterInserterFilter(fi, 'iron_ore')).toBe(false);
    expect(() => addFilterInserterFilter(fi, 'stone')).toThrow(SimulationError);
    expect(() =>
      setFilterInserterFilters(fi, ['iron_ore', 'copper_ore', 'coal', 'stone'])
    ).toThrow(SimulationError);
  });

  it('supports adding, removing, and clearing filters', () => {
    const fi = createFilterInserterEntity(1, { x: 0, y: 0 }, 'N');
    expect(fi.filters).toEqual([]);
    expect(addFilterInserterFilter(fi, 'iron_plate')).toBe(true);
    expect(addFilterInserterFilter(fi, 'copper_plate')).toBe(true);
    expect(removeFilterInserterFilter(fi, 'iron_plate')).toBe(true);
    expect(removeFilterInserterFilter(fi, 'iron_plate')).toBe(false);
    expect(fi.filters).toEqual(['copper_plate']);

    clearFilterInserterFilters(fi);
    expect(fi.filters).toEqual([]);
    expect(isItemAllowedByFilter(fi, 'copper_plate')).toBe(false);
  });

  it('fails closed on empty whitelist and picks nothing', () => {
    const world = createTestWorld();
    const src = createChest(1, 1, 2);
    const fi = createFilterInserterEntity(2, { x: 2, y: 2 }, 'E', []);
    const dst = createChest(3, 3, 2);

    insertItem(src.inventory, 'iron_ore', 5, getStackSize);
    placeEntity(world, src);
    placeEntity(world, fi);
    placeEntity(world, dst);

    for (let t = 0; t < INSERTER_CYCLE_TICKS * 2; t++) {
      tickFilterInserter(world, fi);
    }

    expect(fi.phase).toBe('idle');
    expect(fi.heldItem).toBeNull();
    expect(getItemCount(src.inventory, 'iron_ore')).toBe(5);
    expect(getItemCount(dst.inventory, 'iron_ore')).toBe(0);
  });

  it('moves only whitelisted items (up to 3 types) from mixed chest to chest with 100% conservation', () => {
    const world = createTestWorld();
    const src = createChest(1, 1, 2);
    const fi = createFilterInserterEntity(2, { x: 2, y: 2 }, 'E', [
      'iron_ore',
      'copper_ore',
      'coal',
    ]);
    const dst = createChest(3, 3, 2);

    insertItem(src.inventory, 'stone', 4, getStackSize);
    insertItem(src.inventory, 'iron_ore', 2, getStackSize);
    insertItem(src.inventory, 'iron_plate', 3, getStackSize);
    insertItem(src.inventory, 'copper_ore', 2, getStackSize);
    insertItem(src.inventory, 'coal', 1, getStackSize);

    placeEntity(world, src);
    placeEntity(world, fi);
    placeEntity(world, dst);

    // 5 whitelisted items total; run enough ticks for 6 full cycles
    for (let t = 0; t < INSERTER_CYCLE_TICKS * 6 + 10; t++) {
      tickFilterInserter(world, fi);
    }

    expect(getItemCount(dst.inventory, 'iron_ore')).toBe(2);
    expect(getItemCount(dst.inventory, 'copper_ore')).toBe(2);
    expect(getItemCount(dst.inventory, 'coal')).toBe(1);
    expect(getItemCount(dst.inventory, 'stone')).toBe(0);
    expect(getItemCount(dst.inventory, 'iron_plate')).toBe(0);

    // Non-whitelisted items remain untouched in source
    expect(getItemCount(src.inventory, 'stone')).toBe(4);
    expect(getItemCount(src.inventory, 'iron_plate')).toBe(3);
    expect(getItemCount(src.inventory, 'iron_ore')).toBe(0);
    expect(getItemCount(src.inventory, 'copper_ore')).toBe(0);
    expect(getItemCount(src.inventory, 'coal')).toBe(0);
    expect(fi.heldItem).toBeNull();
  });

  it('filters items from a mixed belt without disturbing non-whitelisted belt items', () => {
    const world = createTestWorld();
    const belt = createBeltEntity(1, { x: 1, y: 2 }, 'S');
    const fi = createFilterInserterEntity(2, { x: 2, y: 2 }, 'E', ['copper_ore']);
    const dst = createChest(3, 3, 2);

    expect(insertOnBelt(belt, 'left', 'iron_ore', 0.2)).toBe(true);
    expect(insertOnBelt(belt, 'left', 'copper_ore', 0.7)).toBe(true);
    expect(insertOnBelt(belt, 'right', 'stone', 0.5)).toBe(true);

    placeEntity(world, belt);
    placeEntity(world, fi);
    placeEntity(world, dst);

    for (let t = 0; t < INSERTER_CYCLE_TICKS * 2 + 5; t++) {
      tickFilterInserter(world, fi);
    }

    expect(getItemCount(dst.inventory, 'copper_ore')).toBe(1);
    expect(getItemCount(dst.inventory, 'iron_ore')).toBe(0);
    expect(getItemCount(dst.inventory, 'stone')).toBe(0);
    expect(countBeltItems(belt)).toBe(2);
  });

  it('preserves heldItem if filters are cleared mid-swing (item conservation)', () => {
    const dropped: ItemId[] = [];
    const source: ItemId[] = ['iron_ore', 'iron_ore'];
    const fi = createFilterInserterEntity(1, { x: 2, y: 2 }, 'E', ['iron_ore']);

    const io = {
      canPick: (filter?: (id: ItemId) => boolean) =>
        source.some((id) => !filter || filter(id)),
      pick: (filter?: (id: ItemId) => boolean) => {
        const idx = source.findIndex((id) => !filter || filter(id));
        if (idx === -1) return null;
        return source.splice(idx, 1)[0] ?? null;
      },
      drop: (itemId: ItemId) => {
        dropped.push(itemId);
        return true;
      },
    };

    // Advance until item is picked and arm is swinging
    while (fi.phase !== 'swinging') {
      stepFilterInserter(fi, io);
    }
    expect(fi.heldItem).toBe('iron_ore');

    // Clear filters mid-swing
    clearFilterInserterFilters(fi);

    // Finish cycle; held item must still be dropped, and second item must not be picked
    for (let t = 0; t < INSERTER_CYCLE_TICKS * 2; t++) {
      stepFilterInserter(fi, io);
    }

    expect(dropped).toEqual(['iron_ore']);
    expect(source).toEqual(['iron_ore']);
    expect(fi.heldItem).toBeNull();
    expect(fi.phase).toBe('idle');
  });

  it('fails closed if filters array was mutated past MAX_FILTER_SLOTS externally', () => {
    const fi = createFilterInserterEntity(1, { x: 0, y: 0 }, 'E', ['iron_ore']);
    fi.filters.push('copper_ore', 'coal', 'stone');
    expect(() =>
      stepFilterInserter(fi, {
        pick: () => null,
        drop: () => true,
      })
    ).toThrow(SimulationError);
  });

  it('tickAllFilterInserters runs deterministically across two independent worlds', () => {
    function runSim(): string {
      const world = createTestWorld();
      const src1 = createChest(1, 1, 2);
      const fi1 = createFilterInserterEntity(2, { x: 2, y: 2 }, 'E', ['iron_ore']);
      const dst1 = createChest(3, 3, 2);
      const src2 = createChest(4, 1, 4);
      const fi2 = createFilterInserterEntity(5, { x: 2, y: 4 }, 'E', ['coal']);
      const dst2 = createChest(6, 3, 4);

      insertItem(src1.inventory, 'iron_ore', 3, getStackSize);
      insertItem(src1.inventory, 'coal', 3, getStackSize);
      insertItem(src2.inventory, 'iron_ore', 3, getStackSize);
      insertItem(src2.inventory, 'coal', 3, getStackSize);

      for (const e of [src1, fi1, dst1, src2, fi2, dst2]) {
        placeEntity(world, e);
      }

      for (let t = 0; t < INSERTER_CYCLE_TICKS * 2; t++) {
        tickAllFilterInserters(world);
      }
      return JSON.stringify(world);
    }

    expect(runSim()).toBe(runSim());
  });
});
