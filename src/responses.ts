import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseUsage,
} from "openai/resources/responses/responses";

import {
  createModelBackend,
  emptyUsage,
  modelScope,
  type AssistantMessage,
  type JsonValue,
  type ModelClient,
  type ModelRequest,
  type ModelStopReason,
  type ModelTurn,
  type TokenUsage,
  type ToolDefinition,
  type TranscriptMessage,
} from "./model.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
const DEFAULT_MAX_TOKENS = 16_384;

interface ResponseStreamLike {
  finalResponse(): Promise<Response>;
  on(
    event: "response.output_text.delta",
    listener: (event: { delta: string }) => void,
  ): void;
}

type ResponseStreamBody = ResponseCreateParamsBase & { stream?: true };

interface ResponsesClientLike {
  responses: {
    stream(
      body: ResponseStreamBody,
      options?: { signal?: AbortSignal },
    ): ResponseStreamLike;
  };
}

export interface ResponsesModelOptions {
  apiKey: string;
  baseUrl?: string;
  client?: ResponsesClientLike;
  maxTokens?: number;
  model?: string;
}

export class OpenAIResponsesModel implements ModelClient {
  readonly #client: ResponsesClientLike;
  readonly #maxTokens: number;
  readonly #model: string;
  readonly #scope: string;

  constructor(options: ResponsesModelOptions) {
    this.#model = options.model ?? DEFAULT_OPENAI_MODEL;
    if (options.client !== undefined) {
      this.#client = options.client;
    } else {
      const client = new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl ?? "https://api.openai.com/v1",
        maxRetries: 1,
      });
      this.#client = {
        responses: {
          stream: (body, requestOptions) =>
            client.responses.stream(body, requestOptions),
        },
      };
    }
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#scope = modelScope(
      createModelBackend("openai", this.#model, options.baseUrl),
    );
  }

  async createMessage(request: ModelRequest): Promise<ModelTurn> {
    const stream = this.#client.responses.stream(
      {
        include: ["reasoning.encrypted_content"],
        input: toResponseInput(request.messages, this.#scope),
        instructions: request.system,
        max_output_tokens: this.#maxTokens,
        model: this.#model,
        store: false,
        tools: request.tools.map(toResponseTool),
      },
      request.signal === undefined ? undefined : { signal: request.signal },
    );

    if (request.onText !== undefined) {
      stream.on("response.output_text.delta", (event) =>
        request.onText?.(event.delta),
      );
    }

    const response = await stream.finalResponse();
    const replayItems = sanitizeOutput(response.output);
    return {
      message: fromResponseOutput(response.output, replayItems, this.#scope),
      stopReason: normalizeStopReason(response),
      usage: normalizeUsage(response.usage),
    };
  }
}

function toResponseInput(
  messages: readonly TranscriptMessage[],
  scope: string,
): ResponseInput {
  const input: ResponseInput = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "tool") {
      for (const result of message.content) {
        input.push({
          type: "function_call_output",
          call_id: result.toolCallId,
          output: result.isError
            ? `Tool error: ${result.content}`
            : result.content,
        });
      }
      continue;
    }

    if (
      message.replay?.format === "responses-output-v1" &&
      message.replay.scope === scope
    ) {
      input.push(...replayInputItems(message.replay.items));
      continue;
    }

    appendPortableAssistantMessage(input, message);
  }
  return input;
}

function appendPortableAssistantMessage(
  input: ResponseInput,
  message: AssistantMessage,
): void {
  let text = "";
  const flushText = (): void => {
    if (text.length === 0) return;
    input.push({ role: "assistant", content: text });
    text = "";
  };

  for (const block of message.content) {
    if (block.type === "text") {
      text += block.text;
      continue;
    }

    flushText();
    input.push({
      type: "function_call",
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input) ?? "null",
    });
  }
  flushText();

  if (message.content.length === 0) {
    input.push({
      role: "assistant",
      content: "[Prior model reasoning omitted.]",
    });
  }
}

function replayInputItems(items: readonly JsonValue[]): ResponseInputItem[] {
  return items.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Stored OpenAI replay contains an invalid output item.");
    }
    if (
      item.type !== "reasoning" &&
      item.type !== "message" &&
      item.type !== "function_call"
    ) {
      throw new Error(
        "Stored OpenAI replay contains an unsupported output item.",
      );
    }
    return item as unknown as ResponseInputItem;
  });
}

function toResponseTool(tool: ToolDefinition): FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function fromResponseOutput(
  output: readonly ResponseOutputItem[],
  replayItems: JsonValue[],
  scope: string,
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content) {
        content.push({
          type: "text",
          text: part.type === "output_text" ? part.text : part.refusal,
        });
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_call",
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item),
      });
    }
  }

  return {
    role: "assistant",
    content,
    replay: {
      format: "responses-output-v1",
      items: replayItems,
      scope,
    },
  };
}

function parseToolArguments(call: ResponseFunctionToolCall): unknown {
  try {
    return JSON.parse(call.arguments) as unknown;
  } catch {
    return "Invalid JSON tool arguments.";
  }
}

function sanitizeOutput(output: readonly ResponseOutputItem[]): JsonValue[] {
  const sanitized = output.map((item): ResponseOutputItem => {
    switch (item.type) {
      case "reasoning":
        return sanitizeReasoning(item);
      case "message":
        return sanitizeMessage(item);
      case "function_call":
        return sanitizeFunctionCall(item);
      default:
        throw new Error("OpenAI returned an unsupported output item.");
    }
  });
  return JSON.parse(JSON.stringify(sanitized)) as JsonValue[];
}

function sanitizeReasoning(item: ResponseReasoningItem): ResponseReasoningItem {
  return {
    type: "reasoning",
    id: item.id,
    summary: item.summary.map((part) => ({
      type: "summary_text",
      text: part.text,
    })),
    ...(item.content === undefined
      ? {}
      : {
          content: item.content.map((part) => ({
            type: "reasoning_text" as const,
            text: part.text,
          })),
        }),
    ...(item.encrypted_content === undefined
      ? {}
      : { encrypted_content: item.encrypted_content }),
    ...(item.status === undefined ? {} : { status: item.status }),
  };
}

function sanitizeMessage(item: ResponseOutputMessage): ResponseOutputMessage {
  return {
    type: "message",
    id: item.id,
    role: "assistant",
    status: item.status,
    content: item.content.map((part) =>
      part.type === "output_text"
        ? {
            type: "output_text" as const,
            text: part.text,
            annotations: part.annotations,
            ...(part.logprobs === undefined ? {} : { logprobs: part.logprobs }),
          }
        : { type: "refusal" as const, refusal: part.refusal },
    ),
    ...(item.phase === undefined ? {} : { phase: item.phase }),
  };
}

function sanitizeFunctionCall(
  item: ResponseFunctionToolCall,
): ResponseFunctionToolCall {
  return {
    type: "function_call",
    call_id: item.call_id,
    name: item.name,
    arguments: item.arguments,
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.caller === undefined ? {} : { caller: item.caller }),
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    ...(item.status === undefined ? {} : { status: item.status }),
  };
}

function normalizeStopReason(response: Response): ModelStopReason {
  const status = response.status ?? "completed";
  switch (status) {
    case "completed":
      if (hasRefusal(response.output)) return "refusal";
      return response.output.some((item) => item.type === "function_call")
        ? "tool_use"
        : "complete";
    case "incomplete": {
      const reason = response.incomplete_details?.reason;
      switch (reason) {
        case "max_output_tokens":
          return "max_tokens";
        case "content_filter":
          return "refusal";
        case undefined:
          return "pause";
        default:
          return assertNever(reason);
      }
    }
    case "in_progress":
    case "queued":
      return "pause";
    case "cancelled":
      throw new Error("OpenAI response was cancelled.");
    case "failed": {
      const code = safeErrorMetadata(response.error?.code);
      throw new Error(
        code === undefined
          ? "OpenAI response failed."
          : `OpenAI response failed (${code}).`,
      );
    }
    default:
      return assertNever(status);
  }
}

function hasRefusal(output: readonly ResponseOutputItem[]): boolean {
  return output.some(
    (item) =>
      item.type === "message" &&
      item.content.some((part) => part.type === "refusal"),
  );
}

function normalizeUsage(usage: ResponseUsage | undefined): TokenUsage {
  if (usage === undefined) return emptyUsage();
  const cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = usage.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    input: Math.max(0, usage.input_tokens - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: usage.output_tokens,
  };
}

function assertNever(_value: never): never {
  throw new Error("OpenAI returned an unsupported response state.");
}

export function formatOpenAIError(error: unknown): string | undefined {
  if (error instanceof OpenAI.APIUserAbortError) {
    return "Request cancelled.";
  }

  if (error instanceof OpenAI.APIError) {
    const details = [
      error.status === undefined ? undefined : `HTTP ${error.status}`,
      safeErrorMetadata(error.code),
      safeErrorMetadata(error.type),
      safeErrorMetadata(error.requestID) === undefined
        ? undefined
        : `request ${safeErrorMetadata(error.requestID)}`,
    ].filter((value): value is string => value !== undefined);
    return details.length === 0
      ? "OpenAI request failed."
      : `OpenAI request failed (${details.join(", ")}).`;
  }

  if (error instanceof OpenAI.OpenAIError) {
    return "OpenAI request failed.";
  }

  return undefined;
}

function safeErrorMetadata(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,80}$/u.test(value)
    ? value
    : undefined;
}
