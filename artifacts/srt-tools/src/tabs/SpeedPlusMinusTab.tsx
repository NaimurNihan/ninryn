import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  CheckCircle2,
  Play,
  Download,
  X,
  ArrowRight,
  Music,
  Film,
  UploadCloud,
  Plus,
  Trash2,
  FolderOpen,
  GripVertical,
  Upload,
  AlertTriangle,
  Activity,
  CheckCheck,
  AlertCircle,
  Gauge,
  FastForward,
  Rewind,
} from "lucide-react";

// Speed +- constraint: video may be slowed down or sped up only within
// this factor window (audioDuration / videoDuration). Outside the window
// the motion gets too jerky / unwatchable, so we mark the card as an
// error instead of processing it.
const MIN_SPEED_FACTOR = 0.5;
const MAX_SPEED_FACTOR = 2.0;
// Floor under which we treat the durations as already matching and skip
// any processing (avoids 0.999x re-encodes).
const SPEED_EPSILON = 0.005;

type PoolItem = {
  id: string;
  file: File;
  kind: "audio" | "video";
  duration: number | null;
};

const PoolContext = createContext<{
  getFile: (id: string) => File | undefined;
}>({ getFile: () => undefined });

const POOL_MIME_ID = "application/x-pool-id";
const POOL_MIME_KIND = "application/x-pool-kind";

// Self-host ffmpeg core files under /ffmpeg/{st,mt}/ so they load
// same-origin and don't need cross-origin fetch headers under COEP.
// Base path is respected so the artifact-prefix routing keeps working.
function ffmpegBaseUrl(mt: boolean): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
  return `${base}/ffmpeg/${mt ? "mt" : "st"}`;
}
const INITIAL_CARDS = 6;

// Multi-threaded ffmpeg core needs SharedArrayBuffer + cross-origin
// isolation (COOP/COEP). When available, libx264 encoding uses all CPU
// cores and runs ~2-4x faster than the single-threaded core.
function canUseMtCore(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof SharedArrayBuffer === "undefined") return false;
  return Boolean((window as unknown as { crossOriginIsolated?: boolean })
    .crossOriginIsolated);
}

// Pool of independent ffmpeg engines so cards can encode in parallel.
// Each engine is single-job-at-a-time (ffmpeg.wasm limitation), so the
// pool size determines max concurrent cards. With short 12-15s clips,
// 2 parallel engines roughly doubles throughput without RAM blowup.
// On low-core machines we fall back to 1 to avoid CPU thrashing.
function pickPoolSize(): number {
  if (typeof navigator === "undefined") return 2;
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 2) return 1;
  return 2;
}
const ENGINE_POOL_SIZE = pickPoolSize();

// Recycle each engine every N successful jobs to keep WASM heap
// healthy. Cutting++ does ~3 exec + 2 writeFile + 2 readFile per job
// (much heavier than Cutting+), so we recycle more aggressively.
const RECYCLE_EVERY_PP = 5;

// Auto-archive successful jobs into the ZIP after every BATCH_SIZE_PP cuts
// and revoke their blob URLs to keep RAM bounded. Lets users process 200+
// files without crashing the tab.
const BATCH_SIZE_PP = 25;

const MEMORY_ERROR_PATTERNS = [
  "memory access out of bounds",
  "out of memory",
  "Cannot enlarge memory",
  "table index is out of bounds",
  "Aborted",
];

function isMemoryError(message: string | undefined | null): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return MEMORY_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function formatSeconds(s: number): string {
  if (!isFinite(s) || s < 0) return "0.00s";
  return `${s.toFixed(2)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const DURATION_CONCURRENCY = 3;
let __durationActive = 0;
const __durationQueue: (() => void)[] = [];

function __acquireDurationSlot(): Promise<void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (__durationActive < DURATION_CONCURRENCY) {
        __durationActive++;
        resolve();
      } else {
        __durationQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function __releaseDurationSlot() {
  __durationActive--;
  const next = __durationQueue.shift();
  if (next) next();
}

function readDurationOnce(file: File, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind) as HTMLMediaElement;
    el.preload = "metadata";
    (el as HTMLVideoElement).muted = true;
    const url = URL.createObjectURL(file);
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      el.src = "";
      el.removeAttribute("src");
      try {
        el.load();
      } catch {}
    };
    const finish = (d: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!isFinite(d) || d <= 0) {
        reject(new Error(`Could not read duration of ${kind} file`));
      } else {
        resolve(d);
      }
    };

    el.onloadedmetadata = () => {
      const d = el.duration;
      if (isFinite(d) && d > 0) {
        finish(d);
        return;
      }
      const onTimeUpdate = () => {
        el.ontimeupdate = null;
        const real = el.duration;
        try {
          el.currentTime = 0;
        } catch {}
        finish(real);
      };
      el.ontimeupdate = onTimeUpdate;
      try {
        el.currentTime = 1e9;
      } catch {
        finish(NaN);
      }
    };
    el.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to load ${kind} file`));
    };

    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Timed out reading duration of ${kind} file`));
      }
    }, 45000);

    el.src = url;
  });
}

async function getMediaDuration(file: File, kind: "audio" | "video"): Promise<number> {
  await __acquireDurationSlot();
  try {
    try {
      return await readDurationOnce(file, kind);
    } catch (err) {
      // One automatic retry — sometimes browsers fail under load
      try {
        return await readDurationOnce(file, kind);
      } catch {
        throw err;
      }
    }
  } finally {
    __releaseDurationSlot();
  }
}

type Stage = "idle" | "reading" | "cutting" | "done" | "error";

type CardState = {
  canCut: boolean;
  isWorking: boolean;
  mode?: "speedup" | "slowdown" | null;
  hasAudio: boolean;
  hasVideo: boolean;
  isDone: boolean;
  mergedUrl?: string | null;
  mergedName?: string;
  isArchived?: boolean;
};

const DEFAULT_CARD_STATE: CardState = {
  canCut: false,
  isWorking: false,
  hasAudio: false,
  hasVideo: false,
  isDone: false,
};

function sameCardState(a: CardState, b: CardState): boolean {
  return (
    a.canCut === b.canCut &&
    a.isWorking === b.isWorking &&
    a.hasAudio === b.hasAudio &&
    a.hasVideo === b.hasVideo &&
    a.isDone === b.isDone &&
    a.mode === b.mode &&
    a.mergedUrl === b.mergedUrl &&
    a.mergedName === b.mergedName &&
    !!a.isArchived === !!b.isArchived
  );
}

export type CutterCardHandle = {
  runCut: () => Promise<{ url: string; name: string } | null>;
  loadAudio: (file: File) => void;
  loadVideo: (file: File) => void;
  markArchived: () => void;
};

type IncomingAudioFiles = { files: File[]; key: number };

function VideoCutterApp({
  incomingAudioFiles,
  incomingVideoFiles,
}: {
  incomingAudioFiles?: IncomingAudioFiles;
  incomingVideoFiles?: { files: File[]; key: number };
}) {
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(true);
  const [ffmpegError, setFfmpegError] = useState<string>("");

  // Whether we're using the multi-threaded core. Decided once at boot,
  // based on cross-origin isolation. Falls back automatically if MT load
  // fails (e.g. unpkg blocked).
  const useMtRef = useRef<boolean>(canUseMtCore());

  // Each engine slot is an independent ffmpeg.wasm instance. Cards lease
  // a slot for the duration of one runCut, then release it. Each slot
  // has its own progress callback so concurrent jobs don't trample each
  // other's progress bars.
  type EngineSlot = {
    id: number;
    ffmpeg: FFmpeg | null;
    jobsSinceRecycle: number;
    busy: boolean;
    loading: Promise<FFmpeg> | null;
    progressCb: ((p: number) => void) | null;
  };

  const slotsRef = useRef<EngineSlot[]>([]);
  const slotWaitersRef = useRef<Array<() => void>>([]);

  // Build a fresh ffmpeg engine bound to a specific slot's progress
  // callback. Used for first load AND every recycle. Tries MT core first
  // (when isolated); on failure falls back to single-threaded core.
  const loadFreshFFmpeg = async (slot: EngineSlot): Promise<FFmpeg> => {
    const ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress }) => {
      const p = Math.min(100, Math.max(0, Math.round(progress * 100)));
      slot.progressCb?.(p);
    });

    const tryLoad = async (mt: boolean) => {
      const base = ffmpegBaseUrl(mt);
      const coreURL = await toBlobURL(
        `${base}/ffmpeg-core.js`,
        "text/javascript",
      );
      const wasmURL = await toBlobURL(
        `${base}/ffmpeg-core.wasm`,
        "application/wasm",
      );
      const opts: { coreURL: string; wasmURL: string; workerURL?: string } = {
        coreURL,
        wasmURL,
      };
      if (mt) {
        opts.workerURL = await toBlobURL(
          `${base}/ffmpeg-core.worker.js`,
          "text/javascript",
        );
      }
      await ffmpeg.load(opts);
    };

    if (useMtRef.current) {
      try {
        await tryLoad(true);
        return ffmpeg;
      } catch (err) {
        console.warn(
          "[Speed+-] MT ffmpeg core failed to load, falling back to single-thread:",
          err,
        );
        useMtRef.current = false;
      }
    }
    await tryLoad(false);
    return ffmpeg;
  };

  // Initialize the engine pool. Engines load in parallel so startup time
  // is roughly the same as loading one engine.
  useEffect(() => {
    let cancelled = false;
    const slots: EngineSlot[] = Array.from(
      { length: ENGINE_POOL_SIZE },
      (_, i) => ({
        id: i,
        ffmpeg: null,
        jobsSinceRecycle: 0,
        busy: false,
        loading: null,
        progressCb: null,
      }),
    );
    slotsRef.current = slots;

    Promise.all(
      slots.map(async (slot) => {
        const ff = await loadFreshFFmpeg(slot);
        slot.ffmpeg = ff;
      }),
    )
      .then(() => {
        if (cancelled) return;
        setFfmpegReady(true);
        setFfmpegLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        setFfmpegLoading(false);
        setFfmpegError("Failed to load video engine. Please refresh.");
      });

    return () => {
      cancelled = true;
      // Best-effort cleanup so a hot-reload doesn't leak workers.
      for (const s of slots) {
        const ff = s.ffmpeg;
        if (ff) {
          try {
            ff.terminate();
          } catch {
            /* ignore */
          }
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force-terminate one slot's engine and load a fresh one in place.
  const recycleSlot = async (slot: EngineSlot): Promise<void> => {
    if (slot.loading) {
      await slot.loading;
      return;
    }
    const old = slot.ffmpeg;
    slot.ffmpeg = null;
    slot.loading = (async () => {
      if (old) {
        try {
          old.terminate();
        } catch {
          /* ignore */
        }
      }
      const fresh = await loadFreshFFmpeg(slot);
      slot.ffmpeg = fresh;
      slot.jobsSinceRecycle = 0;
      return fresh;
    })();
    try {
      await slot.loading;
    } finally {
      slot.loading = null;
    }
  };

  // Lease an idle slot. If all are busy, wait until one is released.
  // Recycles the slot first if it has hit the job-count threshold.
  const acquireSlot = async (
    progressCb: (p: number) => void,
  ): Promise<EngineSlot> => {
    while (true) {
      const slots = slotsRef.current;
      const idle = slots.find((s) => !s.busy && !s.loading);
      if (idle) {
        idle.busy = true;
        idle.progressCb = progressCb;
        if (!idle.ffmpeg || idle.jobsSinceRecycle >= RECYCLE_EVERY_PP) {
          await recycleSlot(idle);
        }
        return idle;
      }
      await new Promise<void>((resolve) => {
        slotWaitersRef.current.push(resolve);
      });
    }
  };

  const releaseSlot = (slot: EngineSlot) => {
    slot.busy = false;
    slot.progressCb = null;
    const next = slotWaitersRef.current.shift();
    if (next) next();
  };

  const [pool, setPool] = useState<PoolItem[]>([]);
  const poolRef = useRef<PoolItem[]>([]);
  poolRef.current = pool;

  const poolCtx = useMemo(
    () => ({
      getFile: (id: string) =>
        poolRef.current.find((p) => p.id === id)?.file,
    }),
    [],
  );

  const addPoolFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    const newItems: PoolItem[] = [];
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      const kind: "audio" | "video" | null = f.type.startsWith("audio/")
        ? "audio"
        : f.type.startsWith("video/")
        ? "video"
        : null;
      if (!kind) continue;
      const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;
      newItems.push({ id, file: f, kind, duration: null });
    }
    if (newItems.length === 0) return;
    // Single state update for the whole batch. Durations are intentionally
    // NOT read here — with 200+ files, sequential reads + per-file
    // setPool() re-renders cause the tab to hang. Each card reads its own
    // file's duration lazily when the file is loaded into it.
    setPool((p) => [...p, ...newItems]);
  };

  const removePoolItem = (id: string) => {
    setPool((p) => p.filter((x) => x.id !== id));
  };

  const lastIncomingKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!incomingAudioFiles) return;
    if (incomingAudioFiles.key === lastIncomingKeyRef.current) return;
    if (!incomingAudioFiles.files || incomingAudioFiles.files.length === 0) return;
    lastIncomingKeyRef.current = incomingAudioFiles.key;
    void addPoolFiles(incomingAudioFiles.files);
  }, [incomingAudioFiles]);

  const lastIncomingVideoKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!incomingVideoFiles) return;
    if (incomingVideoFiles.key === lastIncomingVideoKeyRef.current) return;
    if (!incomingVideoFiles.files || incomingVideoFiles.files.length === 0) return;
    lastIncomingVideoKeyRef.current = incomingVideoFiles.key;
    void addPoolFiles(incomingVideoFiles.files);
  }, [incomingVideoFiles]);

  const clearPool = () => setPool([]);

  const [numCards, setNumCards] = useState(INITIAL_CARDS);
  const cardRefs = useRef<(CutterCardHandle | null)[]>(
    Array(INITIAL_CARDS).fill(null),
  );
  const [cardStates, setCardStates] = useState<CardState[]>(
    Array.from({ length: INITIAL_CARDS }, () => ({ ...DEFAULT_CARD_STATE })),
  );
  // Live snapshot of cardStates that's always current (synchronously updated
  // by setCardState). Used by runByMode to avoid 1-frame lag from React state.
  const cardStatesRef = useRef<CardState[]>(cardStates);
  useEffect(() => {
    cardStatesRef.current = cardStates;
  }, [cardStates]);

  // rAF-debounced bulk setter for card states. With 250 cards, each card's
  // useEffect can fire onStateChange dozens of times during a render cycle.
  // Coalescing them into a single setCardStates per animation frame keeps
  // the UI responsive instead of triggering hundreds of parent re-renders.
  const pendingUpdatesRef = useRef<Map<number, CardState>>(new Map());
  const rafScheduledRef = useRef(false);

  const setCardState = useCallback((idx: number, s: CardState) => {
    pendingUpdatesRef.current.set(idx, s);
    if (rafScheduledRef.current) return;
    rafScheduledRef.current = true;
    requestAnimationFrame(() => {
      rafScheduledRef.current = false;
      const updates = pendingUpdatesRef.current;
      pendingUpdatesRef.current = new Map();
      if (updates.size === 0) return;
      setCardStates((prev) => {
        let maxIdx = prev.length - 1;
        updates.forEach((_, i) => {
          if (i > maxIdx) maxIdx = i;
        });
        const next = prev.slice();
        while (next.length <= maxIdx) {
          next.push({ ...DEFAULT_CARD_STATE });
        }
        let changed = false;
        updates.forEach((s, i) => {
          const cur = next[i];
          // Preserve parent-controlled isArchived if the reporter (card)
          // didn't supply one.
          const merged: CardState = {
            ...s,
            isArchived: s.isArchived ?? cur.isArchived,
          };
          if (sameCardState(cur, merged)) return;
          next[i] = merged;
          changed = true;
        });
        if (!changed) return prev;
        cardStatesRef.current = next;
        return next;
      });
    });
  }, []);

  const [running, setRunning] = useState(false);
  const [downloadCount, setDownloadCount] = useState(0);
  const incrementDownload = useCallback(() => setDownloadCount((n) => n + 1), []);
  const [zipping, setZipping] = useState(false);
  const [archivedCount, setArchivedCount] = useState(0);
  const [archiving, setArchiving] = useState(false);

  // Accumulating ZIP that holds outputs from completed batches. Blob URLs
  // for archived cards are revoked after they're added here, so RAM stays
  // bounded even when processing 200+ files.
  const archiveZipRef = useRef<unknown>(null);
  const archivedNamesRef = useRef<Set<string>>(new Set());

  const archiveBatch = useCallback(
    async (
      items: Array<{ idx: number; url: string; name: string }>,
    ): Promise<void> => {
      if (items.length === 0) return;
      setArchiving(true);
      try {
        const { default: JSZip } = await import("jszip");
        type ZipLike = { file: (name: string, blob: Blob) => void };
        if (!archiveZipRef.current) archiveZipRef.current = new JSZip();
        const zip = archiveZipRef.current as ZipLike;
        for (const { idx, url, name } of items) {
          try {
            const res = await fetch(url);
            const blob = await res.blob();
            let finalName = name;
            if (archivedNamesRef.current.has(finalName)) {
              const dot = finalName.lastIndexOf(".");
              const base = dot > 0 ? finalName.slice(0, dot) : finalName;
              const ext = dot > 0 ? finalName.slice(dot) : "";
              finalName = `${base}-${idx + 1}${ext}`;
            }
            archivedNamesRef.current.add(finalName);
            zip.file(finalName, blob);
            URL.revokeObjectURL(url);
            cardRefs.current[idx]?.markArchived();
          } catch (e) {
            console.error(
              `[Cutting++] Archive failed for card ${idx + 1}:`,
              e,
            );
          }
        }
        setArchivedCount((c) => c + items.length);
      } finally {
        setArchiving(false);
      }
    },
    [],
  );

  const handleDownloadZip = async () => {
    const liveReady = cardStates
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) => c.isDone && !c.isArchived && c.mergedUrl && c.mergedName,
      );
    const hasArchive = !!archiveZipRef.current;
    if (!hasArchive && liveReady.length === 0) return;
    setZipping(true);
    try {
      const { default: JSZip } = await import("jszip");
      type ZipLike = {
        file: (name: string, blob: Blob) => void;
        generateAsync: (options: { type: "blob" }) => Promise<Blob>;
      };
      if (!archiveZipRef.current) archiveZipRef.current = new JSZip();
      const zip = archiveZipRef.current as ZipLike;
      const used = new Set<string>(archivedNamesRef.current);
      for (const { c, i } of liveReady) {
        const res = await fetch(c.mergedUrl!);
        const blob = await res.blob();
        let name = c.mergedName || `merged-${i + 1}.mp4`;
        if (used.has(name)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          name = `${base}-${i + 1}${ext}`;
        }
        used.add(name);
        zip.file(name, blob);
      }
      const out = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(out);
      const a = document.createElement("a");
      a.href = url;
      a.download = `video-clips-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setDownloadCount((n) => n + archivedCount + liveReady.length);
    } catch (e) {
      console.error("zip failed", e);
    } finally {
      setZipping(false);
    }
  };

  const addCard = () => {
    setNumCards((n) => {
      const next = n + 1;
      cardRefs.current.length = next;
      return next;
    });
    setCardStates((prev) => {
      const next = [...prev, { ...DEFAULT_CARD_STATE }];
      cardStatesRef.current = next;
      return next;
    });
  };

  const ensureCards = (count: number) => {
    if (count <= numCards) return;
    cardRefs.current.length = count;
    setNumCards(count);
    setCardStates((prev) => {
      if (prev.length >= count) return prev;
      const next = prev.slice();
      while (next.length < count) {
        next.push({ ...DEFAULT_CARD_STATE });
      }
      cardStatesRef.current = next;
      return next;
    });
  };

  const extractCardNumber = (filename: string): number | null => {
    const m = filename.match(/(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!isFinite(n) || n <= 0) return null;
    return n;
  };

  const pendingLoadRef = useRef<{
    kind: "audio" | "video";
    assignments: { cardIndex: number; file: File }[];
    fallbackFiles: File[];
    requiredCards: number;
  } | null>(null);

  const flushPendingLoad = () => {
    const pending = pendingLoadRef.current;
    if (!pending) return;
    const { kind, assignments, fallbackFiles } = pending;
    const used = new Set<number>();
    let allAssigned = true;

    for (const { cardIndex, file } of assignments) {
      const handle = cardRefs.current[cardIndex];
      if (!handle) {
        allAssigned = false;
        continue;
      }
      if (kind === "audio") handle.loadAudio(file);
      else handle.loadVideo(file);
      used.add(cardIndex);
    }

    let nextSlot = 0;
    for (const file of fallbackFiles) {
      while (used.has(nextSlot)) nextSlot++;
      const handle = cardRefs.current[nextSlot];
      if (!handle) {
        allAssigned = false;
        break;
      }
      if (kind === "audio") handle.loadAudio(file);
      else handle.loadVideo(file);
      used.add(nextSlot);
      nextSlot++;
    }

    if (allAssigned) {
      pendingLoadRef.current = null;
    }
  };

  useEffect(() => {
    if (!pendingLoadRef.current) return;
    if (numCards < pendingLoadRef.current.requiredCards) return;
    const id = requestAnimationFrame(() => flushPendingLoad());
    return () => cancelAnimationFrame(id);
  }, [numCards]);

  const loadPoolToCards = (kind: "audio" | "video") => {
    const items = poolRef.current.filter((p) => p.kind === kind);
    if (items.length === 0) return;

    const assignments: { cardIndex: number; file: File }[] = [];
    const fallbackFiles: File[] = [];
    const claimed = new Set<number>();

    for (const it of items) {
      const num = extractCardNumber(it.file.name);
      if (num !== null && !claimed.has(num - 1)) {
        assignments.push({ cardIndex: num - 1, file: it.file });
        claimed.add(num - 1);
      } else {
        fallbackFiles.push(it.file);
      }
    }

    let maxIndex = -1;
    for (const a of assignments) {
      if (a.cardIndex > maxIndex) maxIndex = a.cardIndex;
    }
    const requiredCards = Math.max(
      maxIndex + 1,
      assignments.length + fallbackFiles.length,
    );

    pendingLoadRef.current = { kind, assignments, fallbackFiles, requiredCards };
    if (requiredCards > numCards) {
      ensureCards(requiredCards);
    } else {
      flushPendingLoad();
    }
  };

  const anyWorking =
    running || archiving || cardStates.some((c) => c.isWorking);
  const anyCanSpeed = cardStates.some(
    (c) => c.canCut && (c.mode === "speedup" || c.mode === "slowdown"),
  );
  const audioPoolCount = pool.filter((p) => p.kind === "audio").length;
  const videoPoolCount = pool.filter((p) => p.kind === "video").length;
  const speedUpCount = cardStates.filter(
    (c) => c.canCut && c.mode === "speedup",
  ).length;
  const slowDownCount = cardStates.filter(
    (c) => c.canCut && c.mode === "slowdown",
  ).length;
  const activeCount = cardStates.filter(
    (c) => c.hasAudio && c.hasVideo && !c.isDone,
  ).length;
  const completeCount = cardStates.filter((c) => c.isDone).length;
  const errorCount = cardStates.filter(
    (c) =>
      c.hasAudio !== c.hasVideo ||
      (c.hasAudio &&
        c.hasVideo &&
        !c.isDone &&
        !c.isWorking &&
        !c.canCut &&
        !c.mode),
  ).length;
  const canRunSpeed = ffmpegReady && anyCanSpeed && !anyWorking;

  const runSpeed = async () => {
    setRunning(true);
    const pendingArchive: Array<{ idx: number; url: string; name: string }> =
      [];
    try {
      // Build the queue of cards that should be processed.
      const queue: number[] = [];
      for (let i = 0; i < numCards; i++) {
        // Read live ref instead of cardStates state — it's up-to-date,
        // even when rAF debouncing hasn't flushed yet.
        const cs = cardStatesRef.current[i];
        if (
          cs?.canCut &&
          (cs.mode === "speedup" || cs.mode === "slowdown") &&
          cardRefs.current[i]
        ) {
          queue.push(i);
        }
      }

      // Spin up POOL_SIZE workers that pull cards off a shared cursor.
      // Each worker leases one engine slot at a time inside runCut, so
      // we never exceed pool capacity. Order of completion may differ
      // from queue order, which is fine — archiveBatch keys by idx.
      let cursor = 0;
      const archiveLock = { busy: false };
      const tryFlushArchive = async () => {
        if (pendingArchive.length < BATCH_SIZE_PP) return;
        if (archiveLock.busy) return;
        archiveLock.busy = true;
        try {
          await archiveBatch(pendingArchive.splice(0));
        } finally {
          archiveLock.busy = false;
        }
      };

      const worker = async () => {
        while (true) {
          const myIdx = cursor++;
          if (myIdx >= queue.length) return;
          const cardIdx = queue[myIdx];
          const result = await cardRefs.current[cardIdx]!.runCut();
          if (result) {
            pendingArchive.push({
              idx: cardIdx,
              url: result.url,
              name: result.name,
            });
            await tryFlushArchive();
          }
        }
      };

      const workerCount = Math.max(1, Math.min(ENGINE_POOL_SIZE, queue.length));
      await Promise.all(
        Array.from({ length: workerCount }, () => worker()),
      );

      if (pendingArchive.length > 0) {
        await archiveBatch(pendingArchive.splice(0));
      }
    } finally {
      setRunning(false);
    }
  };

  const clearAllCards = () => {
    cardRefs.current = [];
    cardStatesRef.current = [];
    pendingUpdatesRef.current.clear();
    archiveZipRef.current = null;
    archivedNamesRef.current = new Set();
    setArchivedCount(0);
    setNumCards(0);
    setCardStates([]);
  };

  const handleSpeed = () => {
    if (canRunSpeed) void runSpeed();
  };

  return (
   <PoolContext.Provider value={poolCtx}>
    <div className="min-h-screen w-full bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Header bar */}
        <div className="mb-8 flex items-center justify-between gap-4 rounded-2xl border-2 border-slate-300 bg-white px-6 py-3 shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-800">
            Video Clip Cutter
          </h1>
          <div className="flex items-center gap-3">
            {ffmpegLoading && (
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading engine…
              </span>
            )}
            {!ffmpegLoading && ffmpegReady && (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Ready
              </span>
            )}
            {ffmpegError && (
              <span className="text-xs text-rose-600">{ffmpegError}</span>
            )}
            {completeCount > 0 && (
              <button
                onClick={handleDownloadZip}
                disabled={zipping}
                data-testid="button-download-zip"
                className="inline-flex min-w-[140px] items-center justify-center rounded-xl border-2 border-indigo-400 bg-white px-5 py-1.5 text-sm font-semibold tracking-wider text-indigo-700 transition hover:border-indigo-600 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {zipping ? (
                  <span className="inline-flex items-center">
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ZIPPING…
                  </span>
                ) : (
                  <span className="inline-flex items-center">
                    <Download className="mr-2 h-3.5 w-3.5" />
                    DOWNLOAD ZIP ({completeCount})
                  </span>
                )}
              </button>
            )}
            <button
              onClick={handleSpeed}
              disabled={!canRunSpeed}
              data-testid="button-speed"
              className="inline-flex min-w-[140px] items-center justify-center rounded-xl border-2 border-violet-400 bg-white px-5 py-1.5 text-sm font-semibold tracking-wider text-violet-700 transition hover:border-violet-600 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {anyWorking ? (
                <span className="inline-flex items-center">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  WORKING…
                </span>
              ) : (
                <span className="inline-flex items-center">
                  <Gauge className="mr-2 h-3.5 w-3.5" />
                  SPEED +-
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Media Pools - separate audio + video */}
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <MediaPool
            kind="audio"
            items={pool.filter((p) => p.kind === "audio")}
            onAdd={addPoolFiles}
            onRemove={removePoolItem}
            onClear={() =>
              setPool((p) => p.filter((x) => x.kind !== "audio"))
            }
            onLoad={() => loadPoolToCards("audio")}
          />
          <MediaPool
            kind="video"
            items={pool.filter((p) => p.kind === "video")}
            onAdd={addPoolFiles}
            onRemove={removePoolItem}
            onClear={() =>
              setPool((p) => p.filter((x) => x.kind !== "video"))
            }
            onLoad={() => loadPoolToCards("video")}
          />
        </div>

        {/* Info card - pool & action summary */}
        <div className="relative mb-6 rounded-2xl border-2 border-slate-200 bg-white px-3 py-2 pr-10 shadow-sm">
          <button
            type="button"
            onClick={clearAllCards}
            disabled={numCards === 0}
            data-testid="button-clear-all-cards"
            title="Remove all cards below"
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-rose-300 bg-rose-50 text-rose-600 shadow-sm transition hover:border-rose-500 hover:bg-rose-100 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className={`flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-2.5 py-1 transition-opacity ${audioPoolCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500 text-white">
                <Music className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                Audio Pool
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-audio-count">
                {audioPoolCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/60 px-2.5 py-1 transition-opacity ${activeCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-500 text-white">
                <Activity className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                Active
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-active-count">
                {activeCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50/60 px-2.5 py-1 transition-opacity ${speedUpCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-violet-600 text-white">
                <FastForward className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-700">
                Speed +
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-speedup-count">
                {speedUpCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/60 px-2.5 py-1 transition-opacity ${errorCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-rose-500 text-white">
                <AlertCircle className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-700">
                Error
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-error-count">
                {errorCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-pink-200 bg-pink-50/60 px-2.5 py-1 transition-opacity ${videoPoolCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-pink-500 text-white">
                <Film className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-pink-700">
                Video Pool
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-video-count">
                {videoPoolCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-green-200 bg-green-50/60 px-2.5 py-1 transition-opacity ${completeCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-green-600 text-white">
                <CheckCheck className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-green-700">
                Complete
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-complete-count">
                {completeCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-fuchsia-200 bg-fuchsia-50/60 px-2.5 py-1 transition-opacity ${slowDownCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-fuchsia-500 text-white">
                <Rewind className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-fuchsia-700">
                Speed -
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-slowdown-count">
                {slowDownCount} <span className="text-[10px] font-medium text-slate-500">cards</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-1 transition-opacity ${downloadCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500 text-white">
                <Download className="h-3 w-3" />
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
                Download
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-download-count">
                {downloadCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
            <div className={`flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50/60 px-2.5 py-1 transition-opacity ${archivedCount === 0 ? "opacity-20" : ""}`}>
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white">
                {archiving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                Archived
              </span>
              <span className="ml-auto text-sm font-bold text-slate-800" data-testid="info-archived-count">
                {archivedCount} <span className="text-[10px] font-medium text-slate-500">files</span>
              </span>
            </div>
          </div>
        </div>

        {/* 2-column grid of cards */}
        <div className="grid gap-5 md:grid-cols-2">
          {Array.from({ length: numCards }, (_, i) => (
            <CutterCard
              key={i}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              index={i + 1}
              engineReady={ffmpegReady}
              acquireSlot={acquireSlot}
              releaseSlot={releaseSlot}
              recycleSlot={recycleSlot}
              onStateChange={setCardState}
              onDownload={incrementDownload}
              highlight={cardStates[i]?.isWorking}
            />
          ))}
          <button
            type="button"
            onClick={addCard}
            data-testid="button-add-card"
            className="group flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 p-4 text-slate-500 transition hover:-translate-y-0.5 hover:border-indigo-400 hover:bg-indigo-50/50 hover:text-indigo-600 hover:shadow-md"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-slate-300 transition group-hover:border-indigo-400 group-hover:bg-white">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold tracking-wide">
              Add card
            </span>
            <span className="text-[11px] text-slate-400">
              Create another clip slot
            </span>
          </button>
        </div>

        <div className="mt-10 text-center text-xs text-slate-500">
          Files never leave your device. All processing happens in your browser.
        </div>
      </div>
    </div>
   </PoolContext.Provider>
  );
}

function MediaPool({
  kind,
  items,
  onAdd,
  onRemove,
  onClear,
  onLoad,
}: {
  kind: "audio" | "video";
  items: PoolItem[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onLoad: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const isAudio = kind === "audio";
  const accept = isAudio ? "audio/*" : "video/*";
  const title = isAudio ? "AUDIO POOL" : "VIDEO POOL";
  const headerGradient = isAudio
    ? "from-emerald-500 to-teal-500"
    : "from-rose-500 to-pink-500";
  const Icon = isAudio ? Music : Film;

  const handleAdd = (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) =>
      isAudio ? f.type.startsWith("audio/") : f.type.startsWith("video/"),
    );
    if (arr.length) onAdd(arr);
  };

  return (
    <div className="rounded-2xl border-2 border-slate-300 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br ${headerGradient} text-white shadow-md`}
          >
            <Icon className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <div>
            <h2 className="text-sm font-bold tracking-wide text-slate-800">
              {title}
            </h2>
            <p className="font-mono text-[11px] text-slate-500">
              {items.length} file{items.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onLoad}
            disabled={items.length === 0}
            data-testid={`button-pool-load-${kind}`}
            aria-label="Load into cards"
            title={`Load ${kind} files into cards by number`}
            className="inline-flex h-8 items-center justify-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-3 text-[11px] font-semibold uppercase tracking-wide text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Upload className="h-3.5 w-3.5" />
            Load
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            data-testid="button-pool-add"
            aria-label="Add files"
            title="Add files"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          >
            <Plus className="h-4 w-4" />
          </button>
          {items.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              data-testid="button-pool-clear"
              aria-label="Clear"
              title="Clear"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={accept}
            className="hidden"
            data-testid={`input-pool-${kind}-files`}
            onChange={(e) => {
              if (e.target.files) handleAdd(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) handleAdd(e.dataTransfer.files);
        }}
        className={`max-h-[220px] overflow-y-auto rounded-xl border-2 border-dashed p-3 transition ${
          dragOver
            ? "border-indigo-400 bg-indigo-50/60"
            : "border-slate-200 bg-slate-50/40"
        }`}
        data-testid="dropzone-pool"
      >
        {items.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-slate-400">
            <UploadCloud className="mx-auto mb-1 h-5 w-5" />
            Drop {kind} files here, or click "Add files"
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {items.map((item) => (
              <PoolItemCard
                key={item.id}
                item={item}
                onRemove={() => onRemove(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PoolItemCard({
  item,
  onRemove,
}: {
  item: PoolItem;
  onRemove: () => void;
}) {
  const isAudio = item.kind === "audio";
  const Icon = isAudio ? Music : Film;
  const palette = isAudio
    ? "from-emerald-50 to-teal-50 ring-emerald-200 text-emerald-700"
    : "from-rose-50 to-pink-50 ring-rose-200 text-rose-700";
  const iconBg = isAudio
    ? "bg-gradient-to-br from-emerald-400 to-teal-500"
    : "bg-gradient-to-br from-rose-400 to-pink-500";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(POOL_MIME_ID, item.id);
        e.dataTransfer.setData(POOL_MIME_KIND, item.kind);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className={`group relative flex cursor-grab items-center gap-2 rounded-lg bg-gradient-to-br ${palette} px-2.5 py-2 ring-1 transition active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-md`}
      data-testid={`pool-item-${item.id}`}
      title={`${item.file.name} · drag onto a card's ${item.kind} slot`}
    >
      <GripVertical className="h-3 w-3 shrink-0 text-slate-400 group-hover:text-slate-600" />
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${iconBg} text-white shadow`}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-slate-700">
          {item.file.name}
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
          <span className="uppercase">{item.kind}</span>
          <span>·</span>
          <span>{formatBytes(item.file.size)}</span>
          {item.duration !== null && (
            <>
              <span>·</span>
              <span>{formatSeconds(item.duration)}</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-0 transition group-hover:opacity-100"
        data-testid={`button-pool-remove-${item.id}`}
        aria-label="Remove"
      >
        <X className="h-3.5 w-3.5 text-slate-500 hover:text-rose-600" />
      </button>
    </div>
  );
}

type EngineLease = {
  ffmpeg: FFmpeg | null;
  jobsSinceRecycle: number;
};

type CutterCardProps = {
  index: number;
  engineReady: boolean;
  acquireSlot: (cb: (p: number) => void) => Promise<EngineLease>;
  releaseSlot: (slot: EngineLease) => void;
  recycleSlot: (slot: EngineLease) => Promise<void>;
  onStateChange: (slotIdx: number, s: CardState) => void;
  onDownload: () => void;
  highlight?: boolean;
};

const CutterCard = forwardRef<CutterCardHandle, CutterCardProps>(
  function CutterCard(
    {
      index,
      engineReady,
      acquireSlot,
      releaseSlot,
      recycleSlot,
      onStateChange,
      onDownload,
      highlight,
    },
    ref,
  ) {
    const { toast } = useToast();

    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [audioDuration, setAudioDuration] = useState<number | null>(null);
    const [videoDuration, setVideoDuration] = useState<number | null>(null);

    const [stage, setStage] = useState<Stage>("idle");
    const [progress, setProgress] = useState(0);
    const [outputUrl, setOutputUrl] = useState<string | null>(null);
    const [mergedUrl, setMergedUrl] = useState<string | null>(null);
    const [mergedName, setMergedName] = useState<string>("");
    const [mergedSize, setMergedSize] = useState<number>(0);
    const [mergedDuration, setMergedDuration] = useState<number>(0);
    const [errorMsg, setErrorMsg] = useState<string>("");
    const [playing, setPlaying] = useState(false);
    // Set by parent (via markArchived) once this card's output has been
    // copied into the accumulating ZIP and its blob URL revoked. We then
    // hide the preview and stop offering playback (URL is gone).
    const [archived, setArchived] = useState(false);

    const handleAudio = async (file: File | null) => {
      setAudioFile(file);
      setAudioDuration(null);
      if (!file) return;
      try {
        const d = await getMediaDuration(file, "audio");
        setAudioDuration(d);
      } catch (e) {
        toast({
          title: "Audio read error",
          description: (e as Error).message,
          variant: "destructive",
        });
        setAudioFile(null);
      }
    };

    const handleVideo = async (file: File | null) => {
      setVideoFile(file);
      setVideoDuration(null);
      if (!file) return;
      try {
        const d = await getMediaDuration(file, "video");
        setVideoDuration(d);
      } catch (e) {
        toast({
          title: "Video read error",
          description: (e as Error).message,
          variant: "destructive",
        });
        setVideoFile(null);
      }
    };

    const isWorking = stage === "reading" || stage === "cutting";

    // setpts factor = audioDuration / videoDuration. The new video duration
    // becomes videoDuration * factor = audioDuration. So:
    //   factor > 1  → slow down (video was shorter than audio)
    //   factor < 1  → speed up  (video was longer than audio)
    //   factor = 1  → already matches, nothing to do
    const speedFactor =
      audioDuration !== null &&
      videoDuration !== null &&
      videoDuration > 0 &&
      audioDuration > 0
        ? audioDuration / videoDuration
        : null;

    const speedDelta =
      speedFactor !== null ? Math.abs(speedFactor - 1) : 0;

    const speedInRange =
      speedFactor !== null &&
      speedFactor >= MIN_SPEED_FACTOR &&
      speedFactor <= MAX_SPEED_FACTOR;

    const speedTooExtreme =
      speedFactor !== null &&
      speedDelta > SPEED_EPSILON &&
      !speedInRange;

    const mode: "speedup" | "slowdown" | null =
      speedFactor !== null && speedInRange && speedDelta > SPEED_EPSILON
        ? speedFactor < 1
          ? "speedup"
          : "slowdown"
        : null;

    const canCut =
      engineReady &&
      !!audioFile &&
      !!videoFile &&
      videoDuration !== null &&
      audioDuration !== null &&
      !isWorking &&
      mode !== null;

    const hasAudio = !!audioFile;
    const hasVideo = !!videoFile;
    const isDone = stage === "done";

    // Keep onStateChange off the effect deps. With 250 cards, having the
    // parent's setter as a dep would re-fire this effect on every parent
    // render — a feedback loop. Stable callback via ref avoids that.
    const onStateChangeRef = useRef(onStateChange);
    useEffect(() => {
      onStateChangeRef.current = onStateChange;
    });

    const slotIdx = index - 1;
    useEffect(() => {
      onStateChangeRef.current(slotIdx, {
        canCut,
        isWorking,
        mode,
        hasAudio,
        hasVideo,
        isDone,
        mergedUrl,
        mergedName,
        isArchived: archived,
      });
    }, [
      slotIdx,
      canCut,
      isWorking,
      mode,
      hasAudio,
      hasVideo,
      isDone,
      mergedUrl,
      mergedName,
      archived,
    ]);

    const reset = () => {
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      if (mergedUrl) URL.revokeObjectURL(mergedUrl);
      setOutputUrl(null);
      setMergedUrl(null);
      setMergedName("");
      setMergedSize(0);
      setMergedDuration(0);
      setAudioFile(null);
      setVideoFile(null);
      setAudioDuration(null);
      setVideoDuration(null);
      setStage("idle");
      setProgress(0);
      setErrorMsg("");
      setPlaying(false);
      setArchived(false);
    };

    const runCut = async (): Promise<{ url: string; name: string } | null> => {
      if (
        !audioFile ||
        !videoFile ||
        audioDuration === null ||
        videoDuration === null ||
        speedFactor === null ||
        mode === null
      )
        return null;

      setErrorMsg("");
      setProgress(0);
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      if (mergedUrl) URL.revokeObjectURL(mergedUrl);
      setOutputUrl(null);
      setMergedUrl(null);
      setArchived(false);

      // Captured in the closure so we can return them after success — local
      // state vars (mergedUrl/mergedName) won't be observable until React
      // commits, but the parent's batch logic needs them right away.
      let producedUrl: string | null = null;
      let producedName: string = "";

      const ns = `c${index}_`;
      const ext = (videoFile.name.split(".").pop() || "mp4").toLowerCase();
      const inputName = `${ns}input.${ext}`;
      // setpts requires re-encoding (stream copy can't change PTS), and
      // libx264 in mp4 is the broadest-compat target.
      const outputExt = "mp4";
      const mergedFileName = `Merged ${index}.${outputExt}`;
      const mergedFile = `${ns}${mergedFileName}`;
      const mimeType = "video/mp4";

      // Lease an engine slot for this job. progress events from this slot's
      // ffmpeg instance will route to our setProgress callback only.
      const slot = await acquireSlot((p) => setProgress(p));

      // Cache video bytes once so a retry after recycle does not re-read the
      // File (still OK if it does — just an optimization).
      let cachedData: Uint8Array | null = null;

      // The actual work, parameterized over the ffmpeg engine instance.
      // After a recycle the WASM heap is empty, so this re-writes inputs
      // and re-runs all exec steps from scratch.
      const doWork = async (eng: FFmpeg) => {
        setStage("reading");
        if (!cachedData) {
          cachedData = await fetchFile(videoFile);
        }
        await eng.writeFile(inputName, cachedData);

        setStage("cutting");

        // Fast path: rescale input timestamps with -itsscale and stream-copy
        // the video. No re-encode — just remux with new sample durations.
        // Output duration ≈ videoDuration * speedFactor = audioDuration.
        // Typically 30-50x faster than libx264 re-encode for short clips.
        // -an drops audio (output is video-only by design).
        const itsScale = speedFactor.toFixed(6);
        let usedFastPath = true;
        try {
          await eng.exec([
            "-itsscale",
            itsScale,
            "-i",
            inputName,
            "-an",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            mergedFile,
          ]);
        } catch (fastErr) {
          // Fallback: re-encode with setpts. Some inputs (unusual codecs,
          // fragmented mp4 with edit lists, etc.) won't survive a pure
          // stream-copy timestamp rescale — fall back to the slower but
          // bulletproof libx264 path.
          console.warn(
            `[Speed+- card ${index}] Fast remux failed, falling back to re-encode:`,
            (fastErr as Error).message || fastErr,
          );
          usedFastPath = false;
          try {
            await eng.deleteFile(mergedFile);
          } catch {
            /* ignore */
          }
          const ptsExpr = `${speedFactor.toFixed(6)}*PTS`;
          await eng.exec([
            "-i",
            inputName,
            "-an",
            "-vf",
            `setpts=${ptsExpr}`,
            "-vsync",
            "vfr",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "fastdecode",
            "-crf",
            "26",
            "-pix_fmt",
            "yuv420p",
            "-threads",
            "0",
            "-movflags",
            "+faststart",
            mergedFile,
          ]);
        }

        const mergedData = await eng.readFile(mergedFile);
        const mergedBuf = mergedData as Uint8Array;
        const mergedBlob = new Blob([mergedBuf.slice().buffer], {
          type: mimeType,
        });
        const mUrl = URL.createObjectURL(mergedBlob);
        producedUrl = mUrl;
        producedName = mergedFileName;
        setMergedUrl(mUrl);
        setMergedName(mergedFileName);
        setMergedSize(mergedBlob.size);
        setMergedDuration(audioDuration);

        setStage("done");
        setProgress(100);

        if (!usedFastPath) {
          console.info(
            `[Speed+- card ${index}] Used re-encode fallback (input incompatible with fast remux).`,
          );
        }

        try {
          await eng.deleteFile(inputName);
          await eng.deleteFile(mergedFile);
        } catch {
          /* ignore */
        }
      };

      try {
        try {
          await doWork(slot.ffmpeg!);
          slot.jobsSinceRecycle += 1;
        } catch (e) {
          const msg = (e as Error).message || String(e);
          if (isMemoryError(msg)) {
            // Recycle this slot and retry once. WASM heap is reset.
            console.warn(
              `[Speed+- card ${index}] Memory error, recycling slot and retrying:`,
              msg,
            );
            try {
              await recycleSlot(slot);
            } catch (loadErr) {
              console.error(
                `[Speed+- card ${index}] Recycle load failed:`,
                loadErr,
              );
              throw e;
            }
            // Reset the produced markers — the retry rebuilds the output.
            producedUrl = null;
            producedName = "";
            await doWork(slot.ffmpeg!);
            slot.jobsSinceRecycle = 1;
          } else {
            throw e;
          }
        }
      } catch (e) {
        console.error(e);
        setStage("error");
        const msg = (e as Error).message || String(e);
        if (isMemoryError(msg)) {
          setErrorMsg(
            "Out of memory. Try processing fewer cards at a time or refresh the page.",
          );
        } else {
          setErrorMsg(msg || "Cutting failed. Try a different video format.");
        }
        return null;
      } finally {
        releaseSlot(slot);
      }

      if (producedUrl && producedName) {
        return { url: producedUrl, name: producedName };
      }
      return null;
    };

    useImperativeHandle(ref, () => ({
      runCut,
      loadAudio: (file: File) => {
        void handleAudio(file);
      },
      loadVideo: (file: File) => {
        void handleVideo(file);
      },
      markArchived: () => {
        // Parent has already revoked the blob URL after copying it into the
        // ZIP. Drop our reference to it and flip the archived flag so the
        // preview tile shows the archived badge instead.
        setMergedUrl(null);
        setOutputUrl(null);
        setPlaying(false);
        setArchived(true);
      },
    }));

    const videoSwapRef = useRef<HTMLInputElement | null>(null);

    return (
      <div
        className={`rounded-2xl border-2 bg-white p-4 shadow-sm transition-colors ${
          speedTooExtreme
            ? "border-rose-500 shadow-md shadow-rose-200/50 bg-rose-50/40"
            : (!!audioFile !== !!videoFile)
            ? "border-rose-500 shadow-md shadow-rose-200/50 bg-rose-50/40"
            : mode === "speedup"
            ? "border-violet-400 shadow-md shadow-violet-200/50 bg-violet-50/40"
            : mode === "slowdown"
            ? "border-fuchsia-400 shadow-md shadow-fuchsia-200/50 bg-fuchsia-50/40"
            : highlight
            ? "border-cyan-500 shadow-md"
            : "border-slate-300"
        }`}
      >
        <input
          ref={videoSwapRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f) {
              void handleVideo(f);
            }
            if (e.target) e.target.value = "";
          }}
          data-testid={`input-video-swap-${index}`}
        />
        <div className="flex items-stretch gap-3">
          {/* Number circle */}
          <div className="flex shrink-0 items-center justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-slate-400 font-mono text-sm font-bold text-slate-700">
              {String(index).padStart(3, "0")}
            </div>
          </div>

          {/* Stacked uploads */}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
            <UploadBox
              kind="audio"
              file={audioFile}
              duration={audioDuration}
              onChange={handleAudio}
              disabled={isWorking}
              testIdSuffix={`-${index}`}
            />
            <UploadBox
              kind="video"
              file={videoFile}
              duration={videoDuration}
              onChange={handleVideo}
              disabled={isWorking}
              testIdSuffix={`-${index}`}
            />
          </div>

          {/* Arrow */}
          <div className="flex shrink-0 items-center justify-center">
            <ArrowRight className="h-5 w-5 text-slate-500" />
          </div>

          {/* Preview + action buttons stacked vertically */}
          <div className="flex shrink-0 flex-col items-center gap-2">
            <PlayablePreview
              videoUrl={mergedUrl}
              archived={archived}
              playing={playing}
              setPlaying={setPlaying}
              testId={`video-merged-${index}`}
            />
            <div className="flex w-full items-center justify-center gap-1.5">
              <ActionButton
                onClick={reset}
                disabled={
                  !audioFile && !videoFile && !mergedUrl && !errorMsg
                }
                icon={<X className="h-3 w-3" />}
                label="cancel"
                testId={`button-cancel-${index}`}
                variant="cancel"
              />
              <ActionButton
                onClick={() => mergedUrl && setPlaying(true)}
                disabled={!mergedUrl}
                icon={<Play className="h-3 w-3" />}
                label="play"
                testId={`button-play-${index}`}
                variant="play"
              />
              <ActionButton
                as="a"
                href={mergedUrl ?? undefined}
                download={mergedName || undefined}
                disabled={!mergedUrl}
                onClick={onDownload}
                icon={<Download className="h-3 w-3" />}
                label="download"
                testId={`button-download-${index}`}
                variant="download"
              />
            </div>
          </div>
        </div>

        {/* Status row */}
        {(isWorking || errorMsg || speedTooExtreme || mode !== null || mergedUrl) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            {speedTooExtreme && !mergedUrl && (
              <span className="inline-flex items-center gap-1.5 rounded border border-rose-400 bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">
                <AlertTriangle className="h-3 w-3" />
                {(speedFactor as number) < MIN_SPEED_FACTOR
                  ? `Video > 2× audio (${(speedFactor as number).toFixed(2)}× — too extreme)`
                  : `Audio > 2× video (${(speedFactor as number).toFixed(2)}× — too extreme)`}
              </span>
            )}
            {mode === "speedup" && !mergedUrl && speedFactor !== null && (
              <span className="inline-flex items-center gap-1.5 rounded border border-violet-400 bg-violet-100 px-2 py-0.5 font-semibold text-violet-800">
                <FastForward className="h-3 w-3" />
                speed +{(1 / speedFactor).toFixed(2)}× (faster)
              </span>
            )}
            {mode === "slowdown" && !mergedUrl && speedFactor !== null && (
              <span className="inline-flex items-center gap-1.5 rounded border border-fuchsia-400 bg-fuchsia-100 px-2 py-0.5 font-semibold text-fuchsia-800">
                <Rewind className="h-3 w-3" />
                speed -{speedFactor.toFixed(2)}× (slower)
              </span>
            )}
            {isWorking && (
              <span className="flex flex-1 items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <span
                    className="block h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </span>
                <span className="font-mono">
                  {progress}% · {stage}
                </span>
              </span>
            )}
            {mergedUrl && !isWorking && (
              <>
                <span className="truncate text-slate-700">{mergedName}</span>
                <span>·</span>
                <span>{formatBytes(mergedSize)}</span>
                <span>·</span>
                <span>{formatSeconds(mergedDuration)}</span>
              </>
            )}
            {errorMsg && (
              <span className="text-rose-600">{errorMsg}</span>
            )}
          </div>
        )}
      </div>
    );
  },
);

function ActionButton({
  onClick,
  disabled,
  icon,
  label,
  testId,
  as,
  href,
  download,
  variant = "cancel",
}: {
  onClick?: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  testId: string;
  as?: "a";
  href?: string;
  download?: string;
  variant?: "cancel" | "play" | "download";
}) {
  const variantCls =
    variant === "play"
      ? "border-emerald-300 bg-gradient-to-b from-emerald-50 to-emerald-100 text-emerald-700 hover:from-emerald-100 hover:to-emerald-200 hover:border-emerald-500"
      : variant === "download"
      ? "border-indigo-300 bg-gradient-to-b from-indigo-50 to-indigo-100 text-indigo-700 hover:from-indigo-100 hover:to-indigo-200 hover:border-indigo-500"
      : "border-rose-300 bg-gradient-to-b from-rose-50 to-rose-100 text-rose-700 hover:from-rose-100 hover:to-rose-200 hover:border-rose-500";

  const cls = `inline-flex flex-1 items-center justify-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-semibold tracking-wide shadow-sm transition active:scale-95 ${variantCls} ${
    disabled ? "pointer-events-none opacity-40" : ""
  }`;

  if (as === "a") {
    return (
      <a
        href={disabled ? undefined : href}
        download={download}
        onClick={disabled ? undefined : onClick}
        className={cls}
        data-testid={testId}
        aria-disabled={disabled}
      >
        {icon}
        {label}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cls}
      data-testid={testId}
    >
      {icon}
      {label}
    </button>
  );
}

function UploadBox({
  kind,
  file,
  duration,
  onChange,
  disabled,
  testIdSuffix = "",
}: {
  kind: "audio" | "video";
  file: File | null;
  duration: number | null;
  onChange: (f: File | null) => void;
  disabled?: boolean;
  testIdSuffix?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isAudio = kind === "audio";
  const hasFile = !!file;
  const poolCtx = useContext(PoolContext);
  const [dropActive, setDropActive] = useState(false);
  const [dropReject, setDropReject] = useState(false);

  const palette = isAudio
    ? {
        gradient:
          "from-emerald-50 via-white to-teal-50/60 hover:from-emerald-100/80 hover:via-white hover:to-teal-100/60",
        ring: "ring-emerald-200/70 hover:ring-emerald-300",
        ringActive: "ring-emerald-400 shadow-emerald-200/50",
        iconBg: "bg-gradient-to-br from-emerald-400 to-teal-500",
        iconShadow: "shadow-emerald-300/40",
        accentText: "text-emerald-700",
        chipBg: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20",
        dot: "bg-emerald-500",
      }
    : {
        gradient:
          "from-rose-50 via-white to-pink-50/60 hover:from-rose-100/80 hover:via-white hover:to-pink-100/60",
        ring: "ring-rose-200/70 hover:ring-rose-300",
        ringActive: "ring-rose-400 shadow-rose-200/50",
        iconBg: "bg-gradient-to-br from-rose-400 to-pink-500",
        iconShadow: "shadow-rose-300/40",
        accentText: "text-rose-700",
        chipBg: "bg-rose-500/10 text-rose-700 ring-rose-500/20",
        dot: "bg-rose-500",
      };

  const Icon = isAudio ? Music : Film;
  const label = isAudio ? "Audio" : "Video";
  const accept = isAudio ? "audio/*" : "video/*";

  return (
    <div
      className={`group relative cursor-pointer overflow-hidden rounded-xl bg-gradient-to-br ${palette.gradient} px-3 py-2.5 ring-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
        dropReject
          ? "ring-2 ring-rose-500 shadow-rose-200/60"
          : dropActive
          ? "ring-2 ring-indigo-500 shadow-indigo-200/60 scale-[1.02]"
          : hasFile
          ? `${palette.ringActive} shadow-md`
          : palette.ring
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        const types = Array.from(e.dataTransfer.types || []);
        if (types.includes(POOL_MIME_KIND)) {
          const k = e.dataTransfer.getData(POOL_MIME_KIND);
          if (k && k !== kind) {
            setDropReject(true);
            setDropActive(false);
            e.dataTransfer.dropEffect = "none";
            return;
          }
        }
        setDropActive(true);
        setDropReject(false);
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        setDropActive(false);
        setDropReject(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        setDropReject(false);
        const poolId = e.dataTransfer.getData(POOL_MIME_ID);
        const poolKind = e.dataTransfer.getData(POOL_MIME_KIND);
        if (poolId) {
          if (poolKind && poolKind !== kind) return;
          const f = poolCtx.getFile(poolId);
          if (f) onChange(f);
          return;
        }
        const f = e.dataTransfer.files?.[0];
        if (f) onChange(f);
      }}
      data-testid={`upload-${kind}${testIdSuffix}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        data-testid={`input-${kind}${testIdSuffix}`}
      />
      <div className="flex items-center gap-2.5">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-md transition-all duration-200 ${
            hasFile
              ? `${palette.iconBg} text-white ${palette.iconShadow}`
              : `bg-white text-white ring-1 ${isAudio ? "ring-emerald-200" : "ring-rose-200"}`
          }`}
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[11px] font-semibold tracking-wide ${palette.accentText}`}>
              {label}
            </span>
            {duration !== null ? (
              <span
                className={`rounded-full px-1.5 py-px font-mono text-[10px] ring-1 ${palette.chipBg}`}
              >
                {formatSeconds(duration)}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-medium text-slate-400">
                <UploadCloud className="h-3 w-3" />
                upload
              </span>
            )}
          </div>
          {hasFile ? (
            <div
              className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-slate-600"
              data-testid={`text-${kind}-name${testIdSuffix}`}
              title={file.name}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${palette.dot}`} />
              <span className="truncate">
                {file.name} · {formatBytes(file.size)}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 truncate text-[10px] text-slate-400">
              Drop or click to add {isAudio ? "an audio" : "a video"} file
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PlayablePreview({
  videoUrl,
  archived,
  playing,
  setPlaying,
  testId,
}: {
  videoUrl: string | null;
  archived?: boolean;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  testId: string;
}) {
  if (archived) {
    return (
      <div
        className="flex h-[96px] w-[150px] flex-col items-center justify-center gap-1 rounded-lg border-2 border-emerald-500 bg-emerald-50 text-[10px] font-semibold text-emerald-700"
        data-testid={`${testId}-archived`}
        title="Saved to ZIP — preview released to free memory"
      >
        <CheckCheck className="h-5 w-5" />
        <span>Archived</span>
        <span className="text-[9px] font-normal text-emerald-600">
          in ZIP
        </span>
      </div>
    );
  }
  if (!videoUrl) {
    return (
      <div
        className="flex h-[96px] w-[150px] items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 text-[10px] text-slate-400"
        data-testid={`${testId}-empty`}
      >
        preview
      </div>
    );
  }

  if (playing) {
    return (
      <video
        src={videoUrl}
        controls
        autoPlay
        className="h-[96px] w-[150px] rounded-lg border-2 border-slate-700 bg-black shadow-md"
        data-testid={testId}
        onEnded={() => setPlaying(false)}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="group relative flex h-[96px] w-[150px] items-center justify-center rounded-lg border-2 border-slate-700 bg-black shadow-md transition hover:border-slate-900"
      data-testid={`${testId}-play`}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 backdrop-blur transition group-hover:scale-110 group-hover:bg-white/30">
        <Play className="h-3.5 w-3.5 text-white" />
      </span>
    </button>
  );
}

export default function SpeedPlusMinusTab({
  incomingAudioFiles,
  incomingVideoFiles,
}: {
  incomingAudioFiles?: { files: File[]; key: number };
  incomingVideoFiles?: { files: File[]; key: number };
} = {}) {
  return (
    <TooltipProvider>
      <VideoCutterApp
        incomingAudioFiles={incomingAudioFiles}
        incomingVideoFiles={incomingVideoFiles}
      />
      <Toaster />
    </TooltipProvider>
  );
}
