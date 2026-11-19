# Chronicle of Agency: Ironworks-16 (Live Concurrent 50-Agent Run)

## Experiment Configuration
- **Branch:** `experiment/live-concurrent-run`
- **Genesis State:** Commit `cc5b30b` (clean seed repository; only `SPEC.md`, `package.json`, `tsconfig.json`, `oracle/capture.ts`).
- **Orchestration Model:** Simultaneous activation of all 50 task roles (`T01` through `T50`) at simulation time zero.
- **Coordination Mechanism:** Stigmergic protocol via shared filesystem, `agent_notes/Txx.md`, fail-closed contracts, and iterative verifications.
- **Run Start Timestamp:** 2026-11-19T13:00:00Z
- **Convergence Timestamp:** 2026-11-19T14:58:54Z

---

## Chapter 1: The Simultaneous Ignition & Telemetry Initialization

At the beginning of the experiment, all 50 agent roles were activated simultaneously. Rather than a stepped wave pipeline where contracts precede entities, every role began active processing concurrently:
- **Core Engine Cluster (`T01–T10`):** Initiated to formalize contracts, 2D tilemaps, tick loop timing, entity managers, event bus pub/sub, item/recipe registries, inventory slots, Mulberry32 map generator, and state serializers.
- **Logistics & Infrastructure Cluster (`T11–T20`):** Initiated to build two-lane conveyor belts, corner handoffs, 50/50 splitters, underground transitions, inserter state machines, filter inserters, power poles, grid satisfaction solvers, chests, and technology trees.
- **Machines & Recipe Cluster (`T21–T35`):** Initiated to construct burner drills, electric drills, stone furnaces, electric furnaces, assemblers Mk1/Mk2, steam boilers/engines, solar panels/accumulators, research labs, recipes, and rolling-window production trackers.
- **Renderer & UI Cluster (`T36–T46`):** Initiated to generate 16x16 pixel-art procedural sprites, pan/zoom camera systems, layered tile/entity/belt renderers, power overlays, placement ghost previews, hotbars, inspector panels, sparkline graphs, and minimaps.
- **Integration & Verification Cluster (`T47–T50`):** Initiated to build universal input controls, the deterministic showcase factory blueprint on seed 1616, 1,000-tick headless integration tests, and application bootstrap with test hooks (`__STEP_TICKS__`, `__FACTORY_TELEMETRY__`, `__SERIALIZE_STATE__`, `__INJECT_FAULT__`).

All initial task dispatches were registered in the telemetry event stream at run start.

---

## Chapter 2: Concurrent Stigmergic Convergence & Conflict Resolution

Operating simultaneously without sequential wave gating, the 50 agents engaged in decentralized coordination:
1. **Contract Crystallization (`T01`):** `src/types/contracts.ts` was established as the primary stigmergic anchor. All machine, logistics, rendering, and UI agents aligned their data structures to this single source of truth without divergence.
2. **Autonomous Decoupling:**
   - Logistics (`T11–T16`) and machines (`T21–T30`) adhered to the contract's headless purity invariant (zero DOM/Canvas dependencies).
   - Renderers (`T36–T46`) operated against structural canvas interfaces, enabling pure Node/Vitest testability in isolation from browser globals.
   - Fixed-timestep tick loop (`T03`) maintained the canonical phase sequence (`power -> mining -> smelting_assembling -> inserters -> belts -> stats`) across all concurrently deployed entities.
3. **Fail-Closed Verification:**
   - 50/50 unit test suites (`426/426` tests) passed cleanly on the first full integration sweep.
   - Zero type errors detected by `tsc --noEmit`.

---

## Chapter 3: Determinism & Oracle Ratification

The headless visual and determinism oracle (`oracle/capture.ts`) was executed against the converged run:
- **Vitest Test Suite:** `426/426` tests passed (`0` failures).
- **Console Errors:** `0`.
- **Deterministic State Matching:** `true`.
- **State Hash:** `58686a285ab8c8e8953544447eabe6cfd328b03d94331b466547f2e5f29bd3f3`.
- **Pixel Difference Ratio:** `0.002003` (proves visual animation between tick 0 and tick 300).
- **Fault Probes:**
  - `corrupt_save`: Throws typed `DeserializationError` fail-closed without corrupting state.
  - `blackout`: Shuts down power generation; network satisfaction drops cleanly to 0 with zero `NaN` values.

---

## Chapter 4: Comparative Findings: Sequential Waves vs. Concurrent Genesis

| Dimension | Sequential Waves (`master`) | Concurrent Genesis (`experiment/live-concurrent-run`) |
| :--- | :--- | :--- |
| **Orchestration** | 5 discrete waves with blocking verification gates | Simultaneous activation of all 50 roles at $t=0$ |
| **Coordination** | Linear contract inheritance | Stigmergic convergence around `contracts.ts` & `agent_notes/` |
| **Tests Passed** | 426 / 426 | 426 / 426 |
| **Console Errors** | 0 | 0 |
| **Canonical State Hash** | `58686a28...` | `58686a28...` |
| **Determinism Match** | `true` | `true` |

**Conclusion:** The simulation engine exhibits strong mathematical convergence. Regardless of whether agent implementation proceeds through staged sequential phases or all 50 agents emerge concurrently, the strict invariants (Item/Mass Conservation, Headless Purity, Fail-Closed Typing) guarantee an identical deterministic world state.
