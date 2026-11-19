/**
 * Ironworks-16 Electric Drill (T23)
 *
 * 90 kW electric mining drill mining 1 ore / 45 ticks onto its front tile,
 * scaled proportionally by power satisfaction.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 * Item & mass conservation: ore is only decremented from the underlying
 * ResourceNode when the front target tile successfully accepts the item.
 * Fail-closed: invalid drill state, coordinates, or footprints throw typed
 * SimulationError / OutOfBoundsError rather than silently corrupting state.
 */

import {
  DIRECTIONS,
  Direction,
  ElectricDrillEntity,
  EntityFootprint,
  EntityId,
  ItemId,
  OutOfBoundsError,
  ResourceType,
  SimulationError,
  Tile,
  TileCoord,
  WorldState,
  isWithinBounds,
  stepCoord,
} from '../types/contracts';
import { EventBus } from '../core/eventBus';
import { insertItem, StackSizeResolver } from '../core/inventory';
import { insertOnBelt, insertOnLane } from '../logistics/belt';
import {
  getEntityPowerSatisfaction,
  scaleMachineSpeed,
} from '../logistics/powerSolver';
import { assertValidResourceNode, mineOneFromTile } from './resourceNode';

export const ELECTRIC_DRILL_POWER_DEMAND_KW = 90;
export const ELECTRIC_DRILL_MINING_TICKS = 45;
export const ELECTRIC_DRILL_BASE_SPEED = 1;
export const ELECTRIC_DRILL_FOOTPRINT: EntityFootprint = Object.freeze({
  width: 1,
  height: 1,
});

const PROGRESS_EPSILON = 1e-9;

export type ElectricDrillHaltReason =
  | 'no_power'
  | 'no_resource'
  | 'output_blocked';

export type DrillOutputHandler = (
  itemId: ResourceType,
  targetCoord: TileCoord,
  drill: ElectricDrillEntity,
  world: WorldState
) => boolean;

export interface ElectricDrillTickContext {
  readonly eventBus?: EventBus;
  readonly getStackSize?: StackSizeResolver;
  /** Optional override for delivering mined ore to the front tile. */
  readonly tryDropItem?: DrillOutputHandler;
}

export interface ElectricDrillTickResult {
  readonly entityId: EntityId;
  readonly mined: boolean;
  readonly itemId: ResourceType | null;
  readonly active: boolean;
  readonly powerSatisfaction: number;
  readonly progressDelta: number;
  readonly haltReason: ElectricDrillHaltReason | null;
  readonly depleted: boolean;
}

/**
 * Create a new ElectricDrillEntity with canonical 90 kW power demand
 * and 1x1 footprint.
 */
export function createElectricDrill(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'N'
): ElectricDrillEntity {
  if (!Number.isInteger(id) || id <= 0) {
    throw new SimulationError(
      'INVALID_ENTITY_ID',
      `Electric drill ID must be a positive integer; received ${id}.`
    );
  }
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new SimulationError(
      'INVALID_POSITION',
      `Electric drill position must have integer coordinates; received (${position.x}, ${position.y}).`
    );
  }
  if (!DIRECTIONS.includes(direction)) {
    throw new SimulationError(
      'INVALID_DIRECTION',
      `Invalid electric drill direction: "${String(direction)}".`
    );
  }

  return {
    id,
    type: 'electric_drill',
    position: { x: position.x, y: position.y },
    direction,
    footprint: {
      width: ELECTRIC_DRILL_FOOTPRINT.width,
      height: ELECTRIC_DRILL_FOOTPRINT.height,
    },
    powerNetworkId: null,
    active: false,
    powerDemandKw: ELECTRIC_DRILL_POWER_DEMAND_KW,
    miningProgress: 0,
  };
}

/**
 * Compute the front output tile coordinate where the drill drops mined ore.
 */
export function getElectricDrillOutputCoord(
  drill: Pick<ElectricDrillEntity, 'position' | 'direction'>
): TileCoord {
  return stepCoord(drill.position, drill.direction, 1);
}

function assertValidElectricDrill(drill: ElectricDrillEntity): void {
  if (
    !Number.isFinite(drill.powerDemandKw) ||
    drill.powerDemandKw < 0
  ) {
    throw new SimulationError(
      'INVALID_POWER_VALUE',
      `Electric drill ${drill.id} has invalid powerDemandKw: ${drill.powerDemandKw}.`
    );
  }
  if (
    !Number.isFinite(drill.miningProgress) ||
    drill.miningProgress < 0
  ) {
    throw new SimulationError(
      'INVALID_MINING_PROGRESS',
      `Electric drill ${drill.id} has invalid miningProgress: ${drill.miningProgress}.`
    );
  }
  if (
    !Number.isInteger(drill.footprint.width) ||
    drill.footprint.width <= 0 ||
    !Number.isInteger(drill.footprint.height) ||
    drill.footprint.height <= 0
  ) {
    throw new SimulationError(
      'INVALID_FOOTPRINT',
      `Electric drill ${drill.id} has invalid footprint (${drill.footprint.width}x${drill.footprint.height}).`
    );
  }
}

function getWorldTile(world: WorldState, coord: TileCoord): Tile {
  const bounds = { width: world.width, height: world.height };
  if (!isWithinBounds(coord, bounds)) {
    throw new OutOfBoundsError(coord, bounds);
  }
  const index = coord.y * world.width + coord.x;
  const tile = world.tiles[index];
  if (!tile) {
    throw new OutOfBoundsError(coord, bounds);
  }
  return tile;
}

/**
 * Deterministically find the first non-depleted resource tile under the drill's
 * footprint (row-major order: dy then dx) without mutating it.
 * Validates all footprint tiles are in bounds (fail-closed).
 */
function findFirstResourceTile(
  world: WorldState,
  drill: ElectricDrillEntity
): Tile | null {
  const footprintTiles: Tile[] = [];
  for (let dy = 0; dy < drill.footprint.height; dy++) {
    for (let dx = 0; dx < drill.footprint.width; dx++) {
      footprintTiles.push(
        getWorldTile(world, {
          x: drill.position.x + dx,
          y: drill.position.y + dy,
        })
      );
    }
  }

  for (const tile of footprintTiles) {
    if (tile.resource !== null) {
      assertValidResourceNode(tile.resource);
      if (tile.resource.amount > 0) {
        return tile;
      }
      // Clean up stale 0-amount resource node deterministically
      tile.resource = null;
    }
  }

  return null;
}

/**
 * Attempt to deliver 1 unit of mined ore to the entity occupying the drill's
 * front tile. Returns true only when the item is conserved in a valid target.
 */
export function tryDeliverOreToFrontTile(
  world: WorldState,
  drill: ElectricDrillEntity,
  itemId: ItemId,
  getStackSize?: StackSizeResolver
): boolean {
  const targetCoord = getElectricDrillOutputCoord(drill);
  const bounds = { width: world.width, height: world.height };
  if (!isWithinBounds(targetCoord, bounds)) {
    return false;
  }

  const targetTile = world.tiles[targetCoord.y * world.width + targetCoord.x];
  if (!targetTile || targetTile.entityId === null) {
    return false;
  }

  const targetEntity = world.entities[targetTile.entityId];
  if (!targetEntity) {
    return false;
  }

  switch (targetEntity.type) {
    case 'transport_belt':
      return (
        insertOnBelt(targetEntity, 'left', itemId, 0) ||
        insertOnBelt(targetEntity, 'right', itemId, 0)
      );

    case 'splitter':
      return (
        insertOnLane(targetEntity.leftLane, itemId, 0) ||
        insertOnLane(targetEntity.rightLane, itemId, 0)
      );

    case 'wooden_chest':
    case 'iron_chest':
      return insertItem(targetEntity.inventory, itemId, 1, getStackSize) === 1;

    case 'stone_furnace':
      if (itemId === 'coal') {
        if (
          insertItem(targetEntity.fuelInventory, itemId, 1, getStackSize) === 1
        ) {
          return true;
        }
      }
      return (
        insertItem(targetEntity.inputInventory, itemId, 1, getStackSize) === 1
      );

    case 'electric_furnace':
    case 'assembler_mk1':
    case 'assembler_mk2':
      return (
        insertItem(targetEntity.inputInventory, itemId, 1, getStackSize) === 1
      );

    case 'burner_drill':
    case 'boiler':
      if (itemId === 'coal') {
        return (
          insertItem(targetEntity.fuelInventory, itemId, 1, getStackSize) === 1
        );
      }
      return false;

    default:
      return false;
  }
}

/**
 * Advance a single ElectricDrillEntity by 1 simulation tick.
 *
 * - Scales mining progress by `getEntityPowerSatisfaction(world, drill)`.
 * - Halts cleanly on `no_power` (unconnected or 0% power), `no_resource`
 *   (no/depleted ore under footprint), or `output_blocked` (front tile cannot
 *   accept the mined ore).
 * - Guarantees strict item/mass conservation: ore is only decremented from
 *   the resource tile once delivery succeeds.
 */
export function tickElectricDrill(
  world: WorldState,
  drill: ElectricDrillEntity,
  context: ElectricDrillTickContext = {}
): ElectricDrillTickResult {
  assertValidElectricDrill(drill);

  const satisfaction = getEntityPowerSatisfaction(world, drill);
  if (satisfaction <= 0) {
    drill.active = false;
    return {
      entityId: drill.id,
      mined: false,
      itemId: null,
      active: false,
      powerSatisfaction: 0,
      progressDelta: 0,
      haltReason: 'no_power',
      depleted: false,
    };
  }

  const resourceTile = findFirstResourceTile(world, drill);
  if (resourceTile === null || resourceTile.resource === null) {
    drill.active = false;
    return {
      entityId: drill.id,
      mined: false,
      itemId: null,
      active: false,
      powerSatisfaction: satisfaction,
      progressDelta: 0,
      haltReason: 'no_resource',
      depleted: true,
    };
  }

  const oreType: ResourceType = resourceTile.resource.type;
  const targetCoord = getElectricDrillOutputCoord(drill);

  // If already at full progress (e.g. recovering from output_blocked), do not
  // accumulate extra progress before attempting delivery.
  const alreadyReady =
    drill.miningProgress + PROGRESS_EPSILON >= ELECTRIC_DRILL_MINING_TICKS;
  const progressDelta = alreadyReady
    ? 0
    : scaleMachineSpeed(ELECTRIC_DRILL_BASE_SPEED, satisfaction);
  const nextProgress = drill.miningProgress + progressDelta;

  if (nextProgress + PROGRESS_EPSILON < ELECTRIC_DRILL_MINING_TICKS) {
    drill.miningProgress = nextProgress;
    drill.active = true;
    return {
      entityId: drill.id,
      mined: false,
      itemId: null,
      active: true,
      powerSatisfaction: satisfaction,
      progressDelta,
      haltReason: null,
      depleted: false,
    };
  }

  // Progress reached 45 ticks: attempt to deliver before consuming the ore.
  const delivered = context.tryDropItem
    ? context.tryDropItem(oreType, targetCoord, drill, world)
    : tryDeliverOreToFrontTile(world, drill, oreType, context.getStackSize);

  if (!delivered) {
    drill.miningProgress = ELECTRIC_DRILL_MINING_TICKS;
    drill.active = false;
    return {
      entityId: drill.id,
      mined: false,
      itemId: null,
      active: false,
      powerSatisfaction: satisfaction,
      progressDelta: 0,
      haltReason: 'output_blocked',
      depleted: false,
    };
  }

  const mineResult = mineOneFromTile(resourceTile);
  if (!mineResult.mined || mineResult.itemId === null) {
    throw new SimulationError(
      'MINE_INVARIANT_VIOLATION',
      `Electric drill ${drill.id} delivered "${oreType}" but failed to decrement resource node.`
    );
  }

  const remainder = nextProgress - ELECTRIC_DRILL_MINING_TICKS;
  drill.miningProgress = remainder <= PROGRESS_EPSILON ? 0 : remainder;
  drill.active = true;

  if (context.eventBus) {
    context.eventBus.emit('itemProduced', {
      tick: world.tick,
      itemId: mineResult.itemId,
      count: 1,
      entityId: drill.id,
    });
  }

  return {
    entityId: drill.id,
    mined: true,
    itemId: mineResult.itemId,
    active: true,
    powerSatisfaction: satisfaction,
    progressDelta,
    haltReason: null,
    depleted: mineResult.depleted,
  };
}

/**
 * Tick all `electric_drill` entities in `world` in deterministic ascending
 * `EntityId` order.
 */
export function tickAllElectricDrills(
  world: WorldState,
  context: ElectricDrillTickContext = {}
): ElectricDrillTickResult[] {
  const drills: ElectricDrillEntity[] = [];
  for (const entity of Object.values(world.entities)) {
    if (entity.type === 'electric_drill') {
      drills.push(entity);
    }
  }
  drills.sort((a, b) => a.id - b.id);

  const results: ElectricDrillTickResult[] = [];
  for (const drill of drills) {
    results.push(tickElectricDrill(world, drill, context));
  }
  return results;
}
