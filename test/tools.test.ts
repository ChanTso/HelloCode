import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspacePaths } from '../src/paths.js';
import { PermissionGate } from '../src/permissions.js';
import { createTools, ToolRegistry } from '../src/tools/index.js';

let directory: string;
let registry: ToolRegistry;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'hellocode-tools-'));
  const paths = await WorkspacePaths.create(directory);
  registry = new ToolRegistry(createTools(), paths, new PermissionGate('bypass'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('file tools', () => {
  it('creates, reads, and protects files from accidental overwrite', async () => {
    const created = await registry.execute('write_file', {
      path: 'src/example.ts',
      content: 'one\ntwo\nthree\n',
    });
    const read = await registry.execute('read_file', {
      path: 'src/example.ts',
      offset: 2,
      limit: 2,
    });
    const overwrite = await registry.execute('write_file', {
      path: 'src/example.ts',
      content: 'lost',
    });

    expect(created.isError).toBe(false);
    expect(read.content).toContain('     2\ttwo');
    expect(read.content).toContain('lines 2-3 of 4');
    expect(overwrite).toMatchObject({ isError: true });
    await expect(readFile(path.join(directory, 'src/example.ts'), 'utf8')).resolves.toBe(
      'one\ntwo\nthree\n',
    );
  });

  it('requires a unique edit unless replace_all is explicit', async () => {
    await writeFile(path.join(directory, 'values.txt'), 'same\nsame\n');

    const ambiguous = await registry.execute('edit_file', {
      path: 'values.txt',
      old_text: 'same',
      new_text: 'new',
    });
    const replaced = await registry.execute('edit_file', {
      path: 'values.txt',
      old_text: 'same',
      new_text: 'new',
      replace_all: true,
    });

    expect(ambiguous.content).toContain('occurs 2 times');
    expect(ambiguous.isError).toBe(true);
    expect(replaced.isError).toBe(false);
    await expect(readFile(path.join(directory, 'values.txt'), 'utf8')).resolves.toBe(
      'new\nnew\n',
    );
  });

  it('lists files and searches text while skipping generated directories', async () => {
    await registry.execute('write_file', {
      path: 'src/a.ts',
      content: 'const needle = 1;\n',
    });
    await registry.execute('write_file', {
      path: 'src/b.js',
      content: 'const other = 2;\n',
    });
    await registry.execute('write_file', {
      path: 'node_modules/hidden.ts',
      content: 'needle\n',
    });

    const listed = await registry.execute('list_files', {
      path: '.',
      pattern: '**/*.ts',
    });
    const searched = await registry.execute('search_text', {
      query: 'needle',
      path: '.',
      pattern: '**/*.ts',
    });

    expect(listed.content).toContain('src/a.ts');
    expect(listed.content).not.toContain('node_modules');
    expect(searched.content).toContain('src/a.ts:1:const needle = 1;');
    expect(searched.content).not.toContain('node_modules');
  });

  it('rejects malformed input as a tool error', async () => {
    const result = await registry.execute('read_file', {
      path: 'anything',
      surprise: true,
    });

    expect(result).toEqual({
      isError: true,
      content: 'Unexpected input field: surprise',
    });
  });
});

describe('run_command', () => {
  it('returns stdout, stderr, and non-zero exit codes', async () => {
    const result = await registry.execute('run_command', {
      command: `${quote(process.execPath)} -e "console.log('out'); console.error('err'); process.exit(3)"`,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Exit code: 3');
    expect(result.content).toContain('stdout:\nout');
    expect(result.content).toContain('stderr:\nerr');
  });

  it('does not pass the Anthropic API key to child processes', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    try {
      const result = await registry.execute('run_command', {
        command: `${quote(process.execPath)} -e "process.stdout.write(process.env.ANTHROPIC_API_KEY || 'missing')"`,
      });
      expect(result.content).toContain('stdout:\nmissing');
      expect(result.content).not.toContain('must-not-leak');
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('terminates commands that exceed their timeout', async () => {
    const result = await registry.execute('run_command', {
      command: `${quote(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      timeout_ms: 1000,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Timed out after 1000 ms');
  });
});

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
