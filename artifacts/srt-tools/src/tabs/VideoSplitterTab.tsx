import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import JSZip from "jszip";
import {
  Film,
  FileText,
  Scissors,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Play,
  Sparkles,
  X,
  FolderInput,
  CheckSquare,
  Square,
} from "lucide-react";

const queryClient = new QueryClient();

const FFMPEG_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";

const BATCH_SIZE = 25;
const RECYCLE_EVERY = 10;
const MEMORY_ERROR_PATTERNS = [
  "memory access out of bounds",
  "out of memory",
  "abort",
  "RuntimeError",
  "not loaded",
];

interface SrtCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

interface SrtPreview {
  count: number;
  totalSeconds: number;
  sample: { index: number; startSec: number; endSec: number; text: string }[];
  overlapCount?: number;
  overlaps?: { a: number; b: number; overlapSec: number }[];
}

interface ClipMeta {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
  filename: string;
}

interface JobInit {
  jobId: string;
  baseName: string;
  total: number;
  clips: ClipMeta[];
}

interface ClipStatus {
  index: number;
  status: "pending" | "running" | "done" | "error";
  error?: string;
}

// Extract every keyframe (I-frame) timestamp from the master video.
// Uses `-skip_frame nokey` so the decoder skips P/B-frames entirely —
// fast even for long videos. `showinfo` filter logs `pts_time:X.XXX`
// for each frame that survives.
async function extractKeyframeTimes(
  eng: FFmpeg,
  inputName: string,
): Promise<number[]> {
  const times: number[] = [];
  const handler = ({ message }: { message: string }) => {
    const m = /pts_time:([\d.]+)/.exec(message);
    if (m) {
      const t = parseFloat(m[1]);
      if (Number.isFinite(t)) times.push(t);
    }
  };
  eng.on("log", handler);
  try {
    await eng.exec([
      "-hide_banner",
      "-skip_frame",
      "nokey",
      "-i",
      inputName,
      "-an",
      "-sn",
      "-vf",
      "showinfo",
      "-f",
      "null",
      "-",
    ]);
  } finally {
    eng.off("log", handler);
  }
  times.sort((a, b) => a - b);
  const dedup: number[] = [];
  for (const t of times) {
    if (dedup.length === 0 || t - dedup[dedup.length - 1] > 1e-3) {
      dedup.push(t);
    }
  }
  // Always anchor 0.0 — first frame of any video is a keyframe.
  if (dedup.length === 0 || dedup[0] > 1e-3) dedup.unshift(0);
  return dedup;
}

// Largest keyframe time ≤ target (binary search). This is exactly
// where ffmpeg's input-seek `-ss` will snap to with `-c copy`.
function priorKeyframe(times: number[], target: number): number {
  if (times.length === 0) return 0;
  let lo = 0;
  let hi = times.length - 1;
  let best = times[0]!;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= target) {
      best = times[mid]!;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

interface JobStatus {
  total: number;
  done: number;
  errors: number;
  finished: boolean;
  clips: ClipStatus[];
}

function timestampToSeconds(ts: string): number {
  const m = ts.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) throw new Error(`Invalid SRT timestamp: ${ts}`);
  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4]) / 1000
  );
}

function parseSrt(content: string): SrtCue[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const blocks = normalized.split(/\n\s*\n/);
  const cues: SrtCue[] = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;
    const lines = block.split("\n");
    let cursor = 0;

    if (lines[cursor] && /^\d+$/.test(lines[cursor]!.trim())) cursor++;

    const timeLine = lines[cursor];
    if (!timeLine) continue;
    const tm = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/,
    );
    if (!tm) continue;
    cursor++;

    const text = lines.slice(cursor).join("\n").trim();
    const startSec = timestampToSeconds(tm[1]!);
    const endSec = timestampToSeconds(tm[2]!);
    if (endSec <= startSec) continue;

    cues.push({ index: cues.length + 1, startSec, endSec, text });
  }

  return cues;
}

function sanitizeForFilename(text: string, max = 40): string {
  const cleaned = text
    .replace(/<[^>]*>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\w\s\-]+/g, "")
    .trim()
    .slice(0, max)
    .replace(/\s+/g, "_");
  return cleaned || "clip";
}

function buildSrtPreview(cues: SrtCue[]): SrtPreview {
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const overlaps: { a: number; b: number; overlapSec: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const nxt = sorted[i + 1]!;
    if (nxt.startSec < cur.endSec) {
      overlaps.push({
        a: cur.index,
        b: nxt.index,
        overlapSec: +(cur.endSec - nxt.startSec).toFixed(3),
      });
    }
  }
  return {
    count: cues.length,
    totalSeconds: cues.reduce((s, c) => s + (c.endSec - c.startSec), 0),
    sample: cues.slice(0, 5).map((c) => ({
      index: c.index,
      startSec: c.startSec,
      endSec: c.endSec,
      text: c.text,
    })),
    overlapCount: overlaps.length,
    overlaps: overlaps.slice(0, 20),
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function ClipThumb({
  status,
  index,
}: {
  status: "pending" | "running" | "done" | "error";
  index: number;
}) {
  const tone =
    status === "done"
      ? "from-indigo-500/15 via-violet-500/10 to-fuchsia-500/15"
      : status === "running"
        ? "from-indigo-400/20 via-indigo-300/10 to-violet-300/20"
        : status === "error"
          ? "from-red-200/40 to-red-100/20 dark:from-red-900/30 dark:to-red-950/30"
          : "from-slate-200/60 to-slate-100/40 dark:from-slate-800 dark:to-slate-900";

  return (
    <div
      className={`relative w-full h-full bg-gradient-to-br ${tone} flex items-center justify-center`}
    >
      {status === "running" ? (
        <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
      ) : status === "error" ? (
        <AlertCircle className="w-5 h-5 text-red-500" />
      ) : status === "done" ? (
        <Play className="w-5 h-5 text-indigo-600 dark:text-indigo-400 ml-0.5" />
      ) : (
        <Film className="w-5 h-5 text-slate-400" />
      )}
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[10px] text-slate-500/0 select-none">
        {index}
      </span>
    </div>
  );
}

function PreviewModal({
  src,
  filename,
  onClose,
}: {
  src: string;
  filename: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl rounded-2xl overflow-hidden bg-slate-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 bg-slate-900 text-slate-200">
          <p className="text-sm font-mono truncate">{filename}</p>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 inline-flex items-center justify-center rounded-md hover:bg-slate-800"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <video
          src={src}
          controls
          autoPlay
          playsInline
          className="w-full max-h-[70vh] bg-black"
        />
      </div>
    </div>
  );
}

function UploadTile({
  tone,
  icon,
  title,
  hint,
  file,
  onPick,
  onClear,
  accept,
  alert,
}: {
  tone: "emerald" | "rose";
  icon: React.ReactNode;
  title: string;
  hint: string;
  file: File | null;
  onPick: (f: File | null) => void;
  onClear: () => void;
  accept: string;
  alert?: { title: string; detail?: string } | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const palette =
    tone === "emerald"
      ? {
          bg: "bg-emerald-50/80 dark:bg-emerald-950/30",
          border: "border-emerald-200/80 dark:border-emerald-900/60",
          hover:
            "hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40",
          chip: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300",
          icon: "text-emerald-600 dark:text-emerald-400",
        }
      : {
          bg: "bg-rose-50/80 dark:bg-rose-950/30",
          border: "border-rose-200/80 dark:border-rose-900/60",
          hover:
            "hover:border-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40",
          chip: "bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300",
          icon: "text-rose-600 dark:text-rose-400",
        };

  const idle = {
    bg: "bg-[#f7f6f2] dark:bg-slate-900/60",
    border: "border-slate-200/80 dark:border-slate-800",
    hover: "hover:border-slate-300 hover:bg-[#f3f2ed] dark:hover:bg-slate-900/80",
    icon: "text-slate-500 dark:text-slate-400",
  };

  const active = !!file;
  const containerClasses = alert
    ? "border-amber-400 dark:border-amber-500/70 bg-amber-50/80 dark:bg-amber-950/30"
    : active
      ? `${palette.border} ${palette.bg}`
      : `${idle.border} ${idle.bg}`;
  const hoverClasses = active ? palette.hover : idle.hover;
  const iconColor = active ? palette.icon : idle.icon;

  return (
    <div
      onClick={() => inputRef.current?.click()}
      className={`relative cursor-pointer rounded-2xl border ${containerClasses} ${hoverClasses} px-5 py-4 transition-all`}
    >
      {alert && (
        <div
          className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-amber-500 text-white flex items-center justify-center shadow-md ring-2 ring-white dark:ring-slate-900"
          title={alert.title}
        >
          <AlertCircle className="w-4 h-4" />
        </div>
      )}
      <Input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-center gap-4">
        <div
          className={`shrink-0 w-11 h-11 rounded-xl bg-white/80 dark:bg-slate-900/60 flex items-center justify-center ${iconColor} shadow-sm`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          {file ? (
            <>
              <p className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">
                {file.name}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {formatBytes(file.size)} · click to replace
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-sm text-slate-800 dark:text-slate-100 tracking-wide uppercase">
                {title}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
            </>
          )}
        </div>
        {file && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="shrink-0 w-7 h-7 rounded-md inline-flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-white dark:hover:bg-slate-800"
            aria-label="Clear"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {alert && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-100/80 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-800 px-3 py-2">
          <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
              {alert.title}
            </p>
            {alert.detail && (
              <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                {alert.detail}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Home({
  incomingSrt,
  incomingSrtFilename,
  incomingSrtKey,
  onSendToCutting,
  onOutputsChange,
}: {
  incomingSrt?: string;
  incomingSrtFilename?: string;
  incomingSrtKey?: number;
  // extras[i] = head-extra seconds for files[i] (the leading "extra"
  // amount that the keyframe-snapped cut produced — Cutting+ trims it
  // accurately so the SRT cue start lines up to the millisecond).
  onSendToCutting?: (files: File[], extras?: number[]) => void;
  onOutputsChange?: (files: File[]) => void;
}) {
  const { toast } = useToast();

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [srtPreview, setSrtPreview] = useState<SrtPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // "uploading" → repurposed as "loading video into engine"
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);

  const [job, setJob] = useState<JobInit | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [previewClip, setPreviewClip] = useState<ClipMeta | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadPct, setLoadPct] = useState(0);

  const lastIncomingSrtKey = useRef<number | undefined>(undefined);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  // index → Blob (browser-side store; replaces server's per-clip files)
  const clipBlobsRef = useRef<Map<number, Blob>>(new Map());
  // index → object URL (for download/preview); revoked on reset
  const clipUrlsRef = useRef<Map<number, string>>(new Map());
  // index → "head extra" seconds (clip starts this much earlier than
  // the SRT cue because of keyframe snap-back). Cutting+ trims this
  // accurately to align the cue start exactly. 0 = perfect alignment.
  const clipExtrasRef = useRef<Map<number, number>>(new Map());
  // Re-render trigger so the per-clip extras badges update in the UI
  // (refs alone don't trigger re-render).
  const [extrasVersion, setExtrasVersion] = useState(0);
  // "scanning keyframes" is a brief stage right after upload finishes
  // and before per-clip cuts begin. Lets the UI show a status badge.
  const [scanningKeyframes, setScanningKeyframes] = useState(false);
  // Cancel signal for the in-flight cutting loop. Set to true by reset()
  // while a job is running so the loop can break out cleanly between
  // clips. Reset back to false when a new job starts.
  const cancelRef = useRef<boolean>(false);
  // ID of the currently active job. The cutting loop captures the jobId
  // it was started with and bails out if this ref no longer matches —
  // belt-and-braces alongside cancelRef in case a new job is started
  // while the previous loop is still mid-iteration.
  const jobIdRef = useRef<string | null>(null);

  function revokeAllClipUrls() {
    for (const url of clipUrlsRef.current.values()) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    clipUrlsRef.current.clear();
    clipBlobsRef.current.clear();
    clipExtrasRef.current.clear();
    setExtrasVersion((v) => v + 1);
  }

  useEffect(() => {
    return () => {
      revokeAllClipUrls();
    };
  }, []);

  async function getFFmpeg(): Promise<FFmpeg> {
    if (ffmpegRef.current) return ffmpegRef.current;
    const ffmpeg = new FFmpeg();
    const coreURL = await toBlobURL(
      `${FFMPEG_BASE_URL}/ffmpeg-core.js`,
      "text/javascript",
    );
    const wasmURL = await toBlobURL(
      `${FFMPEG_BASE_URL}/ffmpeg-core.wasm`,
      "application/wasm",
    );
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  }

  // Terminate the current ffmpeg instance and load a brand new one.
  // This is the core of the "engine recycle" strategy: WASM heap is
  // released entirely so memory fragmentation never accumulates.
  async function recycleFFmpeg(): Promise<FFmpeg> {
    const old = ffmpegRef.current;
    ffmpegRef.current = null;
    if (old) {
      try {
        old.terminate();
      } catch {
        // ignore — instance may already be dead
      }
    }
    return getFFmpeg();
  }

  // Tear down the ffmpeg engine without immediately reloading. Used to
  // free the ~300-500MB WASM heap when the user hands clips off to
  // another tab (e.g. Cutting+) so the next tab's engine has memory
  // headroom to start.
  function disposeFFmpeg() {
    const old = ffmpegRef.current;
    ffmpegRef.current = null;
    if (old) {
      try {
        old.terminate();
      } catch {
        // ignore
      }
    }
  }

  function isMemoryError(msg: string | null | undefined): boolean {
    if (!msg) return false;
    const lower = msg.toLowerCase();
    return MEMORY_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
  }

  // Read a File into Uint8Array with progress callback
  async function readFileWithProgress(
    file: File,
    onProgress: (pct: number) => void,
  ): Promise<Uint8Array> {
    const total = file.size;
    const reader = file.stream().getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    onProgress(0);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        if (total > 0) {
          onProgress(Math.min(99, Math.round((loaded / total) * 100)));
        }
      }
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    onProgress(100);
    return out;
  }

  useEffect(() => {
    if (!incomingSrt || !incomingSrt.trim()) return;
    if (incomingSrtKey === lastIncomingSrtKey.current) return;
    lastIncomingSrtKey.current = incomingSrtKey;
    const name = incomingSrtFilename || "from-time-spliter.srt";
    const file = new File([incomingSrt], name, { type: "text/plain" });
    void handleSrtChange(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingSrt, incomingSrtFilename, incomingSrtKey]);

  async function handleSrtChange(f: File | null) {
    setSrtFile(f);
    setSrtPreview(null);
    if (!f) return;
    setPreviewing(true);
    try {
      const text = await f.text();
      const cues = parseSrt(text);
      setSrtPreview(buildSrtPreview(cues));
    } catch (err) {
      toast({
        title: "Couldn't read SRT",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setPreviewing(false);
    }
  }

  async function startSegment() {
    if (!videoFile || !srtFile) return;

    revokeAllClipUrls();
    setJob(null);
    setStatus(null);
    setSelected(new Set());
    setUploading(true);
    setUploadPct(0);
    // Fresh job → clear any stale cancel signal from a previous job.
    cancelRef.current = false;

    let cues: SrtCue[];
    try {
      const srtText = await srtFile.text();
      cues = parseSrt(srtText);
    } catch (err) {
      setUploading(false);
      toast({
        title: "Couldn't parse SRT",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      return;
    }

    if (cues.length === 0) {
      setUploading(false);
      toast({
        title: "No subtitle cues found in SRT.",
        variant: "destructive",
      });
      return;
    }

    const ext = (() => {
      const m = videoFile.name.match(/\.[A-Za-z0-9]+$/);
      return m ? m[0] : ".mp4";
    })();
    const baseName = videoFile.name.replace(/\.[^.]+$/, "") || "video";
    const padWidth = String(cues.length).length;

    const clipMetas: ClipMeta[] = cues.map((c) => ({
      index: c.index,
      text: c.text,
      startSec: c.startSec,
      endSec: c.endSec,
      filename: `${String(c.index).padStart(padWidth, "0")}_${sanitizeForFilename(c.text)}${ext}`,
    }));

    const initialClipStatuses: ClipStatus[] = cues.map((c) => ({
      index: c.index,
      status: "pending",
    }));

    // Load ffmpeg + video into virtual FS (this replaces server upload).
    // We keep a "master" copy of the bytes outside ffmpeg so that we can
    // re-write the input every time we recycle the engine. ffmpeg's
    // writeFile() transfers/detaches the passed Uint8Array, so we always
    // hand it a *clone* and keep the master intact.
    let ffmpeg: FFmpeg;
    let masterBytes: Uint8Array;
    const inputName = `input${ext}`;
    try {
      ffmpeg = await getFFmpeg();
      masterBytes = await readFileWithProgress(videoFile, setUploadPct);
      // Clone so the master stays intact after writeFile transfers the buffer.
      await ffmpeg.writeFile(inputName, new Uint8Array(masterBytes));
    } catch (err) {
      setUploading(false);
      toast({
        title: "Couldn't load video",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
      return;
    }

    setUploading(false);

    // ── Extract keyframes once, compute per-clip head-extras ─────────
    // `-ss <startSec> -i input -c copy` snaps backward to the prior
    // keyframe, so the clip starts up to ~GOP-size seconds *before*
    // the SRT cue. Capture this leading offset per-clip so the
    // downstream Cutting+ tab can trim it accurately (re-encode head)
    // and align the cue start to the millisecond.
    setScanningKeyframes(true);
    let keyframes: number[] = [];
    try {
      keyframes = await extractKeyframeTimes(ffmpeg, inputName);
    } catch (err) {
      // Non-fatal: cuts can still proceed; we just won't have extras.
      console.warn("[VideoSplitter] keyframe scan failed:", err);
      keyframes = [];
    }
    setScanningKeyframes(false);
    clipExtrasRef.current.clear();
    if (keyframes.length > 0) {
      for (const c of clipMetas) {
        const kf = priorKeyframe(keyframes, c.startSec);
        const extra = Math.max(0, c.startSec - kf);
        clipExtrasRef.current.set(c.index, extra);
      }
      setExtrasVersion((v) => v + 1);
    }

    // Initialize job + status
    const jobId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `job-${Date.now()}`;
    const newJob: JobInit = {
      jobId,
      baseName,
      total: clipMetas.length,
      clips: clipMetas,
    };
    setJob(newJob);
    // Mark this jobId as the active one. The cutting loop captures
    // `jobId` in its closure and breaks out as soon as this ref no
    // longer matches (e.g. user clicked Cancel / started a new job).
    jobIdRef.current = jobId;
    setStatus({
      total: clipMetas.length,
      done: 0,
      errors: 0,
      finished: false,
      clips: initialClipStatuses,
    });

    toast({
      title: "Cutting started",
      description: `${clipMetas.length} clips, processing in browser`,
    });

    // Helper to mutate status
    const updateStatus = (mut: (clips: ClipStatus[]) => ClipStatus[]) => {
      setStatus((prev) => {
        if (!prev) return prev;
        const nextClips = mut(prev.clips.map((c) => ({ ...c })));
        const done = nextClips.filter((c) => c.status === "done").length;
        const errors = nextClips.filter((c) => c.status === "error").length;
        return { ...prev, clips: nextClips, done, errors };
      });
    };

    // Sort clips by startSec for cheap forward demux
    const sortedMetas = [...clipMetas].sort(
      (a, b) => a.startSec - b.startSec,
    );

    const batches: ClipMeta[][] = [];
    for (let i = 0; i < sortedMetas.length; i += BATCH_SIZE) {
      batches.push(sortedMetas.slice(i, i + BATCH_SIZE));
    }

    // Output mime guess from extension
    const mimeForExt = (() => {
      const e = ext.toLowerCase();
      if (e === ".mp4" || e === ".m4v") return "video/mp4";
      if (e === ".webm") return "video/webm";
      if (e === ".mkv") return "video/x-matroska";
      if (e === ".mov") return "video/quicktime";
      return "video/mp4";
    })();

    // Counter of clips processed since last recycle. When this reaches
    // RECYCLE_EVERY we tear down the ffmpeg instance and start a fresh
    // one — this releases all WASM heap memory and prevents the
    // "memory access out of bounds" error on long jobs.
    let sinceRecycle = 0;

    // Reload the input video into a freshly-created ffmpeg engine.
    // Always clones the master bytes so the master copy stays intact.
    const reloadInput = async (eng: FFmpeg) => {
      await eng.writeFile(inputName, new Uint8Array(masterBytes));
    };

    // Run a single clip cut. Returns null on success, or an error message.
    const cutOnce = async (eng: FFmpeg, clip: ClipMeta, outName: string) => {
      const duration = clip.endSec - clip.startSec;
      const args: string[] = [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        clip.startSec.toFixed(3),
        "-i",
        inputName,
        "-t",
        duration.toFixed(3),
        "-c",
        "copy",
        "-avoid_negative_ts",
        "make_zero",
        outName,
      ];
      try {
        await eng.exec(args);
        return null as string | null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };

    // Helper: was this job cancelled (or superseded by a newer job)?
    const isCancelled = () =>
      cancelRef.current || jobIdRef.current !== jobId;

    try {
      // Process clips one at a time using input-seek (`-ss` BEFORE `-i`)
      // for keyframe-aligned fast cuts with no leading freeze/blank.
      // Trade-off: each clip starts at the nearest prior keyframe, so the
      // clip may begin up to ~GOP-size seconds earlier than the SRT cue.
      for (const batch of batches) {
        if (isCancelled()) break;
        for (const clip of batch) {
          if (isCancelled()) break;
          // ── Engine recycle every RECYCLE_EVERY clips ─────────────
          if (sinceRecycle >= RECYCLE_EVERY) {
            try {
              ffmpeg = await recycleFFmpeg();
              await reloadInput(ffmpeg);
              sinceRecycle = 0;
            } catch (err) {
              // If recycle itself fails, mark this clip as error and
              // continue — the next iteration will try to recycle again.
              const msg =
                err instanceof Error ? err.message : String(err);
              updateStatus((clips) =>
                clips.map((c) =>
                  c.index === clip.index
                    ? { ...c, status: "error", error: `recycle failed: ${msg}` }
                    : c,
                ),
              );
              sinceRecycle = RECYCLE_EVERY; // force retry on next iter
              continue;
            }
          }

          updateStatus((clips) =>
            clips.map((c) =>
              c.index === clip.index ? { ...c, status: "running" } : c,
            ),
          );

          const outName = `out_${String(clip.index).padStart(padWidth, "0")}${ext}`;

          // ── First attempt ─────────────────────────────────────────
          let clipErr = await cutOnce(ffmpeg, clip, outName);

          // ── On memory error: recycle once and retry the same clip ─
          if (clipErr && isMemoryError(clipErr)) {
            try {
              ffmpeg = await recycleFFmpeg();
              await reloadInput(ffmpeg);
              sinceRecycle = 0;
              clipErr = await cutOnce(ffmpeg, clip, outName);
            } catch (err) {
              clipErr = err instanceof Error ? err.message : String(err);
            }
          }

          // ── Read result blob (or mark error) ──────────────────────
          try {
            const data = await ffmpeg.readFile(outName);
            const u8 =
              data instanceof Uint8Array
                ? data
                : new TextEncoder().encode(String(data));
            if (u8.byteLength === 0) {
              throw new Error("empty output");
            }
            const blob = new Blob([u8 as BlobPart], { type: mimeForExt });
            clipBlobsRef.current.set(clip.index, blob);
            const url = URL.createObjectURL(blob);
            clipUrlsRef.current.set(clip.index, url);
            updateStatus((clips) =>
              clips.map((c) =>
                c.index === clip.index ? { ...c, status: "done" } : c,
              ),
            );
            try {
              await ffmpeg.deleteFile(outName);
            } catch {
              // ignore
            }
            sinceRecycle += 1;
          } catch {
            const msg = clipErr || "Cut failed";
            updateStatus((clips) =>
              clips.map((c) =>
                c.index === clip.index
                  ? { ...c, status: "error", error: msg }
                  : c,
              ),
            );
            try {
              await ffmpeg.deleteFile(outName);
            } catch {
              // ignore
            }
            // Even failed cuts cost memory in the WASM heap, so count them
            // toward the recycle quota.
            sinceRecycle += 1;
          }
        }
      }
    } finally {
      // Free input from virtual FS (best-effort — engine may already be
      // dead if we were cancelled mid-flight via terminate()).
      try {
        await ffmpeg.deleteFile(inputName);
      } catch {
        // ignore
      }
      // Only mark this job as finished if it's still the active one.
      // If it was cancelled / superseded, reset() has already cleared
      // the status — don't resurrect it.
      if (!isCancelled()) {
        setStatus((prev) => (prev ? { ...prev, finished: true } : prev));
      }
    }
  }

  function reset() {
    // Signal the in-flight cutting loop (if any) to stop after the
    // current iteration. Also clear the active job marker so any loop
    // still mid-iteration bails on its next cancel-check.
    cancelRef.current = true;
    jobIdRef.current = null;
    // Hard-stop the WASM engine if it's currently exec()-ing a clip.
    // terminate() makes the in-flight ffmpeg.exec() reject, which lets
    // the loop's catch path run and the cancel-check break the loop.
    // A fresh engine is created on demand by the next startSegment().
    disposeFFmpeg();
    revokeAllClipUrls();
    setJob(null);
    setStatus(null);
    setVideoFile(null);
    setSrtFile(null);
    setSrtPreview(null);
    setUploadPct(0);
    setSelected(new Set());
    setLoadPct(0);
  }

  function toggleSelect(idx: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  async function handleLoadToCutting() {
    if (!job || !onSendToCutting) return;
    const doneClips = job.clips.filter(
      (c) => statusByIndex.get(c.index)?.status === "done",
    );
    const targetClips =
      selected.size > 0
        ? doneClips.filter((c) => selected.has(c.index))
        : doneClips;
    if (targetClips.length === 0) {
      toast({
        title: "No clips ready",
        description: "Wait for clips to finish, then try again.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    setLoadPct(0);
    try {
      const files: File[] = [];
      const extras: number[] = [];
      for (let i = 0; i < targetClips.length; i++) {
        const clip = targetClips[i]!;
        const blob = clipBlobsRef.current.get(clip.index);
        if (!blob) throw new Error(`Clip #${clip.index}: not available`);
        const type = blob.type || "video/mp4";
        files.push(new File([blob], clip.filename, { type }));
        // Aligned with files[]: per-clip head extra in seconds (0 if unknown).
        extras.push(clipExtrasRef.current.get(clip.index) ?? 0);
        setLoadPct(Math.round(((i + 1) / targetClips.length) * 100));
      }
      onSendToCutting(files, extras);

      // ── Hand-off cleanup (Option A) ──────────────────────────────
      // Release the ~300-500MB WASM engine and drop blob/URL refs so
      // the receiving tab's ffmpeg has memory headroom and the browser
      // can reclaim the clip data once File copies above are consumed.
      // The job/status state stays so the UI still shows "done", but
      // the heavy underlying buffers are gone.
      try {
        revokeAllClipUrls();
      } catch {
        // ignore
      }
      disposeFFmpeg();

      toast({
        title: `Loaded ${files.length} clip${files.length === 1 ? "" : "s"} to Cutting++`,
        description: "Memory freed for next tab.",
      });
    } catch (err) {
      toast({
        title: "Load failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleDownloadZip() {
    if (!job) return;
    const doneClips = job.clips.filter(
      (c) => statusByIndex.get(c.index)?.status === "done",
    );
    if (doneClips.length === 0) {
      toast({
        title: "No clips ready yet.",
        variant: "destructive",
      });
      return;
    }
    try {
      const zip = new JSZip();
      for (const clip of doneClips) {
        const blob = clipBlobsRef.current.get(clip.index);
        if (!blob) continue;
        zip.file(clip.filename, blob);
      }
      const zipBlob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job.baseName || "clips"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      toast({
        title: "ZIP failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  const canRun = !!videoFile && !!srtFile && !uploading && !job;

  // Notify parent of currently-available output files (done clips) so other
  // tabs (e.g. Cutting +) can pull them in on demand.
  useEffect(() => {
    if (!onOutputsChange) return;
    if (!job || !status) {
      onOutputsChange([]);
      return;
    }
    const files: File[] = [];
    for (const c of job.clips) {
      const st = status.clips.find((s) => s.index === c.index);
      if (st?.status !== "done") continue;
      const blob = clipBlobsRef.current.get(c.index);
      if (!blob) continue;
      const type = blob.type || "video/mp4";
      files.push(new File([blob], c.filename, { type }));
    }
    onOutputsChange(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.done, status?.errors, status?.finished, job?.total, onOutputsChange]);

  // Build merged view: clip metadata + live status
  const statusByIndex = new Map<number, ClipStatus>(
    (status?.clips ?? []).map((c) => [c.index, c]),
  );
  const doneCount = status?.done ?? 0;
  const errorCount = status?.errors ?? 0;
  const total = job?.total ?? 0;
  const overallPct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="min-h-screen w-full bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.10),transparent_60%),radial-gradient(ellipse_at_bottom_right,_rgba(244,114,182,0.10),transparent_55%)] bg-slate-50 dark:bg-slate-950">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Top bar */}
        <div className="rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 backdrop-blur-md shadow-sm px-5 py-3 flex items-center gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-md">
              <Scissors className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50 leading-tight">
                Video Spliter
              </h1>
              <p className="text-[11px] text-slate-500 leading-tight">
                {job ? (
                  <>
                    <span className="font-semibold text-slate-700 dark:text-slate-200">
                      {doneCount}
                    </span>{" "}
                    of {total} clips ready
                    {errorCount > 0 && (
                      <span className="text-red-500"> · {errorCount} failed</span>
                    )}
                    {status?.finished && doneCount === total && (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {" "}
                        · all done
                      </span>
                    )}
                  </>
                ) : (
                  <>One clip per subtitle line</>
                )}
              </p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-3">
            {srtPreview && !job && (
              <div className="hidden sm:flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
                <span>
                  <span className="font-semibold text-slate-900 dark:text-slate-50">
                    {srtPreview.count}
                  </span>{" "}
                  subtitles
                </span>
                <span className="text-slate-300 dark:text-slate-700">·</span>
                <span>{formatDuration(srtPreview.totalSeconds)}</span>
              </div>
            )}
            {job && doneCount > 0 && onSendToCutting && (
              <button
                type="button"
                onClick={handleLoadToCutting}
                disabled={loading}
                title={
                  selected.size > 0
                    ? `Load ${selected.size} selected clip${selected.size === 1 ? "" : "s"} to Cutting++`
                    : "Load all done clips to Cutting++"
                }
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-bold tracking-wider uppercase shadow-md transition-all disabled:opacity-60"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {loadPct}%
                  </>
                ) : (
                  <>
                    <FolderInput className="w-3.5 h-3.5" />
                    Load To Cutting +
                  </>
                )}
              </button>
            )}
            {job && doneCount > 0 && (
              <button
                type="button"
                onClick={handleDownloadZip}
                className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 hover:from-indigo-700 hover:via-violet-700 hover:to-fuchsia-700 text-white text-xs font-bold tracking-wider uppercase shadow-md transition-all"
              >
                <Download className="w-3.5 h-3.5" />
                ZIP
              </button>
            )}
            {job ? (
              <Button
                variant="outline"
                size="sm"
                onClick={reset}
                className={
                  status && !status.finished
                    ? "h-7 rounded-md text-xs px-3 border-red-500 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-500/60 dark:text-red-400 dark:hover:bg-red-500/10"
                    : "h-7 rounded-md text-xs px-3"
                }
              >
                {status && !status.finished ? "Cancel" : "New job"}
              </Button>
            ) : (
              <Button
                onClick={startSegment}
                disabled={!canRun}
                className="h-9 rounded-lg px-4 text-xs font-bold tracking-wider uppercase bg-gradient-to-r from-indigo-600 via-violet-600 to-fuchsia-600 hover:from-indigo-700 hover:via-violet-700 hover:to-fuchsia-700 text-white shadow-md disabled:opacity-50"
              >
                {uploading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                    Loading {uploadPct}%
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5 mr-2" />
                    Video Split
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Upload tiles */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <UploadTile
            tone="emerald"
            icon={<FileText className="w-5 h-5" />}
            title="Upload SRT"
            hint={previewing ? "Parsing…" : "SubRip subtitle (.srt)"}
            file={srtFile}
            onPick={handleSrtChange}
            onClear={() => {
              setSrtFile(null);
              setSrtPreview(null);
            }}
            accept=".srt,text/plain"
            alert={
              srtPreview && (srtPreview.overlapCount ?? 0) > 0
                ? {
                    title: `Overlapping subtitles detected (${srtPreview.overlapCount})`,
                    detail:
                      srtPreview.overlaps && srtPreview.overlaps.length > 0
                        ? `e.g. #${srtPreview.overlaps[0]!.a} overlaps #${srtPreview.overlaps[0]!.b} by ${srtPreview.overlaps[0]!.overlapSec}s. Clips may contain duplicate footage.`
                        : "Some cues overlap in time. Clips may contain duplicate footage.",
                  }
                : null
            }
          />
          <UploadTile
            tone="rose"
            icon={<Film className="w-5 h-5" />}
            title="Upload Video"
            hint="MP4, MOV, MKV, WebM…"
            file={videoFile}
            onPick={setVideoFile}
            onClear={() => setVideoFile(null)}
            accept="video/*"
          />
        </div>

        {/* Loading progress (between tiles and grid) */}
        {uploading && (
          <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 backdrop-blur p-4">
            <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 mb-2">
              <span>Loading video into engine…</span>
              <span className="font-mono">{uploadPct}%</span>
            </div>
            <Progress value={uploadPct} />
          </div>
        )}

        {/* Keyframe scan status — needed for cue-accurate trim in Cutting+ */}
        {scanningKeyframes && (
          <div
            className="mt-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/30 backdrop-blur p-3 text-xs text-amber-900 dark:text-amber-200 flex items-center gap-2"
            data-testid="splitter-scanning-keyframes"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              Scanning keyframes for cue-accurate alignment… clips will carry a
              head-extra value to Cutting+ for millisecond-perfect cuts.
            </span>
          </div>
        )}

        {/* Job progress bar — only while processing */}
        {job && overallPct < 100 && (
          <div className="mt-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 backdrop-blur-md p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2 text-xs text-slate-500">
              <span>Progress</span>
              <span className="font-mono">{overallPct}%</span>
            </div>
            <Progress value={overallPct} />
          </div>
        )}

        {/* Clip grid */}
        {job && (
          <div className="mt-4 rounded-2xl border border-slate-200/80 dark:border-slate-800 bg-white/60 dark:bg-slate-900/50 backdrop-blur-md p-4 shadow-sm">
            {onSendToCutting && doneCount > 0 && (
              <div className="mb-3 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  {selected.size > 0 ? (
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {selected.size} selected
                    </span>
                  ) : (
                    <>Tip: tick clips to load only those, or leave empty to load all done</>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const doneIdx = job.clips
                        .filter((c) => statusByIndex.get(c.index)?.status === "done")
                        .map((c) => c.index);
                      setSelected(new Set(doneIdx));
                    }}
                    className="px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                  >
                    Select all done
                  </button>
                  {selected.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}
            <div
              className="grid gap-2 max-h-[68vh] overflow-y-auto pr-1"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(140px, 1fr))",
              }}
            >
              {job.clips.map((clip) => {
                const s = statusByIndex.get(clip.index)?.status ?? "pending";
                const err = statusByIndex.get(clip.index)?.error;
                const downloadUrl = clipUrlsRef.current.get(clip.index) ?? "";
                const duration = clip.endSec - clip.startSec;
                const isDone = s === "done";

                const ring =
                  s === "done"
                    ? "ring-1 ring-emerald-200 dark:ring-emerald-900/50"
                    : s === "error"
                      ? "ring-1 ring-red-200 dark:ring-red-900/50"
                      : s === "running"
                        ? "ring-1 ring-indigo-200 dark:ring-indigo-900/50"
                        : "ring-1 ring-slate-200 dark:ring-slate-800";

                const statusDot = (() => {
                  if (s === "done")
                    return (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/90 text-white text-[10px] font-medium">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                      </span>
                    );
                  if (s === "running")
                    return (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-indigo-500/90 text-white text-[10px] font-medium">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      </span>
                    );
                  if (s === "error")
                    return (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-red-500/90 text-white text-[10px] font-medium">
                        <AlertCircle className="w-2.5 h-2.5" />
                      </span>
                    );
                  return (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-700/80 text-white text-[10px] font-medium">
                      <Clock className="w-2.5 h-2.5" />
                    </span>
                  );
                })();

                const isSelected = selected.has(clip.index);
                return (
                  <div
                    key={clip.index}
                    title={clip.text}
                    className={`group relative flex flex-col rounded-xl overflow-hidden bg-white dark:bg-slate-900 ${ring} ${
                      isSelected ? "ring-2 ring-emerald-500 dark:ring-emerald-400" : ""
                    } hover:ring-2 hover:ring-indigo-300 dark:hover:ring-indigo-700 transition-all`}
                  >
                    {isDone && onSendToCutting && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(clip.index);
                        }}
                        className={`absolute top-1 right-8 z-10 w-5 h-5 inline-flex items-center justify-center rounded-md backdrop-blur ${
                          isSelected
                            ? "bg-emerald-500 text-white"
                            : "bg-white/80 dark:bg-slate-900/70 text-slate-600 dark:text-slate-300 opacity-0 group-hover:opacity-100"
                        } transition-opacity`}
                        aria-label={isSelected ? "Deselect" : "Select"}
                      >
                        {isSelected ? (
                          <CheckSquare className="w-3.5 h-3.5" />
                        ) : (
                          <Square className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!isDone}
                      onClick={() => isDone && setPreviewClip(clip)}
                      className={`relative w-full aspect-video bg-slate-100 dark:bg-slate-800 ${
                        isDone ? "cursor-pointer" : "cursor-default"
                      }`}
                    >
                      <ClipThumb status={s} index={clip.index} />
                      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-mono leading-none">
                        #{clip.index}
                      </div>
                      <div className="absolute top-1 right-1">{statusDot}</div>
                      <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-mono leading-none">
                        {duration.toFixed(1)}s
                      </div>
                      {(() => {
                        const extra = clipExtrasRef.current.get(clip.index) ?? 0;
                        if (extra <= 0.001) return null;
                        return (
                          <div
                            className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded-md bg-amber-500/90 text-white text-[10px] font-mono leading-none"
                            title={`Head-extra ${extra.toFixed(3)}s — Cutting+ will trim this for cue-accurate alignment`}
                            data-testid={`splitter-extra-${clip.index}`}
                          >
                            +{extra.toFixed(2)}s
                          </div>
                        );
                      })()}
                    </button>

                    <div className="px-2 py-1.5 flex items-center gap-1.5">
                      <p className="flex-1 min-w-0 text-[11px] leading-tight text-slate-700 dark:text-slate-300 truncate">
                        {clip.text || (
                          <span className="text-slate-400">(no text)</span>
                        )}
                      </p>
                      {isDone && downloadUrl ? (
                        <a
                          href={downloadUrl}
                          download={clip.filename}
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md bg-indigo-600 hover:bg-indigo-700 text-white"
                          aria-label="Download"
                        >
                          <Download className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-300 dark:text-slate-600">
                          <Download className="w-3 h-3" />
                        </span>
                      )}
                    </div>

                    {err && (
                      <div className="px-2 pb-1.5 -mt-1">
                        <p className="text-[10px] text-red-500 line-clamp-2">
                          {err}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="mt-3 text-center text-[11px] text-slate-500">
              Runs fully in your browser · stream-copy (no re-encode) · clips
              cleared on reset
            </p>
          </div>
        )}

        {previewClip && job && clipUrlsRef.current.get(previewClip.index) && (
          <PreviewModal
            src={clipUrlsRef.current.get(previewClip.index)!}
            filename={previewClip.filename}
            onClose={() => setPreviewClip(null)}
          />
        )}

        {!job && !uploading && (
          <p className="mt-6 text-center text-xs text-slate-500">
            Drop a video and its <span className="font-mono">.srt</span> above,
            then hit{" "}
            <span className="font-semibold tracking-wider">VIDEO SPLIT</span>.
          </p>
        )}
      </div>
    </div>
  );
}

function App({
  incomingSrt,
  incomingSrtFilename,
  incomingSrtKey,
  onSendToCutting,
  onOutputsChange,
}: {
  incomingSrt?: string;
  incomingSrtFilename?: string;
  incomingSrtKey?: number;
  onSendToCutting?: (files: File[], extras?: number[]) => void;
  onOutputsChange?: (files: File[]) => void;
} = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Home
          incomingSrt={incomingSrt}
          incomingSrtFilename={incomingSrtFilename}
          incomingSrtKey={incomingSrtKey}
          onSendToCutting={onSendToCutting}
          onOutputsChange={onOutputsChange}
        />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
