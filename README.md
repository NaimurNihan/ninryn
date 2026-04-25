# SRT Tools — Quick Clone & Run Guide

A pnpm monorepo with a React + Vite frontend (`srt-tools`) and an Express 5 backend (`api-server`).
This file is the **single source of truth** for cloning and running this project on Replit or any
machine. Follow these steps verbatim and the project will run without exploration.

---

## TL;DR for the Replit Agent

If you are an AI agent importing this repository, do exactly this — no detection, no exploration:

1. Run `pnpm install` at the workspace root.
2. Register the `srt-tools` artifact (kind: `react-vite`, slug: `srt-tools`, previewPath: `/`).
   The `artifacts/srt-tools/.replit-artifact/artifact.toml` already exists and is correct.
3. Restart these two workflows:
   - `artifacts/api-server: API Server` (Express, port 8080)
   - `artifacts/srt-tools: web` (Vite, port 5000)
4. Done. Open `/` in the preview pane.

No `.env` file is required. No database setup is required. No code changes are needed.

---

## Stack

| Layer        | Tech                                                 |
| ------------ | ---------------------------------------------------- |
| Monorepo     | pnpm workspaces                                      |
| Node         | 24                                                   |
| Frontend     | React 18 + Vite 7 + TailwindCSS + shadcn/ui + wouter |
| Backend      | Express 5 + Pino + msedge-tts                        |
| FFmpeg       | `@ffmpeg/ffmpeg` (browser-side WASM)                 |
| Validation   | Zod (`zod/v4`) + drizzle-zod                         |
| API codegen  | Orval (from OpenAPI spec)                            |
| DB (unused)  | PostgreSQL + Drizzle ORM (schemas not defined yet)   |

---

## Workspace layout

```
artifacts/
├── api-server/      # Express server (TTS endpoints + health)
├── mockup-sandbox/  # shadcn/ui component preview sandbox
└── srt-tools/       # Main React app (all SRT/audio/video tools)

lib/
├── api-client-react/  # Generated React Query hooks (Orval)
├── api-spec/          # OpenAPI spec + Orval config
├── api-zod/           # Generated Zod schemas (Orval)
└── db/                # Drizzle setup (no schema defined yet)

scripts/               # Shared utility scripts
attached_assets/       # Bundled assets used by the frontend
```

---

## Setup steps (manual)

### 1. Install dependencies

```bash
pnpm install
```

The repo includes `pnpm-lock.yaml` so installation is deterministic and fast.

> Note: pnpm will skip `msedge-tts`'s build script by default. The package works fine at runtime
> for TTS calls. Run `pnpm approve-builds` only if you ever need its postinstall hook.

### 2. Run the services

Two services need to run in parallel:

```bash
# Terminal 1 — backend (port 8080)
PORT=8080 pnpm --filter @workspace/api-server run dev

# Terminal 2 — frontend (port 5000)
PORT=5000 BASE_PATH=/ pnpm --filter @workspace/srt-tools run dev
```

On Replit these are pre-wired as the workflows `artifacts/api-server: API Server` and
`artifacts/srt-tools: web`.

### 3. Open the app

Visit `/` in the preview pane (or `http://localhost:5000` locally). The frontend talks to the
backend at `/api/...` through the shared proxy — no CORS or proxy config needed.

---

## Environment variables

| Variable        | Required by           | Purpose                                          |
| --------------- | --------------------- | ------------------------------------------------ |
| `PORT`          | both services         | Service port (8080 for API, 5000 for frontend)   |
| `BASE_PATH`     | `srt-tools` (Vite)    | URL base path. Always `/`.                       |
| `DATABASE_URL`  | `lib/db` only         | **Not required.** Only needed if you import      |
|                 |                       | from `@workspace/db` (no current code does).     |
| `SESSION_SECRET`| —                     | Reserved for future auth; not currently used.    |

No `.env` file is shipped — none is needed for the project to run.

---

## Useful commands

```bash
pnpm run typecheck                                   # full typecheck across all packages
pnpm run build                                       # typecheck + build all packages
pnpm --filter @workspace/api-spec run codegen        # regenerate API hooks + Zod schemas
pnpm --filter @workspace/db run push                 # push DB schema (only if you add one)
pnpm --filter @workspace/api-server run dev          # run API server locally
pnpm --filter @workspace/srt-tools run dev           # run frontend locally
```

---

## API endpoints

Implemented in `artifacts/api-server/src/routes/`:

| Method | Path               | Purpose                                          |
| ------ | ------------------ | ------------------------------------------------ |
| GET    | `/api/healthz`     | Health check                                     |
| POST   | `/api/tts`         | Synthesize MP3 from text (Microsoft Edge voices) |
| GET    | `/api/tts/voices`  | List all available Edge TTS voices               |

The TTS endpoints use `msedge-tts` — Microsoft Edge's free online voices, no API key needed.
- Body for `POST /api/tts`: `{ text: string, voice?: string }`. Max 5000 chars.
- Auto-detects `bn-BD-NabanitaNeural` for Bangla and `en-US-AriaNeural` for English when
  `voice` is omitted.

---

## Frontend tabs (in `artifacts/srt-tools/src/tabs/`)

- **SRT Merger** — merge sentences into an existing SRT file
- **SRT Editor** — edit SRT files in-browser
- **SRT Maker** — create SRT from scratch
- **SRT Note** — note-taking with SRT export
- **SRT Time Splitter** — re-time SRT cues
- **Ai Audio** — full TTS editor (uses `/api/tts`)
- **Audio Splitter** — split audio files
- **Video Splitter** — split video by SRT cues, scans keyframes for cue accuracy
- **Cutting+** — accurate per-cue trimming pipeline (cue+Xs aligned)
- **Cutting++** — batch hardening for 200–250 file batches with auto-archive ZIP
- **Speed +-** — speed adjustment

All audio/video processing happens **in the browser** via `@ffmpeg/ffmpeg` WASM —
no server-side ffmpeg is required.

---

## Things to know before changing code

- **Never run `pnpm dev` or `pnpm run dev` at the workspace root** — there is no root `dev`
  script by design. Use the per-artifact filters above.
- The frontend reads its base path from `import.meta.env.BASE_URL`; do not hard-code `/`.
- The backend never uses `console.log`. Use `req.log` in route handlers and the `logger`
  singleton from `src/lib/logger.ts` everywhere else.
- The `@workspace/db` lib throws at import time if `DATABASE_URL` is missing. Do not import
  it anywhere unless you actually provision a database first.
- Generated files live under `lib/api-client-react/src/generated/` and
  `lib/api-zod/src/generated/`. Re-generate via the `codegen` command above after editing
  `lib/api-spec/openapi.yaml`. Do not edit generated files by hand.

---

## Troubleshooting

- **Preview pane is blank** → make sure both workflows are running. The frontend lives at `/`.
- **`PORT environment variable is required`** → the workflow didn't pass `PORT`. Restart the
  workflow on Replit, or set `PORT` manually when running locally.
- **`/api/...` returns 404** → the API Server workflow isn't running, or it was started before
  a route file change. Restart `artifacts/api-server: API Server`.
- **TTS returns 500** → the host needs outbound internet to reach Microsoft Edge's voice
  service. There's no API key to configure.
