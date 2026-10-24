import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PageSnapshot } from "../types.js";

/**
 * The agent's eyes: a screenshot marked with element numbers.
 *
 * An element list in text says nothing about layout. The agent cannot tell
 * which button is big and prominent, which menu sits on the side, or which
 * dialog covers what. With an image where every element carries the same ref
 * label as the text list ("set of marks"), the model can see the page the way
 * a human does and point with the right ref.
 *
 * This image is only sent to the model; the video recording is untouched.
 */
const OUT_W = 1280;

const COLORS: Record<string, string> = {
  field: "#0c9466",
  button: "#2236f5",
  link: "#d6337f",
  other: "#b07800",
};

export async function annotate(jpeg: Buffer, snap: PageSnapshot): Promise<string | null> {
  try {
    const img = await loadImage(jpeg);
    const k = OUT_W / img.width;
    const H = Math.round(img.height * k);
    const c = createCanvas(OUT_W, H);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, OUT_W, H);
    // element rects are in viewport CSS px; the image is viewport width x device scale
    const s = OUT_W / snap.viewport.w;
    g.font = "bold 13px sans-serif";
    g.textBaseline = "top";
    for (const e of snap.elements) {
      if (!e.inView) continue;
      const kind = ["input", "textarea", "select"].includes(e.tag)
        ? "field"
        : e.tag === "a"
          ? "link"
          : e.tag === "button" || e.role === "button" || e.role === "tab"
            ? "button"
            : "other";
      const col = COLORS[kind];
      const x = e.rect.x * s;
      const y = e.rect.y * s;
      const w = Math.max(6, e.rect.w * s);
      const h = Math.max(6, e.rect.h * s);
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.strokeRect(x, y, w, h);
      const label = e.ref;
      const tw = g.measureText(label).width + 8;
      const lx = Math.min(OUT_W - tw, Math.max(0, x));
      const ly = y >= 17 ? y - 17 : Math.min(H - 17, y + h);
      g.fillStyle = col;
      g.fillRect(lx, ly, tw, 17);
      g.fillStyle = "#ffffff";
      g.fillText(label, lx + 4, ly + 2);
    }
    const out = await c.encode("jpeg", 72);
    return Buffer.from(out).toString("base64");
  } catch {
    return null;
  }
}
