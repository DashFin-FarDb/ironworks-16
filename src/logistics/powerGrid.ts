/**
 * Ironworks-16 Power Grid & Graph Partitioning (T17)
 *
 * Manages power pole wire connections (wireReach = 7), square supply coverage
 * (supplyRadius = 5), and deterministic connected-component partitioning of
 * producers, consumers, and accumulators into PowerNetworks.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  SimulationError,
  type AccumulatorEntity,
  type AssemblerEntity,
  type ElectricDrillEntity,
  type ElectricFurnaceEntity,
  type Entity,
  type EntityId,
  type PowerGridState,
  type PowerNetwork,
  type PowerNetworkId,
  type PowerPoleEntity,
  type ResearchLabEntity,
  type SolarPanelEntity,
  type SteamEngineEntity,
  type TileCoord,
  type WorldState,
} from '../types/contracts';

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_SUPPLY_RADIUS = 5;
export const DEFAULT_WIRE_REACH = 7;

// ============================================================================
// Entity Classification Predicates
// ============================================================================

export type PowerProducerEntity = SteamEngineEntity | SolarPanelEntity;

export type PowerConsumerEntity =
  | ElectricDrillEntity
  | ElectricFurnaceEntity
  | AssemblerEntity
  | ResearchLabEntity;

export type PowerParticipantEntity =
  | PowerProducerEntity
  | PowerConsumerEntity
  | AccumulatorEntity;

export interface WireConnection {
  readonly from: EntityId;
  readonly to: EntityId;
}

export function isPowerPole(entity: Entity): entity is PowerPoleEntity {
  return entity.type === 'power_pole';
}

export function isPowerProducer(entity: Entity): entity is PowerProducerEntity {
  return entity.type === 'steam_engine' || entity.type === 'solar_panel';
}

export function isPowerConsumer(entity: Entity): entity is PowerConsumerEntity {
  return (
    entity.type === 'electric_drill' ||
    entity.type === 'electric_furnace' ||
    entity.type === 'assembler_mk1' ||
    entity.type === 'assembler_mk2' ||
    entity.type === 'research_lab'
  );
}

export function isPowerAccumulator(entity: Entity): entity is AccumulatorEntity {
  return entity.type === 'accumulator';
}

export function isPowerParticipant(entity: Entity): entity is PowerParticipantEntity {
  return (
    isPowerProducer(entity) ||
    isPowerConsumer(entity) ||
    isPowerAccumulator(entity)
  );
}

// ============================================================================
// Validation & Spatial Helpers
// ============================================================================

function validatePowerPole(pole: PowerPoleEntity): void {
  if (!Number.isFinite(pole.supplyRadius) || pole.supplyRadius < 0) {
    throw new SimulationError(
      'INVALID_POWER_POLE',
      `Power pole ${pole.id} has invalid supplyRadius: ${String(pole.supplyRadius)}.`
    );
  }
  if (!Number.isFinite(pole.wireReach) || pole.wireReach < 0) {
    throw new SimulationError(
      'INVALID_POWER_POLE',
      `Power pole ${pole.id} has invalid wireReach: ${String(pole.wireReach)}.`
    );
  }
}

/**
 * Returns squared Euclidean distance between two tile coordinates.
 */
export function getDistanceSq(a: TileCoord, b: TileCoord): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Returns true if two distinct power poles are within wire reach of each other.
 * Uses squared Euclidean distance against min(a.wireReach, b.wireReach).
 */
export function canPolesConnect(a: PowerPoleEntity, b: PowerPoleEntity): boolean {
  if (a.id === b.id) {
    return false;
  }
  validatePowerPole(a);
  validatePowerPole(b);
  const effectiveReach = Math.min(a.wireReach, b.wireReach);
  return getDistanceSq(a.position, b.position) <= effectiveReach * effectiveReach;
}

/**
 * Returns true if a tile lies within a power pole's square supply area
 * (Chebyshev distance <= pole.supplyRadius).
 */
export function isTileInSupplyRadius(tile: TileCoord, pole: PowerPoleEntity): boolean {
  validatePowerPole(pole);
  const dx = Math.abs(tile.x - pole.position.x);
  const dy = Math.abs(tile.y - pole.position.y);
  return Math.max(dx, dy) <= pole.supplyRadius;
}

/**
 * Returns true if any tile of an entity's footprint lies within a power pole's
 * square supply area.
 */
export function isEntityInSupplyRadius(entity: Entity, pole: PowerPoleEntity): boolean {
  validatePowerPole(pole);
  const { width, height } = entity.footprint;
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (
        isTileInSupplyRadius(
          { x: entity.position.x + dx, y: entity.position.y + dy },
          pole
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// Power Grid Construction & Partitioning
// ============================================================================

export function createEmptyPowerGrid(): PowerGridState {
  return {
    networks: {},
    nextNetworkId: 1,
  };
}

/**
 * Rebuilds the power grid graph from a record of entities.
 *
 * - Resets `powerNetworkId` on all entities and `connectedPoleIds` on all poles.
 * - Connects poles within `wireReach` (Euclidean) in deterministic ascending ID order.
 * - Partitions poles into connected components (PowerNetworks) with deterministic IDs
 *   starting at 1, ordered by each component's smallest pole ID.
 * - Assigns producers, consumers, and accumulators within any pole's `supplyRadius`
 *   (Chebyshev square) to the lowest-ID matching network.
 */
export function buildPowerGrid(entities: Record<EntityId, Entity>): PowerGridState {
  const sortedEntities = Object.values(entities).sort((a, b) => a.id - b.id);
  const poles: PowerPoleEntity[] = [];
  const participants: PowerParticipantEntity[] = [];

  for (const entity of sortedEntities) {
    entity.powerNetworkId = null;
    if (isPowerPole(entity)) {
      validatePowerPole(entity);
      entity.connectedPoleIds = [];
      poles.push(entity);
    } else if (isPowerParticipant(entity)) {
      participants.push(entity);
    }
  }

  // 1. Build undirected wire graph between poles within wireReach.
  const poleById = new Map<EntityId, PowerPoleEntity>();
  for (const pole of poles) {
    poleById.set(pole.id, pole);
  }

  for (let i = 0; i < poles.length; i++) {
    const poleA = poles[i]!;
    for (let j = i + 1; j < poles.length; j++) {
      const poleB = poles[j]!;
      if (canPolesConnect(poleA, poleB)) {
        poleA.connectedPoleIds.push(poleB.id);
        poleB.connectedPoleIds.push(poleA.id);
      }
    }
  }

  // 2. Partition poles into connected components via deterministic BFS.
  const networks: Record<PowerNetworkId, PowerNetwork> = {};
  const visited = new Set<EntityId>();
  let nextNetworkId: PowerNetworkId = 1;

  for (const startPole of poles) {
    if (visited.has(startPole.id)) {
      continue;
    }

    const networkId = nextNetworkId;
    nextNetworkId += 1;

    const componentPoleIds: EntityId[] = [];
    const queue: EntityId[] = [startPole.id];
    visited.add(startPole.id);

    let head = 0;
    while (head < queue.length) {
      const currentId = queue[head]!;
      head += 1;
      componentPoleIds.push(currentId);

      const currentPole = poleById.get(currentId);
      if (!currentPole) {
        continue;
      }
      for (const neighborId of currentPole.connectedPoleIds) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    componentPoleIds.sort((a, b) => a - b);

    for (const poleId of componentPoleIds) {
      const pole = poleById.get(poleId);
      if (pole) {
        pole.powerNetworkId = networkId;
      }
    }

    networks[networkId] = {
      id: networkId,
      poleIds: componentPoleIds,
      producerIds: [],
      consumerIds: [],
      accumulatorIds: [],
      totalSupplyKw: 0,
      totalDemandKw: 0,
      satisfaction: 1.0,
    };
  }

  // 3. Assign producers, consumers, and accumulators to covering networks.
  for (const entity of participants) {
    let assignedNetworkId: PowerNetworkId | null = null;

    for (const pole of poles) {
      if (pole.powerNetworkId === null) {
        continue;
      }
      if (isEntityInSupplyRadius(entity, pole)) {
        if (assignedNetworkId === null || pole.powerNetworkId < assignedNetworkId) {
          assignedNetworkId = pole.powerNetworkId;
        }
      }
    }

    if (assignedNetworkId === null) {
      continue;
    }

    const network = networks[assignedNetworkId];
    if (!network) {
      continue;
    }

    entity.powerNetworkId = assignedNetworkId;
    if (isPowerProducer(entity)) {
      network.producerIds.push(entity.id);
    } else if (isPowerConsumer(entity)) {
      network.consumerIds.push(entity.id);
    } else if (isPowerAccumulator(entity)) {
      network.accumulatorIds.push(entity.id);
    }
  }

  return {
    networks,
    nextNetworkId,
  };
}

/**
 * Rebuilds `world.powerGrid` in-place from `world.entities` and returns it.
 */
export function rebuildPowerGrid(world: WorldState): PowerGridState {
  const grid = buildPowerGrid(world.entities);
  world.powerGrid = grid;
  return grid;
}

// ============================================================================
// Query Helpers
// ============================================================================

export function getPowerNetwork(
  grid: PowerGridState,
  networkId: PowerNetworkId
): PowerNetwork | undefined {
  return grid.networks[networkId];
}

export function getEntityPowerNetwork(
  grid: PowerGridState,
  entity: Entity
): PowerNetwork | undefined {
  if (entity.powerNetworkId === null) {
    return undefined;
  }
  return grid.networks[entity.powerNetworkId];
}

/**
 * Returns deduplicated, deterministically sorted wire edges (from < to)
 * across all power poles.
 */
export function getWireConnections(
  entities: Record<EntityId, Entity>
): WireConnection[] {
  const edges: WireConnection[] = [];
  const poles = Object.values(entities)
    .filter(isPowerPole)
    .sort((a, b) => a.id - b.id);

  for (const pole of poles) {
    const sortedNeighbors = [...pole.connectedPoleIds].sort((a, b) => a - b);
    for (const neighborId of sortedNeighbors) {
      if (pole.id < neighborId) {
        edges.push({ from: pole.id, to: neighborId });
      }
    }
  }

  return edges;
}

/**
 * Returns ascending-sorted IDs of all power participants (producers, consumers,
 * accumulators) that are not currently connected to any power network.
 */
export function getUncoveredPowerEntities(
  entities: Record<EntityId, Entity>
): EntityId[] {
  return Object.values(entities)
    .filter((entity) => isPowerParticipant(entity) && entity.powerNetworkId === null)
    .map((entity) => entity.id)
    .sort((a, b) => a - b);
}
