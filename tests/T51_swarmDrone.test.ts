import { describe, expect, it } from 'vitest';
import {
  SwarmDrone,
  SwarmDroneFleet,
  type LocalPerception,
} from '../src/logistics/swarmDrone.js';
import { createInitialWorldState, generateMap } from '../src/core/mapGen.js';
import { placeChest } from './T19_chest.test.js';
import { getItemCount } from '../src/core/inventory.js';

describe('Swarm Drone Logistics - SwarmBench Inspired Foraging & Transport', () => {
  it('constructs a local k x k perception window around drone center without global leakage', () => {
    const world = createInitialWorldState(1616);
    const drone = new SwarmDrone({ id: 1, viewRadius: 2 }, { x: 32, y: 32 });

    const obs = drone.observe(world, [drone]);
    expect(obs.viewSize).toBe(5); // (2*2 + 1) = 5
    expect(obs.cells.length).toBe(25); // 5x5 window
    expect(obs.center).toEqual({ x: 32, y: 32 });

    // Center cell corresponds to drone's own location
    const centerCell = obs.cells.find(c => c.relX === 0 && c.relY === 0);
    expect(centerCell).toBeDefined();
    expect(centerCell?.worldX).toBe(32);
    expect(centerCell?.worldY).toBe(32);
  });

  it('performs autonomous decentralized foraging and transports ore to a chest nest', () => {
    const world = createInitialWorldState(1616);
    const map = generateMap(1616, { width: 64, height: 64 });
    const ironPatch = map.startingPatches.iron_ore;
    expect(ironPatch.length).toBeGreaterThan(0);

    const oreCoord = ironPatch[0]!;
    const nestCoord = { x: oreCoord.x + 3, y: oreCoord.y };

    // Place a storage chest at nestCoord
    const chestId = 100;
    world.entities[chestId] = {
      id: chestId,
      type: 'wooden_chest',
      position: nestCoord,
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: null,
      active: false,
      inventory: { capacity: 16, slots: Array.from({ length: 16 }, () => ({ item: null, filter: null })) },
    };
    world.tiles[nestCoord.y * world.width + nestCoord.x]!.entityId = chestId;

    // Initialize a swarm fleet of 3 drones near the ore patch
    const fleet = new SwarmDroneFleet(3, { x: oreCoord.x + 1, y: oreCoord.y + 1 }, nestCoord, 'iron_ore');

    const initialOreTile = world.tiles[oreCoord.y * world.width + oreCoord.x]!;
    const initialOreAmount = initialOreTile.resource?.amount ?? 0;
    expect(initialOreAmount).toBeGreaterThan(0);

    // Simulate 150 decentralized autonomous steps
    for (let t = 0; t < 150; t++) {
      fleet.step(world);
    }

    // Verify items foraged and deposited
    expect(fleet.totalItemsForaged).toBeGreaterThan(0);
    expect(fleet.totalItemsDeposited).toBeGreaterThan(0);

    // Verify mass conservation: deposited items exist in chest
    const chestEntity = world.entities[chestId] as any;
    const inChest = getItemCount(chestEntity.inventory, 'iron_ore');
    expect(inChest).toBe(fleet.totalItemsDeposited);

    // Verify ore node was decremented by foraged amount
    const remainingOre = initialOreTile.resource?.amount ?? 0;
    expect(remainingOre).toBeLessThan(initialOreAmount);
  });

  it('maintains strict collision separation and avoids inter-drone collisions', () => {
    const world = createInitialWorldState(1616);
    const center = { x: 20, y: 20 };
    const fleet = new SwarmDroneFleet(4, center, center, 'iron_ore');

    // Run 50 steps
    for (let t = 0; t < 50; t++) {
      fleet.step(world);

      // Verify no two drones occupy the exact same coordinate on any tick
      const positions = new Set<string>();
      for (const d of fleet.drones) {
        const key = `${d.position.x},${d.position.y}`;
        expect(positions.has(key), `Collision detected at ${key} on step ${t}`).toBe(false);
        positions.add(key);
      }
    }
  });

  it('preserves bit-for-bit determinism across two independent swarm fleet simulations', () => {
    function runSwarm(steps = 100): string {
      const world = createInitialWorldState(1616);
      const nest = { x: 30, y: 30 };
      const fleet = new SwarmDroneFleet(5, { x: 28, y: 28 }, nest, 'coal');

      for (let s = 0; s < steps; s++) {
        fleet.step(world);
      }

      return JSON.stringify({
        dronePositions: fleet.drones.map(d => ({ id: d.id, pos: d.position, cargo: d.cargo })),
        foraged: fleet.totalItemsForaged,
        deposited: fleet.totalItemsDeposited,
      });
    }

    const run1 = runSwarm(100);
    const run2 = runSwarm(100);

    expect(run1).toBe(run2);
  });
});
