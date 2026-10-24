import path from "node:path";
import sharp from "sharp";
import type { Preset } from "../preset.js";
import type { FrameRef, Rect, TimelineEvent } from "../types.js";

/**
 * Finds the part of the screen that CHANGED because of an action.
 *
 * This is what separates a useful demo video from one that merely follows the
 * cursor. In apps with a live preview the button sits in the left panel while
 * its effect shows up in the right panel. A camera that only closes in on the
 * button produces a video of someone pressing things without the viewer ever
 * seeing what changed.
 *
 * Read from the frames themselves, not from the DOM, because what matters to
 * the viewer is what looks different, not which attribute changed.
 */

/** Working width for the comparison. Tiny, and that is genuinely enough. */
const W = 160;
/** Brightness difference (out of 255) that counts as a real change. */
const DIFF = 14;
/** Smallest share of the screen worth treating as a change rather than noise. */
const MIN_SHARE = 0.0015;

function frameAt(frames: FrameRef[], t: number): FrameRef | null {
  if (!frames.length) return null;
  let pick = frames[0];
  for (const f of frames) {
    if (f.t <= t) pick = f;
    else break;
  }
  return pick;
}

export async function annotateChanges(
  events: TimelineEvent[],
  frames: FrameRef[],
  framesDir: string,
  preset: Preset,
): Promise<TimelineEvent[]> {
  const H = Math.max(1, Math.round((W * preset.viewport.h) / preset.viewport.w));
  const cache = new Map<string, Buffer>();

  const small = async (file: string) => {
    const hit = cache.get(file);
    if (hit) return hit;
    const buf = await sharp(path.join(framesDir, file))
      .resize(W, H, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    cache.set(file, buf);
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
    return buf;
  };

  for (const e of events) {
    if (!e.ok || !e.target) continue;
    // Before the action runs, and after the page has settled again.
    const a = frameAt(frames, e.actAt - 140);
    const b = frameAt(frames, e.actEnd - 40);
    if (!a || !b || a.file === b.file) continue;

    let ia: Buffer;
    let ib: Buffer;
    try {
      [ia, ib] = [await small(a.file), await small(b.file)];
    } catch {
      continue;
    }
    if (ia.length !== ib.length) continue;

    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(ia[i] - ib[i]) < DIFF) continue;
        count++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0 || count / (W * H) < MIN_SHARE) continue;

    const sx = preset.viewport.w / W;
    const sy = preset.viewport.h / H;
    const change: Rect = {
      x: x0 * sx,
      y: y0 * sy,
      w: (x1 - x0 + 1) * sx,
      h: (y1 - y0 + 1) * sy,
    };

    /**
     * A change that only sits on the target itself is ignored.
     *
     * Pressing a button always changes its own colour. If that counted, every
     * action would seem to have an effect elsewhere and the camera would
     * never close in on anything.
     */
    const t = e.target;
    const inside =
      change.x >= t.x - 24 &&
      change.y >= t.y - 24 &&
      change.x + change.w <= t.x + t.w + 24 &&
      change.y + change.h <= t.y + t.h + 24;
    if (inside) continue;

    e.changed = change;
  }

  return events;
}

/**
 * How much of the screen changed between before the action and after the page
 * settled, as a share of the whole screen (0 to 1).
 *
 * Used to make sure a step really was a no-op before it is cut from the video.
 * An unchanged DOM alone isn't enough: a pure-CSS checkbox can change how it
 * looks without any attribute changing.
 */
export async function changedRegion(
  e: TimelineEvent,
  frames: FrameRef[],
  framesDir: string,
  preset: Preset,
): Promise<number> {
  const H = Math.max(1, Math.round((W * preset.viewport.h) / preset.viewport.w));
  const a = frameAt(frames, e.actAt - 140);
  const b = frameAt(frames, e.actEnd - 40);
  if (!a || !b) return 1;
  if (a.file === b.file) return 0;
  const small = (file: string) =>
    sharp(path.join(framesDir, file)).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  try {
    const [ia, ib] = [await small(a.file), await small(b.file)];
    if (ia.length !== ib.length) return 1;
    let n = 0;
    for (let i = 0; i < ia.length; i++) if (Math.abs(ia[i] - ib[i]) >= DIFF) n++;
    return n / ia.length;
  } catch {
    return 1;
  }
}
