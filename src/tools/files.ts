import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { isSensitivePath } from "../paths.js";
import {
  defineTool,
  objectInput,
  optionalBooleanField,
  optionalIntegerField,
  optionalStringField,
  stringField,
  type ToolSpec,
} from "./types.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_RESULTS = 200;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);

interface ReadInput {
  limit: number;
  offset: number;
  path: string;
}

interface ListInput {
  path: string;
  pattern: string;
}

interface SearchInput {
  path: string;
  pattern?: string;
  query: string;
  regex: boolean;
}

interface EditInput {
  newText: string;
  oldText: string;
  path: string;
  replaceAll: boolean;
}

interface WriteInput {
  content: string;
  overwrite: boolean;
  path: string;
}

export function createFileTools(): ToolSpec[] {
  return [
    readFileTool,
    listFilesTool,
    searchTextTool,
    editFileTool,
    writeFileTool,
  ];
}

const readFileTool = defineTool<ReadInput>({
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file in the workspace with one-based line pagination. The result includes line numbers. Use offset and limit to continue large files.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or in-workspace absolute path.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "First line to return. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          description: "Maximum lines to return. Defaults to 400.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  parse(input) {
    const value = objectInput(input, ["path", "offset", "limit"]);
    return {
      path: stringField(value, "path"),
      offset:
        optionalIntegerField(value, "offset", 1, Number.MAX_SAFE_INTEGER) ?? 1,
      limit: optionalIntegerField(value, "limit", 1, 2000) ?? 400,
    };
  },
  permission: (input) => ({
    tool: "read_file",
    kind: "read",
    detail: input.path,
    sensitive: isSensitivePath(input.path),
  }),
  async execute(input, context) {
    const filePath = await context.paths.resolveExisting(input.path);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`Not a file: ${input.path}`);
    if (fileStat.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large (${fileStat.size} bytes; limit ${MAX_FILE_BYTES}).`,
      );
    }

    const text = decodeText(await readFile(filePath), input.path);
    const lines = text.split("\n");
    const start = input.offset - 1;
    if (start >= lines.length) {
      throw new Error(
        `Offset ${input.offset} is past the end of ${input.path} (${lines.length} lines).`,
      );
    }
    const selected = lines.slice(start, start + input.limit);
    const body = selected
      .map(
        (line, index) => `${String(input.offset + index).padStart(6)}\t${line}`,
      )
      .join("\n");
    const lastLine = input.offset + selected.length - 1;
    const continuation =
      lastLine < lines.length
        ? `\n\n[${input.path}: lines ${input.offset}-${lastLine} of ${lines.length}; continue at offset ${lastLine + 1}]`
        : `\n\n[${input.path}: lines ${input.offset}-${lastLine} of ${lines.length}]`;
    return `${body}${continuation}`;
  },
});

const listFilesTool = defineTool<ListInput>({
  definition: {
    name: "list_files",
    description:
      "List files below a workspace directory. Supports *, **, and ? glob wildcards and skips common generated directories.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to scan. Defaults to the workspace root.",
        },
        pattern: {
          type: "string",
          description: "Glob matched relative to path. Defaults to **/*.",
        },
      },
      additionalProperties: false,
    },
  },
  parse(input) {
    const value = objectInput(input, ["path", "pattern"]);
    return {
      path: optionalStringField(value, "path") ?? ".",
      pattern: optionalStringField(value, "pattern") ?? "**/*",
    };
  },
  permission: (input) => ({
    tool: "list_files",
    kind: "read",
    detail: `${input.path} (${input.pattern})`,
  }),
  async execute(input, context) {
    const startPath = await context.paths.resolveExisting(input.path);
    const matcher = globToRegExp(input.pattern);
    const files = await walkFiles(startPath, context.signal);
    const matches: string[] = [];

    for (const file of files) {
      const relativeToStart = toPosix(path.relative(startPath, file));
      if (!matcher.test(relativeToStart)) continue;
      matches.push(toPosix(context.paths.display(file)));
      if (matches.length === MAX_LIST_RESULTS) break;
    }

    matches.sort();
    if (matches.length === 0) return "No matching files.";
    const suffix =
      matches.length === MAX_LIST_RESULTS
        ? `\n[Results limited to ${MAX_LIST_RESULTS}; use a narrower path or pattern.]`
        : "";
    return `${matches.join("\n")}${suffix}`;
  },
});

const searchTextTool = defineTool<SearchInput>({
  definition: {
    name: "search_text",
    description:
      "Search UTF-8 files in the workspace. Uses fast ripgrep when available and falls back to a built-in search. Literal search is the default; set regex for regular expressions.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text or regular expression to find.",
        },
        path: {
          type: "string",
          description:
            "File or directory to search. Defaults to the workspace root.",
        },
        pattern: {
          type: "string",
          description: "Optional file glob, such as **/*.ts.",
        },
        regex: {
          type: "boolean",
          description:
            "Interpret query as a regular expression. Defaults to false.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  parse(input) {
    const value = objectInput(input, ["query", "path", "pattern", "regex"]);
    const result: SearchInput = {
      query: stringField(value, "query"),
      path: optionalStringField(value, "path") ?? ".",
      regex: optionalBooleanField(value, "regex") ?? false,
    };
    const pattern = optionalStringField(value, "pattern");
    if (pattern !== undefined) result.pattern = pattern;
    if (result.regex) new RegExp(result.query, "u");
    return result;
  },
  permission: (input) => ({
    tool: "search_text",
    kind: "read",
    detail: `${input.query} in ${input.path}`,
    sensitive:
      isSensitivePath(input.path) ||
      (input.pattern !== undefined && isSensitivePath(input.pattern)),
  }),
  async execute(input, context) {
    const searchPath = await context.paths.resolveExisting(input.path);
    const includeSensitive =
      isSensitivePath(input.path) ||
      (input.pattern !== undefined && isSensitivePath(input.pattern));
    const rgResult = await searchWithRipgrep(
      input,
      searchPath,
      context.paths.root,
      includeSensitive,
      context.signal,
    );
    if (rgResult !== undefined) return rgResult;
    return searchWithNode(
      input,
      searchPath,
      context.paths.root,
      includeSensitive,
      context.signal,
    );
  },
});

const editFileTool = defineTool<EditInput>({
  definition: {
    name: "edit_file",
    description:
      "Replace exact text in an existing UTF-8 workspace file. By default old_text must occur exactly once; set replace_all only when every occurrence should change.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: {
          type: "boolean",
          description: "Replace every match. Defaults to false.",
        },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  parse(input) {
    const value = objectInput(input, [
      "path",
      "old_text",
      "new_text",
      "replace_all",
    ]);
    return {
      path: stringField(value, "path"),
      oldText: stringField(value, "old_text"),
      newText:
        typeof value.new_text === "string"
          ? value.new_text
          : (() => {
              throw new TypeError("new_text must be a string.");
            })(),
      replaceAll: optionalBooleanField(value, "replace_all") ?? false,
    };
  },
  permission: (input) => ({
    tool: "edit_file",
    kind: "write",
    detail: input.path,
    sensitive: isSensitivePath(input.path),
  }),
  async execute(input, context) {
    const filePath = await context.paths.resolveWrite(input.path);
    const fileStat = await stat(filePath).catch(() => {
      throw new Error(`File does not exist: ${input.path}`);
    });
    if (!fileStat.isFile()) throw new Error(`Not a file: ${input.path}`);
    if (fileStat.size > MAX_FILE_BYTES)
      throw new Error("File is too large to edit.");
    const original = decodeText(await readFile(filePath), input.path);
    const occurrences = countOccurrences(original, input.oldText);
    if (occurrences === 0) throw new Error("old_text was not found.");
    if (!input.replaceAll && occurrences !== 1) {
      throw new Error(
        `old_text occurs ${occurrences} times; provide a larger unique match or set replace_all.`,
      );
    }
    const updated = input.replaceAll
      ? original.split(input.oldText).join(input.newText)
      : original.replace(input.oldText, input.newText);
    await atomicWrite(filePath, updated, fileStat.mode);
    return `Updated ${input.path} (${input.replaceAll ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"}).`;
  },
});

const writeFileTool = defineTool<WriteInput>({
  definition: {
    name: "write_file",
    description:
      "Create a UTF-8 file in the workspace. Parent directories are created. Existing files are protected unless overwrite is true; prefer edit_file for small changes.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: {
          type: "boolean",
          description: "Allow replacing an existing file. Defaults to false.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  parse(input) {
    const value = objectInput(input, ["path", "content", "overwrite"]);
    if (typeof value.content !== "string") {
      throw new TypeError("content must be a string.");
    }
    if (Buffer.byteLength(value.content) > MAX_WRITE_BYTES) {
      throw new TypeError(
        `content exceeds the ${MAX_WRITE_BYTES}-byte write limit.`,
      );
    }
    return {
      path: stringField(value, "path"),
      content: value.content,
      overwrite: optionalBooleanField(value, "overwrite") ?? false,
    };
  },
  permission: (input) => ({
    tool: "write_file",
    kind: "write",
    detail: input.path,
    sensitive: isSensitivePath(input.path),
  }),
  async execute(input, context) {
    const filePath = await context.paths.resolveWrite(input.path);
    const existing = await lstat(filePath).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existing !== undefined && !input.overwrite) {
      throw new Error(
        `File already exists: ${input.path}. Use edit_file or set overwrite.`,
      );
    }
    if (existing?.isDirectory() === true)
      throw new Error(`Path is a directory: ${input.path}`);
    await mkdir(path.dirname(filePath), { recursive: true });
    await atomicWrite(filePath, input.content, existing?.mode ?? 0o644);
    return `${existing === undefined ? "Created" : "Wrote"} ${input.path} (${Buffer.byteLength(input.content)} bytes).`;
  },
});

async function walkFiles(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  if (!rootStat.isDirectory())
    throw new Error(`Not a file or directory: ${root}`);

  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    if (signal?.aborted === true) throw abortError();
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

async function searchWithRipgrep(
  input: SearchInput,
  searchPath: string,
  workspace: string,
  includeSensitive: boolean,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-filesize=8M",
  ];
  if (!input.regex) args.push("--fixed-strings");
  if (input.pattern !== undefined) args.push("--glob", input.pattern);
  args.push(
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
  );
  if (!includeSensitive) {
    args.push(
      "--glob",
      "!**/.env",
      "--glob",
      "!**/.env.*",
      "--glob",
      "!**/*.pem",
      "--glob",
      "!**/*.key",
      "--glob",
      "!**/.npmrc",
    );
  }
  args.push("--", input.query, path.relative(workspace, searchPath) || ".");

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, {
      cwd: workspace,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      if (error.code === "ENOENT") resolve(undefined);
      else reject(error);
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted === true) return reject(abortError());
      if (code === 1) return resolve("No matches.");
      if (code !== 0)
        return reject(
          new Error(
            stderr.trim() || `ripgrep exited with code ${String(code)}`,
          ),
        );
      const lines = sanitizeText(stdout).trimEnd().split("\n");
      const limited = lines.slice(0, MAX_SEARCH_RESULTS);
      const suffix =
        lines.length > MAX_SEARCH_RESULTS
          ? `\n[Results limited to ${MAX_SEARCH_RESULTS}; narrow the query to see more.]`
          : "";
      return resolve(`${limited.join("\n")}${suffix}`);
    });
  });
}

async function searchWithNode(
  input: SearchInput,
  searchPath: string,
  workspace: string,
  includeSensitive: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const matcher =
    input.pattern === undefined ? undefined : globToRegExp(input.pattern);
  const query = input.regex ? new RegExp(input.query, "u") : undefined;
  const files = await walkFiles(searchPath, signal);
  const matches: string[] = [];

  for (const file of files) {
    if (signal?.aborted === true) throw abortError();
    const workspaceRelative = toPosix(path.relative(workspace, file));
    const searchRelative = toPosix(path.relative(searchPath, file));
    if (matcher !== undefined && !matcher.test(searchRelative)) continue;
    if (!includeSensitive && isSensitivePath(workspaceRelative)) continue;
    const fileStat = await stat(file);
    if (fileStat.size > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      text = decodeText(await readFile(file), workspaceRelative);
    } catch {
      continue;
    }
    for (const [index, line] of text.split("\n").entries()) {
      const matched =
        query === undefined ? line.includes(input.query) : query.test(line);
      if (query !== undefined) query.lastIndex = 0;
      if (matched) matches.push(`${workspaceRelative}:${index + 1}:${line}`);
      if (matches.length === MAX_SEARCH_RESULTS) {
        return `${matches.join("\n")}\n[Results limited to ${MAX_SEARCH_RESULTS}; narrow the query to see more.]`;
      }
    }
  }
  return matches.length === 0 ? "No matches." : matches.join("\n");
}

function decodeText(buffer: Buffer, label: string): string {
  if (buffer.includes(0))
    throw new Error(`Binary file is not supported: ${label}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`File is not valid UTF-8: ${label}`);
  }
}

async function atomicWrite(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.hellocode-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(search, index)) !== -1) {
    count += 1;
    index += search.length;
  }
  return count;
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${source}$`, "u");
}

function sanitizeText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- terminal escape sequences are the subject of this sanitizer.
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
      // eslint-disable-next-line no-control-regex -- terminal escape sequences are the subject of this sanitizer.
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
      // eslint-disable-next-line no-control-regex -- terminal control characters are the subject of this sanitizer.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
  );
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY;
  return environment;
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function abortError(): Error {
  const error = new Error("Operation cancelled.");
  error.name = "AbortError";
  return error;
}
