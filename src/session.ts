import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Anthropic from "@anthropic-ai/sdk";

const SESSION_VERSION = 1;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;

interface SessionDocument {
  createdAt: string;
  id: string;
  messages: Anthropic.MessageParam[];
  model: string;
  updatedAt: string;
  version: number;
  workspace: string;
}

export interface LoadedSession {
  messages: Anthropic.MessageParam[];
  model: string;
  updatedAt: string;
}

export interface SessionStoreOptions {
  baseDirectory?: string;
  model: string;
  workspace: string;
}

export class SessionStore {
  readonly #directory: string;
  readonly #model: string;
  readonly #workspace: string;
  #createdAt = new Date().toISOString();
  #id: string = randomUUID();

  constructor(options: SessionStoreOptions) {
    if (!isNonEmptyString(options.workspace)) {
      throw new Error("Session workspace must not be empty.");
    }
    if (!isNonEmptyString(options.model)) {
      throw new Error("Session model must not be empty.");
    }
    const base = options.baseDirectory ?? defaultStateDirectory();
    const workspaceKey = createHash("sha256")
      .update(options.workspace)
      .digest("hex")
      .slice(0, 16);
    this.#directory = path.join(base, "sessions", workspaceKey);
    this.#workspace = options.workspace;
    this.#model = options.model;
  }

  async loadLatest(): Promise<LoadedSession | undefined> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const names = (await readdir(this.#directory)).filter(
      (name) => name.startsWith("session-") && name.endsWith(".json"),
    );
    if (names.length === 0) return undefined;

    const candidates = await Promise.all(
      names.map(async (name) => ({
        name,
        modified: (await stat(path.join(this.#directory, name))).mtimeMs,
      })),
    );
    candidates.sort((left, right) => right.modified - left.modified);
    const latest = candidates[0];
    if (latest === undefined) return undefined;
    const filePath = path.join(this.#directory, latest.name);
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_SESSION_BYTES) {
      throw new Error(
        `Latest HelloCode session is too large to load: ${filePath}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      throw new Error(
        `Could not read latest HelloCode session ${filePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const document = validateSession(parsed, filePath);
    if (document.workspace !== this.#workspace) {
      throw new Error(
        "Latest HelloCode session belongs to a different workspace.",
      );
    }
    this.#id = document.id;
    this.#createdAt = document.createdAt;
    return {
      messages: structuredClone(document.messages),
      model: document.model,
      updatedAt: document.updatedAt,
    };
  }

  async save(messages: readonly Anthropic.MessageParam[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const destination = path.join(this.#directory, `session-${this.#id}.json`);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const document: SessionDocument = {
      version: SESSION_VERSION,
      id: this.#id,
      workspace: this.#workspace,
      model: this.#model,
      createdAt: this.#createdAt,
      updatedAt: new Date().toISOString(),
      messages: structuredClone(messages) as Anthropic.MessageParam[],
    };

    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  reset(): void {
    this.#id = randomUUID();
    this.#createdAt = new Date().toISOString();
  }
}

export function defaultStateDirectory(): string {
  const override = process.env.HELLOCODE_HOME;
  if (override !== undefined && override.length > 0)
    return path.resolve(override);
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState.length > 0) {
    return path.join(xdgState, "hellocode");
  }
  return path.join(os.homedir(), ".hellocode");
}

/**
 * Removes model-bound reasoning signatures before history is sent to a
 * different model. The input is cloned and never mutated.
 */
export function stripThinkingBlocks(
  messages: readonly Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  return structuredClone(messages).map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }

    const content = message.content.filter(
      (block) =>
        block.type !== "thinking" && block.type !== "redacted_thinking",
    );
    return {
      ...message,
      content:
        content.length > 0
          ? content
          : [
              {
                type: "text",
                text: "[Prior model reasoning omitted after switching models.]",
              },
            ],
    };
  }) as Anthropic.MessageParam[];
}

function validateSession(value: unknown, filePath: string): SessionDocument {
  if (!isRecord(value)) throw invalidSession(filePath);
  if (
    value.version !== SESSION_VERSION ||
    !isUuid(value.id) ||
    !isNonEmptyString(value.workspace) ||
    !isNonEmptyString(value.model) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt) ||
    !Array.isArray(value.messages) ||
    !isValidConversation(value.messages)
  ) {
    throw invalidSession(filePath);
  }
  return value as unknown as SessionDocument;
}

function isValidConversation(messages: unknown[]): boolean {
  if (messages.length > 0) {
    const first = messages[0];
    if (!isRecord(first) || first.role !== "user") return false;
  }
  let expectedToolIds: Set<string> | undefined;

  for (const value of messages) {
    if (!isRecord(value)) return false;

    if (expectedToolIds !== undefined) {
      if (value.role !== "user" || !Array.isArray(value.content)) return false;
      const resultIds = toolResultIds(value.content);
      if (resultIds === undefined || !sameIds(resultIds, expectedToolIds)) {
        return false;
      }
      expectedToolIds = undefined;
      continue;
    }

    if (value.role === "user") {
      if (!isNaturalUserContent(value.content)) return false;
      continue;
    }
    if (value.role !== "assistant" || !isAssistantContent(value.content)) {
      return false;
    }

    if (Array.isArray(value.content)) {
      const toolIds = value.content
        .filter(isToolUseBlock)
        .map((block) => block.id);
      if (new Set(toolIds).size !== toolIds.length) return false;
      if (toolIds.length > 0) expectedToolIds = new Set(toolIds);
    }
  }

  return expectedToolIds === undefined;
}

function isNaturalUserContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((block) => isTextBlock(block))
  );
}

function isAssistantContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (block) =>
        isTextBlock(block) ||
        isThinkingBlock(block) ||
        isRedactedThinkingBlock(block) ||
        isToolUseBlock(block),
    )
  );
}

function isTextBlock(value: unknown): value is Anthropic.TextBlockParam {
  return (
    isRecord(value) && value.type === "text" && typeof value.text === "string"
  );
}

function isThinkingBlock(
  value: unknown,
): value is Anthropic.ThinkingBlockParam {
  return (
    isRecord(value) &&
    value.type === "thinking" &&
    typeof value.thinking === "string" &&
    isNonEmptyString(value.signature)
  );
}

function isRedactedThinkingBlock(
  value: unknown,
): value is Anthropic.RedactedThinkingBlockParam {
  return (
    isRecord(value) &&
    value.type === "redacted_thinking" &&
    isNonEmptyString(value.data)
  );
}

function isToolUseBlock(value: unknown): value is Anthropic.ToolUseBlockParam {
  return (
    isRecord(value) &&
    value.type === "tool_use" &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isRecord(value.input)
  );
}

function toolResultIds(blocks: unknown[]): Set<string> | undefined {
  if (blocks.length === 0) return undefined;
  const ids = new Set<string>();
  for (const block of blocks) {
    if (
      !isRecord(block) ||
      block.type !== "tool_result" ||
      !isNonEmptyString(block.tool_use_id) ||
      typeof block.content !== "string" ||
      (block.is_error !== undefined && typeof block.is_error !== "boolean") ||
      ids.has(block.tool_use_id)
    ) {
      return undefined;
    }
    ids.add(block.tool_use_id);
  }
  return ids;
}

function sameIds(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSession(filePath: string): Error {
  return new Error(`Invalid or unsupported HelloCode session: ${filePath}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
