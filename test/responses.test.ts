import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import type { ModelRequest, TranscriptMessage } from "../src/model.js";
import {
  DEFAULT_OPENAI_MODEL,
  formatOpenAIError,
  OpenAIResponsesModel,
} from "../src/responses.js";

describe("OpenAIResponsesModel", () => {
  it("streams text and normalizes Responses output without SDK parse fields", async () => {
    const client = new FakeClient([
      {
        deltas: ["Hel", "lo"],
        response: makeResponse(
          [
            reasoningItem(),
            parsedMessage("Hello"),
            parsedFunctionCall("item-1", "call-1", "read_file", {
              path: "README.md",
            }),
          ],
          {
            usage: {
              input_tokens: 100,
              input_tokens_details: {
                cached_tokens: 30,
                cache_write_tokens: 10,
              },
              output_tokens: 25,
              output_tokens_details: { reasoning_tokens: 7 },
              total_tokens: 125,
            },
          },
        ),
      },
    ]);
    const deltas: string[] = [];
    const controller = new AbortController();
    const model = new OpenAIResponsesModel({
      apiKey: "test-key",
      baseUrl: "https://proxy.example/v1",
      client,
      maxTokens: 321,
      model: "gpt-5.6-luna",
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

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.options?.signal).toBe(controller.signal);
    expect(client.calls[0]?.body).toMatchObject({
      include: ["reasoning.encrypted_content"],
      input: [{ role: "user", content: "Inspect the project" }],
      instructions: "Act as a coding agent.",
      max_output_tokens: 321,
      model: "gpt-5.6-luna",
      store: false,
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file.",
          strict: false,
        },
      ],
    });
    expect(client.calls[0]?.body.previous_response_id).toBeUndefined();
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.message.content).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "tool_call",
        id: "call-1",
        name: "read_file",
        input: { path: "README.md" },
      },
    ]);
    expect(turn.usage).toEqual({
      input: 60,
      cacheRead: 30,
      cacheWrite: 10,
      output: 25,
    });

    const replay = turn.message.replay;
    expect(replay?.format).toBe("responses-output-v1");
    expect(replay?.items[0]).toEqual(reasoningItem());
    expect(JSON.stringify(replay?.items)).not.toContain("parsed");
    expect(replay?.items[2]).toMatchObject({
      type: "function_call",
      id: "item-1",
      call_id: "call-1",
    });
  });

  it("sends full local history with replay items before matching tool outputs", async () => {
    const firstResponse = makeResponse([
      reasoningItem(),
      parsedFunctionCall("item-1", "call-1", "read_file", {
        path: "README.md",
      }),
    ]);
    const client = new FakeClient([
      { response: firstResponse },
      { response: makeResponse([parsedMessage("Done")]) },
    ]);
    const model = new OpenAIResponsesModel({
      apiKey: "test-key",
      client,
      model: "gpt-5.6-luna",
    });
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
              toolCallId: "call-1",
              content: "permission denied",
              isError: true,
            },
          ],
        },
        { role: "user", content: "Summarize it" },
      ]),
    );

    expect(client.calls[1]?.body.input).toEqual([
      { role: "user", content: "Read the file" },
      reasoningItem(),
      expect.objectContaining({
        type: "function_call",
        id: "item-1",
        call_id: "call-1",
      }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Tool error: permission denied",
      },
      { role: "user", content: "Summarize it" },
    ]);
    expect(client.calls[1]?.body.store).toBe(false);
  });

  it("falls back to portable assistant content when replay scope differs", async () => {
    const client = new FakeClient([{ response: makeResponse([]) }]);
    const model = new OpenAIResponsesModel({
      apiKey: "test-key",
      client,
      model: DEFAULT_OPENAI_MODEL,
    });
    const messages: TranscriptMessage[] = [
      { role: "user", content: "Start" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          {
            type: "tool_call",
            id: "call-portable",
            name: "read_file",
            input: { path: "package.json" },
          },
        ],
        replay: {
          format: "responses-output-v1",
          scope: "openai:other-model:default",
          items: [{ type: "reasoning" }],
        },
      },
    ];

    await model.createMessage(request(messages));

    expect(client.calls[0]?.body.input).toEqual([
      { role: "user", content: "Start" },
      { role: "assistant", content: "Checking." },
      {
        type: "function_call",
        call_id: "call-portable",
        name: "read_file",
        arguments: JSON.stringify({ path: "package.json" }),
      },
    ]);
  });

  it.each([
    ["max_output_tokens", "max_tokens"],
    ["content_filter", "refusal"],
    [undefined, "pause"],
  ] as const)(
    "maps incomplete reason %s to %s",
    async (reason, expectedStop) => {
      const response = makeResponse([], {
        status: "incomplete",
        incomplete_details: reason === undefined ? {} : { reason },
      });
      const model = modelFor(response);

      const turn = await model.createMessage(request([]));

      expect(turn.stopReason).toBe(expectedStop);
    },
  );

  it.each(["in_progress", "queued"] as const)(
    "maps %s responses to a resumable pause",
    async (status) => {
      const model = modelFor(makeResponse([], { status }));

      const turn = await model.createMessage(request([]));

      expect(turn.stopReason).toBe("pause");
    },
  );

  it("maps a completed refusal and preserves its explanation", async () => {
    const refusal = {
      type: "message",
      id: "msg-refusal",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "I cannot help with that." }],
    } as const satisfies ResponseOutputMessage;
    const model = modelFor(makeResponse([refusal]));

    const turn = await model.createMessage(request([]));

    expect(turn.stopReason).toBe("refusal");
    expect(turn.message.content).toEqual([
      { type: "text", text: "I cannot help with that." },
    ]);
  });

  it("rejects failed, cancelled, and unsupported outputs clearly", async () => {
    await expect(
      modelFor(
        makeResponse([], {
          status: "failed",
          error: { code: "invalid_prompt", message: "private details" },
        }),
      ).createMessage(request([])),
    ).rejects.toThrow("OpenAI response failed (invalid_prompt).");

    await expect(
      modelFor(
        makeResponse([], { status: "failed", error: null }),
      ).createMessage(request([])),
    ).rejects.toThrow("OpenAI response failed.");

    const missingError = makeResponse([], { status: "failed" });
    Reflect.deleteProperty(missingError, "error");
    await expect(
      modelFor(missingError).createMessage(request([])),
    ).rejects.toThrow("OpenAI response failed.");

    const unsafeFailure = makeResponse([], {
      status: "failed",
      error: {
        code: "invalid_prompt",
        message: "private response",
      },
    });
    Reflect.set(unsafeFailure.error ?? {}, "code", "private\nmetadata");
    await expect(
      modelFor(unsafeFailure).createMessage(request([])),
    ).rejects.toThrow("OpenAI response failed.");

    await expect(
      modelFor(makeResponse([], { status: "cancelled" })).createMessage(
        request([]),
      ),
    ).rejects.toThrow("OpenAI response was cancelled.");

    const unsupported = {
      type: "file_search_call",
    } as unknown as ResponseOutputItem;
    await expect(
      modelFor(makeResponse([unsupported])).createMessage(request([])),
    ).rejects.toThrow("OpenAI returned an unsupported output item.");
  });

  it("turns malformed function arguments into a recoverable tool input", async () => {
    const malformed = parsedFunctionCall(
      "item-bad",
      "call-bad",
      "read_file",
      {},
    );
    malformed.arguments = "{";
    const model = modelFor(makeResponse([malformed]));

    const turn = await model.createMessage(request([]));

    expect(turn.stopReason).toBe("tool_use");
    expect(turn.message.content).toEqual([
      {
        type: "tool_call",
        id: "call-bad",
        name: "read_file",
        input: "Invalid JSON tool arguments.",
      },
    ]);
  });

  it("rejects unsupported persisted replay items before sending them", async () => {
    const client = new FakeClient([{ response: makeResponse([]) }]);
    const model = new OpenAIResponsesModel({
      apiKey: "test-key",
      client,
      model: DEFAULT_OPENAI_MODEL,
    });

    await expect(
      model.createMessage(
        request([
          {
            role: "assistant",
            content: [],
            replay: {
              format: "responses-output-v1",
              scope: `openai:${DEFAULT_OPENAI_MODEL}:default`,
              items: [{ type: "web_search_call" }],
            },
          },
        ]),
      ),
    ).rejects.toThrow(
      "Stored OpenAI replay contains an unsupported output item.",
    );
    expect(client.calls).toHaveLength(0);
  });

  it("returns zero usage when a compatible endpoint omits usage", async () => {
    const response = makeResponse([]);
    delete response.usage;
    const model = modelFor(response);

    const turn = await model.createMessage(request([]));

    expect(turn.usage).toEqual({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
    });
  });
});

describe("formatOpenAIError", () => {
  it("formats cancellation without exposing SDK details", () => {
    expect(formatOpenAIError(new OpenAI.APIUserAbortError())).toBe(
      "Request cancelled.",
    );
  });

  it("reports safe API metadata without returning the server message", () => {
    const error = OpenAI.APIError.generate(
      429,
      {
        error: {
          message: "secret upstream response",
          type: "rate_limit",
          code: "quota_exceeded",
        },
      },
      "secret outer message",
      new Headers({ "x-request-id": "req_safe" }),
    );

    const formatted = formatOpenAIError(error);

    expect(formatted).toBe(
      "OpenAI request failed (HTTP 429, quota_exceeded, rate_limit, request req_safe).",
    );
    expect(formatted).not.toContain("secret");
  });

  it("drops untrusted or oversized API metadata", () => {
    const error = OpenAI.APIError.generate(
      500,
      {
        error: {
          message: "private response",
          type: "private\nmetadata",
          code: `private_${"x".repeat(100)}`,
        },
      },
      "private outer message",
      new Headers({ "x-request-id": "private metadata" }),
    );

    expect(formatOpenAIError(error)).toBe("OpenAI request failed (HTTP 500).");
  });

  it("hides messages from generic SDK stream and parser errors", () => {
    const formatted = formatOpenAIError(
      new OpenAI.OpenAIError("secret parser state"),
    );

    expect(formatted).toBe("OpenAI request failed.");
    expect(formatted).not.toContain("secret");
  });

  it("ignores errors it does not own", () => {
    expect(formatOpenAIError(new Error("ordinary"))).toBeUndefined();
  });
});

interface QueuedResponse {
  deltas?: string[];
  response: Response;
}

interface StreamCall {
  body: ResponseCreateParamsBase;
  options?: { signal?: AbortSignal };
}

class FakeClient {
  readonly calls: StreamCall[] = [];
  readonly #responses: QueuedResponse[];

  readonly responses = {
    stream: (
      body: ResponseCreateParamsBase,
      options?: { signal?: AbortSignal },
    ) => {
      const next = this.#responses.shift();
      if (next === undefined) throw new Error("No fake response queued.");
      this.calls.push(options === undefined ? { body } : { body, options });
      return new FakeStream(next);
    },
  };

  constructor(responses: QueuedResponse[]) {
    this.#responses = [...responses];
  }
}

class FakeStream {
  readonly #queued: QueuedResponse;
  #textListener: ((event: { delta: string }) => void) | undefined;

  constructor(queued: QueuedResponse) {
    this.#queued = queued;
  }

  on(
    _event: "response.output_text.delta",
    listener: (event: { delta: string }) => void,
  ): void {
    this.#textListener = listener;
  }

  async finalResponse(): Promise<Response> {
    for (const delta of this.#queued.deltas ?? []) {
      this.#textListener?.({ delta });
    }
    return this.#queued.response;
  }
}

function modelFor(response: Response): OpenAIResponsesModel {
  return new OpenAIResponsesModel({
    apiKey: "test-key",
    client: new FakeClient([{ response }]),
    model: DEFAULT_OPENAI_MODEL,
  });
}

function request(messages: TranscriptMessage[]): ModelRequest {
  return {
    messages,
    system: "Test system prompt.",
    tools: [],
  };
}

function reasoningItem(): ResponseReasoningItem {
  return {
    type: "reasoning",
    id: "reasoning-1",
    summary: [{ type: "summary_text", text: "Inspect the requested file." }],
    content: [{ type: "reasoning_text", text: "Private reasoning." }],
    encrypted_content: "encrypted-reasoning",
    status: "completed",
  };
}

function parsedMessage(text: string): ResponseOutputItem {
  return {
    type: "message",
    id: "message-1",
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
        parsed: { injectedBySdk: true },
      },
    ],
  } as unknown as ResponseOutputItem;
}

function parsedFunctionCall(
  id: string,
  callId: string,
  name: string,
  input: unknown,
): ResponseFunctionToolCall & { parsed_arguments: unknown } {
  return {
    type: "function_call",
    id,
    call_id: callId,
    name,
    arguments: JSON.stringify(input),
    parsed_arguments: input,
    status: "completed",
  };
}

function makeResponse(
  output: ResponseOutputItem[],
  overrides: Partial<Response> = {},
): Response {
  return {
    id: "response-1",
    created_at: 0,
    object: "response",
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "gpt-5.6-luna",
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    status: "completed",
    usage: {
      input_tokens: 0,
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
    ...overrides,
  };
}
