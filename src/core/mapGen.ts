/**
 * Ironworks-16 Seeded PRNG & Deterministic Map Generator (T09)
 *
 * - Mulberry32 PRNG (strictly deterministic, zero Math.random / Date.now).
 * - Deterministic terrain & ore patch generator guaranteeing starting
 *   Iron, Copper, Coal, and Stone patches near (32, 32).
 * - Headless pure: zero DOM, Window, or Canvas API imports.
 */

import {
  SimulationError,
  isWithinBounds,
  type GridBounds,
  type ResourceNode,
  type ResourceType,
  type TerrainType,
  type Tile,
  type TileCoord,
  type WorldState,
} from '../types/contracts.js';

export const DEFAULT_MAP_WIDTH = 64;
export const DEFAULT_MAP_HEIGHT = 64;
export const DEFAULT_SPAWN_CENTER: TileCoord = { x: 32, y: 32 };

export const STARTING_RESOURCES: readonly ResourceType[] = [
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
] as const;

export interface SeededRng {
  /** Returns a deterministic float in [0, 1). */
  next(): number;
  /** Returns a deterministic integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number;
  /** Returns a deterministic float in [min, max). */
  nextFloat(min: number, max: number): number;
  /** Deterministically picks an element from a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

export interface MapGenOptions {
  readonly width?: number;
  readonly height?: number;
  readonly spawnCenter?: TileCoord;
}

export interface GeneratedMap {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly tiles: Tile[];
  readonly startingPatches: Readonly<Record<ResourceType, readonly TileCoord[]>>;
}

/**
 * Raw Mulberry32 PRNG returning floats in [0, 1).
 * Fails closed on non-finite seeds.
 */
export function mulberry32(seed: number): () => number {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new SimulationError('INVALID_SEED', `Seed must be a finite number, got: ${String(seed)}`);
  }
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a full SeededRng backed by Mulberry32.
 */
export function createMulberry32(seed: number): SeededRng {
  const next = mulberry32(seed);

  const nextInt = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new SimulationError(
        'INVALID_RANGE',
        `nextInt requires integer bounds with min <= max, got [${min}, ${max}].`
      );
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const nextFloat = (min: number, max: number): number => {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new SimulationError(
        'INVALID_RANGE',
        `nextFloat requires finite bounds with min <= max, got [${min}, ${max}].`
      );
    }
    return min + next() * (max - min);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new SimulationError('EMPTY_COLLECTION', 'Cannot pick from an empty array.');
    }
    const index = nextInt(0, items.length - 1);
    return items[index] as T;
  };

  return { next, nextInt, nextFloat, pick };
}

/**
 * Deterministic 2D integer hash in [0, 1) for smooth value noise.
 */
function hash2D(ix: number, iy: number, seedSalt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seedSalt, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise2D(x: number, y: number, scale: number, seedSalt: number): number {
  const sx = x / scale;
  const sy = y / scale;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = smoothstep(sx - x0);
  const fy = smoothstep(sy - y0);

  const v00 = hash2D(x0, y0, seedSalt);
  const v10 = hash2D(x0 + 1, y0, seedSalt);
  const v01 = hash2D(x0, y0 + 1, seedSalt);
  const v11 = hash2D(x0 + 1, y0 + 1, seedSalt);

  const i0 = v00 + (v10 - v00) * fx;
  const i1 = v01 + (v11 - v01) * fx;
  return i0 + (i1 - i0) * fy;
}

function chooseTerrain(
  x: number,
  y: number,
  spawnCenter: TileCoord,
  safeRadius: number,
  elevSalt: number,
  moistSalt: number
): TerrainType {
  const elevation =
    0.65 * valueNoise2D(x, y, 10, elevSalt) +
    0.35 * valueNoise2D(x, y, 4, elevSalt ^ 0x9e3779b9);
  const moisture = valueNoise2D(x, y, 12, moistSalt);

  const dx = x - spawnCenter.x;
  const dy = y - spawnCenter.y;
  const distFromSpawn = Math.hypot(dx, dy);

  if (distFromSpawn > safeRadius && elevation < 0.24) {
    return 'water';
  }
  if (elevation < 0.34) {
    return 'sand';
  }
  if (elevation > 0.74) {
    return 'stone_ground';
  }
  return moisture > 0.45 ? 'grass' : 'dirt';
}

function placeOrePatch(
  tiles: Tile[],
  bounds: GridBounds,
  center: TileCoord,
  resourceType: ResourceType,
  radius: number,
  baseAmount: number,
  rng: SeededRng,
  allowOverwrite: boolean
): TileCoord[] {
  const placed: TileCoord[] = [];
  const rCeil = Math.ceil(radius);

  for (let dy = -rCeil; dy <= rCeil; dy++) {
    for (let dx = -rCeil; dx <= rCeil; dx++) {
      const coord: TileCoord = { x: center.x + dx, y: center.y + dy };
      if (!isWithinBounds(coord, bounds)) continue;

      const dist = Math.hypot(dx, dy);
      const edgeJitter = (rng.next() - 0.5) * 0.85;
      if (dist + edgeJitter > radius) continue;

      const idx = coord.y * bounds.width + coord.x;
      const tile = tiles[idx];
      if (!tile) continue;
      if (!allowOverwrite && (tile.resource !== null || tile.terrain === 'water')) {
        continue;
      }

      if (tile.terrain === 'water') {
        tile.terrain = 'dirt';
      }

      const falloff = Math.max(0.25, 1 - dist / (radius + 0.5));
      const variance = 0.85 + rng.next() * 0.3;
      const amount = Math.max(200, Math.round(baseAmount * falloff * variance));
      const node: ResourceNode = {
        type: resourceType,
        amount,
        initialAmount: amount,
      };
      tile.resource = node;
      placed.push(coord);
    }
  }

  // Guarantee at least the center tile has the resource if within bounds
  if (placed.length === 0 && isWithinBounds(center, bounds)) {
    const idx = center.y * bounds.width + center.x;
    const tile = tiles[idx];
    if (tile) {
      if (tile.terrain === 'water') {
        tile.terrain = 'dirt';
      }
      tile.resource = {
        type: resourceType,
        amount: baseAmount,
        initialAmount: baseAmount,
      };
      placed.push(center);
    }
  }

  return placed;
}

/**
 * Deterministically generates a bounded 2D tile grid from `seed`.
 * Guarantees starting Iron, Copper, Coal, and Stone patches near `spawnCenter` (default (32, 32)).
 */
export function generateMap(seed: number, options: MapGenOptions = {}): GeneratedMap {
  const width = options.width ?? DEFAULT_MAP_WIDTH;
  const height = options.height ?? DEFAULT_MAP_HEIGHT;

  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new SimulationError(
      'INVALID_MAP_DIMENSIONS',
      `Map dimensions must be positive integers, got ${width}x${height}.`
    );
  }

  const spawnCenter: TileCoord = options.spawnCenter ?? {
    x: Math.floor(width / 2),
    y: Math.floor(height / 2),
  };

  const bounds: GridBounds = { width, height };
  if (!isWithinBounds(spawnCenter, bounds)) {
    throw new SimulationError(
      'INVALID_SPAWN_CENTER',
      `Spawn center (${spawnCenter.x}, ${spawnCenter.y}) is outside ${width}x${height} bounds.`
    );
  }

  const rng = createMulberry32(seed);
  const elevSalt = rng.nextInt(1, 0x3fffffff);
  const moistSalt = rng.nextInt(1, 0x3fffffff);
  const safeRadius = Math.min(14, Math.floor(Math.min(width, height) / 3));

  // 1. Generate base terrain
  const tiles: Tile[] = new Array<Tile>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles[y * width + x] = {
        x,
        y,
        terrain: chooseTerrain(x, y, spawnCenter, safeRadius, elevSalt, moistSalt),
        resource: null,
        entityId: null,
      };
    }
  }

  // 2. Place guaranteed starting patches in 4 distinct quadrants near spawnCenter
  const offsetX = Math.max(2, Math.min(7, Math.floor(width / 8)));
  const offsetY = Math.max(2, Math.min(6, Math.floor(height / 9)));
  const startingAnchors: Readonly<Record<ResourceType, TileCoord>> = {
    iron_ore: { x: spawnCenter.x - offsetX, y: spawnCenter.y - offsetY },
    copper_ore: { x: spawnCenter.x + offsetX, y: spawnCenter.y - offsetY },
    coal: { x: spawnCenter.x - offsetX, y: spawnCenter.y + offsetY },
    stone: { x: spawnCenter.x + offsetX, y: spawnCenter.y + offsetY },
  };

  const startingBaseAmounts: Readonly<Record<ResourceType, number>> = {
    iron_ore: 2000,
    copper_ore: 1800,
    coal: 1600,
    stone: 1400,
  };

  const startingPatchesMutable: Record<ResourceType, TileCoord[]> = {
    iron_ore: [],
    copper_ore: [],
    coal: [],
    stone: [],
  };

  const startingRadius = Math.min(2.7, Math.max(1.4, Math.min(width, height) / 24));

  for (const resType of STARTING_RESOURCES) {
    const anchor = startingAnchors[resType];
    const jitterX = rng.nextInt(-1, 1);
    const jitterY = rng.nextInt(-1, 1);
    const patchCenter: TileCoord = {
      x: Math.max(1, Math.min(width - 2, anchor.x + jitterX)),
      y: Math.max(1, Math.min(height - 2, anchor.y + jitterY)),
    };
    startingPatchesMutable[resType] = placeOrePatch(
      tiles,
      bounds,
      patchCenter,
      resType,
      startingRadius,
      startingBaseAmounts[resType],
      rng,
      true
    );
  }

  // 3. Scatter additional outer-region ore patches deterministically
  const extraPatchesPerType = width >= 48 && height >= 48 ? 2 : 1;
  for (const resType of STARTING_RESOURCES) {
    for (let i = 0; i < extraPatchesPerType; i++) {
      const cx = rng.nextInt(3, Math.max(3, width - 4));
      const cy = rng.nextInt(3, Math.max(3, height - 4));
      const dist = Math.hypot(cx - spawnCenter.x, cy - spawnCenter.y);
      if (dist < safeRadius * 0.85) continue;

      const radius = rng.nextFloat(2.0, 3.2);
      const baseAmount = rng.nextInt(1200, 3000);
      placeOrePatch(tiles, bounds, { x: cx, y: cy }, resType, radius, baseAmount, rng, false);
    }
  }

  return {
    seed,
    width,
    height,
    tiles,
    startingPatches: startingPatchesMutable,
  };
}

/**
 * Convenience helper to construct a fresh deterministic WorldState from a seed.
 */
export function createInitialWorldState(seed: number, options: MapGenOptions = {}): WorldState {
  const generated = generateMap(seed, options);
  return {
    schemaVersion: 1,
    seed: generated.seed,
    tick: 0,
    width: generated.width,
    height: generated.height,
    tiles: generated.tiles,
    entities: {},
    nextEntityId: 1,
    powerGrid: {
      networks: {},
      nextNetworkId: 1,
    },
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: {
      cycleTick: 0,
      solarFactor: 1,
    },
    stats: {
      byItem: {},
    },
  };
}
