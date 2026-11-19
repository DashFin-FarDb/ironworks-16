import { describe, expect, it } from 'vitest';
import {
  DAY_CYCLE_TICKS,
  SimulationError,
  type BoilerEntity,
  type SteamEngineEntity,
  type WorldState,
} from '../src/types/contracts';
import { EntityManager } from '../src/core/entityManager';
import { getItemCount } from '../src/core/inventory';
import { createEmptyPowerGrid, rebuildPowerGrid } from '../src/logistics/powerGrid';
import { solvePowerGrid } from '../src/logistics/powerSolver';
import {
  BOILER_MAX_STEAM_BUFFER,
  STEAM_ENGINE_MAX_OUTPUT_KW,
  insertBoilerFuel,
  updateBoiler,
  updateSteamEngine,
  updateSteamPower,
} from '../src/machines/steamPower';

function createTestWorld(width = 16, height = 16): {
  world: WorldState;
  em: EntityManager;
} {
  const em = new EntityManager({ bounds: { width, height } });
  const world: WorldState = {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width,
    height,
    tiles: [],
    entities: {},
    nextEntityId: 1,
    powerGrid: createEmptyPowerGrid(),
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: {
      cycleTick: 0,
      solarFactor: 1,
    },
    stats: { byItem: {} },
  };
  return { world, em };
}

function syncEntities(world: WorldState, em: EntityManager): void {
  world.entities = em.toRecord();
  world.nextEntityId = em.getNextEntityId();
}

describe('T28: Steam Power (Boiler + Steam Engine)', () => {
  it('supplies 900 kW to its power network when coal-fueled and adjacent', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 4, y: 4 }) as BoilerEntity;
    const engine = em.spawn('steam_engine', { x: 5, y: 4 }) as SteamEngineEntity;
    em.spawn('power_pole', { x: 5, y: 5 });
    em.spawn('electric_drill', { x: 6, y: 5 }); // 90 kW
    em.spawn('electric_furnace', { x: 7, y: 5 }); // 180 kW
    syncEntities(world, em);

    const inserted = insertBoilerFuel(boiler, 'coal', 5);
    expect(inserted).toBe(5);

    rebuildPowerGrid(world);
    const summary = updateSteamPower(world);
    const powerResults = solvePowerGrid(world);

    expect(summary.totalOutputKw).toBe(STEAM_ENGINE_MAX_OUTPUT_KW);
    expect(engine.currentOutputKw).toBe(900);
    expect(engine.active).toBe(true);
    expect(boiler.active).toBe(true);

    expect(powerResults).toHaveLength(1);
    expect(powerResults[0]!.supplyKw).toBe(900);
    expect(powerResults[0]!.demandKw).toBe(270);
    expect(powerResults[0]!.satisfaction).toBe(1.0);
    expect(powerResults[0]!.isBrownout).toBe(false);
  });

  it('scales power network satisfaction cleanly under > 900 kW demand (brownout)', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 2, y: 2 }) as BoilerEntity;
    em.spawn('steam_engine', { x: 3, y: 2 });
    em.spawn('power_pole', { x: 4, y: 2 });
    // 10 electric furnaces * 180 kW = 1800 kW demand -> 50% satisfaction
    for (let i = 0; i < 10; i++) {
      em.spawn('electric_furnace', { x: 2 + (i % 5), y: 3 + Math.floor(i / 5) });
    }
    syncEntities(world, em);

    insertBoilerFuel(boiler, 'coal', 2);
    rebuildPowerGrid(world);
    updateSteamPower(world);
    const results = solvePowerGrid(world);

    expect(results).toHaveLength(1);
    expect(results[0]!.supplyKw).toBe(900);
    expect(results[0]!.demandKw).toBe(1800);
    expect(results[0]!.satisfaction).toBeCloseTo(0.5, 9);
    expect(results[0]!.isBrownout).toBe(true);
  });

  it('conserves energy from 1 coal (4000 kJ) and halts cleanly when fuel and steam run out', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 4, y: 4 }) as BoilerEntity;
    const engine = em.spawn('steam_engine', { x: 4, y: 5 }) as SteamEngineEntity;
    syncEntities(world, em);

    insertBoilerFuel(boiler, 'coal', 1);

    let totalEnergySuppliedKj = 0;
    for (let tick = 0; tick < 300; tick++) {
      updateSteamPower(world);
      totalEnergySuppliedKj += engine.currentOutputKw / 60;
    }

    // 1 coal = 4000 kJ -> total electrical energy supplied must equal 4000 kJ
    expect(totalEnergySuppliedKj).toBeCloseTo(4000, 6);
    expect(getItemCount(boiler.fuelInventory, 'coal')).toBe(0);
    expect(boiler.fuelEnergyKj).toBe(0);
    expect(boiler.steamBuffer).toBe(0);
    expect(boiler.active).toBe(false);
    expect(engine.currentOutputKw).toBe(0);
    expect(engine.active).toBe(false);
  });

  it('does not burn fuel when boiler steamBuffer is already full', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 4, y: 4 }) as BoilerEntity;
    syncEntities(world, em);

    boiler.steamBuffer = BOILER_MAX_STEAM_BUFFER;
    insertBoilerFuel(boiler, 'coal', 3);

    const res = updateBoiler(boiler);
    expect(res.active).toBe(false);
    expect(res.fuelConsumed).toBe(false);
    expect(res.energyBurnedKj).toBe(0);
    expect(getItemCount(boiler.fuelInventory, 'coal')).toBe(3);
  });

  it('supports 1 Boiler supplying 2 adjacent Steam Engines at 900 kW each (1800 kW total)', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 5, y: 5 }) as BoilerEntity;
    const engineA = em.spawn('steam_engine', { x: 4, y: 5 }) as SteamEngineEntity;
    const engineB = em.spawn('steam_engine', { x: 6, y: 5 }) as SteamEngineEntity;
    syncEntities(world, em);

    insertBoilerFuel(boiler, 'coal', 2);

    for (let tick = 0; tick < 50; tick++) {
      const summary = updateSteamPower(world);
      expect(summary.totalOutputKw).toBe(1800);
      expect(engineA.currentOutputKw).toBe(900);
      expect(engineB.currentOutputKw).toBe(900);
    }
  });

  it('produces 0 kW for steam engines without an orthogonally adjacent boiler', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 2, y: 2 }) as BoilerEntity;
    // Diagonal (Manhattan distance 2) - not orthogonally adjacent
    const diagonalEngine = em.spawn('steam_engine', { x: 3, y: 3 }) as SteamEngineEntity;
    syncEntities(world, em);

    insertBoilerFuel(boiler, 'coal', 2);
    updateSteamPower(world);

    expect(boiler.steamBuffer).toBeGreaterThan(0);
    expect(diagonalEngine.currentOutputKw).toBe(0);
    expect(diagonalEngine.active).toBe(false);
  });

  it('drains multiple adjacent boilers in deterministic ascending EntityId order', () => {
    const { world, em } = createTestWorld();
    const boiler1 = em.spawn('boiler', { x: 4, y: 5 }) as BoilerEntity;
    const boiler2 = em.spawn('boiler', { x: 6, y: 5 }) as BoilerEntity;
    const engine = em.spawn('steam_engine', { x: 5, y: 5 }) as SteamEngineEntity;
    syncEntities(world, em);

    boiler1.steamBuffer = 0.6;
    boiler2.steamBuffer = 1.0;

    const res = updateSteamEngine(world, engine);
    expect(res.outputKw).toBe(900);
    expect(res.steamConsumed).toBeCloseTo(1.0, 9);
    // boiler1 (lower ID) drained completely first, boiler2 provides remaining 0.4
    expect(boiler1.steamBuffer).toBe(0);
    expect(boiler2.steamBuffer).toBeCloseTo(0.6, 9);
  });

  it('fails closed on non-fuel items and invalid numeric state', () => {
    const { world, em } = createTestWorld();
    const boiler = em.spawn('boiler', { x: 1, y: 1 }) as BoilerEntity;
    const engine = em.spawn('steam_engine', { x: 2, y: 1 }) as SteamEngineEntity;
    syncEntities(world, em);

    expect(() => insertBoilerFuel(boiler, 'iron_ore', 1)).toThrow(SimulationError);

    boiler.fuelEnergyKj = Number.NaN;
    expect(() => updateBoiler(boiler)).toThrow(SimulationError);

    boiler.fuelEnergyKj = 0;
    boiler.steamBuffer = -5;
    expect(() => updateBoiler(boiler)).toThrow(SimulationError);

    boiler.steamBuffer = 0;
    (engine as { maxPowerOutputKw: number }).maxPowerOutputKw = -100;
    expect(() => updateSteamEngine(world, engine)).toThrow(SimulationError);
  });

  it('is strictly deterministic across two independent runs', () => {
    function runSim(): string {
      const { world, em } = createTestWorld();
      const boiler = em.spawn('boiler', { x: 3, y: 3 }) as BoilerEntity;
      em.spawn('steam_engine', { x: 4, y: 3 });
      em.spawn('power_pole', { x: 4, y: 4 });
      em.spawn('electric_drill', { x: 5, y: 4 });
      syncEntities(world, em);

      insertBoilerFuel(boiler, 'coal', 2);
      rebuildPowerGrid(world);

      for (let t = 0; t < 120; t++) {
        world.tick = t;
        world.dayNight.cycleTick = t % DAY_CYCLE_TICKS;
        updateSteamPower(world);
        solvePowerGrid(world);
      }

      return JSON.stringify(world);
    }

    expect(runSim()).toBe(runSim());
  });
});
