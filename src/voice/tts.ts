import { promises as fs } from "node:fs";
import { ffmpegPath, probeDurationMs, run } from "../ffmpeg.js";

/**
 * Text-to-speech for the voiceover. Every provider writes one audio file per
 * sentence and reports how long it is: the recorder holds the screen still for
 * exactly that long before the action, so the voice and the click line up
 * without any audio analysis.
 */
export interface TTS {
  /** "provider:voice", for logs */
  readonly id: string;
  /** write `text` as speech to `outBase` + an extension; returns the file */
  synth(text: string, outBase: string): Promise<{ file: string; durationMs: number }>;
}

export const TTS_PROVIDERS = ["openai", "elevenlabs", "gemini", "say"] as const;

/**
 * Build a voice from "provider[:voice]", e.g.
 *
 *   openai:alloy   elevenlabs:<voice id>   gemini:Kore   say:Samantha (macOS, offline)
 */
export function createTTS(spec: string, opts: { language?: string; style?: string } = {}): TTS {
  const i = spec.indexOf(":");
  const provider = i < 0 ? spec : spec.slice(0, i);
  const voice = i < 0 ? "" : spec.slice(i + 1);
  switch (provider) {
    case "openai":
      return openaiTTS(voice || "alloy", opts.style);
    case "elevenlabs":
      return elevenlabsTTS(voice || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM");
    case "gemini":
      return geminiTTS(voice || "Kore", opts.style);
    case "say":
      return sayTTS(voice);
    default:
      throw new Error(`Unknown voice provider "${provider}". Use one of: ${TTS_PROVIDERS.join(", ")}.`);
  }
}

async function finish(file: string) {
  return { file, durationMs: await probeDurationMs(file) };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (needed for the voiceover).`);
  return v;
}

async function failIfBad(res: Response, who: string) {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`${who} TTS error ${res.status}: ${body.slice(0, 300)}`);
}

function openaiTTS(voice: string, style?: string): TTS {
  const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  return {
    id: `openai:${voice}`,
    async synth(text, outBase) {
      const res = await fetch(`${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${need("OPENAI_API_KEY")}` },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: "mp3",
          // a calm product-demo read unless told otherwise
          instructions: style ?? "Warm, clear and unhurried, like a product walkthrough.",
        }),
      });
      await failIfBad(res, "OpenAI");
      const file = `${outBase}.mp3`;
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return finish(file);
    },
  };
}

function elevenlabsTTS(voiceId: string): TTS {
  const model = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
  return {
    id: `elevenlabs:${voiceId}`,
    async synth(text, outBase) {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": need("ELEVENLABS_API_KEY") },
          body: JSON.stringify({ text, model_id: model }),
        },
      );
      await failIfBad(res, "ElevenLabs");
      const file = `${outBase}.mp3`;
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      return finish(file);
    },
  };
}

function geminiTTS(voice: string, style?: string): TTS {
  const model = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  return {
    id: `gemini:${voice}`,
    async synth(text, outBase) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": need("GEMINI_API_KEY") },
          body: JSON.stringify({
            contents: [{ parts: [{ text: style ? `${style}: ${text}` : text }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
        },
      );
      await failIfBad(res, "Gemini");
      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
      };
      const data = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
      if (!data) throw new Error("Gemini TTS returned no audio.");
      // raw 24 kHz 16-bit mono PCM; wrap it so every other tool can read it
      const pcm = `${outBase}.pcm`;
      const file = `${outBase}.wav`;
      await fs.writeFile(pcm, Buffer.from(data, "base64"));
      await run(ffmpegPath(), ["-y", "-v", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm, file]);
      await fs.rm(pcm, { force: true });
      return finish(file);
    },
  };
}

/** macOS `say`: free, offline, good enough for drafts and CI. */
function sayTTS(voice: string): TTS {
  return {
    id: `say:${voice || "default"}`,
    async synth(text, outBase) {
      if (process.platform !== "darwin") throw new Error('The "say" voice only exists on macOS.');
      const aiff = `${outBase}.aiff`;
      const file = `${outBase}.wav`;
      await run("say", [...(voice ? ["-v", voice] : []), "-o", aiff, text]);
      await run(ffmpegPath(), ["-y", "-v", "error", "-i", aiff, file]);
      await fs.rm(aiff, { force: true });
      return finish(file);
    },
  };
}
