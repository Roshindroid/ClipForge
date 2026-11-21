import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import type {
  BrandingConfig,
  CreatorWatchItem,
  FacecamBox,
  LayoutId,
  TemplateId,
  ViralMoment,
} from './src/types.ts';
import { analyzeVideoProject, findViralMoments } from './server/analyzer.ts';
import { getSystemCapabilities } from './server/capabilities.ts';
import {
  probeCustomLlmHealth,
  startLocalCustomLlm,
  stopLocalCustomLlm,
} from './server/customLlmManager.ts';
import { generateSampleStreamVideo, ingestFromUrl } from './server/ingest.ts';
import {
  clearRouterCooldowns,
  getLLMRouterState,
  setRoutingPriority,
} from './server/llmRouter.ts';
import { renderVerticalClip } from './server/renderer.ts';
import {
  TRAINING_DATASET_PATH,
  getTrainingStats,
  recordTrainingExample,
} from './server/training.ts';
import {
  FRAMES_DIR,
  RENDERS_DIR,
  SOURCES_DIR,
  deleteClip,
  deleteProject,
  ensureWorkspace,
  getClip,
  getProject,
  listClips,
  listProjects,
  listWatchlist,
  loadWeights,
  resolveSafeChildPath,
  saveClip,
  saveProject,
  saveWatchlist,
} from './server/storage.ts';
import {
  applyMomentFeedback,
  computeFinalRankScore,
  resetRankingWeights,
} from './server/weights.ts';

dotenv.config();
ensureWorkspace();

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureWorkspace();
      cb(null, SOURCES_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_VIDEO_EXTS.has(ext) ? ext : '.mp4';
      cb(null, `upload_${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 100 * 1024 * 1024 * 1024, // 100 GB local video limit
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_VIDEO_EXTS.has(ext) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only MP4, MOV, WebM, and MKV video files are supported.'));
    }
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/capabilities', async (_req, res) => {
    try {
      const caps = await getSystemCapabilities();
      res.json(caps);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to probe capabilities' });
    }
  });

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listProjects() });
  });

  app.post('/api/ingest/upload', upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'Please choose a video file to upload.' });
      }
      const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const transcriptText =
        typeof req.body?.transcriptText === 'string' ? req.body.transcriptText : undefined;
      const title =
        rawTitle ||
        path.basename(req.file.originalname, path.extname(req.file.originalname)) ||
        'Uploaded Video';

      const weights = loadWeights();
      const project = await analyzeVideoProject({
        fileName: req.file.filename,
        title: title.slice(0, 120),
        sourceType: 'local',
        transcriptText,
        weights,
      });

      saveProject(project);
      res.status(201).json({ project });
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // ignore
        }
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Upload analysis failed' });
    }
  });

  app.post('/api/ingest/url', async (req, res) => {
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      const titleOverride = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
      const transcriptText =
        typeof req.body?.transcriptText === 'string' ? req.body.transcriptText : undefined;

      if (!rawUrl) {
        return res.status(400).json({ error: 'Video URL is required.' });
      }

      const ingested = await ingestFromUrl(rawUrl, titleOverride);
      const weights = loadWeights();
      const project = await analyzeVideoProject({
        fileName: ingested.fileName,
        title: ingested.title,
        sourceType: ingested.platform,
        sourceUrl: rawUrl,
        transcriptText,
        weights,
      });

      saveProject(project);
      res.status(201).json({ project });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'URL ingest failed' });
    }
  });

  app.post('/api/ingest/sample', async (_req, res) => {
    try {
      const sample = await generateSampleStreamVideo();
      const sampleTranscript = [
        '00:00:00,000 --> 00:00:05,500',
        'Wait look at the corner right now, no way we hold this angle.',
        '',
        '00:00:08,200 --> 00:00:12,500',
        'OH MY GOD WHAT A CLUTCH! Did you actually see that insane flick?!',
        '',
        '00:00:13,500 --> 00:00:17,800',
        'Bro chat is going crazy, clip that right now before it disappears!',
      ].join('\n');

      const weights = loadWeights();
      const project = await analyzeVideoProject({
        fileName: sample.fileName,
        title: sample.title,
        sourceType: sample.platform,
        transcriptText: sampleTranscript,
        weights,
      });

      saveProject(project);
      res.status(201).json({ project });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Sample stream generation failed' });
    }
  });

  app.post('/api/projects/:id/reanalyze', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const transcriptText =
        typeof req.body?.transcriptText === 'string'
          ? req.body.transcriptText
          : project.transcriptText;

      const weights = loadWeights();
      const moments = await findViralMoments(
        project.title,
        project.durationSec,
        project.audioEnergySeries,
        weights,
        transcriptText
      );

      const updated = saveProject({
        ...project,
        transcriptText,
        moments,
      });
      res.json({ project: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Re-analysis failed' });
    }
  });

  app.post('/api/projects/:id/moments', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const startSec = Math.max(0, Number(req.body?.startSec ?? 0));
    const rawEnd = Number(req.body?.endSec ?? startSec + 15);
    const endSec = Math.min(project.durationSec, Math.max(startSec + 2, rawEnd));
    const durationSec = Math.round((endSec - startSec) * 10) / 10;
    const title =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 90)
        : `Manual Clip (${startSec.toFixed(1)}s – ${endSec.toFixed(1)}s)`;

    const slice = project.audioEnergySeries.filter((p) => p.sec >= startSec && p.sec <= endSec);
    const peakDb = slice.length ? Math.max(...slice.map((p) => p.db)) : -18;
    const avgNorm = slice.length
      ? slice.reduce((a, b) => a + b.normalized, 0) / slice.length
      : 0.65;

    const weights = loadWeights();
    const audioSpikeScore = Math.round(Math.min(0.99, Math.max(0.4, avgNorm + 0.15)) * 100) / 100;
    const transcriptScore = 0.72;
    const llmScore = 0.78;
    const finalRankScore = computeFinalRankScore(
      { audioSpikeScore, transcriptScore, llmScore, durationSec },
      weights
    );

    const newMoment: ViralMoment = {
      id: `mom_${crypto.randomBytes(4).toString('hex')}`,
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      durationSec,
      title,
      hookTagline: title,
      description: `Manual live-clipped highlight from ${project.title}.`,
      hashtags: ['#shorts', '#liveclip', '#highlights'],
      audioPeakDb: peakDb,
      audioSpikeScore,
      transcriptScore,
      llmScore,
      finalRankScore,
      reason: 'Manual timeline override / Live clip marker',
      transcriptSnippet: '',
      feedback: null,
    };

    const updated = saveProject({
      ...project,
      moments: [newMoment, ...project.moments],
    });
    res.status(201).json({ project: updated, moment: newMoment });
  });

  app.post('/api/projects/:id/facecam', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const box = req.body?.facecamBox as Partial<FacecamBox> | undefined;
    if (!box || typeof box.x !== 'number' || typeof box.y !== 'number') {
      return res.status(400).json({ error: 'Valid normalized facecamBox coordinates required.' });
    }

    const clamped: FacecamBox = {
      x: Math.max(0, Math.min(0.9, box.x)),
      y: Math.max(0, Math.min(0.9, box.y)),
      width: Math.max(0.08, Math.min(1, Number(box.width || 0.25))),
      height: Math.max(0.08, Math.min(1, Number(box.height || 0.28))),
      confidence: Number(box.confidence ?? 1),
      presetLabel: String(box.presetLabel || 'Custom Region').slice(0, 48),
    };

    const updated = saveProject({ ...project, detectedFacecam: clamped });
    res.json({ project: updated });
  });

  app.post('/api/projects/:id/moments/:momentId/feedback', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const feedback = req.body?.feedback === 'up' || req.body?.feedback === 'down' ? req.body.feedback : null;
    if (!feedback) return res.status(400).json({ error: 'feedback must be "up" or "down"' });

    const targetMoment = project.moments.find((m) => m.id === req.params.momentId);
    if (!targetMoment) return res.status(404).json({ error: 'Moment not found' });

    const weights = applyMomentFeedback(targetMoment, feedback);
    const trainingStats = recordTrainingExample(project.title, targetMoment, feedback);
    const rerankedMoments = project.moments
      .map((m) => ({
        ...m,
        feedback: m.id === targetMoment.id ? feedback : m.feedback,
        finalRankScore: computeFinalRankScore(m, weights),
      }))
      .sort((a, b) => b.finalRankScore - a.finalRankScore);

    const updated = saveProject({ ...project, moments: rerankedMoments });
    res.json({ project: updated, weights, trainingStats });
  });

  app.post('/api/projects/:id/cleanup-source', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    try {
      const srcPath = resolveSafeChildPath(SOURCES_DIR, project.fileName);
      if (fs.existsSync(srcPath)) {
        fs.unlinkSync(srcPath);
      }
    } catch {
      return res.status(400).json({ error: 'Could not clean up source file safely.' });
    }

    const updated = saveProject({
      ...project,
      sourceDeleted: true,
      sourceSizeBytes: 0,
    });
    res.json({ project: updated });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  app.get('/api/llm-router', async (_req, res) => {
    try {
      res.json(await getLLMRouterState());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Router state error' });
    }
  });

  app.post('/api/llm-router/priority', async (req, res) => {
    const priority = req.body?.priority === 'local-first' ? 'local-first' : 'cloud-first';
    setRoutingPriority(priority);
    res.json(await getLLMRouterState());
  });

  app.post('/api/llm-router/reset-cooldowns', async (_req, res) => {
    clearRouterCooldowns();
    res.json(await getLLMRouterState());
  });

  app.get('/api/custom-llm/status', async (_req, res) => {
    res.json({
      customLlm: await probeCustomLlmHealth(),
      trainingStats: getTrainingStats(),
    });
  });

  app.post('/api/custom-llm/start', async (_req, res) => {
    try {
      const customLlm = await startLocalCustomLlm();
      const routerState = await getLLMRouterState();
      res.json({ customLlm, routerState });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start Custom LLM' });
    }
  });

  app.post('/api/custom-llm/stop', async (_req, res) => {
    const customLlm = await stopLocalCustomLlm();
    const routerState = await getLLMRouterState();
    res.json({ customLlm, routerState });
  });

  app.get('/api/training/export', (_req, res) => {
    if (!fs.existsSync(TRAINING_DATASET_PATH)) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', 'attachment; filename="clipforge-training-dataset.jsonl"');
      res.send('');
      return;
    }
    res.download(TRAINING_DATASET_PATH, 'clipforge-training-dataset.jsonl');
  });

  app.get('/api/weights', (_req, res) => {
    res.json({ weights: loadWeights() });
  });

  app.post('/api/weights/reset', (_req, res) => {
    res.json({ weights: resetRankingWeights() });
  });

  app.get('/api/clips', (_req, res) => {
    res.json({ clips: listClips() });
  });

  app.post('/api/clips/render', async (req, res) => {
    try {
      const projectId = String(req.body?.projectId || '');
      const momentId = String(req.body?.momentId || '');
      const layoutId = (req.body?.layoutId || 'split-top-cam') as LayoutId;
      const templateId = (req.body?.templateId || 'none') as TemplateId;

      const project = getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const moment = project.moments.find((m) => m.id === momentId) || project.moments[0];
      if (!moment) return res.status(404).json({ error: 'Moment not found' });

      const facecamBox = (req.body?.facecamBox as FacecamBox) || project.detectedFacecam;
      const branding: BrandingConfig = {
        creditText: String(req.body?.branding?.creditText || '@clipforge').slice(0, 40),
        backgroundHex: String(req.body?.branding?.backgroundHex || '#0B0D11').slice(0, 12),
        watermarkText: String(req.body?.branding?.watermarkText || '').slice(0, 40),
        outroEnabled: Boolean(req.body?.branding?.outroEnabled),
        outroSeconds: Number(req.body?.branding?.outroSeconds || 1.5),
        musicVolume: Number(req.body?.branding?.musicVolume ?? 0),
        musicTrackId: req.body?.branding?.musicTrackId || null,
      };

      const clip = await renderVerticalClip({
        project,
        moment,
        layoutId,
        templateId,
        facecamBox,
        branding,
        titleOverride: typeof req.body?.title === 'string' ? req.body.title : undefined,
        hookTaglineOverride:
          typeof req.body?.hookTagline === 'string' ? req.body.hookTagline : undefined,
        descriptionOverride:
          typeof req.body?.description === 'string' ? req.body.description : undefined,
        hashtagsOverride: Array.isArray(req.body?.hashtags) ? req.body.hashtags : undefined,
      });

      saveClip(clip);
      res.status(201).json({ clip });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'FFmpeg render failed' });
    }
  });

  app.patch('/api/clips/:id', (req, res) => {
    const existing = getClip(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Clip not found' });

    const updated = saveClip({
      ...existing,
      title: typeof req.body?.title === 'string' ? req.body.title.slice(0, 100) : existing.title,
      hookTagline:
        typeof req.body?.hookTagline === 'string'
          ? req.body.hookTagline.slice(0, 120)
          : existing.hookTagline,
      description:
        typeof req.body?.description === 'string'
          ? req.body.description.slice(0, 1200)
          : existing.description,
      hashtags: Array.isArray(req.body?.hashtags)
        ? req.body.hashtags.map((h: unknown) => String(h).slice(0, 32))
        : existing.hashtags,
      youtubeVideoId:
        typeof req.body?.youtubeVideoId === 'string'
          ? req.body.youtubeVideoId
          : existing.youtubeVideoId,
      youtubePublishAt:
        typeof req.body?.youtubePublishAt === 'string'
          ? req.body.youtubePublishAt
          : existing.youtubePublishAt,
      youtubeStatus: req.body?.youtubeStatus || existing.youtubeStatus,
    });

    res.json({ clip: updated });
  });

  app.delete('/api/clips/:id', (req, res) => {
    const ok = deleteClip(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Clip not found' });
    res.json({ ok: true });
  });

  app.get('/api/watchlist', (_req, res) => {
    res.json({ watchlist: listWatchlist() });
  });

  app.post('/api/watchlist', (req, res) => {
    const creatorName = String(req.body?.creatorName || '').trim().slice(0, 60);
    const channelUrl = String(req.body?.channelUrl || '').trim().slice(0, 240);
    const platform =
      req.body?.platform === 'twitch' || req.body?.platform === 'kick'
        ? req.body.platform
        : 'youtube';
    if (!creatorName || !channelUrl) {
      return res.status(400).json({ error: 'Creator name and channel URL are required.' });
    }
    const item: CreatorWatchItem = {
      id: `watch_${crypto.randomBytes(4).toString('hex')}`,
      creatorName,
      platform,
      channelUrl,
      autoClipEnabled: req.body?.autoClipEnabled !== false,
      defaultLayoutId: (req.body?.defaultLayoutId || 'split-top-cam') as LayoutId,
      minScoreThreshold: Math.min(0.95, Math.max(0.3, Number(req.body?.minScoreThreshold ?? 0.65))),
      lastCheckedAt: new Date().toISOString(),
    };
    const next = [item, ...listWatchlist()];
    saveWatchlist(next);
    res.status(201).json({ item, watchlist: next });
  });

  app.delete('/api/watchlist/:id', (req, res) => {
    const next = listWatchlist().filter((w) => w.id !== req.params.id);
    saveWatchlist(next);
    res.json({ watchlist: next });
  });

  // Safe static media routes (path-confined)
  app.get('/api/frames/:filename', (req, res) => {
    try {
      const target = resolveSafeChildPath(FRAMES_DIR, req.params.filename);
      if (!fs.existsSync(target)) return res.status(404).end();
      res.sendFile(target);
    } catch {
      res.status(400).end();
    }
  });

  app.get('/api/sources/:filename', (req, res) => {
    try {
      const target = resolveSafeChildPath(SOURCES_DIR, req.params.filename);
      if (!fs.existsSync(target)) return res.status(404).end();
      res.sendFile(target);
    } catch {
      res.status(400).end();
    }
  });

  app.get('/api/renders/:filename', (req, res) => {
    try {
      const target = resolveSafeChildPath(RENDERS_DIR, req.params.filename);
      if (!fs.existsSync(target)) return res.status(404).end();
      if (req.query.download === '1') {
        res.download(target, path.basename(target));
        return;
      }
      res.sendFile(target);
    } catch {
      res.status(400).end();
    }
  });

  // Frontend Vite middleware (dev) or static dist (production)
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipForge server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
