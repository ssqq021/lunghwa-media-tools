import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDespill,
  applyColorKey,
  applyColorKeySequence,
  computeColorDistance,
  getOpacityForDistance,
} from './chromaKey';

class FakeCanvas {
  width = 0;
  height = 0;
  data = new Uint8ClampedArray();

  getContext(): CanvasRenderingContext2D {
    const canvas = this;

    return {
      createImageData(width: number, height: number) {
        return {
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        } as ImageData;
      },
      getImageData() {
        return {
          data: new Uint8ClampedArray(canvas.data),
          width: canvas.width,
          height: canvas.height,
        } as ImageData;
      },
      putImageData(imageData: ImageData) {
        canvas.data = new Uint8ClampedArray(imageData.data);
      },
      drawImage(source: FakeCanvas) {
        canvas.width = source.width;
        canvas.height = source.height;
        canvas.data = new Uint8ClampedArray(source.data);
      },
    } as unknown as CanvasRenderingContext2D;
  }
}

function createCanvas(width: number, height: number, pixels: number[]): HTMLCanvasElement {
  const canvas = new FakeCanvas() as unknown as HTMLCanvasElement & FakeCanvas;
  canvas.width = width;
  canvas.height = height;
  canvas.data = Uint8ClampedArray.from(pixels);
  return canvas;
}

function readPixel(canvas: HTMLCanvasElement, x = 0, y = 0): [number, number, number, number] {
  const fakeCanvas = canvas as HTMLCanvasElement & FakeCanvas;
  const offset = (y * fakeCanvas.width + x) * 4;

  return [
    fakeCanvas.data[offset],
    fakeCanvas.data[offset + 1],
    fakeCanvas.data[offset + 2],
    fakeCanvas.data[offset + 3],
  ];
}

describe('chroma key helpers', () => {
  const originalCreateElement = document.createElement.bind(document);

  beforeEach(() => {
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName.toLowerCase() === 'canvas') {
        return new FakeCanvas() as unknown as HTMLElement;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats the sampled color as transparent', () => {
    const distance = computeColorDistance(
      { r: 200, g: 192, b: 231 },
      { r: 200, g: 192, b: 231 },
      'enhanced',
    );

    expect(getOpacityForDistance(distance, 20, 10, 'enhanced', true)).toBe(0);
  });

  it('keeps distant colors opaque', () => {
    const distance = computeColorDistance(
      { r: 24, g: 28, b: 40 },
      { r: 200, g: 192, b: 231 },
      'classic',
    );

    expect(getOpacityForDistance(distance, 20, 10, 'classic', true)).toBe(1);
  });

  it('softness creates a smooth transition on the edge', () => {
    expect(getOpacityForDistance(25, 20, 20, 'enhanced', true)).toBeGreaterThan(0);
    expect(getOpacityForDistance(25, 20, 20, 'enhanced', true)).toBeLessThan(1);
  });

  it('despill reduces the dominant background channel near transparent edges', () => {
    const adjusted = applyDespill(
      { r: 70, g: 180, b: 75 },
      { r: 90, g: 220, b: 80 },
      0.35,
      80,
    );

    expect(adjusted.g).toBeLessThan(180);
  });

  it('preserves source alpha when applying another color key pass', () => {
    const source = createCanvas(1, 1, [80, 120, 160, 128]);
    const result = applyColorKey(source, {
      sample: { x: 0, y: 0, hex: '#000000', rgb: { r: 0, g: 0, b: 0 } },
      tolerance: 0,
      softness: 0,
      despill: 0,
      sampleRadius: 0,
      edgeRadius: 0,
      smoothing: false,
      despillEnabled: false,
      algorithm: 'classic',
    });

    expect(readPixel(result.image)[3]).toBe(128);
  });

  it('supports multi-pass color keying without reviving removed pixels', () => {
    const source = createCanvas(2, 1, [
      0, 255, 0, 255,
      255, 0, 255, 255,
    ]);

    const result = applyColorKeySequence(source, [
      {
        sample: { x: 0, y: 0, hex: '#00ff00', rgb: { r: 0, g: 255, b: 0 } },
        tolerance: 0,
        softness: 0,
        despill: 0,
        sampleRadius: 0,
        edgeRadius: 0,
        smoothing: false,
        despillEnabled: false,
        algorithm: 'classic',
      },
      {
        sample: { x: 1, y: 0, hex: '#ff00ff', rgb: { r: 255, g: 0, b: 255 } },
        tolerance: 0,
        softness: 0,
        despill: 0,
        sampleRadius: 0,
        edgeRadius: 0,
        smoothing: false,
        despillEnabled: false,
        algorithm: 'classic',
      },
    ]);

    expect(readPixel(result.image, 0, 0)[3]).toBe(0);
    expect(readPixel(result.image, 1, 0)[3]).toBe(0);
  });
});
