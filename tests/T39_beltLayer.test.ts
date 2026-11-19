import { describe, expect, it, vi } from 'vitest';
import {
  BELT_LANE_LATERAL_OFFSET,
  DEFAULT_BELT_TICKS_PER_FRAME,
  computeBeltItemWorldPosition,
  computeSplitterItemWorldPosition,
  getBeltAnimationFrame,
  renderBeltLayer,
} from '../src/render/beltLayer.js';
import { createCameraState } from '../src/render/camera.js';
import { createSpriteAtlas, type SpriteAtlas } from '../src/render/spriteAtlas.js';
import {
  SimulationError,
  type BeltEntity,
  type SplitterEntity,
  type UndergroundBeltEntity,
  type WorldState,
} from '../src/types/contracts.js';

function createMockWorld(tick = 0): WorldState {
  return {
    schemaVersion: 1,
    seed: 1616,
    tick,
    width: 64,
    height: 64,
    tiles: [],
    entities: {},
    nextEntityId: 1,
    powerGrid: { networks: {}, nextNetworkId: 1 },
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

function createBelt(
  id: number,
  x: number,
  y: number,
  direction: BeltEntity['direction'] = 'E',
  shape: BeltEntity['shape'] = 'straight',
  leftItems: BeltEntity['leftLane']['items'] = [],
  rightItems: BeltEntity['rightLane']['items'] = []
): BeltEntity {
  return {
    id,
    type: 'transport_belt',
    position: { x, y },
    direction,
    shape,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    leftLane: { items: leftItems },
    rightLane: { items: rightItems },
  };
}

function createSplitter(
  id: number,
  x: number,
  y: number,
  direction: SplitterEntity['direction'] = 'E',
  leftItems: SplitterEntity['leftLane']['items'] = [],
  rightItems: SplitterEntity['rightLane']['items'] = []
): SplitterEntity {
  const footprint =
    direction === 'N' || direction === 'S'
      ? { width: 2, height: 1 }
      : { width: 1, height: 2 };
  return {
    id,
    type: 'splitter',
    position: { x, y },
    direction,
    footprint,
    powerNetworkId: null,
    active: true,
    nextOutputIndex: 0,
    leftLane: { items: leftItems },
    rightLane: { items: rightItems },
  };
}

function createUndergroundBelt(
  id: number,
  x: number,
  y: number,
  direction: UndergroundBeltEntity['direction'] = 'E',
  mode: UndergroundBeltEntity['mode'] = 'input'
): UndergroundBeltEntity {
  return {
    id,
    type: 'underground_belt',
    position: { x, y },
    direction,
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    mode,
    pairedEntityId: null,
    transitQueue: [],
  };
}

function createMockCtx(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    imageSmoothingEnabled: false,
    fillRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('T39: beltLayer', () => {
  describe('getBeltAnimationFrame', () => {
    it('cycles deterministically through 0..3 every 8 ticks by default', () => {
      expect(DEFAULT_BELT_TICKS_PER_FRAME).toBe(8);
      expect(getBeltAnimationFrame(0)).toBe(0);
      expect(getBeltAnimationFrame(7)).toBe(0);
      expect(getBeltAnimationFrame(8)).toBe(1);
      expect(getBeltAnimationFrame(15)).toBe(1);
      expect(getBeltAnimationFrame(16)).toBe(2);
      expect(getBeltAnimationFrame(24)).toBe(3);
      expect(getBeltAnimationFrame(32)).toBe(0);
      expect(getBeltAnimationFrame(40)).toBe(1);
    });

    it('supports custom ticksPerFrame', () => {
      expect(getBeltAnimationFrame(0, 4)).toBe(0);
      expect(getBeltAnimationFrame(4, 4)).toBe(1);
      expect(getBeltAnimationFrame(8, 4)).toBe(2);
      expect(getBeltAnimationFrame(12, 4)).toBe(3);
      expect(getBeltAnimationFrame(16, 4)).toBe(0);
    });

    it('fails closed on invalid tick or ticksPerFrame', () => {
      expect(() => getBeltAnimationFrame(-1)).toThrow(SimulationError);
      expect(() => getBeltAnimationFrame(Number.NaN)).toThrow(SimulationError);
      expect(() => getBeltAnimationFrame(0, 0)).toThrow(SimulationError);
      expect(() => getBeltAnimationFrame(0, -4)).toThrow(SimulationError);
    });
  });

  describe('computeBeltItemWorldPosition', () => {
    it('interpolates straight Eastbound belt lanes accurately', () => {
      const belt = createBelt(1, 10, 20, 'E', 'straight');
      const leftStart = computeBeltItemWorldPosition(belt, 'left', 0);
      const leftMid = computeBeltItemWorldPosition(belt, 'left', 0.5);
      const leftEnd = computeBeltItemWorldPosition(belt, 'left', 1);
      const rightMid = computeBeltItemWorldPosition(belt, 'right', 0.5);

      expect(leftStart.x).toBeCloseTo(10, 6);
      expect(leftMid.x).toBeCloseTo(10.5, 6);
      expect(leftEnd.x).toBeCloseTo(11, 6);
      expect(leftMid.y).toBeCloseTo(20.5 - BELT_LANE_LATERAL_OFFSET, 6);
      expect(rightMid.y).toBeCloseTo(20.5 + BELT_LANE_LATERAL_OFFSET, 6);
    });

    it('interpolates straight North/South/West belts along their forward axes', () => {
      const north = createBelt(1, 5, 5, 'N', 'straight');
      expect(computeBeltItemWorldPosition(north, 'left', 0).y).toBeCloseTo(6, 6);
      expect(computeBeltItemWorldPosition(north, 'left', 1).y).toBeCloseTo(5, 6);
      expect(computeBeltItemWorldPosition(north, 'left', 0.5).x).toBeCloseTo(
        5.5 - BELT_LANE_LATERAL_OFFSET,
        6
      );

      const south = createBelt(2, 5, 5, 'S', 'straight');
      expect(computeBeltItemWorldPosition(south, 'right', 0).y).toBeCloseTo(5, 6);
      expect(computeBeltItemWorldPosition(south, 'right', 1).y).toBeCloseTo(6, 6);

      const west = createBelt(3, 5, 5, 'W', 'straight');
      expect(computeBeltItemWorldPosition(west, 'left', 0).x).toBeCloseTo(6, 6);
      expect(computeBeltItemWorldPosition(west, 'left', 1).x).toBeCloseTo(5, 6);
    });

    it('maintains seamless lane continuity through curve_left and curve_right corners', () => {
      // Southbound feeder at (10, 9) -> curve_left Eastbound at (10, 10) -> Eastbound at (11, 10)
      const feederN = createBelt(1, 10, 9, 'S', 'straight');
      const curveLeft = createBelt(2, 10, 10, 'E', 'curve_left');
      const downstreamE = createBelt(3, 11, 10, 'E', 'straight');

      for (const lane of ['left', 'right'] as const) {
        const feederExit = computeBeltItemWorldPosition(feederN, lane, 1);
        const curveEntry = computeBeltItemWorldPosition(curveLeft, lane, 0);
        const curveExit = computeBeltItemWorldPosition(curveLeft, lane, 1);
        const nextEntry = computeBeltItemWorldPosition(downstreamE, lane, 0);

        expect(curveEntry.x).toBeCloseTo(feederExit.x, 6);
        expect(curveEntry.y).toBeCloseTo(feederExit.y, 6);
        expect(curveExit.x).toBeCloseTo(nextEntry.x, 6);
        expect(curveExit.y).toBeCloseTo(nextEntry.y, 6);
      }

      // Northbound feeder at (10, 11) -> curve_right Eastbound at (10, 10) -> Eastbound at (11, 10)
      const feederS = createBelt(4, 10, 11, 'N', 'straight');
      const curveRight = createBelt(5, 10, 10, 'E', 'curve_right');

      for (const lane of ['left', 'right'] as const) {
        const feederExit = computeBeltItemWorldPosition(feederS, lane, 1);
        const curveEntry = computeBeltItemWorldPosition(curveRight, lane, 0);
        const curveExit = computeBeltItemWorldPosition(curveRight, lane, 1);
        const nextEntry = computeBeltItemWorldPosition(downstreamE, lane, 0);

        expect(curveEntry.x).toBeCloseTo(feederExit.x, 6);
        expect(curveEntry.y).toBeCloseTo(feederExit.y, 6);
        expect(curveExit.x).toBeCloseTo(nextEntry.x, 6);
        expect(curveExit.y).toBeCloseTo(nextEntry.y, 6);
      }
    });

    it('computes splitter item world coordinates centered on its 2-tile footprint', () => {
      const splitter = createSplitter(1, 10, 10, 'E');
      const leftMid = computeSplitterItemWorldPosition(splitter, 'left', 0.5);
      expect(leftMid.x).toBeCloseTo(10.5, 6);
      expect(leftMid.y).toBeCloseTo(11 - BELT_LANE_LATERAL_OFFSET, 6);
    });
  });

  describe('renderBeltLayer', () => {
    it('draws tick-synced belt frames first and moving lane items in pass 2', () => {
      const world = createMockWorld(16); // frame 2 at 8 ticks/frame
      world.entities[1] = createBelt(
        1,
        10,
        10,
        'E',
        'straight',
        [{ itemId: 'iron_ore', offset: 0.25 }],
        [{ itemId: 'copper_ore', offset: 0.75 }]
      );
      world.entities[2] = createBelt(2, 11, 10, 'E', 'curve_left', [
        { itemId: 'coal', offset: 0.5 },
      ]);

      const camera = createCameraState({ x: 10.5, y: 10.5, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const ctx = createMockCtx();
      const atlas = createSpriteAtlas();
      const drawSpy = vi.spyOn(atlas, 'draw');

      const stats = renderBeltLayer(ctx, world, camera, viewport, atlas);

      expect(stats).toEqual({
        animationFrame: 2,
        beltsDrawn: 2,
        splittersDrawn: 0,
        undergroundBeltsDrawn: 0,
        itemsDrawn: 3,
      });

      const drawnKeys = drawSpy.mock.calls.map((call) => call[1]);
      // Pass 1: all belts drawn first with frame 2
      expect(drawnKeys.slice(0, 2)).toEqual([
        'belt:straight:E:2',
        'belt:curve_left:E:2',
      ]);
      // Pass 2: all lane items drawn on top
      expect(drawnKeys.slice(2)).toEqual([
        'item:iron_ore',
        'item:copper_ore',
        'item:coal',
      ]);
    });

    it('advances belt frame and item screen position as simulation ticks progress', () => {
      const world = createMockWorld(0);
      const belt = createBelt(1, 10, 10, 'E', 'straight', [
        { itemId: 'iron_plate', offset: 0.1 },
      ]);
      world.entities[1] = belt;

      const camera = createCameraState({ x: 10.5, y: 10.5, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const ctx = createMockCtx();
      const atlas = createSpriteAtlas();
      const drawSpy = vi.spyOn(atlas, 'draw');

      const statsT0 = renderBeltLayer(ctx, world, camera, viewport, atlas);
      const itemCallT0 = drawSpy.mock.calls.find((c) => c[1] === 'item:iron_plate')!;
      const x0 = itemCallT0[2] as number;

      drawSpy.mockClear();
      world.tick = 8;
      belt.leftLane.items[0]!.offset = 0.6;

      const statsT8 = renderBeltLayer(ctx, world, camera, viewport, atlas);
      const itemCallT8 = drawSpy.mock.calls.find((c) => c[1] === 'item:iron_plate')!;
      const x8 = itemCallT8[2] as number;

      expect(statsT0.animationFrame).toBe(0);
      expect(statsT8.animationFrame).toBe(1);
      expect(x8 - x0).toBeCloseTo(0.5 * 32, 5);
    });

    it('culls off-screen belts, splitters, underground belts, and their items', () => {
      const world = createMockWorld(0);
      // Visible entities around (10, 10)
      world.entities[1] = createBelt(1, 10, 10, 'E', 'straight', [
        { itemId: 'iron_ore', offset: 0.5 },
      ]);
      world.entities[2] = createSplitter(2, 11, 10, 'E', [
        { itemId: 'iron_gear', offset: 0.5 },
      ]);
      world.entities[3] = createUndergroundBelt(3, 12, 10, 'E', 'input');

      // Far off-screen entities at (55, 55)
      world.entities[4] = createBelt(4, 55, 55, 'S', 'straight', [
        { itemId: 'coal', offset: 0.5 },
      ]);
      world.entities[5] = createSplitter(5, 56, 55, 'N', [
        { itemId: 'stone', offset: 0.5 },
      ]);
      world.entities[6] = createUndergroundBelt(6, 58, 55, 'W', 'output');

      const camera = createCameraState({ x: 11, y: 10.5, zoom: 32 });
      const viewport = { width: 256, height: 192 };
      const ctx = createMockCtx();
      const atlas: SpriteAtlas = createSpriteAtlas();

      const stats = renderBeltLayer(ctx, world, camera, viewport, atlas);

      expect(stats.beltsDrawn).toBe(1);
      expect(stats.splittersDrawn).toBe(1);
      expect(stats.undergroundBeltsDrawn).toBe(1);
      expect(stats.itemsDrawn).toBe(2);
    });

    it('respects drawItems: false and fails closed on invalid options', () => {
      const world = createMockWorld(0);
      world.entities[1] = createBelt(1, 10, 10, 'E', 'straight', [
        { itemId: 'red_science', offset: 0.5 },
      ]);

      const camera = createCameraState({ x: 10.5, y: 10.5, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const ctx = createMockCtx();
      const atlas = createSpriteAtlas();

      const stats = renderBeltLayer(ctx, world, camera, viewport, atlas, {
        drawItems: false,
      });
      expect(stats.beltsDrawn).toBe(1);
      expect(stats.itemsDrawn).toBe(0);

      expect(() =>
        renderBeltLayer(ctx, world, camera, viewport, atlas, { itemScale: 0 })
      ).toThrow(SimulationError);
    });
  });
});
