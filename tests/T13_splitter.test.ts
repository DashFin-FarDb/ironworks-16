import { describe, expect, it } from 'vitest';
import {
  type ItemId,
  SimulationError,
  UnknownItemError,
} from '../src/types/contracts.js';
import {
  BELT_ITEM_SPACING,
  BELT_MAX_OFFSET,
  BELT_SPEED,
  advanceBelt,
  countBeltItems,
  createBeltEntity,
} from '../src/logistics/belt.js';
import {
  advanceSplitter,
  advanceSplitterToBelts,
  countSplitterItems,
  createSplitterEntity,
  getSplitterFootprint,
  getSplitterInputCoords,
  getSplitterOutputCoords,
  getSplitterTiles,
  insertIntoSplitter,
} from '../src/logistics/splitter.js';

describe('T13: 2-Tile-Wide 50/50 Alternating Splitter', () => {
  it('computes 2-tile-wide footprints, occupied tiles, and input/output coords for all directions', () => {
    expect(getSplitterFootprint('N')).toEqual({ width: 2, height: 1 });
    expect(getSplitterFootprint('S')).toEqual({ width: 2, height: 1 });
    expect(getSplitterFootprint('E')).toEqual({ width: 1, height: 2 });
    expect(getSplitterFootprint('W')).toEqual({ width: 1, height: 2 });

    const north = createSplitterEntity(1, { x: 10, y: 10 }, 'N');
    expect(getSplitterTiles(north)).toEqual([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
    ]);
    expect(getSplitterInputCoords(north)).toEqual([
      { x: 10, y: 11 },
      { x: 11, y: 11 },
    ]);
    expect(getSplitterOutputCoords(north)).toEqual([
      { x: 10, y: 9 },
      { x: 11, y: 9 },
    ]);

    const east = createSplitterEntity(2, { x: 5, y: 5 }, 'E');
    expect(getSplitterTiles(east)).toEqual([
      { x: 5, y: 5 },
      { x: 5, y: 6 },
    ]);
    expect(getSplitterInputCoords(east)).toEqual([
      { x: 4, y: 5 },
      { x: 4, y: 6 },
    ]);
    expect(getSplitterOutputCoords(east)).toEqual([
      { x: 6, y: 5 },
      { x: 6, y: 6 },
    ]);
  });

  it('alternates 50/50 across output 0 and output 1 when both outputs are open', () => {
    const splitter = createSplitterEntity(1, { x: 0, y: 0 }, 'N');
    const out0: ItemId[] = [];
    const out1: ItemId[] = [];
    const sequence: Array<0 | 1> = [];

    const totalItems = 20;
    let inserted = 0;

    for (let tick = 0; tick < 800; tick++) {
      if (inserted < totalItems) {
        const side = inserted % 2 === 0 ? 'left' : 'right';
        if (insertIntoSplitter(splitter, side, 'iron_ore', 0)) {
          inserted += 1;
        }
      }

      advanceSplitter(splitter, {
        handoff: (outputIndex, itemId) => {
          sequence.push(outputIndex);
          if (outputIndex === 0) {
            out0.push(itemId);
          } else {
            out1.push(itemId);
          }
          return true;
        },
      });
    }

    expect(inserted).toBe(totalItems);
    expect(countSplitterItems(splitter)).toBe(0);
    expect(out0.length).toBe(10);
    expect(out1.length).toBe(10);
    // Strict 0, 1, 0, 1... alternation
    for (let i = 0; i < sequence.length; i++) {
      expect(sequence[i]).toBe(i % 2);
    }
  });

  it('preserves 100% item conservation when one output lane is blocked and resumes fairness on unblock', () => {
    const splitter = createSplitterEntity(1, { x: 0, y: 0 }, 'N');
    const out0: ItemId[] = [];
    const out1: ItemId[] = [];

    // Block output 0 completely for the first 10 items.
    let output0Blocked = true;

    for (let i = 0; i < 10; i++) {
      expect(insertIntoSplitter(splitter, 'left', 'copper_ore', BELT_MAX_OFFSET)).toBe(true);
      const res = advanceSplitter(splitter, {
        handoff: (outputIndex, itemId) => {
          if (outputIndex === 0 && output0Blocked) {
            return false;
          }
          if (outputIndex === 0) {
            out0.push(itemId);
          } else {
            out1.push(itemId);
          }
          return true;
        },
      });
      expect(res.handedOff).toBe(1);
      expect(res.handedOffByOutput).toEqual([0, 1]);
    }

    expect(out0.length).toBe(0);
    expect(out1.length).toBe(10);
    expect(countSplitterItems(splitter)).toBe(0);
    // Output 0 retained priority while blocked.
    expect(splitter.nextOutputIndex).toBe(0);

    // Unblock output 0: next item must go to output 0, then alternate.
    output0Blocked = false;
    for (let i = 0; i < 4; i++) {
      expect(insertIntoSplitter(splitter, 'left', 'copper_ore', BELT_MAX_OFFSET)).toBe(true);
      advanceSplitter(splitter, {
        handoff: (outputIndex, itemId) => {
          if (outputIndex === 0) {
            out0.push(itemId);
          } else {
            out1.push(itemId);
          }
          return true;
        },
      });
    }

    expect(out0.length).toBe(2);
    expect(out1.length).toBe(12);
    expect(out0.length + out1.length + countSplitterItems(splitter)).toBe(14);
  });

  it('halts cleanly under full backpressure when both outputs are blocked', () => {
    const splitter = createSplitterEntity(1, { x: 0, y: 0 }, 'N');
    expect(insertIntoSplitter(splitter, 'left', 'coal', 0.5)).toBe(true);
    expect(insertIntoSplitter(splitter, 'left', 'coal', 0.0)).toBe(true);

    for (let tick = 0; tick < 100; tick++) {
      advanceSplitter(splitter, {
        handoff: () => false,
      });
    }

    expect(countSplitterItems(splitter)).toBe(2);
    expect(splitter.leftLane.items[0]?.offset).toBe(BELT_MAX_OFFSET);
    expect(splitter.leftLane.items[1]?.offset).toBe(
      BELT_MAX_OFFSET - BELT_ITEM_SPACING
    );
    expect(splitter.nextOutputIndex).toBe(0);
  });

  it('integrates with output BeltEntities via advanceSplitterToBelts with zero item loss', () => {
    const splitter = createSplitterEntity(1, { x: 4, y: 4 }, 'N');
    const outBelt0 = createBeltEntity(2, { x: 4, y: 3 }, 'N');
    const outBelt1 = createBeltEntity(3, { x: 5, y: 3 }, 'N');

    let injected = 0;
    let exitedOut1 = 0;

    // outBelt0 has no downstream consumer (will fill up and backpressure!).
    // outBelt1 drains freely into a sink.
    for (let tick = 0; tick < 400; tick++) {
      if (injected < 16 && insertIntoSplitter(splitter, 'left', 'iron_plate', 0)) {
        injected += 1;
      }

      // Advance downstream belts first, then splitter (standard back-to-front order).
      advanceBelt(outBelt0); // blocked at exit
      advanceBelt(outBelt1, {
        handoff: () => {
          exitedOut1 += 1;
          return true;
        },
      });
      advanceSplitterToBelts(splitter, [outBelt0, outBelt1]);
    }

    const totalAccounted =
      countSplitterItems(splitter) +
      countBeltItems(outBelt0) +
      countBeltItems(outBelt1) +
      exitedOut1;

    expect(injected).toBe(16);
    expect(totalAccounted).toBe(injected);
    // outBelt0 should have filled to capacity (5 items on a 1.0 lane with 0.25 spacing: 1.0, 0.75, 0.5, 0.25, 0.0)
    expect(countBeltItems(outBelt0)).toBeGreaterThan(0);
    // All remaining items should have overflowed to outBelt1 without loss
    expect(exitedOut1).toBeGreaterThan(0);
  });

  it('fails closed on invalid items or invalid speed/spacing and is bit-for-bit deterministic', () => {
    const splitter = createSplitterEntity(1, { x: 0, y: 0 }, 'N');
    expect(() =>
      insertIntoSplitter(splitter, 'left', 'invalid_item' as ItemId)
    ).toThrow(UnknownItemError);
    expect(() =>
      advanceSplitter(splitter, { speed: 0 })
    ).toThrow(SimulationError);
    expect(() =>
      advanceSplitter(splitter, { spacing: Number.NaN })
    ).toThrow(SimulationError);

    const runSimulation = () => {
      const s = createSplitterEntity(10, { x: 2, y: 2 }, 'E');
      const log: string[] = [];
      for (let t = 0; t < 120; t++) {
        if (t % 10 === 0) {
          insertIntoSplitter(s, t % 20 === 0 ? 'left' : 'right', 'iron_gear', 0);
        }
        advanceSplitter(s, {
          speed: BELT_SPEED,
          handoff: (idx, itemId, lane) => {
            if (idx === 0 && t % 3 === 0) return false;
            log.push(`${t}:${idx}:${lane}:${itemId}`);
            return true;
          },
        });
      }
      return JSON.stringify({ state: s, log });
    };

    expect(runSimulation()).toBe(runSimulation());
  });
});
