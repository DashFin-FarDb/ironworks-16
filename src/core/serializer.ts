/**
 * Ironworks-16 WorldState Serializer (T10)
 *
 * Deterministic canonical JSON serialization and fail-closed deserialization
 * of WorldState. Strictly headless and deterministic.
 */

import {
  DAY_CYCLE_TICKS,
  DIRECTIONS,
  DeserializationError,
  SimulationError,
  type Direction,
  type Entity,
  type EntityId,
  type EntityType,
  type ItemId,
  type PowerGridState,
  type PowerNetwork,
  type ProductionStats,
  type ResearchState,
  type ResourceType,
  type TechId,
  type TerrainType,
  type Tile,
  type WorldState,
} from '../types/contracts';

const VALID_DIRECTIONS = new Set<string>(DIRECTIONS);

const VALID_TERRAINS = new Set<TerrainType>([
  'grass',
  'dirt',
  'sand',
  'water',
  'stone_ground',
]);

const VALID_RESOURCES = new Set<ResourceType>([
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
]);

const VALID_ITEMS = new Set<ItemId>([
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
  'iron_plate',
  'copper_plate',
  'stone_brick',
  'steel_plate',
  'iron_gear',
  'copper_cable',
  'electronic_circuit',
  'transport_belt',
  'underground_belt',
  'splitter',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'red_science',
  'green_science',
]);

const VALID_TECHS = new Set<TechId>([
  'automation',
  'logistics',
  'steel_processing',
  'solar_energy',
]);

const VALID_ENTITY_TYPES = new Set<EntityType>([
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
// Canonical JSON Serialization
// ============================================================================

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Deterministically serializes a JSON-compatible value with lexicographically
 * sorted object keys, normalized `-0` -> `0`, and fail-closed rejection of
 * non-finite numbers (`NaN`, `Infinity`, `-Infinity`).
 */
export function canonicalStringify(value: unknown, path = '$'): string {
  if (value === null) {
    return 'null';
  }

  const type = typeof value;

  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (type === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) {
      throw new SimulationError(
        'SERIALIZATION_ERROR',
        `Non-finite number at ${path}: ${String(num)}`
      );
    }
    const normalized = Object.is(num, -0) ? 0 : num;
    return JSON.stringify(normalized);
  }

  if (type === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const elem = value[i];
      if (elem === undefined) {
        throw new SimulationError(
          'SERIALIZATION_ERROR',
          `Undefined array element at ${path}[${i}]`
        );
      }
      parts.push(canonicalStringify(elem, `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }

  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareStrings);
    const parts: string[] = [];
    for (const key of keys) {
      const propVal = record[key];
      if (propVal === undefined) {
        continue;
      }
      parts.push(
        `${JSON.stringify(key)}:${canonicalStringify(propVal, `${path}.${key}`)}`
      );
    }
    return `{${parts.join(',')}}`;
  }

  throw new SimulationError(
    'SERIALIZATION_ERROR',
    `Unsupported value type "${type}" at ${path}`
  );
}

/**
 * Serializes a WorldState into a deterministic canonical JSON string.
 */
export function serializeWorldState(state: WorldState): string {
  return canonicalStringify(state, 'WorldState');
}

/**
 * Computes a deterministic 32-bit FNV-1a hex hash of the canonical serialized
 * WorldState for fast equality/determinism verification.
 */
export function hashWorldState(state: WorldState): string {
  const canonical = serializeWorldState(state);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ============================================================================
// Fail-Closed Validation & Deserialization
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new DeserializationError(`Expected object at ${path}.`);
  }
  return value;
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeserializationError(`Expected finite number at ${path}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function assertInteger(value: unknown, path: string): number {
  const num = assertFiniteNumber(value, path);
  if (!Number.isInteger(num)) {
    throw new DeserializationError(`Expected integer at ${path}, got ${num}.`);
  }
  return num;
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  const num = assertInteger(value, path);
  if (num < 0) {
    throw new DeserializationError(
      `Expected non-negative integer at ${path}, got ${num}.`
    );
  }
  return num;
}

function assertPositiveInteger(value: unknown, path: string): number {
  const num = assertInteger(value, path);
  if (num < 1) {
    throw new DeserializationError(
      `Expected positive integer at ${path}, got ${num}.`
    );
  }
  return num;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new DeserializationError(`Expected boolean at ${path}.`);
  }
  return value;
}

function assertIntegerArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    throw new DeserializationError(`Expected array at ${path}.`);
  }
  return value.map((v, i) => assertInteger(v, `${path}[${i}]`));
}

function validateTile(
  raw: unknown,
  expectedX: number,
  expectedY: number,
  index: number
): Tile {
  const path = `tiles[${index}]`;
  const obj = assertPlainObject(raw, path);

  const x = assertInteger(obj.x, `${path}.x`);
  const y = assertInteger(obj.y, `${path}.y`);
  if (x !== expectedX || y !== expectedY) {
    throw new DeserializationError(
      `Tile coordinate mismatch at ${path}: expected (${expectedX}, ${expectedY}), got (${x}, ${y}).`
    );
  }

  if (typeof obj.terrain !== 'string' || !VALID_TERRAINS.has(obj.terrain as TerrainType)) {
    throw new DeserializationError(
      `Invalid terrain "${String(obj.terrain)}" at ${path}.terrain.`
    );
  }

  let resource: Tile['resource'] = null;
  if (obj.resource !== null) {
    const resObj = assertPlainObject(obj.resource, `${path}.resource`);
    if (
      typeof resObj.type !== 'string' ||
      !VALID_RESOURCES.has(resObj.type as ResourceType)
    ) {
      throw new DeserializationError(
        `Invalid resource type "${String(resObj.type)}" at ${path}.resource.type.`
      );
    }
    const amount = assertFiniteNumber(resObj.amount, `${path}.resource.amount`);
    const initialAmount = assertFiniteNumber(
      resObj.initialAmount,
      `${path}.resource.initialAmount`
    );
    if (amount < 0 || initialAmount < 0) {
      throw new DeserializationError(
        `Negative resource amount at ${path}.resource.`
      );
    }
    resource = {
      type: resObj.type as ResourceType,
      amount,
      initialAmount,
    };
  }

  let entityId: EntityId | null = null;
  if (obj.entityId !== null) {
    entityId = assertInteger(obj.entityId, `${path}.entityId`);
  }

  return {
    x,
    y,
    terrain: obj.terrain as TerrainType,
    resource,
    entityId,
  };
}

function assertAllNestedNumbersFinite(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DeserializationError(`Non-finite number at ${path}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertAllNestedNumbersFinite(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertAllNestedNumbersFinite(value[key], `${path}.${key}`);
    }
  }
}

function validateEntity(raw: unknown, expectedKey: string): Entity {
  const path = `entities["${expectedKey}"]`;
  const obj = assertPlainObject(raw, path);

  const id = assertInteger(obj.id, `${path}.id`);
  if (String(id) !== expectedKey) {
    throw new DeserializationError(
      `Entity key "${expectedKey}" does not match entity.id (${id}).`
    );
  }

  if (
    typeof obj.type !== 'string' ||
    !VALID_ENTITY_TYPES.has(obj.type as EntityType)
  ) {
    throw new DeserializationError(
      `Invalid entity type "${String(obj.type)}" at ${path}.type.`
    );
  }

  const pos = assertPlainObject(obj.position, `${path}.position`);
  assertInteger(pos.x, `${path}.position.x`);
  assertInteger(pos.y, `${path}.position.y`);

  if (
    typeof obj.direction !== 'string' ||
    !VALID_DIRECTIONS.has(obj.direction as Direction)
  ) {
    throw new DeserializationError(
      `Invalid direction "${String(obj.direction)}" at ${path}.direction.`
    );
  }

  const footprint = assertPlainObject(obj.footprint, `${path}.footprint`);
  assertPositiveInteger(footprint.width, `${path}.footprint.width`);
  assertPositiveInteger(footprint.height, `${path}.footprint.height`);

  if (obj.powerNetworkId !== null) {
    assertInteger(obj.powerNetworkId, `${path}.powerNetworkId`);
  }

  assertBoolean(obj.active, `${path}.active`);
  assertAllNestedNumbersFinite(obj, path);

  return obj as unknown as Entity;
}

function validatePowerGrid(raw: unknown): PowerGridState {
  const obj = assertPlainObject(raw, 'powerGrid');
  const nextNetworkId = assertNonNegativeInteger(
    obj.nextNetworkId,
    'powerGrid.nextNetworkId'
  );
  const rawNetworks = assertPlainObject(obj.networks, 'powerGrid.networks');
  const networks: Record<number, PowerNetwork> = {};

  for (const key of Object.keys(rawNetworks)) {
    const netPath = `powerGrid.networks["${key}"]`;
    const net = assertPlainObject(rawNetworks[key], netPath);
    const id = assertInteger(net.id, `${netPath}.id`);
    if (String(id) !== key) {
      throw new DeserializationError(
        `PowerNetwork key "${key}" does not match network.id (${id}).`
      );
    }
    networks[id] = {
      id,
      poleIds: assertIntegerArray(net.poleIds, `${netPath}.poleIds`),
      producerIds: assertIntegerArray(net.producerIds, `${netPath}.producerIds`),
      consumerIds: assertIntegerArray(net.consumerIds, `${netPath}.consumerIds`),
      accumulatorIds: assertIntegerArray(
        net.accumulatorIds,
        `${netPath}.accumulatorIds`
      ),
      totalSupplyKw: assertFiniteNumber(
        net.totalSupplyKw,
        `${netPath}.totalSupplyKw`
      ),
      totalDemandKw: assertFiniteNumber(
        net.totalDemandKw,
        `${netPath}.totalDemandKw`
      ),
      satisfaction: assertFiniteNumber(
        net.satisfaction,
        `${netPath}.satisfaction`
      ),
    };
  }

  return { networks, nextNetworkId };
}

function validateResearch(raw: unknown): ResearchState {
  const obj = assertPlainObject(raw, 'research');

  let activeTech: TechId | null = null;
  if (obj.activeTech !== null) {
    if (
      typeof obj.activeTech !== 'string' ||
      !VALID_TECHS.has(obj.activeTech as TechId)
    ) {
      throw new DeserializationError(
        `Invalid activeTech "${String(obj.activeTech)}" at research.activeTech.`
      );
    }
    activeTech = obj.activeTech as TechId;
  }

  if (!Array.isArray(obj.completedTechs)) {
    throw new DeserializationError(
      'Expected array at research.completedTechs.'
    );
  }
  const completedTechs: TechId[] = obj.completedTechs.map((t, i) => {
    if (typeof t !== 'string' || !VALID_TECHS.has(t as TechId)) {
      throw new DeserializationError(
        `Invalid tech "${String(t)}" at research.completedTechs[${i}].`
      );
    }
    return t as TechId;
  });

  const rawProgress = assertPlainObject(obj.progress, 'research.progress');
  const progress: Partial<Record<ItemId, number>> = {};
  for (const key of Object.keys(rawProgress)) {
    if (!VALID_ITEMS.has(key as ItemId)) {
      throw new DeserializationError(
        `Invalid item ID "${key}" at research.progress.`
      );
    }
    const val = assertFiniteNumber(
      rawProgress[key],
      `research.progress["${key}"]`
    );
    if (val < 0) {
      throw new DeserializationError(
        `Negative research progress at research.progress["${key}"].`
      );
    }
    progress[key as ItemId] = val;
  }

  return { activeTech, completedTechs, progress };
}

function validateStats(raw: unknown): ProductionStats {
  const obj = assertPlainObject(raw, 'stats');
  const rawByItem = assertPlainObject(obj.byItem, 'stats.byItem');
  const byItem: ProductionStats['byItem'] = {};

  for (const key of Object.keys(rawByItem)) {
    if (!VALID_ITEMS.has(key as ItemId)) {
      throw new DeserializationError(
        `Invalid item ID "${key}" at stats.byItem.`
      );
    }
    const recPath = `stats.byItem["${key}"]`;
    const rec = assertPlainObject(rawByItem[key], recPath);
    const producedTotal = assertFiniteNumber(
      rec.producedTotal,
      `${recPath}.producedTotal`
    );
    const consumedTotal = assertFiniteNumber(
      rec.consumedTotal,
      `${recPath}.consumedTotal`
    );
    const producedPerMinute = assertFiniteNumber(
      rec.producedPerMinute,
      `${recPath}.producedPerMinute`
    );
    const consumedPerMinute = assertFiniteNumber(
      rec.consumedPerMinute,
      `${recPath}.consumedPerMinute`
    );
    if (
      producedTotal < 0 ||
      consumedTotal < 0 ||
      producedPerMinute < 0 ||
      consumedPerMinute < 0
    ) {
      throw new DeserializationError(`Negative stats value at ${recPath}.`);
    }
    byItem[key as ItemId] = {
      producedTotal,
      consumedTotal,
      producedPerMinute,
      consumedPerMinute,
    };
  }

  return { byItem };
}

/**
 * Deserializes a JSON string into a validated WorldState.
 * Fails closed by throwing a typed DeserializationError on any malformed JSON,
 * unsupported schemaVersion, or structural/invariant violation.
 */
export function deserializeWorldState(json: string): WorldState {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new DeserializationError('Input must be a non-empty JSON string.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DeserializationError(`Malformed JSON: ${message}`);
  }

  const root = assertPlainObject(parsed, 'WorldState');

  if (root.schemaVersion !== 1) {
    throw new DeserializationError(
      `Unsupported schemaVersion: ${String(root.schemaVersion)}. Expected 1.`
    );
  }

  const seed = assertInteger(root.seed, 'seed');
  const tick = assertNonNegativeInteger(root.tick, 'tick');
  const width = assertPositiveInteger(root.width, 'width');
  const height = assertPositiveInteger(root.height, 'height');

  if (!Array.isArray(root.tiles)) {
    throw new DeserializationError('Expected array at tiles.');
  }
  const expectedTileCount = width * height;
  if (root.tiles.length !== expectedTileCount) {
    throw new DeserializationError(
      `Expected ${expectedTileCount} tiles for ${width}x${height} grid, got ${root.tiles.length}.`
    );
  }

  const tiles: Tile[] = new Array<Tile>(expectedTileCount);
  for (let i = 0; i < expectedTileCount; i++) {
    const expectedX = i % width;
    const expectedY = Math.floor(i / width);
    tiles[i] = validateTile(root.tiles[i], expectedX, expectedY, i);
  }

  const rawEntities = assertPlainObject(root.entities, 'entities');
  const entities: Record<EntityId, Entity> = {};
  for (const key of Object.keys(rawEntities)) {
    const entity = validateEntity(rawEntities[key], key);
    entities[entity.id] = entity;
  }

  const nextEntityId = assertNonNegativeInteger(
    root.nextEntityId,
    'nextEntityId'
  );
  const powerGrid = validatePowerGrid(root.powerGrid);
  const research = validateResearch(root.research);

  const rawDayNight = assertPlainObject(root.dayNight, 'dayNight');
  const cycleTick = assertFiniteNumber(
    rawDayNight.cycleTick,
    'dayNight.cycleTick'
  );
  if (cycleTick < 0 || cycleTick >= DAY_CYCLE_TICKS) {
    throw new DeserializationError(
      `dayNight.cycleTick (${cycleTick}) must be in [0, ${DAY_CYCLE_TICKS}).`
    );
  }
  const solarFactor = assertFiniteNumber(
    rawDayNight.solarFactor,
    'dayNight.solarFactor'
  );
  if (solarFactor < 0 || solarFactor > 1) {
    throw new DeserializationError(
      `dayNight.solarFactor (${solarFactor}) must be in [0, 1].`
    );
  }

  const stats = validateStats(root.stats);

  return {
    schemaVersion: 1,
    seed,
    tick,
    width,
    height,
    tiles,
    entities,
    nextEntityId,
    powerGrid,
    research,
    dayNight: { cycleTick, solarFactor },
    stats,
  };
}
