/**
 * Ironworks-16 Production & Consumption Stats Tracker (T35)
 *
 * Tracks cumulative totals and rolling 60-second (3,600-tick) items/min
 * production and consumption rates per ItemId.
 *
 * Invariants:
 * - Strictly deterministic: driven solely by simulation tick (no Date.now/Math.random).
 * - Fail-closed: unknown ItemIds throw UnknownItemError; invalid counts/ticks throw SimulationError.
 * - Headless purity: zero DOM/Window/Canvas imports.
 */

import {
  ItemId,
  ItemProductionRecord,
  ProductionStats,
  SimulationError,
  TICKS_PER_SECOND,
  WorldState,
} from '../types/contracts';
import { EventBus, Unsubscribe } from '../core/eventBus';
import { ALL_ITEM_IDS, assertValidItemId } from '../core/itemRegistry';

export const STATS_WINDOW_SECONDS = 60;
export const STATS_WINDOW_TICKS = TICKS_PER_SECOND * STATS_WINDOW_SECONDS; // 3600 ticks

interface TickBucket {
  tick: number;
  count: number;
}

class RollingWindow {
  private entries: TickBucket[] = [];
  private head = 0;
  private sum = 0;

  add(tick: number, count: number): void {
    if (count === 0) return;

    const len = this.entries.length;
    if (len > this.head) {
      const last = this.entries[len - 1]!;
      if (last.tick === tick) {
        last.count += count;
        this.sum += count;
        return;
      }
      if (tick < last.tick) {
        // Insert in sorted tick order if an out-of-order tick is recorded within the window
        let idx = len - 1;
        while (idx >= this.head && this.entries[idx]!.tick > tick) {
          idx--;
        }
        if (idx >= this.head && this.entries[idx]!.tick === tick) {
          this.entries[idx]!.count += count;
        } else {
          this.entries.splice(idx + 1, 0, { tick, count });
        }
        this.sum += count;
        return;
      }
    }

    this.entries.push({ tick, count });
    this.sum += count;
  }

  prune(currentTick: number, windowTicks: number): void {
    const cutoff = currentTick - windowTicks;
    while (this.head < this.entries.length && this.entries[this.head]!.tick <= cutoff) {
      this.sum -= this.entries[this.head]!.count;
      this.head++;
    }

    // Compact backing array periodically to prevent unbounded memory growth
    if (this.head > 256 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }

    if (this.head >= this.entries.length) {
      this.entries = [];
      this.head = 0;
      this.sum = 0;
    }
  }

  getSum(): number {
    return this.sum;
  }

  clear(): void {
    this.entries = [];
    this.head = 0;
    this.sum = 0;
  }
}

interface InternalItemTracker {
  producedTotal: number;
  consumedTotal: number;
  producedWindow: RollingWindow;
  consumedWindow: RollingWindow;
}

export interface StatsTrackerOptions {
  /** Rolling window duration in simulation ticks. Defaults to 3600 (60s at 60 TPS). */
  readonly windowTicks?: number;
}

function assertValidTick(tick: number): void {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new SimulationError(
      'INVALID_TICK',
      `StatsTracker tick must be a non-negative integer, received: ${String(tick)}`
    );
  }
}

function assertValidCount(count: number): void {
  if (!Number.isInteger(count) || count < 0) {
    throw new SimulationError(
      'INVALID_ITEM_COUNT',
      `StatsTracker item count must be a non-negative integer, received: ${String(count)}`
    );
  }
}

export class StatsTracker {
  readonly windowTicks: number;
  private readonly items = new Map<ItemId, InternalItemTracker>();
  private lastTick = 0;

  constructor(options: StatsTrackerOptions = {}) {
    const windowTicks = options.windowTicks ?? STATS_WINDOW_TICKS;
    if (!Number.isInteger(windowTicks) || windowTicks <= 0) {
      throw new SimulationError(
        'INVALID_WINDOW_TICKS',
        `StatsTracker windowTicks must be a positive integer, received: ${String(windowTicks)}`
      );
    }
    this.windowTicks = windowTicks;
  }

  private getOrCreate(itemId: ItemId): InternalItemTracker {
    let tracker = this.items.get(itemId);
    if (!tracker) {
      tracker = {
        producedTotal: 0,
        consumedTotal: 0,
        producedWindow: new RollingWindow(),
        consumedWindow: new RollingWindow(),
      };
      this.items.set(itemId, tracker);
    }
    return tracker;
  }

  /**
   * Record `count` items produced at simulation `tick`.
   * Fails closed on unknown itemId, negative/non-integer count, or invalid tick.
   */
  recordProduced(itemId: ItemId, count: number, tick: number): void {
    assertValidItemId(itemId);
    assertValidCount(count);
    assertValidTick(tick);

    if (tick > this.lastTick) {
      this.lastTick = tick;
    }
    if (count === 0) return;

    const tracker = this.getOrCreate(itemId);
    tracker.producedTotal += count;
    tracker.producedWindow.add(tick, count);
  }

  /**
   * Record `count` items consumed at simulation `tick`.
   * Fails closed on unknown itemId, negative/non-integer count, or invalid tick.
   */
  recordConsumed(itemId: ItemId, count: number, tick: number): void {
    assertValidItemId(itemId);
    assertValidCount(count);
    assertValidTick(tick);

    if (tick > this.lastTick) {
      this.lastTick = tick;
    }
    if (count === 0) return;

    const tracker = this.getOrCreate(itemId);
    tracker.consumedTotal += count;
    tracker.consumedWindow.add(tick, count);
  }

  /**
   * Subscribe to `itemProduced` events on an EventBus.
   * Returns an idempotent unsubscribe function.
   */
  attachEventBus(eventBus: EventBus): Unsubscribe {
    return eventBus.on('itemProduced', (event) => {
      this.recordProduced(event.itemId, event.count, event.tick);
    });
  }

  /**
   * Advance the rolling window to `currentTick`, pruning entries older than `windowTicks`.
   */
  prune(currentTick: number): void {
    assertValidTick(currentTick);
    if (currentTick > this.lastTick) {
      this.lastTick = currentTick;
    }
    for (const tracker of this.items.values()) {
      tracker.producedWindow.prune(currentTick, this.windowTicks);
      tracker.consumedWindow.prune(currentTick, this.windowTicks);
    }
  }

  /**
   * Convert a rolling-window sum into an items/minute rate.
   * When windowTicks === 3600 (60s), rate === windowSum exactly.
   */
  private toPerMinute(windowSum: number): number {
    if (this.windowTicks === STATS_WINDOW_TICKS) {
      return windowSum;
    }
    return (windowSum * STATS_WINDOW_TICKS) / this.windowTicks;
  }

  /**
   * Return the current production/consumption record for a single item.
   * Returns a zeroed record if the item has no recorded activity yet.
   */
  getItemStats(itemId: ItemId, currentTick: number = this.lastTick): ItemProductionRecord {
    assertValidItemId(itemId);
    assertValidTick(currentTick);

    const tracker = this.items.get(itemId);
    if (!tracker) {
      return {
        producedTotal: 0,
        consumedTotal: 0,
        producedPerMinute: 0,
        consumedPerMinute: 0,
      };
    }

    tracker.producedWindow.prune(currentTick, this.windowTicks);
    tracker.consumedWindow.prune(currentTick, this.windowTicks);

    return {
      producedTotal: tracker.producedTotal,
      consumedTotal: tracker.consumedTotal,
      producedPerMinute: this.toPerMinute(tracker.producedWindow.getSum()),
      consumedPerMinute: this.toPerMinute(tracker.consumedWindow.getSum()),
    };
  }

  /**
   * Produce a deterministic `ProductionStats` snapshot ordered by canonical `ALL_ITEM_IDS`.
   */
  getSnapshot(currentTick: number = this.lastTick): ProductionStats {
    this.prune(currentTick);

    const byItem: Partial<Record<ItemId, ItemProductionRecord>> = {};
    for (const itemId of ALL_ITEM_IDS) {
      const tracker = this.items.get(itemId);
      if (!tracker) continue;
      byItem[itemId] = {
        producedTotal: tracker.producedTotal,
        consumedTotal: tracker.consumedTotal,
        producedPerMinute: this.toPerMinute(tracker.producedWindow.getSum()),
        consumedPerMinute: this.toPerMinute(tracker.consumedWindow.getSum()),
      };
    }

    return { byItem };
  }

  /**
   * Tick-loop `'stats'` phase handler: prunes expired window entries for `world.tick`
   * and writes the deterministic snapshot into `world.stats`.
   */
  syncToWorld(world: WorldState): ProductionStats {
    const snapshot = this.getSnapshot(world.tick);
    world.stats = snapshot;
    return snapshot;
  }

  /**
   * Restore cumulative totals from a deserialized `WorldState.stats`.
   * Rolling windows start empty (no per-tick history is stored in WorldState).
   */
  hydrateFromStats(stats: ProductionStats, currentTick = 0): void {
    assertValidTick(currentTick);
    this.reset();
    this.lastTick = currentTick;

    for (const itemId of ALL_ITEM_IDS) {
      const record = stats.byItem[itemId];
      if (!record) continue;
      assertValidCount(record.producedTotal);
      assertValidCount(record.consumedTotal);

      const tracker = this.getOrCreate(itemId);
      tracker.producedTotal = record.producedTotal;
      tracker.consumedTotal = record.consumedTotal;
    }
  }

  /**
   * Clear all tracked statistics and rolling windows.
   */
  reset(): void {
    this.items.clear();
    this.lastTick = 0;
  }
}

export function createStatsTracker(options?: StatsTrackerOptions): StatsTracker {
  return new StatsTracker(options);
}
