import { describe, expect, it } from 'vitest';
import {
  assignWatermarkPassesToFrames,
  buildWatermarkMask,
  countMaskPixels,
  getNearestFrameTime,
  inpaintImageDataWithMask,
} from './watermark';

describe('watermark helpers', () => {
  it('builds a clamped rectangular mask', () => {
    const mask = buildWatermarkMask(4, 3, {
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    });

    expect(Array.from(mask)).toEqual([
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
    ]);
    expect(countMaskPixels(mask)).toBe(4);
  });

  it('inpaints masked pixels from surrounding known neighbors', () => {
    const imageData = {
      data: new Uint8ClampedArray([
        10, 0, 0, 255,
        20, 0, 0, 255,
        30, 0, 0, 255,
        40, 0, 0, 255,
        0, 0, 0, 0,
        60, 0, 0, 255,
        70, 0, 0, 255,
        80, 0, 0, 255,
        90, 0, 0, 255,
      ]),
    } as ImageData;
    const mask = buildWatermarkMask(3, 3, {
      x: 1,
      y: 1,
      width: 1,
      height: 1,
    });

    const result = inpaintImageDataWithMask(imageData, mask, 3, 3);
    const centerOffset = (1 * 3 + 1) * 4;

    expect(result.data[centerOffset]).toBe(50);
    expect(result.data[centerOffset + 3]).toBe(255);
  });

  it('snaps a preview time to the nearest extracted frame', () => {
    expect(getNearestFrameTime([0.1, 0.2, 0.3], 0.24)).toBe(0.2);
    expect(getNearestFrameTime([], 0.24)).toBeNull();
  });

  it('assigns each watermark pass only to its nearest frame', () => {
    const firstRect = { x: 1, y: 2, width: 3, height: 4 };
    const secondRect = { x: 5, y: 6, width: 7, height: 8 };
    const assignments = assignWatermarkPassesToFrames(
      [0.1, 0.2, 0.3],
      [
        { scope: 'frame', time: 0.19, rect: firstRect },
        { scope: 'frame', time: 0.21, rect: secondRect },
        { scope: 'frame', time: 0.8, rect: firstRect },
      ],
    );

    expect(assignments).toEqual([[], [firstRect, secondRect], []]);
  });

  it('assigns an all-frame watermark pass to every frame', () => {
    const allFramesRect = { x: 1, y: 2, width: 3, height: 4 };
    const currentFrameRect = { x: 5, y: 6, width: 7, height: 8 };
    const assignments = assignWatermarkPassesToFrames(
      [0.1, 0.2, 0.3],
      [
        { scope: 'all', rect: allFramesRect },
        { scope: 'frame', time: 0.21, rect: currentFrameRect },
      ],
    );

    expect(assignments).toEqual([
      [allFramesRect],
      [allFramesRect, currentFrameRect],
      [allFramesRect],
    ]);
  });
});
