import type { Point, Rect, TimelineEvent } from "../types.js";
import type { Preset } from "../preset.js";
import * as C from "../config.js";

export function easeInOutCubic(p: number) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}
export function easeOutCubic(p: number) {
  return 1 - Math.pow(1 - p, 3);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/**
 * Slice of output time -> source time. Inside one segment the mapping is 1:1;
 * "dead time" (waiting for loads, the agent thinking) is dropped by cutting
 * between segments.
 */
export interface Seg {
  outStart: number;
  outLen: number;
  srcStart: number;
  /** Playback speed of this segment: 1 = as recorded, 2.5 = sped up. */
  rate?: number;
}

/** Camera + effect state at one point in time. Everything is lerped. */
interface Vec {
  zScale: number;
  zCx: number;
  zCy: number;
  spotK: number;
  spotX: number;
  spotY: number;
  spotW: number;
  spotH: number;
  /** safe margin around the box */
  spotR: number;
  lbK: number;
  lbX: number;
  lbY: number;
  lbW: number;
  lbH: number;
  lbMag: number;
}

interface StateSpan {
  tStart: number;
  vec: Vec;
  /** how long the transition from the previous state into this one takes */
  fade: number;
  /**
   * Where the camera ACTUALLY is when this state begins.
   *
   * Without this, a transition cut off halfway makes the next transition
   * start from the previous state's stored value instead of from where the
   * camera really was. The camera then jumps first and moves smoothly after,
   * and that jump is what looks rough.
   */
  from?: Vec;
}

export interface Ripple {
  t: number;
  x: number;
  y: number;
}

export interface Callout {
  tStart: number;
  tEnd: number;
  text: string;
  step: number;
  total: number;
  /** box of the element it points at, viewport space. Empty for scroll. */
  anchor?: Rect;
}

export interface FrameState {
  zoom: { scale: number; cx: number; cy: number };
  spotlight:
    | { x: number; y: number; w: number; h: number; pad: number; k: number }
    | null;
  lightbox: { x: number; y: number; w: number; h: number; mag: number; k: number } | null;
  cursor: Point;
  ripples: { x: number; y: number; p: number }[];
  callout:
    | { text: string; step: number; total: number; anchor?: Rect; k: number }
    | null;
}

export interface RenderPlan {
  preset: Preset;
  durationMs: number;
  segs: Seg[];
  states: StateSpan[];
  cursorKeys: { t: number; x: number; y: number }[];
  ripples: Ripple[];
  callouts: Callout[];
  /** narration per step in output time, used for chapters in the UI */
  chapters: Chapter[];
}

/** One successful step in output time. */
export interface Chapter {
  /** the cursor starts moving */
  t: number;
  narration: string;
  effect: string;
  kind?: string;
  /** when the click or typing happens */
  tAct?: number;
  /** when the part worth watching ends */
  tEnd?: number;
}

function neutralOf(p: Preset): Vec {
  const { w: VW, h: VH } = p.viewport;
  return {
    zScale: 1,
    zCx: VW / 2,
    zCy: VH / 2,
    spotK: 0,
    spotX: VW / 2,
    spotY: VH / 2,
    spotW: C.SPOT_MIN_SIZE,
    spotH: C.SPOT_MIN_SIZE,
    spotR: C.SPOT_PAD_MIN,
    lbK: 0,
    lbX: VW / 2,
    lbY: VH / 2,
    lbW: 200,
    lbH: 120,
    lbMag: 1.6,
  };
}

// ---------------------------------------------------------------------------
// Time map
// ---------------------------------------------------------------------------

function buildTimeMap(
  events: TimelineEvent[],
  recDuration: number,
  /**
   * Something is being read or heard (captions, voiceover), so the pause
   * before each action is kept.
   */
  hold = false,
): Seg[] {
  const segs: Seg[] = [];
  let out = 0;

  const push = (srcStart: number, len: number) => {
    if (len <= 1) return;
    const outLen = Math.round(len);
    if (outLen <= 1) return;
    segs.push({ outStart: out, outLen, srcStart });
    out += outLen;
  };
  /** Keep only the TAIL of the range [a,b], the part where the page has settled. */
  const pushTail = (a: number, b: number, cap: number) => {
    const len = clamp(b - a, 0, cap);
    push(b - len, len);
  };

  if (!events.length) {
    push(0, Math.min(recDuration, 6000));
    return segs;
  }

  pushTail(0, events[0].moveStart, C.INTRO_MS);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    /**
     * The pause in front of the action: the cursor has arrived, but the click
     * hasn't happened yet.
     *
     * This pause is only useful when there is a sentence being read on
     * screen. Without captions, what the viewer sees is a cursor parked on a
     * button for a few seconds before it clicks, and that feels like the
     * video froze. Only the arrival and the moment right before the click
     * are kept.
     */
    const arrive = C.CURSOR_TRAVEL_MS + 160;
    let start = e.moveStart;
    if (!hold && e.cursorTo && e.actAt - e.moveStart > arrive + 420) {
      push(e.moveStart, arrive);
      start = e.actAt - 260;
    }
    push(start, e.visualEnd - start);
    /**
     * Tail after the action. Actions that MOVE to another page get a longer
     * tail, because that is where the new page appears and the viewer needs
     * to see it whole before the camera closes in on the next target.
     */
    const changedPage = Boolean(e.urlBefore && e.url && e.urlBefore !== e.url);
    pushTail(e.visualEnd, e.actEnd, changedPage ? C.KEEP_AFTER_NAV_MS : C.KEEP_SETTLE_MS);
    // the agent is thinking, cut more aggressively
    const next = events[i + 1];
    pushTail(
      e.actEnd,
      next ? next.moveStart : recDuration,
      next ? C.KEEP_THINK_MS : C.OUTRO_MS,
    );
  }
  return segs;
}

export function srcAt(segs: Seg[], t: number): number {
  if (!segs.length) return t;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].outStart <= t) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  return s.srcStart + clamp(t - s.outStart, 0, s.outLen) * (s.rate ?? 1);
}

/** Inverse of srcAt. Source time that was cut is clamped to the nearest segment edge. */
export function outAt(segs: Seg[], src: number): number {
  for (const s of segs) {
    const r = s.rate ?? 1;
    if (src < s.srcStart) return s.outStart;
    if (src <= s.srcStart + s.outLen * r) return s.outStart + (src - s.srcStart) / r;
  }
  const last = segs[segs.length - 1];
  return last ? last.outStart + last.outLen : 0;
}

// ---------------------------------------------------------------------------
// State per step
// ---------------------------------------------------------------------------

/** Camera at a given scale, centred on rect without leaving the frame. */
function centeredOn(
  rect: Rect,
  zScale: number,
  p: Preset,
): Pick<Vec, "zScale" | "zCx" | "zCy"> {
  const { w: VW, h: VH } = p.viewport;
  const halfW = VW / (2 * zScale);
  const halfH = VH / (2 * zScale);
  return {
    zScale,
    zCx: clamp(rect.x + rect.w / 2, halfW, VW - halfW),
    zCy: clamp(rect.y + rect.h / 2, halfH, VH - halfH),
  };
}

function zoomScaleFor(rect: Rect, p: Preset): number {
  const { w: VW, h: VH } = p.viewport;
  const byHeight = (VH * C.ZOOM_TARGET_HEIGHT) / Math.max(rect.h, 1);
  const widthCap = (VW * C.ZOOM_WIDTH_ALLOWANCE) / Math.max(rect.w, 1);
  return clamp(Math.min(byHeight, widthCap), C.ZOOM_MIN, p.zoomMax);
}

function zoomVec(rect: Rect, p: Preset): Pick<Vec, "zScale" | "zCx" | "zCy"> {
  return centeredOn(rect, zoomScaleFor(rect, p), p);
}

/** Lightbox geometry, or null when the target is too large to lift out. */
function lightboxGeom(rect: Rect, p: Preset) {
  const { w: VW, h: VH } = p.viewport;
  const x = clamp(rect.x - C.LIGHTBOX_PAD, 0, VW);
  const y = clamp(rect.y - C.LIGHTBOX_PAD, 0, VH);
  const w = clamp(rect.w + C.LIGHTBOX_PAD * 2, 24, VW - x);
  const h = clamp(rect.h + C.LIGHTBOX_PAD * 2, 24, VH - y);
  const mag = Math.min((VW * C.LIGHTBOX_MAX_W) / w, (VH * C.LIGHTBOX_MAX_H) / h);
  if (mag < C.LIGHTBOX_MIN_MAG) return null; // too large, use zoom instead
  return { x, y, w, h, mag };
}

/** Smallest box that holds both. */
function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function vecFor(e: TimelineEvent, prev: Vec, p: Preset): Vec {
  const NEUTRAL = neutralOf(p);
  const rect = e.target;
  // "press" keeps the previous step's highlight so it doesn't flicker
  if (e.kind === "press" && e.effect === "none") return prev;
  if (!rect || e.effect === "none") return NEUTRAL;

  if (e.effect === "spotlight") {
    const soft = clamp(
      1 + (zoomScaleFor(rect, p) - 1) * C.SPOT_ZOOM_FACTOR,
      1,
      C.SPOT_ZOOM_MAX,
    );
    return {
      ...NEUTRAL,
      ...centeredOn(rect, soft, p),
      spotK: 1,
      // The centre comes from the element. The cursor lands anywhere inside
      // the button, and light that follows the cursor leaves the far side of
      // the element in the dark.
      spotX: rect.x + rect.w / 2,
      spotY: rect.y + rect.h / 2,
      spotW: rect.w,
      spotH: rect.h,
      spotR: clamp(
        Math.min(rect.w, rect.h) * 0.45,
        C.SPOT_PAD_MIN,
        C.SPOT_PAD_MAX,
      ),
    };
  }

  if (e.effect === "lightbox") {
    const g = lightboxGeom(rect, p);
    if (g) {
      return { ...NEUTRAL, lbK: 1, lbX: g.x, lbY: g.y, lbW: g.w, lbH: g.h, lbMag: g.mag };
    }
    // target too large for a lightbox, fall back to zoom
  }

  /**
   * The frame uses the visual container so the card or form shows whole.
   *
   * BUT a large container gives no close-up at all: fitting a card half the
   * screen tall means the scale drops to 1, and the video ends without a
   * single camera move even though every step asked for zoom. When the
   * container is that big, the element itself is what gets approached.
   */
  /**
   * When the action changes something elsewhere, the frame has to hold both:
   * what was pressed and what changed. That is the difference between a video
   * that shows the effect and one that only shows someone pressing things.
   */
  const base = e.frame ?? rect;

  /**
   * There is an effect elsewhere: the frame holds both, however wide.
   *
   * There must be NO fallback to the element here. If the union is as wide as
   * the screen, the answer really is the full view, and that is the point:
   * the viewer needs to see what changed, not the button that was pressed.
   */
  if (e.changed) {
    const both = unionRect(base, e.changed);
    return { ...NEUTRAL, ...centeredOn(both, zoomScaleFor(both, p), p) };
  }

  // No effect elsewhere. Use the container when it still gives a close-up
  // that can be felt; otherwise approach the element itself.
  const containerScale = zoomScaleFor(base, p);
  if (containerScale >= 1.15) {
    return { ...NEUTRAL, ...centeredOn(base, containerScale, p) };
  }
  return { ...NEUTRAL, ...zoomVec(rect, p) };
}

/**
 * Whether the next target is still visible inside the current frame.
 *
 * If so, the camera only needs to pan. Forcing a pull back to the full view
 * for two neighbouring elements (email then password) feels restless and
 * wastes watch time. Pulling back only helps when the next destination really
 * can't be seen from here, because that is when the viewer needs orienting.
 */
function nextStaysInFrame(
  vec: Vec,
  cur: TimelineEvent,
  next: TimelineEvent | undefined,
  p: Preset,
): boolean {
  const { w: VW, h: VH } = p.viewport;
  if (!next?.ok || !next.target) return false;
  // page change or a different highlight type: the viewer needs the whole view first
  // Compare the page AFTER this action with the page BEFORE the next action.
  // If they differ there was a navigation in between, and the coordinates
  // can't be compared.
  if ((next.urlBefore ?? next.url) !== cur.url) return false;
  // This action itself moved to another page: the whole screen changes while
  // the camera is still hugging the old position. Without pulling back first
  // the highlight stays on the spot where the button used to be, which on the
  // new page is just empty space.
  if (cur.urlBefore && cur.urlBefore !== cur.url) return false;
  if (next.effect !== cur.effect) return false;
  if (vec.zScale <= 1.01) return false;

  const halfW = VW / (2 * vec.zScale);
  const halfH = VH / (2 * vec.zScale);
  const m = 16; // leave breathing room at the edge, don't hug it
  const r = next.target;
  return (
    r.x >= vec.zCx - halfW + m &&
    r.x + r.w <= vec.zCx + halfW - m &&
    r.y >= vec.zCy - halfH + m &&
    r.y + r.h <= vec.zCy + halfH - m
  );
}

/** When an effect turns off its geometry is inherited, so it fades out in place. */
function inheritGeometry(v: Vec, prev: Vec): Vec {
  const out = { ...v };
  if (v.spotK === 0) {
    out.spotX = prev.spotX;
    out.spotY = prev.spotY;
    out.spotW = prev.spotW;
    out.spotH = prev.spotH;
    out.spotR = prev.spotR;
  }
  if (v.lbK === 0) {
    out.lbX = prev.lbX;
    out.lbY = prev.lbY;
    out.lbW = prev.lbW;
    out.lbH = prev.lbH;
    out.lbMag = prev.lbMag;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function buildRenderPlan(
  events: TimelineEvent[],
  recDuration: number,
  preset: Preset,
  opts: {
    captions?: boolean;
    /**
     * Keep the pause between the cursor arriving and the action 1:1, e.g.
     * because a voiceover line is playing over it. Captions imply this.
     */
    holdBeforeAction?: boolean;
  } = {},
): RenderPlan {
  const captions = opts.captions ?? C.CALLOUT;
  const NEUTRAL = neutralOf(preset);
  const { w: VW, h: VH } = preset.viewport;
  const segs = buildTimeMap(events, recDuration, captions || Boolean(opts.holdBeforeAction));
  const last = segs[segs.length - 1];
  const durationMs = last ? last.outStart + last.outLen : 0;

  const states: StateSpan[] = [{ tStart: 0, vec: NEUTRAL, fade: 1 }];
  const cursorKeys: { t: number; x: number; y: number }[] = [];
  const ripples: Ripple[] = [];
  const callouts: Callout[] = [];
  const chapters: Chapter[] = [];

  let prevVec = NEUTRAL;
  let cursor: Point = { x: VW * 0.72, y: VH * 0.84 };
  cursorKeys.push({ t: 0, ...cursor });

  const live = events.filter((e) => e.ok);
  for (let i = 0; i < live.length; i++) {
    const e = live[i];
    const tMove = outAt(segs, e.moveStart);
    const tAct = outAt(segs, e.actAt);
    const tVisEnd = outAt(segs, e.visualEnd);

    // --- camera & effects ---
    const raw = vecFor(e, prevVec, preset);
    let vec = inheritGeometry(raw, prevVec);
    const usesLightbox = vec.lbK > 0 || prevVec.lbK > 0;
    states.push({
      tStart: tMove,
      vec,
      fade: usesLightbox ? C.LIGHTBOX_FADE_MS : C.ZOOM_IN_MS,
    });
    prevVec = vec;

    /**
     * Once a step is done, the camera ALWAYS pulls back to the full view
     * before the next step.
     *
     * The earlier version panned straight from one target to the next without
     * pulling back. It looked smooth, but the viewer never saw the whole page
     * and lost their bearings: suddenly the cursor is somewhere else with no
     * idea where that is on the page.
     */
    const focused = vec.zScale > 1.01 || vec.spotK > 0 || vec.lbK > 0;
    // If the next step is still inside this frame, just let the camera pan;
    // the next state will move it.
    let stay = nextStaysInFrame(vec, e, live[i + 1], preset);

    /**
     * The next target is right next to this one, just slightly past the edge.
     *
     * Two side-by-side name fields made the camera pull all the way back and
     * then close in again on the field next to it, which looks restless for
     * no reason. The scale doesn't need to drop; shifting the centre to the
     * middle of both is enough, and both fit in one frame.
     */
    const nx = live[i + 1];
    if (
      !stay &&
      vec.zScale > 1.01 &&
      nx?.ok &&
      nx.target &&
      e.target &&
      (nx.urlBefore ?? nx.url) === e.url &&
      !(e.urlBefore && e.urlBefore !== e.url) &&
      nx.effect === e.effect
    ) {
      const both: Rect = {
        x: Math.min(e.target.x, nx.target.x),
        y: Math.min(e.target.y, nx.target.y),
        w:
          Math.max(e.target.x + e.target.w, nx.target.x + nx.target.w) -
          Math.min(e.target.x, nx.target.x),
        h:
          Math.max(e.target.y + e.target.h, nx.target.y + nx.target.h) -
          Math.min(e.target.y, nx.target.y),
      };
      const fits =
        both.w <= VW / vec.zScale - 32 && both.h <= VH / vec.zScale - 32;
      if (fits) {
        const shifted = centeredOn(both, vec.zScale, preset);
        vec = { ...vec, ...shifted };
        states[states.length - 1].vec = vec;
        prevVec = vec;
        stay = true;
      }
    }
    if (focused && !stay) {
      const settle = inheritGeometry(NEUTRAL, vec);
      states.push({
        tStart: tVisEnd + (e.revealAfter ? C.REVEAL_HOLD_MS : 120),
        vec: settle,
        // a new dialog just appeared: pull back faster so the dialog is seen
        // whole for longer before the camera closes in again
        fade: e.revealAfter ? C.ZOOM_OUT_MS * 0.6 : C.ZOOM_OUT_MS,
      });
      prevVec = settle;
    }

    // --- cursor ---
    if (e.cursorTo) {
      cursorKeys.push({ t: tMove, ...cursor });
      cursorKeys.push({ t: tMove + C.CURSOR_TRAVEL_MS, ...e.cursorTo });
      cursor = e.cursorTo;
    }

    // --- click ripple ---
    if ((e.kind === "click" || e.kind === "fill") && e.cursorTo) {
      ripples.push({ t: tAct, x: e.cursorTo.x, y: e.cursorTo.y });
    }

    // Captions accompany the whole step, including scrolls that have no
    // target element. Their ends are tidied up once all are collected.
    if (captions && e.narration) {
      /**
       * A click is the moment the screen changes, whatever the URL does.
       *
       * An earlier attempt only guarded URL changes, but a "Next" button in a
       * multi-step flow replaces the whole screen without leaving the page.
       * The caption carried over and its ring marked some other element that
       * happened to sit at the same coordinates.
       */
      const cut =
        e.kind === "click"
          ? tAct + C.CALLOUT_HOLD_MS
          : tVisEnd + C.CALLOUT_HOLD_MS;
      callouts.push({
        tStart: tMove,
        tEnd: cut,
        text: e.narration,
        step: i + 1,
        total: live.length,
        // The ring marks the element itself, not its container. The container
        // is for framing the camera; using it here made the marker circle the
        // whole title row as if all of it were pressable.
        anchor: e.target ?? e.frame ?? undefined,
      });
    }

    chapters.push({ t: tMove, narration: e.narration, effect: e.effect, kind: e.kind, tAct, tEnd: tVisEnd });
  }

  // Pull back to the full view right after the last action finishes, not in
  // the last second, so the end result is seen whole.
  const lastOk = [...events].reverse().find((e) => e.ok);
  const afterLast = lastOk ? outAt(segs, lastOk.visualEnd) + 300 : durationMs;
  const outroStart = clamp(
    Math.min(afterLast, durationMs - C.ZOOM_OUT_MS),
    states[states.length - 1].tStart + 1,
    Math.max(durationMs - 1, 1),
  );
  states.push({ tStart: outroStart, vec: NEUTRAL, fade: C.ZOOM_OUT_MS });

  // Work out the starting points: the camera value at the moment each state
  // begins, traced through the chain of earlier transitions.
  states.sort((a, b) => a.tStart - b.tStart);
  states[0].from = states[0].vec;
  for (let k = 1; k < states.length; k++) {
    const prev = states[k - 1];
    const p = clamp(
      (states[k].tStart - prev.tStart) / Math.max(prev.fade, 1),
      0,
      1,
    );
    states[k].from = lerpVec(prev.from ?? prev.vec, prev.vec, easeInOutCubic(p));
  }

  return { preset, durationMs, segs, states, cursorKeys, ripples, callouts, chapters };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function lerpVec(a: Vec, b: Vec, p: number): Vec {
  // A highlight that is fading in or out must not travel. If its geometry is
  // lerped too, the light leaves the previous step's element heading for the
  // next one and halfway there stops on empty space, lighting a part of the
  // page with nothing in it. So the shape is taken straight from the live end,
  // and only its strength rises or falls.
  const gp = b.spotK > a.spotK ? 1 : a.spotK > b.spotK ? 0 : p;
  return {
    zScale: lerp(a.zScale, b.zScale, p),
    zCx: lerp(a.zCx, b.zCx, p),
    zCy: lerp(a.zCy, b.zCy, p),
    spotK: lerp(a.spotK, b.spotK, p),
    spotX: lerp(a.spotX, b.spotX, gp),
    spotY: lerp(a.spotY, b.spotY, gp),
    spotW: lerp(a.spotW, b.spotW, gp),
    spotH: lerp(a.spotH, b.spotH, gp),
    spotR: lerp(a.spotR, b.spotR, gp),
    lbK: lerp(a.lbK, b.lbK, p),
    lbX: lerp(a.lbX, b.lbX, p),
    lbY: lerp(a.lbY, b.lbY, p),
    lbW: lerp(a.lbW, b.lbW, p),
    lbH: lerp(a.lbH, b.lbH, p),
    lbMag: lerp(a.lbMag, b.lbMag, p),
  };
}

function sampleVec(states: StateSpan[], t: number): Vec {
  let i = 0;
  while (i + 1 < states.length && states[i + 1].tStart <= t) i++;
  const cur = states[i];
  const p = clamp((t - cur.tStart) / Math.max(cur.fade, 1), 0, 1);
  // start from the real position, not from the previous state's stored value
  return lerpVec(cur.from ?? cur.vec, cur.vec, easeInOutCubic(p));
}

function sampleCursor(
  keys: { t: number; x: number; y: number }[],
  t: number,
  preset: Preset,
): Point {
  if (!keys.length) return { x: preset.viewport.w / 2, y: preset.viewport.h / 2 };
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (!b) return { x: a.x, y: a.y };
  const q = easeInOutCubic(clamp((t - a.t) / Math.max(b.t - a.t, 1), 0, 1));
  return { x: lerp(a.x, b.x, q), y: lerp(a.y, b.y, q) };
}

export function sampleFrame(plan: RenderPlan, t: number): FrameState {
  const v = sampleVec(plan.states, t);
  const cursor = sampleCursor(plan.cursorKeys, t, plan.preset);

  const active = plan.ripples
    .filter((r) => t >= r.t && t <= r.t + C.RIPPLE_MS)
    .map((r) => ({ x: r.x, y: r.y, p: (t - r.t) / C.RIPPLE_MS }));

  const co = plan.callouts.find((c) => t >= c.tStart && t <= c.tEnd);
  const coK = co
    ? Math.min(
        1,
        clamp((t - co.tStart) / C.CALLOUT_FADE_MS, 0, 1),
        clamp((co.tEnd - t) / C.CALLOUT_FADE_MS, 0, 1),
      )
    : 0;

  return {
    callout:
      co && coK > 0.01
        ? { text: co.text, step: co.step, total: co.total, anchor: co.anchor, k: coK }
        : null,
    zoom: { scale: v.zScale, cx: v.zCx, cy: v.zCy },
    spotlight:
      v.spotK > 0.01
        ? {
            x: v.spotX,
            y: v.spotY,
            w: v.spotW,
            h: v.spotH,
            pad: v.spotR,
            k: v.spotK,
          }
        : null,
    lightbox:
      v.lbK > 0.01
        ? { x: v.lbX, y: v.lbY, w: v.lbW, h: v.lbH, mag: v.lbMag, k: v.lbK }
        : null,
    cursor,
    ripples: active,
  };
}
