import { describe, expect, it, vi } from 'vitest';
import {
  RESEARCH_LAB_INPUT_SLOTS,
  RESEARCH_LAB_POWER_DEMAND_KW,
  RESEARCH_LAB_TICKS_PER_PACK,
  canInsertSciencePack,
  createResearchLab,
  insertSciencePack,
  isSciencePack,
  updateAllResearchLabs,
  updateResearchLab,
} from '../src/machines/researchLab';
import { createTechTree, createInitialResearchState } from '../src/logistics/techTree';
import { createEventBus } from '../src/core/eventBus';
import { getItemCount } from '../src/core/inventory';
import { solvePowerGrid } from '../src/logistics/powerSolver';
import {
  SimulationError,
  type PowerNetwork,
  type ResearchLabEntity,
  type SolarPanelEntity,
  type WorldState,
} from '../src/types/contracts';

function createTestWorld(overrides?: Partial<WorldState>): WorldState {
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width: 16,
    height: 16,
    tiles: [],
    entities: {},
    nextEntityId: 1,
    powerGrid: {
      networks: {},
      nextNetworkId: 1,
    },
    research: createInitialResearchState(),
    dayNight: {
      cycleTick: 0,
      solarFactor: 1,
    },
    stats: {
      byItem: {},
    },
    ...overrides,
  };
}

function attachPowerNetwork(
  world: WorldState,
  lab: ResearchLabEntity,
  supplyKw: number
): PowerNetwork {
  const producerId = 900;
  const solar: SolarPanelEntity = {
    id: producerId,
    type: 'solar_panel',
    position: { x: 0, y: 0 },
    direction: 'N',
    footprint: { width: 1, height: 1 },
    powerNetworkId: 1,
    active: supplyKw > 0,
    peakOutputKw: Math.max(60, supplyKw),
    currentOutputKw: supplyKw,
  };
  world.entities[producerId] = solar;
  world.entities[lab.id] = lab;
  lab.powerNetworkId = 1;

  const network: PowerNetwork = {
    id: 1,
    poleIds: [],
    producerIds: [producerId],
    consumerIds: [lab.id],
    accumulatorIds: [],
    totalSupplyKw: 0,
    totalDemandKw: 0,
    satisfaction: 0,
  };
  world.powerGrid.networks[1] = network;
  world.powerGrid.nextNetworkId = 2;

  solvePowerGrid(world);
  return network;
}

describe('T30: Research Lab (src/machines/researchLab.ts)', () => {
  it('creates a 60 kW research lab with 2 input slots and zero progress', () => {
    const lab = createResearchLab(1, { x: 4, y: 5 });
    expect(lab.type).toBe('research_lab');
    expect(lab.powerDemandKw).toBe(RESEARCH_LAB_POWER_DEMAND_KW);
    expect(lab.powerDemandKw).toBe(60);
    expect(lab.inputInventory.capacity).toBe(RESEARCH_LAB_INPUT_SLOTS);
    expect(lab.researchProgress).toBe(0);
    expect(lab.active).toBe(false);
    expect(lab.powerNetworkId).toBeNull();
  });

  it('accepts science packs and rejects non-science items fail-closed', () => {
    const lab = createResearchLab(1, { x: 2, y: 2 });

    expect(isSciencePack('red_science')).toBe(true);
    expect(isSciencePack('green_science')).toBe(true);
    expect(isSciencePack('iron_plate')).toBe(false);

    expect(canInsertSciencePack(lab, 'iron_plate', 5)).toBe(0);
    expect(canInsertSciencePack(lab, 'red_science', 10)).toBe(10);

    expect(insertSciencePack(lab, 'red_science', 10)).toBe(10);
    expect(getItemCount(lab.inputInventory, 'red_science')).toBe(10);

    expect(() => insertSciencePack(lab, 'iron_plate', 1)).toThrowError(SimulationError);
  });

  it('halts cleanly with zero progress when no tech is active or no packs are loaded', () => {
    const world = createTestWorld();
    const techTree = createTechTree();
    const lab = createResearchLab(1, { x: 3, y: 3 });
    attachPowerNetwork(world, lab, 60);
    insertSciencePack(lab, 'red_science', 5);

    // No active tech
    const idleResult = updateResearchLab(lab, world, techTree);
    expect(idleResult.active).toBe(false);
    expect(idleResult.progressDelta).toBe(0);
    expect(idleResult.packsConsumed).toHaveLength(0);
    expect(getItemCount(lab.inputInventory, 'red_science')).toBe(5);

    // Active tech but empty lab
    const emptyLab = createResearchLab(2, { x: 4, y: 3 });
    world.entities[emptyLab.id] = emptyLab;
    emptyLab.powerNetworkId = 1;
    techTree.startResearch(world.research, 'automation');

    const emptyResult = updateResearchLab(emptyLab, world, techTree);
    expect(emptyResult.active).toBe(false);
    expect(emptyResult.progressDelta).toBe(0);
  });

  it('consumes science packs at 100% power, completes tech, emits event, and conserves excess packs', () => {
    const world = createTestWorld();
    const techTree = createTechTree();
    const eventBus = createEventBus();
    const completedHandler = vi.fn();
    eventBus.on('researchCompleted', completedHandler);

    const lab = createResearchLab(1, { x: 5, y: 5 });
    attachPowerNetwork(world, lab, 60);
    insertSciencePack(lab, 'red_science', 15);

    techTree.startResearch(world.research, 'automation'); // costs 10 red_science

    let totalConsumed = 0;
    let completedTech: string | null = null;

    const totalTicks = 10 * RESEARCH_LAB_TICKS_PER_PACK;
    for (let t = 1; t <= totalTicks; t++) {
      world.tick = t;
      const res = updateResearchLab(lab, world, techTree, {
        eventBus,
        onPackConsumed: (_itemId, count) => {
          totalConsumed += count;
        },
      });
      if (res.completedTech !== null) {
        completedTech = res.completedTech;
      }
    }

    expect(completedTech).toBe('automation');
    expect(totalConsumed).toBe(10);
    expect(world.research.activeTech).toBeNull();
    expect(world.research.completedTechs).toContain('automation');
    expect(getItemCount(lab.inputInventory, 'red_science')).toBe(5); // 15 - 10 = 5 conserved
    expect(lab.researchProgress).toBe(0);
    expect(completedHandler).toHaveBeenCalledTimes(1);
    expect(completedHandler).toHaveBeenCalledWith({
      tick: totalTicks,
      techId: 'automation',
    });
  });

  it('scales research speed proportionally under 50% brownout and halts at 0% power', () => {
    const world = createTestWorld();
    const techTree = createTechTree();
    const lab = createResearchLab(1, { x: 2, y: 2 });

    // Unconnected (0% power)
    world.entities[lab.id] = lab;
    insertSciencePack(lab, 'red_science', 5);
    techTree.startResearch(world.research, 'automation');

    const unpowered = updateResearchLab(lab, world, techTree);
    expect(unpowered.active).toBe(false);
    expect(unpowered.satisfaction).toBe(0);
    expect(unpowered.progressDelta).toBe(0);
    expect(lab.researchProgress).toBe(0);

    // 50% brownout: 30 kW supply for 60 kW lab
    attachPowerNetwork(world, lab, 30);
    expect(world.powerGrid.networks[1]!.satisfaction).toBeCloseTo(0.5, 10);

    // After 60 ticks at 50% power, only 30 ticks of progress (no pack consumed yet)
    for (let t = 0; t < RESEARCH_LAB_TICKS_PER_PACK; t++) {
      const res = updateResearchLab(lab, world, techTree);
      expect(res.active).toBe(true);
      expect(res.packsConsumed).toHaveLength(0);
    }
    expect(lab.researchProgress).toBeCloseTo(30, 10);
    expect(getItemCount(lab.inputInventory, 'red_science')).toBe(5);

    // After another 60 ticks (120 total), exactly 1 pack is consumed
    let consumedCount = 0;
    for (let t = 0; t < RESEARCH_LAB_TICKS_PER_PACK; t++) {
      const res = updateResearchLab(lab, world, techTree);
      consumedCount += res.packsConsumed.reduce((sum, p) => sum + p.count, 0);
    }
    expect(consumedCount).toBe(1);
    expect(getItemCount(lab.inputInventory, 'red_science')).toBe(4);
    expect(world.research.progress.red_science).toBe(1);
  });

  it('consumes both red_science and green_science to complete multi-pack tech (solar_energy)', () => {
    const world = createTestWorld();
    world.research.completedTechs = ['automation', 'logistics', 'steel_processing'];
    const techTree = createTechTree();
    const lab = createResearchLab(1, { x: 1, y: 1 });
    attachPowerNetwork(world, lab, 60);

    insertSciencePack(lab, 'red_science', 30);
    insertSciencePack(lab, 'green_science', 30);
    techTree.startResearch(world.research, 'solar_energy'); // 30 red + 30 green

    for (let t = 1; t <= 60; t++) {
      world.tick = t;
      updateResearchLab(lab, world, techTree, { ticksPerPack: 1 });
    }

    expect(world.research.completedTechs).toContain('solar_energy');
    expect(world.research.activeTech).toBeNull();
    expect(getItemCount(lab.inputInventory, 'red_science')).toBe(0);
    expect(getItemCount(lab.inputInventory, 'green_science')).toBe(0);
  });

  it('updates multiple labs deterministically in ascending ID order', () => {
    function runSimulation(): string {
      const world = createTestWorld();
      const techTree = createTechTree();
      const lab2 = createResearchLab(2, { x: 2, y: 1 });
      const lab1 = createResearchLab(1, { x: 1, y: 1 });

      // Insert out of order to verify ascending ID sorting
      world.entities[2] = lab2;
      world.entities[1] = lab1;
      lab1.powerNetworkId = 1;
      lab2.powerNetworkId = 1;

      world.powerGrid.networks[1] = {
        id: 1,
        poleIds: [],
        producerIds: [],
        consumerIds: [1, 2],
        accumulatorIds: [],
        totalSupplyKw: 120,
        totalDemandKw: 120,
        satisfaction: 1.0,
      };

      insertSciencePack(lab1, 'red_science', 6);
      insertSciencePack(lab2, 'red_science', 6);
      techTree.startResearch(world.research, 'automation'); // costs 10 red_science

      for (let t = 1; t <= 5; t++) {
        world.tick = t;
        updateAllResearchLabs(world, techTree, { ticksPerPack: 1 });
      }

      return JSON.stringify({
        research: world.research,
        lab1Inv: lab1.inputInventory,
        lab2Inv: lab2.inputInventory,
      });
    }

    const runA = runSimulation();
    const runB = runSimulation();
    expect(runA).toBe(runB);
  });

  it('fails closed on invalid update options', () => {
    const world = createTestWorld();
    const techTree = createTechTree();
    const lab = createResearchLab(1, { x: 0, y: 0 });

    expect(() =>
      updateResearchLab(lab, world, techTree, { ticksPerPack: 0 })
    ).toThrowError(SimulationError);
    expect(() =>
      updateResearchLab(lab, world, techTree, { ticksPerPack: Number.NaN })
    ).toThrowError(SimulationError);
    expect(() =>
      updateResearchLab(lab, world, techTree, { powerSatisfactionOverride: -0.1 })
    ).toThrowError(SimulationError);
  });
});
