import { LLMError, type Effort, type JsonRequest, type LLM, type Schema } from "./types.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/** Gemini spells JSON Schema types in upper case. */
function toGeminiSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.nullable) out.nullable = true;
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
  }
  return out;
}

/**
 * Thinking budget per effort level.
 *
 * It used to be zero for every call, to be fast and cheap. The agent then
 * answered on reflex: it picked the button closest to a word in the goal, not
 * the one that made sense for the story. A little thinking per step and a lot
 * for the plan is far cheaper than a video that has to be made again.
 */
const BUDGET: Record<Effort, number> = { none: 0, low: 512, high: 2048 };

function friendlyError(status: number, body: string): string {
  if (status === 429) return "Gemini is rate limited. Try again shortly.";
  if (status === 503) return "Gemini is overloaded. Try again shortly.";
  if (status === 400) return `Gemini rejected the request (400). ${body.slice(0, 300)}`;
  if (status === 403) return "Gemini rejected the API key (403). Check GEMINI_API_KEY.";
  return `Gemini error ${status}. ${body.slice(0, 300)}`;
}

export function geminiLLM(opts: { model?: string; apiKey?: string } = {}): LLM {
  const model = opts.model || process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  return {
    id: `gemini:${model}`,
    async json<T>(req: JsonRequest): Promise<T> {
      const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new LLMError("GEMINI_API_KEY is not set.");
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: m.parts.map((p) =>
            "text" in p ? { text: p.text } : { inlineData: { mimeType: p.image.mimeType, data: p.image.data } },
          ),
        })),
        generationConfig: {
          temperature: req.temperature ?? 0.15,
          responseMimeType: "application/json",
          ...(req.schema ? { responseSchema: toGeminiSchema(req.schema) } : {}),
          ...(/^gemini-2\.5/.test(model) || /^gemini-[3-9]/.test(model)
            ? { thinkingConfig: { thinkingBudget: BUDGET[req.effort ?? "low"] } }
            : {}),
        },
      };

      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(body),
            signal: req.signal,
          });
        } catch (e) {
          if (req.signal?.aborted) throw e;
          lastErr = new LLMError(`Could not reach Gemini: ${(e as Error).message}`, true);
          await sleep(800 * (attempt + 1));
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          lastErr = new LLMError(friendlyError(res.status, text), res.status === 429 || res.status >= 500);
          // 429/5xx are worth retrying, the rest are not.
          if (res.status === 429 || res.status >= 500) {
            await sleep(1200 * (attempt + 1));
            continue;
          }
          throw lastErr;
        }

        const json = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
          promptFeedback?: { blockReason?: string };
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
            thoughtsTokenCount?: number;
          };
        };

        if (json.usageMetadata) {
          const u = json.usageMetadata;
          req.onUsage?.({
            inputTokens: u.promptTokenCount ?? 0,
            // thinking tokens are billed as output
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
          });
        }

        if (json.promptFeedback?.blockReason) {
          throw new LLMError(`Gemini declined this request: ${json.promptFeedback.blockReason}`);
        }

        const text = json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("")
          .trim();
        if (!text) {
          lastErr = new LLMError(
            `Gemini returned no text (finishReason=${json.candidates?.[0]?.finishReason ?? "?"})`,
            true,
          );
          await sleep(700 * (attempt + 1));
          continue;
        }

        try {
          return JSON.parse(stripFence(text)) as T;
        } catch {
          lastErr = new LLMError(`Gemini reply is not valid JSON: ${text.slice(0, 200)}`, true);
          await sleep(500);
          continue;
        }
      }
      throw lastErr ?? new LLMError("Gemini failed without a reason");
    },
  };
}

export function stripFence(s: string) {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
