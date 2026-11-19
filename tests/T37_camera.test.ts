import { describe, expect, it } from 'vitest';
import {
  Camera,
  CameraError,
  DEFAULT_CAMERA_ZOOM,
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  centerCameraOn,
  createCameraState,
  getVisibleTileBounds,
  isFootprintVisible,
  isTileVisible,
  panCamera,
  panCameraByPixels,
  screenToTile,
  screenToTileBounded,
  screenToWorld,
  tileToScreen,
  worldToScreen,
  zoomCamera,
  zoomCameraAtPoint,
} from '../src/render/camera.js';

const VIEWPORT = { width: 640, height: 480 };
const WORLD_BOUNDS = { width: 64, height: 64 };

describe('T37: Camera, Screen-to-Tile Transforms & Viewport Culling', () => {
  describe('Creation & Clamping', () => {
    it('creates default camera centered on 64x64 world with default zoom', () => {
      const cam = createCameraState();
      expect(cam).toEqual({ x: 32, y: 32, zoom: DEFAULT_CAMERA_ZOOM });
    });

    it('clamps initial position to worldBounds and zoom to [minZoom, maxZoom]', () => {
      const cam = createCameraState({
        x: -10,
        y: 200,
        zoom: 500,
        worldBounds: WORLD_BOUNDS,
      });
      expect(cam).toEqual({ x: 0, y: 64, zoom: MAX_CAMERA_ZOOM });

      const camMin = createCameraState({ zoom: 1 });
      expect(camMin.zoom).toBe(MIN_CAMERA_ZOOM);
    });
  });

  describe('Panning & Centering', () => {
    it('pans in tile units and clamps to worldBounds', () => {
      const cam = createCameraState({ x: 10, y: 10, zoom: 32 });
      const panned = panCamera(cam, 5.5, -3.25, WORLD_BOUNDS);
      expect(panned).toEqual({ x: 15.5, y: 6.75, zoom: 32 });

      const clamped = panCamera(cam, -50, 100, WORLD_BOUNDS);
      expect(clamped).toEqual({ x: 0, y: 64, zoom: 32 });
    });

    it('pans in screen pixels scaled by zoom', () => {
      const cam = createCameraState({ x: 32, y: 32, zoom: 32 });
      const panned = panCameraByPixels(cam, 64, -32, WORLD_BOUNDS);
      expect(panned).toEqual({ x: 34, y: 31, zoom: 32 });
    });

    it('centers on a world coordinate with clamping', () => {
      const cam = createCameraState({ x: 10, y: 10, zoom: 24 });
      expect(centerCameraOn(cam, { x: 40, y: 20 }, WORLD_BOUNDS)).toEqual({
        x: 40,
        y: 20,
        zoom: 24,
      });
      expect(centerCameraOn(cam, { x: 99, y: -5 }, WORLD_BOUNDS)).toEqual({
        x: 64,
        y: 0,
        zoom: 24,
      });
    });
  });

  describe('Zooming', () => {
    it('zooms multiplicatively and clamps to limits', () => {
      const cam = createCameraState({ x: 32, y: 32, zoom: 32 });
      expect(zoomCamera(cam, 1.5).zoom).toBe(48);
      expect(zoomCamera(cam, 10).zoom).toBe(MAX_CAMERA_ZOOM);
      expect(zoomCamera(cam, 0.01).zoom).toBe(MIN_CAMERA_ZOOM);
    });

    it('zooms toward an anchor screen point keeping world point stationary', () => {
      const cam = createCameraState({ x: 32, y: 32, zoom: 32 });
      const anchor = { x: 120, y: 360 };
      const worldBefore = screenToWorld(cam, anchor, VIEWPORT);

      const zoomed = zoomCameraAtPoint(cam, 2, anchor, VIEWPORT);
      const worldAfter = screenToWorld(zoomed, anchor, VIEWPORT);

      expect(zoomed.zoom).toBe(64);
      expect(worldAfter.x).toBeCloseTo(worldBefore.x, 10);
      expect(worldAfter.y).toBeCloseTo(worldBefore.y, 10);
    });
  });

  describe('Coordinate Transforms', () => {
    it('maps camera center to viewport center and round-trips world <-> screen', () => {
      const cam = createCameraState({ x: 32, y: 32, zoom: 32 });
      expect(worldToScreen(cam, { x: 32, y: 32 }, VIEWPORT)).toEqual({
        x: 320,
        y: 240,
      });

      const pt = { x: 18.75, y: 41.25 };
      const screen = worldToScreen(cam, pt, VIEWPORT);
      const back = screenToWorld(cam, screen, VIEWPORT);
      expect(back.x).toBeCloseTo(pt.x, 10);
      expect(back.y).toBeCloseTo(pt.y, 10);
    });

    it('maps tile top-left to screen and screen pixels to integer tile coords', () => {
      const cam = createCameraState({ x: 10, y: 10, zoom: 16 });
      // Viewport 640x480 => center (320, 240) corresponds to world (10, 10)
      expect(tileToScreen(cam, { x: 10, y: 10 }, VIEWPORT)).toEqual({ x: 320, y: 240 });
      expect(screenToTile(cam, { x: 320, y: 240 }, VIEWPORT)).toEqual({ x: 10, y: 10 });
      expect(screenToTile(cam, { x: 335.9, y: 255.9 }, VIEWPORT)).toEqual({ x: 10, y: 10 });
      expect(screenToTile(cam, { x: 336, y: 256 }, VIEWPORT)).toEqual({ x: 11, y: 11 });
      expect(screenToTile(cam, { x: 319.9, y: 239.9 }, VIEWPORT)).toEqual({ x: 9, y: 9 });
    });

    it('returns null from screenToTileBounded when outside worldBounds', () => {
      const cam = createCameraState({ x: 0, y: 0, zoom: 32 });
      // Screen (0, 0) maps to (-10, -7.5) -> out of bounds
      expect(screenToTileBounded(cam, { x: 0, y: 0 }, VIEWPORT, WORLD_BOUNDS)).toBeNull();
      // Screen (320, 240) maps to (0, 0) -> in bounds
      expect(screenToTileBounded(cam, { x: 320, y: 240 }, VIEWPORT, WORLD_BOUNDS)).toEqual({
        x: 0,
        y: 0,
      });
    });
  });

  describe('Viewport Culling', () => {
    it('computes exact inclusive visible tile bounds without over-fetching on exact edges', () => {
      // Viewport 320x160 at zoom 32 => 10x5 tiles. Centered at (20, 20) => [15, 25) x [17.5, 22.5)
      const cam = createCameraState({ x: 20, y: 20, zoom: 32 });
      const bounds = getVisibleTileBounds(cam, { width: 320, height: 160 }, WORLD_BOUNDS);
      expect(bounds).toEqual({
        minTileX: 15,
        maxTileX: 24,
        minTileY: 17,
        maxTileY: 22,
      });
    });

    it('applies paddingTiles and clamps to worldBounds', () => {
      const cam = createCameraState({ x: 2, y: 2, zoom: 32 });
      const bounds = getVisibleTileBounds(cam, { width: 320, height: 160 }, WORLD_BOUNDS, 2);
      expect(bounds).toEqual({
        minTileX: 0,
        maxTileX: 8,
        minTileY: 0,
        maxTileY: 6,
      });
    });

    it('returns empty bounds when viewport is completely outside worldBounds', () => {
      const cam = createCameraState({ x: -100, y: -100, zoom: 32 });
      const bounds = getVisibleTileBounds(cam, { width: 320, height: 160 }, WORLD_BOUNDS);
      expect(bounds.maxTileX).toBeLessThan(bounds.minTileX);
      expect(bounds.maxTileY).toBeLessThan(bounds.minTileY);
      expect(isTileVisible({ x: 0, y: 0 }, bounds)).toBe(false);
      expect(isFootprintVisible({ x: 0, y: 0 }, { width: 2, height: 2 }, bounds)).toBe(false);
    });

    it('culls single tiles and multi-tile entity footprints accurately', () => {
      const bounds = { minTileX: 10, maxTileX: 20, minTileY: 10, maxTileY: 20 };

      expect(isTileVisible({ x: 10, y: 10 }, bounds)).toBe(true);
      expect(isTileVisible({ x: 9, y: 10 }, bounds)).toBe(false);

      // 2x2 entity at (9, 9) covers (9..10, 9..10) -> overlaps corner (10, 10)
      expect(isFootprintVisible({ x: 9, y: 9 }, { width: 2, height: 2 }, bounds)).toBe(true);
      // 2x2 entity at (8, 9) covers (8..9, 9..10) -> completely left of minTileX=10
      expect(isFootprintVisible({ x: 8, y: 9 }, { width: 2, height: 2 }, bounds)).toBe(false);
      // 3x3 entity at (20, 20) covers (20..22, 20..22) -> overlaps (20, 20)
      expect(isFootprintVisible({ x: 20, y: 20 }, { width: 3, height: 3 }, bounds)).toBe(true);
      expect(isFootprintVisible({ x: 21, y: 20 }, { width: 3, height: 3 }, bounds)).toBe(false);
    });
  });

  describe('Stateful Camera Class', () => {
    it('supports pan, zoomAt, transforms, and culling with worldBounds', () => {
      const camera = new Camera({ x: 32, y: 32, zoom: 32, worldBounds: WORLD_BOUNDS });
      camera.pan(2, -4);
      expect(camera.x).toBe(34);
      expect(camera.y).toBe(28);

      const anchor = { x: 400, y: 100 };
      const before = camera.screenToWorld(anchor, VIEWPORT);
      camera.zoomAt(1.5, anchor, VIEWPORT);
      const after = camera.screenToWorld(anchor, VIEWPORT);
      expect(camera.zoom).toBe(48);
      expect(after.x).toBeCloseTo(before.x, 10);
      expect(after.y).toBeCloseTo(before.y, 10);

      const visible = camera.getVisibleTileBounds(VIEWPORT);
      expect(visible.minTileX).toBeGreaterThanOrEqual(0);
      expect(visible.maxTileX).toBeLessThan(WORLD_BOUNDS.width);
    });
  });

  describe('Fail-Closed Validation', () => {
    it('throws CameraError on invalid zoom, viewport, NaN, or bounds', () => {
      expect(() => createCameraState({ zoom: 0 })).toThrow(CameraError);
      expect(() => createCameraState({ zoom: -16 })).toThrow(CameraError);
      expect(() => createCameraState({ x: Number.NaN })).toThrow(CameraError);
      expect(() => createCameraState({ minZoom: 64, maxZoom: 16 })).toThrow(CameraError);

      const cam = createCameraState();
      expect(() => zoomCamera(cam, 0)).toThrow(CameraError);
      expect(() => zoomCamera(cam, -2)).toThrow(CameraError);
      expect(() => worldToScreen(cam, { x: 0, y: 0 }, { width: 0, height: 480 })).toThrow(
        CameraError
      );
      expect(() => getVisibleTileBounds(cam, VIEWPORT, WORLD_BOUNDS, -1)).toThrow(CameraError);
      expect(() =>
        getVisibleTileBounds(cam, VIEWPORT, { width: 0, height: 64 })
      ).toThrow(CameraError);
    });
  });
});
