import { describe, expect, it } from 'vitest';
import {
  DAY_CYCLE_TICKS,
  SimulationError,
  TICKS_PER_SECOND,
  type AccumulatorEntity,
  type SolarPanelEntity,
  type WorldState,
} from '../src/types/contracts';
import { EntityManager } from '../src/core/entityManager';
import { createEmptyPowerGrid, rebuildPowerGrid } from '../src/logistics/powerGrid';
import { solvePowerGrid } from '../src/logistics/powerSolver';
import {
  ACCUMULATOR_CAPACITY_KJ,
  ACCUMULATOR_MAX_CHARGE_KW,
  ACCUMULATOR_MAX_DISCHARGE_KW,
  DAY_END_TICK,
  DUSK_END_TICK,
  NIGHT_END_TICK,
  SOLAR_PANEL_PEAK_KW,
  advanceDayNightClock,
  balanceNetworkAccumulators,
  chargeAccumulator,
  computeSolarFactor,
  createDayNightState,
  dischargeAccumulator,
  getAccumulatorChargeRatio,
  getDayNightPhase,
  normalizeCycleTick,
  tickSolarPower,
  updateAllSolarPanels,
  updateSolarPanel,
} from '../src/machines/solarPower';

function createTestWorld(initialCycleTick = 0): {
  world: WorldState;
  em: EntityManager;
} {
  const width = 32;
  const height = 32;
  const tiles = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        terrain: 'grass' as const,
        resource: null,
        entityId: null,
      });
    }
  }

  const em = new EntityManager({ bounds: { width, height } });
  const world: WorldState = {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width,
    height,
    tiles,
    entities: {},
    nextEntityId: 1,
    powerGrid: createEmptyPowerGrid(),
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: createDayNightState(initialCycleTick),
    stats: {
      byItem: {},
    },
  };

  return { world, em };
}

describe('T29: Solar Power & 3,600-Tick Day/Night Clock', () => {
  describe('Day/Night Clock', () => {
    it('evaluates exact solar factors and phases across the 3,600-tick cycle', () => {
      expect(DAY_CYCLE_TICKS).toBe(3600);

      // Day plateau [0, 1800)
      expect(getDayNightPhase(0)).toBe('day');
      expect(computeSolarFactor(0)).toBe(1.0);
      expect(getDayNightPhase(900)).toBe('day');
      expect(computeSolarFactor(900)).toBe(1.0);
      expect(getDayNightPhase(DAY_END_TICK - 1)).toBe('day');
      expect(computeSolarFactor(DAY_END_TICK - 1)).toBe(1.0);

      // Dusk ramp [1800, 2160)
      expect(getDayNightPhase(DAY_END_TICK)).toBe('dusk');
      expect(computeSolarFactor(DAY_END_TICK)).toBe(1.0);
      expect(computeSolarFactor(1980)).toBeCloseTo(0.5, 10);

      // Night plateau [2160, 3240)
      expect(getDayNightPhase(DUSK_END_TICK)).toBe('night');
      expect(computeSolarFactor(DUSK_END_TICK)).toBe(0.0);
      expect(getDayNightPhase(2700)).toBe('night');
      expect(computeSolarFactor(2700)).toBe(0.0);
      expect(getDayNightPhase(NIGHT_END_TICK - 1)).toBe('night');
      expect(computeSolarFactor(NIGHT_END_TICK - 1)).toBe(0.0);

      // Dawn ramp [3240, 3600)
      expect(getDayNightPhase(NIGHT_END_TICK)).toBe('dawn');
      expect(computeSolarFactor(NIGHT_END_TICK)).toBe(0.0);
      expect(computeSolarFactor(3420)).toBeCloseTo(0.5, 10);

      // Wraparound at 3600 -> 0
      expect(normalizeCycleTick(3600)).toBe(0);
      expect(computeSolarFactor(3600)).toBe(1.0);
    });

    it('has an exact cycle-average solar factor of 0.6 over 3,600 ticks', () => {
      let sum = 0;
      for (let t = 0; t < DAY_CYCLE_TICKS; t++) {
        sum += computeSolarFactor(t);
      }
      expect(sum / DAY_CYCLE_TICKS).toBeCloseTo(0.6, 10);
    });

    it('advances and wraps DayNightState deterministically', () => {
      const state = createDayNightState(3598);
      expect(state.cycleTick).toBe(3598);

      advanceDayNightClock(state, 1);
      expect(state.cycleTick).toBe(3599);
      expect(state.solarFactor).toBeGreaterThan(0.99);

      advanceDayNightClock(state, 1);
      expect(state.cycleTick).toBe(0);
      expect(state.solarFactor).toBe(1.0);

      advanceDayNightClock(state, 2700);
      expect(state.cycleTick).toBe(2700);
      expect(state.solarFactor).toBe(0.0);
    });

    it('fails closed on invalid cycle ticks and deltaTicks', () => {
      expect(() => normalizeCycleTick(Number.NaN)).toThrow(SimulationError);
      expect(() => normalizeCycleTick(1.5)).toThrow(SimulationError);
      const state = createDayNightState(0);
      expect(() => advanceDayNightClock(state, -1)).toThrow(SimulationError);
      expect(() => advanceDayNightClock(state, 0.5)).toThrow(SimulationError);
    });
  });

  describe('Solar Panels', () => {
    it('scales 60 kW peak output with solarFactor and toggles active flag', () => {
      const { em } = createTestWorld();
      const panel = em.spawn('solar_panel', { x: 4, y: 4 }) as SolarPanelEntity;
      expect(panel.peakOutputKw).toBe(SOLAR_PANEL_PEAK_KW);

      expect(updateSolarPanel(panel, 1.0)).toBe(60);
      expect(panel.currentOutputKw).toBe(60);
      expect(panel.active).toBe(true);

      expect(updateSolarPanel(panel, 0.5)).toBe(30);
      expect(panel.currentOutputKw).toBe(30);
      expect(panel.active).toBe(true);

      expect(updateSolarPanel(panel, 0.0)).toBe(0);
      expect(panel.currentOutputKw).toBe(0);
      expect(panel.active).toBe(false);
    });

    it('updates all solar panels in world state', () => {
      const { world, em } = createTestWorld(0);
      em.spawn('solar_panel', { x: 2, y: 2 });
      em.spawn('solar_panel', { x: 6, y: 2 });
      world.entities = em.toRecord();

      expect(updateAllSolarPanels(world)).toBe(120);

      advanceDayNightClock(world.dayNight, 1980); // mid-dusk = 0.5
      expect(updateAllSolarPanels(world)).toBeCloseTo(60, 10);

      advanceDayNightClock(world.dayNight, 720); // night = 0.0
      expect(updateAllSolarPanels(world)).toBe(0);
    });

    it('fails closed on negative or NaN solar values', () => {
      const { em } = createTestWorld();
      const panel = em.spawn('solar_panel', { x: 2, y: 2 }) as SolarPanelEntity;
      expect(() => updateSolarPanel(panel, -0.1)).toThrow(SimulationError);
      expect(() => updateSolarPanel(panel, Number.NaN)).toThrow(SimulationError);
    });
  });

  describe('Accumulators', () => {
    it('charges up to maxChargeRateKw and clamps at capacityKj', () => {
      const { em } = createTestWorld();
      const acc = em.spawn('accumulator', { x: 10, y: 10 }) as AccumulatorEntity;
      expect(acc.capacityKj).toBe(ACCUMULATOR_CAPACITY_KJ);
      expect(acc.maxChargeRateKw).toBe(ACCUMULATOR_MAX_CHARGE_KW);
      expect(acc.maxDischargeRateKw).toBe(ACCUMULATOR_MAX_DISCHARGE_KW);

      // Available 500 kW > maxChargeRateKw (300 kW) -> capped at 300 kW for 1 second = 300 kJ
      const charged1 = chargeAccumulator(acc, 500, 1.0);
      expect(charged1).toBe(300);
      expect(acc.storedEnergyKj).toBe(300);
      expect(acc.active).toBe(true);
      expect(getAccumulatorChargeRatio(acc)).toBeCloseTo(300 / 5000, 10);

      // Fill near capacity and verify clamping
      acc.storedEnergyKj = 4950;
      const charged2 = chargeAccumulator(acc, 300, 1.0);
      expect(charged2).toBe(50);
      expect(acc.storedEnergyKj).toBe(5000);
      expect(getAccumulatorChargeRatio(acc)).toBe(1.0);

      // Already full -> 0 kW charged, active = false
      const charged3 = chargeAccumulator(acc, 300, 1.0);
      expect(charged3).toBe(0);
      expect(acc.active).toBe(false);
    });

    it('discharges up to maxDischargeRateKw and clamps at 0', () => {
      const { em } = createTestWorld();
      const acc = em.spawn('accumulator', { x: 10, y: 10 }) as AccumulatorEntity;
      acc.storedEnergyKj = 400;

      // Request 500 kW > maxDischargeRateKw (300 kW) -> capped at 300 kW for 1 second = 300 kJ
      const dis1 = dischargeAccumulator(acc, 500, 1.0);
      expect(dis1).toBe(300);
      expect(acc.storedEnergyKj).toBe(100);
      expect(acc.active).toBe(true);

      // Remaining 100 kJ -> supplies 100 kW for 1 second
      const dis2 = dischargeAccumulator(acc, 300, 1.0);
      expect(dis2).toBe(100);
      expect(acc.storedEnergyKj).toBe(0);
      expect(acc.active).toBe(true);

      // Empty -> 0 kW discharged, active = false
      const dis3 = dischargeAccumulator(acc, 300, 1.0);
      expect(dis3).toBe(0);
      expect(acc.active).toBe(false);
    });

    it('balances multiple accumulators proportionally on surplus and deficit', () => {
      const { em } = createTestWorld();
      const acc1 = em.spawn('accumulator', { x: 2, y: 2 }) as AccumulatorEntity;
      const acc2 = em.spawn('accumulator', { x: 6, y: 2 }) as AccumulatorEntity;

      // Surplus of 120 kW across two empty accumulators -> 60 kW each
      const chargeRes = balanceNetworkAccumulators([acc2, acc1], 120, 1.0);
      expect(chargeRes.chargedKw).toBeCloseTo(120, 10);
      expect(chargeRes.dischargedKw).toBe(0);
      expect(chargeRes.netGridContributionKw).toBeCloseTo(-120, 10);
      expect(acc1.storedEnergyKj).toBeCloseTo(60, 10);
      expect(acc2.storedEnergyKj).toBeCloseTo(60, 10);

      // Deficit of 50 kW -> 25 kW each
      const dischargeRes = balanceNetworkAccumulators([acc2, acc1], -50, 1.0);
      expect(dischargeRes.chargedKw).toBe(0);
      expect(dischargeRes.dischargedKw).toBeCloseTo(50, 10);
      expect(dischargeRes.netGridContributionKw).toBeCloseTo(50, 10);
      expect(acc1.storedEnergyKj).toBeCloseTo(35, 10);
      expect(acc2.storedEnergyKj).toBeCloseTo(35, 10);
    });

    it('fails closed on negative or NaN accumulator parameters', () => {
      const { em } = createTestWorld();
      const acc = em.spawn('accumulator', { x: 2, y: 2 }) as AccumulatorEntity;
      expect(() => chargeAccumulator(acc, -10)).toThrow(SimulationError);
      expect(() => dischargeAccumulator(acc, Number.NaN)).toThrow(SimulationError);
      expect(() => balanceNetworkAccumulators([acc], Number.POSITIVE_INFINITY)).toThrow(
        SimulationError
      );
    });
  });

  describe('Full-Cycle Power Grid Integration & Determinism', () => {
    function runFullDayNightMicrogrid(): {
      minSatisfaction: number;
      dayEndChargeKj: number;
      nightEndChargeKj: number;
      finalCycleTick: number;
    } {
      const { world, em } = createTestWorld(0);
      // 1 power pole covering 3 solar panels (180 kW peak, 108 kW avg),
      // 1 accumulator (5000 kJ), and 1 electric drill (90 kW demand).
      em.spawn('power_pole', { x: 10, y: 10 });
      em.spawn('solar_panel', { x: 7, y: 7 });
      em.spawn('solar_panel', { x: 11, y: 7 });
      em.spawn('solar_panel', { x: 7, y: 11 });
      const acc = em.spawn('accumulator', { x: 11, y: 11 }) as AccumulatorEntity;
      em.spawn('electric_drill', { x: 9, y: 11 });

      world.entities = em.toRecord();
      rebuildPowerGrid(world);

      let minSatisfaction = 1.0;
      let dayEndChargeKj = 0;
      let nightEndChargeKj = 0;

      for (let t = 0; t < DAY_CYCLE_TICKS; t++) {
        world.tick = t + 1;
        tickSolarPower(world);
        const results = solvePowerGrid(world, { dtSeconds: 1 / TICKS_PER_SECOND });
        const sat = results[0]!.satisfaction;
        if (sat < minSatisfaction) {
          minSatisfaction = sat;
        }
        if (world.dayNight.cycleTick === DAY_END_TICK) {
          dayEndChargeKj = acc.storedEnergyKj;
        }
        if (world.dayNight.cycleTick === NIGHT_END_TICK) {
          nightEndChargeKj = acc.storedEnergyKj;
        }
      }

      return {
        minSatisfaction,
        dayEndChargeKj,
        nightEndChargeKj,
        finalCycleTick: world.dayNight.cycleTick,
      };
    }

    it('sustains 100% power through night via accumulator discharge and is bit-for-bit deterministic', () => {
      const run1 = runFullDayNightMicrogrid();
      const run2 = runFullDayNightMicrogrid();

      // 3 panels (180 kW peak) vs 90 kW drill -> 90 kW surplus for 30s = 2700 kJ stored during day.
      // Night (18s) + half of dusk/dawn (6s) = 24s * 90 kW = 2160 kJ needed -> fully sustained!
      expect(run1.minSatisfaction).toBeCloseTo(1.0, 12);
      expect(run1.dayEndChargeKj).toBeGreaterThan(2000);
      expect(run1.nightEndChargeKj).toBeLessThan(run1.dayEndChargeKj);
      expect(run1.nightEndChargeKj).toBeGreaterThan(0);
      expect(run1.finalCycleTick).toBe(0);

      // Strict determinism across independent runs
      expect(run1).toEqual(run2);
    });
  });
});
