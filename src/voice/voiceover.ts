import path from "node:path";
import type { LogEntry } from "../types.js";
import type { TTS } from "./tts.js";

export interface VoiceClip {
  file: string;
  durationMs: number;
  text: string;
  /** recording time the clip starts at; set by the executor's narrationAt */
  atSrcMs?: number;
}

/**
 * Breath after the sentence before the action lands. Without it the click
 * falls on the last syllable and the voice sounds cut off.
 */
const TAIL_MS = 220;

/**
 * Voiceover synthesised DURING the recording.
 *
 * The narration of each step is known the moment the agent decides it, before
 * the action runs. Speaking it right there, and holding the real browser still
 * for exactly the length of the clip, is what keeps voice and screen in sync:
 * the frames for that pause are genuinely recorded, so nothing has to be
 * stretched or guessed at render time. It is the same "point, explain, then
 * press" rhythm a person demoing a product uses.
 */
export class Voiceover {
  readonly clips = new Map<number, VoiceClip>();

  constructor(
    private tts: TTS,
    private dir: string,
    private onLog?: (e: LogEntry) => void,
  ) {}

  /** Executor hold hook: speak, then report how long to keep the screen still. */
  hold = async (narration: string, index: number): Promise<number> => {
    const text = narration.trim();
    if (!text) return 0;
    try {
      const clip = await this.tts.synth(text, path.join(this.dir, `vo-${String(index).padStart(3, "0")}`));
      this.clips.set(index, { ...clip, text });
      return clip.durationMs + TAIL_MS;
    } catch (e) {
      // A missing sentence is better than a failed video.
      this.onLog?.({ t: Date.now(), level: "warn", message: `Voiceover for step ${index + 1} failed: ${(e as Error).message}` });
      return 0;
    }
  };

  /** Pin each clip to the moment its explain-pause actually began. */
  anchor(events: { index: number; narrationAt?: number; moveStart: number; noop?: boolean; ok: boolean }[]) {
    for (const e of events) {
      const c = this.clips.get(e.index);
      if (!c) continue;
      if (!e.ok || e.noop) this.clips.delete(e.index);
      else c.atSrcMs = e.narrationAt ?? e.moveStart;
    }
  }
}
