import { useRef, useState } from "react";
import { Upload, Music2 } from "lucide-react";

interface UploadBoxProps {
  onFiles: (files: File[]) => void;
}

const ACCEPTED_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i;

export default function UploadBox({ onFiles }: UploadBoxProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const valid = Array.from(fileList).filter(
      (f) => f.type.startsWith("audio/") || ACCEPTED_EXT.test(f.name)
    );
    if (valid.length > 0) onFiles(valid);
  };

  return (
    <div
      className="rounded-xl cursor-pointer select-none transition-all"
      style={{
        background: dragging ? "hsl(185,65%,36%,0.04)" : "white",
        border: dragging ? "1.5px dashed hsl(185,65%,50%)" : "1.5px dashed hsl(220,15%,82%)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        padding: "20px 24px",
      }}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <div className="flex items-center gap-4">
        <div
          className="p-3 rounded-xl shrink-0"
          style={{ background: dragging ? "hsl(185,65%,36%,0.12)" : "hsl(220,15%,96%)" }}
        >
          <Music2 className="w-5 h-5" style={{ color: dragging ? "hsl(185,65%,36%)" : "hsl(220,10%,55%)" }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "hsl(220,20%,20%)" }}>
            Drop audio files here or click to browse
          </p>
          <p className="text-xs mt-0.5" style={{ color: "hsl(220,10%,58%)" }}>
            MP3, WAV, M4A, AAC, FLAC, OGG supported
          </p>
        </div>
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium shrink-0"
          style={{
            background: dragging ? "hsl(185,65%,36%)" : "hsl(220,15%,94%)",
            color: dragging ? "white" : "hsl(220,20%,40%)",
          }}
        >
          <Upload className="w-3.5 h-3.5" />
          Upload Files
        </div>
      </div>
    </div>
  );
}
