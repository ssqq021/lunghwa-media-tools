import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type { ExtractedFrame, SpineDraft, SpineExportOptions } from '../types';
import {
  buildSpineAtlasDescriptor,
  buildSpineBundleZip,
  buildSpineReadme,
  buildSpineSkeletonData,
  buildUnitySpriteManifest,
  getSpineAtlasDescriptorFileName,
  getSpineAtlasFileName,
  getSpineJsonFileName,
  getSpineZipFileName,
  getUnitySpriteManifestFileName,
  type SpineAtlasExport,
} from './spineBundle';

const frames = [{}, {}] as ExtractedFrame[];

const draft: SpineDraft = {
  frames,
  baseName: 'demo clip.mov',
  width: 128,
  height: 128,
  transparent: true,
  sheetOptions: {
    columns: 2,
    gap: 8,
    backgroundColor: '#ffffff',
    frameSize: 64,
  },
  sourceFrameIndices: [0, 2],
  sourceFrameCount: 3,
  attackFrameIndices: [2],
};

const options: SpineExportOptions = {
  skeletonName: 'demo',
  slotName: 'sprite',
  animations: [
    { id: 'idle', name: 'idle', startFrame: 0, endFrame: 0, fps: 12 },
    { id: 'attack', name: 'attack', startFrame: 2, endFrame: 2, fps: 24 },
  ],
};

const atlas: SpineAtlasExport = {
  blob: new Blob(),
  outputWidth: 136,
  outputHeight: 64,
  frameRects: [
    { x: 0, y: 0, width: 64, height: 64 },
    { x: 72, y: 0, width: 64, height: 64 },
  ],
};

describe('spine bundle helpers', () => {
  it('creates flat atlas companion file names', () => {
    expect(getSpineJsonFileName('demo clip.mov')).toBe('demo-clip-spine.json');
    expect(getSpineZipFileName('demo clip.mov')).toBe('demo-clip-spine.zip');
    expect(getSpineAtlasFileName('demo clip.mov')).toBe('demo-clip-spine.png');
    expect(getSpineAtlasDescriptorFileName('demo clip.mov')).toBe('demo-clip-spine.atlas.txt');
    expect(getUnitySpriteManifestFileName('demo clip.mov')).toBe('demo-clip-unity-sprites.json');
  });

  it('maps each action to the exported frames while skipping unused source frames', () => {
    const json = buildSpineSkeletonData(draft, options, atlas);

    expect(json.skeleton.images).toBe('./');
    expect(json.slots[0]?.attachment).toBe('demo-clip-spine-001');
    expect(Object.keys(json.skins[0]?.attachments.sprite ?? {})).toEqual([
      'demo-clip-spine-001',
      'demo-clip-spine-003',
    ]);
    expect(json.animations.idle.slots.sprite.attachment).toEqual([
      { time: 0, name: 'demo-clip-spine-001' },
    ]);
    expect(json.animations.attack.slots.sprite.attachment).toEqual([
      { time: 0, name: 'demo-clip-spine-003' },
    ]);
  });

  it('uses the compact atlas coordinates and records each action frame order for Unity', () => {
    expect(buildSpineAtlasDescriptor(draft, atlas)).toContain('demo-clip-spine-003');
    expect(buildSpineAtlasDescriptor(draft, atlas)).toContain('xy: 72, 0');
    expect(buildUnitySpriteManifest(draft, options, atlas)).toEqual({
      version: 1,
      texture: 'demo-clip-spine.png',
      coordinateOrigin: 'top-left',
      columns: 2,
      gap: 8,
      frames: [
        { name: 'demo-clip-spine-001', sourceFrame: 0, isAttackFrame: false, x: 0, y: 0, width: 64, height: 64 },
        { name: 'demo-clip-spine-003', sourceFrame: 2, isAttackFrame: true, x: 72, y: 0, width: 64, height: 64 },
      ],
      attackFrames: [{ name: 'demo-clip-spine-003', sourceFrame: 2 }],
      animations: [
        { name: 'idle', startFrame: 0, endFrame: 0, loop: true, fps: 12, frames: ['demo-clip-spine-001'] },
        { name: 'attack', startFrame: 2, endFrame: 2, loop: true, fps: 24, frames: ['demo-clip-spine-003'] },
      ],
    });
  });

  it('builds a readme that states unused frames were removed', () => {
    const readme = buildSpineReadme(draft, options);

    expect(readme).toContain('Spine / Unity 图集动画导出说明');
    expect(readme).toContain('demo-clip-spine.png');
    expect(readme).toContain('frames: 2 / 3（已省略未使用帧）');
    expect(readme).toContain('idle: 1-1 帧 · 12 FPS（循环预览）');
  });

  it('rejects duplicate action names before exporting', () => {
    expect(() => buildSpineSkeletonData(draft, {
      ...options,
      animations: [
        { id: 'first', name: 'idle', startFrame: 0, endFrame: 0, fps: 12 },
        { id: 'second', name: 'idle', startFrame: 2, endFrame: 2, fps: 12 },
      ],
    }, atlas)).toThrow('重复');
  });

  it('packages every export file at the ZIP root', async () => {
    const archive = await buildSpineBundleZip(draft, options, atlas);
    const zip = await JSZip.loadAsync(archive);

    expect(Object.keys(zip.files).sort()).toEqual([
      'README.txt',
      'demo-clip-spine.atlas.txt',
      'demo-clip-spine.json',
      'demo-clip-spine.png',
      'demo-clip-unity-sprites.json',
    ]);

    const skeleton = JSON.parse(await zip.file('demo-clip-spine.json')!.async('string'));
    const atlasDescriptor = await zip.file('demo-clip-spine.atlas.txt')!.async('string');
    const attachments = skeleton.skins[0].attachments.sprite;
    const attachmentNames = new Set(Object.keys(attachments));

    expect(skeleton.skeleton.spine).toBe('4.2.0');
    expect(atlasDescriptor.split('\n')[0]).toBe('demo-clip-spine.png');
    expect(attachmentNames).toEqual(new Set([
      'demo-clip-spine-001',
      'demo-clip-spine-003',
    ]));
    for (const attachmentName of attachmentNames) {
      expect(atlasDescriptor.split('\n')).toContain(attachmentName);
      expect(attachments[attachmentName].path).toBe(attachmentName);
    }
    for (const animation of Object.values(skeleton.animations) as Array<{
      slots: { sprite: { attachment: Array<{ name: string }> } };
    }>) {
      for (const key of animation.slots.sprite.attachment) {
        expect(attachmentNames.has(key.name)).toBe(true);
      }
    }
  });
});
