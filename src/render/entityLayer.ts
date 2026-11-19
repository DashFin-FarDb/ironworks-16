/**
 * Ironworks-16 Entity Layer Renderer (T40)
 *
 * Renders machines with active/idle status indicators, deterministic
 * tick-synced furnace glow, passive structures (chests, poles, etc.),
 * and rotating inserter arms with held items.
 *
 * Strictly deterministic: zero Math.random() or Date.now().
 * Headless-safe: works with both browser CanvasRenderingContext2D and
 * mock 2D contexts in Node/Vitest.
 */

import {
  SimulationError,
  type CameraState,
  type Entity,
  type EntityId,
  type EntityType,
  type FilterInserterEntity,
  type InserterEntity,
  type WorldState,
} from '../types/contracts.js';
import {
  getVisibleTileBounds,
  isFootprintVisible,
  tileToScreen,
  type ViewportSize,
} from './camera.js';
import {
  getEntitySpriteKey,
  getInserterPartSpriteKey,
  getItemSpriteKey,
  type SpriteAtlas,
} from './spriteAtlas.js';

// ============================================================================
// Constants & Types
// ============================================================================

export const MACHINE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
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

export const FURNACE_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'stone_furnace',
  'electric_furnace',
]);

export const INSERTER_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'inserter',
  'filter_inserter',
]);

export const INDICATOR_ACTIVE_COLOR = '#3ddc84';
export const INDICATOR_IDLE_COLOR = '#f0ad4e';
export const INDICATOR_BORDER_COLOR = '#1a1a1a';

export const FURNACE_GLOW_MIN_ALPHA = 0.2;
export const FURNACE_GLOW_MAX_ALPHA = 0.5;
export const INSERTER_ARM_REACH_TILES = 0.4;
export const INSERTER_HELD_ITEM_SCALE = 0.45;

export class EntityLayerError extends SimulationError {
  constructor(message: string) {
    super('ENTITY_LAYER_ERROR', message);
    this.name = 'EntityLayerError';
  }
}

export interface EntityLayerRenderOptions {
  /** Skip transport_belt entities (rendered by beltLayer.ts). Default: true. */
  readonly skipTransportBelts?: boolean;
  /** Also skip splitter and underground_belt entities. Default: false. */
  readonly skipAllBeltLogistics?: boolean;
  /** Draw active/idle LED indicators on machines. Default: true. */
  readonly showStatusIndicators?: boolean;
  /** Draw pulsing warm glow overlay on active furnaces. Default: true. */
  readonly showFurnaceGlow?: boolean;
  /** Extra tile padding around viewport for culling. Default: 1. */
  readonly paddingTiles?: number;
}

export interface EntityLayerRenderStats {
  readonly entitiesRendered: number;
  readonly machinesRendered: number;
  readonly insertersRendered: number;
  readonly furnaceGlowsRendered: number;
  readonly heldItemsRendered: number;
  readonly culledCount: number;
}

// ============================================================================
// Pure Helper Functions
// ============================================================================

export function isMachineEntity(entity: Entity): boolean {
  return MACHINE_ENTITY_TYPES.has(entity.type);
}

export function isFurnaceEntity(entity: Entity): boolean {
  return FURNACE_ENTITY_TYPES.has(entity.type);
}

export function isInserterEntity(
  entity: Entity
): entity is InserterEntity | FilterInserterEntity {
  return INSERTER_ENTITY_TYPES.has(entity.type);
}

/**
 * Resolves the sprite key for an entity, preferring the `:active` variant
 * when `entity.active` is true and the atlas defines one.
 */
export function resolveEntitySpriteKey(atlas: SpriteAtlas, entity: Entity): string {
  if (entity.active) {
    const activeKey = getEntitySpriteKey(entity.type, true);
    if (atlas.hasSprite(activeKey)) {
      return activeKey;
    }
  }
  return getEntitySpriteKey(entity.type, false);
}

/**
 * Computes a deterministic, tick-synced glow alpha in [0.2, 0.5] for an
 * active furnace, phase-shifted by entity ID so adjacent furnaces pulse
 * organically without any randomness.
 */
export function computeFurnaceGlowAlpha(tick: number, entityId: EntityId): number {
  if (!Number.isFinite(tick)) {
    throw new EntityLayerError(`World tick must be finite, got ${tick}.`);
  }
  const wave = 0.5 + 0.5 * Math.sin(tick * 0.2 + entityId * 0.7);
  return FURNACE_GLOW_MIN_ALPHA + wave * (FURNACE_GLOW_MAX_ALPHA - FURNACE_GLOW_MIN_ALPHA);
}

/**
 * Converts a simulation inserter armAngle (E=0, S=π/2, W=π, N=-π/2) into
 * the Canvas 2D rotation needed for the North-pointing arm sprite.
 */
export function computeInserterArmRotation(armAngle: number): number {
  if (!Number.isFinite(armAngle)) {
    throw new EntityLayerError(`Inserter armAngle must be finite, got ${armAngle}.`);
  }
  return armAngle + Math.PI / 2;
}

/**
 * Computes the screen-space position of an inserter arm's claw tip.
 */
export function computeInserterTipScreenPos(
  centerX: number,
  centerY: number,
  armAngle: number,
  zoom: number
): { x: number; y: number } {
  if (!Number.isFinite(armAngle)) {
    throw new EntityLayerError(`Inserter armAngle must be finite, got ${armAngle}.`);
  }
  const reachPx = zoom * INSERTER_ARM_REACH_TILES;
  return {
    x: centerX + Math.cos(armAngle) * reachPx,
    y: centerY + Math.sin(armAngle) * reachPx,
  };
}

/**
 * Returns the LED indicator fill color for a machine's active/idle state.
 */
export function getMachineIndicatorColor(active: boolean): string {
  return active ? INDICATOR_ACTIVE_COLOR : INDICATOR_IDLE_COLOR;
}

function compareEntitiesDeterministically(a: Entity, b: Entity): number {
  if (a.position.y !== b.position.y) return a.position.y - b.position.y;
  if (a.position.x !== b.position.x) return a.position.x - b.position.x;
  return a.id - b.id;
}

function shouldSkipEntity(entity: Entity, options: EntityLayerRenderOptions): boolean {
  const skipTransportBelts = options.skipTransportBelts ?? true;
  const skipAllBeltLogistics = options.skipAllBeltLogistics ?? false;

  if (skipTransportBelts && entity.type === 'transport_belt') {
    return true;
  }
  if (
    skipAllBeltLogistics &&
    (entity.type === 'transport_belt' ||
      entity.type === 'splitter' ||
      entity.type === 'underground_belt')
  ) {
    return true;
  }
  return false;
}

// ============================================================================
// Sub-Renderers
// ============================================================================

function drawFurnaceGlow(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  screenX: number,
  screenY: number,
  widthPx: number,
  heightPx: number,
  tick: number
): void {
  const alpha = computeFurnaceGlowAlpha(tick, entity.id);
  const cx = screenX + widthPx * 0.5;
  const cy = screenY + heightPx * 0.6;
  const outerRadius = Math.min(widthPx, heightPx) * 0.42;
  const innerRadius = outerRadius * 0.55;

  const outerColor =
    entity.type === 'electric_furnace'
      ? `rgba(255,170,48,${alpha.toFixed(3)})`
      : `rgba(255,120,20,${alpha.toFixed(3)})`;
  const innerColor = `rgba(255,230,120,${Math.min(1, alpha * 1.25).toFixed(3)})`;

  ctx.save();
  ctx.fillStyle = outerColor;
  ctx.beginPath();
  ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = innerColor;
  ctx.beginPath();
  ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMachineIndicator(
  ctx: CanvasRenderingContext2D,
  active: boolean,
  screenX: number,
  screenY: number,
  widthPx: number,
  zoom: number
): void {
  const radius = Math.max(2, Math.min(4.5, zoom * 0.11));
  const margin = Math.max(2, zoom * 0.14);
  const cx = screenX + widthPx - margin;
  const cy = screenY + margin;

  ctx.save();
  ctx.fillStyle = INDICATOR_BORDER_COLOR;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 1, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = getMachineIndicatorColor(active);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawInserter(
  ctx: CanvasRenderingContext2D,
  entity: InserterEntity | FilterInserterEntity,
  screenX: number,
  screenY: number,
  widthPx: number,
  heightPx: number,
  zoom: number,
  atlas: SpriteAtlas
): boolean {
  const isFilter = entity.type === 'filter_inserter';
  const baseKey = getInserterPartSpriteKey(isFilter, 'base');
  const armKey = getInserterPartSpriteKey(isFilter, 'arm');

  // 1. Draw stationary base
  atlas.draw(ctx, baseKey, screenX, screenY, widthPx, heightPx);

  // 2. Draw rotating arm around tile center
  const cx = screenX + widthPx * 0.5;
  const cy = screenY + heightPx * 0.5;
  const rotation = computeInserterArmRotation(entity.armAngle);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  atlas.draw(ctx, armKey, -widthPx * 0.5, -heightPx * 0.5, widthPx, heightPx);
  ctx.restore();

  // 3. Draw held item at the tip of the arm if carrying one
  if (entity.heldItem !== null) {
    const tip = computeInserterTipScreenPos(cx, cy, entity.armAngle, zoom);
    const itemSize = zoom * INSERTER_HELD_ITEM_SCALE;
    const itemKey = getItemSpriteKey(entity.heldItem);
    atlas.draw(ctx, itemKey, tip.x - itemSize * 0.5, tip.y - itemSize * 0.5, itemSize, itemSize);
    return true;
  }

  return false;
}

// ============================================================================
// Main Layer Renderer
// ============================================================================

/**
 * Renders all visible non-belt entities onto the 2D canvas context in
 * deterministic order:
 *   Pass 1: Machines and passive structures (sorted by y, x, id)
 *           with furnace glow overlays and active/idle status indicators.
 *   Pass 2: Inserters and filter inserters (sorted by y, x, id)
 *           with rotating arms and held items drawn above adjacent machines.
 */
export function renderEntityLayer(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  atlas: SpriteAtlas,
  options: EntityLayerRenderOptions = {}
): EntityLayerRenderStats {
  if (!Number.isFinite(world.tick)) {
    throw new EntityLayerError(`World tick must be finite, got ${world.tick}.`);
  }

  const showStatusIndicators = options.showStatusIndicators ?? true;
  const showFurnaceGlow = options.showFurnaceGlow ?? true;
  const paddingTiles = options.paddingTiles ?? 1;

  const visibleBounds = getVisibleTileBounds(
    camera,
    viewport,
    { width: world.width, height: world.height },
    paddingTiles
  );

  const structures: Entity[] = [];
  const inserters: (InserterEntity | FilterInserterEntity)[] = [];
  let culledCount = 0;

  for (const entity of Object.values(world.entities)) {
    if (shouldSkipEntity(entity, options)) {
      continue;
    }
    if (!isFootprintVisible(entity.position, entity.footprint, visibleBounds)) {
      culledCount++;
      continue;
    }
    if (isInserterEntity(entity)) {
      inserters.push(entity);
    } else {
      structures.push(entity);
    }
  }

  structures.sort(compareEntitiesDeterministically);
  inserters.sort(compareEntitiesDeterministically);

  let machinesRendered = 0;
  let furnaceGlowsRendered = 0;
  let heldItemsRendered = 0;

  // Pass 1: Machines & passive structures
  for (const entity of structures) {
    const topLeft = tileToScreen(camera, entity.position, viewport);
    const widthPx = entity.footprint.width * camera.zoom;
    const heightPx = entity.footprint.height * camera.zoom;

    const spriteKey = resolveEntitySpriteKey(atlas, entity);
    atlas.draw(ctx, spriteKey, topLeft.x, topLeft.y, widthPx, heightPx);

    if (showFurnaceGlow && isFurnaceEntity(entity) && entity.active) {
      drawFurnaceGlow(ctx, entity, topLeft.x, topLeft.y, widthPx, heightPx, world.tick);
      furnaceGlowsRendered++;
    }

    if (isMachineEntity(entity)) {
      machinesRendered++;
      if (showStatusIndicators) {
        drawMachineIndicator(ctx, entity.active, topLeft.x, topLeft.y, widthPx, camera.zoom);
      }
    }
  }

  // Pass 2: Inserters (drawn on top so rotating arms reach cleanly over machines)
  for (const inserter of inserters) {
    const topLeft = tileToScreen(camera, inserter.position, viewport);
    const widthPx = inserter.footprint.width * camera.zoom;
    const heightPx = inserter.footprint.height * camera.zoom;

    const drewHeldItem = drawInserter(
      ctx,
      inserter,
      topLeft.x,
      topLeft.y,
      widthPx,
      heightPx,
      camera.zoom,
      atlas
    );
    if (drewHeldItem) {
      heldItemsRendered++;
    }
  }

  return {
    entitiesRendered: structures.length + inserters.length,
    machinesRendered,
    insertersRendered: inserters.length,
    furnaceGlowsRendered,
    heldItemsRendered,
    culledCount,
  };
}

/**
 * Stateful convenience wrapper around `renderEntityLayer`.
 */
export class EntityLayer {
  private readonly atlas: SpriteAtlas;
  private readonly defaultOptions: EntityLayerRenderOptions;

  constructor(atlas: SpriteAtlas, defaultOptions: EntityLayerRenderOptions = {}) {
    this.atlas = atlas;
    this.defaultOptions = defaultOptions;
  }

  render(
    ctx: CanvasRenderingContext2D,
    world: WorldState,
    camera: CameraState,
    viewport: ViewportSize,
    options?: EntityLayerRenderOptions
  ): EntityLayerRenderStats {
    return renderEntityLayer(ctx, world, camera, viewport, this.atlas, {
      ...this.defaultOptions,
      ...options,
    });
  }
}
