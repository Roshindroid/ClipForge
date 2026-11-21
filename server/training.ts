import fs from 'node:fs';
import path from 'node:path';
import type { ViralMoment } from '../src/types.ts';
import { WORKSPACE_ROOT, ensureWorkspace } from './storage.ts';

export const TRAINING_DATASET_PATH = path.join(WORKSPACE_ROOT, 'training_data.jsonl');

export interface TrainingDatasetStats {
  total: number;
  positive: number;
  negative: number;
}

export function recordTrainingExample(
  projectTitle: string,
  moment: ViralMoment,
  feedback: 'up' | 'down'
): TrainingDatasetStats {
  ensureWorkspace();
  const label = feedback === 'up' ? 1 : 0;

  const userContent = JSON.stringify({
    sourceTitle: projectTitle,
    startSec: moment.startSec,
    endSec: moment.endSec,
    audioPeakDb: moment.audioPeakDb,
    audioSpikeScore: moment.audioSpikeScore,
    transcriptSnippet: moment.transcriptSnippet,
  });

  const assistantContent = JSON.stringify({
    clips: [
      {
        llmScore: feedback === 'up' ? Math.max(0.85, moment.llmScore) : Math.min(0.3, moment.llmScore),
        title: moment.title,
        hookTagline: moment.hookTagline,
        description: moment.description,
        hashtags: moment.hashtags,
        reason: moment.reason,
      },
    ],
  });

  const row = {
    label,
    title: projectTitle,
    snippet: moment.transcriptSnippet,
    audioPeakDb: moment.audioPeakDb,
    createdAt: new Date().toISOString(),
    messages: [
      {
        role: 'system',
        content:
          'You are ClipForge-Viral. Score short-form clip candidates and return strict JSON.',
      },
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ],
  };

  fs.appendFileSync(TRAINING_DATASET_PATH, JSON.stringify(row) + '\n', 'utf8');
  return getTrainingStats();
}

export function getTrainingStats(): TrainingDatasetStats {
  ensureWorkspace();
  if (!fs.existsSync(TRAINING_DATASET_PATH)) {
    return { total: 0, positive: 0, negative: 0 };
  }
  const lines = fs
    .readFileSync(TRAINING_DATASET_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  let positive = 0;
  let negative = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { label?: number };
      if (parsed.label === 1) positive++;
      else if (parsed.label === 0) negative++;
    } catch {
      // skip malformed line
    }
  }
  return { total: positive + negative, positive, negative };
}
