import type {
  ColorKeyOptions,
  ColorSample,
  ExtractedFrame,
  KeyAlgorithm,
  ProcessedFrame,
  RGBColor,
} from '../types';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function channelToHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function rgbToHex(rgb: RGBColor): string {
  return `#${channelToHex(rgb.r)}${channelToHex(rgb.g)}${channelToHex(rgb.b)}`;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法复制画布。');
  }

  context.drawImage(source, 0, 0);
  return canvas;
}

function createMaskFromAlpha(source: HTMLCanvasElement): HTMLCanvasElement {
  const sourceContext = source.getContext('2d');
  if (!sourceContext) {
    throw new Error('无法读取透明遮罩。');
  }

  const sourceImageData = sourceContext.getImageData(0, 0, source.width, source.height);
  const sourcePixels = sourceImageData.data;
  const maskCanvas = createCanvas(source.width, source.height);
  const maskContext = maskCanvas.getContext('2d');

  if (!maskContext) {
    throw new Error('无法创建透明遮罩。');
  }

  const maskImageData = maskContext.createImageData(source.width, source.height);
  const maskPixels = maskImageData.data;

  for (let index = 0; index < sourcePixels.length; index += 4) {
    const alpha = sourcePixels[index + 3];
    maskPixels[index] = alpha;
    maskPixels[index + 1] = alpha;
    maskPixels[index + 2] = alpha;
    maskPixels[index + 3] = 255;
  }

  maskContext.putImageData(maskImageData, 0, 0);
  return maskCanvas;
}

function getDominantChannel(sample: RGBColor): 'r' | 'g' | 'b' {
  if (sample.r >= sample.g && sample.r >= sample.b) {
    return 'r';
  }

  if (sample.g >= sample.r && sample.g >= sample.b) {
    return 'g';
  }

  return 'b';
}

export function computeColorDistance(
  pixel: RGBColor,
  sample: RGBColor,
  algorithm: KeyAlgorithm,
): number {
  const dr = pixel.r - sample.r;
  const dg = pixel.g - sample.g;
  const db = pixel.b - sample.b;

  if (algorithm === 'classic') {
    return Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
  }

  return Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
}

export function getOpacityForDistance(
  distance: number,
  tolerance: number,
  softness: number,
  algorithm: KeyAlgorithm,
  smoothing: boolean,
): number {
  const threshold = Math.max(0, tolerance);
  const feather = smoothing ? Math.max(0, softness) : 0;

  if (distance <= threshold) {
    return 0;
  }

  if (feather <= 0) {
    return 1;
  }

  if (distance >= threshold + feather) {
    return 1;
  }

  const progress = (distance - threshold) / feather;
  if (algorithm === 'classic') {
    return progress;
  }

  return progress * progress * (3 - 2 * progress);
}

export function applyDespill(
  pixel: RGBColor,
  sample: RGBColor,
  opacity: number,
  despill: number,
): RGBColor {
  const normalizedDespill = clamp(despill, 0, 100) / 100;
  const reductionFactor = (1 - opacity) * normalizedDespill;

  if (reductionFactor <= 0) {
    return pixel;
  }

  const dominant = getDominantChannel(sample);
  const output = { ...pixel };

  if (dominant === 'g' && output.g > Math.max(output.r, output.b)) {
    output.g -= (output.g - Math.max(output.r, output.b)) * reductionFactor;
  }

  if (dominant === 'r' && output.r > Math.max(output.g, output.b)) {
    output.r -= (output.r - Math.max(output.g, output.b)) * reductionFactor;
  }

  if (dominant === 'b' && output.b > Math.max(output.r, output.g)) {
    output.b -= (output.b - Math.max(output.r, output.g)) * reductionFactor;
  }

  return {
    r: clamp(Math.round(output.r), 0, 255),
    g: clamp(Math.round(output.g), 0, 255),
    b: clamp(Math.round(output.b), 0, 255),
  };
}

export function sampleCanvasColor(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  radius: number,
): ColorSample {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法读取参考帧像素数据。');
  }

  const clampedX = clamp(Math.round(x), 0, canvas.width - 1);
  const clampedY = clamp(Math.round(y), 0, canvas.height - 1);
  const sampleRadius = Math.max(0, Math.round(radius));
  const startX = clamp(clampedX - sampleRadius, 0, canvas.width - 1);
  const startY = clamp(clampedY - sampleRadius, 0, canvas.height - 1);
  const endX = clamp(clampedX + sampleRadius, 0, canvas.width - 1);
  const endY = clamp(clampedY + sampleRadius, 0, canvas.height - 1);
  const width = endX - startX + 1;
  const height = endY - startY + 1;
  const imageData = context.getImageData(startX, startY, width, height).data;

  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let samples = 0;

  for (let index = 0; index < imageData.length; index += 4) {
    totalR += imageData[index];
    totalG += imageData[index + 1];
    totalB += imageData[index + 2];
    samples += 1;
  }

  const rgb = {
    r: Math.round(totalR / Math.max(samples, 1)),
    g: Math.round(totalG / Math.max(samples, 1)),
    b: Math.round(totalB / Math.max(samples, 1)),
  };

  return {
    x: clampedX,
    y: clampedY,
    hex: rgbToHex(rgb),
    rgb,
  };
}

export function applyColorKey(
  source: HTMLCanvasElement,
  options: ColorKeyOptions,
  protectionMask?: Uint8Array | null,
): {
  image: HTMLCanvasElement;
  mask: HTMLCanvasElement;
} {
  const sourceContext = source.getContext('2d');
  if (!sourceContext) {
    throw new Error('无法读取原始帧图像。');
  }

  const sourceImageData = sourceContext.getImageData(0, 0, source.width, source.height);
  const sourcePixels = sourceImageData.data;
  const outputCanvas = createCanvas(source.width, source.height);
  const maskCanvas = createCanvas(source.width, source.height);
  const outputContext = outputCanvas.getContext('2d');
  const maskContext = maskCanvas.getContext('2d');

  if (!outputContext || !maskContext) {
    throw new Error('无法创建抠像预览画布。');
  }

  const outputImageData = outputContext.createImageData(source.width, source.height);
  const maskImageData = maskContext.createImageData(source.width, source.height);
  const outputPixels = outputImageData.data;
  const maskPixels = maskImageData.data;

  for (let index = 0; index < sourcePixels.length; index += 4) {
    const sourceAlpha = sourcePixels[index + 3];
    if (protectionMask?.[index / 4]) {
      outputPixels[index] = sourcePixels[index];
      outputPixels[index + 1] = sourcePixels[index + 1];
      outputPixels[index + 2] = sourcePixels[index + 2];
      outputPixels[index + 3] = sourceAlpha;
      maskPixels[index] = sourceAlpha;
      maskPixels[index + 1] = sourceAlpha;
      maskPixels[index + 2] = sourceAlpha;
      maskPixels[index + 3] = 255;
      continue;
    }

    const pixel = {
      r: sourcePixels[index],
      g: sourcePixels[index + 1],
      b: sourcePixels[index + 2],
    };
    const distance = computeColorDistance(pixel, options.sample.rgb, options.algorithm);
    const opacity = getOpacityForDistance(
      distance,
      options.tolerance,
      options.softness,
      options.algorithm,
      options.smoothing,
    );
    const edgeWeight =
      options.edgeRadius <= 0
        ? 1
        : clamp((options.tolerance + options.edgeRadius - distance) / options.edgeRadius, 0, 1);
    const adjustedPixel =
      options.despillEnabled && options.despill > 0
        ? applyDespill(pixel, options.sample.rgb, opacity, options.despill * edgeWeight)
        : pixel;
    const alpha = Math.round((sourceAlpha * opacity));

    outputPixels[index] = adjustedPixel.r;
    outputPixels[index + 1] = adjustedPixel.g;
    outputPixels[index + 2] = adjustedPixel.b;
    outputPixels[index + 3] = alpha;

    maskPixels[index] = alpha;
    maskPixels[index + 1] = alpha;
    maskPixels[index + 2] = alpha;
    maskPixels[index + 3] = 255;
  }

  outputContext.putImageData(outputImageData, 0, 0);
  maskContext.putImageData(maskImageData, 0, 0);

  return {
    image: outputCanvas,
    mask: maskCanvas,
  };
}

export function applyColorKeySequence(
  source: HTMLCanvasElement,
  optionsList: ColorKeyOptions[],
  protectionMask?: Uint8Array | null,
): {
  image: HTMLCanvasElement;
  mask: HTMLCanvasElement;
} {
  if (!optionsList.length) {
    return {
      image: cloneCanvas(source),
      mask: createMaskFromAlpha(source),
    };
  }

  let current = source;
  let latest = applyColorKey(current, optionsList[0], protectionMask);
  current = latest.image;

  for (let index = 1; index < optionsList.length; index += 1) {
    latest = applyColorKey(current, optionsList[index], protectionMask);
    current = latest.image;
  }

  return latest;
}

export function processExtractedFrame(
  frame: ExtractedFrame,
  options: ColorKeyOptions,
  protectionMask?: Uint8Array | null,
): ProcessedFrame {
  const processed = applyColorKey(frame.image, options, protectionMask);

  return {
    ...frame,
    processedImage: processed.image,
    maskImage: processed.mask,
  };
}

export function processExtractedFrameWithSequence(
  frame: ExtractedFrame,
  optionsList: ColorKeyOptions[],
  protectionMask?: Uint8Array | null,
): ProcessedFrame {
  const processed = applyColorKeySequence(frame.image, optionsList, protectionMask);

  return {
    ...frame,
    processedImage: processed.image,
    maskImage: processed.mask,
  };
}
