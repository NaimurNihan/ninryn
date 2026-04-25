import { useState, useRef, useCallback, useEffect } from "react";
import { Plus, Search, FileText, RotateCcw, X, ScanSearch, Download, Trash2, Sun, Moon, Scissors, Copy, Folder, FolderOpen, ArchiveRestore, ChevronDown, ChevronRight } from "lucide-react";
interface TaskRow { checked: boolean; values: string[]; }
interface Project {
  id: string;
  name: string;
  updatedAt: string;
  langs: { label: string; content: string }[];
  trashed?: boolean;
  tasks?: TaskRow[];
}
interface SavedState {
  projects: Project[];
  activeId: string;
  darkMode: boolean;
  copiedChunks: { [key: string]: boolean };
}
const DEFAULT_LANGS = [
  { label: "Original", content: "" },
  { label: "Arabic", content: "" },
  { label: "German", content: "" },
  { label: "English", content: "" },
  { label: "Spanish", content: "" },
];
const SAMPLE_PROJECTS: Project[] = [
  {
    id: "1",
    name: "Harry Potter and the Philosopher's Stone",
    updatedAt: "Today",
    langs: [
      { label: "Original", content: "It is shown at the beginning of the film, the Principal and a female professor of the school of witchcraft, They place a child before the gate of the house of his uncle.\nThat child name is \"Harry Potter\".\nMany years later, \"Harry\" has grown up 10 years old.\nHis uncle family's attitude with him was rough.\nHe used to beat him and lock in his room downstairs." },
      { label: "Arabic", content: "\u064A\u064F\u0638\u0647\u0631 \u0628\u062F\u0627\u064A\u0629 \u0627\u0644\u0641\u064A\u0644\u0645 \u0627\u0644\u0645\u062F\u064A\u0631 \u0648\u0623\u0633\u062A\u0627\u0630\u0629 \u0645\u0646 \u0645\u062F\u0631\u0633\u0629 \u0627\u0644\u0633\u062D\u0631\u060C \u064A\u0636\u0639\u0627\u0646 \u0637\u0641\u0644\u0627\u064B \u0623\u0645\u0627\u0645 \u0628\u0648\u0627\u0628\u0629 \u0645\u0646\u0632\u0644 \u0639\u0645\u0647.\n\u0627\u0633\u0645 \u0647\u0630\u0627 \u0627\u0644\u0637\u0641\u0644 \"\u0647\u0627\u0631\u064A \u0628\u0648\u062A\u0631\".\n\u0628\u0639\u062F \u0633\u0646\u0648\u0627\u062A \u0639\u062F\u064A\u062F\u0629\u060C \u0643\u0628\u0631 \"\u0647\u0627\u0631\u064A\" \u0648\u0623\u0635\u0628\u062D \u0641\u064A \u0627\u0644\u0639\u0627\u0634\u0631\u0629 \u0645\u0646 \u0639\u0645\u0631\u0647.\n\u0643\u0627\u0646\u062A \u0639\u0627\u0626\u0644\u0629 \u0639\u0645\u0647 \u062A\u0639\u0627\u0645\u0644\u0647 \u0628\u0642\u0633\u0648\u0629.\n\u0643\u0627\u0646 \u064A\u0636\u0631\u0628\u0647 \u0648\u064A\u062D\u0628\u0633\u0647 \u0641\u064A \u063A\u0631\u0641\u062A\u0647 \u0641\u064A \u0627\u0644\u0637\u0627\u0628\u0642 \u0627\u0644\u0633\u0641\u0644\u064A." },
      { label: "German", content: "Am Anfang des Films sieht man den Direktor und eine Professorin der Hexenschule, die ein Kind vor das Tor des Hauses seines Onkels bringen.\nDer Name des Kindes ist Harry Potter.\nViele Jahre sp\u00E4ter ist Harry zehn Jahre alt.\nDie Familie seines Onkels behandelt ihn schlecht.\nEr schlug ihn und sperrte ihn in sein Zimmer im Erdgeschoss." },
      { label: "English", content: "" },
      { label: "Spanish", content: "" },
    ],
  },
  { id: "2", name: "The Dark Knight", updatedAt: "Yesterday", langs: DEFAULT_LANGS.map((l) => ({ ...l })) },
  { id: "3", name: "Inception", updatedAt: "3 days ago", langs: DEFAULT_LANGS.map((l) => ({ ...l })) },
];
const STORAGE_KEY = "srt-note-autosave-v1";
function getDefaultState(): SavedState {
  return { projects: SAMPLE_PROJECTS, activeId: "1", darkMode: false, copiedChunks: {} };
}
function readSavedState(): SavedState {
  if (typeof window === "undefined") return getDefaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultState();
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) return getDefaultState();
    const activeId = parsed.projects.some((project) => project.id === parsed.activeId)
      ? parsed.activeId ?? parsed.projects[0].id
      : parsed.projects[0].id;
    const migratedProjects = parsed.projects.map((p) => {
      const existing = Array.isArray(p.langs) ? p.langs : [];
      const padded = DEFAULT_LANGS.map((def, i) => existing[i] ? { label: existing[i].label || def.label, content: existing[i].content ?? "" } : { ...def });
      return { ...p, langs: padded };
    });
    return {
      projects: migratedProjects,
      activeId,
      darkMode: Boolean(parsed.darkMode),
      copiedChunks: (parsed.copiedChunks && typeof parsed.copiedChunks === "object") ? parsed.copiedChunks : {},
    };
  } catch {
    return getDefaultState();
  }
}
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function buildHtml(lines: string[]) {
  if (lines.length === 0) return "<div><br></div>";
  return lines.map((l) => `<div>${l ? escapeHtml(l) : "<br>"}</div>`).join("");
}
function extractLines(el: HTMLDivElement): string {
  const children = Array.from(el.children) as HTMLElement[];
  if (children.length === 0) return "";
  return children.map((c) => c.innerText.replace(/\n$/, "")).join("\n");
}
function normalizePastedLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
interface LineEditorProps {
  editorKey: string; value: string;
  onChange: (v: string) => void;
  placeholder: string;
  divRef: (el: HTMLDivElement | null) => void;
}
function LineEditor({ editorKey, value, onChange, placeholder, divRef }: LineEditorProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const internalChange = useRef(false);
  useEffect(() => {
    if (internalChange.current) { internalChange.current = false; return; }
    const el = innerRef.current;
    if (!el) return;
    const newHtml = buildHtml(value.split("\n"));
    if (el.innerHTML !== newHtml) el.innerHTML = newHtml;
  }, [value, editorKey]);
  const handleInput = () => { if (!innerRef.current) return; internalChange.current = true; onChange(extractLines(innerRef.current)); };
  const handleKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); document.execCommand("insertHTML", false, "<div><br></div>"); } };
  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData("text/plain");
    if (!innerRef.current || !pastedText) return;
    const pastedLines = normalizePastedLines(pastedText);
    if (pastedLines.length === 0) return;
    if (pastedLines.length === 1) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(pastedLines[0]);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        internalChange.current = true;
        onChange(extractLines(innerRef.current));
        return;
      }
    }
    const sel = window.getSelection();
    let insertAfterIdx = -1;
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      let node: Node = range.startContainer;
      while (node.parentNode && node.parentNode !== innerRef.current) node = node.parentNode;
      if (node.parentNode === innerRef.current) insertAfterIdx = Array.from(innerRef.current.children).indexOf(node as Element);
    }
    const existingLines = Array.from(innerRef.current.children as HTMLCollectionOf<HTMLElement>).map((c) => c.innerText.replace(/\n$/, ""));
    let newLines: string[];
    if (existingLines.length === 0 || (existingLines.length === 1 && existingLines[0] === "")) { newLines = pastedLines; }
    else if (insertAfterIdx === -1) { newLines = [...existingLines, ...pastedLines]; }
    else { newLines = [...existingLines.slice(0, insertAfterIdx + 1), ...pastedLines, ...existingLines.slice(insertAfterIdx + 1)]; }
    innerRef.current.innerHTML = buildHtml(newLines);
    const targetIdx = insertAfterIdx === -1 ? newLines.length - 1 : insertAfterIdx + pastedLines.length;
    const targetEl = innerRef.current.children[Math.min(targetIdx, newLines.length - 1)] as HTMLElement | undefined;
    if (targetEl) {
      const newSel = window.getSelection(); const newRange = document.createRange();
      newRange.selectNodeContents(targetEl); newRange.collapse(false);
      newSel?.removeAllRanges(); newSel?.addRange(newRange);
    }
    internalChange.current = true;
    onChange(extractLines(innerRef.current));
  };
  return (
    <div
      ref={(el) => { innerRef.current = el; divRef(el); if (el && el.innerHTML === "") el.innerHTML = buildHtml(value.split("\n")); }}
      key={editorKey} contentEditable suppressContentEditableWarning
      data-line-editor data-placeholder={placeholder}
      onInput={handleInput} onKeyDown={handleKeyDown} onPaste={handlePaste}
      className="flex-1 min-h-0 overflow-y-auto outline-none px-5 pt-4 pb-14 text-sm text-foreground"
      style={{ minHeight: 0, scrollPaddingBottom: "3.5rem" }}
    />
  );
}
interface SrtNoteTabProps {
  incomingText?: string;
  incomingName?: string;
  incomingKey?: number;
}
export default function SrtNoteTab({ incomingText, incomingName, incomingKey }: SrtNoteTabProps = {}) {
  const initialStateRef = useRef<SavedState | null>(null);
  if (initialStateRef.current === null) initialStateRef.current = readSavedState();
  const initialState = initialStateRef.current;
  const [projects, setProjects] = useState<Project[]>(initialState.projects);
  const [activeId, setActiveId] = useState(initialState.activeId);
  const [search, setSearch] = useState("");
  const [findText, setFindText] = useState<{ [k: string]: string }>({});
  const [showFind, setShowFind] = useState<{ [k: string]: boolean }>({});
  const [splitView, setSplitView] = useState<{ [k: string]: boolean }>({});
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [darkMode, setDarkMode] = useState(initialState.darkMode);
  const [copiedChunks, setCopiedChunks] = useState<{ [key: string]: boolean }>(initialState.copiedChunks);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashDragOver, setTrashDragOver] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const editorRefs = useRef<(HTMLDivElement | null)[]>([]);
  const historyRef = useRef<{ [k: number]: string[] }>({});
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { document.documentElement.classList.toggle("dark", darkMode); }, [darkMode]);
  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects, activeId, darkMode, copiedChunks }));
  }, [projects, activeId, darkMode, copiedChunks]);
  useEffect(() => {
    const visible = projects.filter((p) => !p.trashed);
    if (visible.length > 0 && !projects.some((project) => project.id === activeId)) setActiveId(visible[0].id);
  }, [projects, activeId]);
  const activeProject = projects.find((p) => p.id === activeId) ?? projects.find((p) => !p.trashed) ?? projects[0];
  const filtered = projects.filter((p) => !p.trashed && p.name.toLowerCase().includes(search.toLowerCase()));
  const trashedProjects = projects.filter((p) => p.trashed);
  useEffect(() => { setEditingName(false); }, [activeId]);
  function createProject() {
    const newId = Date.now().toString();
    setProjects((prev) => [{ id: newId, name: `New Project ${prev.length + 1}`, updatedAt: "Just now", langs: DEFAULT_LANGS.map((l) => ({ ...l })) }, ...prev]);
    setActiveId(newId);
  }
  const lastIncomingKeyRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (incomingKey === undefined) return;
    if (incomingKey === lastIncomingKeyRef.current) return;
    if (!incomingText || !incomingText.trim()) return;
    lastIncomingKeyRef.current = incomingKey;
    const newId = Date.now().toString();
    setProjects((prev) => {
      const baseName = (incomingName && incomingName.trim()) || `New Project ${prev.length + 1}`;
      const langs = DEFAULT_LANGS.map((l) => ({ ...l }));
      langs[0] = { ...langs[0], content: incomingText };
      return [{ id: newId, name: baseName, updatedAt: "Just now", langs }, ...prev];
    });
    setActiveId(newId);
  }, [incomingKey, incomingText, incomingName]);
  function updateContent(langIdx: number, value: string) {
    setProjects((prev) => prev.map((p) => {
      if (p.id !== activeId) return p;
      const langs = [...p.langs];
      const old = langs[langIdx].content;
      historyRef.current[langIdx] = historyRef.current[langIdx] ?? [];
      historyRef.current[langIdx].push(old);
      langs[langIdx] = { ...langs[langIdx], content: value };
      return { ...p, langs, updatedAt: "Just now" };
    }));
  }
  const handleUndo = useCallback((idx: number) => {
    const hist = historyRef.current[idx];
    if (!hist || hist.length === 0) return;
    const prev = hist.pop()!;
    setProjects((p) => p.map((proj) => { if (proj.id !== activeId) return proj; const langs = [...proj.langs]; langs[idx] = { ...langs[idx], content: prev }; return { ...proj, langs }; }));
  }, [activeId]);
  const handleCopy = useCallback((idx: number) => { navigator.clipboard.writeText(activeProject?.langs[idx]?.content ?? "").catch(() => {}); }, [activeProject]);
  const handleClear = useCallback((idx: number) => { updateContent(idx, ""); }, [activeId]);
  const handleEdit = useCallback((idx: number) => { editorRefs.current[idx]?.focus(); }, []);
  const handleFind = useCallback((idx: number) => { const k = `${activeId}:${idx}`; setShowFind((prev) => ({ ...prev, [k]: !prev[k] })); }, [activeId]);
  const handleSplit = useCallback((idx: number) => { const k = `${activeId}:${idx}`; setSplitView((prev) => ({ ...prev, [k]: !prev[k] })); }, [activeId]);
  const handleExport = useCallback(() => {
    if (!activeProject) return;
    const content = activeProject.langs.map((l) => `=== ${l.label} ===\n${l.content}`).join("\n\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${activeProject.name}.txt`; a.click();
    URL.revokeObjectURL(url);
  }, [activeProject]);
  const handleDelete = useCallback(() => {
    setProjects((prev) => {
      const updated = prev.map((p) => p.id === activeId ? { ...p, trashed: true } : p);
      const next = updated.find((p) => !p.trashed);
      setActiveId(next?.id ?? "");
      return updated;
    });
  }, [activeId]);
  const moveToTrash = useCallback((id: string) => {
    setProjects((prev) => {
      const updated = prev.map((p) => p.id === id ? { ...p, trashed: true } : p);
      if (id === activeId) {
        const next = updated.find((p) => !p.trashed);
        setActiveId(next?.id ?? "");
      }
      return updated;
    });
  }, [activeId]);
  const restoreFromTrash = useCallback((id: string) => {
    setProjects((prev) => prev.map((p) => p.id === id ? { ...p, trashed: false } : p));
  }, []);
  const deleteForever = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const numLangs = activeProject?.langs.length ?? 3;
  const activeTasks: TaskRow[] = activeProject?.tasks ?? [];
  const updateTasks = useCallback((updater: (prev: TaskRow[]) => TaskRow[]) => {
    setProjects((prev) => prev.map((p) => p.id === activeId ? { ...p, tasks: updater(p.tasks ?? []), updatedAt: "Just now" } : p));
  }, [activeId]);
  const addTaskRow = useCallback(() => {
    updateTasks((prev) => [...prev, { checked: false, values: Array(numLangs).fill("") }]);
  }, [updateTasks, numLangs]);
  const toggleTask = useCallback((idx: number) => {
    updateTasks((prev) => prev.map((t, i) => i === idx ? { ...t, checked: !t.checked } : t));
  }, [updateTasks]);
  const updateTaskValue = useCallback((idx: number, col: number, value: string) => {
    updateTasks((prev) => prev.map((t, i) => {
      if (i !== idx) return t;
      const values = [...t.values];
      while (values.length < numLangs) values.push("");
      values[col] = value;
      return { ...t, values };
    }));
  }, [updateTasks, numLangs]);
  const removeTaskRow = useCallback((idx: number) => {
    updateTasks((prev) => prev.filter((_, i) => i !== idx));
  }, [updateTasks]);
  const startEditingName = useCallback(() => { setNameInput(activeProject?.name ?? ""); setEditingName(true); setTimeout(() => nameInputRef.current?.select(), 0); }, [activeProject]);
  const saveName = useCallback(() => {
    const trimmed = nameInput.trim();
    if (trimmed) setProjects((prev) => prev.map((p) => p.id === activeId ? { ...p, name: trimmed, updatedAt: "Just now" } : p));
    setEditingName(false);
  }, [nameInput, activeId]);
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <aside className="w-64 shrink-0 flex flex-col h-full bg-[hsl(var(--sidebar))] border-r border-[hsl(var(--sidebar-border))]">
        <div className="px-4 pt-5 pb-3 border-b border-[hsl(var(--sidebar-border))]">
          <div className="flex items-center justify-between mb-4">
            <button onClick={() => setTaskOpen(true)} title="Open Task Note"
              className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[hsl(var(--sidebar-accent))] transition-colors">
              <span className="text-lg leading-none">📑</span>
              <span className="font-semibold text-sm text-[hsl(var(--sidebar-foreground))] tracking-wide">Task</span>
            </button>
            <button onClick={() => setDarkMode((d) => !d)} title={darkMode ? "Switch to Light mode" : "Switch to Night mode"}
              className="p-1.5 rounded-md bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-foreground))] hover:opacity-80 transition-opacity">
              {darkMode ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
          <button onClick={createProject} className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-[hsl(var(--sidebar-primary))] text-[hsl(var(--sidebar-primary-foreground))] text-sm font-medium hover:opacity-90 transition-opacity">
            <Plus size={14} />New Project
          </button>
        </div>
        <div className="px-3 py-3 border-b border-[hsl(var(--sidebar-border))]">
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[hsl(var(--sidebar-accent))]">
            <Search size={13} className="text-[hsl(var(--sidebar-foreground))] opacity-50 shrink-0" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects..."
              className="bg-transparent text-sm text-[hsl(var(--sidebar-foreground))] placeholder:opacity-40 w-full outline-none" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-3 px-3 flex flex-col gap-2">
          {filtered.length === 0 && <p className="text-xs text-[hsl(var(--sidebar-foreground))] opacity-40 text-center mt-6">No projects found</p>}
          {filtered.map((project) => (
            <button key={project.id} onClick={() => setActiveId(project.id)}
              draggable
              onDragStart={(e) => { setDraggingId(project.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", project.id); }}
              onDragEnd={() => { setDraggingId(null); setTrashDragOver(false); }}
              className={`w-full text-left rounded-lg border transition-all p-3 cursor-grab active:cursor-grabbing ${draggingId === project.id ? "opacity-40" : ""} ${activeId === project.id ? "bg-[hsl(var(--sidebar-accent))] border-[hsl(var(--sidebar-primary)/0.5)] text-[hsl(var(--sidebar-accent-foreground))]" : "bg-[hsl(var(--sidebar-accent)/0.4)] border-[hsl(var(--sidebar-border))] text-[hsl(var(--sidebar-foreground))] hover:bg-[hsl(var(--sidebar-accent)/0.7)]"}`}>
              <div className="flex items-start gap-2">
                <FileText size={13} className="shrink-0 mt-0.5 opacity-60" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold leading-snug break-words whitespace-normal">{project.name}</p>
                  <p className="text-[10px] opacity-40 mt-1">{project.updatedAt}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="shrink-0 border-t border-[hsl(var(--sidebar-border))] p-3">
          <div
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setTrashDragOver(true); }}
            onDragEnter={(e) => { e.preventDefault(); setTrashDragOver(true); }}
            onDragLeave={() => setTrashDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain") || draggingId;
              if (id) { moveToTrash(id); setTrashOpen(true); }
              setTrashDragOver(false); setDraggingId(null);
            }}
            className={`rounded-lg border-2 border-dashed transition-colors ${trashDragOver ? "border-destructive bg-destructive/10" : "border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-accent)/0.3)]"}`}>
            <button onClick={() => setTrashOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-[hsl(var(--sidebar-foreground))]">
              {trashOpen ? <ChevronDown size={12} className="opacity-60" /> : <ChevronRight size={12} className="opacity-60" />}
              {trashOpen ? <FolderOpen size={14} className={trashDragOver ? "text-destructive" : "opacity-70"} /> : <Folder size={14} className={trashDragOver ? "text-destructive" : "opacity-70"} />}
              <span className="text-xs font-semibold tracking-wide flex-1 text-left">Trash</span>
              <span className="text-[10px] opacity-50 bg-[hsl(var(--sidebar-accent))] px-1.5 py-0.5 rounded-full">{trashedProjects.length}</span>
            </button>
            {trashOpen && (
              <div className="px-2 pb-2 flex flex-col gap-1 max-h-48 overflow-y-auto">
                {trashedProjects.length === 0 ? (
                  <p className="text-[10px] text-center opacity-40 py-2 text-[hsl(var(--sidebar-foreground))]">
                    {trashDragOver ? "Drop here to move to trash" : "Drag projects here"}
                  </p>
                ) : (
                  trashedProjects.map((project) => (
                    <div key={project.id} className="group flex items-center gap-1 px-2 py-1.5 rounded-md bg-[hsl(var(--sidebar-accent)/0.5)] text-[hsl(var(--sidebar-foreground))]">
                      <FileText size={11} className="shrink-0 opacity-50" />
                      <span className="text-[11px] flex-1 truncate opacity-70" title={project.name}>{project.name}</span>
                      <button onClick={() => restoreFromTrash(project.id)} title="Restore"
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[hsl(var(--sidebar-accent))] text-muted-foreground hover:text-foreground transition-opacity">
                        <ArchiveRestore size={11} />
                      </button>
                      <button onClick={() => deleteForever(project.id)} title="Delete forever"
                        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-opacity">
                        <X size={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="shrink-0 px-6 py-4 border-b border-border bg-card flex items-center justify-between">
          <div>
            {editingName ? (
              <input ref={nameInputRef} value={nameInput} onChange={(e) => setNameInput(e.target.value)}
                onBlur={saveName} onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") setEditingName(false); }}
                className="text-base font-semibold text-foreground bg-muted border border-primary rounded px-2 py-0.5 outline-none w-72" autoFocus />
            ) : (
              <h1 className="text-base font-semibold text-foreground cursor-pointer hover:text-primary transition-colors" onClick={startEditingName} title="Click to rename">
                {activeProject?.name}
              </h1>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">Updated {activeProject?.updatedAt} · Auto-saved locally</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleExport} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:bg-muted transition-colors">
              <Download size={12} />Export
            </button>
            <button onClick={handleDelete} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-destructive text-xs text-destructive hover:bg-destructive/10 transition-colors">
              <Trash2 size={12} />Delete
            </button>
          </div>
        </header>
        {(() => {
          const langs = activeProject?.langs ?? [];
          const allSplit = langs.length > 0 && langs.every((_, i) => splitView[`${activeId}:${i}`]);
          const chunkSizeFor = (langIdx: number) => (langs[langIdx]?.label === "Original" ? 40 : 20);
          const renderChunkCard = (chunk: string[], chunkIdx: number, langIdx: number) => {
            const startLine = chunkIdx * chunkSizeFor(langIdx) + 1;
            const endLine = chunk.length > 0 ? startLine + chunk.length - 1 : startLine;
            const copyKey = `${activeId}:${langIdx}:${chunkIdx}`;
            const isCopied = !!copiedChunks[copyKey];
            const handleChunkCopy = () => {
              if (isCopied) {
                setCopiedChunks((prev) => { const n = { ...prev }; delete n[copyKey]; return n; });
                return;
              }
              const text = chunk.join("\n");
              navigator.clipboard.writeText(text).catch(() => {});
              setCopiedChunks((prev) => ({ ...prev, [copyKey]: true }));
            };
            return (
              <div className={`flex flex-col rounded-lg border-2 shadow-sm overflow-hidden transition-colors ${isCopied ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 shadow-emerald-200 dark:shadow-emerald-900/40" : "border-border bg-background"}`} style={{ height: "140px" }}>
                <div className={`shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-b ${isCopied ? "border-emerald-500/40 bg-emerald-100/60 dark:bg-emerald-900/30" : "border-border bg-muted/60"}`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${isCopied ? "text-emerald-700 dark:text-emerald-300" : "text-primary"}`}>
                      {chunk.length === 0 ? `${startLine}` : `${startLine}–${endLine}`}
                    </span>
                    <span className={`text-[10px] ${isCopied ? "text-emerald-700/80 dark:text-emerald-300/80" : "text-muted-foreground"}`}>{chunk.length} lines</span>
                    {isCopied && <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">✓ Copied</span>}
                  </div>
                  <button onClick={handleChunkCopy} title={isCopied ? "Copy again" : "Copy this section"}
                    className={`p-1 rounded transition-colors ${isCopied ? "text-emerald-700 hover:bg-emerald-200 dark:text-emerald-300 dark:hover:bg-emerald-900/50" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}>
                    <Copy size={12} />
                  </button>
                </div>
                <div data-line-editor className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-sm text-foreground" style={{ counterReset: `line-num ${startLine - 1}` }}>
                  {chunk.length === 0 ? (
                    <div className="opacity-25">—</div>
                  ) : (
                    chunk.map((line, lineIdx) => (
                      <div key={lineIdx}>{line || <span className="opacity-25">—</span>}</div>
                    ))
                  )}
                </div>
              </div>
            );
          };
          const renderLangHeader = (lang: { label: string; content: string }, idx: number) => {
            const lineCount = lang.content === "" ? 0 : lang.content.split("\n").length;
            const ptuCount = (lang.content.match(/[.?।]/g) || []).length;
            return (
              <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-card rounded-t-xl">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wider">{lang.label}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">{lineCount} {lineCount === 1 ? "line" : "lines"}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ptuCount !== lineCount ? "text-red-500 bg-red-100 dark:bg-red-950" : "text-muted-foreground bg-muted"}`}>{ptuCount} ptu</span>
                </div>
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => handleCopy(idx)} title="Copy all text"
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                    <Copy size={14} />
                  </button>
                  <button onClick={() => handleSplit(idx)} title="Split into sub-cards (every 20 lines)"
                    className={`p-1.5 rounded-md hover:bg-muted transition-colors ${splitView[`${activeId}:${idx}`] ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground"}`}>
                    <Scissors size={14} />
                  </button>
                  <button onClick={() => handleUndo(idx)} title="Undo" className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                    <RotateCcw size={14} />
                  </button>
                  <button onClick={() => handleClear(idx)} title="Clear" className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-destructive transition-colors">
                    <X size={14} />
                  </button>
                </div>
              </div>
            );
          };

          if (allSplit) {
            const langChunks = langs.map((lang, langIdx) => {
              const lines = lang.content === "" ? [] : lang.content.split("\n");
              const size = chunkSizeFor(langIdx);
              const chunks: string[][] = [];
              for (let i = 0; i < lines.length; i += size) chunks.push(lines.slice(i, i + size));
              if (chunks.length === 0) chunks.push([]);
              return chunks;
            });
            const maxChunks = Math.max(...langChunks.map((c) => c.length));
            return (
              <div className="flex-1 min-h-0 flex flex-col overflow-x-auto overflow-y-hidden p-4 gap-3">
                <div className="grid gap-4 shrink-0" style={{ gridTemplateColumns: `repeat(${langs.length}, minmax(280px, 1fr))` }}>
                  {langs.map((lang, idx) => (
                    <div key={idx} className="rounded-xl border border-border overflow-hidden">
                      {renderLangHeader(lang, idx)}
                      {showFind[`${activeId}:${idx}`] && (
                        <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/50">
                          <ScanSearch size={13} className="text-muted-foreground shrink-0" />
                          <input autoFocus type="text" value={findText[`${activeId}:${idx}`] ?? ""} onChange={(e) => setFindText((prev) => ({ ...prev, [`${activeId}:${idx}`]: e.target.value }))}
                            placeholder="Find in text..." className="flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground" />
                          <button onClick={() => setShowFind((prev) => ({ ...prev, [`${activeId}:${idx}`]: false }))} className="text-muted-foreground hover:text-foreground"><X size={13} /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                  <div className="grid gap-4 auto-rows-min" style={{ gridTemplateColumns: `repeat(${langs.length}, minmax(280px, 1fr))` }}>
                    {Array.from({ length: maxChunks }).flatMap((_, chunkIdx) =>
                      langs.map((_, langIdx) => (
                        <div key={`${chunkIdx}-${langIdx}`} className="min-w-0">
                          {renderChunkCard(langChunks[langIdx][chunkIdx] ?? [], chunkIdx, langIdx)}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div className="flex-1 min-h-0 flex overflow-x-auto overflow-y-hidden p-4 gap-4">
              {langs.map((lang, idx) => (
                <div key={idx} className="flex-1 min-h-0 flex flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden basis-[340px] min-w-[340px]">
                  {renderLangHeader(lang, idx)}
                  {showFind[`${activeId}:${idx}`] && (
                    <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/50">
                      <ScanSearch size={13} className="text-muted-foreground shrink-0" />
                      <input autoFocus type="text" value={findText[`${activeId}:${idx}`] ?? ""} onChange={(e) => setFindText((prev) => ({ ...prev, [`${activeId}:${idx}`]: e.target.value }))}
                        placeholder="Find in text..." className="flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground" />
                      <button onClick={() => setShowFind((prev) => ({ ...prev, [`${activeId}:${idx}`]: false }))} className="text-muted-foreground hover:text-foreground"><X size={13} /></button>
                    </div>
                  )}
                  {splitView[`${activeId}:${idx}`] ? (
                    <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
                      {(() => {
                        const lines = lang.content === "" ? [] : lang.content.split("\n");
                        const size = chunkSizeFor(idx);
                        const chunks: string[][] = [];
                        for (let i = 0; i < lines.length; i += size) chunks.push(lines.slice(i, i + size));
                        if (chunks.length === 0) chunks.push([]);
                        return chunks.map((chunk, chunkIdx) => (
                          <div key={chunkIdx}>{renderChunkCard(chunk, chunkIdx, idx)}</div>
                        ));
                      })()}
                    </div>
                  ) : (
                    <LineEditor key={`${activeId}-${idx}`} editorKey={`${activeId}-${idx}`}
                      value={lang.content} onChange={(v) => updateContent(idx, v)}
                      placeholder={`Enter ${lang.label} subtitle text here...`}
                      divRef={(el) => { editorRefs.current[idx] = el; }} />
                  )}
                </div>
              ))}
            </div>
          );
        })()}
      </main>
      {taskOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          onClick={() => setTaskOpen(false)}>
          <div onClick={(e) => e.stopPropagation()}
            className="w-full max-w-6xl max-h-[92vh] h-[85vh] flex flex-col rounded-3xl border-4 border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 shadow-2xl overflow-hidden">
            <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-emerald-200 dark:border-emerald-800">
              <div className="flex-1" />
              <h2 className="text-2xl font-bold tracking-[0.3em] text-emerald-900 dark:text-emerald-100" style={{ fontFamily: "Georgia, serif" }}>TASK NOTE</h2>
              <div className="flex-1 flex justify-end">
                <button onClick={() => setTaskOpen(false)} className="p-1.5 rounded-md hover:bg-emerald-200 dark:hover:bg-emerald-800 text-emerald-900 dark:text-emerald-100">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-3">
              {activeTasks.length === 0 && (
                <p className="text-center text-sm text-emerald-700/70 dark:text-emerald-300/70 py-6">No tasks yet — click + to add a row</p>
              )}
              {activeTasks.map((task, idx) => (
                <div key={idx} className="flex items-start gap-3">
                  <input type="checkbox" checked={task.checked} onChange={() => toggleTask(idx)}
                    className="w-5 h-5 mt-3 accent-emerald-600 shrink-0" />
                  {Array.from({ length: numLangs }).map((_, col) => (
                    <textarea key={col} value={task.values[col] ?? ""}
                      onChange={(e) => updateTaskValue(idx, col, e.target.value)}
                      placeholder={activeProject?.langs[col]?.label ?? ""}
                      rows={3}
                      className={`flex-1 min-w-0 px-3 py-2 text-sm rounded-md border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-gray-900 dark:bg-emerald-900/30 text-foreground outline-none focus:border-emerald-500 resize-y min-h-[72px] leading-relaxed ${task.checked ? "line-through opacity-60" : ""}`} />
                  ))}
                  <button onClick={() => removeTaskRow(idx)} title="Remove row"
                    className="shrink-0 mt-2 w-7 h-7 flex items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors">
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button onClick={addTaskRow} title="Add row"
                className="mt-3 mx-auto w-1/2 flex items-center justify-center py-3 rounded-md border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-gray-900 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 transition-colors">
                <Plus size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
