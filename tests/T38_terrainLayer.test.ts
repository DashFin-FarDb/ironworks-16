import { describe, expect, it, vi } from 'vitest';
import type {
  CameraState,
  ResourceNode,
  ResourceType,
  TerrainType,
  Tile,
} from '../src/types/contracts.js';
import { CameraError, createCameraState } from '../src/render/camera.js';
import {
  SpriteAtlas,
  UnknownSpriteError,
  createSpriteAtlas,
} from '../src/render/spriteAtlas.js';
import {
  TerrainLayer,
  TerrainRenderError,
  collectVisibleTerrainTiles,
  computeResourceRichness,
  renderTerrainLayer,
  type TerrainWorldView,
} from '../src/render/terrainLayer.js';

function makeWorld(
  width: number,
  height: number,
  overrides: Array<{
    x: number;
    y: number;
    terrain?: TerrainType;
    resource?: ResourceNode | null;
  }> = []
): TerrainWorldView {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        terrain: 'grass',
        resource: null,
        entityId: null,
      });
    }
  }
  for (const ov of overrides) {
    const idx = ov.y * width + ov.x;
    const tile = tiles[idx];
    if (tile) {
      if (ov.terrain !== undefined) tile.terrain = ov.terrain;
      if (ov.resource !== undefined) tile.resource = ov.resource;
    }
  }
  return { width, height, tiles };
}

interface DrawCall {
  key: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  alpha: number;
}

function createMockContext() {
  const alphaStack: number[] = [];
  let currentAlpha = 1;
  let strokeCount = 0;
  const moveTos: Array<[number, number]> = [];
  const lineTos: Array<[number, number]> = [];

  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    get globalAlpha() {
      return currentAlpha;
    },
    set globalAlpha(v: number) {
      currentAlpha = v;
    },
    save() {
      alphaStack.push(currentAlpha);
    },
    restore() {
      currentAlpha = alphaStack.pop() ?? 1;
    },
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo(x: number, y: number) {
      moveTos.push([x, y]);
    },
    lineTo(x: number, y: number) {
      lineTos.push([x, y]);
    },
    stroke() {
      strokeCount += 1;
    },
  } as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    getStrokeCount: () => strokeCount,
    moveTos,
    lineTos,
  };
}

function spyAtlasDraw(atlas: SpriteAtlas) {
  const calls: DrawCall[] = [];
  const spy = vi.spyOn(atlas, 'draw').mockImplementation((ctx, key, dx, dy, dw = 16, dh = 16) => {
    // Still validate key exists (fail-closed)
    atlas.getSprite(key);
    calls.push({
      key,
      dx,
      dy,
      dw,
      dh,
      alpha: ctx.globalAlpha,
    });
  });
  return { calls, spy };
}

describe('T38: Terrain & Ore-Patch Renderer (src/render/terrainLayer.ts)', () => {
  const atlas = createSpriteAtlas();

  it('culls to visible viewport bounds and renders terrain + ore in row-major order', () => {
    const world = makeWorld(16, 16, [
      {
        x: 4,
        y: 4,
        terrain: 'dirt',
        resource: { type: 'iron_ore', amount: 1000, initialAmount: 1000 },
      },
      {
        x: 5,
        y: 4,
        terrain: 'sand',
        resource: { type: 'copper_ore', amount: 500, initialAmount: 1000 },
      },
      {
        x: 15,
        y: 15,
        terrain: 'water',
        resource: { type: 'coal', amount: 800, initialAmount: 800 },
      },
    ]);

    // Camera centered at (5, 5), zoom 32, viewport 128x64 -> 4x2 tiles: x in [3,6], y in [4,5]
    const camera = createCameraState({ x: 5, y: 5, zoom: 32 });
    const viewport = { width: 128, height: 64 };
    const { ctx } = createMockContext();
    const { calls, spy } = spyAtlasDraw(atlas);

    const stats = renderTerrainLayer(ctx, world, camera, viewport, atlas);
    spy.mockRestore();

    expect(stats.bounds).toEqual({
      minTileX: 3,
      maxTileX: 6,
      minTileY: 4,
      maxTileY: 5,
    });
    expect(stats.tilesRendered).toBe(8);
    expect(stats.resourcesRendered).toBe(2);
    expect(stats.depletedSkipped).toBe(0);

    // Off-screen (15, 15) must not be drawn
    expect(calls.some((c) => c.key === 'terrain:water')).toBe(false);
    expect(calls.some((c) => c.key === 'resource:coal')).toBe(false);

    // Verify exact draw order for row y=4: (3,4), (4,4)+iron, (5,4)+copper, (6,4)
    expect(calls.slice(0, 6).map((c) => c.key)).toEqual([
      'terrain:grass',
      'terrain:dirt',
      'resource:iron_ore',
      'terrain:sand',
      'resource:copper_ore',
      'terrain:grass',
    ]);

    // Full richness ore has alpha 1; 50% depleted ore has attenuated alpha < 1
    const ironCall = calls.find((c) => c.key === 'resource:iron_ore');
    const copperCall = calls.find((c) => c.key === 'resource:copper_ore');
    expect(ironCall?.alpha).toBeCloseTo(1, 5);
    expect(copperCall?.alpha).toBeCloseTo(0.725, 5);
  });

  it('skips depleted ore deposits (amount <= 0) while still rendering underlying terrain', () => {
    const world = makeWorld(4, 4, [
      {
        x: 1,
        y: 1,
        terrain: 'stone_ground',
        resource: { type: 'stone', amount: 0, initialAmount: 500 },
      },
      {
        x: 2,
        y: 1,
        terrain: 'grass',
        resource: { type: 'coal', amount: -5, initialAmount: 500 },
      },
    ]);

    const camera = createCameraState({ x: 2, y: 2, zoom: 16 });
    const viewport = { width: 64, height: 64 };
    const { ctx } = createMockContext();
    const { calls, spy } = spyAtlasDraw(atlas);

    const stats = renderTerrainLayer(ctx, world, camera, viewport, atlas);
    spy.mockRestore();

    expect(stats.tilesRendered).toBe(16);
    expect(stats.resourcesRendered).toBe(0);
    expect(stats.depletedSkipped).toBe(2);
    expect(calls.some((c) => c.key.startsWith('resource:'))).toBe(false);
    expect(calls.some((c) => c.key === 'terrain:stone_ground')).toBe(true);
  });

  it('renders zero tiles when camera viewport is completely off-map', () => {
    const world = makeWorld(8, 8);
    const camera: CameraState = { x: 100, y: 100, zoom: 32 };
    const viewport = { width: 128, height: 128 };
    const { ctx } = createMockContext();
    const { calls, spy } = spyAtlasDraw(atlas);

    const stats = renderTerrainLayer(ctx, world, camera, viewport, atlas);
    spy.mockRestore();

    expect(stats.tilesRendered).toBe(0);
    expect(stats.resourcesRendered).toBe(0);
    expect(stats.depletedSkipped).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('snaps adjacent tiles to contiguous integer pixels with zero seams at fractional camera/zoom', () => {
    const world = makeWorld(6, 6);
    const camera: CameraState = { x: 2.37, y: 2.61, zoom: 23.4 };
    const viewport = { width: 96, height: 96 };
    const { ctx } = createMockContext();
    const { calls, spy } = spyAtlasDraw(atlas);

    const stats = renderTerrainLayer(ctx, world, camera, viewport, atlas, {
      pixelSnap: true,
    });
    spy.mockRestore();

    expect(stats.tilesRendered).toBeGreaterThan(0);
    const cols = stats.bounds.maxTileX - stats.bounds.minTileX + 1;
    for (const c of calls) {
      expect(Number.isInteger(c.dx)).toBe(true);
      expect(Number.isInteger(c.dy)).toBe(true);
      expect(Number.isInteger(c.dw)).toBe(true);
      expect(Number.isInteger(c.dh)).toBe(true);
    }
    // Adjacent horizontal tiles in row 0 must touch exactly: dx + dw === next.dx
    for (let i = 0; i < cols - 1; i++) {
      const curr = calls[i]!;
      const next = calls[i + 1]!;
      expect(curr.dx + curr.dw).toBe(next.dx);
    }
  });

  it('draws optional tile grid overlay when showGrid is enabled', () => {
    const world = makeWorld(4, 4);
    const camera = createCameraState({ x: 2, y: 2, zoom: 16 });
    const viewport = { width: 64, height: 64 };
    const { ctx, getStrokeCount, moveTos, lineTos } = createMockContext();
    const { spy } = spyAtlasDraw(atlas);

    renderTerrainLayer(ctx, world, camera, viewport, atlas, {
      showGrid: true,
      gridColor: 'rgba(255,255,255,0.2)',
    });
    spy.mockRestore();

    expect(getStrokeCount()).toBe(1);
    // 4 cols -> 5 vertical lines; 4 rows -> 5 horizontal lines = 10 segments
    expect(moveTos).toHaveLength(10);
    expect(lineTos).toHaveLength(10);
  });

  it('supports headless pixel-rect rendering directly through SpriteAtlas without mocking draw', () => {
    const world = makeWorld(2, 2, [
      {
        x: 0,
        y: 0,
        terrain: 'grass',
        resource: { type: 'iron_ore', amount: 100, initialAmount: 100 },
      },
    ]);
    const camera = createCameraState({ x: 1, y: 1, zoom: 16 });
    const viewport = { width: 32, height: 32 };
    const { ctx } = createMockContext();

    const stats = renderTerrainLayer(ctx, world, camera, viewport, atlas);
    expect(stats.tilesRendered).toBe(4);
    expect(stats.resourcesRendered).toBe(1);
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it('exposes TerrainLayer wrapper class with default options and per-call overrides', () => {
    const world = makeWorld(4, 4, [
      {
        x: 1,
        y: 1,
        terrain: 'grass',
        resource: { type: 'copper_ore', amount: 250, initialAmount: 1000 },
      },
    ]);
    const camera = createCameraState({ x: 2, y: 2, zoom: 16 });
    const viewport = { width: 64, height: 64 };
    const layer = new TerrainLayer({ showResourceRichness: false });
    const { ctx } = createMockContext();
    const { calls, spy } = spyAtlasDraw(atlas);

    layer.render(ctx, world, camera, viewport, atlas);
    const oreNoFade = calls.find((c) => c.key === 'resource:copper_ore');
    expect(oreNoFade?.alpha).toBe(1);

    calls.length = 0;
    layer.render(ctx, world, camera, viewport, atlas, { showResourceRichness: true });
    spy.mockRestore();

    const oreFade = calls.find((c) => c.key === 'resource:copper_ore');
    expect(oreFade?.alpha).toBeLessThan(1);
  });

  it('provides pure helpers computeResourceRichness and collectVisibleTerrainTiles', () => {
    expect(computeResourceRichness({ type: 'iron_ore', amount: 0, initialAmount: 100 })).toBe(0);
    expect(computeResourceRichness({ type: 'iron_ore', amount: 50, initialAmount: 100 })).toBe(0.5);
    expect(computeResourceRichness({ type: 'iron_ore', amount: 200, initialAmount: 100 })).toBe(1);

    const world = makeWorld(8, 8);
    const camera = createCameraState({ x: 4, y: 4, zoom: 32 });
    const visible = collectVisibleTerrainTiles(world, camera, { width: 64, height: 64 });
    expect(visible).toHaveLength(4);
    expect(visible.map((t) => `${t.x},${t.y}`)).toEqual(['3,3', '4,3', '3,4', '4,4']);
  });

  it('fails closed on invalid world dimensions, mismatched tile arrays, or unknown sprites', () => {
    const { ctx } = createMockContext();
    const camera = createCameraState({ x: 1, y: 1, zoom: 16 });
    const viewport = { width: 32, height: 32 };

    expect(() =>
      renderTerrainLayer(ctx, { width: 0, height: 4, tiles: [] }, camera, viewport, atlas)
    ).toThrow(TerrainRenderError);

    expect(() =>
      renderTerrainLayer(ctx, { width: 2, height: 2, tiles: [] }, camera, viewport, atlas)
    ).toThrow(TerrainRenderError);

    expect(() =>
      renderTerrainLayer(ctx, makeWorld(2, 2), { x: 1, y: 1, zoom: 0 }, viewport, atlas)
    ).toThrow(CameraError);

    const badWorld = makeWorld(2, 2);
    badWorld.tiles[0]!.terrain = 'lava' as TerrainType;
    expect(() =>
      renderTerrainLayer(ctx, badWorld, camera, viewport, atlas)
    ).toThrow(UnknownSpriteError);

    const badOreWorld = makeWorld(2, 2, [
      {
        x: 0,
        y: 0,
        resource: { type: 'uranium' as ResourceType, amount: 100, initialAmount: 100 },
      },
    ]);
    expect(() =>
      renderTerrainLayer(ctx, badOreWorld, camera, viewport, atlas)
    ).toThrow(UnknownSpriteError);
  });
});
