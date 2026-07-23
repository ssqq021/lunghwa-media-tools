import { describe, expect, it } from 'vitest';
import {
  assignShadowPassesToFrames,
  buildConnectedShadowMask,
  buildPolygonMask,
  estimateShadowBackgroundColor,
  replaceMaskedPixelsWithBackground,
  type ShadowSelection,
} from './shadow';

function createImageData(
  width: number,
  height: number,
  colors: Array<[number, number, number]>,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [index, color] of colors.entries()) {
    const offset = index * 4;
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = 255;
  }
  return { data, width, height } as ImageData;
}

describe('shadow helpers', () => {
  it('builds a mask from a closed polygon instead of its bounding rectangle', () => {
    const mask = buildPolygonMask(4, 4, [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
    ]);

    expect(Array.from(mask)).toEqual([
      1, 1, 1, 1,
      1, 1, 1, 0,
      1, 1, 0, 0,
      1, 0, 0, 0,
    ]);
  });

  it('selects only the sampled connected shadow inside the pen path', () => {
    const background: [number, number, number] = [240, 240, 240];
    const shadow: [number, number, number] = [120, 121, 123];
    const imageData = createImageData(5, 3, [
      background, background, background, background, background,
      background, shadow, shadow, background, shadow,
      background, background, background, background, background,
    ]);
    const selection: ShadowSelection = {
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 3 },
        { x: 0, y: 3 },
      ],
      seed: { x: 1, y: 1 },
      sample: { r: 120, g: 121, b: 123 },
      tolerance: 0,
    };

    expect(Array.from(buildConnectedShadowMask(imageData, 5, 3, selection))).toEqual([
      0, 0, 0, 0, 0,
      0, 1, 1, 0, 0,
      0, 0, 0, 0, 0,
    ]);
  });

  it('never selects matching pixels outside the custom path', () => {
    const shadow: [number, number, number] = [110, 110, 110];
    const imageData = createImageData(4, 2, [
      shadow, shadow, shadow, shadow,
      shadow, shadow, shadow, shadow,
    ]);
    const selection: ShadowSelection = {
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ],
      seed: { x: 0, y: 0 },
      sample: { r: 110, g: 110, b: 110 },
      tolerance: 0,
    };

    expect(Array.from(buildConnectedShadowMask(imageData, 4, 2, selection))).toEqual([
      1, 1, 0, 0,
      1, 1, 0, 0,
    ]);
  });

  it('replaces every recognized shadow pixel with the surrounding background color', () => {
    const background: [number, number, number] = [240, 241, 242];
    const shoe: [number, number, number] = [58, 54, 50];
    const shadow: [number, number, number] = [110, 111, 112];
    const imageData = createImageData(5, 4, [
      background, background, background, background, background,
      background, shoe, shoe, shoe, background,
      background, shadow, shadow, shadow, background,
      background, background, background, background, background,
    ]);
    const polygonMask = buildPolygonMask(5, 4, [
      { x: 0, y: 1 },
      { x: 5, y: 1 },
      { x: 5, y: 4 },
      { x: 0, y: 4 },
    ]);
    const shadowMask = new Uint8Array([
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      0, 0, 0, 0, 0,
    ]);

    const estimatedBackground = estimateShadowBackgroundColor(
      imageData,
      5,
      4,
      polygonMask,
    );
    expect(estimatedBackground).toEqual({ r: 240, g: 241, b: 242 });

    replaceMaskedPixelsWithBackground(imageData, shadowMask, estimatedBackground);

    expect(Array.from(imageData.data.slice(44, 56))).toEqual([
      240, 241, 242, 255,
      240, 241, 242, 255,
      240, 241, 242, 255,
    ]);
    expect(Array.from(imageData.data.slice(24, 36))).toEqual([
      58, 54, 50, 255,
      58, 54, 50, 255,
      58, 54, 50, 255,
    ]);
  });

  it('keeps one path while applying multiple sampled shadow colors', () => {
    const sharedPath = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 2 }];
    const firstColor: ShadowSelection = {
      points: sharedPath,
      seed: { x: 1, y: 1 },
      sample: { r: 120, g: 120, b: 120 },
      tolerance: 24,
    };
    const secondColor: ShadowSelection = {
      points: sharedPath,
      seed: { x: 2, y: 1 },
      sample: { r: 150, g: 150, b: 150 },
      tolerance: 32,
    };

    expect(assignShadowPassesToFrames(
      [0.1, 0.2, 0.3],
      [
        { scope: 'all', selection: firstColor },
        { scope: 'all', selection: secondColor },
      ],
    )).toEqual([
      [firstColor, secondColor],
      [firstColor, secondColor],
      [firstColor, secondColor],
    ]);
  });
});
