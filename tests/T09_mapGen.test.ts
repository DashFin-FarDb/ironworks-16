import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_HEIGHT,
  DEFAULT_MAP_WIDTH,
  DEFAULT_SPAWN_CENTER,
  STARTING_RESOURCES,
  createInitialWorldState,
  createMulberry32,
  generateMap,
  mulberry32,
} from '../src/core/mapGen.js';
import { SimulationError } from '../src/types/contracts.js';

describe('T09: Mulberry32 PRNG', () => {
  it('produces identical sequences for identical seeds and distinct sequences for different seeds', () => {
    const a = mulberry32(1616);
    const b = mulberry32(1616);
    const c = mulberry32(1617);

    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    const seqC = Array.from({ length: 50 }, () => c());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('supports nextInt, nextFloat, and pick deterministically', () => {
    const rng1 = createMulberry32(42);
    const rng2 = createMulberry32(42);

    for (let i = 0; i < 30; i++) {
      const n1 = rng1.nextInt(-5, 5);
      const n2 = rng2.nextInt(-5, 5);
      expect(n1).toBe(n2);
      expect(Number.isInteger(n1)).toBe(true);
      expect(n1).toBeGreaterThanOrEqual(-5);
      expect(n1).toBeLessThanOrEqual(5);

      const f1 = rng1.nextFloat(10, 20);
      const f2 = rng2.nextFloat(10, 20);
      expect(f1).toBe(f2);
      expect(f1).toBeGreaterThanOrEqual(10);
      expect(f1).toBeLessThan(20);

      const p1 = rng1.pick(['a', 'b', 'c', 'd']);
      const p2 = rng2.pick(['a', 'b', 'c', 'd']);
      expect(p1).toBe(p2);
    }
  });

  it('fails closed on invalid seed, range, or empty pick', () => {
    expect(() => mulberry32(Number.NaN)).toThrow(SimulationError);
    expect(() => mulberry32(Number.POSITIVE_INFINITY)).toThrow(SimulationError);

    const rng = createMulberry32(1);
    expect(() => rng.nextInt(5, 2)).toThrow(SimulationError);
    expect(() => rng.nextInt(1.5, 3)).toThrow(SimulationError);
    expect(() => rng.nextFloat(10, 5)).toThrow(SimulationError);
    expect(() => rng.pick([])).toThrow(SimulationError);
  });
});

describe('T09: Deterministic Map Generator', () => {
  it('generates bit-for-bit identical 64x64 maps for seed 1616', () => {
    const mapA = generateMap(1616);
    const mapB = generateMap(1616);
    const mapC = generateMap(9999);

    expect(mapA.width).toBe(DEFAULT_MAP_WIDTH);
    expect(mapA.height).toBe(DEFAULT_MAP_HEIGHT);
    expect(mapA.tiles.length).toBe(DEFAULT_MAP_WIDTH * DEFAULT_MAP_HEIGHT);
    expect(JSON.stringify(mapA)).toBe(JSON.stringify(mapB));
    expect(JSON.stringify(mapA)).not.toBe(JSON.stringify(mapC));

    // Verify row-major indexing invariant
    for (let y = 0; y < mapA.height; y++) {
      for (let x = 0; x < mapA.width; x++) {
        const tile = mapA.tiles[y * mapA.width + x];
        expect(tile?.x).toBe(x);
        expect(tile?.y).toBe(y);
        expect(tile?.entityId).toBeNull();
      }
    }
  });

  it('guarantees Iron, Copper, Coal, and Stone patches near (32, 32) on buildable terrain', () => {
    const testSeeds = [1616, 0, 42, 123456, -77];

    for (const seed of testSeeds) {
      const map = generateMap(seed);

      for (const resType of STARTING_RESOURCES) {
        const coords = map.startingPatches[resType];
        expect(coords.length).toBeGreaterThan(0);

        for (const coord of coords) {
          const dist = Math.hypot(
            coord.x - DEFAULT_SPAWN_CENTER.x,
            coord.y - DEFAULT_SPAWN_CENTER.y
          );
          expect(dist).toBeLessThanOrEqual(15);

          const tile = map.tiles[coord.y * map.width + coord.x];
          expect(tile).toBeDefined();
          expect(tile?.terrain).not.toBe('water');
          expect(tile?.resource?.type).toBe(resType);
          expect(tile?.resource?.amount).toBeGreaterThan(0);
          expect(tile?.resource?.amount).toBe(tile?.resource?.initialAmount);
        }
      }
    }
  });

  it('constructs a valid initial WorldState via createInitialWorldState', () => {
    const w1 = createInitialWorldState(1616);
    const w2 = createInitialWorldState(1616);

    expect(w1.schemaVersion).toBe(1);
    expect(w1.seed).toBe(1616);
    expect(w1.tick).toBe(0);
    expect(w1.width).toBe(64);
    expect(w1.height).toBe(64);
    expect(w1.tiles.length).toBe(4096);
    expect(JSON.stringify(w1)).toBe(JSON.stringify(w2));
  });

  it('fails closed on invalid map dimensions or out-of-bounds spawn center', () => {
    expect(() => generateMap(1616, { width: 0, height: 64 })).toThrow(SimulationError);
    expect(() => generateMap(1616, { width: 64, height: -4 })).toThrow(SimulationError);
    expect(() => generateMap(1616, { width: 32.5, height: 32 })).toThrow(SimulationError);
    expect(() =>
      generateMap(1616, { width: 32, height: 32, spawnCenter: { x: 40, y: 16 } })
    ).toThrow(SimulationError);
  });
});
