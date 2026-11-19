import { describe, it, expect } from 'vitest';
import {
  BELT_ITEM_SPACING,
  BELT_MAX_OFFSET,
  BELT_MIN_OFFSET,
  BELT_SPEED,
  advanceBelt,
  advanceLane,
  canInsertOnLane,
  countBeltItems,
  countLaneItems,
  createBeltEntity,
  insertOnBelt,
  insertOnLane,
  peekFrontItem,
  takeFrontItem,
  takeItemFromBelt,
  takeItemFromLane,
  type BeltLaneSide,
} from '../src/logistics/belt.js';
import {
  SimulationError,
  UnknownItemError,
  type ItemId,
} from '../src/types/contracts.js';

describe('T11: Two-Lane Conveyor Belt (src/logistics/belt.ts)', () => {
  it('maintains two independent lanes with fixed item spacing on insertion', () => {
    const belt = createBeltEntity(1, { x: 5, y: 5 }, 'E');

    expect(insertOnBelt(belt, 'left', 'iron_ore', 0)).toBe(true);
    // Too close on left lane (< 0.25)
    expect(insertOnBelt(belt, 'left', 'iron_ore', 0.24)).toBe(false);
    // Exact spacing on left lane (>= 0.25)
    expect(insertOnBelt(belt, 'left', 'copper_ore', 0.25)).toBe(true);
    // Right lane is completely independent at offset 0
    expect(insertOnBelt(belt, 'right', 'coal', 0)).toBe(true);

    expect(countLaneItems(belt.leftLane)).toBe(2);
    expect(countLaneItems(belt.rightLane)).toBe(1);
    expect(countBeltItems(belt)).toBe(3);

    // Front-most item on left lane is at 0.25 (descending order)
    expect(peekFrontItem(belt.leftLane)).toEqual({
      itemId: 'copper_ore',
      offset: 0.25,
    });
  });

  it('advances items at BELT_SPEED and halts cleanly under dead-end backpressure with zero loss', () => {
    const belt = createBeltEntity(1, { x: 0, y: 0 }, 'E');

    // Feed 5 items into left lane as space opens up
    let inserted = 0;
    for (let tick = 0; tick < 200; tick++) {
      if (inserted < 5 && insertOnBelt(belt, 'left', 'iron_plate', 0)) {
        inserted++;
      }
      advanceBelt(belt);
    }

    expect(inserted).toBe(5);
    expect(countLaneItems(belt.leftLane)).toBe(5);

    // Verify exact backpressure spacing: [1.0, 0.75, 0.5, 0.25, 0.0]
    const offsets = belt.leftLane.items.map((item) => item.offset);
    expect(offsets).toEqual([1, 0.75, 0.5, 0.25, 0]);

    // Lane is completely full: inserting at 0 must fail without losing anything
    expect(canInsertOnLane(belt.leftLane, 0)).toBe(false);
    expect(insertOnBelt(belt, 'left', 'iron_plate', 0)).toBe(false);
    expect(countLaneItems(belt.leftLane)).toBe(5);

    // Advancing further while blocked reports all 5 items blocked, 0 moved
    const res = advanceBelt(belt);
    expect(res).toEqual({ handedOff: 0, moved: 0, blocked: 5 });
  });

  it('enforces strict backpressure when downstream handoff rejects, then resumes when unblocked', () => {
    const belt = createBeltEntity(2, { x: 1, y: 0 }, 'E');
    insertOnBelt(belt, 'left', 'iron_ore', 0.9);
    insertOnBelt(belt, 'left', 'copper_ore', 0.6);

    const received: Array<{ itemId: ItemId; lane: BeltLaneSide }> = [];
    let allowHandoff = false;

    const handoff = (itemId: ItemId, lane: BeltLaneSide): boolean => {
      if (!allowHandoff) return false;
      received.push({ itemId, lane });
      return true;
    };

    // Advance 20 ticks while blocked
    for (let i = 0; i < 20; i++) {
      advanceBelt(belt, { handoff });
    }

    expect(received.length).toBe(0);
    expect(belt.leftLane.items.map((i) => i.offset)).toEqual([1, 0.75]);

    // Unblock downstream: first item hands off immediately on next tick
    allowHandoff = true;
    const firstUnblock = advanceBelt(belt, { handoff });
    expect(firstUnblock.handedOff).toBe(1);
    expect(received).toEqual([{ itemId: 'iron_ore', lane: 'left' }]);
    expect(countLaneItems(belt.leftLane)).toBe(1);

    // Advance until second item also hands off
    for (let i = 0; i < 10; i++) {
      advanceBelt(belt, { handoff });
    }
    expect(received).toEqual([
      { itemId: 'iron_ore', lane: 'left' },
      { itemId: 'copper_ore', lane: 'left' },
    ]);
    expect(countBeltItems(belt)).toBe(0);
    expect(belt.active).toBe(false);
  });

  it('conserves 100% of items across a multi-belt chain under backpressure and release', () => {
    const belts = [
      createBeltEntity(1, { x: 0, y: 0 }, 'E'),
      createBeltEntity(2, { x: 1, y: 0 }, 'E'),
      createBeltEntity(3, { x: 2, y: 0 }, 'E'),
    ];

    const delivered: ItemId[] = [];
    let sinkOpen = false;
    const totalToFeed = 24;
    let fed = 0;

    const stepChain = () => {
      // Update from downstream to upstream to propagate backpressure cleanly
      for (let i = belts.length - 1; i >= 0; i--) {
        const current = belts[i]!;
        const next = belts[i + 1];
        advanceBelt(current, {
          handoff: (itemId, lane, overflow) => {
            if (!next) {
              if (!sinkOpen) return false;
              delivered.push(itemId);
              return true;
            }
            const entryOffset = Math.min(overflow, BELT_MAX_OFFSET);
            return insertOnBelt(next, lane, itemId, entryOffset);
          },
        });
      }
    };

    // Phase 1: Feed while sink is closed (full backpressure)
    for (let tick = 0; tick < 400; tick++) {
      if (fed < totalToFeed) {
        const lane: BeltLaneSide = fed % 2 === 0 ? 'left' : 'right';
        if (insertOnBelt(belts[0]!, lane, 'iron_gear', 0)) {
          fed++;
        }
      }
      stepChain();
      const onBelts = belts.reduce((sum, b) => sum + countBeltItems(b), 0);
      expect(onBelts + delivered.length).toBe(fed);
    }

    expect(delivered.length).toBe(0);
    expect(fed).toBeGreaterThan(0);

    // Phase 2: Open sink and finish feeding + draining
    sinkOpen = true;
    for (let tick = 0; tick < 600; tick++) {
      if (fed < totalToFeed) {
        const lane: BeltLaneSide = fed % 2 === 0 ? 'left' : 'right';
        if (insertOnBelt(belts[0]!, lane, 'iron_gear', 0)) {
          fed++;
        }
      }
      stepChain();
      const onBelts = belts.reduce((sum, b) => sum + countBeltItems(b), 0);
      expect(onBelts + delivered.length).toBe(fed);
    }

    expect(fed).toBe(totalToFeed);
    expect(delivered.length).toBe(totalToFeed);
    expect(belts.reduce((sum, b) => sum + countBeltItems(b), 0)).toBe(0);
  });

  it('supports deterministic extraction helpers with left-before-right tie breaking', () => {
    const belt = createBeltEntity(10, { x: 2, y: 2 }, 'N');
    insertOnBelt(belt, 'left', 'iron_ore', 0.5);
    insertOnBelt(belt, 'right', 'copper_ore', 0.5);
    insertOnBelt(belt, 'right', 'coal', 0.8);

    // Highest offset is coal on right lane (0.8)
    expect(takeItemFromBelt(belt)).toBe('coal');
    // Tie at 0.5: left lane wins deterministically
    expect(takeItemFromBelt(belt)).toBe('iron_ore');
    // Predicate filtering
    expect(takeItemFromBelt(belt, (item) => item.itemId === 'iron_ore')).toBeNull();
    expect(takeItemFromBelt(belt, (item) => item.itemId === 'copper_ore')).toBe('copper_ore');

    // Lane-level takeFrontItem with minOffset
    insertOnLane(belt.leftLane, 'stone', 0.4);
    expect(takeFrontItem(belt.leftLane, 0.5)).toBeNull();
    expect(takeFrontItem(belt.leftLane, 0.4)).toBe('stone');
    expect(takeItemFromLane(belt.leftLane)).toBeNull();
  });

  it('fails closed on unknown item IDs and invalid numeric parameters', () => {
    const belt = createBeltEntity(1, { x: 0, y: 0 }, 'E');

    expect(() =>
      insertOnBelt(belt, 'left', 'invalid_item' as ItemId, 0)
    ).toThrow(UnknownItemError);

    expect(canInsertOnLane(belt.leftLane, Number.NaN)).toBe(false);
    expect(canInsertOnLane(belt.leftLane, -0.01)).toBe(false);
    expect(canInsertOnLane(belt.leftLane, 1.01)).toBe(false);
    expect(insertOnLane(belt.leftLane, 'iron_ore', Number.NaN)).toBe(false);

    expect(() =>
      advanceLane(belt.leftLane, 'left', { speed: 0 })
    ).toThrow(SimulationError);
    expect(() =>
      advanceLane(belt.leftLane, 'left', { speed: Number.NaN })
    ).toThrow(SimulationError);
    expect(() =>
      advanceLane(belt.leftLane, 'left', { spacing: -0.25 })
    ).toThrow(SimulationError);
  });

  it('is strictly deterministic across independent runs', () => {
    const runSimulation = () => {
      const belt = createBeltEntity(1, { x: 0, y: 0 }, 'S');
      const items: ItemId[] = ['iron_ore', 'copper_ore', 'coal', 'stone'];
      const out: ItemId[] = [];
      for (let t = 0; t < 150; t++) {
        const item = items[t % items.length]!;
        const side: BeltLaneSide = t % 2 === 0 ? 'left' : 'right';
        insertOnBelt(belt, side, item, BELT_MIN_OFFSET);
        advanceBelt(belt, {
          speed: BELT_SPEED,
          spacing: BELT_ITEM_SPACING,
          handoff: (itemId) => {
            if (t % 3 === 0) {
              out.push(itemId);
              return true;
            }
            return false;
          },
        });
      }
      return JSON.stringify({ belt, out });
    };

    expect(runSimulation()).toBe(runSimulation());
  });
});
