/**
 * Smoke test for the renderer: fake frames + two fake events + one voiceover
 * clip -> mp4. Checks that the file exists, carries an audio stream, and that
 * its length matches what composeVideo reports.
 *
 *   pnpm exec tsx test/render-smoke.ts
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { composeVideo, extractPoster } from "../src/render/compose.js";
import { PRESETS } from "../src/preset.js";
import type { FrameRef, TimelineEvent } from "../src/types.js";

const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
process.env.FFMPEG_PATH = FFMPEG;
const FFPROBE = process.env.FFPROBE_PATH || path.join(path.dirname(FFMPEG), "ffprobe");

const preset = PRESETS.desktop;
const dir = mkdtempSync(path.join(os.tmpdir(), "demoin-render-"));
const framesDir = path.join(dir, "frames");
mkdirSync(framesDir);

const REC_MS = 3000;
const W = preset.viewport.w * preset.deviceScale;
const H = preset.viewport.h * preset.deviceScale;

async function main() {
  // Solid colours that change after each action, so change detection has
  // something to find. Identical colours share one encoded buffer.
  const colourAt = (t: number) =>
    t < 1150 ? { r: 240, g: 242, b: 247 } : t < 2600 ? { r: 220, g: 236, b: 255 } : { r: 255, g: 240, b: 220 };
  const cache = new Map<string, Buffer>();
  const frames: FrameRef[] = [];
  for (let t = 0, i = 0; t <= REC_MS; t += 33, i++) {
    const c = colourAt(t);
    const key = `${c.r},${c.g},${c.b}`;
    let buf = cache.get(key);
    if (!buf) {
      buf = await sharp({ create: { width: W, height: H, channels: 3, background: c } })
        .jpeg({ quality: 80 })
        .toBuffer();
      cache.set(key, buf);
    }
    const file = `f${String(i).padStart(5, "0")}.jpg`;
    await sharp(buf).toFile(path.join(framesDir, file));
    frames.push({ file, t });
  }

  const events: TimelineEvent[] = [
    {
      index: 0,
      url: "http://localhost:3000/",
      urlBefore: "http://localhost:3000/",
      kind: "click",
      narration: "Open the settings panel.",
      target: { x: 600, y: 400, w: 200, h: 50 },
      cursorFrom: { x: 1100, y: 720 },
      cursorTo: { x: 700, y: 425 },
      moveStart: 400,
      narrationAt: 400,
      actAt: 1100,
      visualEnd: 1600,
      actEnd: 1900,
      secret: false,
      effect: "zoom",
      ok: true,
    },
    {
      index: 1,
      url: "http://localhost:3000/settings",
      urlBefore: "http://localhost:3000/",
      kind: "fill",
      narration: "Type a display name.",
      target: { x: 500, y: 300, w: 420, h: 44 },
      cursorFrom: { x: 700, y: 425 },
      cursorTo: { x: 710, y: 322 },
      moveStart: 2000,
      actAt: 2550,
      visualEnd: 2750,
      actEnd: 2850,
      secret: false,
      effect: "spotlight",
      ok: true,
    },
  ];

  const tone = path.join(dir, "tone.wav");
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=1", tone]);

  const outPath = path.join(dir, "out.mp4");
  const started = Date.now();
  const res = await composeVideo({
    framesDir,
    frames,
    events,
    recDurationMs: REC_MS,
    outPath,
    preset,
    captions: true,
    sound: true,
    displayHost: "example.com",
    // the second clip starts near the end and must not lengthen the video
    audioClips: [
      { file: tone, atSrcMs: 1000 },
      { file: tone, atSrcMs: 2700, gain: 0.5 },
    ],
  });
  console.log(`rendered ${res.frameCount} frames in ${Date.now() - started}ms, durationMs=${res.durationMs}`);

  assert.ok(existsSync(outPath), "mp4 exists");
  const probe = JSON.parse(
    execFileSync(FFPROBE, ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath]).toString(),
  ) as { streams: { codec_type: string; duration?: string }[]; format: { duration: string } };
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  const video = probe.streams.find((s) => s.codec_type === "video");
  assert.ok(audio, "has an audio stream");
  assert.ok(video, "has a video stream");
  const fileMs = Number(probe.format.duration) * 1000;
  const audioMs = Number(audio.duration) * 1000;
  console.log(`ffprobe: format=${fileMs.toFixed(0)}ms video=${(Number(video.duration) * 1000).toFixed(0)}ms audio=${audioMs.toFixed(0)}ms`);
  assert.ok(Math.abs(fileMs - res.durationMs) < 80, `file length ${fileMs} ~ ${res.durationMs}`);
  assert.ok(audioMs <= res.durationMs + 50, `audio ${audioMs} does not run past the video`);

  // the voiceover tone was actually mixed in, not lost to silence
  const vd = spawnSync(FFMPEG, ["-hide_banner", "-i", outPath, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
  });
  const maxDb = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(vd.stderr)?.[1] ?? -99);
  console.log(`audio max_volume=${maxDb}dB`);
  assert.ok(maxDb > -20, "mixed audio is audible");

  // mapTime is monotonic and stays inside the video
  let prev = -1;
  for (let t = 0; t <= REC_MS + 500; t += 50) {
    const o = res.mapTime(t);
    assert.ok(o >= prev && o <= res.durationMs + 1, `mapTime(${t}) = ${o}`);
    prev = o;
  }
  assert.equal(res.chapters.length, 2);

  const poster = path.join(dir, "poster.jpg");
  await extractPoster(outPath, poster, res.durationMs);
  assert.ok(existsSync(poster), "poster exists");

  console.log("render smoke: OK");
  rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  console.error(`artifacts kept in ${dir}`);
  process.exit(1);
});
