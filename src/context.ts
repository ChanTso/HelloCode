import type Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MAX_CHARS = 600_000;
const COMPACTED_RESULT_CHARS = 1200;

export interface CompactResult {
  changed: boolean;
  messages: Anthropic.MessageParam[];
  removedTurns: number;
  shortenedResults: number;
}

export class ContextManager {
  readonly #maxChars: number;

  constructor(maxChars = DEFAULT_MAX_CHARS) {
    if (!Number.isInteger(maxChars) || maxChars < 20_000) {
      throw new Error("Context character budget must be at least 20000.");
    }
    this.#maxChars = maxChars;
  }

  compact(
    source: readonly Anthropic.MessageParam[],
    force = false,
  ): CompactResult {
    const originalSize = estimateSize(source);
    if (!force && originalSize <= this.#maxChars) {
      return {
        changed: false,
        messages: source as Anthropic.MessageParam[],
        removedTurns: 0,
        shortenedResults: 0,
      };
    }

    const messages = structuredClone(source) as Anthropic.MessageParam[];
    let shortenedResults = shortenOldToolResults(messages, force);
    let removedTurns = 0;
    const target = force
      ? Math.floor(this.#maxChars * 0.5)
      : Math.floor(this.#maxChars * 0.8);

    const starts = naturalTurnStarts(messages);
    if (starts.length > 1 && (force || estimateSize(messages) > target)) {
      const keepFrom = starts[Math.max(1, starts.length - (force ? 1 : 2))];
      if (keepFrom !== undefined && keepFrom > 0) {
        const removed = messages.splice(0, keepFrom);
        removedTurns = countNaturalTurns(removed);
        prependCompactionNote(
          messages,
          summarizeRemoved(removed, removedTurns),
        );
      }
    }

    if (estimateSize(messages) > target) {
      shortenedResults += shortenOldToolResults(messages, true, true);
    }

    return {
      changed: removedTurns > 0 || shortenedResults > 0,
      messages,
      removedTurns,
      shortenedResults,
    };
  }
}

function shortenOldToolResults(
  messages: Anthropic.MessageParam[],
  force: boolean,
  includeRecent = false,
): number {
  const lastProtectedIndex = includeRecent
    ? messages.length
    : Math.max(0, messages.length - (force ? 1 : 6));
  let count = 0;

  for (const [messageIndex, message] of messages.entries()) {
    if (!includeRecent && messageIndex >= lastProtectedIndex) continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block.type !== "tool_result" ||
        typeof block.content !== "string" ||
        block.content.length <= COMPACTED_RESULT_CHARS
      ) {
        continue;
      }
      const originalLength = block.content.length;
      block.content = `${block.content.slice(0, COMPACTED_RESULT_CHARS)}\n\n[Earlier tool result compacted from ${originalLength} characters. Re-run the tool if more detail is needed.]`;
      count += 1;
    }
  }
  return count;
}

function naturalTurnStarts(
  messages: readonly Anthropic.MessageParam[],
): number[] {
  const starts: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" && !isToolResultOnly(message))
      starts.push(index);
  }
  return starts;
}

function isToolResultOnly(message: Anthropic.MessageParam): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "tool_result")
  );
}

function countNaturalTurns(
  messages: readonly Anthropic.MessageParam[],
): number {
  return naturalTurnStarts(messages).length;
}

function summarizeRemoved(
  messages: readonly Anthropic.MessageParam[],
  turns: number,
): string {
  const excerpts: string[] = [];
  for (const message of messages) {
    const text = messageText(message).trim().replace(/\s+/gu, " ");
    if (text.length === 0) continue;
    const role = message.role === "user" ? "User" : "Assistant";
    excerpts.push(`- ${role}: ${text.slice(0, 500)}`);
    if (excerpts.length === 8) break;
  }
  const detail = excerpts.length === 0 ? "" : `\n${excerpts.join("\n")}`;
  return `[HelloCode compacted ${turns} earlier conversation turn${turns === 1 ? "" : "s"}. Re-inspect the workspace before relying on omitted details.]${detail}`;
}

function prependCompactionNote(
  messages: Anthropic.MessageParam[],
  note: string,
): void {
  const first = messages[0];
  if (first?.role === "user" && typeof first.content === "string") {
    first.content = `${note}\n\n${first.content}`;
    return;
  }
  messages.unshift({ role: "user", content: note });
}

function messageText(message: Anthropic.MessageParam): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function estimateSize(messages: readonly Anthropic.MessageParam[]): number {
  return JSON.stringify(messages).length;
}
