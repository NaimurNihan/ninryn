import { useState, useRef, useCallback } from "react";
import { Upload, Download, Sparkles, X, Music, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AudioEntry {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000).toString().padStart(2, "0");
  const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, "0");
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
  const msStr = (ms % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${msStr}`;
}

function msToDisplay(ms: number): string {
  const h = Math.floor(ms / 3600000).toString().padStart(2, "0");
  const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, "0");
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

const GAP_MS = 500;

async function getAudioDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const dur = audio.duration;
      URL.revokeObjectURL(url);
      resolve(isFinite(dur) ? Math.round(dur * 1000) : 0);
    };
    audio.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    audio.src = url;
  });
}

export default function SrtMakerTab() {
  const [audioEntries, setAudioEntries] = useState<AudioEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [sentences, setSentences] = useState("");
  const [generated, setGenerated] = useState(false);
  const [lang, setLang] = useState<"en" | "ar" | "de">("en");
  const [langOpen, setLangOpen] = useState(false);
  const langDir = lang === "ar" ? "rtl" : "ltr";
  const audioInputRef = useRef<HTMLInputElement>(null);
  const lineRefs = useRef<(HTMLInputElement | null)[]>([]);

  const processFiles = useCallback(async (files: File[]) => {
    const audioFiles = files.filter((f) =>
      f.type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(f.name)
    );
    if (!audioFiles.length) return;
    audioFiles.sort((a, b) => a.name.localeCompare(b.name));
    setLoadingFiles(true);
    let cumulative = 0;
    const entries: AudioEntry[] = [];
    for (const file of audioFiles) {
      const durationMs = await getAudioDuration(file);
      entries.push({ id: `${file.name}-${file.size}`, name: file.name, startMs: cumulative, endMs: cumulative + durationMs, durationMs });
      cumulative += durationMs + GAP_MS;
    }
    setAudioEntries((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      const combined = [...prev, ...entries.filter((e) => !existingIds.has(e.id))];
      let offset = 0;
      return combined.map((e) => { const s = offset; const end = s + e.durationMs; offset = end + GAP_MS; return { ...e, startMs: s, endMs: end }; });
    });
    setGenerated(false);
    setLoadingFiles(false);
  }, []);

  function handleDrop(e: React.DragEvent) { e.preventDefault(); setIsDragging(false); processFiles(Array.from(e.dataTransfer.files)); }
  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) { processFiles(Array.from(e.target.files || [])); e.target.value = ""; }

  function removeEntry(id: string) {
    setAudioEntries((prev) => {
      const filtered = prev.filter((e) => e.id !== id);
      let offset = 0;
      return filtered.map((e) => { const s = offset; const end = s + e.durationMs; offset = end + GAP_MS; return { ...e, startMs: s, endMs: end }; });
    });
    setGenerated(false);
  }

  const allLines = sentences === "" ? [""] : sentences.split("\n");

  function updateLine(i: number, val: string) {
    const next = [...allLines];
    next[i] = val;
    setSentences(next.join("\n"));
    setGenerated(false);
  }

  function handleLineKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const next = [...allLines];
      next.splice(i + 1, 0, "");
      setSentences(next.join("\n"));
      setTimeout(() => lineRefs.current[i + 1]?.focus(), 0);
    } else if (e.key === "Backspace" && allLines[i] === "" && allLines.length > 1) {
      e.preventDefault();
      const next = [...allLines];
      next.splice(i, 1);
      setSentences(next.join("\n"));
      setTimeout(() => lineRefs.current[Math.max(0, i - 1)]?.focus(), 0);
    }
  }

  function handleLinePaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (text.includes("\n")) {
      e.preventDefault();
      const pasted = text.split("\n").map((l) => l.replace(/^\d+[\.\)]\s*/, "").trim());
      const next = [...allLines];
      next.splice(i, 1, ...pasted);
      setSentences(next.join("\n"));
      setGenerated(false);
    }
  }

  const sentenceLines = sentences.split("\n").map((l) => l.replace(/^\d+[\.\)]\s*/, "").trim()).filter(Boolean);
  const srtCards = audioEntries.map((entry, i) => ({
    index: i + 1,
    startTime: msToSrtTime(entry.startMs),
    endTime: msToSrtTime(entry.endMs),
    text: sentenceLines[i] ?? "",
    name: entry.name,
  }));

  function handleDownload() {
    if (srtCards.length === 0) return;
    const content = srtCards.map((c) => `${c.index}\n${c.startTime} --> ${c.endTime}\n${c.text}`).join("\n\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "output.srt"; a.click();
    URL.revokeObjectURL(url);
  }

  const canGenerate = audioEntries.length > 0 && sentenceLines.length > 0;
  const mismatch = audioEntries.length > 0 && sentenceLines.length > 0 && audioEntries.length !== sentenceLines.length;
  const matchCount = Math.min(audioEntries.length, sentenceLines.length);

  return (
    <div className="h-screen flex flex-col bg-[#f5f7fa] font-sans overflow-hidden">
      {/* Header — top card */}
      <div className="w-full mx-auto px-6 pt-4 flex-shrink-0">
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-6 py-3 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-2">
            <Music className="w-5 h-5 text-emerald-500" />
            <span className="font-semibold text-gray-800 dark:text-gray-100 text-sm">SRT Maker</span>
            {matchCount > 0 && !mismatch && (
              <span className="ml-2 bg-emerald-50 text-emerald-600 border border-emerald-200 text-xs px-2 py-0.5 rounded-full font-medium">
                ✓ {matchCount} files matched
              </span>
            )}
            {mismatch && (
              <span className="ml-2 bg-amber-50 text-amber-700 border border-amber-200 text-xs px-2 py-0.5 rounded-full font-medium">
                ⚠ {audioEntries.length} files · {sentenceLines.length} sentences
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => { if (canGenerate) setGenerated(true); }}
              disabled={!canGenerate}
              className="bg-orange-500 hover:bg-orange-600 text-white text-sm h-8 px-3 gap-1.5 disabled:opacity-40"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Generate SRT
            </Button>
            <Button
              onClick={handleDownload}
              disabled={!generated || srtCards.length === 0}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm h-8 px-3 gap-1.5 disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" />
              Download SRT
            </Button>
          </div>
        </div>
      </div>

      {/* Three Cards */}
      <div className="w-full mx-auto px-6 py-4 grid grid-cols-3 gap-4 flex-1 min-h-0">
        {/* Card 1 — Voice Input */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 bg-emerald-500 text-white rounded-full text-xs flex items-center justify-center font-bold">1</span>
              <div>
                <div className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Voice Input</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">MP3 / Audio files</div>
              </div>
            </div>
            {audioEntries.length > 0 && (
              <button
                onClick={() => { setAudioEntries([]); setGenerated(false); }}
                className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 transition-colors"
              >
                Clear all
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            <input ref={audioInputRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac" multiple className="hidden" onChange={handleFileInput} />
            {audioEntries.length === 0 ? (
              <div
                onClick={() => audioInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                  isDragging ? "border-emerald-400 bg-emerald-50" : "border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/50"
                }`}
              >
                {loadingFiles ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-4">
                    <svg className="w-4 h-4 animate-spin text-emerald-500" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Reading durations...
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Upload className="w-5 h-5 text-emerald-500" />
                    </div>
                    <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Drop audio files here</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">or click to browse</p>
                    <p className="text-xs text-gray-300 dark:text-gray-600 mt-1">MP3, WAV, M4A, OGG</p>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-2 py-1.5 bg-emerald-50 rounded-lg border border-emerald-100 mb-2">
                  <Music className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                  <span className="text-xs text-emerald-700 font-medium truncate">Audio queue</span>
                  <span className="ml-auto text-xs text-emerald-500">{audioEntries.length} files</span>
                </div>

                {audioEntries.map((entry, i) => (
                  <div key={entry.id} className="border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/50 hover:bg-white dark:hover:bg-gray-900 rounded-lg p-3 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="w-5 h-5 bg-blue-100 text-blue-600 rounded text-xs flex items-center justify-center font-bold flex-shrink-0">
                          {i + 1}
                        </span>
                        <span className="text-xs font-mono tabular-nums truncate text-gray-500 dark:text-gray-400">
                          {msToDisplay(entry.startMs)} → {msToDisplay(entry.endMs)}
                        </span>
                      </div>
                      <button
                        onClick={() => removeEntry(entry.id)}
                        className="p-0.5 rounded hover:bg-red-100 transition-colors flex-shrink-0"
                      >
                        <X className="w-3 h-3 text-red-400" />
                      </button>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-300 mt-2 ml-7 leading-relaxed truncate">{entry.name}</p>
                  </div>
                ))}

                <button
                  onClick={() => audioInputRef.current?.click()}
                  className="w-full text-xs text-gray-400 dark:text-gray-500 hover:text-emerald-500 py-2 transition-colors"
                >
                  + Add more audio files
                </button>
              </>
            )}
          </div>
        </div>

        {/* Card 2 — Sentence Input */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 bg-emerald-500 text-white rounded-full text-xs flex items-center justify-center font-bold">2</span>
              <div>
                <div className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Sentence Input</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">One sentence per line</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button
                  onClick={() => setLangOpen((o) => !o)}
                  title="Select language direction"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-xs font-bold text-blue-500 hover:border-blue-300 transition-all"
                >
                  {lang.toUpperCase()}
                  <svg className="w-2.5 h-2.5 text-gray-400 dark:text-gray-500" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>
                {langOpen && (
                  <div className="absolute top-full right-0 mt-1 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden min-w-[120px]">
                    {([
                      { code: "en", label: "EN", desc: "English" },
                      { code: "ar", label: "AR", desc: "Arabic (RTL)" },
                      { code: "de", label: "DE", desc: "German" },
                    ] as const).map(({ code, label, desc }) => (
                      <button key={code} onClick={() => { setLang(code); setLangOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-blue-50 ${lang === code ? "bg-blue-50 text-blue-600" : "text-gray-600"}`}>
                        <span className="font-bold">{label}</span>
                        <span className="text-gray-400 dark:text-gray-500 font-normal">{desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {sentenceLines.length > 0 && (
                <span className="bg-blue-50 text-blue-600 border border-blue-100 text-xs px-2 py-0.5 rounded-full font-medium">
                  {sentenceLines.length} lines
                </span>
              )}
              {sentences && (
                <button
                  onClick={() => { setSentences(""); setGenerated(false); }}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-500 transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            <div className="space-y-2">
              {allLines.map((line, i) => (
                <div
                  key={i}
                  className="flex gap-2 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400 transition-colors"
                  dir={langDir}
                >
                  <span
                    className="text-xs font-semibold text-gray-400 dark:text-gray-500 mt-0.5 w-5 flex-shrink-0 text-right"
                    style={{ userSelect: "none", WebkitUserSelect: "none", pointerEvents: "none" }}
                    aria-hidden="true"
                  >
                    {i + 1}.
                  </span>
                  <input
                    ref={(el) => { lineRefs.current[i] = el; }}
                    type="text"
                    value={line}
                    onChange={(e) => updateLine(i, e.target.value)}
                    onKeyDown={(e) => handleLineKeyDown(i, e)}
                    onPaste={(e) => handleLinePaste(i, e)}
                    placeholder={i === 0 ? "Type or paste sentences here…" : ""}
                    className="flex-1 bg-transparent outline-none text-sm text-gray-700 dark:text-gray-200 placeholder-gray-300 leading-relaxed"
                    spellCheck={false}
                    dir={langDir}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Card 3 — Output SRT */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 bg-emerald-500 text-white rounded-full text-xs flex items-center justify-center font-bold">3</span>
              <div>
                <div className="font-semibold text-gray-800 dark:text-gray-100 text-sm">Output SRT</div>
                <div className="text-xs text-gray-400 dark:text-gray-500">Preview & download</div>
              </div>
            </div>
            {generated && srtCards.length > 0 && (
              <span className="bg-orange-50 text-orange-600 border border-orange-100 text-xs px-2 py-0.5 rounded-full font-medium">
                {srtCards.length} cards
              </span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {!generated ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-gray-500 gap-3 py-12">
                <div className="w-12 h-12 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium">Output will appear here</p>
                  <p className="text-xs mt-1">
                    {canGenerate
                      ? "Click \"Generate SRT\" to create output"
                      : "Add audio files + sentences, then click Generate"}
                  </p>
                  {canGenerate && (
                    <p className="text-xs mt-2 text-emerald-500 font-medium">
                      ✓ {srtCards.length} subtitles ready to generate
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                {srtCards.map((card) => (
                  <div
                    key={card.index}
                    className={`border rounded-lg p-3 transition-colors ${
                      !card.text
                        ? "border-amber-200 bg-amber-50/40"
                        : "border-gray-100 hover:border-emerald-200 hover:bg-emerald-50/20"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-5 h-5 bg-emerald-500 text-white rounded text-xs flex items-center justify-center font-bold flex-shrink-0">
                        {card.index}
                      </span>
                      <span className="text-xs font-mono tabular-nums text-gray-500 dark:text-gray-400 truncate">
                        {card.startTime} → {card.endTime}
                      </span>
                      {!card.text && (
                        <span className="ml-auto text-xs bg-amber-100 text-amber-600 px-1.5 rounded font-medium">no text</span>
                      )}
                    </div>
                    <p className={`text-sm leading-relaxed ml-7 ${card.text ? "text-gray-800" : "text-gray-300 italic"}`} dir={langDir}>
                      {card.text || "—"}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 ml-7 truncate flex items-center gap-1">
                      <FileText className="w-3 h-3" />
                      {card.name}
                    </p>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
