import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspacePaths } from "../src/paths.js";
import { PermissionGate, type PermissionRequest } from "../src/permissions.js";
import { createTools, ToolRegistry } from "../src/tools/index.js";
import { defineTool, objectInput } from "../src/tools/types.js";

let directory: string;
let registry: ToolRegistry;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hellocode-tools-"));
  const paths = await WorkspacePaths.create(directory);
  registry = new ToolRegistry(
    createTools(),
    paths,
    new PermissionGate("bypass"),
  );
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("file tools", () => {
  it("creates, reads, and protects files from accidental overwrite", async () => {
    const created = await registry.execute("write_file", {
      path: "src/example.ts",
      content: "one\ntwo\nthree\n",
    });
    const read = await registry.execute("read_file", {
      path: "src/example.ts",
      offset: 2,
      limit: 2,
    });
    const overwrite = await registry.execute("write_file", {
      path: "src/example.ts",
      content: "lost",
    });

    expect(created.isError).toBe(false);
    expect(read.content).toContain("     2\ttwo");
    expect(read.content).toContain("lines 2-3 of 4");
    expect(overwrite).toMatchObject({ isError: true });
    await expect(
      readFile(path.join(directory, "src/example.ts"), "utf8"),
    ).resolves.toBe("one\ntwo\nthree\n");
  });

  it("creates sensitive files without group or world permissions", async () => {
    if (process.platform === "win32") return;

    const result = await registry.execute("write_file", {
      path: ".env",
      content: "SECRET=value\n",
    });

    expect(result.isError).toBe(false);
    expect((await stat(path.join(directory, ".env"))).mode & 0o077).toBe(0);
  });

  it("requires a unique edit unless replace_all is explicit", async () => {
    await writeFile(path.join(directory, "values.txt"), "same\nsame\n");

    const ambiguous = await registry.execute("edit_file", {
      path: "values.txt",
      old_text: "same",
      new_text: "new",
    });
    const replaced = await registry.execute("edit_file", {
      path: "values.txt",
      old_text: "same",
      new_text: "new",
      replace_all: true,
    });

    expect(ambiguous.content).toContain("occurs 2 times");
    expect(ambiguous.isError).toBe(true);
    expect(replaced.isError).toBe(false);
    await expect(
      readFile(path.join(directory, "values.txt"), "utf8"),
    ).resolves.toBe("new\nnew\n");
  });

  it("treats replacement metacharacters as literal text", async () => {
    await writeFile(path.join(directory, "literal.txt"), "prefixZsuffix");

    const result = await registry.execute("edit_file", {
      path: "literal.txt",
      old_text: "Z",
      new_text: "$`$&$'$$",
    });

    expect(result.isError).toBe(false);
    await expect(
      readFile(path.join(directory, "literal.txt"), "utf8"),
    ).resolves.toBe("prefix$`$&$'$$suffix");
  });

  it("rejects edits that would expand beyond the file-size limit", async () => {
    await writeFile(path.join(directory, "expand.txt"), "x".repeat(100));

    const result = await registry.execute("edit_file", {
      path: "expand.txt",
      old_text: "x",
      new_text: "y".repeat(100_000),
      replace_all: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("limit 8388608");
    await expect(
      readFile(path.join(directory, "expand.txt"), "utf8"),
    ).resolves.toBe("x".repeat(100));
  });

  it("lists files and searches text while skipping generated directories", async () => {
    await registry.execute("write_file", {
      path: "src/a.ts",
      content: "const needle = 1;\n",
    });
    await registry.execute("write_file", {
      path: "src/b.js",
      content: "const other = 2;\n",
    });
    await registry.execute("write_file", {
      path: "node_modules/hidden.ts",
      content: "needle\n",
    });
    await registry.execute("write_file", {
      path: "packages/a/node_modules/nested.ts",
      content: "needle\n",
    });

    const listed = await registry.execute("list_files", {
      path: ".",
      pattern: "**/*.ts",
    });
    const searched = await registry.execute("search_text", {
      query: "needle",
      path: ".",
      pattern: "**/*.ts",
    });

    expect(listed.content).toContain("src/a.ts");
    expect(listed.content).not.toContain("node_modules");
    expect(searched.content).toContain("src/a.ts:1:const needle = 1;");
    expect(searched.content).not.toContain("node_modules");
  });

  it("filters sensitive files from broad listing and search", async () => {
    await writeFile(path.join(directory, "safe.txt"), "needle\n");
    await writeFile(path.join(directory, "credentials"), "needle secret\n");
    await writeFile(path.join(directory, "CREDENTIALS"), "needle upper\n");
    await writeFile(path.join(directory, "CLIENT.PEM"), "needle key\n");
    await writeFile(path.join(directory, "ID_ED25519"), "needle ssh\n");
    await writeFile(path.join(directory, ".env"), "needle hidden\n");

    const listed = await registry.execute("list_files", {
      path: ".",
      pattern: "**/*",
    });
    const searched = await registry.execute("search_text", {
      path: ".",
      query: "needle",
    });

    expect(listed.content).toContain("safe.txt");
    expect(listed.content).not.toContain("credentials");
    expect(listed.content).not.toContain("CREDENTIALS");
    expect(listed.content).not.toContain("CLIENT.PEM");
    expect(listed.content).not.toContain("ID_ED25519");
    expect(listed.content).not.toContain(".env");
    expect(searched.content).toContain("safe.txt");
    expect(searched.content).not.toContain("credentials");
    expect(searched.content).not.toContain("CREDENTIALS");
    expect(searched.content).not.toContain("CLIENT.PEM");
    expect(searched.content).not.toContain("ID_ED25519");
    expect(searched.content).not.toContain(".env");
  });

  it("authorizes the canonical target of a sensitive symlink", async () => {
    if (process.platform === "win32") return;
    await writeFile(path.join(directory, ".env"), "SECRET=value\n");
    await symlink(".env", path.join(directory, "notes.txt"));
    const approve = vi.fn(async (_request: PermissionRequest) => false);
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );

    const result = await guarded.execute("read_file", { path: "notes.txt" });

    expect(result.isError).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      detail: ".env",
      sensitive: true,
    });
  });

  it("rejects a file swapped after authorization", async () => {
    if (process.platform === "win32") return;
    await writeFile(path.join(directory, "safe.pem"), "public\n");
    await writeFile(path.join(directory, ".env"), "SECRET=value\n");
    const approve = vi.fn(async (_request: PermissionRequest) => {
      await rm(path.join(directory, "safe.pem"));
      await symlink(".env", path.join(directory, "safe.pem"));
      return true;
    });
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );

    const result = await guarded.execute("read_file", { path: "safe.pem" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Path changed after authorization");
    expect(result.content).not.toContain("SECRET=value");
  });

  it("rejects a write parent swapped after authorization", async () => {
    if (process.platform === "win32") return;
    const outside = await mkdtemp(path.join(os.tmpdir(), "hellocode-outside-"));
    await mkdir(path.join(directory, "safe"));
    const approve = vi.fn(async (_request: PermissionRequest) => {
      await rename(
        path.join(directory, "safe"),
        path.join(directory, "safe-original"),
      );
      await symlink(outside, path.join(directory, "safe"));
      return true;
    });
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );

    try {
      const result = await guarded.execute("write_file", {
        path: "safe/key.pem",
        content: "secret",
      });

      expect(result.isError).toBe(true);
      await expect(
        readFile(path.join(outside, "key.pem"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not commit a write cancelled during authorization", async () => {
    const controller = new AbortController();
    const approve = vi.fn(async (_request: PermissionRequest) => {
      controller.abort();
      return true;
    });
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );

    await expect(
      guarded.execute(
        "write_file",
        { path: "cancelled.pem", content: "secret" },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      readFile(path.join(directory, "cancelled.pem"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires approval when searching an explicit SSH directory", async () => {
    await mkdir(path.join(directory, ".ssh"));
    await writeFile(path.join(directory, ".ssh", "id_ed25519"), "private");
    const approve = vi.fn(async (_request: PermissionRequest) => false);
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );

    const result = await guarded.execute("search_text", {
      path: ".ssh",
      query: "private",
    });

    expect(result.isError).toBe(true);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ sensitive: true });
  });

  it("keeps sensitivity when the workspace root is an SSH directory", async () => {
    const sshRoot = path.join(directory, ".ssh");
    await mkdir(sshRoot);
    await writeFile(path.join(sshRoot, "config"), "Host example\n");
    const approve = vi.fn(async (_request: PermissionRequest) => false);
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(sshRoot),
      new PermissionGate("default", approve),
    );

    const result = await guarded.execute("read_file", { path: "config" });

    expect(result.isError).toBe(true);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ sensitive: true });
  });

  it("includes a sensitive search pattern in the approval detail", async () => {
    const approve = vi.fn(async (_request: PermissionRequest) => false);
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );

    await guarded.execute("search_text", {
      path: ".",
      query: "token",
      pattern: "**/*.key",
    });

    expect(approve.mock.calls[0]?.[0].detail).toContain("**/*.key");
  });

  it("matches adversarial glob patterns without regex backtracking", async () => {
    await writeFile(path.join(directory, "a".repeat(32)), "content");
    const started = performance.now();

    const result = await registry.execute("list_files", {
      path: ".",
      pattern: `${"*a".repeat(15)}b`,
    });

    expect(result.content).toBe("No matching files.");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("runs ripgrep without inherited configuration", async () => {
    if (process.platform === "win32") return;
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "hellocode-rg-"));
    const executable = path.join(fakeBin, "rg");
    const previousPath = process.env.PATH;
    const previousConfig = process.env.RIPGREP_CONFIG_PATH;
    try {
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          'case " $* " in *" --no-config "*) ;; *) exit 9 ;; esac',
          'if [ -n "${RIPGREP_CONFIG_PATH:-}" ]; then exit 10; fi',
          "printf 'safe.ts:1:needle\\n'",
          "",
        ].join("\n"),
      );
      await chmod(executable, 0o755);
      process.env.PATH = fakeBin;
      process.env.RIPGREP_CONFIG_PATH = "/untrusted/config";

      const result = await registry.execute("search_text", {
        path: ".",
        query: "needle",
      });

      expect(result).toEqual({
        isError: false,
        content: "safe.ts:1:needle",
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
      else process.env.RIPGREP_CONFIG_PATH = previousConfig;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("rejects malformed input as a tool error", async () => {
    const result = await registry.execute("read_file", {
      path: "anything",
      surprise: true,
    });

    expect(result).toEqual({
      isError: true,
      content: "Unexpected input field: surprise",
    });
  });

  it("bounds error results as well as successful results", async () => {
    const exploding = defineTool({
      definition: {
        name: "explode",
        strict: true,
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      parse(input) {
        objectInput(input, []);
        return {};
      },
      permission: () => ({ tool: "explode", kind: "read", detail: "test" }),
      execute: () => Promise.reject(new Error("x".repeat(100_000))),
    });
    const bounded = new ToolRegistry(
      [exploding],
      await WorkspacePaths.create(directory),
      new PermissionGate("bypass"),
    );

    const result = await bounded.execute("explode", {});

    expect(result.isError).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(30_000);
    expect(result.content).toContain("characters omitted");
  });
});

describe("run_command", () => {
  it("shows the complete command in the approval request", async () => {
    const approve = vi.fn(async (_request: PermissionRequest) => false);
    const guarded = new ToolRegistry(
      createTools(),
      await WorkspacePaths.create(directory),
      new PermissionGate("default", approve),
    );
    const command = `${"printf x ".repeat(40)}; dangerous-tail`;

    const result = await guarded.execute("run_command", { command });

    expect(result.isError).toBe(true);
    expect(approve.mock.calls[0]?.[0].detail).toBe(command);
  });

  it("returns stdout, stderr, and non-zero exit codes", async () => {
    const result = await registry.execute("run_command", {
      command: `${quote(process.execPath)} -e "console.log('out'); console.error('err'); process.exit(3)"`,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Exit code: 3");
    expect(result.content).toContain("stdout:\nout");
    expect(result.content).toContain("stderr:\nerr");
  });

  it("does not pass the Anthropic API key to child processes", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    try {
      const result = await registry.execute("run_command", {
        command: `${quote(process.execPath)} -e "process.stdout.write(process.env.ANTHROPIC_API_KEY || 'missing')"`,
      });
      expect(result.content).toContain("stdout:\nmissing");
      expect(result.content).not.toContain("must-not-leak");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("terminates commands that exceed their timeout", async () => {
    const result = await registry.execute("run_command", {
      command: `${quote(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      timeout_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Timed out after 1000 ms");
  });

  it("force-terminates descendants that ignore the timeout signal", async () => {
    if (process.platform === "win32") return;
    const stubbornProgram =
      "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync('stubborn.heartbeat',String(Date.now())),25)";
    const parentProgram = [
      "const {spawn}=require('node:child_process')",
      "const {writeFileSync}=require('node:fs')",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(stubbornProgram)}],{stdio:'ignore'})`,
      "writeFileSync('stubborn.pid',String(child.pid))",
      "setInterval(()=>{},1000)",
    ].join(";");

    const result = await registry.execute("run_command", {
      command: `${quote(process.execPath)} -e ${quote(parentProgram)}`,
      timeout_ms: 1000,
    });
    const pid = Number(
      await readFile(path.join(directory, "stubborn.pid"), "utf8"),
    );
    const heartbeat = await readFile(
      path.join(directory, "stubborn.heartbeat"),
      "utf8",
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(result.isError).toBe(true);
      expect(Number.isInteger(pid)).toBe(true);
      await expect(
        readFile(path.join(directory, "stubborn.heartbeat"), "utf8"),
      ).resolves.toBe(heartbeat);
    } finally {
      if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}
