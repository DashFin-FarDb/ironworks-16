import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAN_SPEED_TILES_PER_SEC,
  DEFAULT_ZOOM_STEP_FACTOR,
  InputController,
  placeEntityInWorld,
  removeEntityAtTile,
} from '../src/app/inputController.js';
import { Camera } from '../src/render/camera.js';
import { Hotbar } from '../src/ui/hotbar.js';
import { GhostPreviewController } from '../src/render/ghostPreview.js';
import { PowerOverlay } from '../src/render/powerOverlay.js';
import { createInspectorState } from '../src/ui/inspector.js';
import { EventBus } from '../src/core/eventBus.js';
import { createInitialWorldState } from '../src/core/mapGen.js';

describe('T47 - InputController', () => {
  function createTestSetup() {
    const world = createInitialWorldState(1616);
    const camera = new Camera({ x: 32, y: 32, zoom: 1 });
    const viewport = { width: 800, height: 600 };
    const hotbar = new Hotbar();
    const ghostPreview = new GhostPreviewController();
    const powerOverlay = new PowerOverlay();
    const inspectorState = createInspectorState();
    const eventBus = new EventBus();

    const controller = new InputController({
      world,
      camera,
      viewport,
      hotbar,
      ghostPreview,
      powerOverlay,
      inspectorState,
      eventBus,
    });

    return { world, camera, viewport, hotbar, ghostPreview, powerOverlay, inspectorState, eventBus, controller };
  }

  it('handles WASD camera panning smoothly and deterministically', () => {
    const { camera, controller } = createTestSetup();
    expect(camera.x).toBe(32);
    expect(camera.y).toBe(32);

    // Press 'd' (pan right)
    const resD = controller.handleKeyDown('d');
    expect(resD.kind).toBe('noop');
    expect(controller.getHeldPanKeys()).toContain('right');

    // Update by 1.0s
    const moved = controller.update(1.0);
    expect(moved).toBe(true);
    expect(camera.x).toBeCloseTo(32 + DEFAULT_PAN_SPEED_TILES_PER_SEC);
    expect(camera.y).toBeCloseTo(32);

    // Key up
    controller.handleKeyUp('d');
    expect(controller.getHeldPanKeys()).not.toContain('right');

    // Pan with diagonal (w + a)
    controller.handleKeyDown('w');
    controller.handleKeyDown('a');
    controller.update(1.0);
    const expectedDist = DEFAULT_PAN_SPEED_TILES_PER_SEC * Math.SQRT1_2;
    expect(camera.x).toBeCloseTo(32 + DEFAULT_PAN_SPEED_TILES_PER_SEC - expectedDist);
    expect(camera.y).toBeCloseTo(32 - expectedDist);

    controller.handleBlur();
    expect(controller.getHeldPanKeys().length).toBe(0);
  });

  it('handles R and Shift+R rotation', () => {
    const { controller, ghostPreview } = createTestSetup();
    expect(ghostPreview.getDirection()).toBe('N');

    const resR = controller.handleKeyDown('r');
    expect(resR.kind).toBe('rotate');
    if (resR.kind === 'rotate') {
      expect(resR.direction).toBe('E');
    }
    expect(ghostPreview.getDirection()).toBe('E');

    // Shift+R rotates counter-clockwise
    const resShiftR = controller.handleKeyDown('r', { shiftKey: true });
    expect(resShiftR.kind).toBe('rotate');
    if (resShiftR.kind === 'rotate') {
      expect(resShiftR.direction).toBe('N');
    }
  });

  it('handles P to toggle power overlay', () => {
    const { controller, powerOverlay } = createTestSetup();
    expect(powerOverlay.isEnabled()).toBe(false);

    const resP = controller.handleKeyDown('p');
    expect(resP.kind).toBe('toggle_power_overlay');
    if (resP.kind === 'toggle_power_overlay') {
      expect(resP.enabled).toBe(true);
    }
    expect(powerOverlay.isEnabled()).toBe(true);
  });

  it('handles hotbar selection (1-9, 0, Escape) and synchronizes ghost preview', () => {
    const { controller, hotbar, ghostPreview } = createTestSetup();
    expect(hotbar.getSelectedEntityType()).toBe('transport_belt');
    expect(ghostPreview.getSelectedEntityType()).toBe('transport_belt');

    // Select slot 2 (inserter)
    controller.handleKeyDown('2');
    expect(hotbar.getSelectedEntityType()).toBe('inserter');
    expect(ghostPreview.getSelectedEntityType()).toBe('inserter');

    // Escape clears selection
    controller.handleKeyDown('Escape');
    expect(hotbar.getSelectedEntityType()).toBeNull();
    expect(ghostPreview.getSelectedEntityType()).toBeNull();
  });

  it('places entity on left-click when tool selected and rejects invalid placement', () => {
    const { world, camera, viewport, controller, eventBus } = createTestSetup();
    let emittedPlaced = false;
    eventBus.on('entityPlaced', () => { emittedPlaced = true; });

    // Select transport_belt
    controller.handleKeyDown('1');

    // Place at center screen (32, 32)
    const centerScreen = { x: viewport.width / 2, y: viewport.height / 2 };
    const resPlace = controller.handlePointerDown(0, centerScreen);
    expect(resPlace.kind).toBe('placed');
    expect(emittedPlaced).toBe(true);

    if (resPlace.kind === 'placed') {
      expect(resPlace.entity.type).toBe('transport_belt');
      expect(world.entities[resPlace.entity.id]).toBeDefined();
    }

    // Attempt placing on top of it -> rejected
    const resConflict = controller.handlePointerDown(0, centerScreen);
    expect(resConflict.kind).toBe('placement_rejected');
  });

  it('inspects entity on left-click when no tool is selected', () => {
    const { world, viewport, controller, inspectorState } = createTestSetup();
    controller.handleKeyDown('Escape');
    expect(controller.getHotbar().getSelectedEntityType()).toBeNull();

    // Directly place an entity at (32, 32)
    const entity = placeEntityInWorld(world, 'iron_chest', { x: 32, y: 32 }, 'N');
    expect(entity).not.toBeNull();

    const centerScreen = { x: viewport.width / 2, y: viewport.height / 2 };
    const res = controller.handlePointerDown(0, centerScreen);
    expect(res.kind).toBe('inspect');
    if (res.kind === 'inspect') {
      expect(res.entityId).toBe(entity!.id);
    }
    expect(inspectorState.selectedEntityId).toBe(entity!.id);
  });

  it('deletes entity on right-click', () => {
    const { world, viewport, controller, eventBus } = createTestSetup();
    let emittedRemoved = false;
    eventBus.on('entityRemoved', () => { emittedRemoved = true; });

    const entity = placeEntityInWorld(world, 'wooden_chest', { x: 32, y: 32 }, 'N');
    expect(entity).not.toBeNull();
    expect(world.entities[entity!.id]).toBeDefined();

    const centerScreen = { x: viewport.width / 2, y: viewport.height / 2 };
    const resDel = controller.handlePointerDown(2, centerScreen);
    expect(resDel.kind).toBe('deleted');
    expect(emittedRemoved).toBe(true);
    expect(world.entities[entity!.id]).toBeUndefined();

    // Right-click on empty tile -> noop
    const resEmpty = controller.handlePointerDown(2, centerScreen);
    expect(resEmpty.kind).toBe('noop');
  });

  it('handles mouse wheel zoom', () => {
    const { camera, viewport, controller } = createTestSetup();
    const initZoom = camera.zoom;
    const centerScreen = { x: viewport.width / 2, y: viewport.height / 2 };

    // Scroll up (deltaY < 0) zooms in
    const resZoom = controller.handleWheel(-100, centerScreen);
    expect(resZoom.kind).toBe('zoom');
    expect(camera.zoom).toBeGreaterThan(initZoom);
  });
});
