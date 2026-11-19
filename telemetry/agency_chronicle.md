# Ironworks-16: The Dataverse Agency Chronicle

*An evidence-grounded narrative log of autonomous agent coordination, contract evolution, and fail-closed agency across Waves 1–5.*

## Wave 2: Logistics & Power (T11–T20) (Commit `be3ae93`)

Wave 2 turned the Ironworks-16 simulation from static core primitives into a living, headless factory substrate—30 new files and 6,890 insertions spanning `src/logistics/*`, `tests/T11_*..T20_*`, and `agent_notes/T11..T20.md`—landing cleanly in commit `be3ae93` with `typecheck_ok=True`, `vitest_ok=True`, and `protected_touched=[]`.

### Autonomy & Agency: Building Clean Layer Boundaries
Working across two natural dependency tiers—foundations (`T11`, `T17`, `T19`, `T20`) followed by integrators (`T12`, `T13`, `T14`, `T15`, `T18`, `T16`)—each agent exercised independent architectural judgment within its assigned module without touching protected contracts:
- **Zero-drift physics:** `T11` anchored belt motion to exact IEEE-754 powers of two (`BELT_SPEED = 0.03125` = `1/32` tile/tick, `BELT_ITEM_SPACING = 0.25` = `1/4` tile) so items never suffer floating-point drift; `T14` extended that exact arithmetic into underground transit (`32` ticks/tile, `160` ticks across the 4-tile gap / distance-5 max span, `8`-tick lane spacing); and `T15` adopted power-of-2 phase durations (`4/16/4/16` = `40` ticks/cycle) paired with a `1 - 1e-9` completion threshold so even custom non-power-of-2 timings cannot stall.
- **Topological clarity:** `T12` introduced a post-order DFS (`getBeltUpdateOrder`) seeded by ascending `EntityId` so downstream belts always step before upstream feeders—preventing single-tick double-stepping and stalls in full-but-moving lines while breaking closed belt loops deterministically.

### Stigmergic Coordination Through Contracts & Notes
Rather than duplicating logic, agents left explicit interfaces and handoff notes in `agent_notes/` that downstream tasks immediately composed with:
- **The Belt Handoff Protocol:** `T11` exposed `LaneHandoffFn` (`(itemId, lane, overflowOffset) => boolean`) and explicitly flagged `T12–T16` and `T39`. `T12`, `T13`, and `T14` all adopted this zero-loss callback contract directly. `T12` in turn recognized `underground_belt` (`mode === 'output'`) as valid adjacent feeders and exposed `externalHandoff` for splitters, underground belts, and chests.
- **Inserter-to-Filter Reuse:** `T15` designed `AnyInserterEntity` and an optional `filter?: (itemId: ItemId) => boolean` hook specifically for `T16` (plus `armAngle` for `T40`). `T16` composed its whitelist predicate with `options.filter` and delegated straight to `stepInserter` / `tickInserter`, duplicating zero state-machine or routing code. Complementing it, `T19` built Wooden (16-slot) and Iron (32-slot) chests on top of Wave 1's `T08` (`inventory.ts`) and `T06` (`itemRegistry.ts`) and exposed `extractMatchingFromChest` specifically as a whitelist helper for filter inserters.
- **Power & Research Handoffs:** `T17` built the Euclidean wire-reach (`7`) and Chebyshev supply-radius (`5`) grid via deterministic `EntityId`-ordered BFS, leaving initialized `PowerNetwork` totals (`satisfaction = 1.0`, `totalSupplyKw = 0`, `totalDemandKw = 0`) and explicit notes for `T18` and `T41`. `T18` populated satisfaction, proportional accumulator charge/discharge (`storedEnergyKj` clamped to `[0, capacityKj]`), and `powerBrownout` events while exporting `getEntityPowerSatisfaction`, `getEffectiveMachineSpeed`, and `getGlobalPowerSatisfaction` for Wave 3 machines (`T23, T25, T26, T27, T30`) and `T50` telemetry. Similarly, `T20` shaped `contributeScience` to return `{ techId, itemId, accepted, rejected, completed }` so `T30`'s `ResearchLab` consumes only `accepted` packs.

### Edge-Case Defense & Item Conservation
Every logistics agent independently enforced strict item conservation under backpressure and deterministic tie-breaking:
- **Backpressure without loss:** `T11` halts items at `1.0` and queues followers at `0.25` unless `handoff` returns `true`; `T12` resolves head-on opposing belts to `'blocked'`; `T13` alternates `nextOutputIndex` (`0`/`1`), falls back to the alternate lane when one output backs up, yet keeps `nextOutputIndex` aimed at the blocked output so it regains priority the moment it clears; and `T14` halts underground exits at `remainingTicks = 0` while queuing trailing items at `minTickSpacing`.
- **Mid-cycle resilience:** `T15` aborts cleanly to `idle` if a source empties mid-pick and freezes in `dropping` (`phaseProgress = 1`, `active = false`) with `heldItem` intact if the target is full; `T16` finishes dropping an already-held item cleanly even if its filter whitelist is edited or cleared mid-swing; `T19` preserves item counts across `transferBetweenChests` under partial or full backpressure; and `T20` returns `rejected` science counts instead of swallowing excess or mismatched packs.
- **Deterministic tie-breakers:** Across the wave, agents eliminated ordering ambiguity—`T11` breaks lane-extraction offset ties `'left'` before `'right'`, `T14` halts pairing scans at intervening same-direction/same-mode underground belts, `T16` ticks filter inserters in ascending numeric `EntityId` order, `T17` assigns power participants to the lowest-ID covering network, and `T18` sums entities in ascending `EntityId` order and solves networks in ascending `network.id` order.

### Fail-Closed Discipline
Instead of silently coercing bad state, every module was built to fail loudly on invariant violations:
- **Item & boundary validation:** `T11`, `T14`, `T16`, and `T19` validate `ItemId`s via `assertValidItemId` (`UnknownItemError`). `T11` rejects non-finite/out-of-range offsets (`false`) and throws `SimulationError` on non-positive/`NaN` speed or spacing; `T14` throws `InvalidPlacementError` on bad underground modes, rejects insertion into unpaired belts (`false`), and throws `SimulationError` on invalid pairing or transit inputs.
- **Empty-means-closed & bounds checks:** `T16` treats an empty whitelist (`filters.length === 0`) as blocking all items rather than acting as an unfiltered inserter, throws `SimulationError('FILTER_LIMIT_EXCEEDED')` above `MAX_FILTER_SLOTS = 3` unique items, and re-validates `filters` on step/tick to catch external mutation. `T18` throws `SimulationError('INVALID_POWER_VALUE')` on negative, `NaN`, or non-finite power values and returns `0.0` for uncovered machines. `T20` throws `SimulationError` on unknown tech IDs, unmet prerequisites, already-completed techs, circular dependencies, invalid science counts, or locked recipes (`assertRecipeUnlocked`).

---

## Wave 3: Machines & Recipes (T21–T35) (Commit `2f628fc`)

With world coordinates, inventories, transport logistics, power networks, and the tech tree settled in earlier waves, Wave 3 tasked fifteen autonomous agents (`T21`–`T35`) with populating the factory floor—ore deposits, drills, furnaces, assemblers, steam and solar generators, research labs, canonical recipes, and telemetry—landing 45 files and 8,751 insertions in commit `2f628fc` (`typecheck_ok=True`, `vitest_ok=True`, `protected_touched=[]`).

### Stigmergic Coordination Without a Central Conductor

The agents never negotiated in a shared chat; they coordinated through shared contracts (`src/types/contracts.ts`), upstream registries, and explicit handoff notes in `agent_notes/*.md`:

- **Deposit Primitives as a Shared Anchor (`T21` → `T22`, `T23`):** `T21` (`src/machines/resourceNode.ts`) intentionally built plain serializable helpers over `ResourceNode`, `Tile`, and `TileMap` ("zero class-prototype drift") and left explicit notes directing downstream drills (`T22`, `T23`, `T38`, `T44`) to `mineOneFromTile`, `mineOneAt`, and `mineOneFromFootprint` so exhausted patches clear `tile.resource = null` immediately. Both `T22` (`src/machines/burnerDrill.ts`) and `T23` (`src/machines/electricDrill.ts`) picked up that exact contract, checking/delivering to the front tile *before* decrementing `ResourceNode.amount`.
- **Phase-Ordered Power Composition (`T28`, `T29` → `T18`):** `T28` (`src/machines/steamPower.ts`) and `T29` (`src/machines/solarPower.ts`) each independently preserved the `power` tick-phase boundary ahead of `solvePowerGrid(world)` (`T18`). `T28` documented calling `updateSteamPower(world)` first to populate `steam_engine.currentOutputKw`, while `T29` deliberately refrained from double-charging or discharging accumulators inside `tickSolarPower(world)` so accumulator balancing remained cleanly isolated in `solvePowerGrid`.
- **1:1 Tech-Tree & Machine-Tier Alignment (`T31`–`T34` ↔ `T20`, `T24`–`T27`):** Without cross-talk, all four recipe modules aligned `requiredTech` directly to `CANONICAL_TECH_DEFINITIONS` (`T20`): `steel_plate` (`steel_processing`, `T31`), `electronic_circuit` (`automation`, `T32`), `inserter` (`automation`, `T33`), `power_pole` (`solar_energy`, `T33`), and `green_science` (`logistics`, `T34`). Ingredient counts cleanly respected the Mk1 (`<= 2`) vs. Mk2 (`<= 4`) assembler split—leaving `inserter` (3 ingredients) exclusive to `assembler_mk2` (`T27`) while keeping `iron_gear`, `copper_cable`, `electronic_circuit`, `transport_belt`, `power_pole`, `red_science`, and `green_science` Mk1-compatible (`T26`).
- **Event-Driven Telemetry (`T35`):** `T35` (`src/machines/statsTracker.ts`) hooked directly into the shared `EventBus` (`itemProduced`) emitted by drills (`T22`, `T23`), furnaces (`T24`, `T25`), and assemblers (`T26`, `T27`), exposing `syncToWorld(world)` for the `'stats'` tick phase and `hydrateFromStats` for post-serialization recovery.

### Agency & Architectural Judgment in Parallel

Operating in parallel, agents made distinct, locally optimal design choices while converging on deterministic behavior:

- **Parallel Drill Strategies (`T22` vs. `T23`):** `T22` reused `dropIntoEntity` and non-mutating `canDropIntoEntity` from `src/logistics/inserter.ts` (handling belt right-lane priority with left-lane fallback at offset `0.5` and auto-routing coal to furnace `fuelInventory`). `T23` implemented `tryDeliverOreToFrontTile` (with an injectable `tryDropItem` hook in `ElectricDrillTickContext`) supporting belts, splitters, chests, furnaces, assemblers, burner drills, and boilers, scaling its 45-tick cycle via `T18`'s `getEntityPowerSatisfaction` and `scaleMachineSpeed` (e.g., 90 ticks at 50% brownout).
- **Two Conservation Paths Under Serialization Constraints (`T24`–`T27`):** Because `AssemblerEntity` carries no hidden `inProgress` buffer, `T26` (`assemblerMk1.ts`) and `T27` (`assemblerMk2.ts`)—alongside `T24` (`stoneFurnace.ts`)—keep ingredients in `inputInventory` and execute `consumeIngredients` + `insertItem` atomically on craft completion (`craftingProgress + 1e-9 >= recipe.craftingTicks` in `T26`), ensuring recipe switches or blackouts never destroy or duplicate items. Taking an alternative valid path, `T25` (`electricFurnace.ts`) consumes inputs atomically at craft start only when output has room, then clamps `craftingProgress` at `recipe.craftingTicks` (`output_full`) if the output fills mid-craft.
- **Deterministic Iteration & Precision (`T22`–`T30`, `T35`):** Every multi-entity tick updater (`T22`–`T30`) sorted iteration by ascending `EntityId` (`T28` also sorted adjacent boiler lookups orthogonally at `|dx| + |dy| === 1`, and `T30` consumed multi-pack research costs in `TechDefinition.cost` order). `T22` chose `BURNER_DRILL_FUEL_BURN_KJ_PER_TICK = 2.5` for exact IEEE-754 representation at 60 TPS; `T29` structured a 3,600-tick piecewise-linear solar curve averaging `0.6` (`36 kW` per `60 kW` panel); and `T35` built a per-item coalesced tick deque with amortized O(1) compaction (`head > 256 && head * 2 >= length`) for exact integer 3,600-tick sums with zero floating-point drift and canonical `ALL_ITEM_IDS` key ordering.

### Edge-Case Defense

Across the wave, agents anticipated subtle factory failure modes before tests forced their hand:

- **Input Slot Starvation Guard (`T26`):** `setAssemblerMk1Recipe` defaults to `applyInputFilters: true`, placing per-slot item filters on empty input slots matching `recipe.ingredients[i].itemId` so inserters cannot fill both slots with a single ingredient and deadlock crafting.
- **Zero-Waste Clean Halts (`T22`, `T24`, `T28`, `T30`):** `T22` and `T24` burn `0` kJ and set `active = false` whenever blocked (`no_resource`, `output_blocked`, `no_input`, `no_recipe`, `recipe_locked`, `insufficient_ingredients`, `output_full`), preserving partial `miningProgress` or `craftingProgress` across out-of-fuel pauses. `T28` halts boiler coal consumption (`4000 kJ`) as soon as `steamBuffer` hits `100`. `T30` removes only `result.accepted` packs after `techTree.contributeScience(...)`, leaving surplus or unneeded science packs intact when a technology finishes.
- **Null-Safe Depletion & Clamped Backpressure (`T21`, `T23`, `T25`):** `T21`'s `isDepleted`, `getRemainingAmount`, and `getRemainingRatio` are null-safe and never return `NaN`, while `mineOne` stops cleanly at `0`. `T23` clamps `miningProgress` at `45` while `output_blocked`, delivering on the very next powered tick once downstream space clears.

### Fail-Closed Discipline

Every module enforced strict boundary checks rather than silently coercing bad state:

- **Typed Rejection of Invalid Inputs & States:** `T22`, `T24`, and `T28` throw `SimulationError('INVALID_FUEL_ITEM')` on non-fuel items; `T30` throws `INVALID_SCIENCE_PACK` on non-science items; `T21` validates positive integers and `ResourceType` plus full footprint bounds before mutating; `T23`, `T25`, `T28`, `T29`, and `T35` throw `SimulationError` or `OutOfBoundsError` on negative, `NaN`, or non-finite power/progress/tick values; and `T35` validates every item ID via `assertValidItemId` (`UnknownItemError`).
- **Strict Recipe & Research Gating:** `T26` and `T27` reject unknown recipes (`UnknownRecipeError`), wrong-category recipes (`INVALID_RECIPE_CATEGORY`), excess-ingredient recipes (`TOO_MANY_INGREDIENTS`), locked technologies (`RECIPE_LOCKED` on set / `recipe_locked` on tick), and invalid power satisfaction (`INVALID_POWER_SATISFACTION`). `T25` throws `UnknownRecipeError` on unregistered `activeRecipe` and `SimulationError` on non-smelting recipes.
- **Frozen, Atomic Recipe Registration (`T31`–`T34`):** All four recipe suites deeply freeze every exported recipe and array via `Object.freeze` and register them through `registry.registerMany(...)` so any duplicate or schema error fails atomically without half-registered state.

---

## Wave 4: 16-Bit Renderer & UI (T36–T46) (Commit `2e557fd`)

In Wave 4, eleven autonomous agents materialized the visual and interactive surface of Ironworks-16—spanning `src/render/spriteAtlas.ts` through `src/render/minimap.ts` and `src/ui/hotbar.ts` through `src/ui/productionGraph.ts`—landing **33 files and 10,480 insertions** in commit `2e557fd` (`typecheck_ok=True`, `vitest_ok=True`, `protected_touched=[]`). Across 11 implementation modules, 11 Vitest suites (`tests/T36_spriteAtlas.test.ts`–`tests/T46_minimap.test.ts`), and 11 `agent_notes/`, the wave operated without a live browser or central UI loop, yet produced a cohesive, deterministic 16-bit Canvas2D pipeline.

### Autonomy & Agency: Headless-First, Deterministic by Default
Operating independently on isolated rendering and HUD slices, the Wave 4 agents converged on a shared architectural discipline without top-down micromanagement:
- **Dual Pure/Stateful APIs & Zero DOM Coupling:** `T37` (`camera.ts`), `T38` (`terrainLayer.ts`), `T40` (`entityLayer.ts`), `T41` (`powerOverlay.ts`), `T42` (`ghostPreview.ts`), `T43` (`hotbar.ts`), `T44` (`inspector.ts`), `T45` (`productionGraph.ts`), and `T46` (`minimap.ts`) kept core logic free of DOM/Window imports. Where Canvas drawing was needed, agents defined structural context interfaces (`PowerOverlayContext`, `HotbarCanvasContext`, `ProductionGraphCanvasContext`, `MinimapCanvasContext`) or dual paths: `T36` (`spriteAtlas.ts`) lazily caches `16×16` `HTMLCanvasElement`s when `document.createElement` exists and falls back to `ctx.fillRect()` per non-transparent pixel in headless Node/Vitest.
- **Tick-Driven Determinism:** Every agent eliminated wall-clock and PRNG variance (zero `Date.now()` or `Math.random()` calls). `T36` synthesizes `1024`-byte RGBA `Uint8ClampedArray` sprites via ASCII patterns and exact `90°` rotations (`rotateBufferCW`) verifiable with an FNV-1a checksum (`hashSpritePixels()`). `T39` (`beltLayer.ts`) locks belt chevron animation (`DEFAULT_BELT_TICKS_PER_FRAME = 8`) to `BELT_ITEM_SPACING / BELT_SPEED = 0.25 / 0.03125 = 8` ticks/frame (`32` ticks per tile). `T40` drives furnace glow alpha (`[0.2, 0.5]`) via `computeFurnaceGlowAlpha(world.tick, entity.id)`, `T41` pulses unpowered warning icons on a `48`-tick triangle wave (`[0.55, 1.0]`), `T43` (`FpsCounter`) accepts explicit `frameDeltaMs`, and `T45` throttles sparkline sampling strictly by simulation `tick` (`DEFAULT_SAMPLE_INTERVAL_TICKS = 60`, `DEFAULT_MAX_SAMPLES = 60`).

### Stigmergic Coordination: Contracts, Splits, and Downstream Handoffs
Rather than duplicating geometry or colliding on entity ownership, agents coordinated through shared types (`src/types/contracts.ts`), earlier-wave primitives, and explicit handoff notes in `agent_notes/*.md`:
- **Sprite-to-Layer Contracts (`T36` → `T38`, `T39`, `T40`, `T42`):** `T36` covered all 5 terrain types, 4 ores, 21 `ItemId`s, 48 animated belt variants (`straight`, `curve_left`, `curve_right` × 4 directions × 4 frames), and 19 `EntityType`s (plus `:active` variants), and deliberately split inserters into `inserter:basic|filter:base|arm` so `T40` could rotate the arm independently. `T40` picked up that split verbatim, adding `entity.armAngle + Math.PI / 2` to align `T36`'s North-pointing arm sprite with `T15`'s `E=0, S=π/2, W=π, N=-π/2` convention, and skipped `transport_belt` by default (`skipTransportBelts: true`) in deference to `T39`—while exposing `skipAllBeltLogistics: true` in case `T39` renders `splitter` and `underground_belt` as well.
- **Shared Culling & Grid Plumbing (`T37`, `T17`, `T18`):** `T38`, `T39`, `T40`, `T41`, and `T42` all anchored viewport culling and screen/tile transforms on `T37`'s `getVisibleTileBounds`, `tileToScreen`, `screenToTile`, `isTileVisible`, and `isFootprintVisible`. `T41` wired directly into `getWireConnections` (`T17`) and `isPowerConsumer` / `getEntityPowerSatisfaction` (`T18`), surfacing `unconnected`, `blackout`, and `brownout` states.
- **Wave 5 Readiness (`T47`, `T50`):** Agents proactively designed clean integration seams for the upcoming input controller (`T47`) and main loop (`T50`): `T41` left `powerOverlay.toggle()` for `P` plus standalone `drawUnpoweredWarnings`; `T42` provided `GhostPreviewController.rotate()` for `R`; `T43`'s `Hotbar.handleKeyDown` returns `false` on non-hotbar keys for composable dispatch; `T44` exposed `selectEntityAtTile` and `inspectSelectedEntity`; `T45` documented `graph.sampleFromWorld(world)` after `statsTracker.syncToWorld(world)`; and `T46` exported `minimapPointToWorld` for click-to-pan navigation.

### Edge-Case Defense: Seams, Overlaps, and Zero/NaN Hazards
Wave 4's notes record extensive proactive defense against rendering artifacts and numeric degeneracies:
- **Zero-Seam Pixel Geometry & Two-Pass Layering:** `T37` used `Math.floor(topLeft)` and `Math.ceil(bottomRight) - 1` to avoid over-fetching exact integer edge tiles and returned inverted bounds (`minTileX: 0, maxTileX: -1`) when off-map so inclusive loops execute zero times. `T38` snapped destination rectangles (`dx = Math.floor(rawX)`, `dw = Math.floor(rawX + zoom) - dx`) to eliminate subpixel seams, and `T46` merged horizontal color runs row-by-row across `Math.floor`/`Math.ceil` boundaries (handling fractional scales like `160 / 64 = 2.5` px/tile) while clamping `computeCameraViewportBox` to `[0, world.width] × [0, world.height]`. `T39` and `T40` both sorted entities deterministically by `(position.y, position.x, id)` and used two-pass rendering—belts/hoods before lane items (`T39`, with quarter-circle curved arcs eliminating corner seams) and machines before rotating inserter arms (`T40`).
- **Partial Footprints, Depletion, and Degenerate Ratios:** `T42` evaluated `splitter` (`2×1`) footprints tile-by-tile so partially blocked placements tint valid tiles green and blocked tiles red while marking `preview.valid = false`, and guarded Canvas state with `ctx.save()` / `try ... finally { ctx.restore(); }`. `T36` normalized negative belt frames modulo `4`; `T38` and `T46` skipped or fell back on depleted ores (`amount <= 0`); `T43` ignored `<= 0`, `NaN`, and `Infinity` frame deltas; `T44` clamped all progress/fuel/power ratios to `[0, 1]`; and `T45` auto-scaled sparklines with `max(1, peak)` so all-zero and single-point series render without `NaN`.

### Fail-Closed Discipline
Rather than silently swallowing bad inputs or corrupting render state, every Wave 4 module enforced strict preconditions:
- `T36` throws `UnknownSpriteError` (subclass of `SimulationError`) on missing keys, instructing callers to check `hasSprite()` for optional `:active` states.
- `T37` throws `CameraError` on non-finite coordinates, non-positive `zoom`/`factor`/`viewport`/`worldBounds`, `minZoom > maxZoom`, or negative `paddingTiles`; `T38` throws `TerrainRenderError` on invalid world dimensions or mismatched `world.tiles.length` (while propagating `CameraError` and `UnknownSpriteError`).
- `T39` throws `SimulationError` on negative/non-finite `world.tick` or non-positive `ticksPerFrame`/`itemScale`; `T40` throws `EntityLayerError` on non-finite `world.tick` or inserter `armAngle`.
- `T42` throws `InvalidPlacementError` on unknown `EntityType`, invalid `Direction`, or non-integer coordinates, evaluating blockers in strict precedence (`'out_of_bounds' -> 'water' -> 'occupied' -> 'requires_ore'`).
- `T43` throws `SimulationError` (`INVALID_HOTBAR_KEY`, `DUPLICATE_HOTBAR_KEY`, `INVALID_FPS_WINDOW`); `T44` fails closed to `null` on out-of-bounds, empty, or destroyed targets; `T45` validates `ItemId`s (`assertValidItemId`), monotonic non-negative integer ticks, finite rates, and positive bounds before mutating any series; and `T46` throws `MinimapError` on invalid viewport, size, margin, camera, or tile array length.

Together, Wave 4 turned headless simulation state into a fully tested, seam-free 16-bit renderer and HUD suite—verified with zero type errors, full Vitest passage, and zero protected files touched.

---


## Chapter 5: Wave 5 - Integration & The Autonomous Showcase (T47–T50)

### Stigmergic Convergence & Cross-Wave Harmony
In Wave 5, the autonomous agents achieved full system synthesis, binding all lower-level simulation mechanics, logistics networks, procedural pixel-art assets, and HUD components into an interactive, self-running factory engine (`Ironworks-16`):
- **Universal Input Control (`T47`):** Agent `T47` built `src/app/inputController.ts`, closing the loop on the design seeds planted in Wave 4:
  - Consumed `Camera.pan` and `Camera.zoomAt` (`T37`) with normalized diagonal velocity ($1/\sqrt{2}$) and cursor-anchored scaling.
  - Linked `GhostPreviewController.rotate` (`T42`) to `R` / `Shift+R` (clockwise/counter-clockwise).
  - Integrated `PowerOverlay.toggle` (`T41`) directly to `P`.
  - Linked `Hotbar.handleKeyDown` and `hitTestHotbar` (`T43`) with `selectSlot` and `Escape`/`0` clearing, automatically synchronizing ghost placement preview.
  - Executed left-click dispatch (hotbar hit-test -> placement via `evaluateGhostPlacement` -> inspection via `selectEntityAtTile`) and right-click deletion (clearing full multi-tile footprints and firing `entityRemoved` on `EventBus`).
  - Utilized pure structural event target interfaces (`MinimalCanvasElement`, `MinimalKeyboardEvent`, `MinimalPointerEvent`, `MinimalWheelEvent`) guaranteeing that input handling could be thoroughly verified in headless Vitest without requiring DOM globals.
- **Showcase Factory Blueprint & Execution Harness (`T48`):** Agent `T48` designed `src/app/showcaseFactory.ts`, assembling a self-starting, fully automated production chain targeting seed `1616`:
  - Positioned coal-fed Boiler + Steam Engine (`T28`) supplying 900 kW electrical power, interconnected across power poles (`T17`) to all consumers.
  - Deployed electric mining drills (`T23`) directly over guaranteed iron and copper patches discovered via `generateMap` (`T09`).
  - Routed mined ores into electric smelting furnaces (`T25`), intermediate gear assemblers (`T26`), and automation science assemblers (`T26`), automated through inserters (`T15`) and container buffers (`T19`).
  - Encapsulated the fixed-timestep simulation phases (`T03`) into `createShowcaseHarness(seed)`, coordinating power -> mining -> smelting/assembling -> inserters -> belts -> stats with zero floating-point accumulation drift.
- **Headless 1,000-Tick E2E Verification & Determinism Oracle (`T49`):** Agent `T49` verified Milestone M4 in `tests/T49_e2e_factory.test.ts`:
  - Verified continuous autonomous operation for 1,000 headless ticks.
  - Verified `redScienceProduced >= 1`.
  - Verified electrical network stability with `powerSatisfaction > 0.9` throughout the run.
  - Verified zero `NaN` values across all numeric telemetry metrics.
  - Verified bit-for-bit canonical serialization equivalence across independent runs (`sha256(serializeWorldState(run1)) === sha256(serializeWorldState(run2))`).
- **Application Bootstrap & Window Test Hooks (`T50`):** Agent `T50` created `src/app/main.ts`, wiring the browser Canvas 2D render loop, input controller, and test hooks:
  - Mounted layered Canvas rendering: background -> terrain/ores (`T38`) -> animated belts & items (`T39`) -> entities & inserter arms (`T40`) -> power overlay (`T41`) -> ghost preview (`T42`) -> minimap (`T46`) -> production sparkline (`T45`) -> hotbar & tick/FPS readout (`T43`) -> clicked entity inspector (`T44`).
  - Auto-detected `?showcase=1` query parameter to load the deterministic factory blueprint.
  - Exposed mandatory headless oracle hooks on `window`:
    - `window.__STEP_TICKS__(n)`
    - `window.__FACTORY_TELEMETRY__()`
    - `window.__SERIALIZE_STATE__()`
    - `window.__INJECT_FAULT__(fault)` handling `'blackout'` and `'corrupt_save'`.

### Agency, Resilience & Invariant Ratification
Wave 5 demonstrated the culmination of stigmergic autonomy and strict invariant adherence:
- **Zero Protected File Violations:** Throughout the 50 tasks, no protected files (`SPEC.md`, `package.json`, `tsconfig.json`, `RUN_MANIFEST.json`, `oracle/capture.ts`) were mutated.
- **Complete Test Suite Passage:** All 50 test files and 426 vitest unit and integration tests passed cleanly.
- **Fail-Closed Resilience:** When subjected to fault injection probes, corrupted save JSON is explicitly caught by typed `DeserializationError` without state corruption, and electrical blackout gracefully drops satisfaction to `0.0` with zero unhandled exceptions and zero `NaN` values.

---
