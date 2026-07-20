export type AlphaBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
};

export type SpriteFingerprint = {
  width: number;
  height: number;
  samples: Uint8Array;
};

export function sanitizeLayerName(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return cleaned || fallback;
}

export function findAlphaBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 8,
): AlphaBounds | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let pixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] <= threshold) {
        continue;
      }

      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      pixels += 1;
    }
  }

  return right < left
    ? null
    : {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
        pixels,
      };
}

export function findAlphaComponents(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  minimumPixels: number,
  threshold = 8,
): AlphaBounds[] {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components: AlphaBounds[] = [];

  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || rgba[start * 4 + 3] <= threshold) {
      continue;
    }

    let head = 0;
    let tail = 0;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    let pixels = 0;

    queue[tail] = start;
    tail += 1;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      pixels += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);

      const neighbours = [
        x > 0 ? index - 1 : -1,
        x + 1 < width ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y + 1 < height ? index + width : -1,
      ];

      for (const next of neighbours) {
        if (next < 0 || visited[next] || rgba[next * 4 + 3] <= threshold) {
          continue;
        }

        visited[next] = 1;
        queue[tail] = next;
        tail += 1;
      }
    }

    if (pixels >= minimumPixels) {
      components.push({
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
        pixels,
      });
    }
  }

  return components.sort((a, b) => b.pixels - a.pixels);
}

export function createSpriteFingerprint(
  rgba: Uint8ClampedArray,
  width: number,
  bounds: AlphaBounds,
  sampleSize = 12,
): SpriteFingerprint {
  const samples = new Uint8Array(sampleSize * sampleSize * 4);

  for (let sampleY = 0; sampleY < sampleSize; sampleY += 1) {
    for (let sampleX = 0; sampleX < sampleSize; sampleX += 1) {
      const sourceX =
        bounds.x +
        Math.min(
          bounds.width - 1,
          Math.floor(((sampleX + 0.5) / sampleSize) * bounds.width),
        );
      const sourceY =
        bounds.y +
        Math.min(
          bounds.height - 1,
          Math.floor(((sampleY + 0.5) / sampleSize) * bounds.height),
        );
      const sourceIndex = (sourceY * width + sourceX) * 4;
      const targetIndex = (sampleY * sampleSize + sampleX) * 4;
      const alpha = rgba[sourceIndex + 3];

      samples[targetIndex] = alpha > 8 ? rgba[sourceIndex] : 0;
      samples[targetIndex + 1] = alpha > 8 ? rgba[sourceIndex + 1] : 0;
      samples[targetIndex + 2] = alpha > 8 ? rgba[sourceIndex + 2] : 0;
      samples[targetIndex + 3] = alpha;
    }
  }

  return {
    width: bounds.width,
    height: bounds.height,
    samples,
  };
}

export function areSpriteFingerprintsSimilar(
  left: SpriteFingerprint,
  right: SpriteFingerprint,
  tolerance = 18,
): boolean {
  const widthRatio = Math.min(left.width, right.width) / Math.max(left.width, right.width);
  const heightRatio = Math.min(left.height, right.height) / Math.max(left.height, right.height);

  if (widthRatio < 0.82 || heightRatio < 0.82 || left.samples.length !== right.samples.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.samples.length; index += 1) {
    difference += Math.abs(left.samples[index] - right.samples[index]);
  }

  return difference / left.samples.length <= tolerance;
}
