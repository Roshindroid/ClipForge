# ClipForge — Local Open-Source Stream & Video Clip Engine

ClipForge extracts viral moments from short clips or 50-hour+ streams/VODs via audio spike analysis, YouTube heatmaps, and multi-provider LLM scoring, detects facecam regions, renders captionless 9:16 YouTube Shorts across 11 layouts, and uploads directly to YouTube.

## Features

- **Ingest (Up to 50-Hour+ Streams & 100 GB Local Files)**:
  - Local MP4/MOV/MKV/WebM uploads (up to 100 GB via disk streaming)
  - YouTube, Twitch, Kick URLs (auto-bootstraps standalone `yt-dlp` into `workspace/bin/yt-dlp` if not on `PATH`), direct media/HLS (`.mp4`, `.webm`, `.mov`, `.mkv`, `.m3u8`) URLs, and FFmpeg-generated test streams
  - **Remote-Stream Mode (`remote-stream`)**: Videos longer than 7 minutes (including 50-hour+ VODs) are probed, scanned, previewed, and clipped directly via HTTP range / remote segments without downloading multi-GB files to disk
- **Viral Moment Detection**:
  - Streaming O(1)-memory PCM RMS calculation for short videos and stratified multi-window FFmpeg probing + YouTube Most-Replayed heatmap & chapter analysis for multi-hour VODs (returns up to 8 spread-out highlights for ≥1h videos, 4 otherwise)
  - Transcript/SRT hook keyword scoring + multi-provider LLM semantic scoring
- **On-Demand 50-Hour Preview & Live Clipping**:
  - Serves cached 45-second preview slices (`/api/projects/:id/moments/:momentId/preview` and `/api/projects/:id/preview-window`) with a `HH:MM:SS` timestamp jump bar and global-timecode Mark In / Mark Out controls
- **Facecam Detection & 11 Vertical Layouts**:
  - FFmpeg `signalstats` probing of 5 corner regions plus interactive drag-and-resize facecam box
  - 11 layout presets (splits, picture-in-picture, blurred-bg, center-crop, facecam-zoom) rendered at 720×1280 H.264 MP4 (`h264_nvenc` GPU when available, `libx264` CPU fallback)
- **Templates & Clean Subtitles**:
  - Optional X Post, TikTok Hook, and Breaking News header overlays — intentionally no burned captions (relies on YouTube auto-captions)
- **Async Background Jobs**:
  - Non-blocking `/api/jobs/:id` polling for URL ingest, file uploads, and 9:16 renders with real stage and percentage progress
- **YouTube Bot-Verification Cookies**:
  - Supports in-app Netscape `cookies.txt` upload/paste (saved server-side to `workspace/ytdlp_cookies.txt`), `YTDLP_COOKIES_FILE`, or desktop `YTDLP_COOKIES_FROM_BROWSER`
- **YouTube Publishing**:
  - Firebase Google sign-in + YouTube Data API v3 resumable upload with scheduling, privacy control, and hashtags
- **Multi-Provider LLM Router & Custom LLM**:
  - Quota-aware rotation across Custom LLM, Gemini, Groq, OpenRouter, and local Ollama with 60-minute cooldowns on `429` limits
  - Python OpenAI-compatible server (`custom_llm/server.py`) with trainable Naive Bayes viral classifier fed by Thumbs Up / Down feedback, plus optional `llama.cpp` GGUF or Ollama backend
- **Creator Watchlist**:
  - Save Twitch/Kick/YouTube channels with preferred facecam layout for one-click loading

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Vite 8, Motion, Lucide React
- **Backend**: Express.js + TypeScript (`tsx`)
- **Video & Stream Extraction**: FFmpeg / ffprobe + `yt-dlp` (system binary or auto-bootstrapped standalone zipapp)
- **Storage**: Local JSON files & media workspace under `workspace/` (projects, clips, weights, watchlist, training data)
- **Auth**: Firebase + YouTube Data API v3

## Project Structure

```
ClipForge/
├── server.ts                    # Express server — API routes, job polling, segment previews
├── vite.config.ts               # Vite + Tailwind + React plugin
├── package.json                 # Node dependencies & scripts
├── requirements.txt             # Optional Python ML / yt-dlp dependencies
├── .env.example                 # Environment variable template
├── firebase-applet-config.json  # Firebase config (Google OAuth for YouTube)
├── server/                      # Backend modules
│   ├── analyzer.ts              # Streaming RMS, stratified 50h probing, facecam & viral scoring
│   ├── capabilities.ts          # ffmpeg/ffprobe/nvenc/yt-dlp/ollama availability checks
│   ├── customLlmManager.ts      # Spawns/stops Python custom LLM server (:8000)
│   ├── ingest.ts                # URL ingest (remote-stream & local), direct streaming, sample VOD
│   ├── jobs.ts                  # In-memory background job queue & progress tracker
│   ├── llmRouter.ts             # Multi-provider LLM router with quota cooldowns
│   ├── renderer.ts              # FFmpeg filter graphs for 11 layouts + remote segment rendering
│   ├── storage.ts               # JSON file CRUD, workspace cleanup & path traversal protection
│   ├── training.ts              # NDJSON training dataset + stats
│   ├── weights.ts               # Feedback-driven ranking weight adjustment
│   └── ytdlp.ts                 # Auto-bootstrapped yt-dlp, cookie store & stream URL resolver
├── src/                         # React frontend
│   ├── main.tsx, App.tsx        # App shell with 4 tabs: ingest, facecam, queue, youtube
│   ├── types.ts                 # Shared TS types, JobStatus & 11 LAYOUT_OPTIONS metadata
│   ├── index.css                # Tailwind + theme
│   ├── lib/
│   │   ├── jobs.ts              # Async job poller & HH:MM:SS timecode helpers
│   │   └── youtubeAuth.ts       # Firebase Google sign-in + YouTube resumable upload
│   └── components/
│       ├── IngestAnalyzeView.tsx     # Upload/URL/cookies/sample ingest, waveform, moments, weights
│       ├── FacecamLayoutStudio.tsx   # Interactive facecam box, 11 layouts, templates, render
│       ├── RenderQueueView.tsx       # Clip gallery, download, publish to YouTube
│       ├── YouTubePublishView.tsx    # Metadata composer, Google sign-in, resumable upload
│       └── LayoutThumbnail.tsx       # SVG wireframe previews per layout
├── custom_llm/                  # Python OpenAI-compatible inference server (:8000)
│   ├── server.py                # Trainable Naive Bayes viral classifier + llama.cpp/Ollama fallback
│   ├── finetune_lora.py         # 4-bit QLoRA fine-tuning for GTX 1650 (4 GB VRAM)
│   ├── Modelfile                # Ollama Modelfile for clipforge-viral:3b
│   ├── requirements.txt         # Optional fine-tuning dependencies
│   └── README.md                # Custom LLM documentation
└── workspace/                   # Runtime data (gitignored: sources, frames, renders, cookies, JSON)
```

## Quick Start

### 1. Install system dependencies

ClipForge requires **FFmpeg** and **ffprobe** on `PATH` (plus **Python 3** if running `custom_llm/server.py` or the standalone `yt-dlp` zipapp).

- **Windows**: `winget install ffmpeg`
- **macOS**: `brew install ffmpeg yt-dlp`
- **Linux**: `sudo apt install ffmpeg python3`

`yt-dlp` is optional to install globally — if missing from `PATH`, ClipForge automatically downloads the official standalone `yt-dlp` zipapp to `workspace/bin/yt-dlp` on startup/first URL ingest (or install manually via `pip install yt-dlp`).

### 2. Install Node dependencies

```bash
npm install
```

### 3. Configure environment

Copy `.env.example` to `.env` and fill in any optional LLM keys or `yt-dlp` settings:

```env
# Optional Cloud LLM keys (multi-provider quota router)
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=

# Optional Local Ollama / Custom LLM
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b
CUSTOM_LLM_URL=
CUSTOM_LLM_MODEL=
CUSTOM_LLM_KEY=

# yt-dlp JavaScript runtime for YouTube extraction (defaults to node)
YTDLP_JS_RUNTIME=node

# YouTube cookies (use ONE of these if YouTube requests bot verification):
# Option A (Recommended for cloud/headless): Upload cookies.txt in the Ingest UI ("YouTube Cookies")
# Option B (Server file path):
YTDLP_COOKIES_FILE=
# Option C (Local desktop browser profile only):
YTDLP_COOKIES_FROM_BROWSER=
```

### 4. Run the dev server

```bash
npm run dev
```

Server listens on `http://0.0.0.0:3000`.

### 5. Optional: Start the Custom LLM server

You can toggle it directly from the **Ingest & Analyze** UI, or run it manually:

```bash
python3 custom_llm/server.py
```

See `custom_llm/README.md` for Ollama and 4-bit QLoRA fine-tuning setup.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Express + Vite dev server on port 3000 (`0.0.0.0`) |
| `npm run build` | Build production frontend into `dist/` |
| `npm run start` | Production server start (`node server.ts`) |
| `npm run preview` | Preview production Vite build |
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm run clean` | Remove `dist/` and `server.js` |

## Notes

- YouTube OAuth tokens are kept in browser memory only (never persisted to `localStorage`).
- Uploaded YouTube `cookies.txt` files are stored server-side at `workspace/ytdlp_cookies.txt` (`0600`), gitignored with `workspace/`, and never returned over API responses.
- No burned captions are ever rendered into videos — YouTube auto-captions handle subtitles.
- `firebase-applet-config.json` contains public Firebase Web SDK configuration for the Google Sign-In flow.
