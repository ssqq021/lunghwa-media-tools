export const BYTES_PER_CANVAS_PIXEL = 4;
export const MAX_CANVAS_SIDE = 32_767;
export const MAX_CANVAS_PIXELS = 8192 * 8192;
export const MAX_RETAINED_CANVAS_BYTES = 2048 * 1024 * 1024;

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label}必须是大于 0 的有限整数。`);
  }

  return Math.ceil(value);
}

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0);
}

export function estimateCanvasBytes(
  width: number,
  height: number,
  frameCount = 1,
  surfaceCount = 1,
): number {
  return width * height * frameCount * surfaceCount * BYTES_PER_CANVAS_PIXEL;
}

export function fitDimensionsWithinSide(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const safeWidth = assertPositiveInteger(width, '宽度');
  const safeHeight = assertPositiveInteger(height, '高度');
  const safeMaxSide = assertPositiveInteger(maxSide, '最大边长');
  const scale = Math.min(1, safeMaxSide / safeWidth, safeMaxSide / safeHeight);

  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

export function assertCanvasSize(width: number, height: number, label: string): void {
  const safeWidth = assertPositiveInteger(width, `${label}宽度`);
  const safeHeight = assertPositiveInteger(height, `${label}高度`);
  const pixels = safeWidth * safeHeight;

  if (safeWidth > MAX_CANVAS_SIDE || safeHeight > MAX_CANVAS_SIDE || pixels > MAX_CANVAS_PIXELS) {
    throw new Error(
      `${label}尺寸 ${safeWidth} × ${safeHeight} 超出浏览器安全范围，请减少列数、帧数或输出尺寸。`,
    );
  }
}

export function assertEstimatedCanvasBytes(estimatedBytes: number, label: string): void {
  if (!Number.isFinite(estimatedBytes) || estimatedBytes < 0) {
    throw new Error(`${label}内存估算无效。`);
  }

  if (estimatedBytes > MAX_RETAINED_CANVAS_BYTES) {
    throw new Error(
      `${label}预计占用约 ${formatMiB(estimatedBytes)} MiB 画布内存，超过 ${formatMiB(MAX_RETAINED_CANVAS_BYTES)} MiB 安全预算；请减少处理数量或输出尺寸。`,
    );
  }
}

export function assertFrameMemoryBudget(
  width: number,
  height: number,
  frameCount: number,
  surfaceCount: number,
  label = '当前任务',
): void {
  const safeWidth = assertPositiveInteger(width, '帧宽度');
  const safeHeight = assertPositiveInteger(height, '帧高度');
  const safeFrameCount = assertPositiveInteger(frameCount, '帧数');
  const safeSurfaceCount = assertPositiveInteger(surfaceCount, '画布副本数');
  assertCanvasSize(safeWidth, safeHeight, '单帧画布');

  const estimatedBytes = estimateCanvasBytes(
    safeWidth,
    safeHeight,
    safeFrameCount,
    safeSurfaceCount,
  );
  assertEstimatedCanvasBytes(estimatedBytes, label);
}
