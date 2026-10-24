/**
 * Geometry of one run: recording viewport, video size, and where the card sits.
 *
 * These used to be module constants. That stopped working once there were two
 * output shapes, because one process can record two runs at once: changing a
 * global constant for a mobile run would break the desktop run next to it. So
 * the values travel as an object instead of being read from a module.
 */
import type { DeviceId } from "./types.js";

export type { DeviceId };

export interface Preset {
  id: DeviceId;
  label: string;
  /** page size in CSS px; decides the layout of the site being recorded */
  viewport: { w: number; h: number };
  /** record above 1x so zooming still uses real pixels */
  deviceScale: number;
  out: { w: number; h: number };
  /** the recording card inside the video */
  card: { w: number; h: number; x: number; y: number; radius: number };
  /** height of the fake browser bar; 0 = no bar */
  chromeH: number;
  /** top-left of the content area, below the browser bar */
  screen: { x: number; y: number };
  /** how close the camera may get for this shape */
  zoomMax: number;
}

function build(
  id: DeviceId,
  label: string,
  viewport: { w: number; h: number },
  deviceScale: number,
  out: { w: number; h: number },
  card: { w: number; h: number },
  chromeH: number,
  radius: number,
  zoomMax: number,
): Preset {
  const cardH = card.h + chromeH;
  const x = Math.round((out.w - card.w) / 2);
  const y = Math.round((out.h - cardH) / 2);
  return {
    id,
    label,
    viewport,
    deviceScale,
    out,
    card: { w: card.w, h: cardH, x, y, radius },
    chromeH,
    screen: { x, y: y + chromeH },
    zoomMax,
  };
}

export const PRESETS: Record<DeviceId, Preset> = {
  /**
   * 16:9 for product pages and YouTube. The 3072x1728 source scales down by
   * exactly 2x into the 1536x864 card, so it stays sharp with no extra math.
   */
  desktop: build(
    "desktop",
    "Desktop 16:9",
    { w: 1536, h: 864 },
    2,
    { w: 1920, h: 1080 },
    { w: 1536, h: 864 },
    40,
    14,
    2.4,
  ),

  /**
   * 9:16 for TikTok, Reels and Shorts.
   *
   * No browser bar: inside a phone frame it looks out of place. Corners are
   * rounded generously so it reads as a phone screen.
   *
   * zoomMax is lower than desktop because the screen is already narrow:
   * elements are relatively large, and moving in too far starts upscaling past
   * the real pixels.
   */
  mobile: build(
    "mobile",
    "Mobile 9:16",
    { w: 390, h: 844 },
    3,
    { w: 1080, h: 1920 },
    { w: 780, h: 1688 },
    0,
    38,
    1.8,
  ),
};

export const presetOf = (id: string | undefined | null): Preset =>
  PRESETS[(id as DeviceId) ?? "desktop"] ?? PRESETS.desktop;

/** Scale from page CSS px to card pixels in the video. */
export const cardScale = (p: Preset) => p.card.w / p.viewport.w;
