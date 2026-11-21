import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  BrandingConfig,
  FacecamBox,
  LayoutId,
  RenderedClip,
  TemplateId,
  VideoProject,
  ViralMoment,
} from '../src/types.ts';
import { detectNvencSupport } from './capabilities.ts';
import { RENDERS_DIR, SOURCES_DIR, ensureWorkspace, resolveSafeChildPath } from './storage.ts';

const OUT_WIDTH = 720;
const OUT_HEIGHT = 1280;

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function findDrawtextFont(): string {
  const candidates = [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/**
 * Strictly escapes strings passed to FFmpeg drawtext so filtergraph syntax is never broken.
 */
function sanitizeDrawtext(input: string, maxLen = 48): string {
  return input
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^a-zA-Z0-9 _.,!?@#&()+-]/g, '')
    .trim()
    .slice(0, maxLen)
    .replace(/:/g, '\\:');
}

function normalizeHexColor(hex: string): string {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
  return cleaned.length === 6 ? `0x${cleaned}` : '0x0B0D11';
}

function buildLayoutFilterGraph(
  layoutId: LayoutId,
  srcWidth: number,
  srcHeight: number,
  cam: FacecamBox,
  bgHex: string
): { filterSteps: string[]; finalVideoLabel: string } {
  // Clamp normalized facecam coordinates safely inside source dimensions
  const camX = even(Math.max(0, Math.min(0.85, cam.x)) * srcWidth);
  const camY = even(Math.max(0, Math.min(0.85, cam.y)) * srcHeight);
  const camW = even(Math.max(0.08, Math.min(1 - camX / srcWidth, cam.width)) * srcWidth);
  const camH = even(Math.max(0.08, Math.min(1 - camY / srcHeight, cam.height)) * srcHeight);

  const bgColor = normalizeHexColor(bgHex);
  const steps: string[] = [];

  if (layoutId === 'center-crop-focus') {
    steps.push(
      `[0:v]scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUT_WIDTH}:${OUT_HEIGHT},setsar=1[vbase]`
    );
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  if (layoutId === 'facecam-only-zoom') {
    steps.push(
      `[0:v]crop=${camW}:${camH}:${camX}:${camY},scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUT_WIDTH}:${OUT_HEIGHT},setsar=1[vbase]`
    );
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  if (layoutId === 'split-top-cam' || layoutId === 'split-bottom-cam' || layoutId === 'split-50-50') {
    const camBandH = layoutId === 'split-50-50' ? even(OUT_HEIGHT * 0.5) : even(OUT_HEIGHT * 0.35);
    const mainBandH = OUT_HEIGHT - camBandH;

    steps.push(
      `[0:v]split=2[src_main][src_cam]`,
      `[src_cam]crop=${camW}:${camH}:${camX}:${camY},scale=${OUT_WIDTH}:${camBandH}:force_original_aspect_ratio=increase,crop=${OUT_WIDTH}:${camBandH},setsar=1[cam_pane]`,
      `[src_main]scale=${OUT_WIDTH}:${mainBandH}:force_original_aspect_ratio=increase,crop=${OUT_WIDTH}:${mainBandH},setsar=1[main_pane]`
    );

    if (layoutId === 'split-bottom-cam') {
      steps.push(`[main_pane][cam_pane]vstack=inputs=2[vbase]`);
    } else {
      steps.push(`[cam_pane][main_pane]vstack=inputs=2[vbase]`);
    }
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  if (
    layoutId === 'pip-top-left' ||
    layoutId === 'pip-top-right' ||
    layoutId === 'pip-bottom-left' ||
    layoutId === 'pip-bottom-right'
  ) {
    const pipW = 224;
    const pipH = 224;
    const margin = 28;
    const topMargin = 140;
    const botMargin = 180;

    let overlayExpr = `${margin}:${topMargin}`;
    if (layoutId === 'pip-top-right') overlayExpr = `W-w-${margin}:${topMargin}`;
    if (layoutId === 'pip-bottom-left') overlayExpr = `${margin}:H-h-${botMargin}`;
    if (layoutId === 'pip-bottom-right') overlayExpr = `W-w-${margin}:H-h-${botMargin}`;

    steps.push(
      `[0:v]split=2[src_main][src_cam]`,
      `[src_main]scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUT_WIDTH}:${OUT_HEIGHT},setsar=1[main_full]`,
      `[src_cam]crop=${camW}:${camH}:${camX}:${camY},scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH},drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=white@0.85:t=3,setsar=1[pip_pane]`,
      `[main_full][pip_pane]overlay=${overlayExpr}[vbase]`
    );
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  // blurred-bg-cam-top or blurred-bg-cam-bottom
  const mainFitH = even((OUT_WIDTH * srcHeight) / Math.max(1, srcWidth));
  const camWOut = 280;
  const camHOut = 230;
  const mainY = even((OUT_HEIGHT - mainFitH) / 2);
  const camYOut = layoutId === 'blurred-bg-cam-top' ? 110 : OUT_HEIGHT - camHOut - 130;
  const camXOut = even((OUT_WIDTH - camWOut) / 2);

  steps.push(
    `[0:v]split=3[src_bg][src_main][src_cam]`,
    `[src_bg]scale=${OUT_WIDTH}:${OUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUT_WIDTH}:${OUT_HEIGHT},boxblur=24:4,drawbox=x=0:y=0:w=${OUT_WIDTH}:h=${OUT_HEIGHT}:color=${bgColor}@0.35:t=fill,setsar=1[bg_blur]`,
    `[src_main]scale=${OUT_WIDTH}:${mainFitH},setsar=1[main_fit]`,
    `[src_cam]crop=${camW}:${camH}:${camX}:${camY},scale=${camWOut}:${camHOut}:force_original_aspect_ratio=increase,crop=${camWOut}:${camHOut},drawbox=x=0:y=0:w=${camWOut}:h=${camHOut}:color=white@0.75:t=3,setsar=1[cam_card]`,
    `[bg_blur][main_fit]overlay=0:${mainY}[tmp_bg_main]`,
    `[tmp_bg_main][cam_card]overlay=${camXOut}:${camYOut}[vbase]`
  );
  return { filterSteps: steps, finalVideoLabel: 'vbase' };
}

function buildTemplateAndBrandingFilters(
  inLabel: string,
  templateId: TemplateId,
  hookTagline: string,
  branding: BrandingConfig
): { filterSteps: string[]; finalVideoLabel: string } {
  const fontFile = findDrawtextFont();
  const fontOpt = fontFile ? `fontfile=${fontFile}:` : '';
  const steps: string[] = [];
  let current = inLabel;

  // Note: Only optional layout header templates (X post / TikTok hook / Breaking News) and credit watermark.
  // NEVER burned captions or word-by-word subtitles!
  if (templateId === 'x-post' && fontFile) {
    const headline = sanitizeDrawtext(hookTagline || 'Clip highlight', 44);
    const handle = sanitizeDrawtext(branding.creditText || '@creator', 26);
    steps.push(
      `[${current}]drawbox=x=36:y=36:w=${OUT_WIDTH - 72}:h=112:color=0x0F1117@0.92:t=fill,drawbox=x=36:y=36:w=${OUT_WIDTH - 72}:h=112:color=0x2A303E@1:t=2,drawtext=${fontOpt}text='${handle}':fontcolor=0x9CA3AF:fontsize=20:x=60:y=56,drawtext=${fontOpt}text='${headline}':fontcolor=white:fontsize=24:x=60:y=92[vtmpl]`
    );
    current = 'vtmpl';
  } else if (templateId === 'tiktok-hook' && fontFile) {
    const headline = sanitizeDrawtext(hookTagline || 'Watch till the end', 40);
    steps.push(
      `[${current}]drawbox=x=48:y=54:w=${OUT_WIDTH - 96}:h=74:color=white@0.96:t=fill,drawtext=${fontOpt}text='${headline}':fontcolor=0x0B0D11:fontsize=26:x=(w-text_w)/2:y=78[vtmpl]`
    );
    current = 'vtmpl';
  } else if (templateId === 'breaking-news' && fontFile) {
    const headline = sanitizeDrawtext(hookTagline || 'BREAKING CLIP', 40);
    steps.push(
      `[${current}]drawbox=x=0:y=${OUT_HEIGHT - 165}:w=${OUT_WIDTH}:h=44:color=0xE11D48@0.96:t=fill,drawbox=x=0:y=${OUT_HEIGHT - 121}:w=${OUT_WIDTH}:h=72:color=0x0B0D11@0.94:t=fill,drawtext=${fontOpt}text='LIVE CLIP':fontcolor=white:fontsize=22:x=28:y=${OUT_HEIGHT - 154},drawtext=${fontOpt}text='${headline}':fontcolor=white:fontsize=26:x=28:y=${OUT_HEIGHT - 98}[vtmpl]`
    );
    current = 'vtmpl';
  }

  const credit = sanitizeDrawtext(branding.watermarkText || branding.creditText || '', 32);
  if (credit && fontFile) {
    steps.push(
      `[${current}]drawtext=${fontOpt}text='${credit}':fontcolor=white@0.72:fontsize=20:x=w-text_w-26:y=h-46[vbrand]`
    );
    current = 'vbrand';
  }

  return { filterSteps: steps, finalVideoLabel: current };
}

export async function renderVerticalClip(params: {
  project: VideoProject;
  moment: ViralMoment;
  layoutId: LayoutId;
  templateId: TemplateId;
  facecamBox: FacecamBox;
  branding: BrandingConfig;
  titleOverride?: string;
  hookTaglineOverride?: string;
  descriptionOverride?: string;
  hashtagsOverride?: string[];
}): Promise<RenderedClip> {
  ensureWorkspace();
  const srcPath = resolveSafeChildPath(SOURCES_DIR, params.project.fileName);
  if (!fs.existsSync(srcPath)) {
    throw new Error('Source video file is missing from workspace.');
  }

  const clipId = `clip_${crypto.randomBytes(5).toString('hex')}`;
  const outputFileName = `${clipId}.mp4`;
  const outPath = resolveSafeChildPath(RENDERS_DIR, outputFileName);

  const clipDuration = Math.max(2, Math.min(60, params.moment.endSec - params.moment.startSec));
  const hookTagline = params.hookTaglineOverride?.trim() || params.moment.hookTagline;

  const layoutGraph = buildLayoutFilterGraph(
    params.layoutId,
    params.project.width,
    params.project.height,
    params.facecamBox,
    params.branding.backgroundHex
  );

  const overlayGraph = buildTemplateAndBrandingFilters(
    layoutGraph.finalVideoLabel,
    params.templateId,
    hookTagline,
    params.branding
  );

  const allFilters = [...layoutGraph.filterSteps, ...overlayGraph.filterSteps];
  const finalVideoLabel = overlayGraph.finalVideoLabel;

  const args: string[] = [
    '-y',
    '-ss',
    params.moment.startSec.toFixed(2),
    '-t',
    clipDuration.toFixed(2),
    '-i',
    srcPath,
    '-filter_complex',
    allFilters.join(';'),
    '-map',
    `[${finalVideoLabel}]`,
  ];

  if (params.project.hasAudio) {
    args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }

  const useNvenc = await detectNvencSupport();
  const encoderUsed: 'h264_nvenc' | 'libx264' = useNvenc ? 'h264_nvenc' : 'libx264';

  if (useNvenc) {
    args.push(
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p4',
      '-rc',
      'vbr',
      '-cq',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath
    );
  } else {
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outPath
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outPath)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg render failed (code ${code}): ${stderr.slice(-400)}`));
      }
    });
  });

  const stat = fs.statSync(outPath);

  return {
    id: clipId,
    projectId: params.project.id,
    momentId: params.moment.id,
    title: params.titleOverride?.trim() || params.moment.title,
    hookTagline,
    description: params.descriptionOverride?.trim() || params.moment.description,
    hashtags: params.hashtagsOverride?.length ? params.hashtagsOverride : params.moment.hashtags,
    layoutId: params.layoutId,
    templateId: params.templateId,
    facecamBox: params.facecamBox,
    branding: params.branding,
    burnedCaptions: false,
    encoderUsed,
    outputFileName,
    downloadUrl: `/api/renders/${outputFileName}`,
    durationSec: Math.round(clipDuration * 10) / 10,
    resolution: `${OUT_WIDTH}x${OUT_HEIGHT}`,
    fileSizeBytes: stat.size,
    createdAt: new Date().toISOString(),
    youtubeStatus: 'ready',
  };
}
