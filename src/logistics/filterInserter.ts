/**
 * Ironworks-16 Filter Inserter (T16)
 *
 * Extends the T15 inserter state machine with a strict whitelist of up to
 * 3 canonical ItemIds. Empty whitelist fails closed (picks nothing).
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  type Direction,
  type EntityId,
  type FilterInserterEntity,
  type ItemId,
  type TileCoord,
  type WorldState,
  SimulationError,
} from '../types/contracts.js';
import { assertValidItemId } from '../core/itemRegistry.js';
import {
  type InserterIO,
  type InserterItemFilter,
  type InserterStepOptions,
  type InserterStepResult,
  computeInserterArmAngle,
  stepInserter,
  tickInserter,
} from './inserter.js';

/** Maximum number of whitelisted ItemIds allowed on a FilterInserterEntity. */
export const MAX_FILTER_SLOTS = 3;

function normalizeFilters(filters: readonly ItemId[]): ItemId[] {
  const unique: ItemId[] = [];
  for (const itemId of filters) {
    assertValidItemId(itemId);
    if (!unique.includes(itemId)) {
      unique.push(itemId);
    }
  }
  if (unique.length > MAX_FILTER_SLOTS) {
    throw new SimulationError(
      'FILTER_LIMIT_EXCEEDED',
      `Filter inserter supports at most ${MAX_FILTER_SLOTS} unique ItemIds, received ${unique.length}.`
    );
  }
  return unique;
}

function assertValidFilterList(filters: readonly ItemId[]): void {
  if (filters.length > MAX_FILTER_SLOTS) {
    throw new SimulationError(
      'FILTER_LIMIT_EXCEEDED',
      `Filter inserter has ${filters.length} filters, exceeding limit of ${MAX_FILTER_SLOTS}.`
    );
  }
  for (const itemId of filters) {
    assertValidItemId(itemId);
  }
}

/**
 * Create a new `FilterInserterEntity` in the `idle` phase with an optional
 * whitelist of up to `MAX_FILTER_SLOTS` (3) canonical `ItemId`s.
 */
export function createFilterInserterEntity(
  id: EntityId,
  position: TileCoord,
  direction: Direction = 'E',
  filters: readonly ItemId[] = []
): FilterInserterEntity {
  const normalized = normalizeFilters(filters);
  return {
    id,
    type: 'filter_inserter',
    position: { x: position.x, y: position.y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    phase: 'idle',
    phaseProgress: 0,
    heldItem: null,
    armAngle: computeInserterArmAngle(direction, 'idle', 0),
    filters: normalized,
  };
}

/**
 * Replace the filter whitelist on `inserter` (deduplicated, max 3 valid `ItemId`s).
 * Throws `UnknownItemError` for invalid IDs or `SimulationError('FILTER_LIMIT_EXCEEDED')`
 * if more than 3 unique items are provided.
 */
export function setFilterInserterFilters(
  inserter: FilterInserterEntity,
  filters: readonly ItemId[]
): void {
  inserter.filters = normalizeFilters(filters);
}

/**
 * Add a single `ItemId` to the filter whitelist.
 * Returns `true` if added, `false` if already present.
 * Throws `UnknownItemError` if invalid, or `SimulationError('FILTER_LIMIT_EXCEEDED')`
 * if adding would exceed `MAX_FILTER_SLOTS`.
 */
export function addFilterInserterFilter(
  inserter: FilterInserterEntity,
  itemId: ItemId
): boolean {
  assertValidItemId(itemId);
  if (inserter.filters.includes(itemId)) {
    return false;
  }
  if (inserter.filters.length >= MAX_FILTER_SLOTS) {
    throw new SimulationError(
      'FILTER_LIMIT_EXCEEDED',
      `Cannot add "${itemId}": filter inserter already has ${MAX_FILTER_SLOTS} filters.`
    );
  }
  inserter.filters.push(itemId);
  return true;
}

/**
 * Remove an `ItemId` from the filter whitelist.
 * Returns `true` if removed, `false` if it was not present.
 */
export function removeFilterInserterFilter(
  inserter: FilterInserterEntity,
  itemId: ItemId
): boolean {
  const idx = inserter.filters.indexOf(itemId);
  if (idx === -1) {
    return false;
  }
  inserter.filters.splice(idx, 1);
  return true;
}

/** Clear all filters from `inserter` (resulting in a fail-closed empty whitelist). */
export function clearFilterInserterFilters(inserter: FilterInserterEntity): void {
  inserter.filters = [];
}

/**
 * Return `true` iff `itemId` is in `inserter.filters`.
 * An empty whitelist fails closed and returns `false` for all items.
 */
export function isItemAllowedByFilter(
  inserter: FilterInserterEntity,
  itemId: ItemId
): boolean {
  if (inserter.filters.length === 0) {
    return false;
  }
  return inserter.filters.includes(itemId);
}

/** Build an `InserterItemFilter` predicate enforcing `inserter.filters`. */
export function createFilterPredicate(
  inserter: FilterInserterEntity
): InserterItemFilter {
  assertValidFilterList(inserter.filters);
  const allowed = inserter.filters;
  return (itemId: ItemId): boolean => allowed.includes(itemId);
}

function buildEffectiveFilter(
  inserter: FilterInserterEntity,
  extraFilter?: InserterItemFilter
): InserterItemFilter {
  const whitelist = createFilterPredicate(inserter);
  if (!extraFilter) {
    return whitelist;
  }
  return (itemId: ItemId): boolean => whitelist(itemId) && extraFilter(itemId);
}

/**
 * Advance a filter inserter's state machine by one tick using `io`,
 * enforcing its whitelist of up to 3 `ItemId`s.
 */
export function stepFilterInserter(
  inserter: FilterInserterEntity,
  io: InserterIO,
  options: InserterStepOptions = {}
): InserterStepResult {
  const effectiveFilter = buildEffectiveFilter(inserter, options.filter);
  return stepInserter(inserter, io, {
    ...options,
    filter: effectiveFilter,
  });
}

/**
 * Advance a single filter inserter in `world` by one tick, resolving source
 * and target entities from `world` and enforcing its whitelist.
 */
export function tickFilterInserter(
  world: WorldState,
  inserter: FilterInserterEntity,
  options: InserterStepOptions = {}
): InserterStepResult {
  const effectiveFilter = buildEffectiveFilter(inserter, options.filter);
  return tickInserter(world, inserter, {
    ...options,
    filter: effectiveFilter,
  });
}

/**
 * Deterministically tick all `'filter_inserter'` entities in `world`
 * in ascending `EntityId` order.
 */
export function tickAllFilterInserters(
  world: WorldState,
  options: InserterStepOptions = {}
): void {
  const ids = Object.keys(world.entities)
    .map(Number)
    .sort((a, b) => a - b);

  for (const id of ids) {
    const entity = world.entities[id];
    if (entity && entity.type === 'filter_inserter') {
      tickFilterInserter(world, entity, options);
    }
  }
}
