import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as C from "../config.js";
import { buildRenderPlan, outAt, sampleFrame, srcAt, type Chapter, type RenderPlan } from "./motion.js";
import { buildDimLayer, buildFxLayer, lightboxCard } from "./overlay.js";
import { getBackdrop, getCardHole, getChromeBar, getLightboxMask } from "./frame.js";
import type { Preset } from "../preset.js";
import { writeClickTrack } from "./audio.js";
import { annotateChanges } from "./change.js";
import type { FrameRef, TimelineEvent } from "../types.js";

sharp.cache({ files: 0, memory: 96 });
sharp.concurrency(1);

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** An extra audio file (e.g. one voiceover line) placed on the recording's clock. */
export interface AudioClip {
  file: string;
  /** ms since the recording started; mapped through the time map */
  atSrcMs: number;
  /** linear volume, 1 = as is */
  gain?: number;
}

export interface ComposeOptions {
  framesDir: string;
  frames: FrameRef[];
  events: TimelineEvent[];
  recDurationMs: number;
  outPath: string;
  preset: Preset;
  /** draw step captions over the video */
  captions?: boolean;
  /** click sound on every cursor tap */
  sound?: boolean;
  /**
   * Replace the host shown in the fake browser bar. A recording made against
   * localhost can then be used as public material without showing off the
   * development address.
   */
  displayHost?: string;
  onProgress?: (done: number, total: number) => void;
  /** extra audio (voiceover), mixed with the click track into the final mp4 */
  audioClips?: AudioClip[];
  /**
   * Keep the pause between the cursor arriving and the action 1:1 in the
   * time map. Defaults to on when there are captions or audio clips; set it
   * explicitly when voiceover is mixed in a separate pass.
   */
  holdBeforeAction?: boolean;
}

export async function composeVideo(opts: ComposeOptions): Promise<{
  /** length of the file: whole frames at FPS */
  durationMs: number;
  frameCount: number;
  plan: RenderPlan;
  /** one entry per successful step, in output time */
  chapters: Chapter[];
  /** recording time (ms) -> output video time (ms) */
  mapTime: (srcMs: number) => number;
}> {
  const { framesDir, frames, events, recDurationMs, outPath, preset } = opts;
  if (!frames.length) throw new Error("no frames were recorded");
  const clips = opts.audioClips ?? [];

  // First find what changed with each action, so the camera can frame the
  // effect, not just the button.
  const marked = await annotateChanges(events, frames, framesDir, preset);
  const plan = buildRenderPlan(marked, recDurationMs, preset, {
    captions: opts.captions,
    holdBeforeAction: opts.holdBeforeAction ?? (Boolean(opts.captions) || clips.length > 0),
  });
  const VPW = preset.viewport.w;
  const VPH = preset.viewport.h;
  const SCR_W = preset.card.w;
  const SCR_H = preset.card.h - preset.chromeH;
  if (plan.durationMs < 500) throw new Error("recording is too short to render");

  // Real pixel scale of the frames relative to the CSS viewport (usually = deviceScale).
  const probe = await sharp(path.join(framesDir, frames[0].file)).metadata();
  const frameW = probe.width ?? VPW * preset.deviceScale;
  const frameH = probe.height ?? VPH * preset.deviceScale;
  const SF = frameW / VPW;

  const framed = preset.out.w !== SCR_W || preset.out.h !== SCR_H;
  const backdrop = framed ? await getBackdrop(preset) : null;
  const hole = framed ? await getCardHole(preset) : null;

  // URL per output time, for the fake browser bar.
  const asHost = (u: string) => {
    if (!opts.displayHost) return u;
    try {
      const x = new URL(u);
      x.protocol = "https:";
      x.host = opts.displayHost;
      x.port = "";
      return x.toString();
    } catch {
      return u;
    }
  };

  const mapTime = (srcMs: number) => outAt(plan.segs, srcMs);
  const urlMarks = events
    .filter((e) => e.ok && e.url)
    // The bar changes when the action fires, not when the cursor sets off:
    // with a pause in front of a navigation (voiceover), switching at
    // moveStart shows the destination while the old page is still on screen.
    .map((e) => ({ t: mapTime(e.actAt), url: asHost(e.url) }));
  const firstUrl = asHost(events[0]?.urlBefore || events[0]?.url || "");

  const total = Math.floor((plan.durationMs / 1000) * C.FPS);
  const videoMs = Math.round((total * 1000) / C.FPS);

  /**
   * The audio is written first, before ffmpeg starts.
   *
   * Every click time is already known from the render plan, so there is no
   * need to wait for a single frame. Adding the audio afterwards would mean
   * unpacking the mp4 again.
   */
  const tracks: AudioTrack[] = [];
  let clickPath: string | null = null;
  if (opts.sound) {
    clickPath = outPath.replace(/\.mp4$/, "") + ".click.wav";
    await writeClickTrack(clickPath, plan.durationMs, plan.ripples.map((r) => r.t));
    tracks.push({ file: clickPath, delayMs: 0, gain: 1 });
  }
  for (const c of clips) {
    const delayMs = Math.max(0, Math.round(mapTime(c.atSrcMs)));
    // starts after the video ends: nothing of it would be heard
    if (delayMs >= videoMs) continue;
    tracks.push({ file: c.file, delayMs, gain: c.gain ?? 1 });
  }

  const ff = spawnFfmpeg(outPath, preset.out, tracks, videoMs, clips.length ? "128k" : "96k");

  let framePtr = 0;
  let lastPath = "";
  let lastBuf: Buffer | null = null;
  const readFrame = async (file: string) => {
    const p = path.join(framesDir, file);
    if (p !== lastPath) {
      lastBuf = await fs.readFile(p);
      lastPath = p;
    }
    return lastBuf!;
  };

  try {
    for (let i = 0; i < total; i++) {
      const t = (i * 1000) / C.FPS;
      const srcT = srcAt(plan.segs, t);

      while (framePtr + 1 < frames.length && frames[framePtr + 1].t <= srcT) framePtr++;
      const src = await readFrame(frames[framePtr].file);

      const state = sampleFrame(plan, t);

      // --- A. screen: crop to the zoom, then scale down to the viewport size ---
      const scale = Math.max(1, state.zoom.scale);
      const cropW = clampInt((VPW / scale) * SF, 16, frameW);
      const cropH = clampInt((VPH / scale) * SF, 16, frameH);
      const left = clampInt(state.zoom.cx * SF - cropW / 2, 0, frameW - cropW);
      const top = clampInt(state.zoom.cy * SF - cropH / 2, 0, frameH - cropH);

      const layers: sharp.OverlayOptions[] = [];

      const dim = buildDimLayer(state, preset);
      if (dim) layers.push({ input: Buffer.from(dim), top: 0, left: 0 });

      const card = lightboxCard(state, preset);
      if (card) {
        const sx = clampInt(card.src.x * SF, 0, frameW - 2);
        const sy = clampInt(card.src.y * SF, 0, frameH - 2);
        const sw = clampInt(card.src.w * SF, 2, frameW - sx);
        const sh = clampInt(card.src.h * SF, 2, frameH - sy);
        const cardBuf = await sharp(src)
          .extract({ left: sx, top: sy, width: sw, height: sh })
          .resize(card.w, card.h, { fit: "fill", kernel: "lanczos3" })
          .composite([
            { input: await getLightboxMask(card.w, card.h, card.k), blend: "dest-in" },
          ])
          .png()
          .toBuffer();
        layers.push({ input: cardBuf, top: card.y, left: card.x });
      }

      const fx = buildFxLayer(state, preset);
      if (fx) layers.push({ input: Buffer.from(fx), top: 0, left: 0 });

      const screen = await sharp(src)
        .extract({ left, top, width: cropW, height: cropH })
        .resize(SCR_W, SCR_H, { fit: "fill", kernel: "lanczos3" })
        .composite(layers)
        .removeAlpha()
        .raw()
        .toBuffer();

      // --- B. paste onto the backdrop + browser bar ---
      let out: Buffer;
      if (backdrop && hole) {
        const url = urlAt(urlMarks, t, firstUrl);
        out = await sharp(backdrop, {
          raw: { width: preset.out.w, height: preset.out.h, channels: 3 },
        })
          .composite([
            ...(preset.chromeH > 0
              ? [
                  {
                    input: await getChromeBar(url, preset),
                    top: preset.card.y,
                    left: preset.card.x,
                  },
                ]
              : []),
            {
              input: screen,
              raw: { width: SCR_W, height: SCR_H, channels: 3 },
              top: preset.screen.y,
              left: preset.screen.x,
            },
            { input: hole, top: preset.card.y, left: preset.card.x },
          ])
          .removeAlpha()
          .raw()
          .toBuffer();
      } else {
        out = screen;
      }

      await write(ff.stdin, out);
      if (opts.onProgress && i % 30 === 0) opts.onProgress(i, total);
    }
  } finally {
    ff.stdin.end();
  }

  try {
    await ff.done;
  } finally {
    if (clickPath) await fs.unlink(clickPath).catch(() => {});
  }
  opts.onProgress?.(total, total);
  return {
    durationMs: videoMs,
    frameCount: total,
    plan,
    chapters: plan.chapters,
    mapTime,
  };
}

// ---------------------------------------------------------------------------

interface AudioTrack {
  file: string;
  /** where it starts in the output video (ms) */
  delayMs: number;
  gain: number;
}

function urlAt(marks: { t: number; url: string }[], t: number, fallback: string) {
  let url = fallback;
  for (const m of marks) {
    if (m.t <= t) url = m.url;
    else break;
  }
  return url;
}

function write(stream: NodeJS.WritableStream, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.write(buf)) return resolve();
    // Listeners must be removed in pairs; over thousands of frames they would
    // otherwise pile up and trigger the EventEmitter leak warning.
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    const onError = (e: Error) => {
      stream.off("drain", onDrain);
      reject(e);
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

/**
 * Audio graph: every track is placed at its offset and mixed without
 * normalisation (amix would otherwise quieten each input by the input count,
 * so a voiceover would get softer just because clicks are present). The result
 * is padded and then cut to exactly the video's length, so a voiceover line
 * that runs past the end can never make the file longer than the picture.
 */
function audioGraph(tracks: AudioTrack[], videoMs: number): string {
  const sec = (videoMs / 1000).toFixed(3);
  const chains = tracks.map(
    (tr, k) =>
      `[${k + 1}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
      `adelay=delays=${tr.delayMs}:all=1,volume=${tr.gain.toFixed(3)}[a${k}]`,
  );
  const labels = tracks.map((_, k) => `[a${k}]`).join("");
  const mix =
    tracks.length > 1
      ? `${labels}amix=inputs=${tracks.length}:normalize=0:duration=longest:dropout_transition=0,`
      : labels;
  return [...chains, `${mix}apad=whole_dur=${sec},atrim=end=${sec}[aout]`].join(";");
}

function spawnFfmpeg(
  outPath: string,
  size: { w: number; h: number },
  tracks: AudioTrack[],
  videoMs: number,
  audioBitrate = "96k",
) {
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  const proc = spawn(
    bin,
    [
      "-y",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-s", `${size.w}x${size.h}`,
      "-r", String(C.FPS),
      "-i", "pipe:0",
      ...tracks.flatMap((tr) => ["-i", tr.file]),
      ...(tracks.length
        ? [
            "-filter_complex", audioGraph(tracks, videoMs),
            "-map", "0:v", "-map", "[aout]",
            "-c:a", "aac", "-b:a", audioBitrate,
          ]
        : ["-an"]),
      // libx264 with yuv420p needs even sides.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += String(d);
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });
  // stdin can EPIPE if ffmpeg dies first; don't let that crash the process
  proc.stdin.on("error", () => {});

  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", (e) =>
      reject(
        new Error(
          `Could not run ffmpeg ("${bin}"). Make sure ffmpeg is installed or set FFMPEG_PATH. ${e.message}`,
        ),
      ),
    );
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-1200)}`)),
    );
  });

  return { stdin: proc.stdin, done };
}

/**
 * Grab one frame as the poster. Taken from the tail of the recording, when
 * the camera has pulled back and the end result is visible whole, because
 * that is the frame that best represents what the demo is about.
 */
export async function extractPoster(
  videoFile: string,
  outFile: string,
  durationMs: number,
): Promise<void> {
  const at = Math.max(0, durationMs / 1000 - 0.7);
  const bin = process.env.FFMPEG_PATH || "ffmpeg";
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      bin,
      ["-y", "-loglevel", "error", "-ss", at.toFixed(2), "-i", videoFile,
       "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", outFile],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (d) => (err += String(d)));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`poster extraction failed (${code}): ${err.slice(-200)}`)),
    );
  });
}
