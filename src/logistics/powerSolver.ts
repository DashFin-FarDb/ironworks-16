/**
 * Ironworks-16 Per-Tick Power Satisfaction Solver (T18)
 *
 * Computes per-network power satisfaction = clamp(supply / demand, 0, 1),
 * handles accumulator discharge/charge buffering, emits `powerBrownout` events,
 * and provides proportional speed-scaling helpers for electric machines.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  clamp,
  SimulationError,
  TICKS_PER_SECOND,
  type AccumulatorEntity,
  type Entity,
  type EntityId,
  type PowerNetwork,
  type PowerSatisfactionResult,
  type WorldState,
} from '../types/contracts';
import type { EventBus } from '../core/eventBus';
import {
  isPowerAccumulator,
  isPowerConsumer,
  isPowerProducer,
} from './powerGrid';

// ============================================================================
// Options
// ============================================================================

export interface SolvePowerOptions {
  /** Tick duration in seconds for accumulator energy transfer (default 1 / 60). */
  readonly dtSeconds?: number;
  /** Whether accumulators buffer deficits/surpluses (default true). */
  readonly useAccumulators?: boolean;
}

export interface SolvePowerGridOptions extends SolvePowerOptions {
  /** Optional simulation event bus for emitting `powerBrownout` events. */
  readonly eventBus?: EventBus;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new SimulationError(
      'INVALID_POWER_VALUE',
      `Expected non-negative finite number for ${label}, received ${String(value)}.`
    );
  }
}

// ============================================================================
// Core Pure Formulas
// ============================================================================

/**
 * Computes power satisfaction in [0, 1].
 * - 0 demand -> 1.0 (even when supply is 0)
 * - 0 supply with positive demand -> 0.0
 * - Otherwise clamp(supplyKw / demandKw, 0, 1)
 * - Never returns NaN; fails closed on non-finite or negative inputs.
 */
export function computePowerSatisfaction(
  supplyKw: number,
  demandKw: number
): number {
  assertNonNegativeFinite(supplyKw, 'supplyKw');
  assertNonNegativeFinite(demandKw, 'demandKw');

  if (demandKw === 0) {
    return 1.0;
  }
  if (supplyKw === 0) {
    return 0.0;
  }
  return clamp(supplyKw / demandKw, 0, 1);
}

/**
 * Scales an electric machine's base speed proportionally by power satisfaction.
 * Never returns NaN; fails closed on invalid baseSpeed or satisfaction.
 */
export function scaleMachineSpeed(
  baseSpeed: number,
  satisfaction: number
): number {
  assertNonNegativeFinite(baseSpeed, 'baseSpeed');
  assertNonNegativeFinite(satisfaction, 'satisfaction');

  return baseSpeed * clamp(satisfaction, 0, 1);
}

// ============================================================================
// Accumulator Buffering
// ============================================================================

function dischargeAccumulators(
  accumulators: readonly AccumulatorEntity[],
  deficitKw: number,
  dtSeconds: number
): number {
  if (deficitKw <= 0 || dtSeconds <= 0 || accumulators.length === 0) {
    return 0;
  }

  let totalAvailableKw = 0;
  const maxDrawByAcc: number[] = [];

  for (const acc of accumulators) {
    assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
    assertNonNegativeFinite(acc.maxDischargeRateKw, `accumulator(${acc.id}).maxDischargeRateKw`);
    const availableKw = Math.min(acc.maxDischargeRateKw, acc.storedEnergyKj / dtSeconds);
    maxDrawByAcc.push(availableKw);
    totalAvailableKw += availableKw;
  }

  if (totalAvailableKw <= 0) {
    return 0;
  }

  const ratio = Math.min(1, deficitKw / totalAvailableKw);
  let suppliedKw = 0;

  for (let i = 0; i < accumulators.length; i++) {
    const acc = accumulators[i]!;
    const drawKw = maxDrawByAcc[i]! * ratio;
    const energyDeltaKj = drawKw * dtSeconds;
    acc.storedEnergyKj = Math.max(0, acc.storedEnergyKj - energyDeltaKj);
    suppliedKw += drawKw;
  }

  return suppliedKw;
}

function chargeAccumulators(
  accumulators: readonly AccumulatorEntity[],
  surplusKw: number,
  dtSeconds: number
): number {
  if (surplusKw <= 0 || dtSeconds <= 0 || accumulators.length === 0) {
    return 0;
  }

  let totalCapacityKw = 0;
  const maxChargeByAcc: number[] = [];

  for (const acc of accumulators) {
    assertNonNegativeFinite(acc.storedEnergyKj, `accumulator(${acc.id}).storedEnergyKj`);
    assertNonNegativeFinite(acc.capacityKj, `accumulator(${acc.id}).capacityKj`);
    assertNonNegativeFinite(acc.maxChargeRateKw, `accumulator(${acc.id}).maxChargeRateKw`);
    const headroomKj = Math.max(0, acc.capacityKj - acc.storedEnergyKj);
    const acceptKw = Math.min(acc.maxChargeRateKw, headroomKj / dtSeconds);
    maxChargeByAcc.push(acceptKw);
    totalCapacityKw += acceptKw;
  }

  if (totalCapacityKw <= 0) {
    return 0;
  }

  const ratio = Math.min(1, surplusKw / totalCapacityKw);
  let chargedKw = 0;

  for (let i = 0; i < accumulators.length; i++) {
    const acc = accumulators[i]!;
    const chargeKw = maxChargeByAcc[i]! * ratio;
    const energyDeltaKj = chargeKw * dtSeconds;
    acc.storedEnergyKj = Math.min(acc.capacityKj, acc.storedEnergyKj + energyDeltaKj);
    chargedKw += chargeKw;
  }

  return chargedKw;
}

// ============================================================================
// Per-Network & World-Level Solvers
// ============================================================================

/**
 * Solves a single PowerNetwork in-place for the current tick.
 * Updates `totalSupplyKw`, `totalDemandKw`, and `satisfaction` on the network.
 */
export function solvePowerNetwork(
  network: PowerNetwork,
  entities: Record<EntityId, Entity>,
  options: SolvePowerOptions = {}
): PowerSatisfactionResult {
  const dtSeconds = options.dtSeconds ?? 1 / TICKS_PER_SECOND;
  assertNonNegativeFinite(dtSeconds, 'dtSeconds');
  const useAccumulators = options.useAccumulators ?? true;

  let supplyKw = 0;
  const sortedProducerIds = [...network.producerIds].sort((a, b) => a - b);
  for (const producerId of sortedProducerIds) {
    const entity = entities[producerId];
    if (!entity || !isPowerProducer(entity)) {
      continue;
    }
    assertNonNegativeFinite(entity.currentOutputKw, `producer(${entity.id}).currentOutputKw`);
    supplyKw += entity.currentOutputKw;
  }

  let demandKw = 0;
  const sortedConsumerIds = [...network.consumerIds].sort((a, b) => a - b);
  for (const consumerId of sortedConsumerIds) {
    const entity = entities[consumerId];
    if (!entity || !isPowerConsumer(entity)) {
      continue;
    }
    assertNonNegativeFinite(entity.powerDemandKw, `consumer(${entity.id}).powerDemandKw`);
    demandKw += entity.powerDemandKw;
  }

  if (useAccumulators && network.accumulatorIds.length > 0 && dtSeconds > 0) {
    const accumulators: AccumulatorEntity[] = [];
    const sortedAccIds = [...network.accumulatorIds].sort((a, b) => a - b);
    for (const accId of sortedAccIds) {
      const entity = entities[accId];
      if (entity && isPowerAccumulator(entity)) {
        accumulators.push(entity);
      }
    }

    if (supplyKw < demandKw) {
      supplyKw += dischargeAccumulators(accumulators, demandKw - supplyKw, dtSeconds);
    } else if (supplyKw > demandKw) {
      chargeAccumulators(accumulators, supplyKw - demandKw, dtSeconds);
    }
  }

  const satisfaction = computePowerSatisfaction(supplyKw, demandKw);
  const isBrownout = demandKw > 0 && satisfaction < 1.0;

  network.totalSupplyKw = supplyKw;
  network.totalDemandKw = demandKw;
  network.satisfaction = satisfaction;

  return {
    networkId: network.id,
    supplyKw,
    demandKw,
    satisfaction,
    isBrownout,
  };
}

/**
 * Solves all PowerNetworks in `world.powerGrid` in deterministic ascending ID order.
 * Emits `powerBrownout` on `options.eventBus` for each network experiencing a brownout.
 */
export function solvePowerGrid(
  world: WorldState,
  options: SolvePowerGridOptions = {}
): PowerSatisfactionResult[] {
  const sortedNetworks = Object.values(world.powerGrid.networks).sort(
    (a, b) => a.id - b.id
  );
  const results: PowerSatisfactionResult[] = [];

  for (const network of sortedNetworks) {
    const result = solvePowerNetwork(network, world.entities, options);
    results.push(result);

    if (result.isBrownout && options.eventBus) {
      options.eventBus.emit('powerBrownout', {
        tick: world.tick,
        networkId: result.networkId,
        satisfaction: result.satisfaction,
        supplyKw: result.supplyKw,
        demandKw: result.demandKw,
      });
    }
  }

  return results;
}

// ============================================================================
// Machine & Telemetry Query Helpers
// ============================================================================

/**
 * Returns the current power satisfaction [0, 1] for an entity.
 * Unconnected electric entities (powerNetworkId === null or unknown network) return 0.0.
 */
export function getEntityPowerSatisfaction(
  world: WorldState,
  entity: Entity
): number {
  if (entity.powerNetworkId === null) {
    return 0.0;
  }
  const network = world.powerGrid.networks[entity.powerNetworkId];
  if (!network) {
    return 0.0;
  }
  return clamp(network.satisfaction, 0, 1);
}

/**
 * Returns an electric machine's effective speed scaled by its network's satisfaction.
 */
export function getEffectiveMachineSpeed(
  world: WorldState,
  entity: Entity,
  baseSpeed: number
): number {
  return scaleMachineSpeed(baseSpeed, getEntityPowerSatisfaction(world, entity));
}

/**
 * Computes demand-weighted global power satisfaction across all networks in [0, 1].
 * Returns 1.0 if total demand across all networks is 0. Never returns NaN.
 */
export function getGlobalPowerSatisfaction(world: WorldState): number {
  const networks = Object.values(world.powerGrid.networks).sort(
    (a, b) => a.id - b.id
  );
  let totalDemand = 0;
  let weightedSum = 0;

  for (const network of networks) {
    if (network.totalDemandKw > 0) {
      totalDemand += network.totalDemandKw;
      weightedSum += clamp(network.satisfaction, 0, 1) * network.totalDemandKw;
    }
  }

  if (totalDemand === 0) {
    return 1.0;
  }

  return clamp(weightedSum / totalDemand, 0, 1);
}
