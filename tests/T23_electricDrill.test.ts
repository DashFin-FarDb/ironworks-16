import { describe, expect, it } from 'vitest';
import {
  Direction,
  ElectricDrillEntity,
  ItemProducedEvent,
  OutOfBoundsError,
  PowerNetwork,
  ResourceType,
  SimulationError,
  Tile,
  WorldState,
} from '../src/types/contracts';
import { EventBus } from '../src/core/eventBus';
import {
  createInventoryState,
  getItemCount,
  removeItem,
} from '../src/core/inventory';
import { createBeltEntity, countBeltItems } from '../src/logistics/belt';
import { createResourceNode } from '../src/machines/resourceNode';
import {
  ELECTRIC_DRILL_MINING_TICKS,
  ELECTRIC_DRILL_POWER_DEMAND_KW,
  createElectricDrill,
  getElectricDrillOutputCoord,
  tickAllElectricDrills,
  tickElectricDrill,
} from '../src/machines/electricDrill';

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
    powerGrid: {
      networks: {},
      nextNetworkId: 1,
    },
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: {
      cycleTick: 0,
      solarFactor: 1,
    },
    stats: {
      byItem: {},
    },
  };
}

function setResource(
  world: WorldState,
  x: number,
  y: number,
  type: ResourceType,
  amount: number
): void {
  const tile = world.tiles[y * world.width + x];
  if (!tile) {
    throw new Error(`Invalid test tile (${x}, ${y})`);
  }
  tile.resource = createResourceNode(type, amount);
}

function placeChest(world: WorldState, id: number, x: number, y: number, capacity = 16): void {
  world.entities[id] = {
    id,
    type: 'wooden_chest',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    inventory: createInventoryState(capacity),
  };
  world.tiles[y * world.width + x]!.entityId = id;
}

function attachPowerNetwork(
  world: WorldState,
  networkId: number,
  satisfaction: number,
  drills: ElectricDrillEntity[]
): void {
  const totalDemandKw = drills.reduce((sum, d) => sum + d.powerDemandKw, 0);
  const network: PowerNetwork = {
    id: networkId,
    poleIds: [],
    producerIds: [],
    consumerIds: drills.map((d) => d.id),
    accumulatorIds: [],
    totalSupplyKw: totalDemandKw * satisfaction,
    totalDemandKw,
    satisfaction,
  };
  world.powerGrid.networks[networkId] = network;
  for (const drill of drills) {
    drill.powerNetworkId = networkId;
  }
}

describe('T23: Electric Drill (src/machines/electricDrill.ts)', () => {
  it('creates an electric drill with canonical 90 kW demand and validates inputs', () => {
    const drill = createElectricDrill(1, { x: 3, y: 4 }, 'E');
    expect(drill.type).toBe('electric_drill');
    expect(drill.powerDemandKw).toBe(ELECTRIC_DRILL_POWER_DEMAND_KW);
    expect(drill.powerDemandKw).toBe(90);
    expect(drill.miningProgress).toBe(0);
    expect(drill.footprint).toEqual({ width: 1, height: 1 });
    expect(getElectricDrillOutputCoord(drill)).toEqual({ x: 4, y: 4 });

    expect(() => createElectricDrill(0, { x: 0, y: 0 })).toThrow(SimulationError);
    expect(() => createElectricDrill(1, { x: 1.5, y: 0 })).toThrow(SimulationError);
    expect(() =>
      createElectricDrill(1, { x: 0, y: 0 }, 'NE' as Direction)
    ).toThrow(SimulationError);
  });

  it('mines exactly 1 ore per 45 ticks at 100% power satisfaction onto a belt', () => {
    const world = createTestWorld();
    const eventBus = new EventBus();
    const events: ItemProducedEvent[] = [];
    eventBus.on('itemProduced', (e) => events.push(e));

    setResource(world, 2, 2, 'iron_ore', 10);
    const drill = createElectricDrill(1, { x: 2, y: 2 }, 'E');
    world.entities[1] = drill;
    world.tiles[2 * world.width + 2]!.entityId = 1;

    const belt = createBeltEntity(2, { x: 3, y: 2 }, 'E');
    world.entities[2] = belt;
    world.tiles[2 * world.width + 3]!.entityId = 2;

    attachPowerNetwork(world, 1, 1.0, [drill]);

    for (let tick = 1; tick < ELECTRIC_DRILL_MINING_TICKS; tick++) {
      world.tick = tick;
      const res = tickElectricDrill(world, drill, { eventBus });
      expect(res.mined).toBe(false);
      expect(res.active).toBe(true);
      expect(res.haltReason).toBeNull();
    }
    expect(countBeltItems(belt)).toBe(0);
    expect(world.tiles[2 * world.width + 2]!.resource?.amount).toBe(10);

    // Tick 45 completes 1 ore
    world.tick = ELECTRIC_DRILL_MINING_TICKS;
    const res45 = tickElectricDrill(world, drill, { eventBus });
    expect(res45.mined).toBe(true);
    expect(res45.itemId).toBe('iron_ore');
    expect(res45.active).toBe(true);
    expect(res45.powerSatisfaction).toBe(1);
    expect(drill.miningProgress).toBe(0);
    expect(countBeltItems(belt)).toBe(1);
    expect(world.tiles[2 * world.width + 2]!.resource?.amount).toBe(9);
    expect(events).toEqual([
      { tick: 45, itemId: 'iron_ore', count: 1, entityId: 1 },
    ]);
  });

  it('scales mining rate proportionally under 50% brownout (90 ticks per ore)', () => {
    const world = createTestWorld();
    setResource(world, 4, 4, 'copper_ore', 5);
    const drill = createElectricDrill(1, { x: 4, y: 4 }, 'S');
    world.entities[1] = drill;
    world.tiles[4 * world.width + 4]!.entityId = 1;
    placeChest(world, 2, 4, 5);

    attachPowerNetwork(world, 1, 0.5, [drill]);

    for (let tick = 1; tick < 90; tick++) {
      world.tick = tick;
      const res = tickElectricDrill(world, drill);
      expect(res.mined).toBe(false);
      expect(res.active).toBe(true);
      expect(res.progressDelta).toBeCloseTo(0.5, 10);
    }

    world.tick = 90;
    const res90 = tickElectricDrill(world, drill);
    expect(res90.mined).toBe(true);
    expect(res90.itemId).toBe('copper_ore');
    expect(res90.powerSatisfaction).toBe(0.5);

    const chest = world.entities[2]!;
    if (chest.type !== 'wooden_chest') throw new Error('Expected chest');
    expect(getItemCount(chest.inventory, 'copper_ore')).toBe(1);
    expect(world.tiles[4 * world.width + 4]!.resource?.amount).toBe(4);
  });

  it('halts cleanly with zero progress mutation when unconnected or at 0% power', () => {
    const world = createTestWorld();
    setResource(world, 1, 1, 'coal', 10);
    const drill = createElectricDrill(1, { x: 1, y: 1 }, 'E');
    world.entities[1] = drill;
    placeChest(world, 2, 2, 1);

    // Unconnected
    const resUnconnected = tickElectricDrill(world, drill);
    expect(resUnconnected.haltReason).toBe('no_power');
    expect(resUnconnected.active).toBe(false);
    expect(drill.miningProgress).toBe(0);

    // Connected to 0% blackout network
    attachPowerNetwork(world, 1, 0, [drill]);
    const resBlackout = tickElectricDrill(world, drill);
    expect(resBlackout.haltReason).toBe('no_power');
    expect(resBlackout.active).toBe(false);
    expect(drill.miningProgress).toBe(0);
    expect(world.tiles[1 * world.width + 1]!.resource?.amount).toBe(10);
  });

  it('preserves strict item conservation under output backpressure and resumes cleanly', () => {
    const world = createTestWorld();
    setResource(world, 2, 2, 'iron_ore', 5);
    const drill = createElectricDrill(1, { x: 2, y: 2 }, 'E');
    world.entities[1] = drill;
    // 1-slot chest with custom stackSize = 1 so it fills after 1 ore
    placeChest(world, 2, 3, 2, 1);
    attachPowerNetwork(world, 1, 1.0, [drill]);

    const getStackSize = () => 1;

    // Mine 1st ore (45 ticks) -> fills chest
    for (let t = 0; t < 45; t++) {
      tickElectricDrill(world, drill, { getStackSize });
    }
    const chest = world.entities[2]!;
    if (chest.type !== 'wooden_chest') throw new Error('Expected chest');
    expect(getItemCount(chest.inventory, 'iron_ore')).toBe(1);
    expect(world.tiles[2 * world.width + 2]!.resource?.amount).toBe(4);

    // Run 60 more ticks while chest is full -> must block at progress 45 without losing ore
    for (let t = 0; t < 60; t++) {
      tickElectricDrill(world, drill, { getStackSize });
    }
    const blockedRes = tickElectricDrill(world, drill, { getStackSize });
    expect(blockedRes.mined).toBe(false);
    expect(blockedRes.haltReason).toBe('output_blocked');
    expect(blockedRes.active).toBe(false);
    expect(drill.miningProgress).toBe(ELECTRIC_DRILL_MINING_TICKS);
    expect(world.tiles[2 * world.width + 2]!.resource?.amount).toBe(4);

    // Free space in chest -> next tick immediately delivers ready ore
    expect(removeItem(chest.inventory, 'iron_ore', 1)).toBe(1);
    const resumedRes = tickElectricDrill(world, drill, { getStackSize });
    expect(resumedRes.mined).toBe(true);
    expect(resumedRes.itemId).toBe('iron_ore');
    expect(resumedRes.active).toBe(true);
    expect(drill.miningProgress).toBe(0);
    expect(getItemCount(chest.inventory, 'iron_ore')).toBe(1);
    expect(world.tiles[2 * world.width + 2]!.resource?.amount).toBe(3);
  });

  it('depletes resource cleanly and halts with no_resource', () => {
    const world = createTestWorld();
    setResource(world, 3, 3, 'stone', 1);
    const drill = createElectricDrill(1, { x: 3, y: 3 }, 'N');
    world.entities[1] = drill;
    placeChest(world, 2, 3, 2);
    attachPowerNetwork(world, 1, 1.0, [drill]);

    let finalMine = null;
    for (let t = 0; t < 45; t++) {
      finalMine = tickElectricDrill(world, drill);
    }
    expect(finalMine?.mined).toBe(true);
    expect(finalMine?.depleted).toBe(true);
    expect(world.tiles[3 * world.width + 3]!.resource).toBeNull();

    const afterDepletion = tickElectricDrill(world, drill);
    expect(afterDepletion.mined).toBe(false);
    expect(afterDepletion.haltReason).toBe('no_resource');
    expect(afterDepletion.active).toBe(false);
  });

  it('ticks all electric drills in ascending EntityId order deterministically', () => {
    const world = createTestWorld();
    setResource(world, 1, 1, 'iron_ore', 5);
    setResource(world, 5, 5, 'copper_ore', 5);

    const drillHigh = createElectricDrill(10, { x: 5, y: 5 }, 'E');
    const drillLow = createElectricDrill(2, { x: 1, y: 1 }, 'E');
    world.entities[10] = drillHigh;
    world.entities[2] = drillLow;
    placeChest(world, 3, 2, 1);
    placeChest(world, 11, 6, 5);
    attachPowerNetwork(world, 1, 1.0, [drillHigh, drillLow]);

    const results = tickAllElectricDrills(world);
    expect(results.map((r) => r.entityId)).toEqual([2, 10]);
  });

  it('fails closed on corrupted drill state or out-of-bounds position', () => {
    const world = createTestWorld(4, 4);
    const drill = createElectricDrill(1, { x: 1, y: 1 }, 'E');
    attachPowerNetwork(world, 1, 1.0, [drill]);

    drill.miningProgress = Number.NaN;
    expect(() => tickElectricDrill(world, drill)).toThrow(SimulationError);

    drill.miningProgress = 0;
    drill.position = { x: 10, y: 10 };
    expect(() => tickElectricDrill(world, drill)).toThrow(OutOfBoundsError);
  });
});
