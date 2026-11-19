import { describe, expect, it } from 'vitest';
import { createShowcaseHarness } from '../src/app/showcaseFactory.js';
import { serializeWorldState } from '../src/core/serializer.js';
import crypto from 'node:crypto';

describe('T49 - Headless 1,000-Tick Factory E2E & Determinism Verification', () => {
  it('runs 1,000 ticks, produces >= 1 Red Science, maintains powerSatisfaction > 0.9, zero NaNs', () => {
    const harness = createShowcaseHarness(1616);

    // Step 1,000 ticks in headless pure execution
    harness.step(1000);
    expect(harness.world.tick).toBe(1000);

    const telemetry = harness.getTelemetry();
    expect(telemetry.tick).toBe(1000);
    expect(telemetry.powerSatisfaction).toBeGreaterThan(0.9);
    expect(telemetry.redScienceProduced).toBeGreaterThanOrEqual(1);

    // Ensure zero NaNs anywhere in telemetry
    for (const [key, val] of Object.entries(telemetry)) {
      expect(Number.isNaN(val), `Telemetry field ${key} is NaN`).toBe(false);
    }
  });

  it('guarantees bit-for-bit determinism across two independent runs', () => {
    function runSim(ticks = 1000): { serialized: string; hash: string } {
      const harness = createShowcaseHarness(1616);
      harness.step(ticks);
      const json = serializeWorldState(harness.world);
      const hash = crypto.createHash('sha256').update(json, 'utf8').digest('hex');
      return { serialized: json, hash };
    }

    const run1 = runSim(1000);
    const run2 = runSim(1000);

    expect(run1.hash).toBe(run2.hash);
    expect(run1.serialized).toBe(run2.serialized);
  });
});
