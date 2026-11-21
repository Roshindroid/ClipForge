import fs from 'node:fs';
import path from 'node:path';
import type {
  CreatorWatchItem,
  RankingWeights,
  RenderedClip,
  VideoProject,
} from '../src/types.ts';

export const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
export const SOURCES_DIR = path.join(WORKSPACE_ROOT, 'sources');
export const FRAMES_DIR = path.join(WORKSPACE_ROOT, 'frames');
export const RENDERS_DIR = path.join(WORKSPACE_ROOT, 'renders');
export const ASSETS_DIR = path.join(WORKSPACE_ROOT, 'assets');

const PROJECTS_FILE = path.join(WORKSPACE_ROOT, 'projects.json');
const CLIPS_FILE = path.join(WORKSPACE_ROOT, 'clips.json');
const WEIGHTS_FILE = path.join(WORKSPACE_ROOT, 'weights.json');
const WATCHLIST_FILE = path.join(WORKSPACE_ROOT, 'watchlists.json');

export const DEFAULT_WEIGHTS: RankingWeights = {
  audioSpikeWeight: 0.42,
  transcriptHookWeight: 0.25,
  pacingDensityWeight: 0.13,
  durationSweetSpotWeight: 0.1,
  llmSemanticWeight: 0.1,
  updatedAt: new Date().toISOString(),
  feedbackCount: 0,
};

export function ensureWorkspace(): void {
  for (const dir of [WORKSPACE_ROOT, SOURCES_DIR, FRAMES_DIR, RENDERS_DIR, ASSETS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(CLIPS_FILE)) {
    fs.writeFileSync(CLIPS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(WEIGHTS_FILE)) {
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(DEFAULT_WEIGHTS, null, 2), 'utf8');
  }
  if (!fs.existsSync(WATCHLIST_FILE)) {
    fs.writeFileSync(WATCHLIST_FILE, '[]', 'utf8');
  }
}

/**
 * Resolves a filename safely inside a target base directory (blocks path traversal).
 */
export function resolveSafeChildPath(baseDir: string, unsafeFileName: string): string {
  const cleanName = path.basename(unsafeFileName);
  if (!cleanName || cleanName === '.' || cleanName === '..') {
    throw new Error('Invalid filename');
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, cleanName);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path traversal blocked');
  }
  return resolvedTarget;
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    ensureWorkspace();
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(filePath: string, data: T): void {
  ensureWorkspace();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export function listProjects(): VideoProject[] {
  return readJson<VideoProject[]>(PROJECTS_FILE, []);
}

export function getProject(projectId: string): VideoProject | undefined {
  return listProjects().find((p) => p.id === projectId);
}

export function saveProject(project: VideoProject): VideoProject {
  const all = listProjects();
  const idx = all.findIndex((p) => p.id === project.id);
  if (idx >= 0) {
    all[idx] = project;
  } else {
    all.unshift(project);
  }
  writeJson(PROJECTS_FILE, all);
  return project;
}

export function deleteProject(projectId: string): boolean {
  const all = listProjects();
  const target = all.find((p) => p.id === projectId);
  if (!target) return false;
  const remaining = all.filter((p) => p.id !== projectId);
  writeJson(PROJECTS_FILE, remaining);
  try {
    const srcPath = resolveSafeChildPath(SOURCES_DIR, target.fileName);
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
  } catch {
    // ignore cleanup errors
  }
  return true;
}

export function listClips(): RenderedClip[] {
  return readJson<RenderedClip[]>(CLIPS_FILE, []);
}

export function getClip(clipId: string): RenderedClip | undefined {
  return listClips().find((c) => c.id === clipId);
}

export function saveClip(clip: RenderedClip): RenderedClip {
  const all = listClips();
  const idx = all.findIndex((c) => c.id === clip.id);
  if (idx >= 0) {
    all[idx] = clip;
  } else {
    all.unshift(clip);
  }
  writeJson(CLIPS_FILE, all);
  return clip;
}

export function deleteClip(clipId: string): boolean {
  const all = listClips();
  const target = all.find((c) => c.id === clipId);
  if (!target) return false;
  writeJson(
    CLIPS_FILE,
    all.filter((c) => c.id !== clipId)
  );
  try {
    const outPath = resolveSafeChildPath(RENDERS_DIR, target.outputFileName);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  } catch {
    // ignore cleanup errors
  }
  return true;
}

export function loadWeights(): RankingWeights {
  return readJson<RankingWeights>(WEIGHTS_FILE, DEFAULT_WEIGHTS);
}

export function saveWeights(weights: RankingWeights): RankingWeights {
  writeJson(WEIGHTS_FILE, weights);
  return weights;
}

export function listWatchlist(): CreatorWatchItem[] {
  return readJson<CreatorWatchItem[]>(WATCHLIST_FILE, []);
}

export function saveWatchlist(items: CreatorWatchItem[]): CreatorWatchItem[] {
  writeJson(WATCHLIST_FILE, items);
  return items;
}
