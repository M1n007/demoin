import type { FrameState } from "./motion.js";
import { easeOutCubic } from "./motion.js";
import { cardScale, type Preset } from "../preset.js";
import * as C from "../config.js";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Cursor arrow shape, box ~11.6 x 19.4, sharp tip exactly at (0,0). */
const CURSOR_PATH =
  "M0,0 L0,17.2 L4.2,13.4 L6.9,19.4 L9.6,18.2 L6.9,12.3 L11.6,12.3 Z";
const CURSOR_NATIVE_H = 19.4;

/** Point in viewport space -> screen pixels (after the zoom crop is resized to VWxVH). */
function toScreen(
  pt: { x: number; y: number },
  zoom: { scale: number; cx: number; cy: number },
  pre: Preset,
) {
  const { w: VW, h: VH } = pre.viewport;
  const k = cardScale(pre); // 1 on desktop, 2 on mobile
  const left = zoom.cx - VW / (2 * zoom.scale);
  const top = zoom.cy - VH / (2 * zoom.scale);
  return {
    x: (pt.x - left) * zoom.scale * k,
    y: (pt.y - top) * zoom.scale * k,
  };
}

/** Lightbox card geometry in screen space. */
export function lightboxCard(state: FrameState, pre: Preset) {
  const lb = state.lightbox;
  if (!lb) return null;
  const VW = pre.card.w;
  const VH = pre.card.h - pre.chromeH;
  const k = cardScale(pre);

  /**
   * Width and magnification are lerped separately while the effect fades, so
   * their product can overshoot even though each state on its own is capped.
   * A card larger than the screen makes compositing fail outright, so its
   * size is clamped here with the aspect ratio kept.
   */
  const fit = Math.min(
    1,
    (VW * C.LIGHTBOX_MAX_W) / Math.max(lb.w * lb.mag * k, 1),
    (VH * C.LIGHTBOX_MAX_H) / Math.max(lb.h * lb.mag * k, 1),
  );
  const w = Math.max(2, Math.min(Math.round(lb.w * lb.mag * fit * k), VW - 8));
  const h = Math.max(2, Math.min(Math.round(lb.h * lb.mag * fit * k), VH - 8));
  return {
    w,
    h,
    x: Math.round((VW - w) / 2),
    y: Math.round((VH - h) / 2),
    src: { x: lb.x, y: lb.y, w: lb.w, h: lb.h },
    // the real magnification after clamping, so the cursor and ripples inside
    // the card stay aligned with its content
    mag: w / Math.max(lb.w, 1),
    k: lb.k,
  };
}

/**
 * Viewport point -> screen, except that when the lightbox is active and the
 * point lies inside the lifted area, it maps into the card (magnified with it).
 */
function place(
  pt: { x: number; y: number },
  state: FrameState,
  pre: Preset,
): { x: number; y: number; scale: number } {
  const card = lightboxCard(state, pre);
  if (card && card.k > 0.5) {
    const inside =
      pt.x >= card.src.x &&
      pt.x <= card.src.x + card.src.w &&
      pt.y >= card.src.y &&
      pt.y <= card.src.y + card.src.h;
    if (inside) {
      return {
        x: card.x + (pt.x - card.src.x) * card.mag,
        y: card.y + (pt.y - card.src.y) * card.mag,
        scale: card.mag,
      };
    }
  }
  const sp = toScreen(pt, state.zoom, pre);
  return { x: sp.x, y: sp.y, scale: state.zoom.scale * cardScale(pre) };
}

/** Dark layer: spotlight + lightbox dimmer. Composited UNDER the lightbox card. */
export function buildDimLayer(state: FrameState, pre: Preset): string | null {
  const VW = pre.card.w;
  const VH = pre.card.h - pre.chromeH;
  const parts: string[] = [];
  const defs: string[] = [];

  if (state.spotlight) {
    const sp = state.spotlight;
    const k = state.zoom.scale * cardScale(pre);
    const c = toScreen(sp, state.zoom, pre);
    const pad = sp.pad * k;

    // The pool of light follows the element's shape. A circle never fits: on
    // a wide input field its left and right ends always stay in the dark
    // while the middle is bright.
    // The minimum size applies to the pool, not to the element. If the
    // element is inflated instead, a 50px tall input turns into a 150px box
    // and again half the light falls on empty space.
    const minSide = C.SPOT_MIN_SIZE * Math.max(k, 1);
    const w = Math.max(sp.w * k + pad * 2, minSide);
    const h = Math.max(sp.h * k + pad * 2, minSide);
    const x = c.x - w / 2;
    const y = c.y - h / 2;
    const rx = Math.min(w / 2, h / 2, C.SPOT_CORNER_MAX * Math.max(k, 1));
    const blur = Math.max(6, pad * 0.62);
    const dim = (C.SPOT_DIM * sp.k).toFixed(3);
    const box = (grow: number, extra = "") =>
      `<rect x="${(x - grow).toFixed(1)}" y="${(y - grow).toFixed(1)}" width="${(w + grow * 2).toFixed(1)}" height="${(h + grow * 2).toFixed(1)}" rx="${(rx + grow).toFixed(1)}" ${extra}/>`;

    // The hole is blurred through a mask, so its edge is soft without needing
    // a gradient that has already faded long before the element's edge.
    defs.push(
      `<filter id="spotblur" x="-50%" y="-50%" width="200%" height="200%">
         <feGaussianBlur stdDeviation="${blur.toFixed(1)}"/>
       </filter>
       <mask id="spotmask">
         <rect width="${VW}" height="${VH}" fill="#ffffff"/>
         <g filter="url(#spotblur)">${box(0, 'fill="#000000"')}</g>
       </mask>`,
    );
    parts.push(
      `<rect width="${VW}" height="${VH}" fill="#04060d" opacity="${dim}" mask="url(#spotmask)"/>`,
    );

    // On a UI that is already dark, dimming the surroundings alone is barely
    // readable. A thin rim marks the edge of the pool without washing out
    // what is inside it.
    defs.push(
      `<filter id="rimblur" x="-50%" y="-50%" width="200%" height="200%">
         <feGaussianBlur stdDeviation="${(blur * 0.42).toFixed(1)}"/>
       </filter>`,
    );
    parts.push(
      `<g filter="url(#rimblur)">${box(
        0,
        `fill="none" stroke="#ffffff" stroke-opacity="${(0.3 * sp.k).toFixed(3)}" stroke-width="${Math.max(1.5, 1.6 * Math.max(k, 1)).toFixed(1)}"`,
      )}</g>`,
    );
  }

  const card = lightboxCard(state, pre);
  if (card) {
    const dim = (C.LIGHTBOX_DIM * card.k).toFixed(3);
    parts.push(`<rect width="${VW}" height="${VH}" fill="#05070f" opacity="${dim}"/>`);
  }

  if (!parts.length) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${VH}">
    <defs>${defs.join("")}</defs>${parts.join("")}</svg>`;
}

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'SF Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace";

const escapeXml = (t: string) =>
  t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Line wrapping is estimated from character counts, not measured. librsvg
 * offers no text measurement, and loading a font engine just for this is too
 * expensive to run every frame. The average glyph width at this size is
 * stable enough, and the box is given some slack.
 */
function wrap(
  text: string,
  maxWidth: number,
  fontSize: number,
  maxLines = 3,
): string[] {
  const perChar = fontSize * 0.52;
  const maxChars = Math.max(16, Math.floor(maxWidth / perChar));
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last.length > maxChars) lines[maxLines - 1] = last.slice(0, maxChars - 1) + "…";
  }
  return lines.slice(0, maxLines);
}

/**
 * Step caption, attached near the element being touched.
 *
 * Placed below the element when it fits, otherwise above it, and shifted so
 * it doesn't leave the frame. The little pointer is what makes "this sentence
 * is about that thing" readable without explanation.
 */
function buildCallout(state: FrameState, pre: Preset): string {
  const co = state.callout;
  if (!co) return "";
  const VW = pre.card.w;
  const VH = pre.card.h - pre.chromeH;
  const k = co.k.toFixed(3);

  const a = co.anchor;
  const tl = a ? place({ x: a.x, y: a.y }, state, pre) : null;
  const br = a ? place({ x: a.x + a.w, y: a.y + a.h }, state, pre) : null;
  // A scroll step points at nothing, so its bubble stands alone at the bottom
  // centre with no ring and no tail.
  const box =
    tl && br
      ? {
          x: Math.min(tl.x, br.x),
          y: Math.min(tl.y, br.y),
          w: Math.abs(br.x - tl.x),
          h: Math.abs(br.y - tl.y),
        }
      : null;

  // A ring on the element. A bubble alone makes the viewer read the sentence
  // and then ask "which one", because a sentence points at nothing. The ring
  // answers that, and stays readable on light and dark sites alike.
  const pad = C.RING_PAD;
  const rx = box
    ? { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
    : null;
  const rr = rx ? Math.min(16, rx.h / 2, rx.w / 2) : 0;
  const ring =
    rx && rx.w > 4 && rx.h > 4
      ? `<g opacity="${k}">
           <rect x="${(rx.x - 3).toFixed(1)}" y="${(rx.y - 3).toFixed(1)}"
                 width="${(rx.w + 6).toFixed(1)}" height="${(rx.h + 6).toFixed(1)}"
                 rx="${(rr + 3).toFixed(1)}" fill="none"
                 stroke="#ffffff" stroke-opacity="0.75" stroke-width="${C.RING_W + 4}"/>
           <rect x="${rx.x.toFixed(1)}" y="${rx.y.toFixed(1)}"
                 width="${rx.w.toFixed(1)}" height="${rx.h.toFixed(1)}"
                 rx="${rr.toFixed(1)}" fill="none"
                 stroke="#0e1220" stroke-opacity="0.95" stroke-width="${C.RING_W}"/>
         </g>`
      : "";

  const lines = wrap(
    co.text,
    C.CALLOUT_MAX_W - C.CALLOUT_PAD_X * 2,
    C.CALLOUT_FONT,
    C.CALLOUT_MAX_LINES,
  );
  const textW = Math.min(
    C.CALLOUT_MAX_W,
    Math.max(260, ...lines.map((l) => l.length * C.CALLOUT_FONT * 0.54)) +
      C.CALLOUT_PAD_X * 2,
  );
  // Extra room at the bottom for the step number, so it doesn't overlap the
  // last line of the sentence.
  const textH = lines.length * C.CALLOUT_LINE + C.CALLOUT_PAD_Y * 2 + 16;

  const gap = C.CALLOUT_GAP + pad;
  const cx = box ? box.x + box.w / 2 : VW / 2;
  const bx = clamp(cx - textW / 2, 14, Math.max(14, VW - textW - 14));
  const below = rx ? rx.y + rx.h + gap + textH < VH - 14 : false;
  const by = rx
    ? below
      ? rx.y + rx.h + gap
      : Math.max(14, rx.y - gap - textH)
    : VH - textH - 34;

  // little pointer towards the element
  const px = clamp(cx, bx + 24, bx + textW - 24);
  const tip = !rx
    ? ""
    : below
      ? `M${px - 10},${by} L${px},${by - 11} L${px + 10},${by} Z`
      : `M${px - 10},${by + textH} L${px},${by + textH + 11} L${px + 10},${by + textH} Z`;

  const rows = lines
    .map(
      (l, i) =>
        `<text x="${bx + C.CALLOUT_PAD_X}" y="${by + C.CALLOUT_PAD_Y + C.CALLOUT_FONT + i * C.CALLOUT_LINE}"
           font-family="${FONT}" font-size="${C.CALLOUT_FONT}" fill="#f4f6fa">${escapeXml(l)}</text>`,
    )
    .join("");

  return `${ring}
  <g opacity="${k}">
    ${tip ? `<path d="${tip}" fill="#0e1220"/>` : ""}
    <rect x="${bx}" y="${by}" width="${textW}" height="${textH}" rx="16"
          fill="#0e1220" stroke="#ffffff" stroke-opacity="0.16"/>
    ${rows}
    <text x="${bx + textW - C.CALLOUT_PAD_X}" y="${by + textH - 12}" text-anchor="end"
          font-family="${MONO}" font-size="14" fill="#5c6377">${co.step}/${co.total}</text>
  </g>`;
}

/** Top layer: click ripples + cursor. */
export function buildFxLayer(
  state: FrameState,
  pre: Preset,
  /**
   * A finger, not an arrow. Inside a phone frame an arrow cursor looks like a
   * desktop recording forced onto a phone; a touch dot that shrinks when
   * pressed reads as "tapped" straight away.
   */
  opts: { touch?: boolean } = {},
): string | null {
  const VW = pre.card.w;
  const VH = pre.card.h - pre.chromeH;
  const parts: string[] = [];

  for (const rip of state.ripples) {
    const pos = place(rip, state, pre);
    const e = easeOutCubic(rip.p);
    const alpha = 1 - rip.p;
    const r = (11 + 30 * e) * Math.min(pos.scale, 2.4);
    parts.push(
      `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${r.toFixed(1)}"
         fill="#6366f1" fill-opacity="${(0.2 * alpha).toFixed(3)}"
         stroke="#0b1020" stroke-opacity="${(0.45 * alpha).toFixed(3)}" stroke-width="4.5"/>`,
      `<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="${r.toFixed(1)}"
         fill="none" stroke="#ffffff" stroke-opacity="${(0.95 * alpha).toFixed(3)}" stroke-width="2.2"/>`,
    );
  }

  const cur = place(state.cursor, state, pre);
  // shrinks a little right at the moment of pressing
  const pressing = state.ripples.some((r) => r.p < 0.28);
  const scale = (C.CURSOR_SIZE / CURSOR_NATIVE_H) * (pressing ? 0.88 : 1);
  const t = (dx: number, dy: number) =>
    `translate(${(cur.x + dx).toFixed(1)},${(cur.y + dy).toFixed(1)}) scale(${scale.toFixed(3)})`;

  parts.push(buildCallout(state, pre));

  if (opts.touch) {
    const r = C.CURSOR_SIZE * 0.62 * (pressing ? 0.8 : 1);
    parts.push(
      `<circle cx="${cur.x.toFixed(1)}" cy="${cur.y.toFixed(1)}" r="${(r + 3).toFixed(1)}" fill="#000000" fill-opacity="0.12"/>`,
      `<circle cx="${cur.x.toFixed(1)}" cy="${cur.y.toFixed(1)}" r="${r.toFixed(1)}" fill="#ffffff" fill-opacity="${pressing ? 0.75 : 0.55}" stroke="#1b2233" stroke-opacity="0.35" stroke-width="2"/>`,
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${VH}">${parts.join("")}</svg>`;
  }

  parts.push(
    `<g transform="${t(1.5, 2.5)}" opacity="0.32"><path d="${CURSOR_PATH}" fill="#000000"/></g>`,
    `<g transform="${t(0, 0)}"><path d="${CURSOR_PATH}" fill="#ffffff" stroke="#1b2233" stroke-width="1.1" stroke-linejoin="round"/></g>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VW}" height="${VH}">${parts.join("")}</svg>`;
}
