import { describe, expect, it } from "vitest";

import { ContextManager } from "../src/context.js";
import type { TranscriptMessage } from "../src/model.js";

describe("ContextManager", () => {
  it("shortens old tool results without breaking tool call/result pairs", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "Inspect the file" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "read-1",
            name: "read_file",
            input: { path: "large.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "read-1",
            content: "x".repeat(5000),
            isError: false,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I inspected it." }],
      },
    ];

    const result = new ContextManager(20_000).compact(messages, true);

    expect(result.changed).toBe(true);
    expect(result.shortenedResults).toBe(1);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain('"id":"read-1"');
    expect(serialized).toContain('"toolCallId":"read-1"');
    expect(serialized).toContain("Earlier tool result compacted");
  });

  it("drops complete old turns and keeps a compact note with the latest turn", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "First request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
      },
      { role: "user", content: "Second request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Second answer" }],
      },
      { role: "user", content: "Latest request" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Latest answer" }],
      },
    ];

    const result = new ContextManager(20_000).compact(messages, true);

    expect(result.removedTurns).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.content).toContain(
      "HelloCode compacted 2 earlier",
    );
    expect(result.messages[0]?.content).toContain("Latest request");
  });

  it("does nothing below budget during automatic compaction", () => {
    const messages: TranscriptMessage[] = [{ role: "user", content: "small" }];

    const result = new ContextManager(20_000).compact(messages, false);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});
