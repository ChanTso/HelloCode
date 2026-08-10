import { createHash } from "node:crypto";

export type ModelProvider = "anthropic" | "openai";

export interface ModelBackend {
  endpoint: string;
  model: string;
  provider: ModelProvider;
}

export type JsonValue =
  boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ModelReplay {
  format: "anthropic-content-v1" | "responses-output-v1";
  items: JsonValue[];
  scope: string;
}

export interface TextBlock {
  text: string;
  type: "text";
}

export interface ToolCallBlock {
  id: string;
  input: unknown;
  name: string;
  type: "tool_call";
}

export interface ToolResultBlock {
  content: string;
  isError: boolean;
  toolCallId: string;
  type: "tool_result";
}

export interface UserMessage {
  content: string;
  role: "user";
}

export interface AssistantMessage {
  content: Array<TextBlock | ToolCallBlock>;
  replay?: ModelReplay;
  role: "assistant";
}

export interface ToolMessage {
  content: ToolResultBlock[];
  role: "tool";
}

export type TranscriptMessage = UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  strict: boolean;
}

export interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export type ModelStopReason =
  | "complete"
  | "context_limit"
  | "max_tokens"
  | "pause"
  | "refusal"
  | "tool_use";

export interface ModelTurn {
  message: AssistantMessage;
  stopReason: ModelStopReason;
  usage: TokenUsage;
}

export interface ModelRequest {
  messages: TranscriptMessage[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  system: string;
  tools: ToolDefinition[];
}

export interface ModelClient {
  createMessage(request: ModelRequest): Promise<ModelTurn>;
}

export function createModelBackend(
  provider: ModelProvider,
  model: string,
  baseUrl?: string,
): ModelBackend {
  return {
    provider,
    model,
    endpoint:
      baseUrl === undefined
        ? "default"
        : createHash("sha256").update(baseUrl).digest("hex").slice(0, 16),
  };
}

export function modelScope(backend: ModelBackend): string {
  return `${backend.provider}:${backend.model}:${backend.endpoint}`;
}

export const emptyUsage = (): TokenUsage => ({
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
});

export function addUsage(total: TokenUsage, next: TokenUsage): void {
  total.input += next.input;
  total.cacheWrite += next.cacheWrite;
  total.cacheRead += next.cacheRead;
  total.output += next.output;
}
