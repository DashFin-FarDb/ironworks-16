import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  SimulationError,
  type BeltShape,
  type EntityType,
  type ItemId,
  type ResourceType,
  type TerrainType,
} from '../src/types/contracts.js';
import {
  BELT_FRAME_COUNT,
  SPRITE_BYTE_LENGTH,
  SPRITE_SIZE,
  SpriteAtlas,
  UnknownSpriteError,
  createSpriteAtlas,
  getBeltSpriteKey,
  getEntitySpriteKey,
  getInserterPartSpriteKey,
  getItemSpriteKey,
  getResourceSpriteKey,
  getTerrainSpriteKey,
  hashSpritePixels,
  rotateBufferCW,
} from '../src/render/spriteAtlas.js';

const ALL_TERRAINS: readonly TerrainType[] = [
  'grass',
  'dirt',
  'sand',
  'water',
  'stone_ground',
];

const ALL_RESOURCES: readonly ResourceType[] = [
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
];

const ALL_ITEMS: readonly ItemId[] = [
  'iron_ore',
  'copper_ore',
  'coal',
  'stone',
  'iron_plate',
  'copper_plate',
  'stone_brick',
  'steel_plate',
  'iron_gear',
  'copper_cable',
  'electronic_circuit',
  'transport_belt',
  'underground_belt',
  'splitter',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'red_science',
  'green_science',
];

const ALL_ENTITIES: readonly EntityType[] = [
  'transport_belt',
  'splitter',
  'underground_belt',
  'inserter',
  'filter_inserter',
  'power_pole',
  'wooden_chest',
  'iron_chest',
  'burner_drill',
  'electric_drill',
  'stone_furnace',
  'electric_furnace',
  'assembler_mk1',
  'assembler_mk2',
  'boiler',
  'steam_engine',
  'solar_panel',
  'accumulator',
  'research_lab',
];

const ACTIVE_DISTINCT_ENTITIES: readonly EntityType[] = [
  'burner_drill',
  'electric_drill',
  'stone_furnace',
  'electric_furnace',
  'assembler_mk1',
  'assembler_mk2',
  'boiler',
  'steam_engine',
  'research_lab',
];

function countOpaquePixels(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if ((pixels[i] ?? 0) > 0) count++;
  }
  return count;
}

describe('T36: Procedural 16x16 Sprite Atlas', () => {
  it('generates all terrain sprites as fully opaque 16x16 tiles', () => {
    const atlas = createSpriteAtlas();
    const hashes = new Set<string>();

    for (const terrain of ALL_TERRAINS) {
      const key = getTerrainSpriteKey(terrain);
      expect(atlas.hasSprite(key)).toBe(true);
      const sprite = atlas.getSprite(key);
      expect(sprite.width).toBe(SPRITE_SIZE);
      expect(sprite.height).toBe(SPRITE_SIZE);
      expect(sprite.pixels.length).toBe(SPRITE_BYTE_LENGTH);
      expect(countOpaquePixels(sprite.pixels)).toBe(SPRITE_SIZE * SPRITE_SIZE);
      hashes.add(hashSpritePixels(sprite.pixels));
    }

    expect(hashes.size).toBe(ALL_TERRAINS.length);
  });

  it('generates all resource ore sprites with transparent backgrounds for terrain overlay', () => {
    const atlas = createSpriteAtlas();
    const hashes = new Set<string>();

    for (const resource of ALL_RESOURCES) {
      const key = getResourceSpriteKey(resource);
      expect(atlas.hasSprite(key)).toBe(true);
      const sprite = atlas.getSprite(key);
      const opaque = countOpaquePixels(sprite.pixels);
      expect(opaque).toBeGreaterThan(20);
      expect(opaque).toBeLessThan(SPRITE_SIZE * SPRITE_SIZE);
      hashes.add(hashSpritePixels(sprite.pixels));
    }

    expect(hashes.size).toBe(ALL_RESOURCES.length);
  });

  it('generates distinct 16x16 sprites for all 21 ItemIds', () => {
    const atlas = createSpriteAtlas();
    const hashes = new Set<string>();

    for (const itemId of ALL_ITEMS) {
      const key = getItemSpriteKey(itemId);
      expect(atlas.hasSprite(key)).toBe(true);
      const sprite = atlas.getSprite(key);
      expect(sprite.pixels.length).toBe(SPRITE_BYTE_LENGTH);
      expect(countOpaquePixels(sprite.pixels)).toBeGreaterThan(16);
      hashes.add(hashSpritePixels(sprite.pixels));
    }

    expect(hashes.size).toBe(ALL_ITEMS.length);
  });

  it('generates 4-frame animated belts for all shapes and directions', () => {
    const atlas = createSpriteAtlas();
    const shapes: readonly BeltShape[] = ['straight', 'curve_left', 'curve_right'];

    for (const shape of shapes) {
      for (const dir of DIRECTIONS) {
        const frameHashes = new Set<string>();
        for (let frame = 0; frame < BELT_FRAME_COUNT; frame++) {
          const key = getBeltSpriteKey(shape, dir, frame);
          expect(atlas.hasSprite(key)).toBe(true);
          const sprite = atlas.getSprite(key);
          expect(countOpaquePixels(sprite.pixels)).toBeGreaterThan(100);
          frameHashes.add(hashSpritePixels(sprite.pixels));
        }
        // All 4 animation frames must be visually distinct
        expect(frameHashes.size).toBe(BELT_FRAME_COUNT);
      }

      // All 4 directions for frame 0 must be distinct
      const dirHashes = new Set<string>();
      for (const dir of DIRECTIONS) {
        dirHashes.add(hashSpritePixels(atlas.getSprite(getBeltSpriteKey(shape, dir, 0)).pixels));
      }
      expect(dirHashes.size).toBe(DIRECTIONS.length);
    }

    // Frame wrapping handles negative and >= 4 frames cleanly
    expect(getBeltSpriteKey('straight', 'N', 4)).toBe(getBeltSpriteKey('straight', 'N', 0));
    expect(getBeltSpriteKey('straight', 'N', -1)).toBe(getBeltSpriteKey('straight', 'N', 3));
  });

  it('generates sprites for all 19 entity types, active machine states, and inserter parts', () => {
    const atlas = createSpriteAtlas();

    for (const entityType of ALL_ENTITIES) {
      const key = getEntitySpriteKey(entityType, false);
      expect(atlas.hasSprite(key)).toBe(true);
      expect(countOpaquePixels(atlas.getSprite(key).pixels)).toBeGreaterThan(20);
    }

    for (const entityType of ACTIVE_DISTINCT_ENTITIES) {
      const idleKey = getEntitySpriteKey(entityType, false);
      const activeKey = getEntitySpriteKey(entityType, true);
      expect(atlas.hasSprite(activeKey)).toBe(true);
      expect(hashSpritePixels(atlas.getSprite(activeKey).pixels)).not.toBe(
        hashSpritePixels(atlas.getSprite(idleKey).pixels)
      );
    }

    const basicBase = atlas.getSprite(getInserterPartSpriteKey(false, 'base'));
    const basicArm = atlas.getSprite(getInserterPartSpriteKey(false, 'arm'));
    const filterBase = atlas.getSprite(getInserterPartSpriteKey(true, 'base'));
    const filterArm = atlas.getSprite(getInserterPartSpriteKey(true, 'arm'));

    expect(hashSpritePixels(basicBase.pixels)).not.toBe(hashSpritePixels(filterBase.pixels));
    expect(hashSpritePixels(basicArm.pixels)).not.toBe(hashSpritePixels(filterArm.pixels));
  });

  it('is strictly deterministic across independent atlas builds', () => {
    const atlasA = createSpriteAtlas();
    const atlasB = createSpriteAtlas();

    const keysA = atlasA.listKeys();
    const keysB = atlasB.listKeys();
    expect(keysA).toEqual(keysB);

    for (const key of keysA) {
      expect(hashSpritePixels(atlasA.getSprite(key).pixels)).toBe(
        hashSpritePixels(atlasB.getSprite(key).pixels)
      );
    }
  });

  it('rotates 16x16 buffers losslessly and returns to original after 4 clockwise steps', () => {
    const atlas = createSpriteAtlas();
    const original = atlas.getSprite(getBeltSpriteKey('straight', 'N', 0)).pixels;
    const rotated4 = rotateBufferCW(original, 4);
    expect(hashSpritePixels(rotated4)).toBe(hashSpritePixels(original));
  });

  it('fails closed on unknown sprite keys and invalid pixel buffer sizes', () => {
    const atlas = createSpriteAtlas();
    expect(() => atlas.getSprite('does:not:exist')).toThrow(UnknownSpriteError);
    expect(() => new SpriteAtlas({ bad: new Uint8ClampedArray(16) })).toThrow(SimulationError);
  });

  it('draws sprites headlessly onto a mock CanvasRenderingContext2D', () => {
    const atlas = createSpriteAtlas();
    let fillRectCalls = 0;
    const mockCtx = {
      fillStyle: '',
      imageSmoothingEnabled: true,
      fillRect: () => {
        fillRectCalls++;
      },
    } as unknown as CanvasRenderingContext2D;

    atlas.draw(mockCtx, getItemSpriteKey('red_science'), 10, 20, 32, 32);
    expect(fillRectCalls).toBe(
      countOpaquePixels(atlas.getSprite(getItemSpriteKey('red_science')).pixels)
    );
  });
});
