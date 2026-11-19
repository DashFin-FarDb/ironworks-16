import { describe, expect, it } from 'vitest';
import {
  clamp,
  coordKey,
  DAY_CYCLE_TICKS,
  DeserializationError,
  DIRECTION_VECTORS,
  DIRECTIONS,
  InsufficientIngredientsError,
  InvalidPlacementError,
  isWithinBounds,
  oppositeDirection,
  OutOfBoundsError,
  rotateDirection,
  SimulationError,
  stepCoord,
  TICK_PHASES,
  TICKS_PER_SECOND,
  UnknownItemError,
  UnknownRecipeError,
  type BeltEntity,
  type Entity,
  type FactoryTelemetry,
  type PowerNetwork,
  type WorldState,
} from '../src/types/contracts.js';

describe('T01: Shared TypeScript Contracts', () => {
  describe('Direction and coordinate helpers', () => {
    it('defines all four cardinal directions and unit vectors', () => {
      expect(DIRECTIONS).toEqual(['N', 'E', 'S', 'W']);
      expect(DIRECTION_VECTORS.N).toEqual({ x: 0, y: -1 });
      expect(DIRECTION_VECTORS.E).toEqual({ x: 1, y: 0 });
      expect(DIRECTION_VECTORS.S).toEqual({ x: 0, y: 1 });
      expect(DIRECTION_VECTORS.W).toEqual({ x: -1, y: 0 });
    });

    it('rotates directions deterministically clockwise and counter-clockwise', () => {
      expect(rotateDirection('N')).toBe('E');
      expect(rotateDirection('E')).toBe('S');
      expect(rotateDirection('S')).toBe('W');
      expect(rotateDirection('W')).toBe('N');
      expect(rotateDirection('N', -1)).toBe('W');
      expect(rotateDirection('E', 4)).toBe('E');
      expect(oppositeDirection('N')).toBe('S');
      expect(oppositeDirection('E')).toBe('W');
    });

    it('steps coordinates and formats keys cleanly', () => {
      expect(stepCoord({ x: 10, y: 10 }, 'N')).toEqual({ x: 10, y: 9 });
      expect(stepCoord({ x: 10, y: 10 }, 'E', 3)).toEqual({ x: 13, y: 10 });
      expect(coordKey({ x: 4, y: 12 })).toBe('4,12');
    });

    it('validates integer grid bounds fail-closed', () => {
      const bounds = { width: 64, height: 64 };
      expect(isWithinBounds({ x: 0, y: 0 }, bounds)).toBe(true);
      expect(isWithinBounds({ x: 63, y: 63 }, bounds)).toBe(true);
      expect(isWithinBounds({ x: -1, y: 0 }, bounds)).toBe(false);
      expect(isWithinBounds({ x: 64, y: 0 }, bounds)).toBe(false);
      expect(isWithinBounds({ x: 1.5, y: 2 }, bounds)).toBe(false);
      expect(isWithinBounds({ x: Number.NaN, y: 0 }, bounds)).toBe(false);
    });

    it('clamps numeric values and guards against NaN', () => {
      expect(clamp(0.5, 0, 1)).toBe(0.5);
      expect(clamp(-2, 0, 1)).toBe(0);
      expect(clamp(3, 0, 1)).toBe(1);
      expect(clamp(Number.NaN, 0, 1)).toBe(0);
    });
  });

  describe('Simulation constants', () => {
    it('matches SPEC.md tick rate, day cycle, and ordered tick phases', () => {
      expect(TICKS_PER_SECOND).toBe(60);
      expect(DAY_CYCLE_TICKS).toBe(3600);
      expect(TICK_PHASES).toEqual([
        'power',
        'mining',
        'smelting_assembling',
        'inserters',
        'belts',
        'stats',
      ]);
    });
  });

  describe('Fail-closed typed errors', () => {
    it('constructs distinct SimulationError subclasses with codes', () => {
      const oob = new OutOfBoundsError({ x: -1, y: 5 }, { width: 64, height: 64 });
      expect(oob).toBeInstanceOf(SimulationError);
      expect(oob.name).toBe('OutOfBoundsError');
      expect(oob.code).toBe('OUT_OF_BOUNDS');

      const placement = new InvalidPlacementError('stone_furnace', { x: 2, y: 3 }, 'tile occupied');
      expect(placement).toBeInstanceOf(SimulationError);
      expect(placement.code).toBe('INVALID_PLACEMENT');

      const itemErr = new UnknownItemError('unobtanium');
      expect(itemErr.code).toBe('UNKNOWN_ITEM');

      const recipeErr = new UnknownRecipeError('fusion_core');
      expect(recipeErr.code).toBe('UNKNOWN_RECIPE');

      const deserErr = new DeserializationError('Unexpected token');
      expect(deserErr.name).toBe('DeserializationError');
      expect(deserErr.code).toBe('DESERIALIZATION_ERROR');

      const ingErr = new InsufficientIngredientsError('red_science');
      expect(ingErr.code).toBe('INSUFFICIENT_INGREDIENTS');
    });
  });

  describe('Core domain contract shapes', () => {
    it('supports constructing valid Entity, PowerNetwork, WorldState, and FactoryTelemetry objects', () => {
      const belt: BeltEntity = {
        id: 1,
        type: 'transport_belt',
        position: { x: 32, y: 32 },
        direction: 'E',
        footprint: { width: 1, height: 1 },
        powerNetworkId: null,
        active: true,
        shape: 'straight',
        leftLane: { items: [{ itemId: 'iron_ore', offset: 0.25 }] },
        rightLane: { items: [] },
      };

      const entity: Entity = belt;
      expect(entity.type).toBe('transport_belt');

      const network: PowerNetwork = {
        id: 1,
        poleIds: [],
        producerIds: [],
        consumerIds: [],
        accumulatorIds: [],
        totalSupplyKw: 900,
        totalDemandKw: 450,
        satisfaction: 1,
      };

      const world: WorldState = {
        schemaVersion: 1,
        seed: 1616,
        tick: 0,
        width: 1,
        height: 1,
        tiles: [{ x: 0, y: 0, terrain: 'grass', resource: null, entityId: null }],
        entities: { 1: entity },
        nextEntityId: 2,
        powerGrid: { networks: { 1: network }, nextNetworkId: 2 },
        research: { activeTech: 'automation', completedTechs: [], progress: {} },
        dayNight: { cycleTick: 0, solarFactor: 1 },
        stats: { byItem: {} },
      };

      const telemetry: FactoryTelemetry = {
        tick: world.tick,
        activeEntities: 1,
        powerSatisfaction: network.satisfaction,
        redScienceProduced: 0,
        ironPlatesProduced: 0,
        totalItemsOnBelts: 1,
      };

      expect(world.seed).toBe(1616);
      expect(telemetry.totalItemsOnBelts).toBe(1);
    });
  });
});
