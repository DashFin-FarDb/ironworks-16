/**
 * Ironworks-16 Live Production Sparkline Graph (T45)
 *
 * Tracks and renders live production rate sparklines (items/min) for:
 * - iron_plate
 * - copper_plate
 * - iron_gear
 * - red_science
 *
 * Invariants:
 * - Strictly deterministic: sampling is driven solely by simulation tick (no Date.now/Math.random).
 * - Fail-closed: invalid options, unknown ItemIds, negative/NaN rates, or invalid ticks throw typed errors.
 * - Headless testable: Canvas 2D rendering uses a structural context interface compatible with
 *   CanvasRenderingContext2D without importing DOM globals.
 */

import {
  ItemId,
  ProductionStats,
  SimulationError,
  TICKS_PER_SECOND,
  WorldState,
  clamp,
} from '../types/contracts';
import { assertValidItemId } from '../core/itemRegistry';

export const PRODUCTION_GRAPH_ITEMS = [
  'iron_plate',
  'copper_plate',
  'iron_gear',
  'red_science',
] as const;

export type ProductionGraphItemId = (typeof PRODUCTION_GRAPH_ITEMS)[number];

export interface SeriesStyle {
  readonly itemId: ItemId;
  readonly label: string;
  readonly color: string;
}

export const DEFAULT_SERIES_STYLES: Readonly<Record<ProductionGraphItemId, SeriesStyle>> = {
  iron_plate: {
    itemId: 'iron_plate',
    label: 'Iron Plate',
    color: '#9fb6c8',
  },
  copper_plate: {
    itemId: 'copper_plate',
    label: 'Copper Plate',
    color: '#e68a45',
  },
  iron_gear: {
    itemId: 'iron_gear',
    label: 'Iron Gear',
    color: '#facc15',
  },
  red_science: {
    itemId: 'red_science',
    label: 'Red Science',
    color: '#ef4444',
  },
} as const;

export const DEFAULT_MAX_SAMPLES = 60;
export const DEFAULT_SAMPLE_INTERVAL_TICKS = TICKS_PER_SECOND; // 1 sample/sec at 60 TPS

export interface ProductionGraphOptions {
  /** Maximum number of historical points retained per series. Defaults to 60. */
  readonly maxSamples?: number;
  /** Minimum simulation ticks between automatic samples. Defaults to 60 (1s at 60 TPS). */
  readonly sampleIntervalTicks?: number;
  /** Optional custom list of tracked items. Defaults to PRODUCTION_GRAPH_ITEMS. */
  readonly items?: readonly ItemId[];
}

export interface SparklineSeries {
  readonly itemId: ItemId;
  readonly label: string;
  readonly color: string;
  readonly samples: readonly number[];
  readonly latestRate: number;
  readonly latestTotal: number;
  readonly maxRate: number;
}

export interface SparklineBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SparklinePoint {
  readonly x: number;
  readonly y: number;
}

export interface ProductionGraphRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Minimal structural subset of CanvasRenderingContext2D required to render the sparkline panel.
 * Allows direct use with HTML5 Canvas 2D in the browser and mock contexts in Node/Vitest.
 */
export interface ProductionGraphCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

export const DEFAULT_GRAPH_RECT: ProductionGraphRect = {
  x: 12,
  y: 12,
  width: 240,
  height: 148,
};

interface InternalSeries {
  readonly itemId: ItemId;
  readonly label: string;
  readonly color: string;
  samples: number[];
  latestTotal: number;
}

function assertPositiveInteger(value: number, code: string, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SimulationError(
      code,
      `${name} must be a positive integer, received: ${String(value)}`
    );
  }
}

function assertNonNegativeInteger(value: number, code: string, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SimulationError(
      code,
      `${name} must be a non-negative integer, received: ${String(value)}`
    );
  }
}

function assertValidRate(value: number, itemId: ItemId): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SimulationError(
      'INVALID_PRODUCTION_RATE',
      `Production rate for "${itemId}" must be a finite non-negative number, received: ${String(value)}`
    );
  }
}

function getSeriesStyle(itemId: ItemId): SeriesStyle {
  if (itemId in DEFAULT_SERIES_STYLES) {
    return DEFAULT_SERIES_STYLES[itemId as ProductionGraphItemId];
  }
  return {
    itemId,
    label: itemId,
    color: '#94a3b8',
  };
}

export class ProductionGraph {
  readonly maxSamples: number;
  readonly sampleIntervalTicks: number;
  readonly items: readonly ItemId[];

  private readonly seriesMap = new Map<ItemId, InternalSeries>();
  private lastSampleTick: number | null = null;
  private sampleTicks: number[] = [];

  constructor(options: ProductionGraphOptions = {}) {
    const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
    const sampleIntervalTicks = options.sampleIntervalTicks ?? DEFAULT_SAMPLE_INTERVAL_TICKS;
    const items = options.items ?? PRODUCTION_GRAPH_ITEMS;

    assertPositiveInteger(maxSamples, 'INVALID_MAX_SAMPLES', 'maxSamples');
    assertPositiveInteger(
      sampleIntervalTicks,
      'INVALID_SAMPLE_INTERVAL',
      'sampleIntervalTicks'
    );

    if (items.length === 0) {
      throw new SimulationError(
        'EMPTY_GRAPH_ITEMS',
        'ProductionGraph requires at least one tracked ItemId.'
      );
    }

    const validatedItems: ItemId[] = [];
    for (const itemId of items) {
      assertValidItemId(itemId);
      if (this.seriesMap.has(itemId)) {
        throw new SimulationError(
          'DUPLICATE_GRAPH_ITEM',
          `Duplicate tracked ItemId in ProductionGraph: "${itemId}".`
        );
      }
      const style = getSeriesStyle(itemId);
      this.seriesMap.set(itemId, {
        itemId,
        label: style.label,
        color: style.color,
        samples: [],
        latestTotal: 0,
      });
      validatedItems.push(itemId);
    }

    this.maxSamples = maxSamples;
    this.sampleIntervalTicks = sampleIntervalTicks;
    this.items = validatedItems;
  }

  /**
   * Sample production rates from a `ProductionStats` snapshot at simulation `tick`.
   * Returns `true` if a new sample was recorded, or `false` if skipped due to `sampleIntervalTicks`.
   * Set `force = true` to record immediately regardless of interval.
   */
  sample(stats: ProductionStats, tick: number, force = false): boolean {
    assertNonNegativeInteger(tick, 'INVALID_TICK', 'tick');

    if (this.lastSampleTick !== null && tick < this.lastSampleTick) {
      throw new SimulationError(
        'NON_MONOTONIC_TICK',
        `ProductionGraph tick must be monotonic (>= ${this.lastSampleTick}), received: ${tick}`
      );
    }

    if (
      !force &&
      this.lastSampleTick !== null &&
      tick - this.lastSampleTick < this.sampleIntervalTicks
    ) {
      return false;
    }

    // Validate all series rates before mutating state (atomic fail-closed update)
    const pending: Array<{ series: InternalSeries; rate: number; total: number }> = [];
    for (const itemId of this.items) {
      const series = this.seriesMap.get(itemId)!;
      const record = stats.byItem[itemId];
      const rate = record ? record.producedPerMinute : 0;
      const total = record ? record.producedTotal : 0;
      assertValidRate(rate, itemId);
      assertValidRate(total, itemId);
      pending.push({ series, rate, total });
    }

    for (const entry of pending) {
      entry.series.samples.push(entry.rate);
      if (entry.series.samples.length > this.maxSamples) {
        entry.series.samples.shift();
      }
      entry.series.latestTotal = entry.total;
    }

    this.sampleTicks.push(tick);
    if (this.sampleTicks.length > this.maxSamples) {
      this.sampleTicks.shift();
    }
    this.lastSampleTick = tick;
    return true;
  }

  /**
   * Convenience helper to sample directly from `WorldState`.
   */
  sampleFromWorld(world: WorldState, force = false): boolean {
    return this.sample(world.stats, world.tick, force);
  }

  /**
   * Return an immutable snapshot of a single tracked item's sparkline series.
   */
  getSeries(itemId: ItemId): SparklineSeries {
    assertValidItemId(itemId);
    const series = this.seriesMap.get(itemId);
    if (!series) {
      throw new SimulationError(
        'UNTRACKED_GRAPH_ITEM',
        `Item "${itemId}" is not tracked by this ProductionGraph.`
      );
    }

    const samples = series.samples.slice();
    const latestRate = samples.length > 0 ? samples[samples.length - 1]! : 0;
    let maxRate = 0;
    for (const value of samples) {
      if (value > maxRate) {
        maxRate = value;
      }
    }

    return {
      itemId: series.itemId,
      label: series.label,
      color: series.color,
      samples,
      latestRate,
      latestTotal: series.latestTotal,
      maxRate,
    };
  }

  /**
   * Return all tracked sparkline series in canonical display order.
   */
  getAllSeries(): readonly SparklineSeries[] {
    return this.items.map((itemId) => this.getSeries(itemId));
  }

  getSampleCount(): number {
    return this.sampleTicks.length;
  }

  getLastSampleTick(): number | null {
    return this.lastSampleTick;
  }

  getSampleTicks(): readonly number[] {
    return this.sampleTicks.slice();
  }

  reset(): void {
    for (const series of this.seriesMap.values()) {
      series.samples = [];
      series.latestTotal = 0;
    }
    this.sampleTicks = [];
    this.lastSampleTick = null;
  }
}

export function createProductionGraph(
  options?: ProductionGraphOptions
): ProductionGraph {
  return new ProductionGraph(options);
}

/**
 * Pure geometry helper mapping a series of production rates onto pixel coordinates
 * within `bounds`. Never produces NaN even when all samples are 0 or length <= 1.
 */
export function computeSparklinePoints(
  samples: readonly number[],
  bounds: SparklineBounds,
  minScale = 1
): SparklinePoint[] {
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new SimulationError(
      'INVALID_SPARKLINE_BOUNDS',
      `Sparkline bounds must have positive width and height, received: ${bounds.width}x${bounds.height}`
    );
  }
  if (!Number.isFinite(minScale) || minScale <= 0) {
    throw new SimulationError(
      'INVALID_MIN_SCALE',
      `Sparkline minScale must be a positive finite number, received: ${String(minScale)}`
    );
  }

  const count = samples.length;
  if (count === 0) {
    return [];
  }

  let peak = minScale;
  for (const val of samples) {
    if (!Number.isFinite(val) || val < 0) {
      throw new SimulationError(
        'INVALID_PRODUCTION_RATE',
        `Sparkline sample must be a finite non-negative number, received: ${String(val)}`
      );
    }
    if (val > peak) {
      peak = val;
    }
  }

  const points: SparklinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const val = samples[i]!;
    const t = count === 1 ? 1 : i / (count - 1);
    const normalized = clamp(val / peak, 0, 1);
    const x = bounds.x + t * bounds.width;
    const y = bounds.y + bounds.height - normalized * bounds.height;
    points.push({ x, y });
  }

  return points;
}

/**
 * Format a production rate (items/min) concisely for HUD display.
 */
export function formatRatePerMinute(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0) {
    return '0/m';
  }
  if (Number.isInteger(rate)) {
    return `${rate}/m`;
  }
  return `${rate.toFixed(1)}/m`;
}

/**
 * Render the live production sparkline panel onto a 2D canvas context.
 */
export function renderProductionGraph(
  ctx: ProductionGraphCanvasContext,
  graph: ProductionGraph,
  rect: ProductionGraphRect = DEFAULT_GRAPH_RECT
): void {
  if (rect.width <= 0 || rect.height <= 0) {
    throw new SimulationError(
      'INVALID_GRAPH_RECT',
      `ProductionGraph rect must have positive width and height, received: ${rect.width}x${rect.height}`
    );
  }

  const allSeries = graph.getAllSeries();
  const padding = 8;
  const headerHeight = 18;
  const innerWidth = Math.max(1, rect.width - padding * 2);
  const availableHeight = Math.max(1, rect.height - padding * 2 - headerHeight);
  const rowHeight = availableHeight / allSeries.length;

  ctx.save();

  // Panel background and crisp 16-bit border
  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

  // Header
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('PRODUCTION / MIN', rect.x + padding, rect.y + padding);

  // Series rows
  const labelWidth = Math.min(110, Math.floor(innerWidth * 0.48));
  const sparkX = rect.x + padding + labelWidth + 6;
  const sparkWidth = Math.max(1, rect.x + rect.width - padding - sparkX);

  for (let i = 0; i < allSeries.length; i++) {
    const series = allSeries[i]!;
    const rowY = rect.y + padding + headerHeight + i * rowHeight;
    const midY = rowY + rowHeight / 2;

    // Color swatch
    ctx.fillStyle = series.color;
    ctx.fillRect(rect.x + padding, midY - 3, 6, 6);

    // Label
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(series.label, rect.x + padding + 10, midY);

    // Current rate readout (right-aligned before sparkline)
    ctx.fillStyle = series.color;
    ctx.textAlign = 'right';
    ctx.fillText(
      formatRatePerMinute(series.latestRate),
      rect.x + padding + labelWidth,
      midY
    );

    // Sparkline baseline
    const sparkTop = rowY + 3;
    const sparkHeight = Math.max(1, rowHeight - 6);
    const baselineY = sparkTop + sparkHeight;

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sparkX, baselineY);
    ctx.lineTo(sparkX + sparkWidth, baselineY);
    ctx.stroke();

    // Sparkline polyline
    const points = computeSparklinePoints(series.samples, {
      x: sparkX,
      y: sparkTop,
      width: sparkWidth,
      height: sparkHeight,
    });

    if (points.length >= 2) {
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const first = points[0]!;
      ctx.moveTo(first.x, first.y);
      for (let p = 1; p < points.length; p++) {
        const pt = points[p]!;
        ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    } else if (points.length === 1) {
      const pt = points[0]!;
      ctx.fillStyle = series.color;
      ctx.fillRect(pt.x - 1, pt.y - 1, 2, 2);
    }
  }

  ctx.restore();
}
