import picaFactory from 'pica';
import type {
  ExtractedFrame,
  LayoutMetrics,
  RenderResult,
  SheetAppearance,
  SheetOptions,
  VideoMeta,
} from '../types';
import { assertCanvasSize } from './resourceBudget';

const MAX_FRAME_WIDTH = 320;
const LABEL_FONT_SIZE = 16;
const LABEL_BLOCK_HEIGHT = 30;
const CARD_PADDING = 10;
const pica = picaFactory();

type PixelBounds = { x: number; y: number; width: number; height: number };

export function getVisibleBoundsFromPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): PixelBounds | null {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function getSharedVisibleBounds(frames: ExtractedFrame[]): PixelBounds | null {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;

  for (const frame of frames) {
    const context = frame.image.getContext('2d', { willReadFrequently: true });
    if (!context) continue;
    const { width, height } = frame.image;
    const bounds = getVisibleBoundsFromPixels(context.getImageData(0, 0, width, height).data, width, height);
    if (!bounds) continue;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width - 1);
    bottom = Math.max(bottom, bounds.y + bounds.height - 1);
  }

  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function cropFramesToSharedBounds(frames: ExtractedFrame[]): ExtractedFrame[] {
  const bounds = getSharedVisibleBounds(frames);
  if (!bounds) return frames;
  return frames.map((frame) => {
    if (bounds.x === 0 && bounds.y === 0 && bounds.width === frame.image.width && bounds.height === frame.image.height) {
      return frame;
    }
    const canvas = document.createElement('canvas');
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    const context = canvas.getContext('2d');
    if (context) context.drawImage(frame.image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    return { ...frame, image: canvas };
  });
}

function cropCanvasToVisibleBounds(source: HTMLCanvasElement): HTMLCanvasElement {
  const frame = { image: source, time: 0, label: '' };
  return cropFramesToSharedBounds([frame])[0].image;
}

export function getLayoutMetrics(
  meta: VideoMeta,
  frameCount: number,
  sheetOptions: SheetOptions,
  includeTimestamps: boolean,
): LayoutMetrics {
  const rows = Math.max(1, Math.ceil(frameCount / sheetOptions.columns));
  const frameSize = sheetOptions.frameSize ?? null;
  const frameWidth = frameSize ?? Math.min(MAX_FRAME_WIDTH, meta.width);
  const frameHeight = frameSize ?? Math.round((meta.height / meta.width) * frameWidth);
  const labelBlockHeight = includeTimestamps ? LABEL_BLOCK_HEIGHT : 0;
  const contentPadding = includeTimestamps ? CARD_PADDING : 0;
  const cardHeight = frameHeight + labelBlockHeight + contentPadding * 2;
  const horizontalGap = Math.max(sheetOptions.columns - 1, 0) * sheetOptions.gap;
  const verticalGap = Math.max(rows - 1, 0) * sheetOptions.gap;
  const canvasWidth = sheetOptions.columns * frameWidth + horizontalGap;
  const canvasHeight = rows * cardHeight + verticalGap;

  return {
    rows,
    canvasWidth,
    canvasHeight,
    frameWidth,
    frameHeight,
    labelBlockHeight,
  };
}

export function getSheetAppearance(transparent: boolean): SheetAppearance {
  return transparent
    ? {
        transparentBackground: true,
        showCardBackground: false,
      }
    : {
        transparentBackground: false,
        showCardBackground: true,
      };
}

function fillRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
  context.fill();
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('图片导出失败，请稍后再试。'));
        return;
      }

      resolve(blob);
    }, 'image/png');
  });
}

async function resizeFrameWithPica(
  source: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
): Promise<HTMLCanvasElement> {
  if (targetWidth === source.width && targetHeight === source.height) {
    return source;
  }

  const target = document.createElement('canvas');
  target.width = targetWidth;
  target.height = targetHeight;

  await pica.resize(source, target, {
    alpha: true,
    unsharpAmount: 80,
    unsharpRadius: 0.6,
    unsharpThreshold: 2,
  });

  return target;
}

export async function renderFrameSheet(
  frames: ExtractedFrame[],
  meta: VideoMeta,
  sheetOptions: SheetOptions,
  includeTimestamps: boolean,
  appearance: SheetAppearance = getSheetAppearance(false),
  trimTransparentOutput = true,
): Promise<RenderResult> {
  const framesForRender = cropFramesToSharedBounds(frames);
  const renderMeta = {
    ...meta,
    width: framesForRender[0]?.image.width ?? meta.width,
    height: framesForRender[0]?.image.height ?? meta.height,
  };
  const metrics = getLayoutMetrics(renderMeta, framesForRender.length, sheetOptions, includeTimestamps);
  assertCanvasSize(metrics.canvasWidth, metrics.canvasHeight, '最终序列图');
  const canvas = document.createElement('canvas');
  canvas.width = metrics.canvasWidth;
  canvas.height = metrics.canvasHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('当前浏览器无法创建最终导出画布。');
  }

  if (appearance.transparentBackground) {
    context.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    context.fillStyle = sheetOptions.backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.font = `600 ${LABEL_FONT_SIZE}px "Avenir Next", "PingFang SC", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const contentPadding = includeTimestamps ? CARD_PADDING : 0;
  const cardHeight = metrics.frameHeight + metrics.labelBlockHeight + contentPadding * 2;
  const frameRects: RenderResult['frameRects'] = [];

  for (const [index, frame] of framesForRender.entries()) {
    const scaledFrame = await resizeFrameWithPica(
      frame.image,
      metrics.frameWidth,
      metrics.frameHeight,
    );
    const column = index % sheetOptions.columns;
    const row = Math.floor(index / sheetOptions.columns);
    const x = column * (metrics.frameWidth + sheetOptions.gap);
    const y = row * (cardHeight + sheetOptions.gap);

    frameRects.push({
      x,
      y: y + contentPadding,
      width: metrics.frameWidth,
      height: metrics.frameHeight,
    });

    if (appearance.showCardBackground) {
      context.fillStyle = 'rgba(16, 24, 40, 0.08)';
      fillRoundedRect(
        context,
        x,
        y,
        metrics.frameWidth,
        metrics.frameHeight + metrics.labelBlockHeight + CARD_PADDING * 2,
        16,
      );
    }

    context.drawImage(
      scaledFrame,
      x,
      y + contentPadding,
      metrics.frameWidth,
      metrics.frameHeight,
    );

    if (includeTimestamps) {
      context.fillStyle = '#182230';
      context.fillText(
        frame.label,
        x + metrics.frameWidth / 2,
        y + contentPadding + metrics.frameHeight + metrics.labelBlockHeight / 2,
      );
    }
  }

  const outputCanvas = appearance.transparentBackground && trimTransparentOutput
    ? cropCanvasToVisibleBounds(canvas)
    : canvas;
  const blob = await canvasToBlob(outputCanvas);

  return {
    blob,
    objectUrl: URL.createObjectURL(blob),
    outputWidth: outputCanvas.width,
    outputHeight: outputCanvas.height,
    frameRects,
  };
}
