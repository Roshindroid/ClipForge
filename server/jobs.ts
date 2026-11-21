import crypto from 'node:crypto';
import type { JobStatus, RenderedClip, VideoProject } from '../src/types.ts';

const jobs = new Map<string, JobStatus>();
const JOB_TTL_MS = 60 * 60 * 1000;

function pruneOldJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (
      (job.status === 'completed' || job.status === 'failed') &&
      new Date(job.updatedAt).getTime() < cutoff
    ) {
      jobs.delete(id);
    }
  }
}

export function createJob(type: JobStatus['type'], stage: string, detail?: string): JobStatus {
  pruneOldJobs();
  const now = new Date().toISOString();
  const job: JobStatus = {
    id: `job_${crypto.randomBytes(6).toString('hex')}`,
    type,
    status: 'running',
    progress: 2,
    stage,
    detail,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<JobStatus, 'progress' | 'stage' | 'detail'>>
): void {
  const job = jobs.get(id);
  if (!job) return;
  if (typeof patch.progress === 'number') {
    job.progress = Math.max(0, Math.min(99, Math.round(patch.progress)));
  }
  if (patch.stage !== undefined) job.stage = patch.stage;
  if (patch.detail !== undefined) job.detail = patch.detail;
  job.updatedAt = new Date().toISOString();
}

export function completeJob(
  id: string,
  result: { project?: VideoProject; clip?: RenderedClip }
): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'completed';
  job.progress = 100;
  job.stage = 'Completed';
  job.project = result.project;
  job.clip = result.clip;
  job.updatedAt = new Date().toISOString();
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'failed';
  job.stage = 'Failed';
  job.error = error;
  job.updatedAt = new Date().toISOString();
}

export function getJob(id: string): JobStatus | undefined {
  return jobs.get(id);
}
