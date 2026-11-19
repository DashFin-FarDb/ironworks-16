import { describe, expect, it } from 'vitest';
import { EntityManager } from '../src/core/entityManager';
import {
  DEFAULT_SUPPLY_RADIUS,
  DEFAULT_WIRE_REACH,
  buildPowerGrid,
  canPolesConnect,
  createEmptyPowerGrid,
  getEntityPowerNetwork,
  getPowerNetwork,
  getUncoveredPowerEntities,
  getWireConnections,
  isEntityInSupplyRadius,
  isTileInSupplyRadius,
  rebuildPowerGrid,
} from '../src/logistics/powerGrid';
import {
  SimulationError,
  type Entity,
  type EntityId,
  type PowerPoleEntity,
  type WorldState,
} from '../src/types/contracts';

function makeMinimalWorld(entities: Record<EntityId, Entity>): WorldState {
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width: 64,
    height: 64,
    tiles: [],
    entities,
    nextEntityId: Object.keys(entities).length + 1,
    powerGrid: createEmptyPowerGrid(),
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

describe('T17: Power Grid & Graph Partitioning', () => {
  it('enforces default supplyRadius = 5 and wireReach = 7 geometry', () => {
    expect(DEFAULT_SUPPLY_RADIUS).toBe(5);
    expect(DEFAULT_WIRE_REACH).toBe(7);

    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    const poleA = em.spawn('power_pole', { x: 10, y: 10 });
    const poleAt7 = em.spawn('power_pole', { x: 17, y: 10 }); // dist = 7
    const poleAt8 = em.spawn('power_pole', { x: 18, y: 10 }); // dist = 8
    const poleDiagIn = em.spawn('power_pole', { x: 14, y: 15 }); // 4^2 + 5^2 = 41 <= 49
    const poleDiagOut = em.spawn('power_pole', { x: 15, y: 15 }); // 5^2 + 5^2 = 50 > 49

    expect(poleA.supplyRadius).toBe(5);
    expect(poleA.wireReach).toBe(7);

    expect(canPolesConnect(poleA, poleA)).toBe(false);
    expect(canPolesConnect(poleA, poleAt7)).toBe(true);
    expect(canPolesConnect(poleA, poleAt8)).toBe(false);
    expect(canPolesConnect(poleA, poleDiagIn)).toBe(true);
    expect(canPolesConnect(poleA, poleDiagOut)).toBe(false);

    // Square Chebyshev supply radius = 5
    expect(isTileInSupplyRadius({ x: 15, y: 15 }, poleA)).toBe(true);
    expect(isTileInSupplyRadius({ x: 5, y: 5 }, poleA)).toBe(true);
    expect(isTileInSupplyRadius({ x: 16, y: 10 }, poleA)).toBe(false);
    expect(isTileInSupplyRadius({ x: 10, y: 16 }, poleA)).toBe(false);
  });

  it('connects producers, consumers, and accumulators in a single network and ignores non-electric entities', () => {
    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    const pole = em.spawn('power_pole', { x: 20, y: 20 });
    const steam = em.spawn('steam_engine', { x: 18, y: 20 });
    const solar = em.spawn('solar_panel', { x: 22, y: 20 });
    const drill = em.spawn('electric_drill', { x: 20, y: 15 }); // dist 5
    const furnace = em.spawn('electric_furnace', { x: 25, y: 25 }); // Chebyshev 5
    const assembler = em.spawn('assembler_mk1', { x: 15, y: 15 }); // Chebyshev 5
    const lab = em.spawn('research_lab', { x: 20, y: 22 });
    const acc = em.spawn('accumulator', { x: 19, y: 21 });

    // Non-electric entities within radius should not be added to network
    const belt = em.spawn('transport_belt', { x: 20, y: 21 });
    const burner = em.spawn('burner_drill', { x: 21, y: 21 });
    const boiler = em.spawn('boiler', { x: 18, y: 21 });
    const chest = em.spawn('wooden_chest', { x: 21, y: 20 });

    const grid = buildPowerGrid(em.toRecord());

    expect(Object.keys(grid.networks)).toHaveLength(1);
    expect(grid.nextNetworkId).toBe(2);

    const net = getPowerNetwork(grid, 1);
    expect(net).toBeDefined();
    expect(net!.poleIds).toEqual([pole.id]);
    expect(net!.producerIds).toEqual([steam.id, solar.id]);
    expect(net!.consumerIds).toEqual([drill.id, furnace.id, assembler.id, lab.id]);
    expect(net!.accumulatorIds).toEqual([acc.id]);
    expect(net!.satisfaction).toBe(1.0);

    expect(pole.powerNetworkId).toBe(1);
    expect(getEntityPowerNetwork(grid, drill)?.id).toBe(1);
    expect(belt.powerNetworkId).toBeNull();
    expect(burner.powerNetworkId).toBeNull();
    expect(boiler.powerNetworkId).toBeNull();
    expect(chest.powerNetworkId).toBeNull();
  });

  it('partitions disconnected pole clusters and bridges them via a pole chain', () => {
    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    const pole1 = em.spawn('power_pole', { x: 10, y: 10 });
    const steam = em.spawn('steam_engine', { x: 8, y: 10 });

    const pole2 = em.spawn('power_pole', { x: 24, y: 10 }); // distance 14 from pole1
    const drill = em.spawn('electric_drill', { x: 26, y: 10 });

    // Initially two separate networks
    const gridBefore = buildPowerGrid(em.toRecord());
    expect(Object.keys(gridBefore.networks)).toHaveLength(2);
    expect(pole1.powerNetworkId).toBe(1);
    expect(steam.powerNetworkId).toBe(1);
    expect(pole2.powerNetworkId).toBe(2);
    expect(drill.powerNetworkId).toBe(2);
    expect(getWireConnections(em.toRecord())).toEqual([]);

    // Place a bridge pole at (17, 10): distance 7 to both pole1 and pole2
    const bridge = em.spawn('power_pole', { x: 17, y: 10 });
    const gridBridged = buildPowerGrid(em.toRecord());

    expect(Object.keys(gridBridged.networks)).toHaveLength(1);
    const merged = getPowerNetwork(gridBridged, 1)!;
    expect(merged.poleIds).toEqual([pole1.id, pole2.id, bridge.id]);
    expect(merged.producerIds).toEqual([steam.id]);
    expect(merged.consumerIds).toEqual([drill.id]);
    expect(getWireConnections(em.toRecord())).toEqual([
      { from: pole1.id, to: bridge.id },
      { from: pole2.id, to: bridge.id },
    ]);

    // Removing the bridge pole splits the network back into 2
    em.destroy(bridge.id);
    const gridSplit = buildPowerGrid(em.toRecord());
    expect(Object.keys(gridSplit.networks)).toHaveLength(2);
    expect(steam.powerNetworkId).toBe(1);
    expect(drill.powerNetworkId).toBe(2);
    expect(pole1.connectedPoleIds).toEqual([]);
    expect(pole2.connectedPoleIds).toEqual([]);
  });

  it('deterministically assigns entities in overlapping supply radii to the lowest network ID', () => {
    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    // Two poles at distance 8 (cannot wire-connect, since wireReach = 7)
    // Their supplyRadius = 5 areas overlap at x = 13, 14, 15.
    const pole1 = em.spawn('power_pole', { x: 10, y: 10 });
    const pole2 = em.spawn('power_pole', { x: 18, y: 10 });
    const drill = em.spawn('electric_drill', { x: 14, y: 10 });

    expect(canPolesConnect(pole1, pole2)).toBe(false);
    expect(isEntityInSupplyRadius(drill, pole1)).toBe(true);
    expect(isEntityInSupplyRadius(drill, pole2)).toBe(true);

    const grid = buildPowerGrid(em.toRecord());
    expect(Object.keys(grid.networks)).toHaveLength(2);
    expect(drill.powerNetworkId).toBe(1);
    expect(grid.networks[1]!.consumerIds).toEqual([drill.id]);
    expect(grid.networks[2]!.consumerIds).toEqual([]);
  });

  it('tracks uncovered power participants and updates WorldState via rebuildPowerGrid', () => {
    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    em.spawn('power_pole', { x: 10, y: 10 });
    const coveredDrill = em.spawn('electric_drill', { x: 12, y: 10 });
    const uncoveredDrill = em.spawn('electric_drill', { x: 40, y: 40 });
    const uncoveredSolar = em.spawn('solar_panel', { x: 50, y: 50 });

    const world = makeMinimalWorld(em.toRecord());
    const grid = rebuildPowerGrid(world);

    expect(world.powerGrid).toBe(grid);
    expect(coveredDrill.powerNetworkId).toBe(1);
    expect(uncoveredDrill.powerNetworkId).toBeNull();
    expect(uncoveredSolar.powerNetworkId).toBeNull();
    expect(getUncoveredPowerEntities(world.entities)).toEqual([
      uncoveredDrill.id,
      uncoveredSolar.id,
    ]);
  });

  it('fails closed on invalid power pole supplyRadius or wireReach', () => {
    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    const pole = em.spawn('power_pole', { x: 10, y: 10 }) as unknown as {
      supplyRadius: number;
      wireReach: number;
    } & PowerPoleEntity;

    pole.supplyRadius = -1;
    expect(() => buildPowerGrid(em.toRecord())).toThrow(SimulationError);

    pole.supplyRadius = 5;
    pole.wireReach = Number.NaN;
    expect(() => buildPowerGrid(em.toRecord())).toThrow(SimulationError);
  });

  it('produces bit-for-bit identical grids regardless of entity record insertion order', () => {
    const em = new EntityManager({ bounds: { width: 64, height: 64 } });
    em.spawn('power_pole', { x: 10, y: 10 });
    em.spawn('power_pole', { x: 16, y: 10 });
    em.spawn('power_pole', { x: 40, y: 40 });
    em.spawn('steam_engine', { x: 11, y: 10 });
    em.spawn('electric_drill', { x: 17, y: 10 });
    em.spawn('assembler_mk2', { x: 41, y: 40 });

    const forward = em.toRecord();
    const reversed: Record<EntityId, Entity> = {};
    for (const key of Object.keys(forward).reverse()) {
      const id = Number(key);
      reversed[id] = structuredClone(forward[id]!);
    }

    const gridA = buildPowerGrid(forward);
    const gridB = buildPowerGrid(reversed);

    expect(JSON.stringify(gridA)).toBe(JSON.stringify(gridB));
  });
});
