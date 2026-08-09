import Anthropic from "@anthropic-ai/sdk";

import type { ModelClient, ModelRequest, ModelTurn } from "./model.js";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 16_384;

export interface AnthropicModelOptions {
  apiKey: string;
  maxTokens?: number;
  model?: string;
}

export class AnthropicModel implements ModelClient {
  readonly #client: Anthropic;
  readonly #maxTokens: number;
  readonly #model: string;

  constructor(options: AnthropicModelOptions) {
    this.#client = new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#model = options.model ?? DEFAULT_MODEL;
  }

  async createMessage(request: ModelRequest): Promise<ModelTurn> {
    const stream = this.#client.messages.stream(
      {
        max_tokens: this.#maxTokens,
        messages: request.messages,
        model: this.#model,
        system: request.system,
        tools: request.tools,
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    );

    if (request.onText !== undefined) {
      stream.on("text", request.onText);
    }

    const message = await stream.finalMessage();
    return {
      content: message.content,
      stopReason: message.stop_reason,
      usage: {
        input: message.usage.input_tokens,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        output: message.usage.output_tokens,
      },
    };
  }
}

export function formatProviderError(error: unknown): string {
  if (error instanceof Anthropic.APIUserAbortError) {
    return "Request cancelled.";
  }

  if (error instanceof Anthropic.APIError) {
    const details = [
      error.status === undefined ? undefined : `HTTP ${error.status}`,
      typeof error.type === "string" ? error.type : undefined,
      error.requestID === undefined ? undefined : `request ${error.requestID}`,
    ].filter((value): value is string => value !== undefined);
    return details.length === 0
      ? error.message
      : `${error.message} (${details.join(", ")})`;
  }

  return error instanceof Error ? error.message : String(error);
}
