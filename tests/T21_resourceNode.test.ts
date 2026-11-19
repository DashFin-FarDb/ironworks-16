import { describe, expect, it } from 'vitest';
import { TileMap } from '../src/core/tilemap';
import {
  OutOfBoundsError,
  ResourceNode,
  ResourceType,
  SimulationError,
} from '../src/types/contracts';
import {
  RESOURCE_TYPES,
  assertValidResourceNode,
  createResourceNode,
  getRemainingAmount,
  getRemainingRatio,
  isDepleted,
  isValidResourceType,
  mineOne,
  mineOneAt,
  mineOneFromFootprint,
  mineOneFromTile,
} from '../src/machines/resourceNode';

describe('T21: ResourceNode (src/machines/resourceNode.ts)', () => {
  describe('createResourceNode & validation', () => {
    it('creates valid finite deposits for all canonical resource types', () => {
      for (const type of RESOURCE_TYPES) {
        expect(isValidResourceType(type)).toBe(true);
        const node = createResourceNode(type, 500);
        expect(node).toEqual({ type, amount: 500, initialAmount: 500 });
        expect(isDepleted(node)).toBe(false);
        expect(getRemainingAmount(node)).toBe(500);
        expect(getRemainingRatio(node)).toBe(1);
      }
    });

    it('fails closed on invalid resource types or non-positive/non-integer amounts', () => {
      expect(isValidResourceType('uranium')).toBe(false);
      expect(() => createResourceNode('uranium' as ResourceType, 100)).toThrow(SimulationError);
      expect(() => createResourceNode('iron_ore', 0)).toThrow(SimulationError);
      expect(() => createResourceNode('iron_ore', -10)).toThrow(SimulationError);
      expect(() => createResourceNode('iron_ore', 12.5)).toThrow(SimulationError);
      expect(() => createResourceNode('iron_ore', Number.NaN)).toThrow(SimulationError);
      expect(() => createResourceNode('iron_ore', Number.POSITIVE_INFINITY)).toThrow(SimulationError);
    });

    it('fails closed when validating corrupted ResourceNode objects', () => {
      const badAmount: ResourceNode = { type: 'coal', amount: -1, initialAmount: 10 };
      const nanAmount: ResourceNode = { type: 'coal', amount: Number.NaN, initialAmount: 10 };
      const badInit: ResourceNode = { type: 'coal', amount: 5, initialAmount: -5 };
      expect(() => assertValidResourceNode(badAmount)).toThrow(SimulationError);
      expect(() => assertValidResourceNode(nanAmount)).toThrow(SimulationError);
      expect(() => assertValidResourceNode(badInit)).toThrow(SimulationError);
      expect(() => mineOne(badAmount)).toThrow(SimulationError);
    });
  });

  describe('mineOne() conservation & clean depletion', () => {
    it('mines exactly initialAmount items and halts cleanly at 0', () => {
      const node = createResourceNode('iron_ore', 3);

      expect(mineOne(node)).toEqual({
        mined: true,
        itemId: 'iron_ore',
        remaining: 2,
        depleted: false,
      });
      expect(getRemainingRatio(node)).toBeCloseTo(2 / 3);

      expect(mineOne(node)).toEqual({
        mined: true,
        itemId: 'iron_ore',
        remaining: 1,
        depleted: false,
      });

      expect(mineOne(node)).toEqual({
        mined: true,
        itemId: 'iron_ore',
        remaining: 0,
        depleted: true,
      });
      expect(isDepleted(node)).toBe(true);
      expect(getRemainingAmount(node)).toBe(0);
      expect(getRemainingRatio(node)).toBe(0);

      // Subsequent mines must never go negative or produce extra items
      expect(mineOne(node)).toEqual({
        mined: false,
        itemId: null,
        remaining: 0,
        depleted: true,
      });
      expect(node.amount).toBe(0);
    });

    it('handles null/undefined helpers safely', () => {
      expect(isDepleted(null)).toBe(true);
      expect(isDepleted(undefined)).toBe(true);
      expect(getRemainingAmount(null)).toBe(0);
      expect(getRemainingRatio(null)).toBe(0);
    });
  });

  describe('mineOneFromTile() & mineOneAt()', () => {
    it('clears tile.resource to null upon final depletion', () => {
      const map = new TileMap(8, 8);
      map.setResource(2, 3, createResourceNode('copper_ore', 2));

      const r1 = mineOneAt(map, { x: 2, y: 3 });
      expect(r1).toEqual({
        mined: true,
        itemId: 'copper_ore',
        remaining: 1,
        depleted: false,
      });
      expect(map.getResource(2, 3)).not.toBeNull();

      const r2 = mineOneAt(map, { x: 2, y: 3 });
      expect(r2).toEqual({
        mined: true,
        itemId: 'copper_ore',
        remaining: 0,
        depleted: true,
      });
      expect(map.getResource(2, 3)).toBeNull();
      expect(map.hasResource(2, 3)).toBe(false);

      // Mining again on empty tile returns empty result cleanly
      const r3 = mineOneFromTile(map.getTile(2, 3));
      expect(r3).toEqual({
        mined: false,
        itemId: null,
        remaining: 0,
        depleted: true,
      });
    });

    it('fails closed with OutOfBoundsError for out-of-bounds coordinates', () => {
      const map = new TileMap(8, 8);
      expect(() => mineOneAt(map, { x: -1, y: 0 })).toThrow(OutOfBoundsError);
      expect(() => mineOneAt(map, { x: 8, y: 0 })).toThrow(OutOfBoundsError);
    });
  });

  describe('mineOneFromFootprint()', () => {
    it('deterministically mines a 2x2 footprint in row-major order and cleans up depleted tiles', () => {
      const map = new TileMap(8, 8);
      map.setResource(1, 1, createResourceNode('coal', 1));
      map.setResource(2, 2, createResourceNode('stone', 2));

      const fp = { width: 2, height: 2 };
      const minedItems: (ResourceType | null)[] = [];

      for (let i = 0; i < 4; i++) {
        const res = mineOneFromFootprint(map, { x: 1, y: 1 }, fp);
        minedItems.push(res.itemId);
      }

      expect(minedItems).toEqual(['coal', 'stone', 'stone', null]);
      expect(map.getResource(1, 1)).toBeNull();
      expect(map.getResource(2, 2)).toBeNull();
    });

    it('fails closed if any tile of the footprint is out of bounds', () => {
      const map = new TileMap(4, 4);
      map.setResource(3, 3, createResourceNode('iron_ore', 5));
      expect(() =>
        mineOneFromFootprint(map, { x: 3, y: 3 }, { width: 2, height: 2 })
      ).toThrow(OutOfBoundsError);
      // Verify no partial mutation occurred
      expect(map.getResource(3, 3)?.amount).toBe(5);
    });
  });
});
