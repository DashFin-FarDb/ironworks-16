/**
 * Ironworks-16 Typed Simulation Event Bus (T05)
 *
 * Deterministic, synchronous, fail-closed pub/sub bus for simulation events:
 * - itemProduced
 * - entityPlaced
 * - entityRemoved
 * - researchCompleted
 * - powerBrownout
 *
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: FIFO handler invocation order, no Math.random() or Date.now().
 */

import {
  SimulationError,
  type EventHandler,
  type SimulationEventMap,
  type SimulationEventType,
} from '../types/contracts.js';

export const SIMULATION_EVENT_TYPES: readonly SimulationEventType[] = [
  'itemProduced',
  'entityPlaced',
  'entityRemoved',
  'researchCompleted',
  'powerBrownout',
] as const;

const VALID_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SIMULATION_EVENT_TYPES);

export type Unsubscribe = () => void;

interface Subscription<K extends SimulationEventType> {
  readonly handler: EventHandler<K>;
  readonly once: boolean;
  active: boolean;
}

function assertValidEventType(event: string): asserts event is SimulationEventType {
  if (!VALID_EVENT_TYPE_SET.has(event)) {
    throw new SimulationError(
      'UNKNOWN_EVENT_TYPE',
      `Unknown simulation event type: "${String(event)}".`
    );
  }
}

function assertValidHandler(handler: unknown): void {
  if (typeof handler !== 'function') {
    throw new SimulationError(
      'INVALID_EVENT_HANDLER',
      'Event handler must be a function.'
    );
  }
}

export class EventBus {
  private readonly subscriptions: {
    [K in SimulationEventType]: Subscription<K>[];
  } = {
    itemProduced: [],
    entityPlaced: [],
    entityRemoved: [],
    researchCompleted: [],
    powerBrownout: [],
  };

  /**
   * Subscribe to a simulation event. Handlers are invoked in FIFO registration order.
   * Returns an idempotent unsubscribe function.
   */
  on<K extends SimulationEventType>(
    event: K,
    handler: EventHandler<K>
  ): Unsubscribe {
    return this.addSubscription(event, handler, false);
  }

  /**
   * Subscribe to a simulation event for a single emission.
   * Automatically unsubscribes before invoking the handler.
   * Returns an idempotent unsubscribe function.
   */
  once<K extends SimulationEventType>(
    event: K,
    handler: EventHandler<K>
  ): Unsubscribe {
    return this.addSubscription(event, handler, true);
  }

  /**
   * Unsubscribe a specific handler from a simulation event.
   * If the same handler was registered multiple times, removes all matching registrations.
   */
  off<K extends SimulationEventType>(
    event: K,
    handler: EventHandler<K>
  ): void {
    assertValidEventType(event);
    assertValidHandler(handler);

    const list = this.subscriptions[event];
    let writeIdx = 0;
    for (let i = 0; i < list.length; i++) {
      const sub = list[i]!;
      if (sub.handler === handler) {
        sub.active = false;
      } else {
        list[writeIdx] = sub;
        writeIdx++;
      }
    }
    list.length = writeIdx;
  }

  /**
   * Synchronously emit an event to all currently subscribed handlers in registration order.
   * Fail-closed: handler exceptions propagate directly without being swallowed.
   */
  emit<K extends SimulationEventType>(
    event: K,
    payload: SimulationEventMap[K]
  ): void {
    assertValidEventType(event);

    const list = this.subscriptions[event];
    if (list.length === 0) {
      return;
    }

    // Snapshot current subscriptions for deterministic iteration even if handlers mutate subscriptions.
    const snapshot = list.slice();

    for (let i = 0; i < snapshot.length; i++) {
      const sub = snapshot[i]!;
      if (!sub.active) {
        continue;
      }
      if (sub.once) {
        this.removeSubscription(event, sub);
      }
      sub.handler(payload);
    }
  }

  /**
   * Returns the number of active listeners for a specific event, or total across all events.
   */
  listenerCount(event?: SimulationEventType): number {
    if (event !== undefined) {
      assertValidEventType(event);
      return this.subscriptions[event].length;
    }
    let total = 0;
    for (const key of SIMULATION_EVENT_TYPES) {
      total += this.subscriptions[key].length;
    }
    return total;
  }

  /**
   * Removes all listeners for a specific event, or all events if omitted.
   */
  clear(event?: SimulationEventType): void {
    if (event !== undefined) {
      assertValidEventType(event);
      const list = this.subscriptions[event];
      for (let i = 0; i < list.length; i++) {
        list[i]!.active = false;
      }
      list.length = 0;
      return;
    }

    for (const key of SIMULATION_EVENT_TYPES) {
      const list = this.subscriptions[key];
      for (let i = 0; i < list.length; i++) {
        list[i]!.active = false;
      }
      list.length = 0;
    }
  }

  private addSubscription<K extends SimulationEventType>(
    event: K,
    handler: EventHandler<K>,
    once: boolean
  ): Unsubscribe {
    assertValidEventType(event);
    assertValidHandler(handler);

    const sub: Subscription<K> = {
      handler,
      once,
      active: true,
    };

    this.subscriptions[event].push(sub);

    return () => {
      this.removeSubscription(event, sub);
    };
  }

  private removeSubscription<K extends SimulationEventType>(
    event: K,
    target: Subscription<K>
  ): void {
    if (!target.active) {
      return;
    }
    target.active = false;
    const list = this.subscriptions[event];
    const idx = list.indexOf(target);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
}
