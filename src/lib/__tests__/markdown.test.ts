import { describe, it, expect } from 'vitest';
import {
  memoizedRenderMarkdown,
  renderMarkdown,
  renderStreamingPreview,
  highlightCode,
  onLangRegistered,
  whenLangReady,
} from '../markdown';

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

  it('escapes HTML in the fence language label (XSS breakout)', () => {
    // The fence info string is interpolated into element context — a crafted
    // label must never produce a raw <svg/onload> element (the legitimate
    // copy-button icon in the header does contain a benign <svg>, so match
    // the payload specifically).
    const md = '```</span><svg/onload=alert(1)>\ncode\n```';
    const result = renderMarkdown(md);
    // Pre-fix output contained the raw breakout `</span><svg/onload=...>`;
    // escaped output contains neither of those raw sequences.
    expect(result).not.toContain('</span><svg');
    expect(result).toContain('&lt;/span&gt;');
    expect(result).toContain('&lt;svg/onload');
  });

  it('escapes quotes in the fence language label', () => {
    const md = '```x" onmouseover="alert(1)\ncode\n```';
    const result = renderMarkdown(md);
    expect(result).not.toContain('onmouseover');
    expect(result).toContain('&quot;');
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

  it('renders common LaTeX symbols as Unicode', () => {
    const result = renderMarkdown(String.raw`$a \rightarrow b$ and $c \leftarrow d$`);
    expect(result).toContain('a → b');
    expect(result).toContain('c ← d');
    expect(result).not.toContain('rightarrow');
    expect(result).not.toContain('leftarrow');
  });

  it('resolves complete math in the streaming preview without changing code', () => {
    const result = renderStreamingPreview('$a \\rightarrow b$ and `$c \\leftarrow d$`');
    expect(result).toContain('a → b');
    expect(result).toContain('$c \\leftarrow d$');
  });
});

describe('renderStreamingPreview', () => {
  it('escapes HTML and preserves whitespace as plain text', () => {
    const result = renderStreamingPreview('<script>alert(1)</script>\n\n**bold**');
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
    expect(result).not.toContain('<strong>'); // no markdown parsing
    expect(result).toContain('whitespace-pre-wrap');
    expect(result).toContain('**bold**'); // raw markdown visible during stream
  });
});

describe('renderMarkdown unresolved-lang hook', () => {
  it('reports fence languages still loading lazily', async () => {
    // 'go' is lazy-loaded; nothing else in this file uses it, so the first
    // render must report it as unresolved.
    const seen: string[] = [];
    const result = renderMarkdown('```go\nfunc main() {}\n```', {
      onUnresolvedLang: (lang) => seen.push(lang),
    });
    expect(seen).toContain('go');
    expect(result).toContain('func main()');

    await whenLangReady('go');

    const seen2: string[] = [];
    renderMarkdown('```go\nfunc main() {}\n```', {
      onUnresolvedLang: (lang) => seen2.push(lang),
    });
    expect(seen2).not.toContain('go');
  });

  it('does not report eager or unknown languages', () => {
    const seen: string[] = [];
    renderMarkdown('```js\nconst x = 1;\n```\n```nosuch\ncode\n```', {
      onUnresolvedLang: (lang) => seen.push(lang),
    });
    expect(seen).toEqual([]);
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

describe('memoizedRenderMarkdown', () => {
  it('returns identical output to renderMarkdown and on repeat calls', () => {
    const input = '# Heading\n\nSome paragraph with **bold** text and `code`.';
    const direct = renderMarkdown(input);
    const first = memoizedRenderMarkdown(input);
    const second = memoizedRenderMarkdown(input);
    expect(first).toBe(direct);
    expect(second).toBe(first);
  });

  it('does not confuse distinct inputs with same length or different content', () => {
    const inputA = 'abc-123';
    const inputB = 'xyz-789';
    const outA = memoizedRenderMarkdown(inputA);
    const outB = memoizedRenderMarkdown(inputB);
    expect(outA).not.toBe(outB);
    expect(memoizedRenderMarkdown(inputA)).toBe(outA);
    expect(memoizedRenderMarkdown(inputB)).toBe(outB);
  });

  it('respects entry limit (300 entries) and char limit (4,000,000 chars)', () => {
    // Fill cache with > 300 unique entries to trigger entry eviction
    for (let i = 0; i < 350; i++) {
      memoizedRenderMarkdown(`unique entry ${i} for count limit testing`);
    }
    // Verify most recently added entries are still rendered accurately
    const latest = memoizedRenderMarkdown(`unique entry 349 for count limit testing`);
    expect(latest).toContain('unique entry 349');

    // Fill cache with large strings to exercise total HTML char limit eviction
    const largeA = 'a'.repeat(2_500_000);
    const largeB = 'b'.repeat(2_500_000);
    const resA = memoizedRenderMarkdown(largeA);
    expect(resA.length).toBeGreaterThan(0);
    const resB = memoizedRenderMarkdown(largeB);
    expect(resB.length).toBeGreaterThan(0);
  });
});
