import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';

const SESSION_VERSION = 1;
const MAX_SESSION_BYTES = 20 * 1024 * 1024;

interface SessionDocument {
  createdAt: string;
  id: string;
  messages: Anthropic.MessageParam[];
  model: string;
  updatedAt: string;
  version: number;
  workspace: string;
}

export interface LoadedSession {
  id: string;
  messages: Anthropic.MessageParam[];
  updatedAt: string;
}

export interface SessionStoreOptions {
  baseDirectory?: string;
  model: string;
  workspace: string;
}

export class SessionStore {
  readonly #directory: string;
  readonly #model: string;
  readonly #workspace: string;
  #createdAt = new Date().toISOString();
  #id: string = randomUUID();

  constructor(options: SessionStoreOptions) {
    const base = options.baseDirectory ?? defaultStateDirectory();
    const workspaceKey = createHash('sha256')
      .update(options.workspace)
      .digest('hex')
      .slice(0, 16);
    this.#directory = path.join(base, 'sessions', workspaceKey);
    this.#workspace = options.workspace;
    this.#model = options.model;
  }

  async loadLatest(): Promise<LoadedSession | undefined> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const names = (await readdir(this.#directory))
      .filter((name) => name.startsWith('session-') && name.endsWith('.json'));
    if (names.length === 0) return undefined;

    const candidates = await Promise.all(
      names.map(async (name) => ({
        name,
        modified: (await stat(path.join(this.#directory, name))).mtimeMs,
      })),
    );
    candidates.sort((left, right) => right.modified - left.modified);
    const latest = candidates[0];
    if (latest === undefined) return undefined;
    const filePath = path.join(this.#directory, latest.name);
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_SESSION_BYTES) {
      throw new Error(`Latest HelloCode session is too large to load: ${filePath}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      throw new Error(
        `Could not read latest HelloCode session ${filePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const document = validateSession(parsed, filePath);
    if (document.workspace !== this.#workspace) {
      throw new Error('Latest HelloCode session belongs to a different workspace.');
    }
    this.#id = document.id;
    this.#createdAt = document.createdAt;
    return {
      id: document.id,
      messages: structuredClone(document.messages),
      updatedAt: document.updatedAt,
    };
  }

  async save(messages: readonly Anthropic.MessageParam[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const destination = path.join(this.#directory, `session-${this.#id}.json`);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const document: SessionDocument = {
      version: SESSION_VERSION,
      id: this.#id,
      workspace: this.#workspace,
      model: this.#model,
      createdAt: this.#createdAt,
      updatedAt: new Date().toISOString(),
      messages: structuredClone(messages) as Anthropic.MessageParam[],
    };

    try {
      await writeFile(temporary, `${JSON.stringify(document)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  reset(): void {
    this.#id = randomUUID();
    this.#createdAt = new Date().toISOString();
  }
}

export function defaultStateDirectory(): string {
  const override = process.env.HELLOCODE_HOME;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  const xdgState = process.env.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState.length > 0) {
    return path.join(xdgState, 'hellocode');
  }
  return path.join(os.homedir(), '.hellocode');
}

function validateSession(value: unknown, filePath: string): SessionDocument {
  if (!isRecord(value)) throw invalidSession(filePath);
  if (
    value.version !== SESSION_VERSION ||
    typeof value.id !== 'string' ||
    typeof value.workspace !== 'string' ||
    typeof value.model !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isMessage)
  ) {
    throw invalidSession(filePath);
  }
  return value as unknown as SessionDocument;
}

function isMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.role !== 'user' && value.role !== 'assistant') return false;
  if (typeof value.content === 'string') return true;
  return (
    Array.isArray(value.content) &&
    value.content.every(
      (block) => isRecord(block) && typeof block.type === 'string',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidSession(filePath: string): Error {
  return new Error(`Invalid or unsupported HelloCode session: ${filePath}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
