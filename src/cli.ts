import { parseArgs } from "node:util";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import { Agent, type AgentRunResult } from "./agent.js";
import {
  AnthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
  formatAnthropicError,
} from "./anthropic.js";
import { ContextManager } from "./context.js";
import {
  createModelBackend,
  type ModelBackend,
  type ModelProvider,
} from "./model.js";
import { WorkspacePaths } from "./paths.js";
import { PermissionGate, type PermissionMode } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  DEFAULT_OPENAI_MODEL,
  formatOpenAIError,
  OpenAIResponsesModel,
} from "./responses.js";
import { SessionStore, stripReplayState } from "./session.js";
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
  backend: ModelBackend;
  baseUrl?: string;
  contextChars: number;
  continueSession: boolean;
  interactive: boolean;
  maxTurns: number;
  mode: PermissionMode;
  model: string;
  prompt?: string;
  provider: ModelProvider;
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
      --provider <name>                Model provider: anthropic or openai (default: anthropic)
  -m, --model <id>                     Model ID (provider default when omitted)
      --base-url <url>                 API root for a compatible endpoint
  -C, --cwd <path>                     Workspace directory (default: current directory)
      --plan                           Read-only mode; deny edits and commands
      --dangerously-skip-permissions   Skip approval prompts (shell is not sandboxed)
      --no-save                        Do not write session history
      --max-turns <number>             Maximum model turns per request (default: 40)
  -v, --version                        Show version
  -h, --help                           Show help

Environment:
  HELLOCODE_PROVIDER      Default provider override
  HELLOCODE_MODEL         Default model override
  HELLOCODE_API_KEY       API key for the selected provider
  HELLOCODE_BASE_URL      API root for a compatible endpoint
  ANTHROPIC_API_KEY       Fallback key for the Anthropic provider
  ANTHROPIC_BASE_URL      Fallback API root for the Anthropic provider
  OPENAI_API_KEY          Fallback key for the OpenAI provider
  OPENAI_BASE_URL         Fallback API root for the OpenAI provider
  HELLOCODE_HOME          Session data directory (default: ~/.hellocode)
  HELLOCODE_CONTEXT_CHARS Approximate context budget (default: 600000)
  NO_COLOR                Disable terminal colors
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
      provider: { type: "string" },
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
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

  const provider = parseProvider(
    values.provider ?? process.env.HELLOCODE_PROVIDER ?? "anthropic",
  );
  const providerBaseUrl =
    provider === "anthropic"
      ? process.env.ANTHROPIC_BASE_URL
      : process.env.OPENAI_BASE_URL;
  const baseUrlValue =
    values["base-url"] ?? process.env.HELLOCODE_BASE_URL ?? providerBaseUrl;
  const baseUrl =
    baseUrlValue === undefined ? undefined : normalizeBaseUrl(baseUrlValue);
  const providerKey =
    provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;
  const apiKey = process.env.HELLOCODE_API_KEY ?? providerKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    const fallback =
      provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    throw new Error(`HELLOCODE_API_KEY or ${fallback} is not set.`);
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
  const defaultModel =
    provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
  const model = values.model ?? process.env.HELLOCODE_MODEL ?? defaultModel;
  if (model.trim() === "") {
    throw new Error("Model ID must not be empty.");
  }

  return {
    apiKey,
    backend: createModelBackend(provider, model, baseUrl),
    ...(baseUrl === undefined ? {} : { baseUrl }),
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
    model,
    ...(prompt === undefined ? {} : { prompt }),
    provider,
    save: values["no-save"] !== true,
    workspace: path.resolve(values.cwd ?? process.cwd()),
  };
}

async function run(config: CliConfig, ui: TerminalUI): Promise<number> {
  const paths = await WorkspacePaths.create(config.workspace);
  const sessionStore =
    config.save || config.continueSession
      ? new SessionStore({ workspace: paths.root, backend: config.backend })
      : undefined;
  const permission = new PermissionGate(
    config.mode,
    config.interactive ? ui.approve : undefined,
  );
  const registry = new ToolRegistry(createTools(), paths, permission);
  const model =
    config.provider === "anthropic"
      ? new AnthropicModel({
          apiKey: config.apiKey,
          model: config.model,
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        })
      : new OpenAIResponsesModel({
          apiKey: config.apiKey,
          model: config.model,
          ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        });
  const agent = new Agent(model, registry, {
    system: await buildSystemPrompt(paths, config.mode === "plan"),
    maxTurns: config.maxTurns,
    context: new ContextManager(config.contextChars),
    onEvent: (event) => ui.render(event),
  });

  if (config.continueSession && sessionStore !== undefined) {
    const loaded = await sessionStore.loadLatest();
    if (loaded === undefined)
      ui.notice("No previous session found for this workspace.");
    else {
      const changedBackend = !sameBackend(loaded.backend, config.backend);
      agent.restore(
        changedBackend ? stripReplayState(loaded.messages) : loaded.messages,
      );
      ui.notice(
        `Resumed session from ${new Date(loaded.updatedAt).toLocaleString()}.`,
      );
      if (changedBackend) {
        ui.notice(
          "Removed model-specific replay state before continuing with a different backend.",
        );
      }
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

  ui.showHeader(paths.root, `${config.provider}/${config.model}`, config.mode);
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

function parseProvider(value: string): ModelProvider {
  if (value === "anthropic" || value === "openai") return value;
  throw new Error("Provider must be anthropic or openai.");
}

function normalizeBaseUrl(value: string): string {
  if (value.trim().length === 0) throw new Error("Base URL must not be empty.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL must be a valid HTTP or HTTPS URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Base URL must use HTTP or HTTPS.");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.href.includes("?") ||
    url.href.includes("#")
  ) {
    throw new Error(
      "Base URL must not contain credentials, a query, or a fragment.",
    );
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("Base URL must use HTTPS unless it targets loopback.");
  }
  return url.toString().replace(/\/+$/u, "");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

function sameBackend(left: ModelBackend, right: ModelBackend): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.endpoint === right.endpoint
  );
}

function formatProviderError(error: unknown): string {
  return (
    formatAnthropicError(error) ??
    formatOpenAIError(error) ??
    errorMessage(error)
  );
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
