import type { LLM, Part, Schema, Usage } from "../llm/types.js";
import { renderSnapshot } from "../browser/snapshot.js";
import type { AgentAction, ActionKind, DemoMode, DemoPlan, FocusEffect, PageSnapshot, PlanDraft } from "../types.js";

/*
 * How much the model "thinks".
 *
 * It used to be zero for every call, to keep things fast and cheap. The
 * result was an agent that answered on reflex: it picked the button closest
 * to a word in the goal, not the one that made the most sense for the story.
 * A little thinking per step and a lot of thinking for the plan is far cheaper
 * than a video that has to be recorded again. So: "low" for every step,
 * "high" for the plan, "none" for the closing summary.
 */

const PLAN_ITEM: Schema = {
  type: "object",
  properties: {
    title: { type: "string", description: "section name, 2-5 words, e.g. 'Sign in to the account' or 'Guest list'" },
    goal: { type: "string", description: "what the viewer must SEE by the end of this section, one sentence" },
    style: { type: "string", enum: ["guide", "tour"] },
    steps: { type: "integer", description: "estimated number of steps, 1-6" },
  },
  required: ["title", "goal", "style", "steps"],
};

function actionSchema(language: string): Schema {
  return {
    type: "object",
    properties: {
      thought: {
        type: "string",
        description: "Short reason for choosing this action (1 sentence max).",
      },
      kind: {
        type: "string",
        enum: ["goto", "click", "fill", "press", "scroll", "wait", "finish"],
      },
      ref: { type: "string", description: "element ref, e.g. e12. Required for click & fill." },
      text: {
        type: "string",
        description: "Text for fill, or the full URL for goto. Leave empty when unused.",
      },
      key: { type: "string", description: "Key name for press, e.g. Enter." },
      deltaY: { type: "number", description: "Scroll distance in px, may be negative." },
      ms: { type: "number", description: "How long to wait in ms for the wait action." },
      narration: {
        type: "string",
        description: `One sentence in ${language} that explains this step to the viewer of the video.`,
      },
      focus: {
        type: "string",
        enum: ["zoom", "spotlight", "lightbox", "none"],
        description: "Cinematic effect used to highlight this step.",
      },
      remaining: {
        type: "string",
        description:
          "One short sentence: WHAT IS STILL MISSING before the goal is reached, " +
          "judged from the current page. Leave empty when nothing is.",
      },
      section: {
        type: "integer",
        description: "Number of the VIDEO PLAN section this step works on.",
      },
      sectionDone: {
        type: "boolean",
        description: "true when, after this step, that section has been shown well enough and the next step moves to another section.",
      },
      newPlan: {
        type: "array",
        items: PLAN_ITEM,
        description:
          "Fill ONLY when the plan for the sections that are not done yet must be replaced, e.g. after signing in " +
          "when the real app menu has only just become visible. Holds the replacement sections for the rest of the video.",
      },
      outcome: {
        type: "string",
        enum: ["achieved", "blocked"],
        description:
          "ONLY for kind=finish. 'achieved' when the goal is truly visible on screen. " +
          "'blocked' when you stop because something cannot be passed, e.g. a captcha, " +
          "a third-party sign-in, two-step verification, or credentials that were not provided.",
      },
    },
    required: ["kind", "narration", "focus"],
  };
}

function system(language: string): string {
  return `You are an agent that operates a website inside a browser to make a TUTORIAL VIDEO.

You are given: a GOAL, a VIDEO PLAN, a SCREENSHOT of the current screen, and a page snapshot (list of interactive elements + page text).
Your job: choose the ONE next action that makes the most sense for reaching the goal, like a person demoing a product.

EYES
- The screenshot is what the viewer sees right now. Every visible interactive element has a
  coloured box with its ref label (e12, e13, ...), exactly the same as the refs in the element list.
  Blue = button, pink = link, green = input field, yellow = other.
- TRUST THE IMAGE for layout: which is the main menu, what stands out, what is covered by a
  dialog, and whether the previous action really changed the screen. Use the text list for exact
  names and for elements off screen.
- Pick the ref from the label attached to the thing you mean. When two elements have the same
  name, the image decides which one is right.

VIDEO PLAN
- This video is built in SECTIONS, like acts in a storyboard. Work through the sections in order,
  set "section" to the number of the section you are working on, and set "sectionDone" true on
  the step that completes it.
- Each section has a style. "guide": the narration instructs ("Click the Sign in button."). "tour":
  the narration introduces what is visible and what it is for ("The Guest List keeps track of every
  invitation."), 12 words max.
- The plan may and MUST be revised through "newPlan" when reality turns out different: for example
  after signing in, when the app menu has only just become visible. Replacement sections must name
  menus that ACTUALLY EXIST on screen, not guesses.
- The step budget is shared across the remaining sections. If the remaining budget is not enough
  for all sections, condense: one step per section, just enough to open it so the viewer knows it exists.

ACTION RULES
- click  : needs "ref". For buttons, links, tabs, checkboxes.
- fill   : needs "ref" + "text". For input/textarea. One field per step.
- press  : needs "key" (e.g. Enter). To submit a form from the keyboard.
- scroll : needs "deltaY" (px, positive = down). Use it when the element you want is probably further down.
- wait   : needs "ms". RARELY needed: every action already waits for the page
           to finish loading on its own. One "wait" uses up one step of the
           budget without showing the viewer anything. Use it only when the
           page is really still processing and nothing at all can be clicked.
- goto   : needs "text" with a full URL. ONLY when truly stuck; prefer navigating by clicking.
- finish : the goal has been reached and the end result is VISIBLE on screen.

HOW TO THINK
- You may only use refs that EXIST in the element list. Never invent a ref.
- If an element is marked "(off screen, needs scrolling)", scroll towards it first before clicking.
- Refuse detours: take the shortest path to the goal.
- Elements marked (CURRENTLY OPEN) are the menu or tab of the page you are on RIGHT NOW.
  Never press them: the screen does not change and the viewer only sees the camera move in
  and then nothing happens. If you want to show the content of this page, it is already
  visible; press something INSIDE this page or move to another menu.
- Before choosing, ask: what will CHANGE on screen after this action? If the answer is
  nothing, choose another action.
- Steps in the HISTORY marked "DID NOT CHANGE ANYTHING" have already been cut from the video. Do not
  repeat the same action, and do not pick elements of the same kind.
CHOOSING WHAT DESERVES TO BE IN THE VIDEO
The rule in one sentence: WIDE BUT SHALLOW. Touch every main part of the product,
each just enough, do not dig through one part until it is exhausted.
- A demo video is not a completeness test, and not a tour of one corner either. What
  viewers want is the whole picture: what this product can do. Ten steps in one
  panel leave the impression that the product is only as big as that panel.
- First identify the big parts of the product from its menus, tabs and panels, then
  split your step budget across those parts. With four parts and a budget of twelve
  steps, roughly three steps per part.
- WITHIN one part, one example is enough. Changing the accent colour once already
  explains that the look can be customised; changing the colour, then the font, then
  the font size, then the line height only repeats the same message.
- DO NOT skip a part entirely just because it is optional. Picking a theme, template
  or layout is often exactly what sells best, and the viewer needs to know it exists.
  One or two steps for each is enough.
- Fields marked (REQUIRED) come first within their part, because that is the path
  every user has to take. Optional fields may be skipped.
- Prefer actions whose effect is VISIBLE on screen. If pressing something changes
  nothing the viewer can see, the step is wasted even though the action succeeded.
- All of this applies UNLESS the goal explicitly asks otherwise. If it says "fill
  in every field" or "focus on the checkout page only", do exactly that.

- One setting only needs to be CHANGED ONCE. Pressing Standard, then Tight, then Relaxed
  on the same setting is not a demo, it is hesitation, and the viewer learns nothing
  from it. Show one option, then move on to something else.
- Do not go back to a setting you already changed. If everything the goal asks for
  has been shown, stop with "finish"; do not look for extras until your step budget runs out.
- Things that pop up suddenly come in TWO kinds, and confusing them ruins the
  whole demo:
  a) OBSTACLES, unrelated to the goal: cookie banners, newsletter sign-ups, ads,
     notification offers. These may be closed.
  b) PART OF THE GOAL: a sign-up form, a sign-in dialog, choosing a plan, a
     confirmation. These are EXACTLY what you are looking for. Work through them
     completely: tick the consent box, fill in the fields, press the continue button.
     DO NOT press the close, X, cancel or "maybe later" button.
- If the element list only contains elements marked [dialog], a dialog is blocking
  the whole page. Nothing behind it can be pressed at all, so do not look for it.
  Answer the dialog first: pick one of its buttons, and the page becomes usable again.
- The fastest way to tell them apart: LOOK AT THE CONTENT, not the title. A dialog that
  is part of the goal almost always has input fields, choices, or a consent box to
  tick. A dialog with only pictures, explanations and a "Next" button is an
  ONBOARDING TOUR: it teaches the product, it does not do your goal. An onboarding
  tour almost always has "Skip" or an X. Use that. Pressing "Next" over and over only
  moves you to the next slide, and your whole step budget is spent inside the same dialog.
- When in doubt about which kind it is, WORK THROUGH it. Closing a dialog that turns out
  to be part of the goal wastes the demo and cannot be undone, while working through
  something that turns out to be an obstacle only costs one step.
- One card often has several clickable parts, and they do DIFFERENT things: the image
  opens a detail page or a sales page, while the small link below it is what actually
  does what you want. If there is an element whose name is a CALL TO ACTION ("Open this
  design", "Select", "Use this template", "View details"), pick that, not the title or
  the image. Titles and images tend to take you away from the page you are working on.
- If the previous step failed, DO NOT repeat exactly the same action. Try another element or scroll.
- If the page shows an ERROR MESSAGE, your submission was rejected even though the click
  worked. Fix EXACTLY what the message names, not another field: "email already
  registered" means the EMAIL must change; changing the password does not help at all.
- A message saying the data is already in use or the account already exists has two ways
  out: change the data to something truly new, or go to the sign-in page if what you
  need can only be reached by signing in. Pick whichever is closest to your goal; do not
  resubmit the same form.
- For values that must be unique (email, username), DO NOT use a value that already
  appeared in the STEP HISTORY: that value has already been rejected. Similar guesses
  are rejected too. Make one that cannot possibly collide, e.g. insert a long random
  string of digits, like "demo8402719@mail.com", not "random@email.com" or "test@email.com".
- Once the field named in the message is fixed AND no required field is EMPTY anymore,
  the next step is pressing the submit button. Input that is not submitted means
  nothing, and the old error message stays on screen until you submit again.
  Swapping the contents of filled fields without ever pressing submit burns the step
  budget for nothing.
- Conversely, pressing submit while the list of REQUIRED FIELDS STILL EMPTY is not
  exhausted WILL be rejected again. Fill every field in that list first, one by one.
- Empty fields often look filled in the image because of their grey example text
  ("John Doe", "My Store", "email@example.com"). What decides whether a field is
  filled is the element list: (filled: ...) or (EMPTY).
- Fill a field according to its NAME, in the format of its example: a subdomain or
  username field whose example is "my-store" gets lowercase letters joined by hyphens
  without spaces, e.g. "dusk-coffee-8402", not the business name as is.
- If signing in is needed and credentials are available, look for the sign-in/login button first.
  SIGNING IN is not the same as SIGNING UP. Buttons like "Create a free invitation", "Get started",
  "Try for free" or "Sign up" usually lead to a sign-up form for a NEW account. With credentials,
  look for a "Sign in", "Login", "Log in" or "Already have an account?" link. If you end up at a form
  asking for a name, a password confirmation, or data other than email and password, it is a
  SIGN-UP form: do not fill it, look for a "Sign in" or "Already have an account?" link on that form.
- If no sign-in link is visible anywhere, open its address directly with goto, e.g.
  <site address>/login or <site address>/signin.
- Fill input fields DIRECTLY with fill. Do not click the field first: fill already moves the
  cursor to that field, and an extra click only makes the viewer see the same field twice.
- Do not refill a field that already holds the right value. Move on to the next field
  or press the sign-in button.
- Buttons marked (SIGN IN THROUGH A THIRD PARTY) cannot be passed: the window belongs to another
  domain. Always choose the regular email and password path. If that is the only
  way in, stop with "finish" and state the reason.
- A captcha must not be solved, must not be clicked, and must not be guessed.
  If a captcha blocks the way to the goal, stop with "finish" and state that the
  site asks for a captcha.
- This video is for viewers: stop with "finish" when the requested end result is on screen,
  not right after the save button was clicked.
- Every time you use "finish", the "outcome" field MUST be filled, never left empty.
  Use "achieved" when the requested result is truly visible on screen.
  Use "blocked" when you stop because something cannot be passed: a captcha,
  a third-party sign-in, two-step verification, or credentials that were not provided.
  "blocked" is not your failure; it is the only way the user learns why the
  video stopped early and what they must fix.

CREDENTIALS
- To fill a secret field, write EXACTLY its placeholder, e.g. {{EMAIL}} or {{PASSWORD}}.
- You NEVER see the real value and must not guess it.
- Never create a new account, pay, delete data, or change account settings
  unless the goal explicitly asks for it.

HIGHLIGHT EFFECT (the "focus" field)
- "zoom"      : default. Normal-sized buttons/links/fields, the camera moves in smoothly on the element.
- "spotlight" : the surroundings are dimmed, only the area around the cursor stays bright.
                Use it for items inside a menu, dropdown, sidebar, or steps in a dense UI.
- "lightbox"  : a small area is lifted into a big close-up in the middle of the screen.
                Use it for small controls: icons, checkboxes, a date in a calendar, toggles, badges.
- "none"      : no highlight. For scrolling, waiting, or changing pages.

NARRATION
- Always fill "narration" with one sentence in ${language}, following the style of the plan section
  being worked on. Guide: "Click the Sign in button in the top right corner." or "Enter the registered
  email address." Tour: explain what is visible and what it is for, 12 words max,
  e.g. "The Guests page sums up who has confirmed they will attend."
- Consecutive narrations must sound like one story, not a list of identical commands.
  Do not start every sentence with the same word.
- For secret fields, do not mention the value. Just "Enter the account password."
- Do not use em dashes. Use a comma, a colon, or a new sentence.`;
}

/**
 * A tour is not just a guide with different wording.
 *
 * A guide instructs: "Click the Save button." The viewer already knows what
 * they want and only needs to know how. A tour introduces: "This is the
 * summary panel, it shows today's sales." The viewer does not yet know what
 * the product can do, so what is wanted is not the shortest path but the
 * parts most worth seeing.
 */
const TOUR = `
TOUR MODE
This video is not a guide to doing a task but a product introduction. The
viewer has never used this site and is weighing whether it suits them.
- Pick the parts that best explain what the product is for, not the shortest
  path to one goal. Walk around: open its main menu, show the page at the heart
  of daily use, stop at the numbers or lists that speak for themselves.
- Scrolling to show one important part of a page is fine, and is often the
  best step in a tour.
- DO NOT change data: do not save, delete, buy, or submit anything. A tour
  only looks around.
- Stop with "finish" once the main parts have been shown; do not wait until
  you run out of steps.

NARRATION IN TOUR MODE
The sentence EXPLAINS what is being seen; it does not tell anyone to click.
- Don't: "Click the Reports menu."
- Do:    "In Reports, every sale is summarised per day."
Say what it is good for to its user, not just the name of the button.
Its length MUST be one sentence, AT MOST 12 WORDS. Long sentences get cut off on
screen and the viewer loses exactly the closing part. If it feels too short,
drop the extra detail; do not add words.`;

type OnUsage = (u: Usage) => void;

export interface DecideInput {
  llm: LLM;
  /** language the narration is written in */
  language: string;
  goal: string;
  /** annotated screenshot (base64 JPEG), if any */
  image?: string | null;
  plan?: DemoPlan | null;
  mode?: DemoMode;
  startUrl: string;
  credentialLabels: string[];
  snapshot: PageSnapshot;
  history: string[];
  stepsLeft: number;
  /** what was still missing according to the previous step, carried forward as context */
  remaining?: string;
  repeatWarning?: string;
  onUsage?: OnUsage;
  signal?: AbortSignal;
}

export async function decideNextAction(input: DecideInput): Promise<AgentAction> {
  const creds = input.credentialLabels.length
    ? input.credentialLabels.map((l) => `{{${l}}}`).join(", ")
    : "(the user provided no credentials)";

  const parts = [
    `GOAL: ${input.goal}`,
    `START SITE: ${input.startUrl}`,
    `AVAILABLE CREDENTIAL PLACEHOLDERS: ${creds}`,
    `STEPS LEFT: ${input.stepsLeft}`,
    "",
    "STEP HISTORY:",
    input.history.length ? input.history.join("\n") : "  (none yet)",
    "",
    // Without this, every step re-derives its intent from the history, and an
    // intention formed at step two can be lost by step five.
    input.plan ? `${renderPlan(input.plan, input.stepsLeft)}\n` : "",
    input.remaining ? `WHAT YOU SAID WAS STILL MISSING: ${input.remaining}\n` : "",
    input.repeatWarning ? `WARNING: ${input.repeatWarning}\n` : "",
    "CURRENT PAGE:",
    renderSnapshot(input.snapshot),
    "",
    "Choose ONE next action.",
  ];

  const content: Part[] = [];
  if (input.image) {
    content.push({ text: "CURRENT SCREENSHOT (label = element ref):" });
    content.push({ image: { mimeType: "image/jpeg", data: input.image } });
  }
  content.push({ text: parts.join("\n") });

  const raw = await input.llm.json<Record<string, unknown>>({
    system: input.mode === "tour" ? system(input.language) + TOUR : system(input.language),
    messages: [{ role: "user", parts: content }],
    schema: actionSchema(input.language),
    temperature: 0.15,
    effort: "low",
    signal: input.signal,
    onUsage: input.onUsage,
  });

  return normalize(raw);
}

const KINDS: ActionKind[] = ["goto", "click", "fill", "press", "scroll", "wait", "finish"];
const FOCUSES: FocusEffect[] = ["zoom", "spotlight", "lightbox", "none"];

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length ? s : undefined;
}

function normalize(raw: Record<string, unknown>): AgentAction {
  const kindRaw = String(raw.kind ?? "").toLowerCase() as ActionKind;
  const kind = KINDS.includes(kindRaw) ? kindRaw : "finish";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  const focusRaw = String(raw.focus ?? "").toLowerCase() as FocusEffect;

  return {
    kind,
    focus: FOCUSES.includes(focusRaw) ? focusRaw : undefined,
    thought: str(raw.thought),
    ref: str(raw.ref),
    text: str(raw.text),
    key: str(raw.key),
    deltaY: num(raw.deltaY),
    ms: num(raw.ms),
    narration: str(raw.narration) ?? "Continuing with the next step.",
    remaining: str(raw.remaining),
    outcome: raw.outcome === "achieved" || raw.outcome === "blocked" ? raw.outcome : undefined,
    section: typeof raw.section === "number" && Number.isFinite(raw.section) ? Math.round(raw.section) : undefined,
    sectionDone: raw.sectionDone === true,
    newPlan: Array.isArray(raw.newPlan) ? drafts(raw.newPlan) : undefined,
  };
}

/** Plan sections from the model's answer, cleaned up and capped. */
function drafts(v: unknown[]): PlanDraft[] {
  return v
    .map((x) => x as Record<string, unknown>)
    .filter((x) => x && typeof x.title === "string" && x.title.trim())
    .slice(0, 8)
    .map((x) => ({
      title: String(x.title).trim().slice(0, 48),
      goal: String(x.goal ?? "").trim().slice(0, 160),
      style: x.style === "tour" ? "tour" : "guide",
      steps: Math.max(1, Math.min(6, Math.round(Number(x.steps) || 2))),
    }));
}

/** The plan in the form the model reads at every step. */
export function renderPlan(plan: DemoPlan, stepsLeft: number): string {
  const rest = plan.sections.filter((s) => s.status !== "done");
  const needed = rest.reduce((a, s) => a + s.steps, 0);
  const lines = [`VIDEO PLAN: ${plan.summary}`];
  plan.sections.forEach((s, i) => {
    const mark = s.status === "done" ? "[done]  " : s.status === "active" ? "[ACTIVE]" : "[todo]  ";
    lines.push(`  ${mark} ${i + 1}. ${s.title} (${s.style}, ~${s.steps} steps): ${s.goal}`);
  });
  if (rest.length && needed > stepsLeft)
    lines.push(
      `  ${stepsLeft} steps left in the budget, the rest of the plan needs ~${needed}. Condense: one step per remaining section is enough.`,
    );
  if (!rest.length) lines.push("  Every section is done. If the end result is visible, end with finish.");
  return lines.join("\n");
}

/**
 * Builds the storyboard before the first step.
 *
 * Without a plan the agent only looks one step ahead: it presses the button
 * that most resembles a word in the goal, then sinks into the first part it
 * finds. With a plan, every step knows which act it is in, how many steps
 * that act has, and which acts are still waiting.
 */
export async function planDemo(input: {
  llm: LLM;
  language: string;
  goal: string;
  mode?: DemoMode;
  startUrl: string;
  credentialLabels: string[];
  snapshot: PageSnapshot;
  image?: string | null;
  maxSteps: number;
  onUsage?: OnUsage;
  signal?: AbortSignal;
}): Promise<DemoPlan | null> {
  const system = `You are the director of tutorial videos and product demos. Before recording, you build a storyboard: the video is split into several SECTIONS in order.

Principles of a good storyboard:
- Follow the intent of the goal. "How to ..." means a step-by-step guide until the result is visible. "Introduce", "show the features", "tour" means an introduction: stop briefly at each main part of the product.
- A mixed goal is split in its own order. Example "log in and then introduce all the features": section 1 "Sign in to the account" (guide), then one section per main feature (tour).
- One section = one thing the viewer understands. 1 to 4 steps per section. The last section shows the result or a summary, not just the last click.
- The total steps of all sections MUST NOT exceed the budget. Keep one step spare to finish.
- Name menus or pages that are ACTUALLY visible on the screen or in the page text. If the real features only become visible after signing in, write one general section like "Explore the main menu"; the agent will revise it after signing in.
- Wide but shallow: five sections of one or two steps each is better than one section dug into for ten steps.
- Do not plan to delete data, pay, or create an account unless the goal asks for it.
- Tour mode chosen by the user: ${input.mode === "tour" ? "YES, every section uses the tour style" : "no, but introduction sections may use the tour style"}.
- Available credentials: ${input.credentialLabels.length ? input.credentialLabels.map((l) => `{{${l}}}`).join(", ") : "none"}. If the goal needs signing in and the credentials are there, the first section is signing in.
- Write the section titles and goals in ${input.language}.

Reply with JSON: summary (one sentence telling the story of the video) and sections (2-7 sections).`;
  const parts: Part[] = [];
  if (input.image) {
    parts.push({ text: "The first page as seen:" });
    parts.push({ image: { mimeType: "image/jpeg", data: input.image } });
  }
  parts.push({
    text: [
      `GOAL: ${input.goal}`,
      `SITE: ${input.startUrl}`,
      `STEP BUDGET: ${input.maxSteps}`,
      "",
      "FIRST PAGE:",
      renderSnapshot(input.snapshot),
    ].join("\n"),
  });
  try {
    const out = await input.llm.json<{ summary?: string; sections?: unknown[] }>({
      system,
      messages: [{ role: "user", parts }],
      schema: {
        type: "object",
        properties: { summary: { type: "string" }, sections: { type: "array", items: PLAN_ITEM } },
        required: ["summary", "sections"],
      },
      temperature: 0.3,
      effort: "high",
      signal: input.signal,
      onUsage: input.onUsage,
    });
    const sections = drafts(out.sections ?? []);
    if (!sections.length) return null;
    if (input.mode === "tour") for (const s of sections) s.style = "tour";
    return {
      summary: String(out.summary ?? "").trim().slice(0, 200),
      sections: sections.map((s, i) => ({ ...s, status: i === 0 ? "active" : "todo" })),
      revisions: 0,
    };
  } catch (e) {
    // An abort must stop the run, not be swallowed as "no plan".
    if (input.signal?.aborted) throw e;
    // Without a plan the agent still runs as it used to; the plan is a bonus.
    return null;
  }
}

/** Apply one step's report to the plan: which section is active, done, or replaced. */
export function advancePlan(plan: DemoPlan, a: AgentAction): DemoPlan {
  const p: DemoPlan = { ...plan, sections: plan.sections.map((s) => ({ ...s })) };
  const n =
    a.section && a.section >= 1 && a.section <= p.sections.length
      ? a.section - 1
      : p.sections.findIndex((s) => s.status !== "done");
  if (n >= 0) {
    // Sections before the one being worked on are considered passed.
    for (let i = 0; i < n; i++) if (p.sections[i].status !== "done") p.sections[i].status = "done";
    p.sections[n].status = a.sectionDone ? "done" : "active";
  }
  if (a.newPlan?.length && p.revisions < 4) {
    const kept = p.sections.filter((s) => s.status === "done" || s.status === "active");
    p.sections = [...kept, ...a.newPlan.map((s) => ({ ...s, status: "todo" as const }))].slice(0, 10);
    p.revisions++;
  }
  // There is always one "active" section while anything is left.
  if (!p.sections.some((s) => s.status === "active")) {
    const nx = p.sections.find((s) => s.status === "todo");
    if (nx) nx.status = "active";
  }
  return p;
}

/** Style of the section being worked on, used to decide the reading pause in the recording. */
export function currentStyle(plan: DemoPlan | null): "guide" | "tour" | null {
  return plan?.sections.find((s) => s.status === "active")?.style ?? null;
}

/** Closing summary to show to the user. */
export async function summarizeRun(input: {
  llm: LLM;
  language: string;
  goal: string;
  history: string[];
  onUsage?: OnUsage;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    const out = await input.llm.json<{ summary?: string }>({
      system: `Summarise the following tutorial flow into 1-2 readable sentences in ${input.language}. Reply with JSON {"summary": "..."}.`,
      messages: [
        {
          role: "user",
          parts: [{ text: `GOAL: ${input.goal}\n\nSTEPS:\n${input.history.join("\n")}` }],
        },
      ],
      schema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
      effort: "none",
      signal: input.signal,
      onUsage: input.onUsage,
    });
    return out.summary ?? "";
  } catch {
    return "";
  }
}
