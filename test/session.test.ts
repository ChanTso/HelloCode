import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createModelBackend,
  modelScope,
  type ModelBackend,
  type TranscriptMessage,
} from "../src/model.js";
import { SessionStore, stripReplayState } from "../src/session.js";

let baseDirectory: string;
let workspace: string;

const backend: ModelBackend = {
  provider: "openai",
  model: "test-model",
  endpoint: "0123456789abcdef",
};

beforeEach(async () => {
  baseDirectory = await mkdtemp(path.join(os.tmpdir(), "hellocode-session-"));
  workspace = path.join(baseDirectory, "workspace");
});

afterEach(async () => {
  await rm(baseDirectory, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("saves and restores a v2 backend-scoped neutral transcript", async () => {
    const messages = completeConversation();
    await createStore().save(messages);

    const loaded = await createStore().loadLatest();

    expect(loaded).toEqual({
      backend,
      messages,
      updatedAt: expect.any(String),
    });
    expect(loaded).not.toHaveProperty("id");

    const document = await readSessionDocument();
    expect(document).toMatchObject({ version: 2, backend, workspace });
    expect(document).not.toHaveProperty("model");
  });

  it("writes private files without API keys or raw base URLs", async () => {
    const apiKey = "session-secret-must-not-leak";
    const baseUrl = "https://private-gateway.example/v1";
    const scopedBackend = createModelBackend("openai", "luna", baseUrl);
    const options = {
      baseDirectory,
      workspace,
      backend: scopedBackend,
      apiKey,
      baseUrl,
    };
    const store = new SessionStore(options);

    const previousApiKey = process.env.CLIPROXY_API_KEY;
    process.env.CLIPROXY_API_KEY = apiKey;
    try {
      await store.save([{ role: "user", content: "private" }]);
    } finally {
      if (previousApiKey === undefined) delete process.env.CLIPROXY_API_KEY;
      else process.env.CLIPROXY_API_KEY = previousApiKey;
    }

    const file = await findSessionFile();
    const serialized = await readFile(file, "utf8");
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(baseUrl);
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).toContain(scopedBackend.endpoint);
  });

  it("reports a corrupt latest session instead of silently ignoring it", async () => {
    await createStore().save([{ role: "user", content: "valid" }]);
    await writeFile(await findSessionFile(), "{broken", "utf8");

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Could not read latest HelloCode session",
    );
  });

  it("can persist an intentionally cleared session", async () => {
    await createStore().save([]);

    await expect(createStore().loadLatest()).resolves.toMatchObject({
      backend,
      messages: [],
    });
  });

  it.each([
    [
      "session id",
      (document: Record<string, unknown>) => (document.id = "../escape"),
    ],
    [
      "creation timestamp",
      (document: Record<string, unknown>) => (document.createdAt = "last week"),
    ],
    [
      "update timestamp",
      (document: Record<string, unknown>) =>
        (document.updatedAt = "2026-01-01T00:00:00Z"),
    ],
    [
      "workspace",
      (document: Record<string, unknown>) => (document.workspace = "  "),
    ],
    ["version", (document: Record<string, unknown>) => (document.version = 3)],
    [
      "backend provider",
      (document: Record<string, unknown>) =>
        ((document.backend as Record<string, unknown>).provider = "mystery"),
    ],
    [
      "backend model",
      (document: Record<string, unknown>) =>
        ((document.backend as Record<string, unknown>).model = ""),
    ],
    [
      "backend endpoint",
      (document: Record<string, unknown>) =>
        ((document.backend as Record<string, unknown>).endpoint = " "),
    ],
    [
      "unexpected secret field",
      (document: Record<string, unknown>) =>
        ((document.backend as Record<string, unknown>).apiKey = "leaked"),
    ],
  ])("rejects an invalid %s", async (_label, mutate) => {
    await seedSession([{ role: "user", content: "hello" }]);
    await rewriteSession(mutate);

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Invalid or unsupported HelloCode session",
    );
  });

  it.each([
    [
      "unknown assistant block",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "mystery", text: "no" }] },
      ],
    ],
    [
      "tool result on an assistant message",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_result",
              toolCallId: "call-1",
              content: "no",
              isError: false,
            },
          ],
        },
      ],
    ],
    [
      "malformed tool call",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "call-1", name: "read_file" }],
        },
      ],
    ],
    [
      "assistant-first transcript",
      [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
    ],
    [
      "malformed replay format",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          replay: { format: "unknown", scope: "scope", items: [] },
        },
      ],
    ],
    [
      "malformed replay items",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          replay: {
            format: "responses-output-v1",
            scope: "scope",
            items: { not: "an array" },
          },
        },
      ],
    ],
    [
      "unknown Responses replay item",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          replay: {
            format: "responses-output-v1",
            scope: "scope",
            items: [{ type: "web_search_call", id: "search-1" }],
          },
        },
      ],
    ],
    [
      "unknown Anthropic replay block",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          replay: {
            format: "anthropic-content-v1",
            scope: "scope",
            items: [{ type: "server_tool_use", id: "tool-1" }],
          },
        },
      ],
    ],
    [
      "unexpected neutral field",
      [{ role: "user", content: "hello", provider: "openai" }],
    ],
  ])("rejects a %s", async (_label, messages) => {
    await seedSession([{ role: "user", content: "valid" }]);
    await rewriteSession((document) => (document.messages = messages));

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Invalid or unsupported HelloCode session",
    );
  });

  it.each([
    [
      "orphan tool result",
      [
        { role: "user", content: "run it" },
        { role: "tool", content: [toolResult("call-1")] },
      ],
    ],
    [
      "dangling tool call",
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: [toolCall("call-1")] },
      ],
    ],
    [
      "natural user message after a tool call",
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: [toolCall("call-1")] },
        { role: "user", content: "skip that" },
      ],
    ],
    [
      "mismatched tool result",
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: [toolCall("call-1")] },
        { role: "tool", content: [toolResult("call-2")] },
      ],
    ],
    [
      "duplicate tool result",
      [
        { role: "user", content: "run it" },
        { role: "assistant", content: [toolCall("call-1")] },
        {
          role: "tool",
          content: [toolResult("call-1"), toolResult("call-1")],
        },
      ],
    ],
    [
      "missing tool result",
      [
        { role: "user", content: "run both" },
        {
          role: "assistant",
          content: [toolCall("call-1"), toolCall("call-2")],
        },
        { role: "tool", content: [toolResult("call-1")] },
      ],
    ],
  ])("rejects a conversation with a %s", async (_label, messages) => {
    await seedSession([{ role: "user", content: "valid" }]);
    await rewriteSession((document) => (document.messages = messages));

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Invalid or unsupported HelloCode session",
    );
  });

  it("restores a complete multi-tool pair when result order differs", async () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "inspect both" },
      {
        role: "assistant",
        content: [toolCall("call-1"), toolCall("call-2")],
        replay: {
          format: "responses-output-v1",
          scope: modelScope(backend),
          items: [responsesReasoning(), responsesFunctionCall("call-1")],
        },
      },
      {
        role: "tool",
        content: [toolResult("call-2"), toolResult("call-1")],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    await createStore().save(messages);

    await expect(createStore().loadLatest()).resolves.toMatchObject({
      messages,
      backend,
    });
  });

  it("rejects non-JSON tool inputs and replay state before writing", async () => {
    const invalidInput = [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            input: { path: undefined },
          },
        ],
      },
      { role: "tool", content: [toolResult("call-1")] },
    ] as unknown as TranscriptMessage[];
    await expect(createStore().save(invalidInput)).rejects.toThrow(
      "Cannot save an invalid HelloCode conversation",
    );

    const invalidReplay = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [],
        replay: {
          format: "responses-output-v1",
          scope: "scope",
          items: [{ output: undefined }],
        },
      },
    ] as unknown as TranscriptMessage[];
    await expect(createStore().save(invalidReplay)).rejects.toThrow(
      "Cannot save an invalid HelloCode conversation",
    );

    await expect(findSessionFile()).rejects.toThrow("No session directory");
  });

  it("migrates a valid v1 Anthropic transcript with legacy-scoped replay", async () => {
    await seedSession([{ role: "user", content: "placeholder" }]);
    const legacyMessages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect " },
          { type: "text", text: "it" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I should inspect it.",
            signature: "signed",
          },
          { type: "text", text: "Looking.", citations: null },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
            caller: { type: "direct" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "contents",
            is_error: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "Done.", citations: null },
        ],
      },
    ];
    await rewriteSession((document) => {
      document.version = 1;
      document.model = "legacy-claude";
      document.messages = legacyMessages;
      delete document.backend;
    });

    const document = await readSessionDocument();
    const legacyBackend: ModelBackend = {
      provider: "anthropic",
      model: "legacy-claude",
      endpoint: `legacy-v1:${String(document.id)}`,
    };
    const loaded = await createStore().loadLatest();

    expect(loaded?.backend).toEqual(legacyBackend);
    expect(loaded?.backend.endpoint).not.toBe(backend.endpoint);
    expect(loaded?.messages).toEqual([
      { role: "user", content: "inspect it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          {
            type: "tool_call",
            id: "call-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
        replay: {
          format: "anthropic-content-v1",
          scope: modelScope(legacyBackend),
          items: legacyMessages[1]?.content,
        },
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            content: "contents",
            isError: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        replay: {
          format: "anthropic-content-v1",
          scope: modelScope(legacyBackend),
          items: legacyMessages[3]?.content,
        },
      },
    ]);

    await createStore().save(loaded?.messages ?? []);
    await expect(createStore().loadLatest()).resolves.toMatchObject({
      backend,
      messages: loaded?.messages,
    });
  });

  it.each([
    [
      "unknown v1 assistant block",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "mystery", text: "no" }] },
      ],
    ],
    [
      "malformed v1 thinking block",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm", signature: "" }],
        },
      ],
    ],
    [
      "orphan v1 tool result",
      [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "done" },
          ],
        },
      ],
    ],
    [
      "mismatched v1 tool result",
      [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-2", content: "done" },
          ],
        },
      ],
    ],
  ])("rejects a %s during migration", async (_label, messages) => {
    await seedSession([{ role: "user", content: "placeholder" }]);
    await rewriteSession((document) => {
      document.version = 1;
      document.model = "legacy-claude";
      document.messages = messages;
      delete document.backend;
    });

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Invalid or unsupported HelloCode session",
    );
  });
});

describe("stripReplayState", () => {
  it("removes replay without mutating normalized content", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }, toolCall("call-1")],
        replay: {
          format: "anthropic-content-v1",
          scope: "old-scope",
          items: [
            { type: "thinking", thinking: "private", signature: "signed" },
          ],
        },
      },
      { role: "tool", content: [toolResult("call-1")] },
      {
        role: "assistant",
        content: [],
        replay: {
          format: "responses-output-v1",
          scope: "old-scope",
          items: [responsesReasoning()],
        },
      },
    ];

    const stripped = stripReplayState(messages);

    expect(stripped).toEqual([
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }, toolCall("call-1")],
      },
      { role: "tool", content: [toolResult("call-1")] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "[Prior model reasoning omitted.]",
          },
        ],
      },
    ]);
    expect(messages[1]).toHaveProperty("replay");
    expect(messages[3]?.content).toEqual([]);
  });
});

function createStore(selectedBackend = backend): SessionStore {
  return new SessionStore({
    baseDirectory,
    workspace,
    backend: selectedBackend,
  });
}

function completeConversation(): TranscriptMessage[] {
  return [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "I'll inspect it." }, toolCall("call-1")],
      replay: {
        format: "responses-output-v1",
        scope: modelScope(backend),
        items: [
          responsesReasoning(),
          responsesMessage("Looking."),
          responsesFunctionCall("call-1"),
        ],
      },
    },
    { role: "tool", content: [toolResult("call-1")] },
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  ];
}

function toolCall(
  id: string,
): Extract<
  Extract<TranscriptMessage, { role: "assistant" }>["content"][number],
  { type: "tool_call" }
> {
  return {
    type: "tool_call",
    id,
    name: "read_file",
    input: { path: id },
  };
}

function responsesReasoning() {
  return {
    type: "reasoning",
    opaque: { providerOwned: true },
  };
}

function responsesMessage(text: string) {
  return { type: "message", providerPayload: { text } };
}

function responsesFunctionCall(callId: string) {
  return { type: "function_call", providerPayload: { callId } };
}

function toolResult(
  id: string,
): Extract<TranscriptMessage, { role: "tool" }>["content"][number] {
  return {
    type: "tool_result",
    toolCallId: id,
    content: `result for ${id}`,
    isError: false,
  };
}

async function seedSession(messages: TranscriptMessage[]): Promise<void> {
  await createStore().save(messages);
}

async function findSessionFile(): Promise<string> {
  const sessions = path.join(baseDirectory, "sessions");
  let workspaceDirectories: string[];
  try {
    workspaceDirectories = await readdir(sessions);
  } catch {
    throw new Error("No session directory.");
  }
  const workspaceDirectory = workspaceDirectories[0];
  if (workspaceDirectory === undefined)
    throw new Error("No workspace session directory.");
  const files = await readdir(path.join(sessions, workspaceDirectory));
  const file = files.find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("No session file.");
  return path.join(sessions, workspaceDirectory, file);
}

async function readSessionDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(await findSessionFile(), "utf8")) as Record<
    string,
    unknown
  >;
}

async function rewriteSession(
  mutate: (document: Record<string, unknown>) => void,
): Promise<void> {
  const file = await findSessionFile();
  const document = await readSessionDocument();
  mutate(document);
  await writeFile(file, `${JSON.stringify(document)}\n`, "utf8");
}
