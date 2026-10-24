import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import * as C from "./config.js";
import { presetOf, type Preset } from "./preset.js";
import { Executor, launchBrowser, sleep, type LaunchOptions } from "./browser/executor.js";
import { friendlyNavError } from "./browser/errors.js";
import { Recorder } from "./browser/recorder.js";
import { parseSession } from "./browser/session.js";
import { snapshotPage } from "./browser/snapshot.js";
import { runAgent, markNoopEvents, summarizeAgentRun, type AgentLoopResult, type StepRecord } from "./agent/loop.js";
import { composeVideo, extractPoster } from "./render/compose.js";
import { createLLM, type LLM } from "./llm/index.js";
import { createTTS, type TTS } from "./voice/tts.js";
import { Voiceover } from "./voice/voiceover.js";
import { buildCues, writeSubtitles } from "./voice/subtitles.js";
import { mixVoiceAndSubtitles } from "./voice/mix.js";
import { saveScript, stepFromAction, loadScript, type DemoScript, type ScriptStep } from "./script/format.js";
import { findTarget } from "./script/locator.js";
import type {
  AgentAction,
  BlockedReason,
  CredentialInput,
  DemoMode,
  DemoPlan,
  DeviceId,
  FocusEffect,
  LogEntry,
  TimelineEvent,
  TokenUsage,
} from "./types.js";

/** Options shared by recording with the agent and replaying a script. */
export interface RenderOptions {
  /** output mp4 path; default ./demoin-out/<host>-<time>.mp4 */
  out?: string;
  device?: DeviceId;
  /** step captions drawn next to the element (default: on in tour mode) */
  captions?: boolean;
  /** click sounds */
  sound?: boolean;
  /** voiceover, "provider[:voice]": openai:alloy, elevenlabs:<id>, gemini:Kore, say:Samantha */
  voice?: string | TTS;
  /** "sidecar" writes .srt/.vtt next to the video, "burn" also draws them in; default sidecar when there is narration */
  subtitles?: "none" | "sidecar" | "burn";
  /** host shown in the fake browser bar instead of the real one (e.g. hide localhost) */
  displayHost?: string;
  /** credentials the steps refer to as {{LABEL}}; values never reach the model or the script */
  credentials?: CredentialInput[] | Record<string, string>;
  /** raw session cookie(s) for sites the agent cannot sign in to */
  session?: string;
  /** write a poster frame next to the video */
  poster?: boolean;
  keepFrames?: boolean;
  browser?: LaunchOptions;
  onLog?: (e: LogEntry) => void;
  signal?: AbortSignal;
}

export interface DemoOptions extends RenderOptions {
  url: string;
  goal: string;
  /** "provider:model" or a ready LLM; default picks from the environment */
  model?: string | LLM;
  mode?: DemoMode;
  style?: FocusEffect | "auto";
  maxSteps?: number;
  /** language of the narration (default English) */
  language?: string;
  /** also save the steps as a replayable script (default true) */
  saveScript?: boolean;
}

export interface DemoResult {
  video: string;
  durationMs: number;
  poster?: string;
  script?: string;
  subtitles?: { srt: string; vtt: string };
  steps: { index: number; kind: string; narration: string; ok: boolean; atMs?: number; cut?: boolean }[];
  achieved: boolean;
  blocked?: BlockedReason;
  plan?: DemoPlan | null;
  usage?: TokenUsage;
  model?: string;
  /** one or two sentences on what the video shows, in the narration language */
  summary?: string;
}

const log = (o: RenderOptions, level: LogEntry["level"], message: string) =>
  o.onLog?.({ t: Date.now(), level, message });

const normCreds = (c: RenderOptions["credentials"]): CredentialInput[] =>
  !c ? [] : Array.isArray(c) ? c : Object.entries(c).map(([label, value]) => ({ label: label.toUpperCase(), value }));

const withScheme = (u: string) => (/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`);

function defaultOut(url: string): string {
  let host = "demo";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "-");
  } catch {
    /* keep "demo" */
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  return path.resolve("demoin-out", `${host}-${stamp}.mp4`);
}

interface DriveResult {
  events: TimelineEvent[];
  achieved: boolean;
  blocked?: BlockedReason;
  plan?: DemoPlan | null;
  usage?: TokenUsage;
  /** the agent's own result, for the pixel check of steps that changed nothing */
  agent?: AgentLoopResult;
}

type Driver = (ctx: {
  page: Page;
  rec: Recorder;
  preset: Preset;
  hold?: (narration: string, index: number) => Promise<number>;
}) => Promise<DriveResult>;

/**
 * Everything around one recording: browser, session cookies, first page load,
 * recorder, then compose, voiceover and subtitles. The driver in the middle is
 * either the agent or a script replay; both drive the same Executor, so the
 * videos they produce are indistinguishable.
 */
async function recordAndRender(
  o: RenderOptions & { url: string; mode: DemoMode },
  drive: Driver,
): Promise<{ result: DemoResult; events: TimelineEvent[] }> {
  const preset = presetOf(o.device);
  const out = path.resolve(o.out ?? defaultOut(o.url));
  await fs.mkdir(path.dirname(out), { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "demoin-"));
  const framesDir = path.join(work, "frames");
  await fs.mkdir(framesDir, { recursive: true });

  const tts = typeof o.voice === "string" ? createTTS(o.voice) : o.voice;
  const voice = tts ? new Voiceover(tts, work, o.onLog) : null;
  if (tts) log(o, "info", `Voiceover: ${tts.id}`);

  const { browser, context, page } = await launchBrowser(preset, o.browser);
  let heartbeat: NodeJS.Timeout | null = null;
  try {
    // Cookies go in before the first page opens, so even the first request
    // carries them and the site never gets the chance to bounce to sign-in.
    if (o.session) {
      const cookies = parseSession(o.session, o.url);
      await context.addCookies(cookies);
      log(o, "info", `Session set, ${cookies.length} cookie(s)`);
    }

    log(o, "info", `Opening ${o.url}`);
    try {
      await page.goto(o.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      log(o, "error", (e as Error).message);
      throw new Error(friendlyNavError((e as Error).message, o.url));
    }
    await Promise.race([page.waitForLoadState("load").catch(() => {}), sleep(6000)]);
    await sleep(600);

    const rec = new Recorder(page, framesDir, preset);
    await rec.start();
    // Force periodic repaints so the frame stream doesn't stall while the page is idle.
    heartbeat = setInterval(() => void rec.tick(), 350);
    await sleep(C.INTRO_MS);

    const driven = await drive({ page, rec, preset, hold: voice?.hold });

    clearInterval(heartbeat);
    heartbeat = null;
    const stopped = await rec.stop();
    await browser.close().catch(() => {});

    const events = driven.events;
    if (driven.agent) {
      await markNoopEvents(driven.agent, stopped.frames, framesDir, preset, o.onLog).catch((e: Error) =>
        log(o, "warn", `Could not check for empty steps: ${e.message}`),
      );
    }
    const shown = events.filter((e) => !e.noop);
    if (!shown.some((e) => e.ok)) throw new Error("Nothing was recorded: no step succeeded.");

    voice?.anchor(events);
    const captions = o.captions ?? o.mode === "tour";
    log(o, "info", "Rendering video…");
    const composed = path.join(work, "composed.mp4");
    let lastPct = -10;
    const rendered = await composeVideo({
      framesDir,
      frames: stopped.frames,
      events: shown,
      recDurationMs: stopped.durationMs,
      outPath: composed,
      preset,
      captions,
      sound: o.sound ?? false,
      displayHost: o.displayHost,
      holdBeforeAction: captions || Boolean(voice?.clips.size),
      onProgress: (done, total) => {
        const pct = Math.floor((done / Math.max(1, total)) * 100);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          log(o, "info", `Render ${pct}%`);
        }
      },
    });

    const hasNarration = shown.some((e) => e.ok && e.narration?.trim());
    const subMode = o.subtitles ?? (hasNarration ? "sidecar" : "none");
    const cues = subMode === "none" ? [] : buildCues(shown, rendered.mapTime, rendered.durationMs, voice?.clips);
    const base = out.replace(/\.mp4$/i, "");
    const subtitles = cues.length ? await writeSubtitles(cues, base) : undefined;

    const { placed } = await mixVoiceAndSubtitles({
      input: composed,
      output: out,
      durationMs: rendered.durationMs,
      mapTime: rendered.mapTime,
      preset,
      clips: voice ? [...voice.clips.values()] : [],
      burn: subMode === "burn" ? cues : [],
      workDir: work,
    });
    if (voice) log(o, "info", `Voiceover: ${placed} clip(s) placed`);

    let poster: string | undefined;
    if (o.poster) {
      poster = `${base}.jpg`;
      await extractPoster(out, poster, rendered.durationMs).catch((e: Error) => {
        log(o, "warn", `Poster failed: ${e.message}`);
        poster = undefined;
      });
    }

    return {
      events,
      result: {
        video: out,
        durationMs: rendered.durationMs,
        poster,
        subtitles,
        steps: events.map((e) => ({
          index: e.index,
          kind: e.kind,
          narration: e.narration,
          ok: e.ok,
          cut: e.noop || undefined,
          atMs: e.noop ? undefined : Math.round(rendered.mapTime(e.moveStart)),
        })),
        achieved: driven.achieved,
        blocked: driven.blocked,
        plan: driven.plan,
        usage: driven.usage,
      },
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await browser.close().catch(() => {});
    if (!o.keepFrames) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    else log(o, "info", `Frames kept in ${work}`);
  }
}

/** Let an AI agent drive the site toward `goal` and render the result. */
export async function recordDemo(opts: DemoOptions): Promise<DemoResult> {
  const url = withScheme(opts.url);
  const llm = typeof opts.model === "object" ? opts.model : createLLM(opts.model);
  const mode = opts.mode ?? "howto";
  const style = opts.style ?? "auto";
  const language = opts.language ?? "English";
  const credentials = normCreds(opts.credentials);
  const steps: StepRecord[] = [];
  let agentResult: AgentLoopResult | undefined;
  log(opts, "info", `Model: ${llm.id}`);

  const { result } = await recordAndRender({ ...opts, url, mode, credentials }, async ({ page, rec, preset, hold }) => {
    const r = await runAgent({
      page,
      rec,
      preset,
      llm,
      url,
      goal: opts.goal,
      mode,
      style,
      credentials,
      maxSteps: opts.maxSteps ?? C.MAX_STEPS,
      language,
      hold,
      onLog: opts.onLog,
      onStep: (s) => steps.push(s),
      signal: opts.signal,
    });
    agentResult = r;
    return { events: r.events, achieved: r.achieved, blocked: r.blocked, plan: r.plan, usage: r.usage, agent: r };
  });
  result.model = llm.id;
  if (agentResult) {
    const r: AgentLoopResult = agentResult;
    result.summary = await summarizeAgentRun(r, { llm, language, goal: opts.goal, signal: opts.signal }).catch(
      () => undefined,
    );
    result.usage = r.usage;
  }

  if (opts.saveScript !== false) {
    const scriptSteps = steps
      .filter((s) => s.event.ok && !s.event.noop)
      .map((s) => stepFromAction(s.action, s.element, s.url))
      .filter((s): s is ScriptStep => s !== null);
    if (scriptSteps.length) {
      const script: DemoScript = {
        demoin: 1,
        url,
        goal: opts.goal,
        device: opts.device ?? "desktop",
        mode,
        style,
        language,
        credentials: credentials.map((c) => c.label),
        steps: scriptSteps,
      };
      result.script = result.video.replace(/\.mp4$/i, ".demoin.yaml");
      await saveScript(script, result.script);
    }
  }
  return result;
}

export interface ReplayOptions extends RenderOptions {
  /** script file path or an already parsed script */
  script: string | DemoScript;
  /** override the script's start URL (e.g. staging instead of production) */
  url?: string;
  /** stop at the first step whose element can't be found (default: skip it and go on) */
  strict?: boolean;
}

/** How long to keep looking for a step's element before giving up (ms). */
const FIND_TIMEOUT_MS = 6000;

/**
 * Play a saved script back with no model involved: same executor, same camera
 * and cursor, so it costs nothing and gives the same video every time. Handy
 * in CI to keep a product's demo in step with each release.
 */
export async function replayDemo(opts: ReplayOptions): Promise<DemoResult> {
  const script = typeof opts.script === "string" ? await loadScript(opts.script) : opts.script;
  const url = withScheme(opts.url ?? script.url);
  // a URL override moves every absolute goto in the script along with it
  const origin = (u: string) => new URL(u).origin;
  const rebase = (u: string) =>
    opts.url && /^https?:/i.test(u) && origin(u) === origin(script.url) ? origin(url) + u.slice(origin(u).length) : u;
  const credentials = normCreds(opts.credentials);
  const missing = script.credentials.filter((l) => !credentials.some((c) => c.label === l));
  if (missing.length) {
    throw new Error(`This script needs credentials: ${missing.join(", ")} (pass --cred ${missing[0]}=…)`);
  }
  const device = opts.device ?? script.device;

  const { result } = await recordAndRender(
    { ...opts, url, mode: script.mode, device, credentials },
    async ({ page, rec, preset, hold }) => {
      const tour = script.mode === "tour";
      const exec = new Executor(page, rec, credentials, script.style, preset, async (n, i) =>
        Math.max(tour ? C.readingMs(n) : 0, hold ? await hold(n, i) : 0),
        Boolean(hold),
      );
      let failed = 0;
      for (let i = 0; i < script.steps.length; i++) {
        if (opts.signal?.aborted) throw new Error("Aborted");
        const step = script.steps[i];
        const action: AgentAction = {
          kind: step.do,
          narration: step.narration,
          ...(step.focus ? { focus: step.focus } : {}),
          ...(step.do === "fill" ? { text: step.text } : {}),
          ...(step.do === "press" ? { key: step.key } : {}),
          ...(step.do === "scroll" ? { deltaY: step.deltaY } : {}),
          ...(step.do === "wait" ? { ms: step.ms } : {}),
          ...(step.do === "goto" ? { text: rebase(step.url) } : {}),
        };
        let snap = await snapshotPage(page);
        if ("target" in step && step.target) {
          let el = findTarget(snap, step.target);
          const until = Date.now() + FIND_TIMEOUT_MS;
          while (!el && Date.now() < until) {
            await revealByName(page, step.target.role, step.target.name);
            await sleep(500);
            snap = await snapshotPage(page);
            el = findTarget(snap, step.target);
          }
          if (!el) {
            const what = step.target.name || step.target.placeholder || step.do;
            if (opts.strict) throw new Error(`Step ${i + 1}: could not find "${what}" on ${page.url()}`);
            log(opts, "warn", `Step ${i + 1}: "${what}" not found, skipped`);
            failed++;
            continue;
          }
          action.ref = el.ref;
        }
        log(opts, "step", `${i + 1}/${script.steps.length} ${step.do}${step.narration ? `: ${step.narration}` : ""}`);
        const ev = await exec.run(action, snap);
        if (!ev.ok) {
          failed++;
          log(opts, "warn", `Step ${i + 1} failed: ${ev.error ?? "unknown error"}`);
          if (opts.strict) throw new Error(`Step ${i + 1} failed: ${ev.error ?? "unknown error"}`);
        }
      }
      return { events: exec.events, achieved: failed === 0 };
    },
  );
  return result;
}

/**
 * The snapshot only lists the first few dozen elements, so a target far down
 * a long page may simply not be in it yet. Asking the page for it by role and
 * name scrolls it into view without the replay having to guess a distance.
 */
const ARIA_ROLES = new Set([
  "button", "link", "tab", "menuitem", "option", "checkbox", "radio", "switch", "textbox", "combobox", "searchbox",
]);

async function revealByName(page: Page, role?: string, name?: string) {
  if (!name) return;
  try {
    // Snapshot roles fall back to the tag name ("a", "input"); map those to ARIA.
    const aria = ({ a: "link", input: "textbox", textarea: "textbox", select: "combobox" } as Record<string, string>)[
      role ?? ""
    ] ?? role;
    const loc =
      aria && ARIA_ROLES.has(aria)
        ? page.getByRole(aria as Parameters<Page["getByRole"]>[0], { name, exact: false }).first()
        : page.getByText(name, { exact: false }).first();
    if (await loc.count()) await loc.scrollIntoViewIfNeeded({ timeout: 1500 });
  } catch {
    /* not on this page (yet) */
  }
}

export { loadScript, saveScript };
