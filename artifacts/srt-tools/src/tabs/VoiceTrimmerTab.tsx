import { useEffect, useRef, useState } from "react";
import { useAudioAnalysis } from "@/hooks/useAudioAnalysis";
import UploadBox from "@/tabs/trimmer/UploadBox";
import AudioCard from "@/tabs/trimmer/AudioCard";
import DownloadPanel from "@/tabs/trimmer/DownloadPanel";
import { Scissors, Trash2, FolderInput, Download, Zap } from "lucide-react";
import JSZip from "jszip";

type SplitStage = "idle" | "preview" | "trimming" | "done";

interface VoiceTrimmerTabProps {
  onSendToCutting?: (files: File[]) => void;
  onSendToSpeed?: (files: File[]) => void;
  incomingAudioFiles?: { files: File[]; key: number };
}

export default function VoiceTrimmerTab({ onSendToCutting, onSendToSpeed, incomingAudioFiles }: VoiceTrimmerTabProps = {}) {
  const { audioFiles, addFiles, removeFile, trimAllFiles, resetTrim } = useAudioAnalysis();
  const [splitStage, setSplitStage] = useState<SplitStage>("idle");
  const [loaded, setLoaded] = useState(false);
  const [loadedSpeed, setLoadedSpeed] = useState(false);
  const lastIncomingKeyRef = useRef<number | null>(null);
  const audioFilesRef = useRef(audioFiles);
  audioFilesRef.current = audioFiles;

  useEffect(() => {
    if (!incomingAudioFiles || incomingAudioFiles.files.length === 0) return;
    if (lastIncomingKeyRef.current === incomingAudioFiles.key) return;
    lastIncomingKeyRef.current = incomingAudioFiles.key;
    resetTrim();
    setSplitStage("idle");
    setLoaded(false);
    setLoadedSpeed(false);
    audioFilesRef.current.forEach((f) => removeFile(f.id));
    addFiles(incomingAudioFiles.files);
  }, [incomingAudioFiles, addFiles, removeFile, resetTrim]);

  const readyCount = audioFiles.filter((f) => f.status === "ready" && !f.isTrimmed).length;
  const trimmedCount = audioFiles.filter((f) => f.isTrimmed).length;

  const handleSplitClick = async () => {
    if (splitStage === "idle") {
      setSplitStage("preview");
    } else if (splitStage === "preview") {
      setSplitStage("trimming");
      await trimAllFiles();
      setSplitStage("done");
    }
  };

  const handleClear = () => {
    resetTrim();
    setSplitStage("idle");
    setLoaded(false);
    audioFiles.forEach((f) => removeFile(f.id));
  };

  const handleDownloadZip = async () => {
    const trimmed = audioFiles.filter((f) => f.isTrimmed && f.trimmedBlob);
    if (trimmed.length === 0) return;
    const zip = new JSZip();
    for (const f of trimmed) {
      const baseName = f.name.replace(/\.[^.]+$/, "") + "_trimmed.wav";
      zip.file(baseName, f.trimmedBlob as Blob);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trimmed_audios_${trimmed.length}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const buildTrimmedFiles = (): File[] => {
    const trimmed = audioFiles.filter((f) => f.isTrimmed && f.trimmedBlob);
    return trimmed.map((f) => {
      const baseName = f.name.replace(/\.[^.]+$/, "") + "_trimmed.wav";
      return new File([f.trimmedBlob as Blob], baseName, { type: "audio/wav" });
    });
  };

  const handleLoadToCutting = () => {
    if (!onSendToCutting) return;
    const files = buildTrimmedFiles();
    if (files.length === 0) return;
    onSendToCutting(files);
    setLoaded(true);
  };

  const handleLoadToSpeed = () => {
    if (!onSendToSpeed) return;
    const files = buildTrimmedFiles();
    if (files.length === 0) return;
    onSendToSpeed(files);
    setLoadedSpeed(true);
  };

  const splitLabel =
    splitStage === "idle" ? "Split" :
    splitStage === "preview" ? "Confirm Cut" :
    splitStage === "trimming" ? "Processing…" : "Split";

  const splitDisabled = splitStage === "trimming" || readyCount === 0;

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-5 flex flex-col gap-3">
      <UploadBox onFiles={addFiles} />

      {/* Controls bar */}
      <div className="rounded-xl flex items-center justify-between px-5 py-3" style={{
        background: "white",
        border: "1px solid hsl(220,15%,90%)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
      }}>
        <div>
          {audioFiles.length === 0 ? (
            <p className="text-xs" style={{ color: "hsl(220,10%,62%)" }}>Upload files to enable controls</p>
          ) : splitStage === "done" ? (
            <p className="text-xs" style={{ color: "hsl(185,65%,34%)" }}>
              ✓ {trimmedCount} file{trimmedCount !== 1 ? "s" : ""} trimmed — download each below
            </p>
          ) : splitStage === "preview" ? (
            <p className="text-xs" style={{ color: "hsl(220,10%,45%)" }}>
              {readyCount} file{readyCount !== 1 ? "s" : ""} ready to cut — click Confirm Cut to proceed
            </p>
          ) : (
            <p className="text-xs" style={{ color: "hsl(220,10%,55%)" }}>
              {audioFiles.length} file{audioFiles.length !== 1 ? "s" : ""} loaded — {readyCount} ready to trim
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {splitStage === "done" && trimmedCount > 0 && (
            <button
              onClick={handleDownloadZip}
              title={`Download all ${trimmedCount} trimmed audios as ZIP`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-all"
              style={{
                background: "linear-gradient(90deg, hsl(265,85%,58%), hsl(295,85%,55%))",
                boxShadow: "0 1px 4px rgba(168,85,247,0.30)",
              }}
            >
              <Download className="w-3 h-3" />
              ZIP
            </button>
          )}
          {splitStage === "done" && trimmedCount > 0 && onSendToCutting && (
            <button
              onClick={handleLoadToCutting}
              title="Send all trimmed audios to Cutting++ Audio Pool"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{
                background: loaded ? "hsl(142,70%,40%)" : "hsl(220,90%,56%)",
                color: "white",
                boxShadow: loaded
                  ? "0 1px 4px rgba(34,197,94,0.30)"
                  : "0 1px 4px rgba(37,99,235,0.30)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = loaded
                  ? "hsl(142,70%,34%)"
                  : "hsl(220,90%,48%)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = loaded
                  ? "hsl(142,70%,40%)"
                  : "hsl(220,90%,56%)";
              }}
            >
              <FolderInput className="w-3 h-3" />
              {loaded ? "Loaded ✓" : "Cutting++"}
            </button>
          )}
          {splitStage === "done" && trimmedCount > 0 && onSendToSpeed && (
            <button
              onClick={handleLoadToSpeed}
              title="Send all trimmed audios to Speed +- Audio Pool"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{
                background: loadedSpeed ? "hsl(142,70%,40%)" : "hsl(38,92%,50%)",
                color: "white",
                boxShadow: loadedSpeed
                  ? "0 1px 4px rgba(34,197,94,0.30)"
                  : "0 1px 4px rgba(245,158,11,0.30)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = loadedSpeed
                  ? "hsl(142,70%,34%)"
                  : "hsl(38,92%,44%)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = loadedSpeed
                  ? "hsl(142,70%,40%)"
                  : "hsl(38,92%,50%)";
              }}
            >
              <Zap className="w-3 h-3" />
              {loadedSpeed ? "Loaded ✓" : "Speed +-"}
            </button>
          )}
          <button
            onClick={handleClear}
            disabled={audioFiles.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-35 disabled:cursor-not-allowed"
            style={{ background: "hsl(220,15%,94%)", color: "hsl(220,20%,40%)" }}
            onMouseEnter={(e) => {
              if (!e.currentTarget.disabled) {
                e.currentTarget.style.background = "rgba(239,68,68,0.10)";
                e.currentTarget.style.color = "#ef4444";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "hsl(220,15%,94%)";
              e.currentTarget.style.color = "hsl(220,20%,40%)";
            }}
          >
            <Trash2 className="w-3 h-3" /> Clear All
          </button>
          {splitStage !== "done" && (
            <button
              onClick={handleSplitClick}
              disabled={splitDisabled}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: splitStage === "preview" ? "hsl(185,65%,30%)" : "hsl(185,65%,36%)",
                color: "white",
                boxShadow: splitStage === "preview"
                  ? "0 0 0 2px hsl(185,65%,70%)"
                  : "0 1px 4px rgba(15,160,155,0.25)",
              }}
              onMouseEnter={(e) => {
                if (!e.currentTarget.disabled) e.currentTarget.style.background = "hsl(185,65%,28%)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = splitStage === "preview"
                  ? "hsl(185,65%,30%)"
                  : "hsl(185,65%,36%)";
              }}
            >
              <Scissors className="w-3 h-3" /> {splitLabel}
            </button>
          )}
        </div>
      </div>

      {/* Audio Cards */}
      {audioFiles.length > 0 && (
        <div className="flex flex-col gap-2">
          {audioFiles.map((audio) => (
            <AudioCard
              key={audio.id}
              audio={audio}
              onRemove={removeFile}
              splitStage={splitStage}
            />
          ))}
        </div>
      )}

      {/* Download Panel */}
      {splitStage === "done" && <DownloadPanel files={audioFiles} />}
    </div>
  );
}
