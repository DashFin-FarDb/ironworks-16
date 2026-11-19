import { describe, expect, it } from 'vitest';
import {
  InvalidPlacementError,
  type Direction,
  type EntityType,
  type Tile,
  type WorldState,
} from '../src/types/contracts.js';
import { createCameraState } from '../src/render/camera.js';
import { createSpriteAtlas } from '../src/render/spriteAtlas.js';
import {
  GhostPreviewController,
  POWER_POLE_SUPPLY_RADIUS,
  evaluateGhostAtScreenPos,
  evaluateGhostPlacement,
  renderGhostPreview,
} from '../src/render/ghostPreview.js';

function createTestWorld(width = 16, height = 16): WorldState {
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

interface DrawCall {
  op: string;
  args: unknown[];
  fillStyle?: string;
  strokeStyle?: string;
  globalAlpha?: number;
}

function createMockContext(): {
  ctx: CanvasRenderingContext2D;
  calls: DrawCall[];
} {
  const calls: DrawCall[] = [];
  const stateStack: Array<{
    fillStyle: string;
    strokeStyle: string;
    globalAlpha: number;
    lineWidth: number;
  }> = [];

  const mock = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    imageSmoothingEnabled: true,
    save() {
      stateStack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        globalAlpha: this.globalAlpha,
        lineWidth: this.lineWidth,
      });
      calls.push({ op: 'save', args: [] });
    },
    restore() {
      const prev = stateStack.pop();
      if (prev) {
        this.fillStyle = prev.fillStyle;
        this.strokeStyle = prev.strokeStyle;
        this.globalAlpha = prev.globalAlpha;
        this.lineWidth = prev.lineWidth;
      }
      calls.push({ op: 'restore', args: [] });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({
        op: 'fillRect',
        args: [x, y, w, h],
        fillStyle: this.fillStyle,
        globalAlpha: this.globalAlpha,
      });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({
        op: 'strokeRect',
        args: [x, y, w, h],
        strokeStyle: this.strokeStyle,
        globalAlpha: this.globalAlpha,
      });
    },
    beginPath() {
      calls.push({ op: 'beginPath', args: [] });
    },
    moveTo(x: number, y: number) {
      calls.push({ op: 'moveTo', args: [x, y] });
    },
    lineTo(x: number, y: number) {
      calls.push({ op: 'lineTo', args: [x, y] });
    },
    closePath() {
      calls.push({ op: 'closePath', args: [] });
    },
    fill() {
      calls.push({ op: 'fill', args: [], fillStyle: this.fillStyle });
    },
  };

  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    calls,
  };
}

describe('T42: Ghost Placement Preview (src/render/ghostPreview.ts)', () => {
  describe('evaluateGhostPlacement', () => {
    it('returns valid for open grass tile', () => {
      const world = createTestWorld();
      const preview = evaluateGhostPlacement(world, 'transport_belt', { x: 4, y: 5 }, 'E');

      expect(preview.valid).toBe(true);
      expect(preview.reason).toBe('valid');
      expect(preview.direction).toBe('E');
      expect(preview.footprint).toEqual({ width: 1, height: 1 });
      expect(preview.tiles).toEqual([
        { coord: { x: 4, y: 5 }, valid: true, reason: 'valid' },
      ]);
      expect(preview.supplyRadius).toBeNull();
    });

    it('reports out_of_bounds when cursor is outside map bounds', () => {
      const world = createTestWorld(10, 10);
      const neg = evaluateGhostPlacement(world, 'stone_furnace', { x: -1, y: 2 });
      expect(neg.valid).toBe(false);
      expect(neg.reason).toBe('out_of_bounds');

      const over = evaluateGhostPlacement(world, 'stone_furnace', { x: 10, y: 2 });
      expect(over.valid).toBe(false);
      expect(over.reason).toBe('out_of_bounds');
    });

    it('reports water when tile terrain is water', () => {
      const world = createTestWorld();
      world.tiles[3 * world.width + 2]!.terrain = 'water';

      const preview = evaluateGhostPlacement(world, 'wooden_chest', { x: 2, y: 3 });
      expect(preview.valid).toBe(false);
      expect(preview.reason).toBe('water');
    });

    it('reports occupied when tile already has an entity', () => {
      const world = createTestWorld();
      world.tiles[6 * world.width + 7]!.entityId = 42;

      const preview = evaluateGhostPlacement(world, 'inserter', { x: 7, y: 6 }, 'S');
      expect(preview.valid).toBe(false);
      expect(preview.reason).toBe('occupied');
    });

    it('requires active ore deposit for burner_drill and electric_drill', () => {
      const world = createTestWorld();

      const noOre = evaluateGhostPlacement(world, 'burner_drill', { x: 5, y: 5 });
      expect(noOre.valid).toBe(false);
      expect(noOre.reason).toBe('requires_ore');

      // Depleted ore node should also be blocked
      world.tiles[5 * world.width + 5]!.resource = {
        type: 'iron_ore',
        amount: 0,
        initialAmount: 100,
      };
      const depleted = evaluateGhostPlacement(world, 'electric_drill', { x: 5, y: 5 });
      expect(depleted.valid).toBe(false);
      expect(depleted.reason).toBe('requires_ore');

      // Active ore node is valid
      world.tiles[5 * world.width + 5]!.resource = {
        type: 'iron_ore',
        amount: 50,
        initialAmount: 100,
      };
      const validDrill = evaluateGhostPlacement(world, 'electric_drill', { x: 5, y: 5 });
      expect(validDrill.valid).toBe(true);
      expect(validDrill.reason).toBe('valid');
    });

    it('evaluates 2x1 splitter footprint with per-tile granularity', () => {
      const world = createTestWorld(10, 10);
      // Occupy the right half of the splitter at (5, 4)
      world.tiles[4 * world.width + 5]!.entityId = 99;

      const preview = evaluateGhostPlacement(world, 'splitter', { x: 4, y: 4 }, 'N');
      expect(preview.footprint).toEqual({ width: 2, height: 1 });
      expect(preview.valid).toBe(false);
      expect(preview.reason).toBe('occupied');
      expect(preview.tiles).toEqual([
        { coord: { x: 4, y: 4 }, valid: true, reason: 'valid' },
        { coord: { x: 5, y: 4 }, valid: false, reason: 'occupied' },
      ]);

      // Splitter straddling right map edge
      const edge = evaluateGhostPlacement(world, 'splitter', { x: 9, y: 4 }, 'N');
      expect(edge.valid).toBe(false);
      expect(edge.reason).toBe('out_of_bounds');
      expect(edge.tiles[0]!.valid).toBe(true);
      expect(edge.tiles[1]!.reason).toBe('out_of_bounds');
    });

    it('populates supplyRadius for power_pole only', () => {
      const world = createTestWorld();
      const pole = evaluateGhostPlacement(world, 'power_pole', { x: 8, y: 8 });
      expect(pole.supplyRadius).toBe(POWER_POLE_SUPPLY_RADIUS);

      const chest = evaluateGhostPlacement(world, 'iron_chest', { x: 8, y: 8 });
      expect(chest.supplyRadius).toBeNull();
    });

    it('fails closed on invalid entity type, direction, or non-integer coordinates', () => {
      const world = createTestWorld();

      expect(() =>
        evaluateGhostPlacement(world, 'not_a_machine' as EntityType, { x: 1, y: 1 })
      ).toThrow(InvalidPlacementError);

      expect(() =>
        evaluateGhostPlacement(world, 'transport_belt', { x: 1, y: 1 }, 'NE' as Direction)
      ).toThrow(InvalidPlacementError);

      expect(() =>
        evaluateGhostPlacement(world, 'transport_belt', { x: 1.5, y: 1 })
      ).toThrow(InvalidPlacementError);
    });
  });

  describe('evaluateGhostAtScreenPos', () => {
    it('maps screen cursor coordinates through camera to tile evaluation', () => {
      const world = createTestWorld(32, 32);
      const camera = createCameraState({ x: 10, y: 10, zoom: 32 });
      const viewport = { width: 640, height: 480 };

      // Center of viewport (320, 240) maps to world (10, 10) -> tile (10, 10)
      const preview = evaluateGhostAtScreenPos(
        world,
        camera,
        viewport,
        { x: 320, y: 240 },
        'stone_furnace',
        'W'
      );

      expect(preview.position).toEqual({ x: 10, y: 10 });
      expect(preview.valid).toBe(true);
      expect(preview.direction).toBe('W');
    });
  });

  describe('renderGhostPreview', () => {
    it('renders valid tint, border, and direction arrow for directional entity', () => {
      const world = createTestWorld(32, 32);
      const camera = createCameraState({ x: 10, y: 10, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const preview = evaluateGhostPlacement(world, 'transport_belt', { x: 10, y: 10 }, 'E');

      const { ctx, calls } = createMockContext();
      const drawn = renderGhostPreview(ctx, preview, camera, viewport, {
        validTint: 'rgba(0,255,0,0.3)',
        validBorder: '#00ff00',
      });

      expect(drawn).toBe(true);
      expect(calls[0]!.op).toBe('save');
      expect(calls[calls.length - 1]!.op).toBe('restore');

      const fillRects = calls.filter((c) => c.op === 'fillRect');
      expect(fillRects.length).toBe(1);
      expect(fillRects[0]!.fillStyle).toBe('rgba(0,255,0,0.3)');

      const strokeRects = calls.filter((c) => c.op === 'strokeRect');
      expect(strokeRects.length).toBe(1);
      expect(strokeRects[0]!.strokeStyle).toBe('#00ff00');

      // Direction arrow drawn via beginPath -> fill
      expect(calls.some((c) => c.op === 'fill')).toBe(true);
    });

    it('renders per-tile mixed tints for partially blocked splitter', () => {
      const world = createTestWorld(32, 32);
      world.tiles[10 * world.width + 11]!.terrain = 'water';

      const camera = createCameraState({ x: 10, y: 10, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const preview = evaluateGhostPlacement(world, 'splitter', { x: 10, y: 10 }, 'N');

      const { ctx, calls } = createMockContext();
      renderGhostPreview(ctx, preview, camera, viewport, {
        validTint: 'VALID_TINT',
        blockedTint: 'BLOCKED_TINT',
        blockedBorder: 'BLOCKED_BORDER',
      });

      const fillRects = calls.filter((c) => c.op === 'fillRect');
      expect(fillRects.map((c) => c.fillStyle)).toEqual(['VALID_TINT', 'BLOCKED_TINT']);

      const strokeRects = calls.filter((c) => c.op === 'strokeRect');
      expect(strokeRects[0]!.strokeStyle).toBe('BLOCKED_BORDER');
    });

    it('renders power pole supply radius and omits direction arrow for non-directional entity', () => {
      const world = createTestWorld(32, 32);
      const camera = createCameraState({ x: 10, y: 10, zoom: 32 });
      const viewport = { width: 640, height: 480 };
      const preview = evaluateGhostPlacement(world, 'power_pole', { x: 10, y: 10 });

      const { ctx, calls } = createMockContext();
      const drawn = renderGhostPreview(ctx, preview, camera, viewport, {
        powerRadiusFill: 'POWER_FILL',
        powerRadiusBorder: 'POWER_BORDER',
      });

      expect(drawn).toBe(true);
      expect(calls.some((c) => c.op === 'fillRect' && c.fillStyle === 'POWER_FILL')).toBe(true);
      expect(calls.some((c) => c.op === 'strokeRect' && c.strokeStyle === 'POWER_BORDER')).toBe(
        true
      );
      // power_pole is non-directional so no arrow fill
      expect(calls.some((c) => c.op === 'fill')).toBe(false);
    });

    it('renders translucent sprite when SpriteAtlas is provided and restores context state', () => {
      const world = createTestWorld(32, 32);
      const camera = createCameraState({ x: 10, y: 10, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const atlas = createSpriteAtlas();
      const preview = evaluateGhostPlacement(world, 'stone_furnace', { x: 10, y: 10 });

      const { ctx, calls } = createMockContext();
      const drawn = renderGhostPreview(ctx, preview, camera, viewport, {
        atlas,
        spriteAlpha: 0.5,
      });

      expect(drawn).toBe(true);
      // Atlas fallback draws pixel rects at globalAlpha 0.5
      expect(calls.some((c) => c.op === 'fillRect' && c.globalAlpha === 0.5)).toBe(true);
      // Context globalAlpha is restored to 1
      expect(ctx.globalAlpha).toBe(1);
    });

    it('culls ghost preview completely outside viewport', () => {
      const world = createTestWorld(64, 64);
      const camera = createCameraState({ x: 5, y: 5, zoom: 32 });
      const viewport = { width: 160, height: 160 };
      const preview = evaluateGhostPlacement(world, 'wooden_chest', { x: 50, y: 50 });

      const { ctx, calls } = createMockContext();
      const drawn = renderGhostPreview(ctx, preview, camera, viewport);

      expect(drawn).toBe(false);
      expect(calls.length).toBe(0);
    });
  });

  describe('GhostPreviewController', () => {
    it('tracks selection, rotation, cursor, and evaluates/renders cleanly', () => {
      const world = createTestWorld(32, 32);
      const camera = createCameraState({ x: 10, y: 10, zoom: 32 });
      const viewport = { width: 320, height: 240 };
      const controller = new GhostPreviewController();

      expect(controller.evaluate(world)).toBeNull();

      controller.select('inserter');
      expect(controller.getSelectedEntityType()).toBe('inserter');
      expect(controller.getDirection()).toBe('N');
      expect(controller.rotate()).toBe('E');
      expect(controller.rotate(2)).toBe('W');

      controller.setCursorScreen({ x: 160, y: 120 }, camera, viewport);
      expect(controller.getCursorTile()).toEqual({ x: 10, y: 10 });

      const { ctx } = createMockContext();
      const rendered = controller.render(ctx, world, camera, viewport);
      expect(rendered).not.toBeNull();
      expect(rendered!.valid).toBe(true);
      expect(rendered!.direction).toBe('W');

      controller.clear();
      expect(controller.evaluate(world)).toBeNull();
    });

    it('fails closed on invalid selection or direction', () => {
      const controller = new GhostPreviewController();
      expect(() => controller.select('invalid_entity' as EntityType)).toThrow(
        InvalidPlacementError
      );
      expect(() => controller.setDirection('UP' as Direction)).toThrow(
        InvalidPlacementError
      );
    });
  });
});
