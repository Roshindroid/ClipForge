import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { HeatmapPoint, PlatformType, VideoChapter } from '../src/types.ts';
import { SOURCES_DIR, ensureWorkspace, resolveSafeChildPath } from './storage.ts';
import {
  ensureYtDlp,
  fetchMetadataWithYtDlp,
  getYtDlpBaseArgs,
  resolveStreamUrlsWithYtDlp,
  runProcessWithTimeout,
  type ResolvedStreamUrls,
} from './ytdlp.ts';

const execFileAsync = promisify(execFile);

const LOCAL_DOWNLOAD_MAX_DURATION_SEC = 420; // <= 7 min downloads locally; > 7 min (up to 50+ hours) streams on-demand
const LOCAL_DOWNLOAD_MAX_BYTES = 450 * 1024 * 1024; // 450 MB cap for eager local download

const ALLOWED_STREAM_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'twitch.tv',
  'www.twitch.tv',
  'clips.twitch.tv',
  'kick.com',
  'www.kick.com',
];

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return true;
  }

  if (net.isIPv4(lower)) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
  }

  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      return true;
    }
  }

  return false;
}

export function detectPlatformFromUrl(rawUrl: string): {
  parsedUrl: URL;
  platform: PlatformType;
  isDirectMediaExt: boolean;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format. Provide a full https:// link.');
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    throw new Error('Localhost and private network URLs are blocked for security.');
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host.includes('youtube.com') || host === 'youtu.be') {
    return { parsedUrl, platform: 'youtube', isDirectMediaExt: false };
  }
  if (host.includes('twitch.tv')) {
    return { parsedUrl, platform: 'twitch', isDirectMediaExt: false };
  }
  if (host.includes('kick.com')) {
    return { parsedUrl, platform: 'kick', isDirectMediaExt: false };
  }

  const isDirectMediaExt = /\.(mp4|mov|webm|mkv|m3u8|mpd)(\?.*)?$/i.test(parsedUrl.pathname);
  if (isDirectMediaExt) {
    return { parsedUrl, platform: 'direct', isDirectMediaExt: true };
  }

  const isKnown = ALLOWED_STREAM_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (isKnown) {
    return { parsedUrl, platform: 'direct', isDirectMediaExt: false };
  }

  // Allow probing any public HTTPS video/CDN link (validated via HEAD/ffprobe in ingestFromUrl)
  return { parsedUrl, platform: 'direct', isDirectMediaExt: false };
}

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
      }
    });
  });
}

async function probeRemoteMediaUrl(url: string): Promise<{
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', url],
    { timeout: 25000 }
  );
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const videoStream = info.streams?.find((s) => s.codec_type === 'video');
  const audioStream = info.streams?.find((s) => s.codec_type === 'audio');
  if (!videoStream) {
    throw new Error('URL does not contain a readable video stream.');
  }
  let fps = 30;
  if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) fps = Math.round((num / den) * 100) / 100;
  }
  return {
    durationSec: Math.max(1, Number(info.format?.duration || 15)),
    width: videoStream.width || 1280,
    height: videoStream.height || 720,
    fps,
    hasAudio: Boolean(audioStream),
  };
}

async function streamDirectMediaToFile(url: string, targetPath: string): Promise<void> {
  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), 45000);
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), 45000);
  };

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch direct media URL (HTTP ${res.status})`);
    }
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > LOCAL_DOWNLOAD_MAX_BYTES) {
      throw new Error('Remote video exceeds local eager-download cap; switching to remote-stream mode.');
    }

    const bodyStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
    bodyStream.on('data', resetStall);
    await pipeline(bodyStream, fs.createWriteStream(targetPath));
  } finally {
    clearTimeout(stallTimer);
  }
}

export interface IngestResult {
  fileName: string;
  title: string;
  platform: PlatformType;
  sourceMode: 'local' | 'remote-stream';
  streamUrls?: ResolvedStreamUrls;
  preProbed?: {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
  };
  chapters?: VideoChapter[];
  heatmap?: HeatmapPoint[];
}

export async function ingestFromUrl(
  rawUrl: string,
  titleOverride?: string,
  onProgress?: (pct: number, stage: string, detail?: string) => void
): Promise<IngestResult> {
  ensureWorkspace();
  const { parsedUrl, platform, isDirectMediaExt } = detectPlatformFromUrl(rawUrl);
  const id = crypto.randomBytes(6).toString('hex');
  const fileName = `src_${id}.mp4`;
  const targetPath = resolveSafeChildPath(SOURCES_DIR, fileName);

  if (platform === 'direct') {
    onProgress?.(6, 'Probing remote video URL...', parsedUrl.hostname);

    let contentLength = 0;
    let contentType = '';
    try {
      const headCtrl = new AbortController();
      const headTimer = setTimeout(() => headCtrl.abort(), 10000);
      const headRes = await fetch(parsedUrl.toString(), {
        method: 'HEAD',
        signal: headCtrl.signal,
        redirect: 'follow',
      });
      clearTimeout(headTimer);
      contentLength = Number(headRes.headers.get('content-length') || 0);
      contentType = (headRes.headers.get('content-type') || '').toLowerCase();
    } catch {
      // Some CDNs block HEAD requests; fall through to ffprobe
    }

    const isHlsOrDash = /\.(m3u8|mpd)(\?.*)?$/i.test(parsedUrl.pathname) || contentType.includes('mpegurl');
    if (
      !isDirectMediaExt &&
      contentType &&
      !contentType.startsWith('video/') &&
      !contentType.includes('octet-stream') &&
      !contentType.includes('mpegurl') &&
      !contentType.includes('mp4')
    ) {
      // Try yt-dlp as fallback if user pasted a generic video page URL
      try {
        onProgress?.(10, 'Checking extractor compatibility...', parsedUrl.hostname);
        const meta = await fetchMetadataWithYtDlp(parsedUrl.toString(), 'direct');
        const streamUrls = meta.streamUrls || (await resolveStreamUrlsWithYtDlp(parsedUrl.toString()));
        return {
          fileName: `remote_${id}.mp4`,
          title: titleOverride?.trim() || meta.title,
          platform: 'direct',
          sourceMode: 'remote-stream',
          streamUrls,
          preProbed: {
            durationSec: meta.durationSec,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            hasAudio: meta.hasAudio,
          },
          chapters: meta.chapters,
          heatmap: meta.heatmap,
        };
      } catch {
        throw new Error(
          'Unsupported URL host or non-video link. Use YouTube, Twitch, Kick, or a direct .mp4/.webm/.mov/.m3u8 media URL.'
        );
      }
    }

    let probed;
    try {
      probed = await probeRemoteMediaUrl(parsedUrl.toString());
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Could not read remote media stream: ${err.message}`
          : 'Could not read remote media stream.'
      );
    }

    const derivedTitle =
      titleOverride?.trim() ||
      path.basename(parsedUrl.pathname, path.extname(parsedUrl.pathname)) ||
      `Direct Stream ${id}`;

    // Long direct videos (including 50-hour MP4/HLS streams) stay in remote-stream mode — zero multi-GB download!
    if (
      isHlsOrDash ||
      probed.durationSec > LOCAL_DOWNLOAD_MAX_DURATION_SEC ||
      contentLength > LOCAL_DOWNLOAD_MAX_BYTES
    ) {
      onProgress?.(
        18,
        'Remote stream indexed (zero full-VOD download)',
        `${Math.round(probed.durationSec / 60)} min · ${probed.width}x${probed.height}`
      );
      return {
        fileName: `remote_${id}.mp4`,
        title: derivedTitle.slice(0, 120),
        platform: 'direct',
        sourceMode: 'remote-stream',
        streamUrls: {
          videoUrl: parsedUrl.toString(),
          audioUrl: parsedUrl.toString(),
          isSeparate: false,
          resolvedAt: Date.now(),
        },
        preProbed: probed,
      };
    }

    onProgress?.(12, 'Downloading short media file...', derivedTitle);
    await streamDirectMediaToFile(parsedUrl.toString(), targetPath);
    return {
      fileName,
      title: derivedTitle.slice(0, 120),
      platform,
      sourceMode: 'local',
      preProbed: probed,
    };
  }

  // Platform link (YouTube / Twitch / Kick): auto-bootstrap yt-dlp if missing
  onProgress?.(6, 'Preparing stream extractor (yt-dlp)...', platform.toUpperCase());
  const bin = await ensureYtDlp();

  onProgress?.(12, `Fetching ${platform.toUpperCase()} metadata & heatmaps...`);
  const meta = await fetchMetadataWithYtDlp(parsedUrl.toString(), platform);
  const resolvedTitle = titleOverride?.trim() || meta.title;

  // For videos > 7 min (including 10-hour or 50-hour VODs), stream directly on demand!
  if (meta.durationSec > LOCAL_DOWNLOAD_MAX_DURATION_SEC || meta.isLive) {
    onProgress?.(
      20,
      'Long-form stream ready for remote scanning',
      `${(meta.durationSec / 3600).toFixed(1)}h · ${meta.width}x${meta.height}`
    );
    const streamUrls = meta.streamUrls || (await resolveStreamUrlsWithYtDlp(parsedUrl.toString()));
    return {
      fileName: `remote_${id}.mp4`,
      title: resolvedTitle.slice(0, 120),
      platform,
      sourceMode: 'remote-stream',
      streamUrls,
      preProbed: {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        hasAudio: meta.hasAudio,
      },
      chapters: meta.chapters,
      heatmap: meta.heatmap,
    };
  }

  // Short platform clip (<= 7 min): download locally for instant scrubbing, fallback to remote-stream if download fails
  onProgress?.(16, `Downloading ${platform.toUpperCase()} clip locally...`, resolvedTitle);
  try {
    const baseArgs = getYtDlpBaseArgs();
    await runProcessWithTimeout(
      bin,
      [
        ...baseArgs,
        '-f',
        'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b',
        '--merge-output-format',
        'mp4',
        '-o',
        targetPath,
        parsedUrl.toString(),
      ],
      180000
    );

    if (fs.existsSync(targetPath)) {
      return {
        fileName,
        title: resolvedTitle.slice(0, 120),
        platform,
        sourceMode: 'local',
      };
    }
  } catch {
    if (fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        // ignore
      }
    }
  }

  // Fallback to remote-stream mode if eager local download failed
  const streamUrls = meta.streamUrls || (await resolveStreamUrlsWithYtDlp(parsedUrl.toString()));
  return {
    fileName: `remote_${id}.mp4`,
    title: resolvedTitle.slice(0, 120),
    platform,
    sourceMode: 'remote-stream',
    streamUrls,
    preProbed: {
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
    },
    chapters: meta.chapters,
    heatmap: meta.heatmap,
  };
}

/**
 * Generates a real 18-second 1280x720 MP4 using FFmpeg with animated gameplay motion,
 * a distinct corner facecam overlay box, and multi-peak reaction audio spikes so the
 * full FFmpeg analysis, facecam detection, and 11-layout 9:16 render pipeline can be tested locally.
 */
export async function generateSampleStreamVideo(): Promise<{
  fileName: string;
  title: string;
  platform: PlatformType;
}> {
  ensureWorkspace();
  const id = crypto.randomBytes(4).toString('hex');
  const fileName = `sample_stream_${id}.mp4`;
  const targetPath = resolveSafeChildPath(SOURCES_DIR, fileName);

  // Create a 1280x720 gameplay background + distinct 300x200 bottom-right facecam feed
  // Audio has baseline commentary plus loud reaction spikes at ~3.5s, ~9.5s, ~14.5s
  const filterComplex = [
    'testsrc2=size=1280x720:rate=30:duration=18[bg]',
    'mandelbrot=size=320x210:rate=30:maxiter=40,trim=duration=18,setpts=PTS-STARTPTS,drawbox=x=0:y=0:w=320:h=210:color=0xE11D48@0.9:t=4[cam]',
    '[bg][cam]overlay=x=W-w-28:y=H-h-28:shortest=1[vout]',
    "sine=frequency=220:sample_rate=44100:duration=18,volume='if(between(t,2.5,5.5),0.85,if(between(t,8.5,11.8),0.95,if(between(t,13.8,16.8),0.88,0.14)))':eval=frame[a1]",
    "anoisesrc=color=pink:amplitude=0.18:sample_rate=44100:duration=18,volume='if(between(t,8.5,11.8),0.9,0.22)':eval=frame[a2]",
    '[a1][a2]amix=inputs=2:duration=first[aout]',
  ].join(';');

  await runCommand('ffmpeg', [
    '-y',
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    targetPath,
  ]);

  return {
    fileName,
    title: 'Sample Ranked Stream Highlight (16:9 + Bottom-Right Cam)',
    platform: 'local',
  };
}
