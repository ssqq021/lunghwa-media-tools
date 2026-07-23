import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  MAX_RETAINED_CANVAS_BYTES,
  assertCanvasSize,
  assertEstimatedCanvasBytes,
  assertFrameMemoryBudget,
  estimateCanvasBytes,
  fitDimensionsWithinSide,
} from './resourceBudget';

describe('resource budget', () => {
  it('rejects the retained surfaces for 180 chroma-keyed 1080p frames', () => {
    expect(() => assertFrameMemoryBudget(1920, 1080, 180, 3)).toThrow(/预计占用/);
  });

  it('accepts a typical 256px sprite workflow', () => {
    expect(() => assertFrameMemoryBudget(256, 256, 180, 3)).not.toThrow();
    expect(estimateCanvasBytes(256, 256, 180, 3)).toBeLessThan(MAX_RETAINED_CANVAS_BYTES);
  });

  it('allows an estimated 1115 MiB task within the 2048 MiB budget', () => {
    expect(MAX_RETAINED_CANVAS_BYTES).toBe(2048 * 1024 * 1024);
    expect(() => assertEstimatedCanvasBytes(1115 * 1024 * 1024, '抽帧任务')).not.toThrow();
  });

  it('rejects a mixed batch whose summed canvas bytes exceed the budget', () => {
    expect(() => assertEstimatedCanvasBytes(MAX_RETAINED_CANVAS_BYTES + 1, '图片列表')).toThrow(
      /图片列表预计占用/,
    );
  });

  it('rejects a canvas whose side or total pixels exceed the portable limit', () => {
    expect(() => assertCanvasSize(MAX_CANVAS_SIDE + 1, 1, '测试画布')).toThrow(/尺寸/);
    expect(() => assertCanvasSize(8192, 8192, '测试画布')).not.toThrow();
    expect(() => assertCanvasSize(8192, 8193, '测试画布')).toThrow(/尺寸|像素/);
    expect(8192 * 8192).toBe(MAX_CANVAS_PIXELS);
  });

  it('keeps aspect ratio while fitting both sides under a limit', () => {
    expect(fitDimensionsWithinSide(8192, 16_384, 8192)).toEqual({
      width: 4096,
      height: 8192,
    });
    expect(fitDimensionsWithinSide(16_384, 8192, 8192)).toEqual({
      width: 8192,
      height: 4096,
    });
  });
});
