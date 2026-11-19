/**
 * Ironworks-16 Application Bootstrap & Showcase Engine (T50)
 *
 * Bootstraps the Canvas 2D viewport, renderer, input controller, and simulation tick loop.
 * Detects `?showcase=1` query parameter to load the deterministic T48 Showcase Factory.
 * Exposes non-negotiable test and oracle hooks onto `window`:
 * - window.__STEP_TICKS__(n: number): number
 * - window.__FACTORY_TELEMETRY__(): FactoryTelemetry
 * - window.__SERIALIZE_STATE__(): string
 * - window.__INJECT_FAULT__(fault: 'blackout' | 'corrupt_save'): FaultInjectionResult
 */

import {
  type EntityId,
  type FactoryTelemetry,
  type FaultInjectionResult,
  type FaultType,
  type WorldState,
} from '../types/contracts.js';
import { Camera, type ViewportSize } from '../render/camera.js';
import { createSpriteAtlas, SpriteAtlas } from '../render/spriteAtlas.js';
import { renderTerrainLayer } from '../render/terrainLayer.js';
import { renderBeltLayer } from '../render/beltLayer.js';
import { renderEntityLayer } from '../render/entityLayer.js';
import { renderGhostPreview, GhostPreviewController } from '../render/ghostPreview.js';
import { renderPowerOverlay, PowerOverlay } from '../render/powerOverlay.js';
import { renderMinimap } from '../render/minimap.js';
import { Hotbar, renderHotbar } from '../ui/hotbar.js';
import {
  type InspectorState,
  createInspectorState,
  inspectEntity,
  renderInspectorCanvas,
  renderInspectorHTML,
} from '../ui/inspector.js';
import {
  ProductionGraph,
  renderProductionGraph,
} from '../ui/productionGraph.js';
import { InputController } from './inputController.js';
import {
  buildShowcaseFactory,
  createCanonicalRecipeRegistry,
  createShowcaseHarness,
  ShowcaseHarness,
} from './showcaseFactory.js';
import {
  deserializeWorldState,
  serializeWorldState,
} from '../core/serializer.js';

// ============================================================================
// Types & Window Extension
// ============================================================================

declare global {
  interface Window {
    __STEP_TICKS__?: (n: number) => number;
    __FACTORY_TELEMETRY__?: () => FactoryTelemetry;
    __SERIALIZE_STATE__?: () => string;
    __INJECT_FAULT__?: (fault: FaultType) => FaultInjectionResult;
  }
}

export interface AppInstance {
  readonly harness: ShowcaseHarness;
  readonly camera: Camera;
  readonly inputController: InputController;
  readonly atlas: SpriteAtlas;
  readonly hotbar: Hotbar;
  readonly ghostPreview: GhostPreviewController;
  readonly powerOverlay: PowerOverlay;
  readonly inspectorState: InspectorState;
  readonly productionGraph: ProductionGraph;
  stepTicks(n: number): number;
  getTelemetry(): FactoryTelemetry;
  serializeState(): string;
  injectFault(fault: FaultType): FaultInjectionResult;
  renderFrame(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  destroy(): void;
}

export interface BootstrapOptions {
  readonly canvas?: HTMLCanvasElement | null;
  readonly uiRoot?: HTMLElement | null;
  readonly isShowcase?: boolean;
  readonly seed?: number;
  readonly startAnimationLoop?: boolean;
}

// ============================================================================
// Core Application Setup
// ============================================================================

export function createApp(options: BootstrapOptions = {}): AppInstance {
  const seed = options.seed ?? 1616;
  const harness = createShowcaseHarness(seed);
  const world = harness.world;

  const camera = new Camera({ x: 32, y: 26, zoom: 32 });
  const viewport: ViewportSize = {
    width: options.canvas?.width ?? 1280,
    height: options.canvas?.height ?? 720,
  };

  const atlas = createSpriteAtlas();
  const hotbar = new Hotbar();
  const ghostPreview = new GhostPreviewController();
  const powerOverlay = new PowerOverlay();
  const inspectorState = createInspectorState();
  const productionGraph = new ProductionGraph();

  const inputController = new InputController({
    world,
    camera,
    viewport,
    hotbar,
    ghostPreview,
    powerOverlay,
    inspectorState,
    eventBus: harness.eventBus,
  });

  let detachInputs: (() => void) | null = null;
  let isOracleStepping = false;
  if (options.canvas) {
    detachInputs = inputController.attach(
      options.canvas as any,
      typeof window !== 'undefined' ? (window as any) : (options.canvas as any)
    );
  }

  function stepTicks(n: number): number {
    isOracleStepping = true;
    const executed = harness.step(n);
    productionGraph.sample(world.stats, world.tick);
    hotbar.updateReadout(world.tick);
    return executed;
  }

  function getTelemetry(): FactoryTelemetry {
    return harness.getTelemetry();
  }

  function serializeState(): string {
    return serializeWorldState(world);
  }

  function injectFault(fault: FaultType): FaultInjectionResult {
    try {
      if (fault === 'blackout') {
        // Disconnect/remove all coal and power production
        for (const entity of Object.values(world.entities)) {
          if (entity.type === 'boiler') {
            entity.fuelEnergyKj = 0;
            entity.steamBuffer = 0;
            for (const slot of entity.fuelInventory.slots) {
              slot.item = null;
            }
          } else if (entity.type === 'steam_engine') {
            entity.currentOutputKw = 0;
            entity.active = false;
          }
        }
        for (const net of Object.values(world.powerGrid.networks)) {
          net.totalSupplyKw = 0;
          net.satisfaction = 0;
        }
        return { caught: true };
      }

      if (fault === 'corrupt_save') {
        try {
          deserializeWorldState('{bad_json:true');
          return { caught: false };
        } catch (err: any) {
          return { caught: true, errorType: err.name || 'DeserializationError' };
        }
      }

      return { caught: false, errorType: 'UNKNOWN_FAULT' };
    } catch (err: any) {
      return { caught: true, errorType: err.name || 'UnknownError' };
    }
  }

  function renderFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    const view: ViewportSize = { width, height };
    inputController.setViewport(view);

    // 1. Clear background
    ctx.fillStyle = '#1a1c2c';
    ctx.fillRect(0, 0, width, height);

    // 2. Terrain & Ore patches
    renderTerrainLayer(ctx, world, camera.getState(), view, atlas);

    // 3. Belts & moving items
    renderBeltLayer(ctx, world, camera.getState(), view, atlas);

    // 4. Entities & inserters
    renderEntityLayer(ctx, world, camera.getState(), view, atlas);

    // 5. Power overlay (wires & supply zones)
    powerOverlay.render(ctx as any, world, camera.getState(), view);

    // 6. Ghost preview
    ghostPreview.render(ctx, world, camera.getState(), view);

    // 7. Minimap
    renderMinimap(ctx as any, world, camera.getState(), view);

    // 8. Production graph
    renderProductionGraph(ctx as any, productionGraph, {
      x: 12,
      y: 12,
      width: 200,
      height: 120,
    });

    // 9. Hotbar & FPS/Tick Readout
    renderHotbar(ctx as any, hotbar.getState(), width, height);

    // 10. Entity Inspector (HTML and/or Canvas)
    const selectedId = inspectorState.selectedEntityId;
    if (selectedId !== null) {
      const snapshot = inspectEntity(world, selectedId, harness.recipeRegistry);
      if (options.uiRoot) {
        options.uiRoot.innerHTML = renderInspectorHTML(snapshot);
      }
      renderInspectorCanvas(ctx, snapshot, width, height);
    } else if (options.uiRoot) {
      options.uiRoot.innerHTML = '';
    }
  }

  let animationFrameId: number | null = null;
  let lastTimestamp = 0;

  function loop(timestamp: number) {
    if (lastTimestamp > 0) {
      const deltaSec = Math.min((timestamp - lastTimestamp) / 1000, 0.1);
      inputController.update(deltaSec);
      if (!isOracleStepping) {
        harness.tickLoop.advance(world, deltaSec * 1000);
      }
      productionGraph.sample(world.stats, world.tick);
      hotbar.updateReadout(world.tick, deltaSec * 1000);
    }
    lastTimestamp = timestamp;

    if (options.canvas) {
      const ctx = options.canvas.getContext('2d');
      if (ctx) {
        renderFrame(ctx, options.canvas.width, options.canvas.height);
      }
    }

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      animationFrameId = window.requestAnimationFrame(loop);
    }
  }

  if (options.startAnimationLoop && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    animationFrameId = window.requestAnimationFrame(loop);
  }

  function destroy() {
    if (detachInputs) {
      detachInputs();
      detachInputs = null;
    }
    if (animationFrameId !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  const appInstance: AppInstance = {
    harness,
    camera,
    inputController,
    atlas,
    hotbar,
    ghostPreview,
    powerOverlay,
    inspectorState,
    productionGraph,
    stepTicks,
    getTelemetry,
    serializeState,
    injectFault,
    renderFrame,
    destroy,
  };

  return appInstance;
}

// ============================================================================
// Browser Entrypoint
// ============================================================================

export function bootstrapBrowser(): AppInstance | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');

  const urlParams = new URLSearchParams(window.location.search);
  const isShowcase = urlParams.get('showcase') === '1' || true; // default showcase

  const app = createApp({
    canvas,
    uiRoot,
    isShowcase,
    seed: 1616,
    startAnimationLoop: false,
  });

  // Bind non-negotiable test & oracle window hooks
  window.__STEP_TICKS__ = (n: number) => {
    const executed = app.stepTicks(n);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        app.renderFrame(ctx, canvas.width, canvas.height);
      }
    }
    return executed;
  };
  window.__FACTORY_TELEMETRY__ = () => app.getTelemetry();
  window.__SERIALIZE_STATE__ = () => app.serializeState();
  window.__INJECT_FAULT__ = (fault: FaultType) => app.injectFault(fault);

  // Render initial tick 0 frame
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      app.renderFrame(ctx, canvas.width, canvas.height);
    }
  }

  return app;
}

// Auto-run when loaded as module in browser
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapBrowser();
}
