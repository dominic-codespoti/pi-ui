import { describe, it, expect } from 'vitest';
import { renderMarkdown, highlightCode, onLangRegistered, whenLangReady } from '../markdown';

describe('renderMarkdown', () => {
  it('renders plain text', () => {
    const result = renderMarkdown('hello world');
    expect(result).toContain('hello world');
  });

  it('strips raw HTML tags', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('highlights code blocks with known language', () => {
    const result = renderMarkdown('```ts\nconst x: number = 1;\n```');
    expect(result).toContain('hljs');
    expect(result).toContain('const');
  });

  it('falls back to plain text for unknown language', () => {
    const md = '```unknown_lang\nsome code\n```';
    const result = renderMarkdown(md);
    expect(result).toContain('some code');
    expect(result).toContain('code-block');
  });

  it('renders inline code', () => {
    const result = renderMarkdown('use `code` here');
    expect(result).toContain('<code>');
    expect(result).toContain('code');
  });

  it('file path inline code is rendered as a link', () => {
    const result = renderMarkdown('check `src/foo.ts`');
    expect(result).toContain('file-link');
    expect(result).toContain('data-filepath="src/foo.ts"');
  });

  it('file path with line number renders as a link', () => {
    const result = renderMarkdown('see `src/bar.ts:42`');
    expect(result).toContain('data-fileline="42"');
  });

  it('absolute paths are not rendered as file links', () => {
    const result = renderMarkdown('`/etc/passwd`');
    expect(result).not.toContain('file-link');
  });

  it('renders bold text', () => {
    const result = renderMarkdown('**bold**');
    expect(result).toContain('<strong>');
  });

  it('renders links with href', () => {
    const result = renderMarkdown('[click](https://example.com)');
    expect(result).toContain('href="https://example.com"');
  });

  it('breaks lines on single newline (breaks: true)', () => {
    const result = renderMarkdown('line1\nline2');
    expect(result).toContain('<br>');
  });
});

describe('highlightCode', () => {
  it('highlights TypeScript code', async () => {
    // Ensure the lazy hljs language import is complete before testing
    await import('highlight.js/lib/languages/typescript');
    const result = highlightCode('const x: number = 1;', 'ts');
    expect(result).toContain('hljs');
    expect(result).toContain('keyword');
  });

  it('falls back to escaped text for unknown language', () => {
    const result = highlightCode('<tag>', 'nosuch');
    expect(result).not.toContain('<tag>');
    expect(result).toContain('&lt;tag&gt;');
  });

  it('falls back to plain text for short snippets with no lang', () => {
    const result = highlightCode('const x = 1;', '');
    // Short snippets (< 40 chars) skip auto-detect and return escaped text
    expect(result).not.toContain('hljs');
    expect(result).toContain('const x = 1;');
  });
});

describe('lazy language race (onLangRegistered / whenLangReady)', () => {
  it('falls back to escaped text on first use, then highlights once the language loads', async () => {
    // 'yaml' is lazy-loaded and untouched by any earlier test in this file — the
    // first call must hit the real fire-and-forget import path in ensureLang().
    const before = highlightCode('key: value', 'yaml');
    expect(before).toBe('key: value');

    await whenLangReady('yaml');

    const after = highlightCode('key: value', 'yaml');
    expect(after).toContain('hljs-attr');
  });

  it('notifies subscribers with the requested language token once it registers', async () => {
    const seen: string[] = [];
    const unsubscribe = onLangRegistered((lang) => seen.push(lang));
    highlightCode('fn main() {}', 'rust');
    await whenLangReady('rust');
    unsubscribe();
    expect(seen).toContain('rust');
  });
});
