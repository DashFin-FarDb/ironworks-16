/**
 * Ironworks-16 Input Controller (T47)
 *
 * Unified keyboard & pointer input controller:
 * - WASD / Arrow keys: continuous camera panning
 * - Mouse wheel: cursor-anchored camera zoom
 * - R (Shift+R): rotate placement direction clockwise (counter-clockwise)
 * - 1-9 / 0 / Escape: hotbar build tool selection & clearing
 * - Left-click: hotbar hit-test, entity placement (when tool selected), or entity inspection
 * - Right-click: delete entity under cursor (clearing full multi-tile footprint)
 * - P: toggle power overlay
 *
 * Strictly deterministic (no Math.random/Date.now) and headless-testable:
 * uses structural event-target interfaces so Node/Vitest tests require zero DOM globals.
 */

import {
  type Direction,
  type Entity,
  type EntityId,
  type EntityType,
  type TileCoord,
  type WorldState,
  isWithinBounds,
  rotateDirection,
} from '../types/contracts.js';
import {
  createEntityInstance,
  getFootprintTiles,
} from '../core/entityManager.js';
import type { EventBus } from '../core/eventBus.js';
import {
  Camera,
  type ScreenCoord,
  type ViewportSize,
} from '../render/camera.js';
import {
  GhostPreviewController,
  type GhostPreviewState,
  evaluateGhostPlacement,
} from '../render/ghostPreview.js';
import { PowerOverlay } from '../render/powerOverlay.js';
import { Hotbar, hitTestHotbar } from '../ui/hotbar.js';
import {
  type InspectorState,
  clearInspectorSelection,
  createInspectorState,
  selectEntityAtTile,
} from '../ui/inspector.js';

// ============================================================================
// Constants & Configuration
// ============================================================================

export const DEFAULT_PAN_SPEED_TILES_PER_SEC = 12;
export const DEFAULT_ZOOM_STEP_FACTOR = 1.15;

export interface InputControllerConfig {
  /** Camera pan speed in tiles per second when holding WASD/Arrow keys. */
  panSpeedTilesPerSec?: number;
  /** Multiplicative zoom factor per wheel notch (> 1). */
  zoomStepFactor?: number;
}

export interface InputControllerDeps {
  world: WorldState;
  camera: Camera;
  viewport: ViewportSize;
  hotbar?: Hotbar;
  ghostPreview?: GhostPreviewController;
  powerOverlay?: PowerOverlay;
  inspectorState?: InspectorState;
  eventBus?: EventBus;
  config?: InputControllerConfig;
  /** Optional custom placement hook; defaults to placeEntityInWorld. */
  onPlaceEntity?: (
    world: WorldState,
    entityType: EntityType,
    tile: TileCoord,
    direction: Direction
  ) => Entity | null;
  /** Optional custom deletion hook; defaults to removeEntityAtTile. */
  onDeleteEntity?: (
    world: WorldState,
    tile: TileCoord
  ) => Entity | null;
}

// ============================================================================
// Action Results (Discriminated Union)
// ============================================================================

export type InputActionResult =
  | { readonly kind: 'noop'; readonly tile?: TileCoord }
  | { readonly kind: 'rotate'; readonly direction: Direction }
  | { readonly kind: 'toggle_power_overlay'; readonly enabled: boolean }
  | { readonly kind: 'hotbar'; readonly slotKey: number | null; readonly entityType: EntityType | null }
  | { readonly kind: 'zoom'; readonly zoom: number }
  | { readonly kind: 'placed'; readonly entity: Entity; readonly tile: TileCoord }
  | {
      readonly kind: 'placement_rejected';
      readonly entityType: EntityType;
      readonly tile: TileCoord;
      readonly preview: GhostPreviewState;
    }
  | { readonly kind: 'inspect'; readonly entityId: EntityId | null; readonly tile: TileCoord }
  | { readonly kind: 'deleted'; readonly entity: Entity; readonly tile: TileCoord };

// ============================================================================
// Minimal Structural Event Interfaces (Zero DOM Globals Required)
// ============================================================================

export interface MinimalKeyboardEvent {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
  preventDefault?: () => void;
}

export interface MinimalPointerEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly button?: number;
  preventDefault?: () => void;
}

export interface MinimalWheelEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly deltaY: number;
  preventDefault?: () => void;
}

export interface MinimalEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

export interface MinimalCanvasElement extends MinimalEventTarget {
  getBoundingClientRect(): { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

// ============================================================================
// World Mutation Helpers (Fail-Closed, Multi-Tile Safe)
// ============================================================================

/**
 * Places an entity directly into `world` after validating via `evaluateGhostPlacement`.
 * Returns the created Entity on success, or `null` (without mutating `world`) if invalid.
 */
export function placeEntityInWorld(
  world: WorldState,
  entityType: EntityType,
  tile: TileCoord,
  direction: Direction,
  eventBus?: EventBus
): Entity | null {
  const preview = evaluateGhostPlacement(world, entityType, tile, direction);
  if (!preview.valid) {
    return null;
  }

  const id = world.nextEntityId;
  const entity = createEntityInstance(id, entityType, tile, { direction });
  const footprintTiles = getFootprintTiles(tile, entity.footprint);

  world.entities[id] = entity;
  world.nextEntityId = id + 1;

  for (const coord of footprintTiles) {
    const t = world.tiles[coord.y * world.width + coord.x];
    if (t) {
      t.entityId = id;
    }
  }

  if (eventBus) {
    eventBus.emit('entityPlaced', {
      tick: world.tick,
      entityId: id,
      entityType: entity.type,
      position: { x: entity.position.x, y: entity.position.y },
    });
  }

  return entity;
}

/**
 * Removes the entity occupying `tile` (including all tiles of its footprint).
 * Returns the removed Entity, or `null` if out of bounds or unoccupied.
 */
export function removeEntityAtTile(
  world: WorldState,
  tile: TileCoord,
  eventBus?: EventBus
): Entity | null {
  if (!isWithinBounds(tile, { width: world.width, height: world.height })) {
    return null;
  }

  const targetTile = world.tiles[tile.y * world.width + tile.x];
  if (!targetTile || targetTile.entityId === null) {
    return null;
  }

  const entityId = targetTile.entityId;
  const entity = world.entities[entityId];
  if (!entity) {
    // Clean up dangling tile occupancy reference fail-safely
    targetTile.entityId = null;
    return null;
  }

  const footprintTiles = getFootprintTiles(entity.position, entity.footprint);
  for (const coord of footprintTiles) {
    if (isWithinBounds(coord, { width: world.width, height: world.height })) {
      const t = world.tiles[coord.y * world.width + coord.x];
      if (t && t.entityId === entityId) {
        t.entityId = null;
      }
    }
  }

  delete world.entities[entityId];

  if (eventBus) {
    eventBus.emit('entityRemoved', {
      tick: world.tick,
      entityId,
      entityType: entity.type,
      position: { x: entity.position.x, y: entity.position.y },
    });
  }

  return entity;
}

// ============================================================================
// InputController Class
// ============================================================================

type PanKey = 'up' | 'down' | 'left' | 'right';

function mapKeyToPanDirection(key: string): PanKey | null {
  switch (key.toLowerCase()) {
    case 'w':
    case 'arrowup':
      return 'up';
    case 's':
    case 'arrowdown':
      return 'down';
    case 'a':
    case 'arrowleft':
      return 'left';
    case 'd':
    case 'arrowright':
      return 'right';
    default:
      return null;
  }
}

export class InputController {
  private readonly world: WorldState;
  private readonly camera: Camera;
  private viewport: ViewportSize;
  private readonly hotbar: Hotbar;
  private readonly ghostPreview: GhostPreviewController;
  private readonly powerOverlay: PowerOverlay;
  private inspectorState: InspectorState;
  private readonly eventBus?: EventBus;
  private readonly panSpeedTilesPerSec: number;
  private readonly zoomStepFactor: number;
  private readonly onPlaceEntity?: InputControllerDeps['onPlaceEntity'];
  private readonly onDeleteEntity?: InputControllerDeps['onDeleteEntity'];

  private readonly heldPanKeys = new Set<PanKey>();
  private cursorScreenPos: ScreenCoord | null = null;
  private cursorTile: TileCoord | null = null;
  private detachFn: (() => void) | null = null;

  constructor(deps: InputControllerDeps) {
    this.world = deps.world;
    this.camera = deps.camera;
    this.viewport = { width: deps.viewport.width, height: deps.viewport.height };
    this.hotbar = deps.hotbar ?? new Hotbar();
    this.ghostPreview = deps.ghostPreview ?? new GhostPreviewController();
    this.powerOverlay = deps.powerOverlay ?? new PowerOverlay();
    this.inspectorState = deps.inspectorState ?? createInspectorState();
    this.eventBus = deps.eventBus;
    this.onPlaceEntity = deps.onPlaceEntity;
    this.onDeleteEntity = deps.onDeleteEntity;

    const panSpeed = deps.config?.panSpeedTilesPerSec ?? DEFAULT_PAN_SPEED_TILES_PER_SEC;
    const zoomStep = deps.config?.zoomStepFactor ?? DEFAULT_ZOOM_STEP_FACTOR;
    this.panSpeedTilesPerSec = Number.isFinite(panSpeed) && panSpeed > 0
      ? panSpeed
      : DEFAULT_PAN_SPEED_TILES_PER_SEC;
    this.zoomStepFactor = Number.isFinite(zoomStep) && zoomStep > 1
      ? zoomStep
      : DEFAULT_ZOOM_STEP_FACTOR;

    this.syncGhostWithHotbar();
  }

  // --- Accessors ---

  getCamera(): Camera {
    return this.camera;
  }

  getHotbar(): Hotbar {
    return this.hotbar;
  }

  getGhostPreview(): GhostPreviewController {
    return this.ghostPreview;
  }

  getPowerOverlay(): PowerOverlay {
    return this.powerOverlay;
  }

  getInspectorState(): InspectorState {
    return this.inspectorState;
  }

  getDirection(): Direction {
    return this.ghostPreview.getDirection();
  }

  getCursorTile(): TileCoord | null {
    return this.cursorTile ? { x: this.cursorTile.x, y: this.cursorTile.y } : null;
  }

  getCursorScreenPos(): ScreenCoord | null {
    return this.cursorScreenPos ? { x: this.cursorScreenPos.x, y: this.cursorScreenPos.y } : null;
  }

  getHeldPanKeys(): readonly PanKey[] {
    return Array.from(this.heldPanKeys);
  }

  setViewport(viewport: ViewportSize): void {
    if (viewport.width > 0 && viewport.height > 0) {
      this.viewport = { width: viewport.width, height: viewport.height };
      if (this.cursorScreenPos) {
        this.updateCursorTile(this.cursorScreenPos);
      }
    }
  }

  // --- Synchronization ---

  private syncGhostWithHotbar(): void {
    const selected = this.hotbar.getSelectedEntityType();
    if (selected) {
      this.ghostPreview.select(selected);
    } else {
      this.ghostPreview.clear();
    }
  }

  private updateCursorTile(screenPos: ScreenCoord): TileCoord {
    this.cursorScreenPos = { x: screenPos.x, y: screenPos.y };
    const tile = this.ghostPreview.setCursorScreen(
      this.cursorScreenPos,
      this.camera.getState(),
      this.viewport
    );
    this.cursorTile = tile;
    return tile;
  }

  // --- Keyboard Handlers ---

  handleKeyDown(key: string, options: { shiftKey?: boolean; repeat?: boolean } = {}): InputActionResult {
    const panDir = mapKeyToPanDirection(key);
    if (panDir !== null) {
      this.heldPanKeys.add(panDir);
      return { kind: 'noop' };
    }

    const lower = key.toLowerCase();

    // R: rotate placement direction (Shift+R rotates counter-clockwise)
    if (lower === 'r') {
      if (options.repeat) {
        return { kind: 'noop' };
      }
      const steps = options.shiftKey ? -1 : 1;
      const direction = this.ghostPreview.rotate(steps);
      return { kind: 'rotate', direction };
    }

    // P: toggle power overlay
    if (lower === 'p') {
      if (options.repeat) {
        return { kind: 'noop' };
      }
      const enabled = this.powerOverlay.toggle();
      return { kind: 'toggle_power_overlay', enabled };
    }

    // Escape / 0 / 1-9: hotbar selection
    const hadSelection = this.hotbar.getSelectedEntityType() !== null;
    if (this.hotbar.handleKeyDown(key)) {
      this.syncGhostWithHotbar();
      if ((key === 'Escape' || key === '0') && !hadSelection) {
        this.inspectorState = clearInspectorSelection(this.inspectorState);
      }
      return {
        kind: 'hotbar',
        slotKey: this.hotbar.getSelectedKey(),
        entityType: this.hotbar.getSelectedEntityType(),
      };
    }

    return { kind: 'noop' };
  }

  handleKeyUp(key: string): void {
    const panDir = mapKeyToPanDirection(key);
    if (panDir !== null) {
      this.heldPanKeys.delete(panDir);
    }
  }

  handleBlur(): void {
    this.heldPanKeys.clear();
  }

  // --- Frame Update (WASD Panning) ---

  /**
   * Advances continuous WASD/Arrow camera panning by `deltaSeconds`.
   * Diagonal movement is normalized by 1/sqrt(2) so speed is uniform in all directions.
   */
  update(deltaSeconds: number): boolean {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || this.heldPanKeys.size === 0) {
      return false;
    }

    let dx = 0;
    let dy = 0;
    if (this.heldPanKeys.has('left')) dx -= 1;
    if (this.heldPanKeys.has('right')) dx += 1;
    if (this.heldPanKeys.has('up')) dy -= 1;
    if (this.heldPanKeys.has('down')) dy += 1;

    if (dx === 0 && dy === 0) {
      return false;
    }

    if (dx !== 0 && dy !== 0) {
      const invSqrt2 = Math.SQRT1_2;
      dx *= invSqrt2;
      dy *= invSqrt2;
    }

    const distance = this.panSpeedTilesPerSec * deltaSeconds;
    this.camera.pan(dx * distance, dy * distance);

    if (this.cursorScreenPos) {
      this.updateCursorTile(this.cursorScreenPos);
    }

    return true;
  }

  // --- Pointer & Wheel Handlers ---

  handlePointerMove(screenPos: ScreenCoord): TileCoord {
    return this.updateCursorTile(screenPos);
  }

  handleWheel(deltaY: number, screenPos: ScreenCoord): InputActionResult {
    if (!Number.isFinite(deltaY) || deltaY === 0) {
      return { kind: 'noop' };
    }

    // Scroll up (deltaY < 0) zooms in; scroll down (deltaY > 0) zooms out.
    const factor = deltaY < 0 ? this.zoomStepFactor : 1 / this.zoomStepFactor;
    this.camera.zoomAt(factor, screenPos, this.viewport);
    this.updateCursorTile(screenPos);

    return { kind: 'zoom', zoom: this.camera.zoom };
  }

  /**
   * Handles mouse/pointer button press at canvas-relative `screenPos`.
   * - button === 0 (left-click): hotbar click -> place entity (if tool selected) -> inspect entity
   * - button === 2 (right-click): delete entity at cursor tile
   */
  handlePointerDown(button: number, screenPos: ScreenCoord): InputActionResult {
    const tile = this.updateCursorTile(screenPos);

    // Right-click: delete entity at tile
    if (button === 2) {
      const removed = this.onDeleteEntity
        ? this.onDeleteEntity(this.world, tile)
        : removeEntityAtTile(this.world, tile, this.eventBus);

      if (removed) {
        if (this.inspectorState.selectedEntityId === removed.id) {
          this.inspectorState = clearInspectorSelection(this.inspectorState);
        }
        return { kind: 'deleted', entity: removed, tile };
      }
      return { kind: 'noop', tile };
    }

    // Left-click: hotbar -> place -> inspect
    if (button === 0) {
      const hitKey = hitTestHotbar(
        screenPos.x,
        screenPos.y,
        this.viewport.width,
        this.viewport.height,
        this.hotbar.getSlots()
      );
      if (hitKey !== null) {
        this.hotbar.toggleSlot(hitKey);
        this.syncGhostWithHotbar();
        return {
          kind: 'hotbar',
          slotKey: this.hotbar.getSelectedKey(),
          entityType: this.hotbar.getSelectedEntityType(),
        };
      }

      const selectedType = this.hotbar.getSelectedEntityType();
      if (selectedType !== null) {
        const direction = this.ghostPreview.getDirection();
        const preview = evaluateGhostPlacement(this.world, selectedType, tile, direction);
        if (!preview.valid) {
          return {
            kind: 'placement_rejected',
            entityType: selectedType,
            tile,
            preview,
          };
        }

        const entity = this.onPlaceEntity
          ? this.onPlaceEntity(this.world, selectedType, tile, direction)
          : placeEntityInWorld(this.world, selectedType, tile, direction, this.eventBus);

        if (!entity) {
          return {
            kind: 'placement_rejected',
            entityType: selectedType,
            tile,
            preview,
          };
        }

        return { kind: 'placed', entity, tile };
      }

      // No build tool selected: inspect entity at tile
      const selectedId = selectEntityAtTile(this.inspectorState, this.world, tile);
      return {
        kind: 'inspect',
        entityId: selectedId,
        tile,
      };
    }

    return { kind: 'noop', tile };
  }

  // --- DOM Event Target Binding ---

  /**
   * Attaches keyboard, pointer, wheel, contextmenu, and blur listeners to a canvas
   * and optional window/document target. Returns an idempotent detach function.
   */
  attach(canvas: MinimalCanvasElement, keyTarget: MinimalEventTarget = canvas): () => void {
    this.detach();

    const toScreenCoord = (e: MinimalPointerEvent | MinimalWheelEvent): ScreenCoord => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };

    const onKeyDown = (raw: unknown): void => {
      const e = raw as MinimalKeyboardEvent;
      const result = this.handleKeyDown(e.key, {
        shiftKey: e.shiftKey,
        repeat: e.repeat,
      });
      if (result.kind !== 'noop' || mapKeyToPanDirection(e.key) !== null) {
        e.preventDefault?.();
      }
    };

    const onKeyUp = (raw: unknown): void => {
      const e = raw as MinimalKeyboardEvent;
      this.handleKeyUp(e.key);
    };

    const onBlur = (): void => {
      this.handleBlur();
    };

    const onPointerMove = (raw: unknown): void => {
      const e = raw as MinimalPointerEvent;
      this.handlePointerMove(toScreenCoord(e));
    };

    const onPointerDown = (raw: unknown): void => {
      const e = raw as MinimalPointerEvent;
      const button = e.button ?? 0;
      if (button === 2) {
        e.preventDefault?.();
      }
      this.handlePointerDown(button, toScreenCoord(e));
    };

    const onWheel = (raw: unknown): void => {
      const e = raw as MinimalWheelEvent;
      e.preventDefault?.();
      this.handleWheel(e.deltaY, toScreenCoord(e));
    };

    const onContextMenu = (raw: unknown): void => {
      const e = raw as { preventDefault?: () => void };
      e.preventDefault?.();
    };

    keyTarget.addEventListener('keydown', onKeyDown);
    keyTarget.addEventListener('keyup', onKeyUp);
    keyTarget.addEventListener('blur', onBlur);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    const cleanup = (): void => {
      keyTarget.removeEventListener('keydown', onKeyDown);
      keyTarget.removeEventListener('keyup', onKeyUp);
      keyTarget.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('wheel', onWheel, { passive: false });
      canvas.removeEventListener('contextmenu', onContextMenu);
      this.heldPanKeys.clear();
      if (this.detachFn === cleanup) {
        this.detachFn = null;
      }
    };

    this.detachFn = cleanup;
    return cleanup;
  }

  detach(): void {
    if (this.detachFn) {
      this.detachFn();
    }
  }
}
