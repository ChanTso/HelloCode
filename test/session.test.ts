import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../src/session.js';

let baseDirectory: string;
let workspace: string;

beforeEach(async () => {
  baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'hellocode-session-'));
  workspace = path.join(baseDirectory, 'workspace');
});

afterEach(async () => {
  await rm(baseDirectory, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('saves and restores workspace-scoped conversation history', async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    const store = createStore();
    await store.save(messages);

    const loaded = await createStore().loadLatest();

    expect(loaded?.messages).toEqual(messages);
    expect(loaded?.id).toBeTypeOf('string');
  });

  it('writes session files with private permissions', async () => {
    await createStore().save([{ role: 'user', content: 'private' }]);
    const file = await findSessionFile(baseDirectory);
    const mode = (await stat(file)).mode & 0o777;

    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain('ANTHROPIC_API_KEY');
  });

  it('reports a corrupt latest session instead of silently ignoring it', async () => {
    await createStore().save([{ role: 'user', content: 'valid' }]);
    const file = await findSessionFile(baseDirectory);
    await writeFile(file, '{broken', 'utf8');

    await expect(createStore().loadLatest()).rejects.toThrow(
      'Could not read latest HelloCode session',
    );
  });

  it('can persist an intentionally cleared session', async () => {
    const store = createStore();
    await store.save([]);

    const loaded = await createStore().loadLatest();

    expect(loaded?.messages).toEqual([]);
  });
});

function createStore(): SessionStore {
  return new SessionStore({
    baseDirectory,
    workspace,
    model: 'test-model',
  });
}

async function findSessionFile(directory: string): Promise<string> {
  const sessions = path.join(directory, 'sessions');
  const workspaceDirectories = await readdir(sessions);
  const workspaceDirectory = workspaceDirectories[0];
  if (workspaceDirectory === undefined) throw new Error('No workspace session directory.');
  const files = await readdir(path.join(sessions, workspaceDirectory));
  const file = files.find((name) => name.endsWith('.json'));
  if (file === undefined) throw new Error('No session file.');
  return path.join(sessions, workspaceDirectory, file);
}
