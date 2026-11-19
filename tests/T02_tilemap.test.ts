import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_HEIGHT,
  DEFAULT_MAP_WIDTH,
  TileMap,
} from '../src/core/tilemap';
import {
  OutOfBoundsError,
  ResourceNode,
  SimulationError,
} from '../src/types/contracts';

describe('T02: TileMap', () => {
  describe('initialization & bounds', () => {
    it('creates a 64x64 grid by default with grass terrain and empty tiles', () => {
      const map = new TileMap();
      expect(map.width).toBe(DEFAULT_MAP_WIDTH);
      expect(map.height).toBe(DEFAULT_MAP_HEIGHT);
      expect(map.width).toBe(64);
      expect(map.height).toBe(64);
      expect(map.getTiles()).toHaveLength(64 * 64);

      const origin = map.getTile(0, 0);
      expect(origin).toEqual({
        x: 0,
        y: 0,
        terrain: 'grass',
        resource: null,
        entityId: null,
      });

      const corner = map.getTile(63, 63);
      expect(corner.x).toBe(63);
      expect(corner.y).toBe(63);
      expect(map.indexOf(63, 63)).toBe(63 * 64 + 63);
    });

    it('supports custom dimensions and default terrain', () => {
      const map = new TileMap(8, 4, 'dirt');
      expect(map.bounds).toEqual({ width: 8, height: 4 });
      expect(map.getTerrain(7, 3)).toBe('dirt');
      expect(map.getTileAt({ x: 3, y: 2 }).x).toBe(3);
    });

    it('fails closed on invalid grid dimensions', () => {
      expect(() => new TileMap(0, 10)).toThrow(SimulationError);
      expect(() => new TileMap(10, -1)).toThrow(SimulationError);
      expect(() => new TileMap(4.5, 4)).toThrow(SimulationError);
      expect(() => new TileMap(Number.NaN, 4)).toThrow(SimulationError);
    });
  });

  describe('fail-closed out-of-bounds queries', () => {
    const map = new TileMap(16, 16);
    const badCoords: Array<[number, number]> = [
      [-1, 0],
      [0, -1],
      [16, 0],
      [0, 16],
      [100, 100],
      [1.5, 2],
      [2, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
    ];

    it('reports false from inBounds for all invalid coordinates', () => {
      for (const [x, y] of badCoords) {
        expect(map.inBounds(x, y)).toBe(false);
      }
      expect(map.inBounds(0, 0)).toBe(true);
      expect(map.inBounds(15, 15)).toBe(true);
    });

    it('throws OutOfBoundsError on all out-of-bounds reads and writes', () => {
      for (const [x, y] of badCoords) {
        expect(() => map.getTile(x, y)).toThrow(OutOfBoundsError);
        expect(() => map.getTerrain(x, y)).toThrow(OutOfBoundsError);
        expect(() => map.setTerrain(x, y, 'sand')).toThrow(OutOfBoundsError);
        expect(() => map.getResource(x, y)).toThrow(OutOfBoundsError);
        expect(() => map.setResource(x, y, null)).toThrow(OutOfBoundsError);
        expect(() => map.getEntityAt(x, y)).toThrow(OutOfBoundsError);
        expect(() => map.isOccupied(x, y)).toThrow(OutOfBoundsError);
        expect(() => map.setEntityAt(x, y, 1)).toThrow(OutOfBoundsError);
        expect(() => map.occupy(x, y, 1)).toThrow(OutOfBoundsError);
        expect(() => map.getNeighbors(x, y)).toThrow(OutOfBoundsError);
      }
    });
  });

  describe('terrain & ore deposits', () => {
    it('updates terrain and checks buildability', () => {
      const map = new TileMap(8, 8);
      expect(map.isBuildableTerrain(2, 2)).toBe(true);

      map.setTerrain(2, 2, 'water');
      expect(map.getTerrain(2, 2)).toBe('water');
      expect(map.isBuildableTerrain(2, 2)).toBe(false);

      map.setTerrain(2, 2, 'stone_ground');
      expect(map.isBuildableTerrain(2, 2)).toBe(true);
    });

    it('stores, queries, and validates resource nodes', () => {
      const map = new TileMap(8, 8);
      expect(map.getResource(3, 3)).toBeNull();
      expect(map.hasResource(3, 3)).toBe(false);

      const iron: ResourceNode = {
        type: 'iron_ore',
        amount: 500,
        initialAmount: 500,
      };
      map.setResource(3, 3, iron);
      expect(map.getResource(3, 3)).toEqual(iron);
      expect(map.hasResource(3, 3)).toBe(true);
      expect(map.hasResource(3, 3, 'iron_ore')).toBe(true);
      expect(map.hasResource(3, 3, 'copper_ore')).toBe(false);

      // Depleted ore returns false for hasResource
      iron.amount = 0;
      expect(map.hasResource(3, 3)).toBe(false);

      // Invalid resource amounts fail closed
      expect(() =>
        map.setResource(4, 4, {
          type: 'coal',
          amount: -10,
          initialAmount: 100,
        })
      ).toThrow(SimulationError);
      expect(() =>
        map.setResource(4, 4, {
          type: 'coal',
          amount: Number.NaN,
          initialAmount: 100,
        })
      ).toThrow(SimulationError);
    });
  });

  describe('O(1) entity occupancy & multi-tile footprints', () => {
    it('sets, looks up, and clears single-tile entity occupancy', () => {
      const map = new TileMap(16, 16);
      expect(map.getEntityAt(5, 5)).toBeNull();
      expect(map.isOccupied(5, 5)).toBe(false);

      map.setEntityAt(5, 5, 42);
      expect(map.getEntityAt(5, 5)).toBe(42);
      expect(map.isOccupied(5, 5)).toBe(true);
      expect(map.getEntityCoords(42)).toEqual([{ x: 5, y: 5 }]);

      // Setting another entity on an occupied tile fails closed
      expect(() => map.setEntityAt(5, 5, 99)).toThrow(SimulationError);
      expect(map.getEntityAt(5, 5)).toBe(42);

      // Clearing via clearEntity frees the tile
      expect(map.clearEntity(42)).toBe(1);
      expect(map.getEntityAt(5, 5)).toBeNull();
      expect(map.isOccupied(5, 5)).toBe(false);
      expect(map.getEntityCoords(42)).toEqual([]);
    });

    it('occupies and clears multi-tile footprints atomically', () => {
      const map = new TileMap(10, 10);
      map.occupy(2, 3, 7, { width: 2, height: 3 });

      expect(map.getEntityCoords(7)).toHaveLength(6);
      expect(map.getEntityAt(2, 3)).toBe(7);
      expect(map.getEntityAt(3, 5)).toBe(7);
      expect(map.getEntityAt(4, 3)).toBeNull();

      // Overlapping footprint fails closed without partial mutation
      expect(() => map.occupy(3, 4, 8, { width: 2, height: 2 })).toThrow(
        SimulationError
      );
      expect(map.getEntityAt(4, 4)).toBeNull();
      expect(map.getEntityCoords(8)).toEqual([]);

      // Footprint extending out of bounds fails closed without partial mutation
      expect(() => map.occupy(9, 9, 9, { width: 2, height: 2 })).toThrow(
        OutOfBoundsError
      );
      expect(map.getEntityAt(9, 9)).toBeNull();

      expect(map.clearEntity(7)).toBe(6);
      expect(map.isOccupied(2, 3)).toBe(false);
      expect(map.isOccupied(3, 5)).toBe(false);
    });

    it('checks placement feasibility via canPlace without throwing on OOB or water', () => {
      const map = new TileMap(8, 8);
      map.setTerrain(4, 4, 'water');
      map.setEntityAt(1, 1, 10);

      expect(map.canPlace(0, 0, { width: 1, height: 1 })).toBe(true);
      expect(map.canPlace(0, 0, { width: 2, height: 2 })).toBe(false); // hits entity at (1,1)
      expect(map.canPlace(3, 3, { width: 2, height: 2 })).toBe(false); // hits water at (4,4)
      expect(map.canPlace(7, 7, { width: 2, height: 1 })).toBe(false); // OOB
      expect(map.canPlace(-1, 0)).toBe(false); // OOB
    });
  });

  describe('fromTiles & neighbors', () => {
    it('reconstructs a TileMap from a flat Tile[] array with occupancy index intact', () => {
      const original = new TileMap(6, 6);
      original.setTerrain(1, 2, 'sand');
      original.setResource(1, 2, {
        type: 'stone',
        amount: 250,
        initialAmount: 250,
      });
      original.occupy(3, 3, 55, { width: 2, height: 2 });

      const restored = TileMap.fromTiles(6, 6, original.getTiles());
      expect(restored.getTerrain(1, 2)).toBe('sand');
      expect(restored.getResource(1, 2)?.amount).toBe(250);
      expect(restored.getEntityAt(4, 4)).toBe(55);
      expect(restored.getEntityCoords(55)).toHaveLength(4);
      expect(restored.clearEntity(55)).toBe(4);
    });

    it('fails closed in fromTiles when tile array length or coordinates are invalid', () => {
      const map = new TileMap(4, 4);
      expect(() => TileMap.fromTiles(4, 4, map.getTiles().slice(0, 10))).toThrow(
        SimulationError
      );

      const corrupted = map.getTiles().map((t) => ({ ...t }));
      corrupted[0] = { ...corrupted[0]!, x: 99 };
      expect(() => TileMap.fromTiles(4, 4, corrupted)).toThrow(SimulationError);
    });

    it('returns deterministic N, E, S, W in-bounds neighbors', () => {
      const map = new TileMap(5, 5);
      expect(
        map.getNeighbors(2, 2).map((t) => [t.x, t.y])
      ).toEqual([
        [2, 1], // N
        [3, 2], // E
        [2, 3], // S
        [1, 2], // W
      ]);

      expect(
        map.getNeighbors(0, 0).map((t) => [t.x, t.y])
      ).toEqual([
        [1, 0], // E
        [0, 1], // S
      ]);
    });
  });
});
