import { describe, expect, it, vi } from "vitest";

import { PermissionGate } from "../src/permissions.js";

describe("PermissionGate", () => {
  it("allows ordinary workspace reads and writes by default", async () => {
    const gate = new PermissionGate("default");

    await expect(
      gate.authorize({ tool: "read_file", kind: "read", detail: "src/a.ts" }),
    ).resolves.toBeUndefined();
    await expect(
      gate.authorize({ tool: "edit_file", kind: "write", detail: "src/a.ts" }),
    ).resolves.toBeUndefined();
  });

  it("asks for commands and sensitive files", async () => {
    const approve = vi.fn(async () => true);
    const gate = new PermissionGate("default", approve);

    await gate.authorize({
      tool: "run_command",
      kind: "shell",
      detail: "npm test",
    });
    await gate.authorize({
      tool: "read_file",
      kind: "read",
      detail: ".env",
      sensitive: true,
    });

    expect(approve).toHaveBeenCalledTimes(2);
  });

  it("denies prompts when no interactive approver is available", async () => {
    const gate = new PermissionGate("default");

    await expect(
      gate.authorize({
        tool: "run_command",
        kind: "shell",
        detail: "npm test",
      }),
    ).rejects.toThrow("Permission denied");
  });

  it("enforces plan mode and bypass mode", async () => {
    const plan = new PermissionGate("plan");
    const bypass = new PermissionGate("bypass");

    await expect(
      plan.authorize({ tool: "write_file", kind: "write", detail: "a.ts" }),
    ).rejects.toThrow("disabled in plan mode");
    await expect(
      bypass.authorize({
        tool: "run_command",
        kind: "shell",
        detail: "anything",
      }),
    ).resolves.toBeUndefined();
  });
});
