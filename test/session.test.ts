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

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionStore, stripThinkingBlocks } from "../src/session.js";

let baseDirectory: string;
let workspace: string;

beforeEach(async () => {
  baseDirectory = await mkdtemp(path.join(os.tmpdir(), "hellocode-session-"));
  workspace = path.join(baseDirectory, "workspace");
});

afterEach(async () => {
  await rm(baseDirectory, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("saves and restores workspace-scoped conversation history", async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const store = createStore();
    await store.save(messages);

    const loaded = await createStore().loadLatest();

    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.model).toBe("test-model");
    expect(loaded).not.toHaveProperty("id");
  });

  it("writes session files with private permissions", async () => {
    await createStore().save([{ role: "user", content: "private" }]);
    const file = await findSessionFile(baseDirectory);
    const mode = (await stat(file)).mode & 0o777;

    if (process.platform !== "win32") expect(mode).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toContain("ANTHROPIC_API_KEY");
  });

  it("reports a corrupt latest session instead of silently ignoring it", async () => {
    await createStore().save([{ role: "user", content: "valid" }]);
    const file = await findSessionFile(baseDirectory);
    await writeFile(file, "{broken", "utf8");

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Could not read latest HelloCode session",
    );
  });

  it("can persist an intentionally cleared session", async () => {
    const store = createStore();
    await store.save([]);

    const loaded = await createStore().loadLatest();

    expect(loaded?.messages).toEqual([]);
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
    ["model", (document: Record<string, unknown>) => (document.model = "")],
  ])("rejects an invalid %s", async (_label, mutate) => {
    await createStore().save([{ role: "user", content: "hello" }]);
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
            { type: "tool_result", tool_use_id: "call-1", content: "no" },
          ],
        },
      ],
    ],
    [
      "thinking block on a user message",
      [
        {
          role: "user",
          content: [{ type: "thinking", thinking: "hmm", signature: "signed" }],
        },
      ],
    ],
    [
      "malformed tool call",
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "read_file" }],
        },
      ],
    ],
    [
      "assistant-first transcript",
      [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
    ],
    ["empty content array", [{ role: "user", content: [] }]],
  ])("rejects a %s", async (_label, messages) => {
    await saveRawMessages(messages);

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Invalid or unsupported HelloCode session",
    );
  });

  it.each([
    [
      "orphan tool result",
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
      "dangling tool call",
      [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [toolCall("call-1")],
        },
      ],
    ],
    [
      "natural user message after a tool call",
      [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [toolCall("call-1")],
        },
        { role: "user", content: "skip that" },
      ],
    ],
    [
      "mismatched tool result",
      [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [toolCall("call-1")],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-2", content: "done" },
          ],
        },
      ],
    ],
    [
      "duplicate tool result",
      [
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: [toolCall("call-1")],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "done" },
            { type: "tool_result", tool_use_id: "call-1", content: "again" },
          ],
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
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "done" },
          ],
        },
      ],
    ],
  ])("rejects a conversation with a %s", async (_label, messages) => {
    await saveRawMessages(messages);

    await expect(createStore().loadLatest()).rejects.toThrow(
      "Invalid or unsupported HelloCode session",
    );
  });

  it("restores complete multi-tool pairs and signed thinking blocks", async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "inspect both" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I will inspect.",
            signature: "signed",
          },
          toolCall("call-1"),
          toolCall("call-2"),
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-2", content: "two" },
          { type: "tool_result", tool_use_id: "call-1", content: "one" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    await createStore().save(messages);

    await expect(createStore().loadLatest()).resolves.toMatchObject({
      messages,
      model: "test-model",
    });
  });
});

describe("stripThinkingBlocks", () => {
  it("removes model-bound thinking without mutating other history", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "continue" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "signed" },
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "visible" },
          toolCall("call-1"),
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "done" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "only", signature: "signed-again" },
        ],
      },
    ];

    const stripped = stripThinkingBlocks(messages);

    expect(stripped[1]?.content).toEqual([
      { type: "text", text: "visible" },
      toolCall("call-1"),
    ]);
    expect(stripped[3]?.content).toEqual([
      {
        type: "text",
        text: "[Prior model reasoning omitted after switching models.]",
      },
    ]);
    expect(messages[1]?.content).toHaveLength(4);
  });
});

function createStore(): SessionStore {
  return new SessionStore({
    baseDirectory,
    workspace,
    model: "test-model",
  });
}

async function findSessionFile(directory: string): Promise<string> {
  const sessions = path.join(directory, "sessions");
  const workspaceDirectories = await readdir(sessions);
  const workspaceDirectory = workspaceDirectories[0];
  if (workspaceDirectory === undefined)
    throw new Error("No workspace session directory.");
  const files = await readdir(path.join(sessions, workspaceDirectory));
  const file = files.find((name) => name.endsWith(".json"));
  if (file === undefined) throw new Error("No session file.");
  return path.join(sessions, workspaceDirectory, file);
}

function toolCall(id: string): Anthropic.ToolUseBlockParam {
  return { type: "tool_use", id, name: "read_file", input: { path: id } };
}

async function saveRawMessages(messages: unknown[]): Promise<void> {
  await createStore().save(messages as Anthropic.MessageParam[]);
}

async function rewriteSession(
  mutate: (document: Record<string, unknown>) => void,
): Promise<void> {
  const file = await findSessionFile(baseDirectory);
  const document = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(document);
  await writeFile(file, `${JSON.stringify(document)}\n`, "utf8");
}
