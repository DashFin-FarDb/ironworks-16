import { describe, expect, it } from 'vitest';
import {
  SimulationError,
  type Direction,
  type Entity,
  type ResourceType,
  type Tile,
  type WorldState,
} from '../src/types/contracts';
import { EventBus } from '../src/core/eventBus';
import { getItemCount, insertItem } from '../src/core/inventory';
import { getStackSize } from '../src/core/itemRegistry';
import { countBeltItems, createBeltEntity, insertOnBelt } from '../src/logistics/belt';
import { createWoodenChest } from '../src/logistics/chest';
import { createResourceNode } from '../src/machines/resourceNode';
import { createStoneFurnace } from '../src/machines/stoneFurnace';
import {
  BURNER_DRILL_FUEL_BURN_KJ_PER_TICK,
  BURNER_DRILL_MINING_TICKS,
  createBurnerDrill,
  getBurnerDrillOutputCoord,
  insertBurnerDrillFuel,
  tickAllBurnerDrills,
  tickBurnerDrill,
} from '../src/machines/burnerDrill';

function createTestWorld(width = 16, height = 16): WorldState {
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

function placeEntity(world: WorldState, entity: Entity): void {
  world.entities[entity.id] = entity;
  const tile = world.tiles[entity.position.y * world.width + entity.position.x]!;
  tile.entityId = entity.id;
}

function setResource(
  world: WorldState,
  x: number,
  y: number,
  type: ResourceType,
  amount: number
): void {
  const tile = world.tiles[y * world.width + x]!;
  tile.resource = createResourceNode(type, amount);
}

describe('T22: Burner Mining Drill (src/machines/burnerDrill.ts)', () => {
  it('mines exactly 1 ore every 90 ticks onto a belt on its front tile', () => {
    const world = createTestWorld();
    setResource(world, 5, 5, 'iron_ore', 100);

    const drill = createBurnerDrill(1, { x: 5, y: 5 }, 'E');
    const belt = createBeltEntity(2, { x: 6, y: 5 }, 'E');
    placeEntity(world, drill);
    placeEntity(world, belt);
    insertBurnerDrillFuel(drill, 'coal', 1);

    expect(getBurnerDrillOutputCoord(drill)).toEqual({ x: 6, y: 5 });

    const bus = new EventBus();
    const produced: Array<{ tick: number; itemId: string; count: number; entityId: number }> = [];
    bus.on('itemProduced', (ev) => produced.push(ev));

    // First 89 ticks: active, no ore mined yet
    for (let t = 1; t < BURNER_DRILL_MINING_TICKS; t++) {
      world.tick = t;
      const res = tickBurnerDrill(world, drill, { eventBus: bus });
      expect(res.active).toBe(true);
      expect(res.mined).toBe(false);
      expect(res.haltReason).toBeNull();
      expect(res.fuelBurnedKj).toBe(BURNER_DRILL_FUEL_BURN_KJ_PER_TICK);
    }
    expect(countBeltItems(belt)).toBe(0);
    expect(world.tiles[5 * world.width + 5]!.resource!.amount).toBe(100);

    // Tick 90: mines 1 iron_ore onto the front belt
    world.tick = BURNER_DRILL_MINING_TICKS;
    const res90 = tickBurnerDrill(world, drill, { eventBus: bus });
    expect(res90.active).toBe(true);
    expect(res90.mined).toBe(true);
    expect(res90.minedItem).toBe('iron_ore');
    expect(res90.haltReason).toBeNull();
    expect(drill.miningProgress).toBe(0);
    expect(countBeltItems(belt)).toBe(1);
    expect(world.tiles[5 * world.width + 5]!.resource!.amount).toBe(99);
    expect(produced).toEqual([
      { tick: 90, itemId: 'iron_ore', count: 1, entityId: 1 },
    ]);
  });

  it('supports all 4 facing directions and drops directly into chests and furnaces', () => {
    const dirs: Array<{ dir: Direction; dx: number; dy: number }> = [
      { dir: 'N', dx: 0, dy: -1 },
      { dir: 'E', dx: 1, dy: 0 },
      { dir: 'S', dx: 0, dy: 1 },
      { dir: 'W', dx: -1, dy: 0 },
    ];

    for (const { dir, dx, dy } of dirs) {
      const world = createTestWorld();
      setResource(world, 4, 4, 'copper_ore', 10);
      const drill = createBurnerDrill(1, { x: 4, y: 4 }, dir);
      const chest = createWoodenChest(2, { x: 4 + dx, y: 4 + dy });
      placeEntity(world, drill);
      placeEntity(world, chest);
      insertBurnerDrillFuel(drill, 'coal', 1);

      for (let t = 0; t < BURNER_DRILL_MINING_TICKS; t++) {
        tickBurnerDrill(world, drill);
      }

      expect(getItemCount(chest.inventory, 'copper_ore')).toBe(1);
      expect(world.tiles[4 * world.width + 4]!.resource!.amount).toBe(9);
    }

    // Coal mined directly into a Stone Furnace routes to fuelInventory
    const furnaceWorld = createTestWorld();
    setResource(furnaceWorld, 3, 3, 'coal', 5);
    const coalDrill = createBurnerDrill(1, { x: 3, y: 3 }, 'S');
    const furnace = createStoneFurnace(2, { x: 3, y: 4 }, 'N');
    placeEntity(furnaceWorld, coalDrill);
    placeEntity(furnaceWorld, furnace);
    insertBurnerDrillFuel(coalDrill, 'coal', 1);

    for (let t = 0; t < BURNER_DRILL_MINING_TICKS; t++) {
      tickBurnerDrill(furnaceWorld, coalDrill);
    }
    expect(getItemCount(furnace.fuelInventory, 'coal')).toBe(1);
  });

  it('halts cleanly when out of fuel, preserves progress, and resumes on refuel', () => {
    const world = createTestWorld();
    setResource(world, 5, 5, 'iron_ore', 50);
    const drill = createBurnerDrill(1, { x: 5, y: 5 }, 'E');
    const chest = createWoodenChest(2, { x: 6, y: 5 });
    placeEntity(world, drill);
    placeEntity(world, chest);

    // Give exact fuel for 40 ticks
    drill.fuelEnergyKj = 40 * BURNER_DRILL_FUEL_BURN_KJ_PER_TICK;

    for (let t = 0; t < 40; t++) {
      const r = tickBurnerDrill(world, drill);
      expect(r.active).toBe(true);
    }
    expect(drill.miningProgress).toBe(40);
    expect(drill.fuelEnergyKj).toBe(0);

    // Tick 41: out of fuel -> halts cleanly, progress preserved
    const halted = tickBurnerDrill(world, drill);
    expect(halted.active).toBe(false);
    expect(halted.mined).toBe(false);
    expect(halted.fuelBurnedKj).toBe(0);
    expect(halted.haltReason).toBe('no_fuel');
    expect(drill.miningProgress).toBe(40);

    // Refuel and run remaining 50 ticks -> completes ore
    insertBurnerDrillFuel(drill, 'coal', 1);
    for (let t = 0; t < 50; t++) {
      tickBurnerDrill(world, drill);
    }
    expect(getItemCount(chest.inventory, 'iron_ore')).toBe(1);
    expect(drill.miningProgress).toBe(0);
  });

  it('halts cleanly with zero fuel burn and zero ore loss when output is blocked', () => {
    const world = createTestWorld();
    setResource(world, 5, 5, 'iron_ore', 20);
    const drill = createBurnerDrill(1, { x: 5, y: 5 }, 'E');
    placeEntity(world, drill);
    insertBurnerDrillFuel(drill, 'coal', 2);

    // Case 1: Empty front tile (no receiver entity)
    const noTarget = tickBurnerDrill(world, drill);
    expect(noTarget.active).toBe(false);
    expect(noTarget.haltReason).toBe('output_blocked');
    expect(noTarget.fuelBurnedKj).toBe(0);
    expect(getItemCount(drill.fuelInventory, 'coal')).toBe(2);

    // Case 2: Blocked belt (both lanes occupied at drop offset 0.5)
    const belt = createBeltEntity(2, { x: 6, y: 5 }, 'E');
    placeEntity(world, belt);
    insertOnBelt(belt, 'right', 'iron_ore', 0.5);
    insertOnBelt(belt, 'left', 'iron_ore', 0.5);

    const blockedBelt = tickBurnerDrill(world, drill);
    expect(blockedBelt.active).toBe(false);
    expect(blockedBelt.haltReason).toBe('output_blocked');
    expect(blockedBelt.fuelBurnedKj).toBe(0);
    expect(world.tiles[5 * world.width + 5]!.resource!.amount).toBe(20);
    expect(countBeltItems(belt)).toBe(2);

    // Case 3: Full chest
    const chest = createWoodenChest(3, { x: 6, y: 5 });
    placeEntity(world, chest);
    for (let i = 0; i < chest.inventory.capacity; i++) {
      insertItem(chest.inventory, 'iron_ore', 50, getStackSize);
    }
    const fullChest = tickBurnerDrill(world, drill);
    expect(fullChest.active).toBe(false);
    expect(fullChest.haltReason).toBe('output_blocked');
    expect(fullChest.fuelBurnedKj).toBe(0);

    // Case 4: Out-of-bounds front tile
    const edgeWorld = createTestWorld(4, 4);
    setResource(edgeWorld, 3, 0, 'stone', 10);
    const edgeDrill = createBurnerDrill(1, { x: 3, y: 0 }, 'N');
    placeEntity(edgeWorld, edgeDrill);
    insertBurnerDrillFuel(edgeDrill, 'coal', 1);
    const oob = tickBurnerDrill(edgeWorld, edgeDrill);
    expect(oob.active).toBe(false);
    expect(oob.haltReason).toBe('out_of_bounds_output');
    expect(oob.fuelBurnedKj).toBe(0);
  });

  it('depletes finite ore cleanly and halts on subsequent ticks without burning fuel', () => {
    const world = createTestWorld();
    setResource(world, 2, 2, 'stone', 1);
    const drill = createBurnerDrill(1, { x: 2, y: 2 }, 'E');
    const chest = createWoodenChest(2, { x: 3, y: 2 });
    placeEntity(world, drill);
    placeEntity(world, chest);
    insertBurnerDrillFuel(drill, 'coal', 1);

    for (let t = 0; t < BURNER_DRILL_MINING_TICKS; t++) {
      tickBurnerDrill(world, drill);
    }

    expect(getItemCount(chest.inventory, 'stone')).toBe(1);
    expect(world.tiles[2 * world.width + 2]!.resource).toBeNull();

    const fuelBefore = drill.fuelEnergyKj;
    const afterDepletion = tickBurnerDrill(world, drill);
    expect(afterDepletion.active).toBe(false);
    expect(afterDepletion.mined).toBe(false);
    expect(afterDepletion.fuelBurnedKj).toBe(0);
    expect(afterDepletion.haltReason).toBe('no_resource');
    expect(drill.fuelEnergyKj).toBe(fuelBefore);
  });

  it('fails closed on non-fuel items and corrupted state', () => {
    const world = createTestWorld();
    setResource(world, 2, 2, 'iron_ore', 10);
    const drill = createBurnerDrill(1, { x: 2, y: 2 }, 'E');
    placeEntity(world, drill);

    expect(() => insertBurnerDrillFuel(drill, 'iron_ore', 1)).toThrow(SimulationError);

    drill.fuelEnergyKj = Number.NaN;
    expect(() => tickBurnerDrill(world, drill)).toThrow(SimulationError);

    drill.fuelEnergyKj = 0;
    expect(() => tickBurnerDrill(world, drill, { miningTicks: 0 })).toThrow(SimulationError);
    expect(() => tickBurnerDrill(world, drill, { fuelBurnKjPerTick: -1 })).toThrow(SimulationError);
  });

  it('ticks all burner drills deterministically in ascending EntityId order', () => {
    const run = () => {
      const world = createTestWorld();
      setResource(world, 2, 2, 'iron_ore', 50);
      setResource(world, 2, 4, 'copper_ore', 50);

      const d10 = createBurnerDrill(10, { x: 2, y: 2 }, 'E');
      const d3 = createBurnerDrill(3, { x: 2, y: 4 }, 'E');
      const c1 = createWoodenChest(11, { x: 3, y: 2 });
      const c2 = createWoodenChest(12, { x: 3, y: 4 });
      placeEntity(world, d10);
      placeEntity(world, d3);
      placeEntity(world, c1);
      placeEntity(world, c2);
      insertBurnerDrillFuel(d10, 'coal', 1);
      insertBurnerDrillFuel(d3, 'coal', 1);

      let lastResults = tickAllBurnerDrills(world);
      for (let t = 1; t < BURNER_DRILL_MINING_TICKS; t++) {
        world.tick = t;
        lastResults = tickAllBurnerDrills(world);
      }
      return {
        order: lastResults.map((r) => r.entityId),
        state: JSON.stringify(world),
      };
    };

    const r1 = run();
    const r2 = run();
    expect(r1.order).toEqual([3, 10]);
    expect(r1.state).toBe(r2.state);
  });
});
