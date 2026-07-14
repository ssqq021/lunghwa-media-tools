import { describe, expect, it } from 'vitest';
import { adjustPreviewZoom } from './previewZoom';

describe('preview zoom', () => {
  it('changes zoom in fixed ten-percent steps', () => {
    expect(adjustPreviewZoom(100, 1)).toBe(110);
    expect(adjustPreviewZoom(100, -1)).toBe(90);
  });

  it('clamps zoom to the supported range', () => {
    expect(adjustPreviewZoom(300, 1)).toBe(300);
    expect(adjustPreviewZoom(25, -1)).toBe(25);
  });
});
