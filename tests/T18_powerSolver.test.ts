import { describe, expect, it } from 'vitest';
import { createEventBus } from '../src/core/eventBus';
import { createEmptyPowerGrid, rebuildPowerGrid } from '../src/logistics/powerGrid';
import {
  computePowerSatisfaction,
  getEffectiveMachineSpeed,
  getEntityPowerSatisfaction,
  getGlobalPowerSatisfaction,
  scaleMachineSpeed,
  solvePowerGrid,
  solvePowerNetwork,
} from '../src/logistics/powerSolver';
import {
  SimulationError,
  type AccumulatorEntity,
  type ElectricDrillEntity,
  type ElectricFurnaceEntity,
  type Entity,
  type PowerBrownoutEvent,
  type PowerPoleEntity,
  type SolarPanelEntity,
  type SteamEngineEntity,
  type WorldState,
} from '../src/types/contracts';

function createTestWorld(entities: Entity[]): WorldState {
  const entityMap: Record<number, Entity> = {};
  let maxId = 0;
  for (const entity of entities) {
    entityMap[entity.id] = entity;
    if (entity.id > maxId) {
      maxId = entity.id;
    }
  }

  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 10,
    width: 64,
    height: 64,
    tiles: [],
    entities: entityMap,
    nextEntityId: maxId + 1,
    powerGrid: createEmptyPowerGrid(),
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: {
      cycleTick: 0,
      solarFactor: 1.0,
    },
    stats: {
      byItem: {},
    },
  };
}

function makePole(id: number, x: number, y: number): PowerPoleEntity {
  return {
    id,
    type: 'power_pole',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    supplyRadius: 5,
    wireReach: 7,
    connectedPoleIds: [],
  };
}

function makeSteamEngine(
  id: number,
  x: number,
  y: number,
  currentOutputKw: number,
  maxPowerOutputKw = 900
): SteamEngineEntity {
  return {
    id,
    type: 'steam_engine',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: currentOutputKw > 0,
    maxPowerOutputKw,
    currentOutputKw,
  };
}

function makeSolarPanel(
  id: number,
  x: number,
  y: number,
  currentOutputKw: number,
  peakOutputKw = 60
): SolarPanelEntity {
  return {
    id,
    type: 'solar_panel',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: currentOutputKw > 0,
    peakOutputKw,
    currentOutputKw,
  };
}

function makeElectricDrill(
  id: number,
  x: number,
  y: number,
  powerDemandKw = 90
): ElectricDrillEntity {
  return {
    id,
    type: 'electric_drill',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    powerDemandKw,
    miningProgress: 0,
  };
}

function makeElectricFurnace(
  id: number,
  x: number,
  y: number,
  powerDemandKw = 180
): ElectricFurnaceEntity {
  return {
    id,
    type: 'electric_furnace',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    powerDemandKw,
    inputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    outputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    activeRecipe: null,
    craftingProgress: 0,
  };
}

function makeAccumulator(
  id: number,
  x: number,
  y: number,
  storedEnergyKj: number,
  capacityKj = 5000,
  maxChargeRateKw = 300,
  maxDischargeRateKw = 300
): AccumulatorEntity {
  return {
    id,
    type: 'accumulator',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    storedEnergyKj,
    capacityKj,
    maxChargeRateKw,
    maxDischargeRateKw,
  };
}

describe('T18: Power Satisfaction Solver', () => {
  describe('computePowerSatisfaction', () => {
    it('returns 1.0 when demand is 0 (never NaN)', () => {
      expect(computePowerSatisfaction(0, 0)).toBe(1.0);
      expect(computePowerSatisfaction(900, 0)).toBe(1.0);
    });

    it('returns 0.0 when supply is 0 and demand > 0', () => {
      expect(computePowerSatisfaction(0, 90)).toBe(0.0);
      expect(computePowerSatisfaction(0, 0.001)).toBe(0.0);
    });

    it('clamps supply / demand to [0, 1]', () => {
      expect(computePowerSatisfaction(45, 90)).toBeCloseTo(0.5, 10);
      expect(computePowerSatisfaction(90, 90)).toBe(1.0);
      expect(computePowerSatisfaction(900, 270)).toBe(1.0);
    });

    it('fails closed on NaN, Infinity, or negative values', () => {
      expect(() => computePowerSatisfaction(Number.NaN, 100)).toThrow(SimulationError);
      expect(() => computePowerSatisfaction(100, Number.NaN)).toThrow(SimulationError);
      expect(() => computePowerSatisfaction(Number.POSITIVE_INFINITY, 100)).toThrow(SimulationError);
      expect(() => computePowerSatisfaction(-10, 100)).toThrow(SimulationError);
      expect(() => computePowerSatisfaction(100, -1)).toThrow(SimulationError);
    });
  });

  describe('scaleMachineSpeed', () => {
    it('scales machine speed proportionally and clamps satisfaction to [0, 1]', () => {
      expect(scaleMachineSpeed(1.0, 0.5)).toBeCloseTo(0.5, 10);
      expect(scaleMachineSpeed(2.0, 0.0)).toBe(0.0);
      expect(scaleMachineSpeed(0.75, 1.0)).toBeCloseTo(0.75, 10);
      expect(scaleMachineSpeed(1.5, 2.0)).toBeCloseTo(1.5, 10);
    });

    it('fails closed on invalid inputs', () => {
      expect(() => scaleMachineSpeed(-1, 0.5)).toThrow(SimulationError);
      expect(() => scaleMachineSpeed(1, Number.NaN)).toThrow(SimulationError);
    });
  });

  describe('solvePowerGrid & machine scaling', () => {
    it('solves a healthy network with surplus power (satisfaction = 1.0)', () => {
      const pole = makePole(1, 10, 10);
      const engine = makeSteamEngine(2, 11, 10, 900);
      const drill = makeElectricDrill(3, 12, 10, 90);
      const furnace = makeElectricFurnace(4, 13, 10, 180);
      const world = createTestWorld([pole, engine, drill, furnace]);
      rebuildPowerGrid(world);

      const bus = createEventBus();
      const brownouts: PowerBrownoutEvent[] = [];
      bus.on('powerBrownout', (e) => brownouts.push(e));

      const results = solvePowerGrid(world, { eventBus: bus });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        networkId: 1,
        supplyKw: 900,
        demandKw: 270,
        satisfaction: 1.0,
        isBrownout: false,
      });
      expect(brownouts).toHaveLength(0);
      expect(getEntityPowerSatisfaction(world, drill)).toBe(1.0);
      expect(getEffectiveMachineSpeed(world, furnace, 2.0)).toBe(2.0);
      expect(getGlobalPowerSatisfaction(world)).toBe(1.0);
    });

    it('handles 50% brownout, scales machine speed proportionally, and emits powerBrownout', () => {
      const pole = makePole(1, 10, 10);
      const engine = makeSteamEngine(2, 11, 10, 135);
      const drill = makeElectricDrill(3, 12, 10, 90);
      const furnace = makeElectricFurnace(4, 13, 10, 180);
      const world = createTestWorld([pole, engine, drill, furnace]);
      rebuildPowerGrid(world);

      const bus = createEventBus();
      const brownouts: PowerBrownoutEvent[] = [];
      bus.on('powerBrownout', (e) => brownouts.push(e));

      const results = solvePowerGrid(world, { eventBus: bus });
      expect(results).toHaveLength(1);
      expect(results[0]?.satisfaction).toBeCloseTo(0.5, 10);
      expect(results[0]?.isBrownout).toBe(true);
      expect(brownouts).toEqual([
        {
          tick: 10,
          networkId: 1,
          satisfaction: 0.5,
          supplyKw: 135,
          demandKw: 270,
        },
      ]);
      expect(getEffectiveMachineSpeed(world, drill, 1.0)).toBeCloseTo(0.5, 10);
      expect(getEffectiveMachineSpeed(world, furnace, 2.0)).toBeCloseTo(1.0, 10);
    });

    it('handles complete blackout (0 supply with demand -> satisfaction 0.0)', () => {
      const pole = makePole(1, 10, 10);
      const engine = makeSteamEngine(2, 11, 10, 0);
      const drill = makeElectricDrill(3, 12, 10, 90);
      const world = createTestWorld([pole, engine, drill]);
      rebuildPowerGrid(world);

      const results = solvePowerGrid(world);
      expect(results[0]?.satisfaction).toBe(0.0);
      expect(results[0]?.isBrownout).toBe(true);
      expect(getEffectiveMachineSpeed(world, drill, 1.0)).toBe(0.0);
    });

    it('returns 0.0 satisfaction for unconnected electric machines', () => {
      const pole = makePole(1, 10, 10);
      const engine = makeSteamEngine(2, 11, 10, 900);
      const farDrill = makeElectricDrill(3, 40, 40, 90);
      const world = createTestWorld([pole, engine, farDrill]);
      rebuildPowerGrid(world);
      solvePowerGrid(world);

      expect(farDrill.powerNetworkId).toBeNull();
      expect(getEntityPowerSatisfaction(world, farDrill)).toBe(0.0);
      expect(getEffectiveMachineSpeed(world, farDrill, 1.0)).toBe(0.0);
    });

    it('keeps independent networks isolated and computes demand-weighted global satisfaction', () => {
      // Network 1: 900 kW supply, 100 kW demand -> satisfaction 1.0
      const pole1 = makePole(1, 10, 10);
      const engine1 = makeSteamEngine(2, 11, 10, 900);
      const drill1 = makeElectricDrill(3, 12, 10, 100);

      // Network 2 (far away): 0 kW supply, 100 kW demand -> satisfaction 0.0
      const pole2 = makePole(4, 40, 40);
      const drill2 = makeElectricDrill(5, 41, 40, 100);

      const world = createTestWorld([pole1, engine1, drill1, pole2, drill2]);
      rebuildPowerGrid(world);

      const results = solvePowerGrid(world);
      expect(results).toHaveLength(2);
      expect(results[0]?.satisfaction).toBe(1.0);
      expect(results[1]?.satisfaction).toBe(0.0);

      // Demand-weighted average: (1.0 * 100 + 0.0 * 100) / 200 = 0.5
      expect(getGlobalPowerSatisfaction(world)).toBeCloseTo(0.5, 10);
    });
  });

  describe('accumulator buffering', () => {
    it('discharges accumulators to cover deficit and charges from surplus', () => {
      const pole = makePole(1, 10, 10);
      const solar = makeSolarPanel(2, 11, 10, 60);
      const drill = makeElectricDrill(3, 12, 10, 120);
      const acc = makeAccumulator(4, 13, 10, 1000, 5000, 300, 300);
      const world = createTestWorld([pole, solar, drill, acc]);
      rebuildPowerGrid(world);

      // Deficit of 60 kW for 1 second -> accumulator discharges 60 kJ
      const deficitResult = solvePowerGrid(world, { dtSeconds: 1 });
      expect(deficitResult[0]?.satisfaction).toBe(1.0);
      expect(deficitResult[0]?.isBrownout).toBe(false);
      expect(acc.storedEnergyKj).toBeCloseTo(940, 10);

      // Surplus: increase solar output to 220 kW (100 kW surplus for 1 second)
      solar.currentOutputKw = 220;
      const surplusResult = solvePowerGrid(world, { dtSeconds: 1 });
      expect(surplusResult[0]?.satisfaction).toBe(1.0);
      expect(acc.storedEnergyKj).toBeCloseTo(1040, 10);
    });

    it('can skip accumulator buffering when useAccumulators is false', () => {
      const pole = makePole(1, 10, 10);
      const solar = makeSolarPanel(2, 11, 10, 60);
      const drill = makeElectricDrill(3, 12, 10, 120);
      const acc = makeAccumulator(4, 13, 10, 1000, 5000, 300, 300);
      const world = createTestWorld([pole, solar, drill, acc]);
      rebuildPowerGrid(world);

      const network = world.powerGrid.networks[1]!;
      const result = solvePowerNetwork(network, world.entities, {
        dtSeconds: 1,
        useAccumulators: false,
      });
      expect(result.satisfaction).toBeCloseTo(0.5, 10);
      expect(acc.storedEnergyKj).toBe(1000);
    });
  });
});
