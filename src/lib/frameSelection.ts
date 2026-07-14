import type { ExtractedFrame, ProcessedFrame } from '../types';

export type FrameSelection = boolean[];

export type GeneratedFrameAssets = {
  frames: ExtractedFrame[];
  processed: ProcessedFrame[] | null;
};

export function createFrameSelection(frameCount: number): FrameSelection {
  return Array.from({ length: Math.max(0, Math.floor(frameCount)) }, () => true);
}

export function createIntervalFrameSelection(
  frameCount: number,
  skippedFrames: number,
): FrameSelection {
  const interval = Math.max(1, Math.floor(skippedFrames) + 1);
  return Array.from(
    { length: Math.max(0, Math.floor(frameCount)) },
    (_, index) => index % interval === 0,
  );
}

export function normalizeFrameSelection(
  selection: FrameSelection | null | undefined,
  frameCount: number,
): FrameSelection {
  const safeCount = Math.max(0, Math.floor(frameCount));
  return Array.from({ length: safeCount }, (_, index) => selection?.[index] !== false);
}

export function getSelectedFrameCount(
  selection: FrameSelection | null | undefined,
  frameCount: number,
): number {
  return normalizeFrameSelection(selection, frameCount).reduce(
    (count, enabled) => count + (enabled ? 1 : 0),
    0,
  );
}

export function getFrameSelectionSignature(
  selection: FrameSelection | null | undefined,
  frameCount: number,
): string {
  return normalizeFrameSelection(selection, frameCount)
    .map((enabled) => (enabled ? '1' : '0'))
    .join('');
}

export function filterFramesBySelection<T>(
  frames: T[],
  selection: FrameSelection | null | undefined,
): T[] {
  const normalized = normalizeFrameSelection(selection, frames.length);
  return frames.filter((_, index) => normalized[index]);
}

export function filterAssetsBySelection(
  assets: GeneratedFrameAssets,
  selection: FrameSelection | null | undefined,
): GeneratedFrameAssets {
  const normalized = normalizeFrameSelection(selection, assets.frames.length);
  return {
    frames: filterFramesBySelection(assets.frames, normalized),
    processed: assets.processed ? filterFramesBySelection(assets.processed, normalized) : null,
  };
}
