/**
 * Ironworks-16 Camera & Viewport Culling (T37)
 *
 * Pure, deterministic pan/zoom camera with screen-to-world/tile transforms
 * and inclusive tile viewport culling. Zero DOM/Canvas dependencies so it
 * can be tested headlessly in Node/Vitest.
 */

import {
  type CameraState,
  type EntityFootprint,
  type GridBounds,
  SimulationError,
  type TileCoord,
  type ViewportBounds,
  type WorldCoord,
  clamp,
  isWithinBounds,
} from '../types/contracts.js';

// ============================================================================
// Constants & Types
// ============================================================================

export const DEFAULT_TILE_SIZE = 16;
export const DEFAULT_CAMERA_ZOOM = 32;
export const MIN_CAMERA_ZOOM = 8;
export const MAX_CAMERA_ZOOM = 96;
export const DEFAULT_WORLD_BOUNDS: GridBounds = { width: 64, height: 64 };

export interface ScreenCoord {
  readonly x: number;
  readonly y: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface CameraOptions {
  readonly x?: number;
  readonly y?: number;
  readonly zoom?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly worldBounds?: GridBounds;
}

export class CameraError extends SimulationError {
  constructor(message: string) {
    super('CAMERA_ERROR', message);
    this.name = 'CameraError';
  }
}

// ============================================================================
// Validation Helpers (Fail-Closed)
// ============================================================================

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new CameraError(`${label} must be a finite number, got ${value}.`);
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new CameraError(`${label} must be a positive finite number, got ${value}.`);
  }
}

function assertValidCameraState(camera: CameraState): void {
  assertFinite(camera.x, 'camera.x');
  assertFinite(camera.y, 'camera.y');
  assertPositiveFinite(camera.zoom, 'camera.zoom');
}

function assertValidViewport(viewport: ViewportSize): void {
  assertPositiveFinite(viewport.width, 'viewport.width');
  assertPositiveFinite(viewport.height, 'viewport.height');
}

function assertValidZoomLimits(minZoom: number, maxZoom: number): void {
  assertPositiveFinite(minZoom, 'minZoom');
  assertPositiveFinite(maxZoom, 'maxZoom');
  if (minZoom > maxZoom) {
    throw new CameraError(`minZoom (${minZoom}) cannot exceed maxZoom (${maxZoom}).`);
  }
}

function assertValidWorldBounds(bounds: GridBounds): void {
  if (
    !Number.isInteger(bounds.width) ||
    !Number.isInteger(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new CameraError(
      `worldBounds must have positive integer dimensions, got (${bounds.width}x${bounds.height}).`
    );
  }
}

function clampToWorldBounds(
  x: number,
  y: number,
  worldBounds?: GridBounds
): { x: number; y: number } {
  if (!worldBounds) {
    return { x, y };
  }
  assertValidWorldBounds(worldBounds);
  return {
    x: clamp(x, 0, worldBounds.width),
    y: clamp(y, 0, worldBounds.height),
  };
}

// ============================================================================
// Pure Camera Operations
// ============================================================================

export function createCameraState(options: CameraOptions = {}): CameraState {
  const minZoom = options.minZoom ?? MIN_CAMERA_ZOOM;
  const maxZoom = options.maxZoom ?? MAX_CAMERA_ZOOM;
  assertValidZoomLimits(minZoom, maxZoom);

  if (options.worldBounds) {
    assertValidWorldBounds(options.worldBounds);
  }

  const defaultX = options.worldBounds ? options.worldBounds.width / 2 : DEFAULT_WORLD_BOUNDS.width / 2;
  const defaultY = options.worldBounds ? options.worldBounds.height / 2 : DEFAULT_WORLD_BOUNDS.height / 2;

  const rawX = options.x ?? defaultX;
  const rawY = options.y ?? defaultY;
  const rawZoom = options.zoom ?? DEFAULT_CAMERA_ZOOM;

  assertFinite(rawX, 'x');
  assertFinite(rawY, 'y');
  assertPositiveFinite(rawZoom, 'zoom');

  const clampedPos = clampToWorldBounds(rawX, rawY, options.worldBounds);
  return {
    x: clampedPos.x,
    y: clampedPos.y,
    zoom: clamp(rawZoom, minZoom, maxZoom),
  };
}

export function panCamera(
  camera: CameraState,
  dxTiles: number,
  dyTiles: number,
  worldBounds?: GridBounds
): CameraState {
  assertValidCameraState(camera);
  assertFinite(dxTiles, 'dxTiles');
  assertFinite(dyTiles, 'dyTiles');

  const pos = clampToWorldBounds(camera.x + dxTiles, camera.y + dyTiles, worldBounds);
  return {
    x: pos.x,
    y: pos.y,
    zoom: camera.zoom,
  };
}

export function panCameraByPixels(
  camera: CameraState,
  dxPixels: number,
  dyPixels: number,
  worldBounds?: GridBounds
): CameraState {
  assertValidCameraState(camera);
  assertFinite(dxPixels, 'dxPixels');
  assertFinite(dyPixels, 'dyPixels');

  return panCamera(camera, dxPixels / camera.zoom, dyPixels / camera.zoom, worldBounds);
}

export function centerCameraOn(
  camera: CameraState,
  target: WorldCoord,
  worldBounds?: GridBounds
): CameraState {
  assertValidCameraState(camera);
  assertFinite(target.x, 'target.x');
  assertFinite(target.y, 'target.y');

  const pos = clampToWorldBounds(target.x, target.y, worldBounds);
  return {
    x: pos.x,
    y: pos.y,
    zoom: camera.zoom,
  };
}

export function zoomCamera(
  camera: CameraState,
  factor: number,
  minZoom = MIN_CAMERA_ZOOM,
  maxZoom = MAX_CAMERA_ZOOM
): CameraState {
  assertValidCameraState(camera);
  assertPositiveFinite(factor, 'factor');
  assertValidZoomLimits(minZoom, maxZoom);

  return {
    x: camera.x,
    y: camera.y,
    zoom: clamp(camera.zoom * factor, minZoom, maxZoom),
  };
}

export function zoomCameraAtPoint(
  camera: CameraState,
  factor: number,
  anchorScreen: ScreenCoord,
  viewport: ViewportSize,
  minZoom = MIN_CAMERA_ZOOM,
  maxZoom = MAX_CAMERA_ZOOM,
  worldBounds?: GridBounds
): CameraState {
  assertValidCameraState(camera);
  assertPositiveFinite(factor, 'factor');
  assertFinite(anchorScreen.x, 'anchorScreen.x');
  assertFinite(anchorScreen.y, 'anchorScreen.y');
  assertValidViewport(viewport);
  assertValidZoomLimits(minZoom, maxZoom);

  const worldAnchor = screenToWorld(camera, anchorScreen, viewport);
  const nextZoom = clamp(camera.zoom * factor, minZoom, maxZoom);

  const nextX = worldAnchor.x - (anchorScreen.x - viewport.width / 2) / nextZoom;
  const nextY = worldAnchor.y - (anchorScreen.y - viewport.height / 2) / nextZoom;
  const pos = clampToWorldBounds(nextX, nextY, worldBounds);

  return {
    x: pos.x,
    y: pos.y,
    zoom: nextZoom,
  };
}

// ============================================================================
// Coordinate Transforms
// ============================================================================

export function worldToScreen(
  camera: CameraState,
  world: WorldCoord,
  viewport: ViewportSize
): ScreenCoord {
  assertValidCameraState(camera);
  assertFinite(world.x, 'world.x');
  assertFinite(world.y, 'world.y');
  assertValidViewport(viewport);

  return {
    x: (world.x - camera.x) * camera.zoom + viewport.width / 2,
    y: (world.y - camera.y) * camera.zoom + viewport.height / 2,
  };
}

export function tileToScreen(
  camera: CameraState,
  tile: TileCoord,
  viewport: ViewportSize
): ScreenCoord {
  return worldToScreen(camera, tile, viewport);
}

export function screenToWorld(
  camera: CameraState,
  screen: ScreenCoord,
  viewport: ViewportSize
): WorldCoord {
  assertValidCameraState(camera);
  assertFinite(screen.x, 'screen.x');
  assertFinite(screen.y, 'screen.y');
  assertValidViewport(viewport);

  return {
    x: (screen.x - viewport.width / 2) / camera.zoom + camera.x,
    y: (screen.y - viewport.height / 2) / camera.zoom + camera.y,
  };
}

export function screenToTile(
  camera: CameraState,
  screen: ScreenCoord,
  viewport: ViewportSize
): TileCoord {
  const world = screenToWorld(camera, screen, viewport);
  return {
    x: Math.floor(world.x),
    y: Math.floor(world.y),
  };
}

export function screenToTileBounded(
  camera: CameraState,
  screen: ScreenCoord,
  viewport: ViewportSize,
  worldBounds: GridBounds
): TileCoord | null {
  assertValidWorldBounds(worldBounds);
  const tile = screenToTile(camera, screen, viewport);
  return isWithinBounds(tile, worldBounds) ? tile : null;
}

// ============================================================================
// Viewport Culling
// ============================================================================

const EMPTY_VIEWPORT_BOUNDS: ViewportBounds = {
  minTileX: 0,
  maxTileX: -1,
  minTileY: 0,
  maxTileY: -1,
};

export function getVisibleTileBounds(
  camera: CameraState,
  viewport: ViewportSize,
  worldBounds?: GridBounds,
  paddingTiles = 0
): ViewportBounds {
  assertValidCameraState(camera);
  assertValidViewport(viewport);
  if (!Number.isInteger(paddingTiles) || paddingTiles < 0) {
    throw new CameraError(`paddingTiles must be a non-negative integer, got ${paddingTiles}.`);
  }
  if (worldBounds) {
    assertValidWorldBounds(worldBounds);
  }

  const topLeft = screenToWorld(camera, { x: 0, y: 0 }, viewport);
  const bottomRight = screenToWorld(
    camera,
    { x: viewport.width, y: viewport.height },
    viewport
  );

  let minTileX = Math.floor(topLeft.x) - paddingTiles;
  let minTileY = Math.floor(topLeft.y) - paddingTiles;
  let maxTileX = Math.ceil(bottomRight.x) - 1 + paddingTiles;
  let maxTileY = Math.ceil(bottomRight.y) - 1 + paddingTiles;

  if (maxTileX < minTileX) {
    maxTileX = minTileX;
  }
  if (maxTileY < minTileY) {
    maxTileY = minTileY;
  }

  if (worldBounds) {
    if (
      maxTileX < 0 ||
      minTileX >= worldBounds.width ||
      maxTileY < 0 ||
      minTileY >= worldBounds.height
    ) {
      return EMPTY_VIEWPORT_BOUNDS;
    }

    minTileX = Math.max(0, minTileX);
    minTileY = Math.max(0, minTileY);
    maxTileX = Math.min(worldBounds.width - 1, maxTileX);
    maxTileY = Math.min(worldBounds.height - 1, maxTileY);
  }

  return {
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
  };
}

export function isTileVisible(tile: TileCoord, bounds: ViewportBounds): boolean {
  return (
    tile.x >= bounds.minTileX &&
    tile.x <= bounds.maxTileX &&
    tile.y >= bounds.minTileY &&
    tile.y <= bounds.maxTileY
  );
}

export function isFootprintVisible(
  position: TileCoord,
  footprint: EntityFootprint,
  bounds: ViewportBounds
): boolean {
  if (bounds.maxTileX < bounds.minTileX || bounds.maxTileY < bounds.minTileY) {
    return false;
  }
  const entMinX = position.x;
  const entMaxX = position.x + footprint.width - 1;
  const entMinY = position.y;
  const entMaxY = position.y + footprint.height - 1;

  return (
    entMaxX >= bounds.minTileX &&
    entMinX <= bounds.maxTileX &&
    entMaxY >= bounds.minTileY &&
    entMinY <= bounds.maxTileY
  );
}

// ============================================================================
// Stateful Camera Wrapper
// ============================================================================

export class Camera {
  private state: CameraState;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly worldBounds?: GridBounds;

  constructor(options: CameraOptions = {}) {
    this.minZoom = options.minZoom ?? MIN_CAMERA_ZOOM;
    this.maxZoom = options.maxZoom ?? MAX_CAMERA_ZOOM;
    this.worldBounds = options.worldBounds;
    this.state = createCameraState(options);
  }

  get x(): number {
    return this.state.x;
  }

  get y(): number {
    return this.state.y;
  }

  get zoom(): number {
    return this.state.zoom;
  }

  getState(): CameraState {
    return { ...this.state };
  }

  setState(next: CameraState): void {
    assertValidCameraState(next);
    const pos = clampToWorldBounds(next.x, next.y, this.worldBounds);
    this.state = {
      x: pos.x,
      y: pos.y,
      zoom: clamp(next.zoom, this.minZoom, this.maxZoom),
    };
  }

  pan(dxTiles: number, dyTiles: number): void {
    this.state = panCamera(this.state, dxTiles, dyTiles, this.worldBounds);
  }

  panByPixels(dxPixels: number, dyPixels: number): void {
    this.state = panCameraByPixels(this.state, dxPixels, dyPixels, this.worldBounds);
  }

  centerOn(target: WorldCoord): void {
    this.state = centerCameraOn(this.state, target, this.worldBounds);
  }

  zoomBy(factor: number): void {
    this.state = zoomCamera(this.state, factor, this.minZoom, this.maxZoom);
  }

  zoomAt(factor: number, anchorScreen: ScreenCoord, viewport: ViewportSize): void {
    this.state = zoomCameraAtPoint(
      this.state,
      factor,
      anchorScreen,
      viewport,
      this.minZoom,
      this.maxZoom,
      this.worldBounds
    );
  }

  worldToScreen(world: WorldCoord, viewport: ViewportSize): ScreenCoord {
    return worldToScreen(this.state, world, viewport);
  }

  tileToScreen(tile: TileCoord, viewport: ViewportSize): ScreenCoord {
    return tileToScreen(this.state, tile, viewport);
  }

  screenToWorld(screen: ScreenCoord, viewport: ViewportSize): WorldCoord {
    return screenToWorld(this.state, screen, viewport);
  }

  screenToTile(screen: ScreenCoord, viewport: ViewportSize): TileCoord {
    return screenToTile(this.state, screen, viewport);
  }

  screenToTileBounded(
    screen: ScreenCoord,
    viewport: ViewportSize,
    bounds?: GridBounds
  ): TileCoord | null {
    const effectiveBounds = bounds ?? this.worldBounds;
    if (!effectiveBounds) {
      throw new CameraError('worldBounds must be provided for screenToTileBounded.');
    }
    return screenToTileBounded(this.state, screen, viewport, effectiveBounds);
  }

  getVisibleTileBounds(viewport: ViewportSize, paddingTiles = 0): ViewportBounds {
    return getVisibleTileBounds(this.state, viewport, this.worldBounds, paddingTiles);
  }
}
