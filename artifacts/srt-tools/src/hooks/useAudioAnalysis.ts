import { useState, useCallback } from "react";
import { encodeWAV } from "@/lib/wavEncoder";

export interface SilenceRange {
  startSilenceEnd: number;
  endSilenceStart: number;
  duration: number;
}

export interface AudioFile {
  id: string;
  file: File;
  name: string;
  duration: number;
  waveformData: Float32Array;
  silence: SilenceRange | null;
  status: "analyzing" | "ready" | "error";
  isTrimmed: boolean;
  trimmedBlob?: Blob;
  trimmedDuration?: number;
  trimmedWaveformData?: Float32Array;
}

const SILENCE_THRESHOLD = 0.01;
const MIN_SILENCE_DURATION = 0.1;

function detectSilence(channelData: Float32Array, sampleRate: number): SilenceRange {
  const totalDuration = channelData.length / sampleRate;
  const minSilenceSamples = Math.floor(MIN_SILENCE_DURATION * sampleRate);
  let startSilenceEnd = 0;
  for (let i = 0; i < channelData.length; i++) {
    if (Math.abs(channelData[i]) > SILENCE_THRESHOLD) {
      const windowStart = Math.max(0, i - minSilenceSamples);
      startSilenceEnd = windowStart / sampleRate;
      break;
    }
  }
  let endSilenceStart = totalDuration;
  for (let i = channelData.length - 1; i >= 0; i--) {
    if (Math.abs(channelData[i]) > SILENCE_THRESHOLD) {
      const windowEnd = Math.min(channelData.length, i + minSilenceSamples);
      endSilenceStart = windowEnd / sampleRate;
      break;
    }
  }
  return { startSilenceEnd, endSilenceStart, duration: totalDuration };
}

function downsample(channelData: Float32Array, targetLength: number): Float32Array {
  const result = new Float32Array(targetLength);
  const blockSize = Math.max(1, Math.floor(channelData.length / targetLength));
  for (let i = 0; i < targetLength; i++) {
    let peak = 0;
    const start = i * blockSize;
    const end = Math.min(start + blockSize, channelData.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(channelData[j]);
      if (v > peak) peak = v;
    }
    result[i] = peak;
  }
  return result;
}

export function useAudioAnalysis() {
  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);

  const addFiles = useCallback(async (files: File[]) => {
    const newEntries: AudioFile[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      duration: 0,
      waveformData: new Float32Array(0),
      silence: null,
      status: "analyzing" as const,
      isTrimmed: false,
    }));
    setAudioFiles((prev) => [...prev, ...newEntries]);
    for (const entry of newEntries) {
      try {
        const arrayBuffer = await entry.file.arrayBuffer();
        const audioCtx = new AudioContext();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();
        const channelData = audioBuffer.getChannelData(0);
        const waveformData = downsample(channelData, 1500);
        const silence = detectSilence(channelData, audioBuffer.sampleRate);
        setAudioFiles((prev) =>
          prev.map((f) =>
            f.id === entry.id
              ? { ...f, duration: audioBuffer.duration, waveformData, silence, status: "ready" as const }
              : f
          )
        );
      } catch {
        setAudioFiles((prev) =>
          prev.map((f) =>
            f.id === entry.id ? { ...f, status: "error" as const } : f
          )
        );
      }
    }
  }, []);

  const trimAllFiles = useCallback(async () => {
    const readyFiles = audioFiles.filter(
      (f) => f.status === "ready" && f.silence && !f.isTrimmed
    );
    for (const entry of readyFiles) {
      if (!entry.silence) continue;
      try {
        const arrayBuffer = await entry.file.arrayBuffer();
        const audioCtx = new AudioContext();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        await audioCtx.close();
        const sampleRate = audioBuffer.sampleRate;
        const startSample = Math.floor(entry.silence.startSilenceEnd * sampleRate);
        const endSample = Math.floor(entry.silence.endSilenceStart * sampleRate);
        const trimmedBlob = encodeWAV(audioBuffer, startSample, endSample);
        const trimmedDuration = entry.silence.endSilenceStart - entry.silence.startSilenceEnd;
        const trimmedChannelData = audioBuffer.getChannelData(0).slice(startSample, endSample);
        const trimmedWaveformData = downsample(trimmedChannelData, 1500);
        setAudioFiles((prev) =>
          prev.map((f) =>
            f.id === entry.id
              ? { ...f, isTrimmed: true, trimmedBlob, trimmedDuration, trimmedWaveformData }
              : f
          )
        );
      } catch {
        // skip on error
      }
    }
  }, [audioFiles]);

  const removeFile = useCallback((id: string) => {
    setAudioFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const resetTrim = useCallback(() => {
    setAudioFiles((prev) =>
      prev.map((f) => ({
        ...f,
        isTrimmed: false,
        trimmedBlob: undefined,
        trimmedDuration: undefined,
        trimmedWaveformData: undefined,
      }))
    );
  }, []);

  return { audioFiles, addFiles, removeFile, trimAllFiles, resetTrim };
}
