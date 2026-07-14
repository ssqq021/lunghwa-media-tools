export const MIN_PREVIEW_ZOOM = 25;
export const MAX_PREVIEW_ZOOM = 300;

export function adjustPreviewZoom(current: number, direction: -1 | 1): number {
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, current + direction * 10));
}
