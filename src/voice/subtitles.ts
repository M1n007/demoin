import { promises as fs } from "node:fs";
import sharp from "sharp";
import { readingMs } from "../config.js";
import type { Preset } from "../preset.js";
import type { TimelineEvent } from "../types.js";
import type { VoiceClip } from "./voiceover.js";

/** One subtitle, in OUTPUT video time. */
export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

/** Gap kept between two cues so one never flashes into the next. */
const GAP_MS = 80;

/**
 * Subtitle cues from the steps that made it into the video.
 *
 * With a voiceover, a cue lasts exactly as long as its clip. Without one, it
 * lasts as long as the sentence takes to read, but never runs into the next
 * step: a subtitle that is still describing the previous click while the
 * cursor is already somewhere else is worse than a short one.
 */
export function buildCues(
  events: TimelineEvent[],
  mapTime: (srcMs: number) => number,
  durationMs: number,
  clips?: Map<number, VoiceClip>,
): Cue[] {
  const cues: Cue[] = [];
  const shown = events.filter((e) => e.ok && !e.noop && e.narration?.trim());
  for (let i = 0; i < shown.length; i++) {
    const e = shown[i];
    const clip = clips?.get(e.index);
    const start = Math.max(mapTime(clip?.atSrcMs ?? e.narrationAt ?? e.moveStart), cues.at(-1) ? cues.at(-1)!.endMs + GAP_MS : 0);
    if (start >= durationMs - 300) break;
    const next = shown[i + 1];
    const nextStart = next ? mapTime(clips?.get(next.index)?.atSrcMs ?? next.narrationAt ?? next.moveStart) : durationMs;
    const want = clip ? clip.durationMs : readingMs(e.narration);
    const end = Math.min(start + want, durationMs, clip ? Infinity : Math.max(start + 900, nextStart - GAP_MS));
    cues.push({ index: e.index, startMs: Math.round(start), endMs: Math.round(end), text: e.narration.trim() });
  }
  return cues;
}

const stamp = (ms: number, sep: string) => {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = Math.round(ms % 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
};

export function toSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${c.text}\n`).join("\n")}`;
}

export async function writeSubtitles(cues: Cue[], base: string): Promise<{ srt: string; vtt: string }> {
  const srt = `${base}.srt`;
  const vtt = `${base}.vtt`;
  await fs.writeFile(srt, toSrt(cues));
  await fs.writeFile(vtt, toVtt(cues));
  return { srt, vtt };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Greedy word wrap by an average glyph width; good enough for a caption bar. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…";
    return kept;
  }
  return lines;
}

/**
 * A burned-in caption as a transparent PNG the size of the video, with the
 * text in a rounded dark pill near the bottom. Drawn here rather than by
 * ffmpeg's subtitles filter, which most ffmpeg builds ship without.
 */
export async function renderCuePng(text: string, preset: Preset, file: string): Promise<void> {
  const { w: W, h: H } = preset.out;
  const card = preset.card;
  const portrait = H > W;
  // Sized and placed against the recording card, not the whole frame, so the
  // pill always sits on the page instead of straddling the card's edge.
  const font = Math.round(portrait ? card.w * 0.05 : card.h * 0.04);
  const line = Math.round(font * 1.32);
  const maxW = Math.round(card.w * (portrait ? 0.88 : 0.74));
  const lines = wrap(text, Math.floor(maxW / (font * 0.54)), portrait ? 3 : 2);
  const longest = Math.max(...lines.map((l) => l.length));
  const padX = Math.round(font * 0.9);
  const padY = Math.round(font * 0.55);
  const boxW = Math.min(maxW + padX * 2, Math.round(longest * font * 0.54) + padX * 2);
  const boxH = lines.length * line + padY * 2;
  const x = Math.round(card.x + (card.w - boxW) / 2);
  // above the bottom of the card, clear of the cursor's usual resting spot
  const y = Math.round(card.y + card.h - boxH - card.h * (portrait ? 0.08 : 0.06));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${Math.round(font * 0.6)}" fill="#0b0d12" fill-opacity="0.86"/>` +
    lines
      .map(
        (l, i) =>
          `<text x="${card.x + card.w / 2}" y="${y + padY + line * i + font}" text-anchor="middle" ` +
          `font-family="Inter, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif" font-size="${font}" ` +
          `font-weight="600" fill="#ffffff">${esc(l)}</text>`,
      )
      .join("") +
    `</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}
