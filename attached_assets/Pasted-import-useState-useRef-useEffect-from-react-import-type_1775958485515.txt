import { useState, useRef, useEffect } from "react";
import { type Subtitle, parseSrt, downloadSrt } from "@/lib/srt";

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface Props {
  editorSubtitles: Subtitle[];
  editorFilename: string;
}

function timeToMs(t: string): number {
  const [h, m, sms] = t.split(":");
  const [s, ms] = sms.split(",");
  return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
}

function msToTime(ms: number): string {
  const v = Math.max(0, ms);
  const h = Math.floor(v / 3600000).toString().padStart(2, "0");
  const m = Math.floor((v % 3600000) / 60000).toString().padStart(2, "0");
  const s = Math.floor((v % 60000) / 1000).toString().padStart(2, "0");
  const ms2 = (v % 1000).toString().padStart(3, "0");
  return `${h}:${m}:${s},${ms2}`;
}

function buildTimeline(subs: Subtitle[]): { text: string; timeline: number[]; lastEndMs: number } {
  const chars: string[] = [];
  const timeline: number[] = [];

  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i];
    const startMs = timeToMs(sub.startTime);
    const endMs = timeToMs(sub.endTime);
    const t = sub.text;
    const n = t.length || 1;

    for (let j = 0; j < t.length; j++) {
      chars.push(t[j]);
      timeline.push(startMs + Math.round(((endMs - startMs) * j) / n));
    }

    if (i < subs.length - 1) {
      chars.push(" ");
      timeline.push(endMs);
    }
  }

  const lastEndMs = subs.length ? timeToMs(subs[subs.length - 1].endTime) : 0;
  return { text: chars.join(""), timeline, lastEndMs };
}

function globalEmojiSplit(
  subs: Subtitle[]
): Array<{ text: string; startMs: number; endMs: number }> {
  if (!subs.length) return [];
  const { text, timeline, lastEndMs } = buildTimeline(subs);

  const sentences: Array<{ text: string; startMs: number; endMs: number }> = [];
  const emojiRe = /\p{Extended_Pictographic}\uFE0F?/gu;
  let lastEnd = 0;
  let m: RegExpExecArray | null;

  const firstNonSpace = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (text[k] !== " ") return k;
    return from;
  };

  while ((m = emojiRe.exec(text)) !== null) {
    const segEnd = m.index + m[0].length;
    const segText = text.slice(lastEnd, segEnd).trim();
    if (segText) {
      const firstIdx = firstNonSpace(lastEnd, segEnd);
      const lastIdx = segEnd - 1;
      sentences.push({
        text: segText,
        startMs: timeline[firstIdx] ?? 0,
        endMs: (timeline[lastIdx] ?? 0),
      });
    }
    lastEnd = segEnd;
  }

  const tail = text.slice(lastEnd).trim();
  if (tail) {
    const firstIdx = firstNonSpace(lastEnd, text.length);
    sentences.push({ text: tail, startMs: timeline[firstIdx] ?? 0, endMs: lastEndMs });
  }

  return sentences;
}

function countEmojiBreaks(subs: Subtitle[]): number {
  const { text } = buildTimeline(subs);
  return (text.match(/\p{Extended_Pictographic}\uFE0F?/gu) ?? []).length;
}

export default function TextSplitterTab({ editorSubtitles, editorFilename }: Props) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>(editorSubtitles);
  const [filename, setFilename] = useState(editorFilename);
  const [source, setSource] = useState<"editor" | "local">(editorSubtitles.length > 0 ? "editor" : "local");
  const [splitDone, setSplitDone] = useState(false);
  const [newCardCount, setNewCardCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editorSubtitles.length > 0 && source === "editor") {
      setSubtitles(editorSubtitles);
      setFilename(editorFilename);
      setSplitDone(false);
    }
  }, [editorSubtitles, editorFilename]);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setSubtitles(parseSrt(content));
      setFilename(file.name);
      setSource("local");
      setSplitDone(false);
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
    setSource("local");
    setSplitDone(false);
    setPasteText("");
    setPasteOpen(false);
  }

  function handleClear() {
    setSubtitles([]);
    setFilename("");
    setSplitDone(false);
  }

  function handleResetFromEditor() {
    setSubtitles(editorSubtitles);
    setFilename(editorFilename);
    setSource("editor");
    setSplitDone(false);
  }

  function handleSplit() {
    const sentences = globalEmojiSplit(subtitles);
    if (!sentences.length) return;

    const trailingEmoji = /\p{Extended_Pictographic}\uFE0F?\s*$/u;
    const result: Subtitle[] = sentences.map((sen, i) => {
      const cleanText = trailingEmoji.test(sen.text)
        ? sen.text.replace(trailingEmoji, ".").trimEnd()
        : sen.text;
      return {
        id: i + 1,
        index: i + 1,
        startTime: msToTime(sen.startMs),
        endTime: msToTime(sen.endMs),
        text: cleanText,
        originalText: cleanText,
        edited: false,
      };
    });

    setSubtitles(result);
    setNewCardCount(result.length - subtitles.length);
    setSplitDone(true);
  }

  const emojiBreaks = countEmojiBreaks(subtitles);

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
        {source === "editor" && subtitles.length > 0 && (
          <span className="flex items-center gap-1 text-xs bg-indigo-50 text-indigo-600 border border-indigo-200 px-2.5 py-1 rounded-full font-medium">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            From SRT Editor
          </span>
        )}
        {source === "local" && editorSubtitles.length > 0 && (
          <button
            onClick={handleResetFromEditor}
            className="flex items-center gap-1 text-xs bg-gray-100 text-gray-500 border border-gray-200 px-2.5 py-1 rounded-full font-medium hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Sync from SRT Editor
          </button>
        )}
        {subtitles.length > 0 && (
          <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full font-medium">
            {subtitles.length} subtitles
          </span>
        )}
        {!splitDone && emojiBreaks > 0 && (
          <span className="flex items-center gap-1 text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2.5 py-1 rounded-full font-medium">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {emojiBreaks} emoji sentence break{emojiBreaks !== 1 ? "s" : ""} found
          </span>
        )}
        {splitDone && (
          <span className="flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            +{newCardCount} new cards created
          </span>
        )}

        <div className="flex-1" />

        <button
          onClick={handleSplit}
          disabled={subtitles.length === 0 || emojiBreaks === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
          </svg>
          Split Lines
        </button>

        <button
          onClick={async () => {
            const text = subtitles.map((s) => s.text).join("\n");
            const ok = await copyToClipboard(text);
            if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); }
          }}
          disabled={subtitles.length === 0}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            copied
              ? "bg-green-500 text-white hover:bg-green-600"
              : "bg-gray-700 text-white hover:bg-gray-800"
          }`}
        >
          {copied ? (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy All
            </>
          )}
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

      {subtitles.length > 0 && !splitDone && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-start gap-3">
          <div className="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-blue-100 flex items-center justify-center">
            <svg className="w-3 h-3 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="text-xs text-blue-700 leading-relaxed">
            <span className="font-semibold">Rule:</span> Every emoji = end of a complete sentence. All subtitle cards are merged into one stream and split globally at each emoji.{" "}
            {emojiBreaks > 0
              ? `Found ${emojiBreaks} emoji break${emojiBreaks !== 1 ? "s" : ""} — clicking "Split Lines" will create ${emojiBreaks + 1} sentence cards with timing pulled from the source cards.`
              : "No emoji breaks found yet. Use the SRT Editor → Convert punctuation to emoji first, then come back here to split."}
          </div>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept=".srt,.txt" className="hidden" onChange={handleFileInput} />

      {!filename && (
        <div className="flex flex-col gap-0">
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center py-14 px-8 select-none ${
              isDragging ? "border-blue-400 bg-blue-50" : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/40"
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
            <button onClick={() => setPasteOpen(true)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 shadow-sm transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Paste SRT text
            </button>
          </div>
        </div>
      )}

      {filename && (
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap shadow-sm">
          <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-semibold text-gray-700">{filename}</span>
          <div className="flex-1" />
          <button onClick={handleClear} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50 hover:text-red-500 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Clear
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 text-xs text-gray-500 hover:bg-gray-50 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Load another
          </button>
        </div>
      )}

      {subtitles.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {subtitles.map((sub) => {
            const hasEmoji = /\p{Extended_Pictographic}/u.test(sub.text);
            return (
              <div key={sub.id}
                className={`bg-white rounded-2xl border shadow-sm transition-all flex items-start gap-3 px-4 py-3 ${
                  hasEmoji && !splitDone ? "border-blue-300 shadow-blue-50" : "border-gray-200"
                }`}>
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-xs font-bold text-gray-500 shrink-0 mt-0.5">
                  {sub.index}
                </span>
                <p className="text-sm text-gray-800 leading-relaxed">{sub.text}</p>
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
              <textarea autoFocus value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                placeholder={"1\n00:00:00,000 --> 00:00:05,000\nHello World\n\n2\n..."}
                className="w-full h-72 p-3 text-sm font-mono border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-300 text-gray-700 placeholder-gray-300" />
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
