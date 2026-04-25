export interface Subtitle {
  id: number;
  index: number;
  startTime: string;
  endTime: string;
  text: string;
  originalText: string;
  edited: boolean;
}

export function parseSrt(content: string): Subtitle[] {
  const blocks = content.trim().split(/\n\s*\n/);
  const subtitles: Subtitle[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    const indexLine = lines[0].trim();
    const timeLine = lines[1].trim();
    const textLines = lines.slice(2).join("\n").trim();

    if (!/^\d+$/.test(indexLine)) continue;

    const timeMatch = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.:]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.:]\d{3})/
    );
    if (!timeMatch) continue;

    const startTime = timeMatch[1].replace(".", ",");
    const endTime = timeMatch[2].replace(".", ",");

    const id = Date.now() * 1000 + subtitles.length;
    subtitles.push({
      id,
      index: parseInt(indexLine),
      startTime,
      endTime,
      text: textLines,
      originalText: textLines,
      edited: false,
    });
  }

  return subtitles;
}

export function formatSrt(subtitles: Subtitle[]): string {
  return subtitles
    .map((s, i) => {
      return `${i + 1}\n${s.startTime} --> ${s.endTime}\n${s.text}`;
    })
    .join("\n\n");
}

export function downloadSrt(subtitles: Subtitle[], filename = "output.srt") {
  const content = formatSrt(subtitles);
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
