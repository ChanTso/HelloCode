import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  AnthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
  formatAnthropicError,
} from "../src/anthropic.js";
import type { ModelRequest, TranscriptMessage } from "../src/model.js";

describe("AnthropicModel", () => {
  it("streams text and retains raw thinking, text, and tool use for replay", async () => {
    const content: Anthropic.ContentBlock[] = [
      {
        type: "thinking",
        thinking: "Inspect the requested path.",
        signature: "opaque-signature",
      },
      { type: "text", text: "I'll inspect it.", citations: null },
      {
        type: "tool_use",
        id: "tool-1",
        name: "read_file",
        input: { path: "README.md" },
        caller: { type: "direct" },
      },
    ];
    const client = new FakeClient([
      {
        deltas: ["I'll ", "inspect it."],
        message: makeMessage(content, {
          stopReason: "tool_use",
          usage: {
            input: 80,
            cacheWrite: 20,
            cacheRead: 30,
            output: 15,
          },
        }),
      },
    ]);
    const deltas: string[] = [];
    const controller = new AbortController();
    const model = new AnthropicModel({
      apiKey: "test-key",
      baseUrl: "https://proxy.example/v1",
      client,
      maxTokens: 456,
      model: "claude-test",
    });

    const turn = await model.createMessage({
      messages: [{ role: "user", content: "Inspect the project" }],
      system: "Act as a coding agent.",
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          strict: true,
        },
      ],
      onText: (delta) => deltas.push(delta),
      signal: controller.signal,
    });

    expect(deltas).toEqual(["I'll ", "inspect it."]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.options?.signal).toBe(controller.signal);
    expect(client.calls[0]?.body).toEqual({
      max_tokens: 456,
      messages: [{ role: "user", content: "Inspect the project" }],
      model: "claude-test",
      system: "Act as a coding agent.",
      tools: [
        {
          name: "read_file",
          description: "Read a file.",
          strict: true,
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    });
    expect(turn).toMatchObject({
      stopReason: "tool_use",
      usage: { input: 80, cacheWrite: 20, cacheRead: 30, output: 15 },
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect it." },
          {
            type: "tool_call",
            id: "tool-1",
            name: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
    });
    expect(turn.message.replay).toEqual({
      format: "anthropic-content-v1",
      scope: expect.stringMatching(/^anthropic:claude-test:/),
      items: content,
    });
  });

  it("replays same-scope output unchanged before an error tool result", async () => {
    const rawContent: Anthropic.ContentBlock[] = [
      {
        type: "thinking",
        thinking: "Need the file.",
        signature: "opaque-signature",
      },
      {
        type: "tool_use",
        id: "tool-1",
        name: "read_file",
        input: { path: "missing.txt" },
        caller: { type: "direct" },
      },
    ];
    const client = new FakeClient([
      { message: makeMessage(rawContent, { stopReason: "tool_use" }) },
      {
        message: makeMessage(
          [{ type: "text", text: "The file is unavailable.", citations: null }],
          { stopReason: "end_turn" },
        ),
      },
    ]);
    const model = new AnthropicModel({ apiKey: "test-key", client });
    const first = await model.createMessage(
      request([{ role: "user", content: "Read the file" }]),
    );

    await model.createMessage(
      request([
        { role: "user", content: "Read the file" },
        first.message,
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-1",
              content: "file not found",
              isError: true,
            },
          ],
        },
      ]),
    );

    expect(client.calls[1]?.body.messages).toEqual([
      { role: "user", content: "Read the file" },
      { role: "assistant", content: rawContent },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "file not found",
            is_error: true,
          },
        ],
      },
    ]);
  });

  it("uses portable assistant content when replay belongs to another scope", async () => {
    const client = new FakeClient([{ message: makeMessage([]) }]);
    const model = new AnthropicModel({ apiKey: "test-key", client });
    const messages: TranscriptMessage[] = [
      { role: "user", content: "Continue" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_call",
            id: "portable-call",
            name: "read_file",
            input: { path: "package.json" },
          },
        ],
        replay: {
          format: "anthropic-content-v1",
          scope: "anthropic:different-model:default",
          items: [
            {
              type: "thinking",
              thinking: "Endpoint-specific reasoning",
              signature: "opaque",
            },
          ],
        },
      },
    ];

    await model.createMessage(request(messages));

    expect(client.calls[0]?.body.messages).toEqual([
      { role: "user", content: "Continue" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_use",
            id: "portable-call",
            name: "read_file",
            input: { path: "package.json" },
          },
        ],
      },
    ]);
  });

  it.each([
    ["end_turn", "complete"],
    ["stop_sequence", "complete"],
    ["tool_use", "tool_use"],
    ["pause_turn", "pause"],
    ["max_tokens", "max_tokens"],
    ["model_context_window_exceeded", "context_limit"],
    ["refusal", "refusal"],
  ] as const)("maps %s to %s", async (reason, expectedStop) => {
    const model = modelFor(makeMessage([], { stopReason: reason }));

    const turn = await model.createMessage(request([]));

    expect(turn.stopReason).toBe(expectedStop);
  });

  it("rejects a response without a stop reason", async () => {
    const model = modelFor(makeMessage([], { stopReason: null }));

    await expect(model.createMessage(request([]))).rejects.toThrow(
      "Anthropic returned a response without a stop reason.",
    );
  });
});

describe("formatAnthropicError", () => {
  it("formats cancellation without exposing SDK details", () => {
    expect(formatAnthropicError(new Anthropic.APIUserAbortError())).toBe(
      "Request cancelled.",
    );
  });

  it("reports safe API metadata without returning the server message", () => {
    const error = Anthropic.APIError.generate(
      429,
      {
        error: {
          message: "secret upstream response",
          type: "rate_limit_error",
        },
      },
      "secret outer message",
      new Headers({ "request-id": "req_safe" }),
    );

    const formatted = formatAnthropicError(error);

    expect(formatted).toBe(
      "Anthropic request failed (HTTP 429, rate_limit_error, request req_safe).",
    );
    expect(formatted).not.toContain("secret");
  });

  it("drops untrusted or oversized API metadata", () => {
    const error = Anthropic.APIError.generate(
      500,
      {
        error: {
          message: "private response",
          type: "private\nmetadata",
        },
      },
      "private outer message",
      new Headers({ "request-id": `req_${"x".repeat(100)}` }),
    );

    expect(formatAnthropicError(error)).toBe(
      "Anthropic request failed (HTTP 500).",
    );
  });

  it("turns other SDK errors into a generic safe message", () => {
    expect(
      formatAnthropicError(
        new Anthropic.AnthropicError("secret internal SDK details"),
      ),
    ).toBe("Anthropic request failed.");
  });

  it("ignores errors it does not own", () => {
    expect(formatAnthropicError(new Error("ordinary"))).toBeUndefined();
  });
});

interface QueuedMessage {
  deltas?: string[];
  message: Anthropic.Message;
}

interface StreamCall {
  body: Anthropic.MessageStreamParams;
  options?: { signal?: AbortSignal };
}

class FakeClient {
  readonly calls: StreamCall[] = [];
  readonly #queue: QueuedMessage[];

  constructor(queue: QueuedMessage[]) {
    this.#queue = [...queue];
  }

  readonly messages = {
    stream: (
      body: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ) => {
      const queued = this.#queue.shift();
      if (queued === undefined) throw new Error("No fake message queued.");
      this.calls.push({ body, ...(options === undefined ? {} : { options }) });
      return {
        on: (event: "text", listener: (delta: string) => void): void => {
          if (event === "text") {
            for (const delta of queued.deltas ?? []) listener(delta);
          }
        },
        finalMessage: async (): Promise<Anthropic.Message> => queued.message,
      };
    },
  };
}

function modelFor(message: Anthropic.Message): AnthropicModel {
  return new AnthropicModel({
    apiKey: "test-key",
    client: new FakeClient([{ message }]),
  });
}

function request(messages: TranscriptMessage[]): ModelRequest {
  return {
    messages,
    system: "system",
    tools: [],
  };
}

function makeMessage(
  content: Anthropic.ContentBlock[],
  options: {
    stopReason?: Anthropic.StopReason | null;
    usage?: {
      cacheRead: number;
      cacheWrite: number;
      input: number;
      output: number;
    };
  } = {},
): Anthropic.Message {
  const usage = options.usage ?? {
    cacheRead: 0,
    cacheWrite: 0,
    input: 1,
    output: 1,
  };
  return {
    id: "msg-test",
    container: null,
    content,
    model: DEFAULT_ANTHROPIC_MODEL,
    role: "assistant",
    stop_details: null,
    stop_reason:
      options.stopReason === undefined ? "end_turn" : options.stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: usage.cacheWrite,
      cache_read_input_tokens: usage.cacheRead,
      inference_geo: null,
      input_tokens: usage.input,
      output_tokens: usage.output,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}
