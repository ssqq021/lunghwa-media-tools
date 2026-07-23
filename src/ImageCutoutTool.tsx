import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ColorKeyOptions,
  ColorSample,
  KeyAlgorithm,
  PreviewMode,
} from './types';
import {
  applyColorKey,
  applyColorKeySequence,
  sampleCanvasColor,
} from './lib/chromaKey';
import { getBaseFileName } from './lib/exportBundle';
import { assertCanvasSize, assertFrameMemoryBudget } from './lib/resourceBudget';
import { createLatestTaskTracker, isStaleTaskError } from './lib/latestTask';

const DEFAULT_KEY_ALGORITHM: KeyAlgorithm = 'enhanced';
const DEFAULT_TOLERANCE = 28;
const DEFAULT_SOFTNESS = 14;
const DEFAULT_DESPILL = 50;
const DEFAULT_EDGE_RADIUS = 22;
const DEFAULT_SAMPLE_RADIUS = 6;
const DEFAULT_SOLID_PREVIEW_BG = '#111827';

type SamplePoint = {
  x: number;
  y: number;
};

type ImageCutoutToolProps = {
  onStatusChange: (status: string) => void;
};

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法导出透明 PNG。'));
        return;
      }

      resolve(blob);
    }, 'image/png');
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
      try {
        assertCanvasSize(image.naturalWidth, image.naturalHeight, '源图片');
      } catch (error) {
        reject(error);
        return;
      }
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

function getCanvasPoint(
  event: Pick<React.MouseEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>,
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

function getCutoutFileName(fileName: string): string {
  return `${getBaseFileName(fileName || 'image')}-cutout.png`;
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

function ImageCutoutTool({ onStatusChange }: ImageCutoutToolProps) {
  const [imageName, setImageName] = useState<string | null>(null);
  const [sourceFrame, setSourceFrame] = useState<HTMLCanvasElement | null>(null);
  const [workingFrame, setWorkingFrame] = useState<HTMLCanvasElement | null>(null);
  const [resultFrame, setResultFrame] = useState<HTMLCanvasElement | null>(null);
  const [maskFrame, setMaskFrame] = useState<HTMLCanvasElement | null>(null);
  const [samplePoint, setSamplePoint] = useState<SamplePoint | null>(null);
  const [colorSample, setColorSample] = useState<ColorSample | null>(null);
  const [committedColorKeys, setCommittedColorKeys] = useState<ColorKeyOptions[]>([]);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('result');
  const [solidPreviewColor, setSolidPreviewColor] = useState(DEFAULT_SOLID_PREVIEW_BG);
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [softness, setSoftness] = useState(DEFAULT_SOFTNESS);
  const [smoothing, setSmoothing] = useState(true);
  const [despillEnabled, setDespillEnabled] = useState(true);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isRendering, setIsRendering] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const referenceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultPanelRef = useRef<HTMLElement | null>(null);
  const fileTaskTrackerRef = useRef(createLatestTaskTracker());
  const renderTaskTrackerRef = useRef(createLatestTaskTracker());

  const cutoutFileName = useMemo(
    () => getCutoutFileName(imageName ?? 'image'),
    [imageName],
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
  const hasCommittedColorKeys = committedColorKeys.length > 0;
  const hasAnyColorKeyPass = activeColorKeySequence.length > 0;

  useEffect(() => {
    return () => {
      fileTaskTrackerRef.current.invalidate();
      renderTaskTrackerRef.current.invalidate();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (resultUrl) {
        URL.revokeObjectURL(resultUrl);
      }
    };
  }, [resultUrl]);

  useEffect(() => {
    renderTaskTrackerRef.current.invalidate();
    setIsRendering(false);
    setResultUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, [resultFrame]);

  useEffect(() => {
    if (!workingFrame || !samplePoint) {
      setColorSample(null);
      return;
    }

    try {
      setColorSample(
        sampleCanvasColor(workingFrame, samplePoint.x, samplePoint.y, DEFAULT_SAMPLE_RADIUS),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '颜色取样失败。');
    }
  }, [samplePoint, workingFrame]);

  useEffect(() => {
    if (!sourceFrame) {
      setWorkingFrame(null);
      setResultFrame(null);
      setMaskFrame(null);
      return;
    }

    try {
      const committedPreview = hasCommittedColorKeys
        ? applyColorKeySequence(sourceFrame, committedColorKeys)
        : null;
      const nextWorkingFrame = committedPreview?.image ?? sourceFrame;

      setWorkingFrame(nextWorkingFrame);

      if (!colorKeyOptions) {
        setResultFrame(nextWorkingFrame);
        setMaskFrame(committedPreview?.mask ?? null);
        return;
      }

      const preview = applyColorKey(nextWorkingFrame, colorKeyOptions);
      setResultFrame(preview.image);
      setMaskFrame(preview.mask);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '图片抠图预览失败。');
    }
  }, [colorKeyOptions, committedColorKeys, hasCommittedColorKeys, sourceFrame]);

  useEffect(() => {
    drawCanvas(referenceCanvasRef.current, workingFrame, samplePoint);
  }, [samplePoint, workingFrame]);

  useEffect(() => {
    const source =
      previewMode === 'mask'
        ? maskFrame
        : resultFrame ?? sourceFrame;

    drawCanvas(
      previewCanvasRef.current,
      source,
      undefined,
      previewMode === 'solid' ? solidPreviewColor : undefined,
    );
  }, [maskFrame, previewMode, resultFrame, solidPreviewColor, sourceFrame]);

  async function updateImageFile(file: File): Promise<void> {
    const taskToken = fileTaskTrackerRef.current.begin();
    renderTaskTrackerRef.current.invalidate();
    setIsRendering(false);
    setError(null);
    onStatusChange('正在读取图片...');
    setSamplePoint(null);
    setColorSample(null);
    setCommittedColorKeys([]);
    setPreviewMode('result');
    setWorkingFrame(null);
    setResultFrame(null);
    setMaskFrame(null);
    setResultUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return null;
    });

    try {
      const canvas = await loadImageFile(file);
      fileTaskTrackerRef.current.assertCurrent(taskToken);
      assertFrameMemoryBudget(canvas.width, canvas.height, 1, 4, '图片抠图');
      setImageName(file.name);
      setSourceFrame(canvas);
      onStatusChange('图片已就绪，请点击背景颜色开始抠图。');
    } catch (nextError) {
      if (!fileTaskTrackerRef.current.isCurrent(taskToken) || isStaleTaskError(nextError)) return;
      setImageName(null);
      setSourceFrame(null);
      setResultFrame(null);
      setMaskFrame(null);
      onStatusChange('图片读取失败，请换一张图片后重试。');
      setError(nextError instanceof Error ? nextError.message : '图片读取失败。');
    }
  }

  function handleImageDrop(fileList: FileList | null): void {
    const file = fileList?.[0];
    if (!file) {
      return;
    }

    void updateImageFile(file);
  }

  function handleReferenceCanvasClick(event: React.MouseEvent<HTMLCanvasElement>): void {
    if (!workingFrame || !referenceCanvasRef.current) {
      return;
    }

    const point = getCanvasPoint(
      event,
      referenceCanvasRef.current,
      workingFrame.width,
      workingFrame.height,
    );

    setSamplePoint(point);
    onStatusChange(
      hasCommittedColorKeys
        ? '新背景颜色已采样，可以继续调整参数，或先应用当前抠像再继续下一轮。'
        : '背景颜色已采样，可以继续调整容差、羽化和去溢色。',
    );
  }

  function clearResultUrl(): void {
    setResultUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }

      return null;
    });
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
    clearResultUrl();
    onStatusChange(`已应用第 ${nextCount} 次抠像，可继续点击下一种背景颜色。`);
  }

  function handleResetCommittedColorKeys(): void {
    if (!committedColorKeys.length) {
      return;
    }

    setCommittedColorKeys([]);
    setSamplePoint(null);
    setColorSample(null);
    setPreviewMode('result');
    clearResultUrl();
    onStatusChange('已重置为原图，可重新开始抠像。');
  }

  async function handleGenerate(): Promise<void> {
    const taskToken = renderTaskTrackerRef.current.begin();
    try {
      if (!resultFrame || !hasAnyColorKeyPass) {
        throw new Error('请先在图片里点击背景颜色，再生成透明抠图。');
      }

      setIsRendering(true);
      const blob = await canvasToPngBlob(resultFrame);
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      const objectUrl = URL.createObjectURL(blob);

      setResultUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return objectUrl;
      });
      onStatusChange('透明抠图已生成，可以预览或下载 PNG。');
      window.setTimeout(() => {
        resultPanelRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
      }, 180);
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : '生成失败。');
      onStatusChange('生成失败，请调整参数后重试。');
    } finally {
      if (renderTaskTrackerRef.current.isCurrent(taskToken)) {
        setIsRendering(false);
      }
    }
  }

  async function handleDownload(): Promise<void> {
    const taskToken = renderTaskTrackerRef.current.begin();
    try {
      if (!resultFrame || !hasAnyColorKeyPass) {
        throw new Error('请先在图片里点击背景颜色，再导出透明抠图。');
      }

      setIsRendering(true);
      const blob = await canvasToPngBlob(resultFrame);
      renderTaskTrackerRef.current.assertCurrent(taskToken);
      triggerBlobDownload(blob, cutoutFileName);
      onStatusChange('透明 PNG 已生成并开始下载。');
    } catch (nextError) {
      if (isStaleTaskError(nextError)) return;
      setError(nextError instanceof Error ? nextError.message : '导出失败。');
      onStatusChange('导出失败，请稍后再试。');
    } finally {
      if (renderTaskTrackerRef.current.isCurrent(taskToken)) {
        setIsRendering(false);
      }
    }
  }

  return (
    <>
      <section className="workspace-grid workspace-grid--single">
        <div className="panel upload-panel">
          <div className="panel-head">
            <h2>1. 上传图片</h2>
            <span>支持 PNG、JPG、WebP 等常见图片格式</span>
          </div>

          <input
            ref={inputRef}
            hidden
            accept="image/*"
            type="file"
            onChange={(event) => {
              handleImageDrop(event.target.files);
              event.currentTarget.value = '';
            }}
          />

          <div className={`upload-layout ${sourceFrame ? 'upload-layout--with-preview' : ''}`}>
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
                handleImageDrop(event.dataTransfer.files);
              }}
            >
              <span className="dropzone-kicker">拖放图片到这里</span>
              <strong>或点击选择本地图片</strong>
              <small>上传后点击背景色即可预览透明抠图，并导出透明 PNG。</small>
            </button>

            {sourceFrame ? (
              <div className="video-preview-card image-preview-card">
                <span>图片信息</span>
                <div className="option-card option-card--metric">
                  <span>{imageName ?? '本地图片'}</span>
                  <strong>{sourceFrame.width} × {sourceFrame.height}</strong>
                  <small>原图尺寸</small>
                </div>
              </div>
            ) : null}
          </div>

          {error ? <p className="error-text">{error}</p> : null}
        </div>
      </section>

      {sourceFrame ? (
        <section className="panel chroma-panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>2. 图片抠图预览</h2>
              <span>直接在左侧基底图里点击背景颜色；每次应用后都可以继续抠下一种颜色。</span>
            </div>
          </div>

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
                      : '点击左侧图片取背景色后生成透明抠图'}
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
                  className="preview-canvas"
                  onClick={handleReferenceCanvasClick}
                />
              </div>
              <div className="canvas-footer">
                <span>
                  {samplePoint
                    ? `当前取样点：(${samplePoint.x}, ${samplePoint.y})`
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
                    disabled={!maskFrame}
                    type="button"
                    onClick={() => setPreviewMode('mask')}
                  >
                    Alpha 蒙版
                  </button>
                  <button
                    className={`segmented-button ${previewMode === 'solid' ? 'is-active' : ''}`}
                    disabled={!resultFrame}
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

          <div className="chroma-actions chroma-actions--stack">
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
              disabled={!sourceFrame || !hasAnyColorKeyPass || isRendering}
              type="button"
              onClick={() => void handleGenerate()}
            >
              {isRendering ? '正在生成透明抠图...' : '3. 生成透明 PNG'}
            </button>
          </div>
        </section>
      ) : null}

      {resultUrl && resultFrame ? (
        <section ref={resultPanelRef} className="result-grid">
          <div className="panel preview-panel">
            <div className="panel-head">
              <h2>3. 透明 PNG 预览</h2>
              <span>透明 PNG · {resultFrame.width} × {resultFrame.height}</span>
            </div>

            <div className="preview-wrap">
              <img alt="生成的透明抠图预览" className="preview-image" src={resultUrl} />
            </div>
          </div>

          <div className="panel download-panel">
            <div className="panel-head">
              <h2>4. 导出结果</h2>
              <span>本地下载</span>
            </div>

            <p className="download-copy">
              图片抠图模式会输出透明 PNG，修改抠图参数后可重新生成当前预览。
            </p>

            <div className="option-card option-card--metric">
              <span>导出文件</span>
              <strong>{cutoutFileName}</strong>
              <small>{resultFrame.width} × {resultFrame.height} 透明 PNG</small>
            </div>

            <div className="export-actions">
              <button
                className="secondary-button secondary-button--violet"
                disabled={isRendering}
                type="button"
                onClick={() => void handleDownload()}
              >
                下载透明抠图 PNG
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

export default ImageCutoutTool;
