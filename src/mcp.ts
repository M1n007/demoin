#!/usr/bin/env node
/**
 * MCP server: lets a coding agent (Claude Code, Cursor, …) make a demo video
 * of the feature it just built, or refresh one from a saved script.
 *
 *   claude mcp add demoin -- npx -y demoin-mcp
 *
 * stdout carries the protocol, so every log line goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recordDemo, replayDemo, type DemoResult } from "./demo.js";
import type { LogEntry } from "./types.js";

const server = new McpServer({ name: "demoin", version: "0.1.0" });

const logToStderr = (e: LogEntry) => process.stderr.write(`[demoin] ${e.level} ${e.message}\n`);

const render = {
  out: z.string().optional().describe("Output .mp4 path. Default ./demoin-out/<host>-<time>.mp4"),
  device: z.enum(["desktop", "mobile"]).optional().describe("desktop = 16:9 with browser frame, mobile = 9:16"),
  voice: z
    .string()
    .optional()
    .describe('Voiceover "provider[:voice]": openai:alloy, elevenlabs:<voice id>, gemini:Kore, say:Samantha (macOS)'),
  subtitles: z.enum(["none", "sidecar", "burn"]).optional(),
  credentials: z
    .record(z.string(), z.string())
    .optional()
    .describe("Credentials by label, e.g. {EMAIL: ..., PASSWORD: ...}. The model only ever sees {{LABEL}}."),
  display_host: z.string().optional().describe("Host to show in the fake browser bar, e.g. to hide localhost"),
};

function report(r: DemoResult) {
  const lines = [
    `video: ${r.video}`,
    `duration: ${(r.durationMs / 1000).toFixed(1)}s`,
    r.script ? `script: ${r.script} (replay with replay_demo, no AI cost)` : "",
    r.subtitles ? `subtitles: ${r.subtitles.srt}` : "",
    r.summary ? `summary: ${r.summary}` : "",
    r.blocked ? `stopped early (${r.blocked.kind}): ${r.blocked.reason}` : `goal reached: ${r.achieved}`,
    "steps:",
    ...r.steps.map((s) => `  ${s.index + 1}. ${s.kind}${s.ok ? "" : " (failed)"}${s.cut ? " (cut)" : ""}: ${s.narration}`),
  ];
  return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
}

const failure = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: `demoin failed: ${(e as Error).message}` }],
});

server.registerTool(
  "record_demo",
  {
    title: "Record a demo video",
    description:
      "Open a URL in a real Chrome, let an AI agent work toward a goal (sign in, use a feature, tour a page), " +
      "and render a polished mp4 with camera moves, cursor, optional voiceover and subtitles. Also saves a " +
      "replayable script. Takes one to several minutes. Works on localhost.",
    inputSchema: {
      url: z.string().describe("Start URL, e.g. http://localhost:3000 or example.com"),
      goal: z.string().describe('What the video should show, e.g. "create a project and invite a teammate"'),
      mode: z.enum(["howto", "tour"]).optional(),
      max_steps: z.number().int().min(1).max(60).optional(),
      language: z.string().optional().describe("Narration language, default English"),
      model: z.string().optional().describe('"provider:model"; default picked from env keys'),
      ...render,
    },
  },
  async (a) => {
    try {
      return report(
        await recordDemo({
          url: a.url,
          goal: a.goal,
          mode: a.mode,
          maxSteps: a.max_steps,
          language: a.language,
          model: a.model,
          out: a.out,
          device: a.device,
          voice: a.voice,
          subtitles: a.subtitles,
          credentials: a.credentials,
          displayHost: a.display_host,
          onLog: logToStderr,
        }),
      );
    } catch (e) {
      return failure(e);
    }
  },
);

server.registerTool(
  "replay_demo",
  {
    title: "Replay a demo script",
    description:
      "Re-render a demo from a saved .demoin.yaml script without any AI calls: same steps, fresh footage of " +
      "the current app. Use it to update a demo video after UI changes.",
    inputSchema: {
      script: z.string().describe("Path to the .demoin.yaml file"),
      url: z.string().optional().describe("Start somewhere else, e.g. a staging URL"),
      strict: z.boolean().optional().describe("Fail on the first step whose element cannot be found"),
      ...render,
    },
  },
  async (a) => {
    try {
      return report(
        await replayDemo({
          script: a.script,
          url: a.url,
          strict: a.strict,
          out: a.out,
          device: a.device,
          voice: a.voice,
          subtitles: a.subtitles,
          credentials: a.credentials,
          displayHost: a.display_host,
          onLog: logToStderr,
        }),
      );
    } catch (e) {
      return failure(e);
    }
  },
);

await server.connect(new StdioServerTransport());
