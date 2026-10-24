/**
 * Provider-neutral interface for the few model calls the engine makes. Every
 * call asks for JSON that matches a schema, so each adapter only has to know
 * how its provider spells "structured output" and "images".
 */

/** The subset of JSON Schema the engine uses. Adapters translate it per provider. */
export interface Schema {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array";
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: string[];
  description?: string;
  required?: string[];
  nullable?: boolean;
}

export type Part =
  | { text: string }
  /** base64 image, sent as-is to models that can see */
  | { image: { mimeType: string; data: string } };

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
}

/**
 * How hard the model should think. "none" for cheap bookkeeping calls, "low"
 * for every agent step, "high" for planning the whole video.
 */
export type Effort = "none" | "low" | "high";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface JsonRequest {
  system: string;
  messages: Message[];
  schema?: Schema;
  effort?: Effort;
  /** 0..1, ignored by providers that no longer accept sampling parameters */
  temperature?: number;
  signal?: AbortSignal;
  /** called for every successful request, to keep track of cost */
  onUsage?: (u: Usage) => void;
}

export interface LLM {
  /** "provider:model", for logs */
  readonly id: string;
  json<T>(req: JsonRequest): Promise<T>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    /** worth retrying: rate limits, overload, flaky network */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
