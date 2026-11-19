/**
 * Ironworks-16 Visible Terrain & Ore-Patch Renderer (T38)
 *
 * Renders only the viewport-culled visible tiles and active ore deposits
 * using the procedural 16x16 SpriteAtlas (T36) and Camera transforms (T37).
 *
 * Strictly deterministic: zero Math.random() or Date.now().
 * Fail-closed: validates world dimensions/tile array length and propagates
 * CameraError / UnknownSpriteError on invalid inputs.
 * Headless-safe: works with mock CanvasRenderingContext2D in Node/Vitest.
 */

import {
  SimulationError,
  clamp,
  type CameraState,
  type ResourceNode,
  type Tile,
  type ViewportBounds,
  type WorldState,
} from '../types/contracts.js';
import {
  getVisibleTileBounds,
  tileToScreen,
  type ViewportSize,
} from './camera.js';
import {
  SpriteAtlas,
  getResourceSpriteKey,
  getTerrainSpriteKey,
} from './spriteAtlas.js';

// ============================================================================
// Types & Errors
// ============================================================================

export type TerrainWorldView = Pick<WorldState, 'width' | 'height' | 'tiles'>;

export interface TerrainRenderOptions {
  /** Extra tiles to render around the viewport edges (default 0). */
  readonly paddingTiles?: number;
  /** Snap tile rects to integer pixels to prevent subpixel seams (default true). */
  readonly pixelSnap?: boolean;
  /** Modulate ore alpha slightly as deposits deplete (default true). */
  readonly showResourceRichness?: boolean;
  /** Draw subtle tile grid lines over visible tiles (default false). */
  readonly showGrid?: boolean;
  /** Grid line stroke style when showGrid is true. */
  readonly gridColor?: string;
}

export interface TerrainRenderStats {
  readonly bounds: ViewportBounds;
  readonly tilesRendered: number;
  readonly resourcesRendered: number;
  readonly depletedSkipped: number;
}

export class TerrainRenderError extends SimulationError {
  constructor(message: string) {
    super('TERRAIN_RENDER_ERROR', message);
    this.name = 'TerrainRenderError';
  }
}

const DEFAULT_GRID_COLOR = 'rgba(0, 0, 0, 0.12)';
const MIN_ORE_ALPHA = 0.45;

// ============================================================================
// Validation & Pure Helpers
// ============================================================================

function assertValidWorldView(world: TerrainWorldView): void {
  if (
    !Number.isInteger(world.width) ||
    !Number.isInteger(world.height) ||
    world.width <= 0 ||
    world.height <= 0
  ) {
    throw new TerrainRenderError(
      `World dimensions must be positive integers, got (${world.width}x${world.height}).`
    );
  }
  const expectedLength = world.width * world.height;
  if (!Array.isArray(world.tiles) || world.tiles.length !== expectedLength) {
    throw new TerrainRenderError(
      `World tiles length (${world.tiles?.length ?? 'invalid'}) does not match ${world.width}x${world.height} (${expectedLength}).`
    );
  }
}

/**
 * Computes normalized ore richness in [0, 1].
 * Returns 0 for depleted or invalid nodes.
 */
export function computeResourceRichness(resource: ResourceNode): number {
  if (!Number.isFinite(resource.amount) || resource.amount <= 0) {
    return 0;
  }
  if (!Number.isFinite(resource.initialAmount) || resource.initialAmount <= 0) {
    return 1;
  }
  return clamp(resource.amount / resource.initialAmount, 0, 1);
}

/**
 * Collects all visible tiles in deterministic row-major order (y outer, x inner).
 */
export function collectVisibleTerrainTiles(
  world: TerrainWorldView,
  camera: CameraState,
  viewport: ViewportSize,
  paddingTiles = 0
): Tile[] {
  assertValidWorldView(world);
  const bounds = getVisibleTileBounds(
    camera,
    viewport,
    { width: world.width, height: world.height },
    paddingTiles
  );

  if (bounds.minTileX > bounds.maxTileX || bounds.minTileY > bounds.maxTileY) {
    return [];
  }

  const visible: Tile[] = [];
  for (let y = bounds.minTileY; y <= bounds.maxTileY; y++) {
    const rowOffset = y * world.width;
    for (let x = bounds.minTileX; x <= bounds.maxTileX; x++) {
      const tile = world.tiles[rowOffset + x];
      if (!tile) {
        throw new TerrainRenderError(`Missing tile at (${x}, ${y}).`);
      }
      visible.push(tile);
    }
  }
  return visible;
}

// ============================================================================
// Terrain & Ore-Patch Renderer
// ============================================================================

/**
 * Renders all visible terrain tiles and non-depleted ore patches onto `ctx`.
 */
export function renderTerrainLayer(
  ctx: CanvasRenderingContext2D,
  world: TerrainWorldView,
  camera: CameraState,
  viewport: ViewportSize,
  atlas: SpriteAtlas,
  options: TerrainRenderOptions = {}
): TerrainRenderStats {
  assertValidWorldView(world);

  const paddingTiles = options.paddingTiles ?? 0;
  const pixelSnap = options.pixelSnap ?? true;
  const showResourceRichness = options.showResourceRichness ?? true;
  const showGrid = options.showGrid ?? false;
  const gridColor = options.gridColor ?? DEFAULT_GRID_COLOR;

  const bounds = getVisibleTileBounds(
    camera,
    viewport,
    { width: world.width, height: world.height },
    paddingTiles
  );

  if (bounds.minTileX > bounds.maxTileX || bounds.minTileY > bounds.maxTileY) {
    return {
      bounds,
      tilesRendered: 0,
      resourcesRendered: 0,
      depletedSkipped: 0,
    };
  }

  const zoom = camera.zoom;
  const origin = tileToScreen(
    camera,
    { x: bounds.minTileX, y: bounds.minTileY },
    viewport
  );

  if (typeof ctx.imageSmoothingEnabled === 'boolean') {
    ctx.imageSmoothingEnabled = false;
  }

  let tilesRendered = 0;
  let resourcesRendered = 0;
  let depletedSkipped = 0;

  for (let y = bounds.minTileY; y <= bounds.maxTileY; y++) {
    const rowOffset = y * world.width;
    const rawY = origin.y + (y - bounds.minTileY) * zoom;
    const dy = pixelSnap ? Math.floor(rawY) : rawY;
    const dh = pixelSnap ? Math.floor(rawY + zoom) - dy : zoom;

    for (let x = bounds.minTileX; x <= bounds.maxTileX; x++) {
      const tile = world.tiles[rowOffset + x];
      if (!tile) {
        throw new TerrainRenderError(`Missing tile at (${x}, ${y}).`);
      }

      const rawX = origin.x + (x - bounds.minTileX) * zoom;
      const dx = pixelSnap ? Math.floor(rawX) : rawX;
      const dw = pixelSnap ? Math.floor(rawX + zoom) - dx : zoom;

      const terrainKey = getTerrainSpriteKey(tile.terrain);
      atlas.draw(ctx, terrainKey, dx, dy, dw, dh);
      tilesRendered += 1;

      if (tile.resource !== null) {
        const richness = computeResourceRichness(tile.resource);
        if (richness <= 0) {
          depletedSkipped += 1;
        } else {
          const resourceKey = getResourceSpriteKey(tile.resource.type);
          const alpha = showResourceRichness
            ? MIN_ORE_ALPHA + (1 - MIN_ORE_ALPHA) * richness
            : 1;

          if (alpha < 1 && typeof ctx.save === 'function' && typeof ctx.restore === 'function') {
            ctx.save();
            ctx.globalAlpha = (typeof ctx.globalAlpha === 'number' ? ctx.globalAlpha : 1) * alpha;
            atlas.draw(ctx, resourceKey, dx, dy, dw, dh);
            ctx.restore();
          } else {
            atlas.draw(ctx, resourceKey, dx, dy, dw, dh);
          }
          resourcesRendered += 1;
        }
      }
    }
  }

  if (
    showGrid &&
    typeof ctx.beginPath === 'function' &&
    typeof ctx.moveTo === 'function' &&
    typeof ctx.lineTo === 'function' &&
    typeof ctx.stroke === 'function'
  ) {
    const startX = pixelSnap ? Math.floor(origin.x) : origin.x;
    const startY = pixelSnap ? Math.floor(origin.y) : origin.y;
    const cols = bounds.maxTileX - bounds.minTileX + 1;
    const rows = bounds.maxTileY - bounds.minTileY + 1;
    const endX = pixelSnap ? Math.floor(origin.x + cols * zoom) : origin.x + cols * zoom;
    const endY = pixelSnap ? Math.floor(origin.y + rows * zoom) : origin.y + rows * zoom;

    if (typeof ctx.save === 'function') ctx.save();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const gx = pixelSnap ? Math.floor(origin.x + c * zoom) + 0.5 : origin.x + c * zoom;
      ctx.moveTo(gx, startY);
      ctx.lineTo(gx, endY);
    }
    for (let r = 0; r <= rows; r++) {
      const gy = pixelSnap ? Math.floor(origin.y + r * zoom) + 0.5 : origin.y + r * zoom;
      ctx.moveTo(startX, gy);
      ctx.lineTo(endX, gy);
    }
    ctx.stroke();
    if (typeof ctx.restore === 'function') ctx.restore();
  }

  return {
    bounds,
    tilesRendered,
    resourcesRendered,
    depletedSkipped,
  };
}

// ============================================================================
// Stateful Wrapper Class
// ============================================================================

export class TerrainLayer {
  private readonly defaultOptions: TerrainRenderOptions;

  constructor(options: TerrainRenderOptions = {}) {
    this.defaultOptions = { ...options };
  }

  render(
    ctx: CanvasRenderingContext2D,
    world: TerrainWorldView,
    camera: CameraState,
    viewport: ViewportSize,
    atlas: SpriteAtlas,
    overrides?: TerrainRenderOptions
  ): TerrainRenderStats {
    const merged: TerrainRenderOptions = overrides
      ? { ...this.defaultOptions, ...overrides }
      : this.defaultOptions;
    return renderTerrainLayer(ctx, world, camera, viewport, atlas, merged);
  }
}
