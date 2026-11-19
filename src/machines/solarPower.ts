/**
 * Ironworks-16 Solar Power & Day/Night Clock (T29)
 *
 * Implements the 3,600-tick day/night cycle driving Solar Panels (60 kW peak)
 * and Accumulator charge/discharge energy storage.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  clamp,
  DAY_CYCLE_TICKS,
  SimulationError,
  TICKS_PER_SECOND,
  type AccumulatorEntity,
  type DayNightState,
  type Entity,
  type SolarPanelEntity,
  type WorldState,
} from '../types/contracts';

// ============================================================================
// Constants
// ============================================================================

export const SOLAR_PANEL_PEAK_KW = 60;
export const ACCUMULATOR_CAPACITY_KJ = 5000;
export const ACCUMULATOR_MAX_CHARGE_KW = 300;
export const ACCUMULATOR_MAX_DISCHARGE_KW = 300;

/**
 * Piecewise-linear 3,600-tick day/night schedule:
 * - [0, 1800)    : Day   (50%, solarFactor = 1.0)
 * - [1800, 2160) : Dusk  (10%, linear ramp 1.0 -> 0.0)
 * - [2160, 3240) : Night (30%, solarFactor = 0.0)
 * - [3240, 3600) : Dawn  (10%, linear ramp 0.0 -> 1.0)
 *
 * Cycle-average solar factor = 0.6 (36 kW average per 60 kW panel).
 */
export const DAY_END_TICK = 1800;
export const DUSK_END_TICK = 2160;
export const NIGHT_END_TICK = 3240;

export type DayNightPhase = 'day' | 'dusk' | 'night' | 'dawn';

export interface AccumulatorBalanceResult {
  readonly chargedKw: number;
  readonly dischargedKw: number;
  /** Positive when discharging into the grid, negative when charging from surplus. */
  readonly netGridContributionKw: number;
}

export interface TickSolarPowerOptions {
  /** Whether to advance world.dayNight by 1 tick before updating panels (default true). */
  readonly advanceClock?: boolean;
}

export interface SolarPowerTickResult {
  readonly cycleTick: number;
  readonly solarFactor: number;
  readonly phase: DayNightPhase;
  readonly totalSolarOutputKw: number;
  readonly activePanelCount: number;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new SimulationError(
      'INVALID_SOLAR_VALUE',
      `Expected non-negative finite number for ${label}, received ${String(value)}.`
    );
  }
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new SimulationError(
      'INVALID_SOLAR_VALUE',
      `Expected finite number for ${label}, received ${String(value)}.`
    );
  }
}

function isSolarPanelEntity(entity: Entity): entity is SolarPanelEntity {
  return entity.type === 'solar_panel';
}

// ============================================================================
// Day/Night Clock
// ============================================================================

/**
 * Wraps any finite integer tick into [0, DAY_CYCLE_TICKS).
 * Fails closed on non-finite or non-integer values.
 */
export function normalizeCycleTick(tick: number): number {
  if (!Number.isInteger(tick)) {
    throw new SimulationError(
      'INVALID_CYCLE_TICK',
      `Cycle tick must be an integer, received ${String(tick)}.`
    );
  }
  return ((tick % DAY_CYCLE_TICKS) + DAY_CYCLE_TICKS) % DAY_CYCLE_TICKS;
}

/**
 * Returns the day/night phase for a given cycle tick.
 */
export function getDayNightPhase(cycleTick: number): DayNightPhase {
  const t = normalizeCycleTick(cycleTick);
  if (t < DAY_END_TICK) {
    return 'day';
  }
  if (t < DUSK_END_TICK) {
    return 'dusk';
  }
  if (t < NIGHT_END_TICK) {
    return 'night';
  }
  return 'dawn';
}

/**
 * Pure deterministic solar efficiency in [0, 1] for a given cycle tick.
 */
export function computeSolarFactor(cycleTick: number): number {
  const t = normalizeCycleTick(cycleTick);
  if (t < DAY_END_TICK) {
    return 1.0;
  }
  if (t < DUSK_END_TICK) {
    const duskDuration = DUSK_END_TICK - DAY_END_TICK;
    return clamp(1.0 - (t - DAY_END_TICK) / duskDuration, 0, 1);
  }
  if (t < NIGHT_END_TICK) {
    return 0.0;
  }
  const dawnDuration = DAY_CYCLE_TICKS - NIGHT_END_TICK;
  return clamp((t - NIGHT_END_TICK) / dawnDuration, 0, 1);
}

/**
 * Creates a fresh DayNightState initialized at `initialCycleTick` (default 0 = full day).
 */
export function createDayNightState(initialCycleTick = 0): DayNightState {
  const cycleTick = normalizeCycleTick(initialCycleTick);
  return {
    cycleTick,
    solarFactor: computeSolarFactor(cycleTick),
  };
}

/**
 * Advances `dayNight` in-place by `deltaTicks` (default 1) modulo DAY_CYCLE_TICKS
 * and recomputes `solarFactor`.
 */
export function advanceDayNightClock(
  dayNight: DayNightState,
  deltaTicks = 1
): DayNightState {
  if (!Number.isInteger(deltaTicks) || deltaTicks < 0) {
    throw new SimulationError(
      'INVALID_CYCLE_TICK',
      `deltaTicks must be a non-negative integer, received ${String(deltaTicks)}.`
    );
  }
  const nextTick = normalizeCycleTick(dayNight.cycleTick + deltaTicks);
  dayNight.cycleTick = nextTick;
  dayNight.solarFactor = computeSolarFactor(nextTick);
  return dayNight;
}

// ============================================================================
// Solar Panels
// ============================================================================

/**
 * Updates a single SolarPanelEntity's `currentOutputKw` and `active` flag
 * based on the current `solarFactor` in [0, 1].
 */
export function updateSolarPanel(
  panel: SolarPanelEntity,
  solarFactor: number
): number {
  assertNonNegativeFinite(panel.peakOutputKw, `solar_panel(${panel.id}).peakOutputKw`);
  assertNonNegativeFinite(solarFactor, 'solarFactor');

  const clampedFactor = clamp(solarFactor, 0, 1);
  const outputKw = panel.peakOutputKw * clampedFactor;
  panel.currentOutputKw = outputKw;
  panel.active = outputKw > 0;
  return outputKw;
}

/**
 * Updates all SolarPanelEntity instances in `world.entities` in deterministic
 * ascending EntityId order using `world.dayNight.solarFactor`.
 * Returns total solar power output in kW.
 */
export function updateAllSolarPanels(world: WorldState): number {
  const panels = Object.values(world.entities)
    .filter(isSolarPanelEntity)
    .sort((a, b) => a.id - b.id);

  let totalKw = 0;
  for (const panel of panels) {
    totalKw += updateSolarPanel(panel, world.dayNight.solarFactor);
  }
  return totalKw;
}

// ============================================================================
// Accumulators
// ============================================================================

/**
 * Returns an accumulator's charge level in [0, 1].
 */
export function getAccumulatorChargeRatio(acc: AccumulatorEntity): number {
  assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
  assertNonNegativeFinite(acc.capacityKj, `accumulator(${acc.id}).capacityKj`);

  if (acc.capacityKj === 0) {
    return 0;
  }
  return clamp(acc.storedEnergyKj / acc.capacityKj, 0, 1);
}

/**
 * Charges a single accumulator from `availableKw` over `dtSeconds`.
 * Clamps `storedEnergyKj` to [0, capacityKj], updates `acc.active`, and
 * returns the actual power consumed in kW.
 */
export function chargeAccumulator(
  acc: AccumulatorEntity,
  availableKw: number,
  dtSeconds = 1 / TICKS_PER_SECOND
): number {
  assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
  assertNonNegativeFinite(acc.capacityKj, `accumulator(${acc.id}).capacityKj`);
  assertNonNegativeFinite(acc.maxChargeRateKw, `accumulator(${acc.id}).maxChargeRateKw`);
  assertNonNegativeFinite(availableKw, 'availableKw');
  assertNonNegativeFinite(dtSeconds, 'dtSeconds');

  if (availableKw === 0 || dtSeconds === 0) {
    acc.active = false;
    return 0;
  }

  const headroomKj = Math.max(0, acc.capacityKj - acc.storedEnergyKj);
  const maxAcceptKw = Math.min(acc.maxChargeRateKw, headroomKj / dtSeconds);
  const chargeKw = Math.min(availableKw, maxAcceptKw);

  if (chargeKw <= 0) {
    acc.active = false;
    return 0;
  }

  acc.storedEnergyKj = Math.min(acc.capacityKj, acc.storedEnergyKj + chargeKw * dtSeconds);
  acc.active = true;
  return chargeKw;
}

/**
 * Discharges a single accumulator to meet `requestedKw` over `dtSeconds`.
 * Clamps `storedEnergyKj` to [0, capacityKj], updates `acc.active`, and
 * returns the actual power supplied in kW.
 */
export function dischargeAccumulator(
  acc: AccumulatorEntity,
  requestedKw: number,
  dtSeconds = 1 / TICKS_PER_SECOND
): number {
  assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
  assertNonNegativeFinite(acc.capacityKj, `accumulator(${acc.id}).capacityKj`);
  assertNonNegativeFinite(
    acc.maxDischargeRateKw,
    `accumulator(${acc.id}).maxDischargeRateKw`
  );
  assertNonNegativeFinite(requestedKw, 'requestedKw');
  assertNonNegativeFinite(dtSeconds, 'dtSeconds');

  if (requestedKw === 0 || dtSeconds === 0) {
    acc.active = false;
    return 0;
  }

  const maxAvailableKw = Math.min(acc.maxDischargeRateKw, acc.storedEnergyKj / dtSeconds);
  const dischargeKw = Math.min(requestedKw, maxAvailableKw);

  if (dischargeKw <= 0) {
    acc.active = false;
    return 0;
  }

  acc.storedEnergyKj = Math.max(0, acc.storedEnergyKj - dischargeKw * dtSeconds);
  acc.active = true;
  return dischargeKw;
}

/**
 * Proportionally charges (when `netPowerKw > 0`) or discharges (when `netPowerKw < 0`)
 * a collection of accumulators in deterministic ascending EntityId order.
 */
export function balanceNetworkAccumulators(
  accumulators: readonly AccumulatorEntity[],
  netPowerKw: number,
  dtSeconds = 1 / TICKS_PER_SECOND
): AccumulatorBalanceResult {
  assertFiniteNumber(netPowerKw, 'netPowerKw');
  assertNonNegativeFinite(dtSeconds, 'dtSeconds');

  const sorted = [...accumulators].sort((a, b) => a.id - b.id);

  if (sorted.length === 0 || netPowerKw === 0 || dtSeconds === 0) {
    for (const acc of sorted) {
      acc.active = false;
    }
    return {
      chargedKw: 0,
      dischargedKw: 0,
      netGridContributionKw: 0,
    };
  }

  if (netPowerKw > 0) {
    // Surplus: charge proportionally
    let totalCapacityKw = 0;
    const maxByAcc: number[] = [];

    for (const acc of sorted) {
      assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
      assertNonNegativeFinite(acc.capacityKj, `accumulator(${acc.id}).capacityKj`);
      assertNonNegativeFinite(acc.maxChargeRateKw, `accumulator(${acc.id}).maxChargeRateKw`);
      const headroomKj = Math.max(0, acc.capacityKj - acc.storedEnergyKj);
      const acceptKw = Math.min(acc.maxChargeRateKw, headroomKj / dtSeconds);
      maxByAcc.push(acceptKw);
      totalCapacityKw += acceptKw;
    }

    if (totalCapacityKw <= 0) {
      for (const acc of sorted) {
        acc.active = false;
      }
      return {
        chargedKw: 0,
        dischargedKw: 0,
        netGridContributionKw: 0,
      };
    }

    const ratio = Math.min(1, netPowerKw / totalCapacityKw);
    let totalChargedKw = 0;

    for (let i = 0; i < sorted.length; i++) {
      const acc = sorted[i]!;
      const chargeKw = maxByAcc[i]! * ratio;
      if (chargeKw > 0) {
        acc.storedEnergyKj = Math.min(
          acc.capacityKj,
          acc.storedEnergyKj + chargeKw * dtSeconds
        );
        acc.active = true;
        totalChargedKw += chargeKw;
      } else {
        acc.active = false;
      }
    }

    return {
      chargedKw: totalChargedKw,
      dischargedKw: 0,
      netGridContributionKw: -totalChargedKw,
    };
  }

  // Deficit (netPowerKw < 0): discharge proportionally
  const deficitKw = -netPowerKw;
  let totalAvailableKw = 0;
  const maxByAcc: number[] = [];

  for (const acc of sorted) {
    assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
    assertNonNegativeFinite(acc.capacityKj, `accumulator(${acc.id}).capacityKj`);
    assertNonNegativeFinite(
      acc.maxDischargeRateKw,
      `accumulator(${acc.id}).maxDischargeRateKw`
    );
    const availableKw = Math.min(acc.maxDischargeRateKw, acc.storedEnergyKj / dtSeconds);
    maxByAcc.push(availableKw);
    totalAvailableKw += availableKw;
  }

  if (totalAvailableKw <= 0) {
    for (const acc of sorted) {
      acc.active = false;
    }
    return {
      chargedKw: 0,
      dischargedKw: 0,
      netGridContributionKw: 0,
    };
  }

  const ratio = Math.min(1, deficitKw / totalAvailableKw);
  let totalDischargedKw = 0;

  for (let i = 0; i < sorted.length; i++) {
    const acc = sorted[i]!;
    const dischargeKw = maxByAcc[i]! * ratio;
    if (dischargeKw > 0) {
      acc.storedEnergyKj = Math.max(
        0,
        acc.storedEnergyKj - dischargeKw * dtSeconds
      );
      acc.active = true;
      totalDischargedKw += dischargeKw;
    } else {
      acc.active = false;
    }
  }

  return {
    chargedKw: 0,
    dischargedKw: totalDischargedKw,
    netGridContributionKw: totalDischargedKw,
  };
}

// ============================================================================
// World-Level Tick
// ============================================================================

/**
 * Advances the day/night clock (unless `options.advanceClock === false`)
 * and updates all solar panels in `world`.
 *
 * Designed to run at the start of the `power` tick phase right before
 * `solvePowerGrid(world)` so solar outputs feed into network satisfaction
 * and accumulator buffering without double-counting.
 */
export function tickSolarPower(
  world: WorldState,
  options: TickSolarPowerOptions = {}
): SolarPowerTickResult {
  const shouldAdvance = options.advanceClock ?? true;
  if (shouldAdvance) {
    advanceDayNightClock(world.dayNight, 1);
  } else {
    world.dayNight.cycleTick = normalizeCycleTick(world.dayNight.cycleTick);
    world.dayNight.solarFactor = computeSolarFactor(world.dayNight.cycleTick);
  }

  const panels = Object.values(world.entities)
    .filter(isSolarPanelEntity)
    .sort((a, b) => a.id - b.id);

  let totalSolarOutputKw = 0;
  let activePanelCount = 0;
  for (const panel of panels) {
    const outputKw = updateSolarPanel(panel, world.dayNight.solarFactor);
    totalSolarOutputKw += outputKw;
    if (panel.active) {
      activePanelCount += 1;
    }
  }

  return {
    cycleTick: world.dayNight.cycleTick,
    solarFactor: world.dayNight.solarFactor,
    phase: getDayNightPhase(world.dayNight.cycleTick),
    totalSolarOutputKw,
    activePanelCount,
  };
}
