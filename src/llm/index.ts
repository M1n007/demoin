import { anthropicLLM } from "./anthropic.js";
import { geminiLLM } from "./gemini.js";
import { openaiCompatLLM } from "./openai.js";
import { LLMError, type LLM } from "./types.js";

export * from "./types.js";
export { anthropicLLM, geminiLLM, openaiCompatLLM };

export const PROVIDERS = ["anthropic", "gemini", "openai", "openrouter", "ollama", "openai-compatible"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/** Models that take `reasoning_effort` and reject `temperature`. */
const OPENAI_REASONING = /^(o\d|gpt-5)/;

/**
 * Build a model from a "provider:model" string, e.g.
 *
 *   anthropic:claude-opus-5-5     gemini:gemini-2.5-flash     openai:gpt-5-mini
 *   openrouter:qwen/qwen3-vl-235b ollama:qwen2.5vl:7b
 *
 * The model must be able to see images: every agent step sends a labelled
 * screenshot. With no spec, the first provider with a key in the environment
 * wins (DEMOIN_MODEL overrides all of that).
 */
export function createLLM(spec?: string): LLM {
  const s = spec?.trim() || process.env.DEMOIN_MODEL?.trim() || detect();
  const i = s.indexOf(":");
  const provider = (i < 0 ? s : s.slice(0, i)) as ProviderId;
  const model = i < 0 ? "" : s.slice(i + 1);

  switch (provider) {
    case "anthropic":
      return anthropicLLM({ model: model || undefined });
    case "gemini":
    case "google" as ProviderId:
      return geminiLLM({ model: model || undefined });
    case "openai": {
      const m = model || process.env.OPENAI_MODEL || "gpt-5-mini";
      return openaiCompatLLM({
        provider,
        model: m,
        baseURL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        apiKey: need("OPENAI_API_KEY"),
        reasoning: OPENAI_REASONING.test(m),
      });
    }
    case "openrouter":
      if (!model) throw new LLMError('openrouter needs a model, e.g. "openrouter:google/gemini-2.5-flash".');
      return openaiCompatLLM({
        provider,
        model,
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: need("OPENROUTER_API_KEY"),
      });
    case "ollama":
      if (!model) throw new LLMError('ollama needs a vision model, e.g. "ollama:qwen2.5vl:7b".');
      return openaiCompatLLM({
        provider,
        model,
        baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      });
    case "openai-compatible": {
      const baseURL = process.env.DEMOIN_LLM_BASE_URL;
      if (!baseURL || !model) {
        throw new LLMError('openai-compatible needs DEMOIN_LLM_BASE_URL and a model, e.g. "openai-compatible:my-model".');
      }
      return openaiCompatLLM({
        provider,
        model,
        baseURL,
        apiKey: process.env.DEMOIN_LLM_API_KEY,
        reasoning: process.env.DEMOIN_LLM_REASONING === "1",
      });
    }
    default:
      throw new LLMError(`Unknown model provider "${provider}". Use one of: ${PROVIDERS.join(", ")}.`);
  }
}

function detect(): string {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL) return `openrouter:${process.env.OPENROUTER_MODEL}`;
  throw new LLMError(
    "No model configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY or OPENAI_API_KEY, " +
      'or pass --model (e.g. "ollama:qwen2.5vl:7b"). Replaying a saved script needs no model.',
  );
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new LLMError(`${name} is not set.`);
  return v;
}
