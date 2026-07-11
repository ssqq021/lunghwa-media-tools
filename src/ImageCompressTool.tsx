import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import UPNG from 'upng-js';
import JSZip from 'jszip';
import { getBaseFileName } from './lib/exportBundle';

const MAX_FILES = 50;
const MAX_SIZE_MB = 50;
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const DEFAULT_QUALITY = 80;

type OutputFormat = 'keep' | 'jpeg' | 'webp';
type ItemStatus = 'pending' | 'done' | 'error';

type CompressItem = {
  id: string;
  file: File;
  name: string;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  mime: string;
  originalUrl: string;
  originalSize: number;
  status: ItemStatus;
  resultUrl: string | null;
  resultBlob: Blob | null;
  resultMime: string | null;
  resultSize: number | null;
  error: string | null;
};

type ImageCompressToolProps = {
  onStatusChange: (status: string) => void;
};

let itemSeq = 0;

function outputExt(mime: string): string {
  if (mime === 'image/png') {
    return 'png';
  }

  if (mime === 'image/webp') {
    return 'webp';
  }

  return 'jpg';
}

function outputName(item: CompressItem): string {
  return `${getBaseFileName(item.name)}-compressed.${outputExt(item.resultMime ?? item.mime)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
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

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('图片导出失败，浏览器可能不支持该格式。'));
          return;
        }

        resolve(blob);
      },
      mime,
      mime === 'image/png' ? undefined : quality,
    );
  });
}

function pngColorCount(qualityPercent: number): number {
  if (qualityPercent >= 98) {
    return 0; // 无损：保留全部颜色
  }

  const cnum = Math.round((qualityPercent / 100) * 256);
  return Math.min(256, Math.max(8, cnum));
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resolveOutputMime(item: CompressItem, format: OutputFormat): string {
  if (format === 'jpeg') {
    return 'image/jpeg';
  }

  if (format === 'webp') {
    return 'image/webp';
  }

  return item.mime;
}

type CompareSliderProps = {
  originalUrl: string;
  compressedUrl: string;
};

function CompareSlider({ originalUrl, compressedUrl }: CompareSliderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<number>(50);
  const draggingRef = useRef<boolean>(false);

  function updateFromEvent(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const next = (x / rect.width) * 100;
    setPos(Math.min(100, Math.max(0, next)));
  }

  return (
    <div
      ref={containerRef}
      className="compare"
      onPointerDown={(event) => {
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromEvent(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) {
          updateFromEvent(event);
        }
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    >
      <img className="compare__after" alt="压缩后" src={compressedUrl} />
      <img
        className="compare__before"
        alt="原图"
        src={originalUrl}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <div className="compare__divider" style={{ left: `${pos}%` }}>
        <span className="compare__grip" aria-hidden="true" />
      </div>
      <span className="compare__tag compare__tag--before">原图</span>
      <span className="compare__tag compare__tag--after">压缩后</span>
    </div>
  );
}

function ImageCompressTool({ onStatusChange }: ImageCompressToolProps) {
  const [items, setItems] = useState<CompressItem[]>([]);
  const [qualityPercent, setQualityPercent] = useState<number>(DEFAULT_QUALITY);
  const [outFormat, setOutFormat] = useState<OutputFormat>('keep');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<CompressItem[]>([]);

  itemsRef.current = items;

  function revokeItem(item: CompressItem): void {
    if (item.originalUrl) {
      URL.revokeObjectURL(item.originalUrl);
    }

    if (item.resultUrl) {
      URL.revokeObjectURL(item.resultUrl);
    }
  }

  useEffect(() => {
    return () => {
      itemsRef.current.forEach(revokeItem);
    };
  }, []);

  const hasResults = items.some((entry) => entry.status === 'done' || entry.status === 'error');

  async function handleFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) {
      return;
    }

    setError(null);

    const incoming = Array.from(fileList);
    const nextItems: CompressItem[] = [];
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
          id: `compress-${itemSeq}`,
          file,
          name: file.name,
          canvas,
          width: canvas.width,
          height: canvas.height,
          mime: file.type,
          originalUrl: URL.createObjectURL(file),
          originalSize: file.size,
          status: 'pending',
          resultUrl: null,
          resultBlob: null,
          resultMime: null,
          resultSize: null,
          error: null,
        });
        itemSeq += 1;
      } catch (nextError) {
        rejected.push(`${file.name}（${nextError instanceof Error ? nextError.message : '读取失败'}）`);
      }
    }

    if (nextItems.length > 0) {
      setItems((current) => [...current, ...nextItems]);
      onStatusChange(`已加入 ${nextItems.length} 张图片，共 ${items.length + nextItems.length} 张待压缩。`);
    }

    if (rejected.length > 0) {
      setError(`已跳过 ${rejected.length} 个文件：${rejected.join('、')}`);
    }
  }

  function handleRemoveItem(id: string): void {
    setItems((current) => {
      const targetItem = current.find((entry) => entry.id === id);
      if (targetItem) {
        revokeItem(targetItem);
      }

      return current.filter((entry) => entry.id !== id);
    });
  }

  function handleClearAll(): void {
    itemsRef.current.forEach(revokeItem);
    setItems([]);
    setError(null);
    onStatusChange('已清空图片列表。');
  }

  function handleProcess(): Promise<void> {
    if (items.length === 0 || isProcessing) {
      return Promise.resolve();
    }

    setError(null);
    setIsProcessing(true);
    onStatusChange(`正在批量压缩，共 ${items.length} 张...`);

    const quality = qualityPercent / 100;

    return Promise.all(
      items.map(async (item): Promise<CompressItem> => {
        try {
          const outMime = resolveOutputMime(item, outFormat);
          const out = document.createElement('canvas');
          out.width = item.width;
          out.height = item.height;
          const context = out.getContext('2d');
          if (!context) {
            throw new Error('无法创建画布。');
          }

          let blob: Blob;
          if (outMime === 'image/png') {
            context.drawImage(item.canvas, 0, 0);
            const imageData = context.getImageData(0, 0, out.width, out.height);
            const pngBuffer = UPNG.encode(
              [imageData.data.buffer],
              out.width,
              out.height,
              pngColorCount(qualityPercent),
            );
            blob = new Blob([pngBuffer], { type: 'image/png' });
          } else {
            if (outMime === 'image/jpeg') {
              context.fillStyle = '#ffffff';
              context.fillRect(0, 0, out.width, out.height);
            }

            context.drawImage(item.canvas, 0, 0);
            blob = await canvasToBlob(out, outMime, quality);
          }
          const resultUrl = URL.createObjectURL(blob);

          return {
            ...item,
            status: 'done',
            resultUrl,
            resultBlob: blob,
            resultMime: outMime,
            resultSize: blob.size,
            error: null,
          };
        } catch (nextError) {
          return {
            ...item,
            status: 'error',
            resultUrl: null,
            resultBlob: null,
            resultMime: null,
            resultSize: null,
            error: nextError instanceof Error ? nextError.message : '压缩失败',
          };
        }
      }),
    ).then((results) => {
      setItems(results);
      setIsProcessing(false);

      const done = results.filter((entry) => entry.status === 'done').length;
      const failed = results.filter((entry) => entry.status === 'error').length;
      onStatusChange(`压缩完成：成功 ${done} 张，失败 ${failed} 张。可拖动结果卡片对比原图与压缩后。`);
    });
  }

  function handleDownloadItem(item: CompressItem): void {
    if (!item.resultBlob) {
      return;
    }

    triggerBlobDownload(item.resultBlob, outputName(item));
  }

  async function handleDownloadAll(): Promise<void> {
    const ready = items.filter((entry) => entry.status === 'done' && entry.resultBlob);
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
    triggerBlobDownload(content, 'compressed-images.zip');
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
                    {formatSize(items.reduce((sum, entry) => sum + entry.originalSize, 0))}
                  </strong>
                  <small>原始总大小</small>
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
              <h2>2. 设置压缩参数</h2>
              <span>拖动滑块调整质量，数值越低体积越小、画质损失越明显。</span>
            </div>
          </div>

          <div className="resize-inputs">
            <label className="field">
              <span>压缩质量（%）</span>
              <div className="range-field">
                <div className="range-field__row">
                  <input
                    max={100}
                    min={10}
                    step={5}
                    type="range"
                    value={qualityPercent}
                    onChange={(event) => setQualityPercent(Number(event.target.value))}
                  />
                  <input
                    className="range-field__num"
                    max={100}
                    min={10}
                    type="number"
                    value={qualityPercent}
                    onChange={(event) => setQualityPercent(Number(event.target.value))}
                  />
                </div>
                <small>10%–100%，默认 {DEFAULT_QUALITY}%。</small>
              </div>
            </label>

            <label className="field">
              <span>输出格式</span>
              <select
                value={outFormat}
                onChange={(event) => setOutFormat(event.target.value as OutputFormat)}
              >
                <option value="keep">保持原格式</option>
                <option value="webp">转为 WebP（体积更小）</option>
                <option value="jpeg">转为 JPEG（体积更小）</option>
              </select>
              <small>PNG 采用调色板量化压缩：质量越高越接近无损，越低体积越小（可能有轻微色带）。</small>
            </label>
          </div>

          <div className="chroma-actions">
            <button
              className="primary-button chroma-generate-button"
              disabled={isProcessing}
              type="button"
              onClick={() => void handleProcess()}
            >
              {isProcessing ? '正在批量压缩...' : '3. 开始压缩'}
            </button>
          </div>
        </section>
      ) : null}

      {hasResults ? (
        <section className="panel">
          <div className="panel-head">
            <h2>压缩结果</h2>
            <span>
              拖动卡片中间的分割线，左右对照原图与压缩后效果。共{' '}
              {items.filter((entry) => entry.status === 'done').length} 张。
            </span>
          </div>

          <div className="resize-results">
            {items.map((item) => {
              const saving =
                item.resultSize !== null
                  ? Math.round((1 - item.resultSize / item.originalSize) * 100)
                  : 0;

              return (
                <div className="panel resize-card" key={item.id}>
                  {item.status === 'error' ? (
                    <span className="resize-badge resize-badge--err">压缩失败</span>
                  ) : (
                    <span className="resize-badge">已完成</span>
                  )}

                  {item.resultUrl ? (
                    <CompareSlider originalUrl={item.originalUrl} compressedUrl={item.resultUrl} />
                  ) : (
                    <div className="resize-thumb resize-thumb--empty">
                      <span>{item.error ?? '未生成预览'}</span>
                    </div>
                  )}

                  <div className="resize-card__meta">
                    <strong>{item.name}</strong>
                    <small>
                      {formatSize(item.originalSize)} → {formatSize(item.resultSize ?? item.originalSize)}
                      {item.status === 'done' ? `（节省 ${saving}%）` : ''}
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
              );
            })}
          </div>

          <div className="export-actions">
            <button
              className="secondary-button"
              disabled={!items.some((entry) => entry.status === 'done')}
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

export default ImageCompressTool;
