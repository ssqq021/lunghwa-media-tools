import { describe, expect, it } from 'vitest';
import { paintProtectionStroke } from './protectionMask';

describe('protection mask', () => {
  it('paints a continuous protected stroke', () => {
    const mask = new Uint8Array(7 * 3);
    paintProtectionStroke(mask, 7, 3, { x: 1, y: 1 }, { x: 5, y: 1 }, 1, true);

    expect(Array.from(mask.slice(7, 14))).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('erases an existing protected area', () => {
    const mask = new Uint8Array(5 * 5).fill(1);
    paintProtectionStroke(mask, 5, 5, { x: 2, y: 2 }, { x: 2, y: 2 }, 1, false);

    expect(mask[2 * 5 + 2]).toBe(0);
    expect(mask[0]).toBe(1);
  });
});
