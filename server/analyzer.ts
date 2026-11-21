import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type {
  AudioEnergyPoint,
  FacecamBox,
  PlatformType,
  RankingWeights,
  VideoProject,
  ViralMoment,
} from '../src/types.ts';
import { scoreMomentsWithRouter } from './llmRouter.ts';
import { FRAMES_DIR, SOURCES_DIR, ensureWorkspace, resolveSafeChildPath } from './storage.ts';
import { computeFinalRankScore } from './weights.ts';

const execFileAsync = promisify(execFile);

interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeout: 15000 }
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
  filePath: string,
  projectId: string,
  durationSec: number
): Promise<string[]> {
  ensureWorkspace();
  const fractions = [0.15, 0.4, 0.65, 0.85];
  const frameUrls: string[] = [];

  for (let i = 0; i < fractions.length; i++) {
    const ts = Math.max(0.2, Math.min(durationSec - 0.2, durationSec * fractions[i]));
    const frameFile = `${projectId}_frame_${i}.jpg`;
    const outPath = resolveSafeChildPath(FRAMES_DIR, frameFile);
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          ts.toFixed(2),
          '-i',
          filePath,
          '-vframes',
          '1',
          '-q:v',
          '3',
          '-vf',
          'scale=960:-2',
          outPath,
        ],
        { timeout: 12000 }
      );
      if (fs.existsSync(outPath)) {
        frameUrls.push(`/api/frames/${frameFile}`);
      }
    } catch {
      // Skip frame if seeking near EOF fails
    }
  }

  return frameUrls;
}

export async function analyzeAudioEnergy(
  filePath: string,
  durationSec: number,
  hasAudio: boolean
): Promise<AudioEnergyPoint[]> {
  const totalSecs = Math.max(1, Math.ceil(durationSec));
  if (!hasAudio) {
    return Array.from({ length: totalSecs }, (_, sec) => ({
      sec,
      db: -42,
      normalized: 0.2,
    }));
  }

  const sampleRate = 8000;
  const pcmBuffer = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(
      'ffmpeg',
      ['-i', filePath, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', 'pipe:1'],
      { shell: false }
    );
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(Buffer.alloc(0)));
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });

  if (pcmBuffer.length < 4) {
    return Array.from({ length: totalSecs }, (_, sec) => ({
      sec,
      db: -42,
      normalized: 0.2,
    }));
  }

  const bytesPerSec = sampleRate * 2;
  const rawPoints: Array<{ sec: number; db: number }> = [];

  for (let sec = 0; sec < totalSecs; sec++) {
    const startByte = sec * bytesPerSec;
    const endByte = Math.min(pcmBuffer.length, startByte + bytesPerSec);
    if (startByte >= endByte) break;

    let sumSq = 0;
    let count = 0;
    for (let offset = startByte; offset + 1 < endByte; offset += 2) {
      const sample = pcmBuffer.readInt16LE(offset) / 32768;
      sumSq += sample * sample;
      count++;
    }
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0.0001;
    const db = Math.max(-60, Math.min(0, Math.round(20 * Math.log10(Math.max(rms, 1e-4)) * 10) / 10));
    rawPoints.push({ sec, db });
  }

  if (rawPoints.length === 0) {
    return [{ sec: 0, db: -40, normalized: 0.2 }];
  }

  const minDb = Math.min(...rawPoints.map((p) => p.db));
  const maxDb = Math.max(...rawPoints.map((p) => p.db));
  const span = Math.max(4, maxDb - minDb);

  return rawPoints.map((p) => ({
    sec: p.sec,
    db: p.db,
    normalized: Math.round(((p.db - minDb) / span) * 100) / 100,
  }));
}

/**
 * Probes corner regions of the 16:9 frame via FFmpeg signalstats to estimate where
 * a persistent streamer facecam box sits (comparing saturation/luma variance across regions).
 */
export async function detectFacecamCandidates(
  filePath: string,
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
    { presetLabel: 'Bottom-Right Cam', x: 0.72, y: 0.65, width: 0.25, height: 0.30 },
    { presetLabel: 'Bottom-Left Cam', x: 0.03, y: 0.65, width: 0.25, height: 0.30 },
    { presetLabel: 'Top-Right Cam', x: 0.72, y: 0.05, width: 0.25, height: 0.30 },
    { presetLabel: 'Top-Left Cam', x: 0.03, y: 0.05, width: 0.25, height: 0.30 },
    { presetLabel: 'Left-Edge Strip', x: 0.02, y: 0.26, width: 0.24, height: 0.36 },
  ];

  const probeTime = Math.max(0.5, Math.min(durationSec - 0.5, durationSec * 0.45));
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
          '-ss',
          probeTime.toFixed(2),
          '-i',
          filePath,
          '-vframes',
          '3',
          '-vf',
          `crop=${cw}:${ch}:${cx}:${cy},signalstats,metadata=print`,
          '-f',
          'null',
          '-',
        ],
        { timeout: 8000 }
      );
      const satMatches = [...stderr.matchAll(/SATAVG=(\d+(\.\d+)?)/g)].map((m) => Number(m[1]));
      const ydifMatches = [...stderr.matchAll(/YDIF=(\d+(\.\d+)?)/g)].map((m) => Number(m[1]));
      const avgSat = satMatches.length
        ? satMatches.reduce((a, b) => a + b, 0) / satMatches.length
        : 20;
      const avgYdif = ydifMatches.length
        ? ydifMatches.reduce((a, b) => a + b, 0) / ydifMatches.length
        : 3;

      // Balanced saturation + moderate temporal motion characterizes a live webcam box
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

  // Detect SRT / VTT timestamps (00:00:12,500 --> 00:00:18,000)
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

  // Plain text fallback: distribute sentences evenly across duration
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

function scoreTranscriptWindow(cues: ParsedTranscriptCue[], startSec: number, endSec: number): {
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
  transcriptText?: string
): Promise<ViralMoment[]> {
  const cues = parseTranscriptInput(transcriptText, durationSec);

  // Choose clip window length tailored to video duration (ideal 15-42s for Shorts, or 4-6s for short test videos)
  const targetClipDur = durationSec <= 25 ? Math.max(4, Math.min(7, durationSec * 0.35)) : Math.min(38, Math.max(18, durationSec * 0.25));

  // Compute mean & stddev of audio energy to find genuine dB spike windows
  const dbs = audioEnergy.map((p) => p.db);
  const meanDb = dbs.reduce((a, b) => a + b, 0) / Math.max(1, dbs.length);
  const variance =
    dbs.reduce((acc, v) => acc + Math.pow(v - meanDb, 2), 0) / Math.max(1, dbs.length);
  const stdDb = Math.max(1.5, Math.sqrt(variance));

  // Slide window across the energy series in 1-second steps
  const windows: Array<{
    startSec: number;
    endSec: number;
    peakDb: number;
    audioSpikeScore: number;
  }> = [];

  const winLen = Math.max(3, Math.round(targetClipDur));
  const maxStart = Math.max(0, Math.floor(durationSec - winLen));

  for (let start = 0; start <= maxStart; start++) {
    const end = Math.min(durationSec, start + winLen);
    const slice = audioEnergy.filter((p) => p.sec >= start && p.sec <= end);
    if (slice.length === 0) continue;

    const peakDb = Math.max(...slice.map((p) => p.db));
    const avgNorm = slice.reduce((a, b) => a + b.normalized, 0) / slice.length;
    const zScore = (peakDb - meanDb) / stdDb;
    const spikeScore = Math.min(0.99, Math.max(0.25, 0.45 + zScore * 0.22 + avgNorm * 0.25));

    windows.push({
      startSec: start,
      endSec: Math.round(end * 10) / 10,
      peakDb,
      audioSpikeScore: Math.round(spikeScore * 100) / 100,
    });
  }

  if (windows.length === 0) {
    windows.push({
      startSec: 0,
      endSec: Math.min(durationSec, 15),
      peakDb: meanDb,
      audioSpikeScore: 0.65,
    });
  }

  // Greedy non-overlapping top-K selection (up to 4 distinct viral moments)
  windows.sort((a, b) => b.audioSpikeScore - a.audioSpikeScore);
  const picked: typeof windows = [];
  const minSeparation = Math.max(2, winLen * 0.65);

  for (const win of windows) {
    const overlaps = picked.some(
      (p) => Math.abs(p.startSec - win.startSec) < minSeparation
    );
    if (!overlaps) {
      picked.push(win);
      if (picked.length >= 4) break;
    }
  }

  picked.sort((a, b) => a.startSec - b.startSec);

  const enrichedCandidates = picked.map((win) => {
    const tInfo = scoreTranscriptWindow(cues, win.startSec, win.endSec);
    return {
      ...win,
      transcriptScore: tInfo.score,
      transcriptSnippet: tInfo.snippet,
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
    const defaultTitles = [
      `Wait for the reaction at ${formatMMSS(c.startSec)}`,
      `Unfiltered peak moment — ${cleanProjectTitle}`,
      `Highest audio surge (${c.peakDb} dB)`,
      `Clutch sequence from ${cleanProjectTitle}`,
    ];
    const defaultTaglines = [
      `Peak energy spike at ${formatMMSS(c.startSec)} — watch the facecam reaction.`,
      `The exact second the room lost it in ${cleanProjectTitle}.`,
      `Zero context needed for this ${Math.round(duration)}s stream highlight.`,
      `Replay-worthy moment extracted from ${cleanProjectTitle}.`,
    ];

    const title = llmOut?.title || defaultTitles[idx % defaultTitles.length];
    const hookTagline = llmOut?.hookTagline || defaultTaglines[idx % defaultTaglines.length];
    const description =
      llmOut?.description ||
      `${hookTagline}\n\nClipped from "${cleanProjectTitle}" (${formatMMSS(c.startSec)} – ${formatMMSS(c.endSec)}). YouTube auto-captions enabled.`;
    const hashtags = llmOut?.hashtags || ['#shorts', '#gaming', '#streamclips', '#highlights'];
    const reason =
      llmOut?.reason ||
      `Audio spike ${c.peakDb} dB${c.transcriptSnippet ? ' + transcript hook match' : ' + local ranking weights'}`;
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
  sourceUrl?: string;
  transcriptText?: string;
  weights: RankingWeights;
}): Promise<VideoProject> {
  const filePath = resolveSafeChildPath(SOURCES_DIR, params.fileName);
  const sourceSizeBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const probe = await probeVideo(filePath);
  const projectId = `prj_${crypto.randomBytes(5).toString('hex')}`;

  const [previewFrames, audioEnergySeries, facecamInfo] = await Promise.all([
    extractPreviewFrames(filePath, projectId, probe.durationSec),
    analyzeAudioEnergy(filePath, probe.durationSec, probe.hasAudio),
    detectFacecamCandidates(filePath, probe.width, probe.height, probe.durationSec),
  ]);

  const moments = await findViralMoments(
    params.title,
    probe.durationSec,
    audioEnergySeries,
    params.weights,
    params.transcriptText
  );

  return {
    id: projectId,
    title: params.title,
    sourceType: params.sourceType,
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
    audioEnergySeries,
    detectedFacecam: facecamInfo.detected,
    facecamCandidates: facecamInfo.candidates,
    moments,
    transcriptText: params.transcriptText,
    createdAt: new Date().toISOString(),
  };
}

function formatMMSS(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
