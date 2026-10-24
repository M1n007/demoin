import type { Page } from "playwright-core";
import { advancePlan, decideNextAction, planDemo, summarizeRun } from "./agent.js";
import * as C from "../config.js";
import { Executor, sleep } from "../browser/executor.js";
import type { Recorder } from "../browser/recorder.js";
import { emptyRequiredFields, snapshotPage } from "../browser/snapshot.js";
import { annotate } from "../browser/vision.js";
import { changedRegion } from "../render/change.js";
import type { LLM, Usage } from "../llm/types.js";
import type { Preset } from "../preset.js";
import type {
  AgentAction,
  BlockedReason,
  CredentialInput,
  DemoMode,
  DemoPlan,
  FocusEffect,
  FrameRef,
  LogEntry,
  LogLevel,
  PageSnapshot,
  SnapEl,
  TimelineEvent,
  TokenUsage,
} from "../types.js";

export interface AgentLoopOptions {
  page: Page;
  rec: Recorder;
  preset: Preset;
  llm: LLM;
  url: string;
  goal: string;
  mode: DemoMode;
  style: FocusEffect | "auto";
  credentials: CredentialInput[];
  maxSteps: number;
  language: string;
  /** extra hold before an action (voiceover); combined with the tour reading hold via max() */
  hold?: (narration: string, index: number) => number | Promise<number>;
  onLog?: (e: LogEntry) => void;
  onStep?: (s: StepRecord) => void;
  signal?: AbortSignal;
}

export interface StepRecord {
  action: AgentAction;
  /** snapshot element the action's ref pointed at, from the snapshot the agent was given */
  element?: SnapEl;
  /** page URL when the action was chosen (before it ran) */
  url: string;
  event: TimelineEvent;
}

export interface AgentLoopResult {
  events: TimelineEvent[];
  plan: DemoPlan | null;
  achieved: boolean;
  blocked?: BlockedReason;
  usage: TokenUsage;
  steps: StepRecord[];
  /**
   * Indexes of events after which the DOM did not change at all. Candidates
   * for being cut from the video; `markNoopEvents` confirms them against the
   * pixels once the recording has stopped.
   */
  noopCandidates: number[];
}

/**
 * Drives the page from the current state to the goal while the recorder runs.
 *
 * The caller has already opened the page and started the recorder (and its
 * heartbeat). This returns after the outro pause, so the caller can stop the
 * recorder right away, then run `markNoopEvents` on the frames.
 */
export async function runAgent(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { page, rec, preset } = opts;
  const tour = opts.mode === "tour";
  const credentialLabels = opts.credentials.map((c) => c.label);
  const log = (level: LogLevel, message: string) => opts.onLog?.({ t: Date.now(), level, message });

  /**
   * Obstacles that were REALLY seen on the page, not guesses from the agent's
   * sentence. The sentence is used to explain things to the user, but the kind
   * of obstacle must come from facts, because that decides which way out is
   * suggested, and a wrong suggestion is worse than none.
   */
  const seen = { captcha: false, sso: false, login: false };
  let blocked: BlockedReason | undefined;
  const usage: TokenUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const steps: StepRecord[] = [];

  await sleep(C.INTRO_MS);

  /** The agent's storyboard; null when it could not be built, and the agent still runs as it used to. */
  let plan: DemoPlan | null = null;

  const exec = new Executor(
    page,
    opts.rec,
    opts.credentials,
    opts.style,
    preset,
    // In tour mode the page is held still while its sentence is read. The
    // frames for that pause must really be recorded, not made up at render
    // time, so the cursor and the page's animations stay honest.
    //
    // ONLY in tour mode, because only there is the sentence shown on screen.
    // Plan sections with the "tour" style used to be held in guide mode too,
    // but without a visible caption that pause is just a cursor sitting still
    // over a button for two to five seconds before clicking it. That was the
    // "long pause before the click".
    //
    // A voiceover hold from the caller is combined with it: the longer wins.
    async (n: string, i: number) => Math.max(tour ? C.readingMs(n) : 0, opts.hold ? await opts.hold(n, i) : 0),
    // a voiceover needs a pause in front of navigations too
    Boolean(opts.hold),
  );

  /** Annotated screenshot for the model; null on failure, and the agent goes on with text. */
  const look = async (s: PageSnapshot) => {
    const jpeg = await rec.latest().catch(() => null);
    return jpeg ? annotate(jpeg, s) : null;
  };

  /**
   * Page fingerprint. Used to answer the question that was never asked
   * before: did the last action CHANGE anything? A click that "succeeded" but
   * changed nothing is why the agent kept clicking the same thing over and
   * over.
   */
  const fingerprint = (s: PageSnapshot) =>
    [
      s.url,
      s.hasDialog ? "d" : "-",
      s.errors.join("|"),
      s.elements.length,
      Math.round(s.scrollY / 50),
      s.text.length,
      s.elements.map((e) => e.value ?? "").join("|").slice(0, 200),
    ].join("~");

  /** The exact same action, to detect repetition. */
  const signature = (a: AgentAction) => `${a.kind}:${a.ref ?? ""}:${(a.text ?? "").slice(0, 24)}`;

  const tried: string[] = [];
  /** refs proven to change nothing, hidden from the agent */
  const dead = new Set<string>();
  let prevPrint = "";
  /** What was still missing according to the previous step, carried forward. */
  let remaining: string | undefined;
  /** How many steps in a row were spent inside the same dialog. */
  let stuckInDialog = 0;
  /** Going back and forth between the same two states. */
  let pingPong = false;
  /** Page fingerprints already passed through. */
  const prints: string[] = [];
  /**
   * How many times each control was used, counted by its name.
   *
   * The page fingerprint is too sensitive to catch this kind of repetition.
   * Once the resume content is filled in, going back to the Style panel gives
   * a page whose content really is different from before, so it never reads
   * as going back. Only the button's name stays the same.
   */
  const used = new Map<string, number>();
  /**
   * Visual container of the element picked at each step.
   *
   * Used to know which part the agent is in. Panels, cards and forms have
   * their own box, so if that box stays the same for several steps the agent
   * is digging through one part only. For a demo video that is a problem: the
   * viewer comes away thinking the product is only as big as that panel.
   */
  const containersPicked: string[] = [];
  /** Names of the parts the agent has already opened. */
  const opened = new Set<string>();
  /** How many times the screen went back to a state it was in before. */
  let returned = 0;
  /** The same error message, how many steps in a row it has persisted. */
  let sameError = 0;
  let lastError = "";
  /** Kind of the last action, to know whether the form was really resubmitted. */
  let lastKind = "";
  /** How many steps in a row only filled fields without submitting. */
  let fillStreak = 0;
  let prevHadDialog = false;
  const trackUsage = (u: Usage) => {
    usage.calls += 1;
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  };
  const history: string[] = [];
  // The absolute ceiling. Whatever the caller asks for, no run goes past it.
  const maxSteps = Math.min(opts.maxSteps, C.HARD_MAX_STEPS);

  /** Whether the agent stopped because its goal was done, not because it ran out. */
  let finishedItself = false;

  // --- storyboard ---
  try {
    const snap0 = await snapshotPage(page);
    plan = await planDemo({
      llm: opts.llm,
      language: opts.language,
      goal: opts.goal,
      mode: opts.mode,
      startUrl: opts.url,
      credentialLabels,
      snapshot: snap0,
      image: await look(snap0),
      maxSteps,
      onUsage: trackUsage,
      signal: opts.signal,
    });
    if (plan) log("info", `Plan: ${plan.sections.map((s, i) => `${i + 1}. ${s.title}`).join(", ")}`);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    log("warn", `Plan could not be built: ${(e as Error).message}`);
  }
  /** The sign-in page has been seen; used to know when the agent has just signed in. */
  let onLoginPage = false;
  let revisedAfterLogin = false;
  /** A password field was seen and then disappeared: signed in. */
  let signedIn = false;
  /**
   * Index of the first action AFTER signing in. Features are counted from
   * here: the sign-in itself is not a feature.
   */
  let afterLogin = 0;
  /** A "finish" rejected once because the plan was not done yet. */
  let finishRejected = false;
  /** Clicks on the menu of the page already open, held back before running. */
  let hereRejected = 0;
  /** how many times a submit button was held back because a required field was still empty */
  let emptySubmitRejected = 0;
  /** steps that close a popup, cut from the video */
  const closeSteps = new Set<number>();
  /** stopped while only a few features had been shown; rejected once */
  let shortFeaturesRejected = false;
  /** claims to be done while the form on screen still has empty required fields */
  let emptyFinishRejected = false;
  /**
   * Actions after which the page did not change at all (according to the
   * DOM). Candidates for being cut from the video; confirmed again through the
   * pixels once the recording is over.
   */
  const noopCandidates = new Set<number>();
  /** Mark the last action when it turns out it changed nothing. */
  const markNoop = (unchanged: boolean) => {
    const ev = exec.events[exec.events.length - 1];
    if (!ev?.ok || !unchanged) return;
    if (!["click", "press", "scroll"].includes(ev.kind)) return;
    if (ev.urlBefore && ev.urlBefore !== ev.url) return;
    if (noopCandidates.has(ev.index)) return;
    noopCandidates.add(ev.index);
    if (history.length) history[history.length - 1] += " (DID NOT CHANGE ANYTHING, cut from the video)";
  };
  let pendingMessage = "";

  for (let step = 1; step <= maxSteps; step++) {
    opts.signal?.throwIfAborted();
    let snap: PageSnapshot;
    try {
      snap = await snapshotPage(page);
    } catch (e) {
      log("warn", `Could not read the page: ${(e as Error).message}`);
      await sleep(1200);
      continue;
    }

    if (snap.hasCaptcha) seen.captcha = true;
    if (snap.elements.some((el) => el.thirdParty)) seen.sso = true;
    // A password field means the site offers a regular sign-in, so what is
    // missing is not the way in but the credentials.
    if (snap.elements.some((el) => el.type === "password")) seen.login = true;

    const print = fingerprint(snap);
    const unchanged = prevPrint !== "" && print === prevPrint;
    markNoop(unchanged);

    // If the page did not change after the last action, that element is a
    // dead end. Warned once; twice and it is hidden entirely so the agent
    // cannot pick it again.
    const lastSig = tried[tried.length - 1];
    const lastRef = lastSig?.split(":")[1];
    if (unchanged && lastRef) {
      const repeats = tried.filter((t) => t === lastSig).length;
      if (repeats >= 2) {
        dead.add(lastRef);
        log("warn", `Element ${lastRef} changes nothing, skipped.`);
      }
    }
    prevPrint = print;

    /**
     * Going back and forth between two pages.
     *
     * The "page did not change" guard is blind to this: every click REALLY
     * changes the page, it just changes it back to where it was. The agent
     * can spend the rest of its step budget walking A to B to A to B while
     * feeling like it is always making progress, and the video shows two
     * pages blinking in turn.
     *
     * What is read is not whether the page changed, but whether the last
     * pair of actions has been repeated exactly.
     */
    /**
     * Going back to a state already passed through.
     *
     * Bouncing between two pages is caught by the A-B-A-B pattern, but longer
     * loops are not. In an app with many settings the agent can set the font,
     * the size, the paper, the line height, then go back to setting the font
     * from the start, and each step feels like progress because the page
     * really does change. What exposes it is not the action but the page
     * fingerprint: if the screen goes back to exactly how it was a few steps
     * ago, the loop has closed.
     */
    if (prints.includes(print)) returned++;
    prints.push(print);
    if (prints.length > 24) prints.shift();

    const n = tried.length;
    if (n >= 4) {
      const [a, b, c, d] = tried.slice(-4);
      if (a === c && b === d && a !== b) {
        for (const sig of [a, b]) {
          const r = sig.split(":")[1];
          if (r) dead.add(r);
        }
        log("warn", "Agent went back and forth between two pages, both buttons skipped.");
        pingPong = true;
      }
    }

    /**
     * Trapped in an onboarding tour.
     *
     * The "page did not change" guard does not catch this: pressing "Next"
     * on an onboarding carousel CHANGES the page every time, it just moves to
     * the next slide. The agent can spend its whole step budget inside one
     * dialog and the video never reaches the page it was asked for.
     *
     * What tells them apart is the dialog's content, not how long it lasts: a
     * sign-up dialog really does take many steps, but it has input fields. A
     * dialog with only buttons is almost certainly an onboarding tour.
     */
    const dialogEls = snap.elements.filter((el) => el.inDialog);
    const hasInputs = dialogEls.some(
      (el) =>
        ["input", "textarea", "select"].includes(el.tag) ||
        ["checkbox", "radio", "switch", "combobox", "textbox"].includes(el.role),
    );
    stuckInDialog = snap.hasDialog ? stuckInDialog + 1 : 0;
    /**
     * If the goal really is to go through the tour, do not chase it out.
     *
     * This guard was made for tours that get in the way. But some people DO
     * ask for the tour to be completed, and for them pressing "Skip" at the
     * third step is the exact opposite of what was asked.
     */
    const tourRequested = /\btur\b|\btour\b|onboarding|perkenalan|walkthrough|\bintroduction\b/i.test(opts.goal);
    const trapped = snap.hasDialog && !hasInputs && stuckInDialog >= 3 && !tourRequested;

    /**
     * The same message persisting AFTER the form was resubmitted means the
     * fix did not touch its cause.
     *
     * The "after it was resubmitted" condition is what matters. Filling a
     * field does not clear the server's message, so counting every step would
     * accuse the agent of being wrong exactly when it is fixing things
     * correctly, and it would then keep swapping fields without ever pressing
     * the submit button.
     */
    const errNow = snap.errors.join("|");
    const resubmitted = lastKind === "click" || lastKind === "press";
    sameError = errNow && errNow === lastError && resubmitted ? sameError + 1 : 0;
    lastError = errNow;

    let visible: PageSnapshot = dead.size
      ? { ...snap, elements: snap.elements.filter((e) => !dead.has(e.ref)) }
      : snap;

    /**
     * Dialog open: what is behind it is hidden from the agent.
     *
     * Not just a suggestion. Elements behind a dialog CANNOT be pressed, the
     * click is swallowed by the dialog's layer. The agent used to still see
     * them in the list, pick them, and waste the step without changing
     * anything; in the reported recording that happened twice in a row while
     * the dialog stayed open.
     *
     * Filtered only when the dialog really has choices to pick from, so a
     * false detection never leaves the agent completely blind.
     */
    const activeDialogEls = visible.elements.filter((e) => e.inDialog);
    if (snap.hasDialog && activeDialogEls.length >= 2) {
      visible = { ...visible, elements: activeDialogEls };
    }

    // A control that has been used three times or more, if any.
    const overused = [...used.entries()].find(([, n]) => n >= 3)?.[0] ?? "";

    /**
     * Too long in one part while the step budget is running low.
     *
     * The threshold deliberately uses the share of the budget spent, not the
     * raw number of steps: five steps in one panel is fine with a budget of
     * thirty, and wasteful with a budget of ten.
     */
    const lingering =
      containersPicked.length >= 5 && new Set(containersPicked.slice(-5)).size === 1 && step > maxSteps * 0.4;

    /**
     * Big parts of the product never opened.
     *
     * Saying "move to another part" turned out not to be enough: the agent
     * follows the app's natural flow and sinks into it. What gets obeyed is a
     * warning that NAMES them, just like naming the ref of the submit button.
     * Candidates come from the navigation row at the top of the screen,
     * because that is where apps put their big divisions.
     */
    const topNav = visible.elements.filter(
      (e) =>
        e.rect.y < preset.viewport.h * 0.28 &&
        e.name.length > 1 &&
        e.name.length <= 24 &&
        !e.disabled &&
        (e.role === "tab" || e.tag === "button" || e.tag === "a"),
    );
    const notOpened = topNav
      .map((e) => e.name.trim())
      .filter((n) => !opened.has(n))
      .slice(0, 4);

    const warnings: string[] = [];
    if (history.slice(-2).join("\n").includes("→ FAILED")) {
      warnings.push("The last step failed. Pick another element or scroll first.");
    }
    if (unchanged) {
      warnings.push(
        "The page did NOT change at all after the last action. That action " +
          "was useless. Do not repeat it. Take another path: a different element, " +
          "scroll, or close the dialog that is in the way.",
      );
    }
    if (dead.size) {
      warnings.push(`Elements already proven to be dead ends: ${[...dead].join(", ")}.`);
    }
    if (fillStreak >= 2) {
      // Naming the button's ref is obeyed far more reliably than saying
      // "press the submit button": there is nothing left for the agent to guess.
      const submit = visible.elements.find(
        (el) =>
          (el.tag === "button" && el.type === "submit") ||
          /^(buat akun|daftar|kirim|simpan|masuk|lanjut|submit|selesai|create account|sign ?up|register|send|save|sign ?in|log ?in|continue|next|done|finish)/i.test(
            el.name.trim(),
          ),
      );
      warnings.push(
        `You have spent ${fillStreak} steps in a row filling fields without submitting ` +
          "the form. Input that is not submitted means nothing." +
          (submit ? ` Press [${submit.ref}] "${submit.name}" NOW.` : ""),
      );
    }
    if (sameError >= 1) {
      warnings.push(
        `The same error message is still shown after your attempt: "${snap.errors[0]}". ` +
          "What you just changed is NOT the cause. Change exactly what the " +
          "message names, or take a completely different path.",
      );
    }
    if (lingering) {
      warnings.push(
        `Your last five steps were in the same part, and ${step} of your ${maxSteps} ` +
          "steps are already used. The viewer has not seen any other part of " +
          "this product yet." +
          (notOpened.length
            ? ` NOT opened even once yet: ${notOpened.map((n) => `"${n}"`).join(", ")}. Open one of them NOW.`
            : " MOVE NOW to a menu or tab you have never opened."),
      );
    }
    if (overused && !tourRequested) {
      warnings.push(
        `You have pressed "${overused}" ${used.get(overused)} times in this run. ` +
          "Going back to a setting you already changed adds nothing for the " +
          "viewer. Move on to a part that has not been shown yet, or finish " +
          'with "finish".',
      );
    }
    if (returned >= 3) {
      warnings.push(
        `The screen has gone back ${returned} times to a state you already passed through. ` +
          "You are resetting things you already set. If everything the goal " +
          'asks for has been shown, FINISH now with "finish". ' +
          "Do not repeat the same part.",
      );
      returned = 0;
    }
    if (pingPong) {
      warnings.push(
        "You are going back and forth between the same two pages and getting nowhere. " +
          "Both buttons have been skipped. If what you are looking for is already " +
          'visible on screen, FINISH now with "finish". If not, ' +
          "take a completely different path.",
      );
      pingPong = false;
    }
    if (trapped) {
      warnings.push(
        `You have spent ${stuckInDialog} steps inside the same dialog, and that dialog ` +
          "has not a single input field. It is an onboarding tour, not your goal. " +
          "NOW find its Skip, Close or X button, and get out. " +
          "Your goal is on the page behind this dialog.",
      );
      log("warn", "Trapped in an onboarding dialog, the agent was told to get out.");
    }

    /**
     * Just signed in to the app.
     *
     * The plan was built from the landing page or the sign-in page, so the
     * sections after signing in are only guesses. As soon as the password
     * field is gone and the real menu is visible, the agent is asked to
     * rebuild the rest from the menus that actually exist.
     */
    const hasPassword = snap.elements.some((el) => el.type === "password");
    if (hasPassword) onLoginPage = true;
    else if (onLoginPage && !signedIn) {
      signedIn = true;
      afterLogin = exec.events.length;
    }
    /**
     * Has credentials but is standing on a SIGN-UP form.
     *
     * On many products' landing pages the most prominent button ("Create a
     * free invitation", "Get started") leads to signing up for a new account,
     * and an agent given an email and a password thinks it is the way in. A
     * sign-up form is recognised by a second password or a name field; the
     * sign-in link is named by its ref so it does not have to be guessed.
     */
    const loginLinks = snap.elements.filter(
      (el) =>
        /^(masuk|login|log in|sign in|sudah punya akun|already have an account)|sudah punya akun|already have an account|\bmasuk\b|\blog ?in\b|\bsign ?in\b/i.test(
          el.name.trim(),
        ) &&
        el.type !== "password" &&
        el.tag !== "input",
    );
    const namedLogin = loginLinks
      .slice(0, 3)
      .map((el) => `[${el.ref}] "${el.name.trim().slice(0, 30)}"`)
      .join(", ");
    if (credentialLabels.length && !signedIn) {
      const passwords = snap.elements.filter((el) => el.type === "password").length;
      const signupField = snap.elements.some(
        (el) =>
          el.tag === "input" &&
          /nama|name|konfirmasi|ulangi|confirm|repeat|retype|telepon|phone|mobile|whatsapp|no\.? ?hp/i.test(el.name),
      );
      const origin = new URL(opts.url).origin;
      if (passwords >= 2 || (passwords >= 1 && signupField)) {
        warnings.push(
          "This page is a SIGN-UP form for a new account, not a sign-in form. You have credentials, so DO NOT fill in this form. " +
            (namedLogin
              ? `Press its sign-in link: ${namedLogin}.`
              : `Open the sign-in page with goto to ${origin}/login or /signin (or /masuk).`),
        );
      } else if (!passwords && step >= 1) {
        warnings.push(
          "You have credentials but have not signed in yet. Sign in before anything else. " +
            (namedLogin
              ? `Sign-in links visible: ${namedLogin}. Do not pick a sign-up or "create for free" button.`
              : `No sign-in link is visible: open ${origin}/login or /signin (or /masuk) directly with goto.`),
        );
      }
    }
    if (!hasPassword && onLoginPage && plan && !revisedAfterLogin) {
      revisedAfterLogin = true;
      warnings.push(
        "You have just signed in successfully and the app's menu is now visible. Look at the screenshot, " +
          "then fill newPlan with the sections for the rest of the video based on the menus that ACTUALLY EXIST " +
          "(one section per main feature), within the remaining step budget.",
      );
    }

    if (pendingMessage) {
      warnings.push(pendingMessage);
      pendingMessage = "";
    }

    const image = await look(visible);
    const action = await decideNextAction({
      llm: opts.llm,
      language: opts.language,
      goal: opts.goal,
      image,
      plan,
      mode: opts.mode,
      startUrl: opts.url,
      credentialLabels,
      snapshot: visible,
      history: history.slice(-14),
      stepsLeft: maxSteps - step,
      onUsage: trackUsage,
      remaining,
      repeatWarning: warnings.length ? warnings.join(" ") : undefined,
      signal: opts.signal,
    });
    remaining = action.remaining?.trim() || remaining;
    if (plan) {
      const before = plan.revisions;
      plan = advancePlan(plan, action);
      if (plan.revisions > before)
        log(
          "info",
          `Plan revised: ${plan.sections
            .filter((s) => s.status !== "done")
            .map((s) => s.title)
            .join(", ")}`,
        );
    }
    fillStreak = action.kind === "fill" ? fillStreak + 1 : 0;
    lastKind = action.kind;

    const picked = visible.elements.find((e) => e.ref === action.ref);
    const name = picked?.name?.trim();
    if (name) {
      used.set(name, (used.get(name) ?? 0) + 1);
      opened.add(name);
    }

    const g = picked?.group ?? picked?.rect;
    containersPicked.push(g ? `${Math.round(g.x / 40)}:${Math.round(g.y / 40)}:${Math.round(g.w / 40)}` : "-");
    if (containersPicked.length > 12) containersPicked.shift();

    /**
     * Stopping too early.
     *
     * The model often considers its goal done as soon as the first section is
     * finished, e.g. it reached the dashboard, while the goal also asked for
     * the features to be introduced. Once only, finish is held back and the
     * sections not yet done are named. If the model is still sure, it may
     * stop; the step is not counted.
     */
    const notDone = plan?.sections.filter((s) => s.status !== "done") ?? [];
    if (
      action.kind === "finish" &&
      action.outcome !== "blocked" &&
      !finishRejected &&
      notDone.length > 0 &&
      maxSteps - step >= 2
    ) {
      finishRejected = true;
      pendingMessage =
        `You were about to stop, but the video plan still has sections that have not been shown: ${notDone
          .map((s) => `"${s.title}"`)
          .join(", ")}. ${maxSteps - step} steps left in the budget. Carry on with those sections. Only stop if ` +
        "that section really does not exist on this site or the goal is truly fully visible.";
      log("info", "Agent wanted to stop before the plan was done; asked to carry on.");
      // No action was run, so the same page next time is not a sign that the
      // last action was a dead end.
      prevPrint = "";
      step--;
      continue;
    }

    /**
     * Pressing the menu of the page already open.
     *
     * Held back before running, because the result is certain: nothing
     * changes, and the video shows the camera moving in on "Home" while the
     * screen is already Home. The step is not counted. At most twice per
     * run, so a false detection can never lock the agent.
     */
    if (action.kind === "click" && picked?.active && !snap.hasDialog && hereRejected < 2) {
      hereRejected++;
      pendingMessage =
        `You were about to press [${picked.ref}] "${name ?? ""}", but that is the page CURRENTLY OPEN. ` +
        "The screen will not change. Pick an action that changes the screen: something inside this page, " +
        "or another menu that has not been opened.";
      log("info", `Agent wanted to open "${name}" while already there; asked to pick something else.`);
      prevPrint = "";
      step--;
      continue;
    }

    /**
     * Pressing the submit button while required fields are still empty.
     *
     * The result is certain to be rejected. On a POS sign-up form the agent pressed
     * "Continue to Business Details" over and over with Business Name empty,
     * because in the image the field seemed filled with its example text, and
     * every press cost one step and one failed scene in the video. Held back
     * before running, the fields are named by ref, and the step is not
     * counted. At most twice per run, so a required field that was detected
     * wrongly (e.g. in another form on the same page) can never lock the agent.
     */
    const emptyNow = emptyRequiredFields(visible).filter((e) => !!e.inDialog === !!picked?.inDialog);
    if (
      action.kind === "click" &&
      picked &&
      (picked.tag === "button" || picked.role === "button" || picked.type === "submit") &&
      /daftar|lanjut|kirim|simpan|submit|buat akun|register|sign ?up|next|continue|selanjutnya|bayar|konfirmasi|selesai|masuk|login|log ?in|sign ?in|send|save|create account|pay\b|confirm|finish|done/i.test(
        name ?? "",
      ) &&
      !/sebelumnya|kembali|batal|back|previous|cancel/i.test(name ?? "") &&
      emptyNow.length > 0 &&
      emptySubmitRejected < 2
    ) {
      emptySubmitRejected++;
      pendingMessage =
        `You were about to press [${picked.ref}] "${name ?? ""}", but these required fields are still EMPTY: ` +
        emptyNow.map((e) => `[${e.ref}] "${e.name.slice(0, 40)}"`).join(", ") +
        ". The form will certainly be rejected. Fill those fields first, one by one with fill, then press the button. " +
        "Grey text inside a field is only an example, not input.";
      log("info", `Button "${name}" held back: ${emptyNow.length} required fields still empty.`);
      prevPrint = "";
      step--;
      continue;
    }

    /**
     * Stopping after a single feature.
     *
     * In production a bot-dashboard video stopped after opening one menu, and
     * all it contained was the sign-in plus one click. A goal that asks for
     * features to be shown needs at least three things shown after signing
     * in. Rejected once; if the agent is still sure, it may stop.
     */
    const featureSteps = exec.events
      .slice(afterLogin)
      .filter((e) => e.ok && ["click", "fill", "press"].includes(e.kind) && !closeSteps.has(e.index)).length;
    if (
      action.kind === "finish" &&
      action.outcome !== "blocked" &&
      // For tutorials whose flow asks for features to be shown: the
      // bot-dashboard run was written as "make an ad for it" and stopped
      // after one menu.
      /iklan|promosi|fitur|feature|pamer|keliling|jelajah|semua menu|\bads?\b|advert|promot|showcase|explore|all (the )?menus|every menu|look around/i.test(
        opts.goal,
      ) &&
      // A flow that limits itself ("then one feature ... Stop after that") is
      // obeyed. A note-taking app run was refused a stop even though its flow
      // really asked to stop after one feature.
      !/berhenti setelah|berhenti di situ|cukup (satu|1)|hanya (satu|1)|satu fitur|1 fitur|sampai di situ|stop after|stop there|just (one|1)\b|only (one|1)\b|one feature|1 feature|single feature/i.test(
        opts.goal,
      ) &&
      !shortFeaturesRejected &&
      featureSteps < 3 &&
      maxSteps - step >= 3
    ) {
      shortFeaturesRejected = true;
      pendingMessage =
        `This video has only shown ${featureSteps} feature actions. The goal asks for features to be shown, so it needs at least three DIFFERENT features ` +
        "really used: open a menu or part that has not been touched yet, then do one thing there whose result is visible. " +
        `${maxSteps - step} steps left in the budget.`;
      log("info", "Agent wanted to stop with too few features shown; asked to add more.");
      prevPrint = "";
      step--;
      continue;
    }
    /**
     * Claiming to be done while the form was never submitted.
     *
     * A POS-app run ended with "The process of filling in the new account
     * sign-up form is complete" while Business Name was still empty and its
     * continue button had not been pressed. If required fields are still empty
     * on screen, finish is rejected once and the fields are named.
     */
    const stillEmpty = emptyRequiredFields(visible);
    if (
      action.kind === "finish" &&
      action.outcome !== "blocked" &&
      !emptyFinishRejected &&
      stillEmpty.length > 0 &&
      maxSteps - step >= 2
    ) {
      emptyFinishRejected = true;
      pendingMessage =
        "You were about to stop, but the form on screen still has EMPTY required fields: " +
        stillEmpty.map((e) => `[${e.ref}] "${e.name.slice(0, 40)}"`).join(", ") +
        ". Your goal is not reached while this form has not been submitted. Fill those fields, then press its continue or submit button.";
      log("info", "Agent wanted to stop with an incomplete form; asked to complete it.");
      prevPrint = "";
      step--;
      continue;
    }

    if (action.kind === "finish") {
      finishedItself = true;
      log("info", `Agent finished: ${action.narration}`);
      // The model sometimes leaves "outcome" empty. The second net reads the
      // sentence, BUT only when the obstacle was really seen on the page.
      // Calling it blocked from words alone is worse than staying silent: the
      // suggestion comes out wrong, and the person pastes a session for nothing.
      /**
       * The pattern must contain a negation, not just the word "login".
       *
       * "Successfully signed in to the dashboard" and "cannot continue because
       * it requires a login" both mention signing in, but only the second is
       * blocked. What is searched for are words saying cannot, needs or must,
       * not just the name of the obstacle.
       */
      const soundsBlocked =
        /terhalang|tidak (bisa|dapat|ada|tersedia)|hanya tersedia|captcha|verifikasi|(memerlukan|perlu|harus|membutuhkan) (login|masuk|akun|mendaftar|daftar)|\bblocked\b|cannot|can't|can not|unable|not (possible|available)|only available|verification|(requires?|needs?|must|have to) (to )?(log ?in|sign ?in|sign ?up|register|an account)/i.test(
          action.narration,
        );
      if (action.outcome === "blocked" || (soundsBlocked && (seen.captcha || seen.sso || seen.login))) {
        blocked = {
          /**
           * The order decides which suggestion appears, so the most specific
           * comes first. A visible password field means the site can be
           * entered normally and only the credentials are missing, and that
           * is a completely different suggestion from "only Google is offered".
           */
          kind: seen.captcha
            ? "captcha"
            : seen.login && !opts.credentials.length
              ? "login"
              : seen.sso
                ? "sso"
                : /masuk|login|log in|daftar|akun|sign in|sign up|register|account/i.test(action.narration) &&
                    !opts.credentials.length
                  ? "login"
                  : "other",
          reason: action.narration,
        };
        log("warn", `Blocked: ${action.narration}`);
      }
      break;
    }

    log("step", `${step}. ${action.narration}`);
    tried.push(signature(action));
    const urlBefore = page.url();
    const ev = await exec.run(action, snap);
    /*
     * Only closing a blocking popup is cut (install-the-app prompts, cookies,
     * promos). A note-taking app's tour opened with the big title "Close the
     * install prompt dialog" as the first step of its video. "Back" is kept:
     * in a tutorial it is part of how it is done.
     */
    const closing =
      ev.ok &&
      action.kind === "click" &&
      !!picked &&
      (/^(tutup|batal|close|cancel|nanti( saja| dulu)?|lewati|skip|tidak,? terima kasih|no,? thanks|not now|maybe later|dismiss|x|×|✕)$/i.test(
        (name ?? "").trim(),
      ) ||
        (!!picked.iconBtn && !!picked.inDialog) ||
        /^(tutup|abaikan|lewati) (dialog|popup|pop-up|banner|iklan|ajakan|penawaran|notifikasi|pemberitahuan)/i.test(
          action.narration.trim(),
        ) ||
        /^(close|dismiss|skip) (the |this )?(dialog|popup|pop-up|banner|ad|prompt|offer|notification|cookie)/i.test(
          action.narration.trim(),
        ));
    if (closing) closeSteps.add(ev.index);

    // A new dialog appeared: the camera pulls back for a moment after this
    // action so the viewer sees the whole dialog, instead of zooming in again
    // straight away.
    const nowDialog = await page
      .evaluate(() =>
        Array.from(
          document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]'),
        ).some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 120 && r.height > 80;
        }),
      )
      .catch(() => prevHadDialog);
    if (nowDialog && !prevHadDialog) ev.revealAfter = true;
    /**
     * Effect of the action, written into the history.
     *
     * "→ ok" only means the click was sent. What helps the next step is what
     * happened: moved to another page, a dialog opened, or nothing changed at all.
     */
    const effects: string[] = [];
    try {
      const a0 = new URL(urlBefore);
      const a1 = new URL(page.url());
      if (a0.host !== a1.host) effects.push(`moved to site ${a1.host}`);
      else if (a0.pathname + a0.search !== a1.pathname + a1.search) effects.push(`moved to ${a1.pathname}${a1.search}`);
    } catch {
      /* odd url, skip */
    }
    if (nowDialog && !prevHadDialog) effects.push("dialog opened");
    if (!nowDialog && prevHadDialog) effects.push("dialog closed");
    prevHadDialog = nowDialog;

    const label = [
      `#${step}`,
      action.kind,
      action.ref ? `[${action.ref}]` : "",
      // Secret values never go in. The rest must, because a history that only
      // says "filled in the email" leaves the agent blind to which emails
      // have already been rejected.
      !ev.secret && action.text ? `= "${action.text.slice(0, 44)}"` : "",
      action.narration,
      ev.ok ? `→ ok${effects.length ? `, ${effects.join(", ")}` : ""}` : `→ FAILED (${ev.error})`,
    ]
      .filter(Boolean)
      .join(" ");
    history.push(label);
    if (!ev.ok) log("warn", `Step ${step} failed: ${ev.error}`);

    const record: StepRecord = { action, element: picked, url: urlBefore, event: ev };
    steps.push(record);
    opts.onStep?.(record);
  }

  // The last action has not been judged yet: the loop stopped before the next snapshot.
  try {
    const finalSnap = await snapshotPage(page);
    markNoop(prevPrint !== "" && fingerprint(finalSnap) === prevPrint);
  } catch {
    /* fine, only one judgement lost */
  }

  await sleep(C.OUTRO_MS);

  const events = exec.events;
  // Closing a popup is not a step worth watching; it is cut from the video.
  for (const ev of events) if (closeSteps.has(ev.index)) ev.noop = true;
  if (closeSteps.size) log("info", `${closeSteps.size} popup-closing steps cut from the video.`);

  /**
   * Stopped because the step budget ran out, not because the goal was done.
   *
   * The difference is big for the user, and from the outside both look the
   * same: a video that just ends. Without this note, a long flow that really
   * needs more steps reads as a broken product.
   */
  if (!finishedItself && steps.length >= maxSteps) {
    blocked = {
      kind: "steps",
      reason: `The flow was not complete when the budget of ${maxSteps} steps ran out.`,
    };
    log("warn", `The budget of ${maxSteps} steps ran out before the flow was complete.`);
  }

  return {
    events,
    plan,
    achieved: finishedItself && !blocked,
    blocked,
    usage,
    steps,
    noopCandidates: [...noopCandidates],
  };
}

/**
 * Noop steps are confirmed through their pixels, then cut from the video.
 *
 * Must run after `rec.stop()`, because it compares the recorded frames. The
 * threshold is small: a focus ring or the colour of a pressed button may still
 * change, but nothing else. Sets `noop` on the confirmed events (the same
 * objects `result.steps[].event` points at) and returns how many it marked.
 */
export async function markNoopEvents(
  result: AgentLoopResult,
  frames: FrameRef[],
  framesDir: string,
  preset: Preset,
  onLog?: (e: LogEntry) => void,
): Promise<number> {
  const candidates = new Set(result.noopCandidates);
  let marked = 0;
  for (const ev of result.events) {
    if (!candidates.has(ev.index) || ev.noop) continue;
    const share = await changedRegion(ev, frames, framesDir, preset);
    if (share < 0.0025) {
      ev.noop = true;
      marked++;
    }
  }
  if (marked) onLog?.({ t: Date.now(), level: "info", message: `${marked} steps did not change the screen, cut from the video.` });
  return marked;
}

/**
 * Closing summary of a finished run, in the narration language. Its token
 * usage is added to `result.usage`.
 */
export async function summarizeAgentRun(
  result: AgentLoopResult,
  opts: { llm: LLM; language: string; goal: string; signal?: AbortSignal },
): Promise<string> {
  return summarizeRun({
    llm: opts.llm,
    language: opts.language,
    goal: opts.goal,
    history: result.steps.map((s) => `${s.event.index + 1}. ${s.event.narration}`),
    signal: opts.signal,
    onUsage: (u) => {
      result.usage.calls += 1;
      result.usage.inputTokens += u.inputTokens;
      result.usage.outputTokens += u.outputTokens;
    },
  });
}
