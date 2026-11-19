/**
 * Ironworks-16 Belt & Moving Lane Items Renderer (T39)
 *
 * Renders tick-synced animated conveyor belts, splitters, underground belts,
 * and moving lane items with viewport culling and seamless straight/curved
 * lane interpolation.
 *
 * Strictly deterministic: zero Math.random() or Date.now().
 * Headless-safe: works with mock CanvasRenderingContext2D in Node/Vitest.
 */

import {
  DIRECTION_VECTORS,
  SimulationError,
  clamp,
  rotateDirection,
  type BeltEntity,
  type CameraState,
  type Direction,
  type Entity,
  type SplitterEntity,
  type UndergroundBeltEntity,
  type WorldCoord,
  type WorldState,
} from '../types/contracts.js';
import {
  getVisibleTileBounds,
  isFootprintVisible,
  isTileVisible,
  tileToScreen,
  worldToScreen,
  type ViewportSize,
} from './camera.js';
import {
  BELT_FRAME_COUNT,
  getBeltSpriteKey,
  getEntitySpriteKey,
  getItemSpriteKey,
  type SpriteAtlas,
} from './spriteAtlas.js';

// ============================================================================
// Constants & Types
// ============================================================================

/**
 * Number of simulation ticks per belt animation frame.
 * Matches BELT_ITEM_SPACING / BELT_SPEED = 0.25 / 0.03125 = 8 ticks/frame
 * (32 ticks per full 4-frame cycle = 1 tile of item travel).
 */
export const DEFAULT_BELT_TICKS_PER_FRAME = 8;

/**
 * Lateral distance from the belt centerline to each lane center in tile units.
 */
export const BELT_LANE_LATERAL_OFFSET = 0.22;

/**
 * Default rendered item sprite size as a fraction of one tile's screen size.
 */
export const DEFAULT_BELT_ITEM_SCALE = 0.45;

export type BeltLaneSide = 'left' | 'right';

export interface BeltLayerRenderOptions {
  /** Simulation ticks per animation frame (default 8). */
  readonly ticksPerFrame?: number;
  /** Item sprite size relative to tile size (default 0.45). */
  readonly itemScale?: number;
  /** Extra tile padding around viewport for culling (default 0). */
  readonly paddingTiles?: number;
  /** Whether to draw lane items on top of belts (default true). */
  readonly drawItems?: boolean;
}

export interface BeltLayerRenderStats {
  readonly animationFrame: number;
  readonly beltsDrawn: number;
  readonly splittersDrawn: number;
  readonly undergroundBeltsDrawn: number;
  readonly itemsDrawn: number;
}

// ============================================================================
// Validation Helpers (Fail-Closed)
// ============================================================================

function assertValidTick(tick: number): void {
  if (!Number.isFinite(tick) || tick < 0) {
    throw new SimulationError(
      'INVALID_TICK',
      `Belt animation tick must be a non-negative finite number, got ${tick}.`
    );
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SimulationError(
      'INVALID_RENDER_OPTION',
      `${label} must be a positive finite number, got ${value}.`
    );
  }
}

// ============================================================================
// Tick-Synced Animation & Lane Geometry
// ============================================================================

/**
 * Computes the deterministic belt animation frame in [0, BELT_FRAME_COUNT - 1]
 * synchronized to the simulation tick.
 */
export function getBeltAnimationFrame(
  tick: number,
  ticksPerFrame = DEFAULT_BELT_TICKS_PER_FRAME
): number {
  assertValidTick(tick);
  assertPositiveFinite(ticksPerFrame, 'ticksPerFrame');
  const rawFrame = Math.floor(tick / ticksPerFrame);
  return ((rawFrame % BELT_FRAME_COUNT) + BELT_FRAME_COUNT) % BELT_FRAME_COUNT;
}

/**
 * Computes the world-space coordinate of an item on a straight or curved
 * conveyor belt tile.
 *
 * - Straight belts interpolate linearly from entry edge (offset 0) to exit
 *   edge (offset 1) offset laterally by ±BELT_LANE_LATERAL_OFFSET.
 * - Curved belts (`curve_left`, `curve_right`) interpolate along a smooth
 *   quarter-circle arc around the inner tile corner so items transition
 *   seamlessly from the perpendicular feeder lane into the exit lane.
 */
export function computeBeltItemWorldPosition(
  belt: Pick<BeltEntity, 'position' | 'direction' | 'shape'>,
  lane: BeltLaneSide,
  offset: number
): WorldCoord {
  const t = clamp(offset, 0, 1);
  const fwd = DIRECTION_VECTORS[belt.direction];
  const rightDir: Direction = rotateDirection(belt.direction, 1);
  const right = DIRECTION_VECTORS[rightDir];

  const cx = belt.position.x + 0.5;
  const cy = belt.position.y + 0.5;

  if (belt.shape === 'straight') {
    const along = t - 0.5;
    const lateral = lane === 'left' ? -BELT_LANE_LATERAL_OFFSET : BELT_LANE_LATERAL_OFFSET;
    return {
      x: cx + fwd.x * along + right.x * lateral,
      y: cy + fwd.y * along + right.y * lateral,
    };
  }

  const theta = t * (Math.PI / 2);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  if (belt.shape === 'curve_left') {
    // Pivot at front-left corner of the tile.
    const pivotX = cx + 0.5 * fwd.x - 0.5 * right.x;
    const pivotY = cy + 0.5 * fwd.y - 0.5 * right.y;
    const radius =
      lane === 'left'
        ? 0.5 - BELT_LANE_LATERAL_OFFSET
        : 0.5 + BELT_LANE_LATERAL_OFFSET;
    return {
      x: pivotX + (-fwd.x * cosT + right.x * sinT) * radius,
      y: pivotY + (-fwd.y * cosT + right.y * sinT) * radius,
    };
  }

  // curve_right: pivot at front-right corner of the tile.
  const pivotX = cx + 0.5 * fwd.x + 0.5 * right.x;
  const pivotY = cy + 0.5 * fwd.y + 0.5 * right.y;
  const radius =
    lane === 'right'
      ? 0.5 - BELT_LANE_LATERAL_OFFSET
      : 0.5 + BELT_LANE_LATERAL_OFFSET;
  return {
    x: pivotX + (-fwd.x * cosT - right.x * sinT) * radius,
    y: pivotY + (-fwd.y * cosT - right.y * sinT) * radius,
  };
}

/**
 * Computes the world-space coordinate of an item moving across a 2-tile-wide
 * splitter entity.
 */
export function computeSplitterItemWorldPosition(
  splitter: Pick<SplitterEntity, 'position' | 'direction' | 'footprint'>,
  lane: BeltLaneSide,
  offset: number
): WorldCoord {
  const t = clamp(offset, 0, 1);
  const fwd = DIRECTION_VECTORS[splitter.direction];
  const rightDir: Direction = rotateDirection(splitter.direction, 1);
  const right = DIRECTION_VECTORS[rightDir];

  const cx = splitter.position.x + splitter.footprint.width * 0.5;
  const cy = splitter.position.y + splitter.footprint.height * 0.5;
  const along = t - 0.5;
  const lateral = lane === 'left' ? -BELT_LANE_LATERAL_OFFSET : BELT_LANE_LATERAL_OFFSET;

  return {
    x: cx + fwd.x * along + right.x * lateral,
    y: cy + fwd.y * along + right.y * lateral,
  };
}

// ============================================================================
// Entity Sorting & Rendering
// ============================================================================

function compareEntitiesDeterministically(a: Entity, b: Entity): number {
  if (a.position.y !== b.position.y) return a.position.y - b.position.y;
  if (a.position.x !== b.position.x) return a.position.x - b.position.x;
  return a.id - b.id;
}

/**
 * Renders all visible conveyor belts, splitters, underground belts, and moving
 * lane items in two deterministic passes:
 *   1. Belt/splitter/underground sprites (tick-synced 4-frame animation)
 *   2. Moving lane items drawn on top of belts so items never clip under
 *      adjacent belt tiles.
 */
export function renderBeltLayer(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  atlas: SpriteAtlas,
  options: BeltLayerRenderOptions = {}
): BeltLayerRenderStats {
  const ticksPerFrame = options.ticksPerFrame ?? DEFAULT_BELT_TICKS_PER_FRAME;
  const itemScale = options.itemScale ?? DEFAULT_BELT_ITEM_SCALE;
  const paddingTiles = options.paddingTiles ?? 0;
  const drawItems = options.drawItems ?? true;

  assertPositiveFinite(itemScale, 'itemScale');
  const animationFrame = getBeltAnimationFrame(world.tick, ticksPerFrame);

  const visibleBounds = getVisibleTileBounds(
    camera,
    viewport,
    { width: world.width, height: world.height },
    paddingTiles
  );

  // Collect visible belt-family entities in deterministic order.
  const visibleBelts: BeltEntity[] = [];
  const visibleSplitters: SplitterEntity[] = [];
  const visibleUndergrounds: UndergroundBeltEntity[] = [];

  for (const entity of Object.values(world.entities)) {
    if (entity.type === 'transport_belt') {
      if (isTileVisible(entity.position, visibleBounds)) {
        visibleBelts.push(entity);
      }
    } else if (entity.type === 'splitter') {
      if (isFootprintVisible(entity.position, entity.footprint, visibleBounds)) {
        visibleSplitters.push(entity);
      }
    } else if (entity.type === 'underground_belt') {
      if (isTileVisible(entity.position, visibleBounds)) {
        visibleUndergrounds.push(entity);
      }
    }
  }

  visibleBelts.sort(compareEntitiesDeterministically);
  visibleSplitters.sort(compareEntitiesDeterministically);
  visibleUndergrounds.sort(compareEntitiesDeterministically);

  const tileSize = camera.zoom;

  // Pass 1: Draw animated belt tiles, splitters, and underground belt hoods.
  for (const belt of visibleBelts) {
    const screen = tileToScreen(camera, belt.position, viewport);
    const spriteKey = getBeltSpriteKey(belt.shape, belt.direction, animationFrame);
    atlas.draw(ctx, spriteKey, screen.x, screen.y, tileSize, tileSize);
  }

  for (const splitter of visibleSplitters) {
    const screen = tileToScreen(camera, splitter.position, viewport);
    const spriteKey = getEntitySpriteKey('splitter', false);
    atlas.draw(
      ctx,
      spriteKey,
      screen.x,
      screen.y,
      splitter.footprint.width * tileSize,
      splitter.footprint.height * tileSize
    );
  }

  for (const underground of visibleUndergrounds) {
    const screen = tileToScreen(camera, underground.position, viewport);
    const spriteKey = getEntitySpriteKey('underground_belt', false);
    atlas.draw(ctx, spriteKey, screen.x, screen.y, tileSize, tileSize);
  }

  // Pass 2: Draw moving lane items on top of belts and splitters.
  let itemsDrawn = 0;
  if (drawItems) {
    const itemSize = tileSize * itemScale;
    const halfItem = itemSize * 0.5;

    for (const belt of visibleBelts) {
      for (const laneSide of ['left', 'right'] as const) {
        const lane = laneSide === 'left' ? belt.leftLane : belt.rightLane;
        for (const item of lane.items) {
          const worldPos = computeBeltItemWorldPosition(belt, laneSide, item.offset);
          const screen = worldToScreen(camera, worldPos, viewport);
          atlas.draw(
            ctx,
            getItemSpriteKey(item.itemId),
            screen.x - halfItem,
            screen.y - halfItem,
            itemSize,
            itemSize
          );
          itemsDrawn++;
        }
      }
    }

    for (const splitter of visibleSplitters) {
      for (const laneSide of ['left', 'right'] as const) {
        const lane = laneSide === 'left' ? splitter.leftLane : splitter.rightLane;
        for (const item of lane.items) {
          const worldPos = computeSplitterItemWorldPosition(splitter, laneSide, item.offset);
          const screen = worldToScreen(camera, worldPos, viewport);
          atlas.draw(
            ctx,
            getItemSpriteKey(item.itemId),
            screen.x - halfItem,
            screen.y - halfItem,
            itemSize,
            itemSize
          );
          itemsDrawn++;
        }
      }
    }
  }

  return {
    animationFrame,
    beltsDrawn: visibleBelts.length,
    splittersDrawn: visibleSplitters.length,
    undergroundBeltsDrawn: visibleUndergrounds.length,
    itemsDrawn,
  };
}
