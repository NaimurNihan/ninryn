import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";

const CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`;

const RECYCLE_EVERY = 10;
const MEMORY_ERROR_PATTERNS = [
  "memory access out of bounds",
  "out of memory",
  "abort",
  "RuntimeError",
  "not loaded",
];

function isMemoryError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return MEMORY_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

async function loadFreshInstance(): Promise<FFmpeg> {
  const instance = new FFmpeg();
  if (logHandler) {
    instance.on("log", ({ message }) => logHandler?.(message));
  }
  const coreURL = await toBlobURL(
    `${CORE_BASE}/ffmpeg-core.js`,
    "text/javascript",
  );
  const wasmURL = await toBlobURL(
    `${CORE_BASE}/ffmpeg-core.wasm`,
    "application/wasm",
  );
  await instance.load({ coreURL, wasmURL });
  return instance;
}

// Create a fully independent FFmpeg instance (for use with engine pools).
// Each instance has its own WASM heap — no shared state with the singleton.
export async function createFFmpegInstance(
  onLog?: (msg: string) => void,
): Promise<FFmpeg> {
  const instance = new FFmpeg();
  if (onLog) {
    instance.on("log", ({ message }) => onLog(message));
  }
  const coreURL = await toBlobURL(
    `${CORE_BASE}/ffmpeg-core.js`,
    "text/javascript",
  );
  const wasmURL = await toBlobURL(
    `${CORE_BASE}/ffmpeg-core.wasm`,
    "application/wasm",
  );
  await instance.load({ coreURL, wasmURL });
  return instance;
}

let ffmpeg: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;
let logHandler: ((msg: string) => void) | null = null;
let trimsSinceRecycle = 0;

export async function getFFmpeg(
  onLog?: (msg: string) => void,
): Promise<FFmpeg> {
  if (onLog) logHandler = onLog;
  if (ffmpeg) return ffmpeg;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const instance = await loadFreshInstance();
    ffmpeg = instance;
    loadingPromise = null;
    return instance;
  })();

  return loadingPromise;
}

export async function recycleFFmpeg(): Promise<FFmpeg> {
  const old = ffmpeg;
  ffmpeg = null;
  loadingPromise = null;
  if (old) {
    try {
      old.terminate();
    } catch {
      // ignore — instance may already be dead
    }
  }
  trimsSinceRecycle = 0;
  return getFFmpeg();
}

export function disposeFFmpeg(): void {
  const old = ffmpeg;
  ffmpeg = null;
  loadingPromise = null;
  trimsSinceRecycle = 0;
  if (old) {
    try {
      old.terminate();
    } catch {
      // ignore
    }
  }
}

export async function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const url = URL.createObjectURL(file);
    video.src = url;
    video.onloadedmetadata = () => {
      const d = video.duration;
      URL.revokeObjectURL(url);
      if (!isFinite(d) || d <= 0) reject(new Error("Invalid duration"));
      else resolve(d);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read video metadata"));
    };
  });
}

export type TrimMode = "end" | "both";

export interface TrimOptions {
  cutSeconds: number;
  mode: TrimMode;
  onProgress?: (ratio: number) => void;
}

// Internal: do one trim attempt against the given ffmpeg engine.
async function trimOnce(
  ff: FFmpeg,
  file: File,
  opts: TrimOptions,
): Promise<Blob> {
  const duration = await getVideoDuration(file);

  const cut = opts.cutSeconds;
  const startCut = opts.mode === "both" ? cut : 0;
  const endCut = cut;
  const newDuration = duration - startCut - endCut;

  if (newDuration <= 0) {
    throw new Error(
      `Cut (${(startCut + endCut).toFixed(3)}s) >= video length (${duration.toFixed(3)}s)`,
    );
  }

  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const safeExt = ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)
    ? ext
    : "mp4";
  const inputName = `in.${safeExt}`;
  const outputName = `out.${safeExt}`;

  await ff.writeFile(inputName, await fetchFile(file));

  const progressHandler = ({ progress }: { progress: number }) => {
    if (opts.onProgress) opts.onProgress(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  try {
    const args = [
      "-ss",
      startCut.toFixed(3),
      "-i",
      inputName,
      "-t",
      newDuration.toFixed(3),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outputName,
    ];
    await ff.exec(args);
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(outputName);
  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});

  const buf = data instanceof Uint8Array ? data : new Uint8Array();
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  const mime = file.type || `video/${safeExt === "mov" ? "quicktime" : safeExt}`;
  return new Blob([ab], { type: mime });
}

export async function trimVideo(
  file: File,
  opts: TrimOptions,
): Promise<Blob> {
  if (trimsSinceRecycle >= RECYCLE_EVERY) {
    await recycleFFmpeg();
  }

  let ff = await getFFmpeg();

  try {
    const blob = await trimOnce(ff, file, opts);
    trimsSinceRecycle += 1;
    return blob;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (isMemoryError(msg)) {
      ff = await recycleFFmpeg();
      const blob = await trimOnce(ff, file, opts);
      trimsSinceRecycle += 1;
      return blob;
    }

    throw err;
  }
}

// Pool-friendly wrapper: trim using an externally-managed FFmpeg instance.
export async function trimVideoWithEngine(
  ff: FFmpeg,
  file: File,
  opts: TrimOptions,
): Promise<Blob> {
  return trimOnce(ff, file, opts);
}

export function trimmedFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}_trimmed`;
  return `${name.slice(0, dot)}_trimmed${name.slice(dot)}`;
}

// ── Full re-encode head trim (frame-accurate, slow) ───────────────────
// Kept for very short clips where smart-cut offers no benefit.
async function trimHeadAccurateOnce(
  ff: FFmpeg,
  file: File,
  opts: AccurateHeadTrimOptions,
): Promise<Blob> {
  const head = Math.max(0, opts.headSeconds);

  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const safeInExt = ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)
    ? ext
    : "mp4";
  const inputName = `in.${safeInExt}`;
  const outputName = `out.mp4`;

  await ff.writeFile(inputName, await fetchFile(file));

  const progressHandler = ({ progress }: { progress: number }) => {
    if (opts.onProgress) opts.onProgress(Math.max(0, Math.min(1, progress)));
  };
  ff.on("progress", progressHandler);

  try {
    const args = [
      "-i",
      inputName,
      "-ss",
      head.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "fastdecode,zerolatency",
      "-crf",
      "22",
      "-x264-params",
      "no-mbtree=1:rc-lookahead=0:sync-lookahead=0:bframes=0",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "0",
      "-c:a",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-movflags",
      "+faststart",
      outputName,
    ];
    await ff.exec(args);
  } finally {
    ff.off("progress", progressHandler);
  }

  const data = await ff.readFile(outputName);
  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});

  const buf = data instanceof Uint8Array ? data : new Uint8Array();
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Blob([ab], { type: "video/mp4" });
}

export async function trimVideoHeadAccurate(
  file: File,
  opts: AccurateHeadTrimOptions,
): Promise<Blob> {
  if (trimsSinceRecycle >= RECYCLE_EVERY) {
    await recycleFFmpeg();
  }

  let ff = await getFFmpeg();

  try {
    const blob = await trimHeadAccurateOnce(ff, file, opts);
    trimsSinceRecycle += 1;
    return blob;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isMemoryError(msg)) {
      ff = await recycleFFmpeg();
      const blob = await trimHeadAccurateOnce(ff, file, opts);
      trimsSinceRecycle += 1;
      return blob;
    }
    throw err;
  }
}

export interface AccurateHeadTrimOptions {
  headSeconds: number;
  onProgress?: (ratio: number) => void;
}

// ── Smart-cut head trim (20-30x faster than full re-encode) ──────────
//
// Strategy:
//   1. Re-encode only the first SEGMENT_S seconds after `head` (output
//      seek → frame-accurate start, only a tiny re-encode window).
//   2. Stream-copy the remaining video (output seek at SEGMENT_S so the
//      copy starts cleanly without keyframe content duplication).
//   3. Concat the two segments with the concat demuxer (-c copy).
//
// For a 60 s clip with head=0.5 s and SEGMENT_S=3 s:
//   Old: encode 59.5 s   (~60 s wall time in WASM)
//   New: encode 3 s + copy 56.5 s  (~3-4 s wall time)  ≈ 15-20× faster
//
// Falls back to full re-encode when the clip is too short to benefit.
const SMART_CUT_SEGMENT_S = 3.0;

async function trimHeadSmartCutOnce(
  ff: FFmpeg,
  file: File,
  opts: AccurateHeadTrimOptions,
): Promise<Blob> {
  const head = Math.max(0, opts.headSeconds);
  const duration = await getVideoDuration(file);
  const remaining = duration - head;

  // Not worth smart-cutting very short clips — just do a full re-encode.
  if (remaining <= SMART_CUT_SEGMENT_S * 2) {
    return trimHeadAccurateOnce(ff, file, opts);
  }

  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const safeInExt = ["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)
    ? ext
    : "mp4";
  const inputName = `in.${safeInExt}`;
  const seg1Name = "seg1.mp4";
  const seg2Name = "seg2.mp4";
  const listName = "list.txt";
  const outputName = "out.mp4";

  const progressFn = opts.onProgress ?? (() => {});

  await ff.writeFile(inputName, await fetchFile(file));

  // --- Segment 1: re-encode [head … head+SEGMENT_S] (frame-accurate) ---
  const p1 = ({ progress }: { progress: number }) =>
    progressFn(Math.max(0, Math.min(1, progress * 0.45)));
  ff.on("progress", p1);
  try {
    await ff.exec([
      "-i", inputName,
      "-ss", head.toFixed(3),
      "-t", SMART_CUT_SEGMENT_S.toFixed(3),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "fastdecode,zerolatency",
      "-crf", "22",
      "-x264-params", "no-mbtree=1:rc-lookahead=0:sync-lookahead=0:bframes=0",
      "-bf", "0",
      "-pix_fmt", "yuv420p",
      "-threads", "0",
      "-c:a", "copy",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "+faststart",
      seg1Name,
    ]);
  } finally {
    ff.off("progress", p1);
  }

  // --- Segment 2: stream-copy [head+SEGMENT_S … end] ---
  // Use output seek (-i first, then -ss) so the copy starts at exactly
  // the right frame boundary — avoids keyframe-alignment content dup.
  progressFn(0.5);
  const seg2Start = head + SMART_CUT_SEGMENT_S;
  const p2 = ({ progress }: { progress: number }) =>
    progressFn(Math.max(0, Math.min(1, 0.5 + progress * 0.4)));
  ff.on("progress", p2);
  try {
    await ff.exec([
      "-i", inputName,
      "-ss", seg2Start.toFixed(3),
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      seg2Name,
    ]);
  } finally {
    ff.off("progress", p2);
  }

  // --- Concat: join the two segments without any re-encode ---
  progressFn(0.9);
  await ff.writeFile(listName, `file '${seg1Name}'\nfile '${seg2Name}'\n`);
  await ff.exec([
    "-f", "concat",
    "-safe", "0",
    "-i", listName,
    "-c", "copy",
    "-movflags", "+faststart",
    outputName,
  ]);
  progressFn(1.0);

  const data = await ff.readFile(outputName);
  for (const f of [inputName, seg1Name, seg2Name, listName, outputName]) {
    await ff.deleteFile(f).catch(() => {});
  }

  const buf = data instanceof Uint8Array ? data : new Uint8Array();
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Blob([ab], { type: "video/mp4" });
}

// Pool-friendly smart cut: accepts an externally-managed FFmpeg instance.
export async function trimHeadSmartCutWithEngine(
  ff: FFmpeg,
  file: File,
  opts: AccurateHeadTrimOptions,
): Promise<Blob> {
  return trimHeadSmartCutOnce(ff, file, opts);
}

// Singleton smart cut (keeps backward compatibility).
export async function trimHeadSmartCut(
  file: File,
  opts: AccurateHeadTrimOptions,
): Promise<Blob> {
  if (trimsSinceRecycle >= RECYCLE_EVERY) {
    await recycleFFmpeg();
  }
  let ff = await getFFmpeg();
  try {
    const blob = await trimHeadSmartCutOnce(ff, file, opts);
    trimsSinceRecycle += 1;
    return blob;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isMemoryError(msg)) {
      ff = await recycleFFmpeg();
      const blob = await trimHeadSmartCutOnce(ff, file, opts);
      trimsSinceRecycle += 1;
      return blob;
    }
    throw err;
  }
}

export function headTrimmedFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}_aligned.mp4`;
  return `${name.slice(0, dot)}_aligned.mp4`;
}
