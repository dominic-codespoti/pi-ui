import { describe, expect, test } from 'vitest';
import {
  trimMessagesForWire,
  boundMessagesForWire,
  MAX_WIRE_BLOCK_CHARS,
  MIN_WIRE_BLOCK_CHARS,
} from '../wire-messages';

const big = 'x'.repeat(MAX_WIRE_BLOCK_CHARS + 5_000);

describe('trimMessagesForWire', () => {
  test('returns the same array identity when nothing exceeds the cap', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(trimMessagesForWire(messages)).toBe(messages);
  });

  test('truncates oversized string content with a marker', () => {
    const messages = [{ role: 'user', content: big }];
    const result = trimMessagesForWire(messages);
    const first = result[0] as { content: string };
    expect(first.content.length).toBeLessThan(big.length);
    expect(first.content).toContain('truncated for transfer');
  });

  test('truncates oversized text and thinking blocks, keeps small siblings intact', () => {
    const small = { type: 'text', text: 'small' };
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: big }, small, { type: 'text', text: big }],
      },
    ];
    const result = trimMessagesForWire(messages);
    const msg = result[0] as { content: { type: string; text?: string; thinking?: string }[] };
    expect(msg.content[0].thinking).toContain('truncated for transfer');
    expect(msg.content[0].thinking!.length).toBeLessThan(big.length);
    expect(msg.content[1]).toBe(small);
    expect(msg.content[2].text).toContain('truncated for transfer');
  });

  test('never mutates the input messages', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: big }] }];
    trimMessagesForWire(messages);
    expect(messages[0].content[0].thinking).toBe(big);
  });

  test('respects a custom cap', () => {
    const messages = [{ role: 'user', content: 'abcdef' }];
    const result = trimMessagesForWire(messages, 3);
    const first = result[0] as { content: string };
    expect(first.content.startsWith('abc\n')).toBe(true);
  });

  test('passes through non-object and content-less entries untouched', () => {
    const messages = [null, 42, { role: 'system' }, { content: { nested: true } }];
    expect(trimMessagesForWire(messages)).toBe(messages);
  });
});

describe('boundMessagesForWire', () => {
  test('returns the same array identity when nothing exceeds default caps', () => {
    const msg1 = { role: 'user', content: 'hello' };
    const msg2 = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    const messages = [msg1, msg2];
    const result = boundMessagesForWire(messages);
    expect(result).toBe(messages);
    expect(result[0]).toBe(msg1);
    expect(result[1]).toBe(msg2);
  });

  test('maintains exact count and order invariance even under tiny budgets', () => {
    const messages = [
      null,
      { role: 'user', content: 'first message' },
      42,
      { role: 'assistant', content: [{ type: 'text', text: 'second message' }] },
      { role: 'user', content: 'third message' },
    ];

    const result = boundMessagesForWire(messages, {
      blockCap: 10,
      messageCap: 10,
      totalBudget: 15,
    });

    expect(result.length).toBe(messages.length);
    expect(result[0]).toBeNull();
    expect(result[2]).toBe(42);
    expect((result[1] as { role: string }).role).toBe('user');
    expect((result[3] as { role: string }).role).toBe('assistant');
    expect((result[4] as { role: string }).role).toBe('user');
  });

  test('allocates budget newest-first (last message keeps full text while first gets floored)', () => {
    const textA = 'A'.repeat(600);
    const textB = 'B'.repeat(600);
    const textC = 'C'.repeat(600);

    const messages = [
      { role: 'user', content: textA },
      { role: 'assistant', content: [{ type: 'text', text: textB }] },
      { role: 'user', content: textC },
    ];

    // totalBudget 600 allows msg 2 (index 2) to consume 600, leaving 0 for older messages.
    // Older messages get MIN_WIRE_BLOCK_CHARS (512).
    const result = boundMessagesForWire(messages, {
      blockCap: 1000,
      messageCap: 1000,
      totalBudget: 600,
    });

    const newest = result[2] as { content: string };
    const middle = result[1] as { content: { type: string; text: string }[] };
    const oldest = result[0] as { content: string };

    expect(newest.content).toBe(textC);
    expect(middle.content[0].text.startsWith('B'.repeat(MIN_WIRE_BLOCK_CHARS))).toBe(true);
    expect(middle.content[0].text).toContain('truncated for transfer');
    expect(oldest.content.startsWith('A'.repeat(MIN_WIRE_BLOCK_CHARS))).toBe(true);
    expect(oldest.content).toContain('truncated for transfer');
  });

  test('messageCap clamps one fat message across multiple blocks', () => {
    const block1 = '1'.repeat(100);
    const block2 = '2'.repeat(100);

    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: block1 },
          { type: 'text', text: block2 },
        ],
      },
    ];

    // messageCap 50, 2 blocks -> effectiveBlockCap for block 1 = min(1000, floor(50/2)) = 25.
    // Remaining message cap becomes 50 - 25 = 25. Effective cap for block 2 = min(1000, floor(25/1)) = 25.
    const result = boundMessagesForWire(messages, {
      blockCap: 1000,
      messageCap: 50,
      totalBudget: 1000,
    });

    const msg = result[0] as { content: { thinking?: string; text?: string }[] };
    expect(msg.content[0].thinking?.startsWith('1'.repeat(25))).toBe(true);
    expect(msg.content[0].thinking).toContain('truncated for transfer');
    expect(msg.content[1].text?.startsWith('2'.repeat(25))).toBe(true);
    expect(msg.content[1].text).toContain('truncated for transfer');
  });

  test('exhaustion floors older messages to MIN_WIRE_BLOCK_CHARS', () => {
    const text = 'Z'.repeat(1000);
    const messages = [
      { role: 'user', content: text },
      { role: 'assistant', content: text },
    ];

    const result = boundMessagesForWire(messages, {
      blockCap: 80_000,
      messageCap: 128_000,
      totalBudget: 500, // less than text.length of newest
    });

    const newest = result[1] as { content: string };
    const oldest = result[0] as { content: string };

    // Newest is capped at messageCap/blockCap (80_000), keeping 1000 chars and exhausting totalBudget.
    expect(newest.content).toBe(text);
    // Oldest sees remaining budget <= 0, so it gets MIN_WIRE_BLOCK_CHARS (512).
    expect(oldest.content.startsWith('Z'.repeat(MIN_WIRE_BLOCK_CHARS))).toBe(true);
    expect(oldest.content).toContain('truncated for transfer');
  });

  test('maintains COW identity for untouched messages', () => {
    const touched = { role: 'user', content: 'X'.repeat(600) };
    const untouched = { role: 'user', content: 'short' };
    const nonObject = 'skip-me';

    const messages = [untouched, nonObject, touched];
    const result = boundMessagesForWire(messages, {
      blockCap: 100,
      messageCap: 100,
      totalBudget: 500,
    });

    expect(result[0]).toBe(untouched);
    expect(result[1]).toBe(nonObject);
    expect(result[2]).not.toBe(touched);
  });

  test('includes standard truncation notice', () => {
    const messages = [{ role: 'user', content: 'Y'.repeat(600) }];
    const result = boundMessagesForWire(messages, { blockCap: 50 });
    const first = result[0] as { content: string };
    expect(first.content).toContain(
      '… [pi-ui: 550 characters truncated for transfer — full text is preserved in the session file]'
    );
  });

  test('defaults match exported constants and contracts', () => {
    expect(MAX_WIRE_BLOCK_CHARS).toBe(80_000);
    expect(MIN_WIRE_BLOCK_CHARS).toBe(512);

    const huge = 'H'.repeat(MAX_WIRE_BLOCK_CHARS + 100);
    const messages = [{ role: 'user', content: huge }];
    const result = boundMessagesForWire(messages);
    const first = result[0] as { content: string };
    expect(first.content.startsWith('H'.repeat(MAX_WIRE_BLOCK_CHARS))).toBe(true);
  });
});
