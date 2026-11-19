import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app/main.js';

describe('T50 - Application Bootstrap & Test Hooks', () => {
  it('instantiates app headlessly and exposes required window hooks', () => {
    const app = createApp({ seed: 1616, isShowcase: true, startAnimationLoop: false });

    // Verify stepTicks
    const initialTick = app.harness.world.tick;
    expect(initialTick).toBe(0);

    const advanced = app.stepTicks(60);
    expect(advanced).toBe(60);
    expect(app.harness.world.tick).toBe(60);

    // Verify telemetry
    const telemetry = app.getTelemetry();
    expect(telemetry.tick).toBe(60);
    expect(telemetry.powerSatisfaction).toBeGreaterThan(0.9);
    expect(typeof telemetry.activeEntities).toBe('number');
    expect(typeof telemetry.redScienceProduced).toBe('number');
    expect(typeof telemetry.ironPlatesProduced).toBe('number');
    expect(typeof telemetry.totalItemsOnBelts).toBe('number');

    // Verify serializeState
    const stateJson = app.serializeState();
    expect(typeof stateJson).toBe('string');
    expect(stateJson.length).toBeGreaterThan(100);
    const parsed = JSON.parse(stateJson);
    expect(parsed.seed).toBe(1616);
    expect(parsed.tick).toBe(60);

    // Verify injectFault
    const corruptSaveResult = app.injectFault('corrupt_save');
    expect(corruptSaveResult.caught).toBe(true);

    const blackoutResult = app.injectFault('blackout');
    expect(blackoutResult.caught).toBe(true);

    // After blackout, power satisfaction should collapse to 0
    app.stepTicks(1);
    const postBlackoutTelemetry = app.getTelemetry();
    expect(postBlackoutTelemetry.powerSatisfaction).toBe(0);

    app.destroy();
  });
});
