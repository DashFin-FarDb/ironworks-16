/**
 * Fixed-timestep deterministic tick loop (T03).
 *
 * Executes simulation phases in strict canonical order:
 *   power -> mining -> smelting_assembling -> inserters -> belts -> stats
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

import {
  SimulationError,
  TICK_PHASES,
  TICKS_PER_SECOND,
  type TickPhase,
  type WorldState,
} from '../types/contracts';

export const FIXED_TIMESTEP_MS = 1000 / TICKS_PER_SECOND;
export const FIXED_TIMESTEP_SEC = 1 / TICKS_PER_SECOND;

export interface TickContext {
  readonly world: WorldState;
  readonly tick: number;
  /** Fixed simulation delta in seconds (1 / ticksPerSecond). */
  readonly dt: number;
  readonly phase: TickPhase;
}

export type PhaseHandler = (ctx: TickContext) => void;

export type PhaseHandlerMap = Partial<
  Record<TickPhase, PhaseHandler | readonly PhaseHandler[]>
>;

export interface TickLoopOptions {
  /** Simulation ticks per second. Defaults to TICKS_PER_SECOND (60). */
  readonly ticksPerSecond?: number;
  /** Optional cap on ticks executed per advance() call (for browser spiral-of-death protection). */
  readonly maxTicksPerAdvance?: number;
  /** Initial phase handlers to register. */
  readonly handlers?: PhaseHandlerMap;
}

const VALID_PHASES: ReadonlySet<string> = new Set<string>(TICK_PHASES);

function assertValidPhase(phase: TickPhase): void {
  if (!VALID_PHASES.has(phase)) {
    throw new SimulationError(
      'INVALID_TICK_PHASE',
      `Unknown tick phase: "${String(phase)}".`
    );
  }
}

export class TickLoop {
  readonly ticksPerSecond: number;
  readonly fixedTimestepMs: number;
  readonly fixedTimestepSec: number;
  readonly maxTicksPerAdvance: number;

  private readonly phaseHandlers: Record<TickPhase, PhaseHandler[]>;
  /**
   * Stored in scaled units of (ms * ticksPerSecond) so that 1 tick === 1000 units.
   * Avoids floating-point drift on integer millisecond deltas (e.g. 1000ms -> exact 60 ticks).
   */
  private accumulatorScaled = 0;
  private paused = false;

  constructor(options: TickLoopOptions = {}) {
    const tps = options.ticksPerSecond ?? TICKS_PER_SECOND;
    if (!Number.isInteger(tps) || tps <= 0) {
      throw new SimulationError(
        'INVALID_TICK_RATE',
        `ticksPerSecond must be a positive integer, received: ${String(tps)}.`
      );
    }

    const maxTicks = options.maxTicksPerAdvance ?? Number.POSITIVE_INFINITY;
    if (
      maxTicks !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(maxTicks) || maxTicks <= 0)
    ) {
      throw new SimulationError(
        'INVALID_MAX_TICKS',
        `maxTicksPerAdvance must be a positive integer or Infinity, received: ${String(maxTicks)}.`
      );
    }

    this.ticksPerSecond = tps;
    this.fixedTimestepMs = 1000 / tps;
    this.fixedTimestepSec = 1 / tps;
    this.maxTicksPerAdvance = maxTicks;

    this.phaseHandlers = {
      power: [],
      mining: [],
      smelting_assembling: [],
      inserters: [],
      belts: [],
      stats: [],
    };

    if (options.handlers) {
      for (const phase of TICK_PHASES) {
        const entry = options.handlers[phase];
        if (!entry) continue;
        if (typeof entry === 'function') {
          this.registerPhaseHandler(phase, entry);
        } else {
          for (const fn of entry) {
            this.registerPhaseHandler(phase, fn);
          }
        }
      }
    }
  }

  /**
   * Register a handler for a specific simulation phase.
   * Handlers within a phase execute in FIFO registration order.
   * Returns an unsubscribe function.
   */
  registerPhaseHandler(phase: TickPhase, handler: PhaseHandler): () => void {
    assertValidPhase(phase);
    const list = this.phaseHandlers[phase];
    list.push(handler);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = list.indexOf(handler);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    };
  }

  /** Remove all handlers for a specific phase, or for all phases if omitted. */
  clearPhaseHandlers(phase?: TickPhase): void {
    if (phase !== undefined) {
      assertValidPhase(phase);
      this.phaseHandlers[phase].length = 0;
      return;
    }
    for (const p of TICK_PHASES) {
      this.phaseHandlers[p].length = 0;
    }
  }

  /** Return the number of registered handlers for a phase. */
  getHandlerCount(phase: TickPhase): number {
    assertValidPhase(phase);
    return this.phaseHandlers[phase].length;
  }

  isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Remaining unconsumed time in milliseconds. */
  getAccumulatorMs(): number {
    return this.accumulatorScaled / this.ticksPerSecond;
  }

  /** Normalized interpolation alpha in [0, 1) for rendering between ticks. */
  getAlpha(): number {
    return this.accumulatorScaled / 1000;
  }

  resetAccumulator(): void {
    this.accumulatorScaled = 0;
  }

  /**
   * Execute exactly one deterministic simulation tick across all phases in order.
   * Increments `world.tick` by 1 and returns the new tick number.
   */
  stepTick(world: WorldState): number {
    if (!Number.isInteger(world.tick) || world.tick < 0) {
      throw new SimulationError(
        'INVALID_WORLD_TICK',
        `world.tick must be a non-negative integer, received: ${String(world.tick)}.`
      );
    }

    world.tick += 1;
    const tick = world.tick;
    const dt = this.fixedTimestepSec;

    for (const phase of TICK_PHASES) {
      const handlers = this.phaseHandlers[phase];
      if (handlers.length === 0) continue;

      const ctx: TickContext = { world, tick, dt, phase };
      for (let i = 0; i < handlers.length; i += 1) {
        const handler = handlers[i];
        if (handler) {
          handler(ctx);
        }
      }
    }

    return tick;
  }

  /**
   * Execute `count` deterministic simulation ticks.
   * Returns the updated `world.tick`.
   */
  stepTicks(world: WorldState, count: number): number {
    if (!Number.isInteger(count) || count < 0) {
      throw new SimulationError(
        'INVALID_TICK_COUNT',
        `Tick count must be a non-negative integer, received: ${String(count)}.`
      );
    }

    for (let i = 0; i < count; i += 1) {
      this.stepTick(world);
    }

    return world.tick;
  }

  /**
   * Advance the fixed-timestep accumulator by `deltaMs` milliseconds and execute
   * as many fixed 1/60s ticks as fit (up to `maxTicksPerAdvance`).
   * Returns the number of ticks executed.
   */
  advance(world: WorldState, deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new SimulationError(
        'INVALID_DELTA_TIME',
        `deltaMs must be a finite non-negative number, received: ${String(deltaMs)}.`
      );
    }

    if (this.paused || deltaMs === 0) {
      return 0;
    }

    this.accumulatorScaled += deltaMs * this.ticksPerSecond;

    let ticksExecuted = 0;
    while (
      this.accumulatorScaled >= 1000 &&
      ticksExecuted < this.maxTicksPerAdvance
    ) {
      this.accumulatorScaled -= 1000;
      this.stepTick(world);
      ticksExecuted += 1;
    }

    // If capped by maxTicksPerAdvance, discard excess backlog to prevent spiral of death.
    if (
      ticksExecuted === this.maxTicksPerAdvance &&
      this.accumulatorScaled >= 1000
    ) {
      this.accumulatorScaled = 0;
    }

    return ticksExecuted;
  }
}
