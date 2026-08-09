import type Anthropic from "@anthropic-ai/sdk";

import { ContextManager, type CompactResult } from "./context.js";
import {
  addUsage,
  emptyUsage,
  type ModelClient,
  type TokenUsage,
} from "./model.js";
import type { ToolExecutionResult, ToolRegistry } from "./tools/index.js";

export type AgentStop =
  "complete" | "context_limit" | "max_tokens" | "refusal" | "turn_limit";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; input: unknown; name: string }
  | {
      type: "tool_result";
      id: string;
      isError: boolean;
      name: string;
      preview: string;
    }
  | { type: "usage"; usage: TokenUsage }
  | {
      type: "context_compacted";
      removedTurns: number;
      shortenedResults: number;
    };

export interface AgentRunResult {
  stop: AgentStop;
  text: string;
  toolCalls: number;
  turns: number;
  usage: TokenUsage;
}

export interface AgentOptions {
  context?: ContextManager;
  maxToolCalls?: number;
  maxTurns?: number;
  onEvent?: (event: AgentEvent) => void;
  system: string;
}

export class Agent {
  readonly #context: ContextManager;
  readonly #maxToolCalls: number;
  readonly #maxTurns: number;
  readonly #model: ModelClient;
  readonly #onEvent: ((event: AgentEvent) => void) | undefined;
  readonly #registry: ToolRegistry;
  readonly #system: string;
  #messages: Anthropic.MessageParam[] = [];

  constructor(
    model: ModelClient,
    registry: ToolRegistry,
    options: AgentOptions,
  ) {
    this.#model = model;
    this.#registry = registry;
    this.#system = options.system;
    this.#maxTurns = options.maxTurns ?? 40;
    this.#maxToolCalls = options.maxToolCalls ?? 100;
    this.#context = options.context ?? new ContextManager();
    this.#onEvent = options.onEvent;
  }

  get messages(): readonly Anthropic.MessageParam[] {
    return this.#messages;
  }

  clear(): void {
    this.#messages = [];
  }

  restore(messages: Anthropic.MessageParam[]): void {
    this.#messages = structuredClone(messages);
  }

  compact(force = true): CompactResult {
    const result = this.#context.compact(this.#messages, force);
    if (result.changed) {
      this.#messages = result.messages;
      this.#onEvent?.({
        type: "context_compacted",
        removedTurns: result.removedTurns,
        shortenedResults: result.shortenedResults,
      });
    }
    return result;
  }

  async run(
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<AgentRunResult> {
    if (userMessage.trim() === "")
      throw new Error("Message must not be empty.");
    this.#messages.push({ role: "user", content: userMessage });

    const usage = emptyUsage();
    const textParts: string[] = [];
    let toolCalls = 0;
    let reactiveCompactionUsed = false;

    for (let turns = 1; turns <= this.#maxTurns; turns += 1) {
      if (isAborted(signal)) throw abortError();
      this.compact(false);
      const turn = await this.#model.createMessage({
        messages: this.#messages,
        system: this.#system,
        tools: this.#registry.definitions(),
        ...(signal === undefined ? {} : { signal }),
        onText: (delta) => this.#onEvent?.({ type: "text", delta }),
      });
      addUsage(usage, turn.usage);
      this.#onEvent?.({ type: "usage", usage: { ...usage } });
      this.#messages.push({
        role: "assistant",
        content: turn.content as Anthropic.ContentBlockParam[],
      });

      const turnText = turn.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (turnText.length > 0) textParts.push(turnText);

      const calls = turn.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (turn.stopReason === "tool_use") {
        if (calls.length === 0) {
          throw new Error("Model stopped for tool use without a tool call.");
        }
        if (
          turns === this.#maxTurns ||
          toolCalls + calls.length > this.#maxToolCalls
        ) {
          this.#appendSkippedResults(
            calls,
            "HelloCode reached its tool or turn limit.",
          );
          return {
            stop: "turn_limit",
            text: textParts.join("\n"),
            toolCalls,
            turns,
            usage,
          };
        }

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const call of calls) {
          if (isAborted(signal)) throw abortError();
          toolCalls += 1;
          this.#onEvent?.({
            type: "tool_start",
            id: call.id,
            input: call.input,
            name: call.name,
          });
          const result = await this.#registry.execute(
            call.name,
            call.input,
            signal,
          );
          results.push(toToolResult(call.id, result));
          this.#onEvent?.({
            type: "tool_result",
            id: call.id,
            isError: result.isError,
            name: call.name,
            preview: result.content.slice(0, 160),
          });
        }
        this.#messages.push({ role: "user", content: results });
        continue;
      }

      if (calls.length > 0) {
        this.#appendSkippedResults(
          calls,
          `Tool calls were not executed because the model stopped with ${String(turn.stopReason)}.`,
        );
      }

      switch (turn.stopReason) {
        case "end_turn":
        case "stop_sequence":
          return {
            stop: "complete",
            text: textParts.join("\n"),
            toolCalls,
            turns,
            usage,
          };
        case "pause_turn":
          if (turns === this.#maxTurns) {
            return {
              stop: "turn_limit",
              text: textParts.join("\n"),
              toolCalls,
              turns,
              usage,
            };
          }
          continue;
        case "max_tokens":
          return {
            stop: "max_tokens",
            text: textParts.join("\n"),
            toolCalls,
            turns,
            usage,
          };
        case "model_context_window_exceeded":
          if (!reactiveCompactionUsed && turns < this.#maxTurns) {
            const compacted = this.compact(true);
            if (compacted.changed) {
              reactiveCompactionUsed = true;
              continue;
            }
          }
          return {
            stop: "context_limit",
            text: textParts.join("\n"),
            toolCalls,
            turns,
            usage,
          };
        case "refusal":
          return {
            stop: "refusal",
            text: textParts.join("\n"),
            toolCalls,
            turns,
            usage,
          };
        case null:
          throw new Error(
            "Model returned a final message without a stop reason.",
          );
        default:
          return assertNever(turn.stopReason);
      }
    }

    throw new Error("Agent loop ended unexpectedly.");
  }

  #appendSkippedResults(calls: Anthropic.ToolUseBlock[], reason: string): void {
    this.#messages.push({
      role: "user",
      content: calls.map((call) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: reason,
        is_error: true,
      })),
    });
  }
}

function toToolResult(
  id: string,
  result: ToolExecutionResult,
): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported stop reason: ${String(value)}`);
}

function abortError(): Error {
  const error = new Error("Agent run cancelled.");
  error.name = "AbortError";
  return error;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}
