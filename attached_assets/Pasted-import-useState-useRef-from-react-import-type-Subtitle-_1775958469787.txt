import { useState, useRef } from "react";
import { type Subtitle, parseSrt, downloadSrt } from "@/lib/srt";

const SYMBOLS = [
  { label: "Sun Cross", char: "☀️" },
  { label: "Glowing Star", char: "🌟" },
  { label: "Sparkles", char: "✨" },
  { label: "Lightning", char: "⚡" },
  { label: "Check Mark", char: "✅" },
  { label: "Red Triangle", char: "🔺" },
  { label: "No Entry", char: "⛔" },
];

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:04,000
Hello. How are you?

2
00:00:04,500 --> 00:00:08,000
I am fine. Thank you.

3
00:00:08,500 --> 00:00:12,000
What is your name? My name is Alex.

4
00:00:12,500 --> 00:00:16,000
Nice to meet you. Where are you from?

5
00:00:16,500 --> 00:00:20,000
I am from Bangladesh। Good day!
`;

interface Props {
  subtitles: Subtitle[];
  filename: string;
  setSubtitles: (s: Subtitle[]) => void;
  setFilename: (f: string) => void;
}

function timeToMs(t: string): number {
  const [h, m, sms] = t.split(":");
  const [s, ms] = sms.split(",");
  return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
}

function msToTime(ms: number): string {
  const ms2 = Math.max(0, ms);
  const h = Math.floor(ms2 / 3600000).toString().padStart(2, "0");
  const m = Math.floor((ms2 % 3600000) / 60000).toString().padStart(2, "0");
  const s = Math.floor((ms2 % 60000) / 1000).toString().padStart(2, "0");
  const msStr = (ms2 % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${msStr}`;
}

export default function SrtEditorTab({ subtitles, filename, setSubtitles, setFilename }: Props) {
  const [selectedSymbol, setSelectedSymbol] = useState(SYMBOLS[4]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [convertStats, setConvertStats] = useState<{ marks: number; ellipsis: number } | null>(null);
  const [converted, setConverted] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [fixedCount, setFixedCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setSubtitles(parseSrt(content));
      setFilename(file.name);
      setConvertStats(null);
      setConverted(false);
      setFixedCount(null);
    };
    reader.readAsText(file, "utf-8");
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }

  function handlePaste() {
    if (!pasteText.trim()) return;
    setSubtitles(parseSrt(pasteText));
    setFilename("pasted.srt");
    setConvertStats(null);
    setConverted(false);
    setFixedCount(null);
    setPasteText("");
    setPasteOpen(false);
  }

  function loadSample() {
    setSubtitles(parseSrt(SAMPLE_SRT));
    setFilename("sample.srt");
    setConvertStats(null);
    setConverted(false);
    setFixedCount(null);
  }

  function handleClear() {
    setSubtitles([]);
    setFilename("");
    setConvertStats(null);
    setConverted(false);
    setFixedCount(null);
  }

  function handleFixTiming() {
    let count = 0;
    const arr = subtitles.map((s) => ({ ...s }));
    for (let i = 1; i < arr.length; i++) {
      const prevEndMs = timeToMs(arr[i - 1].endTime);
      const currStartMs = timeToMs(arr[i].startTime);
      if (currStartMs < prevEndMs) {
        arr[i - 1].endTime = msToTime(currStartMs - 1);
        count++;
      }
    }
    setSubtitles(arr);
    setFixedCount(count);
  }

  const overlapSet = new Set<number>();
  for (let i = 1; i < subtitles.length; i++) {
    const prevEnd = timeToMs(subtitles[i - 1].endTime);
    const currStart = timeToMs(subtitles[i].startTime);
    if (currStart < prevEnd) {
      overlapSet.add(i - 1);
      overlapSet.add(i);
    }
  }
  const overlapCount = overlapSet.size > 0 ? Math.ceil(overlapSet.size / 2) : 0;

  function handleTextChange(id: number, newText: string) {
    setSubtitles(
      subtitles.map((s) =>
        s.id === id ? { ...s, text: newText, edited: newText !== s.originalText } : s
      )
    );
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    const arr = [...subtitles];
    [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
    setSubtitles(arr.map((s, i) => ({ ...s, index: i + 1 })));
  }

  function moveDown(idx: number) {
    if (idx === subtitles.length - 1) return;
    const arr = [...subtitles];
    [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
    setSubtitles(arr.map((s, i) => ({ ...s, index: i + 1 })));
  }

  function addAfter(idx: number) {
    const prev = subtitles[idx];
    const newSub: Subtitle = {
      id: Date.now() * 1000 + Math.floor(Math.random() * 999),
      index: 0,
      startTime: prev.endTime,
      endTime: prev.endTime,
      text: "",
      originalText: "",
      edited: true,
    };
    const arr = [...subtitles];
    arr.splice(idx + 1, 0, newSub);
    setSubtitles(arr.map((s, i) => ({ ...s, index: i + 1 })));
  }

  function remove(idx: number) {
    const arr = [...subtitles];
    arr.splice(idx, 1);
    setSubtitles(arr.map((s, i) => ({ ...s, index: i + 1 })));
  }

  function handleConvert() {
    let marks = 0;
    let removed = 0;
    const result = subtitles.map((s) => {
      let text = s.text;
      const multiMatches = (text.match(/[.?!।]{2,}/g) || []);
      removed += multiMatches.length;
      text = text.replace(/[.?!।]{2,}/g, "");
      const singleMatches = (text.match(/[.?!।]/g) || []);
      marks += singleMatches.length;
      text = text.replace(/[.?!।]/g, selectedSymbol.char);
      return { ...s, text, edited: text !== s.originalText };
    });
    setSubtitles(result);
    setConvertStats({ marks, ellipsis: removed });
    setConverted(true);
  }

  const punctCount = subtitles.reduce(
    (acc, s) => acc + (s.text.match(/[.?!।]/g) || []).length, 0
  );

  return (
    <div className="flex flex-col gap-0">
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2 mb-3">
        {subtitles.length > 0 && (
          <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full font-medium">
            {subtitles.length} subtitles{converted ? " • converted" : ""}
          </span>
        )}
        {converted && convertStats && (
          <>
            <span className="flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
              {selectedSymbol.char} {convertStats.marks} marks converted
            </span>
            {convertStats.ellipsis > 0 && (
              <span className="text-xs bg-red-100 text-red-600 px-2.5 py-1 rounded-full font-medium">
                {convertStats.ellipsis} extra removed
              </span>
            )}
          </>
        )}
        {overlapCount > 0 && fixedCount === null && (
          <span className="flex items-center gap-1 text-xs bg-red-100 text-red-600 px-2.5 py-1 rounded-full font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            {overlapCount} overlap{overlapCount > 1 ? "s" : ""} detected
          </span>
        )}
        {fixedCount !== null && (
          <span className="flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            {fixedCount} timing{fixedCount !== 1 ? "s" : ""} fixed
          </span>
        )}

        <div className="flex-1" />
        <span className="text-xs text-gray-400 font-medium hidden sm:inline">Replace . ? ! ।&nbsp;with</span>

        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm"
          >
            <span>{selectedSymbol.char}</span>
            <span>{selectedSymbol.label}</span>
            <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {dropdownOpen && (
            <div className="absolute right-0 mt-1 w-44 bg-white border border-gray-200 rounded-xl shadow-xl z-30 py-1 overflow-hidden">
              {SYMBOLS.map((sym) => (
                <button
                  key={sym.char}
                  onClick={() => { setSelectedSymbol(sym); setDropdownOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${
                    selectedSymbol.char === sym.char
                      ? "bg-blue-600 text-white"
                      : "text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  <span className="text-base">{sym.char}</span>
                  <span>{sym.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleFixTiming}
          disabled={subtitles.length === 0 || overlapCount === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-purple-600 text-white text-sm font-semibold hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Fix Timing
        </button>

        <button
          onClick={handleConvert}
          disabled={subtitles.length === 0 || punctCount === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Convert . ? !
        </button>

        <button
          onClick={() => downloadSrt(subtitles)}
          disabled={subtitles.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download SRT
        </button>
      </div>

      <input ref={fileInputRef} type="file" accept=".srt,.txt" className="hidden" onChange={handleFileInput} />

      {!filename && (
        <div className="flex flex-col gap-0">
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center py-14 px-8 select-none ${
              isDragging
                ? "border-blue-400 bg-blue-50"
                : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/40"
            }`}
          >
            <div className="w-14 h-14 rounded-full bg-white shadow-sm border border-gray-200 flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
            <p className="text-base font-bold text-gray-700 mb-1">Drop your SRT file here</p>
            <p className="text-sm text-gray-400">or click to browse — supports .srt and .txt files</p>
          </div>

          <div className="flex items-center gap-3 my-4 px-2">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-sm text-gray-400 font-medium">or</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          <div className="flex items-center justify-center gap-3">
            <button onClick={() => setPasteOpen(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Paste SRT text
            </button>
            <button onClick={loadSample}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Load sample
            </button>
          </div>
        </div>
      )}

      {filename && (
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap mb-3 shadow-sm">
          <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">{filename}</span>
          {converted && (
            <span className="flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
              {selectedSymbol.char} Converted
            </span>
          )}
          <div className="flex-1" />
          <button onClick={handleClear}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-500 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Clear
          </button>
          <button onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Load another
          </button>
        </div>
      )}

      {subtitles.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {subtitles.map((sub, idx) => {
            const hasOverlap = overlapSet.has(idx);
            return (
              <div key={sub.id}
                className={`bg-white rounded-2xl border shadow-sm transition-all ${
                  hasOverlap
                    ? "border-orange-400 shadow-orange-100"
                    : sub.edited ? "border-emerald-300 shadow-emerald-100" : "border-gray-200"
                }`}>
                <div className="flex items-center gap-2.5 px-4 pt-3 pb-2 border-b border-gray-100">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-bold text-gray-500 shrink-0">
                    {sub.index}
                  </span>
                  <div className={`flex items-center gap-1.5 text-xs font-mono ${hasOverlap ? "text-orange-500 font-semibold" : "text-gray-400"}`}>
                    <span>{sub.startTime}</span>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                    <span>{sub.endTime}</span>
                  </div>
                  {hasOverlap && (
                    <span className="flex items-center gap-1 text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full font-medium">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      overlap
                    </span>
                  )}
                  {!hasOverlap && sub.edited && (
                    <span className="text-xs bg-emerald-100 text-emerald-600 px-2 py-0.5 rounded-full font-medium">edited</span>
                  )}
                  <div className="flex-1" />
                  <div className="flex items-center gap-0.5">
                    <button onClick={() => moveUp(idx)} disabled={idx === 0} title="Move up"
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                      </svg>
                    </button>
                    <button onClick={() => moveDown(idx)} disabled={idx === subtitles.length - 1} title="Move down"
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    <button onClick={() => addAfter(idx)} title="Add after"
                      className="p-1.5 rounded-lg text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                    <button onClick={() => remove(idx)} title="Delete"
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className="px-4 py-3">
                  <textarea
                    ref={(el) => { if (el) autoResize(el); }}
                    value={sub.text}
                    onChange={(e) => { handleTextChange(sub.id, e.target.value); autoResize(e.target); }}
                    rows={1}
                    spellCheck={false}
                    placeholder="Enter subtitle text..."
                    className="w-full resize-none overflow-hidden text-gray-800 text-sm leading-relaxed bg-transparent border-none outline-none focus:ring-0 p-0 placeholder-gray-300"
                    style={{ minHeight: "1.5rem" }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pasteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">Paste SRT Content</h2>
              <button onClick={() => { setPasteOpen(false); setPasteText(""); }} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              <textarea
                autoFocus value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder={"1\n00:00:00,000 --> 00:00:05,000\nHello World\n\n2\n..."}
                className="w-full h-72 p-3 text-sm font-mono border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-300 text-gray-700 placeholder-gray-300"
              />
            </div>
            <div className="px-6 pb-5 flex gap-2 justify-end">
              <button onClick={() => { setPasteOpen(false); setPasteText(""); }}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
              <button onClick={handlePaste} disabled={!pasteText.trim()}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40">Load SRT</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
