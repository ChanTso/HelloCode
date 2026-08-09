import { parseArgs } from "node:util";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { Agent, type AgentRunResult } from "./agent.js";
import {
  AnthropicModel,
  DEFAULT_MODEL,
  formatProviderError,
} from "./anthropic.js";
import { ContextManager } from "./context.js";
import { WorkspacePaths } from "./paths.js";
import { PermissionGate, type PermissionMode } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionStore } from "./session.js";
import { createTools, ToolRegistry } from "./tools/index.js";
import { TerminalUI } from "./ui.js";
import { VERSION } from "./version.js";

interface RuntimeIO {
  error: Writable;
  input: Readable;
  output: Writable;
}

interface CliConfig {
  apiKey: string;
  contextChars: number;
  continueSession: boolean;
  interactive: boolean;
  maxTurns: number;
  mode: PermissionMode;
  model: string;
  prompt?: string;
  save: boolean;
  workspace: string;
}

const HELP = `HelloCode ${VERSION} — a small, practical coding agent

Usage:
  hellocode [options]
  hellocode [options] "prompt"
  echo "prompt" | hellocode --print

Options:
  -p, --print                          Run once and exit
  -c, --continue                       Resume this workspace's latest session
  -m, --model <id>                     Anthropic model (default: ${DEFAULT_MODEL})
  -C, --cwd <path>                     Workspace directory (default: current directory)
      --plan                           Read-only mode; deny edits and commands
      --dangerously-skip-permissions   Skip approval prompts (shell is not sandboxed)
      --no-save                        Do not write session history
      --max-turns <number>             Maximum model turns per request (default: 40)
  -v, --version                        Show version
  -h, --help                           Show help

Environment:
  ANTHROPIC_API_KEY     Required Anthropic API key
  HELLOCODE_MODEL       Default model override
  HELLOCODE_HOME        Session data directory (default: ~/.hellocode)
  NO_COLOR              Disable terminal colors
`;

const INTERACTIVE_HELP = `Commands:
  /help       Show this help
  /clear      Start a fresh conversation
  /compact    Reduce older conversation context
  /exit       Exit HelloCode
`;

export async function main(
  argv = process.argv.slice(2),
  io: RuntimeIO = {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  },
): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    io.error.write(`error: ${errorMessage(error)}\n\n${HELP}`);
    return 2;
  }

  if (parsed.action === "help") {
    io.output.write(HELP);
    return 0;
  }
  if (parsed.action === "version") {
    io.output.write(`HelloCode ${VERSION}\n`);
    return 0;
  }

  let config: CliConfig;
  try {
    config = await resolveConfig(parsed.values, parsed.positionals, io.input);
  } catch (error) {
    io.error.write(`error: ${errorMessage(error)}\n`);
    return 2;
  }

  const ui = new TerminalUI({
    input: io.input,
    output: io.output,
    error: io.error,
    interactive: config.interactive,
  });

  try {
    return await run(config, ui);
  } catch (error) {
    ui.error(formatProviderError(error));
    return isAbortError(error) ? 130 : 1;
  } finally {
    ui.finishText();
    ui.close();
  }
}

function parseCli(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      print: { type: "boolean", short: "p" },
      continue: { type: "boolean", short: "c" },
      model: { type: "string", short: "m" },
      cwd: { type: "string", short: "C" },
      plan: { type: "boolean" },
      "dangerously-skip-permissions": { type: "boolean" },
      "no-save": { type: "boolean" },
      "max-turns": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (parsed.values.help === true) {
    return {
      action: "help" as const,
      values: parsed.values,
      positionals: parsed.positionals,
    };
  }
  if (parsed.values.version === true) {
    return {
      action: "version" as const,
      values: parsed.values,
      positionals: parsed.positionals,
    };
  }
  return {
    action: "run" as const,
    values: parsed.values,
    positionals: parsed.positionals,
  };
}

async function resolveConfig(
  values: ReturnType<typeof parseCli>["values"],
  positionals: string[],
  input: Readable,
): Promise<CliConfig> {
  if (values.plan === true && values["dangerously-skip-permissions"] === true) {
    throw new Error(
      "--plan and --dangerously-skip-permissions cannot be combined.",
    );
  }

  const positionalPrompt = positionals.join(" ").trim();
  const inputIsTty = streamIsTty(input);
  const interactive =
    values.print !== true && positionalPrompt.length === 0 && inputIsTty;
  let prompt = positionalPrompt.length === 0 ? undefined : positionalPrompt;
  if (!interactive && prompt === undefined && !inputIsTty) {
    const piped = (await readAll(input)).trim();
    if (piped.length > 0) prompt = piped;
  }
  if (!interactive && prompt === undefined) {
    throw new Error("A prompt is required in print mode.");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  const maxTurns = parsePositiveInteger(
    values["max-turns"] ?? "40",
    "--max-turns",
    200,
  );
  const contextChars = parsePositiveInteger(
    process.env.HELLOCODE_CONTEXT_CHARS ?? "600000",
    "HELLOCODE_CONTEXT_CHARS",
    5_000_000,
  );
  if (contextChars < 20_000) {
    throw new Error("HELLOCODE_CONTEXT_CHARS must be at least 20000.");
  }

  return {
    apiKey,
    contextChars,
    continueSession: values.continue === true,
    interactive,
    maxTurns,
    mode:
      values["dangerously-skip-permissions"] === true
        ? "bypass"
        : values.plan === true
          ? "plan"
          : "default",
    model: values.model ?? process.env.HELLOCODE_MODEL ?? DEFAULT_MODEL,
    ...(prompt === undefined ? {} : { prompt }),
    save: values["no-save"] !== true,
    workspace: path.resolve(values.cwd ?? process.cwd()),
  };
}

async function run(config: CliConfig, ui: TerminalUI): Promise<number> {
  const paths = await WorkspacePaths.create(config.workspace);
  const sessionStore =
    config.save || config.continueSession
      ? new SessionStore({ workspace: paths.root, model: config.model })
      : undefined;
  const permission = new PermissionGate(
    config.mode,
    config.interactive ? ui.approve : undefined,
  );
  const registry = new ToolRegistry(createTools(), paths, permission);
  const model = new AnthropicModel({
    apiKey: config.apiKey,
    model: config.model,
  });
  const agent = new Agent(model, registry, {
    system: await buildSystemPrompt(paths),
    maxTurns: config.maxTurns,
    context: new ContextManager(config.contextChars),
    onEvent: (event) => ui.render(event),
  });

  if (config.continueSession && sessionStore !== undefined) {
    const loaded = await sessionStore.loadLatest();
    if (loaded === undefined)
      ui.notice("No previous session found for this workspace.");
    else {
      agent.restore(loaded.messages);
      ui.notice(
        `Resumed session from ${new Date(loaded.updatedAt).toLocaleString()}.`,
      );
    }
  }
  const writableSession = config.save ? sessionStore : undefined;

  if (!config.interactive) {
    const result = await runTurn(agent, config.prompt ?? "", ui);
    await saveSession(writableSession, agent, ui);
    if (result === undefined) return 130;
    reportStop(result, ui);
    return result.stop === "complete" ? 0 : 1;
  }

  ui.showHeader(paths.root, config.model, config.mode);
  return interactiveLoop(agent, writableSession, ui);
}

async function interactiveLoop(
  agent: Agent,
  session: SessionStore | undefined,
  ui: TerminalUI,
): Promise<number> {
  let exitRequested = false;
  while (!exitRequested) {
    ui.setInterruptHandler(() => {
      exitRequested = true;
      ui.close();
    });
    let input: string;
    try {
      input = (await ui.question("› ")).trim();
    } catch (error) {
      if (exitRequested || isAbortError(error) || isClosedReadlineError(error))
        break;
      throw error;
    }
    if (input.length === 0) continue;

    switch (input) {
      case "/exit":
      case "/quit":
        exitRequested = true;
        continue;
      case "/help":
        ui.notice(INTERACTIVE_HELP.trimEnd());
        continue;
      case "/clear":
        agent.clear();
        session?.reset();
        await saveSession(session, agent, ui);
        ui.notice("Conversation cleared.");
        continue;
      case "/compact": {
        const result = agent.compact(true);
        await saveSession(session, agent, ui);
        if (!result.changed) ui.notice("Context is already compact.");
        continue;
      }
      default:
        if (input.startsWith("/")) {
          ui.notice(`Unknown command: ${input}. Type /help for commands.`);
          continue;
        }
    }

    try {
      const result = await runTurn(agent, input, ui);
      await saveSession(session, agent, ui);
      if (result !== undefined) reportStop(result, ui);
    } catch (error) {
      await saveSession(session, agent, ui);
      if (isAbortError(error)) ui.notice("Turn cancelled.");
      else ui.error(formatProviderError(error));
    }
  }
  await saveSession(session, agent, ui);
  ui.notice("Goodbye.");
  return 0;
}

async function runTurn(
  agent: Agent,
  prompt: string,
  ui: TerminalUI,
): Promise<AgentRunResult | undefined> {
  const controller = new AbortController();
  const interrupt = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
      ui.notice("Cancelling current turn…");
    }
  };
  ui.setInterruptHandler(interrupt);
  process.on("SIGINT", interrupt);
  try {
    return await agent.run(prompt, controller.signal);
  } catch (error) {
    if (controller.signal.aborted && isAbortError(error)) return undefined;
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    ui.setInterruptHandler(undefined);
    ui.finishText();
  }
}

async function saveSession(
  store: SessionStore | undefined,
  agent: Agent,
  ui: TerminalUI,
): Promise<void> {
  if (store === undefined) return;
  try {
    await store.save(agent.messages);
  } catch (error) {
    ui.error(`Could not save session: ${errorMessage(error)}`);
  }
}

function reportStop(result: AgentRunResult, ui: TerminalUI): void {
  switch (result.stop) {
    case "complete":
      return;
    case "max_tokens":
      ui.notice("The response reached the model output limit.");
      return;
    case "context_limit":
      ui.notice(
        "The model context window was exhausted. Use /compact or /clear.",
      );
      return;
    case "refusal":
      ui.notice("The model declined this request.");
      return;
    case "turn_limit":
      ui.notice("HelloCode stopped at its tool or turn limit.");
      return;
    default:
      assertNever(result.stop);
  }
}

async function readAll(input: Readable): Promise<string> {
  input.setEncoding("utf8");
  let result = "";
  for await (const chunk of input) result += chunk as string;
  return result;
}

function streamIsTty(stream: Readable): boolean {
  return "isTTY" in stream && stream.isTTY === true;
}

function parsePositiveInteger(
  value: string,
  label: string,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

function isClosedReadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled stop state: ${String(value)}`);
}
