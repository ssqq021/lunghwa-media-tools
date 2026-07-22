import { describe, expect, it } from 'vitest';
import { getLayoutMetrics, getSheetAppearance, getVisibleBoundsFromPixels } from './sheet';
import type { SheetOptions, VideoMeta } from '../types';

const meta: VideoMeta = {
  duration: 12,
  width: 1920,
  height: 1080,
  name: 'sample.mp4',
};

const options: SheetOptions = {
  columns: 4,
  gap: 8,
  backgroundColor: '#ffffff',
};

describe('getLayoutMetrics', () => {
  it('finds the tight visible range across transparent pixels', () => {
    const pixels = new Uint8ClampedArray(5 * 4 * 4);
    pixels[(1 * 5 + 2) * 4 + 3] = 255;
    pixels[(3 * 5 + 4) * 4 + 3] = 120;

    expect(getVisibleBoundsFromPixels(pixels, 5, 4)).toEqual({
      x: 2,
      y: 1,
      width: 3,
      height: 3,
    });
  });

  it('calculates sheet size without timestamps', () => {
    expect(getLayoutMetrics(meta, 12, options, false)).toEqual({
      rows: 3,
      canvasWidth: 1304,
      canvasHeight: 556,
      frameWidth: 320,
      frameHeight: 180,
      labelBlockHeight: 0,
    });
  });

  it('adds extra height when timestamps are enabled', () => {
    expect(getLayoutMetrics(meta, 12, options, true)).toEqual({
      rows: 3,
      canvasWidth: 1304,
      canvasHeight: 706,
      frameWidth: 320,
      frameHeight: 180,
      labelBlockHeight: 30,
    });
  });

  it('recalculates rows and final PNG size when the export column count changes', () => {
    expect(
      getLayoutMetrics(meta, 12, {
        ...options,
        columns: 3,
      }, false),
    ).toEqual({
      rows: 4,
      canvasWidth: 976,
      canvasHeight: 744,
      frameWidth: 320,
      frameHeight: 180,
      labelBlockHeight: 0,
    });
  });

  it('uses a transparent appearance for transparent exports', () => {
    expect(getSheetAppearance(true)).toEqual({
      transparentBackground: true,
      showCardBackground: false,
    });
  });

  it('uses exact sprite frame size when export preset is set', () => {
    expect(
      getLayoutMetrics(meta, 12, {
        ...options,
        frameSize: 64,
      }, false),
    ).toEqual({
      rows: 3,
      canvasWidth: 280,
      canvasHeight: 208,
      frameWidth: 64,
      frameHeight: 64,
      labelBlockHeight: 0,
    });
  });
});
