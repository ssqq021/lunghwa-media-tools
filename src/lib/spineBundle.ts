import JSZip from 'jszip';
import type { RenderResult, SpineDraft, SpineExportOptions } from '../types';
import { getBaseFileName } from './exportBundle';

export type SpineAtlasExport = Pick<RenderResult, 'blob' | 'outputWidth' | 'outputHeight' | 'frameRects'>;

type SpineAttachment = {
  type: 'region';
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SpineSkeletonJson = {
  skeleton: {
    name: string;
    spine: string;
    images: string;
  };
  bones: Array<{
    name: string;
  }>;
  slots: Array<{
    name: string;
    bone: string;
    attachment: string;
  }>;
  skins: Array<{
    name: 'default';
    attachments: Record<string, Record<string, SpineAttachment>>;
  }>;
  animations: Record<
    string,
    {
      slots: Record<
        string,
        {
          attachment: Array<{
            time: number;
            name: string;
          }>;
        }
      >;
    }
  >;
};

type UnitySpriteManifest = {
  version: 1;
  texture: string;
  coordinateOrigin: 'top-left';
  columns: number;
  gap: number;
  fps: number;
  frames: Array<{
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    time: number;
  }>;
};

export function getSpineJsonFileName(baseName: string): string {
  return `${getBaseFileName(baseName)}-spine.json`;
}

export function getSpineZipFileName(baseName: string): string {
  return `${getBaseFileName(baseName)}-spine.zip`;
}

export function getSpineFrameStem(baseName: string, index: number): string {
  const frameNumber = String(index + 1).padStart(3, '0');
  return `${getBaseFileName(baseName)}-spine-${frameNumber}`;
}

export function getSpineAtlasFileName(baseName: string): string {
  return `images/${getBaseFileName(baseName)}-spine.png`;
}

export function getSpineAtlasDescriptorFileName(baseName: string): string {
  return `images/${getBaseFileName(baseName)}-spine.atlas.txt`;
}

export function getUnitySpriteManifestFileName(baseName: string): string {
  return `${getBaseFileName(baseName)}-unity-sprites.json`;
}

function getFrameRect(atlas: SpineAtlasExport, index: number): RenderResult['frameRects'][number] {
  const rect = atlas.frameRects[index];
  if (!rect) {
    throw new Error('图集帧坐标不完整，请重新生成 Spine 图集。');
  }
  return rect;
}

export function buildSpineReadme(draft: SpineDraft, options: SpineExportOptions): string {
  return [
    'Spine / Unity 图集动画导出说明',
    '',
    '此 ZIP 包含：',
    `- ${getSpineJsonFileName(draft.baseName)}（Spine 骨骼与逐帧动画）`,
    `- ${getSpineAtlasFileName(draft.baseName)}（单张图集 PNG）`,
    `- ${getSpineAtlasDescriptorFileName(draft.baseName)}（Spine 图集描述）`,
    `- ${getUnitySpriteManifestFileName(draft.baseName)}（Unity 切片坐标与帧时间）`,
    '',
    'Spine：保持 JSON、PNG 和 atlas.txt 的相对目录不变后导入。',
    'Unity：将 PNG 作为一张 Sprite Sheet 使用；unity-sprites.json 的坐标原点为左上角，记录了每帧矩形与播放时间。',
    '',
    '当前导出参数：',
    `- skeleton: ${options.skeletonName}`,
    `- animation: ${options.animationName}`,
    `- slot: ${options.slotName}`,
    `- fps: ${options.fps}`,
    `- frames: ${draft.frames.length}`,
    `- columns: ${draft.sheetOptions.columns}`,
    `- gap: ${draft.sheetOptions.gap}`,
    `- transparent: ${draft.transparent ? 'yes' : 'no'}`,
  ].join('\n');
}

export function buildSpineSkeletonData(
  draft: SpineDraft,
  options: SpineExportOptions,
  atlas: SpineAtlasExport,
): SpineSkeletonJson {
  const attachmentEntries = Object.fromEntries(
    draft.frames.map((_, index) => {
      const attachmentName = getSpineFrameStem(draft.baseName, index);
      const rect = getFrameRect(atlas, index);
      return [
        attachmentName,
        {
          type: 'region' as const,
          path: attachmentName,
          x: 0,
          y: 0,
          width: rect.width,
          height: rect.height,
        },
      ];
    }),
  );

  const attachmentTimeline = draft.frames.slice(1).map((_, index) => ({
    time: Number(((index + 1) / Math.max(options.fps, 1)).toFixed(6)),
    name: getSpineFrameStem(draft.baseName, index + 1),
  }));

  return {
    skeleton: {
      name: options.skeletonName,
      spine: '4.2.0',
      images: './images/',
    },
    bones: [
      {
        name: 'root',
      },
    ],
    slots: [
      {
        name: options.slotName,
        bone: 'root',
        attachment: getSpineFrameStem(draft.baseName, 0),
      },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          [options.slotName]: attachmentEntries,
        },
      },
    ],
    animations: {
      [options.animationName]: {
        slots: {
          [options.slotName]: {
            attachment: attachmentTimeline,
          },
        },
      },
    },
  };
}

export function buildSpineAtlasDescriptor(
  draft: SpineDraft,
  atlas: SpineAtlasExport,
): string {
  const imageFileName = getSpineAtlasFileName(draft.baseName).replace('images/', '');
  const regions = draft.frames.flatMap((_, index) => {
    const rect = getFrameRect(atlas, index);
    return [
      '',
      getSpineFrameStem(draft.baseName, index),
      '  rotate: false',
      `  xy: ${rect.x}, ${rect.y}`,
      `  size: ${rect.width}, ${rect.height}`,
      `  orig: ${rect.width}, ${rect.height}`,
      '  offset: 0, 0',
      '  index: -1',
    ];
  });

  return [
    imageFileName,
    `size: ${atlas.outputWidth}, ${atlas.outputHeight}`,
    'format: RGBA8888',
    'filter: Linear, Linear',
    'repeat: none',
    ...regions,
    '',
  ].join('\n');
}

export function buildUnitySpriteManifest(
  draft: SpineDraft,
  options: SpineExportOptions,
  atlas: SpineAtlasExport,
): UnitySpriteManifest {
  return {
    version: 1,
    texture: getSpineAtlasFileName(draft.baseName),
    coordinateOrigin: 'top-left',
    columns: draft.sheetOptions.columns,
    gap: draft.sheetOptions.gap,
    fps: options.fps,
    frames: draft.frames.map((_, index) => {
      const rect = getFrameRect(atlas, index);
      return {
        name: getSpineFrameStem(draft.baseName, index),
        ...rect,
        time: Number((index / Math.max(options.fps, 1)).toFixed(6)),
      };
    }),
  };
}

export async function buildSpineBundleZip(
  draft: SpineDraft,
  options: SpineExportOptions,
  atlas: SpineAtlasExport,
): Promise<Blob> {
  if (atlas.frameRects.length !== draft.frames.length) {
    throw new Error('图集帧数与动画帧数不一致，请重新生成后再导出。');
  }

  const zip = new JSZip();
  zip.file(getSpineJsonFileName(draft.baseName), JSON.stringify(buildSpineSkeletonData(draft, options, atlas), null, 2));
  zip.file(getSpineAtlasFileName(draft.baseName), atlas.blob);
  zip.file(getSpineAtlasDescriptorFileName(draft.baseName), buildSpineAtlasDescriptor(draft, atlas));
  zip.file(getUnitySpriteManifestFileName(draft.baseName), JSON.stringify(buildUnitySpriteManifest(draft, options, atlas), null, 2));
  zip.file('README.txt', buildSpineReadme(draft, options));

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
