import { describe, expect, it } from 'vitest';
import {
  FIXED_TIMESTEP_MS,
  FIXED_TIMESTEP_SEC,
  TickLoop,
} from '../src/core/tickLoop';
import {
  SimulationError,
  TICK_PHASES,
  TICKS_PER_SECOND,
  type TickPhase,
  type WorldState,
} from '../src/types/contracts';

function createMinimalWorld(seed = 1616): WorldState {
  return {
    schemaVersion: 1,
    seed,
    tick: 0,
    width: 1,
    height: 1,
    tiles: [
      {
        x: 0,
        y: 0,
        terrain: 'grass',
        resource: null,
        entityId: null,
      },
    ],
    entities: {},
    nextEntityId: 1,
    powerGrid: {
      networks: {},
      nextNetworkId: 1,
    },
    research: {
      activeTech: null,
      completedTechs: [],
      progress: {},
    },
    dayNight: {
      cycleTick: 0,
      solarFactor: 1,
    },
    stats: {
      byItem: {},
    },
  };
}

describe('T03: Fixed-Timestep Deterministic TickLoop', () => {
  it('defaults to 60 ticks/sec with matching timestep constants', () => {
    const loop = new TickLoop();
    expect(loop.ticksPerSecond).toBe(TICKS_PER_SECOND);
    expect(loop.ticksPerSecond).toBe(60);
    expect(loop.fixedTimestepMs).toBeCloseTo(FIXED_TIMESTEP_MS, 10);
    expect(loop.fixedTimestepSec).toBeCloseTo(FIXED_TIMESTEP_SEC, 10);
  });

  it('executes phases in strict canonical order regardless of registration order', () => {
    const loop = new TickLoop();
    const world = createMinimalWorld();
    const executionOrder: TickPhase[] = [];

    // Register in reverse order to prove canonical phase ordering is enforced.
    for (const phase of [...TICK_PHASES].reverse()) {
      loop.registerPhaseHandler(phase, (ctx) => {
        expect(ctx.world).toBe(world);
        expect(ctx.tick).toBe(1);
        expect(ctx.dt).toBeCloseTo(1 / 60, 10);
        expect(ctx.phase).toBe(phase);
        executionOrder.push(ctx.phase);
      });
    }

    const newTick = loop.stepTick(world);
    expect(newTick).toBe(1);
    expect(world.tick).toBe(1);
    expect(executionOrder).toEqual([
      'power',
      'mining',
      'smelting_assembling',
      'inserters',
      'belts',
      'stats',
    ]);
  });

  it('runs multiple handlers within a phase in FIFO order and supports unsubscribe', () => {
    const loop = new TickLoop();
    const world = createMinimalWorld();
    const log: string[] = [];

    const unsubA = loop.registerPhaseHandler('mining', () => log.push('A'));
    loop.registerPhaseHandler('mining', () => log.push('B'));
    loop.registerPhaseHandler('mining', () => log.push('C'));

    expect(loop.getHandlerCount('mining')).toBe(3);

    loop.stepTick(world);
    expect(log).toEqual(['A', 'B', 'C']);

    unsubA();
    // Calling unsubscribe twice is a safe no-op.
    unsubA();
    expect(loop.getHandlerCount('mining')).toBe(2);

    log.length = 0;
    loop.stepTick(world);
    expect(log).toEqual(['B', 'C']);
  });

  it('supports constructor handler map and clearPhaseHandlers', () => {
    const log: string[] = [];
    const loop = new TickLoop({
      handlers: {
        power: () => log.push('power'),
        belts: [() => log.push('belts-1'), () => log.push('belts-2')],
      },
    });
    const world = createMinimalWorld();

    loop.stepTick(world);
    expect(log).toEqual(['power', 'belts-1', 'belts-2']);

    loop.clearPhaseHandlers('belts');
    expect(loop.getHandlerCount('belts')).toBe(0);
    expect(loop.getHandlerCount('power')).toBe(1);

    loop.clearPhaseHandlers();
    expect(loop.getHandlerCount('power')).toBe(0);
  });

  it('advances exactly 60 ticks for 1000ms with zero floating-point drift', () => {
    const loop = new TickLoop();
    const world = createMinimalWorld();

    const executed = loop.advance(world, 1000);
    expect(executed).toBe(60);
    expect(world.tick).toBe(60);
    expect(loop.getAccumulatorMs()).toBe(0);
    expect(loop.getAlpha()).toBe(0);
  });

  it('accumulates fractional sub-tick deltas deterministically', () => {
    const loop = new TickLoop();
    const world = createMinimalWorld();

    // 10ms < 16.666...ms -> 0 ticks
    expect(loop.advance(world, 10)).toBe(0);
    expect(world.tick).toBe(0);
    expect(loop.getAccumulatorMs()).toBeCloseTo(10, 10);
    expect(loop.getAlpha()).toBeCloseTo(0.6, 10);

    // +10ms = 20ms -> 1 tick, 3.333...ms remainder
    expect(loop.advance(world, 10)).toBe(1);
    expect(world.tick).toBe(1);
    expect(loop.getAccumulatorMs()).toBeCloseTo(10 / 3, 10);
    expect(loop.getAlpha()).toBeCloseTo(0.2, 10);

    loop.resetAccumulator();
    expect(loop.getAccumulatorMs()).toBe(0);
    expect(loop.getAlpha()).toBe(0);
  });

  it('respects maxTicksPerAdvance and pause/resume controls', () => {
    const loop = new TickLoop({ maxTicksPerAdvance: 5 });
    const world = createMinimalWorld();

    // 1000ms would be 60 ticks, capped at 5
    expect(loop.advance(world, 1000)).toBe(5);
    expect(world.tick).toBe(5);
    expect(loop.getAccumulatorMs()).toBe(0);

    loop.pause();
    expect(loop.isPaused()).toBe(true);
    expect(loop.advance(world, 100)).toBe(0);
    expect(world.tick).toBe(5);

    // Explicit stepTicks still works while paused (for headless stepping / debugging)
    expect(loop.stepTicks(world, 3)).toBe(8);
    expect(world.tick).toBe(8);

    loop.resume();
    expect(loop.isPaused()).toBe(false);
    expect(loop.advance(world, 50)).toBe(3);
    expect(world.tick).toBe(11);
  });

  it('produces bit-for-bit identical world states across two independent runs', () => {
    const runSimulation = () => {
      const world = createMinimalWorld(1616);
      const loop = new TickLoop({
        handlers: {
          power: ({ world: w }) => {
            w.dayNight.cycleTick = w.tick % 3600;
          },
          stats: ({ world: w }) => {
            const rec = w.stats.byItem.iron_plate ?? {
              producedTotal: 0,
              consumedTotal: 0,
              producedPerMinute: 0,
              consumedPerMinute: 0,
            };
            rec.producedTotal += 1;
            w.stats.byItem.iron_plate = rec;
          },
        },
      });
      loop.stepTicks(world, 120);
      loop.advance(world, 500);
      return JSON.stringify(world);
    };

    const runA = runSimulation();
    const runB = runSimulation();
    expect(runA).toBe(runB);
  });

  it('fails closed on invalid inputs and propagates handler errors', () => {
    expect(() => new TickLoop({ ticksPerSecond: 0 })).toThrow(SimulationError);
    expect(() => new TickLoop({ ticksPerSecond: -60 })).toThrow(SimulationError);
    expect(() => new TickLoop({ ticksPerSecond: 30.5 })).toThrow(SimulationError);
    expect(() => new TickLoop({ maxTicksPerAdvance: 0 })).toThrow(SimulationError);
    expect(() => new TickLoop({ maxTicksPerAdvance: -1 })).toThrow(SimulationError);

    const loop = new TickLoop();
    const world = createMinimalWorld();

    expect(() =>
      loop.registerPhaseHandler('invalid_phase' as TickPhase, () => {})
    ).toThrow(SimulationError);
    expect(() => loop.stepTicks(world, -1)).toThrow(SimulationError);
    expect(() => loop.stepTicks(world, 1.5)).toThrow(SimulationError);
    expect(() => loop.advance(world, -16)).toThrow(SimulationError);
    expect(() => loop.advance(world, Number.NaN)).toThrow(SimulationError);
    expect(() => loop.advance(world, Number.POSITIVE_INFINITY)).toThrow(
      SimulationError
    );

    const corruptWorld = createMinimalWorld();
    corruptWorld.tick = -1;
    expect(() => loop.stepTick(corruptWorld)).toThrow(SimulationError);

    // Handler errors must not be swallowed.
    loop.registerPhaseHandler('power', () => {
      throw new SimulationError('TEST_FAULT', 'Intentional phase fault');
    });
    expect(() => loop.stepTick(world)).toThrow('Intentional phase fault');
  });
});
