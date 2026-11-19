/**
 * Procedural 16x16 Pixel-Art Sprite Atlas (T36)
 *
 * Generates all terrain, ore, item, 4-frame animated belt, machine, and
 * inserter sprites procedurally into deterministic 16x16 RGBA pixel buffers,
 * with optional HTML5 Canvas 2D caching when running in a browser environment.
 *
 * Strictly deterministic: zero Math.random() or Date.now().
 * Zero external assets or npm dependencies.
 * Headless-safe: works in Node/Vitest without DOM or Canvas APIs.
 */

import {
  DIRECTIONS,
  SimulationError,
  type BeltShape,
  type Direction,
  type EntityType,
  type ItemId,
  type ResourceType,
  type TerrainType,
} from '../types/contracts.js';

export const SPRITE_SIZE = 16;
export const SPRITE_BYTE_LENGTH = SPRITE_SIZE * SPRITE_SIZE * 4;
export const BELT_FRAME_COUNT = 4;

export type RGBA = readonly [number, number, number, number];

export interface SpritePixelData {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

export class UnknownSpriteError extends SimulationError {
  readonly spriteKey: string;

  constructor(spriteKey: string) {
    super('UNKNOWN_SPRITE', `Unknown sprite key: "${spriteKey}".`);
    this.name = 'UnknownSpriteError';
    this.spriteKey = spriteKey;
  }
}

export type InserterPart = 'base' | 'arm';

// ============================================================================
// Sprite Key Helpers
// ============================================================================

export function getTerrainSpriteKey(terrain: TerrainType): string {
  return `terrain:${terrain}`;
}

export function getResourceSpriteKey(resource: ResourceType): string {
  return `resource:${resource}`;
}

export function getItemSpriteKey(itemId: ItemId): string {
  return `item:${itemId}`;
}

export function getBeltSpriteKey(
  shape: BeltShape,
  direction: Direction,
  frame: number
): string {
  const normalizedFrame = ((Math.floor(frame) % BELT_FRAME_COUNT) + BELT_FRAME_COUNT) % BELT_FRAME_COUNT;
  return `belt:${shape}:${direction}:${normalizedFrame}`;
}

export function getEntitySpriteKey(entityType: EntityType, active = false): string {
  return active ? `entity:${entityType}:active` : `entity:${entityType}`;
}

export function getInserterPartSpriteKey(
  isFilter: boolean,
  part: InserterPart
): string {
  return isFilter ? `inserter:filter:${part}` : `inserter:basic:${part}`;
}

// ============================================================================
// Low-Level Deterministic Pixel Buffer Primitives
// ============================================================================

export function createPixelBuffer(): Uint8ClampedArray {
  return new Uint8ClampedArray(SPRITE_BYTE_LENGTH);
}

export function parseHexColor(hex: string): RGBA {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    return [r, g, b, 255];
  }
  if (clean.length === 8) {
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    const a = Number.parseInt(clean.slice(6, 8), 16);
    return [r, g, b, a];
  }
  throw new SimulationError('INVALID_COLOR', `Invalid hex color: "${hex}".`);
}

export function setPixel(
  buf: Uint8ClampedArray,
  x: number,
  y: number,
  rgba: RGBA
): void {
  if (x < 0 || y < 0 || x >= SPRITE_SIZE || y >= SPRITE_SIZE) return;
  const idx = (y * SPRITE_SIZE + x) * 4;
  buf[idx] = rgba[0];
  buf[idx + 1] = rgba[1];
  buf[idx + 2] = rgba[2];
  buf[idx + 3] = rgba[3];
}

export function getPixel(
  buf: Uint8ClampedArray,
  x: number,
  y: number
): RGBA {
  if (x < 0 || y < 0 || x >= SPRITE_SIZE || y >= SPRITE_SIZE) {
    return [0, 0, 0, 0];
  }
  const idx = (y * SPRITE_SIZE + x) * 4;
  return [
    buf[idx] ?? 0,
    buf[idx + 1] ?? 0,
    buf[idx + 2] ?? 0,
    buf[idx + 3] ?? 0,
  ];
}

export function fillRect(
  buf: Uint8ClampedArray,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: RGBA
): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      setPixel(buf, px, py, rgba);
    }
  }
}

export function strokeRect(
  buf: Uint8ClampedArray,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: RGBA
): void {
  for (let px = x; px < x + w; px++) {
    setPixel(buf, px, y, rgba);
    setPixel(buf, px, y + h - 1, rgba);
  }
  for (let py = y; py < y + h; py++) {
    setPixel(buf, x, py, rgba);
    setPixel(buf, x + w - 1, py, rgba);
  }
}

export function drawPattern(
  rows: readonly string[],
  palette: Readonly<Record<string, string>>
): Uint8ClampedArray {
  const buf = createPixelBuffer();
  const parsed: Record<string, RGBA> = {};
  for (const [ch, hex] of Object.entries(palette)) {
    parsed[ch] = parseHexColor(hex);
  }
  for (let y = 0; y < Math.min(rows.length, SPRITE_SIZE); y++) {
    const row = rows[y];
    if (!row) continue;
    for (let x = 0; x < Math.min(row.length, SPRITE_SIZE); x++) {
      const ch = row[x];
      if (!ch || ch === '.' || ch === ' ') continue;
      const color = parsed[ch];
      if (color) {
        setPixel(buf, x, y, color);
      }
    }
  }
  return buf;
}

export function rotateBufferCW(
  src: Uint8ClampedArray,
  stepsClockwise: number
): Uint8ClampedArray {
  const steps = ((stepsClockwise % 4) + 4) % 4;
  if (steps === 0) {
    return new Uint8ClampedArray(src);
  }
  let current = src;
  for (let s = 0; s < steps; s++) {
    const next = createPixelBuffer();
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const rgba = getPixel(current, x, y);
        setPixel(next, SPRITE_SIZE - 1 - y, x, rgba);
      }
    }
    current = next;
  }
  return current;
}

export function overlayBuffers(
  base: Uint8ClampedArray,
  top: Uint8ClampedArray
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base);
  for (let i = 0; i < SPRITE_BYTE_LENGTH; i += 4) {
    const ta = top[i + 3] ?? 0;
    if (ta === 0) continue;
    if (ta === 255) {
      out[i] = top[i] ?? 0;
      out[i + 1] = top[i + 1] ?? 0;
      out[i + 2] = top[i + 2] ?? 0;
      out[i + 3] = 255;
    } else {
      const alpha = ta / 255;
      const inv = 1 - alpha;
      out[i] = Math.round((top[i] ?? 0) * alpha + (out[i] ?? 0) * inv);
      out[i + 1] = Math.round((top[i + 1] ?? 0) * alpha + (out[i + 1] ?? 0) * inv);
      out[i + 2] = Math.round((top[i + 2] ?? 0) * alpha + (out[i + 2] ?? 0) * inv);
      out[i + 3] = Math.min(255, Math.round(ta + (out[i + 3] ?? 0) * inv));
    }
  }
  return out;
}

/** Deterministic FNV-1a 32-bit hash of a sprite's pixel buffer. */
export function hashSpritePixels(pixels: Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) {
    hash ^= pixels[i] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ============================================================================
// 1. Terrain Sprites (16x16 opaque tiles)
// ============================================================================

function buildTerrainSprites(): Record<TerrainType, Uint8ClampedArray> {
  const grass = drawPattern(
    [
      'ggggggggGggggggg',
      'ggdggggggggggggg',
      'gggggggggggdgggg',
      'ggggGggggggggggg',
      'ggggggggggggggGg',
      'gGgggggggggggggg',
      'gggggggdgggggggg',
      'ggggggggggggdggg',
      'gggdgggggggggggg',
      'gggggggggGgggggg',
      'gggggggggggggggg',
      'ggggGgggggggdggg',
      'gggggggggggggggg',
      'ggdggggggggggGgg',
      'ggggggggdggggggg',
      'gggggGgggggggggg',
    ],
    { g: '#4a7c3f', G: '#5b944d', d: '#3b6632' }
  );

  const dirt = drawPattern(
    [
      'ddddddddddddDddd',
      'ddkddddddddddddd',
      'dddddddDdddddddd',
      'ddddddddddddkddd',
      'dddDdddddddddddd',
      'ddddddddkddddddd',
      'ddddddddddddddDd',
      'dkdddddddddddddd',
      'ddddddDdddddkddd',
      'dddddddddddddddd',
      'ddddkddddddDdddd',
      'dddddddddddddddd',
      'dDddddddkddddddd',
      'ddddddddddddDddd',
      'dddddkdddddddddd',
      'ddddddddddkddddd',
    ],
    { d: '#7a5a3a', D: '#8c6a47', k: '#63472c' }
  );

  const sand = drawPattern(
    [
      'sssssssssSssssss',
      'sssdssssssssssss',
      'ssssssssssssdsss',
      'sssssSssssssssss',
      'ssssssssssSsssss',
      'sdssssssssssssss',
      'sssssssSsssssdss',
      'ssssssssssssssss',
      'ssssdssssssssSss',
      'ssssssssssssssss',
      'sSsssssssdssssss',
      'ssssssssssssSsss',
      'sssssSssssssssss',
      'sssdssssssssdsss',
      'ssssssssSsssssss',
      'ssssssssssssssds',
    ],
    { s: '#c9b47c', S: '#d8c592', d: '#b39d66' }
  );

  const water = drawPattern(
    [
      'wwwwwwwwwwwwwwww',
      'wwWWwwwwwwwwwwww',
      'wwwwwwwwwwWWwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwdwwwwwwwwwww',
      'wwwwwwWWwwwwwwww',
      'wwwwwwwwwwwwWWww',
      'wwwwwwwwwwwwwwww',
      'wWWwwwwwwdwwwwww',
      'wwwwwwwwwwwwwwww',
      'wwwwwwwwWWwwwwww',
      'wwdwwwwwwwwwwwww',
      'wwwwwwwwwwwwdwww',
      'wwwwWWwwwwwwwwww',
      'wwwwwwwwwwWWwwww',
      'wwwwwwwwwwwwwwww',
    ],
    { w: '#2b5f8c', W: '#3e7db0', d: '#214c70' }
  );

  const stone_ground = drawPattern(
    [
      'gggggggggggggggg',
      'ggGGgggdgggggggg',
      'gggdggggggggGGgg',
      'gggggggggggggdgg',
      'gggggGGggggggggg',
      'ggggggdggggdgggg',
      'gdgggggggggggggg',
      'gggggggggGGggggg',
      'ggggggggggdggggg',
      'gggGGggggggggggg',
      'ggggdggggggGGggg',
      'ggggggggggggdggg',
      'ggggggdggggggggg',
      'gGGggggggggdgggg',
      'ggdgggggGGgggggg',
      'gggggggggdgggggg',
    ],
    { g: '#6d7075', G: '#83878c', d: '#55585c' }
  );

  return { grass, dirt, sand, water, stone_ground };
}

// ============================================================================
// 2. Resource / Ore Overlay Sprites (16x16 with transparent background)
// ============================================================================

function buildResourceSprites(): Record<ResourceType, Uint8ClampedArray> {
  const iron_ore = drawPattern(
    [
      '................',
      '...dd...........',
      '..dLLd.....dd...',
      '..dLMd....dLLd..',
      '...dd.....dMMd..',
      '...........dd...',
      '......ddd.......',
      '.....dLLMd......',
      '.....dMMMd......',
      '......ddd.......',
      '..dd........dd..',
      '.dLLd......dLMd.',
      '.dMMd......dMMd.',
      '..dd........dd..',
      '.......dd.......',
      '................',
    ],
    { d: '#3c4a57', M: '#7a8f9e', L: '#b0c4d4' }
  );

  const copper_ore = drawPattern(
    [
      '................',
      '....dd..........',
      '...dLLd....dd...',
      '...dMMd...dLLd..',
      '....dd....dMMd..',
      '...........dd...',
      '.....ddd........',
      '....dLLMd.......',
      '....dMMMd...dd..',
      '.....ddd...dLMd.',
      '..dd.......dMMd.',
      '.dLLd.......dd..',
      '.dMMd...........',
      '..dd.....dd.....',
      '........dMMd....',
      '................',
    ],
    { d: '#6e3219', M: '#c86432', L: '#f09454' }
  );

  const coal = drawPattern(
    [
      '................',
      '..kk............',
      '.kGGk.....kk....',
      '.kbbk....kGGk...',
      '..kk.....kbbk...',
      '..........kk....',
      '......kkk.......',
      '.....kGGbk......',
      '.....kbbbk......',
      '......kkk.......',
      '...kk......kk...',
      '..kGGk....kGbk..',
      '..kbbk....kbbk..',
      '...kk......kk...',
      '................',
      '................',
    ],
    { k: '#111214', b: '#25282c', G: '#454a52' }
  );

  const stone = drawPattern(
    [
      '................',
      '...dd...........',
      '..dLLd....ddd...',
      '..dMMd...dLLMd..',
      '...dd....dMMMd..',
      '..........ddd...',
      '.....ddd........',
      '....dLLMd.......',
      '....dMMMd.......',
      '.....ddd...dd...',
      '..dd......dLLd..',
      '.dLMd.....dMMd..',
      '.dMMd......dd...',
      '..dd............',
      '................',
      '................',
    ],
    { d: '#635c4e', M: '#9c927d', L: '#c7bea9' }
  );

  return { iron_ore, copper_ore, coal, stone };
}

// ============================================================================
// 3. 4-Frame Animated Transport Belts
// ============================================================================

function buildBeltStraightNorth(frame: number): Uint8ClampedArray {
  const buf = createPixelBuffer();
  const railDark = parseHexColor('#3a3d42');
  const railLight = parseHexColor('#6c717a');
  const beltBg = parseHexColor('#2a2d32');
  const tread = parseHexColor('#4b5059');
  const arrow = parseHexColor('#e6b830');
  const arrowHi = parseHexColor('#ffe066');

  // Fill belt interior
  fillRect(buf, 2, 0, 12, 16, beltBg);
  // Side rails
  fillRect(buf, 0, 0, 2, 16, railDark);
  fillRect(buf, 14, 0, 2, 16, railDark);
  fillRect(buf, 1, 0, 1, 16, railLight);
  fillRect(buf, 14, 0, 1, 16, railLight);

  // Moving treads & chevron arrows (moving North => decreasing y as frame increases)
  const shift = frame % BELT_FRAME_COUNT;
  for (let y = 0; y < SPRITE_SIZE; y++) {
    const phase = (y + shift) % 4;
    if (phase === 0) {
      fillRect(buf, 2, y, 12, 1, tread);
    }
  }

  // Two chevrons pointing North, spaced 8px apart, shifting upward by 1px per frame
  for (const baseTip of [3, 11]) {
    const tipY = ((baseTip - shift) % 16 + 16) % 16;
    const midY = (tipY + 1) % 16;
    const tailY = (tipY + 2) % 16;
    setPixel(buf, 7, tipY, arrowHi);
    setPixel(buf, 8, tipY, arrowHi);
    setPixel(buf, 6, midY, arrow);
    setPixel(buf, 9, midY, arrow);
    setPixel(buf, 5, tailY, arrow);
    setPixel(buf, 10, tailY, arrow);
  }

  return buf;
}

function buildBeltCurveNorth(turn: 'curve_left' | 'curve_right', frame: number): Uint8ClampedArray {
  // curve_left exiting North enters from East; curve_right exiting North enters from West.
  const buf = createPixelBuffer();
  const railDark = parseHexColor('#3a3d42');
  const railLight = parseHexColor('#6c717a');
  const beltBg = parseHexColor('#2a2d32');
  const tread = parseHexColor('#4b5059');
  const arrow = parseHexColor('#e6b830');

  // Fill curved track region
  fillRect(buf, 2, 0, 12, 14, beltBg);
  if (turn === 'curve_left') {
    fillRect(buf, 14, 2, 2, 12, beltBg);
    // Outer L-rail on West + South
    fillRect(buf, 0, 0, 2, 16, railDark);
    fillRect(buf, 0, 14, 16, 2, railDark);
    fillRect(buf, 1, 0, 1, 15, railLight);
    fillRect(buf, 1, 14, 15, 1, railLight);
    // Inner corner post NE
    fillRect(buf, 14, 0, 2, 2, railDark);
    setPixel(buf, 14, 1, railLight);
  } else {
    fillRect(buf, 0, 2, 2, 12, beltBg);
    // Outer L-rail on East + South
    fillRect(buf, 14, 0, 2, 16, railDark);
    fillRect(buf, 0, 14, 16, 2, railDark);
    fillRect(buf, 14, 0, 1, 15, railLight);
    fillRect(buf, 0, 14, 15, 1, railLight);
    // Inner corner post NW
    fillRect(buf, 0, 0, 2, 2, railDark);
    setPixel(buf, 1, 1, railLight);
  }

  // Animated diagonal/arc treads
  const shift = frame % BELT_FRAME_COUNT;
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) {
      const diag = turn === 'curve_left' ? x + y : (15 - x) + y;
      if ((diag + shift) % 4 === 0) {
        setPixel(buf, x, y, tread);
      }
    }
  }

  // Animated chevron near exit pointing North
  const tipY = 2 + ((3 - shift) % 4);
  setPixel(buf, 7, tipY, arrow);
  setPixel(buf, 8, tipY, arrow);
  setPixel(buf, 6, tipY + 1, arrow);
  setPixel(buf, 9, tipY + 1, arrow);

  return buf;
}

function buildAllBeltSprites(): Record<string, Uint8ClampedArray> {
  const sprites: Record<string, Uint8ClampedArray> = {};
  const shapes: readonly BeltShape[] = ['straight', 'curve_left', 'curve_right'];

  for (const shape of shapes) {
    for (let frame = 0; frame < BELT_FRAME_COUNT; frame++) {
      const northBuf =
        shape === 'straight'
          ? buildBeltStraightNorth(frame)
          : buildBeltCurveNorth(shape, frame);

      for (let dirIdx = 0; dirIdx < DIRECTIONS.length; dirIdx++) {
        const dir = DIRECTIONS[dirIdx] as Direction;
        const rotated = rotateBufferCW(northBuf, dirIdx);
        sprites[getBeltSpriteKey(shape, dir, frame)] = rotated;
      }
    }
  }

  return sprites;
}

// ============================================================================
// 4. Item Sprites (all 21 ItemIds, 16x16 with transparent background)
// ============================================================================

function buildItemSprites(): Record<ItemId, Uint8ClampedArray> {
  const iron_ore = drawPattern(
    [
      '................',
      '................',
      '.....ddddd......',
      '....dLLLMdd.....',
      '...dLLMMMMd.....',
      '...dLMMMMMd.....',
      '...dMMMMdd......',
      '....dddd........',
      '.......dddd.....',
      '......dLLMd.....',
      '......dMMMd.....',
      '.......ddd......',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#36434f', M: '#7a8f9e', L: '#b8cde0' }
  );

  const copper_ore = drawPattern(
    [
      '................',
      '................',
      '.....ddddd......',
      '....dLLLMdd.....',
      '...dLLMMMMd.....',
      '...dLMMMMMd.....',
      '...dMMMMdd......',
      '....dddd........',
      '.......dddd.....',
      '......dLLMd.....',
      '......dMMMd.....',
      '.......ddd......',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#692d14', M: '#c86432', L: '#f29a57' }
  );

  const coal = drawPattern(
    [
      '................',
      '................',
      '.....kkkkk......',
      '....kGGGbbk.....',
      '...kGGbbbbk.....',
      '...kGbbbbbk.....',
      '...kbbbbbbk.....',
      '....kbbbbk......',
      '.....kkkk.......',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
    { k: '#0f1012', b: '#26292e', G: '#4a5059' }
  );

  const stone = drawPattern(
    [
      '................',
      '................',
      '.....ddddd......',
      '....dLLLMdd.....',
      '...dLLMMMMd.....',
      '...dMMMMMMd.....',
      '...dMMMMMd......',
      '....ddddd.......',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#5c5649', M: '#9c927d', L: '#ccc3ae' }
  );

  const iron_plate = drawPattern(
    [
      '................',
      '................',
      '................',
      '...dddddddddd...',
      '..dLLLLLLLLLLd..',
      '..dLMMMMMMMMMd..',
      '..dLMdMMMMdMMd..',
      '..dLMMMMMMMMMd..',
      '..dLMMMMMMMMMd..',
      '..dLMdMMMMdMMd..',
      '..dMMMMMMMMMMd..',
      '...dddddddddd...',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#404852', M: '#8e9aa8', L: '#c8d3de' }
  );

  const copper_plate = drawPattern(
    [
      '................',
      '................',
      '................',
      '...dddddddddd...',
      '..dLLLLLLLLLLd..',
      '..dLMMMMMMMMMd..',
      '..dLMdMMMMdMMd..',
      '..dLMMMMMMMMMd..',
      '..dLMMMMMMMMMd..',
      '..dLMdMMMMdMMd..',
      '..dMMMMMMMMMMd..',
      '...dddddddddd...',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#733519', M: '#d4713b', L: '#f7a568' }
  );

  const stone_brick = drawPattern(
    [
      '................',
      '................',
      '................',
      '..dddddddddddd..',
      '.dLLLLLLLLLLLLd.',
      '.dLMMMdMMMMMMMd.',
      '.dLMMMdMMMMMMMd.',
      '.ddddddddddddd..',
      '.dLLLLLLLLLLd...',
      '.dMMMMMMdMMMd...',
      '.dMMMMMMdMMMd...',
      '..dddddddddd....',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#544e43', M: '#8c8373', L: '#b8ae9c' }
  );

  const steel_plate = drawPattern(
    [
      '................',
      '................',
      '..dddddddddddd..',
      '.dLLLLLLLLLLLLd.',
      '.dLMMMMMMMMMMMd.',
      '.dLMLLLLLLLLMMd.',
      '.dLMLddddddLMMd.',
      '.dLMLMMMMMMLMMd.',
      '.dLMLMMMMMMLMMd.',
      '.dLMMMMMMMMMMMd.',
      '..dddddddddddd..',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#2c3540', M: '#647385', L: '#a3b4c7' }
  );

  const iron_gear = drawPattern(
    [
      '................',
      '......dddd......',
      '......dLLd......',
      '...dd.dMMd.dd...',
      '..dLLddMMddLLd..',
      '..dMMMLMMMLMMd..',
      '.ddMMd....dMMdd.',
      '.dLLMd....dMLLd.',
      '.dMMMd....dMMMd.',
      '.ddMMd....dMMdd.',
      '..dMMMLMMMLMMd..',
      '..dMMddMMddMMd..',
      '...dd.dMMd.dd...',
      '......dMMd......',
      '......dddd......',
      '................',
    ],
    { d: '#363e47', M: '#8793a1', L: '#c5d0dc' }
  );

  const copper_cable = drawPattern(
    [
      '................',
      '................',
      '.....dddddd.....',
      '...ddLLLLLLdd...',
      '..dLLdMMMMdLLd..',
      '..dMd..dd..dMd..',
      '..dMd.dLLd.dMd..',
      '..dMd.dMMd.dMd..',
      '..dMd..dd..dMd..',
      '..dMMdMMMMdMMd..',
      '...ddMMMMMMdd...',
      '.....dddddd.....',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#6e3116', M: '#d67238', L: '#f7a96c' }
  );

  const electronic_circuit = drawPattern(
    [
      '................',
      '................',
      '..dddddddddddd..',
      '.dGGGGGGGGGGGGd.',
      '.dGccGGccGGccGd.',
      '.dGcGGccccGGcGd.',
      '.dGGcckkkkccGGd.',
      '.dGGcckkkkccGGd.',
      '.dGcGGccccGGcGd.',
      '.dGccGGccGGccGd.',
      '.dGGGGGGGGGGGGd.',
      '..dddddddddddd..',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#1c3b1e', G: '#2f8a36', c: '#e3963e', k: '#232629' }
  );

  const transport_belt = buildBeltStraightNorth(0);

  const underground_belt = drawPattern(
    [
      '................',
      '..dddddddddddd..',
      '.dYYYYYYYYYYYYd.',
      '.dYddddddddddYd.',
      '.dYdBBBBBBBBdYd.',
      '.dYdBBYYYYBBdYd.',
      '.dYdBYYYYYYBdYd.',
      '.dYdBBBBBBBBdYd.',
      '.dYdKKKKKKKKdYd.',
      '.dYdKKKKKKKKdYd.',
      '.dYdKKKKKKKKdYd.',
      '.dYddddddddddYd.',
      '..dddddddddddd..',
      '................',
      '................',
      '................',
    ],
    { d: '#2b2d30', Y: '#d9a526', B: '#4a4f57', K: '#15171a' }
  );

  const splitter = drawPattern(
    [
      '................',
      '.dddddddddddddd.',
      'dBBBBBBddBBBBBBd',
      'dBBYYBBddBBYYBBd',
      'dBYYYYBddBYYYYBd',
      'dBBBBBBddBBBBBBd',
      'dddddddddddddddd',
      'dYYYYYYYYYYYYYYd',
      'dYddddddddddddYd',
      'dBBBBBBddBBBBBBd',
      'dBBYYBBddBBYYBBd',
      'dBBBBBBddBBBBBBd',
      '.dddddddddddddd.',
      '................',
      '................',
      '................',
    ],
    { d: '#2a2d33', B: '#4e545e', Y: '#e6b830' }
  );

  const inserter = drawPattern(
    [
      '................',
      '......dddd......',
      '.....dYYYYd.....',
      '......dYYd......',
      '......dYYd......',
      '......dYYd......',
      '......dYYd......',
      '.....ddYYdd.....',
      '....dBBBBBBd....',
      '....dBYYYYBd....',
      '....dBYYYYBd....',
      '....dBBBBBBd....',
      '.....dddddd.....',
      '................',
      '................',
      '................',
    ],
    { d: '#26292e', Y: '#e6b830', B: '#555c66' }
  );

  const filter_inserter = drawPattern(
    [
      '................',
      '......dddd......',
      '.....dPPPPd.....',
      '......dPPd......',
      '......dPPd......',
      '......dPPd......',
      '......dPPd......',
      '.....ddPPdd.....',
      '....dBBBBBBd....',
      '....dBPPPPBd....',
      '....dBPPPPBd....',
      '....dBBBBBBd....',
      '.....dddddd.....',
      '................',
      '................',
      '................',
    ],
    { d: '#262130', P: '#a65ce6', B: '#555c66' }
  );

  const power_pole = drawPattern(
    [
      '................',
      '.....dd..dd.....',
      '...ddCCddCCdd...',
      '...dddddddddd...',
      '.......dd.......',
      '......dWWd......',
      '......dWWd......',
      '......dWWd......',
      '......dWWd......',
      '......dWWd......',
      '......dWWd......',
      '.....ddWWdd.....',
      '....dWWWWWWd....',
      '....dddddddd....',
      '................',
      '................',
    ],
    { d: '#3d2817', W: '#8a5d3b', C: '#e3963e' }
  );

  const wooden_chest = drawPattern(
    [
      '................',
      '................',
      '..dddddddddddd..',
      '.dWWWWWWWWWWWWd.',
      '.dWddddddddddWd.',
      '.dWWWWWWWWWWWWd.',
      '.dWddddYYddddWd.',
      '.dWWWWdYYdWWWWd.',
      '.dWWWWddddWWWWd.',
      '.dWWWWWWWWWWWWd.',
      '.dWddddddddddWd.',
      '.dWWWWWWWWWWWWd.',
      '..dddddddddddd..',
      '................',
      '................',
      '................',
    ],
    { d: '#452b16', W: '#9c6839', Y: '#d9b44a' }
  );

  const iron_chest = drawPattern(
    [
      '................',
      '................',
      '..dddddddddddd..',
      '.dLLLLLLLLLLLLd.',
      '.dLddddddddddLd.',
      '.dMMMMMMMMMMMMd.',
      '.dMddddYYddddMd.',
      '.dMMMMdYYdMMMMd.',
      '.dMMMMddddMMMMd.',
      '.dMMMMMMMMMMMMd.',
      '.dMddddddddddMd.',
      '.dMMMMMMMMMMMMd.',
      '..dddddddddddd..',
      '................',
      '................',
      '................',
    ],
    { d: '#333a42', M: '#788491', L: '#b0bcc9', Y: '#e6c84c' }
  );

  const red_science = drawPattern(
    [
      '................',
      '......dddd......',
      '......dGGd......',
      '......dGGd......',
      '.....dGGGGd.....',
      '....dGGRRGGd....',
      '...dGGRRRRGGd...',
      '...dGRhRRRRGd...',
      '...dGRRRRRRGd...',
      '...dGRRRRRRGd...',
      '....dRRRRRRd....',
      '.....dddddd.....',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#2e2b33', G: '#b8d4e3', R: '#d92b3a', h: '#ff8a93' }
  );

  const green_science = drawPattern(
    [
      '................',
      '......dddd......',
      '......dGGd......',
      '......dGGd......',
      '.....dGGGGd.....',
      '....dGGEEGGd....',
      '...dGGEEEEGGd...',
      '...dGEhEEEEGd...',
      '...dGEEEEEEGd...',
      '...dGEEEEEEGd...',
      '....dEEEEEEd....',
      '.....dddddd.....',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#253328', G: '#b8d4e3', E: '#2cc953', h: '#94ffad' }
  );

  return {
    iron_ore,
    copper_ore,
    coal,
    stone,
    iron_plate,
    copper_plate,
    stone_brick,
    steel_plate,
    iron_gear,
    copper_cable,
    electronic_circuit,
    transport_belt,
    underground_belt,
    splitter,
    inserter,
    filter_inserter,
    power_pole,
    wooden_chest,
    iron_chest,
    red_science,
    green_science,
  };
}

// ============================================================================
// 5. Entity & Inserter Sprites (all 19 EntityTypes + active variants + parts)
// ============================================================================

function buildInserterPartSprites(): Record<string, Uint8ClampedArray> {
  const basicBase = drawPattern(
    [
      '................',
      '................',
      '................',
      '................',
      '.....dddddd.....',
      '....dBBBBBBd....',
      '....dBYYYYBd....',
      '....dBYddYBd....',
      '....dBYddYBd....',
      '....dBYYYYBd....',
      '....dBBBBBBd....',
      '.....dddddd.....',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#22252a', B: '#555c66', Y: '#e6b830' }
  );

  const basicArm = drawPattern(
    [
      '......dddd......',
      '.....dYddYd.....',
      '......dYYd......',
      '......dYYd......',
      '......dYYd......',
      '......dYYd......',
      '......dYYd......',
      '......dYYd......',
      '......dddd......',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#22252a', Y: '#f2c94c' }
  );

  const filterBase = drawPattern(
    [
      '................',
      '................',
      '................',
      '................',
      '.....dddddd.....',
      '....dBBBBBBd....',
      '....dBPPPPBd....',
      '....dBPddPBd....',
      '....dBPddPBd....',
      '....dBPPPPBd....',
      '....dBBBBBBd....',
      '.....dddddd.....',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#262130', B: '#555c66', P: '#a65ce6' }
  );

  const filterArm = drawPattern(
    [
      '......dddd......',
      '.....dPddPd.....',
      '......dPPd......',
      '......dPPd......',
      '......dPPd......',
      '......dPPd......',
      '......dPPd......',
      '......dPPd......',
      '......dddd......',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
      '................',
    ],
    { d: '#262130', P: '#c485ff' }
  );

  return {
    [getInserterPartSpriteKey(false, 'base')]: basicBase,
    [getInserterPartSpriteKey(false, 'arm')]: basicArm,
    [getInserterPartSpriteKey(true, 'base')]: filterBase,
    [getInserterPartSpriteKey(true, 'arm')]: filterArm,
  };
}

function buildEntitySprites(
  itemSprites: Record<ItemId, Uint8ClampedArray>
): Record<string, Uint8ClampedArray> {
  const sprites: Record<string, Uint8ClampedArray> = {};

  // Logistics entities reuse/extend their icon designs
  sprites[getEntitySpriteKey('transport_belt')] = new Uint8ClampedArray(itemSprites.transport_belt);
  sprites[getEntitySpriteKey('splitter')] = new Uint8ClampedArray(itemSprites.splitter);
  sprites[getEntitySpriteKey('underground_belt')] = new Uint8ClampedArray(itemSprites.underground_belt);
  sprites[getEntitySpriteKey('inserter')] = new Uint8ClampedArray(itemSprites.inserter);
  sprites[getEntitySpriteKey('filter_inserter')] = new Uint8ClampedArray(itemSprites.filter_inserter);
  sprites[getEntitySpriteKey('power_pole')] = new Uint8ClampedArray(itemSprites.power_pole);
  sprites[getEntitySpriteKey('wooden_chest')] = new Uint8ClampedArray(itemSprites.wooden_chest);
  sprites[getEntitySpriteKey('iron_chest')] = new Uint8ClampedArray(itemSprites.iron_chest);

  // Burner Drill
  const burnerDrill = drawPattern(
    [
      '.dddddddddddddd.',
      'dRRRRRRRRRRRRRRd',
      'dRddddddddddddRd',
      'dRdBBBBBBBBBBdRd',
      'dRdBBddddddBBdRd',
      'dRdBBdMMMMdBBdRd',
      'dRdBBdMLLMdBBdRd',
      'dRdBBdMLLMdBBdRd',
      'dRdBBdMMMMdBBdRd',
      'dRdBBddddddBBdRd',
      'dRdBBBBBBBBBBdRd',
      'dRddddddddddddRd',
      'dRRRRddOOddRRRRd',
      'dRRRRddOOddRRRRd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#292421', R: '#8c4a2e', B: '#524b47', M: '#7a7f87', L: '#b3bac4', O: '#423c38' }
  );
  const burnerDrillActive = drawPattern(
    [
      '.dddddddddddddd.',
      'dRRRRRRRRRRRRRRd',
      'dRddddddddddddRd',
      'dRdBBBBBBBBBBdRd',
      'dRdBBddddddBBdRd',
      'dRdBBdMMMMdBBdRd',
      'dRdBBdMLLMdBBdRd',
      'dRdBBdMLLMdBBdRd',
      'dRdBBdMMMMdBBdRd',
      'dRdBBddddddBBdRd',
      'dRdBBBBBBBBBBdRd',
      'dRddddddddddddRd',
      'dRRRRddOOddRRRRd',
      'dRRRRddFFddRRRRd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#292421', R: '#8c4a2e', B: '#524b47', M: '#7a7f87', L: '#b3bac4', O: '#ff8c24', F: '#ffe047' }
  );
  sprites[getEntitySpriteKey('burner_drill', false)] = burnerDrill;
  sprites[getEntitySpriteKey('burner_drill', true)] = burnerDrillActive;

  // Electric Drill
  const electricDrill = drawPattern(
    [
      '.dddddddddddddd.',
      'dBBBBBBBBBBBBBBd',
      'dBddddddddddddBd',
      'dBdCCCCCCCCCCdBd',
      'dBdCCddddddCCdBd',
      'dBdCCdMMMMdCCdBd',
      'dBdCCdMLLMdCCdBd',
      'dBdCCdMLLMdCCdBd',
      'dBdCCdMMMMdCCdBd',
      'dBdCCddddddCCdBd',
      'dBdCCCCCCCCCCdBd',
      'dBddddddddddddBd',
      'dBBBBddGGddBBBBd',
      'dBBBBddGGddBBBBd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#1f2933', B: '#3b6ea5', C: '#5d8fc4', M: '#7c8794', L: '#c2cedb', G: '#4a545e' }
  );
  const electricDrillActive = drawPattern(
    [
      '.dddddddddddddd.',
      'dBBBBBBBBBBBBBBd',
      'dBddddddddddddBd',
      'dBdCCCCCCCCCCdBd',
      'dBdCCddddddCCdBd',
      'dBdCCdMMMMdCCdBd',
      'dBdCCdMLLMdCCdBd',
      'dBdCCdMLLMdCCdBd',
      'dBdCCdMMMMdCCdBd',
      'dBdCCddddddCCdBd',
      'dBdCCCCCCCCCCdBd',
      'dBddddddddddddBd',
      'dBBBBddGGddBBBBd',
      'dBBBBddGGddBBBBd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#1f2933', B: '#3b6ea5', C: '#5d8fc4', M: '#7c8794', L: '#c2cedb', G: '#47eb70' }
  );
  sprites[getEntitySpriteKey('electric_drill', false)] = electricDrill;
  sprites[getEntitySpriteKey('electric_drill', true)] = electricDrillActive;

  // Stone Furnace
  const stoneFurnace = drawPattern(
    [
      '..dddddddddddd..',
      '.dSSSSSSSSSSSSd.',
      'dSSddddddddddSSd',
      'dSdSSSSSSSSSSdSd',
      'dSdSSddddddSSdSd',
      'dSdSdKKKKKKdSdSd',
      'dSdSdKKKKKKdSdSd',
      'dSdSdKKKKKKdSdSd',
      'dSdSdKKKKKKdSdSd',
      'dSdSSddddddSSdSd',
      'dSdSSSSSSSSSSdSd',
      'dSSddddddddddSSd',
      'dSSSSSSSSSSSSSSd',
      '.dSSSSSSSSSSSSd.',
      '..dddddddddddd..',
      '................',
    ],
    { d: '#3d3933', S: '#8f8778', K: '#24211d' }
  );
  const stoneFurnaceActive = drawPattern(
    [
      '..dddddddddddd..',
      '.dSSSSSSSSSSSSd.',
      'dSSddddddddddSSd',
      'dSdSSSSSSSSSSdSd',
      'dSdSSddddddSSdSd',
      'dSdSdOOOOOOdSdSd',
      'dSdSdOFFFFOdSdSd',
      'dSdSdOFYYFOdSdSd',
      'dSdSdOFFFFOdSdSd',
      'dSdSSddddddSSdSd',
      'dSdSSSSSSSSSSdSd',
      'dSSddddddddddSSd',
      'dSSSSSSSSSSSSSSd',
      '.dSSSSSSSSSSSSd.',
      '..dddddddddddd..',
      '................',
    ],
    { d: '#3d3933', S: '#8f8778', O: '#d94814', F: '#ff8c24', Y: '#fff066' }
  );
  sprites[getEntitySpriteKey('stone_furnace', false)] = stoneFurnace;
  sprites[getEntitySpriteKey('stone_furnace', true)] = stoneFurnaceActive;

  // Electric Furnace
  const electricFurnace = drawPattern(
    [
      '.dddddddddddddd.',
      'dMMMMMMMMMMMMMMd',
      'dMddddddddddddMd',
      'dMdBBBBBBBBBBdMd',
      'dMdBBddddddBBdMd',
      'dMdBdKKKKKKdBdMd',
      'dMdBdKKKKKKdBdMd',
      'dMdBdKKKKKKdBdMd',
      'dMdBdKKKKKKdBdMd',
      'dMdBBddddddBBdMd',
      'dMdBBBBBBBBBBdMd',
      'dMddddddddddddMd',
      'dMMMMddGGddMMMMd',
      'dMMMMMMMMMMMMMMd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#232830', M: '#7a8694', B: '#4f5a66', K: '#1d2229', G: '#4a545e' }
  );
  const electricFurnaceActive = drawPattern(
    [
      '.dddddddddddddd.',
      'dMMMMMMMMMMMMMMd',
      'dMddddddddddddMd',
      'dMdBBBBBBBBBBdMd',
      'dMdBBddddddBBdMd',
      'dMdBdCCCCCCdBdMd',
      'dMdBdCWWWWCdBdMd',
      'dMdBdCWWWWCdBdMd',
      'dMdBdCCCCCCdBdMd',
      'dMdBBddddddBBdMd',
      'dMdBBBBBBBBBBdMd',
      'dMddddddddddddMd',
      'dMMMMddGGddMMMMd',
      'dMMMMMMMMMMMMMMd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#232830', M: '#7a8694', B: '#4f5a66', C: '#38b6ff', W: '#ccf0ff', G: '#47eb70' }
  );
  sprites[getEntitySpriteKey('electric_furnace', false)] = electricFurnace;
  sprites[getEntitySpriteKey('electric_furnace', true)] = electricFurnaceActive;

  // Assembler Mk1 (warm industrial grey/tan)
  const assemblerMk1 = drawPattern(
    [
      '.dddddddddddddd.',
      'dAAAAAAAAAAAAAAd',
      'dAddddddddddddAd',
      'dAdMMMMMMMMMMdAd',
      'dAdMMddMMddMMdAd',
      'dAdMdLLddLLdMdAd',
      'dAdMdLddddLdMdAd',
      'dAdMMddddddMMdAd',
      'dAdMdLddddLdMdAd',
      'dAdMdLLddLLdMdAd',
      'dAdMMddMMddMMdAd',
      'dAddddddddddddAd',
      'dAAAAddGGddAAAAd',
      'dAAAAAAAAAAAAAAd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#2b2824', A: '#9c8c74', M: '#6e685e', L: '#b8b0a2', G: '#4a545e' }
  );
  const assemblerMk1Active = drawPattern(
    [
      '.dddddddddddddd.',
      'dAAAAAAAAAAAAAAd',
      'dAddddddddddddAd',
      'dAdMMMMMMMMMMdAd',
      'dAdMMddMMddMMdAd',
      'dAdMdLLddLLdMdAd',
      'dAdMdLddddLdMdAd',
      'dAdMMddddddMMdAd',
      'dAdMdLddddLdMdAd',
      'dAdMdLLddLLdMdAd',
      'dAdMMddMMddMMdAd',
      'dAddddddddddddAd',
      'dAAAAddGGddAAAAd',
      'dAAAAAAAAAAAAAAd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#2b2824', A: '#9c8c74', M: '#6e685e', L: '#e0d8c8', G: '#47eb70' }
  );
  sprites[getEntitySpriteKey('assembler_mk1', false)] = assemblerMk1;
  sprites[getEntitySpriteKey('assembler_mk1', true)] = assemblerMk1Active;

  // Assembler Mk2 (blue chassis)
  const assemblerMk2 = drawPattern(
    [
      '.dddddddddddddd.',
      'dBBBBBBBBBBBBBBd',
      'dBddddddddddddBd',
      'dBdMMMMMMMMMMdBd',
      'dBdMMddMMddMMdBd',
      'dBdMdLLddLLdMdBd',
      'dBdMdLddddLdMdBd',
      'dBdMMddddddMMdBd',
      'dBdMdLddddLdMdBd',
      'dBdMdLLddLLdMdBd',
      'dBdMMddMMddMMdBd',
      'dBddddddddddddBd',
      'dBBBBddGGddBBBBd',
      'dBBBBBBBBBBBBBBd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#1d2733', B: '#3a75b5', M: '#54687d', L: '#a6c4e0', G: '#4a545e' }
  );
  const assemblerMk2Active = drawPattern(
    [
      '.dddddddddddddd.',
      'dBBBBBBBBBBBBBBd',
      'dBddddddddddddBd',
      'dBdMMMMMMMMMMdBd',
      'dBdMMddMMddMMdBd',
      'dBdMdLLddLLdMdBd',
      'dBdMdLddddLdMdBd',
      'dBdMMddddddMMdBd',
      'dBdMdLddddLdMdBd',
      'dBdMdLLddLLdMdBd',
      'dBdMMddMMddMMdBd',
      'dBddddddddddddBd',
      'dBBBBddGGddBBBBd',
      'dBBBBBBBBBBBBBBd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#1d2733', B: '#3a75b5', M: '#54687d', L: '#d1e8ff', G: '#47eb70' }
  );
  sprites[getEntitySpriteKey('assembler_mk2', false)] = assemblerMk2;
  sprites[getEntitySpriteKey('assembler_mk2', true)] = assemblerMk2Active;

  // Boiler
  const boiler = drawPattern(
    [
      '..dddddddddddd..',
      '.dMMMMMMMMMMMMd.',
      'dMddddddddddddMd',
      'dMdCCCCCCCCCCdMd',
      'dMdCddddddddCdMd',
      'dMdCdKKKKKKdCdMd',
      'dMdCdKKKKKKdCdMd',
      'dMdCddddddddCdMd',
      'dMdCCCCCCCCCCdMd',
      'dMddddddddddddMd',
      'dMMddMMMMMMddMMd',
      'dMMddMMMMMMddMMd',
      '.dMMMMMMMMMMMMd.',
      '..dddddddddddd..',
      '................',
      '................',
    ],
    { d: '#26292e', M: '#6e7680', C: '#a86438', K: '#1e2024' }
  );
  const boilerActive = drawPattern(
    [
      '..dddddddddddd..',
      '.dMMMMMMMMMMMMd.',
      'dMddddddddddddMd',
      'dMdCCCCCCCCCCdMd',
      'dMdCddddddddCdMd',
      'dMdCdOFFFFOdCdMd',
      'dMdCdOFYYFOdCdMd',
      'dMdCddddddddCdMd',
      'dMdCCCCCCCCCCdMd',
      'dMddddddddddddMd',
      'dMMddMMMMMMddMMd',
      'dMMddMMMMMMddMMd',
      '.dMMMMMMMMMMMMd.',
      '..dddddddddddd..',
      '................',
      '................',
    ],
    { d: '#26292e', M: '#6e7680', C: '#a86438', O: '#d94814', F: '#ff8c24', Y: '#fff066' }
  );
  sprites[getEntitySpriteKey('boiler', false)] = boiler;
  sprites[getEntitySpriteKey('boiler', true)] = boilerActive;

  // Steam Engine
  const steamEngine = drawPattern(
    [
      '.dddddddddddddd.',
      'dMMMMMMMMMMMMMMd',
      'dMddLLLLLLLLddMd',
      'dMdLBBBBBBBBLdMd',
      'dMdLBddddddBLdMd',
      'dMdLBdCCCCdBLdMd',
      'dMdLBdCCCCdBLdMd',
      'dMdLBddddddBLdMd',
      'dMdLBBBBBBBBLdMd',
      'dMddLLLLLLLLddMd',
      'dMMMMMMMMMMMMMMd',
      'dMMMddGGGGddMMMd',
      'dMMMMMMMMMMMMMMd',
      '.dddddddddddddd.',
      '................',
      '................',
    ],
    { d: '#24292e', M: '#636c75', L: '#9ea8b3', B: '#3e464f', C: '#c47b3b', G: '#4a545e' }
  );
  const steamEngineActive = drawPattern(
    [
      '.dddddddddddddd.',
      'dMMMMMMMMMMMMMMd',
      'dMddLLLLLLLLddMd',
      'dMdLBBBBBBBBLdMd',
      'dMdLBddddddBLdMd',
      'dMdLBdCCCCdBLdMd',
      'dMdLBdCCCCdBLdMd',
      'dMdLBddddddBLdMd',
      'dMdLBBBBBBBBLdMd',
      'dMddLLLLLLLLddMd',
      'dMMMMMMMMMMMMMMd',
      'dMMMddGGGGddMMMd',
      'dMMMMMMMMMMMMMMd',
      '.dddddddddddddd.',
      '................',
      '................',
    ],
    { d: '#24292e', M: '#636c75', L: '#9ea8b3', B: '#3e464f', C: '#e69b4c', G: '#47eb70' }
  );
  sprites[getEntitySpriteKey('steam_engine', false)] = steamEngine;
  sprites[getEntitySpriteKey('steam_engine', true)] = steamEngineActive;

  // Solar Panel
  const solarPanel = drawPattern(
    [
      '.dddddddddddddd.',
      'dLLLLLLLLLLLLLLd',
      'dLBBBLBBBLBBBLLd',
      'dLBBBLBBBLBBBLLd',
      'dLLLLLLLLLLLLLLd',
      'dLBBBLBBBLBBBLLd',
      'dLBBBLBBBLBBBLLd',
      'dLLLLLLLLLLLLLLd',
      'dLBBBLBBBLBBBLLd',
      'dLBBBLBBBLBBBLLd',
      'dLLLLLLLLLLLLLLd',
      'dLBBBLBBBLBBBLLd',
      'dLBBBLBBBLBBBLLd',
      'dLLLLLLLLLLLLLLd',
      '.dddddddddddddd.',
      '................',
    ],
    { d: '#1b263b', L: '#9ab4d4', B: '#244b85' }
  );
  sprites[getEntitySpriteKey('solar_panel', false)] = solarPanel;
  sprites[getEntitySpriteKey('solar_panel', true)] = solarPanel;

  // Accumulator
  const accumulator = drawPattern(
    [
      '..dddddddddddd..',
      '.dMMMMMMMMMMMMd.',
      '.dMddCCCCCCddMd.',
      '.dMdCBBBBBBCdMd.',
      '.dMdCBEEEEBCdMd.',
      '.dMdCBEEEEBCdMd',
      '.dMdCBBBBBBCdMd.',
      '.dMdCBEEEEBCdMd.',
      '.dMdCBEEEEBCdMd.',
      '.dMdCBBBBBBCdMd.',
      '.dMddCCCCCCddMd.',
      '.dMMMMMMMMMMMMd.',
      '..dddddddddddd..',
      '................',
      '................',
      '................',
    ],
    { d: '#232830', M: '#6e7885', C: '#a3b0bf', B: '#2a333d', E: '#38d9e6' }
  );
  sprites[getEntitySpriteKey('accumulator', false)] = accumulator;
  sprites[getEntitySpriteKey('accumulator', true)] = accumulator;

  // Research Lab
  const researchLab = drawPattern(
    [
      '...dddddddddd...',
      '..dGGGGGGGGGGd..',
      '.dGGLLLLLLLLGGd.',
      '.dGLBBBBBBBBLGd.',
      'dGGLBCCCCCCBLGGd',
      'dGGLBCWWWWCBLGGd',
      'dGGLBCWWWWCBLGGd',
      'dGGLBCCCCCCBLGGd',
      '.dGLBBBBBBBBLGd.',
      '.dGGLLLLLLLLGGd.',
      '..dMMMMMMMMMMd..',
      '..dMddddddddMd..',
      '..dMMMMMMMMMMd..',
      '...dddddddddd...',
      '................',
      '................',
    ],
    { d: '#242a33', G: '#7c8a99', L: '#b8c7d9', B: '#3b4a5e', C: '#4d6680', W: '#6a849e', M: '#59636e' }
  );
  const researchLabActive = drawPattern(
    [
      '...dddddddddd...',
      '..dGGGGGGGGGGd..',
      '.dGGLLLLLLLLGGd.',
      '.dGLBBBBBBBBLGd.',
      'dGGLBCCCCCCBLGGd',
      'dGGLBCWWWWCBLGGd',
      'dGGLBCWWWWCBLGGd',
      'dGGLBCCCCCCBLGGd',
      '.dGLBBBBBBBBLGd.',
      '.dGGLLLLLLLLGGd.',
      '..dMMMMMMMMMMd..',
      '..dMddddddddMd..',
      '..dMMMMMMMMMMd..',
      '...dddddddddd...',
      '................',
      '................',
    ],
    { d: '#242a33', G: '#7c8a99', L: '#b8c7d9', B: '#2b6cb0', C: '#42d4f4', W: '#e0ffff', M: '#59636e' }
  );
  sprites[getEntitySpriteKey('research_lab', false)] = researchLab;
  sprites[getEntitySpriteKey('research_lab', true)] = researchLabActive;

  return sprites;
}

// ============================================================================
// SpriteAtlas Class & Canvas 2D Integration
// ============================================================================

export class SpriteAtlas {
  private readonly sprites: Map<string, SpritePixelData>;
  private readonly canvasCache: Map<string, HTMLCanvasElement>;

  constructor(entries: Readonly<Record<string, Uint8ClampedArray>>) {
    this.sprites = new Map();
    this.canvasCache = new Map();

    for (const [key, pixels] of Object.entries(entries)) {
      if (pixels.length !== SPRITE_BYTE_LENGTH) {
        throw new SimulationError(
          'INVALID_SPRITE_BUFFER',
          `Sprite "${key}" must have ${SPRITE_BYTE_LENGTH} bytes, got ${pixels.length}.`
        );
      }
      this.sprites.set(key, {
        key,
        width: SPRITE_SIZE,
        height: SPRITE_SIZE,
        pixels,
      });
    }
  }

  hasSprite(key: string): boolean {
    return this.sprites.has(key);
  }

  getSprite(key: string): SpritePixelData {
    const sprite = this.sprites.get(key);
    if (!sprite) {
      throw new UnknownSpriteError(key);
    }
    return sprite;
  }

  listKeys(): string[] {
    return Array.from(this.sprites.keys()).sort();
  }

  get size(): number {
    return this.sprites.size;
  }

  /**
   * Returns a cached 16x16 HTMLCanvasElement for fast Canvas 2D drawImage()
   * calls in browser environments. Returns null in headless Node environments.
   */
  getCanvas(key: string): HTMLCanvasElement | null {
    const sprite = this.getSprite(key);
    const cached = this.canvasCache.get(key);
    if (cached) return cached;

    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = SPRITE_SIZE;
    canvas.height = SPRITE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const imageData = ctx.createImageData(SPRITE_SIZE, SPRITE_SIZE);
    imageData.data.set(sprite.pixels);
    ctx.putImageData(imageData, 0, 0);
    this.canvasCache.set(key, canvas);
    return canvas;
  }

  /**
   * Draws a sprite onto a CanvasRenderingContext2D at (dx, dy) with size (dw, dh).
   * Uses the cached 16x16 offscreen canvas in browsers, or falls back to
   * pixel-rect drawing on mock 2D contexts in headless tests.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    key: string,
    dx: number,
    dy: number,
    dw = SPRITE_SIZE,
    dh = SPRITE_SIZE
  ): void {
    const sprite = this.getSprite(key);
    const canvas = this.getCanvas(key);
    if (canvas && typeof ctx.drawImage === 'function') {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, dx, dy, dw, dh);
      return;
    }

    // Headless / mock context fallback
    const pxW = dw / SPRITE_SIZE;
    const pxH = dh / SPRITE_SIZE;
    const { pixels } = sprite;
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) {
        const idx = (y * SPRITE_SIZE + x) * 4;
        const a = pixels[idx + 3] ?? 0;
        if (a === 0) continue;
        const r = pixels[idx] ?? 0;
        const g = pixels[idx + 1] ?? 0;
        const b = pixels[idx + 2] ?? 0;
        ctx.fillStyle = a === 255
          ? `rgb(${r},${g},${b})`
          : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
        ctx.fillRect(dx + x * pxW, dy + y * pxH, pxW, pxH);
      }
    }
  }
}

/**
 * Builds the complete procedural 16x16 sprite atlas containing all terrain,
 * resource ores, items, 4-frame animated belts, machines, and inserters.
 */
export function createSpriteAtlas(): SpriteAtlas {
  const entries: Record<string, Uint8ClampedArray> = {};

  const terrains = buildTerrainSprites();
  for (const [terrain, pixels] of Object.entries(terrains) as [TerrainType, Uint8ClampedArray][]) {
    entries[getTerrainSpriteKey(terrain)] = pixels;
  }

  const resources = buildResourceSprites();
  for (const [resource, pixels] of Object.entries(resources) as [ResourceType, Uint8ClampedArray][]) {
    entries[getResourceSpriteKey(resource)] = pixels;
  }

  const items = buildItemSprites();
  for (const [itemId, pixels] of Object.entries(items) as [ItemId, Uint8ClampedArray][]) {
    entries[getItemSpriteKey(itemId)] = pixels;
  }

  const belts = buildAllBeltSprites();
  for (const [key, pixels] of Object.entries(belts)) {
    entries[key] = pixels;
  }

  const entities = buildEntitySprites(items);
  for (const [key, pixels] of Object.entries(entities)) {
    entries[key] = pixels;
  }

  const inserterParts = buildInserterPartSprites();
  for (const [key, pixels] of Object.entries(inserterParts)) {
    entries[key] = pixels;
  }

  return new SpriteAtlas(entries);
}
