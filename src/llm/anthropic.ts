import Anthropic from "@anthropic-ai/sdk";
import { LLMError, type JsonRequest, type LLM, type Message, type Schema } from "./types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Models that accept the server-side refusal fallback. On these, a request a
 * safety classifier declines is re-run on a fallback model inside the same
 * call instead of coming back empty.
 */
const FALLBACK_MODELS = /^claude-(opus-5|opus-5-5|sonnet-5-5|fable-5-1)$/;

/**
 * Claude structured outputs want closed objects. Optional fields stay optional
 * (only `required` ones are forced), and `nullable` becomes a type union.
 */
function toJsonSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: s.nullable ? [s.type, "null"] : s.type,
  };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.nullable ? [...s.enum, null] : s.enum;
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]),
    );
    out.required = s.required ?? [];
    out.additionalProperties = false;
  }
  return out;
}

function toMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p): Anthropic.ContentBlockParam =>
      "text" in p
        ? { type: "text", text: p.text }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: p.image.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: p.image.data,
            },
          },
    ),
  }));
}

/**
 * Thinking cannot be switched off on current Claude models, so effort is the
 * only dial. Agent steps run at "low": they are many and each is a narrow
 * choice. Planning the whole video is the one call worth thinking hard about.
 */
const EFFORT: Record<NonNullable<JsonRequest["effort"]>, "low" | "medium" | "high"> = {
  none: "low",
  low: "low",
  high: "high",
};

export function anthropicLLM(opts: { model?: string; apiKey?: string; baseURL?: string } = {}): LLM {
  const model = opts.model || process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  const fallback = FALLBACK_MODELS.test(model);

  return {
    id: `anthropic:${model}`,
    async json<T>(req: JsonRequest): Promise<T> {
      const body = {
        model,
        max_tokens: 16000,
        system: req.system,
        messages: toMessages(req.messages),
        output_config: {
          effort: EFFORT[req.effort ?? "low"],
          ...(req.schema ? { format: { type: "json_schema" as const, schema: toJsonSchema(req.schema) } } : {}),
        },
      };

      let res: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        res = fallback
          ? await client.beta.messages.create(
              { ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
              { signal: req.signal },
            )
          : await client.messages.create(body, { signal: req.signal });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) {
          throw new LLMError("Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.");
        }
        if (e instanceof Anthropic.RateLimitError) {
          throw new LLMError("Anthropic rate limit reached. Try again shortly.", true);
        }
        if (e instanceof Anthropic.BadRequestError) {
          throw new LLMError(`Anthropic rejected the request (400): ${e.message.slice(0, 300)}`);
        }
        if (e instanceof Anthropic.APIError) {
          throw new LLMError(`Anthropic error ${e.status ?? "?"}: ${e.message.slice(0, 300)}`, true);
        }
        throw e;
      }

      req.onUsage?.({
        inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
      });

      if (res.stop_reason === "refusal") {
        throw new LLMError("The model declined this request.");
      }
      const text = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      if (!text) throw new LLMError(`The model returned no text (stop_reason=${res.stop_reason}).`, true);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new LLMError(`The model reply is not valid JSON: ${text.slice(0, 200)}`, true);
      }
    },
  };
}
