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

import {
  modelScope,
  type JsonValue,
  type ModelBackend,
  type TranscriptMessage,
} from "./model.js";

const SESSION_VERSION = 2;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const OMITTED_REPLAY_TEXT = "[Prior model reasoning omitted.]";

interface SessionDocument {
  backend: ModelBackend;
  createdAt: string;
  id: string;
  messages: TranscriptMessage[];
  updatedAt: string;
  version: typeof SESSION_VERSION;
  workspace: string;
}

interface LegacySessionDocument {
  createdAt: string;
  id: string;
  messages: LegacyMessage[];
  model: string;
  updatedAt: string;
  version: 1;
  workspace: string;
}

type LegacyBlock = Record<string, JsonValue>;
type LegacyTextBlock = LegacyBlock & { text: string; type: "text" };
type LegacyToolUseBlock = LegacyBlock & {
  id: string;
  input: JsonValue;
  name: string;
  type: "tool_use";
};
type LegacyToolResultBlock = LegacyBlock & {
  content: string;
  tool_use_id: string;
  type: "tool_result";
};
type LegacyMessage = {
  content: string | LegacyBlock[];
  role: "assistant" | "user";
};

export interface LoadedSession {
  backend: ModelBackend;
  messages: TranscriptMessage[];
  updatedAt: string;
}

export interface SessionStoreOptions {
  backend: ModelBackend;
  baseDirectory?: string;
  workspace: string;
}

export class SessionStore {
  readonly #backend: ModelBackend;
  readonly #directory: string;
  readonly #workspace: string;
  #createdAt = new Date().toISOString();
  #id: string = randomUUID();

  constructor(options: SessionStoreOptions) {
    if (!isNonEmptyString(options.workspace)) {
      throw new Error("Session workspace must not be empty.");
    }
    if (!isValidBackend(options.backend)) {
      throw new Error("Session backend is invalid.");
    }
    const base = options.baseDirectory ?? defaultStateDirectory();
    const workspaceKey = createHash("sha256")
      .update(options.workspace)
      .digest("hex")
      .slice(0, 16);
    this.#directory = path.join(base, "sessions", workspaceKey);
    this.#workspace = options.workspace;
    this.#backend = copyBackend(options.backend);
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
      backend: copyBackend(document.backend),
      messages: structuredClone(document.messages),
      updatedAt: document.updatedAt,
    };
  }

  async save(messages: readonly TranscriptMessage[]): Promise<void> {
    if (!isValidConversation(messages)) {
      throw new Error("Cannot save an invalid HelloCode conversation.");
    }

    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const destination = path.join(this.#directory, `session-${this.#id}.json`);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const document: SessionDocument = {
      version: SESSION_VERSION,
      id: this.#id,
      workspace: this.#workspace,
      backend: copyBackend(this.#backend),
      createdAt: this.#createdAt,
      updatedAt: new Date().toISOString(),
      messages: structuredClone(messages) as TranscriptMessage[],
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
 * Removes provider-bound replay data before history is sent to another model
 * backend. Normalized text and tool calls are preserved and the input is never
 * mutated.
 */
export function stripReplayState(
  messages: readonly TranscriptMessage[],
): TranscriptMessage[] {
  return structuredClone(messages).map((message): TranscriptMessage => {
    if (message.role !== "assistant") return message;
    return {
      role: "assistant",
      content:
        message.content.length > 0
          ? message.content
          : [{ type: "text", text: OMITTED_REPLAY_TEXT }],
    };
  });
}

function validateSession(value: unknown, filePath: string): SessionDocument {
  if (!isRecord(value)) throw invalidSession(filePath);
  if (value.version === SESSION_VERSION) {
    if (!isValidSessionDocument(value)) throw invalidSession(filePath);
    return value as unknown as SessionDocument;
  }
  if (value.version === 1) {
    if (!isValidLegacySession(value)) throw invalidSession(filePath);
    return migrateLegacySession(value as unknown as LegacySessionDocument);
  }
  throw invalidSession(filePath);
}

function isValidSessionDocument(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "backend",
      "createdAt",
      "id",
      "messages",
      "updatedAt",
      "version",
      "workspace",
    ]) &&
    value.version === SESSION_VERSION &&
    isUuid(value.id) &&
    isNonEmptyString(value.workspace) &&
    isValidBackend(value.backend) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
    Array.isArray(value.messages) &&
    isValidConversation(value.messages)
  );
}

function isValidLegacySession(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, [
      "createdAt",
      "id",
      "messages",
      "model",
      "updatedAt",
      "version",
      "workspace",
    ]) &&
    value.version === 1 &&
    isUuid(value.id) &&
    isNonEmptyString(value.workspace) &&
    isNonEmptyString(value.model) &&
    isIsoTimestamp(value.createdAt) &&
    isIsoTimestamp(value.updatedAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
    Array.isArray(value.messages) &&
    isValidLegacyConversation(value.messages)
  );
}

function isValidConversation(messages: readonly unknown[]): boolean {
  if (messages.length > 0) {
    const first = messages[0];
    if (!isRecord(first) || first.role !== "user") return false;
  }

  let expectedToolIds: Set<string> | undefined;
  for (const value of messages) {
    if (!isRecord(value)) return false;

    if (expectedToolIds !== undefined) {
      if (!isToolMessage(value)) return false;
      const resultIds = new Set(value.content.map((block) => block.toolCallId));
      if (!sameIds(resultIds, expectedToolIds)) return false;
      expectedToolIds = undefined;
      continue;
    }

    if (isUserMessage(value)) continue;
    if (!isAssistantMessage(value)) return false;

    const toolIds = value.content
      .filter((block) => block.type === "tool_call")
      .map((block) => block.id);
    if (new Set(toolIds).size !== toolIds.length) return false;
    if (toolIds.length > 0) expectedToolIds = new Set(toolIds);
  }

  return expectedToolIds === undefined;
}

function isUserMessage(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, ["content", "role"]) &&
    value.role === "user" &&
    typeof value.content === "string"
  );
}

function isAssistantMessage(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  content: Extract<TranscriptMessage, { role: "assistant" }>["content"];
  role: "assistant";
} {
  if (
    !hasOnlyKeys(value, ["content", "replay", "role"]) ||
    value.role !== "assistant" ||
    !Array.isArray(value.content) ||
    !value.content.every(isNormalizedAssistantBlock)
  ) {
    return false;
  }
  return value.replay === undefined || isModelReplay(value.replay);
}

function isToolMessage(
  value: Record<string, unknown>,
): value is { content: Array<{ toolCallId: string }>; role: "tool" } {
  if (
    !hasOnlyKeys(value, ["content", "role"]) ||
    value.role !== "tool" ||
    !Array.isArray(value.content) ||
    value.content.length === 0 ||
    !value.content.every(isToolResultBlock)
  ) {
    return false;
  }
  const ids = value.content.map((block) => block.toolCallId);
  return new Set(ids).size === ids.length;
}

function isNormalizedAssistantBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") {
    return (
      hasOnlyKeys(value, ["text", "type"]) && typeof value.text === "string"
    );
  }
  return (
    value.type === "tool_call" &&
    hasOnlyKeys(value, ["id", "input", "name", "type"]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isJsonValue(value.input)
  );
}

function isToolResultBlock(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "tool_result" &&
    hasOnlyKeys(value, ["content", "isError", "toolCallId", "type"]) &&
    typeof value.content === "string" &&
    typeof value.isError === "boolean" &&
    isNonEmptyString(value.toolCallId)
  );
}

function isModelReplay(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["format", "items", "scope"]) ||
    !isNonEmptyString(value.scope) ||
    !Array.isArray(value.items)
  ) {
    return false;
  }
  const allowedTypes =
    value.format === "anthropic-content-v1"
      ? ["text", "thinking", "redacted_thinking", "tool_use"]
      : value.format === "responses-output-v1"
        ? ["reasoning", "message", "function_call"]
        : undefined;
  return (
    allowedTypes !== undefined &&
    value.items.every(
      (item) =>
        isRecord(item) &&
        isJsonValue(item) &&
        typeof item.type === "string" &&
        allowedTypes.includes(item.type),
    )
  );
}

function isValidBackend(value: unknown): value is ModelBackend {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["endpoint", "model", "provider"]) &&
    (value.provider === "anthropic" || value.provider === "openai") &&
    isNonEmptyString(value.model) &&
    isEndpointIdentity(value.endpoint)
  );
}

function isEndpointIdentity(value: unknown): value is string {
  return (
    value === "default" ||
    (typeof value === "string" &&
      (/^[0-9a-f]{16}$/u.test(value) ||
        (value.startsWith("legacy-v1:") && isUuid(value.slice(10)))))
  );
}

function isValidLegacyConversation(messages: unknown[]): boolean {
  if (messages.length > 0) {
    const first = messages[0];
    if (!isRecord(first) || first.role !== "user") return false;
  }
  let expectedToolIds: Set<string> | undefined;

  for (const value of messages) {
    if (!isRecord(value) || !hasOnlyKeys(value, ["content", "role"])) {
      return false;
    }

    if (expectedToolIds !== undefined) {
      if (value.role !== "user" || !Array.isArray(value.content)) return false;
      const resultIds = legacyToolResultIds(value.content);
      if (resultIds === undefined || !sameIds(resultIds, expectedToolIds)) {
        return false;
      }
      expectedToolIds = undefined;
      continue;
    }

    if (value.role === "user") {
      if (!isLegacyNaturalUserContent(value.content)) return false;
      continue;
    }
    if (
      value.role !== "assistant" ||
      !isLegacyAssistantContent(value.content)
    ) {
      return false;
    }

    const content = legacyAssistantItems(value.content);
    const toolIds = content
      .filter(isLegacyToolUseBlock)
      .map((block) => block.id);
    if (new Set(toolIds).size !== toolIds.length) return false;
    if (toolIds.length > 0) expectedToolIds = new Set(toolIds);
  }

  return expectedToolIds === undefined;
}

function isLegacyNaturalUserContent(
  value: unknown,
): value is string | LegacyTextBlock[] {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) && value.length > 0 && value.every(isLegacyTextBlock)
  );
}

function isLegacyAssistantContent(
  value: unknown,
): value is string | LegacyBlock[] {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isLegacyAssistantBlock)
  );
}

function isLegacyAssistantBlock(value: unknown): value is LegacyBlock {
  if (!isRecord(value) || !isJsonValue(value)) return false;
  if (isLegacyTextBlock(value) || isLegacyToolUseBlock(value)) return true;
  if (value.type === "thinking") {
    return (
      typeof value.thinking === "string" && isNonEmptyString(value.signature)
    );
  }
  return value.type === "redacted_thinking" && isNonEmptyString(value.data);
}

function isLegacyTextBlock(value: unknown): value is LegacyTextBlock {
  return (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string" &&
    isJsonValue(value)
  );
}

function isLegacyToolUseBlock(value: unknown): value is LegacyToolUseBlock {
  return (
    isRecord(value) &&
    value.type === "tool_use" &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isJsonValue(value.input) &&
    isJsonValue(value)
  );
}

function legacyToolResultIds(blocks: unknown[]): Set<string> | undefined {
  if (blocks.length === 0) return undefined;
  const ids = new Set<string>();
  for (const block of blocks) {
    if (!isLegacyToolResultBlock(block) || ids.has(block.tool_use_id)) {
      return undefined;
    }
    ids.add(block.tool_use_id);
  }
  return ids;
}

function isLegacyToolResultBlock(
  value: unknown,
): value is LegacyToolResultBlock {
  return (
    isRecord(value) &&
    value.type === "tool_result" &&
    isNonEmptyString(value.tool_use_id) &&
    typeof value.content === "string" &&
    (value.is_error === undefined || typeof value.is_error === "boolean") &&
    isJsonValue(value)
  );
}

function migrateLegacySession(legacy: LegacySessionDocument): SessionDocument {
  const backend: ModelBackend = {
    provider: "anthropic",
    model: legacy.model,
    endpoint: `legacy-v1:${legacy.id}`,
  };
  const scope = modelScope(backend);
  const messages: TranscriptMessage[] = legacy.messages.map((message) => {
    if (message.role === "user") {
      const content = message.content;
      if (typeof content === "string") {
        return { role: "user", content };
      }
      if (content.every(isLegacyTextBlock)) {
        return {
          role: "user",
          content: content.map((block) => block.text).join(""),
        };
      }
      const results = content as LegacyToolResultBlock[];
      return {
        role: "tool",
        content: results.map((block) => ({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          content: block.content,
          isError: block.is_error === true,
        })),
      };
    }

    const items = legacyAssistantItems(message.content);
    const normalized: Extract<
      TranscriptMessage,
      { role: "assistant" }
    >["content"] = [];
    for (const block of items) {
      if (isLegacyTextBlock(block)) {
        normalized.push({ type: "text", text: block.text });
      } else if (isLegacyToolUseBlock(block)) {
        normalized.push({
          type: "tool_call",
          id: block.id,
          name: block.name,
          input: structuredClone(block.input),
        });
      }
    }
    return {
      role: "assistant",
      content: normalized,
      replay: {
        format: "anthropic-content-v1",
        scope,
        items: structuredClone(items) as JsonValue[],
      },
    };
  });

  return {
    version: SESSION_VERSION,
    id: legacy.id,
    workspace: legacy.workspace,
    backend,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    messages,
  };
}

function legacyAssistantItems(content: string | LegacyBlock[]): LegacyBlock[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInner(value, new Set());
}

function isJsonValueInner(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((item) => isJsonValueInner(item, ancestors));
    ancestors.delete(value);
    return valid;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  const valid =
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((item) => isJsonValueInner(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function copyBackend(backend: ModelBackend): ModelBackend {
  return {
    provider: backend.provider,
    model: backend.model,
    endpoint: backend.endpoint,
  };
}

function sameIds(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
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
