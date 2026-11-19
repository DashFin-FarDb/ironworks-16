import { describe, expect, it } from 'vitest';
import {
  INSERTER_DROP_TICKS,
  INSERTER_PICK_TICKS,
  INSERTER_RETURN_TICKS,
  INSERTER_SWING_TICKS,
  computeInserterArmAngle,
  createInserterEntity,
  directionToAngle,
  getInserterSourceCoord,
  getInserterTargetCoord,
  stepInserter,
  tickAllInserters,
  tickInserter,
} from '../src/logistics/inserter.js';
import { createBeltEntity, insertOnBelt, countBeltItems } from '../src/logistics/belt.js';
import { createWoodenChest, insertIntoChest, getChestTotalItems } from '../src/logistics/chest.js';
import { createInventoryState, getItemCount, insertItem, removeItem } from '../src/core/inventory.js';
import {
  SimulationError,
  type ItemId,
  type StoneFurnaceEntity,
  type Tile,
  type WorldState,
} from '../src/types/contracts.js';

function createTestWorld(width = 8, height = 8): WorldState {
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
  const idx = entity.position.y * world.width + entity.position.x;
  world.tiles[idx]!.entityId = entity.id;
}

describe('T15: Inserter State Machine (src/logistics/inserter.ts)', () => {
  it('computes source and target coordinates for all 4 directions', () => {
    const pos = { x: 4, y: 4 };

    const east = createInserterEntity(1, pos, 'E');
    expect(getInserterSourceCoord(east)).toEqual({ x: 3, y: 4 });
    expect(getInserterTargetCoord(east)).toEqual({ x: 5, y: 4 });

    const west = createInserterEntity(2, pos, 'W');
    expect(getInserterSourceCoord(west)).toEqual({ x: 5, y: 4 });
    expect(getInserterTargetCoord(west)).toEqual({ x: 3, y: 4 });

    const north = createInserterEntity(3, pos, 'N');
    expect(getInserterSourceCoord(north)).toEqual({ x: 4, y: 5 });
    expect(getInserterTargetCoord(north)).toEqual({ x: 4, y: 3 });

    const south = createInserterEntity(4, pos, 'S');
    expect(getInserterSourceCoord(south)).toEqual({ x: 4, y: 3 });
    expect(getInserterTargetCoord(south)).toEqual({ x: 4, y: 5 });
  });

  it('executes the full state machine lifecycle: idle -> picking -> swinging -> dropping -> returning -> idle', () => {
    const inserter = createInserterEntity(1, { x: 2, y: 2 }, 'E');
    const source: ItemId[] = ['iron_ore'];
    const target: ItemId[] = [];

    const io = {
      canPick: () => source.length > 0,
      pick: () => source.shift() ?? null,
      drop: (item: ItemId) => {
        target.push(item);
        return true;
      },
    };

    expect(inserter.phase).toBe('idle');
    expect(inserter.armAngle).toBeCloseTo(directionToAngle('W'));

    // Tick 1: idle -> picking
    const t1 = stepInserter(inserter, io);
    expect(t1.previousPhase).toBe('idle');
    expect(t1.currentPhase).toBe('picking');
    expect(inserter.active).toBe(true);
    expect(inserter.heldItem).toBeNull();

    // Ticks during picking
    for (let i = 0; i < INSERTER_PICK_TICKS - 1; i++) {
      const r = stepInserter(inserter, io);
      expect(r.currentPhase).toBe('picking');
      expect(inserter.heldItem).toBeNull();
    }
    const pickDone = stepInserter(inserter, io);
    expect(pickDone.pickedItem).toBe('iron_ore');
    expect(pickDone.currentPhase).toBe('swinging');
    expect(inserter.heldItem).toBe('iron_ore');
    expect(source.length).toBe(0);

    // Ticks during swinging
    for (let i = 0; i < INSERTER_SWING_TICKS - 1; i++) {
      const r = stepInserter(inserter, io);
      expect(r.currentPhase).toBe('swinging');
      expect(inserter.heldItem).toBe('iron_ore');
    }
    const swingDone = stepInserter(inserter, io);
    expect(swingDone.currentPhase).toBe('dropping');
    expect(inserter.armAngle).toBeCloseTo(directionToAngle('E'));

    // Ticks during dropping
    for (let i = 0; i < INSERTER_DROP_TICKS - 1; i++) {
      const r = stepInserter(inserter, io);
      expect(r.currentPhase).toBe('dropping');
    }
    const dropDone = stepInserter(inserter, io);
    expect(dropDone.droppedItem).toBe('iron_ore');
    expect(dropDone.currentPhase).toBe('returning');
    expect(inserter.heldItem).toBeNull();
    expect(target).toEqual(['iron_ore']);

    // Ticks during returning
    for (let i = 0; i < INSERTER_RETURN_TICKS - 1; i++) {
      const r = stepInserter(inserter, io);
      expect(r.currentPhase).toBe('returning');
    }
    const returnDone = stepInserter(inserter, io);
    expect(returnDone.currentPhase).toBe('idle');
    expect(inserter.active).toBe(false);
    expect(inserter.armAngle).toBeCloseTo(computeInserterArmAngle('E', 'idle', 0));
  });

  it('halts cleanly in dropping under target backpressure and resumes without item loss', () => {
    const inserter = createInserterEntity(1, { x: 2, y: 2 }, 'E');
    const source: ItemId[] = ['iron_plate'];
    const target: ItemId[] = [];
    let allowDrop = false;

    const io = {
      canPick: () => source.length > 0,
      pick: () => source.shift() ?? null,
      drop: (item: ItemId) => {
        if (!allowDrop) return false;
        target.push(item);
        return true;
      },
    };

    // Run until blocked in dropping
    const timing = { pickTicks: 2, swingTicks: 2, dropTicks: 2, returnTicks: 2 };
    for (let i = 0; i < 15; i++) {
      stepInserter(inserter, io, { timing });
    }

    expect(inserter.phase).toBe('dropping');
    expect(inserter.phaseProgress).toBe(1);
    expect(inserter.heldItem).toBe('iron_plate');
    expect(inserter.active).toBe(false);
    expect(target.length).toBe(0);

    // Unblock target
    allowDrop = true;
    const unblocked = stepInserter(inserter, io, { timing });
    expect(unblocked.blocked).toBe(false);
    expect(unblocked.droppedItem).toBe('iron_plate');
    expect(unblocked.currentPhase).toBe('returning');
    expect(inserter.heldItem).toBeNull();
    expect(target).toEqual(['iron_plate']);
  });

  it('returns cleanly to idle if source item disappears before picking completes', () => {
    const inserter = createInserterEntity(1, { x: 2, y: 2 }, 'E');
    let available = true;
    const io = {
      canPick: () => available,
      pick: () => (available ? 'coal' as ItemId : null),
      drop: () => true,
    };
    const timing = { pickTicks: 3, swingTicks: 3, dropTicks: 3, returnTicks: 3 };

    stepInserter(inserter, io, { timing }); // idle -> picking
    expect(inserter.phase).toBe('picking');

    // Another inserter steals the item mid-pick
    available = false;
    stepInserter(inserter, io, { timing });
    stepInserter(inserter, io, { timing });
    const done = stepInserter(inserter, io, { timing });

    expect(done.pickedItem).toBeNull();
    expect(done.currentPhase).toBe('idle');
    expect(inserter.heldItem).toBeNull();
    expect(inserter.active).toBe(false);
  });

  it('conserves 100% of items across chest -> inserter -> chest and belt -> inserter -> chest in WorldState', () => {
    const world = createTestWorld();
    const srcChest = createWoodenChest(1, { x: 1, y: 2 });
    const inserter1 = createInserterEntity(2, { x: 2, y: 2 }, 'E');
    const belt = createBeltEntity(3, { x: 3, y: 2 }, 'E');
    const inserter2 = createInserterEntity(4, { x: 4, y: 2 }, 'E');
    const dstChest = createWoodenChest(5, { x: 5, y: 2 });

    insertIntoChest(srcChest, 'iron_ore', 5);
    placeEntity(world, srcChest);
    placeEntity(world, inserter1);
    placeEntity(world, belt);
    placeEntity(world, inserter2);
    placeEntity(world, dstChest);

    const totalItems = () =>
      getChestTotalItems(srcChest) +
      (inserter1.heldItem ? 1 : 0) +
      countBeltItems(belt) +
      (inserter2.heldItem ? 1 : 0) +
      getChestTotalItems(dstChest);

    for (let tick = 0; tick < 350; tick++) {
      tickAllInserters(world);
      // Strict mass conservation at every single tick
      expect(totalItems()).toBe(5);
    }

    expect(getChestTotalItems(srcChest)).toBe(0);
    expect(getChestTotalItems(dstChest)).toBe(5);
    expect(inserter1.heldItem).toBeNull();
    expect(inserter2.heldItem).toBeNull();
    expect(countBeltItems(belt)).toBe(0);
  });

  it('routes fuel to fuelInventory and ore to inputInventory on a StoneFurnace', () => {
    const world = createTestWorld();
    const belt = createBeltEntity(1, { x: 1, y: 1 }, 'E');
    const inserter = createInserterEntity(2, { x: 2, y: 1 }, 'E');
    const furnace: StoneFurnaceEntity = {
      id: 3,
      type: 'stone_furnace',
      position: { x: 3, y: 1 },
      direction: 'N',
      footprint: { width: 2, height: 2 },
      powerNetworkId: null,
      active: false,
      inputInventory: createInventoryState(1),
      outputInventory: createInventoryState(1),
      fuelInventory: createInventoryState(1),
      fuelEnergyKj: 0,
      activeRecipe: null,
      craftingProgress: 0,
    };

    insertOnBelt(belt, 'left', 'coal', 0.8);
    insertOnBelt(belt, 'right', 'iron_ore', 0.5);
    placeEntity(world, belt);
    placeEntity(world, inserter);
    placeEntity(world, furnace);

    for (let i = 0; i < 120; i++) {
      tickInserter(world, inserter);
    }

    expect(getItemCount(furnace.fuelInventory, 'coal')).toBe(1);
    expect(getItemCount(furnace.inputInventory, 'iron_ore')).toBe(1);
    expect(countBeltItems(belt)).toBe(0);
  });

  it('halts cleanly at speed 0 and fails closed on invalid speed or timing', () => {
    const inserter = createInserterEntity(1, { x: 1, y: 1 }, 'E');
    const io = {
      canPick: () => true,
      pick: () => 'iron_ore' as ItemId,
      drop: () => true,
    };

    const halted = stepInserter(inserter, io, { speed: 0 });
    expect(halted.currentPhase).toBe('idle');
    expect(inserter.phaseProgress).toBe(0);
    expect(inserter.active).toBe(false);

    expect(() => stepInserter(inserter, io, { speed: Number.NaN })).toThrow(SimulationError);
    expect(() => stepInserter(inserter, io, { speed: -1 })).toThrow(SimulationError);
    expect(() =>
      stepInserter(inserter, io, { timing: { swingTicks: 0 } })
    ).toThrow(SimulationError);
  });

  it('is strictly deterministic across two independent runs', () => {
    const run = () => {
      const world = createTestWorld();
      const src = createWoodenChest(1, { x: 1, y: 1 });
      const ins = createInserterEntity(2, { x: 2, y: 1 }, 'E');
      const dst = createWoodenChest(3, { x: 3, y: 1 });
      insertItem(src.inventory, 'copper_ore', 3);
      placeEntity(world, src);
      placeEntity(world, ins);
      placeEntity(world, dst);

      for (let t = 0; t < 100; t++) {
        tickAllInserters(world);
      }
      // Also verify removeItem doesn't drift
      removeItem(dst.inventory, 'copper_ore', 0);
      return JSON.stringify({ src, ins, dst });
    };

    expect(run()).toBe(run());
  });
});
