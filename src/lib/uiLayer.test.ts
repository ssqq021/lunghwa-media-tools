import { describe, expect, it } from 'vitest';
import {
  areSpriteFingerprintsSimilar,
  createSpriteFingerprint,
  findAlphaBounds,
  findAlphaComponents,
  sanitizeLayerName,
} from './uiLayer';

function makePixels(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4);
}

function fillPixel(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  value = 220,
): void {
  const index = (y * width + x) * 4;
  pixels[index] = value;
  pixels[index + 1] = value;
  pixels[index + 2] = value;
  pixels[index + 3] = 255;
}

describe('UI layer exports', () => {
  it('finds the smallest transparent-image bounds', () => {
    const pixels = makePixels(5, 4);
    fillPixel(pixels, 5, 1, 1);
    fillPixel(pixels, 5, 3, 2);

    expect(findAlphaBounds(pixels, 5, 4)).toEqual({
      x: 1,
      y: 1,
      width: 3,
      height: 2,
      pixels: 2,
    });
  });

  it('splits disconnected visible regions and ignores tiny noise', () => {
    const pixels = makePixels(8, 4);
    fillPixel(pixels, 8, 0, 0);
    fillPixel(pixels, 8, 1, 0);
    fillPixel(pixels, 8, 0, 1);
    fillPixel(pixels, 8, 6, 2);
    fillPixel(pixels, 8, 7, 2);
    fillPixel(pixels, 8, 7, 3);
    fillPixel(pixels, 8, 4, 3);

    expect(findAlphaComponents(pixels, 8, 4, 2)).toEqual([
      { x: 0, y: 0, width: 2, height: 2, pixels: 3 },
      { x: 6, y: 2, width: 2, height: 2, pixels: 3 },
    ]);
  });

  it('recognizes repeated sprites while rejecting different proportions', () => {
    const pixels = makePixels(8, 4);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        fillPixel(pixels, 8, x, y, 180);
        fillPixel(pixels, 8, x + 5, y + 2, 184);
      }
    }

    const first = createSpriteFingerprint(
      pixels,
      8,
      { x: 0, y: 0, width: 2, height: 2, pixels: 4 },
    );
    const repeated = createSpriteFingerprint(
      pixels,
      8,
      { x: 5, y: 2, width: 2, height: 2, pixels: 4 },
    );
    const stretched = { ...repeated, width: 5 };

    expect(areSpriteFingerprintsSimilar(first, repeated)).toBe(true);
    expect(areSpriteFingerprintsSimilar(first, stretched)).toBe(false);
  });

  it('keeps same-shaped sprites when their colors are different', () => {
    const pixels = makePixels(4, 2);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        fillPixel(pixels, 4, x, y, 40);
        const index = (y * 4 + x + 2) * 4;
        pixels[index] = 220;
        pixels[index + 1] = 30;
        pixels[index + 2] = 30;
        pixels[index + 3] = 255;
      }
    }

    const gray = createSpriteFingerprint(
      pixels,
      4,
      { x: 0, y: 0, width: 2, height: 2, pixels: 4 },
    );
    const red = createSpriteFingerprint(
      pixels,
      4,
      { x: 2, y: 0, width: 2, height: 2, pixels: 4 },
    );

    expect(areSpriteFingerprintsSimilar(gray, red)).toBe(false);
  });

  it('creates safe PNG base names', () => {
    expect(sanitizeLayerName(' 顶部/状态栏:* ', 'layer-1')).toBe('顶部-状态栏');
    expect(sanitizeLayerName('***', 'layer-1')).toBe('layer-1');
  });
});
