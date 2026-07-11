import { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import picaFactory from 'pica';
import { getBaseFileName } from './lib/exportBundle';

const MAX_FILES = 50;
const MAX_SIZE_MB = 50;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const DEFAULT_SCALE = 75;
const DEFAULT_DIMENSION = 1080;

type ResizeMode = 'scale' | 'dimension';
type DimensionMode = 'fixed' | 'width' | 'height' | 'max' | 'min';
type FitMode = 'crop' | 'stretch';
type ItemStatus = 'pending' | 'done' | 'skipped' | 'error';

type ResizeItem = {
  id: string;
  file: File;
  name: string;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  mime: string;
  status: ItemStatus;
  resultUrl: string | null;
  resultBlob: Blob | null;
  resultWidth: number | null;
  resultHeight: number | null;
  error: string | null;
};

type ResizeOptions = {
  mode: ResizeMode;
  scalePercent: number;
  dimMode: DimensionMode;
  targetWidth: number;
  targetHeight: number;
  targetSide: number;
  fitMode: FitMode;
  skipSmall: boolean;
};

type ImageResizeToolProps = {
  onStatusChange: (status: string) => void;
};

let itemSeq = 0;

function parseSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function outputExt(mime: string): string {
  if (mime === 'image/png') {
    return 'png';
  }

  if (mime === 'image/webp') {
    return 'webp';
  }

  return 'jpg';
}

function outputName(item: ResizeItem): string {
  if (item.status === 'skipped') {
    return item.name;
  }

  return `${getBaseFileName(item.name)}-resized.${outputExt(item.mime)}`;
}

function loadImageFile(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('请选择 PNG、JPG、WebP 等图片文件。'));
      return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');

      if (!context) {
        reject(new Error('无法创建图片画布。'));
        return;
      }

      context.drawImage(image, 0, 0);
      resolve(canvas);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败，请换一张图片后重试。'));
    };

    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('图片导出失败。'));
          return;
        }

        resolve(blob);
      },
      mime,
      mime === 'image/png' ? undefined : 0.92,
    );
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

function computeTarget(
  item: ResizeItem,
  options: ResizeOptions,
): { width: number; height: number } | null {
  const { width: ow, height: oh } = item;

  if (options.mode === 'scale') {
    const percent = Math.min(1000, Math.max(1, options.scalePercent));
    return {
      width: Math.max(1, Math.round((ow * percent) / 100)),
      height: Math.max(1, Math.round((oh * percent) / 100)),
    };
  }

  switch (options.dimMode) {
    case 'fixed': {
      const width = parseSize(options.targetWidth);
      const height = parseSize(options.targetHeight);
      if (width < 1 || height < 1) {
        return null;
      }
      return { width, height };
    }
    case 'width': {
      const width = parseSize(options.targetWidth);
      if (width < 1) {
        return null;
      }
      return { width, height: Math.max(1, Math.round((oh * width) / ow)) };
    }
    case 'height': {
      const height = parseSize(options.targetHeight);
      if (height < 1) {
        return null;
      }
      return { width: Math.max(1, Math.round((ow * height) / oh)), height };
    }
    case 'max': {
      const side = parseSize(options.targetSide);
      if (side < 1) {
        return null;
      }
      return ow >= oh
        ? { width: side, height: Math.max(1, Math.round((oh * side) / ow)) }
        : { width: Math.max(1, Math.round((ow * side) / oh)), height: side };
    }
    case 'min': {
      const side = parseSize(options.targetSide);
      if (side < 1) {
        return null;
      }
      return ow <= oh
        ? { width: side, height: Math.max(1, Math.round((oh * side) / ow)) }
        : { width: Math.max(1, Math.round((ow * side) / oh)), height: side };
    }
    default:
      return null;
  }
}

type RenderOutcome = {
  blob: Blob;
  width: number;
  height: number;
  skipped: boolean;
};

async function renderItem(
  item: ResizeItem,
  options: ResizeOptions,
  pica: ReturnType<typeof picaFactory>,
): Promise<RenderOutcome> {
  const target = computeTarget(item, options);
  if (!target || target.width < 1 || target.height < 1) {
    throw new Error('目标尺寸无效，请检查输入。');
  }

  const isUpscale = target.width >= item.width && target.height >= item.height;
  if (options.skipSmall && isUpscale) {
    return { blob: item.file, width: item.width, height: item.height, skipped: true };
  }

  const srcRatio = item.width / item.height;
  const dstRatio = target.width / target.height;
  const needCrop =
    options.mode === 'dimension' &&
    options.dimMode === 'fixed' &&
    Math.abs(srcRatio - dstRatio) > 0.002;

  let sourceForResize: HTMLCanvasElement = item.canvas;

  if (needCrop && options.fitMode === 'crop') {
    let sx = 0;
    let sy = 0;
    let sw = item.width;
    let sh = item.height;

    if (srcRatio > dstRatio) {
      sh = item.height;
      sw = Math.round(item.height * dstRatio);
      sx = Math.round((item.width - sw) / 2);
    } else {
      sw = item.width;
      sh = Math.round(item.width / dstRatio);
      sy = Math.round((item.height - sh) / 2);
    }

    const tmp = document.createElement('canvas');
    tmp.width = sw;
    tmp.height = sh;
    const tmpContext = tmp.getContext('2d');
    if (!tmpContext) {
      throw new Error('无法创建裁剪画布。');
    }
    tmpContext.drawImage(item.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    sourceForResize = tmp;
  }

  const out = document.createElement('canvas');
  out.width = target.width;
  out.height = target.height;

  await pica.resize(sourceForResize, out, { alpha: item.mime !== 'image/jpeg' });

  let exportCanvas: HTMLCanvasElement = out;
  if (item.mime === 'image/jpeg') {
    const flat = document.createElement('canvas');
    flat.width = out.width;
    flat.height = out.height;
    const flatContext = flat.getContext('2d');
    if (flatContext) {
      flatContext.fillStyle = '#ffffff';
      flatContext.fillRect(0, 0, flat.width, flat.height);
      flatContext.drawImage(out, 0, 0);
      exportCanvas = flat;
    }
  }

  const blob = await canvasToBlob(exportCanvas, item.mime);
  return { blob, width: target.width, height: target.height, skipped: false };
}

type SliderNumberFieldProps = {
  label: string;
  hint?: string;
  sliderMin: number;
  sliderMax: number;
  step?: number;
  value: number;
  onChange: (next: number) => void;
};

function SliderNumberField({
  label,
  hint,
  sliderMin,
  sliderMax,
  step = 1,
  value,
  onChange,
}: SliderNumberFieldProps) {
  const safeValue = Number.isFinite(value) ? value : sliderMin;
  const sliderValue = Math.min(sliderMax, Math.max(sliderMin, safeValue));

  return (
    <label className="field">
      <span>{label}</span>
      <div className="range-field">
        <div className="range-field__row">
          <input
            max={sliderMax}
            min={sliderMin}
            step={step}
            type="range"
            value={sliderValue}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <input
            className="range-field__num"
            min={1}
            type="number"
            value={value === 0 ? '' : value}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </div>
        {hint ? <small>{hint}</small> : null}
      </div>
    </label>
  );
}

function ImageResizeTool({ onStatusChange }: ImageResizeToolProps) {
  const [items, setItems] = useState<ResizeItem[]>([]);
  const [mode, setMode] = useState<ResizeMode>('scale');
  const [scalePercent, setScalePercent] = useState<number>(DEFAULT_SCALE);
  const [dimMode, setDimMode] = useState<DimensionMode>('fixed');
  const [targetWidth, setTargetWidth] = useState<number>(DEFAULT_DIMENSION);
  const [targetHeight, setTargetHeight] = useState<number>(DEFAULT_DIMENSION);
  const [targetSide, setTargetSide] = useState<number>(DEFAULT_DIMENSION);
  const [fitMode, setFitMode] = useState<FitMode>('crop');
  const [skipSmall, setSkipSmall] = useState<boolean>(true);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const picaRef = useRef<ReturnType<typeof picaFactory>>(picaFactory());
  const itemsRef = useRef<ResizeItem[]>([]);

  itemsRef.current = items;

  const options = useMemo<ResizeOptions>(
    () => ({
      mode,
      scalePercent,
      dimMode,
      targetWidth,
      targetHeight,
      targetSide,
      fitMode,
      skipSmall,
    }),
    [mode, scalePercent, dimMode, targetWidth, targetHeight, targetSide, fitMode, skipSmall],
  );

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => {
        if (item.resultUrl) {
          URL.revokeObjectURL(item.resultUrl);
        }
      });
    };
  }, []);

  const preview = useMemo(() => {
    if (items.length === 0) {
      return null;
    }

    const [first] = items;
    const target = computeTarget(first, options);
    if (!target) {
      return null;
    }

    return { width: target.width, height: target.height };
  }, [items, options]);

  const isDimensionValid = useMemo(() => {
    if (mode !== 'dimension') {
      return scalePercent >= 1;
    }

    switch (dimMode) {
      case 'fixed':
        return parseSize(targetWidth) >= 1 && parseSize(targetHeight) >= 1;
      case 'width':
        return parseSize(targetWidth) >= 1;
      case 'height':
        return parseSize(targetHeight) >= 1;
      case 'max':
      case 'min':
        return parseSize(targetSide) >= 1;
      default:
        return false;
    }
  }, [mode, dimMode, scalePercent, targetWidth, targetHeight, targetSide]);

  const hasResults = useMemo(
    () => items.some((item) => item.status === 'done' || item.status === 'skipped'),
    [items],
  );

  function revokeResults(): void {
    itemsRef.current.forEach((item) => {
      if (item.resultUrl) {
        URL.revokeObjectURL(item.resultUrl);
      }
    });
  }

  async function handleFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    setError(null);

    const incoming = Array.from(fileList);
    const nextItems: ResizeItem[] = [];
    const rejected: string[] = [];

    for (const file of incoming) {
      if (items.length + nextItems.length >= MAX_FILES) {
        rejected.push(`${file.name}（超过 ${MAX_FILES} 张上限）`);
        continue;
      }

      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        rejected.push(`${file.name}（超过 ${MAX_SIZE_MB}M）`);
        continue;
      }

      if (!ACCEPTED_TYPES.includes(file.type)) {
        rejected.push(`${file.name}（仅支持 JPG/PNG/WebP）`);
        continue;
      }

      try {
        const canvas = await loadImageFile(file);
        nextItems.push({
          id: `resize-${itemSeq}`,
          file,
          name: file.name,
          canvas,
          width: canvas.width,
          height: canvas.height,
          mime: file.type,
          status: 'pending',
          resultUrl: null,
          resultBlob: null,
          resultWidth: null,
          resultHeight: null,
          error: null,
        });
        itemSeq += 1;
      } catch (nextError) {
        rejected.push(`${file.name}（${nextError instanceof Error ? nextError.message : '读取失败'}）`);
      }
    }

    if (nextItems.length > 0) {
      setItems((current) => [...current, ...nextItems]);
      onStatusChange(`已加入 ${nextItems.length} 张图片，共 ${items.length + nextItems.length} 张待处理。`);
    }

    if (rejected.length > 0) {
      setError(`已跳过 ${rejected.length} 个文件：${rejected.join('、')}`);
    }
  }

  function handleRemoveItem(id: string): void {
    setItems((current) => {
      const targetItem = current.find((entry) => entry.id === id);
      if (targetItem?.resultUrl) {
        URL.revokeObjectURL(targetItem.resultUrl);
      }

      return current.filter((entry) => entry.id !== id);
    });
  }

  function handleClearAll(): void {
    revokeResults();
    setItems([]);
    setError(null);
    onStatusChange('已清空图片列表。');
  }

  async function handleProcess(): Promise<void> {
    if (items.length === 0 || isProcessing) {
      return;
    }

    if (!isDimensionValid) {
      setError('请填写有效的目标尺寸（至少为 1 像素）。');
      return;
    }

    setError(null);
    setIsProcessing(true);
    onStatusChange(`正在批量改尺寸，共 ${items.length} 张...`);

    const results = await Promise.all(
      items.map(async (item): Promise<ResizeItem> => {
        try {
          const outcome = await renderItem(item, options, picaRef.current);
          const resultUrl = URL.createObjectURL(outcome.blob);
          return {
            ...item,
            status: outcome.skipped ? 'skipped' : 'done',
            resultUrl,
            resultBlob: outcome.blob,
            resultWidth: outcome.width,
            resultHeight: outcome.height,
            error: null,
          };
        } catch (nextError) {
          return {
            ...item,
            status: 'error',
            resultUrl: null,
            resultBlob: null,
            resultWidth: null,
            resultHeight: null,
            error: nextError instanceof Error ? nextError.message : '处理失败',
          };
        }
      }),
    );

    setItems(results);
    setIsProcessing(false);

    const done = results.filter((entry) => entry.status === 'done').length;
    const skipped = results.filter((entry) => entry.status === 'skipped').length;
    const failed = results.filter((entry) => entry.status === 'error').length;
    onStatusChange(`改尺寸完成：成功 ${done} 张，跳过 ${skipped} 张，失败 ${failed} 张。`);
  }

  function handleDownloadItem(item: ResizeItem): void {
    if (!item.resultBlob) {
      return;
    }

    triggerBlobDownload(item.resultBlob, outputName(item));
  }

  async function handleDownloadAll(): Promise<void> {
    const ready = items.filter(
      (entry) => (entry.status === 'done' || entry.status === 'skipped') && entry.resultBlob,
    );
    if (ready.length === 0) {
      return;
    }

    const zip = new JSZip();
    ready.forEach((entry) => {
      if (entry.resultBlob) {
        zip.file(outputName(entry), entry.resultBlob);
      }
    });

    const content = await zip.generateAsync({ type: 'blob' });
    triggerBlobDownload(content, 'resized-images.zip');
    onStatusChange(`已打包 ${ready.length} 张图片为 ZIP 并开始下载。`);
  }

  return (
    <>
      <section className="workspace-grid workspace-grid--single">
        <div className="panel upload-panel">
          <div className="panel-head">
            <h2>1. 上传图片</h2>
            <span>支持 JPG、PNG、WebP，最多 {MAX_FILES} 张，单张 ≤ {MAX_SIZE_MB}M</span>
          </div>

          <input
            ref={inputRef}
            hidden
            accept="image/jpeg,image/png,image/webp"
            multiple
            type="file"
            onChange={(event) => {
              void handleFiles(event.target.files);
              event.currentTarget.value = '';
            }}
          />

          <div className={`upload-layout ${items.length > 0 ? 'upload-layout--with-preview' : ''}`}>
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
                void handleFiles(event.dataTransfer.files);
              }}
            >
              <span className="dropzone-kicker">拖放图片到这里</span>
              <strong>或点击选择本地图片（可多选）</strong>
              <small>图片在浏览器本地处理，不会上传到任何服务器。</small>
            </button>

            {items.length > 0 ? (
              <div className="video-preview-card image-preview-card">
                <span>已选图片</span>
                <div className="option-card option-card--metric">
                  <span>共 {items.length} 张</span>
                  <strong>
                    {items[0].width} × {items[0].height}
                  </strong>
                  <small>{items[0].name}（首张原图尺寸）</small>
                </div>
                <button className="ghost-button" type="button" onClick={handleClearAll}>
                  清空列表
                </button>
              </div>
            ) : null}
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </section>

      {items.length > 0 ? (
        <section className="panel resize-settings">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>2. 设置尺寸</h2>
              <span>选择缩放方式并填写目标尺寸，下方会实时显示首张图片的输出尺寸。</span>
            </div>
          </div>

          <div className="mode-switch">
            <label className={`mode-pill ${mode === 'scale' ? 'is-active' : ''}`}>
              <input
                checked={mode === 'scale'}
                name="resize-mode"
                type="radio"
                onChange={() => setMode('scale')}
              />
              <span>按比例缩放</span>
              <small>等比例缩放，例如统一缩小到原来的 75%。</small>
            </label>
            <label className={`mode-pill ${mode === 'dimension' ? 'is-active' : ''}`}>
              <input
                checked={mode === 'dimension'}
                name="resize-mode"
                type="radio"
                onChange={() => setMode('dimension')}
              />
              <span>按尺寸缩放</span>
              <small>缩放到固定宽高、固定边或指定边长。</small>
            </label>
          </div>

          {mode === 'scale' ? (
            <div className="resize-inputs">
              <SliderNumberField
                hint="小于 100 为缩小，大于 100 为放大；可拖动滑块或直接在输入框填写自定义数值。"
                label="缩放比例（%）"
                sliderMax={200}
                sliderMin={10}
                value={scalePercent}
                onChange={setScalePercent}
              />
            </div>
          ) : (
            <>
              <div className="resize-inputs">
                <label className="field">
                  <span>缩放方式</span>
                  <select
                    value={dimMode}
                    onChange={(event) => setDimMode(event.target.value as DimensionMode)}
                  >
                    <option value="fixed">固定尺寸（宽 × 高）</option>
                    <option value="width">固定宽度（高度按比例）</option>
                    <option value="height">固定高度（宽度按比例）</option>
                    <option value="max">固定最长边</option>
                    <option value="min">固定最短边</option>
                  </select>
                </label>

                {dimMode === 'fixed' ? (
                  <>
                    <SliderNumberField
                      label="目标宽度（px）"
                      sliderMax={3000}
                      sliderMin={16}
                      value={targetWidth}
                      onChange={setTargetWidth}
                    />
                    <SliderNumberField
                      label="目标高度（px）"
                      sliderMax={3000}
                      sliderMin={16}
                      value={targetHeight}
                      onChange={setTargetHeight}
                    />
                  </>
                ) : null}

                {dimMode === 'width' ? (
                  <SliderNumberField
                    label="目标宽度（px）"
                    sliderMax={3000}
                    sliderMin={16}
                    value={targetWidth}
                    onChange={setTargetWidth}
                  />
                ) : null}

                {dimMode === 'height' ? (
                  <SliderNumberField
                    label="目标高度（px）"
                    sliderMax={3000}
                    sliderMin={16}
                    value={targetHeight}
                    onChange={setTargetHeight}
                  />
                ) : null}

                {dimMode === 'max' || dimMode === 'min' ? (
                  <SliderNumberField
                    label={dimMode === 'max' ? '最长边（px）' : '最短边（px）'}
                    sliderMax={3000}
                    sliderMin={16}
                    value={targetSide}
                    onChange={setTargetSide}
                  />
                ) : null}
              </div>

              {dimMode === 'fixed' ? (
                <div className="resize-fit">
                  <span>比例不符时：</span>
                  <div className="segmented-control">
                    <button
                      className={`segmented-button ${fitMode === 'crop' ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => setFitMode('crop')}
                    >
                      居中裁剪
                    </button>
                    <button
                      className={`segmented-button ${fitMode === 'stretch' ? 'is-active' : ''}`}
                      type="button"
                      onClick={() => setFitMode('stretch')}
                    >
                      拉伸图片
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}

          <div className="toggle-group">
            <label className="toggle-card">
              <input
                checked={skipSmall}
                type="checkbox"
                onChange={(event) => setSkipSmall(event.target.checked)}
              />
              <span>跳过小图（目标尺寸大于原图时保持原尺寸）</span>
            </label>
          </div>

          {preview ? (
            <p className="resize-hint">
              首张图片将输出为 <strong>{preview.width} × {preview.height}</strong>
              {!isDimensionValid ? '（请填写有效的目标尺寸）' : ''}。
            </p>
          ) : null}

          <div className="chroma-actions">
            <button
              className="primary-button chroma-generate-button"
              disabled={!isDimensionValid || isProcessing}
              type="button"
              onClick={() => void handleProcess()}
            >
              {isProcessing ? '正在批量改尺寸...' : '3. 开始改尺寸'}
            </button>
          </div>
        </section>
      ) : null}

      {hasResults ? (
        <section className="panel">
          <div className="panel-head">
            <h2>改尺寸结果</h2>
            <span>
              本地处理完成，可逐张下载或打包下载。共{' '}
              {items.filter((entry) => entry.status === 'done' || entry.status === 'skipped').length} 张。
            </span>
          </div>

          <div className="resize-results">
            {items.map((item) => (
              <div className="panel resize-card" key={item.id}>
                {item.status === 'error' ? (
                  <span className="resize-badge resize-badge--err">处理失败</span>
                ) : item.status === 'skipped' ? (
                  <span className="resize-badge resize-badge--skip">已跳过（小图）</span>
                ) : (
                  <span className="resize-badge">已完成</span>
                )}

                {item.resultUrl ? (
                  <img
                    alt={`${item.name} 改尺寸预览`}
                    className="resize-thumb"
                    src={item.resultUrl}
                  />
                ) : (
                  <div className="resize-thumb resize-thumb--empty">
                    <span>{item.error ?? '未生成预览'}</span>
                  </div>
                )}

                <div className="resize-card__meta">
                  <strong>{item.name}</strong>
                  <small>
                    {item.width} × {item.height} →{' '}
                    {item.resultWidth ?? item.width} × {item.resultHeight ?? item.height}
                  </small>
                </div>

                <div className="resize-card__actions">
                  <button
                    className="secondary-button secondary-button--violet"
                    disabled={!item.resultBlob}
                    type="button"
                    onClick={() => handleDownloadItem(item)}
                  >
                    下载
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => handleRemoveItem(item.id)}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="export-actions">
            <button
              className="secondary-button"
              disabled={!hasResults}
              type="button"
              onClick={() => void handleDownloadAll()}
            >
              下载全部（ZIP）
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

export default ImageResizeTool;
