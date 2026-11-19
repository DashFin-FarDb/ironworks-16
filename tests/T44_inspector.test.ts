import { describe, it, expect, vi } from 'vitest';
import {
  type AssemblerEntity,
  type BeltEntity,
  type ChestEntity,
  type ElectricDrillEntity,
  type FilterInserterEntity,
  type InventoryState,
  type PowerPoleEntity,
  type ResearchLabEntity,
  type StoneFurnaceEntity,
  type Tile,
  type WorldState,
} from '../src/types/contracts';
import { createRecipeRegistry } from '../src/core/recipeRegistry';
import {
  clearInspectorSelection,
  createInspectorState,
  formatInspectorLines,
  inspectEntity,
  inspectSelectedEntity,
  renderInspectorCanvas,
  renderInspectorHTML,
  selectEntity,
  selectEntityAtTile,
} from '../src/ui/inspector';

function makeInventory(
  capacity: number,
  items: Array<{ slot: number; itemId: 'iron_ore' | 'iron_plate' | 'coal' | 'red_science'; count: number; filter?: 'iron_ore' | 'iron_plate' | 'coal' | 'red_science' }> = []
): InventoryState {
  const slots = Array.from({ length: capacity }, () => ({
    item: null as { itemId: 'iron_ore' | 'iron_plate' | 'coal' | 'red_science'; count: number } | null,
    filter: null as 'iron_ore' | 'iron_plate' | 'coal' | 'red_science' | null,
  }));
  for (const entry of items) {
    slots[entry.slot] = {
      item: { itemId: entry.itemId, count: entry.count },
      filter: entry.filter ?? null,
    };
  }
  return { capacity, slots };
}

function makeWorld(width = 8, height = 8): WorldState {
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
    tick: 100,
    width,
    height,
    tiles,
    entities: {},
    nextEntityId: 1,
    powerGrid: {
      networks: {
        1: {
          id: 1,
          poleIds: [10],
          producerIds: [11],
          consumerIds: [2, 3],
          accumulatorIds: [],
          totalSupplyKw: 900,
          totalDemandKw: 900,
          satisfaction: 1.0,
        },
        2: {
          id: 2,
          poleIds: [],
          producerIds: [],
          consumerIds: [4],
          accumulatorIds: [],
          totalSupplyKw: 45,
          totalDemandKw: 90,
          satisfaction: 0.5,
        },
      },
      nextNetworkId: 3,
    },
    research: {
      activeTech: 'automation',
      completedTechs: [],
      progress: {},
    },
    dayNight: {
      cycleTick: 900,
      solarFactor: 1.0,
    },
    stats: {
      byItem: {},
    },
  };
}

describe('T44: Clicked Entity Inspector', () => {
  it('selects and clears entities by tile coordinate and handles out-of-bounds safely', () => {
    const world = makeWorld(4, 4);
    const chest: ChestEntity = {
      id: 1,
      type: 'wooden_chest',
      position: { x: 2, y: 1 },
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: null,
      active: false,
      inventory: makeInventory(16, [{ slot: 0, itemId: 'iron_plate', count: 25 }]),
    };
    world.entities[1] = chest;
    world.tiles[1 * 4 + 2]!.entityId = 1;

    const state = createInspectorState();
    expect(state.selectedEntityId).toBeNull();
    expect(inspectSelectedEntity(state, world)).toBeNull();

    // Click occupied tile
    expect(selectEntityAtTile(state, world, { x: 2, y: 1 })).toBe(1);
    expect(state.selectedEntityId).toBe(1);

    const snap = inspectSelectedEntity(state, world);
    expect(snap).not.toBeNull();
    expect(snap!.displayName).toBe('Wooden Chest');
    expect(snap!.inventories).toHaveLength(1);
    expect(snap!.inventories[0]!.usedSlots).toBe(1);
    expect(snap!.inventories[0]!.totalItems).toBe(25);
    expect(snap!.inventories[0]!.items[0]!.name).toBe('Iron Plate');

    // Click empty tile clears selection
    expect(selectEntityAtTile(state, world, { x: 0, y: 0 })).toBeNull();
    expect(state.selectedEntityId).toBeNull();

    // Out-of-bounds click fails closed to null
    selectEntity(state, 1);
    expect(selectEntityAtTile(state, world, { x: -1, y: 99 })).toBeNull();
    expect(state.selectedEntityId).toBeNull();

    // Clear helper
    selectEntity(state, 1);
    clearInspectorSelection(state);
    expect(state.selectedEntityId).toBeNull();
  });

  it('inspects stone_furnace with inventory, smelting progress, and fuel %', () => {
    const world = makeWorld();
    const registry = createRecipeRegistry();
    registry.register({
      id: 'iron_plate',
      name: 'Iron Plate',
      category: 'smelting',
      ingredients: [{ itemId: 'iron_ore', count: 1 }],
      outputs: [{ itemId: 'iron_plate', count: 1 }],
      craftingTicks: 120,
    });

    const furnace: StoneFurnaceEntity = {
      id: 2,
      type: 'stone_furnace',
      position: { x: 3, y: 3 },
      direction: 'E',
      footprint: { width: 1, height: 1 },
      powerNetworkId: null,
      active: true,
      inputInventory: makeInventory(1, [{ slot: 0, itemId: 'iron_ore', count: 10 }]),
      outputInventory: makeInventory(1, [{ slot: 0, itemId: 'iron_plate', count: 4 }]),
      fuelInventory: makeInventory(1, [{ slot: 0, itemId: 'coal', count: 5 }]),
      fuelEnergyKj: 2000,
      activeRecipe: 'iron_plate',
      craftingProgress: 60,
    };
    world.entities[2] = furnace;

    const snap = inspectEntity(world, 2, registry);
    expect(snap).not.toBeNull();
    expect(snap!.statusText).toBe('Active');
    expect(snap!.recipeId).toBe('iron_plate');
    expect(snap!.inventories.map((i) => i.label)).toEqual(['Input', 'Output', 'Fuel']);
    expect(snap!.progress).toEqual({
      label: 'Smelting',
      current: 60,
      max: 120,
      ratio: 0.5,
      percent: 50,
    });
    expect(snap!.fuel).not.toBeNull();
    expect(snap!.fuel!.fuelEnergyKj).toBe(2000);
    expect(snap!.fuel!.percent).toBe(50);
    expect(snap!.fuel!.totalFuelCount).toBe(5);
    expect(snap!.power).toBeNull();

    // Out of fuel status
    furnace.fuelEnergyKj = 0;
    furnace.fuelInventory = makeInventory(1);
    furnace.active = false;
    const emptyFuelSnap = inspectEntity(world, 2, registry);
    expect(emptyFuelSnap!.statusText).toBe('Out of Fuel');
    expect(emptyFuelSnap!.fuel!.percent).toBe(0);
  });

  it('inspects electric machines with full power, brownout %, and no-power status', () => {
    const world = makeWorld();

    const drillFull: ElectricDrillEntity = {
      id: 3,
      type: 'electric_drill',
      position: { x: 1, y: 1 },
      direction: 'S',
      footprint: { width: 1, height: 1 },
      powerNetworkId: 1,
      active: true,
      powerDemandKw: 90,
      miningProgress: 22.5,
    };

    const drillBrownout: ElectricDrillEntity = {
      id: 4,
      type: 'electric_drill',
      position: { x: 2, y: 1 },
      direction: 'S',
      footprint: { width: 1, height: 1 },
      powerNetworkId: 2,
      active: true,
      powerDemandKw: 90,
      miningProgress: 45,
    };

    const assemblerUnpowered: AssemblerEntity = {
      id: 5,
      type: 'assembler_mk1',
      position: { x: 3, y: 1 },
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: null,
      active: false,
      powerDemandKw: 75,
      craftingSpeed: 0.5,
      maxIngredients: 2,
      recipeId: 'iron_gear',
      inputInventory: makeInventory(2),
      outputInventory: makeInventory(1),
      craftingProgress: 0,
    };

    world.entities[3] = drillFull;
    world.entities[4] = drillBrownout;
    world.entities[5] = assemblerUnpowered;

    const sFull = inspectEntity(world, 3)!;
    expect(sFull.power!.connected).toBe(true);
    expect(sFull.power!.percent).toBe(100);
    expect(sFull.power!.isBrownout).toBe(false);
    expect(sFull.progress!.percent).toBe(50);
    expect(sFull.statusText).toBe('Active');

    const sBrownout = inspectEntity(world, 4)!;
    expect(sBrownout.power!.connected).toBe(true);
    expect(sBrownout.power!.percent).toBe(50);
    expect(sBrownout.power!.isBrownout).toBe(true);
    expect(sBrownout.statusText).toBe('Low Power (50%)');

    const sUnpowered = inspectEntity(world, 5)!;
    expect(sUnpowered.power!.connected).toBe(false);
    expect(sUnpowered.power!.percent).toBe(0);
    expect(sUnpowered.statusText).toBe('No Power');
    expect(sUnpowered.details.craftingSpeed).toBe(0.5);
  });

  it('inspects logistics and research entities and guards against NaN/missing entities', () => {
    const world = makeWorld();
    const belt: BeltEntity = {
      id: 6,
      type: 'transport_belt',
      position: { x: 0, y: 0 },
      direction: 'E',
      footprint: { width: 1, height: 1 },
      powerNetworkId: null,
      active: true,
      shape: 'straight',
      leftLane: { items: [{ itemId: 'iron_ore', offset: 0.25 }] },
      rightLane: { items: [] },
    };
    const filterIns: FilterInserterEntity = {
      id: 7,
      type: 'filter_inserter',
      position: { x: 0, y: 1 },
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: null,
      active: true,
      phase: 'swinging',
      phaseProgress: Number.NaN,
      heldItem: 'coal',
      armAngle: 1.5,
      filters: ['coal', 'iron_ore'],
    };
    const pole: PowerPoleEntity = {
      id: 10,
      type: 'power_pole',
      position: { x: 4, y: 4 },
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: 1,
      active: true,
      supplyRadius: 5,
      wireReach: 7,
      connectedPoleIds: [],
    };
    const lab: ResearchLabEntity = {
      id: 12,
      type: 'research_lab',
      position: { x: 5, y: 5 },
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: 1,
      active: true,
      powerDemandKw: 60,
      inputInventory: makeInventory(2, [{ slot: 0, itemId: 'red_science', count: 3 }]),
      researchProgress: 30,
    };
    world.entities[6] = belt;
    world.entities[7] = filterIns;
    world.entities[10] = pole;
    world.entities[12] = lab;

    expect(inspectEntity(world, 999)).toBeNull();

    const sBelt = inspectEntity(world, 6)!;
    expect(sBelt.details.leftLaneItems).toBe(1);
    expect(sBelt.details.rightLaneItems).toBe(0);

    const sIns = inspectEntity(world, 7)!;
    expect(Number.isNaN(sIns.progress!.ratio)).toBe(false);
    expect(sIns.progress!.percent).toBe(0);
    expect(sIns.details.filters).toBe('Coal, Iron Ore');

    const sPole = inspectEntity(world, 10)!;
    expect(sPole.power!.percent).toBe(100);
    expect(sPole.details.supplyRadius).toBe(5);

    const sLab = inspectEntity(world, 12)!;
    expect(sLab.progress!.percent).toBe(50);
    expect(sLab.details.activeTech).toBe('automation');
  });

  it('formats lines, HTML, and renders to Canvas 2D without throwing', () => {
    const world = makeWorld();
    const drill: ElectricDrillEntity = {
      id: 3,
      type: 'electric_drill',
      position: { x: 1, y: 2 },
      direction: 'N',
      footprint: { width: 1, height: 1 },
      powerNetworkId: 2,
      active: true,
      powerDemandKw: 90,
      miningProgress: 18,
    };
    world.entities[3] = drill;

    const snap = inspectEntity(world, 3)!;
    const lines = formatInspectorLines(snap);
    expect(lines.some((l) => l.includes('Electric Mining Drill'))).toBe(true);
    expect(lines.some((l) => l.includes('Power: 50%'))).toBe(true);
    expect(lines.some((l) => l.includes('Mining: 40%'))).toBe(true);

    const html = renderInspectorHTML(snap);
    expect(html).toContain('data-entity-id="3"');
    expect(html).toContain('Power: 50%');
    expect(renderInspectorHTML(null)).toBe('');

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textBaseline: 'top',
    } as unknown as CanvasRenderingContext2D;

    renderInspectorCanvas(ctx, null, 800, 600);
    expect(ctx.fillRect).not.toHaveBeenCalled();

    renderInspectorCanvas(ctx, snap, 800, 600);
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalled();
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });
});
