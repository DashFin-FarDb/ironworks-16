import { describe, expect, it } from 'vitest';
import { SimulationError, TICKS_PER_SECOND, type HotbarSlot } from '../src/types/contracts.js';
import {
  DEFAULT_HOTBAR_SLOTS,
  FpsCounter,
  Hotbar,
  computeHotbarLayout,
  formatTickFpsReadout,
  hitTestHotbar,
  renderHotbar,
  type HotbarCanvasContext,
} from '../src/ui/hotbar.js';

function createMockCanvasContext() {
  const texts: Array<{ text: string; x: number; y: number }> = [];
  const fillRects: Array<{ x: number; y: number; w: number; h: number; fillStyle: unknown }> = [];
  const strokeRects: Array<{ x: number; y: number; w: number; h: number; strokeStyle: unknown }> = [];

  const ctx: HotbarCanvasContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    fillRect(x, y, w, h) {
      fillRects.push({ x, y, w, h, fillStyle: this.fillStyle });
    },
    strokeRect(x, y, w, h) {
      strokeRects.push({ x, y, w, h, strokeStyle: this.strokeStyle });
    },
    fillText(text, x, y) {
      texts.push({ text, x, y });
    },
    save() {
      // no-op
    },
    restore() {
      // no-op
    },
  };

  return { ctx, texts, fillRects, strokeRects };
}

describe('T43: Build Hotbar (1-9 hotkeys) & Tick/FPS Readout', () => {
  it('initializes with 9 default build slots (keys 1-9) and selects slot 1 by default', () => {
    const hotbar = new Hotbar();
    const slots = hotbar.getSlots();

    expect(slots).toHaveLength(9);
    expect(slots.map((s) => s.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(hotbar.getSelectedKey()).toBe(1);
    expect(hotbar.getSelectedEntityType()).toBe('transport_belt');
  });

  it('selects slots via 1-9 hotkeys and clears selection via Escape or 0', () => {
    const hotbar = new Hotbar();

    expect(hotbar.handleKeyDown('6')).toBe(true);
    expect(hotbar.getSelectedKey()).toBe(6);
    expect(hotbar.getSelectedEntityType()).toBe('stone_furnace');

    expect(hotbar.handleKeyDown('9')).toBe(true);
    expect(hotbar.getSelectedKey()).toBe(9);
    expect(hotbar.getSelectedEntityType()).toBe('wooden_chest');

    expect(hotbar.handleKeyDown('Escape')).toBe(true);
    expect(hotbar.getSelectedKey()).toBeNull();
    expect(hotbar.getSelectedEntityType()).toBeNull();

    expect(hotbar.handleKeyDown('2')).toBe(true);
    expect(hotbar.getSelectedEntityType()).toBe('inserter');

    expect(hotbar.handleKeyDown('0')).toBe(true);
    expect(hotbar.getSelectedKey()).toBeNull();

    // Unrelated keys are ignored
    expect(hotbar.handleKeyDown('w')).toBe(false);
    expect(hotbar.handleKeyDown('r')).toBe(false);
    expect(hotbar.handleKeyDown('F1')).toBe(false);
  });

  it('supports toggleSlot, setSlot, and ignores out-of-range selectSlot calls', () => {
    const hotbar = new Hotbar();

    expect(hotbar.toggleSlot(1)).toBeNull();
    expect(hotbar.getSelectedKey()).toBeNull();

    const toggled = hotbar.toggleSlot(3);
    expect(toggled?.entityType).toBe('splitter');
    expect(hotbar.getSelectedKey()).toBe(3);

    expect(hotbar.selectSlot(0)).toBeNull();
    expect(hotbar.selectSlot(10)).toBeNull();
    expect(hotbar.selectSlot(2.5)).toBeNull();
    expect(hotbar.getSelectedKey()).toBe(3);

    hotbar.setSlot(5, 'electric_drill', 'Elec Drill');
    hotbar.selectSlot(5);
    expect(hotbar.getSelectedEntityType()).toBe('electric_drill');
    expect(hotbar.getSelectedSlot()?.label).toBe('Elec Drill');
  });

  it('fails closed on invalid slot definitions or FPS window sizes', () => {
    const duplicateSlots: HotbarSlot[] = [
      { key: 1, entityType: 'transport_belt', label: 'Belt' },
      { key: 1, entityType: 'inserter', label: 'Inserter' },
    ];
    expect(() => new Hotbar(duplicateSlots)).toThrow(SimulationError);

    const outOfRangeSlots: HotbarSlot[] = [
      { key: 10, entityType: 'transport_belt', label: 'Belt' },
    ];
    expect(() => new Hotbar(outOfRangeSlots)).toThrow(SimulationError);

    expect(() => new FpsCounter(0)).toThrow(SimulationError);
    expect(() => new FpsCounter(-5)).toThrow(SimulationError);
  });

  it('computes deterministic rolling-window FPS and ignores invalid frame deltas', () => {
    const counter = new FpsCounter(4);
    expect(counter.getFps()).toBe(0);

    // 4 frames at 16ms -> 62.5 FPS
    for (let i = 0; i < 4; i++) {
      counter.recordFrame(16);
    }
    expect(counter.getFps()).toBeCloseTo(62.5, 5);

    // Invalid deltas are ignored without corrupting state
    expect(counter.recordFrame(0)).toBeCloseTo(62.5, 5);
    expect(counter.recordFrame(-10)).toBeCloseTo(62.5, 5);
    expect(counter.recordFrame(Number.NaN)).toBeCloseTo(62.5, 5);
    expect(counter.recordFrame(Number.POSITIVE_INFINITY)).toBeCloseTo(62.5, 5);

    // 4 frames at 20ms -> 50.0 FPS (window fully replaced)
    for (let i = 0; i < 4; i++) {
      counter.recordFrame(20);
    }
    expect(counter.getFps()).toBeCloseTo(50.0, 5);

    counter.reset();
    expect(counter.getFps()).toBe(0);
    expect(counter.getSampleCount()).toBe(0);
  });

  it('tracks tick and FPS readout accurately and formats safely', () => {
    const hotbar = new Hotbar();
    hotbar.updateReadout(1200, 1000 / 60);

    const readout = hotbar.getReadout();
    expect(readout.tick).toBe(1200);
    expect(readout.fps).toBeCloseTo(60, 5);
    expect(readout.targetTps).toBe(TICKS_PER_SECOND);
    expect(hotbar.getFormattedReadout()).toBe('Tick: 1200 | FPS: 60.0');

    hotbar.setFps(58.4);
    expect(hotbar.getFormattedReadout()).toBe('Tick: 1200 | FPS: 58.4');

    expect(formatTickFpsReadout(-5, Number.NaN)).toBe('Tick: 0 | FPS: 0.0');
  });

  it('computes layout, hit-tests slots, and renders toolbar + tick/FPS readout to Canvas 2D', () => {
    const hotbar = new Hotbar();
    hotbar.selectSlot(4);
    hotbar.updateReadout(600, 1000 / 60);

    const width = 1280;
    const height = 720;
    const layout = computeHotbarLayout(width, height, DEFAULT_HOTBAR_SLOTS);
    expect(layout.slotRects).toHaveLength(9);

    // Hit-test center of slot 4
    const slot4 = layout.slotRects[3]!;
    expect(
      hitTestHotbar(slot4.x + slot4.width / 2, slot4.y + slot4.height / 2, width, height)
    ).toBe(4);

    // Hit-test outside toolbar
    expect(hitTestHotbar(10, 10, width, height)).toBeNull();

    // Render with mock context
    const { ctx, texts, fillRects, strokeRects } = createMockCanvasContext();
    renderHotbar(ctx, hotbar.getState(), width, height);

    // Container + 9 slots + readout panel = 11 fillRects & 11 strokeRects
    expect(fillRects).toHaveLength(11);
    expect(strokeRects).toHaveLength(11);

    // Verify all 9 keys, labels, and the Tick/FPS readout text were rendered
    const renderedStrings = texts.map((t) => t.text);
    for (const slot of DEFAULT_HOTBAR_SLOTS) {
      expect(renderedStrings).toContain(String(slot.key));
      expect(renderedStrings).toContain(slot.label);
    }
    expect(renderedStrings).toContain('Tick: 600 | FPS: 60.0');

    // Verify selected slot 4 has highlight stroke color
    const selectedStrokes = strokeRects.filter((r) => r.strokeStyle === '#f6ad55');
    expect(selectedStrokes).toHaveLength(1);
  });
});
