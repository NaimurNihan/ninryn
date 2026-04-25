export type SubtitleBlock = {
  id: number;
  startTime: number;
  endTime: number;
  text: string;
  isSplit?: boolean;
};

export function timeToMs(timeStr: string): number {
  const parts = timeStr.trim().replace(',', '.').split(':');
  if (parts.length !== 3) return 0;
  const hours = parseInt(parts[0], 10) * 3600000;
  const minutes = parseInt(parts[1], 10) * 60000;
  const secParts = parts[2].split('.');
  const seconds = parseInt(secParts[0], 10) * 1000;
  const ms = secParts[1] ? parseInt(secParts[1].padEnd(3, '0').substring(0, 3), 10) : 0;
  return hours + minutes + seconds + ms;
}

export function msToTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = Math.floor(ms % 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')},${milliseconds
    .toString()
    .padStart(3, '0')}`;
}

export function parseInput(input: string): SubtitleBlock[] {
  const lines = input.split('\n');
  const blocks: SubtitleBlock[] = [];
  let currentBlock: Partial<SubtitleBlock> | null = null;
  let idCounter = 1;

  const timeRegex = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*(?:-->|-)\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (currentBlock && currentBlock.startTime !== undefined) {
        blocks.push(currentBlock as SubtitleBlock);
        currentBlock = null;
      }
      continue;
    }

    const timeMatch = line.match(timeRegex);
    if (timeMatch) {
      if (currentBlock && currentBlock.startTime !== undefined) {
        blocks.push(currentBlock as SubtitleBlock);
      }
      currentBlock = {
        id: idCounter++,
        startTime: timeToMs(timeMatch[1]),
        endTime: timeToMs(timeMatch[2]),
        text: timeMatch[3] ? timeMatch[3].trim() : '',
        isSplit: false
      };
    } else if (currentBlock && currentBlock.startTime !== undefined) {
      currentBlock.text = currentBlock.text ? currentBlock.text + '\n' + line : line;
    } else {
      if (/^\d+$/.test(line)) {
        continue;
      }
    }
  }

  if (currentBlock && currentBlock.startTime !== undefined) {
    blocks.push(currentBlock as SubtitleBlock);
  }

  return blocks;
}

export function processBlocks(blocks: SubtitleBlock[]): SubtitleBlock[] {
  const result: SubtitleBlock[] = [];
  let idCounter = 1;

  for (const block of blocks) {
    if (!block.text.includes('✅')) {
      result.push({ ...block, id: idCounter++ });
      continue;
    }

    const rawParts = block.text.split('✅');
    const parts = rawParts
      .map((part, index) => `${part}${index < rawParts.length - 1 ? '✅' : ''}`.trim())
      .filter(Boolean);

    const totalChars = parts.reduce((sum, p) => sum + p.trim().length, 0);
    const duration = block.endTime - block.startTime;

    let currentTime = block.startTime;

    for (let i = 0; i < parts.length; i++) {
      const partText = parts[i].trim();
      if (!partText && i === parts.length - 1) continue;

      const partChars = partText.length;
      const partDuration = totalChars === 0 ? duration / parts.length : Math.round(duration * (partChars / totalChars));

      const partEndTime = i === parts.length - 1 ? block.endTime : currentTime + partDuration;

      result.push({
        id: idCounter++,
        startTime: currentTime,
        endTime: partEndTime,
        text: partText,
        isSplit: true
      });

      currentTime = partEndTime;
    }
  }

  return result;
}

type TimedTextSegment = {
  text: string;
  startTime: number;
  endTime: number;
};

function splitBlockByMarkers(block: SubtitleBlock): TimedTextSegment[] {
  if (!block.text.includes('✅')) {
    return [
      {
        text: block.text.trim(),
        startTime: block.startTime,
        endTime: block.endTime,
      },
    ].filter((segment) => segment.text.length > 0);
  }

  const rawParts = block.text.split('✅');
  const parts = rawParts
    .map((part, index) => `${part}${index < rawParts.length - 1 ? '✅' : ''}`.trim())
    .filter(Boolean);
  const totalChars = parts.reduce((sum, part) => sum + part.length, 0);
  const duration = block.endTime - block.startTime;
  let currentTime = block.startTime;

  return parts.map((part, index) => {
    const partDuration =
      totalChars === 0 ? duration / parts.length : Math.round(duration * (part.length / totalChars));
    const endTime = index === parts.length - 1 ? block.endTime : currentTime + partDuration;
    const segment = {
      text: part,
      startTime: currentTime,
      endTime,
    };
    currentTime = endTime;
    return segment;
  });
}

function joinSentenceParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function mergeBlocksByMarkers(blocks: SubtitleBlock[]): SubtitleBlock[] {
  const result: SubtitleBlock[] = [];
  let idCounter = 1;
  let sentenceParts: string[] = [];
  let sentenceStartTime: number | null = null;
  let sentenceEndTime: number | null = null;

  for (const block of blocks) {
    const segments = splitBlockByMarkers(block);

    for (const segment of segments) {
      if (sentenceStartTime === null) {
        sentenceStartTime = segment.startTime;
      }

      sentenceParts.push(segment.text);
      sentenceEndTime = segment.endTime;

      if (segment.text.endsWith('✅')) {
        result.push({
          id: idCounter++,
          startTime: sentenceStartTime,
          endTime: sentenceEndTime,
          text: joinSentenceParts(sentenceParts),
          isSplit: true,
        });
        sentenceParts = [];
        sentenceStartTime = null;
        sentenceEndTime = null;
      }
    }
  }

  if (sentenceParts.length > 0 && sentenceStartTime !== null && sentenceEndTime !== null) {
    result.push({
      id: idCounter++,
      startTime: sentenceStartTime,
      endTime: sentenceEndTime,
      text: joinSentenceParts(sentenceParts),
      isSplit: true,
    });
  }

  return result;
}

export function generateSrtString(blocks: SubtitleBlock[]): string {
  return blocks
    .map(
      (b) =>
        `${b.id}\n${msToTime(b.startTime)} --> ${msToTime(b.endTime)}\n${b.text}`
    )
    .join('\n\n');
}
