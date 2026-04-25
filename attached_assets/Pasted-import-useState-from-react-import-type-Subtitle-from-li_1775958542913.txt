import { useState } from "react";
import { type Subtitle } from "@/lib/srt";
import SrtEditorTab from "@/tabs/SrtEditorTab";
import TextSplitterTab from "@/tabs/TextSplitterTab";
import SrtConverterTab from "@/tabs/SrtConverterTab";
import SrtEditTab from "@/tabs/SrtEditTab";
import CounterTab from "@/tabs/CounterTab";

type Tab = "editor" | "splitter" | "converter" | "edit" | "counter";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
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
    id: "splitter",
    label: "Text Splitter",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
    ),
  },
  {
    id: "converter",
    label: "SRT Converter",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    ),
  },
  {
    id: "edit",
    label: "SRT Edit",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </svg>
    ),
  },
  {
    id: "counter",
    label: "Counter",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
      </svg>
    ),
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("editor");
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [filename, setFilename] = useState("");

  const hasFile = subtitles.length > 0;

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4">
          <div className="flex items-center gap-3 py-3">
            <div className="flex items-center justify-center w-8 h-8 bg-blue-600 rounded-lg shrink-0">
              <svg className="w-4.5 h-4.5 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M14.5 2.5a2 2 0 00-2-2h-1a2 2 0 00-2 2v1h5v-1zm-5 3v1.5a.5.5 0 01-.5.5H7.5A2.5 2.5 0 005 10v9a2.5 2.5 0 002.5 2.5h9A2.5 2.5 0 0019 19v-9a2.5 2.5 0 00-2.5-2.5H15a.5.5 0 01-.5-.5V5.5h-5z" />
              </svg>
            </div>
            <span className="text-base font-bold text-gray-900">SRT Tools</span>
            {hasFile && (
              <span className="text-xs bg-blue-50 text-blue-600 border border-blue-200 px-2.5 py-0.5 rounded-full font-medium">
                {subtitles.length} subtitles loaded
              </span>
            )}
          </div>

          <nav className="flex gap-0 -mb-px">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                {tab.icon}
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.label.split(" ")[0]}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5">
        {activeTab === "editor" && (
          <SrtEditorTab
            subtitles={subtitles}
            filename={filename}
            setSubtitles={setSubtitles}
            setFilename={setFilename}
          />
        )}
        {activeTab === "splitter" && (
          <TextSplitterTab
            editorSubtitles={subtitles}
            editorFilename={filename}
          />
        )}
        {activeTab === "converter" && (
          <SrtConverterTab
            sharedSubtitles={subtitles}
            sharedFilename={filename}
          />
        )}
        {activeTab === "edit" && (
          <SrtEditTab
            subtitles={subtitles}
            filename={filename}
            setSubtitles={setSubtitles}
            setFilename={setFilename}
          />
        )}
        {activeTab === "counter" && (
          <CounterTab
            subtitles={subtitles}
            filename={filename}
            setSubtitles={setSubtitles}
            setFilename={setFilename}
          />
        )}
      </main>
    </div>
  );
}
