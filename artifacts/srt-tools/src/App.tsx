import { useCallback, useEffect, useMemo, useState } from "react";
import { type Subtitle, formatSrt } from "@/lib/srt";
import SrtEditorTab from "@/tabs/SrtEditorTab";
import SrtMakerTab from "@/tabs/SrtMakerTab";
import SrtNoteTab from "@/tabs/SrtNoteTab";
import SrtTimeSplitterTab from "@/tabs/SrtTimeSplitterTab";
import SrtMergerTab from "@/tabs/SrtMergerTab";
import VoiceTrimmerTab from "@/tabs/VoiceTrimmerTab";
import VideoSplitterTab from "@/tabs/VideoSplitterTab";
import CuttingPlusTab from "@/tabs/CuttingPlusTab";
import CuttingPlusPlusTab from "@/tabs/CuttingPlusPlusTab";
import SpeedPlusMinusTab from "@/tabs/SpeedPlusMinusTab";
import AiAudioTab from "@/tabs/AiAudioTab";

type Tab = "editor" | "maker" | "note" | "splitter" | "merger" | "aiAudio" | "audio" | "video" | "cuttingPlus" | "cutting" | "speed";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: "merger",
    label: "SRT Marger",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    id: "editor",
    label: "SRT Editor",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: "maker",
    label: "SRT Maker",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
      </svg>
    ),
  },
  {
    id: "note",
    label: "SRT Note",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
  },
  {
    id: "splitter",
    label: "SRT Time Spliter",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
      </svg>
    ),
  },
  {
    id: "aiAudio",
    label: "Ai Audio",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
  },
  {
    id: "audio",
    label: "Audio Spliter",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" />
      </svg>
    ),
  },
  {
    id: "video",
    label: "Video Spliter",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    id: "cuttingPlus",
    label: "Cutting +",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
      </svg>
    ),
  },
  {
    id: "cutting",
    label: "Cutting ++",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
      </svg>
    ),
  },
  {
    id: "speed",
    label: "Speed +-",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("merger");
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [filename, setFilename] = useState("");
  const [splitterIncomingKey, setSplitterIncomingKey] = useState(0);
  const [videoIncomingSrt, setVideoIncomingSrt] = useState("");
  const [videoIncomingSrtFilename, setVideoIncomingSrtFilename] = useState("");
  const [videoIncomingSrtKey, setVideoIncomingSrtKey] = useState(0);
  const [noteIncomingText, setNoteIncomingText] = useState("");
  const [noteIncomingName, setNoteIncomingName] = useState("");
  const [noteIncomingKey, setNoteIncomingKey] = useState(0);
  const [cuttingIncomingAudio, setCuttingIncomingAudio] = useState<{ files: File[]; key: number }>({ files: [], key: 0 });
  const [spliterIncomingAudio, setSpliterIncomingAudio] = useState<{ files: File[]; key: number }>({ files: [], key: 0 });
  const [cuttingPlusIncomingVideos, setCuttingPlusIncomingVideos] = useState<{ files: File[]; key: number; autoLoad?: boolean; extras?: number[] }>({ files: [], key: 0 });
  const [speedIncomingVideos, setSpeedIncomingVideos] = useState<{ files: File[]; key: number }>({ files: [], key: 0 });
  const [speedIncomingAudio, setSpeedIncomingAudio] = useState<{ files: File[]; key: number }>({ files: [], key: 0 });
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = localStorage.getItem("srt-tools-theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    localStorage.setItem("srt-tools-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  const handleVideoSplitterOutputs = useCallback((files: File[]) => {
    setCuttingPlusIncomingVideos((prev) => {
      const sameLength = prev.files.length === files.length;
      const sameNames =
        sameLength &&
        prev.files.every((f, i) => f.name === files[i]?.name && f.size === files[i]?.size);
      if (sameNames) return prev;
      return { files, key: Date.now() };
    });
  }, []);

  const hasFile = subtitles.length > 0;

  const incomingSrtForSplitter = useMemo(
    () => (subtitles.length > 0 ? formatSrt(subtitles) : ""),
    [subtitles]
  );

  useEffect(() => {
    if (subtitles.length > 0) {
      setSplitterIncomingKey((k) => k + 1);
    }
  }, [subtitles]);

  const handleSelectTab = (id: Tab) => {
    setActiveTab(id);
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const runTransformSequence = async () => {
    await sleep(1000);
    window.dispatchEvent(new CustomEvent("srt-tools:merger-generate"));
    await sleep(1000);
    handleSelectTab("editor");
    await sleep(200);
    window.dispatchEvent(new CustomEvent("srt-tools:editor-convert"));
    await sleep(800);
    handleSelectTab("splitter");
    await sleep(1000);
    window.dispatchEvent(new CustomEvent("srt-tools:splitter-split"));
    await sleep(500);
    window.dispatchEvent(new CustomEvent("srt-tools:splitter-dot"));
    await sleep(500);
    window.dispatchEvent(new CustomEvent("srt-tools:splitter-trim10"));
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900 overflow-hidden">
      <header className="bg-white dark:bg-gray-950 border-b border-gray-200 dark:border-gray-800 sticky top-0 z-20 shrink-0">
        <div className="px-4">
          <div className="max-w-5xl mx-auto flex items-center gap-3 py-3">
            <div className="flex items-center justify-center w-8 h-8 bg-blue-600 rounded-lg shrink-0">
              <svg className="w-4.5 h-4.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M14.5 2.5a2 2 0 00-2-2h-1a2 2 0 00-2 2v1h5v-1zm-5 3v1.5a.5.5 0 01-.5.5H7.5A2.5 2.5 0 005 10v9a2.5 2.5 0 002.5 2.5h9A2.5 2.5 0 0019 19v-9a2.5 2.5 0 00-2.5-2.5H15a.5.5 0 01-.5-.5V5.5h-5z" />
              </svg>
            </div>
            <span className="text-base font-bold text-gray-900 dark:text-gray-100">SRT Tools</span>
            <button
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to day mode" : "Switch to night mode"}
              title={theme === "dark" ? "Day mode" : "Night mode"}
              className="flex items-center justify-center w-8 h-8 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              {theme === "dark" ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            {hasFile && (
              <span className="text-xs bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-900 px-2.5 py-0.5 rounded-full font-medium">
                {subtitles.length} subtitles loaded
              </span>
            )}
          </div>

          <nav className="flex gap-0 -mb-px -mx-4 px-2 flex-wrap justify-center">
            {TABS.map((tab, idx) => (
              <button
                key={tab.id}
                onClick={() => handleSelectTab(tab.id)}
                style={[3, 5, 7].includes(idx) ? { marginLeft: "1.5rem" } : undefined}
                className={`flex items-center gap-1 px-2 py-2.5 text-[0.525rem] sm:text-[0.6125rem] font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
                    : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600"
                }`}
              >
                {tab.icon}
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.label.split(" ")[1] ?? tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* SRT Maker — always mounted, hidden when inactive */}
      <div style={{ display: activeTab === "maker" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <SrtMakerTab />
      </div>

      {/* SRT Note — always mounted, full width, hidden when inactive */}
      <div style={{ display: activeTab === "note" ? "flex" : "none" }} className="flex-col flex-1 overflow-hidden">
        <SrtNoteTab
          incomingText={noteIncomingText}
          incomingName={noteIncomingName}
          incomingKey={noteIncomingKey}
        />
      </div>

      {/* SRT Time Spliter — full width, hidden when inactive */}
      <div style={{ display: activeTab === "splitter" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <SrtTimeSplitterTab
          incomingSrt={incomingSrtForSplitter}
          incomingFilename={filename || "from-editor.srt"}
          incomingKey={splitterIncomingKey}
          onFinalOutput={(srt, name) => {
            setVideoIncomingSrt(srt);
            setVideoIncomingSrtFilename(name);
            setVideoIncomingSrtKey((k) => k + 1);
          }}
          onSendToNote={(text, sourceName) => {
            setNoteIncomingText(text);
            setNoteIncomingName(sourceName);
            setNoteIncomingKey((k) => k + 1);
            handleSelectTab("note");
          }}
        />
      </div>

      {/* SRT Marger — full width, hidden when inactive */}
      <div style={{ display: activeTab === "merger" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <SrtMergerTab
          setSubtitles={setSubtitles}
          setFilename={setFilename}
          onGenerated={() => {}}
          onTransform={runTransformSequence}
        />
      </div>

      {/* Ai Audio — full width, hidden when inactive */}
      <div style={{ display: activeTab === "aiAudio" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <AiAudioTab
          onSendToSpliter={(files) => {
            setSpliterIncomingAudio({ files, key: Date.now() });
            handleSelectTab("audio");
          }}
        />
      </div>

      {/* Audio Spliter — full width, hidden when inactive */}
      <div style={{ display: activeTab === "audio" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <VoiceTrimmerTab
          incomingAudioFiles={spliterIncomingAudio}
          onSendToCutting={(files) => {
            setCuttingIncomingAudio({ files, key: Date.now() });
            handleSelectTab("cutting");
          }}
          onSendToSpeed={(files) => {
            setSpeedIncomingAudio({ files, key: Date.now() });
            handleSelectTab("speed");
          }}
        />
      </div>

      {/* Video Spliter — full width, hidden when inactive */}
      <div style={{ display: activeTab === "video" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <VideoSplitterTab
          incomingSrt={videoIncomingSrt}
          incomingSrtFilename={videoIncomingSrtFilename}
          incomingSrtKey={videoIncomingSrtKey}
          onSendToCutting={(files, extras) => {
            setCuttingPlusIncomingVideos({ files, key: Date.now(), autoLoad: true, extras });
            handleSelectTab("cuttingPlus");
          }}
          onOutputsChange={handleVideoSplitterOutputs}
        />
      </div>

      {/* Cutting + — full width, hidden when inactive */}
      <div style={{ display: activeTab === "cuttingPlus" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <CuttingPlusTab
          incomingVideoFiles={cuttingPlusIncomingVideos}
          onSendToCuttingPlusPlus={(files) => {
            setCuttingIncomingAudio({ files, key: Date.now() });
            handleSelectTab("cutting");
          }}
          onSendToSpeedPlusMinus={(files) => {
            setSpeedIncomingVideos({ files, key: Date.now() });
            handleSelectTab("speed");
          }}
        />
      </div>

      {/* Cutting ++ — full width, hidden when inactive */}
      <div style={{ display: activeTab === "cutting" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <CuttingPlusPlusTab incomingAudioFiles={cuttingIncomingAudio} />
      </div>

      {/* Speed +- — full width, hidden when inactive */}
      <div style={{ display: activeTab === "speed" ? "flex" : "none" }} className="flex-col flex-1 overflow-y-auto">
        <SpeedPlusMinusTab incomingVideoFiles={speedIncomingVideos} incomingAudioFiles={speedIncomingAudio} />
      </div>

      {/* Other tabs */}
      <main
        style={{ display: activeTab === "maker" || activeTab === "note" || activeTab === "splitter" || activeTab === "merger" || activeTab === "aiAudio" || activeTab === "audio" || activeTab === "video" || activeTab === "cuttingPlus" || activeTab === "cutting" || activeTab === "speed" ? "none" : "block" }}
        className="max-w-5xl mx-auto px-4 py-5 flex-1 overflow-y-auto w-full"
      >
        {activeTab === "editor" && (
          <SrtEditorTab
            subtitles={subtitles}
            filename={filename}
            setSubtitles={setSubtitles}
            setFilename={setFilename}
            onNext={() => handleSelectTab("maker")}
          />
        )}
      </main>
    </div>
  );
}
