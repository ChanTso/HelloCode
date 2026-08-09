import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { stripTerminalControls } from "../terminal-safety.js";
import {
  defineTool,
  objectInput,
  optionalIntegerField,
  stringField,
  type ToolSpec,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_CHARS = 16_000;

interface CommandInput {
  command: string;
  timeoutMs: number;
}

export function createShellTool(): ToolSpec {
  return defineTool<CommandInput>({
    definition: {
      name: "run_command",
      description:
        "Run one shell command in the workspace. Returns exit code, stdout, and stderr. Use for builds, tests, git, and other project commands. Commands are not OS-sandboxed and normally require user approval.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command interpreted by the platform shell.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1000,
            maximum: 600000,
            description: "Timeout in milliseconds. Defaults to 120000.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    parse(input) {
      const value = objectInput(input, ["command", "timeout_ms"]);
      return {
        command: stringField(value, "command"),
        timeoutMs:
          optionalIntegerField(value, "timeout_ms", 1000, 600_000) ??
          DEFAULT_TIMEOUT_MS,
      };
    },
    permission: (input) => ({
      tool: "run_command",
      kind: "shell",
      detail: input.command,
    }),
    execute: (input, context) =>
      runCommand(
        input.command,
        input.timeoutMs,
        context.paths.root,
        context.signal,
      ),
  });
}

async function runCommand(
  command: string,
  timeoutMs: number,
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  if (isAborted(signal)) throw abortError();

  const windows = process.platform === "win32";
  const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const args = windows ? ["/d", "/s", "/c", command] : ["-c", command];
  const child = spawn(shell, args, {
    cwd: workspace,
    detached: !windows,
    env: commandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = new BoundedText(MAX_CAPTURE_CHARS);
  const stderr = new BoundedText(MAX_CAPTURE_CHARS);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.append(chunk));
  child.stderr.on("data", (chunk: string) => stderr.append(chunk));

  let timedOut = false;
  let termination: Promise<void> | undefined;
  const stop = (): void => {
    termination ??= terminate(child);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeout.unref();

  const onAbort = (): void => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (isAborted(signal)) onAbort();

  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, closeSignal) =>
        resolve({ code, signal: closeSignal }),
      );
    });
    if (isAborted(signal)) throw abortError();

    const status = timedOut
      ? `Timed out after ${timeoutMs} ms`
      : result.signal !== null
        ? `Terminated by ${result.signal}`
        : `Exit code: ${result.code ?? "unknown"}`;
    const output = [
      status,
      `stdout:\n${stdout.toString() || "(empty)"}`,
      `stderr:\n${stderr.toString() || "(empty)"}`,
    ].join("\n\n");
    if (timedOut) throw new Error(output);
    return output;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    if (termination !== undefined) await termination;
  }
}

class BoundedText {
  readonly #half: number;
  #head = "";
  #omitted = 0;
  #tail = "";

  constructor(limit: number) {
    this.#half = Math.floor(limit / 2);
  }

  append(chunk: string): void {
    const clean = stripTerminalControls(chunk);
    if (this.#head.length < this.#half) {
      const needed = this.#half - this.#head.length;
      this.#head += clean.slice(0, needed);
      const remainder = clean.slice(needed);
      if (remainder.length > 0) this.#appendTail(remainder);
    } else {
      this.#appendTail(clean);
    }
  }

  toString(): string {
    if (this.#omitted === 0) return `${this.#head}${this.#tail}`.trimEnd();
    return `${this.#head}\n[... ${this.#omitted} characters omitted ...]\n${this.#tail}`.trimEnd();
  }

  #appendTail(chunk: string): void {
    const combined = this.#tail + chunk;
    if (combined.length > this.#half) {
      this.#omitted += combined.length - this.#half;
      this.#tail = combined.slice(-this.#half);
    } else {
      this.#tail = combined;
    }
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!isRunning(child)) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32") void killWindowsTree(pid, false);
    else process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  await delay(500);
  try {
    if (process.platform === "win32") await killWindowsTree(pid, true);
    else process.kill(-pid, "SIGKILL");
  } catch {
    if (isRunning(child)) child.kill("SIGKILL");
  }
}

function isRunning(
  child: ChildProcess,
): child is ChildProcess & { pid: number } {
  return (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

function killWindowsTree(pid: number, force: boolean): Promise<void> {
  const systemRoot =
    process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "taskkill.exe");
  const killer = spawn(
    executable,
    ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])],
    { env: commandEnvironment(), stdio: "ignore", windowsHide: true },
  );
  return new Promise((resolve) => {
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "ANTHROPIC_API_KEY") {
      delete environment[name];
    }
  }
  return environment;
}

function abortError(): Error {
  const error = new Error("Command cancelled.");
  error.name = "AbortError";
  return error;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}
