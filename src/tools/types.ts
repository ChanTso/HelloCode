import type Anthropic from "@anthropic-ai/sdk";

import type { PermissionRequest } from "../permissions.js";
import type { WorkspacePaths } from "../paths.js";

export const MAX_TOOL_RESULT_CHARS = 30_000;

export interface ToolContext {
  paths: WorkspacePaths;
  signal?: AbortSignal;
}

export interface ToolSpec {
  definition: Anthropic.Tool;
  execute(input: unknown, context: ToolContext): Promise<string>;
  parse(input: unknown): unknown;
  permission(
    input: unknown,
    context: ToolContext,
  ): PermissionRequest | Promise<PermissionRequest>;
}

interface TypedToolSpec<T> {
  definition: Anthropic.Tool;
  execute(input: T, context: ToolContext): Promise<string>;
  parse(input: unknown): T;
  permission(
    input: T,
    context: ToolContext,
  ): PermissionRequest | Promise<PermissionRequest>;
}

export function defineTool<T>(spec: TypedToolSpec<T>): ToolSpec {
  return {
    definition: spec.definition,
    parse: spec.parse,
    permission: (input, context) => spec.permission(input as T, context),
    execute: (input, context) => spec.execute(input as T, context),
  };
}

export function objectInput(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Tool input must be an object.");
  }
  const record = input as Record<string, unknown>;
  const unexpected = Object.keys(record).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpected.length > 0) {
    throw new TypeError(`Unexpected input field: ${unexpected[0]}`);
  }
  return record;
}

export function stringField(
  input: Record<string, unknown>,
  name: string,
): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

export function optionalStringField(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string when provided.`);
  }
  return value;
}

export function optionalBooleanField(
  input: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean when provided.`);
  }
  return value;
}

export function optionalIntegerField(
  input: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const marker = `\n\n[... ${text.length - MAX_TOOL_RESULT_CHARS} characters omitted; narrow the request to see more ...]\n\n`;
  const available = MAX_TOOL_RESULT_CHARS - marker.length;
  const headLength = Math.ceil(available * 0.6);
  return `${text.slice(0, headLength)}${marker}${text.slice(-available + headLength)}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
