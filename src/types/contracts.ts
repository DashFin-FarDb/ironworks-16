/**
 * Ironworks-16 Shared TypeScript Contracts (T01)
 *
 * Root type definitions covering Waves 1-5 of SPEC.md.
 * Strictly headless: zero DOM, Window, or Canvas API imports.
 * Strictly deterministic: no Math.random() or Date.now().
 */

// ============================================================================
// 1. Directions, Coordinates & Spatial Primitives
// ============================================================================

export type Direction = 'N' | 'E' | 'S' | 'W';

export const DIRECTIONS: readonly Direction[] = ['N', 'E', 'S', 'W'] as const;

export interface TileCoord {
  readonly x: number;
  readonly y: number;
}

export interface WorldCoord {
  readonly x: number;
  readonly y: number;
}

export interface GridBounds {
  readonly width: number;
  readonly height: number;
}

export const DIRECTION_VECTORS: Readonly<Record<Direction, TileCoord>> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
} as const;

export function rotateDirection(dir: Direction, stepsClockwise = 1): Direction {
  const idx = DIRECTIONS.indexOf(dir);
  const next = (((idx + stepsClockwise) % 4) + 4) % 4;
  return DIRECTIONS[next] as Direction;
}

export function oppositeDirection(dir: Direction): Direction {
  return rotateDirection(dir, 2);
}

export function stepCoord(coord: TileCoord, dir: Direction, distance = 1): TileCoord {
  const vec = DIRECTION_VECTORS[dir];
  return {
    x: coord.x + vec.x * distance,
    y: coord.y + vec.y * distance,
  };
}

export function coordKey(coord: TileCoord): string {
  return `${coord.x},${coord.y}`;
}

export function isWithinBounds(coord: TileCoord, bounds: GridBounds): boolean {
  return (
    Number.isInteger(coord.x) &&
    Number.isInteger(coord.y) &&
    coord.x >= 0 &&
    coord.y >= 0 &&
    coord.x < bounds.width &&
    coord.y < bounds.height
  );
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ============================================================================
// 2. Terrain & Resource Nodes
// ============================================================================

export type TerrainType = 'grass' | 'dirt' | 'sand' | 'water' | 'stone_ground';

export type ResourceType = 'iron_ore' | 'copper_ore' | 'coal' | 'stone';

export interface ResourceNode {
  readonly type: ResourceType;
  amount: number;
  readonly initialAmount: number;
}

export interface Tile {
  readonly x: number;
  readonly y: number;
  terrain: TerrainType;
  resource: ResourceNode | null;
  entityId: EntityId | null;
}

// ============================================================================
// 3. Items & Inventories
// ============================================================================

export type ItemId =
  // Raw ores & fuel
  | 'iron_ore'
  | 'copper_ore'
  | 'coal'
  | 'stone'
  // Smelted plates & bricks
  | 'iron_plate'
  | 'copper_plate'
  | 'stone_brick'
  | 'steel_plate'
  // Intermediates
  | 'iron_gear'
  | 'copper_cable'
  | 'electronic_circuit'
  // Logistics & infrastructure
  | 'transport_belt'
  | 'underground_belt'
  | 'splitter'
  | 'inserter'
  | 'filter_inserter'
  | 'power_pole'
  | 'wooden_chest'
  | 'iron_chest'
  // Science packs
  | 'red_science'
  | 'green_science';

export type ItemCategory =
  | 'raw'
  | 'smelted'
  | 'intermediate'
  | 'logistics'
  | 'science';

export interface ItemDefinition {
  readonly id: ItemId;
  readonly name: string;
  readonly category: ItemCategory;
  readonly stackSize: number;
  /** Fuel energy in kilojoules (kJ); 0 if not burnable. */
  readonly fuelValueKj: number;
}

export interface ItemStack {
  itemId: ItemId;
  count: number;
}

export interface InventorySlot {
  item: ItemStack | null;
  filter: ItemId | null;
}

export interface InventoryState {
  readonly capacity: number;
  slots: InventorySlot[];
}

// ============================================================================
// 4. Recipes & Tech Tree
// ============================================================================

export type RecipeId =
  // Smelting (T31)
  | 'iron_plate'
  | 'copper_plate'
  | 'stone_brick'
  | 'steel_plate'
  // Intermediates (T32)
  | 'iron_gear'
  | 'copper_cable'
  | 'electronic_circuit'
  // Logistics (T33)
  | 'transport_belt'
  | 'inserter'
  | 'power_pole'
  // Science (T34)
  | 'red_science'
  | 'green_science';

export type RecipeCategory = 'smelting' | 'assembling';

export interface RecipeIngredient {
  readonly itemId: ItemId;
  readonly count: number;
}

export interface RecipeOutput {
  readonly itemId: ItemId;
  readonly count: number;
}

export type TechId =
  | 'automation'
  | 'logistics'
  | 'steel_processing'
  | 'solar_energy';

export interface RecipeDefinition {
  readonly id: RecipeId;
  readonly name: string;
  readonly category: RecipeCategory;
  readonly ingredients: readonly RecipeIngredient[];
  readonly outputs: readonly RecipeOutput[];
  /** Base crafting duration in simulation ticks (at 60 ticks/sec). */
  readonly craftingTicks: number;
  /** Optional technology required to unlock this recipe. */
  readonly requiredTech?: TechId;
}

export interface TechDefinition {
  readonly id: TechId;
  readonly name: string;
  readonly prerequisites: readonly TechId[];
  readonly cost: readonly RecipeIngredient[];
  readonly unlocksRecipes: readonly RecipeId[];
}

export interface ResearchState {
  activeTech: TechId | null;
  completedTechs: TechId[];
  /** Number of science packs delivered toward the active tech, keyed by ItemId. */
  progress: Partial<Record<ItemId, number>>;
}

// ============================================================================
// 5. Entities (Logistics, Power & Machines)
// ============================================================================

export type EntityId = number;

export type EntityType =
  // Logistics (Wave 2)
  | 'transport_belt'
  | 'splitter'
  | 'underground_belt'
  | 'inserter'
  | 'filter_inserter'
  | 'power_pole'
  | 'wooden_chest'
  | 'iron_chest'
  // Machines (Wave 3)
  | 'burner_drill'
  | 'electric_drill'
  | 'stone_furnace'
  | 'electric_furnace'
  | 'assembler_mk1'
  | 'assembler_mk2'
  | 'boiler'
  | 'steam_engine'
  | 'solar_panel'
  | 'accumulator'
  | 'research_lab';

export interface EntityFootprint {
  readonly width: number;
  readonly height: number;
}

export interface BaseEntity {
  readonly id: EntityId;
  readonly type: EntityType;
  position: TileCoord;
  direction: Direction;
  readonly footprint: EntityFootprint;
  /** Current power network ID if connected, else null. */
  powerNetworkId: PowerNetworkId | null;
  /** Active working indicator for renderer/telemetry. */
  active: boolean;
}

// --- Logistics Entities ---

export interface BeltLaneItem {
  itemId: ItemId;
  /** Normalized position along the tile in [0, 1]. */
  offset: number;
}

export interface BeltLane {
  items: BeltLaneItem[];
}

export type BeltShape = 'straight' | 'curve_left' | 'curve_right';

export interface BeltEntity extends BaseEntity {
  readonly type: 'transport_belt';
  shape: BeltShape;
  leftLane: BeltLane;
  rightLane: BeltLane;
}

export interface SplitterEntity extends BaseEntity {
  readonly type: 'splitter';
  /** Alternates 0 / 1 for 50/50 fair distribution. */
  nextOutputIndex: 0 | 1;
  leftLane: BeltLane;
  rightLane: BeltLane;
}

export type UndergroundBeltMode = 'input' | 'output';

export interface UndergroundBeltItem {
  itemId: ItemId;
  remainingTicks: number;
  lane: 'left' | 'right';
}

export interface UndergroundBeltEntity extends BaseEntity {
  readonly type: 'underground_belt';
  mode: UndergroundBeltMode;
  pairedEntityId: EntityId | null;
  transitQueue: UndergroundBeltItem[];
}

export type InserterPhase =
  | 'idle'
  | 'picking'
  | 'swinging'
  | 'dropping'
  | 'returning';

export interface InserterEntity extends BaseEntity {
  readonly type: 'inserter';
  phase: InserterPhase;
  /** Normalized progress of current phase in [0, 1]. */
  phaseProgress: number;
  heldItem: ItemId | null;
  /** Arm angle in radians for rendering. */
  armAngle: number;
}

export interface FilterInserterEntity extends BaseEntity {
  readonly type: 'filter_inserter';
  phase: InserterPhase;
  phaseProgress: number;
  heldItem: ItemId | null;
  armAngle: number;
  /** Up to 3 whitelisted ItemIds. */
  filters: ItemId[];
}

export interface PowerPoleEntity extends BaseEntity {
  readonly type: 'power_pole';
  readonly supplyRadius: number;
  readonly wireReach: number;
  connectedPoleIds: EntityId[];
}

export interface ChestEntity extends BaseEntity {
  readonly type: 'wooden_chest' | 'iron_chest';
  inventory: InventoryState;
}

// --- Machine Entities ---

export interface BurnerDrillEntity extends BaseEntity {
  readonly type: 'burner_drill';
  fuelInventory: InventoryState;
  /** Remaining burn energy in kJ. */
  fuelEnergyKj: number;
  /** Mining progress in ticks toward 90. */
  miningProgress: number;
}

export interface ElectricDrillEntity extends BaseEntity {
  readonly type: 'electric_drill';
  /** Rated power draw in kW (default 90). */
  readonly powerDemandKw: number;
  /** Mining progress in ticks toward 45. */
  miningProgress: number;
}

export interface StoneFurnaceEntity extends BaseEntity {
  readonly type: 'stone_furnace';
  inputInventory: InventoryState;
  outputInventory: InventoryState;
  fuelInventory: InventoryState;
  fuelEnergyKj: number;
  activeRecipe: RecipeId | null;
  craftingProgress: number;
}

export interface ElectricFurnaceEntity extends BaseEntity {
  readonly type: 'electric_furnace';
  readonly powerDemandKw: number;
  inputInventory: InventoryState;
  outputInventory: InventoryState;
  activeRecipe: RecipeId | null;
  craftingProgress: number;
}

export interface AssemblerEntity extends BaseEntity {
  readonly type: 'assembler_mk1' | 'assembler_mk2';
  readonly powerDemandKw: number;
  readonly craftingSpeed: number;
  readonly maxIngredients: number;
  recipeId: RecipeId | null;
  inputInventory: InventoryState;
  outputInventory: InventoryState;
  craftingProgress: number;
}

export interface BoilerEntity extends BaseEntity {
  readonly type: 'boiler';
  fuelInventory: InventoryState;
  fuelEnergyKj: number;
  /** Steam buffer in [0, 100]. */
  steamBuffer: number;
}

export interface SteamEngineEntity extends BaseEntity {
  readonly type: 'steam_engine';
  /** Maximum power output in kW (default 900). */
  readonly maxPowerOutputKw: number;
  currentOutputKw: number;
}

export interface SolarPanelEntity extends BaseEntity {
  readonly type: 'solar_panel';
  /** Peak daytime output in kW (default 60). */
  readonly peakOutputKw: number;
  currentOutputKw: number;
}

export interface AccumulatorEntity extends BaseEntity {
  readonly type: 'accumulator';
  /** Stored energy in kJ. */
  storedEnergyKj: number;
  readonly capacityKj: number;
  readonly maxChargeRateKw: number;
  readonly maxDischargeRateKw: number;
}

export interface ResearchLabEntity extends BaseEntity {
  readonly type: 'research_lab';
  readonly powerDemandKw: number;
  inputInventory: InventoryState;
  researchProgress: number;
}

export type Entity =
  | BeltEntity
  | SplitterEntity
  | UndergroundBeltEntity
  | InserterEntity
  | FilterInserterEntity
  | PowerPoleEntity
  | ChestEntity
  | BurnerDrillEntity
  | ElectricDrillEntity
  | StoneFurnaceEntity
  | ElectricFurnaceEntity
  | AssemblerEntity
  | BoilerEntity
  | SteamEngineEntity
  | SolarPanelEntity
  | AccumulatorEntity
  | ResearchLabEntity;

// ============================================================================
// 6. Power Networks
// ============================================================================

export type PowerNetworkId = number;

export interface PowerNetwork {
  readonly id: PowerNetworkId;
  poleIds: EntityId[];
  producerIds: EntityId[];
  consumerIds: EntityId[];
  accumulatorIds: EntityId[];
  totalSupplyKw: number;
  totalDemandKw: number;
  /** Clamped ratio in [0, 1]. 1.0 when demand === 0; 0.0 when supply === 0 && demand > 0. */
  satisfaction: number;
}

export interface PowerGridState {
  networks: Record<PowerNetworkId, PowerNetwork>;
  nextNetworkId: PowerNetworkId;
}

export interface PowerSatisfactionResult {
  readonly networkId: PowerNetworkId;
  readonly supplyKw: number;
  readonly demandKw: number;
  readonly satisfaction: number;
  readonly isBrownout: boolean;
}

// ============================================================================
// 7. Simulation Events (T05)
// ============================================================================

export interface ItemProducedEvent {
  readonly tick: number;
  readonly itemId: ItemId;
  readonly count: number;
  readonly entityId: EntityId;
}

export interface EntityPlacedEvent {
  readonly tick: number;
  readonly entityId: EntityId;
  readonly entityType: EntityType;
  readonly position: TileCoord;
}

export interface EntityRemovedEvent {
  readonly tick: number;
  readonly entityId: EntityId;
  readonly entityType: EntityType;
  readonly position: TileCoord;
}

export interface ResearchCompletedEvent {
  readonly tick: number;
  readonly techId: TechId;
}

export interface PowerBrownoutEvent {
  readonly tick: number;
  readonly networkId: PowerNetworkId;
  readonly satisfaction: number;
  readonly supplyKw: number;
  readonly demandKw: number;
}

export interface SimulationEventMap {
  itemProduced: ItemProducedEvent;
  entityPlaced: EntityPlacedEvent;
  entityRemoved: EntityRemovedEvent;
  researchCompleted: ResearchCompletedEvent;
  powerBrownout: PowerBrownoutEvent;
}

export type SimulationEventType = keyof SimulationEventMap;

export type EventHandler<K extends SimulationEventType> = (
  payload: SimulationEventMap[K]
) => void;

// ============================================================================
// 8. Statistics, Telemetry & Fault Injection
// ============================================================================

export interface ItemProductionRecord {
  producedTotal: number;
  consumedTotal: number;
  /** Rolling 60-second production rate (items/min). */
  producedPerMinute: number;
  /** Rolling 60-second consumption rate (items/min). */
  consumedPerMinute: number;
}

export interface ProductionStats {
  byItem: Partial<Record<ItemId, ItemProductionRecord>>;
}

export interface FactoryTelemetry {
  readonly tick: number;
  readonly activeEntities: number;
  readonly powerSatisfaction: number;
  readonly redScienceProduced: number;
  readonly ironPlatesProduced: number;
  readonly totalItemsOnBelts: number;
}

export type FaultType = 'blackout' | 'corrupt_save';

export interface FaultInjectionResult {
  readonly caught: boolean;
  readonly errorType?: string;
}

// ============================================================================
// 9. Tick Loop, Day/Night Cycle & World State
// ============================================================================

export type TickPhase =
  | 'power'
  | 'mining'
  | 'smelting_assembling'
  | 'inserters'
  | 'belts'
  | 'stats';

export const TICK_PHASES: readonly TickPhase[] = [
  'power',
  'mining',
  'smelting_assembling',
  'inserters',
  'belts',
  'stats',
] as const;

export const TICKS_PER_SECOND = 60;
export const DAY_CYCLE_TICKS = 3600;

export interface DayNightState {
  /** Current tick within [0, DAY_CYCLE_TICKS). */
  cycleTick: number;
  /** Normalized solar efficiency in [0, 1]. */
  solarFactor: number;
}

export interface WorldState {
  readonly schemaVersion: 1;
  readonly seed: number;
  tick: number;
  readonly width: number;
  readonly height: number;
  /** Row-major flat array of length width * height (index = y * width + x). */
  tiles: Tile[];
  entities: Record<EntityId, Entity>;
  nextEntityId: EntityId;
  powerGrid: PowerGridState;
  research: ResearchState;
  dayNight: DayNightState;
  stats: ProductionStats;
}

// ============================================================================
// 10. Renderer & UI Pure State Contracts (Zero DOM/Canvas Imports)
// ============================================================================

export interface CameraState {
  /** World-space center X in tile units. */
  x: number;
  /** World-space center Y in tile units. */
  y: number;
  /** Pixels per tile (e.g. 16, 32, 48). */
  zoom: number;
}

export interface ViewportBounds {
  readonly minTileX: number;
  readonly maxTileX: number;
  readonly minTileY: number;
  readonly maxTileY: number;
}

export interface HotbarSlot {
  readonly key: number;
  readonly entityType: EntityType;
  readonly label: string;
}

// ============================================================================
// 11. Typed Fail-Closed Simulation Errors
// ============================================================================

export class SimulationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SimulationError';
    this.code = code;
  }
}

export class OutOfBoundsError extends SimulationError {
  readonly coord: TileCoord;

  constructor(coord: TileCoord, bounds: GridBounds) {
    super(
      'OUT_OF_BOUNDS',
      `Coordinate (${coord.x}, ${coord.y}) is outside grid bounds (${bounds.width}x${bounds.height}).`
    );
    this.name = 'OutOfBoundsError';
    this.coord = coord;
  }
}

export class InvalidPlacementError extends SimulationError {
  readonly coord: TileCoord;
  readonly entityType: EntityType;

  constructor(entityType: EntityType, coord: TileCoord, reason: string) {
    super(
      'INVALID_PLACEMENT',
      `Cannot place ${entityType} at (${coord.x}, ${coord.y}): ${reason}`
    );
    this.name = 'InvalidPlacementError';
    this.coord = coord;
    this.entityType = entityType;
  }
}

export class UnknownItemError extends SimulationError {
  readonly itemId: string;

  constructor(itemId: string) {
    super('UNKNOWN_ITEM', `Unknown item ID: "${itemId}".`);
    this.name = 'UnknownItemError';
    this.itemId = itemId;
  }
}

export class UnknownRecipeError extends SimulationError {
  readonly recipeId: string;

  constructor(recipeId: string) {
    super('UNKNOWN_RECIPE', `Unknown recipe ID: "${recipeId}".`);
    this.name = 'UnknownRecipeError';
    this.recipeId = recipeId;
  }
}

export class DeserializationError extends SimulationError {
  constructor(message: string) {
    super('DESERIALIZATION_ERROR', message);
    this.name = 'DeserializationError';
  }
}

export class InsufficientIngredientsError extends SimulationError {
  readonly recipeId: RecipeId;

  constructor(recipeId: RecipeId) {
    super(
      'INSUFFICIENT_INGREDIENTS',
      `Insufficient ingredients to craft recipe "${recipeId}".`
    );
    this.name = 'InsufficientIngredientsError';
    this.recipeId = recipeId;
  }
}
