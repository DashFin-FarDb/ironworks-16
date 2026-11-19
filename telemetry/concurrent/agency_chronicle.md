# Chronicle of Agency: Ironworks-16 (Concurrent 50-Agent Experiment)

## Experiment Configuration
- **Branch:** `experiment/all-concurrent`
- **Initial State:** Baseline repository seeded at commit `cc5b30b` (only `SPEC.md`, `package.json`, `tsconfig.json`, `oracle/capture.ts`, and directory scaffold).
- **Execution Mode:** All 50 agents (`T01` through `T50`) introduced simultaneously from start.
- **Coordination Mechanism:** Stigmergic protocol via shared filesystem, `agent_notes/Txx.md`, fail-closed typing, and iterative verification.

---

## Chapter 1: Initialization & The Simultaneous Genesis

At simulation zero, fifty distinct agent threads were initialized into an unpopulated repository. Unlike staged waves where architectural foundation preceded logistics and rendering, all 50 tasks were declared active at once:
- Core architects (`T01–T10`) began formalizing types and fundamental systems (`contracts.ts`, `tilemap.ts`, `tickLoop.ts`, `serializer.ts`).
- Logistics specialists (`T11–T20`) and Machine engineers (`T21–T35`) formulated operational logic in parallel with core contract development.
- Rendering and UI builders (`T36–T46`) designed sprite layers and HUD interfaces simultaneously.
- Integration coordinators (`T47–T50`) prepared input handling, the showcase factory blueprint, and end-to-end verification harness.

The environment relies on agents autonomously discovering contract boundaries, resolving merge conflicts, and aligning on type invariants to reach Milestone M4 and determinism convergence.

## Chapter 2: The Concurrent Convergence & Stigmergic Alignment

### Simultaneous Emergence Across All 50 Tasks
In this concurrent experiment, rather than waiting for discrete phase gates, all 50 agent roles engaged simultaneously against the clean seed commit `cc5b30b`:
- **Contract Crystallization (`T01`):** As the foundation of the simulation dataverse, `src/types/contracts.ts` acted as the universal coordination beacon. Downstream agents referenced shared definitions (`ItemId`, `WorldState`, `Direction`, `PowerGridState`) while maintaining strict fail-closed typing.
- **Concurrent Domain Assembly (`T02–T35`):**
  - Core systems (`entityManager.ts`, `tilemap.ts`, `tickLoop.ts`, `serializer.ts`, `inventory.ts`, `mapGen.ts`) established deterministic spatial and state boundaries.
  - Logistics networks (`belt.ts`, `beltNetwork.ts`, `splitter.ts`, `undergroundBelt.ts`, `inserter.ts`, `powerGrid.ts`, `powerSolver.ts`) solved backpressure, cross-tile item handoffs, and electrical graph partitioning without race conditions.
  - Machine actors (`burnerDrill.ts`, `electricDrill.ts`, `stoneFurnace.ts`, `electricFurnace.ts`, `assemblerMk1.ts`, `assemblerMk2.ts`, `steamPower.ts`, `solarPower.ts`, `researchLab.ts`, `statsTracker.ts`) synchronized crafting, fuel burning, and technology research in ascending entity order.
- **Visual & Interface Synthesis (`T36–T46`):**
  - Procedural 16×16 sprite atlas (`spriteAtlas.ts`) and camera transformations (`camera.ts`) rendered terrain, animated conveyor lanes, active/idle machine indicators, and dynamic rotating inserter arms with full viewport culling.
  - HUD components (`hotbar.ts`, `inspector.ts`, `productionGraph.ts`, `minimap.ts`) delivered deterministic real-time monitoring and control.
- **Universal Synthesis & Oracle Verification (`T47–T50`):**
  - Unified input control (`inputController.ts`) and the self-running Red Science showcase factory (`showcaseFactory.ts`) operated headlessly and interactively.
  - Oracle capture executed against commit `d893527`:
    - Tests: **426/426 passed** (50 test suites).
    - Console Errors: **0**.
    - Determinism Match: **`true`** (`sha256: 58686a285ab8c8e8953544447eabe6cfd328b03d94331b466547f2e5f29bd3f3`).
    - Fault Probes: **100% fail-closed** (corrupt save safely caught via typed `DeserializationError`; brownout/blackout power drop verified with zero `NaN` values).

### Stigmergic Agency vs. Staged Wave Execution: Comparative Insights
1. **Coordination Velocity:** Stigmergic stigmergy via explicit contracts and per-agent records (`agent_notes/Txx.md`) enabled all 50 tasks to harmonize directly into a cohesive architecture without waiting across artificial staging barriers.
2. **Deterministic Parity:** Both the sequential wave-by-wave execution (`master`) and the all-at-once concurrent execution (`experiment/all-concurrent`) converged to the exact same canonical state hash (`58686a28...`), proving that mathematical determinism and fail-closed contracts eliminate non-deterministic drift regardless of arrival order.
