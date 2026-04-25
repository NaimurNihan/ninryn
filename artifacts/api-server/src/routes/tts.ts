import { Router, type IRouter } from "express";
import { MsEdgeTTS, OUTPUT_FORMAT, type Voice } from "msedge-tts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MAX_TEXT_LENGTH = 5000;
const DEFAULT_VOICE_EN = "en-US-AriaNeural";
const DEFAULT_VOICE_BN = "bn-BD-NabanitaNeural";

let voicesCache: Voice[] | null = null;
let voicesCachePromise: Promise<Voice[]> | null = null;

async function getVoices(): Promise<Voice[]> {
  if (voicesCache) return voicesCache;
  if (voicesCachePromise) return voicesCachePromise;
  const tts = new MsEdgeTTS();
  voicesCachePromise = tts
    .getVoices()
    .then((vs) => {
      voicesCache = vs;
      voicesCachePromise = null;
      return vs;
    })
    .catch((err) => {
      voicesCachePromise = null;
      throw err;
    });
  return voicesCachePromise;
}

function detectVoice(text: string): string {
  return /[\u0980-\u09FF]/.test(text) ? DEFAULT_VOICE_BN : DEFAULT_VOICE_EN;
}

function streamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(err));
  });
}

router.get("/tts/voices", async (_req, res) => {
  try {
    const voices = await getVoices();
    res.json({ voices });
  } catch (err) {
    logger.error({ err }, "Failed to load voices");
    res.status(500).json({ error: "Failed to load voices" });
  }
});

router.post("/tts", async (req, res) => {
  const body = req.body as { text?: unknown; voice?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  const voiceArg = typeof body.voice === "string" ? body.voice : "";

  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `Text exceeds ${MAX_TEXT_LENGTH} chars` });
    return;
  }

  const voice = voiceArg.trim() || detectVoice(text);

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const buffer = await streamToBuffer(audioStream);
    tts.close();

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch (err) {
    logger.error({ err, voice }, "TTS synthesis failed");
    res.status(500).json({ error: "TTS synthesis failed" });
  }
});

export default router;
