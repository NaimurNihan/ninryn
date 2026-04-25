import { Editor } from "@/components/editor/note-editor";

interface AiAudioTabProps {
  onSendToSpliter?: (files: File[]) => void;
}

export default function AiAudioTab({ onSendToSpliter }: AiAudioTabProps = {}) {
  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      <main className="flex-1 h-full overflow-y-auto relative">
        <Editor onSendToSpliter={onSendToSpliter} />
      </main>
    </div>
  );
}
