import sharp from "sharp";
import type { Preset } from "../preset.js";

/**
 * Static assets for the video frame: gradient backdrop (with the card shadow
 * baked in), fake browser bar, and the rounded-corner "hole". All built once
 * and reused for every frame.
 */

const backdropCache = new Map<string, Buffer>();
const holeCache = new Map<string, Buffer>();
const chromeCache = new Map<string, Buffer>();
const maskCache = new Map<string, Buffer>();

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Full backdrop as raw RGB, ready to use as the base canvas. */
export async function getBackdrop(pre: Preset): Promise<Buffer> {
  const hit = backdropCache.get(pre.id);
  if (hit) return hit;

  const gradient = `<svg xmlns="http://www.w3.org/2000/svg" width="${pre.out.w}" height="${pre.out.h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0d1226"/>
        <stop offset="0.5" stop-color="#1b2444"/>
        <stop offset="1" stop-color="#090d1b"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.38" r="0.75">
        <stop offset="0" stop-color="#6366f1" stop-opacity="0.30"/>
        <stop offset="1" stop-color="#6366f1" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect width="100%" height="100%" fill="url(#glow)"/>
  </svg>`;

  const shadow = `<svg xmlns="http://www.w3.org/2000/svg" width="${pre.out.w}" height="${pre.out.h}">
    <rect x="${pre.card.x}" y="${pre.card.y + 20}" width="${pre.card.w}" height="${pre.card.h}"
          rx="${pre.card.radius + 4}" fill="#000000" opacity="0.66"/>
  </svg>`;

  const blurred = await sharp(Buffer.from(shadow)).blur(26).png().toBuffer();

  const out = await sharp(Buffer.from(gradient))
    .composite([{ input: blurred, top: 0, left: 0 }])
    .removeAlpha()
    .raw()
    .toBuffer();

  backdropCache.set(pre.id, out);
  return out;
}

/**
 * A card-sized slice of the backdrop with its middle punched out. Composited
 * last so the card gets rounded corners and its shadow still shows at the
 * edges.
 */
export async function getCardHole(pre: Preset): Promise<Buffer> {
  const hit = holeCache.get(pre.id);
  if (hit) return hit;
  const bd = await getBackdrop(pre);

  const region = await sharp(bd, {
    raw: { width: pre.out.w, height: pre.out.h, channels: 3 },
  })
    .extract({
      left: pre.card.x,
      top: pre.card.y,
      width: pre.card.w,
      height: pre.card.h,
    })
    .png()
    .toBuffer();

  const punch = `<svg xmlns="http://www.w3.org/2000/svg" width="${pre.card.w}" height="${pre.card.h}">
    <rect width="${pre.card.w}" height="${pre.card.h}" rx="${pre.card.radius}" fill="#ffffff"/>
  </svg>`;

  const out = await sharp(region)
    .ensureAlpha()
    .composite([{ input: Buffer.from(punch), blend: "dest-out" }])
    .png()
    .toBuffer();

  holeCache.set(pre.id, out);
  return out;
}

/** Fake browser bar showing the current page URL. */
export async function getChromeBar(url: string, pre: Preset): Promise<Buffer> {
  const key = `${pre.id}|${url}`;
  const cached = chromeCache.get(key);
  if (cached) return cached;

  let shown = url;
  try {
    const u = new URL(url);
    shown = u.host + (u.pathname === "/" ? "" : u.pathname) + (u.search ? u.search : "");
  } catch {
    /* leave it as is */
  }
  if (shown.length > 78) shown = shown.slice(0, 77) + "…";

  const h = pre.chromeH;
  const pillH = h - 15;
  const pillY = 7.5;
  const pillX = 92;
  const pillW = pre.card.w - pillX * 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pre.card.w}" height="${h}">
    <rect width="${pre.card.w}" height="${h}" fill="#20283c"/>
    <circle cx="21" cy="${h / 2}" r="5.5" fill="#ff5f57"/>
    <circle cx="40" cy="${h / 2}" r="5.5" fill="#febc2e"/>
    <circle cx="59" cy="${h / 2}" r="5.5" fill="#28c840"/>
    <rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="#141a2b"/>
    <text x="${pillX + 16}" y="${h / 2 + 4.5}" font-family="${FONT}" font-size="12.5"
          fill="#8ea0c0">${esc(shown)}</text>
  </svg>`;

  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  chromeCache.set(key, buf);
  return buf;
}

/**
 * Mask for the lightbox card: a white rounded rectangle with opacity = k.
 * Used with the "dest-in" blend, so it gives rounded corners and the
 * appear/disappear animation in one go.
 */
export async function getLightboxMask(w: number, h: number, k: number): Promise<Buffer> {
  const kq = Math.round(k * 20) / 20;
  const key = `${w}x${h}@${kq}`;
  const cached = maskCache.get(key);
  if (cached) return cached;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" rx="10" fill="#ffffff" fill-opacity="${kq}"/>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  if (maskCache.size > 200) maskCache.clear();
  maskCache.set(key, buf);
  return buf;
}
