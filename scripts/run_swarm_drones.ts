/**
 * Swarm Drone Live Simulation Demo
 * Runs an autonomous 10-drone swarm foraging iron ore and transporting to storage chest.
 */
import { createInitialWorldState, generateMap } from '../src/core/mapGen.js';
import { SwarmDroneFleet } from '../src/logistics/swarmDrone.js';
import { getItemCount } from '../src/core/inventory.js';

console.log('=== Ironworks-16: SwarmBench Drone Logistics Simulation ===\n');

const world = createInitialWorldState(1616);
const map = generateMap(1616, { width: 64, height: 64 });
const oreCoord = map.startingPatches.iron_ore[0] ?? { x: 27, y: 27 };
const nestCoord = { x: oreCoord.x + 3, y: oreCoord.y };

// Place storage chest at nestCoord
const chestId = 200;
world.entities[chestId] = {
  id: chestId,
  type: 'wooden_chest',
  position: nestCoord,
  direction: 'N',
  footprint: { width: 1, height: 1 },
  powerNetworkId: null,
  active: false,
  inventory: { capacity: 16, slots: Array.from({ length: 16 }, () => ({ item: null, filter: null })) },
} as any;
world.tiles[nestCoord.y * world.width + nestCoord.x]!.entityId = chestId;

const initialOreAmount = world.tiles[oreCoord.y * world.width + oreCoord.x]!.resource?.amount ?? 0;
console.log(`[Setup] Target Ore Deposit: (${oreCoord.x}, ${oreCoord.y}) Initial Amount: ${initialOreAmount}`);
console.log(`[Setup] Central Storage Nest: (${nestCoord.x}, ${nestCoord.y})`);

const FLEET_SIZE = 10;
const fleet = new SwarmDroneFleet(FLEET_SIZE, { x: oreCoord.x + 1, y: oreCoord.y + 1 }, nestCoord, 'iron_ore');
console.log(`[Setup] Deployed ${FLEET_SIZE} autonomous drones with 5x5 localized perception windows.\n`);

const TOTAL_STEPS = 200;
console.log(`Running simulation for ${TOTAL_STEPS} steps...`);

for (let step = 1; step <= TOTAL_STEPS; step++) {
  fleet.step(world);

  if (step % 40 === 0 || step === TOTAL_STEPS) {
    const chestEntity = world.entities[chestId] as any;
    const inChest = getItemCount(chestEntity.inventory, 'iron_ore');
    const remainingOre = world.tiles[oreCoord.y * world.width + oreCoord.x]!.resource?.amount ?? 0;
    const foragingDrones = fleet.drones.filter(d => d.state === 'foraging').length;
    const transportingDrones = fleet.drones.filter(d => d.state === 'transporting').length;

    console.log(
      `Step ${step.toString().padStart(3, ' ')}: ` +
      `Foraged: ${fleet.totalItemsForaged} | Deposited: ${fleet.totalItemsDeposited} | In Chest: ${inChest} | ` +
      `Remaining Ore: ${remainingOre} | [Drones: ${foragingDrones} Foraging, ${transportingDrones} Transporting]`
    );
  }
}

console.log('\n=== Swarm Simulation Run Complete ===');
console.log(`Final Ore Harvested: ${fleet.totalItemsForaged}`);
console.log(`Final Ore In Storage: ${fleet.totalItemsDeposited}`);
console.log(`Conservation Check: ${fleet.totalItemsDeposited === getItemCount((world.entities[chestId] as any).inventory, 'iron_ore') ? 'PASS (100% Mass Conserved)' : 'FAIL'}`);
