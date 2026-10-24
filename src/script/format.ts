import { promises as fs } from "node:fs";
import YAML from "yaml";
import { z } from "zod";
import type { AgentAction, SnapEl } from "../types.js";

/**
 * A demo script: the steps an agent took, written down so they can be played
 * back without a model.
 *
 * Elements are stored by what a person would call them (role, accessible name,
 * placeholder) plus where they were, never by the snapshot ref, which only
 * lives for one page load. That makes a script survive copy changes and
 * re-deploys well enough to regenerate a product's demo video on every
 * release, and readable enough to edit by hand.
 */

const target = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
  type: z.string().optional(),
  placeholder: z.string().optional(),
  /** centre of the element when it was recorded (CSS px, viewport) */
  near: z.object({ x: z.number(), y: z.number() }).optional(),
  /** path of the page it was on, to tell same-named buttons apart */
  page: z.string().optional(),
});
export type ScriptTarget = z.infer<typeof target>;

const common = {
  narration: z.string().default(""),
  focus: z.enum(["zoom", "spotlight", "lightbox", "none"]).optional(),
};

export const stepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("click"), target, ...common }),
  z.object({ do: z.literal("fill"), target, text: z.string(), ...common }),
  z.object({ do: z.literal("press"), key: z.string(), target: target.optional(), ...common }),
  z.object({ do: z.literal("scroll"), deltaY: z.number(), target: target.optional(), ...common }),
  z.object({ do: z.literal("wait"), ms: z.number().int().positive(), ...common }),
  z.object({ do: z.literal("goto"), url: z.string(), ...common }),
]);
export type ScriptStep = z.infer<typeof stepSchema>;

export const scriptSchema = z.object({
  demoin: z.literal(1),
  url: z.string(),
  goal: z.string().default(""),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  mode: z.enum(["howto", "tour"]).default("howto"),
  style: z.enum(["auto", "zoom", "spotlight", "lightbox", "none"]).default("auto"),
  language: z.string().default("English"),
  /** labels of credentials the steps refer to as {{LABEL}}; values are never stored */
  credentials: z.array(z.string()).default([]),
  steps: z.array(stepSchema).min(1),
});
export type DemoScript = z.infer<typeof scriptSchema>;

const clean = (s?: string) => s?.replace(/\s+/g, " ").trim() || undefined;

export function targetOf(el: SnapEl, url: string): ScriptTarget {
  let page: string | undefined;
  try {
    page = new URL(url).pathname;
  } catch {
    /* keep it unset */
  }
  return {
    role: clean(el.role),
    name: clean(el.name)?.slice(0, 120),
    tag: el.tag,
    type: el.type,
    placeholder: clean(el.placeholder),
    near: { x: Math.round(el.rect.x + el.rect.w / 2), y: Math.round(el.rect.y + el.rect.h / 2) },
    page,
  };
}

/** One executed agent action as a script step; null for actions not worth replaying. */
export function stepFromAction(a: AgentAction, el: SnapEl | undefined, url: string): ScriptStep | null {
  const base = { narration: a.narration ?? "", ...(a.focus ? { focus: a.focus } : {}) };
  const t = el ? targetOf(el, url) : undefined;
  switch (a.kind) {
    case "click":
      return t ? { do: "click", target: t, ...base } : null;
    case "fill":
      // the agent writes credentials as {{LABEL}}, so the script stays secret-free
      return t ? { do: "fill", target: t, text: a.text ?? "", ...base } : null;
    case "press":
      return { do: "press", key: a.key ?? "Enter", ...(t ? { target: t } : {}), ...base };
    case "scroll":
      return { do: "scroll", deltaY: a.deltaY ?? 600, ...(t ? { target: t } : {}), ...base };
    case "wait":
      return { do: "wait", ms: Math.max(1, Math.round(a.ms ?? 1000)), ...base };
    case "goto":
      return a.text ? { do: "goto", url: a.text, ...base } : null;
    default:
      return null;
  }
}

/** Strip `undefined` so the YAML stays tidy. */
const prune = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export async function saveScript(script: DemoScript, file: string): Promise<void> {
  const header =
    "# demoin script. Replay with: demoin replay " +
    file.split("/").pop() +
    "\n# Steps refer to elements by role and name; edit freely.\n";
  await fs.writeFile(file, header + YAML.stringify(prune(script), { lineWidth: 0 }));
}

export async function loadScript(file: string): Promise<DemoScript> {
  const raw = YAML.parse(await fs.readFile(file, "utf8"));
  const r = scriptSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`Invalid script ${file}: ${issue.path.join(".")} ${issue.message}`);
  }
  return r.data;
}
