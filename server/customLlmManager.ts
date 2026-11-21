import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CUSTOM_LLM_SCRIPT = path.resolve(process.cwd(), 'custom_llm', 'server.py');
const LOCAL_CUSTOM_URL = 'http://127.0.0.1:8000';

let localProc: ChildProcess | null = null;

export interface CustomLLMStatus {
  running: boolean;
  managedByServer: boolean;
  url: string;
  backendMode?: string;
  trainedFeedbackSamples?: number;
}

export function getEffectiveCustomLlmUrl(): string {
  const envUrl = process.env.CUSTOM_LLM_URL?.trim();
  if (envUrl) return envUrl;
  return localProc ? LOCAL_CUSTOM_URL : '';
}

export async function probeCustomLlmHealth(): Promise<CustomLLMStatus> {
  const url = process.env.CUSTOM_LLM_URL?.trim() || LOCAL_CUSTOM_URL;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { running: false, managedByServer: Boolean(localProc), url };
    }
    const data = (await res.json()) as {
      ok?: boolean;
      backendMode?: string;
      trainedFeedbackSamples?: number;
    };
    return {
      running: Boolean(data.ok),
      managedByServer: Boolean(localProc),
      url,
      backendMode: data.backendMode,
      trainedFeedbackSamples: data.trainedFeedbackSamples ?? 0,
    };
  } catch {
    return { running: false, managedByServer: Boolean(localProc), url };
  }
}

export async function startLocalCustomLlm(): Promise<CustomLLMStatus> {
  const existing = await probeCustomLlmHealth();
  if (existing.running) return existing;

  if (!fs.existsSync(CUSTOM_LLM_SCRIPT)) {
    throw new Error('custom_llm/server.py is missing.');
  }

  localProc = spawn('python3', [CUSTOM_LLM_SCRIPT], {
    shell: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      CUSTOM_LLM_BIND_HOST: '127.0.0.1',
      CUSTOM_LLM_PORT: '8000',
    },
  });

  localProc.on('exit', () => {
    localProc = null;
  });

  // Wait up to 2.5s for Python HTTP server socket readiness
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const status = await probeCustomLlmHealth();
    if (status.running) return status;
  }

  throw new Error('Custom LLM server did not respond on 127.0.0.1:8000.');
}

export async function stopLocalCustomLlm(): Promise<CustomLLMStatus> {
  if (localProc) {
    localProc.kill('SIGTERM');
    localProc = null;
  }
  return probeCustomLlmHealth();
}
