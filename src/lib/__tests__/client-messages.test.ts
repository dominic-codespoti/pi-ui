import { describe, it, expect } from 'vitest';
import {
  uid,
  extractTextContent,
  formatToolInput,
  agentMsgToUI,
  rawMessagesToUI,
  reconnectDelay,
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
    expect(formatToolInput('read', { path: 'src/main.ts', offset: 10, limit: 20 })).toBe(
      'main.ts:10–29'
    );
  });

  it('formats write file', () => {
    expect(formatToolInput('write', { path: '/tmp/out.txt' })).toBe('out.txt');
  });

  it('formats edit file', () => {
    expect(formatToolInput('edit', { file_path: 'src/index.ts' })).toBe('index.ts');
  });

  it('formats edit with multiple edits', () => {
    expect(
      formatToolInput('edit', { file_path: 'src/index.ts', edits: [{ old: 'a' }, { old: 'b' }] })
    ).toBe('index.ts (2 edits)');
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
  it('preserves assistant block order, redacted thinking, usage, and stop metadata', () => {
    const [message] = agentMsgToUI({
      role: 'assistant',
      content: [
        { type: 'text', text: 'before' },
        { type: 'thinking', thinking: 'hidden text' },
        { type: 'thinking', redacted: true, thinkingSignature: 'never-render' },
        { type: 'text', text: 'after' },
      ],
      stopReason: 'length',
      errorMessage: 'max tokens',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 4,
        totalTokens: 15,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
      },
    });
    expect(message).toMatchObject({
      role: 'assistant',
      content: 'beforeafter',
      thinking: 'hidden text',
      redactedThinking: true,
      stopReason: 'length',
      errorMessage: 'max tokens',
      blocks: [
        { type: 'text', text: 'before' },
        { type: 'thinking', text: 'hidden text' },
        { type: 'text', text: 'after' },
      ],
      usage: {
        cacheRead: 3,
        cacheWrite: 2,
        reasoning: 4,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 },
      },
    });
    expect(JSON.stringify(message)).not.toContain('never-render');
  });

  it('converts compaction and branch summaries from session history', () => {
    expect(
      agentMsgToUI({ role: 'compactionSummary', summary: 'kept context', tokensBefore: 900 })[0]
    ).toMatchObject({ role: 'compaction_summary', summary: 'kept context', tokensBefore: 900 });
    expect(
      agentMsgToUI({ role: 'branchSummary', summary: 'branch notes', fromId: 'entry-1' })[0]
    ).toMatchObject({ role: 'branch_summary', summary: 'branch notes', fromId: 'entry-1' });
  });

  it('skips assistant messages with no displayable content', () => {
    const result = agentMsgToUI({
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call1', name: 'bash', arguments: '{}' }],
    });
    expect(result).toHaveLength(0);
  });

  it('converts bash execution messages with lifecycle details', () => {
    const result = agentMsgToUI({
      role: 'bash_execution',
      command: 'ls',
      output: 'file1\nfile2',
      exitCode: 0,
      cancelled: false,
      truncated: true,
      fullOutputPath: '/tmp/full-output.log',
      excludeFromContext: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'tool',
      toolName: 'bash',
      toolInput: '$ ls',
      isError: false,
      fullOutputPath: '/tmp/full-output.log',
      excludeFromContext: true,
      toolDetails: {
        truncation: { truncated: true },
        fullOutputPath: '/tmp/full-output.log',
        exitCode: 0,
      },
    });
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

    const result = agentMsgToUI(
      {
        role: 'tool_result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'file content here' }],
        details: {
          truncation: {
            truncated: true,
            truncatedBy: 'lines',
            totalLines: 18432,
            outputLines: 2000,
            totalBytes: 900000,
            outputBytes: 95000,
          },
        },
        isError: false,
      },
      map
    );
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    expect(result[0].toolName).toBe('read');
    expect(result[0].toolInput).toBe('file.ts');
    expect(result[0].content).toBe('file content here');
    expect(result[0].toolDetails).toMatchObject({
      truncation: { truncated: true, truncatedBy: 'lines', totalLines: 18432, outputLines: 2000 },
    });
  });
  it('preserves elided tool output metadata without synthesising content', () => {
    const map = new Map<string, { name: string; input: Record<string, unknown> }>();
    map.set('call-elided', { name: 'bash', input: { command: 'npm test' } });

    const result = agentMsgToUI(
      {
        role: 'tool_result',
        timestamp: 1234,
        toolCallId: 'call-elided',
        outputElided: true,
        outputBytes: 51239,
        isError: false,
      },
      map
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'tool',
      toolName: 'bash',
      toolCallId: 'call-elided',
      toolInput: '$ npm test',
      outputElided: true,
      outputBytes: 51239,
      content: '',
      createdAt: 1234,
    });
  });

  it('converts SDK-shaped custom extension messages', () => {
    const result = agentMsgToUI({
      role: 'custom',
      customType: 'mermaid',
      content: '```mermaid\ngraph TD\n```',
      display: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('notice');
    expect(result[0].customType).toBe('mermaid');
    expect(result[0].content).toContain('graph TD');
  });

  it('extracts custom text blocks and skips display:false messages', () => {
    const blocks = agentMsgToUI({
      role: 'custom',
      customType: 'status',
      content: [
        { type: 'text', text: 'one' },
        { type: 'image', data: 'img-data', mimeType: 'image/png' },
        { type: 'text', text: 'two' },
      ],
      display: true,
    });
    expect(blocks[0].content).toBe('onetwo');
    expect(blocks[0].images).toEqual(['data:image/png;base64,img-data']);
    expect(
      agentMsgToUI({
        role: 'custom',
        customType: 'hidden',
        content: 'secret',
        display: false,
      })
    ).toEqual([]);
  });

  it('returns empty array for unknown role without customType', () => {
    const result = agentMsgToUI({ role: 'unknown_role', content: 'something' });
    expect(result).toHaveLength(0);
  });

  it('returns empty array for null/undefined input', () => {
    expect(agentMsgToUI(null)).toEqual([]);
    expect(agentMsgToUI(undefined)).toEqual([]);
  });

  it('keeps timestamp-less history IDs deterministic across reconversion', () => {
    const history = [
      { role: 'user', content: 'same' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: 'same' },
    ];
    const first = rawMessagesToUI(history).map((message) => message.id);
    const second = rawMessagesToUI(history).map((message) => message.id);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);

    const pageHistory = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: 'last' },
    ];
    const full = rawMessagesToUI(pageHistory);
    const paged = [
      ...rawMessagesToUI(pageHistory.slice(0, 2), 0),
      ...rawMessagesToUI(pageHistory.slice(2), 2),
    ];
    expect(paged.map((message) => message.id)).toEqual(full.map((message) => message.id));
  });

  it('ignores malformed content blocks without throwing', () => {
    expect(() =>
      rawMessagesToUI([
        null,
        'scalar',
        { role: 'user', content: [null, 'bad', 42, { text: 'missing type' }] },
        { role: 'assistant', content: [null, 'bad', { type: 'text' }] },
        { role: 'tool_result', content: [null, 'bad', { type: 'text', text: 'ok' }] },
        { role: 'custom', customType: 'status', content: [null, 42] },
      ])
    ).not.toThrow();
  });

  it('collects tool calls from legacy ai messages', () => {
    const [tool] = rawMessagesToUI([
      {
        role: 'ai',
        content: [
          { type: 'toolCall', id: 'legacy-call', name: 'read', arguments: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool_result',
        toolCallId: 'legacy-call',
        content: [{ type: 'text', text: 'contents' }],
      },
    ]).filter((message) => message.role === 'tool');
    expect(tool).toMatchObject({ toolName: 'read', toolInput: 'a.ts' });
  });

  it('resolves tool result IDs through precomputed suffix aliases', () => {
    const [tool] = rawMessagesToUI([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } }],
      },
      {
        role: 'tool_result',
        toolCallId: 'provider-call-1',
        content: [{ type: 'text', text: 'ok' }],
      },
    ]).filter((message) => message.role === 'tool');
    expect(tool).toMatchObject({ toolName: 'bash', toolInput: '$ pwd' });
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
