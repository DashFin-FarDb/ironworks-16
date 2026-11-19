import { describe, expect, it } from 'vitest';
import {
  type BeltEntity,
  type Direction,
  type Tile,
  type UndergroundBeltEntity,
  type WorldState,
} from '../src/types/contracts.js';
import {
  BELT_ITEM_SPACING,
  BELT_SPEED,
  createBeltEntity,
  insertOnBelt,
} from '../src/logistics/belt.js';
import {
  SIDELOAD_ENTRY_OFFSET,
  computeBeltShape,
  countAllBeltItems,
  getBeltAt,
  getBeltUpdateOrder,
  resolveBeltHandoff,
  stepBeltNetwork,
  updateAllBeltShapes,
  updateBeltShapesAround,
} from '../src/logistics/beltNetwork.js';

function createEmptyWorld(width = 16, height = 16): WorldState {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x,
        y,
        terrain: 'grass',
        resource: null,
        entityId: null,
      });
    }
  }
  return {
    schemaVersion: 1,
    seed: 1616,
    tick: 0,
    width,
    height,
    tiles,
    entities: {},
    nextEntityId: 1,
    powerGrid: { networks: {}, nextNetworkId: 1 },
    research: { activeTech: null, completedTechs: [], progress: {} },
    dayNight: { cycleTick: 0, solarFactor: 1 },
    stats: { byItem: {} },
  };
}

function placeBelt(world: WorldState, x: number, y: number, dir: Direction): BeltEntity {
  const id = world.nextEntityId++;
  const belt = createBeltEntity(id, { x, y }, dir, 'straight');
  world.entities[id] = belt;
  world.tiles[y * world.width + x]!.entityId = id;
  return belt;
}

function removeEntityAt(world: WorldState, x: number, y: number): void {
  const tile = world.tiles[y * world.width + x]!;
  if (tile.entityId !== null) {
    delete world.entities[tile.entityId];
    tile.entityId = null;
  }
}

describe('T12: Belt Network (Auto-Curved Corners, Sideloading, Cross-Tile Handoff)', () => {
  describe('auto-curved corners', () => {
    it('curves left when fed only from the left side', () => {
      const world = createEmptyWorld();
      // Belt at (5,5) facing E; feeder at (5,4) (North = left of E) facing S.
      placeBelt(world, 5, 4, 'S');
      const corner = placeBelt(world, 5, 5, 'E');
      updateAllBeltShapes(world);

      expect(corner.shape).toBe('curve_left');
    });

    it('curves right when fed only from the right side', () => {
      const world = createEmptyWorld();
      // Belt at (5,5) facing E; feeder at (5,6) (South = right of E) facing N.
      placeBelt(world, 5, 6, 'N');
      const corner = placeBelt(world, 5, 5, 'E');
      updateAllBeltShapes(world);

      expect(corner.shape).toBe('curve_right');
    });

    it('remains straight when a back feeder is present alongside a side feeder', () => {
      const world = createEmptyWorld();
      placeBelt(world, 4, 5, 'E'); // back feeder
      placeBelt(world, 5, 4, 'S'); // left feeder
      const target = placeBelt(world, 5, 5, 'E');
      updateAllBeltShapes(world);

      expect(target.shape).toBe('straight');
    });

    it('remains straight when fed from both left and right (T-junction)', () => {
      const world = createEmptyWorld();
      placeBelt(world, 5, 4, 'S'); // left feeder
      placeBelt(world, 5, 6, 'N'); // right feeder
      const target = placeBelt(world, 5, 5, 'E');
      updateAllBeltShapes(world);

      expect(target.shape).toBe('straight');
    });

    it('updates neighbor shapes dynamically via updateBeltShapesAround', () => {
      const world = createEmptyWorld();
      const corner = placeBelt(world, 5, 5, 'E');
      expect(corner.shape).toBe('straight');

      placeBelt(world, 5, 4, 'S');
      updateBeltShapesAround(world, { x: 5, y: 4 });
      expect(corner.shape).toBe('curve_left');

      removeEntityAt(world, 5, 4);
      updateBeltShapesAround(world, { x: 5, y: 4 });
      expect(corner.shape).toBe('straight');
    });

    it('recognizes underground belt outputs as valid feeders for auto-curving', () => {
      const world = createEmptyWorld();
      const ugId = world.nextEntityId++;
      const ugOutput: UndergroundBeltEntity = {
        id: ugId,
        type: 'underground_belt',
        position: { x: 5, y: 4 },
        direction: 'S',
        footprint: { width: 1, height: 1 },
        powerNetworkId: null,
        active: false,
        mode: 'output',
        pairedEntityId: null,
        transitQueue: [],
      };
      world.entities[ugId] = ugOutput;
      world.tiles[4 * world.width + 5]!.entityId = ugId;

      const corner = placeBelt(world, 5, 5, 'E');
      expect(computeBeltShape(world, corner)).toBe('curve_left');
    });
  });

  describe('seamless cross-tile item handoff', () => {
    it('moves an item seamlessly across a 10-belt chain without double-stepping', () => {
      const world = createEmptyWorld(16, 16);
      const belts: BeltEntity[] = [];
      for (let x = 1; x <= 10; x++) {
        belts.push(placeBelt(world, x, 5, 'E'));
      }
      updateAllBeltShapes(world);

      // Downstream-first order should place belt 10 before belt 1.
      const order = getBeltUpdateOrder(world);
      expect(order[0]!.id).toBe(belts[9]!.id);
      expect(order[order.length - 1]!.id).toBe(belts[0]!.id);

      expect(insertOnBelt(belts[0]!, 'left', 'iron_ore', 0)).toBe(true);

      // At BELT_SPEED = 1/32, crossing 1 tile takes 32 ticks.
      // After 32 ticks, item should be on belt[1] at offset 0 (not 0 + speed).
      for (let t = 0; t < 32; t++) {
        stepBeltNetwork(world);
      }
      expect(belts[0]!.leftLane.items).toHaveLength(0);
      expect(belts[1]!.leftLane.items).toHaveLength(1);
      expect(belts[1]!.leftLane.items[0]!.offset).toBe(0);

      // After 9 * 32 = 288 more ticks (320 total), item reaches end of belt[9] at offset 1.0.
      for (let t = 0; t < 320; t++) {
        stepBeltNetwork(world);
      }
      expect(countAllBeltItems(world)).toBe(1);
      expect(belts[9]!.leftLane.items).toHaveLength(1);
      expect(belts[9]!.leftLane.items[0]!.itemId).toBe('iron_ore');
      expect(belts[9]!.leftLane.items[0]!.offset).toBe(1);
    });

    it('preserves left and right lanes through an auto-curved corner', () => {
      const world = createEmptyWorld();
      const b1 = placeBelt(world, 5, 4, 'S');
      const corner = placeBelt(world, 5, 5, 'E');
      const b3 = placeBelt(world, 6, 5, 'E');
      updateAllBeltShapes(world);

      expect(corner.shape).toBe('curve_left');

      insertOnBelt(b1, 'left', 'iron_plate', 0);
      insertOnBelt(b1, 'right', 'copper_plate', 0);

      // Step enough ticks to traverse b1 -> corner -> b3.
      for (let t = 0; t < 128; t++) {
        stepBeltNetwork(world);
      }

      expect(countAllBeltItems(world)).toBe(2);
      expect(b3.leftLane.items).toHaveLength(1);
      expect(b3.leftLane.items[0]!.itemId).toBe('iron_plate');
      expect(b3.rightLane.items).toHaveLength(1);
      expect(b3.rightLane.items[0]!.itemId).toBe('copper_plate');
    });

    it('handles a closed 4-belt loop deterministically with 100% conservation', () => {
      const world = createEmptyWorld();
      const b1 = placeBelt(world, 4, 4, 'E');
      placeBelt(world, 5, 4, 'S');
      placeBelt(world, 5, 5, 'W');
      placeBelt(world, 4, 5, 'N');
      updateAllBeltShapes(world);

      insertOnBelt(b1, 'left', 'coal', 0);
      insertOnBelt(b1, 'right', 'stone', 0.25);

      for (let t = 0; t < 200; t++) {
        stepBeltNetwork(world);
      }

      expect(countAllBeltItems(world)).toBe(2);
    });
  });

  describe('sideloading merges & backpressure conservation', () => {
    it('merges both lanes of a left-side feeder onto the target left lane at 0.5', () => {
      const world = createEmptyWorld();
      placeBelt(world, 4, 5, 'E'); // back feeder keeps target straight
      const side = placeBelt(world, 5, 4, 'S'); // left-side feeder
      const target = placeBelt(world, 5, 5, 'E');
      updateAllBeltShapes(world);

      expect(target.shape).toBe('straight');

      const resLeft = resolveBeltHandoff(side, target, 'left', 0);
      expect(resLeft.kind).toBe('sideload');
      if (resLeft.kind === 'sideload') {
        expect(resLeft.targetLane).toBe('left');
        expect(resLeft.entryOffset).toBe(SIDELOAD_ENTRY_OFFSET);
      }

      const resRight = resolveBeltHandoff(side, target, 'right', 0);
      expect(resRight.kind).toBe('sideload');
      if (resRight.kind === 'sideload') {
        expect(resRight.targetLane).toBe('left');
        expect(resRight.entryOffset).toBe(SIDELOAD_ENTRY_OFFSET);
      }

      // Insert one item on side's right lane and advance into target.
      insertOnBelt(side, 'right', 'iron_gear', 1 - BELT_SPEED);
      stepBeltNetwork(world);

      expect(side.rightLane.items).toHaveLength(0);
      expect(target.leftLane.items).toHaveLength(1);
      expect(target.leftLane.items[0]!.itemId).toBe('iron_gear');
      expect(target.leftLane.items[0]!.offset).toBe(SIDELOAD_ENTRY_OFFSET);
      expect(target.rightLane.items).toHaveLength(0);
    });

    it('merges a right-side feeder onto the target right lane and preserves conservation under backpressure', () => {
      const world = createEmptyWorld();
      placeBelt(world, 4, 5, 'E'); // keeps target straight
      const rightSide = placeBelt(world, 5, 6, 'N'); // right-side feeder
      const target = placeBelt(world, 5, 5, 'E');
      updateAllBeltShapes(world);

      // Fill target's right lane completely so sideloading is blocked by backpressure.
      insertOnBelt(target, 'right', 'iron_ore', 1.0);
      insertOnBelt(target, 'right', 'iron_ore', 0.75);
      insertOnBelt(target, 'right', 'iron_ore', 0.5);
      insertOnBelt(target, 'right', 'iron_ore', 0.25);

      // Place items on rightSide belt.
      insertOnBelt(rightSide, 'left', 'copper_ore', 1.0);
      insertOnBelt(rightSide, 'right', 'coal', 1.0);

      const beforeCount = countAllBeltItems(world);
      expect(beforeCount).toBe(6);

      for (let t = 0; t < 40; t++) {
        stepBeltNetwork(world);
      }

      // 100% conservation: nothing lost or duplicated under full backpressure.
      expect(countAllBeltItems(world)).toBe(6);
      expect(rightSide.leftLane.items[0]!.offset).toBe(1.0);
      expect(rightSide.rightLane.items[0]!.offset).toBe(1.0);
    });
  });

  describe('head-on collisions, map boundaries, external handoff, and determinism', () => {
    it('blocks head-on opposing belts with zero item loss', () => {
      const world = createEmptyWorld();
      const b1 = placeBelt(world, 4, 5, 'E');
      const b2 = placeBelt(world, 5, 5, 'W');
      updateAllBeltShapes(world);

      insertOnBelt(b1, 'left', 'iron_ore', 0.75);
      insertOnBelt(b2, 'left', 'copper_ore', 0.75);

      for (let t = 0; t < 20; t++) {
        stepBeltNetwork(world);
      }

      expect(countAllBeltItems(world)).toBe(2);
      expect(b1.leftLane.items[0]!.offset).toBe(1);
      expect(b2.leftLane.items[0]!.offset).toBe(1);
    });

    it('halts cleanly at map boundaries and invokes externalHandoff when provided', () => {
      const world = createEmptyWorld(4, 4);
      const edgeBelt = placeBelt(world, 3, 2, 'E');
      insertOnBelt(edgeBelt, 'left', 'stone', 1.0);

      // Without externalHandoff, item halts cleanly at edge.
      stepBeltNetwork(world);
      expect(countAllBeltItems(world)).toBe(1);
      expect(getBeltAt(world, { x: 4, y: 2 })).toBeNull();

      // With externalHandoff accepting the item, it is handed off cleanly.
      const received: string[] = [];
      stepBeltNetwork(world, {
        externalHandoff: (_belt, coord, itemId) => {
          received.push(`${itemId}@${coord.x},${coord.y}`);
          return true;
        },
      });
      expect(received).toEqual(['stone@4,2']);
      expect(countAllBeltItems(world)).toBe(0);
    });

    it('produces bit-for-bit identical world states across two independent runs', () => {
      const buildScenario = (): WorldState => {
        const w = createEmptyWorld(12, 12);
        const b1 = placeBelt(w, 2, 5, 'E');
        placeBelt(w, 3, 5, 'E');
        placeBelt(w, 4, 5, 'S');
        placeBelt(w, 4, 6, 'S');
        const side = placeBelt(w, 3, 6, 'E');
        updateAllBeltShapes(w);

        insertOnBelt(b1, 'left', 'iron_ore', 0);
        insertOnBelt(b1, 'right', 'copper_ore', BELT_ITEM_SPACING);
        insertOnBelt(side, 'left', 'coal', 0);
        return w;
      };

      const w1 = buildScenario();
      const w2 = buildScenario();

      for (let t = 0; t < 150; t++) {
        stepBeltNetwork(w1);
        stepBeltNetwork(w2);
      }

      expect(JSON.stringify(w1)).toBe(JSON.stringify(w2));
      expect(countAllBeltItems(w1)).toBe(3);
    });
  });
});
