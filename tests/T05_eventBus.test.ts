import { describe, it, expect, vi } from 'vitest';
import {
  EventBus,
  createEventBus,
  SIMULATION_EVENT_TYPES,
} from '../src/core/eventBus.js';
import {
  SimulationError,
  type ItemProducedEvent,
  type EntityPlacedEvent,
  type EntityRemovedEvent,
  type ResearchCompletedEvent,
  type PowerBrownoutEvent,
  type SimulationEventType,
} from '../src/types/contracts.js';

describe('T05: Typed Simulation EventBus', () => {
  it('supports all five canonical simulation event types', () => {
    expect(SIMULATION_EVENT_TYPES).toEqual([
      'itemProduced',
      'entityPlaced',
      'entityRemoved',
      'researchCompleted',
      'powerBrownout',
    ]);

    const bus = createEventBus();
    expect(bus).toBeInstanceOf(EventBus);

    const produced: ItemProducedEvent[] = [];
    const placed: EntityPlacedEvent[] = [];
    const removed: EntityRemovedEvent[] = [];
    const researched: ResearchCompletedEvent[] = [];
    const brownouts: PowerBrownoutEvent[] = [];

    bus.on('itemProduced', (e) => produced.push(e));
    bus.on('entityPlaced', (e) => placed.push(e));
    bus.on('entityRemoved', (e) => removed.push(e));
    bus.on('researchCompleted', (e) => researched.push(e));
    bus.on('powerBrownout', (e) => brownouts.push(e));

    expect(bus.listenerCount()).toBe(5);

    const p1: ItemProducedEvent = { tick: 10, itemId: 'iron_plate', count: 2, entityId: 1 };
    const p2: EntityPlacedEvent = { tick: 11, entityId: 2, entityType: 'transport_belt', position: { x: 4, y: 5 } };
    const p3: EntityRemovedEvent = { tick: 12, entityId: 2, entityType: 'transport_belt', position: { x: 4, y: 5 } };
    const p4: ResearchCompletedEvent = { tick: 120, techId: 'automation' };
    const p5: PowerBrownoutEvent = { tick: 150, networkId: 1, satisfaction: 0.5, supplyKw: 450, demandKw: 900 };

    bus.emit('itemProduced', p1);
    bus.emit('entityPlaced', p2);
    bus.emit('entityRemoved', p3);
    bus.emit('researchCompleted', p4);
    bus.emit('powerBrownout', p5);

    expect(produced).toEqual([p1]);
    expect(placed).toEqual([p2]);
    expect(removed).toEqual([p3]);
    expect(researched).toEqual([p4]);
    expect(brownouts).toEqual([p5]);
  });

  it('invokes handlers deterministically in FIFO registration order', () => {
    const bus = createEventBus();
    const order: string[] = [];

    bus.on('itemProduced', () => order.push('first'));
    bus.on('itemProduced', () => order.push('second'));
    bus.on('itemProduced', () => order.push('third'));

    bus.emit('itemProduced', { tick: 1, itemId: 'coal', count: 1, entityId: 7 });
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('unsubscribes cleanly via returned function and is idempotent', () => {
    const bus = createEventBus();
    const calls: number[] = [];

    const unsub = bus.on('researchCompleted', (e) => calls.push(e.tick));
    bus.emit('researchCompleted', { tick: 10, techId: 'automation' });
    expect(calls).toEqual([10]);
    expect(bus.listenerCount('researchCompleted')).toBe(1);

    unsub();
    unsub(); // idempotent second call
    expect(bus.listenerCount('researchCompleted')).toBe(0);

    bus.emit('researchCompleted', { tick: 20, techId: 'logistics' });
    expect(calls).toEqual([10]);
  });

  it('unsubscribes via off() without affecting other handlers', () => {
    const bus = createEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on('powerBrownout', h1);
    bus.on('powerBrownout', h2);
    bus.off('powerBrownout', h1);

    const payload: PowerBrownoutEvent = {
      tick: 50,
      networkId: 1,
      satisfaction: 0.25,
      supplyKw: 100,
      demandKw: 400,
    };
    bus.emit('powerBrownout', payload);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledWith(payload);
  });

  it('supports once() including safe re-entrant emission and pre-emit cancellation', () => {
    const bus = createEventBus();
    const calls: number[] = [];

    bus.once('itemProduced', (e) => {
      calls.push(e.tick);
      // Re-entrant emit should NOT trigger this once() handler a second time
      bus.emit('itemProduced', { tick: e.tick + 1, itemId: 'iron_ore', count: 1, entityId: 1 });
    });

    const cancelled = vi.fn();
    const unsubCancelled = bus.once('itemProduced', cancelled);
    unsubCancelled();

    bus.emit('itemProduced', { tick: 1, itemId: 'iron_ore', count: 1, entityId: 1 });
    bus.emit('itemProduced', { tick: 3, itemId: 'iron_ore', count: 1, entityId: 1 });

    expect(calls).toEqual([1]);
    expect(cancelled).not.toHaveBeenCalled();
    expect(bus.listenerCount('itemProduced')).toBe(0);
  });

  it('handles subscription mutations deterministically during emit', () => {
    const bus = createEventBus();
    const log: string[] = [];

    const secondHandler = () => {
      log.push('second');
    };
    const lateHandler = () => {
      log.push('late');
    };

    bus.on('entityPlaced', () => {
      log.push('first');
      // Unsubscribe a later handler before it runs in this emit
      bus.off('entityPlaced', secondHandler);
      // Subscribe a new handler during emit (should not run until next emit)
      bus.on('entityPlaced', lateHandler);
    });
    bus.on('entityPlaced', secondHandler);

    const payload: EntityPlacedEvent = {
      tick: 5,
      entityId: 10,
      entityType: 'stone_furnace',
      position: { x: 1, y: 2 },
    };

    bus.emit('entityPlaced', payload);
    expect(log).toEqual(['first']);

    bus.emit('entityPlaced', payload);
    expect(log).toEqual(['first', 'first', 'late']);
  });

  it('clears listeners for a single event or all events', () => {
    const bus = createEventBus();
    bus.on('itemProduced', () => {});
    bus.on('entityPlaced', () => {});
    bus.on('entityRemoved', () => {});

    expect(bus.listenerCount()).toBe(3);
    bus.clear('entityPlaced');
    expect(bus.listenerCount('entityPlaced')).toBe(0);
    expect(bus.listenerCount()).toBe(2);

    bus.clear();
    expect(bus.listenerCount()).toBe(0);
  });

  it('fails closed on unknown event types, invalid handlers, and handler exceptions', () => {
    const bus = createEventBus();

    expect(() =>
      bus.on('nonexistentEvent' as SimulationEventType, () => {})
    ).toThrow(SimulationError);

    expect(() =>
      bus.emit('nonexistentEvent' as SimulationEventType, {} as never)
    ).toThrow(SimulationError);

    expect(() =>
      bus.on('itemProduced', null as unknown as (e: ItemProducedEvent) => void)
    ).toThrow(SimulationError);

    // Handler exceptions must propagate (never swallowed)
    bus.on('entityRemoved', () => {
      throw new Error('handler failure');
    });

    expect(() =>
      bus.emit('entityRemoved', {
        tick: 99,
        entityId: 42,
        entityType: 'inserter',
        position: { x: 0, y: 0 },
      })
    ).toThrow('handler failure');
  });
});
