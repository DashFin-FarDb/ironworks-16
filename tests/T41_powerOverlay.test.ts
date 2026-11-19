import { describe, expect, it } from 'vitest';
import {
  type CameraState,
  type ElectricDrillEntity,
  type ElectricFurnaceEntity,
  type Entity,
  type PowerPoleEntity,
  type SteamEngineEntity,
  type StoneFurnaceEntity,
  type WorldState,
} from '../src/types/contracts.js';
import { createEmptyPowerGrid, rebuildPowerGrid } from '../src/logistics/powerGrid.js';
import { solvePowerGrid } from '../src/logistics/powerSolver.js';
import {
  PowerOverlay,
  type PowerOverlayContext,
  computeCoverageSquares,
  computePowerWires,
  computeUnpoweredWarnings,
  computeWarningPulseAlpha,
  createPowerOverlayConfig,
  renderPowerOverlay,
} from '../src/render/powerOverlay.js';

function createMockContext(): {
  ctx: PowerOverlayContext;
  calls: string[];
} {
  const calls: string[] = [];
  const ctx: PowerOverlayContext = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    quadraticCurveTo: () => calls.push('quadraticCurveTo'),
    arc: () => calls.push('arc'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
  };
  return { ctx, calls };
}

function createTestWorld(entities: Entity[], tick = 0): WorldState {
  const entityMap: Record<number, Entity> = {};
  for (const e of entities) {
    entityMap[e.id] = e;
  }
  const world: WorldState = {
    schemaVersion: 1,
    seed: 1616,
    tick,
    width: 64,
    height: 64,
    tiles: [],
    entities: entityMap,
    nextEntityId: entities.length + 1,
    powerGrid: createEmptyPowerGrid(),
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
  rebuildPowerGrid(world);
  solvePowerGrid(world);
  return world;
}

function makePole(id: number, x: number, y: number, supplyRadius = 5, wireReach = 7): PowerPoleEntity {
  return {
    id,
    type: 'power_pole',
    position: { x, y },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: null,
    active: true,
    supplyRadius,
    wireReach,
    connectedPoleIds: [],
  };
}

function makeElectricDrill(id: number, x: number, y: number, powerDemandKw = 90): ElectricDrillEntity {
  return {
    id,
    type: 'electric_drill',
    position: { x, y },
    direction: 'N',
    footprint: { width: 2, height: 2 },
    powerNetworkId: null,
    active: false,
    powerDemandKw,
    miningProgress: 0,
  };
}

function makeElectricFurnace(id: number, x: number, y: number, powerDemandKw = 180): ElectricFurnaceEntity {
  return {
    id,
    type: 'electric_furnace',
    position: { x, y },
    direction: 'N',
    footprint: { width: 2, height: 2 },
    powerNetworkId: null,
    active: false,
    powerDemandKw,
    inputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    outputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    activeRecipe: null,
    craftingProgress: 0,
  };
}

function makeSteamEngine(id: number, x: number, y: number, currentOutputKw = 900): SteamEngineEntity {
  return {
    id,
    type: 'steam_engine',
    position: { x, y },
    direction: 'N',
    footprint: { width: 2, height: 2 },
    powerNetworkId: null,
    active: currentOutputKw > 0,
    maxPowerOutputKw: 900,
    currentOutputKw,
  };
}

function makeStoneFurnace(id: number, x: number, y: number): StoneFurnaceEntity {
  return {
    id,
    type: 'stone_furnace',
    position: { x, y },
    direction: 'N',
    footprint: { width: 2, height: 2 },
    powerNetworkId: null,
    active: false,
    inputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    outputInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    fuelInventory: { capacity: 1, slots: [{ item: null, filter: null }] },
    fuelEnergyKj: 0,
    activeRecipe: null,
    craftingProgress: 0,
  };
}

const DEFAULT_CAMERA: CameraState = { x: 20, y: 20, zoom: 32 };
const DEFAULT_VIEWPORT = { width: 800, height: 600 };

describe('T41: PowerOverlay', () => {
  it('toggles cleanly and performs zero draw calls when disabled', () => {
    const world = createTestWorld([
      makePole(1, 18, 20),
      makePole(2, 22, 20),
      makeElectricDrill(3, 19, 21),
    ]);
    const overlay = new PowerOverlay();
    expect(overlay.isEnabled()).toBe(false);

    const { ctx, calls } = createMockContext();
    const disabledStats = overlay.render(ctx, world, DEFAULT_CAMERA, DEFAULT_VIEWPORT);
    expect(disabledStats).toEqual({
      rendered: false,
      wiresDrawn: 0,
      coverageRectsDrawn: 0,
      warningsDrawn: 0,
    });
    expect(calls.length).toBe(0);

    expect(overlay.toggle()).toBe(true);
    expect(overlay.isEnabled()).toBe(true);

    const enabledStats = overlay.render(ctx, world, DEFAULT_CAMERA, DEFAULT_VIEWPORT);
    expect(enabledStats.rendered).toBe(true);
    expect(enabledStats.wiresDrawn).toBe(1);
    expect(enabledStats.coverageRectsDrawn).toBe(2);
    expect(enabledStats.warningsDrawn).toBe(1);
    expect(calls.length).toBeGreaterThan(0);

    overlay.setEnabled(false);
    expect(overlay.isEnabled()).toBe(false);
  });

  it('computes deduplicated power wires with catenary sag and viewport culling', () => {
    const world = createTestWorld([
      makePole(1, 18, 20),
      makePole(2, 22, 20),
      // Far off-screen poles
      makePole(3, 58, 58),
      makePole(4, 61, 58),
    ]);

    const wires = computePowerWires(world, DEFAULT_CAMERA, DEFAULT_VIEWPORT);
    expect(wires).toHaveLength(1);
    const wire = wires[0]!;
    expect(wire.fromId).toBe(1);
    expect(wire.toId).toBe(2);

    // Control point must sag below the midpoint
    const midY = (wire.fromScreen.y + wire.toScreen.y) / 2;
    expect(wire.controlScreen.y).toBeGreaterThan(midY);
  });

  it('computes coverage squares clamped to world bounds', () => {
    const world = createTestWorld([makePole(1, 2, 2, 5, 7)]);
    const camera: CameraState = { x: 4, y: 4, zoom: 32 };
    const squares = computeCoverageSquares(world, camera, DEFAULT_VIEWPORT);

    expect(squares).toHaveLength(1);
    const sq = squares[0]!;
    expect(sq.minTileX).toBe(0);
    expect(sq.minTileY).toBe(0);
    expect(sq.maxTileX).toBe(7);
    expect(sq.maxTileY).toBe(7);
    expect(sq.screenWidth).toBe(8 * 32);
    expect(sq.screenHeight).toBe(8 * 32);
  });

  it('flags unconnected, blackout, and brownout consumers while ignoring healthy and non-electric entities', () => {
    // Network 1 (healthy): steam engine 900kW + drill 90kW
    const healthyPole = makePole(1, 12, 12);
    const healthyEngine = makeSteamEngine(2, 11, 13, 900);
    const healthyDrill = makeElectricDrill(3, 14, 12, 90);

    // Network 2 (brownout): steam engine 90kW + furnace 180kW -> 50% satisfaction
    const brownoutPole = makePole(4, 24, 12);
    const brownoutEngine = makeSteamEngine(5, 23, 13, 90);
    const brownoutFurnace = makeElectricFurnace(6, 25, 12, 180);

    // Network 3 (blackout): no producer + drill 90kW -> 0% satisfaction
    const blackoutPole = makePole(7, 12, 26);
    const blackoutDrill = makeElectricDrill(8, 13, 26, 90);

    // Unconnected electric drill (far from all poles)
    const unconnectedDrill = makeElectricDrill(9, 28, 28, 90);

    // Non-electric stone furnace (never warned)
    const stoneFurnace = makeStoneFurnace(10, 26, 26);

    const world = createTestWorld(
      [
        healthyPole,
        healthyEngine,
        healthyDrill,
        brownoutPole,
        brownoutEngine,
        brownoutFurnace,
        blackoutPole,
        blackoutDrill,
        unconnectedDrill,
        stoneFurnace,
      ],
      12
    );

    const camera: CameraState = { x: 20, y: 20, zoom: 16 };
    const warnings = computeUnpoweredWarnings(world, camera, DEFAULT_VIEWPORT);

    expect(warnings.map((w) => [w.entityId, w.reason])).toEqual([
      [6, 'brownout'],
      [8, 'blackout'],
      [9, 'unconnected'],
    ]);
    expect(warnings[0]!.satisfaction).toBeCloseTo(0.5, 5);
    expect(warnings[1]!.satisfaction).toBe(0);
    expect(warnings[2]!.satisfaction).toBe(0);
  });

  it('produces deterministic tick-driven warning pulse alpha', () => {
    const a0 = computeWarningPulseAlpha(0);
    const a24 = computeWarningPulseAlpha(24);
    const a48 = computeWarningPulseAlpha(48);

    expect(a0).toBeCloseTo(0.55, 5);
    expect(a24).toBeCloseTo(1.0, 5);
    expect(a48).toBeCloseTo(a0, 5);
  });

  it('respects granular sub-toggles (showWires, showCoverage, showUnpoweredWarnings)', () => {
    const world = createTestWorld([
      makePole(1, 18, 20),
      makePole(2, 22, 20),
      makeElectricDrill(3, 19, 21),
    ]);

    const { ctx } = createMockContext();
    const config = createPowerOverlayConfig({
      enabled: true,
      showWires: true,
      showCoverage: false,
      showUnpoweredWarnings: false,
    });

    const stats = renderPowerOverlay(ctx, world, DEFAULT_CAMERA, DEFAULT_VIEWPORT, config);
    expect(stats).toEqual({
      rendered: true,
      wiresDrawn: 1,
      coverageRectsDrawn: 0,
      warningsDrawn: 0,
    });
  });
});
