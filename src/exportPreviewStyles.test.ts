import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('final PNG preview styles', () => {
  it('keeps the image at its actual pixel dimensions', () => {
    const styles = readFileSync(resolve('src/styles.css'), 'utf8');
    const rule = styles.match(/\.export-preview-card__image\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toContain('width: auto;');
    expect(rule).toContain('height: auto;');
    expect(rule).toContain('max-width: none;');
  });
});
