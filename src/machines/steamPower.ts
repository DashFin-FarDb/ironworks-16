/**
 * Ironworks-16 Steam Power Generation (T28)
 *
 * Implements coal-fueled Boilers and Steam Engines supplying up to 900 kW
 * per Steam Engine to its connected power network.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  clamp,
  SimulationError,
  TICKS_PER_SECOND,
  type BoilerEntity,
  type Entity,
  type ItemId,
  type SteamEngineEntity,
  type TileCoord,
  type WorldState,
} from '../types/contracts';
import { getFuelValueKj, getStackSize, isFuelItem } from '../core/itemRegistry';
import { insertItem, removeItem } from '../core/inventory';

// ============================================================================
// Constants
// ============================================================================

/** Default maximum electrical output of a Steam Engine in kW. */
export const STEAM_ENGINE_MAX_OUTPUT_KW = 900;

/** Maximum steam buffer capacity of a Boiler. */
export const BOILER_MAX_STEAM_BUFFER = 100;

/** Thermal energy equivalent of 1 unit of steam in kJ (900 kW / 60 ticks/s = 15 kJ/tick). */
export const KJ_PER_STEAM_UNIT = STEAM_ENGINE_MAX_OUTPUT_KW / TICKS_PER_SECOND;

/** Maximum steam units a Boiler can generate per tick (1800 kW thermal = 2 engines). */
export const BOILER_MAX_STEAM_PER_TICK = 2;

/** Maximum thermal power rating of a Boiler in kW. */
export const BOILER_MAX_POWER_KW =
  BOILER_MAX_STEAM_PER_TICK * KJ_PER_STEAM_UNIT * TICKS_PER_SECOND;

const ENERGY_EPSILON = 1e-9;

// ============================================================================
// Result Types
// ============================================================================

export interface BoilerTickResult {
  readonly boilerId: number;
  readonly fuelConsumed: boolean;
  readonly fuelItemId: ItemId | null;
  readonly energyBurnedKj: number;
  readonly steamProduced: number;
  readonly steamBuffer: number;
  readonly active: boolean;
}

export interface SteamEngineTickResult {
  readonly engineId: number;
  readonly steamConsumed: number;
  readonly outputKw: number;
  readonly active: boolean;
}

export interface SteamPowerTickSummary {
  readonly boilers: readonly BoilerTickResult[];
  readonly engines: readonly SteamEngineTickResult[];
  readonly totalOutputKw: number;
}

// ============================================================================
// Predicates & Validation
// ============================================================================

export function isBoiler(entity: Entity): entity is BoilerEntity {
  return entity.type === 'boiler';
}

export function isSteamEngine(entity: Entity): entity is SteamEngineEntity {
  return entity.type === 'steam_engine';
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new SimulationError(
      'INVALID_STEAM_POWER_STATE',
      `Expected non-negative finite number for ${label}, received ${String(value)}.`
    );
  }
}

/**
 * Returns true if two tile coordinates are orthogonally adjacent (Manhattan distance 1).
 */
export function areTilesAdjacent(a: TileCoord, b: TileCoord): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/**
 * Returns all Boilers orthogonally adjacent to the given Steam Engine,
 * sorted in deterministic ascending EntityId order.
 */
export function getAdjacentBoilers(
  world: WorldState,
  engine: SteamEngineEntity
): BoilerEntity[] {
  const adjacent: BoilerEntity[] = [];
  for (const entity of Object.values(world.entities)) {
    if (isBoiler(entity) && areTilesAdjacent(entity.position, engine.position)) {
      adjacent.push(entity);
    }
  }
  adjacent.sort((a, b) => a.id - b.id);
  return adjacent;
}

// ============================================================================
// Fuel Insertion Helper
// ============================================================================

/**
 * Inserts burnable fuel into a Boiler's fuel inventory.
 * Fails closed if `itemId` is unknown or not a burnable fuel item.
 * Returns the number of items actually inserted.
 */
export function insertBoilerFuel(
  boiler: BoilerEntity,
  itemId: ItemId,
  count: number
): number {
  if (!isFuelItem(itemId)) {
    throw new SimulationError(
      'INVALID_FUEL_ITEM',
      `Item "${itemId}" is not a burnable fuel and cannot be inserted into a boiler.`
    );
  }
  return insertItem(boiler.fuelInventory, itemId, count, getStackSize);
}

// ============================================================================
// Per-Tick Simulation Updates
// ============================================================================

/**
 * Consumes 1 unit of the first available burnable fuel item from a Boiler's fuel inventory.
 * Returns the consumed ItemId and its fuel energy in kJ, or null if no fuel is available.
 */
function consumeOneFuelFromBoiler(
  boiler: BoilerEntity
): { itemId: ItemId; fuelKj: number } | null {
  for (const slot of boiler.fuelInventory.slots) {
    if (slot.item !== null && slot.item.count > 0) {
      const fuelKj = getFuelValueKj(slot.item.itemId);
      if (fuelKj > 0) {
        const itemId = slot.item.itemId;
        const removed = removeItem(boiler.fuelInventory, itemId, 1);
        if (removed === 1) {
          return { itemId, fuelKj };
        }
      }
    }
  }
  return null;
}

/**
 * Advances a single Boiler by one simulation tick.
 * Burns coal (or any burnable fuel) to replenish `steamBuffer` up to `BOILER_MAX_STEAM_BUFFER`.
 * Halts cleanly (without wasting fuel) when `steamBuffer` is full or fuel is exhausted.
 */
export function updateBoiler(boiler: BoilerEntity): BoilerTickResult {
  assertNonNegativeFinite(boiler.fuelEnergyKj, `boiler(${boiler.id}).fuelEnergyKj`);
  assertNonNegativeFinite(boiler.steamBuffer, `boiler(${boiler.id}).steamBuffer`);

  boiler.steamBuffer = clamp(boiler.steamBuffer, 0, BOILER_MAX_STEAM_BUFFER);

  const steamSpace = BOILER_MAX_STEAM_BUFFER - boiler.steamBuffer;
  if (steamSpace <= ENERGY_EPSILON) {
    boiler.steamBuffer = BOILER_MAX_STEAM_BUFFER;
    boiler.active = false;
    return {
      boilerId: boiler.id,
      fuelConsumed: false,
      fuelItemId: null,
      energyBurnedKj: 0,
      steamProduced: 0,
      steamBuffer: boiler.steamBuffer,
      active: false,
    };
  }

  const steamWanted = Math.min(BOILER_MAX_STEAM_PER_TICK, steamSpace);
  const energyNeededKj = steamWanted * KJ_PER_STEAM_UNIT;

  let fuelConsumed = false;
  let fuelItemId: ItemId | null = null;

  if (boiler.fuelEnergyKj < energyNeededKj) {
    const consumed = consumeOneFuelFromBoiler(boiler);
    if (consumed !== null) {
      boiler.fuelEnergyKj += consumed.fuelKj;
      fuelConsumed = true;
      fuelItemId = consumed.itemId;
    }
  }

  const energyBurnedKj = Math.min(boiler.fuelEnergyKj, energyNeededKj);
  if (energyBurnedKj <= ENERGY_EPSILON) {
    boiler.fuelEnergyKj = 0;
    boiler.active = false;
    return {
      boilerId: boiler.id,
      fuelConsumed,
      fuelItemId,
      energyBurnedKj: 0,
      steamProduced: 0,
      steamBuffer: boiler.steamBuffer,
      active: false,
    };
  }

  boiler.fuelEnergyKj -= energyBurnedKj;
  if (boiler.fuelEnergyKj < ENERGY_EPSILON) {
    boiler.fuelEnergyKj = 0;
  }

  const steamProduced = energyBurnedKj / KJ_PER_STEAM_UNIT;
  boiler.steamBuffer = clamp(
    boiler.steamBuffer + steamProduced,
    0,
    BOILER_MAX_STEAM_BUFFER
  );
  boiler.active = true;

  return {
    boilerId: boiler.id,
    fuelConsumed,
    fuelItemId,
    energyBurnedKj,
    steamProduced,
    steamBuffer: boiler.steamBuffer,
    active: true,
  };
}

/**
 * Advances a single Steam Engine by one simulation tick.
 * Draws steam from orthogonally adjacent Boilers (in ascending EntityId order)
 * and sets `currentOutputKw` proportionally up to `maxPowerOutputKw` (default 900 kW).
 */
export function updateSteamEngine(
  world: WorldState,
  engine: SteamEngineEntity
): SteamEngineTickResult {
  assertNonNegativeFinite(
    engine.maxPowerOutputKw,
    `steam_engine(${engine.id}).maxPowerOutputKw`
  );

  if (engine.maxPowerOutputKw === 0) {
    engine.currentOutputKw = 0;
    engine.active = false;
    return {
      engineId: engine.id,
      steamConsumed: 0,
      outputKw: 0,
      active: false,
    };
  }

  const steamNeeded =
    engine.maxPowerOutputKw / TICKS_PER_SECOND / KJ_PER_STEAM_UNIT;
  const adjacentBoilers = getAdjacentBoilers(world, engine);

  let steamDrawn = 0;
  for (const boiler of adjacentBoilers) {
    assertNonNegativeFinite(boiler.steamBuffer, `boiler(${boiler.id}).steamBuffer`);
    const remainingNeed = steamNeeded - steamDrawn;
    if (remainingNeed <= ENERGY_EPSILON) {
      break;
    }
    const draw = Math.min(boiler.steamBuffer, remainingNeed);
    if (draw > 0) {
      boiler.steamBuffer -= draw;
      if (boiler.steamBuffer < ENERGY_EPSILON) {
        boiler.steamBuffer = 0;
      }
      steamDrawn += draw;
    }
  }

  const ratio = clamp(steamDrawn / steamNeeded, 0, 1);
  const outputKw = ratio * engine.maxPowerOutputKw;

  engine.currentOutputKw = outputKw < ENERGY_EPSILON ? 0 : outputKw;
  engine.active = engine.currentOutputKw > 0;

  return {
    engineId: engine.id,
    steamConsumed: steamDrawn,
    outputKw: engine.currentOutputKw,
    active: engine.active,
  };
}

/**
 * Advances all Boilers and Steam Engines in the world by one simulation tick.
 * Boilers update first (in ascending EntityId order) to replenish steam buffers,
 * followed by Steam Engines (in ascending EntityId order) to draw steam and set `currentOutputKw`.
 *
 * Should be called during the `power` tick phase before `solvePowerGrid(world)`.
 */
export function updateSteamPower(world: WorldState): SteamPowerTickSummary {
  const boilers: BoilerEntity[] = [];
  const engines: SteamEngineEntity[] = [];

  for (const entity of Object.values(world.entities)) {
    if (isBoiler(entity)) {
      boilers.push(entity);
    } else if (isSteamEngine(entity)) {
      engines.push(entity);
    }
  }

  boilers.sort((a, b) => a.id - b.id);
  engines.sort((a, b) => a.id - b.id);

  const boilerResults: BoilerTickResult[] = [];
  for (const boiler of boilers) {
    boilerResults.push(updateBoiler(boiler));
  }

  const engineResults: SteamEngineTickResult[] = [];
  let totalOutputKw = 0;
  for (const engine of engines) {
    const res = updateSteamEngine(world, engine);
    engineResults.push(res);
    totalOutputKw += res.outputKw;
  }

  return {
    boilers: boilerResults,
    engines: engineResults,
    totalOutputKw,
  };
}
