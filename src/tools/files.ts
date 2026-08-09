import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { isSensitivePath } from "../paths.js";
import { stripTerminalControls } from "../terminal-safety.js";
import {
  defineTool,
  objectInput,
  optionalBooleanField,
  optionalIntegerField,
  optionalStringField,
  stringField,
  type ToolSpec,
  type ToolContext,
} from "./types.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_REPLACEMENTS = 100_000;
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_SCANNED_FILES = 50_000;
const MAX_GLOB_CHARS = 1024;
const SEARCH_TIMEOUT_MS = 120_000;
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
  resolvedPath?: string;
}

interface ListInput {
  includeSensitive?: boolean;
  path: string;
  pattern: string;
  resolvedPath?: string;
}

interface SearchInput {
  includeSensitive?: boolean;
  path: string;
  pattern?: string;
  query: string;
  regex: boolean;
  resolvedPath?: string;
}

interface EditInput {
  newText: string;
  oldText: string;
  path: string;
  replaceAll: boolean;
  resolvedPath?: string;
}

interface WriteInput {
  content: string;
  createMode?: number;
  overwrite: boolean;
  path: string;
  resolvedPath?: string;
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
  async permission(input, context) {
    input.resolvedPath = await context.paths.resolveExisting(input.path);
    const display = context.paths.display(input.resolvedPath);
    const sensitive =
      isSensitivePath(input.resolvedPath) || isSensitivePath(display);
    return {
      tool: "read_file",
      kind: "read",
      detail: display,
      sensitive,
    };
  },
  async execute(input, context) {
    const filePath = await confirmExistingPath(input, context);
    const { buffer } = await readRegularFile(
      filePath,
      input.path,
      MAX_FILE_BYTES,
    );
    const text = decodeText(buffer, input.path);
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
    const parsed = {
      path: optionalStringField(value, "path") ?? ".",
      pattern: optionalStringField(value, "pattern") ?? "**/*",
    };
    validateGlob(parsed.pattern);
    return parsed;
  },
  async permission(input, context) {
    input.resolvedPath = await context.paths.resolveExisting(input.path);
    const display = context.paths.display(input.resolvedPath);
    input.includeSensitive =
      isSensitivePath(input.resolvedPath) ||
      isSensitivePath(display) ||
      isSensitivePath(input.pattern);
    return {
      tool: "list_files",
      kind: "read",
      detail: `${display} (${input.pattern})`,
      sensitive: input.includeSensitive,
    };
  },
  async execute(input, context) {
    const startPath = await confirmExistingPath(input, context);
    const files = await walkFiles(startPath, context.signal);
    const matches: string[] = [];

    for (const file of files) {
      const relativeToStart = toPosix(path.relative(startPath, file));
      if (!globMatches(input.pattern, relativeToStart)) continue;
      const workspaceRelative = toPosix(context.paths.display(file));
      if (!input.includeSensitive && isSensitivePath(workspaceRelative))
        continue;
      matches.push(workspaceRelative);
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
      "Search UTF-8 files in the workspace. Literal search uses ripgrep when available and has a built-in fallback; regular expressions require ripgrep.",
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
    if (pattern !== undefined) {
      validateGlob(pattern);
      result.pattern = pattern;
    }
    return result;
  },
  async permission(input, context) {
    input.resolvedPath = await context.paths.resolveExisting(input.path);
    const display = context.paths.display(input.resolvedPath);
    input.includeSensitive =
      isSensitivePath(input.resolvedPath) ||
      isSensitivePath(display) ||
      (input.pattern !== undefined && isSensitivePath(input.pattern));
    return {
      tool: "search_text",
      kind: "read",
      detail: `${input.query} in ${display}${input.pattern === undefined ? "" : ` (${input.pattern})`}`,
      sensitive: input.includeSensitive,
    };
  },
  async execute(input, context) {
    const searchPath = await confirmExistingPath(input, context);
    const includeSensitive = input.includeSensitive ?? false;
    const rgResult = await searchWithRipgrep(
      input,
      searchPath,
      context.paths.root,
      includeSensitive,
      context.signal,
    );
    if (rgResult !== undefined) return rgResult;
    if (input.regex) {
      throw new Error("Regex search requires ripgrep (rg) to be installed.");
    }
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
  async permission(input, context) {
    input.resolvedPath = await context.paths.resolveWrite(input.path);
    const display = context.paths.display(input.resolvedPath);
    const sensitive =
      isSensitivePath(input.resolvedPath) || isSensitivePath(display);
    return {
      tool: "edit_file",
      kind: "write",
      detail: display,
      sensitive,
    };
  },
  async execute(input, context) {
    const filePath = await confirmWritePath(input, context);
    const originalFile = await readRegularFile(
      filePath,
      input.path,
      MAX_FILE_BYTES,
    ).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) {
        throw new Error(`File does not exist: ${input.path}`);
      }
      throw error;
    });
    const originalBuffer = originalFile.buffer;
    const original = decodeText(originalBuffer, input.path);
    const occurrences = countOccurrences(original, input.oldText);
    if (occurrences === 0) throw new Error("old_text was not found.");
    if (!input.replaceAll && occurrences !== 1) {
      throw new Error(
        `old_text occurs ${occurrences} times; provide a larger unique match or set replace_all.`,
      );
    }
    if (input.replaceAll && occurrences > MAX_EDIT_REPLACEMENTS) {
      throw new Error(
        `replace_all matched ${occurrences} times; limit ${MAX_EDIT_REPLACEMENTS}. Use a more specific edit.`,
      );
    }
    const replacements = input.replaceAll ? occurrences : 1;
    const projectedBytes =
      originalBuffer.byteLength -
      replacements * Buffer.byteLength(input.oldText) +
      replacements * Buffer.byteLength(input.newText);
    if (projectedBytes > MAX_FILE_BYTES) {
      throw new Error(
        `Edit would create a ${projectedBytes}-byte file; limit ${MAX_FILE_BYTES}.`,
      );
    }
    const updated = input.replaceAll
      ? original.replaceAll(input.oldText, () => input.newText)
      : original.replace(input.oldText, () => input.newText);
    if (Buffer.byteLength(updated) > MAX_FILE_BYTES) {
      throw new Error(`Edited file exceeds the ${MAX_FILE_BYTES}-byte limit.`);
    }
    const current = await readRegularFile(filePath, input.path, MAX_FILE_BYTES);
    if (!current.buffer.equals(originalBuffer)) {
      throw new Error(`File changed while it was being edited: ${input.path}`);
    }
    throwIfAborted(context.signal);
    await atomicWrite(filePath, updated, originalFile.mode, context.signal);
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
  async permission(input, context) {
    input.resolvedPath = await context.paths.resolveWrite(input.path);
    const display = context.paths.display(input.resolvedPath);
    const sensitive =
      isSensitivePath(input.resolvedPath) || isSensitivePath(display);
    input.createMode = sensitive ? 0o600 : 0o666;
    return {
      tool: "write_file",
      kind: "write",
      detail: display,
      sensitive,
    };
  },
  async execute(input, context) {
    const filePath = await confirmWritePath(input, context);
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
    throwIfAborted(context.signal);
    await mkdir(path.dirname(filePath), { recursive: true });
    await confirmWritePath(input, context);
    throwIfAborted(context.signal);
    let created = existing === undefined;
    if (existing === undefined) {
      try {
        await atomicCreate(
          filePath,
          input.content,
          input.createMode ?? 0o666,
          context.signal,
        );
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (!input.overwrite) {
          throw new Error(
            `File appeared while it was being created: ${input.path}.`,
            { cause: error },
          );
        }
        const raced = await lstat(filePath);
        if (raced.isSymbolicLink()) {
          throw new Error(
            `Refusing to overwrite a symbolic link: ${input.path}`,
            { cause: error },
          );
        }
        if (raced.isDirectory())
          throw new Error(`Path is a directory: ${input.path}`, {
            cause: error,
          });
        created = false;
        await atomicWrite(filePath, input.content, raced.mode, context.signal);
      }
    } else {
      await atomicWrite(filePath, input.content, existing.mode, context.signal);
    }
    return `${created ? "Created" : "Wrote"} ${input.path} (${Buffer.byteLength(input.content)} bytes).`;
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
        if (files.length >= MAX_SCANNED_FILES) {
          throw new Error(
            `Workspace scan exceeded ${MAX_SCANNED_FILES} files; use a narrower path.`,
          );
        }
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
  const executable = await findRipgrep(workspace);
  if (executable === undefined) return undefined;
  const args = [
    "--no-config",
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-filesize=8M",
  ];
  if (!input.regex) args.push("--fixed-strings");
  if (input.pattern !== undefined) args.push("--glob", input.pattern);
  args.push(
    "--glob",
    "!**/node_modules/**",
    "--glob",
    "!**/dist/**",
    "--glob",
    "!**/build/**",
    "--glob",
    "!**/coverage/**",
    "--glob",
    "!**/.next/**",
    "--glob",
    "!**/.turbo/**",
  );
  if (!includeSensitive) {
    args.push(
      "--iglob",
      "!**/.git/**",
      "--iglob",
      "!**/.env*",
      "--iglob",
      "!**/*.pem",
      "--iglob",
      "!**/*.key",
      "--iglob",
      "!**/.npmrc",
      "--iglob",
      "!**/.pypirc",
      "--iglob",
      "!**/.netrc",
      "--iglob",
      "!**/.ssh/**",
      "--iglob",
      "!**/credential",
      "--iglob",
      "!**/credentials",
      "--iglob",
      "!**/credentials.*",
      "--iglob",
      "!**/id_rsa",
      "--iglob",
      "!**/id_dsa",
      "--iglob",
      "!**/id_ecdsa",
      "--iglob",
      "!**/id_ed25519",
      "--iglob",
      "!**/*.p12",
      "--iglob",
      "!**/*.pfx",
    );
  }
  args.push("--", input.query, path.relative(workspace, searchPath) || ".");

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace,
      env: sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let abortForce: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill("SIGTERM");
      abortForce ??= setTimeout(() => child.kill("SIGKILL"), 1500);
      abortForce.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (abortForce !== undefined) clearTimeout(abortForce);
      signal?.removeEventListener("abort", onAbort);
      if (error.code === "ENOENT") resolve(undefined);
      else reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (abortForce !== undefined) clearTimeout(abortForce);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted === true) return reject(abortError());
      if (timedOut)
        return reject(
          new Error(`ripgrep timed out after ${SEARCH_TIMEOUT_MS} ms.`),
        );
      if (code === 1) return resolve("No matches.");
      if (code !== 0)
        return reject(
          new Error(
            stderr.trim() || `ripgrep exited with code ${String(code)}`,
          ),
        );
      const lines = stripTerminalControls(stdout).trimEnd().split("\n");
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
  const files = await walkFiles(searchPath, signal);
  const matches: string[] = [];

  for (const file of files) {
    if (signal?.aborted === true) throw abortError();
    const workspaceRelative = toPosix(path.relative(workspace, file));
    const searchRelative = toPosix(path.relative(searchPath, file));
    if (
      input.pattern !== undefined &&
      !globMatches(input.pattern, searchRelative)
    )
      continue;
    if (!includeSensitive && isSensitivePath(workspaceRelative)) continue;
    let text: string;
    try {
      const { buffer } = await readRegularFile(
        file,
        workspaceRelative,
        MAX_FILE_BYTES,
      );
      text = decodeText(buffer, workspaceRelative);
    } catch {
      continue;
    }
    for (const [index, line] of text.split("\n").entries()) {
      const matched = line.includes(input.query);
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

async function confirmExistingPath(
  input: { path: string; resolvedPath?: string },
  context: ToolContext,
): Promise<string> {
  const current = await context.paths.resolveExisting(input.path);
  assertAuthorizedPath(input.resolvedPath, current);
  input.resolvedPath = current;
  return current;
}

async function confirmWritePath(
  input: { path: string; resolvedPath?: string },
  context: ToolContext,
): Promise<string> {
  const current = await context.paths.resolveWrite(input.path);
  assertAuthorizedPath(input.resolvedPath, current);
  input.resolvedPath = current;
  return current;
}

function assertAuthorizedPath(
  authorized: string | undefined,
  current: string,
): void {
  if (authorized !== undefined && authorized !== current) {
    throw new Error("Path changed after authorization; retry the operation.");
  }
}

async function readRegularFile(
  filePath: string,
  label: string,
  maximumBytes: number,
): Promise<{ buffer: Buffer; mode: number }> {
  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`Not a file: ${label}`);
    if (fileStat.size > maximumBytes) {
      throw new Error(
        `File is too large (${fileStat.size} bytes; limit ${maximumBytes}).`,
      );
    }
    const capacity = Math.min(maximumBytes + 1, fileStat.size + 1);
    const buffer = Buffer.alloc(capacity);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > fileStat.size) {
      throw new Error(`File changed while it was being read: ${label}`);
    }
    return { buffer: buffer.subarray(0, bytesRead), mode: fileStat.mode };
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  filePath: string,
  content: string,
  mode: number,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.hellocode-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    throwIfAborted(signal);
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporary, mode);
    throwIfAborted(signal);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function atomicCreate(
  filePath: string,
  content: string,
  mode: number,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.hellocode-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    throwIfAborted(signal);
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    throwIfAborted(signal);
    await link(temporary, filePath);
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

type GlobToken =
  | { kind: "literal"; value: string }
  | { kind: "one" | "star" | "tree" | "tree_directory" };

function globMatches(glob: string, candidate: string): boolean {
  const value = toPosix(candidate);
  let states = Array<boolean>(value.length + 1).fill(false);
  states[0] = true;

  for (const token of tokenizeGlob(glob)) {
    const next = Array<boolean>(value.length + 1).fill(false);
    switch (token.kind) {
      case "literal":
        for (let index = 0; index < value.length; index += 1) {
          if (states[index] && value[index] === token.value)
            next[index + 1] = true;
        }
        break;
      case "one":
        for (let index = 0; index < value.length; index += 1) {
          if (states[index] && value[index] !== "/") next[index + 1] = true;
        }
        break;
      case "star":
        for (let index = 0; index <= value.length; index += 1) {
          if (states[index]) next[index] = true;
          if (index > 0 && next[index - 1] && value[index - 1] !== "/")
            next[index] = true;
        }
        break;
      case "tree":
        for (let index = 0; index <= value.length; index += 1) {
          if (states[index] || (index > 0 && next[index - 1]))
            next[index] = true;
        }
        break;
      case "tree_directory": {
        next[0] = states[0] ?? false;
        let reachable = states[0] ?? false;
        for (let index = 1; index <= value.length; index += 1) {
          if (states[index - 1]) reachable = true;
          if (states[index] || (reachable && value[index - 1] === "/"))
            next[index] = true;
        }
        break;
      }
    }
    states = next;
  }

  return states[value.length] ?? false;
}

function tokenizeGlob(glob: string): GlobToken[] {
  const normalized = glob.replaceAll("\\", "/");
  const tokens: GlobToken[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "?") {
      tokens.push({ kind: "one" });
      continue;
    }
    if (character !== "*") {
      tokens.push({ kind: "literal", value: character ?? "" });
      continue;
    }

    let end = index + 1;
    while (normalized[end] === "*") end += 1;
    if (end - index === 1) {
      tokens.push({ kind: "star" });
    } else if (normalized[end] === "/") {
      tokens.push({ kind: "tree_directory" });
      end += 1;
    } else {
      tokens.push({ kind: "tree" });
    }
    index = end - 1;
  }
  return tokens;
}

function validateGlob(glob: string): void {
  if (glob.length > MAX_GLOB_CHARS) {
    throw new TypeError(
      `pattern exceeds the ${MAX_GLOB_CHARS}-character glob limit.`,
    );
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function findRipgrep(workspace: string): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (pathValue === undefined) return undefined;
  const executableNames =
    process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];

  for (const entry of pathValue.split(path.delimiter)) {
    const directory = path.resolve(entry === "" ? process.cwd() : entry);
    for (const name of executableNames) {
      try {
        const candidate = await realpath(path.join(directory, name));
        if (isWithin(workspace, candidate)) continue;
        const candidateStat = await stat(candidate);
        if (!candidateStat.isFile()) continue;
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH entries until a usable executable is found.
      }
    }
  }
  return undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError();
}
