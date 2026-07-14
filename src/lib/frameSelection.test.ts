import { describe, expect, it } from 'vitest';
import type { ExtractedFrame, ProcessedFrame } from '../types';
import {
  createFrameSelection,
  createIntervalFrameSelection,
  filterAssetsBySelection,
  filterFramesBySelection,
  getFrameSelectionSignature,
  getSelectedFrameCount,
  normalizeFrameSelection,
} from './frameSelection';

function createFrame(label: string): ExtractedFrame {
  return {
    image: { width: 64, height: 64 } as HTMLCanvasElement,
    time: Number(label),
    label,
  };
}

function createProcessedFrame(label: string): ProcessedFrame {
  return {
    ...createFrame(label),
    processedImage: { width: 64, height: 64 } as HTMLCanvasElement,
    maskImage: { width: 64, height: 64 } as HTMLCanvasElement,
  };
}

describe('frame selection helpers', () => {
  it('creates an all-enabled selection by default', () => {
    expect(createFrameSelection(3)).toEqual([true, true, true]);
  });

  it('selects one frame after skipping one frame', () => {
    expect(createIntervalFrameSelection(7, 1)).toEqual([
      true, false, true, false, true, false, true,
    ]);
  });

  it('selects one frame after skipping two frames', () => {
    expect(createIntervalFrameSelection(8, 2)).toEqual([
      true, false, false, true, false, false, true, false,
    ]);
  });

  it('normalizes missing or short selections to enabled', () => {
    expect(normalizeFrameSelection([true, false], 4)).toEqual([true, false, true, true]);
  });

  it('counts enabled frames correctly', () => {
    expect(getSelectedFrameCount([true, false, true, false], 4)).toBe(2);
  });

  it('builds a stable selection signature for preview invalidation', () => {
    expect(getFrameSelectionSignature([true, false, true], 3)).toBe('101');
  });

  it('filters plain frames by selection order', () => {
    const frames = [createFrame('0'), createFrame('1'), createFrame('2')];
    const filtered = filterFramesBySelection(frames, [true, false, true]);

    expect(filtered.map((frame) => frame.label)).toEqual(['0', '2']);
  });

  it('filters extracted and processed frames with the same selection mask', () => {
    const frames = [createFrame('0'), createFrame('1'), createFrame('2')];
    const processed: ProcessedFrame[] = [
      createProcessedFrame('0'),
      createProcessedFrame('1'),
      createProcessedFrame('2'),
    ];

    const filtered = filterAssetsBySelection({ frames, processed }, [false, true, true]);

    expect(filtered.frames.map((frame) => frame.label)).toEqual(['1', '2']);
    expect(filtered.processed?.map((frame) => frame.label)).toEqual(['1', '2']);
  });
});
