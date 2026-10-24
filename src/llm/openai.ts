import { stripFence } from "./gemini.js";
import { LLMError, type Effort, type JsonRequest, type LLM, type Schema } from "./types.js";

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenAI itself, OpenRouter,
 * Ollama, LM Studio, vLLM, Groq, Together… They differ only in base URL,
 * key, and how strictly they honour `response_format`.
 */
export interface OpenAICompatOptions {
  provider: string;
  model: string;
  baseURL: string;
  apiKey?: string;
  /** send `reasoning_effort` (reasoning models only; others reject it) */
  reasoning?: boolean;
}

function toJsonSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.nullable ? [s.type, "null"] : s.type };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]),
    );
    if (s.required) out.required = s.required;
  }
  return out;
}

const REASONING: Record<Effort, string> = { none: "minimal", low: "low", high: "medium" };

export function openaiCompatLLM(o: OpenAICompatOptions): LLM {
  const base = o.baseURL.replace(/\/+$/, "");
  return {
    id: `${o.provider}:${o.model}`,
    async json<T>(req: JsonRequest): Promise<T> {
      const body: Record<string, unknown> = {
        model: o.model,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.map((m) => ({
            role: m.role,
            content: m.parts.map((p) =>
              "text" in p
                ? { type: "text", text: p.text }
                : { type: "image_url", image_url: { url: `data:${p.image.mimeType};base64,${p.image.data}` } },
            ),
          })),
        ],
        response_format: req.schema
          ? { type: "json_schema", json_schema: { name: "output", schema: toJsonSchema(req.schema), strict: false } }
          : { type: "json_object" },
        ...(o.reasoning
          ? { reasoning_effort: REASONING[req.effort ?? "low"] }
          : { temperature: req.temperature ?? 0.15 }),
      };

      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: req.signal,
          });
        } catch (e) {
          if (req.signal?.aborted) throw e;
          lastErr = new LLMError(`Could not reach ${o.provider} at ${base}: ${(e as Error).message}`, true);
          await sleep(800 * (attempt + 1));
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const retry = res.status === 429 || res.status >= 500;
          lastErr = new LLMError(`${o.provider} error ${res.status}: ${text.slice(0, 300)}`, retry);
          if (retry) {
            await sleep(1200 * (attempt + 1));
            continue;
          }
          throw lastErr;
        }

        const json = (await res.json()) as {
          choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        if (json.usage) {
          req.onUsage?.({
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
          });
        }
        const msg = json.choices?.[0]?.message;
        if (msg?.refusal) throw new LLMError(`${o.provider} declined this request: ${msg.refusal}`);
        const text = msg?.content?.trim();
        if (!text) {
          lastErr = new LLMError(
            `${o.provider} returned no text (finish_reason=${json.choices?.[0]?.finish_reason ?? "?"})`,
            true,
          );
          await sleep(700 * (attempt + 1));
          continue;
        }
        try {
          return JSON.parse(stripFence(text)) as T;
        } catch {
          lastErr = new LLMError(`${o.provider} reply is not valid JSON: ${text.slice(0, 200)}`, true);
          await sleep(500);
          continue;
        }
      }
      throw lastErr ?? new LLMError(`${o.provider} failed without a reason`);
    },
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
