import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type {
  AgentAction,
  CredentialInput,
  FocusEffect,
  PageSnapshot,
  Point,
  Rect,
  TimelineEvent,
} from "../types.js";
import { friendlyNavError } from "./errors.js";
import { REF_ATTR } from "./snapshot.js";
import type { Recorder } from "./recorder.js";
import { PRESETS } from "../preset.js";
import type { Preset } from "../preset.js";
import { CURSOR_TRAVEL_MS, POST_ACTION_MS, RIPPLE_MS } from "../config.js";

const HOVER_BEAT_MS = 90;

/**
 * Written as a STRING, not a function, on purpose.
 *
 * Playwright serialises functions to text and evaluates them in the page. Our
 * bundler (esbuild through tsx) wraps functions in a `__name()` helper to keep
 * Function.name, that helper does not exist inside the page, so every
 * page.evaluate() fails with "__name is not defined". A string never goes
 * through the transform, and doubles as the place to install the shim.
 */
const INIT_SCRIPT = `(() => {
  globalThis.__name = globalThis.__name || function (fn) { return fn; };

  // Keep every navigation in this tab so the recording is not cut off.
  window.open = function (url) { if (url) { location.href = String(url); } return null; };
  document.addEventListener("click", function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest("a[target]") : null;
    if (a) { a.removeAttribute("target"); }
  }, true);
})();`;

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function easeInOutCubic(p: number) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/**
 * Headless Chrome gives itself away through "HeadlessChrome" in the user agent.
 *
 * Writing a fake UA by hand is not the answer either: Chrome sends the
 * `Sec-CH-UA-Platform` client hint from the real OS, so a macOS UA on Windows
 * becomes a glaring mismatch. The safe way is to take this browser's real UA
 * and strip the headless marker, so the Chrome version and platform are right
 * on any OS automatically.
 *
 * Note: this does not disguise everything. The brand list in `Sec-CH-UA` can
 * still mention headless, so sites with serious bot protection still manage
 * to detect it.
 */
async function realisticUserAgent(browser: Browser): Promise<string | undefined> {
  try {
    const probe = await browser.newContext();
    const page = await probe.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    await probe.close();
    return ua.replace(/HeadlessChrome/g, "Chrome");
  } catch {
    return undefined; // fall back to the browser default
  }
}

export interface LaunchOptions {
  /** show the browser window (default: env DEMOIN_HEADFUL=1) */
  headful?: boolean;
  /** path to a Chrome/Chromium binary (default: env DEMOIN_EXECUTABLE_PATH) */
  executablePath?: string;
  /** Playwright channel, ignored when executablePath is set (default: env DEMOIN_BROWSER_CHANNEL or "chrome") */
  channel?: string;
  /** disable Chrome's sandbox; only for containers (default: env DEMOIN_CHROME_NO_SANDBOX=1) */
  noSandbox?: boolean;
  /** browser locale (default "en-US") */
  locale?: string;
  /** browser timezone (default: the host's timezone) */
  timezoneId?: string;
}

export async function launchBrowser(preset: Preset, opts: LaunchOptions = {}): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const headful = opts.headful ?? process.env.DEMOIN_HEADFUL === "1";
  const executablePath = opts.executablePath || process.env.DEMOIN_EXECUTABLE_PATH || undefined;
  const channel = executablePath
    ? undefined
    : opts.channel || process.env.DEMOIN_BROWSER_CHANNEL || "chrome";
  const noSandbox = opts.noSandbox ?? process.env.DEMOIN_CHROME_NO_SANDBOX === "1";

  const browser = await chromium.launch({
    headless: !headful,
    channel,
    executablePath,
    args: [
      // Inside a container Chrome cannot use its own sandbox without extra
      // privileges. The container is the boundary then, so this must ONLY be
      // switched on in an environment that really is confined.
      ...(noSandbox ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
      "--hide-scrollbars",
      "--disable-blink-features=AutomationControlled",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: preset.viewport.w, height: preset.viewport.h },
    deviceScaleFactor: preset.deviceScale,
    locale: opts.locale || "en-US",
    timezoneId: opts.timezoneId || Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Sites pick their layout from these signals, not from the screen width alone.
    isMobile: preset.id === "mobile",
    hasTouch: preset.id === "mobile",
    userAgent: await realisticUserAgent(browser),
  });

  await context.addInitScript({ content: INIT_SCRIPT });

  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return { browser, context, page };
}

export class Executor {
  private cursor: Point;
  private index = 0;
  readonly events: TimelineEvent[] = [];

  constructor(
    private page: Page,
    private rec: Recorder,
    private credentials: CredentialInput[],
    /** "auto" = follow the agent's choice; anything else forces one effect for every step */
    private style: FocusEffect | "auto" = "auto",
    private preset: Preset = PRESETS.desktop,
    /**
     * How long to hold the screen before an action (ms), e.g. so a tour
     * caption can be read or a voiceover clip can play. `index` is the index
     * of the event about to be recorded.
     */
    private hold: (narration: string, index: number) => number | Promise<number> = () => 0,
    /**
     * Also pause before actions that have no target (goto, press). Only a
     * voiceover needs this: its sentence has to be spoken somewhere, and a
     * navigation with no pause in front of it leaves nowhere to put it.
     * Captions don't, so without a voice those steps stay instant.
     */
    private explainAll = false,
  ) {
    this.cursor = {
      x: preset.viewport.w * 0.72,
      y: preset.viewport.h * 0.84,
    };
  }

  get cursorPos() {
    return this.cursor;
  }

  /**
   * Decide the highlight effect for one step.
   * "auto" respects the agent's choice, with a heuristic fallback:
   * a very small target reads better as a lightbox than as a plain zoom.
   */
  private effectFor(action: AgentAction, rect: Rect | null): FocusEffect {
    if (this.style !== "auto") return this.style;
    if (!rect) return "none";
    if (action.focus && action.focus !== "none") return action.focus;
    const areaRatio =
      (rect.w * rect.h) / (this.preset.viewport.w * this.preset.viewport.h);
    return areaRatio < 0.006 ? "lightbox" : "zoom";
  }

  /** Replace {{LABEL}} with the real credential value. The value is never logged. */
  private applyCredentials(text: string): { value: string; secret: boolean } {
    let secret = false;
    const value = text.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (whole, label: string) => {
      const found = this.credentials.find(
        (c) => c.label.toUpperCase() === label.toUpperCase(),
      );
      if (!found) return whole;
      secret = true;
      return found.value;
    });
    return { value, secret };
  }

  private async settle() {
    await Promise.race([this.page.waitForLoadState("load").catch(() => {}), sleep(4000)]);
    await this.waitForLoaders();
    await this.clearWideSelection();
    await sleep(POST_ACTION_MS);
  }

  /** pages whose loader turned out never to go away (a decorative animation) */
  private everlastingLoaders = new Set<string>();

  /**
   * Wait for "loading" screens to finish.
   *
   * "load" fires long before the app has finished fetching its data. In
   * production, an invitation-app video showed a blank screen reading "Preparing
   * invitation…" three times, exactly in the scene that should have shown off
   * the invitation, because the action was considered done while the spinner
   * was still loading. What is looked for: short loading text, aria-busy and
   * progressbar markers, and spinners and grey skeletons visible on screen. Two
   * clean checks in a row means done. Seven seconds at most, so sites with a
   * permanent loader animation don't hold up the run.
   */
  private async waitForLoaders(maxMs = 7000) {
    const key = (() => {
      try {
        const u = new URL(this.currentUrl());
        return u.origin + u.pathname;
      } catch {
        return "";
      }
    })();
    if (this.everlastingLoaders.has(key)) maxMs = 1200;
    const start = Date.now();
    let clean = 0;
    while (Date.now() - start < maxMs) {
      const loading = await this.page
        .evaluate(`(() => {
          const vw = innerWidth, vh = innerHeight;
          const shown = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 12 || r.height < 12 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
            const cs = getComputedStyle(el);
            return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.1;
          };
          for (const el of document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')) if (shown(el)) return true;
          for (const el of document.querySelectorAll('[class*="spinner" i],[class*="loader" i],[class*="loading" i],[class*="skeleton" i],[class*="shimmer" i],[class*="animate-spin" i],[class*="animate-pulse" i]')) {
            if (!shown(el)) continue;
            const r = el.getBoundingClientRect();
            // small to medium spinners and skeletons; a large background with a
            // "loaded" or "loading-done" class is not a sign of loading
            if (/loaded|done|complete/i.test(el.className && el.className.toString ? el.className.toString() : "")) continue;
            if (r.width * r.height < vw * vh * 0.6) return true;
          }
          const RE = /^(memuat|sedang memuat|menyiapkan|mohon tunggu|harap tunggu|tunggu sebentar|loading|please wait|preparing|just a moment|one moment)\\b/i;
          for (const el of document.querySelectorAll("p,span,div,h1,h2,h3,small")) {
            if (el.childElementCount > 1) continue;
            const t = (el.innerText || "").trim();
            if (t.length > 0 && t.length < 50 && RE.test(t) && shown(el)) return true;
          }
          return false;
        })()`)
        .catch(() => false);
      if (!loading) {
        if (++clean >= 2) return;
      } else clean = 0;
      await sleep(250);
    }
    // Seven full seconds and still "loading": almost certainly decoration.
    // This page won't be waited on that long again.
    if (key) this.everlastingLoaders.add(key);
  }

  /**
   * Wait after a click that may move to another page.
   *
   * waitForLoadState called right after the click resolves instantly, because
   * the OLD page is indeed loaded and the navigation has not started yet. So
   * actEnd was recorded before the new page was painted, the time map thought
   * there was nothing worth keeping after that action, and the new page never
   * got to be seen whole before the camera dived in again.
   */
  private async settleClick(urlBefore: string) {
    await sleep(400);
    if (this.currentUrl() !== urlBefore) {
      await Promise.race([
        this.page.waitForLoadState("load").catch(() => {}),
        sleep(6000),
      ]);
      // Loaded does not mean painted. This pause is what makes the new page's
      // frames actually exist for the time map to keep.
      await sleep(700);
    }
    // A click that does not change the address can still open a preview that
    // is loading (an invitation dialog, a video player).
    await this.waitForLoaders();
    await this.clearWideSelection();
    await sleep(POST_ACTION_MS);
  }

  /**
   * A text selection that has spread over the whole page is cleared.
   *
   * Short ones are left alone: they may be exactly what is being demoed, such
   * as selecting code to copy. Long ones are never intentional, and left in
   * place they tint the rest of the video blue.
   */
  private async clearWideSelection() {
    await this.page
      .evaluate(() => {
        const s = window.getSelection();
        if (s && s.toString().length > 120) s.removeAllRanges();
      })
      .catch(() => {});
  }

  /**
   * A pause so the explanation can be read, IN FRONT OF the action.
   *
   * Holding after the action does not help at all: once the button is clicked
   * the screen has changed, so the sentence "Click the Next button" lingers on
   * top of a page that no longer has that button. A human demoing a product
   * also points first, explains, and only then presses.
   *
   * Returns the moment the pause began (recording time), which is where a
   * voiceover clip for this step is anchored.
   */
  private async explain(narration: string): Promise<number> {
    const at = this.rec.now();
    const ms = await this.hold(narration, this.index);
    if (ms > 0) await sleep(ms);
    return at;
  }

  /** Move the real mouse with the same easing as the cursor in the video. */
  private async travel(to: Point) {
    const from = { ...this.cursor };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(6, Math.min(28, Math.round(dist / 24)));
    const dt = CURSOR_TRAVEL_MS / steps;
    for (let i = 1; i <= steps; i++) {
      const p = easeInOutCubic(i / steps);
      await this.page.mouse
        .move(from.x + (to.x - from.x) * p, from.y + (to.y - from.y) * p)
        .catch(() => {});
      await sleep(dt);
    }
    this.cursor = { ...to };
  }

  /** Find the element by ref, scroll smoothly if needed, return its current rect. */
  private async resolve(ref: string): Promise<Rect | null> {
    const sel = `[${REF_ATTR}="${ref}"]`;
    const loc = this.page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) return null;

    let box = await loc.boundingBox().catch(() => null);
    if (!box) return null;

    if (box.y < 40 || box.y + box.height > this.preset.viewport.h - 40) {
      await this.page
        .evaluate((s) => {
          document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, sel)
        .catch(() => {});
      await sleep(750);
      box = await loc.boundingBox().catch(() => null);
      if (!box) return null;
    }
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }

  /**
   * An element that disappeared because its page was re-rendered.
   *
   * Single-page apps often re-render their whole content a moment after sign
   * in or after their data arrives. The ref marker goes with it, and in
   * production the agent on a bot dashboard stopped with "element e2 not found
   * anymore" while the menu was still in the same place. What is looked for:
   * an element with the same tag and the same name, closest to where the old
   * one was. Once found, the marker is put back.
   */
  private async reacquire(ref: string, snap?: PageSnapshot): Promise<Rect | null> {
    const old = snap?.elements.find((e) => e.ref === ref);
    if (!old || !old.name) return null;
    const found = await this.page
      .evaluate(
        ({ ref, attr, tag, name, x, y }) => {
          const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
          let best: Element | null = null;
          let distance = Infinity;
          for (const el of Array.from(document.querySelectorAll(tag))) {
            const r = el.getBoundingClientRect();
            if (r.width < 3 || r.height < 3) continue;
            const nm =
              clean(el.getAttribute("aria-label")) ||
              clean((el as HTMLElement).innerText).slice(0, 90) ||
              clean(el.getAttribute("placeholder"));
            if (nm !== name) continue;
            const d = Math.hypot(r.x - x, r.y - y);
            if (d < distance) {
              distance = d;
              best = el;
            }
          }
          if (!best) return null;
          best.setAttribute(attr, ref);
          // Measure right here. A page that keeps re-rendering can drop the
          // marker again before it gets looked up.
          const r0 = best.getBoundingClientRect();
          if (r0.top < 40 || r0.bottom > innerHeight - 40) best.scrollIntoView({ block: "center" });
          const r = best.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        },
        { ref, attr: REF_ATTR, tag: old.tag, name: old.name, x: old.rect.x, y: old.rect.y },
      )
      .catch(() => null);
    return found;
  }

  private currentUrl(): string {
    try {
      return this.page.url();
    } catch {
      return "";
    }
  }

  private record(e: Omit<TimelineEvent, "index" | "url">): TimelineEvent {
    let url = "";
    try {
      url = this.page.url();
    } catch {
      /* the page may already be closed */
    }
    const ev: TimelineEvent = { index: this.index++, url, ...e };
    this.events.push(ev);
    return ev;
  }

  private failed(action: AgentAction, message: string) {
    const t = this.rec.now();
    return this.record({
      kind: action.kind,
      narration: action.narration,
      target: null,
      cursorFrom: null,
      cursorTo: null,
      moveStart: t,
      actAt: t,
      visualEnd: t,
      actEnd: t,
      secret: false,
      effect: "none",
      ok: false,
      error: message,
    });
  }

  /**
   * The target's visual container according to the snapshot, shifted along
   * with the target itself. resolve() can scroll the page, so the snapshot
   * coordinates need correcting by however much it moved.
   */
  private frameFor(
    action: AgentAction,
    fresh: Rect,
    snap?: PageSnapshot,
  ): Rect | undefined {
    const el = snap?.elements.find((e) => e.ref === action.ref);
    if (!el?.group) return undefined;
    const dx = fresh.x - el.rect.x;
    const dy = fresh.y - el.rect.y;
    return { x: el.group.x + dx, y: el.group.y + dy, w: el.group.w, h: el.group.h };
  }

  async run(action: AgentAction, snap?: PageSnapshot): Promise<TimelineEvent> {
    switch (action.kind) {
      case "goto":
        return this.doGoto(action);
      case "click":
        return this.doClick(action, snap);
      case "fill":
        return this.doFill(action, snap);
      case "press":
        return this.doPress(action);
      case "scroll":
        return this.doScroll(action);
      case "wait":
        return this.doWait(action);
      default:
        return this.failed(action, `unknown action: ${action.kind}`);
    }
  }

  private async doGoto(action: AgentAction): Promise<TimelineEvent> {
    const url = (action.text ?? "").trim();
    if (!url) return this.failed(action, "goto without a url");
    const moveStart = this.rec.now();
    const narrationAt = this.explainAll ? await this.explain(action.narration) : undefined;
    const actAt = this.rec.now();
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await this.settle();
    } catch (e) {
      return this.failed(action, friendlyNavError((e as Error).message, url));
    }
    return this.record({
      kind: "goto",
      narration: action.narration,
      target: null,
      cursorFrom: null,
      cursorTo: null,
      moveStart,
      narrationAt,
      actAt,
      visualEnd: actAt,
      actEnd: this.rec.now(),
      secret: false,
      effect: "none",
      ok: true,
    });
  }

  private async doClick(
    action: AgentAction,
    snap?: PageSnapshot,
  ): Promise<TimelineEvent> {
    if (!action.ref) return this.failed(action, "click without a ref");
    const rect = (await this.resolve(action.ref)) ?? (await this.reacquire(action.ref, snap));
    if (!rect) return this.failed(action, `element ${action.ref} not found anymore`);

    const to: Point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const from = { ...this.cursor };
    const urlBefore = this.currentUrl();
    const moveStart = this.rec.now();
    await this.travel(to);
    await sleep(HOVER_BEAT_MS);
    const narrationAt = await this.explain(action.narration);
    /**
     * Measure again just before pressing.
     *
     * Between the measurement and the click there is the cursor's trip and the
     * narration pause, almost a second. Sites with entrance animations, headers
     * that shrink on scroll, or images that just loaded shift the button, and
     * the click lands on empty space. In production on a POS app, "Mulai Gratis"
     * (Start Free) was clicked three times with no result, burning a quarter
     * of the step budget.
     */
    const sel = `[${REF_ATTR}="${action.ref}"]`;
    const loc = this.page.locator(sel).first();
    const now = await loc.boundingBox({ timeout: 400 }).catch(() => null);
    if (now && (Math.abs(now.x + now.width / 2 - to.x) > 6 || Math.abs(now.y + now.height / 2 - to.y) > 6)) {
      to.x = now.x + now.width / 2;
      to.y = now.y + now.height / 2;
      await this.travel(to);
    }
    // What sits at that point must be the target itself (or a part/parent of
    // it), not a floating bar or banner that happens to cover it.
    const covered = await this.page
      .evaluate(
        ({ s, x, y }) => {
          const t = document.querySelector(s);
          const at = document.elementFromPoint(x, y);
          return !!t && !!at && !(t === at || t.contains(at) || at.contains(t));
        },
        { s: sel, x: to.x, y: to.y },
      )
      .catch(() => false);
    // Page fingerprint: address, content, selection state, and the classes
    // around the target. A selected plan card only changes class; without that
    // a second click is thought necessary and ends up undoing the selection.
    const fingerprint = () =>
      this.page
        .evaluate((s) => {
          const t = document.querySelector(s);
          let near = "";
          for (let n: Element | null = t, i = 0; n && i < 4; n = n.parentElement, i++) near += n.outerHTML.slice(0, 6000);
          let h = 0;
          for (let i = 0; i < near.length; i++) h = (h * 31 + near.charCodeAt(i)) | 0;
          const n = (q: string) => document.querySelectorAll(q).length;
          return [
            location.href,
            document.body?.innerText.length ?? 0,
            n("*"),
            Math.round(scrollY),
            n("input:checked"),
            n('[aria-expanded="true"],[aria-checked="true"],[aria-selected="true"],[aria-pressed="true"],[data-state="open"],[data-state="checked"],[data-state="active"],[open]'),
            h,
          ].join("|");
        }, sel)
        .catch(() => "");
    const before = await fingerprint();

    const actAt = this.rec.now();
    try {
      if (covered) {
        // Playwright scrolls and waits for the target to be pressable. If it
        // really is covered for good (a floating bar), the click is dispatched
        // straight to the element.
        await loc.click({ timeout: 2500 }).catch(() => loc.dispatchEvent("click"));
      } else await this.page.mouse.click(to.x, to.y);
    } catch (e) {
      return this.failed(action, `click failed: ${(e as Error).message}`);
    }
    await this.settleClick(urlBefore);
    /**
     * A click that changed nothing is tried once more through the element.
     *
     * Playwright waits for the element to be still and pressable, then presses
     * at the right point. If still nothing changes, the step is left as is and
     * the pipeline cuts it from the video.
     */
    if (!covered && (await fingerprint()) === before) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await this.settleClick(urlBefore);
    }
    const actEnd = this.rec.now();
    return this.record({
      kind: "click",
      urlBefore,
      narration: action.narration,
      target: rect,
      frame: this.frameFor(action, rect, snap),
      cursorFrom: from,
      cursorTo: to,
      moveStart,
      narrationAt,
      actAt,
      visualEnd: Math.min(actAt + RIPPLE_MS, actEnd),
      actEnd,
      secret: false,
      effect: this.effectFor(action, rect),
      ok: true,
    });
  }

  private async doFill(
    action: AgentAction,
    snap?: PageSnapshot,
  ): Promise<TimelineEvent> {
    if (!action.ref) return this.failed(action, "fill without a ref");
    const rect = (await this.resolve(action.ref)) ?? (await this.reacquire(action.ref, snap));
    if (!rect) return this.failed(action, `element ${action.ref} not found anymore`);

    const { value, secret } = this.applyCredentials(action.text ?? "");
    const to: Point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const from = { ...this.cursor };
    const urlBefore = this.currentUrl();
    const moveStart = this.rec.now();
    await this.travel(to);
    await sleep(HOVER_BEAT_MS);
    const narrationAt = await this.explain(action.narration);
    const actAt = this.rec.now();
    try {
      await this.page.mouse.click(to.x, to.y);
      await sleep(160);

      /**
       * The field is cleared through its element, not with Ctrl+A.
       *
       * Ctrl+A is a command to the page, not to the field. If the click turns
       * out not to have landed in a text field, the whole page gets selected,
       * everything turns blue, and that selection stays until the video ends.
       * One wrong tap ruins the whole recording, and what was typed never goes
       * anywhere.
       */
      const ready = await this.page.evaluate(
        ({ ref, attr }) => {
          const typable = (n: Element | null): n is HTMLElement =>
            n instanceof HTMLInputElement ||
            n instanceof HTMLTextAreaElement ||
            (n instanceof HTMLElement && n.isContentEditable);

          let el = document.querySelector(`[${attr}="${ref}"]`) as HTMLElement | null;

          /**
           * If the target is not a text field, or its node is gone, use
           * whatever has focus.
           *
           * Two things often happen after the click: the search box turns out
           * to be a decorative box that forwards focus to the real input behind
           * it, and a re-rendered component replaces its node so the old marker
           * vanishes. Both leave the same trace: the right field holds focus.
           */
          if (!typable(el)) {
            const focused = document.activeElement;
            if (typable(focused)) el = focused;
          }

          if (!el) return "is gone";
          if (!typable(el)) return "is not a text field";
          if (document.activeElement !== el) el.focus();
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.select();
          } else {
            const r = document.createRange();
            r.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(r);
          }
          return "ok";
        },
        { ref: action.ref, attr: REF_ATTR },
      );
      if (ready !== "ok") {
        return this.failed(action, `element ${action.ref} ${ready}, cannot type into it`);
      }

      await this.page.keyboard.type(value, { delay: value.length > 40 ? 18 : 45 });
    } catch (e) {
      return this.failed(action, `typing failed: ${(e as Error).message}`);
    }
    const visualEnd = this.rec.now();
    await this.clearWideSelection();
    await sleep(POST_ACTION_MS);
    return this.record({
      kind: "fill",
      urlBefore,
      narration: action.narration,
      target: rect,
      frame: this.frameFor(action, rect, snap),
      cursorFrom: from,
      cursorTo: to,
      moveStart,
      narrationAt,
      actAt,
      visualEnd,
      actEnd: this.rec.now(),
      secret,
      effect: this.effectFor(action, rect),
      ok: true,
    });
  }

  private async doPress(action: AgentAction): Promise<TimelineEvent> {
    const key = action.key || "Enter";
    const t = this.rec.now();
    const narrationAt = this.explainAll ? await this.explain(action.narration) : undefined;
    const actAt = this.rec.now();
    try {
      await this.page.keyboard.press(key);
    } catch (e) {
      return this.failed(action, `failed to press ${key}: ${(e as Error).message}`);
    }
    const visualEnd = this.rec.now();
    await this.settle();
    return this.record({
      kind: "press",
      narration: action.narration,
      target: null,
      cursorFrom: null,
      cursorTo: null,
      moveStart: t,
      narrationAt,
      actAt,
      visualEnd,
      actEnd: this.rec.now(),
      secret: false,
      // "inherit": keep the previous step's highlight, don't zoom out just because of Enter
      effect: "none",
      ok: true,
    });
  }

  private async doScroll(action: AgentAction): Promise<TimelineEvent> {
    const delta = Math.round(action.deltaY ?? this.preset.viewport.h * 0.8);
    const t = this.rec.now();

    /**
     * What scrolls is not necessarily the window.
     *
     * Theme pickers, carts and side panels are often built as a box with its
     * own overflow-y, while the page behind cannot scroll at all.
     * window.scrollBy does nothing there but is still reported as a success,
     * so the agent repeats it until its step budget is gone and the video holds
     * a dozen seconds of a frozen screen.
     */
    const result = await this.page.evaluate((d) => {
      const scrollable = (el: Element) => {
        const cs = getComputedStyle(el);
        return (
          /(auto|scroll)/.test(cs.overflowY) &&
          el.scrollHeight > el.clientHeight + 8 &&
          el.clientHeight > 120
        );
      };

      const doc = document.scrollingElement ?? document.documentElement;
      let target: Element = doc;
      if (doc.scrollHeight <= doc.clientHeight + 8) {
        // The page itself cannot scroll. Find the largest box that can.
        let area = 0;
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          if (!scrollable(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width * r.height > area) {
            area = r.width * r.height;
            target = el;
          }
        }
      }
      if (target === doc && doc.scrollHeight <= doc.clientHeight + 8) return null;

      const before = target.scrollTop;
      target.scrollBy({ top: d, behavior: "smooth" });
      (window as unknown as { __scrolled: () => number }).__scrolled = () =>
        target.scrollTop - before;
      return true;
    }, delta);

    if (result === null) {
      return this.failed(action, "nothing on this page can be scrolled");
    }

    await sleep(900);

    // Did it really move or not. One that stayed put is reported as failed so
    // it does not become a step in the video, and so the agent knows this road
    // is a dead end.
    const moved = await this.page.evaluate(
      () => Math.abs((window as unknown as { __scrolled: () => number }).__scrolled()) > 4,
    );
    if (!moved) {
      return this.failed(action, "already at the end, cannot scroll any further");
    }
    // A scroll sentence explains the part that just appeared, so its pause
    // comes after. visualEnd is moved forward too so the time map does not cut
    // that pause as dead time.
    const narrationAt = await this.explain(action.narration);
    const now = this.rec.now();
    return this.record({
      kind: "scroll",
      narration: action.narration,
      target: null,
      cursorFrom: null,
      cursorTo: null,
      moveStart: t,
      narrationAt,
      actAt: t,
      visualEnd: now,
      actEnd: now,
      secret: false,
      effect: "none",
      ok: true,
    });
  }

  private async doWait(action: AgentAction): Promise<TimelineEvent> {
    const ms = Math.min(8000, Math.max(300, action.ms ?? 1200));
    const t = this.rec.now();
    await sleep(ms);
    const now = this.rec.now();
    return this.record({
      kind: "wait",
      narration: action.narration,
      target: null,
      cursorFrom: null,
      cursorTo: null,
      moveStart: t,
      actAt: t,
      visualEnd: now,
      actEnd: now,
      secret: false,
      effect: "none",
      ok: true,
    });
  }
}
