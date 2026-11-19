import { describe, expect, it } from 'vitest';
import {
  EntityManager,
  EntityNotFoundError,
} from '../src/core/entityManager';
import {
  InvalidPlacementError,
  OutOfBoundsError,
  SimulationError,
  type EntityType,
  type WorldState,
} from '../src/types/contracts';

const ALL_ENTITY_TYPES: readonly EntityType[] = [
  'transport_belt',
  'splitter',
  'underground_belt',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'burner_drill',
  'electric_drill',
  'stone_furnace',
  'electric_furnace',
  'assembler_mk1',
  'assembler_mk2',
  'boiler',
  'steam_engine',
  'solar_panel',
  'accumulator',
  'research_lab',
];

describe('T04 EntityManager', () => {
  it('assigns strictly monotonic deterministic IDs and never reuses destroyed IDs', () => {
    const manager = new EntityManager({ bounds: { width: 64, height: 64 } });

    expect(manager.getNextEntityId()).toBe(1);

    const e1 = manager.spawn('transport_belt', { x: 0, y: 0 });
    const e2 = manager.spawn('inserter', { x: 1, y: 0 });
    const e3 = manager.spawn('wooden_chest', { x: 2, y: 0 });

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e3.id).toBe(3);
    expect(manager.getNextEntityId()).toBe(4);

    manager.destroy(e2.id);
    expect(manager.has(e2.id)).toBe(false);
    expect(manager.getById(e2.id)).toBeUndefined();

    // Re-spawning at the freed tile must allocate ID 4, not reuse ID 2
    const e4 = manager.spawn('inserter', { x: 1, y: 0 });
    expect(e4.id).toBe(4);
    expect(manager.getNextEntityId()).toBe(5);
  });

  it('spawns all 19 EntityTypes with valid contract defaults', () => {
    const manager = new EntityManager({ bounds: { width: 64, height: 64 } });

    ALL_ENTITY_TYPES.forEach((type, index) => {
      const entity = manager.spawn(type, { x: index * 3, y: 10 }, { direction: 'E' });
      expect(entity.id).toBe(index + 1);
      expect(entity.type).toBe(type);
      expect(entity.direction).toBe('E');
      expect(entity.position).toEqual({ x: index * 3, y: 10 });
      expect(entity.active).toBe(false);
      expect(entity.powerNetworkId).toBeNull();
    });

    expect(manager.count()).toBe(ALL_ENTITY_TYPES.length);

    // Spot-check type-specific defaults
    const woodenChest = manager.getByType('wooden_chest')[0];
    expect(woodenChest?.inventory.capacity).toBe(16);
    expect(woodenChest?.inventory.slots).toHaveLength(16);

    const ironChest = manager.getByType('iron_chest')[0];
    expect(ironChest?.inventory.capacity).toBe(32);

    const pole = manager.getByType('power_pole')[0];
    expect(pole?.supplyRadius).toBe(5);
    expect(pole?.wireReach).toBe(7);

    const mk1 = manager.getByType('assembler_mk1')[0];
    expect(mk1?.powerDemandKw).toBe(75);
    expect(mk1?.craftingSpeed).toBe(0.5);
    expect(mk1?.maxIngredients).toBe(2);

    const mk2 = manager.getByType('assembler_mk2')[0];
    expect(mk2?.powerDemandKw).toBe(150);
    expect(mk2?.craftingSpeed).toBe(0.75);
    expect(mk2?.maxIngredients).toBe(4);

    const steamEngine = manager.getByType('steam_engine')[0];
    expect(steamEngine?.maxPowerOutputKw).toBe(900);
  });

  it('handles multi-tile splitter footprint occupancy, collision, bounds, and cleanup', () => {
    const manager = new EntityManager({ bounds: { width: 10, height: 10 } });

    const splitter = manager.spawn('splitter', { x: 4, y: 5 });
    expect(splitter.footprint).toEqual({ width: 2, height: 1 });
    expect(manager.getAt({ x: 4, y: 5 })?.id).toBe(splitter.id);
    expect(manager.getAt({ x: 5, y: 5 })?.id).toBe(splitter.id);

    // Colliding with second tile of splitter must fail closed
    expect(() => manager.spawn('transport_belt', { x: 5, y: 5 })).toThrow(
      InvalidPlacementError
    );

    // Placing splitter at x=9 on width=10 overflows to x=10 -> OutOfBoundsError
    expect(() => manager.spawn('splitter', { x: 9, y: 5 })).toThrow(
      OutOfBoundsError
    );

    // Destroying splitter frees both tiles
    manager.destroy(splitter.id);
    expect(manager.getAt({ x: 4, y: 5 })).toBeUndefined();
    expect(manager.getAt({ x: 5, y: 5 })).toBeUndefined();

    // Both tiles are now placeable again
    const b1 = manager.spawn('transport_belt', { x: 4, y: 5 });
    const b2 = manager.spawn('transport_belt', { x: 5, y: 5 });
    expect(b1.id).toBe(2);
    expect(b2.id).toBe(3);
  });

  it('rotates entities clockwise and counter-clockwise and fails closed on invalid calls', () => {
    const manager = new EntityManager();
    const belt = manager.spawn('transport_belt', { x: 0, y: 0 }, { direction: 'N' });

    expect(manager.rotate(belt.id).direction).toBe('E');
    expect(manager.rotate(belt.id).direction).toBe('S');
    expect(manager.rotate(belt.id).direction).toBe('W');
    expect(manager.rotate(belt.id).direction).toBe('N');
    expect(manager.rotate(belt.id, -1).direction).toBe('W');
    expect(manager.rotate(belt.id, 2).direction).toBe('E');

    expect(() => manager.rotate(999)).toThrow(EntityNotFoundError);
    expect(() => manager.rotate(belt.id, 1.5)).toThrow(SimulationError);
  });

  it('queries by ID, type, and position in deterministic ascending ID order', () => {
    const manager = new EntityManager();

    const b1 = manager.spawn('transport_belt', { x: 0, y: 0 });
    const f1 = manager.spawn('stone_furnace', { x: 1, y: 0 });
    const b2 = manager.spawn('transport_belt', { x: 2, y: 0 });
    const b3 = manager.spawn('transport_belt', { x: 3, y: 0 });

    expect(manager.getByIdOrThrow(f1.id)).toBe(f1);
    expect(() => manager.getByIdOrThrow(42)).toThrow(EntityNotFoundError);

    const belts = manager.getByType('transport_belt');
    expect(belts.map((b) => b.id)).toEqual([b1.id, b2.id, b3.id]);
    expect(manager.countByType('transport_belt')).toBe(3);
    expect(manager.countByType('stone_furnace')).toBe(1);
    expect(manager.countByType('solar_panel')).toBe(0);

    expect(manager.getAll().map((e) => e.id)).toEqual([b1.id, f1.id, b2.id, b3.id]);
  });

  it('fails closed without mutating nextEntityId on invalid spawns or destroys', () => {
    const manager = new EntityManager({ bounds: { width: 8, height: 8 } });

    expect(() => manager.spawn('transport_belt', { x: -1, y: 0 })).toThrow(
      OutOfBoundsError
    );
    expect(() => manager.spawn('transport_belt', { x: 8, y: 0 })).toThrow(
      OutOfBoundsError
    );
    expect(() => manager.spawn('transport_belt', { x: 1.5, y: 0 })).toThrow(
      InvalidPlacementError
    );
    expect(() =>
      manager.spawn('filter_inserter', { x: 0, y: 0 }, {
        filters: ['iron_ore', 'copper_ore', 'coal', 'stone'],
      })
    ).toThrow(InvalidPlacementError);
    expect(() =>
      manager.spawn('unknown_machine' as EntityType, { x: 0, y: 0 })
    ).toThrow(SimulationError);

    // None of the failed spawns should have consumed an ID
    expect(manager.getNextEntityId()).toBe(1);
    expect(manager.count()).toBe(0);

    expect(() => manager.destroy(1)).toThrow(EntityNotFoundError);
  });

  it('hydrates from WorldState preserving nextEntityId and occupancy', () => {
    const source = new EntityManager({ bounds: { width: 16, height: 16 } });
    const e1 = source.spawn('burner_drill', { x: 3, y: 4 }, { direction: 'S' });
    const e2 = source.spawn('stone_furnace', { x: 3, y: 5 });
    source.destroy(e1.id);

    const world: WorldState = {
      schemaVersion: 1,
      seed: 1616,
      tick: 10,
      width: 16,
      height: 16,
      tiles: [],
      entities: source.toRecord(),
      nextEntityId: source.getNextEntityId(),
      powerGrid: { networks: {}, nextNetworkId: 1 },
      research: { activeTech: null, completedTechs: [], progress: {} },
      dayNight: { cycleTick: 0, solarFactor: 1 },
      stats: { byItem: {} },
    };

    const hydrated = EntityManager.fromWorldState(world);
    expect(hydrated.getNextEntityId()).toBe(3);
    expect(hydrated.count()).toBe(1);
    expect(hydrated.getById(e2.id)?.type).toBe('stone_furnace');
    expect(hydrated.getAt({ x: 3, y: 5 })?.id).toBe(e2.id);

    const e3 = hydrated.spawn('transport_belt', { x: 3, y: 4 });
    expect(e3.id).toBe(3);
  });

  it('produces bit-for-bit identical state across two independent runs', () => {
    const runSequence = () => {
      const m = new EntityManager({ bounds: { width: 32, height: 32 } });
      const a = m.spawn('electric_drill', { x: 5, y: 5 }, { direction: 'E' });
      const b = m.spawn('transport_belt', { x: 6, y: 5 }, { direction: 'E' });
      const c = m.spawn('inserter', { x: 7, y: 5 }, { direction: 'E' });
      m.rotate(b.id, 1);
      m.destroy(a.id);
      m.spawn('assembler_mk1', { x: 8, y: 5 }, { recipeId: 'iron_gear' });
      return {
        nextId: m.getNextEntityId(),
        json: JSON.stringify(m.toRecord()),
        cId: c.id,
      };
    };

    const run1 = runSequence();
    const run2 = runSequence();
    expect(run1).toEqual(run2);
  });
});
