/**
 * Ironworks-16 Corner Minimap Renderer (T46)
 *
 * Renders a deterministic 160x160 corner minimap displaying terrain,
 * ore deposits, placed entities, and the current camera viewport box.
 * Uses a structural Canvas 2D context interface with zero DOM imports
 * so it can be tested headlessly in Node/Vitest.
 */

import {
  type CameraState,
  type Entity,
  type EntityId,
  type EntityType,
  type GridBounds,
  type ResourceType,
  SimulationError,
  type TerrainType,
  type Tile,
  type WorldCoord,
  type WorldState,
  clamp,
} from '../types/contracts.js';
import type { ViewportSize } from './camera.js';

// ============================================================================
// Constants & Palette
// ============================================================================

export const DEFAULT_MINIMAP_SIZE = 160;
export const DEFAULT_MINIMAP_MARGIN = 12;

export type MinimapCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export const DEFAULT_MINIMAP_CORNER: MinimapCorner = 'top-right';

export const MINIMAP_TERRAIN_COLORS: Readonly<Record<TerrainType, string>> = {
  grass: '#3a6b35',
  dirt: '#7a5c3e',
  sand: '#c2a86b',
  water: '#24568a',
  stone_ground: '#6d7178',
} as const;

export const MINIMAP_RESOURCE_COLORS: Readonly<Record<ResourceType, string>> = {
  iron_ore: '#7da6c8',
  copper_ore: '#d47a3c',
  coal: '#222428',
  stone: '#b5b0a1',
} as const;

export const MINIMAP_ENTITY_COLORS: Readonly<Record<EntityType, string>> = {
  transport_belt: '#d9a441',
  splitter: '#e6b84c',
  underground_belt: '#b5842a',
  inserter: '#e8c547',
  filter_inserter: '#b066e0',
  power_pole: '#66d9ef',
  wooden_chest: '#a66b3a',
  iron_chest: '#9aa5b1',
  burner_drill: '#c95d3a',
  electric_drill: '#4ea8de',
  stone_furnace: '#d96b38',
  electric_furnace: '#ff8c42',
  assembler_mk1: '#4d96ff',
  assembler_mk2: '#38bdf8',
  boiler: '#e05a47',
  steam_engine: '#f28482',
  solar_panel: '#2a6f97',
  accumulator: '#52b788',
  research_lab: '#e0e7ff',
} as const;

export interface MinimapStyle {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly viewportBoxColor: string;
  readonly viewportBoxFillColor: string;
  readonly viewportBoxLineWidth: number;
}

export const DEFAULT_MINIMAP_STYLE: MinimapStyle = {
  backgroundColor: '#14181f',
  borderColor: '#4a5568',
  borderWidth: 2,
  viewportBoxColor: '#ffd166',
  viewportBoxFillColor: 'rgba(255, 209, 102, 0.12)',
  viewportBoxLineWidth: 1.5,
} as const;

// ============================================================================
// Types & Errors
// ============================================================================

export interface MinimapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MinimapOptions {
  readonly size?: number;
  readonly margin?: number;
  readonly corner?: MinimapCorner;
  readonly style?: Partial<MinimapStyle>;
}

/**
 * Structural subset of CanvasRenderingContext2D needed to render the minimap.
 * Compatible with both browser CanvasRenderingContext2D and headless mocks.
 */
export interface MinimapCanvasContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
}

export class MinimapError extends SimulationError {
  constructor(message: string) {
    super('MINIMAP_ERROR', message);
    this.name = 'MinimapError';
  }
}

// ============================================================================
// Validation Helpers (Fail-Closed)
// ============================================================================

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new MinimapError(`${label} must be a finite number, got ${value}.`);
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MinimapError(`${label} must be a positive finite number, got ${value}.`);
  }
}

function assertNonNegativeFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new MinimapError(`${label} must be a non-negative finite number, got ${value}.`);
  }
}

function assertValidViewport(viewport: ViewportSize): void {
  assertPositiveFinite(viewport.width, 'viewport.width');
  assertPositiveFinite(viewport.height, 'viewport.height');
}

function assertValidCamera(camera: CameraState): void {
  assertFinite(camera.x, 'camera.x');
  assertFinite(camera.y, 'camera.y');
  assertPositiveFinite(camera.zoom, 'camera.zoom');
}

function assertValidWorldBounds(bounds: GridBounds): void {
  if (
    !Number.isInteger(bounds.width) ||
    !Number.isInteger(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new MinimapError(
      `worldBounds must have positive integer dimensions, got (${bounds.width}x${bounds.height}).`
    );
  }
}

function assertValidMinimapRect(rect: MinimapRect): void {
  assertFinite(rect.x, 'minimapRect.x');
  assertFinite(rect.y, 'minimapRect.y');
  assertPositiveFinite(rect.width, 'minimapRect.width');
  assertPositiveFinite(rect.height, 'minimapRect.height');
}

function resolveStyle(partial?: Partial<MinimapStyle>): MinimapStyle {
  if (!partial) {
    return DEFAULT_MINIMAP_STYLE;
  }
  const style: MinimapStyle = {
    backgroundColor: partial.backgroundColor ?? DEFAULT_MINIMAP_STYLE.backgroundColor,
    borderColor: partial.borderColor ?? DEFAULT_MINIMAP_STYLE.borderColor,
    borderWidth: partial.borderWidth ?? DEFAULT_MINIMAP_STYLE.borderWidth,
    viewportBoxColor: partial.viewportBoxColor ?? DEFAULT_MINIMAP_STYLE.viewportBoxColor,
    viewportBoxFillColor:
      partial.viewportBoxFillColor ?? DEFAULT_MINIMAP_STYLE.viewportBoxFillColor,
    viewportBoxLineWidth:
      partial.viewportBoxLineWidth ?? DEFAULT_MINIMAP_STYLE.viewportBoxLineWidth,
  };
  assertNonNegativeFinite(style.borderWidth, 'style.borderWidth');
  assertNonNegativeFinite(style.viewportBoxLineWidth, 'style.viewportBoxLineWidth');
  return style;
}

// ============================================================================
// Pure Geometry & Color Functions
// ============================================================================

/**
 * Computes the screen-space bounding rectangle of the corner minimap.
 */
export function computeMinimapRect(
  viewport: ViewportSize,
  options: MinimapOptions = {}
): MinimapRect {
  assertValidViewport(viewport);
  const size = options.size ?? DEFAULT_MINIMAP_SIZE;
  const margin = options.margin ?? DEFAULT_MINIMAP_MARGIN;
  const corner = options.corner ?? DEFAULT_MINIMAP_CORNER;

  assertPositiveFinite(size, 'options.size');
  assertNonNegativeFinite(margin, 'options.margin');

  let x: number;
  let y: number;

  switch (corner) {
    case 'top-left':
      x = margin;
      y = margin;
      break;
    case 'top-right':
      x = viewport.width - size - margin;
      y = margin;
      break;
    case 'bottom-left':
      x = margin;
      y = viewport.height - size - margin;
      break;
    case 'bottom-right':
      x = viewport.width - size - margin;
      y = viewport.height - size - margin;
      break;
    default:
      throw new MinimapError(`Unsupported minimap corner: "${String(corner)}".`);
  }

  return { x, y, width: size, height: size };
}

/**
 * Projects the camera's visible world-space rectangle onto the minimap,
 * clamped to the minimap's inner bounds.
 */
export function computeCameraViewportBox(
  camera: CameraState,
  viewport: ViewportSize,
  worldBounds: GridBounds,
  minimapRect: MinimapRect
): MinimapRect {
  assertValidCamera(camera);
  assertValidViewport(viewport);
  assertValidWorldBounds(worldBounds);
  assertValidMinimapRect(minimapRect);

  const halfWorldW = viewport.width / (2 * camera.zoom);
  const halfWorldH = viewport.height / (2 * camera.zoom);

  const worldLeft = clamp(camera.x - halfWorldW, 0, worldBounds.width);
  const worldRight = clamp(camera.x + halfWorldW, 0, worldBounds.width);
  const worldTop = clamp(camera.y - halfWorldH, 0, worldBounds.height);
  const worldBottom = clamp(camera.y + halfWorldH, 0, worldBounds.height);

  const scaleX = minimapRect.width / worldBounds.width;
  const scaleY = minimapRect.height / worldBounds.height;

  const boxX = minimapRect.x + worldLeft * scaleX;
  const boxY = minimapRect.y + worldTop * scaleY;
  const boxW = Math.max(0, (worldRight - worldLeft) * scaleX);
  const boxH = Math.max(0, (worldBottom - worldTop) * scaleY);

  return {
    x: boxX,
    y: boxY,
    width: boxW,
    height: boxH,
  };
}

/**
 * Returns true if the screen-space point lies inside the minimap rectangle.
 */
export function isPointInMinimap(
  screenX: number,
  screenY: number,
  minimapRect: MinimapRect
): boolean {
  assertFinite(screenX, 'screenX');
  assertFinite(screenY, 'screenY');
  assertValidMinimapRect(minimapRect);

  return (
    screenX >= minimapRect.x &&
    screenX <= minimapRect.x + minimapRect.width &&
    screenY >= minimapRect.y &&
    screenY <= minimapRect.y + minimapRect.height
  );
}

/**
 * Converts a screen-space click inside the minimap to world tile coordinates.
 * Returns null if the point is outside the minimap.
 */
export function minimapPointToWorld(
  screenX: number,
  screenY: number,
  minimapRect: MinimapRect,
  worldBounds: GridBounds
): WorldCoord | null {
  assertValidWorldBounds(worldBounds);
  if (!isPointInMinimap(screenX, screenY, minimapRect)) {
    return null;
  }

  const normX = (screenX - minimapRect.x) / minimapRect.width;
  const normY = (screenY - minimapRect.y) / minimapRect.height;

  return {
    x: clamp(normX * worldBounds.width, 0, worldBounds.width),
    y: clamp(normY * worldBounds.height, 0, worldBounds.height),
  };
}

/**
 * Resolves the single minimap pixel color for a tile.
 * Priority: occupying entity > non-depleted ore resource > base terrain.
 */
export function getTileMinimapColor(
  tile: Tile,
  entities: Readonly<Record<EntityId, Entity>>
): string {
  if (tile.entityId !== null) {
    const entity = entities[tile.entityId];
    if (entity) {
      return MINIMAP_ENTITY_COLORS[entity.type];
    }
  }

  if (tile.resource !== null && tile.resource.amount > 0) {
    return MINIMAP_RESOURCE_COLORS[tile.resource.type];
  }

  return MINIMAP_TERRAIN_COLORS[tile.terrain];
}

// ============================================================================
// Canvas 2D Renderer
// ============================================================================

/**
 * Renders the 160x160 corner minimap and camera viewport box onto the given
 * Canvas 2D context. Returns the rendered screen-space MinimapRect.
 */
export function renderMinimap(
  ctx: MinimapCanvasContext,
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  options: MinimapOptions = {}
): MinimapRect {
  const worldBounds: GridBounds = { width: world.width, height: world.height };
  assertValidWorldBounds(worldBounds);
  if (world.tiles.length !== world.width * world.height) {
    throw new MinimapError(
      `world.tiles length (${world.tiles.length}) does not match width*height (${world.width * world.height}).`
    );
  }
  assertValidCamera(camera);
  assertValidViewport(viewport);

  const rect = computeMinimapRect(viewport, options);
  const style = resolveStyle(options.style);

  // 1. Background
  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  // 2. Clipped map & viewport box
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();

  const scaleX = rect.width / world.width;
  const scaleY = rect.height / world.height;

  // Row-by-row horizontal run-length batching for deterministic, fast rendering
  for (let ty = 0; ty < world.height; ty++) {
    const rowOffset = ty * world.width;
    const py0 = Math.floor(rect.y + ty * scaleY);
    const py1 = Math.ceil(rect.y + (ty + 1) * scaleY);
    const ph = Math.max(1, py1 - py0);

    let runStart = 0;
    let runColor = getTileMinimapColor(world.tiles[rowOffset] as Tile, world.entities);

    for (let tx = 1; tx <= world.width; tx++) {
      const nextColor =
        tx < world.width
          ? getTileMinimapColor(world.tiles[rowOffset + tx] as Tile, world.entities)
          : null;

      if (nextColor !== runColor) {
        const px0 = Math.floor(rect.x + runStart * scaleX);
        const px1 = Math.ceil(rect.x + tx * scaleX);
        const pw = Math.max(1, px1 - px0);

        ctx.fillStyle = runColor;
        ctx.fillRect(px0, py0, pw, ph);

        if (nextColor !== null) {
          runStart = tx;
          runColor = nextColor;
        }
      }
    }
  }

  // 3. Camera viewport box
  const vpBox = computeCameraViewportBox(camera, viewport, worldBounds, rect);
  if (vpBox.width > 0 && vpBox.height > 0) {
    ctx.fillStyle = style.viewportBoxFillColor;
    ctx.fillRect(vpBox.x, vpBox.y, vpBox.width, vpBox.height);

    ctx.strokeStyle = style.viewportBoxColor;
    ctx.lineWidth = style.viewportBoxLineWidth;
    ctx.strokeRect(vpBox.x, vpBox.y, vpBox.width, vpBox.height);
  }

  ctx.restore();

  // 4. Outer border
  if (style.borderWidth > 0) {
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = style.borderWidth;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }

  return rect;
}

// ============================================================================
// Stateful Convenience Wrapper
// ============================================================================

export class Minimap {
  private readonly options: MinimapOptions;

  constructor(options: MinimapOptions = {}) {
    if (options.size !== undefined) {
      assertPositiveFinite(options.size, 'options.size');
    }
    if (options.margin !== undefined) {
      assertNonNegativeFinite(options.margin, 'options.margin');
    }
    resolveStyle(options.style);
    this.options = options;
  }

  getRect(viewport: ViewportSize): MinimapRect {
    return computeMinimapRect(viewport, this.options);
  }

  containsPoint(screenX: number, screenY: number, viewport: ViewportSize): boolean {
    return isPointInMinimap(screenX, screenY, this.getRect(viewport));
  }

  screenToWorld(
    screenX: number,
    screenY: number,
    viewport: ViewportSize,
    worldBounds: GridBounds
  ): WorldCoord | null {
    return minimapPointToWorld(screenX, screenY, this.getRect(viewport), worldBounds);
  }

  render(
    ctx: MinimapCanvasContext,
    world: WorldState,
    camera: CameraState,
    viewport: ViewportSize
  ): MinimapRect {
    return renderMinimap(ctx, world, camera, viewport, this.options);
  }
}
