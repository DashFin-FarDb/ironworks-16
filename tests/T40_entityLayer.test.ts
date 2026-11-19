import { describe, it, expect, vi } from 'vitest';
import {
  EntityLayer,
  EntityLayerError,
  FURNACE_GLOW_MAX_ALPHA,
  FURNACE_GLOW_MIN_ALPHA,
  INDICATOR_ACTIVE_COLOR,
  INDICATOR_IDLE_COLOR,
  computeFurnaceGlowAlpha,
  computeInserterArmRotation,
  computeInserterTipScreenPos,
  getMachineIndicatorColor,
  renderEntityLayer,
  resolveEntitySpriteKey,
} from '../src/render/entityLayer.js';
import { createSpriteAtlas, type SpriteAtlas } from '../src/render/spriteAtlas.js';
import { createCameraState } from '../src/render/camera.js';
import type {
  AssemblerEntity,
  BeltEntity,
  ChestEntity,
  Entity,
  FilterInserterEntity,
  InserterEntity,
  StoneFurnaceEntity,
  ElectricFurnaceEntity,
  WorldState,
} from '../src/types/contracts.js';

interface RecordedArc {
  x: number;
  y: number;
  radius: number;
  fillStyle: string;
}

interface MockCanvas2D {
  ctx: CanvasRenderingContext2D;
  arcs: RecordedArc[];
  rotations: number[];
  translations: Array<{ x: number; y: number }>;
  saveCount: number;
  restoreCount: number;
  fillRectCount: number;
}

function createMockCanvas2D(): MockCanvas2D {
  const arcs: RecordedArc[] = [];
  const rotations: number[] = [];
  const translations: Array<{ x: number; y: number }> = [];
  const state: MockCanvas2D = {
    ctx: null as unknown as CanvasRenderingContext2D,
    arcs,
    rotations,
    translations,
    saveCount: 0,
    restoreCount: 0,
    fillRectCount: 0,
  };

  let currentFillStyle = '#000000';
  let pendingArc: { x: number; y: number; radius: number } | null = null;

  const mock = {
    get fillStyle() {
      return currentFillStyle;
    },
    set fillStyle(val: string) {
      currentFillStyle = val;
    },
    imageSmoothingEnabled: true,
    save() {
      state.saveCount++;
    },
    restore() {
      state.restoreCount++;
    },
    translate(x: number, y: number) {
      translations.push({ x, y });
    },
    rotate(angle: number) {
      rotations.push(angle);
    },
    beginPath() {
      pendingArc = null;
    },
    arc(x: number, y: number, radius: number) {
      pendingArc = { x, y, radius };
    },
    fill() {
      if (pendingArc) {
        arcs.push({ ...pendingArc, fillStyle: currentFillStyle });
        pendingArc = null;
      }
    },
    fillRect() {
      state.fillRectCount++;
    },
  };

  state.ctx = mock as unknown as CanvasRenderingContext2D;
  return state;
}

function createEmptyWorld(entities: Entity[], tick = 100): WorldState {
  const entityMap: Record<number, Entity> = {};
  for (const e of entities) {
    entityMap[e.id] = e;
  }
  return {
    schemaVersion: 1,
    seed: 1616,
    tick,
    width: 64,
    height: 64,
    tiles: [],
    entities: entityMap,
    nextEntityId: entities.length + 1,
    powerGrid: { networks: {}, nextNetworkId: 1 },
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

function makeStoneFurnace(id: number, x: number, y: number, active: boolean): StoneFurnaceEntity {
  return {
    id,
    type: 'stone_furnace',
    position: { x, y },
    direction: 'N',
    footprint: { width: 2, height: 2 },
    powerNetworkId: null,
    active,
    inputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    outputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    fuelInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    fuelEnergyKj: active ? 4000 : 0,
    activeRecipe: active ? 'iron_plate' : null,
    craftingProgress: 0,
  };
}

function makeElectricFurnace(
  id: number,
  x: number,
  y: number,
  active: boolean
): ElectricFurnaceEntity {
  return {
    id,
    type: 'electric_furnace',
    position: { x, y },
    direction: 'N',
    footprint: { width: 2, height: 2 },
    powerNetworkId: 1,
    active,
    powerDemandKw: 180,
    inputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    outputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    activeRecipe: active ? 'iron_plate' : null,
    craftingProgress: 0,
  };
}

function makeAssembler(id: number, x: number, y: number, active: boolean): AssemblerEntity {
  return {
    id,
    type: 'assembler_mk1',
    position: { x, y },
    direction: 'N',
    footprint: { width: 3, height: 3 },
    powerNetworkId: 1,
    active,
    powerDemandKw: 75,
    craftingSpeed: 0.5,
    maxIngredients: 2,
    recipeId: 'iron_gear',
    inputInventory: { capacity: 2, slots: [] },
    outputInventory: { capacity: 1, slots: [] },
    craftingProgress: 0,
  };
}

function makeInserter(
  id: number,
  x: number,
  y: number,
  armAngle: number,
  heldItem: InserterEntity['heldItem'] = null
): InserterEntity {
  return {
    id,
    type: 'inserter',
    position: { x, y },
    direction: 'E',
    footprint: { width: 1, height: 1 },
    powerNetworkId: 1,
    active: heldItem !== null,
    phase: heldItem ? 'swinging' : 'idle',
    phaseProgress: 0.5,
    heldItem,
    armAngle,
  };
}

function makeFilterInserter(
  id: number,
  x: number,
  y: number,
  armAngle: number,
  heldItem: FilterInserterEntity['heldItem'] = null
): FilterInserterEntity {
  return {
    id,
    type: 'filter_inserter',
    position: { x, y },
    direction: 'S',
    footprint: { width: 1, height: 1 },
    powerNetworkId: 1,
    active: heldItem !== null,
    phase: heldItem ? 'swinging' : 'idle',
    phaseProgress: 0.5,
    heldItem,
    armAngle,
    filters: ['iron_plate'],
  };
}

function makeChest(id: number, x: number, y: number): ChestEntity {
  return {
    id,
    type: 'wooden_chest',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: false,
    inventory: { capacity: 16, slots: [] },
  };
}

function makeBelt(id: number, x: number, y: number): BeltEntity {
  return {
    id,
    type: 'transport_belt',
    position: { x, y },
    direction: 'E',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    shape: 'straight',
    leftLane: { items: [] },
    rightLane: { items: [] },
  };
}

describe('T40: Entity Layer Renderer', () => {
  const atlas: SpriteAtlas = createSpriteAtlas();
  const camera = createCameraState({ x: 32, y: 32, zoom: 32 });
  const viewport = { width: 640, height: 480 };

  describe('Pure helpers', () => {
    it('resolves active vs idle entity sprite keys with fallback for passive entities', () => {
      const activeFurnace = makeStoneFurnace(1, 32, 32, true);
      const idleFurnace = makeStoneFurnace(2, 34, 32, false);
      const chest = makeChest(3, 30, 32);

      expect(resolveEntitySpriteKey(atlas, activeFurnace)).toBe('entity:stone_furnace:active');
      expect(resolveEntitySpriteKey(atlas, idleFurnace)).toBe('entity:stone_furnace');
      expect(resolveEntitySpriteKey(atlas, chest)).toBe('entity:wooden_chest');
    });

    it('computes deterministic furnace glow alpha bounded within [min, max]', () => {
      const a1 = computeFurnaceGlowAlpha(42, 7);
      const a2 = computeFurnaceGlowAlpha(42, 7);
      expect(a1).toBe(a2);

      for (let t = 0; t < 200; t++) {
        const alpha = computeFurnaceGlowAlpha(t, 3);
        expect(alpha).toBeGreaterThanOrEqual(FURNACE_GLOW_MIN_ALPHA - 1e-12);
        expect(alpha).toBeLessThanOrEqual(FURNACE_GLOW_MAX_ALPHA + 1e-12);
      }
    });

    it('maps inserter armAngle to North-up sprite canvas rotation', () => {
      expect(computeInserterArmRotation(-Math.PI / 2)).toBeCloseTo(0); // North
      expect(computeInserterArmRotation(0)).toBeCloseTo(Math.PI / 2); // East
      expect(computeInserterArmRotation(Math.PI / 2)).toBeCloseTo(Math.PI); // South
      expect(computeInserterArmRotation(Math.PI)).toBeCloseTo(1.5 * Math.PI); // West
    });

    it('computes inserter claw tip position along armAngle', () => {
      const tipEast = computeInserterTipScreenPos(100, 200, 0, 32);
      expect(tipEast.x).toBeGreaterThan(100);
      expect(tipEast.y).toBeCloseTo(200);

      const tipSouth = computeInserterTipScreenPos(100, 200, Math.PI / 2, 32);
      expect(tipSouth.x).toBeCloseTo(100);
      expect(tipSouth.y).toBeGreaterThan(200);
    });

    it('returns distinct indicator colors for active vs idle machines', () => {
      expect(getMachineIndicatorColor(true)).toBe(INDICATOR_ACTIVE_COLOR);
      expect(getMachineIndicatorColor(false)).toBe(INDICATOR_IDLE_COLOR);
      expect(INDICATOR_ACTIVE_COLOR).not.toBe(INDICATOR_IDLE_COLOR);
    });
  });

  describe('Machines, active/idle indicators, and furnace glow', () => {
    it('renders active and idle indicators for machines and glow only for active furnaces', () => {
      const activeStone = makeStoneFurnace(1, 30, 30, true);
      const idleStone = makeStoneFurnace(2, 33, 30, false);
      const activeElectric = makeElectricFurnace(3, 30, 33, true);
      const idleAssembler = makeAssembler(4, 34, 33, false);
      const chest = makeChest(5, 29, 30);

      const world = createEmptyWorld([activeStone, idleStone, activeElectric, idleAssembler, chest], 120);
      const mock = createMockCanvas2D();

      const stats = renderEntityLayer(mock.ctx, world, camera, viewport, atlas);

      expect(stats.entitiesRendered).toBe(5);
      expect(stats.machinesRendered).toBe(4);
      expect(stats.furnaceGlowsRendered).toBe(2); // activeStone + activeElectric only
      expect(stats.insertersRendered).toBe(0);
      expect(stats.culledCount).toBe(0);

      const activeDots = mock.arcs.filter((a) => a.fillStyle === INDICATOR_ACTIVE_COLOR);
      const idleDots = mock.arcs.filter((a) => a.fillStyle === INDICATOR_IDLE_COLOR);
      expect(activeDots.length).toBe(2);
      expect(idleDots.length).toBe(2);

      // Each active furnace draws 2 concentric glow arcs (outer + inner)
      const glowArcs = mock.arcs.filter((a) => a.fillStyle.startsWith('rgba(255,'));
      expect(glowArcs.length).toBe(4);
      expect(mock.saveCount).toBe(mock.restoreCount);
    });

    it('respects showFurnaceGlow: false and showStatusIndicators: false options', () => {
      const activeFurnace = makeStoneFurnace(1, 32, 32, true);
      const world = createEmptyWorld([activeFurnace], 50);
      const mock = createMockCanvas2D();

      const stats = renderEntityLayer(mock.ctx, world, camera, viewport, atlas, {
        showFurnaceGlow: false,
        showStatusIndicators: false,
      });

      expect(stats.machinesRendered).toBe(1);
      expect(stats.furnaceGlowsRendered).toBe(0);
      expect(mock.arcs.length).toBe(0);
    });
  });

  describe('Rotating inserter arms and held items', () => {
    it('rotates inserter and filter_inserter arms and draws held items', () => {
      const basic = makeInserter(1, 31, 32, 0, 'iron_ore'); // pointing East
      const filter = makeFilterInserter(2, 33, 32, Math.PI / 2, null); // pointing South, empty

      const world = createEmptyWorld([basic, filter], 60);
      const mock = createMockCanvas2D();
      const drawSpy = vi.spyOn(atlas, 'draw');

      const stats = renderEntityLayer(mock.ctx, world, camera, viewport, atlas);

      expect(stats.insertersRendered).toBe(2);
      expect(stats.heldItemsRendered).toBe(1);
      expect(mock.rotations.length).toBe(2);
      expect(mock.rotations[0]).toBeCloseTo(Math.PI / 2); // East -> +π/2
      expect(mock.rotations[1]).toBeCloseTo(Math.PI); // South -> π
      expect(mock.saveCount).toBe(mock.restoreCount);

      const drawnKeys = drawSpy.mock.calls.map((c) => c[1]);
      expect(drawnKeys).toContain('inserter:basic:base');
      expect(drawnKeys).toContain('inserter:basic:arm');
      expect(drawnKeys).toContain('item:iron_ore');
      expect(drawnKeys).toContain('inserter:filter:base');
      expect(drawnKeys).toContain('inserter:filter:arm');

      drawSpy.mockRestore();
    });

    it('draws inserters in Pass 2 after machines regardless of entity ID order', () => {
      const inserter = makeInserter(1, 32, 32, 0, null);
      const furnace = makeStoneFurnace(2, 32, 32, false);
      const world = createEmptyWorld([inserter, furnace], 10);
      const mock = createMockCanvas2D();
      const drawSpy = vi.spyOn(atlas, 'draw');

      renderEntityLayer(mock.ctx, world, camera, viewport, atlas);

      const drawnKeys = drawSpy.mock.calls.map((c) => c[1]);
      const furnaceIdx = drawnKeys.indexOf('entity:stone_furnace');
      const inserterBaseIdx = drawnKeys.indexOf('inserter:basic:base');
      expect(furnaceIdx).toBeGreaterThanOrEqual(0);
      expect(inserterBaseIdx).toBeGreaterThan(furnaceIdx);

      drawSpy.mockRestore();
    });
  });

  describe('Culling, belt skipping, and fail-closed validation', () => {
    it('culls off-screen entities and skips transport_belt by default', () => {
      const onScreenChest = makeChest(1, 32, 32);
      const offScreenChest = makeChest(2, 0, 0);
      const belt = makeBelt(3, 32, 33);

      const world = createEmptyWorld([onScreenChest, offScreenChest, belt], 10);
      const mock = createMockCanvas2D();

      const stats = renderEntityLayer(mock.ctx, world, camera, viewport, atlas);
      expect(stats.entitiesRendered).toBe(1);
      expect(stats.culledCount).toBe(1);
    });

    it('throws EntityLayerError on non-finite world tick or inserter armAngle', () => {
      const mock = createMockCanvas2D();
      const badTickWorld = createEmptyWorld([], Number.NaN);
      expect(() => renderEntityLayer(mock.ctx, badTickWorld, camera, viewport, atlas)).toThrow(
        EntityLayerError
      );

      const badInserter = makeInserter(1, 32, 32, Number.NaN, null);
      const badArmWorld = createEmptyWorld([badInserter], 10);
      expect(() => renderEntityLayer(mock.ctx, badArmWorld, camera, viewport, atlas)).toThrow(
        EntityLayerError
      );
    });

    it('supports the EntityLayer class wrapper', () => {
      const layer = new EntityLayer(atlas, { showFurnaceGlow: true });
      const world = createEmptyWorld([makeStoneFurnace(1, 32, 32, true)], 25);
      const mock = createMockCanvas2D();

      const stats = layer.render(mock.ctx, world, camera, viewport);
      expect(stats.entitiesRendered).toBe(1);
      expect(stats.furnaceGlowsRendered).toBe(1);
    });
  });
});
