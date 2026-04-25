import { useState, useRef, useEffect } from "react";
import { type Subtitle, parseSrt, downloadSrt } from "@/lib/srt";

interface Props {
  sharedSubtitles: Subtitle[];
  sharedFilename: string;
}

type EmojiMode = "number" | "emoji";

function textToDashes(text: string, counter: { n: number }, mode: EmojiMode): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const emojiCheck = /\p{Extended_Pictographic}/u;
  let result = "";
  for (const { segment } of segmenter.segment(text)) {
    if (emojiCheck.test(segment)) {
      if (mode === "number") {
        counter.n++;
        result += `[${String(counter.n).padStart(3, "0")}]`;
      } else {
        result += "✅";
      }
    } else {
      result += "-";
    }
  }
  return result;
}

export default function SrtConverterTab({ sharedSubtitles, sharedFilename }: Props) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [filename, setFilename] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [converted, setConverted] = useState(false);
  const [emojiMode, setEmojiMode] = useState<EmojiMode>("number");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userModified = useRef(false);

  useEffect(() => {
    if (!userModified.current && sharedSubtitles.length > 0) {
      setSubtitles(sharedSubtitles.map((s) => ({ ...s })));
      setFilename(sharedFilename);
      setConverted(false);
    }
  }, [sharedSubtitles, sharedFilename]);

  function loadFile(file: File) {
    userModified.current = true;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setSubtitles(parseSrt(content));
      setFilename(file.name);
      setConverted(false);
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

  function handleClear() {
    userModified.current = true;
    setSubtitles([]);
    setFilename("");
    setConverted(false);
  }

  function handleConvert() {
    userModified.current = true;
    const counter = { n: 0 };
    const result = subtitles.map((s) => {
      const newText = s.text
        .split("\n")
        .map((line) => textToDashes(line, counter, emojiMode))
        .join("\n");
      return { ...s, text: newText, edited: true };
    });
    setSubtitles(result);
    setConverted(true);
  }

  const convertRef = useRef(handleConvert);
  convertRef.current = handleConvert;
  useEffect(() => {
    const h = () => convertRef.current();
    window.addEventListener("srt-tools:converter-convert", h);
    return () => window.removeEventListener("srt-tools:converter-convert", h);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
        {subtitles.length > 0 && (
          <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-2.5 py-1 rounded-full font-medium">
            {subtitles.length} subtitles
          </span>
        )}
        {converted && (
          <span className="text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
            ✓ Converted
          </span>
        )}
        <div className="flex-1" />

        {/* Mode toggle */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
          <button
            onClick={() => { setEmojiMode("number"); setConverted(false); }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
              emojiMode === "number"
                ? "bg-white text-gray-800 shadow-sm border border-gray-200"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <span className="font-mono font-bold">[001]</span>
            Number
          </button>
          <button
            onClick={() => { setEmojiMode("emoji"); setConverted(false); }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
              emojiMode === "emoji"
                ? "bg-white text-gray-800 shadow-sm border border-gray-200"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <span>✅</span>
            Emoji
          </button>
        </div>

        <button
          onClick={handleConvert}
          disabled={subtitles.length === 0}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Convert
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

      {subtitles.length > 0 && !converted && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-amber-500 text-lg shrink-0 mt-0.5">⚡</span>
          <div className="text-xs text-amber-800 leading-relaxed">
            <span className="font-semibold">Text → Dashes:</span> প্রতিটি character → <span className="font-mono font-bold">-</span> হবে।{" "}
            {emojiMode === "number"
              ? "Emoji গুলো পুরো file জুড়ে sequential number পাবে।"
              : "Emoji গুলো ✅ হিসেবে থাকবে।"}
            <br />
            <span className="font-mono text-amber-700 text-xs mt-1 block">
              {emojiMode === "number"
                ? '"Hello✅ World✅" → "-----[001]------[002]"'
                : '"Hello✅ World✅" → "-----✅------✅"'}
            </span>
          </div>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept=".srt,.txt" className="hidden" onChange={handleFileInput} />

      {!filename && (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`cursor-pointer rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center py-14 px-8 select-none ${
            isDragging ? "border-blue-400 bg-blue-50" : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/40"
          }`}
        >
          <div className="w-14 h-14 rounded-full bg-white dark:bg-gray-900 shadow-sm border border-gray-200 dark:border-gray-700 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <p className="text-base font-bold text-gray-700 dark:text-gray-200 mb-1">Drop your SRT file here</p>
          <p className="text-sm text-gray-400 dark:text-gray-500">or click to browse</p>
        </div>
      )}

      {filename && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 flex items-center gap-3 flex-wrap shadow-sm">
          <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{filename}</span>
          <div className="flex-1" />
          <button onClick={handleClear} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-red-500 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            Clear
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            Load another
          </button>
        </div>
      )}

      {subtitles.length > 0 && (
        <div className="flex flex-col gap-2">
          {subtitles.map((sub) => (
            <div
              key={sub.id}
              className={`bg-white dark:bg-gray-900 rounded-xl border shadow-sm px-4 py-3 transition-all ${
                sub.edited ? "border-emerald-300 bg-emerald-50/30" : "border-gray-200"
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs font-bold text-gray-500 dark:text-gray-400 shrink-0">
                  {sub.index}
                </span>
                <span className="text-xs font-mono text-gray-400 dark:text-gray-500">{sub.startTime} → {sub.endTime}</span>
                {sub.edited && (
                  <span className="text-xs bg-emerald-100 text-emerald-600 px-2 py-0.5 rounded-full font-medium">
                    converted
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-800 dark:text-gray-100 font-mono break-all leading-relaxed">
                {sub.text.split(/(\[\d{3}\]|✅)/g).map((part, i) =>
                  /^\[\d{3}\]$/.test(part) || part === "✅"
                    ? <span key={i} className="text-green-600 font-bold">{part}</span>
                    : part
                )}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
