import { Download, Film, Trash2, Youtube } from 'lucide-react';
import type { RenderedClip } from '../types';
import { LAYOUT_OPTIONS } from '../types';

interface RenderQueueViewProps {
  clips: RenderedClip[];
  onDeleteClip: (clipId: string) => void;
  onPublishClip: (clip: RenderedClip) => void;
  onGoToStudio: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function RenderQueueView({
  clips,
  onDeleteClip,
  onPublishClip,
  onGoToStudio,
}: RenderQueueViewProps) {
  if (clips.length === 0) {
    return (
      <div className="bg-[#13161D] border border-[#232834] rounded-xl p-12 text-center space-y-3">
        <Film className="w-7 h-7 text-[#64748B] mx-auto" />
        <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
          No Rendered Vertical Clips Yet
        </h3>
        <p className="text-sm text-[#94A3B8] max-w-md mx-auto">
          Select a viral moment and choose your facecam placement in the Facecam & Layouts studio to render a 9:16 MP4.
        </p>
        <button
          type="button"
          onClick={onGoToStudio}
          className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer"
        >
          Open Facecam & Layouts
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#F4F5F7]">
            Rendered 9:16 Shorts ({clips.length})
          </h2>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            All renders omit burned captions so YouTube auto-captions stay crisp and searchable.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {clips.map((clip) => {
          const layoutMeta = LAYOUT_OPTIONS.find((l) => l.id === clip.layoutId);
          return (
            <article
              key={clip.id}
              className="bg-[#13161D] border border-[#232834] rounded-xl p-4 flex flex-col gap-4"
            >
              <div className="aspect-[9/16] max-h-[380px] mx-auto w-full max-w-[220px] bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
                <video
                  src={clip.downloadUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="space-y-1.5 flex-1">
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-[#94A3B8]">
                  <span>{clip.resolution} · {clip.durationSec}s</span>
                  <span>{formatBytes(clip.fileSizeBytes)}</span>
                </div>
                <h3 className="font-display text-sm font-semibold text-[#F4F5F7] line-clamp-2">
                  {clip.title}
                </h3>
                <p className="text-xs text-[#94A3B8]">
                  Layout: {layoutMeta?.name || clip.layoutId} · {clip.encoderUsed || 'libx264'} · Captions: None
                </p>
                {clip.youtubeVideoId && (
                  <p className="text-xs text-emerald-400 font-mono pt-0.5">
                    YouTube ID: {clip.youtubeVideoId} ({clip.youtubeStatus})
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-[#232834]">
                <a
                  href={`${clip.downloadUrl}?download=1`}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  MP4
                </a>
                <button
                  type="button"
                  onClick={() => onPublishClip(clip)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Youtube className="w-3.5 h-3.5" />
                  YouTube
                </button>
                <button
                  type="button"
                  aria-label="Delete clip"
                  onClick={() => onDeleteClip(clip.id)}
                  className="p-2 text-[#64748B] hover:text-rose-400 border border-[#232834] rounded-lg cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
