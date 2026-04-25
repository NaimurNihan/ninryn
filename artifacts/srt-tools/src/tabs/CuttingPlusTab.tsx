import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Scissors,
  Upload,
  Plus,
  Film,
  Download,
  Trash2,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Settings2,
  Package,
  Play,
  FolderInput,
  Gauge,
} from "lucide-react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  createFFmpegInstance,
  getVideoDuration,
  trimVideoWithEngine,
  trimHeadSmartCutWithEngine,
  trimmedFileName,
  headTrimmedFileName,
  type TrimMode,
} from "@/lib/video-trim-ffmpeg";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

// ── Engine pool ────────────────────────────────────────────────────────
// Each slot is an independent FFmpeg WASM instance. Cutting+ processes
// multiple clips in parallel — one slot per concurrent clip.
function pickPoolSize(): number {
  if (typeof navigator === "undefined") return 2;
  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 2) return 1;
  if (cores >= 8) return 3;
  return 2;
}
const ENGINE_POOL_SIZE = pickPoolSize();
const RECYCLE_EVERY = 8; // recycle each engine every N jobs

type EngineSlot = {
  id: number;
  ffmpeg: FFmpeg | null;
  busy: boolean;
  jobsSinceRecycle: number;
};

// ── Types ──────────────────────────────────────────────────────────────
type Status = "idle" | "ready" | "processing" | "done" | "error";

interface VideoItem {
  id: string;
  file: File;
  duration: number | null;
  status: Status;
  progress: number;
  error?: string;
  resultBlob?: Blob;
  resultUrl?: string;
  selected: boolean;
  headExtra?: number;
}

function formatTime(s: number): string {
  if (!isFinite(s) || s <= 0) return "0.0s";
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}m ${sec}s`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

interface IncomingVideoFiles {
  files: File[];
  key: number;
  autoLoad?: boolean;
  extras?: number[];
}

export default function CuttingPlusTab({
  incomingVideoFiles,
  onSendToCuttingPlusPlus,
  onSendToSpeedPlusMinus,
}: {
  incomingVideoFiles?: IncomingVideoFiles;
  onSendToCuttingPlusPlus?: (files: File[]) => void;
  onSendToSpeedPlusMinus?: (files: File[]) => void;
} = {}) {
  const { toast } = useToast();
  const [items, setItems] = useState<VideoItem[]>([]);
  const [cutMs, setCutMs] = useState<number>(1000);
  const [mode, setMode] = useState<TrimMode>("end");
  const [engineState, setEngineState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [busy, setBusy] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Pool state ──────────────────────────────────────────────────────
  const slotsRef = useRef<EngineSlot[]>([]);
  const slotWaitersRef = useRef<Array<() => void>>([]);

  const loadFreshSlot = async (slot: EngineSlot): Promise<void> => {
    const ff = await createFFmpegInstance();
    slot.ffmpeg = ff;
    slot.jobsSinceRecycle = 0;
  };

  // Acquire an idle slot. Waits until one is free, then marks it busy.
  const acquireSlot = async (): Promise<EngineSlot> => {
    while (true) {
      const idle = slotsRef.current.find((s) => !s.busy && s.ffmpeg != null);
      if (idle) {
        idle.busy = true;
        // Recycle if this engine has processed too many jobs.
        if (idle.jobsSinceRecycle >= RECYCLE_EVERY) {
          try {
            idle.ffmpeg!.terminate();
          } catch { /* ignore */ }
          idle.ffmpeg = null;
          await loadFreshSlot(idle);
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
    const next = slotWaitersRef.current.shift();
    if (next) next();
  };

  const disposeAllSlots = () => {
    for (const s of slotsRef.current) {
      if (s.ffmpeg) {
        try { s.ffmpeg.terminate(); } catch { /* ignore */ }
        s.ffmpeg = null;
      }
      s.busy = false;
    }
    // Wake all waiters so they don't hang.
    for (const w of slotWaitersRef.current) w();
    slotWaitersRef.current = [];
  };

  // Boot the engine pool on mount, clean up on unmount.
  useEffect(() => {
    let cancelled = false;
    setEngineState("loading");

    const slots: EngineSlot[] = Array.from(
      { length: ENGINE_POOL_SIZE },
      (_, i) => ({ id: i, ffmpeg: null, busy: false, jobsSinceRecycle: 0 }),
    );
    slotsRef.current = slots;

    Promise.all(slots.map((s) => loadFreshSlot(s)))
      .then(() => {
        if (cancelled) return;
        setEngineState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[Cutting+] engine pool failed to load:", err);
        setEngineState("error");
      });

    return () => {
      cancelled = true;
      disposeAllSlots();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cutSeconds = cutMs / 1000;

  const totals = useMemo(() => {
    const done = items.filter((i) => i.status === "done").length;
    const errors = items.filter((i) => i.status === "error").length;
    return { total: items.length, done, errors };
  }, [items]);

  const addFiles = useCallback(
    async (fileList: FileList | File[], extras?: number[]) => {
      const arr = Array.from(fileList);
      const indexed = arr
        .map((f, i) => ({ f, origIdx: i }))
        .filter(({ f }) =>
          f.type.startsWith("video/") ||
          /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f.name),
        );
      const files = indexed.map((x) => x.f);
      if (files.length === 0) {
        toast({
          title: "No video files",
          description: "Drop video files (mp4, mov, mkv, webm, avi)",
          variant: "destructive",
        });
        return;
      }
      const newItems: VideoItem[] = indexed.map(({ f, origIdx }) => {
        const ex = extras?.[origIdx];
        return {
          id: uid(),
          file: f,
          duration: null,
          status: "idle",
          progress: 0,
          selected: true,
          headExtra: typeof ex === "number" && ex > 0 ? ex : undefined,
        };
      });
      setItems((prev) => [...prev, ...newItems]);

      for (const item of newItems) {
        try {
          const d = await getVideoDuration(item.file);
          setItems((prev) =>
            prev.map((p) =>
              p.id === item.id ? { ...p, duration: d, status: "ready" } : p,
            ),
          );
        } catch {
          setItems((prev) =>
            prev.map((p) =>
              p.id === item.id
                ? { ...p, status: "ready", duration: null }
                : p,
            ),
          );
        }
      }
    },
    [toast],
  );

  const onPickFiles = () => fileInputRef.current?.click();

  const lastConsumedKeyRef = useRef<number>(0);
  const lastAutoLoadedKeyRef = useRef<number>(0);
  const pendingSplitterFiles = incomingVideoFiles?.files ?? [];
  const pendingSplitterKey = incomingVideoFiles?.key ?? 0;
  const pendingAutoLoad = incomingVideoFiles?.autoLoad ?? false;
  const pendingSplitterExtras = incomingVideoFiles?.extras;

  const buildFresh = (): { files: File[]; extras?: number[] } => {
    const existingNames = new Set(items.map((i) => i.file.name));
    const out: { files: File[]; extras: number[] } = { files: [], extras: [] };
    for (let i = 0; i < pendingSplitterFiles.length; i++) {
      const f = pendingSplitterFiles[i]!;
      if (existingNames.has(f.name)) continue;
      out.files.push(f);
      out.extras.push(pendingSplitterExtras?.[i] ?? 0);
    }
    return pendingSplitterExtras ? out : { files: out.files };
  };

  useEffect(() => {
    if (
      pendingAutoLoad &&
      pendingSplitterKey > 0 &&
      pendingSplitterKey !== lastAutoLoadedKeyRef.current &&
      pendingSplitterFiles.length > 0
    ) {
      lastAutoLoadedKeyRef.current = pendingSplitterKey;
      lastConsumedKeyRef.current = pendingSplitterKey;
      const fresh = buildFresh();
      if (fresh.files.length > 0) {
        void addFiles(fresh.files, fresh.extras);
        const aligned = (fresh.extras ?? []).filter((e) => e > 0).length;
        toast({
          title: `Loaded ${fresh.files.length} clip${fresh.files.length === 1 ? "" : "s"} from Video Spliter`,
          description:
            aligned > 0
              ? `${aligned} have head-extra to auto-trim for cue alignment`
              : undefined,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoLoad, pendingSplitterKey, pendingSplitterFiles, pendingSplitterExtras, items, addFiles, toast]);

  const onLoadClick = () => {
    if (pendingSplitterFiles.length > 0) {
      const fresh = buildFresh();
      if (fresh.files.length > 0) {
        void addFiles(fresh.files, fresh.extras);
        lastConsumedKeyRef.current = pendingSplitterKey;
        const aligned = (fresh.extras ?? []).filter((e) => e > 0).length;
        toast({
          title: `Loaded ${fresh.files.length} clip${fresh.files.length === 1 ? "" : "s"} from Video Spliter`,
          description:
            aligned > 0
              ? `${aligned} have head-extra to auto-trim for cue alignment`
              : undefined,
        });
        return;
      }
    }
    onPickFiles();
  };

  const removeItem = (id: string) => {
    setItems((prev) => {
      const it = prev.find((p) => p.id === id);
      if (it?.resultUrl) URL.revokeObjectURL(it.resultUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const clearAll = () => {
    items.forEach((i) => i.resultUrl && URL.revokeObjectURL(i.resultUrl));
    setItems([]);
    setOverallProgress(0);
  };

  // ── Parallel cut runner ─────────────────────────────────────────────
  // Spawns ENGINE_POOL_SIZE workers that each drain the same queue,
  // one slot per worker. Gives a 2-3× overall throughput boost.
  const runCut = async () => {
    if (items.length === 0) {
      toast({ title: "No videos", description: "Add some videos first", variant: "destructive" });
      return;
    }
    if (cutMs <= 0) {
      toast({ title: "Invalid cut", description: "Cut duration must be greater than 0", variant: "destructive" });
      return;
    }
    if (engineState !== "ready") {
      toast({ title: "Engine not ready", description: "Please wait for the engine to finish loading", variant: "destructive" });
      return;
    }

    const queue = items.filter(
      (i) => i.selected && (i.status === "ready" || i.status === "error"),
    );
    if (queue.length === 0) {
      toast({ title: "Nothing to process", description: "Tick at least one ready clip" });
      return;
    }

    setBusy(true);
    setOverallProgress(0);

    // Shared mutable index — each worker advances this atomically.
    let nextIdx = 0;
    let completed = 0;

    const processOne = async (target: VideoItem) => {
      setItems((prev) =>
        prev.map((p) =>
          p.id === target.id
            ? { ...p, status: "processing", progress: 0, error: undefined }
            : p,
        ),
      );

      const slot = await acquireSlot();
      try {
        const onProgress = (r: number) => {
          setItems((prev) =>
            prev.map((p) => (p.id === target.id ? { ...p, progress: r } : p)),
          );
        };

        // Head-extra clips → smart cut (re-encode only first 3 s, stream-copy rest).
        // Regular clips → fast stream-copy.
        const blob =
          target.headExtra && target.headExtra > 0
            ? await trimHeadSmartCutWithEngine(slot.ffmpeg!, target.file, {
                headSeconds: target.headExtra,
                onProgress,
              })
            : await trimVideoWithEngine(slot.ffmpeg!, target.file, {
                cutSeconds,
                mode,
                onProgress,
              });

        slot.jobsSinceRecycle += 1;

        const url = URL.createObjectURL(blob);
        setItems((prev) =>
          prev.map((p) =>
            p.id === target.id
              ? { ...p, status: "done", progress: 1, resultBlob: blob, resultUrl: url }
              : p,
          ),
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setItems((prev) =>
          prev.map((p) =>
            p.id === target.id
              ? { ...p, status: "error", error: msg, progress: 0 }
              : p,
          ),
        );
      } finally {
        releaseSlot(slot);
        completed += 1;
        setOverallProgress(completed / queue.length);
      }
    };

    // Worker: keep pulling items from the shared queue.
    const worker = async () => {
      while (true) {
        const idx = nextIdx++;
        if (idx >= queue.length) break;
        await processOne(queue[idx]!);
      }
    };

    const workerCount = Math.min(ENGINE_POOL_SIZE, queue.length);
    await Promise.all(Array.from({ length: workerCount }, worker));

    setBusy(false);
    toast({ title: "Done", description: `Processed ${completed} of ${queue.length} clips` });
  };

  const outputName = (item: VideoItem) =>
    item.headExtra && item.headExtra > 0
      ? headTrimmedFileName(item.file.name)
      : trimmedFileName(item.file.name);

  const downloadOne = (item: VideoItem) => {
    if (!item.resultUrl) return;
    const a = document.createElement("a");
    a.href = item.resultUrl;
    a.download = outputName(item);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const sendDoneToCuttingPlusPlus = () => {
    const done = items.filter((i) => i.status === "done" && i.resultBlob);
    if (done.length === 0) {
      toast({ title: "Nothing to send", description: "Process some videos first" });
      return;
    }
    if (!onSendToCuttingPlusPlus) return;
    const files: File[] = done.map((it) => {
      const name = outputName(it);
      const type = it.resultBlob!.type || it.file.type || "video/mp4";
      return new File([it.resultBlob!], name, { type });
    });
    onSendToCuttingPlusPlus(files);

    const sentIds = new Set(done.map((d) => d.id));
    setItems((prev) =>
      prev.map((it) => {
        if (!sentIds.has(it.id)) return it;
        if (it.resultUrl) {
          try { URL.revokeObjectURL(it.resultUrl); } catch { /* ignore */ }
        }
        return { ...it, resultBlob: undefined, resultUrl: undefined };
      }),
    );
    disposeAllSlots();

    toast({
      title: `Sent ${files.length} clip${files.length === 1 ? "" : "s"} to Cutting ++`,
      description: "Memory freed. Preview & download here are cleared for the next tab.",
    });
  };

  const sendDoneToSpeedPlusMinus = () => {
    const done = items.filter((i) => i.status === "done" && i.resultBlob);
    if (done.length === 0) {
      toast({ title: "Nothing to send", description: "Process some videos first" });
      return;
    }
    if (!onSendToSpeedPlusMinus) return;
    const files: File[] = done.map((it) => {
      const name = outputName(it);
      const type = it.resultBlob!.type || it.file.type || "video/mp4";
      return new File([it.resultBlob!], name, { type });
    });
    onSendToSpeedPlusMinus(files);

    const sentIds = new Set(done.map((d) => d.id));
    setItems((prev) =>
      prev.map((it) => {
        if (!sentIds.has(it.id)) return it;
        if (it.resultUrl) {
          try { URL.revokeObjectURL(it.resultUrl); } catch { /* ignore */ }
        }
        return { ...it, resultBlob: undefined, resultUrl: undefined };
      }),
    );
    disposeAllSlots();

    toast({
      title: `Sent ${files.length} clip${files.length === 1 ? "" : "s"} to Speed +-`,
      description: "Memory freed. Preview & download here are cleared for the next tab.",
    });
  };

  const downloadAllZip = async () => {
    const done = items.filter((i) => i.status === "done" && i.resultBlob);
    if (done.length === 0) {
      toast({ title: "Nothing to download", description: "Process some videos first" });
      return;
    }
    const zip = new JSZip();
    for (const it of done) {
      if (it.resultBlob) zip.file(outputName(it), it.resultBlob);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trimmed_videos_${Date.now()}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  };

  const toggleSelect = (id: string) => {
    setItems((prev) =>
      prev.map((p) => (p.id === id ? { ...p, selected: !p.selected } : p)),
    );
  };

  const engineBadge = (() => {
    if (engineState === "loading")
      return (
        <Badge variant="secondary" className="gap-1.5" data-testid="status-engine">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading {ENGINE_POOL_SIZE} engines…
        </Badge>
      );
    if (engineState === "ready")
      return (
        <Badge
          variant="secondary"
          className="gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200"
          data-testid="status-engine"
        >
          <CheckCircle2 className="h-3 w-3" />
          {ENGINE_POOL_SIZE}× Ready
        </Badge>
      );
    if (engineState === "error")
      return (
        <Badge variant="destructive" className="gap-1.5" data-testid="status-engine">
          <AlertCircle className="h-3 w-3" />
          Engine error
        </Badge>
      );
    return (
      <Badge variant="secondary" className="gap-1.5" data-testid="status-engine">
        <Clock className="h-3 w-3" />
        Idle
      </Badge>
    );
  })();

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-50 via-white to-indigo-50/40 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950/40">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 md:py-10">
        {/* Header */}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
              <Scissors className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                Video End Trimmer
              </h1>
              <p className="text-xs text-muted-foreground">
                Cut a fixed duration off the end of every clip — all in your browser.
              </p>
            </div>
          </div>
          <div className="hidden md:block text-xs text-muted-foreground">
            100% local · nothing uploaded
          </div>
        </header>

        {/* Top Cutter Card */}
        <Card className="mb-5 border-card-border shadow-sm">
          <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              {engineBadge}
              <Separator orientation="vertical" className="hidden h-8 md:block" />
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="cut-input" className="text-sm font-medium">
                  Cut
                </Label>
                <div className="relative">
                  <Input
                    id="cut-input"
                    type="number"
                    min={1}
                    step={1}
                    value={cutMs}
                    onChange={(e) => setCutMs(Number(e.target.value) || 0)}
                    className="h-9 w-28 pr-10 font-mono"
                    data-testid="input-cut-ms"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    ms
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  ({cutSeconds.toFixed(3)}s)
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  setMode("end");
                  runCut();
                }}
                disabled={busy || items.length === 0 || engineState !== "ready"}
                className="gap-2 bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25 hover:opacity-95"
                data-testid="button-mode-end"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Scissors className="h-4 w-4" />
                )}
                {busy ? "Processing..." : "Auto Cut"}
              </Button>
            </div>
          </div>

          {busy && (
            <div className="border-t px-5 py-4">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-muted-foreground">Progress</span>
                <span className="font-mono">
                  {Math.round(overallProgress * 100)}%
                </span>
              </div>
              <Progress value={overallProgress * 100} className="h-2" />
            </div>
          )}
        </Card>

        {/* Video Pool Header Card */}
        <Card className="mb-5 border-card-border shadow-sm">
          <div className="flex items-center justify-between gap-3 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-pink-500 to-rose-500 shadow-sm">
                <Film className="h-5 w-5 text-white" />
              </div>
              <div>
                <h2 className="text-sm font-semibold tracking-wide">VIDEO POOL</h2>
                <p className="text-xs text-muted-foreground">
                  {totals.total} {totals.total === 1 ? "file" : "files"}
                  {totals.done > 0 && ` · ${totals.done} done`}
                  {totals.errors > 0 && ` · ${totals.errors} failed`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {totals.done > 0 && onSendToCuttingPlusPlus && (
                <button
                  type="button"
                  onClick={sendDoneToCuttingPlusPlus}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-bold tracking-wider uppercase shadow-md transition-all"
                  data-testid="button-load-to-cutting-plus-plus"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  → Cutting ++
                </button>
              )}
              {totals.done > 0 && onSendToSpeedPlusMinus && (
                <button
                  type="button"
                  onClick={sendDoneToSpeedPlusMinus}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 text-white text-xs font-bold tracking-wider uppercase shadow-md transition-all"
                  data-testid="button-load-to-speed"
                >
                  <Gauge className="h-3.5 w-3.5" />
                  → Speed +-
                </button>
              )}
              {totals.done > 0 && (
                <button
                  type="button"
                  onClick={downloadAllZip}
                  className="inline-flex items-center gap-1.5 px-3 h-7 rounded-md bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white text-xs font-bold tracking-wider uppercase shadow-md transition-all"
                  data-testid="button-download-zip"
                >
                  <Package className="h-3.5 w-3.5" />
                  ZIP
                </button>
              )}
              {items.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearAll}
                  className="gap-2"
                  data-testid="button-clear"
                >
                  <Trash2 className="h-4 w-4" />
                  Clear all
                </Button>
              )}
              <Button
                size="sm"
                onClick={onPickFiles}
                className="h-9 w-9 rounded-full p-0 bg-indigo-500 hover:bg-indigo-600"
                data-testid="button-add"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = "";
            }}
            data-testid="input-file"
          />
        </Card>

        {/* Videos Card */}
        <Card className="border-card-border shadow-sm">
          <div className="p-5">
            {items.length === 0 ? (
              <div
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
                className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/30 px-6 py-12 text-center transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20"
                data-testid="dropzone"
              >
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-900">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Drop video files here, or click{" "}
                  <button
                    onClick={onPickFiles}
                    className="font-medium text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                  >
                    Add files
                  </button>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  mp4, mov, mkv, webm, avi · stays on your computer
                </p>
              </div>
            ) : (
              <div
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
                className="space-y-2"
              >
                <div className="mb-2 text-xs text-muted-foreground">
                  Tip: tick clips to load only those, or leave empty to load all done
                </div>
                <div
                  onClick={onLoadClick}
                  className="mb-3 flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 px-4 py-2 text-sm text-indigo-700 hover:bg-indigo-100/50 dark:border-indigo-800 dark:bg-indigo-950/20 dark:text-indigo-300"
                >
                  <FolderInput className="h-4 w-4" />
                  {pendingSplitterFiles.length > 0
                    ? `Load ${pendingSplitterFiles.length} clip${pendingSplitterFiles.length === 1 ? "" : "s"} from Video Splitter`
                    : "Add more files"}
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
                  {items.map((item, idx) => (
                    <VideoRow
                      key={item.id}
                      item={item}
                      index={idx + 1}
                      cutSeconds={cutSeconds}
                      mode={mode}
                      onToggle={() => toggleSelect(item.id)}
                      onDownload={() => downloadOne(item)}
                      onRemove={() => removeItem(item.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Stream-copy trim (fast) · Smart-cut head trim (re-encodes ~3 s only) · {ENGINE_POOL_SIZE} parallel engines
        </p>
      </div>
    </div>
  );
}

function VideoRow({
  item,
  index,
  cutSeconds,
  mode,
  onToggle,
  onDownload,
  onRemove,
}: {
  item: VideoItem;
  index: number;
  cutSeconds: number;
  mode: TrimMode;
  onToggle: () => void;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const isAligned = !!(item.headExtra && item.headExtra > 0);
  const newDuration =
    item.duration != null
      ? isAligned
        ? item.duration - (item.headExtra ?? 0)
        : item.duration - cutSeconds * (mode === "both" ? 2 : 1)
      : null;
  const willFail = newDuration != null && newDuration <= 0;

  const statusBadge = (() => {
    switch (item.status) {
      case "processing":
        return (
          <Badge className="gap-1.5 bg-indigo-500 text-white">
            <Loader2 className="h-3 w-3 animate-spin" />
            {Math.round(item.progress * 100)}%
          </Badge>
        );
      case "done":
        return (
          <Badge className="gap-1.5 bg-emerald-500 text-white">
            <CheckCircle2 className="h-3 w-3" />
            Done
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive" className="gap-1.5">
            <AlertCircle className="h-3 w-3" />
            Error
          </Badge>
        );
      case "ready":
        return willFail ? (
          <Badge variant="destructive" className="gap-1.5">
            <AlertCircle className="h-3 w-3" />
            Too short
          </Badge>
        ) : null;
      default:
        return (
          <Badge variant="secondary" className="gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            Reading
          </Badge>
        );
    }
  })();

  return (
    <div
      className="group flex flex-col rounded-lg border bg-card p-2 transition-shadow hover:shadow-md"
      data-testid={`row-video-${item.id}`}
    >
      <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-indigo-100 to-violet-100 dark:from-indigo-950/40 dark:to-violet-950/40">
        <span className="absolute left-1.5 top-1.5 inline-flex items-center justify-center font-mono text-[11px] font-bold text-black dark:text-white">
          {String(index).padStart(3, "0")}
        </span>
        <div className="absolute right-1.5 top-1.5">
          <Checkbox
            checked={item.selected}
            onCheckedChange={onToggle}
            disabled={item.status === "processing"}
            className="h-4 w-4 border-white/80 bg-white/80 data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
            data-testid={`checkbox-${item.id}`}
          />
        </div>
        <Play className="h-8 w-8 text-indigo-500/70" />
        {item.duration != null && (
          <span className="absolute bottom-1.5 right-1.5 font-mono text-[11px] font-bold">
            <span className="text-red-600">{formatTime(item.duration)}</span>
            {newDuration != null && newDuration > 0 && (
              <>
                <span className="mx-1 text-slate-500">{">"}</span>
                <span className="text-emerald-600">{formatTime(newDuration)}</span>
              </>
            )}
          </span>
        )}
        <div className="absolute bottom-1.5 left-1.5">{statusBadge}</div>
      </div>

      <div className="mt-2 flex items-start gap-1">
        <p
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={item.file.name}
        >
          {item.file.name}
        </p>
        {item.status === "done" ? (
          <Button
            variant="default"
            size="icon"
            onClick={onDownload}
            className="h-6 w-6 shrink-0 bg-indigo-600 hover:bg-indigo-700"
            data-testid={`button-download-${item.id}`}
          >
            <Download className="h-3 w-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            disabled={item.status === "processing"}
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
            data-testid={`button-remove-${item.id}`}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="font-mono">{formatBytes(item.file.size)}</span>
        {isAligned && (
          <Badge
            variant="secondary"
            className="h-4 gap-1 px-1.5 py-0 text-[9px] font-mono bg-amber-100 text-amber-900 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-200"
            title={`Head-extra ${(item.headExtra ?? 0).toFixed(3)}s · smart-cut (re-encodes ~3 s only)`}
            data-testid={`badge-head-extra-${item.id}`}
          >
            cue+{(item.headExtra ?? 0).toFixed(2)}s
          </Badge>
        )}
        {newDuration != null && newDuration > 0 && (
          <>
            <span>→</span>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">
              {formatTime(newDuration)}
            </span>
          </>
        )}
      </div>

      {item.error && (
        <p
          className="mt-1 truncate text-[10px] text-destructive"
          title={item.error}
        >
          {item.error}
        </p>
      )}

      {item.status === "processing" && (
        <Progress value={item.progress * 100} className="mt-1 h-1" />
      )}
    </div>
  );
}
