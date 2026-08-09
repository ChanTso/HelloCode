import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { ContextManager } from '../src/context.js';

describe('ContextManager', () => {
  it('shortens old tool results without breaking tool call/result pairs', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Inspect the file' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'read-1',
            name: 'read_file',
            input: { path: 'large.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read-1',
            content: 'x'.repeat(5000),
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'I inspected it.' }] },
    ];

    const result = new ContextManager(20_000).compact(messages, true);

    expect(result.changed).toBe(true);
    expect(result.shortenedResults).toBe(1);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain('"id":"read-1"');
    expect(serialized).toContain('"tool_use_id":"read-1"');
    expect(serialized).toContain('Earlier tool result compacted');
  });

  it('drops complete old turns and keeps a compact note with the latest turn', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'First request' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second request' },
      { role: 'assistant', content: 'Second answer' },
      { role: 'user', content: 'Latest request' },
      { role: 'assistant', content: 'Latest answer' },
    ];

    const result = new ContextManager(20_000).compact(messages, true);

    expect(result.removedTurns).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.content).toContain('HelloCode compacted 2 earlier');
    expect(result.messages[0]?.content).toContain('Latest request');
  });

  it('does nothing below budget during automatic compaction', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'small' },
    ];

    const result = new ContextManager(20_000).compact(messages, false);

    expect(result.changed).toBe(false);
    expect(result.messages).toBe(messages);
  });
});
