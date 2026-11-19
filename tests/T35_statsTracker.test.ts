import { describe, it, expect } from 'vitest';
import {
  StatsTracker,
  createStatsTracker,
  STATS_WINDOW_SECONDS,
  STATS_WINDOW_TICKS,
} from '../src/machines/statsTracker';
import { createEventBus } from '../src/core/eventBus';
import {
  ItemId,
  SimulationError,
  TICKS_PER_SECOND,
  UnknownItemError,
  WorldState,
} from '../src/types/contracts';

function makeMinimalWorld(tick = 0): WorldState {
  return {
    schemaVersion: 1,
    seed: 1616,
    tick,
    width: 1,
    height: 1,
    tiles: [{ x: 0, y: 0, terrain: 'grass', resource: null, entityId: null }],
    entities: {},
    nextEntityId: 1,
    powerGrid: { networks: {}, nextNetworkId: 1 },
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

describe('T35: StatsTracker (cumulative & rolling 60s items/min)', () => {
  it('defines canonical 60-second / 3600-tick window constants', () => {
    expect(STATS_WINDOW_SECONDS).toBe(60);
    expect(STATS_WINDOW_TICKS).toBe(TICKS_PER_SECOND * 60);
    expect(STATS_WINDOW_TICKS).toBe(3600);
  });

  it('tracks cumulative production and consumption across items', () => {
    const tracker = createStatsTracker();

    tracker.recordProduced('iron_plate', 5, 10);
    tracker.recordProduced('iron_plate', 3, 20);
    tracker.recordConsumed('iron_plate', 2, 25);
    tracker.recordConsumed('iron_ore', 8, 10);

    expect(tracker.getItemStats('iron_plate', 30)).toEqual({
      producedTotal: 8,
      consumedTotal: 2,
      producedPerMinute: 8,
      consumedPerMinute: 2,
    });

    expect(tracker.getItemStats('iron_ore', 30)).toEqual({
      producedTotal: 0,
      consumedTotal: 8,
      producedPerMinute: 0,
      consumedPerMinute: 8,
    });

    // Untracked valid item returns zeroed record
    expect(tracker.getItemStats('red_science', 30)).toEqual({
      producedTotal: 0,
      consumedTotal: 0,
      producedPerMinute: 0,
      consumedPerMinute: 0,
    });
  });

  it('evicts rolling window entries at the exact 3600-tick boundary while keeping cumulative totals', () => {
    const tracker = createStatsTracker();

    tracker.recordProduced('iron_plate', 10, 1);
    tracker.recordConsumed('iron_ore', 10, 1);

    // At tick 3600, tick 1 is still within (3600 - 3600, 3600] = (0, 3600]
    expect(tracker.getItemStats('iron_plate', 3600)).toEqual({
      producedTotal: 10,
      consumedTotal: 0,
      producedPerMinute: 10,
      consumedPerMinute: 0,
    });

    // At tick 3601, tick 1 falls outside (1, 3601] and is evicted
    expect(tracker.getItemStats('iron_plate', 3601)).toEqual({
      producedTotal: 10,
      consumedTotal: 0,
      producedPerMinute: 0,
      consumedPerMinute: 0,
    });

    expect(tracker.getItemStats('iron_ore', 3601)).toEqual({
      producedTotal: 0,
      consumedTotal: 10,
      producedPerMinute: 0,
      consumedPerMinute: 0,
    });
  });

  it('coalesces multiple events on the same tick and handles steady-state rates', () => {
    const tracker = createStatsTracker();

    // 1 iron_gear every 60 ticks (1/sec = 60/min), plus a second burst on the same tick
    for (let s = 1; s <= 120; s++) {
      const tick = s * 60;
      tracker.recordProduced('iron_gear', 1, tick);
      tracker.recordProduced('iron_gear', 2, tick);
    }

    // Over the last 60 seconds (ticks 3660..7200 = 60 events * 3 = 180 items/min)
    const stats = tracker.getItemStats('iron_gear', 120 * 60);
    expect(stats.producedTotal).toBe(360);
    expect(stats.producedPerMinute).toBe(180);
  });

  it('handles out-of-order tick recording within the active window', () => {
    const tracker = createStatsTracker();

    tracker.recordProduced('copper_plate', 4, 100);
    tracker.recordProduced('copper_plate', 6, 50);
    tracker.recordProduced('copper_plate', 2, 50);

    // At tick 3650: tick 50 is evicted (50 <= 3650 - 3600 = 50), tick 100 remains
    expect(tracker.getItemStats('copper_plate', 3650)).toEqual({
      producedTotal: 12,
      consumedTotal: 0,
      producedPerMinute: 4,
      consumedPerMinute: 0,
    });
  });

  it('compacts internal rolling window cleanly over many ticks without drift', () => {
    const tracker = createStatsTracker();

    // Record 1 item per tick for 5000 ticks (triggers compaction when head > 256)
    for (let t = 1; t <= 5000; t++) {
      tracker.recordProduced('coal', 1, t);
      if (t % 10 === 0) {
        tracker.prune(t);
      }
    }

    const stats = tracker.getItemStats('coal', 5000);
    expect(stats.producedTotal).toBe(5000);
    expect(stats.producedPerMinute).toBe(3600);
  });

  it('scales rolling rate to items/min when configured with a custom windowTicks', () => {
    // 10-second window (600 ticks): 15 items in 10s -> 90 items/min
    const tracker = new StatsTracker({ windowTicks: 600 });

    tracker.recordProduced('red_science', 15, 100);
    expect(tracker.getItemStats('red_science', 699).producedPerMinute).toBe(90);
    expect(tracker.getItemStats('red_science', 700).producedPerMinute).toBe(0);
  });

  it('integrates with EventBus itemProduced events and unsubscribes cleanly', () => {
    const bus = createEventBus();
    const tracker = createStatsTracker();
    const unsub = tracker.attachEventBus(bus);

    bus.emit('itemProduced', { tick: 10, itemId: 'red_science', count: 2, entityId: 7 });
    bus.emit('itemProduced', { tick: 20, itemId: 'red_science', count: 3, entityId: 7 });

    expect(tracker.getItemStats('red_science', 20)).toEqual({
      producedTotal: 5,
      consumedTotal: 0,
      producedPerMinute: 5,
      consumedPerMinute: 0,
    });

    unsub();
    bus.emit('itemProduced', { tick: 30, itemId: 'red_science', count: 10, entityId: 7 });
    expect(tracker.getItemStats('red_science', 30).producedTotal).toBe(5);
  });

  it('syncs deterministic canonical snapshot to WorldState and hydrates cumulative totals', () => {
    const tracker = createStatsTracker();
    const world = makeMinimalWorld(120);

    // Record in reverse canonical order to verify snapshot ordering is canonical
    tracker.recordProduced('red_science', 1, 100);
    tracker.recordProduced('iron_plate', 10, 110);
    tracker.recordConsumed('iron_ore', 10, 110);

    const snapshot = tracker.syncToWorld(world);
    expect(world.stats).toBe(snapshot);
    expect(Object.keys(world.stats.byItem)).toEqual(['iron_ore', 'iron_plate', 'red_science']);

    // Hydrate a fresh tracker from saved WorldState.stats
    const restored = createStatsTracker();
    restored.hydrateFromStats(world.stats, world.tick);
    expect(restored.getItemStats('iron_plate', world.tick)).toEqual({
      producedTotal: 10,
      consumedTotal: 0,
      producedPerMinute: 0,
      consumedPerMinute: 0,
    });
    expect(restored.getItemStats('iron_ore', world.tick).consumedTotal).toBe(10);
  });

  it('treats count === 0 as a valid no-op', () => {
    const tracker = createStatsTracker();
    tracker.recordProduced('iron_plate', 0, 10);
    tracker.recordConsumed('iron_plate', 0, 10);
    expect(tracker.getSnapshot(10)).toEqual({ byItem: {} });
  });

  it('fails closed on unknown ItemId, invalid counts, invalid ticks, and invalid windowTicks', () => {
    const tracker = createStatsTracker();

    expect(() => tracker.recordProduced('unobtainium' as ItemId, 1, 0)).toThrow(UnknownItemError);
    expect(() => tracker.recordConsumed('__proto__' as ItemId, 1, 0)).toThrow(UnknownItemError);
    expect(() => tracker.getItemStats('bad_item' as ItemId, 0)).toThrow(UnknownItemError);

    expect(() => tracker.recordProduced('iron_plate', -1, 0)).toThrow(SimulationError);
    expect(() => tracker.recordProduced('iron_plate', 1.5, 0)).toThrow(SimulationError);
    expect(() => tracker.recordProduced('iron_plate', Number.NaN, 0)).toThrow(SimulationError);

    expect(() => tracker.recordConsumed('iron_plate', 1, -5)).toThrow(SimulationError);
    expect(() => tracker.recordConsumed('iron_plate', 1, 1.2)).toThrow(SimulationError);
    expect(() => tracker.prune(-1)).toThrow(SimulationError);

    expect(() => new StatsTracker({ windowTicks: 0 })).toThrow(SimulationError);
    expect(() => new StatsTracker({ windowTicks: -60 })).toThrow(SimulationError);
    expect(() => new StatsTracker({ windowTicks: 1.5 })).toThrow(SimulationError);
  });

  it('produces bit-for-bit identical snapshots across two independent deterministic runs', () => {
    const run = (): string => {
      const tracker = createStatsTracker();
      tracker.recordProduced('iron_ore', 50, 10);
      tracker.recordConsumed('iron_ore', 20, 40);
      tracker.recordProduced('iron_plate', 20, 40);
      tracker.recordConsumed('iron_plate', 4, 80);
      tracker.recordProduced('iron_gear', 2, 80);
      tracker.recordProduced('red_science', 1, 120);
      return JSON.stringify(tracker.getSnapshot(120));
    };

    expect(run()).toBe(run());
  });
});
