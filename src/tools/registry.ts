import type { ToolDefinition } from "../model.js";
import type { PermissionGate } from "../permissions.js";
import type { WorkspacePaths } from "../paths.js";
import { errorMessage, truncateToolResult, type ToolSpec } from "./types.js";

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export class ToolRegistry {
  readonly #gate: PermissionGate;
  readonly #paths: WorkspacePaths;
  readonly #tools: Map<string, ToolSpec>;

  constructor(
    tools: readonly ToolSpec[],
    paths: WorkspacePaths,
    gate: PermissionGate,
  ) {
    this.#paths = paths;
    this.#gate = gate;
    this.#tools = new Map();
    for (const tool of tools) {
      if (this.#tools.has(tool.definition.name)) {
        throw new Error(`Duplicate tool name: ${tool.definition.name}`);
      }
      this.#tools.set(tool.definition.name, tool);
    }
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }

  async execute(
    name: string,
    rawInput: unknown,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    try {
      throwIfAborted(signal);
      const input = tool.parse(rawInput);
      const context = {
        paths: this.#paths,
        ...(signal === undefined ? {} : { signal }),
      };
      await this.#gate.authorize(await tool.permission(input, context), signal);
      throwIfAborted(signal);
      const output = await tool.execute(input, context);
      throwIfAborted(signal);
      return {
        content: truncateToolResult(
          output.length === 0 ? "(no output)" : output,
        ),
        isError: false,
      };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return {
        content: truncateToolResult(errorMessage(error)),
        isError: true,
      };
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Tool execution cancelled.");
  error.name = "AbortError";
  throw error;
}
