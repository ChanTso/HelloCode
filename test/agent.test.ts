import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "../src/agent.js";
import type { ModelClient, ModelRequest, ModelTurn } from "../src/model.js";
import { WorkspacePaths } from "../src/paths.js";
import { PermissionGate } from "../src/permissions.js";
import { ToolRegistry } from "../src/tools/index.js";
import {
  defineTool,
  objectInput,
  stringField,
  type ToolSpec,
} from "../src/tools/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent", () => {
  it("returns a streamed text response without invoking tools", async () => {
    const model = new FakeModel([textTurn("Done.")]);
    const events: string[] = [];
    const agent = await createAgent(model, [], (event) => {
      if (event.type === "text") events.push(event.delta);
    });

    const result = await agent.run("Do the work");

    expect(result.stop).toBe("complete");
    expect(result.text).toBe("Done.");
    expect(events.join("")).toBe("Done.");
    expect(agent.messages).toHaveLength(2);
  });

  it("executes tool calls and returns matching results to the model", async () => {
    const model = new FakeModel([
      toolTurn(toolCall("call-1", "echo", { value: "hello" })),
      textTurn("Finished."),
    ]);
    const tool = echoTool();
    const agent = await createAgent(model, [tool]);

    const result = await agent.run("Use the tool");

    expect(result.toolCalls).toBe(1);
    expect(model.requests).toHaveLength(2);
    const resultMessage = model.requests[1]?.messages[2];
    expect(resultMessage?.role).toBe("user");
    expect(resultMessage?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: "echo:hello",
      },
    ]);
  });

  it("executes multiple calls in order and reports tool failures", async () => {
    const order: string[] = [];
    const tool = echoTool(async (value) => {
      order.push(value);
      if (value === "bad") throw new Error("broken input");
      return `ok:${value}`;
    });
    const model = new FakeModel([
      toolTurn(
        toolCall("first", "echo", { value: "good" }),
        toolCall("second", "echo", { value: "bad" }),
      ),
      textTurn("Recovered."),
    ]);
    const agent = await createAgent(model, [tool]);

    await agent.run("Run both");

    expect(order).toEqual(["good", "bad"]);
    const resultMessage = model.requests[1]?.messages[2];
    expect(resultMessage?.content).toEqual([
      { type: "tool_result", tool_use_id: "first", content: "ok:good" },
      {
        type: "tool_result",
        tool_use_id: "second",
        content: "broken input",
        is_error: true,
      },
    ]);
  });

  it("turns unknown tools into recoverable error results", async () => {
    const model = new FakeModel([
      toolTurn(toolCall("missing", "not_registered", {})),
      textTurn("I used another approach."),
    ]);
    const agent = await createAgent(model, []);

    const result = await agent.run("Try something");

    expect(result.stop).toBe("complete");
    expect(model.requests[1]?.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "missing",
        content: "Unknown tool: not_registered",
        is_error: true,
      },
    ]);
  });

  it("does not execute tool blocks from a truncated response", async () => {
    let executed = false;
    const tool = echoTool(async () => {
      executed = true;
      return "unexpected";
    });
    const model = new FakeModel([
      {
        ...toolTurn(toolCall("partial", "echo", { value: "x" })),
        stopReason: "max_tokens",
      },
    ]);
    const agent = await createAgent(model, [tool]);

    const result = await agent.run("Do not run partial calls");

    expect(result.stop).toBe("max_tokens");
    expect(executed).toBe(false);
    expect(agent.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ tool_use_id: "partial", is_error: true }),
    ]);
  });

  it("stops with paired error results when the turn limit is reached", async () => {
    const model = new FakeModel([
      toolTurn(toolCall("limited", "echo", { value: "x" })),
    ]);
    const agent = await createAgent(model, [echoTool()], undefined, 1);

    const result = await agent.run("Loop forever");

    expect(result.stop).toBe("turn_limit");
    expect(result.toolCalls).toBe(0);
    expect(agent.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ tool_use_id: "limited", is_error: true }),
    ]);
  });

  it("stops cleanly when pause_turn reaches the configured limit", async () => {
    const model = new FakeModel([
      { ...textTurn("Still working"), stopReason: "pause_turn" },
    ]);
    const agent = await createAgent(model, [], undefined, 1);

    const result = await agent.run("Long task");

    expect(result.stop).toBe("turn_limit");
    expect(result.turns).toBe(1);
  });

  it("compacts once and retries a context-window stop", async () => {
    const model = new FakeModel([
      { ...textTurn(""), stopReason: "model_context_window_exceeded" },
      textTurn("Recovered after compaction."),
    ]);
    const agent = await createAgent(model, []);
    agent.restore([
      { role: "user", content: "Old request one" },
      { role: "assistant", content: "Old answer one" },
      { role: "user", content: "Old request two" },
      { role: "assistant", content: "Old answer two" },
    ]);

    const result = await agent.run("Current request");

    expect(result.stop).toBe("complete");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(
      "HelloCode compacted",
    );
  });

  it("preserves thinking blocks when returning assistant history", async () => {
    const thinking: Anthropic.ThinkingBlock = {
      type: "thinking",
      thinking: "private reasoning summary",
      signature: "signed",
    };
    const call = toolCall("think-call", "echo", { value: "x" });
    const model = new FakeModel([
      {
        content: [thinking, call],
        stopReason: "tool_use",
        usage: { input: 1, cacheWrite: 2, cacheRead: 3, output: 4 },
      },
      textTurn("Done"),
    ]);
    const agent = await createAgent(model, [echoTool()]);

    const result = await agent.run("Think and act");

    expect(model.requests[1]?.messages[1]?.content).toEqual([thinking, call]);
    expect(result.usage).toEqual({
      input: 11,
      cacheWrite: 2,
      cacheRead: 3,
      output: 8,
    });
  });

  it("propagates cancellation to the model request", async () => {
    const model: ModelClient = {
      createMessage(request) {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    };
    const agent = await createAgent(model, []);
    const controller = new AbortController();
    const running = agent.run("Wait", controller.signal);

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});

class FakeModel implements ModelClient {
  readonly requests: Array<{ messages: Anthropic.MessageParam[] }> = [];
  readonly #turns: ModelTurn[];

  constructor(turns: ModelTurn[]) {
    this.#turns = [...turns];
  }

  async createMessage(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push({ messages: structuredClone(request.messages) });
    const turn = this.#turns.shift();
    if (turn === undefined) throw new Error("Fake model ran out of responses.");
    for (const block of turn.content) {
      if (block.type === "text") request.onText?.(block.text);
    }
    return turn;
  }
}

async function createAgent(
  model: ModelClient,
  tools: ToolSpec[],
  onEvent?: ConstructorParameters<typeof Agent>[2]["onEvent"],
  maxTurns?: number,
): Promise<Agent> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hellocode-agent-"));
  temporaryDirectories.push(directory);
  const paths = await WorkspacePaths.create(directory);
  const registry = new ToolRegistry(tools, paths, new PermissionGate("bypass"));
  return new Agent(model, registry, {
    system: "test",
    ...(onEvent === undefined ? {} : { onEvent }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  });
}

function echoTool(
  handler: (value: string) => Promise<string> = async (value) =>
    `echo:${value}`,
) {
  return defineTool({
    definition: {
      name: "echo",
      description: "Echo a value.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    parse(input) {
      const object = objectInput(input, ["value"]);
      return { value: stringField(object, "value") };
    },
    permission: () => ({ tool: "echo", kind: "read", detail: "echo" }),
    execute: (input) => handler(input.value),
  });
}

function textTurn(text: string): ModelTurn {
  return {
    content: [{ type: "text", text, citations: null }],
    stopReason: "end_turn",
    usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 4 },
  };
}

function toolTurn(...calls: Anthropic.ToolUseBlock[]): ModelTurn {
  return {
    content: calls,
    stopReason: "tool_use",
    usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 4 },
  };
}

function toolCall(
  id: string,
  name: string,
  input: unknown,
): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}
