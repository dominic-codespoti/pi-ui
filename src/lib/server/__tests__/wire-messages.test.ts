import { describe, expect, test } from 'vitest';
import { trimMessagesForWire, MAX_WIRE_BLOCK_CHARS } from '../wire-messages';

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
