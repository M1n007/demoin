/**
 * Shared types for the whole engine: what the agent decides, what the browser
 * sees, and what actually happened during the recording.
 */

export type ActionKind =
  | "goto"
  | "click"
  | "fill"
  | "press"
  | "scroll"
  | "wait"
  | "finish";

/** Cinematic effect used to highlight one step. */
export type FocusEffect = "zoom" | "spotlight" | "lightbox" | "none";

export type DeviceId = "desktop" | "mobile";

/** "howto" completes a task; "tour" introduces what is on screen while it goes. */
export type DemoMode = "howto" | "tour";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A raw decision from the model. */
export interface AgentAction {
  thought?: string;
  kind: ActionKind;
  /** element ref from the snapshot, e.g. "e12" */
  ref?: string;
  /** text to type for fill, or the url for goto */
  text?: string;
  key?: string;
  deltaY?: number;
  ms?: number;
  /** one sentence that explains this step to the viewer */
  narration: string;
  /** highlight effect the agent picked for this step */
  focus?: FocusEffect;
  /** what the agent thinks is still missing before the goal is reached */
  remaining?: string;
  /** finish only: the goal was reached, or the agent stopped because it was blocked */
  outcome?: "achieved" | "blocked";
  /** plan section this step works on (1-based) */
  section?: number;
  /** that section has been shown well enough after this step */
  sectionDone?: boolean;
  /** replacement for the plan sections that are NOT done yet */
  newPlan?: PlanDraft[];
}

/** One section of the video plan, like one act of a storyboard. */
export interface PlanDraft {
  title: string;
  /** what the viewer must see by the end of this section */
  goal: string;
  /** guide = instruct step by step; tour = introduce what is visible */
  style: "guide" | "tour";
  /** estimated number of steps */
  steps: number;
}

export interface PlanSection extends PlanDraft {
  status: "todo" | "active" | "done";
}

export interface DemoPlan {
  /** one sentence: the story of this video */
  summary: string;
  sections: PlanSection[];
  /** how many times the plan has been revised */
  revisions: number;
}

/** One interactive element from a DOM snapshot. */
export interface SnapEl {
  ref: string;
  tag: string;
  role: string;
  name: string;
  type?: string;
  value?: string;
  /**
   * Grey hint text inside an empty field. Kept apart from the name because on
   * a screenshot it looks exactly like a filled-in value.
   */
  placeholder?: string;
  rect: Rect;
  /** visual container (card/form/dialog) around it, used to frame the camera */
  group?: Rect;
  inView: boolean;
  /** lives inside the dialog that is currently open */
  inDialog?: boolean;
  /** sign in with Google, Apple and the like: the agent has no way through */
  thirdParty?: boolean;
  /** a button whose only content is an icon */
  iconBtn?: boolean;
  /** not an official control, but clearly meant to be clicked */
  clickable?: boolean;
  /** a field that must be filled before the form can be sent */
  required?: boolean;
  /** present but not pressable yet; usually waiting on another condition */
  disabled?: boolean;
  /** menu item or tab that points at the page currently open */
  active?: boolean;
}

export interface PageSnapshot {
  url: string;
  /** a modal/dialog is open on this page */
  hasDialog: boolean;
  /** a captcha is on this page: reCAPTCHA, hCaptcha, Turnstile and similar */
  hasCaptcha: boolean;
  /**
   * Error messages currently shown, e.g. "Email already registered".
   *
   * This is the most common reason web agents go in circles: the click
   * worked, the button was right, but the server refused. Without the message
   * the agent only sees a page that "changed a little" and retries with random
   * guesses until its step budget is gone on the same form.
   */
  errors: string[];
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewport: { w: number; h: number };
  elements: SnapEl[];
  text: string;
}

/** An action that was actually executed, with its timing inside the recording. */
export interface TimelineEvent {
  index: number;
  /** page URL AFTER this action, shown in the fake browser bar */
  url: string;
  /**
   * URL BEFORE the action ran. Used to tell whether two consecutive steps
   * happened on the same page so their coordinates can be compared. Using
   * `url` for that is wrong: it has already changed when the action navigates.
   */
  urlBefore?: string;
  kind: ActionKind;
  narration: string;
  /** target position relative to the viewport (CSS px). null for target-less actions. */
  target: Rect | null;
  /**
   * What the CAMERA frames: the target's visual container rather than the
   * raw target, so the whole card or form is shown. Falls back to the target
   * when there is no clear container.
   */
  frame?: Rect;
  /**
   * The part of the screen that actually CHANGED because of this action.
   *
   * Only set when the change is outside the target itself, e.g. a preview
   * that updates when a colour is picked in a side panel.
   */
  changed?: Rect;
  cursorFrom: Point | null;
  cursorTo: Point | null;
  /** ms since the recording started */
  moveStart: number;
  /**
   * When the explanation pause in front of the action began (ms since the
   * recording started). Voiceover clips are anchored here.
   */
  narrationAt?: number;
  actAt: number;
  /**
   * When the part worth WATCHING ends (click ripple done, typing done). The
   * span moveStart..visualEnd is kept 1:1 in the video; the rest (waiting for
   * the page to load / the agent thinking) is compressed.
   */
  visualEnd: number;
  actEnd: number;
  /** true when this action typed a credential; the value is never stored */
  secret: boolean;
  effect: FocusEffect;
  /**
   * This action opened a dialog. The camera pulls back for a moment afterwards
   * so the viewer sees the whole dialog instead of zooming straight in again.
   */
  revealAfter?: boolean;
  /**
   * The action was sent but the screen did not change at all: same page, same
   * content, same pixels. Steps like this are cut from the video, because all
   * the viewer would see is the camera moving in and nothing happening.
   */
  noop?: boolean;
  ok: boolean;
  error?: string;
}

export interface Timeline {
  events: TimelineEvent[];
  durationMs: number;
  viewport: { w: number; h: number };
}

export interface FrameRef {
  file: string;
  /** ms since the recording started */
  t: number;
}

export interface CredentialInput {
  /** label the agent sees, e.g. EMAIL / PASSWORD */
  label: string;
  value: string;
}

export type LogLevel = "info" | "step" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: LogLevel;
  message: string;
}

/** Why the agent stopped before reaching its goal. */
export interface BlockedReason {
  kind: "captcha" | "sso" | "login" | "steps" | "other";
  reason: string;
}

export interface TokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
