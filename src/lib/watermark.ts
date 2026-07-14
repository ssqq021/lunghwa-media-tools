import type { CropBounds } from '../types';

export type WatermarkPass =
  | {
      scope: 'all';
      rect: CropBounds;
    }
  | {
      scope: 'frame';
      time: number;
      rect: CropBounds;
    };

function getNearestFrameIndex(frameTimes: number[], targetTime: number): number {
  let nearestIndex = 0;
  let nearestDistance = Math.abs(frameTimes[0] - targetTime);

  for (let index = 1; index < frameTimes.length; index += 1) {
    const distance = Math.abs(frameTimes[index] - targetTime);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }

  return nearestIndex;
}

export function getNearestFrameTime(frameTimes: number[], targetTime: number): number | null {
  if (!frameTimes.length) {
    return null;
  }

  return frameTimes[getNearestFrameIndex(frameTimes, targetTime)];
}

export function assignWatermarkPassesToFrames(
  frameTimes: number[],
  passes: WatermarkPass[],
): CropBounds[][] {
  const assignments = frameTimes.map(() => [] as CropBounds[]);
  if (!frameTimes.length) {
    return assignments;
  }

  const firstTime = frameTimes[0];
  const lastTime = frameTimes[frameTimes.length - 1];
  for (const pass of passes) {
    if (pass.scope === 'all') {
      for (const frameRects of assignments) {
        frameRects.push(pass.rect);
      }
      continue;
    }

    if (pass.time < firstTime || pass.time > lastTime) {
      continue;
    }

    assignments[getNearestFrameIndex(frameTimes, pass.time)].push(pass.rect);
  }

  return assignments;
}

export function buildWatermarkMask(
  width: number,
  height: number,
  rect: CropBounds | null | undefined,
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, width * height));
  if (!rect || width <= 0 || height <= 0) {
    return mask;
  }

  const x0 = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
  const x1 = Math.max(0, Math.min(width - 1, Math.floor(rect.x + rect.width - 1)));
  const y1 = Math.max(0, Math.min(height - 1, Math.floor(rect.y + rect.height - 1)));

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      mask[y * width + x] = 1;
    }
  }

  return mask;
}

export function countMaskPixels(mask: Uint8Array): number {
  return mask.reduce((count, value) => count + (value ? 1 : 0), 0);
}

export function inpaintImageDataWithMask(
  imageData: ImageData,
  mask: Uint8Array,
  width: number,
  height: number,
): ImageData {
  const source = imageData.data;
  const output = new Uint8ClampedArray(source);
  const known = new Uint8Array(mask.length);

  for (let index = 0; index < mask.length; index += 1) {
    known[index] = mask[index] ? 0 : 1;
  }

  let frontier: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);
    let hasKnownNeighbor = false;

    for (let yy = -1; yy <= 1 && !hasKnownNeighbor; yy += 1) {
      for (let xx = -1; xx <= 1; xx += 1) {
        if (xx === 0 && yy === 0) {
          continue;
        }

        const nx = x + xx;
        const ny = y + yy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue;
        }

        if (known[ny * width + nx]) {
          hasKnownNeighbor = true;
          break;
        }
      }
    }

    if (hasKnownNeighbor) {
      frontier.push(index);
    }
  }

  const queued = new Uint8Array(mask.length);
  for (const index of frontier) {
    queued[index] = 1;
  }

  while (frontier.length) {
    const nextFrontier: number[] = [];

    for (const index of frontier) {
      const x = index % width;
      const y = Math.floor(index / width);
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let count = 0;

      for (let yy = -1; yy <= 1; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          if (xx === 0 && yy === 0) {
            continue;
          }

          const nx = x + xx;
          const ny = y + yy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }

          const neighborIndex = ny * width + nx;
          if (!known[neighborIndex]) {
            continue;
          }

          const offset = neighborIndex * 4;
          sumR += output[offset];
          sumG += output[offset + 1];
          sumB += output[offset + 2];
          sumA += output[offset + 3];
          count += 1;
        }
      }

      if (!count) {
        continue;
      }

      const offset = index * 4;
      output[offset] = Math.round(sumR / count);
      output[offset + 1] = Math.round(sumG / count);
      output[offset + 2] = Math.round(sumB / count);
      output[offset + 3] = Math.round(sumA / count);
      known[index] = 1;

      for (let yy = -1; yy <= 1; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          if (xx === 0 && yy === 0) {
            continue;
          }

          const nx = x + xx;
          const ny = y + yy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }

          const neighborIndex = ny * width + nx;
          if (mask[neighborIndex] && !known[neighborIndex] && !queued[neighborIndex]) {
            queued[neighborIndex] = 1;
            nextFrontier.push(neighborIndex);
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  imageData.data.set(output);
  return imageData;
}

export function removeWatermarkFromCanvas(
  source: HTMLCanvasElement,
  rect: CropBounds,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D，无法去水印。');
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const mask = buildWatermarkMask(canvas.width, canvas.height, rect);
  inpaintImageDataWithMask(imageData, mask, canvas.width, canvas.height);
  context.putImageData(imageData, 0, 0);
  return canvas;
}
