# Ironworks-16: Behavioral Specification & System Invariants

## 1. Mission
Build **Ironworks-16**, a deterministic, browser-playable 16-bit factory and logistics simulation engine in TypeScript + HTML5 Canvas 2D. You are operating inside a 50-agent autonomous swarm. Internal architecture, helper abstractions, and edge-case handling are yours to design, provided all **System Invariants** and **Behavioral Contracts** below hold.

## 2. Non-Negotiable System Invariants
1. **Strict Determinism:** Given an identical seed and input sequence, two independent simulation runs must produce bit-for-bit identical serialized world states at any tick $t$. Never use `Math.random()` or `Date.now()` inside simulation logic.
2. **Item & Mass Conservation:** Items may only be created by mining/crafting and destroyed by consumption/fueling. Under belt backpressure, splitter congestion, or full inventories, items must halt—never silently disappear, duplicate, or produce `NaN` counts.
3. **Fail-Closed Execution:** Invalid placements, missing recipes, unknown item IDs, corrupted save JSON, or zero-power brownouts must fail explicitly (typed error/rejection or clean zero-progress halt)—never swallow exceptions with silent `try/catch {}` fallbacks or corrupt world state.
4. **Headless Simulation Purity:** Simulation modules (`src/types/`, `src/core/`, `src/logistics/`, `src/machines/`, `src/recipes/`) must never import `window`, `document`, or Canvas APIs. The entire factory must run headlessly in Node/Vitest.
5. **Zero External Assets & Dependencies:** Do not install new npm packages. All 16×16 sprites must be generated procedurally in code.
6. **Stigmergic Coordination:** If you define, extend, or discover a defect in a shared contract (`src/types/contracts.ts`), record a concise note in `agent_notes/Txx.md` (one file per task to avoid merge conflicts). Read existing `agent_notes/` before modifying shared interfaces.
7. **Verification:** Every task `Txx` must include a passing unit test at `tests/Txx_*.test.ts`. `npm run typecheck` and `npm test` must pass.

---

## 3. Progressive Integration Milestones
- **Milestone M1 (Post-Wave 1):** Map generates deterministically from seed `1616`; world serializes and deserializes with zero state drift.
- **Milestone M2 (Post-Wave 2):** Items travel across 10 belts, a corner, an underground belt, and a 50/50 splitter into a chest with 100% item conservation under backpressure.
- **Milestone M3 (Post-Wave 3):** A coal-fed steam engine powers an electric drill and furnace, smelting iron ore into iron plates while scaling down cleanly under a simulated 50% brownout.
- **Milestone M4 (Post-Wave 5):** The `T48` Showcase Factory runs 1,000 headless ticks, producing `>= 1` Red Science pack with `powerSatisfaction > 0.9`, zero `NaN` values, and identical state hashes across two independent runs.

---

## 4. 50-Agent Behavioral Task Manifest

### Wave 1: Core Engine & Contracts (T01–T10)
- **T01** `src/types/contracts.ts` — Shared TypeScript contracts for directions, coordinates, items, recipes, entities, power networks, world state, and telemetry snapshots.
- **T02** `src/core/tilemap.ts` — Bounded 2D tile grid (`64×64` default) with terrain, ore deposits, and O(1) entity occupancy lookup; out-of-bounds queries must fail closed.
- **T03** `src/core/tickLoop.ts` — Fixed-timestep engine (`60 ticks/sec`) executing deterministic update phases: power -> mining -> smelting/assembling -> inserters -> belts -> stats.
- **T04** `src/core/entityManager.ts` — Entity lifecycle (spawn, rotate, destroy, query by type/ID) with deterministic monotonic IDs.
- **T05** `src/core/eventBus.ts` — Typed pub/sub bus (`itemProduced`, `entityPlaced`, `entityRemoved`, `researchCompleted`, `powerBrownout`).
- **T06** `src/core/itemRegistry.ts` — Canonical item definitions (ores, plates, brick, steel, gears, cable, circuits, belts, inserters, poles, red/green science) with stack sizes and fuel values.
- **T07** `src/core/recipeRegistry.ts` — Recipe registry validating that all ingredient/output `ItemId`s exist in `T06`.
- **T08** `src/core/inventory.ts` — Slot-based inventory supporting stacking, optional per-slot filters, and atomic `consumeIngredients` (all-or-nothing).
- **T09** `src/core/mapGen.ts` — Seeded PRNG (Mulberry32) and deterministic map generator guaranteeing starting Iron, Copper, Coal, and Stone patches near `(32, 32)`.
- **T10** `src/core/serializer.ts` — Deterministic canonical JSON serialization/deserialization of `WorldState`; malformed JSON must throw a typed `DeserializationError` (fail closed).

### Wave 2: Logistics & Power (T11–T20)
- **T11** `src/logistics/belt.ts` — Two-lane conveyor belt with fixed item spacing and strict backpressure blocking (zero item loss).
- **T12** `src/logistics/beltNetwork.ts` — Auto-curved corners, sideloading merges, and seamless cross-tile item handoff.
- **T13** `src/logistics/splitter.ts` — 2-tile-wide 50/50 alternating splitter preserving conservation when one output lane is blocked.
- **T14** `src/logistics/undergroundBelt.ts` — Entry/exit underground belt bridging up to 4 tiles with accurate transit delay.
- **T15** `src/logistics/inserter.ts` — State-machine arm (`idle -> picking -> swinging -> dropping -> returning`) moving 1 item between source and target tiles.
- **T16** `src/logistics/filterInserter.ts` — Inserter restricted to a whitelist of up to 3 `ItemId`s.
- **T17** `src/logistics/powerGrid.ts` — Power poles (`supplyRadius = 5`, `wireReach = 7`) and graph partitioning of connected producers/consumers.
- **T18** `src/logistics/powerSolver.ts` — Per-tick `satisfaction = clamp(supply / demand, 0, 1)` solver scaling electric machine speed proportionally (0 demand -> satisfaction `1.0`, 0 supply with demand -> `0.0`, never `NaN`).
- **T19** `src/logistics/chest.ts` — Wooden (16-slot) and Iron (32-slot) storage chests.
- **T20** `src/logistics/techTree.ts` — Research state machine (`automation`, `logistics`, `steel_processing`, `solar_energy`) gating locked recipes.

### Wave 3: Machines & Recipes (T21–T35)
- **T21** `src/machines/resourceNode.ts` — Finite ore deposits supporting `mineOne()` and clean depletion.
- **T22** `src/machines/burnerDrill.ts` — Coal-fueled drill mining 1 ore / 90 ticks onto its front tile; halts cleanly if blocked or out of fuel.
- **T23** `src/machines/electricDrill.ts` — 90 kW drill mining 1 ore / 45 ticks scaled by power satisfaction.
- **T24** `src/machines/stoneFurnace.ts` — Coal-fueled smelter auto-selecting smelting recipes from input.
- **T25** `src/machines/electricFurnace.ts` — 180 kW smelter at 2× Stone Furnace speed scaled by power satisfaction.
- **T26** `src/machines/assemblerMk1.ts` — 75 kW assembler (`≤2` ingredients, speed `0.5`).
- **T27** `src/machines/assemblerMk2.ts` — 150 kW assembler (`≤4` ingredients, speed `0.75`).
- **T28** `src/machines/steamPower.ts` — Coal-fueled Boiler + Steam Engine supplying 900 kW to its power network.
- **T29** `src/machines/solarPower.ts` — 3,600-tick day/night clock driving Solar Panels (60 kW peak) and Accumulator charge/discharge.
- **T30** `src/machines/researchLab.ts` — 60 kW lab consuming science packs to advance active tech.
- **T31** `src/recipes/smeltingRecipes.ts` — `iron_plate`, `copper_plate`, `stone_brick`, `steel_plate`.
- **T32** `src/recipes/intermediateRecipes.ts` — `iron_gear`, `copper_cable`, `electronic_circuit`.
- **T33** `src/recipes/logisticsRecipes.ts` — `transport_belt`, `inserter`, `power_pole`.
- **T34** `src/recipes/scienceRecipes.ts` — `red_science`, `green_science`.
- **T35** `src/machines/statsTracker.ts` — Cumulative and rolling 60-second items/min production/consumption tracker.

### Wave 4: 16-Bit Renderer & UI (T36–T46)
- **T36** `src/render/spriteAtlas.ts` — Procedural 16×16 pixel-art sprite atlas (terrain, ores, items, 4-frame belts, machines, inserters).
- **T37** `src/render/camera.ts` — Pan/zoom camera, screen-to-tile transforms, and viewport culling.
- **T38** `src/render/terrainLayer.ts` — Visible terrain and ore-patch renderer.
- **T39** `src/render/beltLayer.ts` — Tick-synced animated belts and moving lane items.
- **T40** `src/render/entityLayer.ts` — Machines with active/idle indicators, furnace glow, and rotating inserter arms.
- **T41** `src/render/powerOverlay.ts` — Toggleable power wires, coverage squares, and unpowered warning icons.
- **T42** `src/render/ghostPreview.ts` — Valid/blocked placement preview under cursor.
- **T43** `src/ui/hotbar.ts` — Build toolbar (`1–9` hotkeys) + tick/FPS readout.
- **T44** `src/ui/inspector.ts` — Clicked entity inspector (inventory, progress, fuel, power %).
- **T45** `src/ui/productionGraph.ts` — Live sparkline chart for `iron_plate`, `copper_plate`, `iron_gear`, `red_science`.
- **T46** `src/render/minimap.ts` — 160×160 corner minimap with camera viewport box.

### Wave 5: Integration & Showcase (T47–T50)
- **T47** `src/app/inputController.ts` — WASD pan, scroll zoom, `R` rotate, left-click place/inspect, right-click delete, `P` power overlay.
- **T48** `src/app/showcaseFactory.ts` — Deterministic blueprint builder creating a self-running Red-Science factory on seed `1616`.
- **T49** `tests/T49_e2e_factory.test.ts` — Headless 1,000-tick integration test verifying `red_science >= 1`, `powerSatisfaction > 0.9`, and bit-for-bit determinism across two independent runs.
- **T50** `src/app/main.ts` — App bootstrap (`?showcase=1` loads `T48`) exposing:
  - `window.__STEP_TICKS__(n: number)`
  - `window.__FACTORY_TELEMETRY__()` -> `{ tick, activeEntities, powerSatisfaction, redScienceProduced, ironPlatesProduced, totalItemsOnBelts }`
  - `window.__SERIALIZE_STATE__()` -> canonical JSON string of `WorldState` (for determinism hashing)
  - `window.__INJECT_FAULT__(fault: 'blackout' | 'corrupt_save')` -> triggers fault probe (removes all coal/power or attempts to deserialize `"{bad_json"` and returns `{ caught: boolean, errorType?: string }`)
