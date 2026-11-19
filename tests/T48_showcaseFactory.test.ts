import { describe, expect, it } from 'vitest';
import {
  buildShowcaseFactory,
  createCanonicalRecipeRegistry,
  createShowcaseHarness,
} from '../src/app/showcaseFactory.js';
import { createInitialWorldState } from '../src/core/mapGen.js';

describe('T48 - Showcase Factory', () => {
  it('builds showcase factory on seed 1616 with all key infrastructure', () => {
    const world = createInitialWorldState(1616);
    const registry = createCanonicalRecipeRegistry();
    buildShowcaseFactory(world, registry);

    const entities = Object.values(world.entities);
    expect(entities.length).toBeGreaterThan(10);

    const hasBoiler = entities.some((e) => e.type === 'boiler');
    const hasEngine = entities.some((e) => e.type === 'steam_engine');
    const hasDrill = entities.some((e) => e.type === 'electric_drill');
    const hasFurnace = entities.some((e) => e.type === 'electric_furnace');
    const hasAssembler = entities.some((e) => e.type === 'assembler_mk1');

    expect(hasBoiler).toBe(true);
    expect(hasEngine).toBe(true);
    expect(hasDrill).toBe(true);
    expect(hasFurnace).toBe(true);
    expect(hasAssembler).toBe(true);
  });

  it('runs simulation harness and produces telemetry', () => {
    const harness = createShowcaseHarness(1616);
    expect(harness.world.tick).toBe(0);

    const initialTelemetry = harness.getTelemetry();
    expect(initialTelemetry.tick).toBe(0);
    expect(initialTelemetry.powerSatisfaction).toBeGreaterThanOrEqual(0.9);

    // Step 300 ticks
    harness.step(300);
    expect(harness.world.tick).toBe(300);

    const tel300 = harness.getTelemetry();
    expect(tel300.tick).toBe(300);
    expect(tel300.powerSatisfaction).toBeGreaterThan(0.9);
  });
});
