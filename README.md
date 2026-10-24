# demoin

**Give it a URL and a goal. Get a polished product demo video.**

```bash
npx demoin linear.app "create an issue and assign it to a teammate" --voice openai:alloy
```

An AI agent opens your site in a real Chrome, plans the video like a storyboard, clicks and types its
way to the goal, and renders an mp4 that looks edited by hand: smooth camera moves that follow the
action, an animated cursor with click ripples, spotlight and lightbox highlights, a browser frame on a
gradient backdrop, plus optional voiceover and subtitles.

Every run also writes a **replayable script**, so the next video of the same flow needs no AI at all,
which makes it cheap enough to regenerate your demos in CI on every release.

- **Any site, any language.** Works on production, staging and `localhost`. Narration in whatever language you ask for.
- **Any model.** Claude, Gemini, OpenAI, OpenRouter, or a local vision model through Ollama.
- **Voiceover that stays in sync.** The sentence is spoken *while recording* and the browser holds still for exactly
  that long, so voice and clicks line up without any audio stretching.
- **Subtitles** as `.srt`/`.vtt` sidecars or burned in.
- **16:9 or 9:16.** Desktop with browser chrome, or a phone frame for Reels, TikTok and Shorts.
- **MCP server.** Let Claude Code or Cursor record a demo of the feature it just built.
- **Credentials never reach the model.** The agent only sees `{{EMAIL}}` / `{{PASSWORD}}` placeholders.

## Install

Requirements: Node 20+, [ffmpeg](https://ffmpeg.org/download.html) on your `PATH`, and Google Chrome
(or any Chromium via `DEMOIN_EXECUTABLE_PATH`).

```bash
npm i -g demoin        # or run it with npx demoin
export ANTHROPIC_API_KEY=...   # or GEMINI_API_KEY / OPENAI_API_KEY
```

## Record with the agent

```bash
demoin <url> "<what the video should show>" [options]
```

```bash
# a tour of a landing page, vertical, with an offline macOS voice
demoin example.com "tour the homepage and the pricing section" --mode tour -d mobile --voice say:Samantha

# a signed-in flow on your dev server, shown as if it were production
demoin localhost:3000 "sign in, create a project, invite a teammate" \
  --cred EMAIL=demo@acme.com --cred PASSWORD=hunter2 \
  --display-host app.acme.com --voice elevenlabs:<voice-id> --subtitles burn

# narrate in Indonesian with Gemini
demoin tokopedia.com "cari sepatu lari dan buka detail produknya" --language Indonesian -m gemini:gemini-2.5-flash
```

Output lands in `./demoin-out/` (or `-o file.mp4`): the video, `.srt`/`.vtt` subtitles when there is
narration, and a `.demoin.yaml` script.

### Writing good goals

Describe what a viewer should **see**, in order: *"open Settings, switch to dark mode, then show the
billing page"*. The agent turns it into a short plan before recording, revises the plan once it is signed
in and can see the real menus, and stops when the plan is done. If it gets stuck (captcha, SSO-only
sign-in, a missing credential) it says so in the result instead of producing a misleading video.

## Replay a script, no AI

```bash
demoin replay demoin-out/acme.com-2026-10-24.demoin.yaml --voice openai:alloy
demoin replay flow.demoin.yaml --url https://staging.acme.com --strict   # CI: fail if the UI drifted
```

Scripts are plain YAML. Elements are matched by accessible name and placeholder first, then role
(the ARIA role, or the tag name when there is none), tag and type, with position only as a tie-breaker,
so they survive redesigns and are easy to edit by hand:

```yaml
demoin: 1
url: https://acme.com
device: desktop
credentials: [EMAIL, PASSWORD]
steps:
  - do: click
    target: { role: a, name: Sign in }
    narration: Start by signing in to your workspace.
  - do: fill
    target: { tag: input, type: email, placeholder: you@company.com }
    text: "{{EMAIL}}"
    narration: Enter your work email.
  - do: press
    key: Enter
    narration: ""
  - do: scroll
    deltaY: 600
    narration: Your projects are listed here.
```

Step kinds: `click`, `fill`, `press`, `scroll`, `wait`, `goto`. Optional `focus` per step:
`zoom | spotlight | lightbox | none`.

### Keep demos fresh in CI

See [`examples/github-action.yml`](examples/github-action.yml): it replays your scripts against
staging on every release and uploads the videos as artifacts, with no model key needed.

## Options

| Option | Meaning |
| --- | --- |
| `-m, --model provider:model` | `anthropic:claude-opus-5-5`, `gemini:gemini-2.5-flash`, `openai:gpt-5-mini`, `openrouter:<model>`, `ollama:<vision model>`, `openai-compatible:<model>` |
| `--mode howto\|tour` | complete a task, or introduce what is on screen (tour turns captions on) |
| `--steps n` | step budget (default 26) |
| `--language name` | narration language (default English) |
| `-d, --device desktop\|mobile` | 1920×1080 with browser frame, or 1080×1920 phone frame |
| `--style auto\|zoom\|spotlight\|lightbox\|none` | camera effect; `auto` lets the agent pick per step |
| `--voice provider[:voice]` | `openai:alloy`, `elevenlabs:<voice id>`, `gemini:Kore`, `say[:Voice]` (macOS, free) |
| `--subtitles none\|sidecar\|burn` | sidecar files, or also drawn into the video |
| `--captions` / `--no-captions` | step captions next to the element |
| `--sound` | click sounds |
| `--cred LABEL=value` | credential (repeatable); the model only sees `{{LABEL}}` |
| `--session cookies` | raw `Cookie` header or cookie JSON, for sign-ins the agent can't do (SSO, 2FA) |
| `--display-host host` | host shown in the fake browser bar |
| `--poster` | also write a poster `.jpg` |
| `--headful` | watch the browser while it records |
| `--json` | print the result as JSON |

## Models

The agent sends a labelled screenshot with every step, so the model must accept images.

| Provider | Env | Notes |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | default `claude-opus-5-5`; `claude-haiku-5-5` is a cheaper option for simple flows |
| `gemini` | `GEMINI_API_KEY` | default `gemini-2.5-flash`, fast and cheap |
| `openai` | `OPENAI_API_KEY` | default `gpt-5-mini`; `OPENAI_BASE_URL` for proxies |
| `openrouter` | `OPENROUTER_API_KEY` | any vision model on OpenRouter |
| `ollama` | `OLLAMA_BASE_URL` | local, e.g. `ollama:qwen2.5vl:7b` |
| `openai-compatible` | `DEMOIN_LLM_BASE_URL`, `DEMOIN_LLM_API_KEY` | vLLM, LM Studio, Groq… |

Without `--model`, the first key found in the environment wins (`DEMOIN_MODEL` overrides that).
A typical 15-step run with Gemini Flash uses roughly 40k input tokens.

## Use it as a library

```ts
import { recordDemo, replayDemo } from "demoin";

const result = await recordDemo({
  url: "https://acme.com",
  goal: "show how to export a report",
  model: "anthropic:claude-opus-5-5",
  voice: "openai:alloy",
  subtitles: "burn",
  credentials: { EMAIL: "demo@acme.com", PASSWORD: process.env.DEMO_PASSWORD! },
  onLog: (e) => console.log(e.message),
});
console.log(result.video, result.script, result.summary);

await replayDemo({ script: result.script!, device: "mobile" });
```

You can also pass your own model object (`{ id, json(req) }`, see `src/llm/types.ts`) or TTS
(`{ id, synth(text, outBase) }`).

## MCP server

```bash
claude mcp add demoin -- npx -y demoin-mcp
```

Tools: `record_demo` (url, goal, mode, voice, device, credentials, …) and `replay_demo` (script, url, …).
Ask your coding agent things like *"record a 9:16 demo of the onboarding flow on localhost:3000 with a
voiceover"*.

## How it works

1. **Snapshot.** Each step, the page's interactive elements are collected (role, name, placeholder,
   required/disabled state, visible error messages, open dialogs) and drawn as numbered labels on a screenshot.
2. **Plan, then act.** The model writes a short storyboard first, then picks one action at a time with a
   narration sentence and a highlight effect. Guards catch the classic failure modes of web agents:
   clicks that change nothing, A-B-A-B loops, onboarding carousels, repeating the same server error,
   filling forms without submitting, signing up when it should sign in.
3. **Record.** Chrome's screencast is captured at 2× while a real mouse moves along the same eased path
   the video cursor will follow.
4. **Edit.** Dead time (page loads, model thinking) is compressed, steps that changed nothing are cut by
   comparing pixels, and the camera plan zooms to what each action *changed*, not just to the button.
5. **Render.** Frames are composited (backdrop, card, cursor, ripples, overlays) and piped to ffmpeg; the
   voiceover and subtitles are laid in on a second pass.

## Environment

| Variable | Purpose |
| --- | --- |
| `FFMPEG_PATH`, `FFPROBE_PATH` | ffmpeg binaries (default: from `PATH`) |
| `DEMOIN_EXECUTABLE_PATH` | Chrome/Chromium binary; otherwise the installed Google Chrome |
| `DEMOIN_BROWSER_CHANNEL` | Playwright channel (default `chrome`) |
| `DEMOIN_CHROME_NO_SANDBOX=1` | needed inside most containers |
| `DEMOIN_HEADFUL=1` | same as `--headful` |
| `OPENAI_TTS_MODEL`, `ELEVENLABS_MODEL`, `GEMINI_TTS_MODEL` | override TTS models |

## Development

```bash
pnpm install
pnpm test                        # browser regression cases against test/sites (no API key needed)
pnpm exec tsx test/render-smoke.ts
pnpm dev <url> "<goal>"          # run the CLI from source
```

## License

MIT
