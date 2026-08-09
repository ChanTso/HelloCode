import type Anthropic from "@anthropic-ai/sdk";

export interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface ModelTurn {
  content: Anthropic.ContentBlock[];
  requestId?: string;
  stopReason: Anthropic.StopReason | null;
  usage: TokenUsage;
}

export interface ModelRequest {
  messages: Anthropic.MessageParam[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  system: string;
  tools: Anthropic.Tool[];
}

export interface ModelClient {
  createMessage(request: ModelRequest): Promise<ModelTurn>;
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
