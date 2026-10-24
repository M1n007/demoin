import { promises as fs } from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright-core";
import type { FrameRef } from "../types.js";
import type { Preset } from "../preset.js";

/**
 * Records the screen through CDP `Page.startScreencast`.
 *
 * Important: frames are only sent when the page repaints. While the page is
 * still, no new frames arrive at all; the compositor handles that by using
 * the last frame whose time is <= t.
 */
export class Recorder {
  private cdp: CDPSession | null = null;
  private frames: FrameRef[] = [];
  private writes: Promise<unknown>[] = [];
  private seq = 0;
  private t0 = 0;
  private stopped = true;
  /** raw frame width in pixels, used to work out the real scale factor */
  frameWidth: number;
  frameHeight: number;
  /** the last frame received, for the agent's "eyes"; never touches the page at all */
  private last: { data: string; at: number } | null = null;

  constructor(
    private page: Page,
    private dir: string,
    private preset: Preset,
  ) {
    this.frameWidth = preset.viewport.w * preset.deviceScale;
    this.frameHeight = preset.viewport.h * preset.deviceScale;
  }

  now(): number {
    return this.t0 ? Date.now() - this.t0 : 0;
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.t0 = Date.now();
    this.stopped = false;

    this.cdp.on("Page.screencastFrame", (ev) => {
      const { data, sessionId, metadata } = ev as {
        data: string;
        sessionId: number;
        metadata?: { timestamp?: number; deviceWidth?: number; deviceHeight?: number };
      };

      // ack first so the stream does not stall
      this.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (this.stopped) return;

      // metadata.timestamp = seconds since epoch, more accurate than arrival time
      const wall = metadata?.timestamp ? metadata.timestamp * 1000 : Date.now();
      const t = Math.max(0, Math.round(wall - this.t0));

      const file = `${String(this.seq++).padStart(6, "0")}.jpg`;
      this.frames.push({ file, t });
      this.last = { data, at: Date.now() };
      this.writes.push(
        fs.writeFile(path.join(this.dir, file), Buffer.from(data, "base64")),
      );
    });

    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      // High on purpose: this is the only image source, and JPEG artefacts on
      // text cannot be fixed at any later stage. Frames on disk get bigger,
      // but they are temporary.
      quality: 94,
      maxWidth: this.frameWidth,
      maxHeight: this.frameHeight,
      everyNthFrame: 1,
    });
  }

  /**
   * The screencast only sends frames when the page repaints. If the page is
   * completely still, the frame stream stops and the timeline gets coarse.
   * This practically invisible 1px square is used to force periodic repaints.
   */
  async tick() {
    if (this.stopped) return;
    try {
      await this.page.evaluate(() => {
        const ID = "__demoin_tick";
        let el = document.getElementById(ID);
        if (!el) {
          el = document.createElement("div");
          el.id = ID;
          el.style.cssText =
            "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.02;pointer-events:none;z-index:2147483647";
          document.documentElement.appendChild(el);
        }
        el.style.backgroundColor =
          el.style.backgroundColor === "rgb(255, 0, 0)" ? "rgb(0, 0, 255)" : "rgb(255, 0, 0)";
      });
    } catch {
      /* the page may be navigating */
    }
  }

  /**
   * The most recent screen image, raw JPEG.
   *
   * Taken from the screencast stream that is already running, not from
   * page.screenshot: taking another picture can trigger a repaint and disturb
   * the recording. A repaint is forced first so what comes back is not a stale
   * frame.
   */
  async latest(maxAgeMs = 600): Promise<Buffer | null> {
    if (this.stopped) return null;
    const before = this.last?.at ?? 0;
    await this.tick();
    const until = Date.now() + maxAgeMs;
    while (Date.now() < until && (this.last?.at ?? 0) <= before) await new Promise((r) => setTimeout(r, 40));
    return this.last ? Buffer.from(this.last.data, "base64") : null;
  }

  async stop(): Promise<{ frames: FrameRef[]; durationMs: number }> {
    if (this.stopped) return { frames: this.frames, durationMs: 0 };
    this.stopped = true;
    const durationMs = this.now();
    try {
      await this.cdp?.send("Page.stopScreencast");
    } catch {
      /* the page may already be closed */
    }
    await Promise.allSettled(this.writes);
    try {
      await this.cdp?.detach();
    } catch {
      /* ignore */
    }
    this.frames.sort((a, b) => a.t - b.t);
    await fs.writeFile(
      path.join(this.dir, "frames.json"),
      JSON.stringify(this.frames),
    );
    return { frames: this.frames, durationMs };
  }
}
