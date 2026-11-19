import { describe, it, expect } from 'vitest';
import {
  CANONICAL_TECH_DEFINITIONS,
  TECH_IDS,
  TechTree,
  createInitialResearchState,
  createTechTree,
} from '../src/logistics/techTree';
import { createEventBus } from '../src/core/eventBus';
import {
  SimulationError,
  type ResearchCompletedEvent,
  type TechDefinition,
} from '../src/types/contracts';

describe('T20: Research & Tech Tree State Machine', () => {
  it('loads all 4 canonical technologies in deterministic order', () => {
    const tree = createTechTree();
    expect(tree.size).toBe(4);
    expect(tree.listAll().map((t) => t.id)).toEqual([
      'automation',
      'logistics',
      'steel_processing',
      'solar_energy',
    ]);
    for (const id of TECH_IDS) {
      expect(tree.hasTech(id)).toBe(true);
      expect(tree.getTech(id)).toEqual(CANONICAL_TECH_DEFINITIONS[id]);
    }
  });

  it('enforces prerequisite DAG and status transitions', () => {
    const tree = createTechTree();
    const state = createInitialResearchState();

    // Initially only automation is available; others are locked
    expect(tree.getTechStatus(state, 'automation')).toBe('available');
    expect(tree.getTechStatus(state, 'logistics')).toBe('locked');
    expect(tree.getTechStatus(state, 'steel_processing')).toBe('locked');
    expect(tree.getTechStatus(state, 'solar_energy')).toBe('locked');
    expect(tree.getAvailableTechs(state).map((t) => t.id)).toEqual(['automation']);

    // Cannot start locked techs
    expect(() => tree.startResearch(state, 'logistics')).toThrow(SimulationError);
    expect(() => tree.startResearch(state, 'steel_processing')).toThrow(SimulationError);
    expect(() => tree.startResearch(state, 'solar_energy')).toThrow(SimulationError);

    // Start and complete automation
    tree.startResearch(state, 'automation');
    expect(tree.getTechStatus(state, 'automation')).toBe('in_progress');
    // Starting already-active tech is a safe no-op
    tree.startResearch(state, 'automation');
    expect(state.activeTech).toBe('automation');

    const res = tree.contributeScience(state, 'red_science', 10);
    expect(res).toEqual({
      techId: 'automation',
      itemId: 'red_science',
      accepted: 10,
      rejected: 0,
      completed: true,
    });
    expect(tree.getTechStatus(state, 'automation')).toBe('completed');
    expect(state.activeTech).toBeNull();
    expect(tree.getAvailableTechs(state).map((t) => t.id)).toEqual([
      'logistics',
      'steel_processing',
    ]);

    // Completing only logistics is not enough for solar_energy
    tree.startResearch(state, 'logistics');
    tree.contributeScience(state, 'red_science', 20);
    expect(tree.getTechStatus(state, 'solar_energy')).toBe('locked');
    expect(() => tree.startResearch(state, 'solar_energy')).toThrow(SimulationError);

    // Completing steel_processing unlocks solar_energy
    tree.startResearch(state, 'steel_processing');
    tree.contributeScience(state, 'red_science', 25);
    expect(tree.getTechStatus(state, 'solar_energy')).toBe('available');
  });

  it('gates locked recipes until their required technology is completed', () => {
    const tree = createTechTree();
    const state = createInitialResearchState();

    // Base recipes are unlocked by default
    expect(tree.getRequiredTechForRecipe('iron_plate')).toBeNull();
    expect(tree.isRecipeUnlocked(state, 'iron_plate')).toBe(true);
    expect(tree.isRecipeUnlocked(state, 'red_science')).toBe(true);
    expect(() => tree.assertRecipeUnlocked(state, 'iron_plate')).not.toThrow();

    // Locked recipes fail closed before research
    expect(tree.getRequiredTechForRecipe('electronic_circuit')).toBe('automation');
    expect(tree.getRequiredTechForRecipe('inserter')).toBe('automation');
    expect(tree.getRequiredTechForRecipe('green_science')).toBe('logistics');
    expect(tree.getRequiredTechForRecipe('steel_plate')).toBe('steel_processing');
    expect(tree.getRequiredTechForRecipe('power_pole')).toBe('solar_energy');

    expect(tree.isRecipeUnlocked(state, 'steel_plate')).toBe(false);
    expect(() => tree.assertRecipeUnlocked(state, 'steel_plate')).toThrow(SimulationError);
    expect(tree.getLockedRecipes(state)).toEqual([
      'electronic_circuit',
      'inserter',
      'green_science',
      'steel_plate',
      'power_pole',
    ]);
    expect(tree.getUnlockedRecipes(state)).toEqual([]);

    // Complete automation -> electronic_circuit and inserter unlock
    tree.startResearch(state, 'automation');
    tree.contributeScience(state, 'red_science', 10);
    expect(tree.isRecipeUnlocked(state, 'electronic_circuit')).toBe(true);
    expect(tree.isRecipeUnlocked(state, 'inserter')).toBe(true);
    expect(() => tree.assertRecipeUnlocked(state, 'inserter')).not.toThrow();
    expect(tree.isRecipeUnlocked(state, 'steel_plate')).toBe(false);
    expect(tree.getUnlockedRecipes(state)).toEqual(['electronic_circuit', 'inserter']);

    // Filtering candidate recipes
    expect(
      tree.getUnlockedRecipes(state, ['iron_plate', 'inserter', 'steel_plate'])
    ).toEqual(['iron_plate', 'inserter']);
  });

  it('preserves science pack conservation on partial, excess, and mismatched contributions', () => {
    const tree = createTechTree();
    const state = createInitialResearchState();

    tree.startResearch(state, 'automation'); // requires 10 red_science

    // Mismatched science pack is fully rejected
    const wrong = tree.contributeScience(state, 'green_science', 5);
    expect(wrong).toEqual({
      techId: 'automation',
      itemId: 'green_science',
      accepted: 0,
      rejected: 5,
      completed: false,
    });
    expect(tree.getProgressRatio(state)).toBe(0);

    // Partial contribution
    const part = tree.contributeScience(state, 'red_science', 4);
    expect(part).toEqual({
      techId: 'automation',
      itemId: 'red_science',
      accepted: 4,
      rejected: 0,
      completed: false,
    });
    expect(tree.getProgressRatio(state)).toBeCloseTo(0.4, 10);
    expect(tree.getRemainingCost(state)).toEqual([{ itemId: 'red_science', count: 6 }]);

    // Excess contribution: only 6 accepted, 4 rejected
    const finish = tree.contributeScience(state, 'red_science', 10);
    expect(finish).toEqual({
      techId: 'automation',
      itemId: 'red_science',
      accepted: 6,
      rejected: 4,
      completed: true,
    });
    expect(finish.accepted + finish.rejected).toBe(10);
    expect(tree.getProgressRatio(state)).toBe(0);
    expect(tree.getRemainingCost(state)).toEqual([]);
  });

  it('handles multi-pack research (solar_energy) and emits researchCompleted on EventBus', () => {
    const tree = createTechTree();
    const state = createInitialResearchState();
    const bus = createEventBus();
    const events: ResearchCompletedEvent[] = [];
    bus.on('researchCompleted', (e) => events.push(e));

    // Unlock prerequisites
    tree.startResearch(state, 'automation');
    tree.contributeScience(state, 'red_science', 10, { tick: 100, eventBus: bus });
    tree.startResearch(state, 'logistics');
    tree.contributeScience(state, 'red_science', 20, { tick: 200, eventBus: bus });
    tree.startResearch(state, 'steel_processing');
    tree.contributeScience(state, 'red_science', 25, { tick: 300, eventBus: bus });

    // Start solar_energy: 30 red_science + 30 green_science
    tree.startResearch(state, 'solar_energy');
    const r1 = tree.contributeScience(state, 'red_science', 30, { tick: 350, eventBus: bus });
    expect(r1.completed).toBe(false);
    expect(tree.getProgressRatio(state)).toBeCloseTo(0.5, 10);
    expect(tree.getRemainingCost(state)).toEqual([{ itemId: 'green_science', count: 30 }]);

    // Extra red_science while waiting for green_science is rejected
    const rExtra = tree.contributeScience(state, 'red_science', 5, { tick: 355, eventBus: bus });
    expect(rExtra).toEqual({
      techId: 'solar_energy',
      itemId: 'red_science',
      accepted: 0,
      rejected: 5,
      completed: false,
    });

    // Complete with green_science
    const r2 = tree.contributeScience(state, 'green_science', 30, { tick: 400, eventBus: bus });
    expect(r2.completed).toBe(true);
    expect(tree.isRecipeUnlocked(state, 'power_pole')).toBe(true);

    expect(events).toEqual([
      { tick: 100, techId: 'automation' },
      { tick: 200, techId: 'logistics' },
      { tick: 300, techId: 'steel_processing' },
      { tick: 400, techId: 'solar_energy' },
    ]);
  });

  it('supports canceling and switching active research cleanly', () => {
    const tree = createTechTree();
    const state = createInitialResearchState();

    tree.startResearch(state, 'automation');
    tree.contributeScience(state, 'red_science', 3);
    expect(tree.getProgressRatio(state)).toBeCloseTo(0.3, 10);

    tree.cancelResearch(state);
    expect(state.activeTech).toBeNull();
    expect(state.progress).toEqual({});
    expect(tree.getTechStatus(state, 'automation')).toBe('available');
  });

  it('fails closed on invalid inputs and malformed tech trees', () => {
    const tree = createTechTree();
    const state = createInitialResearchState();

    expect(() => tree.getTech('nonexistent')).toThrow(SimulationError);
    expect(() => tree.contributeScience(state, 'red_science', 1)).toThrow(SimulationError);

    tree.startResearch(state, 'automation');
    expect(() => tree.contributeScience(state, 'red_science', 0)).toThrow(SimulationError);
    expect(() => tree.contributeScience(state, 'red_science', -3)).toThrow(SimulationError);
    expect(() => tree.contributeScience(state, 'red_science', 1.5)).toThrow(SimulationError);

    tree.contributeScience(state, 'red_science', 10);
    expect(() => tree.startResearch(state, 'automation')).toThrow(SimulationError);

    // Circular dependency detection
    const cyclic: TechDefinition[] = [
      {
        id: 'automation',
        name: 'A',
        prerequisites: ['logistics'],
        cost: [{ itemId: 'red_science', count: 5 }],
        unlocksRecipes: [],
      },
      {
        id: 'logistics',
        name: 'B',
        prerequisites: ['automation'],
        cost: [{ itemId: 'red_science', count: 5 }],
        unlocksRecipes: [],
      },
    ];
    expect(() => new TechTree(cyclic)).toThrow(SimulationError);
  });

  it('produces bit-for-bit identical serialized ResearchState across independent runs', () => {
    const run = (): string => {
      const tree = createTechTree();
      const state = createInitialResearchState();
      tree.startResearch(state, 'automation');
      tree.contributeScience(state, 'red_science', 10);
      tree.startResearch(state, 'logistics');
      tree.contributeScience(state, 'red_science', 7);
      return JSON.stringify(state);
    };

    expect(run()).toBe(run());
  });
});
