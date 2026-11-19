import { describe, expect, it } from 'vitest';
import {
  canonicalStringify,
  deserializeWorldState,
  hashWorldState,
  serializeWorldState,
} from '../src/core/serializer';
import {
  DeserializationError,
  SimulationError,
  type BeltEntity,
  type StoneFurnaceEntity,
  type WorldState,
} from '../src/types/contracts';

function makeSampleWorldState(): WorldState {
  const belt: BeltEntity = {
    id: 1,
    type: 'transport_belt',
    position: { x: 0, y: 0 },
    direction: 'E',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    shape: 'straight',
    leftLane: { items: [{ itemId: 'iron_ore', offset: 0.25 }] },
    rightLane: { items: [] },
  };

  const furnace: StoneFurnaceEntity = {
    id: 2,
    type: 'stone_furnace',
    position: { x: 1, y: 1 },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    inputInventory: {
      capacity: 1,
      slots: [{ item: { itemId: 'iron_ore', count: 5 }, filter: null }],
    },
    outputInventory: {
      capacity: 1,
      slots: [{ item: { itemId: 'iron_plate', count: 2 }, filter: null }],
    },
    fuelInventory: {
      capacity: 1,
      slots: [{ item: { itemId: 'coal', count: 10 }, filter: 'coal' }],
    },
    fuelEnergyKj: 1500,
    activeRecipe: 'iron_plate',
    craftingProgress: 30,
  };

  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 120,
    width: 2,
    height: 2,
    tiles: [
      {
        x: 0,
        y: 0,
        terrain: 'grass',
        resource: { type: 'iron_ore', amount: 500, initialAmount: 600 },
        entityId: 1,
      },
      {
        x: 1,
        y: 0,
        terrain: 'dirt',
        resource: null,
        entityId: null,
      },
      {
        x: 0,
        y: 1,
        terrain: 'sand',
        resource: { type: 'coal', amount: 300, initialAmount: 300 },
        entityId: null,
      },
      {
        x: 1,
        y: 1,
        terrain: 'stone_ground',
        resource: null,
        entityId: 2,
      },
    ],
    entities: {
      1: belt,
      2: furnace,
    },
    nextEntityId: 3,
    powerGrid: {
      nextNetworkId: 2,
      networks: {
        1: {
          id: 1,
          poleIds: [],
          producerIds: [],
          consumerIds: [],
          accumulatorIds: [],
          totalSupplyKw: 0,
          totalDemandKw: 0,
          satisfaction: 1,
        },
      },
    },
    research: {
      activeTech: 'automation',
      completedTechs: [],
      progress: { red_science: 4 },
    },
    dayNight: {
      cycleTick: 120,
      solarFactor: 1,
    },
    stats: {
      byItem: {
        iron_plate: {
          producedTotal: 12,
          consumedTotal: 4,
          producedPerMinute: 24,
          consumedPerMinute: 8,
        },
      },
    },
  };
}

describe('T10: WorldState Serializer', () => {
  it('round-trips a WorldState with zero drift and idempotent canonical JSON', () => {
    const original = makeSampleWorldState();
    const json1 = serializeWorldState(original);
    const restored = deserializeWorldState(json1);
    const json2 = serializeWorldState(restored);

    expect(restored).toEqual(original);
    expect(json2).toBe(json1);
    expect(hashWorldState(restored)).toBe(hashWorldState(original));
  });

  it('produces bit-for-bit identical canonical JSON regardless of object key order', () => {
    const a = makeSampleWorldState();
    const b: WorldState = {
      stats: {
        byItem: {
          iron_plate: {
            consumedPerMinute: 8,
            producedPerMinute: 24,
            consumedTotal: 4,
            producedTotal: 12,
          },
        },
      },
      dayNight: { solarFactor: 1, cycleTick: 120 },
      research: {
        progress: { red_science: 4 },
        completedTechs: [],
        activeTech: 'automation',
      },
      powerGrid: {
        networks: {
          1: {
            satisfaction: 1,
            totalDemandKw: 0,
            totalSupplyKw: 0,
            accumulatorIds: [],
            consumerIds: [],
            producerIds: [],
            poleIds: [],
            id: 1,
          },
        },
        nextNetworkId: 2,
      },
      nextEntityId: 3,
      entities: {
        2: a.entities[2]!,
        1: a.entities[1]!,
      },
      tiles: a.tiles,
      height: 2,
      width: 2,
      tick: 120,
      seed: 1616,
      schemaVersion: 1,
    };

    expect(serializeWorldState(a)).toBe(serializeWorldState(b));
    expect(hashWorldState(a)).toBe(hashWorldState(b));
  });

  it('normalizes -0 to 0 and rejects NaN / Infinity during serialization', () => {
    expect(canonicalStringify({ a: -0, b: 0 })).toBe('{"a":0,"b":0}');
    expect(() => canonicalStringify({ bad: Number.NaN })).toThrow(
      SimulationError
    );
    expect(() => canonicalStringify({ bad: Number.POSITIVE_INFINITY })).toThrow(
      SimulationError
    );
    expect(() => canonicalStringify({ bad: Number.NEGATIVE_INFINITY })).toThrow(
      SimulationError
    );
  });

  it('fails closed with DeserializationError on malformed JSON', () => {
    expect(() => deserializeWorldState('{bad_json')).toThrow(
      DeserializationError
    );
    expect(() => deserializeWorldState('')).toThrow(DeserializationError);
    expect(() => deserializeWorldState('   ')).toThrow(DeserializationError);
    expect(() => deserializeWorldState('null')).toThrow(DeserializationError);
    expect(() => deserializeWorldState('[]')).toThrow(DeserializationError);
  });

  it('fails closed with DeserializationError on unsupported schemaVersion', () => {
    const state = makeSampleWorldState();
    const mutated = JSON.parse(serializeWorldState(state)) as Record<
      string,
      unknown
    >;
    mutated.schemaVersion = 2;

    expect(() => deserializeWorldState(JSON.stringify(mutated))).toThrow(
      DeserializationError
    );
  });

  it('fails closed on invalid tile dimensions or coordinate mismatch', () => {
    const state = makeSampleWorldState();
    const wrongLen = JSON.parse(serializeWorldState(state)) as Record<
      string,
      unknown
    >;
    wrongLen.tiles = (wrongLen.tiles as unknown[]).slice(0, 3);
    expect(() => deserializeWorldState(JSON.stringify(wrongLen))).toThrow(
      DeserializationError
    );

    const wrongCoord = JSON.parse(serializeWorldState(state)) as WorldState;
    (wrongCoord.tiles[0] as { x: number }).x = 99;
    expect(() => deserializeWorldState(JSON.stringify(wrongCoord))).toThrow(
      DeserializationError
    );
  });

  it('fails closed on invalid entity type, direction, or key/id mismatch', () => {
    const state = makeSampleWorldState();

    const badType = JSON.parse(serializeWorldState(state)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    badType.entities!['1']!.type = 'teleporter';
    expect(() => deserializeWorldState(JSON.stringify(badType))).toThrow(
      DeserializationError
    );

    const badDir = JSON.parse(serializeWorldState(state)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    badDir.entities!['1']!.direction = 'NE';
    expect(() => deserializeWorldState(JSON.stringify(badDir))).toThrow(
      DeserializationError
    );

    const badKey = JSON.parse(serializeWorldState(state)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    badKey.entities!['1']!.id = 999;
    expect(() => deserializeWorldState(JSON.stringify(badKey))).toThrow(
      DeserializationError
    );
  });

  it('fails closed on out-of-range dayNight values or unknown research/stats items', () => {
    const state = makeSampleWorldState();

    const badSolar = JSON.parse(serializeWorldState(state)) as WorldState;
    badSolar.dayNight.solarFactor = 1.5;
    expect(() => deserializeWorldState(JSON.stringify(badSolar))).toThrow(
      DeserializationError
    );

    const badItem = JSON.parse(serializeWorldState(state)) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    badItem.stats!.byItem!['unobtanium'] = {
      producedTotal: 1,
      consumedTotal: 0,
      producedPerMinute: 1,
      consumedPerMinute: 0,
    };
    expect(() => deserializeWorldState(JSON.stringify(badItem))).toThrow(
      DeserializationError
    );
  });
});
