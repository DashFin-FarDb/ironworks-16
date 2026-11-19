/**
 * Ironworks-16 Entity Manager (T04)
 *
 * Manages entity lifecycle (spawn, rotate, destroy, query by type/ID/position)
 * with strictly deterministic monotonic IDs and fail-closed validation.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  DIRECTIONS,
  InvalidPlacementError,
  OutOfBoundsError,
  SimulationError,
  coordKey,
  isWithinBounds,
  rotateDirection,
  type AccumulatorEntity,
  type AssemblerEntity,
  type BeltEntity,
  type BoilerEntity,
  type BurnerDrillEntity,
  type ChestEntity,
  type Direction,
  type ElectricDrillEntity,
  type ElectricFurnaceEntity,
  type Entity,
  type EntityFootprint,
  type EntityId,
  type EntityType,
  type FilterInserterEntity,
  type GridBounds,
  type InserterEntity,
  type InventoryState,
  type ItemId,
  type PowerPoleEntity,
  type RecipeId,
  type ResearchLabEntity,
  type SolarPanelEntity,
  type SplitterEntity,
  type SteamEngineEntity,
  type StoneFurnaceEntity,
  type TileCoord,
  type UndergroundBeltEntity,
  type UndergroundBeltMode,
  type WorldState,
} from '../types/contracts';

// ============================================================================
// Errors
// ============================================================================

export class EntityNotFoundError extends SimulationError {
  readonly entityId: EntityId;

  constructor(entityId: EntityId) {
    super('ENTITY_NOT_FOUND', `Entity with ID ${entityId} does not exist.`);
    this.name = 'EntityNotFoundError';
    this.entityId = entityId;
  }
}

// ============================================================================
// Types & Constants
// ============================================================================

export type EntityOfType<T extends EntityType> = Entity extends infer E
  ? E extends { type: infer U }
    ? T extends U
      ? E
      : never
    : never
  : never;

export interface SpawnEntityOptions {
  direction?: Direction;
  /** Underground belt mode ('input' | 'output'). Defaults to 'input'. */
  undergroundMode?: UndergroundBeltMode;
  /** Initial whitelist for filter_inserter (max 3 items). */
  filters?: readonly ItemId[];
  /** Initial recipe for assembler_mk1 / assembler_mk2. */
  recipeId?: RecipeId | null;
}

export interface EntityManagerOptions {
  /** Optional grid bounds for fail-closed placement checks. */
  bounds?: GridBounds;
  /** Starting ID for monotonic allocation (must be positive integer >= 1). */
  initialNextId?: EntityId;
}

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'transport_belt',
  'splitter',
  'underground_belt',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'burner_drill',
  'electric_drill',
  'stone_furnace',
  'electric_furnace',
  'assembler_mk1',
  'assembler_mk2',
  'boiler',
  'steam_engine',
  'solar_panel',
  'accumulator',
  'research_lab',
]);

// ============================================================================
// Helpers
// ============================================================================

function createEmptyInventory(capacity: number): InventoryState {
  return {
    capacity,
    slots: Array.from({ length: capacity }, () => ({ item: null, filter: null })),
  };
}

export function isValidEntityType(value: string): value is EntityType {
  return VALID_ENTITY_TYPES.has(value as EntityType);
}

export function getEntityFootprint(type: EntityType): EntityFootprint {
  if (type === 'splitter') {
    return { width: 2, height: 1 };
  }
  return { width: 1, height: 1 };
}

export function getFootprintTiles(
  origin: TileCoord,
  footprint: EntityFootprint
): TileCoord[] {
  const tiles: TileCoord[] = [];
  for (let dy = 0; dy < footprint.height; dy++) {
    for (let dx = 0; dx < footprint.width; dx++) {
      tiles.push({ x: origin.x + dx, y: origin.y + dy });
    }
  }
  return tiles;
}

export function createEntityInstance(
  id: EntityId,
  type: EntityType,
  position: TileCoord,
  options: SpawnEntityOptions = {}
): Entity {
  const direction: Direction = options.direction ?? 'N';
  if (!DIRECTIONS.includes(direction)) {
    throw new InvalidPlacementError(
      type,
      position,
      `Invalid direction "${String(direction)}".`
    );
  }

  const footprint = getEntityFootprint(type);
  const base = {
    id,
    position: { x: position.x, y: position.y },
    direction,
    footprint,
    powerNetworkId: null,
    active: false,
  };

  switch (type) {
    case 'transport_belt': {
      const entity: BeltEntity = {
        ...base,
        type: 'transport_belt',
        shape: 'straight',
        leftLane: { items: [] },
        rightLane: { items: [] },
      };
      return entity;
    }

    case 'splitter': {
      const entity: SplitterEntity = {
        ...base,
        type: 'splitter',
        nextOutputIndex: 0,
        leftLane: { items: [] },
        rightLane: { items: [] },
      };
      return entity;
    }

    case 'underground_belt': {
      const mode: UndergroundBeltMode = options.undergroundMode ?? 'input';
      if (mode !== 'input' && mode !== 'output') {
        throw new InvalidPlacementError(
          type,
          position,
          `Invalid underground belt mode "${String(mode)}".`
        );
      }
      const entity: UndergroundBeltEntity = {
        ...base,
        type: 'underground_belt',
        mode,
        pairedEntityId: null,
        transitQueue: [],
      };
      return entity;
    }

    case 'inserter': {
      const entity: InserterEntity = {
        ...base,
        type: 'inserter',
        phase: 'idle',
        phaseProgress: 0,
        heldItem: null,
        armAngle: 0,
      };
      return entity;
    }

    case 'filter_inserter': {
      const filters = options.filters ? [...options.filters] : [];
      if (filters.length > 3) {
        throw new InvalidPlacementError(
          type,
          position,
          `Filter inserter supports at most 3 filters, received ${filters.length}.`
        );
      }
      const entity: FilterInserterEntity = {
        ...base,
        type: 'filter_inserter',
        phase: 'idle',
        phaseProgress: 0,
        heldItem: null,
        armAngle: 0,
        filters,
      };
      return entity;
    }

    case 'power_pole': {
      const entity: PowerPoleEntity = {
        ...base,
        type: 'power_pole',
        supplyRadius: 5,
        wireReach: 7,
        connectedPoleIds: [],
      };
      return entity;
    }

    case 'wooden_chest': {
      const entity: ChestEntity = {
        ...base,
        type: 'wooden_chest',
        inventory: createEmptyInventory(16),
      };
      return entity;
    }

    case 'iron_chest': {
      const entity: ChestEntity = {
        ...base,
        type: 'iron_chest',
        inventory: createEmptyInventory(32),
      };
      return entity;
    }

    case 'burner_drill': {
      const entity: BurnerDrillEntity = {
        ...base,
        type: 'burner_drill',
        fuelInventory: createEmptyInventory(1),
        fuelEnergyKj: 0,
        miningProgress: 0,
      };
      return entity;
    }

    case 'electric_drill': {
      const entity: ElectricDrillEntity = {
        ...base,
        type: 'electric_drill',
        powerDemandKw: 90,
        miningProgress: 0,
      };
      return entity;
    }

    case 'stone_furnace': {
      const entity: StoneFurnaceEntity = {
        ...base,
        type: 'stone_furnace',
        inputInventory: createEmptyInventory(1),
        outputInventory: createEmptyInventory(1),
        fuelInventory: createEmptyInventory(1),
        fuelEnergyKj: 0,
        activeRecipe: null,
        craftingProgress: 0,
      };
      return entity;
    }

    case 'electric_furnace': {
      const entity: ElectricFurnaceEntity = {
        ...base,
        type: 'electric_furnace',
        powerDemandKw: 180,
        inputInventory: createEmptyInventory(1),
        outputInventory: createEmptyInventory(1),
        activeRecipe: null,
        craftingProgress: 0,
      };
      return entity;
    }

    case 'assembler_mk1': {
      const entity: AssemblerEntity = {
        ...base,
        type: 'assembler_mk1',
        powerDemandKw: 75,
        craftingSpeed: 0.5,
        maxIngredients: 2,
        recipeId: options.recipeId ?? null,
        inputInventory: createEmptyInventory(2),
        outputInventory: createEmptyInventory(1),
        craftingProgress: 0,
      };
      return entity;
    }

    case 'assembler_mk2': {
      const entity: AssemblerEntity = {
        ...base,
        type: 'assembler_mk2',
        powerDemandKw: 150,
        craftingSpeed: 0.75,
        maxIngredients: 4,
        recipeId: options.recipeId ?? null,
        inputInventory: createEmptyInventory(4),
        outputInventory: createEmptyInventory(1),
        craftingProgress: 0,
      };
      return entity;
    }

    case 'boiler': {
      const entity: BoilerEntity = {
        ...base,
        type: 'boiler',
        fuelInventory: createEmptyInventory(1),
        fuelEnergyKj: 0,
        steamBuffer: 0,
      };
      return entity;
    }

    case 'steam_engine': {
      const entity: SteamEngineEntity = {
        ...base,
        type: 'steam_engine',
        maxPowerOutputKw: 900,
        currentOutputKw: 0,
      };
      return entity;
    }

    case 'solar_panel': {
      const entity: SolarPanelEntity = {
        ...base,
        type: 'solar_panel',
        peakOutputKw: 60,
        currentOutputKw: 0,
      };
      return entity;
    }

    case 'accumulator': {
      const entity: AccumulatorEntity = {
        ...base,
        type: 'accumulator',
        storedEnergyKj: 0,
        capacityKj: 5000,
        maxChargeRateKw: 300,
        maxDischargeRateKw: 300,
      };
      return entity;
    }

    case 'research_lab': {
      const entity: ResearchLabEntity = {
        ...base,
        type: 'research_lab',
        powerDemandKw: 60,
        inputInventory: createEmptyInventory(2),
        researchProgress: 0,
      };
      return entity;
    }

    default: {
      const exhaustive: never = type;
      throw new SimulationError(
        'UNKNOWN_ENTITY_TYPE',
        `Unknown entity type: "${String(exhaustive)}".`
      );
    }
  }
}

// ============================================================================
// EntityManager
// ============================================================================

export class EntityManager {
  private readonly entities = new Map<EntityId, Entity>();
  private readonly byType = new Map<EntityType, Set<EntityId>>();
  private readonly occupiedTiles = new Map<string, EntityId>();
  private readonly bounds: GridBounds | null;
  private nextEntityId: EntityId;

  constructor(options: EntityManagerOptions = {}) {
    const initialNextId = options.initialNextId ?? 1;
    if (!Number.isInteger(initialNextId) || initialNextId < 1) {
      throw new SimulationError(
        'INVALID_INITIAL_ID',
        `initialNextId must be a positive integer, received ${String(initialNextId)}.`
      );
    }
    this.nextEntityId = initialNextId;
    this.bounds = options.bounds ?? null;
  }

  /**
   * Reconstruct an EntityManager from a serialized or live WorldState.
   * Preserves deterministic nextEntityId and occupancy indices.
   */
  static fromWorldState(world: WorldState): EntityManager {
    const manager = new EntityManager({
      bounds: { width: world.width, height: world.height },
      initialNextId: Math.max(1, world.nextEntityId),
    });

    const sortedIds = Object.keys(world.entities)
      .map((k) => Number(k))
      .sort((a, b) => a - b);

    let maxId = 0;
    for (const id of sortedIds) {
      const entity = world.entities[id];
      if (!entity) continue;
      manager.registerExisting(entity);
      if (entity.id > maxId) {
        maxId = entity.id;
      }
    }

    if (manager.nextEntityId <= maxId) {
      manager.nextEntityId = maxId + 1;
    }

    return manager;
  }

  /**
   * Returns the next deterministic monotonic ID that will be assigned.
   */
  getNextEntityId(): EntityId {
    return this.nextEntityId;
  }

  /**
   * Spawns a new entity with a deterministic monotonic ID.
   * Fails closed on invalid type, non-integer coordinates, out-of-bounds, or tile collision.
   */
  spawn<T extends EntityType>(
    type: T,
    position: TileCoord,
    options: SpawnEntityOptions = {}
  ): EntityOfType<T> {
    if (!isValidEntityType(type)) {
      throw new SimulationError(
        'UNKNOWN_ENTITY_TYPE',
        `Unknown entity type: "${String(type)}".`
      );
    }

    if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
      throw new InvalidPlacementError(
        type,
        position,
        'Coordinates must be integers.'
      );
    }

    const footprint = getEntityFootprint(type);
    const tiles = getFootprintTiles(position, footprint);

    if (this.bounds !== null) {
      for (const tile of tiles) {
        if (!isWithinBounds(tile, this.bounds)) {
          throw new OutOfBoundsError(tile, this.bounds);
        }
      }
    }

    for (const tile of tiles) {
      const key = coordKey(tile);
      const existingId = this.occupiedTiles.get(key);
      if (existingId !== undefined) {
        throw new InvalidPlacementError(
          type,
          tile,
          `Tile (${tile.x}, ${tile.y}) is already occupied by entity ${existingId}.`
        );
      }
    }

    // Validate & construct before mutating nextEntityId or indices (atomic fail-closed).
    const id = this.nextEntityId;
    const entity = createEntityInstance(id, type, position, options);

    this.nextEntityId += 1;
    this.indexEntity(entity, tiles);

    return entity as EntityOfType<T>;
  }

  /**
   * Rotates an existing entity clockwise by `stepsClockwise` 90-degree steps (default 1).
   * Fails closed if entity does not exist or stepsClockwise is not an integer.
   */
  rotate(id: EntityId, stepsClockwise = 1): Entity {
    const entity = this.entities.get(id);
    if (!entity) {
      throw new EntityNotFoundError(id);
    }
    if (!Number.isInteger(stepsClockwise)) {
      throw new SimulationError(
        'INVALID_ROTATION',
        `Rotation steps must be an integer, received ${String(stepsClockwise)}.`
      );
    }

    entity.direction = rotateDirection(entity.direction, stepsClockwise);
    return entity;
  }

  /**
   * Destroys an entity by ID and releases its occupied tiles.
   * Monotonic IDs are never reused. Fails closed if entity does not exist.
   */
  destroy(id: EntityId): Entity {
    const entity = this.entities.get(id);
    if (!entity) {
      throw new EntityNotFoundError(id);
    }

    this.entities.delete(id);

    const typeSet = this.byType.get(entity.type);
    if (typeSet) {
      typeSet.delete(id);
      if (typeSet.size === 0) {
        this.byType.delete(entity.type);
      }
    }

    const tiles = getFootprintTiles(entity.position, entity.footprint);
    for (const tile of tiles) {
      const key = coordKey(tile);
      if (this.occupiedTiles.get(key) === id) {
        this.occupiedTiles.delete(key);
      }
    }

    return entity;
  }

  /**
   * Returns true if an entity with the given ID currently exists.
   */
  has(id: EntityId): boolean {
    return this.entities.has(id);
  }

  /**
   * Queries an entity by ID, or returns undefined if not found.
   */
  getById(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  /**
   * Queries an entity by ID, throwing EntityNotFoundError if not found.
   */
  getByIdOrThrow(id: EntityId): Entity {
    const entity = this.entities.get(id);
    if (!entity) {
      throw new EntityNotFoundError(id);
    }
    return entity;
  }

  /**
   * Queries the entity occupying a given tile coordinate, or undefined if empty.
   */
  getAt(coord: TileCoord): Entity | undefined {
    const id = this.occupiedTiles.get(coordKey(coord));
    if (id === undefined) {
      return undefined;
    }
    return this.entities.get(id);
  }

  /**
   * Queries all entities of a specific EntityType in deterministic ascending ID order.
   */
  getByType<T extends EntityType>(type: T): EntityOfType<T>[] {
    const idSet = this.byType.get(type);
    if (!idSet || idSet.size === 0) {
      return [];
    }

    const result: EntityOfType<T>[] = [];
    const sortedIds = Array.from(idSet).sort((a, b) => a - b);
    for (const id of sortedIds) {
      const entity = this.entities.get(id);
      if (entity && entity.type === type) {
        result.push(entity as EntityOfType<T>);
      }
    }
    return result;
  }

  /**
   * Returns all entities in deterministic ascending ID order.
   */
  getAll(): Entity[] {
    return Array.from(this.entities.values()).sort((a, b) => a.id - b.id);
  }

  /**
   * Returns total number of live entities.
   */
  count(): number {
    return this.entities.size;
  }

  /**
   * Returns number of live entities of the given type.
   */
  countByType(type: EntityType): number {
    return this.byType.get(type)?.size ?? 0;
  }

  /**
   * Exports entities as a plain Record<EntityId, Entity> compatible with WorldState.
   */
  toRecord(): Record<EntityId, Entity> {
    const record: Record<EntityId, Entity> = {};
    for (const entity of this.getAll()) {
      record[entity.id] = entity;
    }
    return record;
  }

  private registerExisting(entity: Entity): void {
    const tiles = getFootprintTiles(entity.position, entity.footprint);
    if (this.bounds !== null) {
      for (const tile of tiles) {
        if (!isWithinBounds(tile, this.bounds)) {
          throw new OutOfBoundsError(tile, this.bounds);
        }
      }
    }
    for (const tile of tiles) {
      const key = coordKey(tile);
      const existingId = this.occupiedTiles.get(key);
      if (existingId !== undefined) {
        throw new InvalidPlacementError(
          entity.type,
          tile,
          `Tile (${tile.x}, ${tile.y}) is already occupied by entity ${existingId}.`
        );
      }
    }
    this.indexEntity(entity, tiles);
  }

  private indexEntity(entity: Entity, tiles: TileCoord[]): void {
    this.entities.set(entity.id, entity);

    let typeSet = this.byType.get(entity.type);
    if (!typeSet) {
      typeSet = new Set<EntityId>();
      this.byType.set(entity.type, typeSet);
    }
    typeSet.add(entity.id);

    for (const tile of tiles) {
      this.occupiedTiles.set(coordKey(tile), entity.id);
    }
  }
}
