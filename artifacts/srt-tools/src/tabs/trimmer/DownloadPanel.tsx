import { useState, useRef } from "react";
import { Download, Play, Square, RotateCcw } from "lucide-react";
import { AudioFile } from "@/hooks/useAudioAnalysis";
import { useDarkMode } from "@/hooks/useDarkMode";

interface DownloadPanelProps {
  files: AudioFile[];
}

function FolderCard({
  file,
  index,
  isDone,
  isActive,
  onDownload,
}: {
  file: AudioFile;
  index: number;
  isDone: boolean;
  isActive: boolean;
  onDownload: (f: AudioFile) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const num = String(index + 1).padStart(3, "0");
  const shortName = file.name.length > 12 ? file.name.slice(0, 10) + "…" : file.name;

  const G = {
    back: "#bbf7d0", front: "#dcfce7", border: "#22c55e",
    text: "#15803d", accent: "#16a34a", num: "#166534",
    glow: "rgba(34,197,94,0.40)", shadow: "rgba(34,197,94,0.25)",
  };
  const R = {
    back: "#fecaca", front: "#fee2e2", border: "#ef4444",
    text: "#991b1b", accent: "#dc2626", num: "#7f1d1d",
    glow: "rgba(239,68,68,0.35)", shadow: "rgba(239,68,68,0.20)",
  };
  const A = {
    back: "#bfdbfe", front: "#dbeafe", border: "#3b82f6",
    text: "#1e3a8a", accent: "#2563eb", num: "#1e40af",
    glow: "rgba(59,130,246,0.40)", shadow: "rgba(59,130,246,0.25)",
  };
  const c = isActive ? A : isDone ? R : G;

  return (
    <button
      onClick={() => onDownload(file)}
      title={`Download: ${file.name}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "transparent", border: "none", padding: 0,
        width: "100%", cursor: "pointer", perspective: "800px", display: "block",
      }}
    >
      <div
        style={{
          position: "relative", width: "100%",
          transition: "transform 0.28s cubic-bezier(0.34,1.56,0.64,1), filter 0.28s ease",
          transform: (hovered || isActive)
            ? "rotateX(8deg) rotateY(-7deg) translateY(-6px) scale(1.05)"
            : "rotateX(0deg) rotateY(0deg) translateY(0) scale(1)",
          transformStyle: "preserve-3d",
          filter: (hovered || isActive) ? `drop-shadow(0 10px 18px ${c.shadow})` : `drop-shadow(0 3px 8px ${c.shadow})`,
        }}
      >
        <svg viewBox="0 0 110 95" width="100%" style={{ display: "block" }} xmlns="http://www.w3.org/2000/svg">
          <path
            d="M6,26 Q6,20 12,20 L42,20 Q45,20 47,16 L51,10 Q53,6 57,6 L98,6 Q104,6 104,12 L104,84 Q104,90 98,90 L12,90 Q6,90 6,84 Z"
            fill={c.back} stroke={c.border} strokeWidth="2.5" strokeLinejoin="round"
          />
          <rect x="6" y="34" width="98" height="56" rx="9" ry="9"
            fill={c.front} stroke={c.border} strokeWidth="2" />
          <rect x="6" y="34" width="98" height="22" rx="9" ry="9" fill="rgba(255,255,255,0.30)" />
        </svg>
        <div style={{
          position: "absolute", top: "6%", right: "10%",
          fontSize: "clamp(6px, 0.8vw, 9px)", fontWeight: "800", fontFamily: "monospace",
          color: c.num, letterSpacing: "0.3px",
          textShadow: "0 1px 0 rgba(255,255,255,0.6)", pointerEvents: "none",
        }}>
          {num}
        </div>
        <div style={{
          position: "absolute", bottom: "5%", left: 0, right: 0,
          display: "flex", flexDirection: "column", alignItems: "center",
          gap: "2px", pointerEvents: "none", padding: "0 3px",
        }}>
          <span style={{
            fontSize: "clamp(6px, 0.75vw, 8px)", fontWeight: "600", color: c.text,
            textAlign: "center", lineHeight: 1.1, wordBreak: "break-all",
            maxWidth: "100%", overflow: "hidden",
          }}>
            {shortName}
          </span>
          <span style={{
            fontSize: "clamp(6px, 0.7vw, 8px)", fontWeight: "800", color: c.accent,
            display: "flex", alignItems: "center", gap: "2px",
          }}>
            <Download style={{ width: "8px", height: "8px" }} />
            {isDone ? "Done" : isActive ? "..." : "DL"}
          </span>
        </div>
      </div>
    </button>
  );
}

export default function DownloadPanel({ files }: DownloadPanelProps) {
  const isDark = useDarkMode();
  const trimmedFiles = files.filter((f) => f.isTrimmed && f.trimmedBlob);
  const [downloaded, setDownloaded] = useState<Record<string, boolean>>({});
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const stopRef = useRef(false);

  if (trimmedFiles.length === 0) return null;

  const downloadedCount = Object.values(downloaded).filter(Boolean).length;
  const notDownloadedCount = trimmedFiles.length - downloadedCount;
  const someDownloaded = downloadedCount > 0;

  const handleDownload = (file: AudioFile) => {
    if (!file.trimmedBlob) return;
    const url = URL.createObjectURL(file.trimmedBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name.replace(/\.[^.]+$/, "") + "_trimmed.wav";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded((prev) => ({ ...prev, [file.id]: true }));
  };

  const startAutoDownload = () => {
    if (isAutoRunning) {
      stopRef.current = true;
      setIsAutoRunning(false);
      setActiveIndex(null);
      return;
    }

    stopRef.current = false;
    setIsAutoRunning(true);

    const notDone = trimmedFiles.filter((f) => !downloaded[f.id]);
    let i = 0;

    const clickNext = () => {
      if (stopRef.current || i >= notDone.length) {
        setIsAutoRunning(false);
        setActiveIndex(null);
        return;
      }
      const file = notDone[i];
      const globalIndex = trimmedFiles.indexOf(file);
      setActiveIndex(globalIndex);
      handleDownload(file);
      i++;
      setTimeout(clickNext, 1000);
    };

    clickNext();
  };

  const resetAll = () => {
    stopRef.current = true;
    setIsAutoRunning(false);
    setActiveIndex(null);
    setDownloaded({});
  };

  return (
    <div className="rounded-xl overflow-hidden transition-all duration-300" style={{
      background: isDark ? "hsl(220,18%,14%)" : "white",
      border: someDownloaded ? "2px solid hsl(0,72%,60%)" : "2px solid hsl(142,70%,50%)",
      boxShadow: someDownloaded
        ? `0 2px 20px ${isDark ? "rgba(239,68,68,0.25)" : "rgba(239,68,68,0.12)"}`
        : `0 2px 20px ${isDark ? "rgba(34,197,94,0.22)" : "rgba(34,197,94,0.12)"}`,
    }}>
      <div className="flex items-center justify-between px-5 py-2.5"
        style={{ background: isDark ? "hsl(220,18%,12%)" : "hsl(220,15%,97%)", borderBottom: `1px solid ${isDark ? "hsl(220,15%,20%)" : "hsl(220,15%,90%)"}` }}>

        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold" style={{ color: isDark ? "hsl(220,10%,70%)" : "hsl(220,15%,40%)" }}>
            total : {trimmedFiles.length}
          </span>
          <button
            onClick={startAutoDownload}
            title={isAutoRunning ? "Stop Auto Download" : "Auto Download All"}
            style={{
              display: "flex", alignItems: "center", gap: "4px",
              padding: "3px 8px", borderRadius: "6px", border: "none", cursor: "pointer",
              fontSize: "10px", fontWeight: "700",
              background: isAutoRunning ? "hsl(0,72%,51%)" : "hsl(142,70%,40%)",
              color: "white",
              boxShadow: isAutoRunning
                ? "0 2px 8px rgba(239,68,68,0.35)"
                : "0 2px 8px rgba(34,197,94,0.35)",
              transition: "all 0.2s ease",
            }}
          >
            {isAutoRunning
              ? <><Square style={{ width: "9px", height: "9px" }} /> Stop</>
              : <><Play style={{ width: "9px", height: "9px" }} /> Auto DL</>
            }
          </button>
          <button
            onClick={resetAll}
            title="Reset — all folders back to green"
            style={{
              display: "flex", alignItems: "center", gap: "4px",
              padding: "3px 8px", borderRadius: "6px", border: "none", cursor: "pointer",
              fontSize: "10px", fontWeight: "700",
              background: "hsl(220,15%,55%)",
              color: "white",
              boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
              transition: "all 0.2s ease",
            }}
          >
            <RotateCcw style={{ width: "9px", height: "9px" }} /> Reset
          </button>
        </div>

        <span className="text-sm font-bold tracking-wide" style={{ color: isDark ? "hsl(220,10%,90%)" : "hsl(220,20%,22%)" }}>
          Trimmed Files
        </span>

        {someDownloaded ? (
          <div className="text-right text-[11px] font-medium leading-tight" style={{ color: isDark ? "hsl(220,10%,65%)" : "hsl(220,15%,45%)" }}>
            <div>Downloaded &nbsp;<span style={{ color: "hsl(0,72%,51%)" }}>: {downloadedCount}</span></div>
            <div>Not Downloaded &nbsp;<span style={{ color: "hsl(142,70%,40%)" }}>: {notDownloadedCount}</span></div>
          </div>
        ) : <div className="w-28" />}
      </div>

      <div className="p-3" style={{ background: isDark ? "hsl(220,18%,11%)" : "hsl(220,20%,98%)" }}>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(10, minmax(0, 1fr))" }}>
          {trimmedFiles.map((file, index) => (
            <FolderCard
              key={file.id} file={file} index={index}
              isDone={!!downloaded[file.id]}
              isActive={activeIndex === index}
              onDownload={handleDownload}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
