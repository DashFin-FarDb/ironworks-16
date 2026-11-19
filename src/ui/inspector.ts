/**
 * Ironworks-16 Clicked Entity Inspector (T44)
 *
 * Provides pure, deterministic entity inspection view-models (inventory,
 * progress, fuel, power %) plus Canvas 2D and HTML panel renderers.
 */

import {
  type Direction,
  type Entity,
  type EntityId,
  type EntityType,
  type InventoryState,
  type ItemId,
  type PowerNetwork,
  type PowerNetworkId,
  type RecipeId,
  type TileCoord,
  type WorldState,
  clamp,
  isWithinBounds,
} from '../types/contracts';
import { ITEM_REGISTRY } from '../core/itemRegistry';
import type { RecipeRegistry } from '../core/recipeRegistry';

// ============================================================================
// Constants
// ============================================================================

export const BURNER_DRILL_MAX_MINING_TICKS = 90;
export const ELECTRIC_DRILL_MAX_MINING_TICKS = 45;
export const RESEARCH_LAB_MAX_TICKS = 60;
export const BOILER_MAX_STEAM_BUFFER = 100;
export const DEFAULT_FUEL_MAX_KJ = 4000; // 1 unit of coal = 4000 kJ
export const DEFAULT_CRAFTING_TICKS = 60;

export const ENTITY_DISPLAY_NAMES: Readonly<Record<EntityType, string>> = Object.freeze({
  transport_belt: 'Transport Belt',
  splitter: 'Splitter',
  underground_belt: 'Underground Belt',
  inserter: 'Inserter',
  filter_inserter: 'Filter Inserter',
  power_pole: 'Power Pole',
  wooden_chest: 'Wooden Chest',
  iron_chest: 'Iron Chest',
  burner_drill: 'Burner Mining Drill',
  electric_drill: 'Electric Mining Drill',
  stone_furnace: 'Stone Furnace',
  electric_furnace: 'Electric Furnace',
  assembler_mk1: 'Assembler Mk1',
  assembler_mk2: 'Assembler Mk2',
  boiler: 'Boiler',
  steam_engine: 'Steam Engine',
  solar_panel: 'Solar Panel',
  accumulator: 'Accumulator',
  research_lab: 'Research Lab',
});

// ============================================================================
// Inspector State & View-Model Contracts
// ============================================================================

export interface InspectorState {
  selectedEntityId: EntityId | null;
}

export interface InspectorItemEntry {
  readonly itemId: ItemId;
  readonly name: string;
  readonly count: number;
  readonly slotIndex: number;
  readonly filter: ItemId | null;
}

export interface InspectorInventorySection {
  readonly label: string;
  readonly capacity: number;
  readonly usedSlots: number;
  readonly totalItems: number;
  readonly items: readonly InspectorItemEntry[];
}

export interface InspectorProgressInfo {
  readonly label: string;
  readonly current: number;
  readonly max: number;
  /** Clamped normalized progress in [0, 1]. */
  readonly ratio: number;
  /** Integer percentage in [0, 100]. */
  readonly percent: number;
}

export interface InspectorFuelInfo {
  readonly fuelEnergyKj: number;
  readonly maxFuelEnergyKj: number;
  /** Clamped normalized remaining burn bar in [0, 1]. */
  readonly ratio: number;
  /** Integer percentage in [0, 100]. */
  readonly percent: number;
  readonly fuelItems: readonly InspectorItemEntry[];
  readonly totalFuelCount: number;
}

export interface InspectorPowerInfo {
  readonly networkId: PowerNetworkId | null;
  readonly connected: boolean;
  /** Clamped satisfaction ratio in [0, 1]. */
  readonly satisfaction: number;
  /** Integer percentage in [0, 100]. */
  readonly percent: number;
  readonly demandKw: number;
  readonly supplyKw: number;
  readonly networkSupplyKw: number;
  readonly networkDemandKw: number;
  readonly isBrownout: boolean;
  readonly storedEnergyKj?: number;
  readonly capacityKj?: number;
  readonly chargePercent?: number;
}

export interface InspectorSnapshot {
  readonly entityId: EntityId;
  readonly entityType: EntityType;
  readonly displayName: string;
  readonly position: TileCoord;
  readonly direction: Direction;
  readonly active: boolean;
  readonly statusText: string;
  readonly recipeId: RecipeId | null;
  readonly inventories: readonly InspectorInventorySection[];
  readonly progress: InspectorProgressInfo | null;
  readonly fuel: InspectorFuelInfo | null;
  readonly power: InspectorPowerInfo | null;
  readonly details: Readonly<Record<string, string | number>>;
}

// ============================================================================
// State Management Helpers
// ============================================================================

export function createInspectorState(): InspectorState {
  return { selectedEntityId: null };
}

export function selectEntity(
  state: InspectorState,
  entityId: EntityId | null
): InspectorState {
  state.selectedEntityId = entityId;
  return state;
}

export function clearInspectorSelection(state: InspectorState): InspectorState {
  state.selectedEntityId = null;
  return state;
}

/**
 * Selects the entity occupying `coord` in `world`, or clears selection if
 * `coord` is out of bounds or unoccupied.
 */
export function selectEntityAtTile(
  state: InspectorState,
  world: WorldState,
  coord: TileCoord
): EntityId | null {
  if (!isWithinBounds(coord, { width: world.width, height: world.height })) {
    state.selectedEntityId = null;
    return null;
  }
  const tile = world.tiles[coord.y * world.width + coord.x];
  const entityId = tile?.entityId ?? null;
  if (entityId !== null && world.entities[entityId] !== undefined) {
    state.selectedEntityId = entityId;
    return entityId;
  }
  state.selectedEntityId = null;
  return null;
}

// ============================================================================
// Pure Inspection Helpers
// ============================================================================

function safeRatio(current: number, max: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  return clamp(current / max, 0, 1);
}

function getItemDisplayName(itemId: ItemId): string {
  const def = ITEM_REGISTRY[itemId];
  return def ? def.name : itemId;
}

function extractInventorySection(
  label: string,
  inv: InventoryState
): InspectorInventorySection {
  const items: InspectorItemEntry[] = [];
  let usedSlots = 0;
  let totalItems = 0;

  for (let i = 0; i < inv.slots.length; i++) {
    const slot = inv.slots[i];
    if (!slot) continue;
    if (slot.item !== null && slot.item.count > 0) {
      usedSlots += 1;
      totalItems += slot.item.count;
      items.push({
        itemId: slot.item.itemId,
        name: getItemDisplayName(slot.item.itemId),
        count: slot.item.count,
        slotIndex: i,
        filter: slot.filter,
      });
    }
  }

  return {
    label,
    capacity: inv.capacity,
    usedSlots,
    totalItems,
    items,
  };
}

function buildProgressInfo(
  label: string,
  current: number,
  max: number
): InspectorProgressInfo {
  const safeCurrent = Number.isFinite(current) ? Math.max(0, current) : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const ratio = safeRatio(safeCurrent, safeMax);
  return {
    label,
    current: safeCurrent,
    max: safeMax,
    ratio,
    percent: Math.round(ratio * 100),
  };
}

function buildFuelInfo(
  fuelEnergyKj: number,
  fuelInventory: InventoryState
): InspectorFuelInfo {
  const section = extractInventorySection('Fuel', fuelInventory);
  const safeEnergy = Number.isFinite(fuelEnergyKj) ? Math.max(0, fuelEnergyKj) : 0;
  const maxFuelEnergyKj = Math.max(DEFAULT_FUEL_MAX_KJ, safeEnergy);
  const ratio = safeRatio(safeEnergy, maxFuelEnergyKj);
  return {
    fuelEnergyKj: safeEnergy,
    maxFuelEnergyKj,
    ratio,
    percent: Math.round(ratio * 100),
    fuelItems: section.items,
    totalFuelCount: section.totalItems,
  };
}

function buildPowerInfo(
  world: WorldState,
  networkId: PowerNetworkId | null,
  demandKw: number,
  supplyKw: number,
  extra?: { storedEnergyKj: number; capacityKj: number }
): InspectorPowerInfo {
  const network: PowerNetwork | undefined =
    networkId !== null ? world.powerGrid.networks[networkId] : undefined;
  const connected = network !== undefined;
  const satisfaction = connected ? clamp(network.satisfaction, 0, 1) : 0;
  const percent = Math.round(satisfaction * 100);
  const networkSupplyKw = connected ? network.totalSupplyKw : 0;
  const networkDemandKw = connected ? network.totalDemandKw : 0;
  const isBrownout = connected && networkDemandKw > 0 && satisfaction < 1;

  const base: InspectorPowerInfo = {
    networkId: connected ? networkId : null,
    connected,
    satisfaction,
    percent,
    demandKw: Number.isFinite(demandKw) ? Math.max(0, demandKw) : 0,
    supplyKw: Number.isFinite(supplyKw) ? Math.max(0, supplyKw) : 0,
    networkSupplyKw,
    networkDemandKw,
    isBrownout,
  };

  if (extra) {
    const chargeRatio = safeRatio(extra.storedEnergyKj, extra.capacityKj);
    return {
      ...base,
      storedEnergyKj: Math.max(0, extra.storedEnergyKj),
      capacityKj: Math.max(0, extra.capacityKj),
      chargePercent: Math.round(chargeRatio * 100),
    };
  }

  return base;
}

function resolveRecipeCraftingTicks(
  recipeId: RecipeId | null,
  recipeRegistry?: RecipeRegistry
): number {
  if (recipeId === null) {
    return DEFAULT_CRAFTING_TICKS;
  }
  if (recipeRegistry && recipeRegistry.has(recipeId)) {
    return recipeRegistry.get(recipeId).craftingTicks;
  }
  return DEFAULT_CRAFTING_TICKS;
}

function deriveStatusText(
  active: boolean,
  fuel: InspectorFuelInfo | null,
  power: InspectorPowerInfo | null
): string {
  if (power !== null && power.demandKw > 0) {
    if (!power.connected || power.satisfaction <= 0) {
      return 'No Power';
    }
    if (power.isBrownout) {
      return `Low Power (${power.percent}%)`;
    }
  }
  if (fuel !== null && fuel.fuelEnergyKj <= 0 && fuel.totalFuelCount === 0) {
    return 'Out of Fuel';
  }
  return active ? 'Active' : 'Idle';
}

// ============================================================================
// Main Inspection API
// ============================================================================

/**
 * Produces a deterministic, read-only snapshot of an entity's state
 * (inventory, progress, fuel, power %, and entity-specific details).
 * Returns `null` if the entity does not exist in `world.entities`.
 */
export function inspectEntity(
  world: WorldState,
  entityId: EntityId,
  recipeRegistry?: RecipeRegistry
): InspectorSnapshot | null {
  const entity: Entity | undefined = world.entities[entityId];
  if (!entity) {
    return null;
  }

  const displayName = ENTITY_DISPLAY_NAMES[entity.type];
  let recipeId: RecipeId | null = null;
  const inventories: InspectorInventorySection[] = [];
  let progress: InspectorProgressInfo | null = null;
  let fuel: InspectorFuelInfo | null = null;
  let power: InspectorPowerInfo | null = null;
  const details: Record<string, string | number> = {};

  switch (entity.type) {
    case 'wooden_chest':
    case 'iron_chest': {
      inventories.push(extractInventorySection('Storage', entity.inventory));
      break;
    }

    case 'burner_drill': {
      inventories.push(extractInventorySection('Fuel', entity.fuelInventory));
      fuel = buildFuelInfo(entity.fuelEnergyKj, entity.fuelInventory);
      progress = buildProgressInfo(
        'Mining',
        entity.miningProgress,
        BURNER_DRILL_MAX_MINING_TICKS
      );
      break;
    }

    case 'electric_drill': {
      progress = buildProgressInfo(
        'Mining',
        entity.miningProgress,
        ELECTRIC_DRILL_MAX_MINING_TICKS
      );
      power = buildPowerInfo(world, entity.powerNetworkId, entity.powerDemandKw, 0);
      break;
    }

    case 'stone_furnace': {
      recipeId = entity.activeRecipe;
      inventories.push(extractInventorySection('Input', entity.inputInventory));
      inventories.push(extractInventorySection('Output', entity.outputInventory));
      inventories.push(extractInventorySection('Fuel', entity.fuelInventory));
      fuel = buildFuelInfo(entity.fuelEnergyKj, entity.fuelInventory);
      const maxTicks = resolveRecipeCraftingTicks(entity.activeRecipe, recipeRegistry);
      progress = buildProgressInfo('Smelting', entity.craftingProgress, maxTicks);
      break;
    }

    case 'electric_furnace': {
      recipeId = entity.activeRecipe;
      inventories.push(extractInventorySection('Input', entity.inputInventory));
      inventories.push(extractInventorySection('Output', entity.outputInventory));
      const maxTicks = resolveRecipeCraftingTicks(entity.activeRecipe, recipeRegistry);
      progress = buildProgressInfo('Smelting', entity.craftingProgress, maxTicks);
      power = buildPowerInfo(world, entity.powerNetworkId, entity.powerDemandKw, 0);
      break;
    }

    case 'assembler_mk1':
    case 'assembler_mk2': {
      recipeId = entity.recipeId;
      inventories.push(extractInventorySection('Input', entity.inputInventory));
      inventories.push(extractInventorySection('Output', entity.outputInventory));
      const maxTicks = resolveRecipeCraftingTicks(entity.recipeId, recipeRegistry);
      progress = buildProgressInfo('Crafting', entity.craftingProgress, maxTicks);
      power = buildPowerInfo(world, entity.powerNetworkId, entity.powerDemandKw, 0);
      details.craftingSpeed = entity.craftingSpeed;
      details.maxIngredients = entity.maxIngredients;
      break;
    }

    case 'boiler': {
      inventories.push(extractInventorySection('Fuel', entity.fuelInventory));
      fuel = buildFuelInfo(entity.fuelEnergyKj, entity.fuelInventory);
      progress = buildProgressInfo(
        'Steam',
        entity.steamBuffer,
        BOILER_MAX_STEAM_BUFFER
      );
      break;
    }

    case 'steam_engine': {
      power = buildPowerInfo(
        world,
        entity.powerNetworkId,
        0,
        entity.currentOutputKw
      );
      progress = buildProgressInfo(
        'Output',
        entity.currentOutputKw,
        entity.maxPowerOutputKw
      );
      details.maxPowerOutputKw = entity.maxPowerOutputKw;
      break;
    }

    case 'solar_panel': {
      power = buildPowerInfo(
        world,
        entity.powerNetworkId,
        0,
        entity.currentOutputKw
      );
      progress = buildProgressInfo(
        'Solar Output',
        entity.currentOutputKw,
        entity.peakOutputKw
      );
      details.peakOutputKw = entity.peakOutputKw;
      break;
    }

    case 'accumulator': {
      power = buildPowerInfo(world, entity.powerNetworkId, 0, 0, {
        storedEnergyKj: entity.storedEnergyKj,
        capacityKj: entity.capacityKj,
      });
      progress = buildProgressInfo(
        'Charge',
        entity.storedEnergyKj,
        entity.capacityKj
      );
      break;
    }

    case 'research_lab': {
      inventories.push(extractInventorySection('Science', entity.inputInventory));
      progress = buildProgressInfo(
        'Research',
        entity.researchProgress,
        RESEARCH_LAB_MAX_TICKS
      );
      power = buildPowerInfo(world, entity.powerNetworkId, entity.powerDemandKw, 0);
      if (world.research.activeTech !== null) {
        details.activeTech = world.research.activeTech;
      }
      break;
    }

    case 'transport_belt': {
      details.shape = entity.shape;
      details.leftLaneItems = entity.leftLane.items.length;
      details.rightLaneItems = entity.rightLane.items.length;
      break;
    }

    case 'splitter': {
      details.leftLaneItems = entity.leftLane.items.length;
      details.rightLaneItems = entity.rightLane.items.length;
      details.nextOutputIndex = entity.nextOutputIndex;
      break;
    }

    case 'underground_belt': {
      details.mode = entity.mode;
      details.paired = entity.pairedEntityId !== null ? entity.pairedEntityId : 'None';
      details.transitItems = entity.transitQueue.length;
      break;
    }

    case 'inserter': {
      details.phase = entity.phase;
      details.heldItem = entity.heldItem !== null ? getItemDisplayName(entity.heldItem) : 'None';
      progress = buildProgressInfo('Cycle', entity.phaseProgress, 1);
      break;
    }

    case 'filter_inserter': {
      details.phase = entity.phase;
      details.heldItem = entity.heldItem !== null ? getItemDisplayName(entity.heldItem) : 'None';
      details.filters =
        entity.filters.length > 0
          ? entity.filters.map(getItemDisplayName).join(', ')
          : 'None';
      progress = buildProgressInfo('Cycle', entity.phaseProgress, 1);
      break;
    }

    case 'power_pole': {
      power = buildPowerInfo(world, entity.powerNetworkId, 0, 0);
      details.connectedPoles = entity.connectedPoleIds.length;
      details.supplyRadius = entity.supplyRadius;
      details.wireReach = entity.wireReach;
      break;
    }
  }

  const statusText = deriveStatusText(entity.active, fuel, power);

  return {
    entityId: entity.id,
    entityType: entity.type,
    displayName,
    position: { x: entity.position.x, y: entity.position.y },
    direction: entity.direction,
    active: entity.active,
    statusText,
    recipeId,
    inventories,
    progress,
    fuel,
    power,
    details,
  };
}

/**
 * Inspects the currently selected entity in `state`.
 * Returns `null` if nothing is selected or the entity no longer exists.
 */
export function inspectSelectedEntity(
  state: InspectorState,
  world: WorldState,
  recipeRegistry?: RecipeRegistry
): InspectorSnapshot | null {
  if (state.selectedEntityId === null) {
    return null;
  }
  return inspectEntity(world, state.selectedEntityId, recipeRegistry);
}

// ============================================================================
// Pure Text & HTML Formatters
// ============================================================================

export function formatInspectorLines(snapshot: InspectorSnapshot): string[] {
  const lines: string[] = [
    `${snapshot.displayName} (#${snapshot.entityId})`,
    `Pos: (${snapshot.position.x}, ${snapshot.position.y}) Dir: ${snapshot.direction}`,
    `Status: ${snapshot.statusText}`,
  ];

  if (snapshot.recipeId !== null) {
    lines.push(`Recipe: ${snapshot.recipeId}`);
  }

  if (snapshot.progress !== null) {
    lines.push(`${snapshot.progress.label}: ${snapshot.progress.percent}%`);
  }

  if (snapshot.fuel !== null) {
    lines.push(
      `Fuel: ${snapshot.fuel.percent}% (${Math.round(snapshot.fuel.fuelEnergyKj)} kJ, ${snapshot.fuel.totalFuelCount} items)`
    );
  }

  if (snapshot.power !== null) {
    const netLabel = snapshot.power.connected
      ? `Net #${snapshot.power.networkId}`
      : 'Disconnected';
    lines.push(`Power: ${snapshot.power.percent}% (${netLabel})`);
  }

  for (const inv of snapshot.inventories) {
    const summary =
      inv.items.length > 0
        ? inv.items.map((item) => `${item.name} x${item.count}`).join(', ')
        : 'Empty';
    lines.push(`${inv.label} [${inv.usedSlots}/${inv.capacity}]: ${summary}`);
  }

  return lines;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderInspectorHTML(snapshot: InspectorSnapshot | null): string {
  if (!snapshot) {
    return '';
  }
  const lines = formatInspectorLines(snapshot);
  const body = lines.map((line) => `<div class="inspector-line">${escapeHtml(line)}</div>`).join('');
  return `<div class="ironworks-inspector" data-entity-id="${snapshot.entityId}">${body}</div>`;
}

// ============================================================================
// Canvas 2D Panel Renderer
// ============================================================================

export function renderInspectorCanvas(
  ctx: CanvasRenderingContext2D,
  snapshot: InspectorSnapshot | null,
  canvasWidth: number,
  canvasHeight: number
): void {
  if (!snapshot) {
    return;
  }

  const panelWidth = 240;
  const padding = 10;
  const lineHeight = 16;
  const lines = formatInspectorLines(snapshot);

  let barCount = 0;
  if (snapshot.progress !== null) barCount += 1;
  if (snapshot.fuel !== null) barCount += 1;
  if (snapshot.power !== null) barCount += 1;

  const panelHeight = padding * 2 + lines.length * lineHeight + barCount * 10 + 4;
  const x = Math.max(8, canvasWidth - panelWidth - 12);
  const y = Math.max(8, canvasHeight - panelHeight - 12);

  ctx.save();

  // Panel background
  ctx.fillStyle = 'rgba(20, 24, 32, 0.92)';
  ctx.fillRect(x, y, panelWidth, panelHeight);
  ctx.strokeStyle = '#5c6b7a';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, panelWidth, panelHeight);

  // Text lines
  ctx.font = '12px monospace';
  ctx.textBaseline = 'top';
  let cursorY = y + padding;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    ctx.fillStyle = i === 0 ? '#f4d35e' : '#e0e6ed';
    ctx.fillText(line, x + padding, cursorY, panelWidth - padding * 2);
    cursorY += lineHeight;
  }

  // Visual bars for progress, fuel, power %
  const barWidth = panelWidth - padding * 2;
  const drawBar = (ratio: number, color: string): void => {
    ctx.fillStyle = '#2c3440';
    ctx.fillRect(x + padding, cursorY, barWidth, 6);
    ctx.fillStyle = color;
    ctx.fillRect(x + padding, cursorY, Math.round(barWidth * clamp(ratio, 0, 1)), 6);
    cursorY += 10;
  };

  if (snapshot.progress !== null) {
    drawBar(snapshot.progress.ratio, '#4ea8de');
  }
  if (snapshot.fuel !== null) {
    drawBar(snapshot.fuel.ratio, '#f77f00');
  }
  if (snapshot.power !== null) {
    const powerColor =
      snapshot.power.percent >= 90
        ? '#52b788'
        : snapshot.power.percent > 0
          ? '#f4d35e'
          : '#e63946';
    drawBar(snapshot.power.satisfaction, powerColor);
  }

  ctx.restore();
}
