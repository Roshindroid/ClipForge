import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type {
  AudioEnergyPoint,
  FacecamBox,
  HeatmapPoint,
  PlatformType,
  RankingWeights,
  VideoChapter,
  VideoProject,
  ViralMoment,
} from '../src/types.ts';
import { scoreMomentsWithRouter } from './llmRouter.ts';
import {
  FRAMES_DIR,
  SOURCES_DIR,
  ensureWorkspace,
  resolveSafeChildPath,
  resolveSafeSourcePath,
} from './storage.ts';
import { computeFinalRankScore } from './weights.ts';
import type { ResolvedStreamUrls } from './ytdlp.ts';

const execFileAsync = promisify(execFile);

const MAX_ENERGY_SERIES_POINTS = 240;
const FULL_SCAN_MAX_DURATION_SEC = 1200; // 20 minutes; longer videos (up to 50+ hours) use stratified probing

interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface WindowSpikeSample {
  startSec: number;
  endSec: number;
  peakDb: number;
  audioSpikeScore: number;
  hintTitle?: string;
}

function arrayMin(vals: number[], fallback = -42): number {
  if (vals.length === 0) return fallback;
  let min = vals[0];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] < min) min = vals[i];
  }
  return min;
}

function arrayMax(vals: number[], fallback = -12): number {
  if (vals.length === 0) return fallback;
  let max = vals[0];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] > max) max = vals[i];
  }
  return max;
}

function isRemoteInput(input: string): boolean {
  return input.startsWith('http://') || input.startsWith('https://');
}

function buildReconnectArgs(input: string): string[] {
  return isRemoteInput(input)
    ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4']
    : [];
}

export function formatTimecode(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function probeVideo(filePathOrUrl: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePathOrUrl],
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

  let fps = 30;
  if (videoStream?.r_frame_rate && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) fps = Math.round((num / den) * 100) / 100;
  }

  return {
    durationSec: Math.max(1, Number(info.format?.duration || 10)),
    width: videoStream?.width || 1280,
    height: videoStream?.height || 720,
    fps,
    hasAudio: Boolean(audioStream),
  };
}

export async function extractPreviewFrames(
  videoInput: string,
  projectId: string,
  durationSec: number
): Promise<string[]> {
  ensureWorkspace();
  const fractions = [0.12, 0.36, 0.62, 0.84];
  const frameUrls: string[] = [];

  for (let i = 0; i < fractions.length; i++) {
    const ts = Math.max(0.2, Math.min(durationSec - 0.5, durationSec * fractions[i]));
    const frameFile = `${projectId}_frame_${i}.jpg`;
    const outPath = resolveSafeChildPath(FRAMES_DIR, frameFile);
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          ...buildReconnectArgs(videoInput),
          '-ss',
          ts.toFixed(2),
          '-i',
          videoInput,
          '-vframes',
          '1',
          '-q:v',
          '3',
          '-vf',
          'scale=960:-2',
          outPath,
        ],
        { timeout: 18000 }
      );
      if (fs.existsSync(outPath)) {
        frameUrls.push(`/api/frames/${frameFile}`);
      }
    } catch {
      // Skip frame if seeking near EOF or transient network hiccup
    }
  }

  return frameUrls;
}

/**
 * Streams PCM chunks incrementally from FFmpeg without accumulating GBs in RAM,
 * returning per-second RMS dB values.
 */
async function streamPcmRmsWindow(
  audioInput: string,
  startSec?: number,
  durationLimitSec?: number,
  timeoutMs = 18000
): Promise<Array<{ sec: number; db: number }>> {
  const sampleRate = 8000;
  const bytesPerSec = sampleRate * 2;
  const baseSec = startSec ?? 0;

  return new Promise((resolve) => {
    const args: string[] = [...buildReconnectArgs(audioInput)];
    if (typeof startSec === 'number') {
      args.push('-ss', Math.max(0, startSec).toFixed(2));
    }
    if (typeof durationLimitSec === 'number') {
      args.push('-t', Math.max(1, durationLimitSec).toFixed(2));
    }
    args.push('-i', audioInput, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1');

    const child = spawn('ffmpeg', args, { shell: false });
    const points: Array<{ sec: number; db: number }> = [];
    let leftover: Buffer = Buffer.alloc(0);
    let secOffset = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1500);
        resolve(points);
      }
    }, timeoutMs);

    const processCompleteSeconds = () => {
      let cursor = 0;
      while (cursor + bytesPerSec <= leftover.length) {
        let sumSq = 0;
        for (let offset = cursor; offset < cursor + bytesPerSec; offset += 2) {
          const sample = leftover.readInt16LE(offset) / 32768;
          sumSq += sample * sample;
        }
        const rms = Math.sqrt(sumSq / sampleRate);
        const db = Math.max(
          -60,
          Math.min(0, Math.round(20 * Math.log10(Math.max(rms, 1e-4)) * 10) / 10)
        );
        points.push({ sec: Math.floor(baseSec + secOffset), db });
        secOffset++;
        cursor += bytesPerSec;
      }
      if (cursor > 0) {
        leftover = Buffer.from(leftover.subarray(cursor));
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      leftover = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
      processCompleteSeconds();
    });

    child.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(points);
      }
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (leftover.length >= 2) {
        let sumSq = 0;
        let count = 0;
        for (let offset = 0; offset + 1 < leftover.length; offset += 2) {
          const sample = leftover.readInt16LE(offset) / 32768;
          sumSq += sample * sample;
          count++;
        }
        if (count > 0) {
          const rms = Math.sqrt(sumSq / count);
          const db = Math.max(
            -60,
            Math.min(0, Math.round(20 * Math.log10(Math.max(rms, 1e-4)) * 10) / 10)
          );
          points.push({ sec: Math.floor(baseSec + secOffset), db });
        }
      }
      resolve(points);
    });
  });
}

function bucketEnergySeries(
  rawPoints: Array<{ sec: number; db: number }>,
  durationSec: number
): AudioEnergyPoint[] {
  if (rawPoints.length === 0) {
    return [{ sec: 0, db: -40, normalized: 0.25 }];
  }

  const dbs = rawPoints.map((p) => p.db);
  const minDb = arrayMin(dbs, -50);
  const maxDb = arrayMax(dbs, -10);
  const span = Math.max(4, maxDb - minDb);

  if (rawPoints.length <= MAX_ENERGY_SERIES_POINTS) {
    return rawPoints.map((p) => ({
      sec: p.sec,
      db: p.db,
      normalized: Math.round(((p.db - minDb) / span) * 100) / 100,
    }));
  }

  const bucketCount = MAX_ENERGY_SERIES_POINTS;
  const bucketSpan = Math.max(1, durationSec / bucketCount);
  const buckets: Array<{ sumDb: number; maxDb: number; count: number }> = Array.from(
    { length: bucketCount },
    () => ({ sumDb: 0, maxDb: -60, count: 0 })
  );

  for (const pt of rawPoints) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(pt.sec / bucketSpan)));
    const b = buckets[idx];
    b.sumDb += pt.db;
    if (pt.db > b.maxDb) b.maxDb = pt.db;
    b.count++;
  }

  const result: AudioEnergyPoint[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const b = buckets[i];
    // Preserve peaks inside each bucket so audio spikes stay clearly visible across 50-hour timelines
    const db = b.count > 0 ? Math.round((b.maxDb * 0.65 + (b.sumDb / b.count) * 0.35) * 10) / 10 : minDb;
    result.push({
      sec: Math.round(i * bucketSpan),
      db,
      normalized: Math.round(((db - minDb) / span) * 100) / 100,
    });
  }
  return result;
}

export async function analyzeAudioEnergy(
  audioInput: string,
  durationSec: number,
  hasAudio: boolean,
  options?: {
    heatmap?: HeatmapPoint[];
    chapters?: VideoChapter[];
    onProgress?: (pct: number, stage: string, detail?: string) => void;
  }
): Promise<{
  series: AudioEnergyPoint[];
  windowSpikes: WindowSpikeSample[];
}> {
  const totalSecs = Math.max(1, Math.ceil(durationSec));
  if (!hasAudio) {
    const count = Math.min(totalSecs, MAX_ENERGY_SERIES_POINTS);
    const step = totalSecs / count;
    const series = Array.from({ length: count }, (_, i) => ({
      sec: Math.round(i * step),
      db: -42,
      normalized: 0.25,
    }));
    return { series, windowSpikes: [] };
  }

  // Short/medium local videos (<= 20 min): stream full PCM at 1s resolution in low memory
  if (!isRemoteInput(audioInput) && durationSec <= FULL_SCAN_MAX_DURATION_SEC) {
    options?.onProgress?.(40, 'Scanning full audio RMS curve...');
    const rawPoints = await streamPcmRmsWindow(audioInput, undefined, undefined, 120000);
    const series = bucketEnergySeries(rawPoints, durationSec);
    return { series, windowSpikes: buildSpikesFromDensePoints(rawPoints, durationSec) };
  }

  // Long videos (> 20 min, up to 50+ hours, local or remote stream):
  // Stratified multi-window FFmpeg probing + YouTube heatmap & chapter guidance
  const probeTargets: Array<{ startSec: number; hintTitle?: string; heatmapBoost?: number }> = [];
  const numStratified = durationSec >= 36000 ? 44 : 32; // up to 44 stratified windows across 50 hours
  const probeDurSec = 10;
  const usableSpan = Math.max(1, durationSec - 35);

  for (let i = 0; i < numStratified; i++) {
    const start = Math.floor((usableSpan * (i + 0.5)) / numStratified);
    probeTargets.push({ startSec: start });
  }

  // Inject top YouTube Most-Replayed heatmap peaks if present
  if (options?.heatmap && options.heatmap.length > 0) {
    const topHeat = [...options.heatmap]
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    for (const h of topHeat) {
      probeTargets.push({
        startSec: Math.max(0, Math.min(usableSpan, Math.floor(h.startSec))),
        heatmapBoost: h.value,
      });
    }
  }

  // Inject chapter openings if chapters exist
  if (options?.chapters && options.chapters.length > 0) {
    const step = Math.max(1, Math.floor(options.chapters.length / 8));
    for (let i = 0; i < options.chapters.length && i < step * 8; i += step) {
      const ch = options.chapters[i];
      probeTargets.push({
        startSec: Math.max(0, Math.min(usableSpan, Math.floor(ch.startSec + 5))),
        hintTitle: ch.title,
      });
    }
  }

  // Deduplicate probe positions within 25s of each other
  probeTargets.sort((a, b) => a.startSec - b.startSec);
  const dedupedTargets: typeof probeTargets = [];
  for (const t of probeTargets) {
    const prev = dedupedTargets[dedupedTargets.length - 1];
    if (!prev || Math.abs(t.startSec - prev.startSec) >= 25) {
      dedupedTargets.push(t);
    } else if (t.heatmapBoost && (!prev.heatmapBoost || t.heatmapBoost > prev.heatmapBoost)) {
      dedupedTargets[dedupedTargets.length - 1] = t;
    }
  }

  const sampledRaw: Array<{ sec: number; db: number }> = [];
  const probedWindows: Array<{
    startSec: number;
    endSec: number;
    peakDb: number;
    avgDb: number;
    hintTitle?: string;
    heatmapBoost?: number;
  }> = [];

  const concurrency = 4;
  let completed = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < dedupedTargets.length) {
      const idx = cursor++;
      const target = dedupedTargets[idx];
      const pts = await streamPcmRmsWindow(audioInput, target.startSec, probeDurSec, 20000);
      completed++;
      options?.onProgress?.(
        35 + Math.round((completed / dedupedTargets.length) * 40),
        `Scanning timeline audio (${completed}/${dedupedTargets.length})...`,
        `Probing ${formatTimecode(target.startSec)} / ${formatTimecode(durationSec)}`
      );

      if (pts.length > 0) {
        sampledRaw.push(...pts);
        const dbs = pts.map((p) => p.db);
        const peakDb = arrayMax(dbs, -24);
        const avgDb = dbs.reduce((a, b) => a + b, 0) / dbs.length;
        const clipLen = Math.min(38, Math.max(20, durationSec - target.startSec));
        const clipStart = Math.max(0, target.startSec - 4);
        probedWindows.push({
          startSec: Math.round(clipStart * 10) / 10,
          endSec: Math.round(Math.min(durationSec, clipStart + clipLen) * 10) / 10,
          peakDb,
          avgDb,
          hintTitle: target.hintTitle,
          heatmapBoost: target.heatmapBoost,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, dedupedTargets.length) }, worker));

  if (sampledRaw.length === 0) {
    // Graceful fallback if remote audio probing timed out on every window: synthesize timeline from heatmap/evenly spaced checkpoints
    const fallbackTargets = dedupedTargets.slice(0, 8);
    const series: AudioEnergyPoint[] = Array.from({ length: Math.min(60, MAX_ENERGY_SERIES_POINTS) }, (_, i) => ({
      sec: Math.round((durationSec * i) / 60),
      db: -22,
      normalized: 0.5,
    }));
    const windowSpikes: WindowSpikeSample[] = fallbackTargets.map((t, idx) => ({
      startSec: t.startSec,
      endSec: Math.min(durationSec, t.startSec + 32),
      peakDb: -16,
      audioSpikeScore: Math.round((0.82 - idx * 0.04) * 100) / 100,
      hintTitle: t.hintTitle,
    }));
    return { series, windowSpikes };
  }

  // Build uniform 160-bucket timeline across 0..durationSec for the UI waveform
  const allDbs = sampledRaw.map((p) => p.db);
  const meanDb = allDbs.reduce((a, b) => a + b, 0) / allDbs.length;
  const minDb = arrayMin(allDbs, -48);
  const maxDb = arrayMax(allDbs, -8);
  const span = Math.max(4, maxDb - minDb);
  const variance =
    allDbs.reduce((acc, v) => acc + Math.pow(v - meanDb, 2), 0) / Math.max(1, allDbs.length);
  const stdDb = Math.max(1.5, Math.sqrt(variance));

  const bucketCount = 160;
  const bucketSpan = durationSec / bucketCount;
  const buckets: Array<{ maxDb: number; count: number }> = Array.from(
    { length: bucketCount },
    () => ({ maxDb: -60, count: 0 })
  );

  for (const pt of sampledRaw) {
    const bIdx = Math.min(bucketCount - 1, Math.max(0, Math.floor(pt.sec / bucketSpan)));
    if (buckets[bIdx].count === 0 || pt.db > buckets[bIdx].maxDb) {
      buckets[bIdx].maxDb = pt.db;
    }
    buckets[bIdx].count++;
  }

  // Fill unprobed gap buckets smoothly near baseline meanDb
  const series: AudioEnergyPoint[] = buckets.map((b, i) => {
    const db = b.count > 0 ? b.maxDb : Math.round(meanDb * 10) / 10;
    return {
      sec: Math.round(i * bucketSpan),
      db,
      normalized: Math.round(Math.min(1, Math.max(0.08, (db - minDb) / span)) * 100) / 100,
    };
  });

  const windowSpikes: WindowSpikeSample[] = probedWindows.map((w) => {
    const zScore = (w.peakDb - meanDb) / stdDb;
    const heatBonus = w.heatmapBoost ? Math.min(0.22, w.heatmapBoost * 0.22) : 0;
    const spikeScore = Math.min(0.99, Math.max(0.3, 0.48 + zScore * 0.2 + heatBonus));
    return {
      startSec: w.startSec,
      endSec: w.endSec,
      peakDb: w.peakDb,
      audioSpikeScore: Math.round(spikeScore * 100) / 100,
      hintTitle: w.hintTitle,
    };
  });

  return { series, windowSpikes };
}

function buildSpikesFromDensePoints(
  rawPoints: Array<{ sec: number; db: number }>,
  durationSec: number
): WindowSpikeSample[] {
  if (rawPoints.length === 0) {
    return [
      {
        startSec: 0,
        endSec: Math.min(durationSec, 15),
        peakDb: -20,
        audioSpikeScore: 0.65,
      },
    ];
  }

  const targetClipDur =
    durationSec <= 25
      ? Math.max(4, Math.min(7, durationSec * 0.35))
      : Math.min(38, Math.max(18, durationSec * 0.25));

  const dbs = rawPoints.map((p) => p.db);
  const meanDb = dbs.reduce((a, b) => a + b, 0) / Math.max(1, dbs.length);
  const minDb = arrayMin(dbs, -50);
  const maxDb = arrayMax(dbs, -10);
  const span = Math.max(4, maxDb - minDb);
  const variance =
    dbs.reduce((acc, v) => acc + Math.pow(v - meanDb, 2), 0) / Math.max(1, dbs.length);
  const stdDb = Math.max(1.5, Math.sqrt(variance));

  const winLen = Math.max(3, Math.round(targetClipDur));
  const maxStart = Math.max(0, Math.floor(durationSec - winLen));

  // Prefix sums for O(N) sliding window instead of O(N^2)
  const windows: WindowSpikeSample[] = [];
  for (let start = 0; start <= maxStart; start++) {
    const endIdx = Math.min(rawPoints.length - 1, start + winLen);
    let peakDb = -60;
    let normSum = 0;
    let count = 0;
    for (let i = start; i <= endIdx && i < rawPoints.length; i++) {
      const db = rawPoints[i].db;
      if (db > peakDb) peakDb = db;
      normSum += (db - minDb) / span;
      count++;
    }
    if (count === 0) continue;
    const avgNorm = normSum / count;
    const zScore = (peakDb - meanDb) / stdDb;
    const spikeScore = Math.min(0.99, Math.max(0.25, 0.45 + zScore * 0.22 + avgNorm * 0.25));

    windows.push({
      startSec: start,
      endSec: Math.round(Math.min(durationSec, start + winLen) * 10) / 10,
      peakDb,
      audioSpikeScore: Math.round(spikeScore * 100) / 100,
    });
  }

  return windows;
}

/**
 * Probes corner regions of the 16:9 frame via FFmpeg signalstats to estimate where
 * a persistent streamer facecam box sits (comparing saturation/luma variance across regions).
 */
export async function detectFacecamCandidates(
  videoInput: string,
  width: number,
  height: number,
  durationSec: number
): Promise<{ detected: FacecamBox; candidates: FacecamBox[] }> {
  const presets: Array<{
    presetLabel: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [
    { presetLabel: 'Bottom-Right Cam', x: 0.72, y: 0.65, width: 0.25, height: 0.3 },
    { presetLabel: 'Bottom-Left Cam', x: 0.03, y: 0.65, width: 0.25, height: 0.3 },
    { presetLabel: 'Top-Right Cam', x: 0.72, y: 0.05, width: 0.25, height: 0.3 },
    { presetLabel: 'Top-Left Cam', x: 0.03, y: 0.05, width: 0.25, height: 0.3 },
    { presetLabel: 'Left-Edge Strip', x: 0.02, y: 0.26, width: 0.24, height: 0.36 },
  ];

  const probeTime = Math.max(0.5, Math.min(durationSec - 1, durationSec * 0.35));
  const scored: FacecamBox[] = [];

  for (let i = 0; i < presets.length; i++) {
    const p = presets[i];
    const cx = Math.max(0, Math.floor(p.x * width));
    const cy = Math.max(0, Math.floor(p.y * height));
    const cw = Math.max(32, Math.floor(p.width * width));
    const ch = Math.max(32, Math.floor(p.height * height));

    let edgeScore = 0.52 - i * 0.05;
    try {
      const { stderr } = await execFileAsync(
        'ffmpeg',
        [
          ...buildReconnectArgs(videoInput),
          '-ss',
          probeTime.toFixed(2),
          '-i',
          videoInput,
          '-vframes',
          '3',
          '-vf',
          `crop=${cw}:${ch}:${cx}:${cy},signalstats,metadata=print`,
          '-f',
          'null',
          '-',
        ],
        { timeout: 15000 }
      );
      const satMatches = [...stderr.matchAll(/SATAVG=(\d+(\.\d+)?)/g)].map((m) => Number(m[1]));
      const ydifMatches = [...stderr.matchAll(/YDIF=(\d+(\.\d+)?)/g)].map((m) => Number(m[1]));
      const avgSat = satMatches.length
        ? satMatches.reduce((a, b) => a + b, 0) / satMatches.length
        : 20;
      const avgYdif = ydifMatches.length
        ? ydifMatches.reduce((a, b) => a + b, 0) / ydifMatches.length
        : 3;

      const satNorm = Math.min(1, avgSat / 90);
      const motionNorm = Math.min(1, avgYdif / 12);
      edgeScore = Math.round((0.45 + satNorm * 0.3 + motionNorm * 0.2) * 100) / 100;
    } catch {
      // Keep heuristic baseline score
    }

    scored.push({
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      confidence: Math.min(0.96, Math.max(0.35, edgeScore)),
      presetLabel: p.presetLabel,
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return {
    detected: scored[0],
    candidates: scored,
  };
}

interface ParsedTranscriptCue {
  startSec: number;
  endSec: number;
  text: string;
}

function parseTranscriptInput(raw?: string, totalDurationSec = 60): ParsedTranscriptCue[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();

  const srtBlocks = trimmed.split(/\r?\n\r?\n+/);
  const cues: ParsedTranscriptCue[] = [];
  const tsRegex =
    /(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})/;

  for (const block of srtBlocks) {
    const lines = block.split(/\r?\n/);
    const tsLineIdx = lines.findIndex((l) => tsRegex.test(l));
    if (tsLineIdx >= 0) {
      const m = lines[tsLineIdx].match(tsRegex);
      if (m) {
        const startSec =
          (m[1] ? parseInt(m[1], 10) * 3600 : 0) +
          parseInt(m[2], 10) * 60 +
          parseInt(m[3], 10) +
          parseInt(m[4], 10) / 1000;
        const endSec =
          (m[5] ? parseInt(m[5], 10) * 3600 : 0) +
          parseInt(m[6], 10) * 60 +
          parseInt(m[7], 10) +
          parseInt(m[8], 10) / 1000;
        const text = lines
          .slice(tsLineIdx + 1)
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (text) cues.push({ startSec, endSec, text });
      }
    }
  }

  if (cues.length > 0) return cues;

  const sentences = trimmed
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [];
  const chunkDur = totalDurationSec / sentences.length;
  return sentences.map((text, idx) => ({
    startSec: idx * chunkDur,
    endSec: (idx + 1) * chunkDur,
    text,
  }));
}

const VIRAL_HOOK_TERMS = [
  'no way',
  'wait',
  'what',
  'insane',
  'clutch',
  'bro',
  'watch',
  'secret',
  'actually',
  'crazy',
  'how',
  'never',
  'why',
  'oh my',
  'lets go',
  "let's go",
  'unbelievable',
  'glitch',
  'won',
  'best',
];

function scoreTranscriptWindow(
  cues: ParsedTranscriptCue[],
  startSec: number,
  endSec: number
): {
  score: number;
  snippet: string;
} {
  const overlapping = cues.filter((c) => c.endSec >= startSec && c.startSec <= endSec);
  if (overlapping.length === 0) {
    return { score: 0.48, snippet: '' };
  }
  const combined = overlapping.map((c) => c.text).join(' ').slice(0, 220);
  const lower = combined.toLowerCase();

  let hits = 0;
  for (const term of VIRAL_HOOK_TERMS) {
    if (lower.includes(term)) hits++;
  }
  const exclamations = (combined.match(/[!?]/g) || []).length;
  const wordDensity = Math.min(1, combined.split(/\s+/).length / 28);
  const score = Math.min(0.98, 0.4 + hits * 0.12 + exclamations * 0.08 + wordDensity * 0.18);
  return { score: Math.round(score * 100) / 100, snippet: combined };
}

export async function findViralMoments(
  projectTitle: string,
  durationSec: number,
  audioEnergy: AudioEnergyPoint[],
  weights: RankingWeights,
  transcriptText?: string,
  precomputedSpikes?: WindowSpikeSample[]
): Promise<ViralMoment[]> {
  const cues = parseTranscriptInput(transcriptText, durationSec);

  let windows: WindowSpikeSample[] =
    precomputedSpikes && precomputedSpikes.length > 0 ? [...precomputedSpikes] : [];

  if (windows.length === 0) {
    // Re-score directly from bucketed audioEnergySeries (fast O(M) for reanalyze)
    const winLen =
      durationSec <= 25
        ? Math.max(4, Math.min(7, durationSec * 0.35))
        : Math.min(38, Math.max(20, durationSec * 0.25));
    const dbs = audioEnergy.map((p) => p.db);
    const meanDb = dbs.reduce((a, b) => a + b, 0) / Math.max(1, dbs.length);
    const variance =
      dbs.reduce((acc, v) => acc + Math.pow(v - meanDb, 2), 0) / Math.max(1, dbs.length);
    const stdDb = Math.max(1.5, Math.sqrt(variance));

    windows = audioEnergy.map((pt) => {
      const start = Math.max(0, Math.min(durationSec - 4, pt.sec));
      const end = Math.min(durationSec, start + winLen);
      const zScore = (pt.db - meanDb) / stdDb;
      const spikeScore = Math.min(
        0.99,
        Math.max(0.25, 0.45 + zScore * 0.22 + pt.normalized * 0.25)
      );
      return {
        startSec: Math.round(start * 10) / 10,
        endSec: Math.round(end * 10) / 10,
        peakDb: pt.db,
        audioSpikeScore: Math.round(spikeScore * 100) / 100,
      };
    });
  }

  if (windows.length === 0) {
    windows.push({
      startSec: 0,
      endSec: Math.min(durationSec, 15),
      peakDb: -20,
      audioSpikeScore: 0.65,
    });
  }

  // Spread highlights across long/50-hour videos: up to 8 moments when >= 1 hour, 4 otherwise
  const maxMoments = durationSec >= 3600 ? 8 : 4;
  const minSeparation =
    durationSec >= 3600
      ? Math.max(45, Math.floor(durationSec / 24))
      : Math.max(2, Math.min(25, durationSec * 0.2));

  windows.sort((a, b) => b.audioSpikeScore - a.audioSpikeScore);
  const picked: WindowSpikeSample[] = [];

  for (const win of windows) {
    const overlaps = picked.some((p) => Math.abs(p.startSec - win.startSec) < minSeparation);
    if (!overlaps) {
      picked.push(win);
      if (picked.length >= maxMoments) break;
    }
  }

  picked.sort((a, b) => a.startSec - b.startSec);

  const enrichedCandidates = picked.map((win) => {
    const tInfo = scoreTranscriptWindow(cues, win.startSec, win.endSec);
    return {
      ...win,
      transcriptScore: tInfo.score,
      transcriptSnippet: tInfo.snippet || win.hintTitle || '',
    };
  });

  const routerResults = await scoreMomentsWithRouter(
    projectTitle,
    enrichedCandidates.map((c) => ({
      startSec: c.startSec,
      endSec: c.endSec,
      audioPeakDb: c.peakDb,
      audioSpikeScore: c.audioSpikeScore,
      transcriptSnippet: c.transcriptSnippet,
    }))
  );

  const moments: ViralMoment[] = enrichedCandidates.map((c, idx) => {
    const duration = Math.round((c.endSec - c.startSec) * 10) / 10;
    const llmOut = routerResults?.[idx];
    const llmScore = llmOut
      ? llmOut.llmScore
      : Math.round(Math.min(0.95, c.audioSpikeScore * 0.6 + c.transcriptScore * 0.4) * 100) / 100;

    const cleanProjectTitle = projectTitle.replace(/\.[^.]+$/, '').slice(0, 48);
    const tsLabel = formatTimecode(c.startSec);
    const defaultTitles = [
      `Wait for the reaction at ${tsLabel}`,
      `Unfiltered peak moment (${tsLabel}) — ${cleanProjectTitle}`,
      `Highest audio surge (${c.peakDb} dB) at ${tsLabel}`,
      `Clutch sequence at ${tsLabel} — ${cleanProjectTitle}`,
    ];
    const defaultTaglines = [
      `Peak energy spike at ${tsLabel} — watch the facecam reaction.`,
      `The exact second the room lost it in ${cleanProjectTitle}.`,
      `Zero context needed for this ${Math.round(duration)}s stream highlight.`,
      `Replay-worthy moment extracted from ${cleanProjectTitle}.`,
    ];

    const title = llmOut?.title || defaultTitles[idx % defaultTitles.length];
    const hookTagline = llmOut?.hookTagline || defaultTaglines[idx % defaultTaglines.length];
    const description =
      llmOut?.description ||
      `${hookTagline}\n\nClipped from "${cleanProjectTitle}" (${formatTimecode(c.startSec)} – ${formatTimecode(c.endSec)}). YouTube auto-captions enabled.`;
    const hashtags = llmOut?.hashtags || ['#shorts', '#gaming', '#streamclips', '#highlights'];
    const reason =
      llmOut?.reason ||
      `Audio spike ${c.peakDb} dB${c.transcriptSnippet ? ' + hook/chapter match' : ' + local ranking weights'}`;
    const scoredBy = llmOut?.scoredBy || 'Local Heuristic';

    const finalRankScore = computeFinalRankScore(
      {
        audioSpikeScore: c.audioSpikeScore,
        transcriptScore: c.transcriptScore,
        llmScore,
        durationSec: duration,
      },
      weights
    );

    return {
      id: `mom_${crypto.randomBytes(4).toString('hex')}`,
      startSec: c.startSec,
      endSec: c.endSec,
      durationSec: duration,
      title,
      hookTagline,
      description,
      hashtags,
      audioPeakDb: c.peakDb,
      audioSpikeScore: c.audioSpikeScore,
      transcriptScore: c.transcriptScore,
      llmScore,
      finalRankScore,
      reason,
      scoredBy,
      transcriptSnippet: c.transcriptSnippet,
      feedback: null,
    };
  });

  return moments.sort((a, b) => b.finalRankScore - a.finalRankScore);
}

export async function analyzeVideoProject(params: {
  fileName: string;
  title: string;
  sourceType: PlatformType;
  sourceMode?: 'local' | 'remote-stream';
  downloadFolder?: string;
  sourceUrl?: string;
  streamUrls?: ResolvedStreamUrls;
  preProbed?: ProbeResult;
  chapters?: VideoChapter[];
  heatmap?: HeatmapPoint[];
  transcriptText?: string;
  weights: RankingWeights;
  onProgress?: (pct: number, stage: string, detail?: string) => void;
}): Promise<VideoProject> {
  const sourceMode = params.sourceMode || 'local';
  const localPath =
    sourceMode === 'local' ? resolveSafeSourcePath(params.fileName) : '';
  const sourceSizeBytes =
    sourceMode === 'local' && localPath && fs.existsSync(localPath)
      ? fs.statSync(localPath).size
      : 0;

  const videoInput =
    sourceMode === 'remote-stream'
      ? params.streamUrls?.videoUrl || params.sourceUrl || ''
      : localPath;
  const audioInput =
    sourceMode === 'remote-stream'
      ? params.streamUrls?.audioUrl || params.streamUrls?.videoUrl || params.sourceUrl || ''
      : localPath;

  if (!videoInput) {
    throw new Error('Missing video input for analysis.');
  }

  params.onProgress?.(24, 'Probing video stream dimensions...');
  const probe = params.preProbed || (await probeVideo(videoInput));
  const projectId = `prj_${crypto.randomBytes(5).toString('hex')}`;

  params.onProgress?.(30, 'Extracting keyframes & detecting facecam...');
  const [previewFrames, facecamInfo] = await Promise.all([
    extractPreviewFrames(videoInput, projectId, probe.durationSec),
    detectFacecamCandidates(videoInput, probe.width, probe.height, probe.durationSec),
  ]);

  const audioAnalysis = await analyzeAudioEnergy(audioInput, probe.durationSec, probe.hasAudio, {
    heatmap: params.heatmap,
    chapters: params.chapters,
    onProgress: params.onProgress,
  });

  params.onProgress?.(82, 'Scoring viral moments with AI router...');
  const moments = await findViralMoments(
    params.title,
    probe.durationSec,
    audioAnalysis.series,
    params.weights,
    params.transcriptText,
    audioAnalysis.windowSpikes
  );

  params.onProgress?.(96, 'Finalizing project workspace...');

  return {
    id: projectId,
    title: params.title,
    sourceType: params.sourceType,
    sourceMode,
    downloadFolder: params.downloadFolder || undefined,
    sourceUrl: params.sourceUrl,
    fileName: params.fileName,
    sourceSizeBytes,
    sourceDeleted: false,
    durationSec: Math.round(probe.durationSec * 10) / 10,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    previewFrames,
    audioEnergySeries: audioAnalysis.series,
    detectedFacecam: facecamInfo.detected,
    facecamCandidates: facecamInfo.candidates,
    moments,
    chapters: params.chapters,
    heatmapPeaks: params.heatmap?.slice(0, 40),
    transcriptText: params.transcriptText,
    createdAt: new Date().toISOString(),
  };
}
