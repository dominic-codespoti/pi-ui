import { describe, it, expect } from 'vitest';
import {
  uid, extractTextContent, formatToolInput,
  agentMsgToUI, rawMessagesToUI, reconnectDelay,
} from '../client-messages';

describe('uid', () => {
  it('returns a string', () => {
    expect(typeof uid()).toBe('string');
  });

  it('returns a UUID-like string', () => {
    expect(uid()).toMatch(/^[0-9a-f-]+$/);
  });

  it('returns unique values', () => {
    const a = uid();
    const b = uid();
    expect(a).not.toBe(b);
  });
});

describe('extractTextContent', () => {
  it('extracts text blocks', () => {
    const blocks = [
      { type: 'text', text: 'Hello' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'text', text: ' world' },
    ];
    expect(extractTextContent(blocks)).toBe('Hello world');
  });

  it('returns empty string for no text blocks', () => {
    expect(extractTextContent([{ type: 'image', text: undefined }])).toBe('');
  });

  it('handles empty array', () => {
    expect(extractTextContent([])).toBe('');
  });
});

describe('formatToolInput', () => {
  it('formats bash command', () => {
    expect(formatToolInput('bash', { command: 'ls -la' })).toBe('$ ls -la');
  });

  it('truncates multiline bash to first line', () => {
    expect(formatToolInput('bash', { command: 'echo hi\nrm -rf /\n' })).toBe('$ echo hi');
  });

  it('formats read file path', () => {
    expect(formatToolInput('read', { path: '/home/user/file.ts' })).toBe('file.ts');
  });

  it('formats read with offset', () => {
    expect(formatToolInput('read', { path: 'src/main.ts', offset: 10 })).toBe('main.ts:10+');
  });

  it('formats read with offset and limit', () => {
    expect(formatToolInput('read', { path: 'src/main.ts', offset: 10, limit: 20 })).toBe('main.ts:10–29');
  });

  it('formats write file', () => {
    expect(formatToolInput('write', { path: '/tmp/out.txt' })).toBe('out.txt');
  });

  it('formats edit file', () => {
    expect(formatToolInput('edit', { file_path: 'src/index.ts' })).toBe('index.ts');
  });

  it('formats edit with multiple edits', () => {
    expect(formatToolInput('edit', { file_path: 'src/index.ts', edits: [{ old: 'a' }, { old: 'b' }] })).toBe('index.ts (2 edits)');
  });

  it('formats grep with pattern', () => {
    expect(formatToolInput('grep', { pattern: 'TODO', path: 'src/lib' })).toBe('/TODO/ lib');
  });

  it('formats find', () => {
    expect(formatToolInput('find', { pattern: '*.ts', path: '.' })).toBe('*.ts .');
  });

  it('formats ls', () => {
    expect(formatToolInput('ls', { path: '/home' })).toBe('/home');
  });

  it('returns undefined for missing details', () => {
    expect(formatToolInput('bash')).toBeUndefined();
  });

  it('falls back to first short string value', () => {
    expect(formatToolInput('custom_tool', { name: 'myvalue' })).toBe('myvalue');
  });
});

describe('agentMsgToUI', () => {
  it('converts a user string message', () => {
    const result = agentMsgToUI({ role: 'user', content: 'Hello' });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Hello');
    expect(result[0].streaming).toBe(false);
  });

  it('converts a user message with image blocks', () => {
    const result = agentMsgToUI({
      role: 'user',
      content: [
        { type: 'text', text: 'See this:' },
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('See this:');
    expect(result[0].images).toHaveLength(1);
    expect(result[0].images![0]).toContain('data:image/png;base64,base64data');
  });

  it('converts assistant text message', () => {
    const result = agentMsgToUI({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from AI' }],
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.001 } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Hello from AI');
    expect(result[0].usage?.totalTokens).toBe(15);
  });

  it('converts assistant with thinking blocks', () => {
    const result = agentMsgToUI({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me solve this...' },
        { type: 'text', text: 'Here is the answer' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].thinking).toBe('Let me solve this...');
    expect(result[0].content).toBe('Here is the answer');
  });

  it('skips assistant messages with no displayable content', () => {
    const result = agentMsgToUI({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call1', name: 'bash', arguments: '{}' }],
    });
    expect(result).toHaveLength(0);
  });

  it('converts bash execution messages', () => {
    const result = agentMsgToUI({
      role: 'bash_execution',
      command: 'ls',
      output: 'file1\nfile2',
      exitCode: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    expect(result[0].toolName).toBe('bash');
    expect(result[0].toolInput).toBe('$ ls');
    expect(result[0].isError).toBe(false);
  });

  it('marks bash execution with non-zero exit as error', () => {
    const result = agentMsgToUI({
      role: 'bash',
      command: 'invalid',
      output: 'not found',
      exitCode: 127,
    });
    expect(result[0].isError).toBe(true);
  });

  it('converts tool_result messages', () => {
    const map = new Map<string, { name: string; input: Record<string, unknown> }>();
    map.set('call-1', { name: 'read', input: { path: 'file.ts' } });

    const result = agentMsgToUI({
      role: 'tool_result',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'file content here' }],
      isError: false,
    }, map);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    expect(result[0].toolName).toBe('read');
    expect(result[0].toolInput).toBe('file.ts');
    expect(result[0].content).toBe('file content here');
  });

  it('converts custom extension message types', () => {
    const result = agentMsgToUI({
      role: 'custom',
      customType: 'mermaid',
      display: '```mermaid\ngraph TD\n```',
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('notice');
    expect(result[0].customType).toBe('mermaid');
  });

  it('returns empty array for unknown role without customType', () => {
    const result = agentMsgToUI({ role: 'unknown_role', content: 'something' });
    expect(result).toHaveLength(0);
  });

  it('returns empty array for null/undefined input', () => {
    expect(agentMsgToUI(null)).toEqual([]);
    expect(agentMsgToUI(undefined)).toEqual([]);
  });
});

describe('reconnectDelay', () => {
  it('returns at least 500ms', () => {
    expect(reconnectDelay(0)).toBeGreaterThanOrEqual(500);
  });

  it('returns ~1000ms for attempt 0', () => {
    for (let i = 0; i < 100; i++) {
      const d = reconnectDelay(0);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });

  it('doubles each attempt up to 30s cap', () => {
    // Attempt 1: ~2000ms
    const d1 = reconnectDelay(1);
    expect(d1).toBeGreaterThanOrEqual(1500);
    expect(d1).toBeLessThanOrEqual(2500);

    // Attempt 2: ~4000ms
    const d2 = reconnectDelay(2);
    expect(d2).toBeGreaterThanOrEqual(3500);
    expect(d2).toBeLessThanOrEqual(4500);

    // Attempt 5: capped at ~30000ms
    const d5 = reconnectDelay(5);
    expect(d5).toBeGreaterThanOrEqual(29500);
    expect(d5).toBeLessThanOrEqual(30500);
  });

  it('never goes below 30s cap after enough attempts', () => {
    for (let i = 5; i < 20; i++) {
      const d = reconnectDelay(i);
      expect(d).toBeGreaterThanOrEqual(29500);
      expect(d).toBeLessThanOrEqual(30500);
    }
  });
});

describe('rawMessagesToUI', () => {
  it('converts a list of messages with tool call tracking', () => {
    const raw = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'config.json' } },
        ],
      },
      {
        role: 'tool_result',
        toolCallId: 'tc1',
        content: [{ type: 'text', text: '{"key": "value"}' }],
      },
    ];
    const result = rawMessagesToUI(raw);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Let me check');
    expect(result[1].role).toBe('tool');
    expect(result[1].toolName).toBe('read');
    expect(result[1].toolInput).toBe('config.json');
  });

  it('handles empty message list', () => {
    expect(rawMessagesToUI([])).toEqual([]);
  });

  it('filters null entries', () => {
    const result = rawMessagesToUI([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(result).toHaveLength(1);
  });
});
