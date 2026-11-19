/**
 * Ironworks-16 Build Hotbar & Tick/FPS Readout (T43)
 *
 * Provides:
 * - 1-9 build toolbar state management & hotkey handling
 * - Deterministic rolling-window FPS counter & tick/FPS readout formatting
 * - Canvas 2D rendering & hit-testing (via structural context interface for headless testability)
 */

import {
  type EntityType,
  type HotbarSlot,
  SimulationError,
  TICKS_PER_SECOND,
} from '../types/contracts.js';

// ============================================================================
// Constants & Default Build Slots
// ============================================================================

export const MIN_HOTBAR_KEY = 1;
export const MAX_HOTBAR_KEY = 9;

export const DEFAULT_HOTBAR_SLOTS: readonly HotbarSlot[] = [
  { key: 1, entityType: 'transport_belt', label: 'Belt' },
  { key: 2, entityType: 'inserter', label: 'Inserter' },
  { key: 3, entityType: 'splitter', label: 'Splitter' },
  { key: 4, entityType: 'underground_belt', label: 'Underground' },
  { key: 5, entityType: 'burner_drill', label: 'Drill' },
  { key: 6, entityType: 'stone_furnace', label: 'Furnace' },
  { key: 7, entityType: 'assembler_mk1', label: 'Assembler' },
  { key: 8, entityType: 'power_pole', label: 'Pole' },
  { key: 9, entityType: 'wooden_chest', label: 'Chest' },
] as const;

// ============================================================================
// Pure State & Readout Types
// ============================================================================

export interface TickFpsReadout {
  readonly tick: number;
  readonly fps: number;
  readonly targetTps: number;
}

export interface HotbarState {
  readonly slots: readonly HotbarSlot[];
  readonly selectedKey: number | null;
  readonly readout: TickFpsReadout;
}

export interface HotbarSlotRect {
  readonly key: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HotbarLayout {
  readonly barX: number;
  readonly barY: number;
  readonly barWidth: number;
  readonly barHeight: number;
  readonly slotRects: readonly HotbarSlotRect[];
  readonly readoutX: number;
  readonly readoutY: number;
  readonly readoutWidth: number;
  readonly readoutHeight: number;
}

/**
 * Minimal Canvas 2D context subset required by renderHotbar.
 * Structurally compatible with browser CanvasRenderingContext2D and mock contexts in Vitest.
 */
export interface HotbarCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  save(): void;
  restore(): void;
}

// ============================================================================
// Validation Helpers
// ============================================================================

function validateHotbarKey(key: number): void {
  if (!Number.isInteger(key) || key < MIN_HOTBAR_KEY || key > MAX_HOTBAR_KEY) {
    throw new SimulationError(
      'INVALID_HOTBAR_KEY',
      `Hotbar key must be an integer between ${MIN_HOTBAR_KEY} and ${MAX_HOTBAR_KEY}, got: ${key}`
    );
  }
}

function validateSlots(slots: readonly HotbarSlot[]): HotbarSlot[] {
  const seen = new Set<number>();
  const validated: HotbarSlot[] = [];

  for (const slot of slots) {
    validateHotbarKey(slot.key);
    if (seen.has(slot.key)) {
      throw new SimulationError(
        'DUPLICATE_HOTBAR_KEY',
        `Duplicate hotbar key: ${slot.key}`
      );
    }
    seen.add(slot.key);
    validated.push({
      key: slot.key,
      entityType: slot.entityType,
      label: slot.label,
    });
  }

  validated.sort((a, b) => a.key - b.key);
  return validated;
}

// ============================================================================
// Deterministic Rolling-Window FPS Counter
// ============================================================================

export class FpsCounter {
  private readonly windowSize: number;
  private readonly frameDurationsMs: number[] = [];
  private sumMs = 0;

  constructor(windowSize = 30) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new SimulationError(
        'INVALID_FPS_WINDOW',
        `FPS window size must be a positive integer, got: ${windowSize}`
      );
    }
    this.windowSize = windowSize;
  }

  /**
   * Records a frame delta in milliseconds and returns the smoothed FPS.
   * Non-finite or non-positive deltas are ignored without corrupting state.
   */
  recordFrame(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return this.getFps();
    }

    this.frameDurationsMs.push(deltaMs);
    this.sumMs += deltaMs;

    if (this.frameDurationsMs.length > this.windowSize) {
      const removed = this.frameDurationsMs.shift();
      if (removed !== undefined) {
        this.sumMs -= removed;
      }
    }

    return this.getFps();
  }

  getFps(): number {
    if (this.frameDurationsMs.length === 0 || this.sumMs <= 0) {
      return 0;
    }
    const avgMs = this.sumMs / this.frameDurationsMs.length;
    return 1000 / avgMs;
  }

  getSampleCount(): number {
    return this.frameDurationsMs.length;
  }

  reset(): void {
    this.frameDurationsMs.length = 0;
    this.sumMs = 0;
  }
}

export function formatTickFpsReadout(tick: number, fps: number): string {
  const safeTick = Number.isFinite(tick) && tick >= 0 ? Math.floor(tick) : 0;
  const safeFps = Number.isFinite(fps) && fps >= 0 ? fps : 0;
  return `Tick: ${safeTick} | FPS: ${safeFps.toFixed(1)}`;
}

// ============================================================================
// Hotbar Controller
// ============================================================================

export class Hotbar {
  private slots: HotbarSlot[];
  private selectedKey: number | null;
  private tick: number;
  private readonly fpsCounter: FpsCounter;
  private manualFps: number | null = null;

  constructor(
    initialSlots: readonly HotbarSlot[] = DEFAULT_HOTBAR_SLOTS,
    initialSelectedKey: number | null = 1,
    fpsWindowSize = 30
  ) {
    this.slots = validateSlots(initialSlots);
    this.fpsCounter = new FpsCounter(fpsWindowSize);
    this.tick = 0;

    if (initialSelectedKey !== null) {
      validateHotbarKey(initialSelectedKey);
      const exists = this.slots.some((s) => s.key === initialSelectedKey);
      this.selectedKey = exists ? initialSelectedKey : null;
    } else {
      this.selectedKey = null;
    }
  }

  getSlots(): readonly HotbarSlot[] {
    return this.slots;
  }

  getSelectedKey(): number | null {
    return this.selectedKey;
  }

  getSelectedSlot(): HotbarSlot | null {
    if (this.selectedKey === null) return null;
    return this.slots.find((s) => s.key === this.selectedKey) ?? null;
  }

  getSelectedEntityType(): EntityType | null {
    return this.getSelectedSlot()?.entityType ?? null;
  }

  /**
   * Selects the slot mapped to `key` (1-9).
   * Returns the selected slot, or null if `key` is out of range or unbound.
   */
  selectSlot(key: number): HotbarSlot | null {
    if (!Number.isInteger(key) || key < MIN_HOTBAR_KEY || key > MAX_HOTBAR_KEY) {
      return null;
    }
    const slot = this.slots.find((s) => s.key === key) ?? null;
    if (slot === null) {
      return null;
    }
    this.selectedKey = key;
    return slot;
  }

  /**
   * Toggles selection of `key`: selects it if not currently selected, or clears selection if already selected.
   */
  toggleSlot(key: number): HotbarSlot | null {
    if (this.selectedKey === key) {
      this.selectedKey = null;
      return null;
    }
    return this.selectSlot(key);
  }

  clearSelection(): void {
    this.selectedKey = null;
  }

  /**
   * Replaces or inserts a slot binding for key 1-9.
   */
  setSlot(key: number, entityType: EntityType, label: string): HotbarSlot {
    validateHotbarKey(key);
    const updated: HotbarSlot = { key, entityType, label };
    const idx = this.slots.findIndex((s) => s.key === key);
    if (idx >= 0) {
      this.slots[idx] = updated;
    } else {
      this.slots.push(updated);
      this.slots.sort((a, b) => a.key - b.key);
    }
    return updated;
  }

  /**
   * Handles keyboard input (`1`-`9` to select slot, `Escape` or `0` to clear selection).
   * Returns true if the key was handled by the hotbar.
   */
  handleKeyDown(key: string): boolean {
    if (key === 'Escape' || key === '0') {
      this.clearSelection();
      return true;
    }
    if (key.length === 1 && key >= '1' && key <= '9') {
      const slotKey = Number(key);
      return this.selectSlot(slotKey) !== null;
    }
    return false;
  }

  /**
   * Updates the current simulation tick and optionally records a frame delta (in ms) for FPS calculation.
   */
  updateReadout(tick: number, frameDeltaMs?: number): TickFpsReadout {
    if (Number.isFinite(tick) && tick >= 0) {
      this.tick = Math.floor(tick);
    }
    if (frameDeltaMs !== undefined) {
      this.manualFps = null;
      this.fpsCounter.recordFrame(frameDeltaMs);
    }
    return this.getReadout();
  }

  /**
   * Explicitly sets FPS (useful when an external loop computes FPS).
   */
  setFps(fps: number): void {
    if (Number.isFinite(fps) && fps >= 0) {
      this.manualFps = fps;
    }
  }

  getReadout(): TickFpsReadout {
    const fps = this.manualFps ?? this.fpsCounter.getFps();
    return {
      tick: this.tick,
      fps,
      targetTps: TICKS_PER_SECOND,
    };
  }

  getFormattedReadout(): string {
    const readout = this.getReadout();
    return formatTickFpsReadout(readout.tick, readout.fps);
  }

  getState(): HotbarState {
    return {
      slots: this.slots,
      selectedKey: this.selectedKey,
      readout: this.getReadout(),
    };
  }
}

// ============================================================================
// Layout, Hit-Testing & Canvas 2D Rendering
// ============================================================================

const SLOT_WIDTH = 64;
const SLOT_HEIGHT = 48;
const SLOT_GAP = 4;
const BAR_PADDING = 6;
const BAR_BOTTOM_MARGIN = 12;

const READOUT_WIDTH = 180;
const READOUT_HEIGHT = 28;
const READOUT_MARGIN = 12;

export function computeHotbarLayout(
  canvasWidth: number,
  canvasHeight: number,
  slots: readonly HotbarSlot[] = DEFAULT_HOTBAR_SLOTS
): HotbarLayout {
  const count = Math.max(1, slots.length);
  const barWidth = count * SLOT_WIDTH + (count - 1) * SLOT_GAP + BAR_PADDING * 2;
  const barHeight = SLOT_HEIGHT + BAR_PADDING * 2;
  const barX = Math.floor((canvasWidth - barWidth) / 2);
  const barY = Math.max(0, canvasHeight - barHeight - BAR_BOTTOM_MARGIN);

  const slotRects: HotbarSlotRect[] = slots.map((slot, index) => ({
    key: slot.key,
    x: barX + BAR_PADDING + index * (SLOT_WIDTH + SLOT_GAP),
    y: barY + BAR_PADDING,
    width: SLOT_WIDTH,
    height: SLOT_HEIGHT,
  }));

  const readoutX = Math.max(READOUT_MARGIN, canvasWidth - READOUT_WIDTH - READOUT_MARGIN);
  const readoutY = READOUT_MARGIN;

  return {
    barX,
    barY,
    barWidth,
    barHeight,
    slotRects,
    readoutX,
    readoutY,
    readoutWidth: READOUT_WIDTH,
    readoutHeight: READOUT_HEIGHT,
  };
}

/**
 * Returns the hotbar slot key (1-9) at the given screen coordinates, or null if outside all slots.
 */
export function hitTestHotbar(
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
  slots: readonly HotbarSlot[] = DEFAULT_HOTBAR_SLOTS
): number | null {
  const layout = computeHotbarLayout(canvasWidth, canvasHeight, slots);
  for (const rect of layout.slotRects) {
    if (
      screenX >= rect.x &&
      screenX <= rect.x + rect.width &&
      screenY >= rect.y &&
      screenY <= rect.y + rect.height
    ) {
      return rect.key;
    }
  }
  return null;
}

/**
 * Renders the 1-9 build toolbar at the bottom center and the Tick/FPS readout at the top right.
 */
export function renderHotbar(
  ctx: HotbarCanvasContext,
  state: HotbarState,
  canvasWidth: number,
  canvasHeight: number
): HotbarLayout {
  const layout = computeHotbarLayout(canvasWidth, canvasHeight, state.slots);

  ctx.save();

  // 1. Toolbar container
  ctx.fillStyle = 'rgba(20, 24, 32, 0.9)';
  ctx.fillRect(layout.barX, layout.barY, layout.barWidth, layout.barHeight);
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 2;
  ctx.strokeRect(layout.barX, layout.barY, layout.barWidth, layout.barHeight);

  // 2. Individual build slots (1-9)
  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i];
    const rect = layout.slotRects[i];
    if (!slot || !rect) continue;

    const isSelected = state.selectedKey === slot.key;

    ctx.fillStyle = isSelected ? '#2d3b55' : '#1a202c';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.strokeStyle = isSelected ? '#f6ad55' : '#4a5568';
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

    // Hotkey badge (top-left of slot)
    ctx.fillStyle = isSelected ? '#fbd38d' : '#a0aec0';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(slot.key), rect.x + 4, rect.y + 3);

    // Slot label (centered lower half)
    ctx.fillStyle = isSelected ? '#ffffff' : '#e2e8f0';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(slot.label, rect.x + rect.width / 2, rect.y + rect.height - 14, rect.width - 6);
  }

  // 3. Tick / FPS readout panel (top-right)
  ctx.fillStyle = 'rgba(20, 24, 32, 0.9)';
  ctx.fillRect(layout.readoutX, layout.readoutY, layout.readoutWidth, layout.readoutHeight);
  ctx.strokeStyle = '#4a5568';
  ctx.lineWidth = 1;
  ctx.strokeRect(layout.readoutX, layout.readoutY, layout.readoutWidth, layout.readoutHeight);

  ctx.fillStyle = '#9ae6b4';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    formatTickFpsReadout(state.readout.tick, state.readout.fps),
    layout.readoutX + layout.readoutWidth / 2,
    layout.readoutY + layout.readoutHeight / 2,
    layout.readoutWidth - 10
  );

  ctx.restore();

  return layout;
}
