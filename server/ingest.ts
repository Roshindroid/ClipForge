import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { PlatformType } from '../src/types.ts';
import { getSystemCapabilities } from './capabilities.ts';
import { SOURCES_DIR, ensureWorkspace, resolveSafeChildPath } from './storage.ts';

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
    return { parsedUrl, platform: 'youtube' };
  }
  if (host.includes('twitch.tv')) {
    return { parsedUrl, platform: 'twitch' };
  }
  if (host.includes('kick.com')) {
    return { parsedUrl, platform: 'kick' };
  }

  if (/\.(mp4|mov|webm|mkv)(\?.*)?$/i.test(parsedUrl.pathname)) {
    return { parsedUrl, platform: 'direct' };
  }

  const isKnown = ALLOWED_STREAM_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (!isKnown) {
    throw new Error(
      'Unsupported URL host. Use YouTube, Twitch, Kick, or a direct .mp4/.webm/.mov media URL.'
    );
  }

  return { parsedUrl, platform: 'direct' };
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

export async function ingestFromUrl(
  rawUrl: string,
  titleOverride?: string
): Promise<{ fileName: string; title: string; platform: PlatformType }> {
  ensureWorkspace();
  const { parsedUrl, platform } = detectPlatformFromUrl(rawUrl);
  const id = crypto.randomBytes(6).toString('hex');
  const fileName = `src_${id}.mp4`;
  const targetPath = resolveSafeChildPath(SOURCES_DIR, fileName);

  if (platform === 'direct') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(parsedUrl.toString(), { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`Failed to fetch direct media URL (HTTP ${res.status})`);
    }
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > 100 * 1024 * 1024 * 1024) {
      throw new Error('Remote video exceeds the 100 GB local ingest limit.');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(targetPath, buf);
    const derivedTitle =
      titleOverride?.trim() ||
      path.basename(parsedUrl.pathname, path.extname(parsedUrl.pathname)) ||
      `Direct Stream ${id}`;
    return { fileName, title: derivedTitle, platform };
  }

  // Platform link (YouTube / Twitch / Kick): requires yt-dlp locally
  const caps = await getSystemCapabilities();
  if (!caps.ytdlp) {
    throw new Error(
      `yt-dlp is not installed in this runtime to download ${platform.toUpperCase()} URLs. Install yt-dlp locally (pip install yt-dlp) or upload an MP4 file directly.`
    );
  }

  const ytDlpCookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const ytDlpCookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  const ytDlpBaseArgs: string[] = ['--no-playlist'];
  if (ytDlpCookiesFile) {
    ytDlpBaseArgs.push('--cookies', ytDlpCookiesFile);
  } else if (ytDlpCookiesFromBrowser) {
    ytDlpBaseArgs.push('--cookies-from-browser', ytDlpCookiesFromBrowser);
  }

  let fetchedTitle = titleOverride?.trim() || `${platform.toUpperCase()} Stream ${id}`;
  try {
    const meta = await runCommand('yt-dlp', [
      ...ytDlpBaseArgs,
      '--print',
      '%(title)s',
      parsedUrl.toString(),
    ]);
    if (meta.stdout.trim() && !titleOverride?.trim()) {
      fetchedTitle = meta.stdout.trim().slice(0, 120);
    }
  } catch {
    // Keep fallback title if metadata print fails
  }

  await runCommand('yt-dlp', [
    ...ytDlpBaseArgs,
    '-f',
    'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format',
    'mp4',
    '-o',
    targetPath,
    parsedUrl.toString(),
  ]);

  if (!fs.existsSync(targetPath)) {
    throw new Error('yt-dlp finished without writing an MP4 output file.');
  }

  return { fileName, title: fetchedTitle, platform };
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
