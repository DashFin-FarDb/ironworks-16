import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_RECT,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_SAMPLE_INTERVAL_TICKS,
  PRODUCTION_GRAPH_ITEMS,
  ProductionGraphCanvasContext,
  computeSparklinePoints,
  createProductionGraph,
  formatRatePerMinute,
  renderProductionGraph,
} from '../src/ui/productionGraph';
import { createStatsTracker } from '../src/machines/statsTracker';
import {
  ItemId,
  ProductionStats,
  SimulationError,
  UnknownItemError,
} from '../src/types/contracts';

interface RecordedCanvasCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

function createMockCanvasContext(): {
  ctx: ProductionGraphCanvasContext;
  calls: RecordedCanvasCall[];
} {
  const calls: RecordedCanvasCall[] = [];
  const ctx: ProductionGraphCanvasContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    save() {
      calls.push({ method: 'save', args: [] });
    },
    restore() {
      calls.push({ method: 'restore', args: [] });
    },
    fillRect(x, y, w, h) {
      calls.push({ method: 'fillRect', args: [x, y, w, h, this.fillStyle] });
    },
    strokeRect(x, y, w, h) {
      calls.push({ method: 'strokeRect', args: [x, y, w, h, this.strokeStyle] });
    },
    beginPath() {
      calls.push({ method: 'beginPath', args: [] });
    },
    moveTo(x, y) {
      calls.push({ method: 'moveTo', args: [x, y] });
    },
    lineTo(x, y) {
      calls.push({ method: 'lineTo', args: [x, y] });
    },
    stroke() {
      calls.push({ method: 'stroke', args: [this.strokeStyle, this.lineWidth] });
    },
    fillText(text, x, y) {
      calls.push({ method: 'fillText', args: [text, x, y, this.fillStyle] });
    },
  };
  return { ctx, calls };
}

function makeStats(rates: Partial<Record<ItemId, number>>): ProductionStats {
  const byItem: ProductionStats['byItem'] = {};
  for (const [itemId, rate] of Object.entries(rates)) {
    byItem[itemId as ItemId] = {
      producedTotal: rate ?? 0,
      consumedTotal: 0,
      producedPerMinute: rate ?? 0,
      consumedPerMinute: 0,
    };
  }
  return { byItem };
}

describe('T45: ProductionGraph live sparkline chart', () => {
  it('tracks iron_plate, copper_plate, iron_gear, and red_science by default', () => {
    const graph = createProductionGraph();
    expect(graph.items).toEqual([
      'iron_plate',
      'copper_plate',
      'iron_gear',
      'red_science',
    ]);
    expect(graph.maxSamples).toBe(DEFAULT_MAX_SAMPLES);
    expect(graph.sampleIntervalTicks).toBe(DEFAULT_SAMPLE_INTERVAL_TICKS);

    const all = graph.getAllSeries();
    expect(all.map((s) => s.itemId)).toEqual([...PRODUCTION_GRAPH_ITEMS]);
    const uniqueColors = new Set(all.map((s) => s.color));
    expect(uniqueColors.size).toBe(4);
  });

  it('samples from StatsTracker and throttles according to sampleIntervalTicks', () => {
    const tracker = createStatsTracker();
    const graph = createProductionGraph({ sampleIntervalTicks: 60, maxSamples: 10 });

    tracker.recordProduced('iron_plate', 5, 0);
    expect(graph.sample(tracker.getSnapshot(0), 0)).toBe(true);
    expect(graph.getSampleCount()).toBe(1);
    expect(graph.getLastSampleTick()).toBe(0);

    // Within interval -> skipped
    tracker.recordProduced('iron_plate', 3, 30);
    expect(graph.sample(tracker.getSnapshot(30), 30)).toBe(false);
    expect(graph.getSampleCount()).toBe(1);

    // Forced sample within interval -> recorded
    expect(graph.sample(tracker.getSnapshot(30), 30, true)).toBe(true);
    expect(graph.getSampleCount()).toBe(2);

    // Next interval boundary from lastSampleTick (30 + 60 = 90)
    tracker.recordProduced('copper_plate', 4, 90);
    tracker.recordProduced('iron_gear', 2, 90);
    tracker.recordProduced('red_science', 1, 90);
    expect(graph.sample(tracker.getSnapshot(90), 90)).toBe(true);
    expect(graph.getSampleCount()).toBe(3);

    expect(graph.getSeries('iron_plate').samples).toEqual([5, 8, 8]);
    expect(graph.getSeries('copper_plate').samples).toEqual([0, 0, 4]);
    expect(graph.getSeries('iron_gear').samples).toEqual([0, 0, 2]);
    expect(graph.getSeries('red_science').samples).toEqual([0, 0, 1]);
    expect(graph.getSeries('red_science').latestTotal).toBe(1);
  });

  it('bounds history length to maxSamples via FIFO eviction', () => {
    const graph = createProductionGraph({ maxSamples: 3, sampleIntervalTicks: 10 });

    for (let i = 0; i < 5; i++) {
      const tick = i * 10;
      graph.sample(makeStats({ iron_plate: (i + 1) * 10 }), tick);
    }

    expect(graph.getSampleCount()).toBe(3);
    expect(graph.getSeries('iron_plate').samples).toEqual([30, 40, 50]);
    expect(graph.getSeries('iron_plate').latestRate).toBe(50);
    expect(graph.getSeries('iron_plate').maxRate).toBe(50);
    expect(graph.getSampleTicks()).toEqual([20, 30, 40]);

    graph.reset();
    expect(graph.getSampleCount()).toBe(0);
    expect(graph.getLastSampleTick()).toBeNull();
    expect(graph.getSeries('iron_plate').samples).toEqual([]);
  });

  it('computes sparkline geometry cleanly for empty, single, zero, and scaled series', () => {
    const bounds = { x: 10, y: 20, width: 100, height: 40 };

    expect(computeSparklinePoints([], bounds)).toEqual([]);

    const single = computeSparklinePoints([0], bounds);
    expect(single).toEqual([{ x: 110, y: 60 }]);

    const zeros = computeSparklinePoints([0, 0, 0], bounds);
    expect(zeros).toEqual([
      { x: 10, y: 60 },
      { x: 60, y: 60 },
      { x: 110, y: 60 },
    ]);

    const scaled = computeSparklinePoints([0, 5, 10], bounds);
    expect(scaled).toEqual([
      { x: 10, y: 60 },
      { x: 60, y: 40 },
      { x: 110, y: 20 },
    ]);
  });

  it('renders panel, labels, rates, and sparklines onto a Canvas 2D context', () => {
    const graph = createProductionGraph({ sampleIntervalTicks: 10 });
    graph.sample(makeStats({ iron_plate: 10, copper_plate: 5, iron_gear: 2, red_science: 1 }), 0);
    graph.sample(makeStats({ iron_plate: 20, copper_plate: 8, iron_gear: 4, red_science: 2 }), 10);

    const { ctx, calls } = createMockCanvasContext();
    renderProductionGraph(ctx, graph, DEFAULT_GRAPH_RECT);

    const saves = calls.filter((c) => c.method === 'save').length;
    const restores = calls.filter((c) => c.method === 'restore').length;
    expect(saves).toBe(1);
    expect(restores).toBe(1);

    const texts = calls
      .filter((c) => c.method === 'fillText')
      .map((c) => c.args[0] as string);
    expect(texts).toContain('PRODUCTION / MIN');
    expect(texts).toContain('Iron Plate');
    expect(texts).toContain('Copper Plate');
    expect(texts).toContain('Iron Gear');
    expect(texts).toContain('Red Science');
    expect(texts).toContain('20/m');
    expect(texts).toContain('8/m');
    expect(texts).toContain('4/m');
    expect(texts).toContain('2/m');

    // 4 baselines + 4 sparkline polylines = 8 stroke calls
    const strokes = calls.filter((c) => c.method === 'stroke');
    expect(strokes.length).toBe(8);
  });

  it('formats rates cleanly and fails closed on invalid inputs', () => {
    expect(formatRatePerMinute(12)).toBe('12/m');
    expect(formatRatePerMinute(12.34)).toBe('12.3/m');
    expect(formatRatePerMinute(Number.NaN)).toBe('0/m');

    expect(() => createProductionGraph({ maxSamples: 0 })).toThrow(SimulationError);
    expect(() => createProductionGraph({ sampleIntervalTicks: -1 })).toThrow(SimulationError);
    expect(() => createProductionGraph({ items: [] })).toThrow(SimulationError);
    expect(() =>
      createProductionGraph({ items: ['iron_plate', 'iron_plate'] })
    ).toThrow(SimulationError);
    expect(() =>
      createProductionGraph({ items: ['unknown_item' as ItemId] })
    ).toThrow(UnknownItemError);

    const graph = createProductionGraph({ sampleIntervalTicks: 10 });
    graph.sample(makeStats({ iron_plate: 5 }), 10);

    // Non-monotonic tick fails closed
    expect(() => graph.sample(makeStats({ iron_plate: 6 }), 5)).toThrow(SimulationError);

    // NaN rate fails closed atomically without mutating prior samples
    expect(() =>
      graph.sample(makeStats({ iron_plate: Number.NaN }), 20)
    ).toThrow(SimulationError);
    expect(graph.getSampleCount()).toBe(1);
    expect(graph.getSeries('iron_plate').samples).toEqual([5]);

    // Untracked item query fails closed
    expect(() => graph.getSeries('coal')).toThrow(SimulationError);

    // Invalid bounds / rect fail closed
    expect(() =>
      computeSparklinePoints([1, 2], { x: 0, y: 0, width: 0, height: 10 })
    ).toThrow(SimulationError);
    const { ctx } = createMockCanvasContext();
    expect(() =>
      renderProductionGraph(ctx, graph, { x: 0, y: 0, width: -5, height: 100 })
    ).toThrow(SimulationError);
  });

  it('is strictly deterministic across independent runs', () => {
    const run = () => {
      const g = createProductionGraph({ sampleIntervalTicks: 30, maxSamples: 5 });
      for (let tick = 0; tick <= 180; tick += 30) {
        g.sample(
          makeStats({
            iron_plate: tick / 10,
            copper_plate: tick / 15,
            iron_gear: tick / 30,
            red_science: tick >= 90 ? 1 : 0,
          }),
          tick
        );
      }
      return g.getAllSeries();
    };

    expect(run()).toEqual(run());
  });
});
