import { useState, useRef } from "react";
import { type Subtitle, parseSrt } from "@/lib/srt";

interface Props {
  subtitles: Subtitle[];
  filename: string;
  setSubtitles: (s: Subtitle[]) => void;
  setFilename: (f: string) => void;
}

export default function CounterTab({ subtitles, filename, setSubtitles, setFilename }: Props) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setSubtitles(parseSrt(content));
      setFilename(file.name);
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
  }

  const stats = (() => {
    if (!subtitles.length) return null;
    const totalChars = subtitles.reduce((a, s) => a + s.text.length, 0);
    const totalWords = subtitles.reduce((a, s) => a + s.text.split(/\s+/).filter(Boolean).length, 0);
    const totalLines = subtitles.reduce((a, s) => a + s.text.split("\n").length, 0);
    const avgChars = Math.round(totalChars / subtitles.length);
    const avgWords = Math.round(totalWords / subtitles.length);
    const longSubs = subtitles.filter((s) => s.text.length > 84).length;
    const shortSubs = subtitles.filter((s) => s.text.trim().length < 5).length;
    const emptyLines = subtitles.filter((s) => !s.text.trim()).length;

    const parseMs = (t: string) => {
      const [h, m, sms] = t.split(":");
      const [s, ms] = sms.split(",");
      return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
    };
    const durations = subtitles.map((s) => parseMs(s.endTime) - parseMs(s.startTime));
    const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);

    const charFreq: Record<string, number> = {};
    for (const s of subtitles) {
      for (const c of s.text) {
        if (/[^\s]/.test(c)) charFreq[c] = (charFreq[c] || 0) + 1;
      }
    }
    const topChars = Object.entries(charFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return { totalChars, totalWords, totalLines, avgChars, avgWords, longSubs, shortSubs, emptyLines, avgDuration, maxDuration, minDuration, topChars };
  })();

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 flex flex-wrap items-center gap-2">
        {subtitles.length > 0 && (
          <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-2.5 py-1 rounded-full font-medium">
            {subtitles.length} subtitles
          </span>
        )}
        <div className="flex-1" />
        {filename && (
          <>
            <button onClick={handleClear} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-red-500 transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear
            </button>
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
              Load another
            </button>
          </>
        )}
      </div>

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

      {filename && stats && (
        <div className="flex flex-col gap-3">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 flex items-center gap-3 shadow-sm">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">{filename}</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {[
              { label: "Total Subtitles", value: subtitles.length },
              { label: "Total Characters", value: stats.totalChars.toLocaleString() },
              { label: "Total Words", value: stats.totalWords.toLocaleString() },
              { label: "Total Lines", value: stats.totalLines.toLocaleString() },
              { label: "Avg Chars/Sub", value: stats.avgChars },
              { label: "Avg Words/Sub", value: stats.avgWords },
              { label: "Long Subs (>84)", value: stats.longSubs },
              { label: "Empty Subs", value: stats.emptyLines },
              { label: "Avg Duration", value: `${(stats.avgDuration / 1000).toFixed(2)}s` },
              { label: "Max Duration", value: `${(stats.maxDuration / 1000).toFixed(2)}s` },
              { label: "Min Duration", value: `${(stats.minDuration / 1000).toFixed(2)}s` },
              { label: "Short Subs (<5)", value: stats.shortSubs },
            ].map((item) => (
              <div key={item.label} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-3 shadow-sm">
                <div className="text-xl font-bold text-gray-800 dark:text-gray-100">{item.value}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{item.label}</div>
              </div>
            ))}
          </div>

          {stats.topChars.length > 0 && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-5 py-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Most Frequent Characters</h3>
              <div className="flex flex-wrap gap-2">
                {stats.topChars.map(([char, count]) => (
                  <div key={char} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-sm">
                    <span className="font-mono font-bold text-gray-700 dark:text-gray-200">{char}</span>
                    <span className="text-gray-400 dark:text-gray-500 text-xs">{count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
