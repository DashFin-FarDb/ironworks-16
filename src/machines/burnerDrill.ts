/**
 * Ironworks-16 Burner Mining Drill (T22)
 *
 * Coal-fueled drill mining 1 ore / 90 ticks onto its front tile.
 * Halts cleanly if blocked, out of fuel, or resource is depleted.
 *
 * Invariants:
 * - Strictly headless: zero DOM, Window, or Canvas API imports.
 * - Strictly deterministic: no Math.random() or Date.now().
 * - Strict item & fuel conservation: ore is only mined when the front tile
 *   can accept it; fuel is only burned while actively mining.
 * - Fail-closed: invalid fuel items, corrupted state (NaN/negative), or
 *   invalid tick options throw typed SimulationError.
 */

import {
  OutOfBoundsError,
  SimulationError,
  isWithinBounds,
  stepCoord,
  type BurnerDrillEntity,
  type Direction,
  type Entity,
  type EntityId,
  type ItemId,
  type ResourceType,
  type Tile,
  type TileCoord,
  type WorldState,
} from '../types/contracts';
import {
  getFuelValueKj,
  getStackSize,
  isFuelItem,
} from '../core/itemRegistry';
import {
  canInsert,
  createInventoryState,
  getFirstAvailableItem,
  insertItem,
  removeItem,
} from '../core/inventory';
import { type EventBus } from '../core/eventBus';
import { canInsertOnLane } from '../logistics/belt';
import {
  INSERTER_BELT_DROP_OFFSET,
  dropIntoEntity,
} from '../logistics/inserter';
import { mineOneFromTile } from './resourceNode';

// ============================================================================
// Constants
// ============================================================================

/** Base ticks required to mine 1 ore (1 ore / 90 ticks = 0.667 ore/sec at 60 TPS). */
export const BURNER_DRILL_MINING_TICKS = 90;

/** Burner thermal power draw in kW (150 kW => 2.5 kJ/tick at 60 TPS). */
export const BURNER_DRILL_POWER_KW = 150;

/** Fuel energy consumed per active simulation tick in kJ (exact IEEE-754 binary fraction). */
export const BURNER_DRILL_FUEL_BURN_KJ_PER_TICK = BURNER_DRILL_POWER_KW / 60;

/** Number of slots in a burner drill's fuel inventory. */
export const BURNER_DRILL_FUEL_SLOTS = 1;

const COMPLETION_EPSILON = 1e-9;
const ENERGY_DUST_EPSILON = 1e-12;

// ============================================================================
// Types
// ============================================================================

export type BurnerDrillHaltReason =
  | 'no_resource'
  | 'out_of_bounds_output'
  | 'output_blocked'
  | 'no_fuel';

export interface BurnerDrillTickOptions {
  /** Current simulation tick (defaults to world.tick). */
  readonly tick?: number;
  /** Optional event bus for emitting itemProduced events. */
  readonly eventBus?: Pick<EventBus, 'emit'>;
  /** Optional override for ticks per ore (defaults to BURNER_DRILL_MINING_TICKS = 90). */
  readonly miningTicks?: number;
  /** Optional override for fuel burn rate in kJ/tick (defaults to BURNER_DRILL_FUEL_BURN_KJ_PER_TICK). */
  readonly fuelBurnKjPerTick?: number;
}

export interface BurnerDrillTickResult {
  readonly entityId: EntityId;
  readonly active: boolean;
  readonly mined: boolean;
  readonly minedItem: ResourceType | null;
  readonly fuelBurnedKj: number;
  readonly haltReason: BurnerDrillHaltReason | null;
}

// ============================================================================
// Factory & Helpers
// ============================================================================

/**
 * Creates a new BurnerDrillEntity with an empty 1-slot fuel inventory.
 */
export function createBurnerDrill(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N'
): BurnerDrillEntity {
  return {
    id,
    type: 'burner_drill',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    fuelInventory: createInventoryState(BURNER_DRILL_FUEL_SLOTS),
    fuelEnergyKj: 0,
    miningProgress: 0,
  };
}

/**
 * Computes the front output tile coordinate directly ahead of the drill.
 */
export function getBurnerDrillOutputCoord(drill: BurnerDrillEntity): TileCoord {
  return stepCoord(drill.position, drill.direction, 1);
}

/**
 * Inserts burnable fuel items into the drill's fuel inventory.
 * Fails closed with SimulationError if itemId is not a valid fuel item.
 * Returns the number of fuel items actually inserted.
 */
export function insertBurnerDrillFuel(
  drill: BurnerDrillEntity,
  itemId: ItemId,
  count: number
): number {
  if (!isFuelItem(itemId)) {
    throw new SimulationError(
      'INVALID_FUEL_ITEM',
      `Item "${itemId}" has no fuel value and cannot be inserted as burner drill fuel.`
    );
  }
  return insertItem(drill.fuelInventory, itemId, count, getStackSize);
}

// ============================================================================
// Internal Helpers
// ============================================================================

function getTileAt(world: WorldState, coord: TileCoord): Tile {
  const bounds = { width: world.width, height: world.height };
  if (!isWithinBounds(coord, bounds)) {
    throw new OutOfBoundsError(coord, bounds);
  }
  const tile = world.tiles[coord.y * world.width + coord.x];
  if (!tile) {
    throw new SimulationError(
      'CORRUPTED_TILEMAP',
      `Missing tile at (${coord.x}, ${coord.y}).`
    );
  }
  return tile;
}

function getEntityAtCoord(world: WorldState, coord: TileCoord): Entity | null {
  if (!isWithinBounds(coord, { width: world.width, height: world.height })) {
    return null;
  }
  const tile = world.tiles[coord.y * world.width + coord.x];
  if (!tile || tile.entityId === null) {
    return null;
  }
  return world.entities[tile.entityId] ?? null;
}

/**
 * Finds the first non-depleted resource tile under the drill's footprint
 * in deterministic row-major order (dy, then dx).
 */
function findResourceTileUnderDrill(
  world: WorldState,
  drill: BurnerDrillEntity
): Tile | null {
  const { width, height } = drill.footprint;
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const tile = getTileAt(world, {
        x: drill.position.x + dx,
        y: drill.position.y + dy,
      });
      if (tile.resource !== null && tile.resource.amount > 0) {
        return tile;
      }
    }
  }
  return null;
}

/**
 * Non-mutating check matching `dropIntoEntity` from `src/logistics/inserter.ts`.
 */
function canDropIntoEntity(entity: Entity | null, itemId: ItemId): boolean {
  if (!entity) return false;

  switch (entity.type) {
    case 'transport_belt':
      return (
        canInsertOnLane(entity.rightLane, INSERTER_BELT_DROP_OFFSET) ||
        canInsertOnLane(entity.leftLane, INSERTER_BELT_DROP_OFFSET)
      );
    case 'wooden_chest':
    case 'iron_chest':
      return canInsert(entity.inventory, itemId, 1, getStackSize) >= 1;
    case 'stone_furnace':
      if (isFuelItem(itemId)) {
        return canInsert(entity.fuelInventory, itemId, 1, getStackSize) >= 1;
      }
      return canInsert(entity.inputInventory, itemId, 1, getStackSize) >= 1;
    case 'electric_furnace':
    case 'assembler_mk1':
    case 'assembler_mk2':
    case 'research_lab':
      return canInsert(entity.inputInventory, itemId, 1, getStackSize) >= 1;
    case 'burner_drill':
    case 'boiler':
      if (!isFuelItem(itemId)) return false;
      return canInsert(entity.fuelInventory, itemId, 1, getStackSize) >= 1;
    default:
      return false;
  }
}

function assertValidDrillState(
  drill: BurnerDrillEntity,
  miningTicks: number,
  fuelBurnKjPerTick: number
): void {
  if (!Number.isFinite(miningTicks) || miningTicks <= 0) {
    throw new SimulationError(
      'INVALID_MINING_TICKS',
      `miningTicks must be a finite positive number; received ${miningTicks}.`
    );
  }
  if (!Number.isFinite(fuelBurnKjPerTick) || fuelBurnKjPerTick < 0) {
    throw new SimulationError(
      'INVALID_FUEL_BURN_RATE',
      `fuelBurnKjPerTick must be a finite non-negative number; received ${fuelBurnKjPerTick}.`
    );
  }
  if (!Number.isFinite(drill.fuelEnergyKj) || drill.fuelEnergyKj < 0) {
    throw new SimulationError(
      'CORRUPTED_DRILL_STATE',
      `Burner drill ${drill.id} has invalid fuelEnergyKj: ${drill.fuelEnergyKj}.`
    );
  }
  if (!Number.isFinite(drill.miningProgress) || drill.miningProgress < 0) {
    throw new SimulationError(
      'CORRUPTED_DRILL_STATE',
      `Burner drill ${drill.id} has invalid miningProgress: ${drill.miningProgress}.`
    );
  }
}

/**
 * Attempts to consume fuel energy for one active tick.
 * Refills fuelEnergyKj from fuelInventory if needed.
 * Returns true if enough fuel energy was available and consumed.
 */
function consumeFuelForTick(
  drill: BurnerDrillEntity,
  fuelBurnKjPerTick: number
): boolean {
  if (fuelBurnKjPerTick === 0) {
    return true;
  }

  while (drill.fuelEnergyKj + ENERGY_DUST_EPSILON < fuelBurnKjPerTick) {
    const nextFuel = getFirstAvailableItem(drill.fuelInventory);
    if (nextFuel === null || !isFuelItem(nextFuel)) {
      return false;
    }
    const fuelValue = getFuelValueKj(nextFuel);
    if (fuelValue <= 0) {
      return false;
    }
    const removed = removeItem(drill.fuelInventory, nextFuel, 1);
    if (removed !== 1) {
      return false;
    }
    drill.fuelEnergyKj += fuelValue;
  }

  const remaining = drill.fuelEnergyKj - fuelBurnKjPerTick;
  drill.fuelEnergyKj = remaining < ENERGY_DUST_EPSILON ? 0 : remaining;
  return true;
}

// ============================================================================
// Simulation Tick
// ============================================================================

/**
 * Advances a single BurnerDrillEntity by one simulation tick.
 *
 * Halts cleanly (active = false, zero fuel burned) when:
 * - No non-depleted ore deposit exists under the drill ('no_resource')
 * - Front output tile is outside map bounds ('out_of_bounds_output')
 * - Front output tile has no receiver or receiver is full/blocked ('output_blocked')
 * - No fuel energy remains and fuelInventory has no burnable fuel ('no_fuel')
 */
export function tickBurnerDrill(
  world: WorldState,
  drill: BurnerDrillEntity,
  options: BurnerDrillTickOptions = {}
): BurnerDrillTickResult {
  const miningTicks = options.miningTicks ?? BURNER_DRILL_MINING_TICKS;
  const fuelBurnKjPerTick =
    options.fuelBurnKjPerTick ?? BURNER_DRILL_FUEL_BURN_KJ_PER_TICK;
  const tick = options.tick ?? world.tick;

  assertValidDrillState(drill, miningTicks, fuelBurnKjPerTick);

  // 1. Verify ore deposit under drill footprint
  const resourceTile = findResourceTileUnderDrill(world, drill);
  if (resourceTile === null || resourceTile.resource === null) {
    drill.active = false;
    return {
      entityId: drill.id,
      active: false,
      mined: false,
      minedItem: null,
      fuelBurnedKj: 0,
      haltReason: 'no_resource',
    };
  }

  const targetItemId: ResourceType = resourceTile.resource.type;

  // 2. Verify front output tile is in bounds and can accept the ore
  const outputCoord = getBurnerDrillOutputCoord(drill);
  if (!isWithinBounds(outputCoord, { width: world.width, height: world.height })) {
    drill.active = false;
    return {
      entityId: drill.id,
      active: false,
      mined: false,
      minedItem: null,
      fuelBurnedKj: 0,
      haltReason: 'out_of_bounds_output',
    };
  }

  const targetEntity = getEntityAtCoord(world, outputCoord);
  if (!canDropIntoEntity(targetEntity, targetItemId)) {
    drill.active = false;
    return {
      entityId: drill.id,
      active: false,
      mined: false,
      minedItem: null,
      fuelBurnedKj: 0,
      haltReason: 'output_blocked',
    };
  }

  // 3. Consume fuel for this tick
  if (!consumeFuelForTick(drill, fuelBurnKjPerTick)) {
    drill.active = false;
    return {
      entityId: drill.id,
      active: false,
      mined: false,
      minedItem: null,
      fuelBurnedKj: 0,
      haltReason: 'no_fuel',
    };
  }

  // 4. Advance mining progress
  drill.active = true;
  drill.miningProgress += 1;

  if (drill.miningProgress + COMPLETION_EPSILON >= miningTicks) {
    // Atomic conservation: only decrement ore if output drop succeeds
    const dropped = dropIntoEntity(targetEntity, targetItemId);
    if (!dropped) {
      drill.miningProgress = miningTicks;
      drill.active = false;
      return {
        entityId: drill.id,
        active: false,
        mined: false,
        minedItem: null,
        fuelBurnedKj: fuelBurnKjPerTick,
        haltReason: 'output_blocked',
      };
    }

    const mineResult = mineOneFromTile(resourceTile);
    if (!mineResult.mined || mineResult.itemId === null) {
      throw new SimulationError(
        'CORRUPTED_RESOURCE_STATE',
        `Expected mineable resource at (${resourceTile.x}, ${resourceTile.y}) for burner drill ${drill.id}.`
      );
    }

    drill.miningProgress = 0;

    if (options.eventBus) {
      options.eventBus.emit('itemProduced', {
        tick,
        itemId: mineResult.itemId,
        count: 1,
        entityId: drill.id,
      });
    }

    return {
      entityId: drill.id,
      active: true,
      mined: true,
      minedItem: mineResult.itemId,
      fuelBurnedKj: fuelBurnKjPerTick,
      haltReason: null,
    };
  }

  return {
    entityId: drill.id,
    active: true,
    mined: false,
    minedItem: null,
    fuelBurnedKj: fuelBurnKjPerTick,
    haltReason: null,
  };
}

/**
 * Deterministically ticks all `'burner_drill'` entities in `world`
 * in ascending `EntityId` order.
 */
export function tickAllBurnerDrills(
  world: WorldState,
  options: BurnerDrillTickOptions = {}
): BurnerDrillTickResult[] {
  const ids = Object.keys(world.entities)
    .map(Number)
    .sort((a, b) => a - b);

  const results: BurnerDrillTickResult[] = [];
  for (const id of ids) {
    const entity = world.entities[id];
    if (entity && entity.type === 'burner_drill') {
      results.push(tickBurnerDrill(world, entity, options));
    }
  }
  return results;
}
