import type { RankingWeights, ViralMoment } from '../src/types.ts';
import { DEFAULT_WEIGHTS, loadWeights, saveWeights } from './storage.ts';

export function computeFinalRankScore(
  moment: Pick<ViralMoment, 'audioSpikeScore' | 'transcriptScore' | 'llmScore' | 'durationSec'>,
  weights: RankingWeights
): number {
  const durationOptimal =
    moment.durationSec >= 18 && moment.durationSec <= 48
      ? 1.0
      : moment.durationSec >= 10 && moment.durationSec <= 58
        ? 0.78
        : 0.45;
  const pacingDensity = Math.min(1, moment.audioSpikeScore * 0.65 + moment.transcriptScore * 0.35);

  const weighted =
    moment.audioSpikeScore * weights.audioSpikeWeight +
    moment.transcriptScore * weights.transcriptHookWeight +
    pacingDensity * weights.pacingDensityWeight +
    durationOptimal * weights.durationSweetSpotWeight +
    moment.llmScore * weights.llmSemanticWeight;

  const totalWeight =
    weights.audioSpikeWeight +
    weights.transcriptHookWeight +
    weights.pacingDensityWeight +
    weights.durationSweetSpotWeight +
    weights.llmSemanticWeight;

  const normalized = totalWeight > 0 ? weighted / totalWeight : weighted;
  return Math.round(Math.min(1, Math.max(0, normalized)) * 100) / 100;
}

export function applyMomentFeedback(
  moment: ViralMoment,
  feedback: 'up' | 'down'
): RankingWeights {
  const current = loadWeights();
  const direction = feedback === 'up' ? 1 : -1;
  const step = 0.03;

  const next: RankingWeights = {
    audioSpikeWeight: clampWeight(
      current.audioSpikeWeight + direction * step * (moment.audioSpikeScore - 0.5)
    ),
    transcriptHookWeight: clampWeight(
      current.transcriptHookWeight + direction * step * (moment.transcriptScore - 0.5)
    ),
    pacingDensityWeight: clampWeight(
      current.pacingDensityWeight + direction * step * 0.2
    ),
    durationSweetSpotWeight: clampWeight(
      current.durationSweetSpotWeight +
        direction * step * (moment.durationSec >= 18 && moment.durationSec <= 48 ? 0.3 : -0.2)
    ),
    llmSemanticWeight: clampWeight(
      current.llmSemanticWeight + direction * step * (moment.llmScore - 0.5)
    ),
    updatedAt: new Date().toISOString(),
    feedbackCount: current.feedbackCount + 1,
  };

  // Normalize weights to sum to 1.0
  const sum =
    next.audioSpikeWeight +
    next.transcriptHookWeight +
    next.pacingDensityWeight +
    next.durationSweetSpotWeight +
    next.llmSemanticWeight;

  if (sum > 0) {
    next.audioSpikeWeight = round3(next.audioSpikeWeight / sum);
    next.transcriptHookWeight = round3(next.transcriptHookWeight / sum);
    next.pacingDensityWeight = round3(next.pacingDensityWeight / sum);
    next.durationSweetSpotWeight = round3(next.durationSweetSpotWeight / sum);
    next.llmSemanticWeight = round3(next.llmSemanticWeight / sum);
  }

  return saveWeights(next);
}

export function resetRankingWeights(): RankingWeights {
  return saveWeights({ ...DEFAULT_WEIGHTS, updatedAt: new Date().toISOString() });
}

function clampWeight(v: number): number {
  return Math.max(0.05, Math.min(0.75, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
