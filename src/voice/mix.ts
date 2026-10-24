import { promises as fs } from "node:fs";
import path from "node:path";
import { ffmpegPath, ffprobePath, run } from "../ffmpeg.js";
import type { Preset } from "../preset.js";
import { renderCuePng, type Cue } from "./subtitles.js";
import type { VoiceClip } from "./voiceover.js";

export interface MixOptions {
  input: string;
  output: string;
  durationMs: number;
  mapTime: (srcMs: number) => number;
  preset: Preset;
  clips?: VoiceClip[];
  /** cues to burn into the picture */
  burn?: Cue[];
  workDir: string;
}

async function hasAudio(file: string): Promise<boolean> {
  const out = await run(ffprobePath(), [
    "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file,
  ]).catch(() => "");
  return out.trim().length > 0;
}

/**
 * Second pass over the composed video: lay the voiceover clips at their
 * output-time positions and, if asked, burn the subtitles in.
 *
 * Clips are placed one after another, never on top of each other. Steps
 * without an explain-pause (a scroll, a page load) have no hold to sit in, so
 * their sentence can only start once the previous one has finished; one that
 * would run past the end of the video is dropped rather than cut mid-word.
 */
export async function mixVoiceAndSubtitles(o: MixOptions): Promise<{ placed: number }> {
  const clips = [...(o.clips ?? [])]
    .filter((c) => c.atSrcMs !== undefined)
    .sort((a, b) => a.atSrcMs! - b.atSrcMs!);
  const burn = o.burn ?? [];
  if (!clips.length && !burn.length) {
    await fs.copyFile(o.input, o.output);
    return { placed: 0 };
  }

  const args = ["-y", "-v", "error", "-i", o.input];
  let inputs = 1;
  const audioIn = await hasAudio(o.input);
  const dur = (o.durationMs / 1000).toFixed(3);
  let silentBase = -1;
  if (clips.length && !audioIn) {
    args.push("-f", "lavfi", "-t", dur, "-i", "anullsrc=r=48000:cl=stereo");
    silentBase = inputs++;
  }

  const placed: { input: number; at: number }[] = [];
  let free = 0;
  for (const c of clips) {
    const at = Math.max(o.mapTime(c.atSrcMs!), free);
    if (at + c.durationMs > o.durationMs + 120) continue;
    args.push("-i", c.file);
    placed.push({ input: inputs++, at });
    free = at + c.durationMs + 120;
  }

  const pngs: { input: number; cue: Cue }[] = [];
  for (const cue of burn) {
    const file = path.join(o.workDir, `cue-${String(cue.index).padStart(3, "0")}.png`);
    await renderCuePng(cue.text, o.preset, file);
    args.push("-loop", "1", "-t", dur, "-i", file);
    pngs.push({ input: inputs++, cue });
  }

  const graph: string[] = [];
  let vOut = "0:v";
  pngs.forEach((p, i) => {
    const label = `v${i}`;
    graph.push(
      `[${vOut === "0:v" ? "0:v" : vOut}][${p.input}:v]overlay=0:0:enable='between(t,${(p.cue.startMs / 1000).toFixed(3)},${(p.cue.endMs / 1000).toFixed(3)})'[${label}]`,
    );
    vOut = label;
  });

  let aOut: string | null = audioIn ? "0:a" : null;
  if (placed.length) {
    const base = audioIn ? "[0:a]" : `[${silentBase}:a]`;
    placed.forEach((p, i) => {
      graph.push(`[${p.input}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(p.at)}:all=1[vo${i}]`);
    });
    graph.push(
      `${base}${placed.map((_, i) => `[vo${i}]`).join("")}amix=inputs=${placed.length + 1}:normalize=0:duration=first:dropout_transition=0[aout]`,
    );
    aOut = "aout";
  }

  if (graph.length) args.push("-filter_complex", graph.join(";"));
  args.push("-map", vOut === "0:v" ? "0:v" : `[${vOut}]`);
  if (aOut) args.push("-map", aOut === "0:a" ? "0:a" : `[${aOut}]`);
  if (pngs.length) args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
  else args.push("-c:v", "copy");
  if (aOut) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-t", dur, "-movflags", "+faststart", o.output);

  await run(ffmpegPath(), args);
  return { placed: placed.length };
}
