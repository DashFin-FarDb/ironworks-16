/**
 * Ironworks-16 Ghost Placement Preview Renderer (T42)
 *
 * Evaluates and renders a valid/blocked placement preview under the cursor,
 * supporting multi-tile footprints, terrain/occupancy/ore checks, power pole
 * supply radius preview, translucent sprite rendering, and directional arrows.
 *
 * Strictly deterministic: zero Math.random() or Date.now().
 * Headless-safe: works in Node/Vitest with mock CanvasRenderingContext2D.
 */

import {
  DIRECTIONS,
  DIRECTION_VECTORS,
  InvalidPlacementError,
  isWithinBounds,
  rotateDirection,
  type CameraState,
  type Direction,
  type EntityFootprint,
  type EntityType,
  type TileCoord,
  type WorldState,
} from '../types/contracts.js';
import {
  getEntityFootprint,
  getFootprintTiles,
  isValidEntityType,
} from '../core/entityManager.js';
import {
  getVisibleTileBounds,
  isFootprintVisible,
  screenToTile,
  tileToScreen,
  type ScreenCoord,
  type ViewportSize,
} from './camera.js';
import {
  getBeltSpriteKey,
  getEntitySpriteKey,
  type SpriteAtlas,
} from './spriteAtlas.js';

// ============================================================================
// Constants & Types
// ============================================================================

export const POWER_POLE_SUPPLY_RADIUS = 5;

export type GhostPlacementReason =
  | 'valid'
  | 'out_of_bounds'
  | 'water'
  | 'occupied'
  | 'requires_ore';

export interface GhostTileEvaluation {
  readonly coord: TileCoord;
  readonly valid: boolean;
  readonly reason: GhostPlacementReason;
}

export interface GhostPreviewState {
  readonly entityType: EntityType;
  readonly position: TileCoord;
  readonly direction: Direction;
  readonly footprint: EntityFootprint;
  readonly valid: boolean;
  readonly reason: GhostPlacementReason;
  readonly tiles: readonly GhostTileEvaluation[];
  /** Supply radius in tiles for power poles, otherwise null. */
  readonly supplyRadius: number | null;
}

export interface GhostRenderOptions {
  readonly atlas?: SpriteAtlas;
  readonly tick?: number;
  readonly validTint?: string;
  readonly blockedTint?: string;
  readonly validBorder?: string;
  readonly blockedBorder?: string;
  readonly spriteAlpha?: number;
  readonly showDirectionArrow?: boolean;
  readonly showPowerRadius?: boolean;
  readonly powerRadiusFill?: string;
  readonly powerRadiusBorder?: string;
}

const DEFAULT_RENDER_OPTIONS = {
  validTint: 'rgba(64, 224, 96, 0.35)',
  blockedTint: 'rgba(239, 68, 68, 0.42)',
  validBorder: 'rgba(34, 197, 94, 0.95)',
  blockedBorder: 'rgba(239, 68, 68, 0.95)',
  spriteAlpha: 0.65,
  showDirectionArrow: true,
  showPowerRadius: true,
  powerRadiusFill: 'rgba(56, 189, 248, 0.14)',
  powerRadiusBorder: 'rgba(56, 189, 248, 0.55)',
} as const;

const DIRECTIONAL_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'transport_belt',
  'splitter',
  'underground_belt',
  'inserter',
  'filter_inserter',
  'burner_drill',
  'electric_drill',
]);

const DRILL_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'burner_drill',
  'electric_drill',
]);

// ============================================================================
// Pure Placement Evaluation
// ============================================================================

/**
 * Evaluates whether `entityType` can be placed at `position` with `direction`
 * in the given `world`, returning per-tile and aggregate validity.
 *
 * Fail-closed: throws `InvalidPlacementError` on unknown entity type,
 * invalid direction, or non-integer coordinates.
 */
export function evaluateGhostPlacement(
  world: WorldState,
  entityType: EntityType,
  position: TileCoord,
  direction: Direction = 'N'
): GhostPreviewState {
  if (!isValidEntityType(entityType)) {
    throw new InvalidPlacementError(
      entityType,
      position,
      `Unknown entity type "${String(entityType)}".`
    );
  }
  if (!DIRECTIONS.includes(direction)) {
    throw new InvalidPlacementError(
      entityType,
      position,
      `Invalid direction "${String(direction)}".`
    );
  }
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new InvalidPlacementError(
      entityType,
      position,
      `Position must have integer coordinates, got (${position.x}, ${position.y}).`
    );
  }

  const footprint = getEntityFootprint(entityType);
  const footprintCoords = getFootprintTiles(position, footprint);
  const bounds = { width: world.width, height: world.height };
  const requiresOre = DRILL_ENTITY_TYPES.has(entityType);

  const tiles: GhostTileEvaluation[] = [];
  let firstBlockingReason: GhostPlacementReason | null = null;

  for (const coord of footprintCoords) {
    let reason: GhostPlacementReason = 'valid';

    if (!isWithinBounds(coord, bounds)) {
      reason = 'out_of_bounds';
    } else {
      const tile = world.tiles[coord.y * world.width + coord.x];
      if (!tile) {
        reason = 'out_of_bounds';
      } else if (tile.terrain === 'water') {
        reason = 'water';
      } else if (tile.entityId !== null) {
        reason = 'occupied';
      } else if (requiresOre && (!tile.resource || tile.resource.amount <= 0)) {
        reason = 'requires_ore';
      }
    }

    const tileValid = reason === 'valid';
    if (!tileValid && firstBlockingReason === null) {
      firstBlockingReason = reason;
    }

    tiles.push({
      coord,
      valid: tileValid,
      reason,
    });
  }

  return {
    entityType,
    position: { x: position.x, y: position.y },
    direction,
    footprint,
    valid: firstBlockingReason === null,
    reason: firstBlockingReason ?? 'valid',
    tiles,
    supplyRadius: entityType === 'power_pole' ? POWER_POLE_SUPPLY_RADIUS : null,
  };
}

/**
 * Converts a screen-space cursor position to a tile coordinate via the camera
 * and evaluates ghost placement at that tile.
 */
export function evaluateGhostAtScreenPos(
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  screenPos: ScreenCoord,
  entityType: EntityType,
  direction: Direction = 'N'
): GhostPreviewState {
  const tileCoord = screenToTile(camera, screenPos, viewport);
  return evaluateGhostPlacement(world, entityType, tileCoord, direction);
}

// ============================================================================
// Canvas 2D Rendering
// ============================================================================

function drawDirectionArrow(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  direction: Direction,
  color: string
): void {
  const vec = DIRECTION_VECTORS[direction];
  const half = size * 0.28;
  const tipX = centerX + vec.x * half;
  const tipY = centerY + vec.y * half;
  const baseX = centerX - vec.x * half * 0.6;
  const baseY = centerY - vec.y * half * 0.6;
  const perpX = -vec.y * half * 0.65;
  const perpY = vec.x * half * 0.65;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + perpX, baseY + perpY);
  ctx.lineTo(baseX - perpX, baseY - perpY);
  ctx.closePath();
  ctx.fill();
}

/**
 * Renders a `GhostPreviewState` onto a 2D canvas context.
 * Returns `true` if rendered, or `false` if culled outside the viewport.
 */
export function renderGhostPreview(
  ctx: CanvasRenderingContext2D,
  preview: GhostPreviewState,
  camera: CameraState,
  viewport: ViewportSize,
  options: GhostRenderOptions = {}
): boolean {
  const visibleBounds = getVisibleTileBounds(camera, viewport);
  const footprintVisible = isFootprintVisible(
    preview.position,
    preview.footprint,
    visibleBounds
  );

  const showPowerRadius =
    (options.showPowerRadius ?? DEFAULT_RENDER_OPTIONS.showPowerRadius) &&
    preview.supplyRadius !== null;

  let radiusVisible = false;
  if (showPowerRadius && preview.supplyRadius !== null) {
    const r = preview.supplyRadius;
    radiusVisible = isFootprintVisible(
      { x: preview.position.x - r, y: preview.position.y - r },
      { width: r * 2 + 1, height: r * 2 + 1 },
      visibleBounds
    );
  }

  if (!footprintVisible && !radiusVisible) {
    return false;
  }

  const validTint = options.validTint ?? DEFAULT_RENDER_OPTIONS.validTint;
  const blockedTint = options.blockedTint ?? DEFAULT_RENDER_OPTIONS.blockedTint;
  const validBorder = options.validBorder ?? DEFAULT_RENDER_OPTIONS.validBorder;
  const blockedBorder = options.blockedBorder ?? DEFAULT_RENDER_OPTIONS.blockedBorder;
  const spriteAlpha = options.spriteAlpha ?? DEFAULT_RENDER_OPTIONS.spriteAlpha;
  const showDirectionArrow =
    options.showDirectionArrow ?? DEFAULT_RENDER_OPTIONS.showDirectionArrow;
  const powerRadiusFill =
    options.powerRadiusFill ?? DEFAULT_RENDER_OPTIONS.powerRadiusFill;
  const powerRadiusBorder =
    options.powerRadiusBorder ?? DEFAULT_RENDER_OPTIONS.powerRadiusBorder;

  const tileSize = camera.zoom;

  ctx.save();
  try {
    // 1. Optional power pole supply radius preview
    if (showPowerRadius && preview.supplyRadius !== null) {
      const r = preview.supplyRadius;
      const topLeft = tileToScreen(
        camera,
        { x: preview.position.x - r, y: preview.position.y - r },
        viewport
      );
      const span = (r * 2 + 1) * tileSize;
      ctx.fillStyle = powerRadiusFill;
      ctx.fillRect(topLeft.x, topLeft.y, span, span);
      ctx.strokeStyle = powerRadiusBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, span - 1, span - 1);
    }

    if (footprintVisible) {
      const originScreen = tileToScreen(camera, preview.position, viewport);
      const totalW = preview.footprint.width * tileSize;
      const totalH = preview.footprint.height * tileSize;

      // 2. Optional translucent sprite from SpriteAtlas
      if (options.atlas) {
        const spriteKey =
          preview.entityType === 'transport_belt'
            ? getBeltSpriteKey('straight', preview.direction, Math.floor((options.tick ?? 0) / 4))
            : getEntitySpriteKey(preview.entityType, false);

        if (options.atlas.hasSprite(spriteKey)) {
          ctx.globalAlpha = spriteAlpha;
          options.atlas.draw(ctx, spriteKey, originScreen.x, originScreen.y, totalW, totalH);
          ctx.globalAlpha = 1;
        }
      }

      // 3. Per-tile valid/blocked tint overlay
      for (const tileEval of preview.tiles) {
        const tileScreen = tileToScreen(camera, tileEval.coord, viewport);
        ctx.fillStyle = tileEval.valid ? validTint : blockedTint;
        ctx.fillRect(tileScreen.x, tileScreen.y, tileSize, tileSize);
      }

      // 4. Outer footprint border
      ctx.strokeStyle = preview.valid ? validBorder : blockedBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(originScreen.x + 1, originScreen.y + 1, totalW - 2, totalH - 2);

      // 5. Directional arrow indicator for directional entities
      if (showDirectionArrow && DIRECTIONAL_ENTITY_TYPES.has(preview.entityType)) {
        drawDirectionArrow(
          ctx,
          originScreen.x + totalW / 2,
          originScreen.y + totalH / 2,
          tileSize,
          preview.direction,
          preview.valid ? validBorder : blockedBorder
        );
      }
    }
  } finally {
    ctx.restore();
  }

  return true;
}

// ============================================================================
// Stateful Ghost Preview Controller (for T47 Input Integration)
// ============================================================================

export class GhostPreviewController {
  private selectedEntityType: EntityType | null = null;
  private direction: Direction = 'N';
  private cursorTile: TileCoord | null = null;

  select(entityType: EntityType): void {
    if (!isValidEntityType(entityType)) {
      throw new InvalidPlacementError(
        entityType,
        this.cursorTile ?? { x: 0, y: 0 },
        `Unknown entity type "${String(entityType)}".`
      );
    }
    this.selectedEntityType = entityType;
  }

  clear(): void {
    this.selectedEntityType = null;
  }

  getSelectedEntityType(): EntityType | null {
    return this.selectedEntityType;
  }

  getDirection(): Direction {
    return this.direction;
  }

  setDirection(direction: Direction): void {
    if (!DIRECTIONS.includes(direction)) {
      throw new InvalidPlacementError(
        this.selectedEntityType ?? 'transport_belt',
        this.cursorTile ?? { x: 0, y: 0 },
        `Invalid direction "${String(direction)}".`
      );
    }
    this.direction = direction;
  }

  rotate(stepsClockwise = 1): Direction {
    this.direction = rotateDirection(this.direction, stepsClockwise);
    return this.direction;
  }

  setCursorTile(coord: TileCoord | null): void {
    this.cursorTile = coord ? { x: coord.x, y: coord.y } : null;
  }

  setCursorScreen(
    screenPos: ScreenCoord,
    camera: CameraState,
    viewport: ViewportSize
  ): TileCoord {
    const tile = screenToTile(camera, screenPos, viewport);
    this.cursorTile = tile;
    return tile;
  }

  getCursorTile(): TileCoord | null {
    return this.cursorTile ? { x: this.cursorTile.x, y: this.cursorTile.y } : null;
  }

  evaluate(world: WorldState): GhostPreviewState | null {
    if (!this.selectedEntityType || !this.cursorTile) {
      return null;
    }
    return evaluateGhostPlacement(
      world,
      this.selectedEntityType,
      this.cursorTile,
      this.direction
    );
  }

  render(
    ctx: CanvasRenderingContext2D,
    world: WorldState,
    camera: CameraState,
    viewport: ViewportSize,
    options?: GhostRenderOptions
  ): GhostPreviewState | null {
    const preview = this.evaluate(world);
    if (!preview) {
      return null;
    }
    renderGhostPreview(ctx, preview, camera, viewport, options);
    return preview;
  }
}
