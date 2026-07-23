import type { RGBColor } from '../types';

export type ShadowPoint = {
  x: number;
  y: number;
};

export type ShadowSelection = {
  points: ShadowPoint[];
  seed: ShadowPoint;
  sample: RGBColor;
  tolerance: number;
};

export type ShadowPass =
  | {
      scope: 'all';
      selection: ShadowSelection;
    }
  | {
      scope: 'frame';
      time: number;
      selection: ShadowSelection;
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

function isPointInsidePolygon(x: number, y: number, points: ShadowPoint[]): boolean {
  let inside = false;

  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const currentPoint = points[current];
    const previousPoint = points[previous];
    const edgeX = currentPoint.x - previousPoint.x;
    const edgeY = currentPoint.y - previousPoint.y;
    const pointX = x - previousPoint.x;
    const pointY = y - previousPoint.y;
    const cross = edgeX * pointY - edgeY * pointX;
    const dot = pointX * edgeX + pointY * edgeY;
    if (
      Math.abs(cross) < 1e-7
      && dot >= 0
      && dot <= edgeX * edgeX + edgeY * edgeY
    ) {
      return true;
    }

    const intersects =
      currentPoint.y > y !== previousPoint.y > y
      && x < (
        ((previousPoint.x - currentPoint.x) * (y - currentPoint.y))
        / (previousPoint.y - currentPoint.y)
      ) + currentPoint.x;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

export function buildPolygonMask(
  width: number,
  height: number,
  points: ShadowPoint[],
): Uint8Array {
  const mask = new Uint8Array(Math.max(0, width * height));
  if (width <= 0 || height <= 0 || points.length < 3) {
    return mask;
  }

  const minX = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...points.map((point) => point.x))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point.y))));

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (isPointInsidePolygon(x + 0.5, y + 0.5, points)) {
        mask[y * width + x] = 1;
      }
    }
  }

  return mask;
}

export function buildConnectedShadowMask(
  imageData: ImageData,
  width: number,
  height: number,
  selection: ShadowSelection,
): Uint8Array {
  const polygonMask = buildPolygonMask(width, height, selection.points);
  const mask = new Uint8Array(polygonMask.length);
  if (!polygonMask.length || imageData.data.length < width * height * 4) {
    return mask;
  }

  const seedX = Math.max(0, Math.min(width - 1, Math.floor(selection.seed.x)));
  const seedY = Math.max(0, Math.min(height - 1, Math.floor(selection.seed.y)));
  const seedIndex = seedY * width + seedX;
  if (!polygonMask[seedIndex]) {
    return mask;
  }

  const tolerance = Math.max(0, selection.tolerance);
  const candidates = new Uint8Array(polygonMask.length);
  for (let index = 0; index < polygonMask.length; index += 1) {
    if (!polygonMask[index]) {
      continue;
    }

    const offset = index * 4;
    const distance = Math.max(
      Math.abs(imageData.data[offset] - selection.sample.r),
      Math.abs(imageData.data[offset + 1] - selection.sample.g),
      Math.abs(imageData.data[offset + 2] - selection.sample.b),
    );
    if (distance <= tolerance) {
      candidates[index] = 1;
    }
  }

  if (!candidates[seedIndex]) {
    return mask;
  }

  const queue = [seedIndex];
  mask[seedIndex] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }

        const nextX = x + offsetX;
        const nextY = y + offsetY;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
          continue;
        }

        const nextIndex = nextY * width + nextX;
        if (candidates[nextIndex] && !mask[nextIndex]) {
          mask[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }
    }
  }

  return mask;
}

export function estimateShadowBackgroundColor(
  imageData: ImageData,
  width: number,
  height: number,
  polygonMask: Uint8Array,
  fallback: RGBColor = { r: 0, g: 0, b: 0 },
): RGBColor {
  if (
    width <= 0
    || height <= 0
    || polygonMask.length !== width * height
    || imageData.data.length < width * height * 4
  ) {
    return fallback;
  }

  const sampled = new Uint8Array(polygonMask.length);
  const colorBuckets = new Map<string, {
    count: number;
    totalR: number;
    totalG: number;
    totalB: number;
  }>();

  const addSample = (index: number): void => {
    if (sampled[index]) {
      return;
    }

    const offset = index * 4;
    if (imageData.data[offset + 3] === 0) {
      return;
    }

    sampled[index] = 1;
    const r = imageData.data[offset];
    const g = imageData.data[offset + 1];
    const b = imageData.data[offset + 2];
    const key = `${Math.floor(r / 16)}-${Math.floor(g / 16)}-${Math.floor(b / 16)}`;
    const bucket = colorBuckets.get(key) ?? {
      count: 0,
      totalR: 0,
      totalG: 0,
      totalB: 0,
    };
    bucket.count += 1;
    bucket.totalR += r;
    bucket.totalG += g;
    bucket.totalB += b;
    colorBuckets.set(key, bucket);
  };

  for (let index = 0; index < polygonMask.length; index += 1) {
    if (!polygonMask[index]) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }

        const sampleX = x + offsetX;
        const sampleY = y + offsetY;
        if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) {
          continue;
        }

        const sampleIndex = sampleY * width + sampleX;
        if (!polygonMask[sampleIndex]) {
          addSample(sampleIndex);
        }
      }
    }
  }

  let bestBucket: {
    count: number;
    totalR: number;
    totalG: number;
    totalB: number;
  } | null = null;
  for (const bucket of colorBuckets.values()) {
    if (!bestBucket || bucket.count > bestBucket.count) {
      bestBucket = bucket;
    }
  }

  if (!bestBucket) {
    return fallback;
  }

  return {
    r: Math.round(bestBucket.totalR / bestBucket.count),
    g: Math.round(bestBucket.totalG / bestBucket.count),
    b: Math.round(bestBucket.totalB / bestBucket.count),
  };
}

export function replaceMaskedPixelsWithBackground(
  imageData: ImageData,
  mask: Uint8Array,
  background: RGBColor,
): ImageData {
  const pixelCount = Math.min(mask.length, Math.floor(imageData.data.length / 4));
  for (let index = 0; index < pixelCount; index += 1) {
    if (!mask[index]) {
      continue;
    }

    const offset = index * 4;
    imageData.data[offset] = background.r;
    imageData.data[offset + 1] = background.g;
    imageData.data[offset + 2] = background.b;
  }

  return imageData;
}

export function assignShadowPassesToFrames(
  frameTimes: number[],
  passes: ShadowPass[],
): ShadowSelection[][] {
  const assignments = frameTimes.map(() => [] as ShadowSelection[]);
  if (!frameTimes.length) {
    return assignments;
  }

  const firstTime = frameTimes[0];
  const lastTime = frameTimes[frameTimes.length - 1];
  for (const pass of passes) {
    if (pass.scope === 'all') {
      for (const frameSelections of assignments) {
        frameSelections.push(pass.selection);
      }
      continue;
    }

    if (pass.time < firstTime || pass.time > lastTime) {
      continue;
    }

    assignments[getNearestFrameIndex(frameTimes, pass.time)].push(pass.selection);
  }

  return assignments;
}

export function removeShadowFromCanvas(
  source: HTMLCanvasElement,
  selection: ShadowSelection,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('当前浏览器不支持 Canvas 2D，无法去阴影。');
  }

  context.drawImage(source, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const polygonMask = buildPolygonMask(
    canvas.width,
    canvas.height,
    selection.points,
  );
  const mask = buildConnectedShadowMask(
    imageData,
    canvas.width,
    canvas.height,
    selection,
  );
  const background = estimateShadowBackgroundColor(
    imageData,
    canvas.width,
    canvas.height,
    polygonMask,
    selection.sample,
  );
  replaceMaskedPixelsWithBackground(imageData, mask, background);
  context.putImageData(imageData, 0, 0);
  return canvas;
}
