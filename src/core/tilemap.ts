/**
 * Ironworks-16 TileMap (T02)
 *
 * Bounded 2D tile grid (64x64 default) with terrain, ore deposits,
 * and O(1) entity occupancy lookup. All out-of-bounds queries fail closed
 * by throwing OutOfBoundsError.
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  DIRECTION_VECTORS,
  DIRECTIONS,
  EntityFootprint,
  EntityId,
  GridBounds,
  OutOfBoundsError,
  ResourceNode,
  ResourceType,
  SimulationError,
  TerrainType,
  Tile,
  TileCoord,
  isWithinBounds,
} from '../types/contracts';

export const DEFAULT_MAP_WIDTH = 64;
export const DEFAULT_MAP_HEIGHT = 64;

const DEFAULT_FOOTPRINT: EntityFootprint = { width: 1, height: 1 };

function assertValidDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new SimulationError(
      'INVALID_BOUNDS',
      `TileMap dimensions must be positive integers; received (${width}x${height}).`
    );
  }
}

function assertValidFootprint(footprint: EntityFootprint): void {
  if (
    !Number.isInteger(footprint.width) ||
    footprint.width <= 0 ||
    !Number.isInteger(footprint.height) ||
    footprint.height <= 0
  ) {
    throw new SimulationError(
      'INVALID_FOOTPRINT',
      `Entity footprint must have positive integer dimensions; received (${footprint.width}x${footprint.height}).`
    );
  }
}

function assertValidResource(resource: ResourceNode): void {
  if (
    !Number.isFinite(resource.amount) ||
    resource.amount < 0 ||
    !Number.isFinite(resource.initialAmount) ||
    resource.initialAmount < 0
  ) {
    throw new SimulationError(
      'INVALID_RESOURCE',
      `Resource node amounts must be finite non-negative numbers; received amount=${resource.amount}, initialAmount=${resource.initialAmount}.`
    );
  }
}

export class TileMap {
  readonly width: number;
  readonly height: number;
  private readonly tiles: Tile[];
  private readonly entityTiles: Map<EntityId, TileCoord[]>;

  constructor(
    width: number = DEFAULT_MAP_WIDTH,
    height: number = DEFAULT_MAP_HEIGHT,
    defaultTerrain: TerrainType = 'grass'
  ) {
    assertValidDimensions(width, height);
    this.width = width;
    this.height = height;
    this.tiles = new Array<Tile>(width * height);
    this.entityTiles = new Map<EntityId, TileCoord[]>();

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        this.tiles[y * width + x] = {
          x,
          y,
          terrain: defaultTerrain,
          resource: null,
          entityId: null,
        };
      }
    }
  }

  /**
   * Construct a TileMap from an existing row-major flat Tile[] array (e.g. WorldState.tiles).
   * Validates dimensions, array length, tile coordinates, and builds the occupancy index.
   */
  static fromTiles(width: number, height: number, tiles: Tile[]): TileMap {
    assertValidDimensions(width, height);
    const expectedLength = width * height;
    if (tiles.length !== expectedLength) {
      throw new SimulationError(
        'INVALID_TILE_DATA',
        `Expected ${expectedLength} tiles for (${width}x${height}) grid, received ${tiles.length}.`
      );
    }

    const map = new TileMap(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const tile = tiles[idx];
        if (!tile || tile.x !== x || tile.y !== y) {
          throw new SimulationError(
            'INVALID_TILE_DATA',
            `Tile at index ${idx} does not match expected coordinate (${x}, ${y}).`
          );
        }
        if (tile.resource !== null) {
          assertValidResource(tile.resource);
        }
        map.tiles[idx] = tile;
        if (tile.entityId !== null) {
          const coords = map.entityTiles.get(tile.entityId);
          if (coords) {
            coords.push({ x, y });
          } else {
            map.entityTiles.set(tile.entityId, [{ x, y }]);
          }
        }
      }
    }
    return map;
  }

  get bounds(): GridBounds {
    return { width: this.width, height: this.height };
  }

  /** Returns true iff (x, y) are integers within [0, width) x [0, height). */
  inBounds(x: number, y: number): boolean {
    return isWithinBounds({ x, y }, this.bounds);
  }

  /** Fail-closed bounds assertion. Throws OutOfBoundsError if (x, y) is outside the grid. */
  assertInBounds(x: number, y: number): void {
    if (!this.inBounds(x, y)) {
      throw new OutOfBoundsError({ x, y }, this.bounds);
    }
  }

  /** Row-major flat array index for (x, y). Throws OutOfBoundsError if out of bounds. */
  indexOf(x: number, y: number): number {
    this.assertInBounds(x, y);
    return y * this.width + x;
  }

  /** O(1) tile lookup. Throws OutOfBoundsError if out of bounds. */
  getTile(x: number, y: number): Tile {
    const idx = this.indexOf(x, y);
    const tile = this.tiles[idx];
    if (!tile) {
      throw new OutOfBoundsError({ x, y }, this.bounds);
    }
    return tile;
  }

  /** O(1) tile lookup by TileCoord. Throws OutOfBoundsError if out of bounds. */
  getTileAt(coord: TileCoord): Tile {
    return this.getTile(coord.x, coord.y);
  }

  /** Direct access to the underlying row-major flat Tile array (for WorldState/serialization). */
  getTiles(): Tile[] {
    return this.tiles;
  }

  // --------------------------------------------------------------------------
  // Terrain
  // --------------------------------------------------------------------------

  getTerrain(x: number, y: number): TerrainType {
    return this.getTile(x, y).terrain;
  }

  setTerrain(x: number, y: number, terrain: TerrainType): void {
    this.getTile(x, y).terrain = terrain;
  }

  isBuildableTerrain(x: number, y: number): boolean {
    return this.getTile(x, y).terrain !== 'water';
  }

  // --------------------------------------------------------------------------
  // Resources / Ore Deposits
  // --------------------------------------------------------------------------

  getResource(x: number, y: number): ResourceNode | null {
    return this.getTile(x, y).resource;
  }

  setResource(x: number, y: number, resource: ResourceNode | null): void {
    const tile = this.getTile(x, y);
    if (resource !== null) {
      assertValidResource(resource);
    }
    tile.resource = resource;
  }

  hasResource(x: number, y: number, type?: ResourceType): boolean {
    const res = this.getTile(x, y).resource;
    if (res === null || res.amount <= 0) {
      return false;
    }
    return type === undefined ? true : res.type === type;
  }

  // --------------------------------------------------------------------------
  // O(1) Entity Occupancy
  // --------------------------------------------------------------------------

  /** O(1) entity occupancy lookup at (x, y). Throws OutOfBoundsError if out of bounds. */
  getEntityAt(x: number, y: number): EntityId | null {
    return this.getTile(x, y).entityId;
  }

  /** O(1) occupancy check at (x, y). Throws OutOfBoundsError if out of bounds. */
  isOccupied(x: number, y: number): boolean {
    return this.getTile(x, y).entityId !== null;
  }

  /**
   * Non-throwing placement feasibility check for a footprint anchored at (x, y).
   * Returns false if any tile is out of bounds, water, or already occupied.
   */
  canPlace(
    x: number,
    y: number,
    footprint: EntityFootprint = DEFAULT_FOOTPRINT
  ): boolean {
    assertValidFootprint(footprint);
    for (let dy = 0; dy < footprint.height; dy++) {
      for (let dx = 0; dx < footprint.width; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!this.inBounds(tx, ty)) {
          return false;
        }
        const tile = this.getTile(tx, ty);
        if (tile.terrain === 'water' || tile.entityId !== null) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Set or clear the entity occupancy on a single tile.
   * Throws OutOfBoundsError if out of bounds.
   * Throws SimulationError('TILE_OCCUPIED') if occupied by a different entity.
   */
  setEntityAt(x: number, y: number, entityId: EntityId | null): void {
    const tile = this.getTile(x, y);
    const prevId = tile.entityId;

    if (entityId === null) {
      if (prevId !== null) {
        tile.entityId = null;
        this.removeCoordFromEntityIndex(prevId, x, y);
      }
      return;
    }

    if (prevId !== null && prevId !== entityId) {
      throw new SimulationError(
        'TILE_OCCUPIED',
        `Tile (${x}, ${y}) is already occupied by entity ${prevId}.`
      );
    }

    if (prevId === entityId) {
      return;
    }

    tile.entityId = entityId;
    const coords = this.entityTiles.get(entityId);
    if (coords) {
      coords.push({ x, y });
    } else {
      this.entityTiles.set(entityId, [{ x, y }]);
    }
  }

  /**
   * Atomically occupy all tiles in an entity's footprint anchored at (x, y).
   * Validates bounds and occupancy for every tile before mutating any state.
   */
  occupy(
    x: number,
    y: number,
    entityId: EntityId,
    footprint: EntityFootprint = DEFAULT_FOOTPRINT
  ): void {
    assertValidFootprint(footprint);

    // Phase 1: Validate all tiles atomically before mutating.
    for (let dy = 0; dy < footprint.height; dy++) {
      for (let dx = 0; dx < footprint.width; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        const tile = this.getTile(tx, ty);
        if (tile.entityId !== null && tile.entityId !== entityId) {
          throw new SimulationError(
            'TILE_OCCUPIED',
            `Tile (${tx}, ${ty}) is already occupied by entity ${tile.entityId}.`
          );
        }
      }
    }

    // Phase 2: Commit occupancy.
    for (let dy = 0; dy < footprint.height; dy++) {
      for (let dx = 0; dx < footprint.width; dx++) {
        this.setEntityAt(x + dx, y + dy, entityId);
      }
    }
  }

  /**
   * Clear all tiles occupied by entityId in O(footprint) time.
   * Returns the number of tiles cleared.
   */
  clearEntity(entityId: EntityId): number {
    const coords = this.entityTiles.get(entityId);
    if (!coords || coords.length === 0) {
      return 0;
    }

    let cleared = 0;
    for (const coord of coords) {
      const tile = this.getTile(coord.x, coord.y);
      if (tile.entityId === entityId) {
        tile.entityId = null;
        cleared++;
      }
    }
    this.entityTiles.delete(entityId);
    return cleared;
  }

  /** Returns the coordinates occupied by entityId (empty array if not present). */
  getEntityCoords(entityId: EntityId): readonly TileCoord[] {
    const coords = this.entityTiles.get(entityId);
    return coords ? coords.map((c) => ({ x: c.x, y: c.y })) : [];
  }

  // --------------------------------------------------------------------------
  // Neighbors
  // --------------------------------------------------------------------------

  /**
   * Returns in-bounds orthogonal neighbor tiles in deterministic N, E, S, W order.
   * Throws OutOfBoundsError if (x, y) itself is out of bounds.
   */
  getNeighbors(x: number, y: number): Tile[] {
    this.assertInBounds(x, y);
    const neighbors: Tile[] = [];
    for (const dir of DIRECTIONS) {
      const vec = DIRECTION_VECTORS[dir];
      const nx = x + vec.x;
      const ny = y + vec.y;
      if (this.inBounds(nx, ny)) {
        neighbors.push(this.getTile(nx, ny));
      }
    }
    return neighbors;
  }

  private removeCoordFromEntityIndex(entityId: EntityId, x: number, y: number): void {
    const coords = this.entityTiles.get(entityId);
    if (!coords) return;
    const filtered = coords.filter((c) => c.x !== x || c.y !== y);
    if (filtered.length === 0) {
      this.entityTiles.delete(entityId);
    } else {
      this.entityTiles.set(entityId, filtered);
    }
  }
}
