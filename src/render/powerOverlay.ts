/**
 * Ironworks-16 Power Overlay Renderer (T41)
 *
 * Renders toggleable power grid visuals on HTML5 Canvas 2D:
 *   1. Power wires between connected poles (with catenary sag & network health tinting)
 *   2. Square Chebyshev supply coverage areas around each power pole
 *   3. Unpowered / low-power warning icons on electric consumers
 *
 * Strictly deterministic: animations use `world.tick` only (never `Date.now()`).
 * Headless-testable: accepts any Canvas2D-compatible `PowerOverlayContext`.
 */

import {
  type CameraState,
  type Entity,
  type EntityId,
  type PowerNetworkId,
  type PowerPoleEntity,
  type ViewportBounds,
  type WorldState,
  clamp,
} from '../types/contracts.js';
import {
  getEntityPowerNetwork,
  getWireConnections,
  isPowerConsumer,
  isPowerPole,
} from '../logistics/powerGrid.js';
import { getEntityPowerSatisfaction } from '../logistics/powerSolver.js';
import {
  type ScreenCoord,
  type ViewportSize,
  getVisibleTileBounds,
  isFootprintVisible,
  worldToScreen,
} from './camera.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Minimal subset of CanvasRenderingContext2D required by the power overlay.
 * Allows headless unit testing in Node/Vitest without a DOM.
 */
export interface PowerOverlayContext {
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number
  ): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fill(): void;
  stroke(): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
}

export type PowerHealthStatus = 'healthy' | 'brownout' | 'blackout';

export type PowerWarningReason = 'unconnected' | 'blackout' | 'brownout';

export interface PowerOverlayConfig {
  enabled: boolean;
  showWires: boolean;
  showCoverage: boolean;
  showUnpoweredWarnings: boolean;
}

export interface PowerWireRenderItem {
  readonly fromId: EntityId;
  readonly toId: EntityId;
  readonly fromScreen: ScreenCoord;
  readonly toScreen: ScreenCoord;
  readonly controlScreen: ScreenCoord;
  readonly networkId: PowerNetworkId | null;
  readonly health: PowerHealthStatus;
}

export interface CoverageSquareRenderItem {
  readonly poleId: EntityId;
  readonly networkId: PowerNetworkId | null;
  readonly minTileX: number;
  readonly minTileY: number;
  readonly maxTileX: number;
  readonly maxTileY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly health: PowerHealthStatus;
}

export interface UnpoweredWarningRenderItem {
  readonly entityId: EntityId;
  readonly screenCenter: ScreenCoord;
  readonly radius: number;
  readonly reason: PowerWarningReason;
  readonly satisfaction: number;
  readonly alpha: number;
}

export interface PowerOverlayRenderStats {
  readonly rendered: boolean;
  readonly wiresDrawn: number;
  readonly coverageRectsDrawn: number;
  readonly warningsDrawn: number;
}

// ============================================================================
// Constants & Palette
// ============================================================================

export const DEFAULT_POWER_OVERLAY_CONFIG: Readonly<PowerOverlayConfig> = {
  enabled: false,
  showWires: true,
  showCoverage: true,
  showUnpoweredWarnings: true,
};

/** Vertical anchor offset within a 1x1 pole tile for wire attachment. */
const POLE_WIRE_ANCHOR_Y = 0.25;

/** Blink cycle period in simulation ticks (at 60 ticks/sec = 0.8s). */
const WARNING_PULSE_PERIOD_TICKS = 48;

const WIRE_COLORS: Readonly<Record<PowerHealthStatus, string>> = {
  healthy: '#e8a848',
  brownout: '#f0c030',
  blackout: '#d84848',
};

const COVERAGE_FILL_COLORS: Readonly<Record<PowerHealthStatus, string>> = {
  healthy: 'rgba(64, 180, 255, 0.16)',
  brownout: 'rgba(240, 192, 48, 0.16)',
  blackout: 'rgba(216, 72, 72, 0.16)',
};

const COVERAGE_STROKE_COLORS: Readonly<Record<PowerHealthStatus, string>> = {
  healthy: 'rgba(80, 210, 255, 0.55)',
  brownout: 'rgba(240, 192, 48, 0.60)',
  blackout: 'rgba(216, 72, 72, 0.60)',
};

const WARNING_BADGE_COLORS: Readonly<Record<PowerWarningReason, string>> = {
  unconnected: '#e03030',
  blackout: '#e03030',
  brownout: '#d88820',
};

const WARNING_BOLT_COLOR = '#ffe040';
const WARNING_BORDER_COLOR = '#1a1a1a';

// ============================================================================
// Pure Helpers
// ============================================================================

export function createPowerOverlayConfig(
  overrides: Partial<PowerOverlayConfig> = {}
): PowerOverlayConfig {
  return {
    enabled: overrides.enabled ?? DEFAULT_POWER_OVERLAY_CONFIG.enabled,
    showWires: overrides.showWires ?? DEFAULT_POWER_OVERLAY_CONFIG.showWires,
    showCoverage: overrides.showCoverage ?? DEFAULT_POWER_OVERLAY_CONFIG.showCoverage,
    showUnpoweredWarnings:
      overrides.showUnpoweredWarnings ??
      DEFAULT_POWER_OVERLAY_CONFIG.showUnpoweredWarnings,
  };
}

export function getNetworkHealthStatus(
  world: WorldState,
  networkId: PowerNetworkId | null
): PowerHealthStatus {
  if (networkId === null) {
    return 'healthy';
  }
  const network = world.powerGrid.networks[networkId];
  if (!network) {
    return 'healthy';
  }
  if (network.totalDemandKw > 0 && network.satisfaction <= 0) {
    return 'blackout';
  }
  if (network.totalDemandKw > 0 && network.satisfaction < 0.999) {
    return 'brownout';
  }
  return 'healthy';
}

/**
 * Deterministic triangle-wave alpha in [0.55, 1.0] driven solely by `tick`.
 */
export function computeWarningPulseAlpha(tick: number): number {
  const safeTick = Number.isFinite(tick) ? Math.max(0, Math.floor(tick)) : 0;
  const phase = (safeTick % WARNING_PULSE_PERIOD_TICKS) / WARNING_PULSE_PERIOD_TICKS;
  const triangle = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  return 0.55 + triangle * 0.45;
}

function getSortedEntities(world: WorldState): Entity[] {
  return Object.values(world.entities).sort((a, b) => a.id - b.id);
}

function isRectIntersectingBounds(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  bounds: ViewportBounds
): boolean {
  if (bounds.maxTileX < bounds.minTileX || bounds.maxTileY < bounds.minTileY) {
    return false;
  }
  return (
    maxX >= bounds.minTileX &&
    minX <= bounds.maxTileX &&
    maxY >= bounds.minTileY &&
    minY <= bounds.maxTileY
  );
}

// ============================================================================
// Pure Geometry Computation (Headless-Testable)
// ============================================================================

export function computeCoverageSquares(
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  visibleBounds?: ViewportBounds
): CoverageSquareRenderItem[] {
  const bounds =
    visibleBounds ??
    getVisibleTileBounds(camera, viewport, {
      width: world.width,
      height: world.height,
    });

  const results: CoverageSquareRenderItem[] = [];
  const entities = getSortedEntities(world);

  for (const entity of entities) {
    if (!isPowerPole(entity)) {
      continue;
    }
    const radius = Math.max(0, Math.floor(entity.supplyRadius));
    const minTileX = Math.max(0, entity.position.x - radius);
    const minTileY = Math.max(0, entity.position.y - radius);
    const maxTileX = Math.min(world.width - 1, entity.position.x + radius);
    const maxTileY = Math.min(world.height - 1, entity.position.y + radius);

    if (!isRectIntersectingBounds(minTileX, minTileY, maxTileX, maxTileY, bounds)) {
      continue;
    }

    const topLeft = worldToScreen(camera, { x: minTileX, y: minTileY }, viewport);
    const bottomRight = worldToScreen(
      camera,
      { x: maxTileX + 1, y: maxTileY + 1 },
      viewport
    );

    results.push({
      poleId: entity.id,
      networkId: entity.powerNetworkId,
      minTileX,
      minTileY,
      maxTileX,
      maxTileY,
      screenX: topLeft.x,
      screenY: topLeft.y,
      screenWidth: bottomRight.x - topLeft.x,
      screenHeight: bottomRight.y - topLeft.y,
      health: getNetworkHealthStatus(world, entity.powerNetworkId),
    });
  }

  return results;
}

export function computePowerWires(
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  visibleBounds?: ViewportBounds
): PowerWireRenderItem[] {
  const bounds =
    visibleBounds ??
    getVisibleTileBounds(camera, viewport, {
      width: world.width,
      height: world.height,
    });

  const connections = getWireConnections(world.entities);
  const results: PowerWireRenderItem[] = [];

  for (const edge of connections) {
    const fromEntity = world.entities[edge.from];
    const toEntity = world.entities[edge.to];
    if (!fromEntity || !toEntity || !isPowerPole(fromEntity) || !isPowerPole(toEntity)) {
      continue;
    }

    const minX = Math.min(fromEntity.position.x, toEntity.position.x);
    const maxX = Math.max(fromEntity.position.x, toEntity.position.x);
    const minY = Math.min(fromEntity.position.y, toEntity.position.y);
    const maxY = Math.max(fromEntity.position.y, toEntity.position.y);

    if (!isRectIntersectingBounds(minX, minY, maxX, maxY, bounds)) {
      continue;
    }

    const fromWorld = {
      x: fromEntity.position.x + fromEntity.footprint.width / 2,
      y: fromEntity.position.y + POLE_WIRE_ANCHOR_Y,
    };
    const toWorld = {
      x: toEntity.position.x + toEntity.footprint.width / 2,
      y: toEntity.position.y + POLE_WIRE_ANCHOR_Y,
    };

    const fromScreen = worldToScreen(camera, fromWorld, viewport);
    const toScreen = worldToScreen(camera, toWorld, viewport);

    const dx = toScreen.x - fromScreen.x;
    const dy = toScreen.y - fromScreen.y;
    const distPx = Math.hypot(dx, dy);
    const sagPx = clamp(distPx * 0.08, 2, camera.zoom * 0.45);

    const controlScreen: ScreenCoord = {
      x: (fromScreen.x + toScreen.x) / 2,
      y: (fromScreen.y + toScreen.y) / 2 + sagPx,
    };

    const networkId = fromEntity.powerNetworkId ?? toEntity.powerNetworkId;
    results.push({
      fromId: fromEntity.id,
      toId: toEntity.id,
      fromScreen,
      toScreen,
      controlScreen,
      networkId,
      health: getNetworkHealthStatus(world, networkId),
    });
  }

  return results;
}

export function computeUnpoweredWarnings(
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  visibleBounds?: ViewportBounds
): UnpoweredWarningRenderItem[] {
  const bounds =
    visibleBounds ??
    getVisibleTileBounds(camera, viewport, {
      width: world.width,
      height: world.height,
    });

  const alpha = computeWarningPulseAlpha(world.tick);
  const radius = clamp(camera.zoom * 0.28, 5, 16);
  const results: UnpoweredWarningRenderItem[] = [];
  const entities = getSortedEntities(world);

  for (const entity of entities) {
    if (!isPowerConsumer(entity)) {
      continue;
    }

    if (!isFootprintVisible(entity.position, entity.footprint, bounds)) {
      continue;
    }

    let reason: PowerWarningReason | null = null;
    let satisfaction = 0;

    if (entity.powerNetworkId === null) {
      reason = 'unconnected';
      satisfaction = 0;
    } else {
      const network = getEntityPowerNetwork(world.powerGrid, entity);
      satisfaction = getEntityPowerSatisfaction(world, entity);
      if (!network || satisfaction <= 0) {
        reason = 'blackout';
      } else if (satisfaction < 0.999) {
        reason = 'brownout';
      }
    }

    if (reason === null) {
      continue;
    }

    const centerWorld = {
      x: entity.position.x + entity.footprint.width / 2,
      y: entity.position.y + entity.footprint.height / 2,
    };

    results.push({
      entityId: entity.id,
      screenCenter: worldToScreen(camera, centerWorld, viewport),
      radius,
      reason,
      satisfaction,
      alpha,
    });
  }

  return results;
}

// ============================================================================
// Canvas 2D Drawing Primitives
// ============================================================================

export function drawCoverageSquares(
  ctx: PowerOverlayContext,
  squares: readonly CoverageSquareRenderItem[]
): number {
  if (squares.length === 0) {
    return 0;
  }

  ctx.save();
  ctx.lineWidth = 1.5;

  for (const sq of squares) {
    ctx.fillStyle = COVERAGE_FILL_COLORS[sq.health];
    ctx.fillRect(sq.screenX, sq.screenY, sq.screenWidth, sq.screenHeight);
    ctx.strokeStyle = COVERAGE_STROKE_COLORS[sq.health];
    ctx.strokeRect(sq.screenX, sq.screenY, sq.screenWidth, sq.screenHeight);
  }

  ctx.restore();
  return squares.length;
}

export function drawPowerWires(
  ctx: PowerOverlayContext,
  wires: readonly PowerWireRenderItem[],
  zoom: number
): number {
  if (wires.length === 0) {
    return 0;
  }

  ctx.save();
  ctx.lineWidth = clamp(zoom * 0.06, 1.25, 3);

  for (const wire of wires) {
    ctx.strokeStyle = WIRE_COLORS[wire.health];
    ctx.beginPath();
    ctx.moveTo(wire.fromScreen.x, wire.fromScreen.y);
    ctx.quadraticCurveTo(
      wire.controlScreen.x,
      wire.controlScreen.y,
      wire.toScreen.x,
      wire.toScreen.y
    );
    ctx.stroke();
  }

  ctx.restore();
  return wires.length;
}

export function drawUnpoweredWarnings(
  ctx: PowerOverlayContext,
  warnings: readonly UnpoweredWarningRenderItem[]
): number {
  if (warnings.length === 0) {
    return 0;
  }

  ctx.save();

  for (const warning of warnings) {
    const { x, y } = warning.screenCenter;
    const r = warning.radius;

    ctx.globalAlpha = warning.alpha;

    // Circular warning badge
    ctx.fillStyle = WARNING_BADGE_COLORS[warning.reason];
    ctx.strokeStyle = WARNING_BORDER_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Stylized lightning bolt icon inside the badge
    ctx.fillStyle = WARNING_BOLT_COLOR;
    ctx.beginPath();
    ctx.moveTo(x + r * 0.1, y - r * 0.65);
    ctx.lineTo(x - r * 0.45, y + r * 0.05);
    ctx.lineTo(x - r * 0.05, y + r * 0.05);
    ctx.lineTo(x - r * 0.15, y + r * 0.65);
    ctx.lineTo(x + r * 0.45, y - r * 0.08);
    ctx.lineTo(x + r * 0.05, y - r * 0.08);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
  return warnings.length;
}

// ============================================================================
// Main Render Entry Point & Stateful Toggle Controller
// ============================================================================

export function renderPowerOverlay(
  ctx: PowerOverlayContext,
  world: WorldState,
  camera: CameraState,
  viewport: ViewportSize,
  config: PowerOverlayConfig
): PowerOverlayRenderStats {
  if (!config.enabled) {
    return {
      rendered: false,
      wiresDrawn: 0,
      coverageRectsDrawn: 0,
      warningsDrawn: 0,
    };
  }

  const visibleBounds = getVisibleTileBounds(camera, viewport, {
    width: world.width,
    height: world.height,
  });

  let coverageRectsDrawn = 0;
  let wiresDrawn = 0;
  let warningsDrawn = 0;

  if (config.showCoverage) {
    const squares = computeCoverageSquares(world, camera, viewport, visibleBounds);
    coverageRectsDrawn = drawCoverageSquares(ctx, squares);
  }

  if (config.showWires) {
    const wires = computePowerWires(world, camera, viewport, visibleBounds);
    wiresDrawn = drawPowerWires(ctx, wires, camera.zoom);
  }

  if (config.showUnpoweredWarnings) {
    const warnings = computeUnpoweredWarnings(world, camera, viewport, visibleBounds);
    warningsDrawn = drawUnpoweredWarnings(ctx, warnings);
  }

  return {
    rendered: true,
    wiresDrawn,
    coverageRectsDrawn,
    warningsDrawn,
  };
}

/**
 * Stateful toggleable power overlay controller for integration with
 * T47 (`inputController.ts` `P` key) and T50 (`main.ts` render loop).
 */
export class PowerOverlay {
  private config: PowerOverlayConfig;

  constructor(initialConfig: Partial<PowerOverlayConfig> = {}) {
    this.config = createPowerOverlayConfig(initialConfig);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  toggle(): boolean {
    this.config.enabled = !this.config.enabled;
    return this.config.enabled;
  }

  getConfig(): Readonly<PowerOverlayConfig> {
    return { ...this.config };
  }

  updateConfig(partial: Partial<PowerOverlayConfig>): void {
    this.config = {
      ...this.config,
      ...partial,
    };
  }

  render(
    ctx: PowerOverlayContext,
    world: WorldState,
    camera: CameraState,
    viewport: ViewportSize
  ): PowerOverlayRenderStats {
    return renderPowerOverlay(ctx, world, camera, viewport, this.config);
  }
}

export type { PowerPoleEntity };
