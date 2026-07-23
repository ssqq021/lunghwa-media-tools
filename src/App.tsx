'use client';

import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type {
  CropArea,
  CropBounds,
  ColorKeyOptions,
  ColorSample,
  ExtractedFrame,
  KeyAlgorithm,
  PreviewMode,
  ProcessedFrame,
  RenderResult,
  SheetOptions,
  SpineAnimationClip,
  SpineDraft,
  SpineExportOptions,
  VideoMeta,
} from './types';
import {
  applyColorKey,
  applyColorKeySequence,
  processExtractedFrameWithSequence,
  sampleCanvasColor,
} from './lib/chromaKey';
import {
  buildTransparentFramesZip,
  getBaseFileName,
  getGifFileName,
  getSheetFileName,
  getZipFileName,
} from './lib/exportBundle';
import { buildAnimatedGif } from './lib/gif';
import {
  buildSpineBundleZip,
  getSpineZipFileName,
} from './lib/spineBundle';
import {
  getLayoutMetrics,
  getSheetAppearance,
  renderFrameSheet,
} from './lib/sheet';
import { formatTimestamp } from './lib/time';
import { adjustPreviewZoom, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from './lib/previewZoom';
import { paintProtectionStroke, type MaskPoint } from './lib/protectionMask';
import {
  createFrameSelection,
  createIntervalFrameSelection,
  filterAssetsBySelection,
  getFrameSelectionSignature,
  getSelectedAttackFrameIndices,
  getSelectedFrameCount,
  normalizeAttackFrameSelection,
  normalizeFrameSelection,
  type FrameAttackSelection,
  type FrameSelection,
} from './lib/frameSelection';
import {
  cropCanvas,
  createVideoFrameReader,
  extractFrames,
  getCropBounds,
  getSampleTimes,
  getSegmentLoopSeekTime,
  loadVideoAsset,
  normalizeCropArea,
  revokeVideoAsset,
  resizeCanvas,
  type VideoFrameReader,
} from './lib/video';
import {
  assignWatermarkPassesToFrames,
  getNearestFrameTime,
  removeWatermarkFromCanvas,
  type WatermarkPass,
} from './lib/watermark';
import {
  assignShadowPassesToFrames,
  buildConnectedShadowMask,
  buildPolygonMask,
  removeShadowFromCanvas,
  type ShadowPass,
  type ShadowPoint,
  type ShadowSelection,
} from './lib/shadow';
import {
  assertFrameMemoryBudget,
  fitDimensionsWithinSide,
} from './lib/resourceBudget';
import {
  createLatestTaskTracker,
  isStaleTaskError,
} from './lib/latestTask';

const ImageCutoutTool = lazy(() => import('./ImageCutoutTool'));
const ImageResizeTool = lazy(() => import('./ImageResizeTool'));
const ImageCompressTool = lazy(() => import('./ImageCompressTool'));

const DEFAULT_FRAMES_PER_SECOND = 12;
const DEFAULT_COLUMNS = 4;
const DEFAULT_GAP = 0;
const DEFAULT_KEY_ALGORITHM: KeyAlgorithm = 'enhanced';
const DEFAULT_TOLERANCE = 28;
const DEFAULT_SOFTNESS = 14;
const DEFAULT_DESPILL = 50;
const DEFAULT_EDGE_RADIUS = 22;
const DEFAULT_SAMPLE_RADIUS = 6;
const DEFAULT_SHADOW_TOLERANCE = 48;
const DEFAULT_SOLID_PREVIEW_BG = '#111827';
const DEFAULT_CROP_LEFT_PERCENT = 0;
const DEFAULT_CROP_TOP_PERCENT = 0;
const DEFAULT_CROP_WIDTH_PERCENT = 100;
const DEFAULT_CROP_HEIGHT_PERCENT = 100;
const MAX_EXTRACTED_FRAMES = 180;
const MAX_FRAME_SIDE = 8192;
const THUMBNAIL_SIDE = 160;
const EXPORT_PRESETS = [
  { value: 'original', label: '原始比例', frameSize: undefined },
  { value: '32', label: '32 × 32', frameSize: 32 },
  { value: '64', label: '64 × 64', frameSize: 64 },
  { value: '128', label: '128 × 128', frameSize: 128 },
  { value: '256', label: '256 × 256', frameSize: 256 },
  { value: '512', label: '512 × 512', frameSize: 512 },
] as const;
type SamplePoint = {
  x: number;
  y: number;
};

type GeneratedAssets = {
  frames: ExtractedFrame[];
  processed: ProcessedFrame[] | null;
};

type SheetPreviewResult = {
  renderResult: RenderResult;
  transparent: boolean;
};

type ResultPreviewMode = 'sheet' | 'animation';
type SpinePreviewMode = 'animation';

type ExportPresetValue = (typeof EXPORT_PRESETS)[number]['value'];
type AppMode = 'sheet' | 'cutout' | 'resize' | 'compress';

type DragSelection = {
  start: SamplePoint;
  current: SamplePoint;
};

type ProtectionBrushMode = 'off' | 'protect' | 'erase';
type CleanupTool = 'watermark' | 'shadow';
type ShadowInteractionMode = 'pen' | 'sample';

type SheetPreviewConfig = {
  columns: number;
  gap: number;
  frameSize: number | null;
};

function clampPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawCanvas(
  target: HTMLCanvasElement | null,
  source: HTMLCanvasElement | null,
  marker?: SamplePoint | null,
  backgroundFill?: string,
): void {
  if (!target || !source) {
    return;
  }

  target.width = source.width;
  target.height = source.height;

  const context = target.getContext('2d');
  if (!context) {
    return;
  }

  context.clearRect(0, 0, target.width, target.height);

  if (backgroundFill) {
    context.fillStyle = backgroundFill;
    context.fillRect(0, 0, target.width, target.height);
  }

  context.drawImage(source, 0, 0);

  if (!marker) {
    return;
  }

  context.save();
  context.strokeStyle = '#ff8f1f';
  context.lineWidth = Math.max(2, source.width / 220);
  context.beginPath();
  context.arc(marker.x, marker.y, Math.max(10, source.width / 50), 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = '#ff8f1f';
  context.beginPath();
  context.arc(marker.x, marker.y, Math.max(3, source.width / 130), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function attachMiddleMousePan(viewport: HTMLElement): () => void {
  let drag:
    | {
        pointerId: number;
        clientX: number;
        clientY: number;
        scrollLeft: number;
        scrollTop: number;
      }
    | null = null;

  const finishDrag = (event?: PointerEvent): void => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) {
      return;
    }

    if (viewport.hasPointerCapture(drag.pointerId)) {
      viewport.releasePointerCapture(drag.pointerId);
    }
    drag = null;
    viewport.classList.remove('is-middle-panning');
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 1) {
      return;
    }

    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-middle-panning');
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.clientX);
    viewport.scrollTop = drag.scrollTop - (event.clientY - drag.clientY);
    event.preventDefault();
  };

  const handlePointerUp = (event: PointerEvent): void => {
    finishDrag(event);
  };

  viewport.addEventListener('pointerdown', handlePointerDown);
  viewport.addEventListener('pointermove', handlePointerMove);
  viewport.addEventListener('pointerup', handlePointerUp);
  viewport.addEventListener('pointercancel', handlePointerUp);
  viewport.addEventListener('lostpointercapture', handlePointerUp);

  return () => {
    finishDrag();
    viewport.removeEventListener('pointerdown', handlePointerDown);
    viewport.removeEventListener('pointermove', handlePointerMove);
    viewport.removeEventListener('pointerup', handlePointerUp);
    viewport.removeEventListener('pointercancel', handlePointerUp);
    viewport.removeEventListener('lostpointercapture', handlePointerUp);
  };
}

function getCanvasPoint(
  event: Pick<React.PointerEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>,
  canvas: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
): SamplePoint {
  const rect = canvas.getBoundingClientRect();
  const ratioX = sourceWidth / rect.width;
  const ratioY = sourceHeight / rect.height;

  return {
    x: Math.round((event.clientX - rect.left) * ratioX),
    y: Math.round((event.clientY - rect.top) * ratioY),
  };
}

function getCropAreaFromSelection(
  start: SamplePoint,
  end: SamplePoint,
  sourceWidth: number,
  sourceHeight: number,
): CropArea {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.max(1, Math.abs(end.x - start.x));
  const height = Math.max(1, Math.abs(end.y - start.y));

  return normalizeCropArea({
    leftPercent: (left / sourceWidth) * 100,
    topPercent: (top / sourceHeight) * 100,
    widthPercent: (width / sourceWidth) * 100,
    heightPercent: (height / sourceHeight) * 100,
  });
}

function createFrameThumbnailDataUrl(source: HTMLCanvasElement): string {
  const scale = Math.min(1, THUMBNAIL_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return '';
  }

  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

function getPixelBoundsFromSelection(
  start: SamplePoint,
  end: SamplePoint,
  sourceWidth: number,
  sourceHeight: number,
): CropBounds {
  const left = Math.max(0, Math.min(start.x, end.x));
  const top = Math.max(0, Math.min(start.y, end.y));
  const right = Math.min(sourceWidth, Math.max(start.x, end.x));
  const bottom = Math.min(sourceHeight, Math.max(start.y, end.y));

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function drawCropSelectionCanvas(
  target: HTMLCanvasElement | null,
  source: HTMLCanvasElement | null,
  cropArea?: CropArea | null,
): void {
  if (!target || !source) {
    return;
  }

  target.width = source.width;
  target.height = source.height;

  const context = target.getContext('2d');
  if (!context) {
    return;
  }

  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0);

  if (!cropArea) {
    return;
  }

  const bounds = getCropBounds(source.width, source.height, cropArea);

  context.save();
  context.fillStyle = 'rgba(15, 23, 42, 0.34)';
  context.fillRect(0, 0, target.width, bounds.y);
  context.fillRect(0, bounds.y, bounds.x, bounds.height);
  context.fillRect(bounds.x + bounds.width, bounds.y, target.width - bounds.x - bounds.width, bounds.height);
  context.fillRect(0, bounds.y + bounds.height, target.width, target.height - bounds.y - bounds.height);

  context.strokeStyle = '#ff8f1f';
  context.lineWidth = Math.max(2, source.width / 220);
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);

  context.setLineDash([8, 8]);
  context.beginPath();
  context.moveTo(bounds.x + bounds.width / 3, bounds.y);
  context.lineTo(bounds.x + bounds.width / 3, bounds.y + bounds.height);
  context.moveTo(bounds.x + (bounds.width / 3) * 2, bounds.y);
  context.lineTo(bounds.x + (bounds.width / 3) * 2, bounds.y + bounds.height);
  context.moveTo(bounds.x, bounds.y + bounds.height / 3);
  context.lineTo(bounds.x + bounds.width, bounds.y + bounds.height / 3);
  context.moveTo(bounds.x, bounds.y + (bounds.height / 3) * 2);
  context.lineTo(bounds.x + bounds.width, bounds.y + (bounds.height / 3) * 2);
  context.stroke();
  context.restore();
}

function drawProtectionOverlay(
  target: HTMLCanvasElement | null,
  mask: Uint8Array | null,
): void {
  if (!target || !mask || mask.length !== target.width * target.height) {
    return;
  }

  const context = target.getContext('2d');
  if (!context) {
    return;
  }

  const imageData = context.getImageData(0, 0, target.width, target.height);
  const pixels = imageData.data;
  for (let pixelIndex = 0; pixelIndex < mask.length; pixelIndex += 1) {
    if (!mask[pixelIndex]) {
      continue;
    }

    const offset = pixelIndex * 4;
    pixels[offset] = Math.round(pixels[offset] * 0.55 + 34 * 0.45);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * 0.55 + 197 * 0.45);
    pixels[offset + 2] = Math.round(pixels[offset + 2] * 0.55 + 94 * 0.45);
  }
  context.putImageData(imageData, 0, 0);
}

function drawCleanupSelectionCanvas(
  target: HTMLCanvasElement | null,
  source: HTMLCanvasElement | null,
  tool: CleanupTool,
  rect?: CropBounds | null,
  shadowPoints: ShadowPoint[] = [],
  shadowPathClosed = false,
  shadowSelection?: ShadowSelection | null,
): void {
  if (!target || !source) {
    return;
  }

  target.width = source.width;
  target.height = source.height;

  const context = target.getContext('2d');
  if (!context) {
    return;
  }

  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0);

  if (tool === 'watermark') {
    if (!rect) {
      return;
    }

    context.save();
    context.fillStyle = 'rgba(239, 68, 68, 0.18)';
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.strokeStyle = '#ef4444';
    context.lineWidth = Math.max(2, source.width / 240);
    context.setLineDash([10, 8]);
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    context.restore();
    return;
  }

  if (shadowSelection) {
    const imageData = context.getImageData(0, 0, target.width, target.height);
    const mask = buildConnectedShadowMask(
      imageData,
      target.width,
      target.height,
      shadowSelection,
    );
    const pixels = imageData.data;
    for (let index = 0; index < mask.length; index += 1) {
      if (!mask[index]) {
        continue;
      }

      const offset = index * 4;
      pixels[offset] = Math.round(pixels[offset] * 0.5 + 124 * 0.5);
      pixels[offset + 1] = Math.round(pixels[offset + 1] * 0.5 + 58 * 0.5);
      pixels[offset + 2] = Math.round(pixels[offset + 2] * 0.5 + 237 * 0.5);
    }
    context.putImageData(imageData, 0, 0);
  }

  if (!shadowPoints.length) {
    return;
  }

  context.save();
  context.beginPath();
  context.moveTo(shadowPoints[0].x, shadowPoints[0].y);
  for (const point of shadowPoints.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  if (shadowPathClosed) {
    context.closePath();
    context.fillStyle = 'rgba(124, 58, 237, 0.08)';
    context.fill();
  }
  context.strokeStyle = '#7c3aed';
  context.lineWidth = Math.max(2, source.width / 240);
  context.stroke();

  const anchorRadius = Math.max(4, source.width / 120);
  for (const [index, point] of shadowPoints.entries()) {
    context.beginPath();
    context.arc(point.x, point.y, anchorRadius, 0, Math.PI * 2);
    context.fillStyle = index === 0 ? '#f97316' : '#ffffff';
    context.fill();
    context.strokeStyle = '#7c3aed';
    context.lineWidth = Math.max(2, source.width / 300);
    context.stroke();
  }

  if (shadowSelection) {
    context.beginPath();
    context.arc(
      shadowSelection.seed.x,
      shadowSelection.seed.y,
      Math.max(7, source.width / 80),
      0,
      Math.PI * 2,
    );
    context.strokeStyle = '#f97316';
    context.lineWidth = Math.max(2, source.width / 240);
    context.stroke();
  }
  context.restore();
}

function toTransparentSheetFrames(processedFrames: ProcessedFrame[]): ExtractedFrame[] {
  return processedFrames.map(({ processedImage, ...frame }) => ({
    ...frame,
    image: processedImage,
  }));
}

function getSheetPreviewConfigKey(config: SheetPreviewConfig): string {
  return `${config.columns}|${config.gap}|${config.frameSize ?? 'original'}`;
}

function buildSpineDraftFromAssets(
  assets: GeneratedAssets,
  baseName: string,
  width: number,
  height: number,
  sheetOptions: SheetOptions,
  attackFrameIndices: number[],
): SpineDraft {
  const transparent = Boolean(assets.processed);
  const draftFrames = transparent ? toTransparentSheetFrames(assets.processed ?? []) : assets.frames;
  return {
    frames: draftFrames,
    baseName,
    width,
    height,
    transparent,
    sheetOptions,
    sourceFrameIndices: Array.from({ length: draftFrames.length }, (_, index) => index),
    sourceFrameCount: draftFrames.length,
    attackFrameIndices,
  };
}

let spineAnimationId = 0;

function createSpineAnimationClip(
  frameCount: number,
  index: number,
  fps: number,
): SpineAnimationClip {
  spineAnimationId += 1;
  return {
    id: `animation-${spineAnimationId}`,
    name: index === 0 ? 'idle' : `animation-${index + 1}`,
    startFrame: 0,
    endFrame: Math.max(frameCount - 1, 0),
    fps,
  };
}

function getUsedSpineFrameIndices(
  clips: SpineAnimationClip[],
  frameCount: number,
): number[] {
  const used = new Set<number>();
  for (const clip of clips) {
    const start = Math.min(Math.max(clip.startFrame, 0), Math.max(frameCount - 1, 0));
    const end = Math.min(Math.max(clip.endFrame, start), Math.max(frameCount - 1, 0));
    for (let index = start; index <= end; index += 1) {
      used.add(index);
    }
  }
  return [...used].sort((left, right) => left - right);
}

function App() {
  const [appMode, setAppMode] = useState<AppMode>('sheet');
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isChromaStageOpen, setIsChromaStageOpen] = useState(false);
  const [framesPerSecond, setFramesPerSecond] = useState(DEFAULT_FRAMES_PER_SECOND);
  const [segmentStart, setSegmentStart] = useState(0);
  const [segmentEnd, setSegmentEnd] = useState(0);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [gap, setGap] = useState(DEFAULT_GAP);
  const [exportPreset, setExportPreset] = useState<ExportPresetValue>('original');
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [softness, setSoftness] = useState(DEFAULT_SOFTNESS);
  const [smoothing, setSmoothing] = useState(true);
  const [despillEnabled, setDespillEnabled] = useState(true);
  const [referenceTime, setReferenceTime] = useState(0);
  const [referenceRawFrame, setReferenceRawFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceFrame, setReferenceFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceCommittedFrame, setReferenceCommittedFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceResultFrame, setReferenceResultFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceMaskFrame, setReferenceMaskFrame] = useState<HTMLCanvasElement | null>(null);
  const [cropLeftPercent, setCropLeftPercent] = useState(DEFAULT_CROP_LEFT_PERCENT);
  const [cropTopPercent, setCropTopPercent] = useState(DEFAULT_CROP_TOP_PERCENT);
  const [cropWidthPercent, setCropWidthPercent] = useState(DEFAULT_CROP_WIDTH_PERCENT);
  const [cropHeightPercent, setCropHeightPercent] = useState(DEFAULT_CROP_HEIGHT_PERCENT);
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  const [resizeHeight, setResizeHeight] = useState<number | null>(null);
  const [resizeLocked, setResizeLocked] = useState(true);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [watermarkDragSelection, setWatermarkDragSelection] = useState<DragSelection | null>(null);
  const [watermarkRect, setWatermarkRect] = useState<CropBounds | null>(null);
  const [watermarkPasses, setWatermarkPasses] = useState<WatermarkPass[]>([]);
  const [cleanupTool, setCleanupTool] = useState<CleanupTool>('watermark');
  const [shadowPoints, setShadowPoints] = useState<ShadowPoint[]>([]);
  const [shadowPathClosed, setShadowPathClosed] = useState(false);
  const [shadowInteractionMode, setShadowInteractionMode] = useState<ShadowInteractionMode>('pen');
  const [shadowSample, setShadowSample] = useState<ColorSample | null>(null);
  const [shadowTolerance, setShadowTolerance] = useState(DEFAULT_SHADOW_TOLERANCE);
  const [shadowPasses, setShadowPasses] = useState<ShadowPass[]>([]);
  const [watermarkCanvasZoom, setWatermarkCanvasZoom] = useState(100);
  const [frameSelection, setFrameSelection] = useState<FrameSelection | null>(null);
  const [attackFrameSelection, setAttackFrameSelection] = useState<FrameAttackSelection | null>(null);
  const [samplePoint, setSamplePoint] = useState<SamplePoint | null>(null);
  const [colorSample, setColorSample] = useState<ColorSample | null>(null);
  const [committedColorKeys, setCommittedColorKeys] = useState<ColorKeyOptions[]>([]);
  const [protectionMask, setProtectionMask] = useState<Uint8Array | null>(null);
  const [protectionUndoStack, setProtectionUndoStack] = useState<Uint8Array[]>([]);
  const [protectionBrushMode, setProtectionBrushMode] = useState<ProtectionBrushMode>('off');
  const [protectionBrushSize, setProtectionBrushSize] = useState(48);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('result');
  const [solidPreviewColor, setSolidPreviewColor] = useState(DEFAULT_SOLID_PREVIEW_BG);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [resultTransparent, setResultTransparent] = useState(false);
  const [resultPreviewMode, setResultPreviewMode] = useState<ResultPreviewMode>('sheet');
  const [spineDraft, setSpineDraft] = useState<SpineDraft | null>(null);
  const [spineOptions, setSpineOptions] = useState<SpineExportOptions>({
    skeletonName: 'video',
    slotName: 'sprite',
    animations: [],
  });
  const [activeSpineAnimationId, setActiveSpineAnimationId] = useState<string | null>(null);
  const spinePreviewMode: SpinePreviewMode = 'animation';
  const [spineAnimationPlaying, setSpineAnimationPlaying] = useState(true);
  const [spineAnimationFrameIndex, setSpineAnimationFrameIndex] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(true);
  const [animationFrameIndex, setAnimationFrameIndex] = useState(0);
  const [animationZoom, setAnimationZoom] = useState(100);
  const [status, setStatus] = useState('请选择一个本地视频开始生成。');
  const [isDragging, setIsDragging] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isReferenceLoading, setIsReferenceLoading] = useState(false);
  const [readerReady, setReaderReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [extractedFrames, setExtractedFrames] = useState<ExtractedFrame[] | null>(null);
  const [processedFrames, setProcessedFrames] = useState<ProcessedFrame[] | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const cropSelectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const referenceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const watermarkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const watermarkCanvasViewportRef = useRef<HTMLDivElement | null>(null);
  const segmentPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const watermarkVideoRef = useRef<HTMLVideoElement | null>(null);
  const resultAnimationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultAnimationPreviewRef = useRef<HTMLDivElement | null>(null);
  const spineAnimationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsPanelRef = useRef<HTMLDivElement | null>(null);
  const cropPanelRef = useRef<HTMLElement | null>(null);
  const chromaPanelRef = useRef<HTMLElement | null>(null);
  const chromaActionsRef = useRef<HTMLDivElement | null>(null);
  const resultPanelRef = useRef<HTMLElement | null>(null);
  const spinePanelRef = useRef<HTMLElement | null>(null);
  const readerRef = useRef<VideoFrameReader | null>(null);
  const autoPreviewTimerRef = useRef<number | null>(null);
  const autoPreviewInFlightRef = useRef(false);
  const lastSheetPreviewConfigRef = useRef<string | null>(null);
  const readerTokenRef = useRef(0);
  const pendingChromaScrollRef = useRef(false);
  const pendingChromaScrollTopRef = useRef<number | null>(null);
  const pendingResultScrollRef = useRef(false);
  const pendingResultScrollTopRef = useRef<number | null>(null);
  const pendingSpineScrollRef = useRef(false);
  const pendingSpineScrollTopRef = useRef<number | null>(null);
  const hasInitializedInvalidationRef = useRef(false);
  const hasInitializedAssetInvalidationRef = useRef(false);
  const latestVideoUrlRef = useRef<string | null>(null);
  const latestResultRef = useRef<RenderResult | null>(null);
  const protectionMaskRef = useRef<Uint8Array | null>(null);
  const protectionPaintingRef = useRef(false);
  const protectionLastPointRef = useRef<MaskPoint | null>(null);
  const shadowDraggingPointRef = useRef<number | null>(null);
  const fileTaskTrackerRef = useRef(createLatestTaskTracker());
  const renderTaskTrackerRef = useRef(createLatestTaskTracker());

  const sheetOptions: SheetOptions = {
    columns,
    gap,
    backgroundColor: '#ffffff',
    frameSize: EXPORT_PRESETS.find((preset) => preset.value === exportPreset)?.frameSize,
  };

  const baseFileName = useMemo(
    () => getBaseFileName(videoMeta?.name ?? 'video'),
    [videoMeta?.name],
  );
  const sampleTimes = useMemo(() => {
    if (!videoMeta) {
      return [];
    }

    return getSampleTimes(
      videoMeta.duration,
      framesPerSecond,
      segmentStart,
      segmentEnd,
    );
  }, [framesPerSecond, segmentEnd, segmentStart, videoMeta]);
  const firstSampleTime = sampleTimes[0] ?? 0;
  const selectedDuration = Math.max(0, segmentEnd - segmentStart);
  const estimatedFrameCount = sampleTimes.length;
  const frameLimitExceeded = estimatedFrameCount > MAX_EXTRACTED_FRAMES;
  const segmentTrackStyle = useMemo(
    () =>
      ({
        ['--segment-start' as const]: videoMeta
          ? `${(segmentStart / videoMeta.duration) * 100}%`
          : '0%',
        ['--segment-end' as const]: videoMeta
          ? `${(segmentEnd / videoMeta.duration) * 100}%`
          : '100%',
      }) as CSSProperties,
    [segmentEnd, segmentStart, videoMeta],
  );
  const cropArea = useMemo<CropArea>(
    () =>
      normalizeCropArea({
        leftPercent: cropLeftPercent,
        topPercent: cropTopPercent,
        widthPercent: cropWidthPercent,
        heightPercent: cropHeightPercent,
      }),
    [cropHeightPercent, cropLeftPercent, cropTopPercent, cropWidthPercent],
  );
  const cropBounds = useMemo(
    () =>
      videoMeta
        ? getCropBounds(videoMeta.width, videoMeta.height, cropArea)
        : null,
    [cropArea, videoMeta],
  );
  const activeCropArea = useMemo<CropArea>(
    () =>
      dragSelection && referenceRawFrame
        ? getCropAreaFromSelection(
            dragSelection.start,
            dragSelection.current,
            referenceRawFrame.width,
            referenceRawFrame.height,
          )
        : cropArea,
    [cropArea, dragSelection, referenceRawFrame],
  );
  const cropSurfaceStyle = useMemo<CSSProperties | undefined>(
    () =>
      videoMeta
        ? {
            aspectRatio: `${videoMeta.width} / ${videoMeta.height}`,
          }
        : undefined,
    [videoMeta],
  );
  const isCropApplied = Boolean(
    cropBounds &&
      videoMeta &&
      (cropBounds.x > 0 ||
        cropBounds.y > 0 ||
        cropBounds.width < videoMeta.width ||
        cropBounds.height < videoMeta.height),
  );
  const outputVideoMeta = useMemo<VideoMeta | null>(() => {
    if (!videoMeta || !cropBounds) {
      return videoMeta;
    }

    return {
      ...videoMeta,
      width: resizeWidth ?? cropBounds.width,
      height: resizeHeight ?? cropBounds.height,
    };
  }, [cropBounds, resizeHeight, resizeWidth, videoMeta]);
  const exportFrameSize = useMemo(
    () => EXPORT_PRESETS.find((preset) => preset.value === exportPreset)?.frameSize,
    [exportPreset],
  );
  const exportLayoutMetrics = useMemo(
    () =>
      outputVideoMeta
        ? getLayoutMetrics(
            outputVideoMeta,
            extractedFrames?.length ?? estimatedFrameCount,
            sheetOptions,
            false,
          )
        : null,
    [estimatedFrameCount, extractedFrames?.length, outputVideoMeta, sheetOptions],
  );
  const exportTargetSize = useMemo(
    () =>
      exportLayoutMetrics
        ? {
            width: exportLayoutMetrics.canvasWidth,
            height: exportLayoutMetrics.canvasHeight,
          }
        : null,
    [exportLayoutMetrics],
  );
  const sheetPreviewConfigKey = useMemo(
    () =>
      getSheetPreviewConfigKey({
        columns: sheetOptions.columns,
        gap: sheetOptions.gap,
        frameSize: sheetOptions.frameSize ?? null,
      }),
    [sheetOptions.columns, sheetOptions.frameSize, sheetOptions.gap],
  );
  const normalizedFrameSelection = useMemo(
    () => normalizeFrameSelection(frameSelection, extractedFrames?.length ?? 0),
    [extractedFrames?.length, frameSelection],
  );
  const normalizedAttackFrameSelection = useMemo(
    () => normalizeAttackFrameSelection(attackFrameSelection, extractedFrames?.length ?? 0),
    [attackFrameSelection, extractedFrames?.length],
  );
  const frameSelectionSignature = useMemo(
    () => getFrameSelectionSignature(normalizedFrameSelection, extractedFrames?.length ?? 0),
    [extractedFrames?.length, normalizedFrameSelection],
  );
  const selectedFrameCount = useMemo(
    () => getSelectedFrameCount(normalizedFrameSelection, extractedFrames?.length ?? 0),
    [extractedFrames?.length, normalizedFrameSelection],
  );
  const filteredAssets = useMemo<GeneratedAssets | null>(() => {
    if (!extractedFrames) {
      return null;
    }

    return filterAssetsBySelection(
      {
        frames: extractedFrames,
        processed: processedFrames,
      },
      normalizedFrameSelection,
    );
  }, [extractedFrames, normalizedFrameSelection, processedFrames]);
  const frameThumbnailUrls = useMemo(
    () => extractedFrames?.map((frame) => createFrameThumbnailDataUrl(frame.image)) ?? [],
    [extractedFrames],
  );
  const watermarkAssignments = useMemo(
    () => assignWatermarkPassesToFrames(sampleTimes, watermarkPasses),
    [sampleTimes, watermarkPasses],
  );
  const shadowAssignments = useMemo(
    () => assignShadowPassesToFrames(sampleTimes, shadowPasses),
    [sampleTimes, shadowPasses],
  );
  const currentWatermarkRects = useMemo(() => {
    const frameTime = getNearestFrameTime(sampleTimes, referenceTime);
    if (frameTime === null) {
      return [];
    }

    return watermarkAssignments[sampleTimes.indexOf(frameTime)] ?? [];
  }, [referenceTime, sampleTimes, watermarkAssignments]);
  const currentShadowSelections = useMemo(() => {
    const frameTime = getNearestFrameTime(sampleTimes, referenceTime);
    if (frameTime === null) {
      return [];
    }

    return shadowAssignments[sampleTimes.indexOf(frameTime)] ?? [];
  }, [referenceTime, sampleTimes, shadowAssignments]);
  const referenceFrameAfterWatermark = useMemo(() => {
    if (!referenceFrame) {
      return null;
    }

    return currentWatermarkRects.reduce(
      (current, rect) => removeWatermarkFromCanvas(current, rect),
      referenceFrame,
    );
  }, [currentWatermarkRects, referenceFrame]);
  const referenceFrameAfterCleanup = useMemo(() => {
    if (!referenceFrameAfterWatermark) {
      return null;
    }

    return currentShadowSelections.reduce(
      (current, selection) => removeShadowFromCanvas(current, selection),
      referenceFrameAfterWatermark,
    );
  }, [currentShadowSelections, referenceFrameAfterWatermark]);
  const activeWatermarkRect = useMemo<CropBounds | null>(
    () =>
      watermarkDragSelection && referenceFrame
        ? getPixelBoundsFromSelection(
            watermarkDragSelection.start,
            watermarkDragSelection.current,
            referenceFrame.width,
            referenceFrame.height,
          )
        : watermarkRect,
    [referenceFrame, watermarkDragSelection, watermarkRect],
  );
  const activeShadowSelection = useMemo<ShadowSelection | null>(
    () =>
      shadowPathClosed && shadowSample
        ? {
            points: shadowPoints,
            seed: { x: shadowSample.x, y: shadowSample.y },
            sample: shadowSample.rgb,
            tolerance: shadowTolerance,
          }
        : null,
    [shadowPathClosed, shadowPoints, shadowSample, shadowTolerance],
  );
  const framePreviewRefreshKey = useMemo(
    () => `${sheetPreviewConfigKey}|${frameSelectionSignature}`,
    [frameSelectionSignature, sheetPreviewConfigKey],
  );

  const colorKeyOptions = useMemo<ColorKeyOptions | null>(() => {
    if (!colorSample) {
      return null;
    }

    return {
      sample: colorSample,
      tolerance,
      softness,
      despill: DEFAULT_DESPILL,
      sampleRadius: DEFAULT_SAMPLE_RADIUS,
      edgeRadius: DEFAULT_EDGE_RADIUS,
      smoothing,
      despillEnabled,
      algorithm: DEFAULT_KEY_ALGORITHM,
    };
  }, [
    colorSample,
    despillEnabled,
    smoothing,
    softness,
    tolerance,
  ]);
  const activeColorKeySequence = useMemo<ColorKeyOptions[]>(
    () => (colorKeyOptions ? [...committedColorKeys, colorKeyOptions] : committedColorKeys),
    [colorKeyOptions, committedColorKeys],
  );
  const committedColorKeySignature = useMemo(
    () =>
      JSON.stringify(
        committedColorKeys.map((item) => ({
          sample: item.sample.hex,
          tolerance: item.tolerance,
          softness: item.softness,
          despill: item.despill,
          edgeRadius: item.edgeRadius,
          smoothing: item.smoothing,
          despillEnabled: item.despillEnabled,
          algorithm: item.algorithm,
        })),
      ),
    [committedColorKeys],
  );
  const hasCommittedColorKeys = committedColorKeys.length > 0;
  const hasAnyColorKeyPass = activeColorKeySequence.length > 0;
  const protectedPixelCount = useMemo(
    () => protectionMask?.reduce((count, value) => count + (value ? 1 : 0), 0) ?? 0,
    [protectionMask],
  );
  const generationBudgetError = useMemo(() => {
    if (!outputVideoMeta || estimatedFrameCount < 1) return null;

    try {
      assertFrameMemoryBudget(
        outputVideoMeta.width,
        outputVideoMeta.height,
        estimatedFrameCount,
        1 + (watermarkPasses.length || shadowPasses.length ? 1 : 0) + (activeColorKeySequence.length ? 2 : 0),
        '抽帧任务',
      );
      return null;
    } catch (nextError) {
      return nextError instanceof Error ? nextError.message : '当前任务超出浏览器安全预算。';
    }
  }, [
    activeColorKeySequence.length,
    estimatedFrameCount,
    outputVideoMeta,
    shadowPasses.length,
    watermarkPasses.length,
  ]);

  const isCutoutMode = appMode === 'cutout';
  const isResizeMode = appMode === 'resize';
  const isCompressMode = appMode === 'compress';
  const isSheetMode = appMode === 'sheet';
  const canGenerate = Boolean(
    videoMeta &&
      videoUrl &&
      isChromaStageOpen &&
      !isRendering &&
      estimatedFrameCount > 0 &&
      !frameLimitExceeded &&
      !generationBudgetError,
  );
  const showChromaStage = Boolean(videoMeta && isChromaStageOpen);
  const showFramePickerStage = Boolean(isSheetMode && extractedFrames?.length);
  const showResultStage = Boolean(result);
  const showSpineStage = Boolean(isSheetMode && spineDraft);
  const animationFrames = useMemo<ExtractedFrame[]>(() => {
    if (filteredAssets?.processed) {
      return toTransparentSheetFrames(filteredAssets.processed);
    }

    return filteredAssets?.frames ?? [];
  }, [filteredAssets]);
  const spineFrames = useMemo<ExtractedFrame[]>(() => spineDraft?.frames ?? [], [spineDraft]);
  const activeSpineAnimation = useMemo(
    () => spineOptions.animations.find((clip) => clip.id === activeSpineAnimationId)
      ?? spineOptions.animations[0]
      ?? null,
    [activeSpineAnimationId, spineOptions.animations],
  );
  const spinePreviewStartFrame = activeSpineAnimation
    ? Math.min(Math.max(activeSpineAnimation.startFrame, 0), Math.max(spineFrames.length - 1, 0))
    : 0;
  const spinePreviewEndFrame = activeSpineAnimation
    ? Math.min(Math.max(activeSpineAnimation.endFrame, spinePreviewStartFrame), Math.max(spineFrames.length - 1, 0))
    : Math.max(spineFrames.length - 1, 0);
  const spinePreviewFrameCount = spineFrames.length
    ? spinePreviewEndFrame - spinePreviewStartFrame + 1
    : 0;

  function scrollToStep(target: { current: HTMLElement | null }): void {
    window.setTimeout(() => {
      target.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 180);
  }

  function replacePreviewResult(next: RenderResult | null, transparent = false): void {
    setResult((current) => {
      if (current) {
        URL.revokeObjectURL(current.objectUrl);
      }

      return next;
    });
    setResultTransparent(Boolean(next && transparent));
  }

  function disposeReferenceReader(): void {
    readerRef.current?.dispose();
    readerRef.current = null;
  }

  function resetProtectionMask(): void {
    protectionMaskRef.current = null;
    protectionPaintingRef.current = false;
    protectionLastPointRef.current = null;
    setProtectionMask(null);
    setProtectionUndoStack([]);
    setProtectionBrushMode('off');
  }

  function resetShadowDraft(): void {
    shadowDraggingPointRef.current = null;
    setShadowPoints([]);
    setShadowPathClosed(false);
    setShadowInteractionMode('pen');
    setShadowSample(null);
    setShadowTolerance(DEFAULT_SHADOW_TOLERANCE);
  }

  function clearDerivedOutputs(nextStatus?: string): void {
    renderTaskTrackerRef.current.invalidate();
    setIsRendering(false);
    pendingResultScrollRef.current = false;
    pendingResultScrollTopRef.current = null;
    pendingSpineScrollRef.current = false;
    pendingSpineScrollTopRef.current = null;
    replacePreviewResult(null);
    setResultPreviewMode('sheet');
    setAnimationFrameIndex(0);
    setAnimationPlaying(true);
    setAnimationZoom(100);
    setSpineDraft(null);
    setSpineAnimationFrameIndex(0);
    setSpineAnimationPlaying(true);
    setActiveSpineAnimationId(null);
    lastSheetPreviewConfigRef.current = null;
    autoPreviewInFlightRef.current = false;
    if (autoPreviewTimerRef.current !== null) {
      window.clearTimeout(autoPreviewTimerRef.current);
      autoPreviewTimerRef.current = null;
    }
    if (nextStatus) {
      setStatus(nextStatus);
    }
  }

  function clearGeneratedAssets(nextStatus?: string): void {
    setExtractedFrames(null);
    setProcessedFrames(null);
    clearDerivedOutputs(nextStatus);
  }

  function beginRenderTask(): number {
    const taskToken = renderTaskTrackerRef.current.begin();
    setIsRendering(true);
    return taskToken;
  }

  function finishRenderTask(taskToken: number): void {
    if (renderTaskTrackerRef.current.isCurrent(taskToken)) {
      setIsRendering(false);
    }
  }

  useEffect(() => {
    latestVideoUrlRef.current = videoUrl;
  }, [videoUrl]);

  useEffect(() => {
    latestResultRef.current = result;
  }, [result]);

  useEffect(() => {
    return () => {
      fileTaskTrackerRef.current.invalidate();
      renderTaskTrackerRef.current.invalidate();
      disposeReferenceReader();
      if (autoPreviewTimerRef.current !== null) {
        window.clearTimeout(autoPreviewTimerRef.current);
      }

      if (latestVideoUrlRef.current) {
        revokeVideoAsset(latestVideoUrlRef.current);
      }

      if (latestResultRef.current) {
        URL.revokeObjectURL(latestResultRef.current.objectUrl);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (
      !pendingChromaScrollRef.current ||
      !showChromaStage ||
      pendingChromaScrollTopRef.current === null
    ) {
      return;
    }

    window.scrollTo({
      top: pendingChromaScrollTopRef.current,
      left: window.scrollX,
    });
  }, [showChromaStage]);

  useLayoutEffect(() => {
    if (
      !pendingResultScrollRef.current ||
      !showResultStage ||
      pendingResultScrollTopRef.current === null
    ) {
      return;
    }

    window.scrollTo({
      top: pendingResultScrollTopRef.current,
      left: window.scrollX,
    });
  }, [showResultStage]);

  useLayoutEffect(() => {
    if (
      !pendingSpineScrollRef.current ||
      !showSpineStage ||
      pendingSpineScrollTopRef.current === null
    ) {
      return;
    }

    window.scrollTo({
      top: pendingSpineScrollTopRef.current,
      left: window.scrollX,
    });
  }, [showSpineStage]);

  useEffect(() => {
    if (!videoUrl || !videoMeta) {
      disposeReferenceReader();
      setReferenceRawFrame(null);
      setReferenceFrame(null);
      return;
    }

    let cancelled = false;
    const token = ++readerTokenRef.current;

    setIsReferenceLoading(true);

    void createVideoFrameReader(videoUrl)
      .then((reader) => {
        if (cancelled || token !== readerTokenRef.current) {
          reader.dispose();
          return;
        }

        disposeReferenceReader();
        readerRef.current = reader;
        setReaderReady((value) => value + 1);
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : '参考帧读取失败。');
      })
      .finally(() => {
        if (!cancelled && token === readerTokenRef.current) {
          setIsReferenceLoading(false);
        }
      });

    return () => {
      cancelled = true;
      readerTokenRef.current += 1;
      disposeReferenceReader();
    };
  }, [videoMeta, videoUrl]);

  useEffect(() => {
    if (!videoMeta || !readerRef.current) {
      return;
    }

    let cancelled = false;
    const token = ++readerTokenRef.current;

    setIsReferenceLoading(true);

    void readerRef.current
      .captureFrameAt(referenceTime)
      .then((canvas) => {
        if (cancelled || token !== readerTokenRef.current) {
          return;
        }

        setReferenceRawFrame(canvas);
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : '参考帧更新失败。');
      })
      .finally(() => {
        if (!cancelled && token === readerTokenRef.current) {
          setIsReferenceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [readerReady, referenceTime, videoMeta]);

  useEffect(() => {
    if (!referenceRawFrame) {
      setReferenceFrame(null);
      setReferenceCommittedFrame(null);
      return;
    }

    try {
      const cropped = resizeCanvas(cropCanvas(referenceRawFrame, cropArea), resizeWidth, resizeHeight);
      setReferenceFrame(cropped);
      setSamplePoint((current) => {
        if (!current) {
          return current;
        }

        if (current.x >= cropped.width || current.y >= cropped.height) {
          return null;
        }

        return current;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '参考帧裁剪失败。');
    }
  }, [cropArea, referenceRawFrame, resizeHeight, resizeWidth]);

  useEffect(() => {
    if (!videoMeta) {
      return;
    }

    const clampedTime = Math.min(Math.max(referenceTime, segmentStart), segmentEnd);
    if (Math.abs(clampedTime - referenceTime) > 0.001) {
      setReferenceTime(Number(clampedTime.toFixed(3)));
    }
  }, [referenceTime, segmentEnd, segmentStart, videoMeta]);

  useEffect(() => {
    const preview = segmentPreviewVideoRef.current;
    if (!preview || !videoMeta || !videoUrl) {
      return;
    }

    preview.currentTime = segmentStart;
    void preview.play().catch(() => undefined);
  }, [segmentEnd, segmentStart, videoMeta, videoUrl]);

  useEffect(() => {
    if (!samplePoint && !colorSample) {
      return;
    }

    setSamplePoint(null);
    setColorSample(null);
  }, [
    cropArea.heightPercent,
    cropArea.leftPercent,
    cropArea.topPercent,
    cropArea.widthPercent,
  ]);

  useEffect(() => {
    if (!referenceCommittedFrame || !samplePoint) {
      setColorSample(null);
      return;
    }

    try {
      setColorSample(
        sampleCanvasColor(referenceCommittedFrame, samplePoint.x, samplePoint.y, DEFAULT_SAMPLE_RADIUS),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '颜色取样失败。');
    }
  }, [referenceCommittedFrame, samplePoint]);

  useEffect(() => {
    if (!referenceFrameAfterCleanup) {
      setReferenceCommittedFrame(null);
      setReferenceResultFrame(null);
      setReferenceMaskFrame(null);
      return;
    }

    try {
      const committedPreview = hasCommittedColorKeys
        ? applyColorKeySequence(referenceFrameAfterCleanup, committedColorKeys, protectionMask)
        : null;
      const committedFrame = committedPreview?.image ?? referenceFrameAfterCleanup;

      setReferenceCommittedFrame(committedFrame);

      if (!colorKeyOptions) {
        setReferenceResultFrame(committedFrame);
        setReferenceMaskFrame(committedPreview?.mask ?? null);
        return;
      }

      const preview = applyColorKey(committedFrame, colorKeyOptions, protectionMask);
      setReferenceResultFrame(preview.image);
      setReferenceMaskFrame(preview.mask);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '参考帧预览失败。');
    }
  }, [colorKeyOptions, committedColorKeys, hasCommittedColorKeys, protectionMask, referenceFrameAfterCleanup]);

  useEffect(() => {
    drawCanvas(referenceCanvasRef.current, referenceCommittedFrame, samplePoint);
    drawProtectionOverlay(referenceCanvasRef.current, protectionMask);
  }, [protectionMask, referenceCommittedFrame, samplePoint]);

  useEffect(() => {
    drawCropSelectionCanvas(cropSelectionCanvasRef.current, referenceRawFrame, activeCropArea);
  }, [activeCropArea, referenceRawFrame]);

  useEffect(() => {
    if (!referenceRawFrame) {
      return;
    }

    drawCanvas(
      cropPreviewCanvasRef.current,
      cropCanvas(referenceRawFrame, activeCropArea),
    );
  }, [activeCropArea, referenceRawFrame]);

  useEffect(() => {
    drawCleanupSelectionCanvas(
      watermarkCanvasRef.current,
      referenceFrameAfterCleanup,
      cleanupTool,
      activeWatermarkRect,
      shadowPoints,
      shadowPathClosed,
      activeShadowSelection,
    );
  }, [
    activeShadowSelection,
    activeWatermarkRect,
    cleanupTool,
    referenceFrameAfterCleanup,
    shadowPathClosed,
    shadowPoints,
  ]);

  useEffect(() => {
    const viewport = watermarkCanvasViewportRef.current;
    if (!viewport || !showChromaStage) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const cursorX = event.clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft;
      const cursorY = event.clientY - viewport.getBoundingClientRect().top + viewport.scrollTop;
      const visibleX = event.clientX - viewport.getBoundingClientRect().left;
      const visibleY = event.clientY - viewport.getBoundingClientRect().top;

      setWatermarkCanvasZoom((current) => {
        const next = adjustPreviewZoom(current, event.deltaY < 0 ? 1 : -1);
        if (next === current) {
          return current;
        }

        const scale = next / current;
        window.requestAnimationFrame(() => {
          viewport.scrollLeft = cursorX * scale - visibleX;
          viewport.scrollTop = cursorY * scale - visibleY;
        });
        return next;
      });
    };

    const detachPan = attachMiddleMousePan(viewport);
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      detachPan();
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, [showChromaStage]);

  useEffect(() => {
    const source =
      previewMode === 'mask'
        ? referenceMaskFrame
        : referenceResultFrame ?? referenceFrame;

    drawCanvas(
      previewCanvasRef.current,
      source,
      undefined,
      previewMode === 'solid' ? solidPreviewColor : undefined,
    );
  }, [previewMode, referenceFrame, referenceMaskFrame, referenceResultFrame, solidPreviewColor]);

  useEffect(() => {
    if (
      !pendingChromaScrollRef.current ||
      !showChromaStage ||
      !referenceFrame ||
      !referenceResultFrame ||
      isReferenceLoading
    ) {
      return;
    }

    const referenceCanvas = referenceCanvasRef.current;
    const previewCanvas = previewCanvasRef.current;
    if (
      !referenceCanvas ||
      !previewCanvas ||
      referenceCanvas.width === 0 ||
      referenceCanvas.height === 0 ||
      previewCanvas.width === 0 ||
      previewCanvas.height === 0
    ) {
      return;
    }

    let nextFrameId = 0;
    let finalFrameId = 0;

    nextFrameId = window.requestAnimationFrame(() => {
      finalFrameId = window.requestAnimationFrame(() => {
        pendingChromaScrollRef.current = false;
        pendingChromaScrollTopRef.current = null;
        scrollToStep(chromaPanelRef);
      });
    });

    return () => {
      window.cancelAnimationFrame(nextFrameId);
      window.cancelAnimationFrame(finalFrameId);
    };
  }, [isReferenceLoading, referenceFrame, referenceResultFrame, showChromaStage]);

  useEffect(() => {
    if (
      !pendingResultScrollRef.current ||
      !showResultStage ||
      !result ||
      resultPreviewMode !== 'sheet'
    ) {
      return;
    }

    let nextFrameId = 0;
    let finalFrameId = 0;

    nextFrameId = window.requestAnimationFrame(() => {
      finalFrameId = window.requestAnimationFrame(() => {
        pendingResultScrollRef.current = false;
        pendingResultScrollTopRef.current = null;
        scrollToStep(resultPanelRef);
      });
    });

    return () => {
      window.cancelAnimationFrame(nextFrameId);
      window.cancelAnimationFrame(finalFrameId);
    };
  }, [result, resultPreviewMode, showResultStage]);

  useEffect(() => {
    if (!spineFrames.length) {
      setSpineAnimationFrameIndex(0);
      return;
    }

    setSpineAnimationFrameIndex((current) => (
      current < spinePreviewStartFrame || current > spinePreviewEndFrame
        ? spinePreviewStartFrame
        : current
    ));
  }, [spineFrames.length, spinePreviewEndFrame, spinePreviewStartFrame]);

  useEffect(() => {
    const frame = spineFrames[spineAnimationFrameIndex];
    if (!frame) {
      return;
    }

    drawCanvas(spineAnimationCanvasRef.current, frame.image);
  }, [spineAnimationFrameIndex, spineFrames]);

  useEffect(() => {
    if (
      !pendingSpineScrollRef.current ||
      !showSpineStage ||
      !spineDraft ||
      spinePreviewMode !== 'animation' ||
      !spineFrames.length
    ) {
      return;
    }

    const canvas = spineAnimationCanvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      return;
    }

    let nextFrameId = 0;
    let finalFrameId = 0;

    nextFrameId = window.requestAnimationFrame(() => {
      finalFrameId = window.requestAnimationFrame(() => {
        pendingSpineScrollRef.current = false;
        pendingSpineScrollTopRef.current = null;
        scrollToStep(spinePanelRef);
      });
    });

    return () => {
      window.cancelAnimationFrame(nextFrameId);
      window.cancelAnimationFrame(finalFrameId);
    };
  }, [showSpineStage, spineDraft, spineFrames, spinePreviewMode]);

  useEffect(() => {
    if (!animationFrames.length) {
      setAnimationFrameIndex(0);
      return;
    }

    setAnimationFrameIndex((current) => Math.min(current, animationFrames.length - 1));
  }, [animationFrames.length]);

  useEffect(() => {
    const frame = animationFrames[animationFrameIndex];
    if (!frame) {
      return;
    }

    drawCanvas(resultAnimationCanvasRef.current, frame.image);
  }, [animationFrameIndex, animationFrames, resultPreviewMode]);

  useEffect(() => {
    const preview = resultAnimationPreviewRef.current;
    if (!preview || resultPreviewMode !== 'animation') {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      setAnimationZoom((current) => adjustPreviewZoom(current, event.deltaY < 0 ? 1 : -1));
    };
    const detachPan = attachMiddleMousePan(preview);
    preview.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      detachPan();
      preview.removeEventListener('wheel', handleWheel);
    };
  }, [result, resultPreviewMode]);

  useEffect(() => {
    if (
      !animationPlaying ||
      resultPreviewMode !== 'animation' ||
      animationFrames.length <= 1
    ) {
      return;
    }

    const playbackFps = Math.min(Math.max(framesPerSecond, 1), 24);
    const interval = window.setInterval(() => {
      setAnimationFrameIndex((current) => (current + 1) % animationFrames.length);
    }, Math.round(1000 / playbackFps));

    return () => {
      window.clearInterval(interval);
    };
  }, [animationFrames.length, animationPlaying, framesPerSecond, resultPreviewMode]);

  useEffect(() => {
    if (
      !spineAnimationPlaying ||
      spinePreviewMode !== 'animation' ||
      spineFrames.length <= 1
    ) {
      return;
    }

    const playbackFps = Math.min(Math.max(activeSpineAnimation?.fps ?? DEFAULT_FRAMES_PER_SECOND, 1), 60);
    const interval = window.setInterval(() => {
      setSpineAnimationFrameIndex((current) => {
        if (current >= spinePreviewEndFrame) return spinePreviewStartFrame;

        return current + 1;
      });
    }, Math.round(1000 / playbackFps));

    return () => {
      window.clearInterval(interval);
    };
  }, [
    spineAnimationPlaying,
    spineFrames.length,
    activeSpineAnimation?.fps,
    spinePreviewEndFrame,
    spinePreviewMode,
    spinePreviewStartFrame,
  ]);

  useEffect(() => {
    if (!showResultStage) {
      return;
    }

    if (lastSheetPreviewConfigRef.current === null || lastSheetPreviewConfigRef.current === framePreviewRefreshKey) {
      return;
    }

    renderTaskTrackerRef.current.invalidate();
    autoPreviewInFlightRef.current = false;
    setIsRendering(false);

    if (autoPreviewTimerRef.current !== null) {
      window.clearTimeout(autoPreviewTimerRef.current);
    }

    autoPreviewTimerRef.current = window.setTimeout(() => {
      autoPreviewTimerRef.current = null;
      const taskToken = beginRenderTask();
      autoPreviewInFlightRef.current = true;
      setError(null);
      setStatus('参数已更新，正在自动刷新序列图...');
      void renderSheetPreview(taskToken)
        .catch((nextError) => {
          if (isStaleTaskError(nextError)) return;
          setError(nextError instanceof Error ? nextError.message : '自动预览失败。');
          setStatus('自动预览失败，请稍后重试。');
        })
        .finally(() => {
          if (renderTaskTrackerRef.current.isCurrent(taskToken)) {
            autoPreviewInFlightRef.current = false;
          }
          finishRenderTask(taskToken);
        });
    }, 220);

    return () => {
      if (autoPreviewTimerRef.current !== null) {
        window.clearTimeout(autoPreviewTimerRef.current);
        autoPreviewTimerRef.current = null;
      }
    };
  }, [framePreviewRefreshKey, showResultStage]);

  useEffect(() => {
    if (!hasInitializedInvalidationRef.current) {
      hasInitializedInvalidationRef.current = true;
      return;
    }

    if (!extractedFrames && !processedFrames && !result) {
      return;
    }

    clearGeneratedAssets('参数已更新，请重新生成最新结果。');
  }, [
    colorSample?.hex,
    committedColorKeySignature,
    despillEnabled,
    protectionMask,
    samplePoint?.x,
    samplePoint?.y,
    smoothing,
    softness,
    tolerance,
  ]);

  useEffect(() => {
    if (!hasInitializedAssetInvalidationRef.current) {
      hasInitializedAssetInvalidationRef.current = true;
      return;
    }

    if (!extractedFrames && !processedFrames && !result) {
      return;
    }

    setFrameSelection(null);
    setAttackFrameSelection(null);
    clearGeneratedAssets('视频片段或裁剪范围已更新，请重新抽帧并生成最新结果。');
  }, [
    framesPerSecond,
    segmentEnd,
    segmentStart,
  ]);

  useEffect(() => {
    setWatermarkRect(null);
    setWatermarkDragSelection(null);
    setWatermarkPasses([]);
    setWatermarkCanvasZoom(100);
    resetShadowDraft();
    setShadowPasses([]);
    resetProtectionMask();
    if (extractedFrames || processedFrames || result) {
      setFrameSelection(null);
      setAttackFrameSelection(null);
      clearGeneratedAssets('裁剪范围或视频已更新，请重新设置去水印或去阴影区域并抽帧。');
    }
  }, [
    cropArea.heightPercent,
    cropArea.leftPercent,
    cropArea.topPercent,
    cropArea.widthPercent,
    resizeHeight,
    resizeWidth,
    videoUrl,
  ]);

  async function updateFile(file: File): Promise<void> {
    const taskToken = fileTaskTrackerRef.current.begin();
    setError(null);
    setStatus('正在读取视频元数据...');

    disposeReferenceReader();
    setReferenceRawFrame(null);
    setReferenceFrame(null);
    setReferenceCommittedFrame(null);
    setReferenceResultFrame(null);
    setReferenceMaskFrame(null);
    setCropLeftPercent(DEFAULT_CROP_LEFT_PERCENT);
    setCropTopPercent(DEFAULT_CROP_TOP_PERCENT);
    setCropWidthPercent(DEFAULT_CROP_WIDTH_PERCENT);
    setCropHeightPercent(DEFAULT_CROP_HEIGHT_PERCENT);
    setResizeWidth(null);
    setResizeHeight(null);
    setSamplePoint(null);
    setColorSample(null);
    setCommittedColorKeys([]);
    resetProtectionMask();
    setFrameSelection(null);
    setAttackFrameSelection(null);
    setWatermarkRect(null);
    setWatermarkDragSelection(null);
    setWatermarkPasses([]);
    setCleanupTool('watermark');
    setWatermarkCanvasZoom(100);
    resetShadowDraft();
    setShadowPasses([]);
    setIsChromaStageOpen(false);
    pendingChromaScrollRef.current = false;
    pendingChromaScrollTopRef.current = null;
    pendingResultScrollRef.current = false;
    pendingResultScrollTopRef.current = null;
    clearGeneratedAssets();

    if (videoUrl) {
      revokeVideoAsset(videoUrl);
      setVideoUrl(null);
    }

    try {
      const asset = await loadVideoAsset(file);
      if (!fileTaskTrackerRef.current.isCurrent(taskToken)) {
        revokeVideoAsset(asset.url);
        return;
      }
      setVideoMeta(asset.meta);
      setVideoUrl(asset.url);
      setSegmentStart(0);
      setSegmentEnd(Number(asset.meta.duration.toFixed(3)));
      setReferenceTime(0);
      setPreviewMode('result');
      setStatus('视频已就绪，请先选择视频片段并预览，再裁剪画面。');
      scrollToStep(cropPanelRef);
    } catch (nextError) {
      if (!fileTaskTrackerRef.current.isCurrent(taskToken) || isStaleTaskError(nextError)) {
        return;
      }
      setVideoMeta(null);
      setStatus('读取失败，请换一个文件后重试。');
      setError(nextError instanceof Error ? nextError.message : '读取视频失败。');
    }
  }

  function handleDrop(fileList: FileList | null): void {
    const file = fileList?.[0];
    if (!file) {
      return;
    }

    void updateFile(file);
  }

  async function applyWatermarkToFrames(
    frames: ExtractedFrame[],
    passes: WatermarkPass[],
    taskToken: number,
  ): Promise<ExtractedFrame[]> {
    if (!passes.length) {
      return frames;
    }

    const assignments = assignWatermarkPassesToFrames(
      frames.map((frame) => frame.time),
      passes,
    );
    const nextFrames: ExtractedFrame[] = [];

    for (const [index, frame] of frames.entries()) {
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      const rects = assignments[index];
      if (!rects.length) {
        nextFrames.push(frame);
        continue;
      }

      setStatus(`正在执行第 ${index + 1} 帧去水印...`);
      nextFrames.push({
        ...frame,
        image: rects.reduce(
          (current, rect) => removeWatermarkFromCanvas(current, rect),
          frame.image,
        ),
      });
      if (index < frames.length - 1) {
        await nextFrame();
      }
    }

    return nextFrames;
  }

  async function applyShadowToFrames(
    frames: ExtractedFrame[],
    passes: ShadowPass[],
    taskToken: number,
  ): Promise<ExtractedFrame[]> {
    if (!passes.length) {
      return frames;
    }

    const assignments = assignShadowPassesToFrames(
      frames.map((frame) => frame.time),
      passes,
    );
    const nextFrames: ExtractedFrame[] = [];

    for (const [index, frame] of frames.entries()) {
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      const selections = assignments[index];
      if (!selections.length) {
        nextFrames.push(frame);
        continue;
      }

      setStatus(`正在执行第 ${index + 1} 帧去阴影...`);
      nextFrames.push({
        ...frame,
        image: selections.reduce(
          (current, selection) => removeShadowFromCanvas(current, selection),
          frame.image,
        ),
      });
      if (index < frames.length - 1) {
        await nextFrame();
      }
    }

    return nextFrames;
  }

  function getSelectedAssetsOrThrow(assets: GeneratedAssets): GeneratedAssets {
    const nextAssets = filterAssetsBySelection(assets, normalizedFrameSelection);
    if (!nextAssets.frames.length) {
      throw new Error('请至少保留 1 帧后再生成或导出。');
    }

    return nextAssets;
  }

  async function generateAssets(taskToken: number): Promise<GeneratedAssets> {
    renderTaskTrackerRef.current.assertCurrent(taskToken);
    if (!videoMeta || !videoUrl) {
      throw new Error('请先上传一个视频文件。');
    }

    if (frameLimitExceeded) {
      throw new Error(`当前片段预计会提取 ${estimatedFrameCount} 帧，请缩短片段或降低每秒帧数。`);
    }

    const outputWidth = resizeWidth ?? cropBounds?.width ?? videoMeta.width;
    const outputHeight = resizeHeight ?? cropBounds?.height ?? videoMeta.height;
    const retainedSurfaceCount = 1
      + (watermarkPasses.length || shadowPasses.length ? 1 : 0)
      + (activeColorKeySequence.length ? 2 : 0);
    assertFrameMemoryBudget(
      outputWidth,
      outputHeight,
      estimatedFrameCount,
      retainedSurfaceCount,
      '抽帧任务',
    );

    setError(null);

    setStatus(`正在抽取序列帧 0/${estimatedFrameCount}...`);
    const frames = await extractFrames(
      videoUrl,
      videoMeta,
      {
        framesPerSecond,
        segmentStart,
        segmentEnd,
        cropArea,
        resizeWidth,
        resizeHeight,
      },
      (current, total) => {
        renderTaskTrackerRef.current.assertCurrent(taskToken);
        setStatus(`正在抽取序列帧 ${current}/${total}...`);
      },
    );
    renderTaskTrackerRef.current.assertCurrent(taskToken);
    const framesWithWatermarkHandled = await applyWatermarkToFrames(
      frames,
      watermarkPasses,
      taskToken,
    );
    renderTaskTrackerRef.current.assertCurrent(taskToken);
    const framesWithCleanupHandled = await applyShadowToFrames(
      framesWithWatermarkHandled,
      shadowPasses,
      taskToken,
    );
    renderTaskTrackerRef.current.assertCurrent(taskToken);
    setFrameSelection((current) =>
      current
        ? normalizeFrameSelection(current, framesWithCleanupHandled.length)
        : createFrameSelection(framesWithCleanupHandled.length),
    );
    setAttackFrameSelection((current) =>
      normalizeAttackFrameSelection(current, framesWithCleanupHandled.length),
    );

    if (!activeColorKeySequence.length) {
      setExtractedFrames(framesWithCleanupHandled);
      setProcessedFrames(null);

      return {
        frames: framesWithCleanupHandled,
        processed: null,
      };
    }

    const nextProcessedFrames: ProcessedFrame[] = [];

    for (const [index, frame] of framesWithCleanupHandled.entries()) {
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      setStatus(`正在执行 ChromaKey 抠像 ${index + 1}/${framesWithCleanupHandled.length}...`);
      nextProcessedFrames.push(
        processExtractedFrameWithSequence(frame, activeColorKeySequence, protectionMask),
      );
      if (index < framesWithCleanupHandled.length - 1) {
        await nextFrame();
      }
    }

    setExtractedFrames(framesWithCleanupHandled);
    setProcessedFrames(nextProcessedFrames);

    return {
      frames: framesWithCleanupHandled,
      processed: nextProcessedFrames,
    };
  }

  async function ensureAssets(taskToken: number): Promise<GeneratedAssets> {
    renderTaskTrackerRef.current.assertCurrent(taskToken);
    if (extractedFrames) {
      return {
        frames: extractedFrames,
        processed: processedFrames,
      };
    }

    return generateAssets(taskToken);
  }

  async function renderSheetPreview(
    taskToken: number,
    assets?: GeneratedAssets,
  ): Promise<SheetPreviewResult> {
    renderTaskTrackerRef.current.assertCurrent(taskToken);
    if (!outputVideoMeta) {
      throw new Error('请先上传视频。');
    }

    const currentAssets = getSelectedAssetsOrThrow(assets ?? (await ensureAssets(taskToken)));
    const transparent = Boolean(currentAssets.processed);
    const framesForRender = currentAssets.processed
      ? toTransparentSheetFrames(currentAssets.processed)
      : currentAssets.frames;

    setStatus(transparent ? '正在拼接透明序列表...' : '正在拼接序列图...');
    const renderResult = await renderFrameSheet(
      framesForRender,
      outputVideoMeta,
      sheetOptions,
      false,
      getSheetAppearance(transparent),
    );
    if (!renderTaskTrackerRef.current.isCurrent(taskToken)) {
      URL.revokeObjectURL(renderResult.objectUrl);
      renderTaskTrackerRef.current.assertCurrent(taskToken);
    }

    replacePreviewResult(renderResult, transparent);
    lastSheetPreviewConfigRef.current = framePreviewRefreshKey;
    setStatus(transparent ? '透明序列图已生成，可以继续预览或下载。' : '普通序列图已生成，可以继续预览或下载。');

    return {
      renderResult,
      transparent,
    };
  }

  async function handleGeneratePreview(): Promise<void> {
    const taskToken = beginRenderTask();
    try {
      const assets = await generateAssets(taskToken);
      await renderSheetPreview(taskToken, assets);
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      setResultPreviewMode('animation');
      scrollToStep(resultPanelRef);
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : '生成失败。');
      setStatus('生成失败，请调整参数后重试。');
    } finally {
      finishRenderTask(taskToken);
    }
  }

  async function handleDownloadSheet(): Promise<void> {
    const taskToken = beginRenderTask();
    try {
      const preview = await renderSheetPreview(taskToken);
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      triggerBlobDownload(
        preview.renderResult.blob,
        getSheetFileName(baseFileName, preview.transparent),
      );
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : '导出失败。');
      setStatus('导出失败，请稍后再试。');
    } finally {
      finishRenderTask(taskToken);
    }
  }

  async function handleDownloadZip(): Promise<void> {
    const taskToken = beginRenderTask();
    try {
      const assets = getSelectedAssetsOrThrow(await ensureAssets(taskToken));
      if (!assets.processed) {
        throw new Error('透明帧 ZIP 需要先启用背景扣像并完成取色。');
      }

      setError(null);
      setStatus('正在打包透明 PNG ZIP...');
      const blob = await buildTransparentFramesZip(assets.processed, baseFileName);
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      triggerBlobDownload(blob, getZipFileName(baseFileName));
      setStatus('透明 PNG ZIP 已生成并开始下载。');
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : '打包 ZIP 失败。');
      setStatus('ZIP 导出失败，请稍后再试。');
    } finally {
      finishRenderTask(taskToken);
    }
  }

  async function handleDownloadGif(): Promise<void> {
    const taskToken = beginRenderTask();
    try {
      const assets = getSelectedAssetsOrThrow(await ensureAssets(taskToken));
      const transparent = Boolean(assets.processed);
      const framesForGif = transparent
        ? toTransparentSheetFrames(assets.processed ?? [])
        : assets.frames;

      if (!framesForGif.length) {
        throw new Error('没有可导出的序列帧，请先生成预览。');
      }

      setError(null);
      setStatus('正在分析 GIF 调色板...');
      assertFrameMemoryBudget(
        framesForGif[0].image.width,
        framesForGif[0].image.height,
        framesForGif.length,
        transparent ? 4 : 2,
        'GIF 导出',
      );

      const blob = await buildAnimatedGif(framesForGif, {
        fps: framesPerSecond,
        transparent,
        onProgress: (progress) => {
          renderTaskTrackerRef.current.assertCurrent(taskToken);
          if (progress.phase === 'palette') {
            setStatus(`正在分析 GIF 调色板 ${progress.current}/${progress.total}...`);
            return;
          }

          setStatus(`正在编码 GIF ${progress.current}/${progress.total}...`);
        },
      });

      renderTaskTrackerRef.current.assertCurrent(taskToken);
      triggerBlobDownload(blob, getGifFileName(baseFileName, transparent));
      setStatus('GIF 已生成并开始下载。');
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : 'GIF 导出失败。');
      setStatus('GIF 导出失败，请稍后再试。');
    } finally {
      finishRenderTask(taskToken);
    }
  }

  async function handleOpenSpineWorkspace(): Promise<void> {
    const taskToken = beginRenderTask();
    try {
      if (!outputVideoMeta) {
        throw new Error('请先上传视频并生成可用帧数据。');
      }

      setError(null);
      const assets = getSelectedAssetsOrThrow(await ensureAssets(taskToken));
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      const nextDraft = buildSpineDraftFromAssets(
        assets,
        baseFileName,
        outputVideoMeta.width,
        outputVideoMeta.height,
        sheetOptions,
        getSelectedAttackFrameIndices(
          normalizedFrameSelection,
          normalizedAttackFrameSelection,
          extractedFrames?.length ?? assets.frames.length,
        ),
      );

      pendingSpineScrollTopRef.current = window.scrollY;
      pendingSpineScrollRef.current = true;
      setSpineDraft(nextDraft);
      const firstAnimation = createSpineAnimationClip(nextDraft.frames.length, 0, framesPerSecond);
      setSpineOptions({
        skeletonName: baseFileName,
        slotName: 'sprite',
        animations: [firstAnimation],
      });
      setActiveSpineAnimationId(firstAnimation.id);
      setSpineAnimationFrameIndex(0);
      setSpineAnimationPlaying(true);
      setStatus('Spine 动画工作区已准备好，可以继续预览或下载 Spine ZIP。');
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      pendingSpineScrollRef.current = false;
      pendingSpineScrollTopRef.current = null;
      setError(nextError instanceof Error ? nextError.message : '打开 Spine 工作区失败。');
      setStatus('Spine 工作区打开失败，请稍后重试。');
    } finally {
      finishRenderTask(taskToken);
    }
  }

  function selectSpineAnimation(clip: SpineAnimationClip): void {
    setActiveSpineAnimationId(clip.id);
    setSpineAnimationFrameIndex(clip.startFrame);
    setSpineAnimationPlaying(true);
  }

  function updateSpineAnimation(
    clipId: string,
    update: Partial<Omit<SpineAnimationClip, 'id'>>,
  ): void {
    setSpineOptions((current) => ({
      ...current,
      animations: current.animations.map((clip) => (
        clip.id === clipId ? { ...clip, ...update } : clip
      )),
    }));
  }

  function addSpineAnimation(): void {
    const clip = createSpineAnimationClip(
      spineFrames.length,
      spineOptions.animations.length,
      activeSpineAnimation?.fps ?? framesPerSecond,
    );
    setSpineOptions((current) => ({
      ...current,
      animations: [...current.animations, clip],
    }));
    selectSpineAnimation(clip);
  }

  function removeSpineAnimation(clipId: string): void {
    if (spineOptions.animations.length <= 1) {
      return;
    }

    const nextAnimations = spineOptions.animations.filter((clip) => clip.id !== clipId);
    setSpineOptions((current) => ({ ...current, animations: nextAnimations }));
    const nextActive = nextAnimations.find((clip) => clip.id !== clipId) ?? null;
    if (nextActive) {
      selectSpineAnimation(nextActive);
    }
  }

  async function handleDownloadSpineZip(): Promise<void> {
    const taskToken = beginRenderTask();
    try {
      if (!spineDraft) {
        throw new Error('请先进入 Spine 动画工作区。');
      }

      setError(null);
      setStatus('正在按第 7 步排布生成单张 Spine 图集 PNG + JSON ZIP...');
      const usedFrameIndices = getUsedSpineFrameIndices(
        spineOptions.animations,
        spineDraft.sourceFrameCount,
      );
      if (!usedFrameIndices.length) {
        throw new Error('请至少为一个动作设置可用帧范围。');
      }
      const exportDraft = {
        ...spineDraft,
        sheetOptions,
        frames: usedFrameIndices.map((index) => spineDraft.frames[index]),
        sourceFrameIndices: usedFrameIndices,
        attackFrameIndices: usedFrameIndices.filter((index) => (
          spineDraft.attackFrameIndices.includes(index)
        )),
      };
      const atlas = await renderFrameSheet(
        exportDraft.frames,
        {
          duration: 0,
          width: exportDraft.width,
          height: exportDraft.height,
          name: exportDraft.baseName,
        },
        exportDraft.sheetOptions,
        false,
        getSheetAppearance(spineDraft.transparent),
        false,
      );
      if (!renderTaskTrackerRef.current.isCurrent(taskToken)) {
        URL.revokeObjectURL(atlas.objectUrl);
        renderTaskTrackerRef.current.assertCurrent(taskToken);
      }
      let blob: Blob;
      try {
        blob = await buildSpineBundleZip(exportDraft, spineOptions, atlas);
      } finally {
        URL.revokeObjectURL(atlas.objectUrl);
      }
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      triggerBlobDownload(blob, getSpineZipFileName(spineDraft.baseName));
      setStatus('Spine ZIP 已生成并开始下载。');
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : 'Spine 导出失败。');
      setStatus('Spine ZIP 导出失败，请稍后再试。');
    } finally {
      finishRenderTask(taskToken);
    }
  }

  function resetCropArea(): void {
    setDragSelection(null);
    setCropLeftPercent(DEFAULT_CROP_LEFT_PERCENT);
    setCropTopPercent(DEFAULT_CROP_TOP_PERCENT);
    setCropWidthPercent(DEFAULT_CROP_WIDTH_PERCENT);
    setCropHeightPercent(DEFAULT_CROP_HEIGHT_PERCENT);
  }

  function applyCropArea(nextCropArea: CropArea): void {
    const normalized = normalizeCropArea(nextCropArea);
    setCropLeftPercent(normalized.leftPercent);
    setCropTopPercent(normalized.topPercent);
    setCropWidthPercent(normalized.widthPercent);
    setCropHeightPercent(normalized.heightPercent);
  }

  function handleCropLeftChange(value: number): void {
    setDragSelection(null);
    const nextLeft = clampPercent(value, 0, 99);
    setCropLeftPercent(nextLeft);
    setCropWidthPercent((current) => clampPercent(current, 1, 100 - nextLeft));
  }

  function handleCropTopChange(value: number): void {
    setDragSelection(null);
    const nextTop = clampPercent(value, 0, 99);
    setCropTopPercent(nextTop);
    setCropHeightPercent((current) => clampPercent(current, 1, 100 - nextTop));
  }

  function handleCropWidthChange(value: number): void {
    setDragSelection(null);
    setCropWidthPercent(clampPercent(value, 1, 100 - cropLeftPercent));
  }

  function handleCropHeightChange(value: number): void {
    setDragSelection(null);
    setCropHeightPercent(clampPercent(value, 1, 100 - cropTopPercent));
  }

  function handleCropPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceRawFrame) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceRawFrame.width,
      referenceRawFrame.height,
    );
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragSelection({
      start: point,
      current: point,
    });
  }

  function handleCropPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceRawFrame || !dragSelection) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceRawFrame.width,
      referenceRawFrame.height,
    );
    setDragSelection((current) =>
      current
        ? {
            ...current,
            current: point,
          }
        : current,
    );
  }

  function finishCropSelection(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceRawFrame || !dragSelection) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceRawFrame.width,
      referenceRawFrame.height,
    );
    const selectionWidth = Math.abs(point.x - dragSelection.start.x);
    const selectionHeight = Math.abs(point.y - dragSelection.start.y);

    event.currentTarget.releasePointerCapture(event.pointerId);

    if (selectionWidth < 8 || selectionHeight < 8) {
      setDragSelection(null);
      setStatus('框选区域过小，请重新拖拽鼠标选择裁剪范围。');
      return;
    }

    applyCropArea(
      getCropAreaFromSelection(
        dragSelection.start,
        point,
        referenceRawFrame.width,
        referenceRawFrame.height,
      ),
    );
    setDragSelection(null);
    setStatus('裁剪区域已更新，可以确认片段与裁剪并提取参考帧。');
    scrollToStep(controlsPanelRef);
  }

  function handleCropPointerCancel(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setDragSelection(null);
  }

  function handleResizeWidthChange(value: number): void {
    const width = Math.min(MAX_FRAME_SIDE, Math.max(1, Math.round(value)));
    if (resizeLocked && cropBounds) {
      const fitted = fitDimensionsWithinSide(
        width,
        Math.max(1, Math.round((width * cropBounds.height) / cropBounds.width)),
        MAX_FRAME_SIDE,
      );
      setResizeWidth(fitted.width);
      setResizeHeight(fitted.height);
      return;
    }
    setResizeWidth(width);
  }

  function handleResizeHeightChange(value: number): void {
    const height = Math.min(MAX_FRAME_SIDE, Math.max(1, Math.round(value)));
    if (resizeLocked && cropBounds) {
      const fitted = fitDimensionsWithinSide(
        Math.max(1, Math.round((height * cropBounds.width) / cropBounds.height)),
        height,
        MAX_FRAME_SIDE,
      );
      setResizeWidth(fitted.width);
      setResizeHeight(fitted.height);
      return;
    }
    setResizeHeight(height);
  }

  function paintProtectionMaskToPoint(point: MaskPoint): void {
    if (!referenceCommittedFrame || protectionBrushMode === 'off') {
      return;
    }

    const expectedLength = referenceCommittedFrame.width * referenceCommittedFrame.height;
    const mask =
      protectionMaskRef.current?.length === expectedLength
        ? protectionMaskRef.current
        : new Uint8Array(expectedLength);
    const start = protectionLastPointRef.current ?? point;
    paintProtectionStroke(
      mask,
      referenceCommittedFrame.width,
      referenceCommittedFrame.height,
      start,
      point,
      protectionBrushSize / 2,
      protectionBrushMode === 'protect',
    );
    protectionMaskRef.current = mask;
    protectionLastPointRef.current = point;
    setProtectionMask(new Uint8Array(mask));
  }

  function selectProtectionBrushMode(mode: ProtectionBrushMode): void {
    setProtectionBrushMode(mode);
    if (mode === 'off') {
      setStatus('已退出保护笔刷，可继续点击画面取背景色。');
      return;
    }

    setSamplePoint(null);
    setColorSample(null);
    setStatus(
      mode === 'protect'
        ? '保护笔刷已开启，请在人物或特效上涂抹绿色保护区域。'
        : '保护橡皮擦已开启，请涂抹要取消保护的区域。',
    );
  }

  function handleProtectionPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceCommittedFrame || protectionBrushMode === 'off') {
      return;
    }

    event.preventDefault();
    const expectedLength = referenceCommittedFrame.width * referenceCommittedFrame.height;
    const currentMask =
      protectionMaskRef.current?.length === expectedLength
        ? new Uint8Array(protectionMaskRef.current)
        : new Uint8Array(expectedLength);
    setProtectionUndoStack((current) => [...current.slice(-19), currentMask]);
    protectionMaskRef.current = new Uint8Array(currentMask);
    protectionPaintingRef.current = true;
    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceCommittedFrame.width,
      referenceCommittedFrame.height,
    );
    protectionLastPointRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    paintProtectionMaskToPoint(point);
  }

  function handleProtectionPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceCommittedFrame || !protectionPaintingRef.current) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceCommittedFrame.width,
      referenceCommittedFrame.height,
    );
    paintProtectionMaskToPoint(point);
  }

  function finishProtectionStroke(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceCommittedFrame || !protectionPaintingRef.current) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceCommittedFrame.width,
      referenceCommittedFrame.height,
    );
    paintProtectionMaskToPoint(point);
    protectionPaintingRef.current = false;
    protectionLastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setStatus(
      protectionBrushMode === 'protect'
        ? '保护区域已更新，绿色区域不会被抠像影响。'
        : '已擦除部分保护区域。',
    );
  }

  function handleProtectionPointerCancel(event: React.PointerEvent<HTMLCanvasElement>): void {
    protectionPaintingRef.current = false;
    protectionLastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleUndoProtectionStroke(): void {
    const previous = protectionUndoStack[protectionUndoStack.length - 1];
    if (!previous) {
      return;
    }

    const restored = new Uint8Array(previous);
    protectionMaskRef.current = restored;
    setProtectionMask(restored);
    setProtectionUndoStack((current) => current.slice(0, -1));
    setStatus('已撤销上一次保护笔刷操作。');
  }

  function handleClearProtectionMask(): void {
    if (!protectionMask || protectedPixelCount === 0) {
      return;
    }

    setProtectionUndoStack((current) => [
      ...current.slice(-19),
      new Uint8Array(protectionMask),
    ]);
    protectionMaskRef.current = null;
    setProtectionMask(null);
    setStatus('已清空全部抠像保护区域。');
  }

  function handleReferenceCanvasClick(event: React.MouseEvent<HTMLCanvasElement>): void {
    if (
      protectionBrushMode !== 'off' ||
      !referenceCommittedFrame ||
      !referenceCanvasRef.current
    ) {
      return;
    }

    const rect = referenceCanvasRef.current.getBoundingClientRect();
    const ratioX = referenceCommittedFrame.width / rect.width;
    const ratioY = referenceCommittedFrame.height / rect.height;
    const x = Math.round((event.clientX - rect.left) * ratioX);
    const y = Math.round((event.clientY - rect.top) * ratioY);

    setSamplePoint({
      x,
      y,
    });
    setStatus(
      hasCommittedColorKeys
        ? '新背景颜色已采样，可以继续调整参数，或先应用当前抠像再继续下一轮。'
        : '背景颜色已采样，可以继续调整容差、羽化和去溢色。',
    );
    if (!samplePoint) {
      scrollToStep(chromaActionsRef);
    }
  }

  function handleCommitCurrentColorKey(): void {
    if (!colorKeyOptions) {
      return;
    }

    const nextCount = committedColorKeys.length + 1;
    setCommittedColorKeys((current) => [...current, colorKeyOptions]);
    setSamplePoint(null);
    setColorSample(null);
    setPreviewMode('result');
    setStatus(`已应用第 ${nextCount} 次抠像，可继续点击下一种背景颜色。`);
  }

  function handleResetCommittedColorKeys(): void {
    if (!committedColorKeys.length) {
      return;
    }

    setCommittedColorKeys([]);
    setSamplePoint(null);
    setColorSample(null);
    setPreviewMode('result');
    setStatus('已重置为原始参考帧，可重新开始抠像。');
  }

  function handleFrameSelectionChange(index: number, checked: boolean): void {
    setFrameSelection((current) => {
      const base = normalizeFrameSelection(current, extractedFrames?.length ?? 0);
      if (index < 0 || index >= base.length) {
        return base;
      }

      const next = [...base];
      next[index] = checked;
      return next;
    });
  }

  function handleAttackFrameSelectionChange(index: number, checked: boolean): void {
    setAttackFrameSelection((current) => {
      const base = normalizeAttackFrameSelection(current, extractedFrames?.length ?? 0);
      if (index < 0 || index >= base.length) {
        return base;
      }

      const next = [...base];
      next[index] = checked;
      return next;
    });
  }

  function handleSelectAllFrames(): void {
    setFrameSelection(createFrameSelection(extractedFrames?.length ?? 0));
  }

  function handleInvertFrameSelection(): void {
    setFrameSelection((current) =>
      normalizeFrameSelection(current, extractedFrames?.length ?? 0).map((enabled) => !enabled),
    );
  }

  function handleIntervalFrameSelection(skippedFrames: number): void {
    setFrameSelection(
      createIntervalFrameSelection(extractedFrames?.length ?? 0, skippedFrames),
    );
  }

  function handleWatermarkPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0 || !referenceFrame) {
      return;
    }

    watermarkVideoRef.current?.pause();
    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceFrame.width,
      referenceFrame.height,
    );
    event.currentTarget.setPointerCapture(event.pointerId);
    setWatermarkDragSelection({
      start: point,
      current: point,
    });
  }

  function handleWatermarkPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceFrame || !watermarkDragSelection) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceFrame.width,
      referenceFrame.height,
    );
    setWatermarkDragSelection((current) =>
      current
        ? {
            ...current,
            current: point,
          }
        : current,
    );
  }

  function handleWatermarkPointerUp(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceFrame || !watermarkDragSelection) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceFrame.width,
      referenceFrame.height,
    );
    const rect = getPixelBoundsFromSelection(
      watermarkDragSelection.start,
      point,
      referenceFrame.width,
      referenceFrame.height,
    );

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setWatermarkDragSelection(null);
    if (rect.width < 4 || rect.height < 4) {
      setStatus('去水印框选区域过小，请重新拖拽选择。');
      return;
    }

    setWatermarkRect(rect);
    setStatus('去水印区域已选中，可应用到全部帧，或仅对当前帧补漏。');
  }

  function handleWatermarkPointerCancel(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setWatermarkDragSelection(null);
  }

  function selectCleanupTool(nextTool: CleanupTool): void {
    watermarkVideoRef.current?.pause();
    setCleanupTool(nextTool);
    setWatermarkDragSelection(null);
    shadowDraggingPointRef.current = null;
    setStatus(
      nextTool === 'shadow'
        ? shadowPathClosed
          ? '钢笔去阴影已开启，可切换到取色模式继续处理同一路径内的其他阴影色。'
          : '钢笔去阴影已开启，请沿阴影外围逐点添加锚点。'
        : '矩形去水印已开启，请在画面上拖拽框选水印。',
    );
  }

  function selectShadowInteractionMode(nextMode: ShadowInteractionMode): void {
    if (nextMode === 'sample' && !shadowPathClosed) {
      setStatus('请先添加至少 3 个锚点并闭合路径，再切换到阴影取色。');
      return;
    }

    setShadowInteractionMode(nextMode);
    setStatus(
      nextMode === 'sample'
        ? '阴影取色已开启，请在闭合路径内点击需要处理的阴影颜色。'
        : shadowPathClosed
          ? '钢笔编辑已开启，可拖动锚点；如需增删锚点，请先重新打开路径。'
          : '钢笔编辑已开启，请沿阴影外围逐点添加锚点。',
    );
  }

  function closeShadowPath(): void {
    if (!referenceFrameAfterCleanup || shadowPoints.length < 3) {
      setStatus('至少添加 3 个锚点后才能闭合阴影路径。');
      return;
    }

    const polygonMask = buildPolygonMask(
      referenceFrameAfterCleanup.width,
      referenceFrameAfterCleanup.height,
      shadowPoints,
    );
    if (!polygonMask.some(Boolean)) {
      setStatus('当前阴影路径面积过小，请调整锚点后重试。');
      return;
    }

    setShadowPathClosed(true);
    setShadowInteractionMode('sample');
    setShadowSample(null);
    setStatus('路径已闭合，已切换到阴影取色；同一路径可连续处理多种阴影颜色。');
  }

  function handleShadowPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0 || !referenceFrameAfterCleanup) {
      return;
    }

    watermarkVideoRef.current?.pause();
    const rawPoint = getCanvasPoint(
      event,
      event.currentTarget,
      referenceFrameAfterCleanup.width,
      referenceFrameAfterCleanup.height,
    );
    const point = {
      x: Math.max(0, Math.min(referenceFrameAfterCleanup.width - 1, rawPoint.x)),
      y: Math.max(0, Math.min(referenceFrameAfterCleanup.height - 1, rawPoint.y)),
    };
    if (shadowInteractionMode === 'sample') {
      if (!shadowPathClosed) {
        setStatus('请先闭合路径，再使用阴影取色。');
        return;
      }

      const polygonMask = buildPolygonMask(
        referenceFrameAfterCleanup.width,
        referenceFrameAfterCleanup.height,
        shadowPoints,
      );
      if (!polygonMask[point.y * referenceFrameAfterCleanup.width + point.x]) {
        setStatus('请在闭合路径内部点击阴影颜色。');
        return;
      }

      try {
        setShadowSample(
          sampleCanvasColor(referenceFrameAfterCleanup, point.x, point.y, 0),
        );
        setStatus('阴影颜色已取样，紫色蒙版内的像素会完整替换为周边背景。');
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : '阴影颜色取样失败。');
      }
      return;
    }

    const hitRadius = Math.max(8, referenceFrameAfterCleanup.width / 80);
    const hitIndex = shadowPoints.findIndex(
      (anchor) => Math.hypot(anchor.x - point.x, anchor.y - point.y) <= hitRadius,
    );

    if (!shadowPathClosed && shadowPoints.length >= 3 && hitIndex === 0) {
      closeShadowPath();
      return;
    }

    if (hitIndex >= 0) {
      shadowDraggingPointRef.current = hitIndex;
      setShadowSample(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    if (!shadowPathClosed) {
      setShadowPoints((current) => [...current, point]);
      setStatus(`已添加第 ${shadowPoints.length + 1} 个锚点；点击橙色起点或“闭合路径”完成范围。`);
      return;
    }

    setStatus('钢笔编辑模式下可拖动锚点；切换到“阴影取色”后再点击颜色。');
  }

  function handleShadowPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    const pointIndex = shadowDraggingPointRef.current;
    if (!referenceFrameAfterCleanup || pointIndex === null) {
      return;
    }

    const rawPoint = getCanvasPoint(
      event,
      event.currentTarget,
      referenceFrameAfterCleanup.width,
      referenceFrameAfterCleanup.height,
    );
    const point = {
      x: Math.max(0, Math.min(referenceFrameAfterCleanup.width - 1, rawPoint.x)),
      y: Math.max(0, Math.min(referenceFrameAfterCleanup.height - 1, rawPoint.y)),
    };
    setShadowPoints((current) =>
      current.map((anchor, index) => (index === pointIndex ? point : anchor)),
    );
  }

  function finishShadowPointDrag(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (shadowDraggingPointRef.current !== null) {
      setStatus(
        shadowPathClosed
          ? '锚点已调整，请切换到“阴影取色”后重新点击阴影颜色。'
          : '锚点已调整，可继续添加或闭合路径。',
      );
    }
    shadowDraggingPointRef.current = null;
  }

  function handleShadowPointerCancel(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    shadowDraggingPointRef.current = null;
  }

  function handleUndoShadowPoint(): void {
    if (!shadowPoints.length || shadowPathClosed) {
      return;
    }

    setShadowPoints((current) => current.slice(0, -1));
    setShadowSample(null);
    setStatus('已撤销最后一个阴影锚点。');
  }

  function handleReopenShadowPath(): void {
    if (!shadowPathClosed) {
      return;
    }

    setShadowPathClosed(false);
    setShadowInteractionMode('pen');
    setShadowSample(null);
    setStatus('路径已重新打开，可拖动锚点、撤销锚点或继续添加。');
  }

  function handleClearShadowDraft(): void {
    resetShadowDraft();
    setStatus('已清除当前阴影路径。');
  }

  function handleClearWatermarkRect(): void {
    setWatermarkRect(null);
    setWatermarkDragSelection(null);
    setStatus('已清除当前框选。');
  }

  function invalidateAssetsAfterCleanupChange(nextStatus: string): void {
    if (extractedFrames || processedFrames || result) {
      setFrameSelection(null);
      setAttackFrameSelection(null);
      clearGeneratedAssets(nextStatus);
      return;
    }

    setStatus(nextStatus);
  }

  function handleApplyWatermarkToCurrentFrame(): void {
    if (!watermarkRect) {
      setStatus('请先在当前帧上框选水印区域。');
      return;
    }

    const frameTime = getNearestFrameTime(sampleTimes, referenceTime);
    if (frameTime === null) {
      setStatus('当前片段没有可处理的抽帧时间点。');
      return;
    }

    setReferenceTime(frameTime);
    setWatermarkPasses((current) => [
      ...current,
      { scope: 'frame', time: frameTime, rect: watermarkRect },
    ]);
    setWatermarkRect(null);
    setWatermarkDragSelection(null);
    invalidateAssetsAfterCleanupChange(
      `已完成第 ${watermarkPasses.length + 1} 次去水印，仅作用于 ${formatTimestamp(frameTime)} 对应帧。`,
    );
  }

  function handleApplyWatermarkToAllFrames(): void {
    if (!watermarkRect) {
      setStatus('请先在当前画面上框选水印区域。');
      return;
    }

    setWatermarkPasses((current) => [
      ...current,
      { scope: 'all', rect: watermarkRect },
    ]);
    setWatermarkDragSelection(null);
    invalidateAssetsAfterCleanupChange(
      `已完成第 ${watermarkPasses.length + 1} 次去水印，当前区域将应用到全部抽帧。`,
    );
  }

  function handleUndoWatermarkPass(): void {
    if (!watermarkPasses.length) {
      return;
    }

    setWatermarkPasses((current) => current.slice(0, -1));
    invalidateAssetsAfterCleanupChange('已撤销上一次去水印操作。');
  }

  function handleClearWatermarkPasses(): void {
    if (!watermarkPasses.length) {
      return;
    }

    setWatermarkPasses([]);
    setWatermarkRect(null);
    setWatermarkDragSelection(null);
    invalidateAssetsAfterCleanupChange('已清空步骤4的全部去水印操作。');
  }

  function getShadowSelectionForPass(): ShadowSelection | null {
    if (!activeShadowSelection) {
      setStatus('请先闭合阴影路径，并在路径内点击阴影颜色。');
      return null;
    }

    return {
      ...activeShadowSelection,
      points: activeShadowSelection.points.map((point) => ({ ...point })),
      seed: { ...activeShadowSelection.seed },
      sample: { ...activeShadowSelection.sample },
    };
  }

  function handleApplyShadowToCurrentFrame(): void {
    const selection = getShadowSelectionForPass();
    if (!selection) {
      return;
    }

    const frameTime = getNearestFrameTime(sampleTimes, referenceTime);
    if (frameTime === null) {
      setStatus('当前片段没有可处理的抽帧时间点。');
      return;
    }

    setReferenceTime(frameTime);
    setShadowPasses((current) => [
      ...current,
      { scope: 'frame', time: frameTime, selection },
    ]);
    setShadowSample(null);
    setShadowInteractionMode('sample');
    invalidateAssetsAfterCleanupChange(
      `已完成第 ${shadowPasses.length + 1} 次去阴影，仅作用于 ${formatTimestamp(frameTime)} 对应帧；当前路径已保留，可继续取色。`,
    );
  }

  function handleApplyShadowToAllFrames(): void {
    const selection = getShadowSelectionForPass();
    if (!selection) {
      return;
    }

    setShadowPasses((current) => [
      ...current,
      { scope: 'all', selection },
    ]);
    setShadowSample(null);
    setShadowInteractionMode('sample');
    invalidateAssetsAfterCleanupChange(
      `已完成第 ${shadowPasses.length + 1} 次去阴影，当前路径将应用到全部抽帧；可继续取下一种颜色。`,
    );
  }

  function handleUndoShadowPass(): void {
    if (!shadowPasses.length) {
      return;
    }

    setShadowPasses((current) => current.slice(0, -1));
    invalidateAssetsAfterCleanupChange('已撤销上一次去阴影操作。');
  }

  function handleClearShadowPasses(): void {
    if (!shadowPasses.length) {
      return;
    }

    setShadowPasses([]);
    setShadowSample(null);
    setShadowInteractionMode(shadowPathClosed ? 'sample' : 'pen');
    invalidateAssetsAfterCleanupChange('已清空步骤4的全部去阴影操作，当前路径已保留。');
  }

  function switchAppMode(nextMode: AppMode): void {
    setAppMode(nextMode);
    setSpineDraft(null);
    setActiveSpineAnimationId(null);
    setSamplePoint(null);
    setColorSample(null);
    setCommittedColorKeys([]);
    resetProtectionMask();
    setFrameSelection(null);
    setAttackFrameSelection(null);
    setWatermarkRect(null);
    setWatermarkDragSelection(null);
    setWatermarkPasses([]);
    setCleanupTool('watermark');
    setWatermarkCanvasZoom(100);
    resetShadowDraft();
    setShadowPasses([]);
    setPreviewMode('result');

    if (nextMode === 'cutout') {
      setIsChromaStageOpen(false);
      setReferenceRawFrame(null);
      setReferenceFrame(null);
      setReferenceResultFrame(null);
      setReferenceMaskFrame(null);
    }

    clearGeneratedAssets(
      nextMode === 'cutout'
        ? '已切换到图片背景抠图功能，请上传图片并点选背景颜色。'
        : nextMode === 'resize'
          ? '已切换到图片尺寸工具，请上传图片并设置目标尺寸。'
          : nextMode === 'compress'
            ? '已切换到图片压缩工具，请上传图片并设置压缩参数。'
            : '已切换回视频转序列帧表。'
    );
  }

  return (
    <div className="page-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <main className="app-card">
        <section className="hero">
          <h1 className="hero-title">
            <span className="hero-title__main">
              {isCutoutMode
                ? '背景抠图工具'
                : isResizeMode
                  ? '图片尺寸工具'
                  : isCompressMode
                    ? '图片压缩工具'
                    : '视频转序列帧表'}
            </span>
            <span className="hero-title__version">
              {isSheetMode ? '2.0' : '1.0'}
            </span>
          </h1>
          <div className="hero-tool-row">
            <p className="hero-tool-copy">{'\u66F4\u591A\u5DE5\u5177\uFF1A'}</p>
            <div className="hero-links">
              <button
                className={`hero-link hero-link--button ${isSheetMode ? 'is-active' : ''}`}
                type="button"
                onClick={() => switchAppMode('sheet')}
              >
                序列帧工具
              </button>
              <button
                className={`hero-link hero-link--button ${isCutoutMode ? 'is-active' : ''}`}
                type="button"
                onClick={() => switchAppMode('cutout')}
              >
                背景抠图工具
              </button>
              <button
                className={`hero-link hero-link--button ${isResizeMode ? 'is-active' : ''}`}
                type="button"
                onClick={() => switchAppMode('resize')}
              >
                图片尺寸工具
              </button>
              <button
                className={`hero-link hero-link--button ${isCompressMode ? 'is-active' : ''}`}
                type="button"
                onClick={() => switchAppMode('compress')}
              >
                图片压缩工具
              </button>
            </div>
          </div>
        </section>

        <div className="status-banner status-banner--global">{status}</div>

        <Suspense
          fallback={(
            <section className="workspace-grid workspace-grid--single">
              <div className="panel upload-panel">正在加载工具...</div>
            </section>
          )}
        >
          {isCutoutMode ? (
            <ImageCutoutTool onStatusChange={setStatus} />
          ) : isResizeMode ? (
            <ImageResizeTool onStatusChange={setStatus} />
          ) : isCompressMode ? (
            <ImageCompressTool onStatusChange={setStatus} />
          ) : (
          <section className="workspace-grid workspace-grid--single">
            <div className="panel upload-panel">
              <div className="panel-head">
                <h2>1. 上传视频</h2>
              </div>

            <input
              ref={inputRef}
              hidden
              accept="video/*"
              type="file"
              onChange={(event) => {
                handleDrop(event.target.files);
                event.currentTarget.value = '';
              }}
            />

            <div className={`upload-layout ${videoUrl ? 'upload-layout--with-preview' : ''}`}>
              <button
                className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  handleDrop(event.dataTransfer.files);
                }}
              >
                <span className="dropzone-kicker">拖放视频到这里</span>
                <strong>或点击选择本地文件</strong>
                <small>推荐使用单色背景视频。纯前端处理时，长视频会消耗更多浏览器内存。</small>
              </button>

              {videoUrl ? (
                <div className="video-preview-card">
                  <span>视频预览</span>
                  <video className="upload-video-preview" controls muted playsInline src={videoUrl} />
                </div>
              ) : null}
            </div>

            </div>
          </section>
          )}
        </Suspense>

        {isSheetMode && videoMeta ? (
          <section ref={cropPanelRef} className="crop-row">
            <div className="crop-picker crop-picker--row">
              <div className="segment-step-grid">
                <div className="controls-pane">
                  <div className="crop-controls-head">
                    <strong>2. 视频片段与参考帧</strong>
                    <span>先选择需要处理的片段，右侧会循环播放当前范围。</span>
                  </div>

                  <div className="segment-picker">
                    <div className="segment-picker__head">
                      <span>视频片段</span>
                      <strong>{formatTimestamp(segmentStart)} - {formatTimestamp(segmentEnd)}</strong>
                    </div>

                    <div className="segment-slider" style={segmentTrackStyle}>
                      <div className="segment-slider__track" />
                      <div className="segment-slider__active" />
                      <input
                        aria-label="开始位置"
                        className="segment-slider__input segment-slider__input--start"
                        max={videoMeta.duration}
                        min={0}
                        step={0.01}
                        type="range"
                        value={segmentStart}
                        onChange={(event) => {
                          const nextStart = Math.min(Number(event.target.value), segmentEnd);
                          setSegmentStart(Number(nextStart.toFixed(3)));
                          setWatermarkPasses([]);
                          setWatermarkRect(null);
                          setWatermarkCanvasZoom(100);
                          resetShadowDraft();
                          setShadowPasses([]);
                        }}
                      />
                      <input
                        aria-label="结束位置"
                        className="segment-slider__input segment-slider__input--end"
                        max={videoMeta.duration}
                        min={0}
                        step={0.01}
                        type="range"
                        value={segmentEnd}
                        onChange={(event) => {
                          const nextEnd = Math.max(Number(event.target.value), segmentStart);
                          setSegmentEnd(Number(nextEnd.toFixed(3)));
                          setWatermarkPasses([]);
                          setWatermarkRect(null);
                          setWatermarkCanvasZoom(100);
                          resetShadowDraft();
                          setShadowPasses([]);
                        }}
                      />
                    </div>

                    <div className="segment-picker__meta">
                      <div className="segment-pill">
                        <span>开始</span>
                        <strong>{formatTimestamp(segmentStart)}</strong>
                      </div>
                      <div className="segment-pill">
                        <span>结束</span>
                        <strong>{formatTimestamp(segmentEnd)}</strong>
                      </div>
                      <div className="segment-pill">
                        <span>片段长度</span>
                        <strong>{selectedDuration.toFixed(2)} 秒</strong>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="video-preview-card segment-preview-card">
                  <div className="segment-preview-card__head">
                    <span>所选片段预览</span>
                    <strong>循环播放</strong>
                  </div>
                  <video
                    ref={segmentPreviewVideoRef}
                    aria-label="所选视频片段循环预览"
                    autoPlay
                    className="upload-video-preview segment-video-preview"
                    controls
                    muted
                    playsInline
                    src={videoUrl ?? undefined}
                    style={cropSurfaceStyle}
                    onEnded={(event) => {
                      event.currentTarget.currentTime = segmentStart;
                      void event.currentTarget.play().catch(() => undefined);
                    }}
                    onLoadedMetadata={(event) => {
                      event.currentTarget.currentTime = segmentStart;
                      void event.currentTarget.play().catch(() => undefined);
                    }}
                    onPlay={(event) => {
                      const seekTime = getSegmentLoopSeekTime(
                        event.currentTarget.currentTime,
                        segmentStart,
                        segmentEnd,
                      );
                      if (seekTime !== null) {
                        event.currentTarget.currentTime = seekTime;
                      }
                    }}
                    onTimeUpdate={(event) => {
                      const seekTime = getSegmentLoopSeekTime(
                        event.currentTarget.currentTime,
                        segmentStart,
                        segmentEnd,
                      );
                      if (seekTime !== null) {
                        event.currentTarget.currentTime = seekTime;
                        void event.currentTarget.play().catch(() => undefined);
                      }
                    }}
                  />
                  <small>
                    播放范围：{formatTimestamp(segmentStart)} - {formatTimestamp(segmentEnd)}
                  </small>
                </div>
              </div>

              <div className="crop-step-head">
                <strong>3. 画面裁剪</strong>
                <span>
                  最终输出尺寸：{outputVideoMeta?.width ?? videoMeta.width} ×{' '}
                  {outputVideoMeta?.height ?? videoMeta.height}
                </span>
              </div>

              <div className="crop-preview-grid">
                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>鼠标框选裁剪</span>
                      <small>在参考画面上拖拽，直接选择要保留的区域</small>
                    </div>
                  </div>
                  <div className="canvas-surface crop-canvas-surface" style={cropSurfaceStyle}>
                    {referenceRawFrame ? (
                      <canvas
                        ref={cropSelectionCanvasRef}
                        className="preview-canvas crop-preview-canvas crop-selection-canvas"
                        onPointerCancel={handleCropPointerCancel}
                        onPointerDown={handleCropPointerDown}
                        onPointerMove={handleCropPointerMove}
                        onPointerUp={finishCropSelection}
                      />
                    ) : (
                      <div className="crop-placeholder">视频读取后可直接鼠标框选裁剪区域</div>
                    )}
                  </div>
                  <div className="canvas-footer">
                    <span>也可以继续用下面的数值输入精确微调</span>
                  </div>
                </div>

                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>裁剪预览</span>
                      <small>这里会实时显示当前裁剪后的输出画面</small>
                    </div>
                  </div>
                  <div className="canvas-surface crop-canvas-surface" style={cropSurfaceStyle}>
                    {referenceRawFrame ? (
                      <canvas
                        ref={cropPreviewCanvasRef}
                        className="preview-canvas crop-preview-canvas"
                      />
                    ) : (
                      <div className="crop-placeholder">视频读取后，这里会显示裁剪预览</div>
                    )}
                  </div>
                  <div className="canvas-footer">
                    <span>
                      最终输出尺寸：{outputVideoMeta?.width ?? videoMeta.width} ×{' '}
                      {outputVideoMeta?.height ?? videoMeta.height}
                    </span>
                  </div>
                </div>
              </div>

              <div className="crop-controls-pane">
                <div className="crop-controls-head">
                  <strong>裁剪微调</strong>
                  <span>继续用数值做精确裁剪</span>
                </div>

                <div className="crop-grid">
                  <label className="field">
                    <span>左侧偏移 (%)</span>
                    <input
                      min={0}
                      max={99}
                      type="number"
                      value={cropLeftPercent}
                      onChange={(event) => handleCropLeftChange(Number(event.target.value) || 0)}
                    />
                  </label>

                  <label className="field">
                    <span>顶部偏移 (%)</span>
                    <input
                      min={0}
                      max={99}
                      type="number"
                      value={cropTopPercent}
                      onChange={(event) => handleCropTopChange(Number(event.target.value) || 0)}
                    />
                  </label>

                  <label className="field">
                    <span>裁剪宽度 (%)</span>
                    <input
                      min={1}
                      max={100 - cropLeftPercent}
                      type="number"
                      value={cropWidthPercent}
                      onChange={(event) => handleCropWidthChange(Number(event.target.value) || 1)}
                    />
                  </label>

                  <label className="field">
                    <span>裁剪高度 (%)</span>
                    <input
                      min={1}
                      max={100 - cropTopPercent}
                      type="number"
                      value={cropHeightPercent}
                      onChange={(event) => handleCropHeightChange(Number(event.target.value) || 1)}
                    />
                  </label>
                </div>

                <div className="crop-controls-head">
                  <strong>图像大小（不裁剪）</strong>
                  <span>类似 Photoshop 的图像大小：只缩放分辨率，不改变画面内容。</span>
                </div>

                <div className="crop-grid">
                  <label className="field">
                    <span>输出宽度（px）</span>
                    <input
                      min={1}
                      max={MAX_FRAME_SIDE}
                      type="number"
                      value={resizeWidth ?? cropBounds?.width ?? videoMeta.width}
                      onChange={(event) => handleResizeWidthChange(Number(event.target.value) || 1)}
                    />
                  </label>

                  <label className="field">
                    <span>输出高度（px）</span>
                    <input
                      min={1}
                      max={MAX_FRAME_SIDE}
                      type="number"
                      value={resizeHeight ?? cropBounds?.height ?? videoMeta.height}
                      onChange={(event) => handleResizeHeightChange(Number(event.target.value) || 1)}
                    />
                  </label>
                </div>

                <div className="crop-picker__footer">
                  <label className="toggle-card">
                    <input
                      checked={resizeLocked}
                      type="checkbox"
                      onChange={(event) => setResizeLocked(event.target.checked)}
                    />
                    <span>锁定比例</span>
                  </label>
                  <button
                    className="ghost-button"
                    disabled={resizeWidth === null && resizeHeight === null}
                    type="button"
                    onClick={() => {
                      setResizeWidth(null);
                      setResizeHeight(null);
                    }}
                  >
                    恢复裁剪后原尺寸
                  </button>
                </div>

                <div className="crop-picker__footer">
                  <small>
                    你可以直接鼠标框选，也可以继续用百分比数值精确裁剪。
                  </small>
                  <button
                    className="ghost-button"
                    disabled={!isCropApplied}
                    type="button"
                    onClick={resetCropArea}
                  >
                    重置裁剪
                  </button>
                </div>
              </div>

              <div ref={controlsPanelRef} className="workflow-action-row">
                <div>
                  <strong>片段与裁剪确认完成后，继续提取参考帧</strong>
                  <span>下一步进入去水印、去阴影和抠像设置。</span>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    pendingChromaScrollTopRef.current = window.scrollY;
                    setReferenceTime(firstSampleTime);
                    setIsChromaStageOpen(true);
                    pendingChromaScrollRef.current = true;
                    setStatus(
                      !isSheetMode
                        ? '已提取参考帧，请点击背景颜色开始抠图。'
                        : '参考帧已就绪，请先设置去水印或去阴影区域，再进行抠像。'
                    );
                  }}
                >
                  {isChromaStageOpen ? '重新确认片段与裁剪' : '确认片段与裁剪并提取参考帧'}
                </button>
              </div>
              {error ? <p className="error-text">{error}</p> : null}
            </div>
          </section>
        ) : null}

        {isSheetMode && showChromaStage ? (
        <section ref={chromaPanelRef} className="panel frame-picker-panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>4. 去水印 / 去阴影</h2>
              <span>矩形工具处理水印；钢笔工具沿阴影外围自定义路径，并只识别路径内的阴影颜色。</span>
            </div>
          </div>

          <div className="cleanup-tool-switch">
            <div className="segmented-control">
              <button
                className={`segmented-button ${cleanupTool === 'watermark' ? 'is-active' : ''}`}
                type="button"
                onClick={() => selectCleanupTool('watermark')}
              >
                矩形去水印
              </button>
              <button
                className={`segmented-button ${cleanupTool === 'shadow' ? 'is-active' : ''}`}
                type="button"
                onClick={() => selectCleanupTool('shadow')}
              >
                钢笔去阴影
              </button>
            </div>
            <span>
              {cleanupTool === 'watermark'
                ? '在画面上拖拽矩形范围。'
                : '逐点添加锚点，点击橙色起点闭合；闭合后点击阴影取色。'}
            </span>
          </div>

          <div className="reference-toolbar">
            <label className="range-block">
              <span>当前检查时间</span>
              <input
                max={segmentEnd}
                min={segmentStart}
                step={0.01}
                type="range"
                value={referenceTime}
                onChange={(event) => setReferenceTime(Number(event.target.value))}
              />
            </label>

            <div className="reference-meta">
              <strong>{videoMeta ? formatTimestamp(referenceTime) : '00:00.000'}</strong>
              <span>
                {isReferenceLoading
                  ? '正在更新当前帧...'
                  : cleanupTool === 'watermark'
                    ? '播放右侧视频或拖动时间轴，找到出现水印的帧'
                    : '播放右侧视频或拖动时间轴，找到阴影轮廓清楚的帧'}
              </span>
            </div>
          </div>

          <div className="reference-grid">
            <div className="canvas-card">
              <div className="canvas-head">
                <div className="canvas-title">
                  <span>{cleanupTool === 'watermark' ? '去水印区域' : '钢笔阴影路径'}</span>
                  <small>
                    {cleanupTool === 'watermark'
                      ? watermarkRect
                        ? '已框选，请选择应用到全部帧或仅当前帧'
                        : `当前帧累计应用 ${currentWatermarkRects.length} 个去水印区域`
                      : shadowPathClosed
                        ? shadowInteractionMode === 'sample'
                          ? shadowSample
                            ? '已取样，紫色蒙版内的阴影会完整替换为背景'
                            : '取色模式已开启，请点击路径内的阴影颜色'
                          : '钢笔编辑模式已开启，可拖动锚点调整范围'
                        : shadowPoints.length
                          ? `已添加 ${shadowPoints.length} 个锚点`
                          : `当前帧累计应用 ${currentShadowSelections.length} 个去阴影路径`}
                  </small>
                </div>
                <div className="canvas-zoom-actions">
                  <button
                    aria-label="缩小清理画布"
                    className="ghost-button"
                    disabled={watermarkCanvasZoom <= MIN_PREVIEW_ZOOM}
                    type="button"
                    onClick={() => setWatermarkCanvasZoom((current) => adjustPreviewZoom(current, -1))}
                  >
                    −
                  </button>
                  <span>{watermarkCanvasZoom}%</span>
                  <button
                    aria-label="放大清理画布"
                    className="ghost-button"
                    disabled={watermarkCanvasZoom >= MAX_PREVIEW_ZOOM}
                    type="button"
                    onClick={() => setWatermarkCanvasZoom((current) => adjustPreviewZoom(current, 1))}
                  >
                    +
                  </button>
                  <button
                    className="ghost-button"
                    disabled={watermarkCanvasZoom === 100}
                    type="button"
                    onClick={() => setWatermarkCanvasZoom(100)}
                  >
                    适应
                  </button>
                </div>
              </div>
              <div
                ref={watermarkCanvasViewportRef}
                className="canvas-surface checkerboard watermark-canvas-viewport"
                title="滚动鼠标滚轮可缩放画布；按住鼠标滚轮可拖动画布"
              >
                <div
                  className="watermark-canvas-stage"
                  style={{ width: `${watermarkCanvasZoom}%` }}
                >
                  <canvas
                    ref={watermarkCanvasRef}
                    className={`preview-canvas ${cleanupTool === 'shadow' ? 'is-shadow-pen' : ''}`}
                    onPointerCancel={
                      cleanupTool === 'watermark'
                        ? handleWatermarkPointerCancel
                        : handleShadowPointerCancel
                    }
                    onPointerDown={
                      cleanupTool === 'watermark'
                        ? handleWatermarkPointerDown
                        : handleShadowPointerDown
                    }
                    onPointerMove={
                      cleanupTool === 'watermark'
                        ? handleWatermarkPointerMove
                        : handleShadowPointerMove
                    }
                    onPointerUp={
                      cleanupTool === 'watermark'
                        ? handleWatermarkPointerUp
                        : finishShadowPointDrag
                    }
                  />
                </div>
              </div>
              <div className="canvas-footer">
                <span>
                  {cleanupTool === 'watermark'
                    ? watermarkRect
                      ? `区域：x=${watermarkRect.x}, y=${watermarkRect.y}, 宽=${watermarkRect.width}, 高=${watermarkRect.height}`
                      : `当前帧：${formatTimestamp(getNearestFrameTime(sampleTimes, referenceTime) ?? referenceTime)}`
                    : shadowSample
                      ? `阴影取样：RGB(${shadowSample.rgb.r}, ${shadowSample.rgb.g}, ${shadowSample.rgb.b})`
                    : shadowPathClosed
                        ? shadowInteractionMode === 'sample'
                          ? '取色模式：点击路径内的阴影颜色；每次执行后路径会保留'
                          : '钢笔编辑模式：可拖动锚点；切换到取色模式后再点击颜色'
                        : '橙色锚点是起点；至少需要 3 个锚点'}
                  {' · 滚轮可缩放画布；按住鼠标滚轮可拖动查看细节'}
                </span>
              </div>
            </div>

            <div className="canvas-card">
              <div className="canvas-head">
                <div className="canvas-title">
                  <span>清理动画预览</span>
                  <small>水印或阴影并非每帧相同时，先播放并暂停到目标画面</small>
                </div>
              </div>
              <div className="canvas-surface">
                <video
                  ref={watermarkVideoRef}
                  className="upload-video-preview"
                  controls
                  muted
                  playsInline
                  src={videoUrl ?? undefined}
                  onPlay={(event) => {
                    if (event.currentTarget.currentTime < segmentStart || event.currentTarget.currentTime >= segmentEnd) {
                      event.currentTarget.currentTime = segmentStart;
                    }
                  }}
                  onTimeUpdate={(event) => {
                    const time = event.currentTarget.currentTime;
                    if (time >= segmentEnd) {
                      event.currentTarget.pause();
                      event.currentTarget.currentTime = segmentStart;
                      setReferenceTime(segmentStart);
                      return;
                    }

                    if (time >= segmentStart) {
                      setReferenceTime(Number(time.toFixed(3)));
                    }
                  }}
                />
              </div>
              <div className="canvas-footer">
                <span>播放范围：{formatTimestamp(segmentStart)} - {formatTimestamp(segmentEnd)}</span>
              </div>
            </div>
          </div>

          {cleanupTool === 'watermark' ? (
            <div className="watermark-toolbar">
              <div className="watermark-toolbar__copy">
                <strong>
                  已执行 {watermarkPasses.length} 次去水印 · 全部帧 {watermarkPasses.filter((pass) => pass.scope === 'all').length} 次 · 当前帧 {watermarkPasses.filter((pass) => pass.scope === 'frame').length} 次
                </strong>
                <span>优先对全部帧处理固定水印；仅在遗漏画面上使用当前帧补漏。</span>
              </div>
              <div className="watermark-toolbar__actions">
                <button
                  className="primary-button"
                  disabled={isRendering || !watermarkRect}
                  type="button"
                  onClick={handleApplyWatermarkToAllFrames}
                >
                  对全部帧执行去水印
                </button>
                <button
                  className="secondary-button secondary-button--slate"
                  disabled={isRendering || !watermarkRect}
                  type="button"
                  onClick={handleApplyWatermarkToCurrentFrame}
                >
                  执行当前帧去水印
                </button>
                <button
                  className="ghost-button"
                  disabled={!watermarkRect}
                  type="button"
                  onClick={handleClearWatermarkRect}
                >
                  清除当前框选
                </button>
                <button
                  className="ghost-button"
                  disabled={!watermarkPasses.length}
                  type="button"
                  onClick={handleUndoWatermarkPass}
                >
                  撤销上一次
                </button>
                <button
                  className="ghost-button"
                  disabled={!watermarkPasses.length}
                  type="button"
                  onClick={handleClearWatermarkPasses}
                >
                  清空全部
                </button>
              </div>
            </div>
          ) : (
            <div className="watermark-toolbar shadow-toolbar">
              <div className="watermark-toolbar__copy">
                <strong>
                  已执行 {shadowPasses.length} 次去阴影 · 全部帧 {shadowPasses.filter((pass) => pass.scope === 'all').length} 次 · 当前帧 {shadowPasses.filter((pass) => pass.scope === 'frame').length} 次
                </strong>
                <span>路径只需画一次；每次取色后执行去阴影，路径会自动保留。</span>
                <div className="cleanup-tool-switch shadow-mode-switch">
                  <div className="segmented-control">
                    <button
                      className={`segmented-button ${shadowInteractionMode === 'pen' ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => selectShadowInteractionMode('pen')}
                    >
                      钢笔编辑
                    </button>
                    <button
                      className={`segmented-button ${shadowInteractionMode === 'sample' ? 'is-active' : ''}`}
                      disabled={!shadowPathClosed}
                      type="button"
                      onClick={() => selectShadowInteractionMode('sample')}
                    >
                      阴影取色
                    </button>
                  </div>
                  <span>
                    {shadowInteractionMode === 'pen'
                      ? '添加、闭合或调整路径锚点。'
                      : '只在已闭合路径内点击需要去除的颜色。'}
                  </span>
                </div>
                <label className="shadow-tolerance">
                  <span>阴影识别容差：{shadowTolerance}</span>
                  <input
                    max={120}
                    min={0}
                    type="range"
                    value={shadowTolerance}
                    onChange={(event) => setShadowTolerance(Number(event.target.value))}
                  />
                </label>
              </div>
              <div className="watermark-toolbar__actions">
                {!shadowPathClosed ? (
                  <>
                    <button
                      className="secondary-button secondary-button--slate"
                      disabled={shadowPoints.length < 3}
                      type="button"
                      onClick={closeShadowPath}
                    >
                      闭合路径
                    </button>
                    <button
                      className="ghost-button"
                      disabled={!shadowPoints.length}
                      type="button"
                      onClick={handleUndoShadowPoint}
                    >
                      撤销锚点
                    </button>
                  </>
                ) : (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={handleReopenShadowPath}
                  >
                    重新打开路径
                  </button>
                )}
                <button
                  className="primary-button"
                  disabled={isRendering || !activeShadowSelection}
                  type="button"
                  onClick={handleApplyShadowToAllFrames}
                >
                  对全部帧执行去阴影
                </button>
                <button
                  className="secondary-button secondary-button--slate"
                  disabled={isRendering || !activeShadowSelection}
                  type="button"
                  onClick={handleApplyShadowToCurrentFrame}
                >
                  执行当前帧去阴影
                </button>
                <button
                  className="ghost-button"
                  disabled={!shadowPoints.length}
                  type="button"
                  onClick={handleClearShadowDraft}
                >
                  清除当前路径
                </button>
                <button
                  className="ghost-button"
                  disabled={!shadowPasses.length}
                  type="button"
                  onClick={handleUndoShadowPass}
                >
                  撤销上一次
                </button>
                <button
                  className="ghost-button"
                  disabled={!shadowPasses.length}
                  type="button"
                  onClick={handleClearShadowPasses}
                >
                  清空全部
                </button>
              </div>
            </div>
          )}

          {watermarkPasses.length ? (
            <div className="watermark-pass-list">
              {watermarkPasses.map((pass, index) => (
                <span key={`${pass.scope}-${pass.scope === 'frame' ? pass.time : 'all'}-${index}`}>
                  #{index + 1} · {pass.scope === 'all' ? '全部帧' : formatTimestamp(pass.time)} · x={pass.rect.x}, y={pass.rect.y}, {pass.rect.width}×{pass.rect.height}
                </span>
              ))}
            </div>
          ) : null}

          {shadowPasses.length ? (
            <div className="watermark-pass-list shadow-pass-list">
              {shadowPasses.map((pass, index) => (
                <span key={`${pass.scope}-${pass.scope === 'frame' ? pass.time : 'all'}-${index}`}>
                  阴影 #{index + 1} · {pass.scope === 'all' ? '全部帧' : formatTimestamp(pass.time)} · {pass.selection.points.length} 个锚点 · 容差 {pass.selection.tolerance}
                </span>
              ))}
            </div>
          ) : null}
        </section>
        ) : null}

        {isSheetMode && showChromaStage ? (
        <section className="panel chroma-panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>5. 参考帧与抠像预览</h2>
              <span>直接在左侧基底图里点击背景颜色；当前帧会使用步骤4已经执行的去水印和去阴影结果。</span>
            </div>
          </div>

          <>
              <div className="sample-badge-row">
                <div className="sample-badge">
                  <span
                    className="sample-swatch"
                    style={{ backgroundColor: colorSample?.hex ?? '#e6e8f3' }}
                  />
                  <div>
                    <strong>
                      {colorSample
                        ? `RGB(${colorSample.rgb.r}, ${colorSample.rgb.g}, ${colorSample.rgb.b})`
                        : '未选择背景颜色'}
                    </strong>
                    <span>
                      {samplePoint
                        ? `位置: (${samplePoint.x}, ${samplePoint.y})`
                        : hasCommittedColorKeys
                          ? `已应用 ${committedColorKeys.length} 次抠像，可继续点击左侧基底图取下一种颜色`
                          : '可直接生成普通序列图，或点击左侧预览图取背景色'}
                    </span>
                  </div>
                </div>

                <div className="sample-action-group">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSamplePoint(null);
                      setColorSample(null);
                    }}
                  >
                    清除当前取色
                  </button>
                  {hasCommittedColorKeys ? (
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={handleResetCommittedColorKeys}
                    >
                      重置多次抠像
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="protection-toolbar">
                <div className="protection-toolbar__copy">
                  <strong>抠像保护笔刷</strong>
                  <span>绿色区域会在全部抽帧的相同位置保留原始颜色和透明度。</span>
                </div>

                <div className="protection-toolbar__controls">
                  <div className="segmented-control">
                    <button
                      className={`segmented-button ${protectionBrushMode === 'protect' ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => selectProtectionBrushMode('protect')}
                    >
                      保护涂抹
                    </button>
                    <button
                      className={`segmented-button ${protectionBrushMode === 'erase' ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => selectProtectionBrushMode('erase')}
                    >
                      橡皮擦
                    </button>
                    <button
                      className={`segmented-button ${protectionBrushMode === 'off' ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => selectProtectionBrushMode('off')}
                    >
                      退出笔刷
                    </button>
                  </div>

                  <label className="protection-brush-size">
                    <span>笔刷大小：{protectionBrushSize}px</span>
                    <input
                      max={160}
                      min={6}
                      type="range"
                      value={protectionBrushSize}
                      onChange={(event) => setProtectionBrushSize(Number(event.target.value))}
                    />
                  </label>

                  <div className="protection-toolbar__actions">
                    <button
                      className="ghost-button"
                      disabled={!protectionUndoStack.length}
                      type="button"
                      onClick={handleUndoProtectionStroke}
                    >
                      撤销笔画
                    </button>
                    <button
                      className="ghost-button"
                      disabled={protectedPixelCount === 0}
                      type="button"
                      onClick={handleClearProtectionMask}
                    >
                      清空保护区
                    </button>
                  </div>
                </div>

                <small>已保护 {protectedPixelCount.toLocaleString()} 像素</small>
              </div>

              <div className="reference-grid">
                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>{hasCommittedColorKeys ? '当前抠像基底' : '原图'}</span>
                      <small>{samplePoint ? '已选背景点，可继续点击更换' : '点击背景取样'}</small>
                    </div>
                  </div>
                  <div className="canvas-surface">
                    <canvas
                      ref={referenceCanvasRef}
                      className={`preview-canvas ${protectionBrushMode !== 'off' ? 'is-protection-brush' : ''}`}
                      onClick={handleReferenceCanvasClick}
                      onPointerCancel={handleProtectionPointerCancel}
                      onPointerDown={handleProtectionPointerDown}
                      onPointerMove={handleProtectionPointerMove}
                      onPointerUp={finishProtectionStroke}
                    />
                  </div>
                  <div className="canvas-footer">
                    <span>
                      {samplePoint
                        ? `当前取样点：(${samplePoint.x}, ${samplePoint.y})`
                        : protectionBrushMode !== 'off'
                          ? protectionBrushMode === 'protect'
                            ? '正在涂抹保护区域，绿色像素不会被抠除'
                            : '正在擦除保护区域'
                        : hasCommittedColorKeys
                          ? `当前基底已累计应用 ${committedColorKeys.length} 次抠像`
                          : '点击原图任意背景区域开始取色'}
                    </span>
                  </div>
                </div>

                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>抠图预览结果</span>
                      <small>切换模式检查边缘干净度</small>
                    </div>
                    <div className="segmented-control">
                      <button
                        className={`segmented-button ${previewMode === 'result' ? 'is-active' : ''}`}
                        type="button"
                        onClick={() => setPreviewMode('result')}
                      >
                        抠像结果
                      </button>
                      <button
                        className={`segmented-button ${previewMode === 'mask' ? 'is-active' : ''}`}
                        disabled={!referenceMaskFrame}
                        type="button"
                        onClick={() => setPreviewMode('mask')}
                      >
                        Alpha 蒙版
                      </button>
                      <button
                        className={`segmented-button ${previewMode === 'solid' ? 'is-active' : ''}`}
                        disabled={!referenceResultFrame}
                        type="button"
                        onClick={() => setPreviewMode('solid')}
                      >
                        纯色底
                      </button>
                    </div>
                  </div>
                  <div className="canvas-surface checkerboard">
                    <canvas ref={previewCanvasRef} className="preview-canvas" />
                  </div>
                  <div className="solid-preview-bar">
                    <span>纯色底检查色</span>
                    <div className="color-field color-field--compact">
                      <input
                        type="color"
                        value={solidPreviewColor}
                        onChange={(event) => setSolidPreviewColor(event.target.value)}
                      />
                      <code>{solidPreviewColor}</code>
                    </div>
                  </div>
                </div>
              </div>

              <div className="advanced-panel">
                <div className="advanced-head">
                  <h3>高级参数设置</h3>
                  <span>容差、羽化、边缘平滑、去溢色都会即时影响右侧预览。</span>
                </div>

                <div className="advanced-grid">
                  <label className="range-field">
                    <span>颜色容差: {tolerance}</span>
                    <input
                      max={120}
                      min={0}
                      type="range"
                      value={tolerance}
                      onChange={(event) => setTolerance(Number(event.target.value))}
                    />
                    <small>越大越容易把接近背景色的区域一起抠除。</small>
                  </label>

                  <label className="range-field">
                    <span>羽化半径: {softness}px</span>
                    <input
                      max={60}
                      min={0}
                      type="range"
                      value={softness}
                      onChange={(event) => setSoftness(Number(event.target.value))}
                    />
                    <small>控制边缘从透明到不透明的过渡长度。</small>
                  </label>

                  <div className="toggle-group">
                    <label className="toggle-card">
                      <input
                        checked={smoothing}
                        type="checkbox"
                        onChange={(event) => setSmoothing(event.target.checked)}
                      />
                      <span>边缘平滑</span>
                    </label>

                    <label className="toggle-card">
                      <input
                        checked={despillEnabled}
                        type="checkbox"
                        onChange={(event) => setDespillEnabled(event.target.checked)}
                      />
                      <span>溢色移除</span>
                    </label>
                  </div>
                </div>
              </div>

              <div ref={chromaActionsRef} className="chroma-actions chroma-actions--stack">
                {colorKeyOptions ? (
                  <button
                    className="secondary-button secondary-button--slate"
                    type="button"
                    onClick={handleCommitCurrentColorKey}
                  >
                    {hasCommittedColorKeys ? '应用当前抠像并继续下一轮' : '应用本次抠像并继续下一轮'}
                  </button>
                ) : null}
                <button
                  className="primary-button chroma-generate-button"
                  type="button"
                  onClick={() => scrollToStep(resultPanelRef)}
                >
                  完成抠像设置，进入步骤6
                </button>
              </div>
          </>
        </section>
        ) : null}

        {isSheetMode && showChromaStage ? (
        <section ref={resultPanelRef} className="panel frame-picker-panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>6. 抽帧与预览</h2>
              <span>调整每秒帧数后快捷抽帧；生成后可播放动画，并逐帧决定保留或排除。</span>
            </div>

            {showFramePickerStage ? (
              <div className="option-card option-card--metric">
                <span>当前选中帧数</span>
                <strong>{selectedFrameCount} / {extractedFrames?.length ?? 0}</strong>
                <small>未勾选的帧不会进入预览、GIF、ZIP 与 Spine 导出。</small>
              </div>
            ) : null}
          </div>

          <div className="control-grid">
            <label className="field field-card">
              <span>每秒提取帧数</span>
              <input
                min={1}
                max={24}
                type="number"
                value={framesPerSecond}
                onChange={(event) => setFramesPerSecond(
                  Math.min(24, Math.max(1, Math.round(Number(event.target.value) || 1))),
                )}
              />
            </label>

            <div className="option-card option-card--metric">
              <span>预计抽帧结果</span>
              <strong>{estimatedFrameCount} 帧</strong>
              <small>{selectedDuration.toFixed(2)} 秒片段</small>
            </div>
          </div>

          <button
            className="primary-button"
            disabled={!canGenerate}
            type="button"
            onClick={() => void handleGeneratePreview()}
          >
            {isRendering
              ? `正在抽帧 ${extractedFrames?.length ?? 0}/${estimatedFrameCount}...`
              : showFramePickerStage
                ? `重新快捷抽帧（预计 ${estimatedFrameCount} 帧）`
                : `快捷抽帧（预计 ${estimatedFrameCount} 帧）`}
          </button>

          {frameLimitExceeded ? (
            <p className="error-text">当前设置预计提取 {estimatedFrameCount} 帧，建议缩短片段或降低每秒帧数。</p>
          ) : null}
          {generationBudgetError ? <p className="error-text">{generationBudgetError}</p> : null}

          <div className="segmented-control segmented-control--result">
            <button
              className={`segmented-button ${resultPreviewMode === 'sheet' ? 'is-active' : ''}`}
              disabled={!result}
              type="button"
              onClick={() => setResultPreviewMode('sheet')}
            >
              序列图预览
            </button>
            <button
              className={`segmented-button ${resultPreviewMode === 'animation' ? 'is-active' : ''}`}
              disabled={!animationFrames.length}
              type="button"
              onClick={() => setResultPreviewMode('animation')}
            >
              动画预览
            </button>
          </div>

          {result && resultPreviewMode === 'sheet' ? (
            <div className="preview-wrap">
              <img alt="生成的序列帧表预览" className="preview-image" src={result.objectUrl} />
            </div>
          ) : result && resultPreviewMode === 'animation' ? (
            <>
              <div
                ref={resultAnimationPreviewRef}
                className={`preview-wrap preview-wrap--animation preview-wrap--sequence-animation ${
                  animationZoom > 100 ? 'is-zoomed' : ''
                } ${
                  resultTransparent ? 'preview-wrap--transparent' : 'preview-wrap--solid'
                }`}
                title="鼠标滚轮缩放预览；按住鼠标滚轮可拖动预览"
              >
                <div
                  className="sequence-animation-stage"
                  style={{
                    width: `${animationZoom}%`,
                    height: `${animationZoom}%`,
                  }}
                >
                  <canvas
                    ref={resultAnimationCanvasRef}
                    aria-label="序列帧动画预览"
                    className="preview-canvas"
                  />
                </div>
              </div>

              <div className="animation-toolbar">
                <div className="animation-meta">
                  <strong>
                    第 {Math.min(animationFrameIndex + 1, animationFrames.length)} / {animationFrames.length} 帧
                  </strong>
                  <span>
                    {animationFrames[animationFrameIndex]
                      ? `${animationFrames[animationFrameIndex].label} · ${Math.min(Math.max(framesPerSecond, 1), 24)} FPS 预览`
                      : '等待动画帧'}
                  </span>
                </div>

                <div className="animation-actions">
                  <button
                    aria-label="缩小动画预览"
                    className="ghost-button"
                    disabled={animationZoom <= MIN_PREVIEW_ZOOM}
                    type="button"
                    onClick={() => setAnimationZoom((current) => adjustPreviewZoom(current, -1))}
                  >
                    缩小
                  </button>
                  <span className="animation-zoom-value">{animationZoom}%</span>
                  <button
                    aria-label="放大动画预览"
                    className="ghost-button"
                    disabled={animationZoom >= MAX_PREVIEW_ZOOM}
                    type="button"
                    onClick={() => setAnimationZoom((current) => adjustPreviewZoom(current, 1))}
                  >
                    放大
                  </button>
                  <button
                    className="ghost-button"
                    disabled={animationZoom === 100}
                    type="button"
                    onClick={() => setAnimationZoom(100)}
                  >
                    适应
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setAnimationPlaying((current) => !current)}
                  >
                    {animationPlaying ? '暂停' : '播放'}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setAnimationFrameIndex(0);
                      setAnimationPlaying(true);
                    }}
                  >
                    重播
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="preview-empty">
              点击“快捷抽帧”后，这里会显示序列图和动画预览。
            </div>
          )}

          {showFramePickerStage ? (
            <>
              <div className="frame-picker-actions">
                <button className="ghost-button" type="button" onClick={handleSelectAllFrames}>
                  全选
                </button>
                <button className="ghost-button" type="button" onClick={handleInvertFrameSelection}>
                  反选
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => handleIntervalFrameSelection(1)}
                >
                  每隔1帧选1帧
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => handleIntervalFrameSelection(2)}
                >
                  每隔2帧选1帧
                </button>
              </div>

              <div className="frame-picker-grid">
                {(extractedFrames ?? []).map((frame, index) => {
                  const checked = normalizedFrameSelection[index] !== false;
                  const isAttackFrame = normalizedAttackFrameSelection[index] === true;

                  return (
                    <div
                      key={`${frame.label}-${index}`}
                      className={`frame-picker-card ${checked ? 'is-active' : 'is-disabled'} ${isAttackFrame ? 'is-attack' : ''}`}
                    >
                      <label className="frame-picker-card__selection">
                        <input
                          checked={checked}
                          type="checkbox"
                          onChange={(event) => handleFrameSelectionChange(index, event.target.checked)}
                        />
                        <div className="frame-picker-thumb">
                          <img alt={`第 ${index + 1} 帧缩略图`} src={frameThumbnailUrls[index]} />
                        </div>
                        <div className="frame-picker-meta">
                          <strong>第 {index + 1} 帧</strong>
                          <span>{frame.label}</span>
                        </div>
                      </label>
                      <label
                        className="frame-picker-card__attack"
                        title="标记为攻击命中帧"
                      >
                        <input
                          aria-label={`标记第 ${index + 1} 帧为攻击命中帧`}
                          checked={isAttackFrame}
                          type="checkbox"
                          onChange={(event) => handleAttackFrameSelectionChange(index, event.target.checked)}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </section>
        ) : null}

        {isSheetMode && showResultStage ? (
        <section className="result-grid result-grid--single">
          <div className="panel download-panel">
            <div className="panel-head">
              <h2>7. 导出结果</h2>
              <span>本地下载</span>
            </div>

            <p className="download-copy">
              支持导出序列图 PNG、动画 GIF、透明帧 ZIP 和 Spine ZIP；透明序列图会按所有帧叠加后的最大有效像素范围统一裁切，避免保留多余空白。
            </p>

            <div className="export-config-grid">
              <label className="field">
                <span>导出列数</span>
                <input
                  min={1}
                  max={8}
                  type="number"
                  value={columns}
                  onChange={(event) => setColumns(
                    Math.min(8, Math.max(1, Math.round(Number(event.target.value) || 1))),
                  )}
                />
              </label>

              <label className="field">
                <span>导出间距（精灵图建议 0）</span>
                <input
                  min={0}
                  max={48}
                  type="number"
                  value={gap}
                  onChange={(event) => setGap(
                    Math.min(48, Math.max(0, Math.round(Number(event.target.value) || 0))),
                  )}
                />
              </label>

              <label className="field">
                <span>单帧尺寸预设</span>
                <select
                  value={exportPreset}
                  onChange={(event) => setExportPreset(event.target.value as ExportPresetValue)}
                >
                  {EXPORT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="option-card option-card--metric export-config-grid__full">
                <span>预估导出尺寸</span>
                <strong>
                  {exportTargetSize
                    ? `${exportTargetSize.width} × ${exportTargetSize.height}`
                    : '等待生成'}
                </strong>
                <small>
                  {exportFrameSize ? `智能缩放到每帧 ${exportFrameSize} × ${exportFrameSize}` : '保持原始帧比例尺寸'}
                </small>
              </div>
            </div>

            {result ? (
              <div className="export-preview-card" aria-live="polite">
                <div className="export-preview-card__head">
                  <div>
                    <strong>最终 PNG 排布预览</strong>
                    <span>按 1:1 像素显示；大图可横向、纵向滚动查看。</span>
                  </div>
                  <div className="export-preview-card__badge">
                    {columns} 列 × {exportLayoutMetrics?.rows ?? 0} 行
                  </div>
                </div>

                <div
                  className={`preview-wrap export-preview-card__canvas ${
                    resultTransparent ? 'preview-wrap--transparent' : 'preview-wrap--solid'
                  }`}
                >
                  <img
                    alt={`最终 PNG 排布预览：${columns} 列`}
                    className="preview-image export-preview-card__image"
                    height={result.outputHeight}
                    src={result.objectUrl}
                    width={result.outputWidth}
                  />
                </div>

                <div className="export-preview-card__meta">
                  <span>
                    {selectedFrameCount} 帧 · {columns} 列 · {exportLayoutMetrics?.rows ?? 0} 行
                  </span>
                  <strong>
                    {result.outputWidth} × {result.outputHeight} PNG
                  </strong>
                </div>
              </div>
            ) : null}

            <div className="export-actions">
              <button
                className="secondary-button secondary-button--slate"
                disabled={isRendering}
                type="button"
                onClick={() => void handleOpenSpineWorkspace()}
              >
                进入 Spine 动画
              </button>

              <button
                className="secondary-button secondary-button--violet"
                disabled={isRendering}
                type="button"
                onClick={() => void handleDownloadSheet()}
              >
                {resultTransparent ? '下载透明序列图 PNG' : '下载普通序列图 PNG'}
              </button>

              <button
                className="secondary-button"
                disabled={isRendering}
                type="button"
                onClick={() => void handleDownloadGif()}
              >
                下载动画 GIF
              </button>

              <button
                className="secondary-button secondary-button--emerald"
                disabled={isRendering || !hasAnyColorKeyPass}
                type="button"
                onClick={() => void handleDownloadZip()}
              >
                下载透明单帧 ZIP
              </button>
            </div>
          </div>
        </section>
        ) : null}

        {showSpineStage && spineDraft ? (
          <section ref={spinePanelRef} className="result-grid spine-grid">
            <div className="panel preview-panel">
              <div className="panel-head">
                <h2>8. Spine 动画工作区</h2>
                <span>
                  {spineDraft.transparent ? '透明帧优先' : '普通帧'} · {spineDraft.width} × {spineDraft.height}
                </span>
              </div>

              <div className="spine-preview-note option-card option-card--metric">
                <span>{activeSpineAnimation ? `正在预览：${activeSpineAnimation.name}` : '当前资源'}</span>
                <strong>{spinePreviewFrameCount} 帧</strong>
                <small>
                  {activeSpineAnimation
                    ? `第 ${spinePreviewStartFrame + 1}–${spinePreviewEndFrame + 1} 帧 · 循环预览`
                    : spineDraft.baseName}
                </small>
              </div>

              <div
                className={`preview-wrap preview-wrap--animation ${
                  spineDraft.transparent ? 'preview-wrap--transparent' : 'preview-wrap--solid'
                }`}
              >
                <canvas
                  ref={spineAnimationCanvasRef}
                  aria-label="Spine 序列动画预览"
                  className="preview-canvas"
                />
              </div>

              <div className="animation-toolbar">
                <div className="animation-meta">
                  <strong>
                    第 {Math.max(spineAnimationFrameIndex - spinePreviewStartFrame + 1, 1)} / {spinePreviewFrameCount} 帧
                  </strong>
                  <span>
                    {spineFrames[spineAnimationFrameIndex]
                      ? `${spineFrames[spineAnimationFrameIndex].label} · ${activeSpineAnimation?.fps ?? DEFAULT_FRAMES_PER_SECOND} FPS 预览`
                      : '等待 Spine 预览帧'}
                  </span>
                </div>

                <div className="animation-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setSpineAnimationPlaying((current) => !current)}
                  >
                    {spineAnimationPlaying ? '暂停' : '播放'}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSpineAnimationFrameIndex(spinePreviewStartFrame);
                      setSpineAnimationPlaying(true);
                    }}
                  >
                    重播
                  </button>
                </div>
              </div>
            </div>

            <div className="panel download-panel">
              <div className="panel-head">
                <h2>Spine / Unity 图集导出</h2>
                <span>单张 PNG + JSON ZIP</span>
              </div>

              <p className="download-copy">
                导出会生成按第 7 步排布的单张图集 PNG、Spine JSON、图集描述和 Unity 切片 JSON，不再逐帧输出 PNG。
              </p>

              <div className="export-config-grid">
                <label className="field">
                  <span>骨骼名</span>
                  <input
                    type="text"
                    value={spineOptions.skeletonName}
                    onChange={(event) =>
                      setSpineOptions((current) => ({
                        ...current,
                        skeletonName: event.target.value || baseFileName,
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>插槽名</span>
                  <input
                    type="text"
                    value={spineOptions.slotName}
                    onChange={(event) =>
                      setSpineOptions((current) => ({
                        ...current,
                        slotName: event.target.value || 'sprite',
                      }))
                    }
                  />
                </label>

                <div className="spine-clip-editor export-config-grid__full">
                  <div className="spine-clip-editor__head">
                    <div>
                      <strong>动作切分与循环预览</strong>
                      <span>选择一个动作后，预览只播放该动作范围。</span>
                    </div>
                    <button className="ghost-button" type="button" onClick={addSpineAnimation}>
                      新增动作
                    </button>
                  </div>

                  <div className="spine-clip-list" aria-label="动作分段列表">
                    {spineOptions.animations.map((clip) => (
                      <div
                        key={clip.id}
                        className={`spine-clip-row ${activeSpineAnimation?.id === clip.id ? 'is-active' : ''}`}
                      >
                        <button type="button" onClick={() => selectSpineAnimation(clip)}>
                          <strong>{clip.name || '未命名动作'}</strong>
                          <span>第 {clip.startFrame + 1}–{clip.endFrame + 1} 帧 · 循环预览</span>
                        </button>
                        <button
                          aria-label={`删除动作 ${clip.name}`}
                          className="spine-clip-row__delete"
                          disabled={spineOptions.animations.length <= 1}
                          type="button"
                          onClick={() => removeSpineAnimation(clip.id)}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>

                  {activeSpineAnimation ? (
                    <div className="spine-clip-fields">
                      <label className="field">
                        <span>动作名</span>
                        <input
                          type="text"
                          value={activeSpineAnimation.name}
                          onChange={(event) => updateSpineAnimation(activeSpineAnimation.id, {
                            name: event.target.value,
                          })}
                        />
                      </label>
                      <label className="field">
                        <span>起始帧</span>
                        <input
                          min={1}
                          max={activeSpineAnimation.endFrame + 1}
                          type="number"
                          value={activeSpineAnimation.startFrame + 1}
                          onChange={(event) => updateSpineAnimation(activeSpineAnimation.id, {
                            startFrame: Math.min(
                              Math.max((Number(event.target.value) || 1) - 1, 0),
                              activeSpineAnimation.endFrame,
                            ),
                          })}
                        />
                      </label>
                      <label className="field">
                        <span>结束帧</span>
                        <input
                          min={activeSpineAnimation.startFrame + 1}
                          max={spineFrames.length}
                          type="number"
                          value={activeSpineAnimation.endFrame + 1}
                          onChange={(event) => updateSpineAnimation(activeSpineAnimation.id, {
                            endFrame: Math.max(
                              Math.min((Number(event.target.value) || 1) - 1, spineFrames.length - 1),
                              activeSpineAnimation.startFrame,
                            ),
                          })}
                        />
                      </label>
                      <label className="field">
                        <span>此动作 FPS</span>
                        <input
                          min={1}
                          max={60}
                          type="number"
                          value={activeSpineAnimation.fps}
                          onChange={(event) => updateSpineAnimation(activeSpineAnimation.id, {
                            fps: Math.min(Math.max(Number(event.target.value) || 1, 1), 60),
                          })}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="export-actions">
                <button
                  className="secondary-button secondary-button--emerald"
                  disabled={isRendering}
                  type="button"
                  onClick={() => void handleDownloadSpineZip()}
                >
                  下载图集 Spine ZIP
                </button>
              </div>
            </div>
          </section>
        ) : null}

      </main>
    </div>
  );
}

export default App;
