import { spawn } from "node:child_process";
import path from "node:path";

export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg";

/** ffprobe next to the configured ffmpeg, so one env var is enough. */
export const ffprobePath = () => {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const ff = process.env.FFMPEG_PATH;
  return ff ? path.join(path.dirname(ff), path.basename(ff).replace(/ffmpeg/, "ffprobe")) : "ffprobe";
};

export function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${bin} not found. Install ffmpeg or set FFMPEG_PATH.`)
          : e,
      ),
    );
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-800)}`)),
    );
  });
}

export async function probeDurationMs(file: string): Promise<number> {
  const out = await run(ffprobePath(), [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const s = Number(out.trim());
  if (!Number.isFinite(s)) throw new Error(`Could not read the duration of ${file}`);
  return Math.round(s * 1000);
}
