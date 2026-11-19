import { describe, expect, it } from 'vitest';
import {
  type CameraState,
  type Entity,
  type Tile,
  type WorldState,
} from '../src/types/contracts.js';
import {
  DEFAULT_MINIMAP_MARGIN,
  DEFAULT_MINIMAP_SIZE,
  DEFAULT_MINIMAP_STYLE,
  MINIMAP_ENTITY_COLORS,
  MINIMAP_RESOURCE_COLORS,
  MINIMAP_TERRAIN_COLORS,
  Minimap,
  type MinimapCanvasContext,
  MinimapError,
  computeCameraViewportBox,
  computeMinimapRect,
  getTileMinimapColor,
  isPointInMinimap,
  minimapPointToWorld,
  renderMinimap,
} from '../src/render/minimap.js';

interface DrawOp {
  op: string;
  args: number[];
  fillStyle?: string;
  strokeStyle?: string;
  lineWidth?: number;
}

function createMockContext(): { ctx: MinimapCanvasContext; ops: DrawOp[] } {
  const ops: DrawOp[] = [];
  const ctx: MinimapCanvasContext = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    save() {
      ops.push({ op: 'save', args: [] });
    },
    restore() {
      ops.push({ op: 'restore', args: [] });
    },
    beginPath() {
      ops.push({ op: 'beginPath', args: [] });
    },
    rect(x, y, w, h) {
      ops.push({ op: 'rect', args: [x, y, w, h] });
    },
    clip() {
      ops.push({ op: 'clip', args: [] });
    },
    fillRect(x, y, w, h) {
      ops.push({ op: 'fillRect', args: [x, y, w, h], fillStyle: ctx.fillStyle });
    },
    strokeRect(x, y, w, h) {
      ops.push({
        op: 'strokeRect',
        args: [x, y, w, h],
        strokeStyle: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
      });
    },
  };
  return { ctx, ops };
}

function createTestWorld(width = 64, height = 64): WorldState {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        terrain: x < width / 2 ? 'grass' : 'dirt',
        resource: null,
        entityId: null,
      });
    }
  }

  // Add an iron ore patch at (10, 10)
  const oreTile = tiles[10 * width + 10] as Tile;
  oreTile.resource = { type: 'iron_ore', amount: 500, initialAmount: 500 };

  // Add a depleted ore tile at (11, 10)
  const depletedTile = tiles[10 * width + 11] as Tile;
  depletedTile.resource = { type: 'copper_ore', amount: 0, initialAmount: 500 };

  // Add an entity at (20, 20)
  const furnace: Entity = {
    id: 1,
    type: 'stone_furnace',
    position: { x: 20, y: 20 },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    inputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    outputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    fuelInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    fuelEnergyKj: 0,
    activeRecipe: null,
    craftingProgress: 0,
  };
  (tiles[20 * width + 20] as Tile).entityId = 1;

  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width,
    height,
    tiles,
    entities: { 1: furnace },
    nextEntityId: 2,
    powerGrid: { networks: {}, nextNetworkId: 1 },
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

describe('T46: 160x160 Corner Minimap', () => {
  const viewport = { width: 1280, height: 720 };

  describe('computeMinimapRect', () => {
    it('defaults to 160x160 in the top-right corner', () => {
      const rect = computeMinimapRect(viewport);
      expect(rect).toEqual({
        x: 1280 - DEFAULT_MINIMAP_SIZE - DEFAULT_MINIMAP_MARGIN,
        y: DEFAULT_MINIMAP_MARGIN,
        width: 160,
        height: 160,
      });
    });

    it('supports all four corners and custom size/margin', () => {
      expect(computeMinimapRect(viewport, { corner: 'top-left', size: 160, margin: 10 })).toEqual({
        x: 10,
        y: 10,
        width: 160,
        height: 160,
      });
      expect(
        computeMinimapRect(viewport, { corner: 'bottom-left', size: 160, margin: 10 })
      ).toEqual({
        x: 10,
        y: 720 - 160 - 10,
        width: 160,
        height: 160,
      });
      expect(
        computeMinimapRect(viewport, { corner: 'bottom-right', size: 160, margin: 10 })
      ).toEqual({
        x: 1280 - 160 - 10,
        y: 720 - 160 - 10,
        width: 160,
        height: 160,
      });
    });
  });

  describe('computeCameraViewportBox', () => {
    const worldBounds = { width: 64, height: 64 };
    const minimapRect = { x: 1108, y: 12, width: 160, height: 160 };

    it('projects centered camera accurately onto 160x160 minimap', () => {
      // viewport 1280x720 at zoom 32 => 40x22.5 tiles visible
      // scale = 160/64 = 2.5 px/tile => box = 100 x 56.25 px
      const camera: CameraState = { x: 32, y: 32, zoom: 32 };
      const box = computeCameraViewportBox(camera, viewport, worldBounds, minimapRect);

      expect(box.width).toBeCloseTo(100, 6);
      expect(box.height).toBeCloseTo(56.25, 6);
      expect(box.x).toBeCloseTo(minimapRect.x + (32 - 20) * 2.5, 6);
      expect(box.y).toBeCloseTo(minimapRect.y + (32 - 11.25) * 2.5, 6);
    });

    it('shrinks viewport box when zooming in and clamps near map edges', () => {
      const zoomedIn: CameraState = { x: 32, y: 32, zoom: 64 };
      const zoomedOut: CameraState = { x: 32, y: 32, zoom: 16 };
      const boxIn = computeCameraViewportBox(zoomedIn, viewport, worldBounds, minimapRect);
      const boxOut = computeCameraViewportBox(zoomedOut, viewport, worldBounds, minimapRect);

      expect(boxIn.width).toBeLessThan(boxOut.width);
      expect(boxIn.height).toBeLessThan(boxOut.height);

      // Edge clamping at (0, 0)
      const edgeBox = computeCameraViewportBox(
        { x: 0, y: 0, zoom: 32 },
        viewport,
        worldBounds,
        minimapRect
      );
      expect(edgeBox.x).toBe(minimapRect.x);
      expect(edgeBox.y).toBe(minimapRect.y);
      expect(edgeBox.x + edgeBox.width).toBeLessThanOrEqual(minimapRect.x + minimapRect.width);
      expect(edgeBox.y + edgeBox.height).toBeLessThanOrEqual(minimapRect.y + minimapRect.height);
    });

    it('returns zero-size box when camera is completely off-map', () => {
      const box = computeCameraViewportBox(
        { x: -200, y: -200, zoom: 32 },
        viewport,
        worldBounds,
        minimapRect
      );
      expect(box.width).toBe(0);
      expect(box.height).toBe(0);
    });
  });

  describe('minimapPointToWorld & isPointInMinimap', () => {
    const minimapRect = { x: 100, y: 20, width: 160, height: 160 };
    const worldBounds = { width: 64, height: 64 };

    it('maps center and corners accurately and returns null outside', () => {
      expect(isPointInMinimap(180, 100, minimapRect)).toBe(true);
      expect(isPointInMinimap(99, 100, minimapRect)).toBe(false);

      expect(minimapPointToWorld(100, 20, minimapRect, worldBounds)).toEqual({ x: 0, y: 0 });
      expect(minimapPointToWorld(180, 100, minimapRect, worldBounds)).toEqual({ x: 32, y: 32 });
      expect(minimapPointToWorld(260, 180, minimapRect, worldBounds)).toEqual({ x: 64, y: 64 });
      expect(minimapPointToWorld(50, 50, minimapRect, worldBounds)).toBeNull();
    });
  });

  describe('getTileMinimapColor', () => {
    it('prioritizes entity > non-depleted ore > terrain', () => {
      const world = createTestWorld(64, 64);
      const entityTile = world.tiles[20 * 64 + 20] as Tile;
      const oreTile = world.tiles[10 * 64 + 10] as Tile;
      const depletedTile = world.tiles[10 * 64 + 11] as Tile;
      const dirtTile = world.tiles[0 * 64 + 40] as Tile;

      expect(getTileMinimapColor(entityTile, world.entities)).toBe(
        MINIMAP_ENTITY_COLORS.stone_furnace
      );
      expect(getTileMinimapColor(oreTile, world.entities)).toBe(MINIMAP_RESOURCE_COLORS.iron_ore);
      expect(getTileMinimapColor(depletedTile, world.entities)).toBe(MINIMAP_TERRAIN_COLORS.grass);
      expect(getTileMinimapColor(dirtTile, world.entities)).toBe(MINIMAP_TERRAIN_COLORS.dirt);
    });
  });

  describe('renderMinimap & Minimap class', () => {
    it('renders terrain, ores, entities, camera viewport box, and border deterministically', () => {
      const world = createTestWorld(64, 64);
      const camera: CameraState = { x: 32, y: 32, zoom: 32 };

      const run1 = createMockContext();
      const rect1 = renderMinimap(run1.ctx, world, camera, viewport);

      const run2 = createMockContext();
      const rect2 = renderMinimap(run2.ctx, world, camera, viewport);

      expect(rect1).toEqual({ x: 1108, y: 12, width: 160, height: 160 });
      expect(rect1).toEqual(rect2);
      expect(run1.ops).toEqual(run2.ops);

      // Verify clip region matches 160x160 minimap rect
      const clipRectOp = run1.ops.find((o) => o.op === 'rect');
      expect(clipRectOp?.args).toEqual([1108, 12, 160, 160]);

      // Verify entity, ore, and terrain colors were rendered
      const fillColors = new Set(
        run1.ops.filter((o) => o.op === 'fillRect').map((o) => o.fillStyle)
      );
      expect(fillColors.has(DEFAULT_MINIMAP_STYLE.backgroundColor)).toBe(true);
      expect(fillColors.has(MINIMAP_TERRAIN_COLORS.grass)).toBe(true);
      expect(fillColors.has(MINIMAP_TERRAIN_COLORS.dirt)).toBe(true);
      expect(fillColors.has(MINIMAP_RESOURCE_COLORS.iron_ore)).toBe(true);
      expect(fillColors.has(MINIMAP_ENTITY_COLORS.stone_furnace)).toBe(true);
      expect(fillColors.has(DEFAULT_MINIMAP_STYLE.viewportBoxFillColor)).toBe(true);

      // Verify viewport box stroke and outer border stroke
      const strokeOps = run1.ops.filter((o) => o.op === 'strokeRect');
      expect(strokeOps).toHaveLength(2);
      expect(strokeOps[0]?.strokeStyle).toBe(DEFAULT_MINIMAP_STYLE.viewportBoxColor);
      expect(strokeOps[1]?.strokeStyle).toBe(DEFAULT_MINIMAP_STYLE.borderColor);
      expect(strokeOps[1]?.args).toEqual([1108, 12, 160, 160]);
    });

    it('Minimap class wrapper delegates cleanly', () => {
      const world = createTestWorld(64, 64);
      const camera: CameraState = { x: 32, y: 32, zoom: 32 };
      const minimap = new Minimap({ corner: 'bottom-right', size: 160, margin: 16 });

      const rect = minimap.getRect(viewport);
      expect(rect).toEqual({ x: 1104, y: 544, width: 160, height: 160 });
      expect(minimap.containsPoint(1184, 624, viewport)).toBe(true);
      expect(minimap.screenToWorld(1184, 624, viewport, { width: 64, height: 64 })).toEqual({
        x: 32,
        y: 32,
      });

      const { ctx } = createMockContext();
      expect(minimap.render(ctx, world, camera, viewport)).toEqual(rect);
    });
  });

  describe('Fail-Closed Validation', () => {
    it('throws MinimapError on invalid dimensions, camera, or world state', () => {
      const world = createTestWorld(64, 64);
      const camera: CameraState = { x: 32, y: 32, zoom: 32 };
      const { ctx } = createMockContext();

      expect(() => computeMinimapRect({ width: 0, height: 720 })).toThrow(MinimapError);
      expect(() => computeMinimapRect(viewport, { size: -10 })).toThrow(MinimapError);
      expect(() => computeMinimapRect(viewport, { margin: -1 })).toThrow(MinimapError);
      expect(() =>
        renderMinimap(ctx, world, { x: Number.NaN, y: 4, zoom: 32 }, viewport)
      ).toThrow(MinimapError);
      expect(() => renderMinimap(ctx, world, { x: 4, y: 4, zoom: 0 }, viewport)).toThrow(
        MinimapError
      );

      const brokenWorld: WorldState = { ...world, tiles: world.tiles.slice(0, 10) };
      expect(() => renderMinimap(ctx, brokenWorld, camera, viewport)).toThrow(MinimapError);
    });
  });
});
