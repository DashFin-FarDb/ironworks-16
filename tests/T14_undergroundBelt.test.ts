import { describe, it, expect } from 'vitest';
import {
  type Entity,
  type ItemId,
  SimulationError,
  InvalidPlacementError,
  UnknownItemError,
} from '../src/types/contracts.js';
import {
  UNDERGROUND_MAX_SPAN,
  UNDERGROUND_MAX_DISTANCE,
  createUndergroundBeltEntity,
  countUndergroundItems,
  getUndergroundDistance,
  computeTransitTicks,
  computeLaneTickSpacing,
  pairUndergroundBelts,
  unpairUndergroundBelt,
  findMatchingUndergroundPair,
  reconcileUndergroundPairs,
  canInsertIntoUndergroundBelt,
  insertIntoUndergroundBelt,
  advanceUndergroundBelt,
} from '../src/logistics/undergroundBelt.js';
import { BELT_SPEED, BELT_ITEM_SPACING, type BeltLaneSide } from '../src/logistics/belt.js';

describe('T14: Underground Belt (src/logistics/undergroundBelt.ts)', () => {
  describe('creation & fail-closed validation', () => {
    it('creates valid input and output underground belts', () => {
      const entry = createUndergroundBeltEntity(1, { x: 2, y: 3 }, 'E', 'input');
      const exit = createUndergroundBeltEntity(2, { x: 7, y: 3 }, 'E', 'output');

      expect(entry.type).toBe('underground_belt');
      expect(entry.mode).toBe('input');
      expect(entry.pairedEntityId).toBeNull();
      expect(entry.transitQueue).toEqual([]);
      expect(exit.mode).toBe('output');
    });

    it('rejects invalid mode with InvalidPlacementError', () => {
      expect(() =>
        createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'sideways' as never)
      ).toThrow(InvalidPlacementError);
    });

    it('rejects unknown item IDs with UnknownItemError', () => {
      const entry = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      const exit = createUndergroundBeltEntity(2, { x: 3, y: 0 }, 'E', 'output');
      pairUndergroundBelts(entry, exit);

      expect(() =>
        insertIntoUndergroundBelt(entry, exit, 'unobtanium' as ItemId, 'left')
      ).toThrow(UnknownItemError);
    });

    it('rejects invalid speed or distance parameters', () => {
      expect(() => computeTransitTicks(0)).toThrow(SimulationError);
      expect(() => computeTransitTicks(UNDERGROUND_MAX_DISTANCE + 1)).toThrow(SimulationError);
      expect(() => computeTransitTicks(2, 0)).toThrow(SimulationError);
      expect(() => computeTransitTicks(2, Number.NaN)).toThrow(SimulationError);
    });
  });

  describe('pairing & max 4-tile span', () => {
    it('pairs valid entry/exit up to 4 gap tiles (distance 1..5) in all 4 directions', () => {
      expect(UNDERGROUND_MAX_SPAN).toBe(4);
      expect(UNDERGROUND_MAX_DISTANCE).toBe(5);

      const cases = [
        { dir: 'E' as const, start: { x: 10, y: 10 }, end: { x: 15, y: 10 }, dist: 5 },
        { dir: 'W' as const, start: { x: 10, y: 10 }, end: { x: 5, y: 10 }, dist: 5 },
        { dir: 'N' as const, start: { x: 10, y: 10 }, end: { x: 10, y: 5 }, dist: 5 },
        { dir: 'S' as const, start: { x: 10, y: 10 }, end: { x: 10, y: 15 }, dist: 5 },
        { dir: 'E' as const, start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, dist: 1 },
      ];

      for (const c of cases) {
        const entry = createUndergroundBeltEntity(1, c.start, c.dir, 'input');
        const exit = createUndergroundBeltEntity(2, c.end, c.dir, 'output');
        expect(getUndergroundDistance(entry, exit)).toBe(c.dist);
        expect(pairUndergroundBelts(entry, exit)).toBe(c.dist);
        expect(entry.pairedEntityId).toBe(2);
        expect(exit.pairedEntityId).toBe(1);
      }
    });

    it('rejects pairs beyond 4 gap tiles (distance 6), misaligned, or wrong direction/mode', () => {
      const entry = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      const tooFar = createUndergroundBeltEntity(2, { x: 6, y: 0 }, 'E', 'output');
      const misaligned = createUndergroundBeltEntity(3, { x: 3, y: 1 }, 'E', 'output');
      const behind = createUndergroundBeltEntity(4, { x: -2, y: 0 }, 'E', 'output');
      const wrongDir = createUndergroundBeltEntity(5, { x: 3, y: 0 }, 'W', 'output');
      const wrongMode = createUndergroundBeltEntity(6, { x: 3, y: 0 }, 'E', 'input');

      expect(getUndergroundDistance(entry, tooFar)).toBeNull();
      expect(getUndergroundDistance(entry, misaligned)).toBeNull();
      expect(getUndergroundDistance(entry, behind)).toBeNull();
      expect(getUndergroundDistance(entry, wrongDir)).toBeNull();
      expect(getUndergroundDistance(entry, wrongMode)).toBeNull();

      expect(() => pairUndergroundBelts(entry, tooFar)).toThrow(SimulationError);
    });

    it('reconciles pairs deterministically and prevents crossing through same-mode belts', () => {
      const in1 = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      const in2 = createUndergroundBeltEntity(2, { x: 2, y: 0 }, 'E', 'input');
      const out2 = createUndergroundBeltEntity(3, { x: 4, y: 0 }, 'E', 'output');

      const entities: Record<number, Entity> = { 1: in1, 2: in2, 3: out2 };

      // in1 cannot cross over in2 to pair with out2
      expect(findMatchingUndergroundPair(in1, entities)).toBeNull();
      expect(findMatchingUndergroundPair(in2, entities)?.id).toBe(3);

      reconcileUndergroundPairs(entities);
      expect(in1.pairedEntityId).toBeNull();
      expect(in2.pairedEntityId).toBe(3);
      expect(out2.pairedEntityId).toBe(2);

      // Unpairing clears both sides
      unpairUndergroundBelt(in2, entities);
      expect(in2.pairedEntityId).toBeNull();
      expect(out2.pairedEntityId).toBeNull();
    });
  });

  describe('accurate transit delay & lane independence', () => {
    it('delivers an item after exact transit ticks for distance 1 (32 ticks) and distance 5 (160 ticks)', () => {
      expect(computeTransitTicks(1, BELT_SPEED)).toBe(32);
      expect(computeTransitTicks(5, BELT_SPEED)).toBe(160);
      expect(computeLaneTickSpacing(BELT_SPEED, BELT_ITEM_SPACING)).toBe(8);

      const entry = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      const exit = createUndergroundBeltEntity(2, { x: 5, y: 0 }, 'E', 'output');
      pairUndergroundBelts(entry, exit);

      expect(insertIntoUndergroundBelt(entry, exit, 'iron_ore', 'left')).toBe(true);
      expect(insertIntoUndergroundBelt(entry, exit, 'copper_ore', 'right')).toBe(true);
      expect(countUndergroundItems(entry)).toBe(2);

      const exitedItems: Array<{ tick: number; itemId: ItemId; lane: BeltLaneSide }> = [];
      for (let tick = 1; tick <= 165; tick++) {
        advanceUndergroundBelt(entry, exit, {
          handoff: (itemId, lane) => {
            exitedItems.push({ tick, itemId, lane });
            return true;
          },
        });
      }

      expect(exitedItems).toEqual([
        { tick: 160, itemId: 'iron_ore', lane: 'left' },
        { tick: 160, itemId: 'copper_ore', lane: 'right' },
      ]);
      expect(countUndergroundItems(entry)).toBe(0);
    });

    it('enforces minimum tick spacing on the same lane', () => {
      const entry = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      const exit = createUndergroundBeltEntity(2, { x: 2, y: 0 }, 'E', 'output');
      pairUndergroundBelts(entry, exit);

      expect(insertIntoUndergroundBelt(entry, exit, 'iron_plate', 'left')).toBe(true);
      // Immediately inserting another item on the same lane is blocked
      expect(canInsertIntoUndergroundBelt(entry, exit, 'left')).toBe(false);
      expect(insertIntoUndergroundBelt(entry, exit, 'iron_plate', 'left')).toBe(false);

      // Advance 7 ticks: still blocked
      for (let i = 0; i < 7; i++) {
        advanceUndergroundBelt(entry, exit);
      }
      expect(canInsertIntoUndergroundBelt(entry, exit, 'left')).toBe(false);

      // Advance 1 more tick (total 8): now allowed
      advanceUndergroundBelt(entry, exit);
      expect(canInsertIntoUndergroundBelt(entry, exit, 'left')).toBe(true);
      expect(insertIntoUndergroundBelt(entry, exit, 'iron_plate', 'left')).toBe(true);
      expect(countUndergroundItems(entry)).toBe(2);
    });
  });

  describe('backpressure & 100% item conservation', () => {
    it('halts items under backpressure without loss and drains in FIFO order when cleared', () => {
      const entry = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      const exit = createUndergroundBeltEntity(2, { x: 2, y: 0 }, 'E', 'output');
      pairUndergroundBelts(entry, exit);

      const sent: ItemId[] = ['iron_ore', 'copper_ore', 'coal', 'stone'];
      const received: ItemId[] = [];

      // Feed 4 items spaced 8 ticks apart while exit is blocked
      for (let i = 0; i < sent.length; i++) {
        expect(insertIntoUndergroundBelt(entry, exit, sent[i]!, 'left')).toBe(true);
        for (let t = 0; t < 8; t++) {
          advanceUndergroundBelt(entry, exit, { handoff: () => false });
        }
      }

      // Run 100 more blocked ticks — all 4 items must remain conserved inside
      for (let t = 0; t < 100; t++) {
        const res = advanceUndergroundBelt(entry, exit, { handoff: () => false });
        expect(res.exited).toBe(0);
      }
      expect(countUndergroundItems(entry)).toBe(4);

      // Now unblock exit and drain
      for (let t = 0; t < 60; t++) {
        advanceUndergroundBelt(entry, exit, {
          handoff: (itemId) => {
            received.push(itemId);
            return true;
          },
        });
      }

      expect(received).toEqual(sent);
      expect(countUndergroundItems(entry)).toBe(0);
    });

    it('refuses insertion when unpaired (zero item loss)', () => {
      const entry = createUndergroundBeltEntity(1, { x: 0, y: 0 }, 'E', 'input');
      expect(insertIntoUndergroundBelt(entry, null, 'iron_ore', 'left')).toBe(false);
      expect(countUndergroundItems(entry)).toBe(0);
    });
  });

  describe('determinism', () => {
    it('produces bit-for-bit identical state across two independent runs', () => {
      const runSim = () => {
        const entry = createUndergroundBeltEntity(1, { x: 4, y: 4 }, 'S', 'input');
        const exit = createUndergroundBeltEntity(2, { x: 4, y: 8 }, 'S', 'output');
        pairUndergroundBelts(entry, exit);

        const out: Array<{ tick: number; itemId: ItemId; lane: BeltLaneSide }> = [];
        for (let tick = 1; tick <= 200; tick++) {
          if (tick % 10 === 1) {
            insertIntoUndergroundBelt(entry, exit, 'iron_plate', 'left');
            insertIntoUndergroundBelt(entry, exit, 'copper_plate', 'right');
          }
          const allowExit = tick > 150;
          advanceUndergroundBelt(entry, exit, {
            handoff: (itemId, lane) => {
              if (!allowExit) return false;
              out.push({ tick, itemId, lane });
              return true;
            },
          });
        }
        return JSON.stringify({ entry, exit, out });
      };

      expect(runSim()).toBe(runSim());
    });
  });
});
