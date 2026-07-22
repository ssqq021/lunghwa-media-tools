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

const frames = [{}, {}, {}] as ExtractedFrame[];

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
};

const options: SpineExportOptions = {
  skeletonName: 'demo',
  animationName: 'idle',
  slotName: 'sprite',
  fps: 12,
};

const atlas: SpineAtlasExport = {
  blob: new Blob(),
  outputWidth: 136,
  outputHeight: 136,
  frameRects: [
    { x: 0, y: 0, width: 64, height: 64 },
    { x: 72, y: 0, width: 64, height: 64 },
    { x: 0, y: 72, width: 64, height: 64 },
  ],
};

describe('spine bundle helpers', () => {
  it('creates one atlas PNG and its companion file names', () => {
    expect(getSpineJsonFileName('demo clip.mov')).toBe('demo-clip-spine.json');
    expect(getSpineZipFileName('demo clip.mov')).toBe('demo-clip-spine.zip');
    expect(getSpineAtlasFileName('demo clip.mov')).toBe('images/demo-clip-spine.png');
    expect(getSpineAtlasDescriptorFileName('demo clip.mov')).toBe('images/demo-clip-spine.atlas.txt');
    expect(getUnitySpriteManifestFileName('demo clip.mov')).toBe('demo-clip-unity-sprites.json');
  });

  it('maps every skeleton attachment to a region in the single atlas', () => {
    const json = buildSpineSkeletonData(draft, options, atlas);

    expect(json.skeleton.name).toBe('demo');
    expect(json.bones).toEqual([{ name: 'root' }]);
    expect(json.slots).toEqual([
      {
        name: 'sprite',
        bone: 'root',
        attachment: 'demo-clip-spine-001',
      },
    ]);
    expect(json.skins[0]?.attachments.sprite['demo-clip-spine-001']).toEqual({
      type: 'region',
      path: 'demo-clip-spine-001',
      x: 0,
      y: 0,
      width: 64,
      height: 64,
    });
    expect(json.animations.idle.slots.sprite.attachment).toEqual([
      {
        time: 0.083333,
        name: 'demo-clip-spine-002',
      },
      {
        time: 0.166667,
        name: 'demo-clip-spine-003',
      },
    ]);
  });

  it('uses the step 7 layout for the Spine atlas and Unity manifest', () => {
    expect(buildSpineAtlasDescriptor(draft, atlas)).toContain('xy: 72, 0');
    expect(buildSpineAtlasDescriptor(draft, atlas)).toContain('size: 136, 136');
    expect(buildUnitySpriteManifest(draft, options, atlas)).toEqual({
      version: 1,
      texture: 'images/demo-clip-spine.png',
      coordinateOrigin: 'top-left',
      columns: 2,
      gap: 8,
      fps: 12,
      frames: [
        { name: 'demo-clip-spine-001', x: 0, y: 0, width: 64, height: 64, time: 0 },
        { name: 'demo-clip-spine-002', x: 72, y: 0, width: 64, height: 64, time: 0.083333 },
        { name: 'demo-clip-spine-003', x: 0, y: 72, width: 64, height: 64, time: 0.166667 },
      ],
    });
  });

  it('builds a readme with the atlas and Unity import hints', () => {
    const readme = buildSpineReadme(draft, options);

    expect(readme).toContain('Spine / Unity 图集动画导出说明');
    expect(readme).toContain('demo-clip-spine.json');
    expect(readme).toContain('demo-clip-spine.png');
    expect(readme).toContain('demo-clip-unity-sprites.json');
    expect(readme).toContain('fps: 12');
    expect(readme).toContain('transparent: yes');
  });

  it('packages one atlas PNG instead of individual frame PNGs', async () => {
    const archive = await buildSpineBundleZip(draft, options, atlas);
    const zip = await JSZip.loadAsync(archive);

    expect(Object.keys(zip.files).sort()).toEqual([
      'README.txt',
      'demo-clip-spine.json',
      'demo-clip-unity-sprites.json',
      'images/',
      'images/demo-clip-spine.atlas.txt',
      'images/demo-clip-spine.png',
    ]);
  });
});
