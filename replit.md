# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## AI Audio Tab (cloned from Ai-Audio2 repo)

The "Ai Audio" tab in `artifacts/srt-tools` is a full TTS editor cloned verbatim from https://github.com/2absolutetwo/Ai-Audio2 (originally the `notes-app` artifact in that repo).

- **Backend** (`artifacts/api-server`):
  - `POST /api/tts` — synthesizes MP3 audio with `msedge-tts` (Microsoft Edge online voices, free, no API key). Body: `{ text, voice? }`. Auto-detects `bn-BD-NabanitaNeural` for Bangla text and `en-US-AriaNeural` for English when `voice` is omitted. Max 5000 chars.
  - `GET /api/tts/voices` — returns the full list of available Edge voices (cached in memory).
- **Frontend** (`artifacts/srt-tools/src`):
  - `tabs/AiAudioTab.tsx` mounts `<Editor />`.
  - `components/editor/note-editor.tsx` — main editor (chunked synthesis, playback queue, MP3 download, undo, copy/cut/paste, history).
  - `components/editor/voice-picker.tsx` & `favorite-voices-button.tsx` — language → voice selector with starred favorites.
  - `hooks/use-favorite-voices.ts` — favorite voices stored in `localStorage` under key `favorite-voices`.
  - Sonner `<Toaster />` is mounted in `main.tsx` for editor notifications.

## Cutting++ Tab — Batch Hardening (200–250 file batches)

`artifacts/srt-tools/src/tabs/CuttingPlusPlusTab.tsx` is hardened for very large batches:

- **No per-file metadata stalls**: `addPoolFiles` no longer calls `getMediaDuration` or `setPool` per file. Cards read durations lazily via `handleAudio` / `handleVideo`.
- **Auto-archive batching** (`BATCH_SIZE_PP = 25`): after every 25 successful cuts, finished outputs are streamed into a single accumulating ZIP (`archiveZipRef`) and the per-card blob URL is revoked. The card flips to an "Archived in ZIP" green badge so RAM doesn't grow with the batch.
- **State churn fix**: `setCardState` is now bulk + rAF-debounced via `pendingUpdatesRef`; the runtime reads the live `cardStatesRef` instead of the throttled React state. Cards expose `markArchived()` on their imperative handle.
- **Download flow**: `handleDownloadZip` combines the accumulated archive ZIP + still-live merged outputs into one final ZIP. `clearAllCards` resets archive state.

User explicitly skipped the counter-accuracy fix ("D"); only A + B + C are implemented.

## Video Splitter → Cutting+ Cue-Accurate Pipeline

Browser-only fix (no API cost) so SRT-cue cuts align to the millisecond:

- **Problem**: `Video Splitter` cuts each clip with `-ss <startSec> -i input -c copy`, which snaps backward to the prior keyframe. Each clip starts up to ~GOP-size seconds *before* the cue (visible "extra" head content / freeze).
- **Fix (Option B)**: Splitter scans master keyframes once after upload (`extractKeyframeTimes` via `-skip_frame nokey -vf showinfo`, parses `pts_time:`), then for each clip computes `headExtra = startSec - priorKeyframe(times, startSec)` and stores it in `clipExtrasRef` (Map<index, number>). Aligned `extras: number[]` are passed alongside files via `onSendToCutting(files, extras)`.
- **Cutting+** (`CuttingPlusTab.tsx`): `IncomingVideoFiles.extras?` and `VideoItem.headExtra?` carry the value. `addFiles(files, extras?)` maps extras by original index (filter-safe). `runCut` switches per-item: items with `headExtra > 0` use the new accurate `trimVideoHeadAccurate` (output-seek `-ss` *after* `-i`, `libx264 CRF 18 veryfast`, `-c:a copy`, `+faststart`, MP4 → visually lossless). Items without extras keep the original global fixed-cut path.
- **`lib/video-trim-ffmpeg.ts`**: adds `trimVideoHeadAccurate({headSeconds, onProgress})` + `headTrimmedFileName()` (always `.mp4`). Includes the standard recycle/memory-error retry. Output filename helper `outputName(item)` picks `headTrimmedFileName` for aligned items, `trimmedFileName` otherwise — used by single download, ZIP, and forward-send (Cutting++ / Speed +-).
- **UI**:
  - Splitter: amber `+X.XXs` badge on each clip card whose `headExtra > 0`. Amber "Scanning keyframes…" status banner shown between upload and per-clip cuts.
  - Cutting+: amber `cue+X.XXs` badge on each aligned card; per-card duration calc subtracts `headExtra` (instead of `cutSeconds * mode`) for those items.
- **Files touched**: `artifacts/srt-tools/src/lib/video-trim-ffmpeg.ts`, `artifacts/srt-tools/src/tabs/VideoSplitterTab.tsx`, `artifacts/srt-tools/src/tabs/CuttingPlusTab.tsx`, `artifacts/srt-tools/src/App.tsx`. `CuttingPlusPlusTab.tsx` is intentionally NOT touched.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
