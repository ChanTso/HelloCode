import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { AgentEvent } from "./agent.js";
import type {
  ApprovalPrompt,
  PermissionMode,
  PermissionRequest,
} from "./permissions.js";
import { quoteTerminalText, stripTerminalControls } from "./terminal-safety.js";

export interface TerminalUIOptions {
  error: Writable;
  input: Readable;
  interactive: boolean;
  output: Writable;
}

export class TerminalUI {
  readonly #color: boolean;
  readonly #error: Writable;
  readonly #output: Writable;
  readonly #readline: Interface | undefined;
  #interruptHandler: (() => void) | undefined;
  #textEndedWithNewline = true;
  #wroteText = false;

  constructor(options: TerminalUIOptions) {
    this.#output = options.output;
    this.#error = options.error;
    this.#color =
      "isTTY" in options.error &&
      options.error.isTTY === true &&
      process.env.NO_COLOR === undefined;
    this.#readline = options.interactive
      ? createInterface({ input: options.input, output: options.error })
      : undefined;
    this.#readline?.on("SIGINT", () => this.#interruptHandler?.());
  }

  readonly approve: ApprovalPrompt = async (
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    this.finishText();
    const label =
      request.sensitive === true ? "sensitive access" : request.kind;
    const answer = await this.question(
      `${this.#yellow("?")} Allow ${label}: ${quoteTerminalText(request.detail)}? ${this.#dim("[y/N]")} `,
      signal,
    );
    return (
      answer.trim().toLowerCase() === "y" ||
      answer.trim().toLowerCase() === "yes"
    );
  };

  showHeader(workspace: string, model: string, mode: PermissionMode): void {
    const safeWorkspace = stripTerminalControls(workspace);
    const safeModel = stripTerminalControls(model);
    this.#error.write(
      `${this.#cyan("HelloCode")} ${this.#dim(`· ${safeModel} · ${mode}`)}\n${this.#dim(safeWorkspace)}\n${this.#dim("Type /help for commands.")}\n\n`,
    );
  }

  render(event: AgentEvent): void {
    switch (event.type) {
      case "text": {
        const clean = stripTerminalControls(event.delta);
        this.#output.write(clean);
        this.#wroteText = true;
        this.#textEndedWithNewline = clean.endsWith("\n");
        break;
      }
      case "tool_start":
        this.finishText();
        this.#error.write(
          `${this.#cyan("→")} ${stripTerminalControls(event.name)} ${this.#dim(summarizeInput(event.input))}\n`,
        );
        break;
      case "tool_result":
        this.#error.write(
          `${event.isError ? this.#red("×") : this.#green("✓")} ${stripTerminalControls(event.name)}${event.isError ? ` ${this.#dim(firstLine(event.preview))}` : ""}\n`,
        );
        break;
      case "context_compacted":
        this.#error.write(
          `${this.#dim(`↻ compacted context (${event.removedTurns} turns removed, ${event.shortenedResults} results shortened)`)}\n`,
        );
        break;
      case "usage":
        break;
      default:
        assertNever(event);
    }
  }

  async question(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.#readline === undefined) {
      throw new Error("Interactive input is unavailable.");
    }
    return signal === undefined
      ? this.#readline.question(prompt)
      : this.#readline.question(prompt, { signal });
  }

  notice(message: string): void {
    this.finishText();
    this.#error.write(`${this.#dim(stripTerminalControls(message))}\n`);
  }

  error(message: string): void {
    this.finishText();
    this.#error.write(
      `${this.#red("error:")} ${stripTerminalControls(message)}\n`,
    );
  }

  finishText(): void {
    if (this.#wroteText && !this.#textEndedWithNewline)
      this.#output.write("\n");
    this.#wroteText = false;
    this.#textEndedWithNewline = true;
  }

  setInterruptHandler(handler?: () => void): void {
    this.#interruptHandler = handler;
  }

  close(): void {
    this.#readline?.close();
  }

  #cyan(text: string): string {
    return this.#paint("36", text);
  }

  #dim(text: string): string {
    return this.#paint("2", text);
  }

  #green(text: string): string {
    return this.#paint("32", text);
  }

  #red(text: string): string {
    return this.#paint("31", text);
  }

  #yellow(text: string): string {
    return this.#paint("33", text);
  }

  #paint(code: string, text: string): string {
    return this.#color ? `\u001B[${code}m${text}\u001B[0m` : text;
  }
}

function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const value = record.path ?? record.command ?? record.query;
  if (typeof value !== "string") return "";
  const singleLine = stripTerminalControls(value).replace(/\s+/gu, " ");
  return singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine;
}

function firstLine(text: string): string {
  const safe = stripTerminalControls(text);
  return safe.split("\n", 1)[0] ?? safe;
}

function assertNever(value: never): never {
  throw new Error(`Unknown UI event: ${String(value)}`);
}
