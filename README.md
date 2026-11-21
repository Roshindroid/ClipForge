# ClipForge — Local Open-Source Stream & Video Clip Engine

ClipForge extracts viral moments from long-form streams/VODs via audio spike analysis and local LLM scoring, detects facecam regions, renders captionless 9:16 YouTube Shorts across 11 layouts, and uploads directly to YouTube.

## Features

- **Ingest**: Local MP4/MOV/MKV/WebM uploads (≤500 MB), YouTube/Twitch/Kick URLs via yt-dlp, direct media URLs, or FFmpeg-generated test streams
- **Viral Moment Detection**: Sliding-window audio RMS energy spike analysis + transcript hook keyword scoring + multi-provider LLM semantic scoring (up to 4 ranked, non-overlapping moments)
- **Facecam Detection**: FFmpeg `signalstats` probing of 5 corner regions to estimate streamer facecam box coordinates
- **Rendering**: 11 layout options (splits, picture-in-picture, blurred-bg, center-crop, facecam-zoom) rendered at 720×1280 H.264 MP4 via FFmpeg filter graphs; NVENC GPU encoding when available
- **Templates**: X Post, TikTok Hook, Breaking News overlays — intentionally no burned captions (relies on YouTube auto-captions)
- **YouTube Publishing**: Firebase Google sign-in + YouTube Data API v3 resumable upload with scheduling, privacy control, and hashtags
- **Multi-Provider LLM Router**: Quota-aware rotation across Gemini, Groq, OpenRouter, Ollama, and a local custom LLM with 60-minute cooldowns on 429 errors
- **Custom LLM**: Python OpenAI-compatible server with trainable Naive Bayes viral classifier (learns from thumbs up/down feedback), optional llama.cpp GGUF or Ollama backend
- **Creator Watchlist**: Save Twitch/Kick/YouTube channels with preferred facecam layout for one-click loading

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Vite 8, Motion, Lucide React
- **Backend**: Express.js + TypeScript (`tsx`)
- **Video**: FFmpeg / ffprobe (probing, audio energy, facecam detection, vertical render)
- **Storage**: Local JSON files under `workspace/` (projects, clips, weights, watchlist, training data)
- **Auth**: Firebase + YouTube Data API v3

## Project Structure

```
ClipForge/
├── server.ts                 # Express server — all API routes
├── vite.config.ts            # Vite + Tailwind + React plugin
├── package.json              # Node dependencies
├── .env.example              # Environment variables (LLM API keys, Ollama, Custom LLM)
├── firebase-applet-config.json  # Firebase config (Google OAuth for YouTube)
├── server/                   # Backend modules
│   ├── analyzer.ts           # FFmpeg probing, audio RMS, facecam detection, viral scoring
│   ├── capabilities.ts       # ffmpeg/ffprobe/nvenc/yt-dlp/ollama availability checks
│   ├── customLlmManager.ts   # Spawns/stops Python custom LLM server (:8000)
│   ├── ingest.ts             # URL ingest (yt-dlp), direct download, FFmpeg sample generation
│   ├── llmRouter.ts          # Multi-provider LLM router with quota cooldowns
│   ├── renderer.ts           # FFmpeg filter graphs for 11 layouts + templates/branding
│   ├── storage.ts            # JSON file CRUD + path traversal protection
│   ├── training.ts           # NDJSON training dataset + stats
│   └── weights.ts            # Feedback-driven ranking weight adjustment
├── src/                      # React frontend
│   ├── main.tsx, App.tsx     # App shell with 4 tabs: ingest, facecam, queue, youtube
│   ├── types.ts              # Shared TS types + 11 LAYOUT_OPTIONS metadata
│   ├── index.css             # Tailwind + theme
│   ├── lib/youtubeAuth.ts    # Firebase Google sign-in + YouTube upload helpers
│   └── components/
│       ├── IngestAnalyzeView.tsx     # Upload/URL/sample ingest, audio waveform, moments, weights
│       ├── FacecamLayoutStudio.tsx   # Interactive facecam box, 11 layouts, templates, render
│       ├── RenderQueueView.tsx       # Clip gallery, download, publish to YouTube
│       ├── YouTubePublishView.tsx    # Metadata composer, Google sign-in, resumable upload
│       └── LayoutThumbnail.tsx       # SVG wireframe previews per layout
├── custom_llm/               # Python OpenAI-compatible inference server (:8000)
│   ├── server.py             # Trainable Naive Bayes viral classifier + llama.cpp/Ollama fallback
│   ├── finetune_lora.py      # 4-bit QLoRA fine-tuning for GTX 1650 (4 GB VRAM)
│   ├── Modelfile             # Ollama Modelfile for clipforge-viral:3b
│   ├── requirements.txt      # Optional fine-tuning dependencies
│   └── README.md             # Custom LLM documentation
└── workspace/                # Runtime data (projects, clips, weights, watchlist, training data)
```

## Quick Start

### 1. Install system dependencies

ClipForge requires **FFmpeg** and **ffprobe** on PATH for video probing, audio analysis, facecam detection, and rendering.

- **Windows**: `winget install ffmpeg` or download from ffmpeg.org
- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg yt-dlp`

`yt-dlp` is also required for YouTube/Twitch/Kick URL ingest: `pip install yt-dlp`

### 2. Install Node dependencies

```bash
npm install
```

### 3. Configure environment

Copy `.env.example` to `.env` and add API keys if you want cloud LLM overflow. For YouTube URL ingest, you also need yt-dlp cookie auth:

```env
# yt-dlp JavaScript runtime (node or deno) for YouTube signature extraction
YTDLP_JS_RUNTIME=node

# yt-dlp browser cookies for YouTube bot verification (chrome, edge, firefox, brave, opera, etc.)
# Set this to the browser you're logged into YouTube with.
YTDLP_COOKIES_FROM_BROWSER=chrome
```

**Important:** YouTube now requires cookies to download videos. Set `YTDLP_COOKIES_FROM_BROWSER` to the browser where you're logged into YouTube (e.g., `chrome`, `edge`, `firefox`). yt-dlp will read your auth cookies from that browser automatically.

### 4. Run the dev server

```bash
npm run dev
```

Server starts on `http://localhost:3000`.

### 5. Optional: Start the Custom LLM server

```bash
python custom_llm/server.py
```

Then set `CUSTOM_LLM_URL=http://127.0.0.1:8000` in `.env`. See `custom_llm/README.md` for details.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Express + Vite dev server on :3000 |
| `npm run build` | Vite production build to `dist/` |
| `npm run start` | Production start (`node server.ts`) |
| `npm run preview` | Preview production build |
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm run clean` | Remove `dist/` and `server.js` |

## Notes

- YouTube OAuth tokens are kept in browser memory only (never persisted to localStorage).
- No burned captions are ever rendered into videos — YouTube auto-captions handle subtitles.
- `firebase-applet-config.json` contains a committed Firebase API key for the Google Sign-In flow.
- Source video files are stored locally under `workspace/sources/`; delete projects to reclaim disk space.
