import { useEffect, useRef, useState } from 'react';
import {
  Link2,
  Upload,
  Play,
  Scissors,
  ThumbsUp,
  ThumbsDown,
  SlidersHorizontal,
  Plus,
  Trash2,
  RotateCcw,
  Sparkles,
  FileText,
  ArrowRight,
  HardDrive,
  Cpu,
  Power,
  Download,
  Cookie,
} from 'lucide-react';
import type {
  CreatorWatchItem,
  CustomLLMStatus,
  LayoutId,
  LLMRouterState,
  RankingWeights,
  RoutingPriority,
  SystemCapabilities,
  TrainingDatasetStats,
  VideoProject,
  ViralMoment,
} from '../types';
import { LAYOUT_OPTIONS } from '../types';
import { formatTimecode, parseTimecodeInput, pollJobUntilDone } from '../lib/jobs';

interface IngestAnalyzeViewProps {
  capabilities: SystemCapabilities | null;
  projects: VideoProject[];
  activeProject: VideoProject | null;
  selectedMomentId: string | null;
  weights: RankingWeights | null;
  watchlist: CreatorWatchItem[];
  routerState: LLMRouterState | null;
  customLlm: CustomLLMStatus | null;
  trainingStats: TrainingDatasetStats | null;
  onSelectProject: (project: VideoProject) => void;
  onSelectMoment: (moment: ViralMoment) => void;
  onOpenFacecamStudio: (moment: ViralMoment) => void;
  onProjectCreated: (project: VideoProject) => void;
  onProjectUpdated: (project: VideoProject) => void;
  onProjectDeleted: (projectId: string) => void;
  onWeightsUpdated: (weights: RankingWeights) => void;
  onWatchlistUpdated: (items: CreatorWatchItem[]) => void;
  onRouterStateUpdated: (state: LLMRouterState) => void;
  onCustomLlmUpdated: (status: CustomLLMStatus) => void;
  onTrainingStatsUpdated: (stats: TrainingDatasetStats) => void;
}

function formatTime(sec: number): string {
  return formatTimecode(sec);
}

function formatDiskBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function IngestAnalyzeView({
  capabilities,
  projects,
  activeProject,
  selectedMomentId,
  weights,
  watchlist,
  routerState,
  customLlm,
  trainingStats,
  onSelectProject,
  onSelectMoment,
  onOpenFacecamStudio,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted,
  onWeightsUpdated,
  onWatchlistUpdated,
  onRouterStateUpdated,
  onCustomLlmUpdated,
  onTrainingStatsUpdated,
}: IngestAnalyzeViewProps) {
  const [urlInput, setUrlInput] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [transcriptInput, setTranscriptInput] = useState('');
  const [showTranscriptBox, setShowTranscriptBox] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [ingestProgress, setIngestProgress] = useState(0);
  const [ingestStage, setIngestStage] = useState<string>('');
  const [ingestDetail, setIngestDetail] = useState<string>('');
  const [customLlmBusy, setCustomLlmBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live clipping markers & remote-stream segment preview state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [manualTitle, setManualTitle] = useState('');
  const [remotePreviewSrc, setRemotePreviewSrc] = useState<string | null>(null);
  const [remotePreviewOffsetSec, setRemotePreviewOffsetSec] = useState(0);
  const [jumpInput, setJumpInput] = useState('');

  // Optional YouTube cookies.txt state (resolves cloud-IP bot verification cleanly)
  const [showCookiesBox, setShowCookiesBox] = useState(false);
  const [cookiesText, setCookiesText] = useState('');
  const [cookiesStatus, setCookiesStatus] = useState<{
    configured: boolean;
    source: string;
    cookieCount: number;
  } | null>(null);
  const [cookiesBusy, setCookiesBusy] = useState(false);
  const cookiesFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch('/api/ytdlp/cookies/status')
      .then((r) => r.json())
      .then((data) => setCookiesStatus(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setRemotePreviewSrc(null);
    setMarkIn(null);
    if (activeProject?.sourceMode === 'remote-stream' && activeProject.moments[0]) {
      const startOff = Math.max(0, Math.floor(activeProject.moments[0].startSec - 2));
      setRemotePreviewOffsetSec(startOff);
      setCurrentTime(startOff);
    } else {
      setRemotePreviewOffsetSec(0);
      setCurrentTime(0);
    }
  }, [activeProject?.id]);

  const handleUrlIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    setErrorMsg(null);
    setBusyAction('url');
    setIngestProgress(4);
    setIngestStage('Connecting to stream...');
    setIngestDetail('');

    try {
      const res = await fetch('/api/ingest/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.trim(),
          title: customTitle.trim() || undefined,
          transcriptText: transcriptInput.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'URL ingest failed');

      let createdProject = data.project;
      if (data.jobId) {
        const done = await pollJobUntilDone(data.jobId, (job) => {
          setIngestProgress(job.progress);
          setIngestStage(job.stage);
          setIngestDetail(job.detail || '');
        });
        createdProject = done.project;
      }

      if (!createdProject) throw new Error('Ingest finished without returning a project.');
      setIngestProgress(100);
      setRemotePreviewSrc(null);
      setRemotePreviewOffsetSec(0);
      onProjectCreated(createdProject);
      setUrlInput('');
      setCustomTitle('');
    } catch (err) {
      setIngestProgress(0);
      const msg = err instanceof Error ? err.message : 'URL ingest failed';
      setErrorMsg(msg);
      if (msg.toLowerCase().includes('bot verification') || msg.toLowerCase().includes('cookies')) {
        setShowCookiesBox(true);
      }
    } finally {
      setBusyAction(null);
      setIngestStage('');
      setIngestDetail('');
      setTimeout(() => setIngestProgress(0), 400);
    }
  };

  const handleSaveCookies = async (rawText?: string) => {
    const payload = (rawText ?? cookiesText).trim();
    if (!payload) return;
    setCookiesBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/ytdlp/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesText: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save cookies');
      setCookiesStatus(data);
      setCookiesText('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save cookies');
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleClearCookies = async () => {
    setCookiesBusy(true);
    try {
      const res = await fetch('/api/ytdlp/cookies', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) setCookiesStatus(data);
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setBusyAction('upload');
    setIngestProgress(5);
    setIngestStage('Uploading video file...');
    setIngestDetail(file.name);

    try {
      const form = new FormData();
      form.append('video', file);
      if (customTitle.trim()) form.append('title', customTitle.trim());
      if (transcriptInput.trim()) form.append('transcriptText', transcriptInput.trim());
      const res = await fetch('/api/ingest/upload', {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      let createdProject = data.project;
      if (data.jobId) {
        const done = await pollJobUntilDone(data.jobId, (job) => {
          setIngestProgress(job.progress);
          setIngestStage(job.stage);
          setIngestDetail(job.detail || '');
        });
        createdProject = done.project;
      }

      if (!createdProject) throw new Error('Upload finished without returning a project.');
      setIngestProgress(100);
      setRemotePreviewSrc(null);
      setRemotePreviewOffsetSec(0);
      onProjectCreated(createdProject);
      setCustomTitle('');
    } catch (err) {
      setIngestProgress(0);
      setErrorMsg(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusyAction(null);
      setIngestStage('');
      setIngestDetail('');
      setTimeout(() => setIngestProgress(0), 400);
    }
  };

  // Creator watchlist form
  const [watchCreator, setWatchCreator] = useState('');
  const [watchUrl, setWatchUrl] = useState('');
  const [watchPlatform, setWatchPlatform] = useState<'youtube' | 'twitch' | 'kick'>('twitch');
  const [watchLayout, setWatchLayout] = useState<LayoutId>('split-top-cam');

  const handleGenerateSample = async () => {
    setErrorMsg(null);
    setBusyAction('sample');
    try {
      const res = await fetch('/api/ingest/sample', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sample generation failed');
      onProjectCreated(data.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sample generation failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleFeedback = async (momentId: string, feedback: 'up' | 'down') => {
    if (!activeProject) return;
    try {
      const res = await fetch(
        `/api/projects/${activeProject.id}/moments/${momentId}/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        onProjectUpdated(data.project);
        onWeightsUpdated(data.weights);
        if (data.trainingStats) {
          onTrainingStatsUpdated(data.trainingStats);
        }
      }
    } catch {
      // ignore transient error
    }
  };

  const handleCreateManualClip = async (startSec: number, endSec: number) => {
    if (!activeProject) return;
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/moments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startSec,
          endSec,
          title: manualTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add clip marker');
      onProjectUpdated(data.project);
      onSelectMoment(data.moment);
      setMarkIn(null);
      setManualTitle('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to mark clip');
    }
  };

  const handleReanalyzeTranscript = async () => {
    if (!activeProject) return;
    setBusyAction('reanalyze');
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/reanalyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptText: transcriptInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Re-analysis failed');
      onProjectUpdated(data.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Re-analysis failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleResetWeights = async () => {
    const res = await fetch('/api/weights/reset', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.weights) onWeightsUpdated(data.weights);
  };

  const handleAddWatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!watchCreator.trim() || !watchUrl.trim()) return;
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorName: watchCreator.trim(),
        channelUrl: watchUrl.trim(),
        platform: watchPlatform,
        defaultLayoutId: watchLayout,
      }),
    });
    const data = await res.json();
    if (res.ok && data.watchlist) {
      onWatchlistUpdated(data.watchlist);
      setWatchCreator('');
      setWatchUrl('');
    }
  };

  const handleRemoveWatch = async (id: string) => {
    const res = await fetch(`/api/watchlist/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.watchlist) onWatchlistUpdated(data.watchlist);
  };

  const seekVideoTo = (sec: number, momentId?: string) => {
    if (!activeProject) return;
    if (activeProject.sourceMode === 'remote-stream') {
      const targetOffset = Math.max(0, Math.floor(sec - (momentId ? 2 : 0)));
      const src = momentId
        ? `/api/projects/${activeProject.id}/moments/${momentId}/preview`
        : `/api/projects/${activeProject.id}/preview-window?start=${targetOffset}&dur=45`;
      setRemotePreviewOffsetSec(targetOffset);
      setRemotePreviewSrc(src);
      setCurrentTime(targetOffset);
      return;
    }
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      videoRef.current.play().catch(() => {});
    }
  };

  return (
    <div className="space-y-8">
      {/* Ingest Source Panel */}
      <section className="bg-[#13161D] border border-[#232834] rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-[#F4F5F7]">
              Ingest Long-Form Video or Stream Link
            </h2>
            <p className="text-sm text-[#94A3B8] mt-1">
              Paste a YouTube, Twitch, or Kick URL, upload a local MP4/MOV/WebM file, or synthesize a test stream with FFmpeg.
            </p>
          </div>
          <button
            type="button"
            onClick={handleGenerateSample}
            disabled={busyAction !== null}
            className="px-4 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            {busyAction === 'sample' ? 'Synthesizing FFmpeg Stream...' : 'Generate Sample Stream'}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          {/* URL Ingest Form */}
          <form onSubmit={handleUrlIngest} className="lg:col-span-7 flex flex-col justify-between gap-3 bg-[#0E1016] border border-[#232834] rounded-lg p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                <span className="font-medium text-[#CBD5E1]">Stream or Direct Video URL</span>
                <span>
                  YouTube · Twitch · Kick · Direct MP4
                </span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2.5">
                <div className="relative flex-1">
                  <Link2 className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder="https://www.twitch.tv/videos/... or https://youtube.com/watch?v=..."
                    className="w-full pl-9 pr-3 py-2.5 text-sm bg-[#13161D] border border-[#232834] focus:border-rose-500 rounded-lg text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busyAction !== null || !urlInput.trim()}
                  className="px-4 py-2.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  {busyAction === 'url' ? 'Downloading & Probing...' : 'Fetch & Analyze'}
                </button>

                {busyAction === 'url' && (
                  <div className="w-full sm:w-44 flex flex-col gap-1 justify-center">
                    <div className="w-full h-1.5 bg-[#13161D] rounded-full overflow-hidden border border-[#232834]">
                      <div
                        className="h-full bg-rose-500 transition-all duration-300"
                        style={{ width: `${ingestProgress}%` }}
                      />
                    </div>
                    <p className="text-[10px] font-mono text-[#94A3B8] truncate">
                      {ingestProgress}% {ingestStage ? `· ${ingestStage}` : ''}
                    </p>
                    {ingestDetail && (
                      <p className="text-[10px] font-mono text-[#64748B] truncate">{ingestDetail}</p>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Optional project title override"
                  className="flex-1 min-w-[200px] px-3 py-1.5 text-xs bg-[#13161D] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowTranscriptBox((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#F4F5F7] cursor-pointer whitespace-nowrap"
                >
                  <FileText className="w-3.5 h-3.5" />
                  {showTranscriptBox ? 'Hide Transcript / SRT' : 'Attach Transcript / SRT'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCookiesBox((v) => !v)}
                  className={`inline-flex items-center gap-1.5 text-xs cursor-pointer whitespace-nowrap ${
                    cookiesStatus?.configured
                      ? 'text-emerald-400 hover:text-emerald-300'
                      : 'text-[#94A3B8] hover:text-[#F4F5F7]'
                  }`}
                >
                  <Cookie className="w-3.5 h-3.5" />
                  {cookiesStatus?.configured
                    ? `YouTube Cookies (${cookiesStatus.cookieCount})`
                    : showCookiesBox
                      ? 'Hide YouTube Cookies'
                      : 'YouTube Cookies'}
                </button>
              </div>
            </div>

            <p className="text-xs text-[#64748B] mt-1">
              {capabilities?.ytdlp
                ? 'Stream extractor ready — long VODs (up to 50+ hours) probe and render directly over remote segments without filling disk.'
                : 'YouTube, Twitch & Kick links auto-bootstrap yt-dlp on first fetch — long VODs stream on-demand without full multi-GB download.'}
            </p>
          </form>

          {/* Local File Upload Dropzone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) handleFileUpload(file);
            }}
            className="lg:col-span-5 flex flex-col items-center justify-center text-center bg-[#0E1016] border border-dashed border-[#32394A] hover:border-rose-500/70 rounded-lg p-5 transition-colors"
          >
            <Upload className="w-6 h-6 text-[#94A3B8] mb-2" />
            <p className="text-sm font-medium text-[#F4F5F7]">
              {busyAction === 'upload' ? 'Uploading & Running FFmpeg Analysis...' : 'Drop local MP4, MOV, MKV, or WebM'}
            </p>

            {busyAction === 'upload' && (
              <div className="w-full max-w-[220px] flex flex-col gap-1 mt-2">
                <div className="w-full h-1.5 bg-[#13161D] rounded-full overflow-hidden border border-[#232834]">
                  <div
                    className="h-full bg-rose-500 transition-all duration-300"
                    style={{ width: `${ingestProgress}%` }}
                  />
                </div>
                <p className="text-[10px] font-mono text-[#94A3B8] mt-1 truncate">
                  {ingestProgress}% {ingestStage ? `· ${ingestStage}` : ''}
                </p>
              </div>
            )}

              <p className="text-xs text-[#64748B] mt-1 mb-3">
                Stays 100% local in workspace/sources · Up to 100 GB
              </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
              }}
            />
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
            >
              Choose Local Video
            </button>
          </div>
        </div>

        {showTranscriptBox && (
          <div className="mt-4 pt-4 border-t border-[#232834] space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[#CBD5E1]">
                Optional Transcript or SRT/VTT (scored for hooks locally — never burned into video)
              </label>
              {activeProject && (
                <button
                  type="button"
                  onClick={handleReanalyzeTranscript}
                  disabled={busyAction !== null}
                  className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer"
                >
                  {busyAction === 'reanalyze' ? 'Re-scoring...' : 'Re-score Active Project'}
                </button>
              )}
            </div>
            <textarea
              rows={3}
              value={transcriptInput}
              onChange={(e) => setTranscriptInput(e.target.value)}
              placeholder="Paste .srt cues or raw speech transcript for hook keyword + local Ollama scoring..."
              className="w-full p-3 text-xs font-mono bg-[#0E1016] border border-[#232834] rounded-lg text-[#F4F5F7] placeholder:text-[#64748B] outline-none focus:border-rose-500"
            />
          </div>
        )}

        {showCookiesBox && (
          <div className="mt-4 pt-4 border-t border-[#232834] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-[#CBD5E1]">
                  YouTube Bot-Verification Cookies (Netscape cookies.txt or Cookie header)
                </p>
                <p className="text-[11px] text-[#94A3B8] mt-0.5">
                  Cloud container IPs trigger YouTube bot verification. Export cookies.txt from a logged-in browser (e.g. “Get cookies.txt LOCALLY”) and upload or paste once. Stored server-side in workspace/ytdlp_cookies.txt.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={cookiesFileRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const txt = await file.text();
                    await handleSaveCookies(txt);
                  }}
                />
                <button
                  type="button"
                  disabled={cookiesBusy}
                  onClick={() => cookiesFileRef.current?.click()}
                  className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer"
                >
                  Upload cookies.txt
                </button>
                {cookiesStatus?.configured && cookiesStatus.source === 'workspace' && (
                  <button
                    type="button"
                    disabled={cookiesBusy}
                    onClick={handleClearCookies}
                    className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-rose-950/60 border border-[#32394A] hover:border-rose-700 rounded-md text-rose-300 cursor-pointer"
                  >
                    Clear Saved
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <textarea
                rows={3}
                value={cookiesText}
                onChange={(e) => setCookiesText(e.target.value)}
                placeholder="# Netscape HTTP Cookie File&#10;.youtube.com&#9;TRUE&#9;/&#9;TRUE&#9;...&#10;(or paste raw Cookie header string)"
                className="flex-1 p-2.5 text-xs font-mono bg-[#0E1016] border border-[#232834] rounded-lg text-[#F4F5F7] placeholder:text-[#64748B] outline-none focus:border-rose-500"
              />
              <button
                type="button"
                disabled={cookiesBusy || !cookiesText.trim()}
                onClick={() => handleSaveCookies()}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer disabled:opacity-50 self-end sm:self-stretch"
              >
                {cookiesBusy ? 'Saving...' : 'Save Cookies'}
              </button>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="mt-4 px-4 py-3 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
            {errorMsg}
          </div>
        )}
      </section>

      {/* Source Projects Strip */}
      {projects.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-[#CBD5E1]">
              Analyzed Source Videos ({projects.length})
            </h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {projects.map((p) => {
              const isSelected = activeProject?.id === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => onSelectProject(p)}
                  className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#171B24] border-rose-500/80'
                      : 'bg-[#13161D] border-[#232834] hover:border-[#343C4E]'
                  }`}
                >
                  <div className="w-24 h-14 bg-[#0B0D11] rounded-md overflow-hidden shrink-0 border border-[#232834]">
                    {p.previewFrames[0] ? (
                      <img
                        src={p.previewFrames[0]}
                        alt={p.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-[#64748B]">
                        No frame
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[#F4F5F7] truncate">{p.title}</p>
                    <p className="text-xs text-[#94A3B8] font-mono tabular-nums mt-0.5 truncate">
                      {p.sourceType.toUpperCase()} · {formatTime(p.durationSec)} · {p.width}×{p.height} · {p.moments.length} clips
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      onProjectDeleted(p.id);
                    }}
                    className="p-1.5 text-[#64748B] hover:text-rose-400 rounded-md cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Active Project Player, Audio Spike Waveform & Viral Moments */}
      {activeProject ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left: Video Scrub + Audio Energy Spike Graph + Live Clipping Controls */}
          <div className="xl:col-span-6 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-[#F4F5F7] truncate">
                  {activeProject.title}
                </h3>
                <p className="text-xs text-[#94A3B8] font-mono tabular-nums mt-0.5">
                  {activeProject.width}×{activeProject.height} · {activeProject.fps} fps · Facecam: {activeProject.detectedFacecam.presetLabel}
                  {activeProject.sourceSizeBytes ? ` · ${formatDiskBytes(activeProject.sourceSizeBytes)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {!activeProject.sourceDeleted && activeProject.sourceMode !== 'remote-stream' && (
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await fetch(`/api/projects/${activeProject.id}/cleanup-source`, {
                        method: 'POST',
                      });
                      const data = await res.json();
                      if (res.ok && data.project) onProjectUpdated(data.project);
                    }}
                    title="Delete large source VOD from disk after rendering Shorts (keeps frames & rendered clips)"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#CBD5E1] cursor-pointer whitespace-nowrap"
                  >
                    <HardDrive className="w-3.5 h-3.5 text-amber-400" />
                    Prune Source
                  </button>
                )}
                {activeProject.sourceMode === 'remote-stream' && (
                  <span className="px-2 py-0.5 text-[10px] font-mono uppercase bg-[#1C212C] border border-[#32394A] rounded text-emerald-400">
                    Remote Stream
                  </span>
                )}
                <span className="text-xs font-mono tabular-nums text-[#CBD5E1]">
                  {formatTime(currentTime)} / {formatTime(activeProject.durationSec)}
                </span>
              </div>
            </div>

            {activeProject.sourceDeleted ? (
              <div className="aspect-video bg-[#0E1016] rounded-lg border border-[#232834] flex flex-col items-center justify-center p-6 text-center space-y-2">
                <HardDrive className="w-6 h-6 text-[#64748B]" />
                <p className="text-sm font-medium text-[#CBD5E1]">Source VOD Pruned to Save Disk Space</p>
                <p className="text-xs text-[#94A3B8] max-w-sm">
                  Your extracted keyframes, audio energy timeline, and already-rendered 9:16 Shorts remain available.
                </p>
              </div>
            ) : activeProject.sourceMode === 'remote-stream' ? (
              <div className="space-y-2">
                <div className="aspect-video bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
                  {remotePreviewSrc || activeProject.moments[0] ? (
                    <video
                      ref={videoRef}
                      key={
                        remotePreviewSrc ||
                        `/api/projects/${activeProject.id}/moments/${activeProject.moments[0].id}/preview`
                      }
                      src={
                        remotePreviewSrc ||
                        `/api/projects/${activeProject.id}/moments/${activeProject.moments[0].id}/preview`
                      }
                      controls
                      onTimeUpdate={(e) =>
                        setCurrentTime(remotePreviewOffsetSec + e.currentTarget.currentTime)
                      }
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-[#64748B]">
                      Click any moment or jump to a timestamp to preview
                    </div>
                  )}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const parsed = parseTimecodeInput(jumpInput);
                    if (parsed !== null) {
                      seekVideoTo(Math.min(Math.max(0, activeProject.durationSec - 10), parsed));
                    }
                  }}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    type="text"
                    value={jumpInput}
                    onChange={(e) => setJumpInput(e.target.value)}
                    placeholder={`Jump to timestamp (e.g. 24:15:00 or 1200)`}
                    className="flex-1 px-2.5 py-1 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] font-mono outline-none focus:border-rose-500"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1 bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer whitespace-nowrap"
                  >
                    Load 45s Window
                  </button>
                </form>
              </div>
            ) : (
              <div className="aspect-video bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
                <video
                  ref={videoRef}
                  key={activeProject.fileName}
                  src={`/api/sources/${activeProject.fileName}`}
                  controls
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  className="w-full h-full object-contain"
                />
              </div>
            )}

            {/* Audio RMS Energy Curve */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                <span>Audio RMS Energy Spikes (click bar to seek)</span>
                <span className="font-mono tabular-nums">
                  Peak:{' '}
                  {activeProject.audioEnergySeries
                    .reduce((acc, p) => (p.db > acc ? p.db : acc), -60)
                    .toFixed(1)}{' '}
                  dB
                </span>
              </div>
              <div className="h-20 bg-[#0E1016] border border-[#232834] rounded-lg px-2 py-2 flex items-end gap-[2px] overflow-hidden">
                {activeProject.audioEnergySeries.map((pt) => {
                  const inSelected = activeProject.moments.some(
                    (m) =>
                      m.id === selectedMomentId && pt.sec >= m.startSec && pt.sec <= m.endSec
                  );
                  const isSpike = pt.normalized >= 0.72;
                  return (
                    <button
                      key={pt.sec}
                      type="button"
                      title={`${formatTime(pt.sec)} · ${pt.db} dB`}
                      onClick={() => seekVideoTo(pt.sec)}
                      style={{ height: `${Math.max(12, Math.round(pt.normalized * 100))}%` }}
                      className={`flex-1 min-w-[3px] rounded-t-[2px] transition-opacity cursor-pointer ${
                        inSelected
                          ? 'bg-rose-500'
                          : isSpike
                            ? 'bg-amber-500/85 hover:bg-amber-400'
                            : 'bg-[#333C4D] hover:bg-[#4B576E]'
                      }`}
                    />
                  );
                })}
              </div>
            </div>

            {/* Live Clipping / Manual Override Controls */}
            <div className="pt-3 border-t border-[#232834] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-[#CBD5E1]">
                  Live Clipping & Manual Override
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMarkIn(Math.round(currentTime * 10) / 10)}
                    className="px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer whitespace-nowrap"
                  >
                    {markIn !== null ? `In: ${markIn.toFixed(1)}s` : 'Mark In'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const start = markIn !== null ? Math.min(markIn, currentTime) : Math.max(0, currentTime - 10);
                      const end = Math.max(start + 3, currentTime);
                      handleCreateManualClip(start, end);
                    }}
                    className="px-2.5 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white rounded-md cursor-pointer whitespace-nowrap"
                  >
                    {markIn !== null ? 'Mark Out & Save Clip' : 'Quick Clip Last 10s'}
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Optional manual clip title before marking out..."
                className="w-full px-3 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
              />
            </div>
          </div>

          {/* Right: Ranked Viral Moments List */}
          <div className="xl:col-span-6 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
                  Detected Viral Moments
                </h3>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Ranked by audio spikes, transcript hooks{capabilities?.ollama.available ? ', and local Ollama' : ''}. Thumbs up/down trains your ranking weights.
                </p>
              </div>
            </div>

            <div className="divide-y divide-[#232834]">
              {activeProject.moments.map((moment, idx) => {
                const isSelected = selectedMomentId === moment.id;
                return (
                  <div
                    key={moment.id}
                    onClick={() => {
                      onSelectMoment(moment);
                      seekVideoTo(moment.startSec, moment.id);
                    }}
                    className={`py-4 first:pt-1 last:pb-1 px-3 -mx-3 rounded-lg transition-colors cursor-pointer ${
                      isSelected ? 'bg-[#191E29]' : 'hover:bg-[#171B24]/60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-[#94A3B8]">
                          <span className="text-rose-400 font-semibold">#{idx + 1}</span>
                          <span>{formatTime(moment.startSec)} – {formatTime(moment.endSec)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{moment.durationSec}s</span>
                          <span aria-hidden="true">·</span>
                          <span>{moment.audioPeakDb} dB</span>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#CBD5E1]">Rank {(moment.finalRankScore * 100).toFixed(0)}</span>
                        </div>
                        <p className="text-sm font-semibold text-[#F4F5F7] mt-1">
                          {moment.title}
                        </p>
                        <p className="text-xs text-[#94A3B8] mt-1">
                          {moment.reason}
                          {moment.scoredBy ? ` · ${moment.scoredBy}` : ''}
                        </p>
                        {moment.transcriptSnippet && (
                          <p className="text-xs text-[#CBD5E1] italic mt-1.5 line-clamp-2">
                            “{moment.transcriptSnippet}”
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          title="Boost similar moments in learned weights"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFeedback(moment.id, 'up');
                          }}
                          className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                            moment.feedback === 'up'
                              ? 'bg-emerald-950/60 border-emerald-600 text-emerald-400'
                              : 'border-[#232834] text-[#94A3B8] hover:text-[#F4F5F7]'
                          }`}
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Downrank similar moments in learned weights"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleFeedback(moment.id, 'down');
                          }}
                          className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                            moment.feedback === 'down'
                              ? 'bg-rose-950/60 border-rose-600 text-rose-400'
                              : 'border-[#232834] text-[#94A3B8] hover:text-[#F4F5F7]'
                          }`}
                        >
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectMoment(moment);
                          seekVideoTo(moment.startSec, moment.id);
                        }}
                        className="inline-flex items-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#F4F5F7] cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5" />
                        Preview Segment
                      </button>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFacecamStudio(moment);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white rounded-md transition-colors cursor-pointer whitespace-nowrap"
                      >
                        <Scissors className="w-3.5 h-3.5" />
                        Fix Facecam & Render
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#13161D] border border-[#232834] rounded-xl p-10 text-center space-y-3">
          <Sparkles className="w-7 h-7 text-rose-500 mx-auto" />
          <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
            No Video Loaded Yet
          </h3>
          <p className="text-sm text-[#94A3B8] max-w-md mx-auto">
            Upload a local MP4 stream, paste a video link, or click “Generate Sample Stream” above to test real FFmpeg audio-spike analysis and facecam layout detection immediately.
          </p>
        </div>
      )}

      {/* Learned Ranking Weights + Creator Auto-Clipping Watchlist */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-5 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-rose-400" />
              <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                Learned Ranking Weights
              </h3>
            </div>
            <button
              type="button"
              onClick={handleResetWeights}
              className="inline-flex items-center gap-1 text-xs text-[#94A3B8] hover:text-[#F4F5F7] cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
          </div>
          {weights && (
            <div className="space-y-2.5 text-xs">
              {[
                { label: 'Audio RMS Spike', val: weights.audioSpikeWeight },
                { label: 'Transcript Hook', val: weights.transcriptHookWeight },
                { label: 'Pacing Density', val: weights.pacingDensityWeight },
                { label: 'Shorts Duration Fit', val: weights.durationSweetSpotWeight },
                { label: 'Local LLM (Ollama)', val: weights.llmSemanticWeight },
              ].map((row) => (
                <div key={row.label} className="space-y-1">
                  <div className="flex items-center justify-between text-[#CBD5E1]">
                    <span>{row.label}</span>
                    <span className="font-mono tabular-nums">{(row.val * 100).toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 bg-[#0E1016] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-rose-500 rounded-full transition-all"
                      style={{ width: `${Math.round(row.val * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-[#64748B] pt-1 font-mono tabular-nums">
                Feedback updates applied: {weights.feedbackCount}
              </p>
            </div>
          )}
        </section>

        <section className="lg:col-span-7 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
          <div>
            <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
              Creator Auto-Clipping Watchlist
            </h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Save favorite Kick, Twitch, or YouTube channels with preferred facecam layout presets.
            </p>
          </div>
          <form onSubmit={handleAddWatch} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
            <input
              type="text"
              value={watchCreator}
              onChange={(e) => setWatchCreator(e.target.value)}
              placeholder="Creator name"
              className="sm:col-span-3 px-2.5 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
            />
            <select
              value={watchPlatform}
              onChange={(e) => setWatchPlatform(e.target.value as 'youtube' | 'twitch' | 'kick')}
              className="sm:col-span-2 px-2 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
            >
              <option value="twitch">Twitch</option>
              <option value="kick">Kick</option>
              <option value="youtube">YouTube</option>
            </select>
            <input
              type="url"
              value={watchUrl}
              onChange={(e) => setWatchUrl(e.target.value)}
              placeholder="https://kick.com/creator"
              className="sm:col-span-4 px-2.5 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
            />
            <select
              value={watchLayout}
              onChange={(e) => setWatchLayout(e.target.value as LayoutId)}
              className="sm:col-span-2 px-2 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
            >
              {LAYOUT_OPTIONS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.shortLabel}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="sm:col-span-1 flex items-center justify-center py-1.5 bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer"
              title="Add creator"
            >
              <Plus className="w-4 h-4" />
            </button>
          </form>

          {watchlist.length > 0 ? (
            <div className="divide-y divide-[#232834]">
              {watchlist.map((w) => (
                <div key={w.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <span className="font-medium text-[#F4F5F7]">{w.creatorName}</span>
                    <span className="text-[#64748B] mx-2">·</span>
                    <span className="text-[#94A3B8] uppercase">{w.platform}</span>
                    <span className="text-[#64748B] mx-2">·</span>
                    <span className="text-[#94A3B8] font-mono">{w.defaultLayoutId}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setUrlInput(w.channelUrl)}
                      className="text-rose-400 hover:text-rose-300 cursor-pointer"
                    >
                      Load URL
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveWatch(w.id)}
                      className="text-[#64748B] hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[#64748B]">
              No creator channels saved yet. Add a Twitch, Kick, or YouTube channel above for one-click loading.
            </p>
          )}
        </section>
      </div>

      {/* Multi-Provider Quota-Aware LLM Router & Hardware Encoder */}
      {routerState && (
        <section className="bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-rose-400" />
              <div>
                <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                  Multi-Provider AI Quota Router & Hardware Acceleration
                </h3>
                <p className="text-xs text-[#94A3B8]">
                  Automatically rotates across configured APIs on 429 quota limits and falls back to Local Ollama (4 GB VRAM friendly) + Heuristics.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 p-1 bg-[#0E1016] border border-[#232834] rounded-lg text-xs">
                {(['cloud-first', 'local-first'] as RoutingPriority[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={async () => {
                      const res = await fetch('/api/llm-router/priority', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ priority: mode }),
                      });
                      const data = await res.json();
                      if (res.ok) onRouterStateUpdated(data);
                    }}
                    className={`px-3 py-1 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      routerState.priority === mode
                        ? 'bg-[#1C212C] text-[#F4F5F7]'
                        : 'text-[#94A3B8] hover:text-[#F4F5F7]'
                    }`}
                  >
                    {mode === 'cloud-first' ? 'Cloud Quota → Ollama' : 'Ollama First → Cloud'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={async () => {
                  const res = await fetch('/api/llm-router/reset-cooldowns', { method: 'POST' });
                  const data = await res.json();
                  if (res.ok) onRouterStateUpdated(data);
                }}
                className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer whitespace-nowrap"
              >
                Clear Cooldowns
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {routerState.providers.map((prov, index) => (
              <div
                key={prov.id}
                className="bg-[#0E1016] border border-[#232834] rounded-lg p-3 space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono text-[#64748B]">#{index + 1}</span>
                  <span
                    className={`font-mono text-[11px] ${
                      prov.cooldownUntil
                        ? 'text-amber-400'
                        : prov.configured
                          ? 'text-emerald-400'
                          : 'text-[#64748B]'
                    }`}
                  >
                    {prov.cooldownUntil ? 'Cooldown' : prov.configured ? 'Ready' : 'Env Unset'}
                  </span>
                </div>
                <div className="text-xs font-semibold text-[#F4F5F7] truncate">{prov.label}</div>
                <div className="text-[11px] font-mono text-[#94A3B8] truncate">{prov.model}</div>
                {prov.quotaHits > 0 && (
                  <div className="text-[10px] font-mono text-amber-400/90 tabular-nums">
                    429 rotations: {prov.quotaHits}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ClipForge Custom LLM Engine & QLoRA Training Dataset */}
          <div className="pt-4 border-t border-[#232834] flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-[#F4F5F7]">
                  ClipForge Custom LLM Server
                </span>
                <span className="text-[#475569]">·</span>
                <span className={customLlm?.running ? 'font-mono text-emerald-400' : 'font-mono text-[#94A3B8]'}>
                  {customLlm?.running
                    ? `Running (${customLlm.backendMode || 'trainable-viral-classifier'})`
                    : 'Stopped'}
                </span>
                <span className="text-[#475569]">·</span>
                <span className="font-mono text-[#64748B]">
                  {customLlm?.url || 'http://127.0.0.1:8000'}
                </span>
              </div>
              <p className="text-xs text-[#94A3B8] font-mono tabular-nums">
                Training Dataset: {trainingStats?.total ?? 0} samples ({trainingStats?.positive ?? 0} positive · {trainingStats?.negative ?? 0} negative)
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={customLlmBusy}
                onClick={async () => {
                  setCustomLlmBusy(true);
                  setErrorMsg(null);
                  try {
                    const endpoint = customLlm?.running
                      ? '/api/custom-llm/stop'
                      : '/api/custom-llm/start';
                    const res = await fetch(endpoint, { method: 'POST' });
                    const data = await res.json();
                    if (!res.ok) {
                      throw new Error(data.error || 'Custom LLM toggle failed');
                    }
                    if (data.customLlm) onCustomLlmUpdated(data.customLlm);
                    if (data.routerState) onRouterStateUpdated(data.routerState);
                  } catch (err) {
                    setErrorMsg(err instanceof Error ? err.message : 'Custom LLM action failed');
                  } finally {
                    setCustomLlmBusy(false);
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                  customLlm?.running
                    ? 'bg-[#1C212C] hover:bg-[#252B39] border-[#32394A] text-[#F4F5F7]'
                    : 'bg-rose-600 hover:bg-rose-500 border-rose-600 text-white'
                }`}
              >
                <Power className="w-3.5 h-3.5" />
                {customLlmBusy
                  ? customLlm?.running
                    ? 'Stopping...'
                    : 'Starting...'
                  : customLlm?.running
                    ? 'Stop Custom LLM'
                    : 'Start Custom LLM'}
              </button>

              <a
                href="/api/training/export"
                download="clipforge-training-dataset.jsonl"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Export JSONL
              </a>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
