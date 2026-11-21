import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import type {
  LLMProviderId,
  LLMProviderStatus,
  LLMRouterState,
  RoutingPriority,
} from '../src/types.ts';
import { checkOllama, getOllamaHost } from './capabilities.ts';
import { probeCustomLlmHealth } from './customLlmManager.ts';
import { WORKSPACE_ROOT, ensureWorkspace } from './storage.ts';

const ROUTER_STATE_FILE = path.join(WORKSPACE_ROOT, 'llm_router.json');

interface PersistedRouterData {
  priority: RoutingPriority;
  stats: Record<
    LLMProviderId,
    {
      cooldownUntil: string | null;
      quotaHits: number;
      lastError: string | null;
      lastSuccessAt: string | null;
    }
  >;
}

const DEFAULT_STATS = () => ({
  cooldownUntil: null,
  quotaHits: 0,
  lastError: null,
  lastSuccessAt: null,
});

function loadRouterData(): PersistedRouterData {
  ensureWorkspace();
  try {
    if (fs.existsSync(ROUTER_STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ROUTER_STATE_FILE, 'utf8')) as PersistedRouterData;
      return {
        priority: parsed.priority === 'local-first' ? 'local-first' : 'cloud-first',
        stats: {
          custom: parsed.stats?.custom || DEFAULT_STATS(),
          gemini: parsed.stats?.gemini || DEFAULT_STATS(),
          groq: parsed.stats?.groq || DEFAULT_STATS(),
          openrouter: parsed.stats?.openrouter || DEFAULT_STATS(),
          ollama: parsed.stats?.ollama || DEFAULT_STATS(),
        },
      };
    }
  } catch {
    // ignore malformed file
  }
  return {
    priority: 'cloud-first',
    stats: {
      custom: DEFAULT_STATS(),
      gemini: DEFAULT_STATS(),
      groq: DEFAULT_STATS(),
      openrouter: DEFAULT_STATS(),
      ollama: DEFAULT_STATS(),
    },
  };
}

function saveRouterData(data: PersistedRouterData): void {
  ensureWorkspace();
  fs.writeFileSync(ROUTER_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getProviderConfig(
  id: LLMProviderId,
  ollamaModels: string[],
  localCustomRunning: boolean
) {
  switch (id) {
    case 'custom': {
      const envUrl = process.env.CUSTOM_LLM_URL?.trim() || '';
      const url = envUrl || (localCustomRunning ? 'http://127.0.0.1:8000' : '');
      const key = process.env.CUSTOM_LLM_KEY?.trim() || '';
      const model =
        process.env.CUSTOM_LLM_MODEL?.trim() ||
        (localCustomRunning ? 'clipforge-viral-custom' : 'default');
      let validUrl = false;
      if (url) {
        try {
          const parsed = new URL(url);
          validUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          validUrl = false;
        }
      }
      return {
        label: localCustomRunning && !envUrl ? 'ClipForge Custom LLM' : 'Custom OpenAI API',
        configured: validUrl,
        model,
        url,
        key,
      };
    }
    case 'gemini':
      return {
        label: 'Google Gemini',
        configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
        model: 'gemini-2.5-flash',
        key: process.env.GEMINI_API_KEY?.trim() || '',
      };
    case 'groq':
      return {
        label: 'Groq (Llama 3.3 70B)',
        configured: Boolean(process.env.GROQ_API_KEY?.trim()),
        model: 'llama-3.3-70b-versatile',
        key: process.env.GROQ_API_KEY?.trim() || '',
      };
    case 'openrouter':
      return {
        label: 'OpenRouter Free',
        configured: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        key: process.env.OPENROUTER_API_KEY?.trim() || '',
      };
    case 'ollama':
      return {
        label: 'Local Ollama',
        configured: ollamaModels.length > 0,
        model: process.env.OLLAMA_MODEL?.trim() || ollamaModels[0] || 'llama3.2:3b',
      };
  }
}

export async function getLLMRouterState(): Promise<LLMRouterState> {
  const data = loadRouterData();
  const [ollamaInfo, customHealth] = await Promise.all([
    checkOllama(),
    probeCustomLlmHealth(),
  ]);
  const order: LLMProviderId[] =
    data.priority === 'local-first'
      ? ['ollama', 'custom', 'gemini', 'groq', 'openrouter']
      : ['custom', 'gemini', 'groq', 'openrouter', 'ollama'];

  const now = Date.now();
  const providers: LLMProviderStatus[] = order.map((id) => {
    const cfg = getProviderConfig(id, ollamaInfo.models, customHealth.running);
    const st = data.stats[id];
    const cooldownActive = st.cooldownUntil && new Date(st.cooldownUntil).getTime() > now;
    return {
      id,
      label: cfg.label,
      configured: cfg.configured,
      model: cfg.model,
      cooldownUntil: cooldownActive ? st.cooldownUntil : null,
      quotaHits: st.quotaHits,
      lastError: st.lastError,
      lastSuccessAt: st.lastSuccessAt,
    };
  });

  return {
    priority: data.priority,
    providers,
  };
}

export function setRoutingPriority(priority: RoutingPriority): void {
  const data = loadRouterData();
  data.priority = priority;
  saveRouterData(data);
}

export function clearRouterCooldowns(): void {
  const data = loadRouterData();
  for (const id of Object.keys(data.stats) as LLMProviderId[]) {
    data.stats[id].cooldownUntil = null;
    data.stats[id].lastError = null;
  }
  saveRouterData(data);
}

function isQuotaError(status: number, message: string): boolean {
  if (status === 429) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('resource_exhausted') ||
    lower.includes('too many requests')
  );
}

async function callOpenAICompatible(params: {
  endpointUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...params.extraHeaders,
  };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  const res = await fetch(params.endpointUrl, {
    method: 'POST',
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      model: params.model,
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Respond strictly with valid JSON matching the requested schema.',
        },
        { role: 'user', content: params.prompt },
      ],
    }),
  });
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty completion content');
  return content;
}

export interface CandidateClipInput {
  startSec: number;
  endSec: number;
  audioPeakDb: number;
  audioSpikeScore: number;
  transcriptSnippet: string;
}

export interface ScoredClipOutput {
  llmScore: number;
  title: string;
  hookTagline: string;
  description: string;
  hashtags: string[];
  reason: string;
  scoredBy: string;
}

export async function scoreMomentsWithRouter(
  projectTitle: string,
  candidates: CandidateClipInput[]
): Promise<ScoredClipOutput[] | null> {
  if (candidates.length === 0) return null;

  const data = loadRouterData();
  const [ollamaInfo, customHealth] = await Promise.all([
    checkOllama(),
    probeCustomLlmHealth(),
  ]);
  const order: LLMProviderId[] =
    data.priority === 'local-first'
      ? ['ollama', 'custom', 'gemini', 'groq', 'openrouter']
      : ['custom', 'gemini', 'groq', 'openrouter', 'ollama'];

  const prompt = [
    `You are scoring viral short-form video clips for YouTube Shorts.`,
    `Source video title: "${projectTitle}".`,
    `Evaluate these ${candidates.length} candidate segments and return JSON strictly matching: {"clips":[{"llmScore":0.0-1.0,"title":"short punchy title","hookTagline":"1-line hook tagline","description":"2-sentence YouTube Shorts description","hashtags":["#shorts","#gaming"],"reason":"brief reason"}]}`,
    `Candidates: ${JSON.stringify(candidates)}`,
  ].join('\n');

  const now = Date.now();

  for (const id of order) {
    const cfg = getProviderConfig(id, ollamaInfo.models, customHealth.running);
    if (!cfg.configured) continue;

    const st = data.stats[id];
    if (st.cooldownUntil && new Date(st.cooldownUntil).getTime() > now) {
      continue;
    }

    try {
      let rawText = '';

      if (id === 'custom') {
        const customCfg = cfg as ReturnType<typeof getProviderConfig> & { url: string; key: string };
        const endpoint = customCfg.url.endsWith('/chat/completions')
          ? customCfg.url
          : `${customCfg.url.replace(/\/+$/, '')}/v1/chat/completions`;
        rawText = await callOpenAICompatible({
          endpointUrl: endpoint,
          apiKey: customCfg.key,
          model: cfg.model,
          prompt,
        });
      } else if (id === 'gemini') {
        const geminiCfg = cfg as ReturnType<typeof getProviderConfig> & { key: string };
        const ai = new GoogleGenAI({ apiKey: geminiCfg.key });
        const response = await ai.models.generateContent({
          model: cfg.model,
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        rawText = response.text || '';
      } else if (id === 'groq') {
        const groqCfg = cfg as ReturnType<typeof getProviderConfig> & { key: string };
        rawText = await callOpenAICompatible({
          endpointUrl: 'https://api.groq.com/openai/v1/chat/completions',
          apiKey: groqCfg.key,
          model: cfg.model,
          prompt,
        });
      } else if (id === 'openrouter') {
        const orCfg = cfg as ReturnType<typeof getProviderConfig> & { key: string };
        rawText = await callOpenAICompatible({
          endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
          apiKey: orCfg.key,
          model: cfg.model,
          prompt,
          extraHeaders: { 'X-Title': 'ClipForge' },
        });
      } else if (id === 'ollama') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 14000);
        const res = await fetch(`${getOllamaHost()}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: cfg.model,
            prompt,
            stream: false,
            format: 'json',
          }),
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
        const payload = (await res.json()) as { response?: string };
        rawText = payload.response || '';
      }

      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/```$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned) as {
        clips?: Array<{
          llmScore?: number;
          title?: string;
          hookTagline?: string;
          description?: string;
          hashtags?: string[];
          reason?: string;
        }>;
      };

      if (!Array.isArray(parsed.clips) || parsed.clips.length !== candidates.length) {
        throw new Error('Malformed JSON clip array length');
      }

      data.stats[id].lastSuccessAt = new Date().toISOString();
      data.stats[id].lastError = null;
      data.stats[id].cooldownUntil = null;
      saveRouterData(data);

      return parsed.clips.map((c, idx) => ({
        llmScore: Math.min(1, Math.max(0.2, Number(c.llmScore || 0.75))),
        title: String(c.title || `Peak Moment #${idx + 1}`).slice(0, 90),
        hookTagline: String(c.hookTagline || 'Wait until the final second').slice(0, 110),
        description: String(
          c.description ||
            `Clipped from ${projectTitle}. Watch the key audio spike and reaction moment.`
        ).slice(0, 400),
        hashtags: Array.isArray(c.hashtags)
          ? c.hashtags.slice(0, 6).map((h) => (h.startsWith('#') ? h : `#${h}`))
          : ['#shorts', '#clips', '#highlights'],
        reason: String(c.reason || `${cfg.label} semantic hook match`).slice(0, 140),
        scoredBy: `${cfg.label} (${cfg.model})`,
      }));
    } catch (err) {
      const status = (err as Error & { status?: number }).status || 0;
      const msg = err instanceof Error ? err.message : 'Provider call failed';
      data.stats[id].lastError = msg.slice(0, 120);
      if (isQuotaError(status, msg)) {
        data.stats[id].quotaHits += 1;
        // Put provider in 60-minute cooldown before rotating to next provider
        data.stats[id].cooldownUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      }
      saveRouterData(data);
    }
  }

  return null;
}
