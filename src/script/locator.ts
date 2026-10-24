import type { PageSnapshot, SnapEl } from "../types.js";
import type { ScriptTarget } from "./format.js";

const norm = (s?: string) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Share of words two names have in common, 0..1. */
function overlap(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean));
  const B = new Set(b.split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

/**
 * Score how well a snapshot element matches a recorded target.
 *
 * The name carries most of the weight because it is what survives a
 * redesign; role, tag, type and placeholder settle ties between controls that
 * share a label (a "Sign up" link in the header and a "Sign up" button in the
 * form). Distance to the recorded position is the last tie-breaker only, since
 * layouts move far more often than labels do.
 */
export function scoreElement(el: SnapEl, t: ScriptTarget, viewport: { w: number; h: number }): number {
  let s = 0;
  const tn = norm(t.name);
  const en = norm(el.name);
  if (tn) {
    if (en === tn) s += 10;
    else if (en && (en.includes(tn) || tn.includes(en))) s += 6;
    else s += 5 * overlap(en, tn);
  }
  const tp = norm(t.placeholder);
  if (tp) {
    const ep = norm(el.placeholder);
    if (ep === tp) s += 5;
    else if (ep && (ep.includes(tp) || tp.includes(ep))) s += 3;
  }
  if (t.role && el.role === t.role) s += 2;
  if (t.tag && el.tag === t.tag) s += 1;
  if (t.type && el.type === t.type) s += 2;
  if (t.type === "password" && el.type !== "password") s -= 6;
  if (el.disabled) s -= 1;
  if (t.near) {
    const cx = el.rect.x + el.rect.w / 2;
    const cy = el.rect.y + el.rect.h / 2;
    const d = Math.hypot(cx - t.near.x, cy - t.near.y) / Math.hypot(viewport.w, viewport.h);
    s += 1.5 * (1 - Math.min(1, d * 2));
  }
  return s;
}

/** Below this, an element only resembles the target by accident. */
const MIN_SCORE = 4.5;

export function findTarget(snap: PageSnapshot, t: ScriptTarget): SnapEl | null {
  // A target with neither a name nor a placeholder can only be found by place.
  const byPlaceOnly = !norm(t.name) && !norm(t.placeholder);
  let best: SnapEl | null = null;
  let bestScore = -Infinity;
  for (const el of snap.elements) {
    const sc = scoreElement(el, t, snap.viewport);
    if (sc > bestScore) {
      best = el;
      bestScore = sc;
    }
  }
  if (!best) return null;
  if (byPlaceOnly) return bestScore >= 3 ? best : null;
  return bestScore >= MIN_SCORE ? best : null;
}
