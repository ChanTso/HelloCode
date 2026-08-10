import Anthropic from "@anthropic-ai/sdk";

import {
  createModelBackend,
  modelScope,
  type AssistantMessage,
  type JsonValue,
  type ModelClient,
  type ModelRequest,
  type ModelStopReason,
  type ModelTurn,
  type ToolDefinition,
  type TranscriptMessage,
} from "./model.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

interface AnthropicStreamLike {
  finalMessage(): Promise<Anthropic.Message>;
  on(event: "text", listener: (delta: string) => void): void;
}

interface AnthropicClientLike {
  messages: {
    stream(
      body: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): AnthropicStreamLike;
  };
}

export interface AnthropicModelOptions {
  apiKey: string;
  baseUrl?: string;
  client?: AnthropicClientLike;
  maxTokens?: number;
  model?: string;
}

export class AnthropicModel implements ModelClient {
  readonly #client: AnthropicClientLike;
  readonly #maxTokens: number;
  readonly #model: string;
  readonly #scope: string;

  constructor(options: AnthropicModelOptions) {
    this.#model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    if (options.client !== undefined) {
      this.#client = options.client;
    } else {
      const client = new Anthropic({
        apiKey: options.apiKey,
        baseURL: options.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
        maxRetries: 2,
      });
      this.#client = {
        messages: {
          stream: (body, requestOptions) =>
            client.messages.stream(body, requestOptions),
        },
      };
    }
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#scope = modelScope(
      createModelBackend("anthropic", this.#model, options.baseUrl),
    );
  }

  async createMessage(request: ModelRequest): Promise<ModelTurn> {
    const stream = this.#client.messages.stream(
      {
        max_tokens: this.#maxTokens,
        messages: toAnthropicMessages(request.messages, this.#scope),
        model: this.#model,
        system: request.system,
        tools: request.tools.map(toAnthropicTool),
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    );

    if (request.onText !== undefined) {
      stream.on("text", request.onText);
    }

    const message = await stream.finalMessage();
    return {
      message: fromAnthropicMessage(message.content, this.#scope),
      stopReason: normalizeStopReason(message.stop_reason),
      usage: {
        input: message.usage.input_tokens,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        output: message.usage.output_tokens,
      },
    };
  }
}

function fromAnthropicMessage(
  content: Anthropic.ContentBlock[],
  scope: string,
): AssistantMessage {
  const normalized: AssistantMessage["content"] = [];
  for (const block of content) {
    if (block.type === "text") {
      normalized.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      normalized.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return {
    role: "assistant",
    content: normalized,
    replay: {
      format: "anthropic-content-v1",
      scope,
      items: jsonItems(content),
    },
  };
}

function toAnthropicMessages(
  messages: readonly TranscriptMessage[],
  scope: string,
): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }
    if (message.role === "tool") {
      return {
        role: "user",
        content: message.content.map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    }

    if (
      message.replay?.format === "anthropic-content-v1" &&
      message.replay.scope === scope
    ) {
      return {
        role: "assistant",
        content: message.replay
          .items as unknown as Anthropic.ContentBlockParam[],
      };
    }

    const content: Anthropic.ContentBlockParam[] = message.content.map(
      (block): Anthropic.ContentBlockParam =>
        block.type === "text"
          ? { type: "text", text: block.text }
          : {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            },
    );
    return {
      role: "assistant",
      content:
        content.length > 0
          ? content
          : [{ type: "text", text: "[Prior model reasoning omitted.]" }],
    };
  });
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    strict: tool.strict,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

function normalizeStopReason(
  reason: Anthropic.StopReason | null,
): ModelStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "complete";
    case "tool_use":
      return "tool_use";
    case "pause_turn":
      return "pause";
    case "max_tokens":
      return "max_tokens";
    case "model_context_window_exceeded":
      return "context_limit";
    case "refusal":
      return "refusal";
    case null:
      throw new Error("Anthropic returned a response without a stop reason.");
    default:
      return assertNever(reason);
  }
}

function jsonItems(value: unknown[]): JsonValue[] {
  return JSON.parse(JSON.stringify(value)) as JsonValue[];
}

function assertNever(_value: never): never {
  throw new Error("Anthropic returned an unsupported stop reason.");
}

export function formatAnthropicError(error: unknown): string | undefined {
  if (error instanceof Anthropic.APIUserAbortError) {
    return "Request cancelled.";
  }

  if (error instanceof Anthropic.APIError) {
    const details = [
      error.status === undefined ? undefined : `HTTP ${error.status}`,
      safeErrorMetadata(error.type),
      safeErrorMetadata(error.requestID) === undefined
        ? undefined
        : `request ${safeErrorMetadata(error.requestID)}`,
    ].filter((value): value is string => value !== undefined);
    return details.length === 0
      ? "Anthropic request failed."
      : `Anthropic request failed (${details.join(", ")}).`;
  }

  if (error instanceof Anthropic.AnthropicError) {
    return "Anthropic request failed.";
  }

  return undefined;
}

function safeErrorMetadata(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,80}$/u.test(value)
    ? value
    : undefined;
}
