#!/usr/bin/env node
import { parseArgs } from "node:util";
import { recordDemo, replayDemo, type DemoResult, type RenderOptions } from "./demo.js";
import type { CredentialInput, LogEntry } from "./types.js";

const HELP = `demoin: turn a URL and a goal into a polished product demo video.

Usage
  demoin <url> "<goal>" [options]        let the AI agent record a demo
  demoin replay <script.yaml> [options]  replay a saved script, no AI needed

Examples
  demoin linear.app "show how to create an issue and assign it"
  demoin localhost:3000 "sign in and export a report" --cred EMAIL=me@x.com --cred PASSWORD=secret \\
         --display-host app.example.com --voice openai:alloy --subtitles burn
  demoin replay demoin-out/linear.app-2026-10-24.demoin.yaml --voice say:Samantha

Agent options
  -m, --model <provider:model>   anthropic:claude-opus-5-5, gemini:gemini-2.5-flash, openai:gpt-5-mini,
                                 openrouter:<model>, ollama:<vision model>  (default: from env keys)
      --mode howto|tour          complete a task, or tour what is on screen (default howto)
      --steps <n>                step budget (default 26)
      --language <name>          narration language (default English)
      --no-script                don't save the replayable .demoin.yaml

Render options (both commands)
  -o, --out <file.mp4>           output path (default ./demoin-out/<host>-<time>.mp4)
  -d, --device desktop|mobile    16:9 with browser frame, or 9:16 for Reels/TikTok/Shorts
      --style auto|zoom|spotlight|lightbox|none   camera effect (default auto)
      --voice <provider[:voice]> voiceover: openai:alloy, elevenlabs:<voice id>, gemini:Kore, say[:Samantha]
      --subtitles none|sidecar|burn   .srt/.vtt files, or also drawn into the video
      --captions / --no-captions step captions next to elements (default: on in tour mode)
      --sound                    click sounds
      --cred LABEL=value         credential, repeatable; the agent only ever sees {{LABEL}}
      --session <cookies>        raw Cookie header or cookie JSON for sign-in walls
      --display-host <host>      host shown in the fake browser bar (hide localhost)
      --poster                   also write a poster .jpg
      --headful                  show the browser while recording
      --keep-frames              keep raw frames (debugging)
      --json                     print the result as JSON
  replay only
      --url <url>                start somewhere else (e.g. staging); same-origin gotos follow
      --strict                   fail on the first step whose element can't be found

Environment
  ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY   model keys
  DEMOIN_MODEL            default --model
  ELEVENLABS_API_KEY      for --voice elevenlabs
  FFMPEG_PATH             ffmpeg binary (default: ffmpeg on PATH)
  DEMOIN_EXECUTABLE_PATH  Chrome/Chromium binary (default: installed Google Chrome)
`;

function fail(msg: string): never {
  process.stderr.write(`demoin: ${msg}\n`);
  process.exit(1);
}

function parseCreds(list: string[] = []): CredentialInput[] {
  return list.map((c) => {
    const eq = c.indexOf("=");
    if (eq <= 0) fail(`--cred must look like LABEL=value, got "${c}"`);
    return { label: c.slice(0, eq).toUpperCase(), value: c.slice(eq + 1) };
  });
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) fail(`--${flag} must be one of ${allowed.join(", ")}`);
  return v as T;
}

const ICON: Record<LogEntry["level"], string> = { info: "·", step: "›", warn: "!", error: "✗" };

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
      model: { type: "string", short: "m" },
      mode: { type: "string" },
      steps: { type: "string" },
      language: { type: "string" },
      "no-script": { type: "boolean" },
      out: { type: "string", short: "o" },
      device: { type: "string", short: "d" },
      style: { type: "string" },
      voice: { type: "string" },
      subtitles: { type: "string" },
      captions: { type: "boolean" },
      "no-captions": { type: "boolean" },
      sound: { type: "boolean" },
      cred: { type: "string", multiple: true },
      session: { type: "string" },
      "display-host": { type: "string" },
      poster: { type: "boolean" },
      headful: { type: "boolean" },
      "keep-frames": { type: "boolean" },
      json: { type: "boolean" },
      url: { type: "string" },
      strict: { type: "boolean" },
    },
  });

  if (v.version) {
    const { createRequire } = await import("node:module");
    console.log(createRequire(import.meta.url)("../package.json").version);
    return;
  }
  if (v.help || !positionals.length) {
    process.stdout.write(HELP);
    return;
  }

  const quiet = Boolean(v.json);
  const render: RenderOptions = {
    out: v.out,
    device: oneOf(v.device, ["desktop", "mobile"] as const, "device"),
    voice: v.voice,
    subtitles: oneOf(v.subtitles, ["none", "sidecar", "burn"] as const, "subtitles"),
    captions: v["no-captions"] ? false : v.captions ? true : undefined,
    sound: v.sound,
    credentials: parseCreds(v.cred),
    session: v.session,
    displayHost: v["display-host"],
    poster: v.poster,
    keepFrames: v["keep-frames"],
    browser: v.headful ? { headful: true } : undefined,
    onLog: (e) => {
      if (quiet && e.level !== "error") return;
      const line = `${ICON[e.level]} ${e.message}\n`;
      (e.level === "warn" || e.level === "error" ? process.stderr : process.stdout).write(line);
    },
  };
  const style = oneOf(v.style, ["auto", "zoom", "spotlight", "lightbox", "none"] as const, "style");

  let result: DemoResult;
  if (positionals[0] === "replay") {
    const file = positionals[1];
    if (!file) fail("replay needs a script file: demoin replay <script.yaml>");
    result = await replayDemo({ ...render, script: file, url: v.url, strict: v.strict });
  } else {
    const [url, goal] = positionals;
    if (!goal) fail('missing the goal: demoin <url> "<what the video should show>"');
    const steps = v.steps === undefined ? undefined : Number(v.steps);
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) fail("--steps must be a positive integer");
    result = await recordDemo({
      ...render,
      url,
      goal,
      model: v.model,
      mode: oneOf(v.mode, ["howto", "tour"] as const, "mode"),
      style,
      maxSteps: steps,
      language: v.language,
      saveScript: !v["no-script"],
    });
  }

  if (quiet) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  const cut = result.steps.filter((s) => s.cut).length;
  console.log(`\n✓ ${result.video}`);
  console.log(`  ${(result.durationMs / 1000).toFixed(1)}s, ${result.steps.length - cut} steps${cut ? ` (${cut} empty cut)` : ""}`);
  if (result.summary) console.log(`  ${result.summary}`);
  if (result.script) console.log(`  script: ${result.script}`);
  if (result.subtitles) console.log(`  subtitles: ${result.subtitles.srt}`);
  if (result.poster) console.log(`  poster: ${result.poster}`);
  if (result.blocked) console.log(`  ! stopped early (${result.blocked.kind}): ${result.blocked.reason}`);
  if (result.usage?.calls) {
    console.log(`  ${result.model}: ${result.usage.calls} calls, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`);
  }
}

main().catch((e: Error) => fail(e.message));
