import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  CreatorWatchItem,
  RankingWeights,
  RenderedClip,
  StorageStatus,
  VideoProject,
} from '../src/types.ts';

export const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
export const SOURCES_DIR = process.env.CLIPFORGE_SOURCES_DIR?.trim()
  ? path.resolve(process.env.CLIPFORGE_SOURCES_DIR.trim())
  : path.join(WORKSPACE_ROOT, 'sources');
export const FRAMES_DIR = path.join(WORKSPACE_ROOT, 'frames');
export const RENDERS_DIR = process.env.CLIPFORGE_RENDERS_DIR?.trim()
  ? path.resolve(process.env.CLIPFORGE_RENDERS_DIR.trim())
  : path.join(WORKSPACE_ROOT, 'renders');
export const ASSETS_DIR = path.join(WORKSPACE_ROOT, 'assets');

const PROJECTS_FILE = path.join(WORKSPACE_ROOT, 'projects.json');
const CLIPS_FILE = path.join(WORKSPACE_ROOT, 'clips.json');
const WEIGHTS_FILE = path.join(WORKSPACE_ROOT, 'weights.json');
const WATCHLIST_FILE = path.join(WORKSPACE_ROOT, 'watchlists.json');
const SETTINGS_FILE = path.join(WORKSPACE_ROOT, 'settings.json');

export const DEFAULT_SETTINGS: AppSettings = {
  autoPruneSourceVod: false,
};

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
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
  }
}

export function sanitizeFolderName(raw?: string): string {
  if (!raw) return '';
  const cleaned = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) =>
      seg
        .replace(/[^a-zA-Z0-9._ -]/g, '_')
        .replace(/\.\./g, '')
        .replace(/^\.+/, '')
        .trim()
    )
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .slice(0, 2)
    .join('/');
  return cleaned;
}

export function sanitizeFileSlug(raw: string, maxLen = 48): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return cleaned || 'video';
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

/**
 * Resolves a source relative path (flat file or sanitized subfolder inside SOURCES_DIR).
 */
export function resolveSafeSourcePath(unsafeRelativePath: string): string {
  const normalized = unsafeRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) {
    throw new Error('Invalid source path');
  }
  const resolvedBase = path.resolve(SOURCES_DIR);
  const resolvedTarget = path.resolve(resolvedBase, ...parts);
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

function syncProjectWithDisk(project: VideoProject): { project: VideoProject; changed: boolean } {
  if (project.sourceMode === 'remote-stream' || !project.fileName) {
    return { project, changed: false };
  }
  try {
    const srcPath = resolveSafeSourcePath(project.fileName);
    const exists = fs.existsSync(srcPath);
    if (!exists && !project.sourceDeleted) {
      return {
        project: { ...project, sourceDeleted: true, sourceSizeBytes: 0 },
        changed: true,
      };
    }
    if (exists) {
      const size = fs.statSync(srcPath).size;
      if (project.sourceDeleted || project.sourceSizeBytes !== size) {
        return {
          project: { ...project, sourceDeleted: false, sourceSizeBytes: size },
          changed: true,
        };
      }
    }
  } catch {
    // ignore malformed paths
  }
  return { project, changed: false };
}

export function listProjects(): VideoProject[] {
  const raw = readJson<VideoProject[]>(PROJECTS_FILE, []);
  let anyChanged = false;
  const synced = raw.map((p) => {
    const res = syncProjectWithDisk(p);
    if (res.changed) anyChanged = true;
    return res.project;
  });
  if (anyChanged) {
    writeJson(PROJECTS_FILE, synced);
  }
  return synced;
}

export function getProject(projectId: string): VideoProject | undefined {
  return listProjects().find((p) => p.id === projectId);
}

export function saveProject(project: VideoProject): VideoProject {
  const all = readJson<VideoProject[]>(PROJECTS_FILE, []);
  const idx = all.findIndex((p) => p.id === project.id);
  if (idx >= 0) {
    all[idx] = project;
  } else {
    all.unshift(project);
  }
  writeJson(PROJECTS_FILE, all);
  return project;
}

function removeEmptySourceSubdir(filePath: string): void {
  const resolvedBase = path.resolve(SOURCES_DIR);
  let current = path.dirname(path.resolve(filePath));
  while (current !== resolvedBase && current.startsWith(resolvedBase + path.sep)) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

function cleanupProjectPreviewSlices(projectId: string): number {
  let freed = 0;
  try {
    if (fs.existsSync(FRAMES_DIR)) {
      for (const file of fs.readdirSync(FRAMES_DIR)) {
        if (file.startsWith(`preview_${projectId}_`)) {
          const full = path.join(FRAMES_DIR, file);
          freed += fs.statSync(full).size;
          fs.unlinkSync(full);
        }
      }
    }
  } catch {
    // ignore cleanup errors
  }
  return freed;
}

export function cleanupProjectSource(projectId: string): {
  project: VideoProject | null;
  freedBytes: number;
} {
  const target = getProject(projectId);
  if (!target) return { project: null, freedBytes: 0 };

  let freedBytes = 0;
  if (target.sourceMode !== 'remote-stream' && target.fileName) {
    const srcPath = resolveSafeSourcePath(target.fileName);
    if (fs.existsSync(srcPath)) {
      freedBytes += fs.statSync(srcPath).size;
      fs.unlinkSync(srcPath);
      removeEmptySourceSubdir(srcPath);
    }
  }
  freedBytes += cleanupProjectPreviewSlices(projectId);

  const updated = saveProject({
    ...target,
    sourceDeleted: true,
    sourceSizeBytes: 0,
  });
  return { project: updated, freedBytes };
}

export function pruneAllDownloadedSources(): {
  projects: VideoProject[];
  freedBytes: number;
} {
  const all = listProjects();
  let freedBytes = 0;
  const updatedProjects = all.map((proj) => {
    if (proj.sourceMode !== 'remote-stream' && proj.fileName) {
      try {
        const srcPath = resolveSafeSourcePath(proj.fileName);
        if (fs.existsSync(srcPath)) {
          freedBytes += fs.statSync(srcPath).size;
          fs.unlinkSync(srcPath);
          removeEmptySourceSubdir(srcPath);
        }
      } catch {
        // ignore
      }
    }
    freedBytes += cleanupProjectPreviewSlices(proj.id);
    if (proj.sourceMode !== 'remote-stream' && !proj.sourceDeleted) {
      return { ...proj, sourceDeleted: true, sourceSizeBytes: 0 };
    }
    return proj;
  });
  writeJson(PROJECTS_FILE, updatedProjects);
  return { projects: updatedProjects, freedBytes };
}

function walkDirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += walkDirBytes(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

export function getStorageStatus(): StorageStatus {
  ensureWorkspace();
  const projects = listProjects();
  const activeVodCount = projects.filter(
    (p) => p.sourceMode !== 'remote-stream' && !p.sourceDeleted && (p.sourceSizeBytes || 0) > 0
  ).length;
  return {
    sourcesDir: SOURCES_DIR,
    rendersDir: RENDERS_DIR,
    totalSourceBytes: walkDirBytes(SOURCES_DIR),
    totalRenderBytes: walkDirBytes(RENDERS_DIR),
    activeVodCount,
  };
}

export function deleteProject(projectId: string): boolean {
  const all = listProjects();
  const target = all.find((p) => p.id === projectId);
  if (!target) return false;
  const remaining = all.filter((p) => p.id !== projectId);
  writeJson(PROJECTS_FILE, remaining);
  if (target.fileName && target.sourceMode !== 'remote-stream') {
    try {
      const srcPath = resolveSafeSourcePath(target.fileName);
      if (fs.existsSync(srcPath)) {
        fs.unlinkSync(srcPath);
        removeEmptySourceSubdir(srcPath);
      }
    } catch {
      // ignore cleanup errors
    }
  }
  try {
    if (fs.existsSync(FRAMES_DIR)) {
      for (const file of fs.readdirSync(FRAMES_DIR)) {
        if (file.startsWith(`${projectId}_`) || file.startsWith(`preview_${projectId}_`)) {
          fs.unlinkSync(path.join(FRAMES_DIR, file));
        }
      }
    }
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

export function loadAppSettings(): AppSettings {
  const raw = readJson<Partial<AppSettings>>(SETTINGS_FILE, DEFAULT_SETTINGS);
  return {
    autoPruneSourceVod: Boolean(raw.autoPruneSourceVod),
  };
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadAppSettings();
  const next: AppSettings = {
    ...current,
    autoPruneSourceVod:
      typeof patch.autoPruneSourceVod === 'boolean'
        ? patch.autoPruneSourceVod
        : current.autoPruneSourceVod,
  };
  writeJson(SETTINGS_FILE, next);
  return next;
}
