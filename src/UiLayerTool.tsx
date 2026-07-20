import JSZip from 'jszip';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { getBaseFileName } from './lib/exportBundle';
import {
  areSpriteFingerprintsSimilar,
  createSpriteFingerprint,
  findAlphaBounds,
  findAlphaComponents,
  sanitizeLayerName,
  type SpriteFingerprint,
} from './lib/uiLayer';

const SERVICE_URL = 'http://127.0.0.1:7862';

type LayerMode = 'faithful' | 'complete';
type LayerQuality = 'fast' | 'high';
type BrushMode = 'off' | 'erase' | 'restore';

type ServiceInfo = {
  ready: boolean;
  status: string;
  message: string;
  error?: string | null;
  progress: number;
  device: string;
  model_download_gb: number;
};

type ApiLayer = {
  id: string;
  name: string;
  image: string;
};

type DecomposeResponse = {
  width: number;
  height: number;
  layer_count: number;
  layers: ApiLayer[];
};

type EditableLayer = {
  id: string;
  name: string;
  visible: boolean;
  x: number;
  y: number;
  scale: number;
};

type EditSnapshot = {
  layerId: string;
  image: ImageData;
};

type LayerDrag = {
  layerId: string;
  startX: number;
  startY: number;
  layerX: number;
  layerY: number;
};

type UiLayerToolProps = {
  onStatusChange: (status: string) => void;
};

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('无法生成透明 PNG。'));
      }
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

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('拆分图层读取失败。'));
    image.src = url;
  });
}

async function canvasFromImageUrl(url: string): Promise<HTMLCanvasElement> {
  const image = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('无法创建图层画布。');
  }
  context.drawImage(image, 0, 0);
  return canvas;
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext('2d')?.drawImage(source, 0, 0);
  return copy;
}

function drawTransformedLayer(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  layer: EditableLayer,
): void {
  context.drawImage(
    canvas,
    layer.x,
    layer.y,
    canvas.width * layer.scale,
    canvas.height * layer.scale,
  );
}

function getCanvasPoint(
  event: ReactPointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '处理失败，请稍后重试。';
}

function UiLayerTool({ onStatusChange }: UiLayerToolProps) {
  const [service, setService] = useState<ServiceInfo | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [mode, setMode] = useState<LayerMode>('faithful');
  const [quality, setQuality] = useState<LayerQuality>('fast');
  const [layerChoice, setLayerChoice] = useState<'auto' | 'manual'>('auto');
  const [manualLayers, setManualLayers] = useState(6);
  const [layers, setLayers] = useState<EditableLayer[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [brushMode, setBrushMode] = useState<BrushMode>('off');
  const [brushSize, setBrushSize] = useState(32);
  const [revision, setRevision] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workingCanvasesRef = useRef(new Map<string, HTMLCanvasElement>());
  const originalCanvasesRef = useRef(new Map<string, HTMLCanvasElement>());
  const undoStackRef = useRef<EditSnapshot[]>([]);
  const redoStackRef = useRef<EditSnapshot[]>([]);
  const isPaintingRef = useRef(false);
  const layerDragRef = useRef<LayerDrag | null>(null);

  const selectedLayer = useMemo(
    () => layers.find((layer) => layer.id === selectedLayerId) ?? null,
    [layers, selectedLayerId],
  );

  const renderComposite = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !sourceSize.width || !sourceSize.height) {
      return;
    }

    canvas.width = sourceSize.width;
    canvas.height = sourceSize.height;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of layers) {
      const source = workingCanvasesRef.current.get(layer.id);
      if (source && layer.visible) {
        drawTransformedLayer(context, source, layer);
      }
    }
  }, [layers, sourceSize]);

  useEffect(() => {
    renderComposite();
  }, [renderComposite, revision]);

  useEffect(() => {
    return () => {
      if (sourceUrl) {
        URL.revokeObjectURL(sourceUrl);
      }
    };
  }, [sourceUrl]);

  useEffect(() => {
    if (!service || !['downloading', 'loading'].includes(service.status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void connectService(false);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [service?.status]);

  async function connectService(report = true): Promise<void> {
    try {
      const response = await fetch(`${SERVICE_URL}/health`);
      if (!response.ok) {
        throw new Error('本地服务没有正常响应。');
      }
      const info = (await response.json()) as ServiceInfo;
      setService(info);
      setError(null);
      if (report) {
        onStatusChange(
          info.ready
            ? 'UI拆图本地模型已经就绪。'
            : ['downloading', 'loading'].includes(info.status)
              ? '已连接本地服务，模型正在准备。'
              : info.status === 'error'
                ? '已连接本地服务，但模型准备失败。'
                : '已连接本地服务，请准备本地模型。',
        );
      }
    } catch {
      setService(null);
      if (report) {
        setError('无法连接本地服务。请先下载安装包并运行 start_ui_layer.bat。');
        onStatusChange('UI拆图本地服务未连接。');
      }
    }
  }

  async function prepareModel(): Promise<void> {
    try {
      setError(null);
      const response = await fetch(`${SERVICE_URL}/prepare`, { method: 'POST' });
      const info = (await response.json()) as ServiceInfo;
      if (!response.ok) {
        throw new Error(info.error || '无法开始准备本地模型。');
      }
      setService(info);
      onStatusChange('正在准备本地 Qwen-Image-Layered 模型，请保持服务窗口开启。');
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  }

  async function updateSourceFile(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      setError('请选择 PNG、JPG 或 WebP 图片。');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setError('单张图片不能超过 50MB。');
      return;
    }

    const nextUrl = URL.createObjectURL(file);
    try {
      const image = await loadImage(nextUrl);
      setSourceUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return nextUrl;
      });
      setSourceFile(file);
      setSourceSize({ width: image.naturalWidth, height: image.naturalHeight });
      setLayers([]);
      setSelectedLayerId(null);
      workingCanvasesRef.current.clear();
      originalCanvasesRef.current.clear();
      undoStackRef.current = [];
      redoStackRef.current = [];
      setError(null);
      onStatusChange('图片已就绪，请选择拆图模式和图层数量。');
    } catch (nextError) {
      URL.revokeObjectURL(nextUrl);
      setError(errorMessage(nextError));
    }
  }

  async function requestLayers(file: File): Promise<DecomposeResponse> {
    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    form.append('quality', quality);
    form.append('layers', layerChoice === 'auto' ? 'auto' : String(manualLayers));
    const response = await fetch(`${SERVICE_URL}/decompose`, {
      method: 'POST',
      body: form,
    });
    const payload = (await response.json()) as DecomposeResponse & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || '本地模型拆图失败。');
    }
    return payload;
  }

  async function createEditableLayers(
    apiLayers: ApiLayer[],
    namePrefix = '图层',
  ): Promise<EditableLayer[]> {
    const nextLayers: EditableLayer[] = [];
    for (let index = 0; index < apiLayers.length; index += 1) {
      const apiLayer = apiLayers[index];
      const id = `${apiLayer.id}-${Date.now()}-${index}`;
      const canvas = await canvasFromImageUrl(apiLayer.image);
      workingCanvasesRef.current.set(id, canvas);
      originalCanvasesRef.current.set(id, copyCanvas(canvas));
      nextLayers.push({
        id,
        name: namePrefix === '图层' ? apiLayer.name : `${namePrefix}-${index + 1}`,
        visible: true,
        x: 0,
        y: 0,
        scale: 1,
      });
    }
    return nextLayers;
  }

  async function handleDecompose(): Promise<void> {
    if (!sourceFile) {
      setError('请先上传游戏 UI 图片。');
      return;
    }
    if (!service?.ready) {
      setError('请先连接本地服务并准备模型。');
      return;
    }

    setIsWorking(true);
    setError(null);
    onStatusChange(
      mode === 'faithful'
        ? '正在进行忠实拆图，保留原图可见像素……'
        : '正在智能拆图并补全被遮挡区域……',
    );
    try {
      const payload = await requestLayers(sourceFile);
      workingCanvasesRef.current.clear();
      originalCanvasesRef.current.clear();
      const nextLayers = await createEditableLayers(payload.layers);
      setLayers(nextLayers);
      setSelectedLayerId(nextLayers.at(-1)?.id ?? null);
      undoStackRef.current = [];
      redoStackRef.current = [];
      setRevision((value) => value + 1);
      onStatusChange(`拆图完成，共生成 ${payload.layer_count} 个可编辑图层。`);
    } catch (nextError) {
      setError(errorMessage(nextError));
      onStatusChange('UI拆图失败，请检查本地服务窗口中的提示。');
    } finally {
      setIsWorking(false);
      void connectService(false);
    }
  }

  function updateLayer(id: string, patch: Partial<EditableLayer>): void {
    setLayers((current) =>
      current.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
    );
  }

  function captureSnapshot(layerId: string): EditSnapshot | null {
    const canvas = workingCanvasesRef.current.get(layerId);
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return null;
    }
    return {
      layerId,
      image: context.getImageData(0, 0, canvas.width, canvas.height),
    };
  }

  function applyBrush(point: { x: number; y: number }): void {
    if (!selectedLayer || brushMode === 'off') {
      return;
    }
    const working = workingCanvasesRef.current.get(selectedLayer.id);
    const original = originalCanvasesRef.current.get(selectedLayer.id);
    const context = working?.getContext('2d');
    if (!working || !original || !context) {
      return;
    }

    const x = (point.x - selectedLayer.x) / selectedLayer.scale;
    const y = (point.y - selectedLayer.y) / selectedLayer.scale;
    const radius = brushSize / selectedLayer.scale / 2;
    if (brushMode === 'erase') {
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      context.restore();
    } else {
      context.save();
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.clip();
      context.clearRect(x - radius, y - radius, radius * 2, radius * 2);
      context.drawImage(original, 0, 0);
      context.restore();
    }
    setRevision((value) => value + 1);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!previewCanvasRef.current || !selectedLayer) {
      return;
    }
    const point = getCanvasPoint(event, previewCanvasRef.current);
    if (brushMode === 'off') {
      layerDragRef.current = {
        layerId: selectedLayer.id,
        startX: point.x,
        startY: point.y,
        layerX: selectedLayer.x,
        layerY: selectedLayer.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const snapshot = captureSnapshot(selectedLayer.id);
    if (snapshot) {
      undoStackRef.current = [...undoStackRef.current.slice(-7), snapshot];
      redoStackRef.current = [];
    }
    isPaintingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    applyBrush(point);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!previewCanvasRef.current) {
      return;
    }
    const point = getCanvasPoint(event, previewCanvasRef.current);
    const drag = layerDragRef.current;
    if (drag) {
      updateLayer(drag.layerId, {
        x: Math.round(drag.layerX + point.x - drag.startX),
        y: Math.round(drag.layerY + point.y - drag.startY),
      });
      return;
    }
    if (isPaintingRef.current) {
      applyBrush(point);
    }
  }

  function stopPainting(): void {
    isPaintingRef.current = false;
    layerDragRef.current = null;
  }

  function restoreSnapshot(
    sourceStack: { current: EditSnapshot[] },
    targetStack: { current: EditSnapshot[] },
  ): void {
    const snapshot = sourceStack.current.at(-1);
    if (!snapshot) {
      return;
    }
    const current = captureSnapshot(snapshot.layerId);
    const canvas = workingCanvasesRef.current.get(snapshot.layerId);
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }
    if (current) {
      targetStack.current = [...targetStack.current.slice(-7), current];
    }
    sourceStack.current = sourceStack.current.slice(0, -1);
    context.putImageData(snapshot.image, 0, 0);
    setSelectedLayerId(snapshot.layerId);
    setRevision((value) => value + 1);
  }

  function moveLayer(id: string, direction: -1 | 1): void {
    setLayers((current) => {
      const index = current.findIndex((layer) => layer.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function deleteSelectedLayer(): void {
    if (!selectedLayer) {
      return;
    }
    workingCanvasesRef.current.delete(selectedLayer.id);
    originalCanvasesRef.current.delete(selectedLayer.id);
    setLayers((current) => current.filter((layer) => layer.id !== selectedLayer.id));
    setSelectedLayerId(null);
  }

  function mergeSelectedDown(): void {
    if (!selectedLayer) {
      return;
    }
    const index = layers.findIndex((layer) => layer.id === selectedLayer.id);
    if (index <= 0) {
      setError('当前图层下方没有可合并的图层。');
      return;
    }
    const lower = layers[index - 1];
    const lowerCanvas = workingCanvasesRef.current.get(lower.id);
    const selectedCanvas = workingCanvasesRef.current.get(selectedLayer.id);
    if (!lowerCanvas || !selectedCanvas) {
      return;
    }

    const merged = document.createElement('canvas');
    merged.width = sourceSize.width;
    merged.height = sourceSize.height;
    const context = merged.getContext('2d');
    if (!context) {
      return;
    }
    drawTransformedLayer(context, lowerCanvas, lower);
    drawTransformedLayer(context, selectedCanvas, selectedLayer);

    const id = `merged-${Date.now()}`;
    workingCanvasesRef.current.set(id, merged);
    originalCanvasesRef.current.set(id, copyCanvas(merged));
    workingCanvasesRef.current.delete(lower.id);
    workingCanvasesRef.current.delete(selectedLayer.id);
    originalCanvasesRef.current.delete(lower.id);
    originalCanvasesRef.current.delete(selectedLayer.id);
    const mergedLayer: EditableLayer = {
      id,
      name: `${lower.name}+${selectedLayer.name}`,
      visible: true,
      x: 0,
      y: 0,
      scale: 1,
    };
    setLayers((current) => [
      ...current.slice(0, index - 1),
      mergedLayer,
      ...current.slice(index + 1),
    ]);
    setSelectedLayerId(id);
    setRevision((value) => value + 1);
  }

  async function splitSelectedLayerAgain(): Promise<void> {
    if (!selectedLayer || !service?.ready) {
      return;
    }
    const source = workingCanvasesRef.current.get(selectedLayer.id);
    if (!source) {
      return;
    }

    setIsWorking(true);
    setError(null);
    onStatusChange(`正在继续拆分“${selectedLayer.name}”……`);
    try {
      const full = document.createElement('canvas');
      full.width = sourceSize.width;
      full.height = sourceSize.height;
      const context = full.getContext('2d');
      if (!context) {
        throw new Error('无法创建继续拆分画布。');
      }
      drawTransformedLayer(context, source, selectedLayer);
      const file = new File(
        [await canvasToPngBlob(full)],
        `${sanitizeLayerName(selectedLayer.name, 'layer')}.png`,
        { type: 'image/png' },
      );
      const payload = await requestLayers(file);
      const replacements = await createEditableLayers(payload.layers, selectedLayer.name);
      const index = layers.findIndex((layer) => layer.id === selectedLayer.id);
      workingCanvasesRef.current.delete(selectedLayer.id);
      originalCanvasesRef.current.delete(selectedLayer.id);
      setLayers((current) => [
        ...current.slice(0, index),
        ...replacements,
        ...current.slice(index + 1),
      ]);
      setSelectedLayerId(replacements.at(-1)?.id ?? null);
      setRevision((value) => value + 1);
      onStatusChange(`继续拆分完成，新增 ${replacements.length} 个图层。`);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setIsWorking(false);
    }
  }

  function renderLayerToFullCanvas(layer: EditableLayer): HTMLCanvasElement | null {
    const source = workingCanvasesRef.current.get(layer.id);
    if (!source) {
      return null;
    }
    const full = document.createElement('canvas');
    full.width = sourceSize.width;
    full.height = sourceSize.height;
    const context = full.getContext('2d');
    if (!context) {
      return null;
    }
    drawTransformedLayer(context, source, layer);
    return full;
  }

  async function exportPngZip(): Promise<void> {
    const visibleLayers = layers.filter((layer) => layer.visible);
    if (!visibleLayers.length) {
      setError('至少保留一个可见图层后再导出。');
      return;
    }

    setIsExporting(true);
    setError(null);
    onStatusChange('正在切分透明区域、去除重复素材并生成 ZIP……');
    try {
      const zip = new JSZip();
      const fingerprints: SpriteFingerprint[] = [];
      let outputIndex = 0;
      const minimumPixels = Math.max(12, Math.floor(sourceSize.width * sourceSize.height * 0.00002));

      for (const layer of visibleLayers) {
        const full = renderLayerToFullCanvas(layer);
        const context = full?.getContext('2d', { willReadFrequently: true });
        if (!full || !context) {
          continue;
        }
        const imageData = context.getImageData(0, 0, full.width, full.height);
        let components = findAlphaComponents(
          imageData.data,
          full.width,
          full.height,
          minimumPixels,
        );
        if (!components.length) {
          const bounds = findAlphaBounds(imageData.data, full.width, full.height);
          components = bounds ? [bounds] : [];
        }

        for (const bounds of components.slice(0, 160)) {
          const fingerprint = createSpriteFingerprint(imageData.data, full.width, bounds);
          if (
            fingerprints.some((existing) =>
              areSpriteFingerprintsSimilar(existing, fingerprint),
            )
          ) {
            continue;
          }

          const cropped = document.createElement('canvas');
          cropped.width = bounds.width;
          cropped.height = bounds.height;
          cropped
            .getContext('2d')
            ?.drawImage(
              full,
              bounds.x,
              bounds.y,
              bounds.width,
              bounds.height,
              0,
              0,
              bounds.width,
              bounds.height,
            );
          const blob = await canvasToPngBlob(cropped);
          outputIndex += 1;
          const name = sanitizeLayerName(layer.name, `layer-${outputIndex}`);
          zip.file(`${String(outputIndex).padStart(3, '0')}-${name}.png`, blob);
          fingerprints.push(fingerprint);
        }
      }

      if (!outputIndex) {
        throw new Error('当前图层没有可导出的可见像素。');
      }

      const archive = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });
      const baseName = getBaseFileName(sourceFile?.name ?? 'ui-image');
      triggerBlobDownload(archive, `${baseName}-ui-layers.zip`);
      onStatusChange(`ZIP 已生成，共导出 ${outputIndex} 个不重复透明 PNG。`);
    } catch (nextError) {
      setError(errorMessage(nextError));
      onStatusChange('PNG ZIP 导出失败。');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <>
      <section className="panel ui-layer-service-card">
        <div className="panel-head panel-head--stack">
          <div>
            <h2>1. 连接本地 AI 服务</h2>
            <span>图片只在你的电脑中处理，网站不会上传原图。</span>
          </div>
          <div className="ui-layer-service-actions">
            <a
              className="ghost-button ui-layer-download-link"
              download
              href="./downloads/ui-layer-local-service.zip"
            >
              下载 Windows 本地服务
            </a>
            <button className="secondary-button" type="button" onClick={() => void connectService()}>
              连接本地服务
            </button>
            <button
              className="primary-button"
              disabled={!service || service.ready || ['downloading', 'loading'].includes(service.status)}
              type="button"
              onClick={() => void prepareModel()}
            >
              {service?.ready ? '模型已就绪' : '准备本地模型'}
            </button>
          </div>
        </div>
        <div className={`ui-layer-service-status ${service?.ready ? 'is-ready' : ''}`}>
          <span className="ui-layer-service-dot" />
          <div>
            <strong>
              {service
                ? `${service.device} · ${service.ready ? '可开始拆图' : service.message}`
                : '尚未连接本地服务'}
            </strong>
            <small>
              {service?.error
                ? service.error
                : `首次准备约需下载 ${service?.model_download_gb ?? 53.8}GB 模型文件。`}
            </small>
          </div>
        </div>
      </section>

      <section className="panel upload-panel">
        <div className="panel-head">
          <h2>2. 上传游戏 UI 图片</h2>
          <span>支持 PNG、JPG、WebP，单张不超过 50MB</span>
        </div>
        <input
          ref={inputRef}
          hidden
          accept="image/png,image/jpeg,image/webp"
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void updateSourceFile(file);
            }
            event.currentTarget.value = '';
          }}
        />
        <div className={`upload-layout ${sourceUrl ? 'upload-layout--with-preview' : ''}`}>
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
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) {
                void updateSourceFile(file);
              }
            }}
          >
            <span className="dropzone-kicker">拖放图片到这里</span>
            <strong>或点击选择游戏 UI 效果图</strong>
            <small>建议使用生成后的原始尺寸图片，不要先压缩。</small>
          </button>
          {sourceUrl ? (
            <div className="ui-layer-source-preview">
              <img alt="待拆分游戏 UI" src={sourceUrl} />
              <div>
                <strong>{sourceFile?.name}</strong>
                <span>{sourceSize.width} × {sourceSize.height}</span>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {sourceFile ? (
        <section className="panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>3. 设置拆图方式</h2>
              <span>忠实模式保留原像素；智能补全会生成被遮挡区域。</span>
            </div>
          </div>
          <div className="ui-layer-mode-grid">
            <label className={`option-card ui-layer-choice ${mode === 'faithful' ? 'is-selected' : ''}`}>
              <input
                checked={mode === 'faithful'}
                name="ui-layer-mode"
                type="radio"
                onChange={() => setMode('faithful')}
              />
              <strong>忠实拆图</strong>
              <span>使用 AI 图层的透明区域，颜色和纹理取自原图。</span>
            </label>
            <label className={`option-card ui-layer-choice ${mode === 'complete' ? 'is-selected' : ''}`}>
              <input
                checked={mode === 'complete'}
                name="ui-layer-mode"
                type="radio"
                onChange={() => setMode('complete')}
              />
              <strong>智能补全</strong>
              <span>直接使用 AI 生成的 RGBA 图层，尝试补齐遮挡内容。</span>
            </label>
          </div>
          <div className="ui-layer-settings-grid">
            <label className="field">
              <span>图层数量</span>
              <select
                value={layerChoice}
                onChange={(event) => setLayerChoice(event.target.value as 'auto' | 'manual')}
              >
                <option value="auto">自动判断</option>
                <option value="manual">手动设置</option>
              </select>
            </label>
            {layerChoice === 'manual' ? (
              <label className="field">
                <span>生成层数</span>
                <input
                  max={8}
                  min={3}
                  type="number"
                  value={manualLayers}
                  onChange={(event) => setManualLayers(Math.min(8, Math.max(3, Number(event.target.value))))}
                />
              </label>
            ) : null}
            <label className="field">
              <span>质量</span>
              <select
                value={quality}
                onChange={(event) => setQuality(event.target.value as LayerQuality)}
              >
                <option value="fast">快速 · 640</option>
                <option value="high">高质量 · 1024</option>
              </select>
            </label>
          </div>
          <button
            className="primary-button ui-layer-run-button"
            disabled={!service?.ready || isWorking}
            type="button"
            onClick={() => void handleDecompose()}
          >
            {isWorking ? '本地 AI 正在拆图，请保持页面开启……' : '开始 UI 拆图'}
          </button>
        </section>
      ) : null}

      {layers.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>4. 检查和编辑图层</h2>
            <span>{layers.length} 个图层 · 选中图层后可擦除或恢复透明区域</span>
          </div>
          <div className="ui-layer-editor">
            <aside className="ui-layer-list">
              <div className="ui-layer-list-head">
                <strong>图层</strong>
                <span>上方覆盖下方</span>
              </div>
              {[...layers].reverse().map((layer) => (
                <div
                  className={`ui-layer-list-item ${selectedLayerId === layer.id ? 'is-selected' : ''}`}
                  key={layer.id}
                >
                  <input
                    aria-label={`显示${layer.name}`}
                    checked={layer.visible}
                    type="checkbox"
                    onChange={(event) => updateLayer(layer.id, { visible: event.target.checked })}
                  />
                  <button type="button" onClick={() => setSelectedLayerId(layer.id)}>
                    {layer.name}
                  </button>
                </div>
              ))}
            </aside>

            <div className="ui-layer-canvas-column">
              <div className="ui-layer-toolbar">
                <button
                  className={`ghost-button ${brushMode === 'off' ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setBrushMode('off')}
                >
                  查看/移动
                </button>
                <button
                  className={`ghost-button ${brushMode === 'erase' ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setBrushMode('erase')}
                >
                  橡皮擦
                </button>
                <button
                  className={`ghost-button ${brushMode === 'restore' ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setBrushMode('restore')}
                >
                  恢复画笔
                </button>
                <label>
                  <span>笔刷 {brushSize}px</span>
                  <input
                    max={160}
                    min={4}
                    type="range"
                    value={brushSize}
                    onChange={(event) => setBrushSize(Number(event.target.value))}
                  />
                </label>
                <button
                  className="ghost-button"
                  disabled={!undoStackRef.current.length}
                  type="button"
                  onClick={() => restoreSnapshot(undoStackRef, redoStackRef)}
                >
                  撤销
                </button>
                <button
                  className="ghost-button"
                  disabled={!redoStackRef.current.length}
                  type="button"
                  onClick={() => restoreSnapshot(redoStackRef, undoStackRef)}
                >
                  重做
                </button>
              </div>
              <div className="ui-layer-canvas-wrap checkerboard">
                <canvas
                  ref={previewCanvasRef}
                  className={`ui-layer-canvas ${brushMode !== 'off' ? 'is-painting' : ''}`}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={stopPainting}
                  onPointerCancel={stopPainting}
                />
              </div>
            </div>

            <aside className="ui-layer-properties">
              {selectedLayer ? (
                <>
                  <label className="field">
                    <span>图层名称</span>
                    <input
                      value={selectedLayer.name}
                      onChange={(event) => updateLayer(selectedLayer.id, { name: event.target.value })}
                    />
                  </label>
                  <div className="ui-layer-transform-grid">
                    <label className="field">
                      <span>X</span>
                      <input
                        type="number"
                        value={Math.round(selectedLayer.x)}
                        onChange={(event) => updateLayer(selectedLayer.id, { x: Number(event.target.value) })}
                      />
                    </label>
                    <label className="field">
                      <span>Y</span>
                      <input
                        type="number"
                        value={Math.round(selectedLayer.y)}
                        onChange={(event) => updateLayer(selectedLayer.id, { y: Number(event.target.value) })}
                      />
                    </label>
                    <label className="field">
                      <span>缩放 %</span>
                      <input
                        min={10}
                        type="number"
                        value={Math.round(selectedLayer.scale * 100)}
                        onChange={(event) =>
                          updateLayer(selectedLayer.id, {
                            scale: Math.max(0.1, Number(event.target.value) / 100),
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="ui-layer-property-actions">
                    <button className="ghost-button" type="button" onClick={() => moveLayer(selectedLayer.id, 1)}>
                      上移
                    </button>
                    <button className="ghost-button" type="button" onClick={() => moveLayer(selectedLayer.id, -1)}>
                      下移
                    </button>
                    <button className="ghost-button" type="button" onClick={mergeSelectedDown}>
                      与下层合并
                    </button>
                    <button
                      className="ghost-button"
                      disabled={isWorking}
                      type="button"
                      onClick={() => void splitSelectedLayerAgain()}
                    >
                      继续拆分
                    </button>
                    <button className="ghost-button ui-layer-danger" type="button" onClick={deleteSelectedLayer}>
                      删除图层
                    </button>
                  </div>
                </>
              ) : (
                <p className="ui-layer-empty-copy">请在左侧选择一个图层。</p>
              )}
            </aside>
          </div>
        </section>
      ) : null}

      {layers.length ? (
        <section className="panel ui-layer-export-panel">
          <div>
            <h2>5. 导出透明 PNG ZIP</h2>
            <p>自动裁掉透明空白，拆开不相连区域，并只保留一份重复素材。</p>
          </div>
          <button
            className="primary-button"
            disabled={isExporting || isWorking}
            type="button"
            onClick={() => void exportPngZip()}
          >
            {isExporting ? '正在生成 ZIP……' : '下载多个 PNG 的 ZIP'}
          </button>
        </section>
      ) : null}

      {error ? <p className="error-text ui-layer-error">{error}</p> : null}
    </>
  );
}

export default UiLayerTool;
