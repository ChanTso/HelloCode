import { describe, expect, it } from "vitest";

import {
  quoteTerminalText,
  stripTerminalControls,
} from "../src/terminal-safety.js";

describe("stripTerminalControls", () => {
  it("removes ANSI, OSC, C0, and C1 terminal controls", () => {
    const unsafe =
      "before\u001B[31mred\u001B[0m\u001B]0;title\u0007after\u009B31m!\u0000";

    expect(stripTerminalControls(unsafe)).toBe("beforeredafter31m!");
  });

  it("keeps line breaks and tabs used by command output", () => {
    expect(stripTerminalControls("one\n\ttwo\r\n")).toBe("one\n\ttwo\n");
  });

  it("removes bidi overrides and quotes approval text unambiguously", () => {
    expect(quoteTerminalText("safe\rHIDDEN\n\u202Etxt")).toBe(
      '"safe\\nHIDDEN\\ntxt"',
    );
  });
});
