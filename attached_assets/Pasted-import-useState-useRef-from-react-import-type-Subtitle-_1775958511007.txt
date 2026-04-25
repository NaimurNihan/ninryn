import { useState, useRef } from "react";
import { type Subtitle, parseSrt, downloadSrt } from "@/lib/srt";

interface Props {
  subtitles: Subtitle[];
  filename: string;
  setSubtitles: (s: Subtitle[]) => void;
  setFilename: (f: string) => void;
}

export default function SrtEditTab({ subtitles, filename, setSubtitles, setFilename }: Props) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replaceCount, setReplaceCount] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setSubtitles(parseSrt(content));
      setFilename(file.name);
      setReplaceCount(null);
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
    setSubtitles([]);
    setFilename("");
    setReplaceCount(null);
  }

  function handleReplace() {
    if (!findText.trim()) return;
    let count = 0;
    const flags = caseSensitive ? "g" : "gi";
    const pattern = useRegex ? findText : findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      return;
    }
    const result = subtitles.map((s) => {
      const matches = s.text.match(regex);
      if (matches) count += matches.length;
      const newText = s.text.replace(regex, replaceText);
      return { ...s, text: newText, edited: newText !== s.originalText };
    });
    setSubtitles(result);
    setReplaceCount(count);
  }

  const matchCount = (() => {
    if (!findText.trim()) return 0;
    try {
      const flags = caseSensitive ? "g" : "gi";
      const pattern = useRegex ? findText : findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(pattern, flags);
      return subtitles.reduce((acc, s) => acc + (s.text.match(regex) || []).length, 0);
    } catch {
      return 0;
    }
  })();

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
        {subtitles.length > 0 && (
          <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full font-medium">
            {subtitles.length} subtitles
          </span>
        )}
        {replaceCount !== null && (
          <span className="text-xs bg-green-100 text-green-700 px-2.5 py-1 rounded-full font-medium">
            {replaceCount} replacements made
          </span>
        )}
        <div className="flex-1" />
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

      {subtitles.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 flex flex-col gap-3 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700">Find & Replace</h3>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Find</label>
              <input
                value={findText}
                onChange={(e) => setFindText(e.target.value)}
                placeholder="Search text..."
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Replace with</label>
              <input
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="Replacement text..."
                className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} className="rounded" />
              Regex
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="rounded" />
              Case sensitive
            </label>
            {findText.trim() && matchCount > 0 && (
              <span className="text-xs text-blue-600 font-medium">{matchCount} match{matchCount !== 1 ? "es" : ""}</span>
            )}
            <div className="flex-1" />
            <button
              onClick={handleReplace}
              disabled={!findText.trim() || matchCount === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-orange-500 text-white text-sm font-semibold hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
            >
              Replace All
            </button>
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
          <div className="w-14 h-14 rounded-full bg-white shadow-sm border border-gray-200 flex items-center justify-center mb-4">
            <svg className="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <p className="text-base font-bold text-gray-700 mb-1">Drop your SRT file here</p>
          <p className="text-sm text-gray-400">or click to browse</p>
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
        <div className="flex flex-col gap-2">
          {subtitles.map((sub) => (
            <div key={sub.id} className={`bg-white rounded-xl border shadow-sm px-4 py-3 transition-all ${sub.edited ? "border-emerald-300" : "border-gray-200"}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-100 text-xs font-bold text-gray-500">{sub.index}</span>
                <span className="text-xs font-mono text-gray-400">{sub.startTime} → {sub.endTime}</span>
                {sub.edited && <span className="text-xs bg-emerald-100 text-emerald-600 px-2 py-0.5 rounded-full font-medium">edited</span>}
              </div>
              <p className="text-sm text-gray-800">{sub.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
