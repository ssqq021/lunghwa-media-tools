import JSZip from 'jszip';
import type { RenderResult, SpineAnimationClip, SpineDraft, SpineExportOptions } from '../types';
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
  animations: Array<{
    name: string;
    startFrame: number;
    endFrame: number;
    loop: boolean;
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

function getClipRange(clip: SpineAnimationClip, frameCount: number): { startFrame: number; endFrame: number } {
  const startFrame = Math.min(Math.max(clip.startFrame, 0), Math.max(frameCount - 1, 0));
  const endFrame = Math.min(Math.max(clip.endFrame, startFrame), Math.max(frameCount - 1, 0));
  return { startFrame, endFrame };
}

function validateAnimationClips(clips: SpineAnimationClip[]): void {
  if (!clips.length) {
    throw new Error('请至少保留一个动作分段。');
  }

  const names = new Set<string>();
  for (const clip of clips) {
    const name = clip.name.trim();
    if (!name) {
      throw new Error('每个动作分段都需要名称。');
    }
    if (names.has(name)) {
      throw new Error(`动作名称“${name}”重复，请修改后再导出。`);
    }
    names.add(name);
  }
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
    `- slot: ${options.slotName}`,
    `- fps: ${options.fps}`,
    `- frames: ${draft.frames.length}`,
    `- columns: ${draft.sheetOptions.columns}`,
    `- gap: ${draft.sheetOptions.gap}`,
    `- transparent: ${draft.transparent ? 'yes' : 'no'}`,
    '',
    '动作分段：',
    ...options.animations.map((clip) => {
      const range = getClipRange(clip, draft.frames.length);
      return `- ${clip.name}: ${range.startFrame + 1}-${range.endFrame + 1} 帧${clip.loop ? '（循环）' : ''}`;
    }),
  ].join('\n');
}

export function buildSpineSkeletonData(
  draft: SpineDraft,
  options: SpineExportOptions,
  atlas: SpineAtlasExport,
): SpineSkeletonJson {
  validateAnimationClips(options.animations);
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

  const defaultAnimation = options.animations[0];
  const defaultFrame = defaultAnimation ? getClipRange(defaultAnimation, draft.frames.length).startFrame : 0;
  const animations = Object.fromEntries(options.animations.map((clip) => {
    const { startFrame, endFrame } = getClipRange(clip, draft.frames.length);
    return [
      clip.name.trim(),
      {
        slots: {
          [options.slotName]: {
            attachment: Array.from({ length: endFrame - startFrame + 1 }, (_, offset) => {
              const frameIndex = startFrame + offset;
              return {
                time: Number((offset / Math.max(options.fps, 1)).toFixed(6)),
                name: getSpineFrameStem(draft.baseName, frameIndex),
              };
            }),
          },
        },
      },
    ];
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
        attachment: getSpineFrameStem(draft.baseName, defaultFrame),
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
    animations,
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
  validateAnimationClips(options.animations);
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
    animations: options.animations.map((clip) => ({
      name: clip.name.trim(),
      ...getClipRange(clip, draft.frames.length),
      loop: clip.loop,
    })),
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
  validateAnimationClips(options.animations);

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
