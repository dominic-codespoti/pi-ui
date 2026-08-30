import { marked, type RendererObject, type TokenizerAndRendererExtension } from 'marked';
import { renderLatex } from '@earendil-works/pi-tui/dist/latex.js';
import type { LanguageFn } from 'highlight.js';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';

// Eager-register the 4 most common languages — covers ~85% of code blocks in agent output.
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);

// Lazy registry for less common languages — imported on first use, cached.
const _lazyLangs: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  ts: () => import('highlight.js/lib/languages/typescript'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  yml: () => import('highlight.js/lib/languages/yaml'),
  xml: () => import('highlight.js/lib/languages/xml'),
  html: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  sql: () => import('highlight.js/lib/languages/sql'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  md: () => import('highlight.js/lib/languages/markdown'),
  rust: () => import('highlight.js/lib/languages/rust'),
  rs: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  cs: () => import('highlight.js/lib/languages/csharp'),
};

const _lazyLoaders = new Map<string, Promise<void>>();

/** Notified with the raw fence-language token whenever a lazy hljs language
 *  finishes loading — lets callers that memoized pre-registration HTML
 *  re-render once real highlighting becomes available. */
const _langReadyListeners = new Set<(lang: string) => void>();

/** Subscribe to lazy-language-ready notifications. Returns an unsubscribe fn. */
export function onLangRegistered(listener: (lang: string) => void): () => void {
  _langReadyListeners.add(listener);
  return () => _langReadyListeners.delete(listener);
}

/** Resolves once `lang` finishes loading (immediately if already loaded, eager, or unknown). */
export function whenLangReady(lang: string): Promise<void> {
  return _lazyLoaders.get(lang) ?? Promise.resolve();
}

/** Ensure a lazy hljs language is loaded — fire-and-forget dynamic import. */
function ensureLang(lang: string): void {
  if (_lazyLoaders.has(lang) || hljs.getLanguage(lang)) return;
  const loader = _lazyLangs[lang];
  if (!loader) return;
  const prom = loader()
    .then((mod) => {
      // Each hljs language module exports a register function as `default`
      // Register the canonical name and any aliases
      const aliases: Record<string, string> = {
        typescript: 'typescript',
        ts: 'typescript',
        yaml: 'yaml',
        yml: 'yaml',
        xml: 'xml',
        html: 'xml',
        css: 'css',
        sql: 'sql',
        markdown: 'markdown',
        md: 'markdown',
        rust: 'rust',
        rs: 'rust',
        go: 'go',
        csharp: 'csharp',
        cs: 'csharp',
      };
      const canonical = aliases[lang] ?? lang;
      hljs.registerLanguage(canonical, mod.default as LanguageFn);
      for (const listener of _langReadyListeners) listener(lang);
    })
    .catch(() => {
      _lazyLoaders.delete(lang);
    });
  _lazyLoaders.set(lang, prom);
}

/** Escape HTML special characters for safe insertion into attribute values
 *  AND element text. `<`/`>` must be escaped too — escAttr output is
 *  interpolated into element context (e.g. the code-block language label),
 *  where unescaped `<`/`>` would break out of the element (XSS). */
function escAttr(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

/** Escape HTML special characters for safe insertion into element text. */
function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** When true, code blocks are escaped without hljs — used while a message is streaming. */
let _skipHighlight = false;
/** Notified when a render encounters a fence language that is still loading
 *  lazily — lets callers re-render just the messages that need it once the
 *  grammar registers (see `renderMarkdown` opts). */
let _onUnresolvedLang: ((lang: string) => void) | null = null;

/** Highlight code or fall back to plain-escaped text if language unknown. */
function highlight(code: string, lang: string): string {
  // Kick off lazy dynamic import for less common languages
  if (lang) {
    const lazyPending = !hljs.getLanguage(lang) && lang in _lazyLangs;
    ensureLang(lang);
    if (lazyPending) _onUnresolvedLang?.(lang);
  }
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through
    }
  }
  // No language specified — try auto-detect on longer snippets
  if (!lang && code.length > 40) {
    try {
      return hljs.highlightAuto(code, [
        'javascript',
        'typescript',
        'python',
        'bash',
        'json',
        'yaml',
        'html',
        'css',
        'sql',
        'rust',
        'go',
        'csharp',
      ]).value;
    } catch {
      // fall through
    }
  }
  // Plain escape
  return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const renderer: RendererObject = {
  // Strip raw HTML — return escaped text instead of passing arbitrary HTML through.
  html({ text }: { text: string }) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Code blocks — rounded container, header with optional language label + copy button.
  code({ text, lang }: { text: string; lang?: string }) {
    const safeLang = (lang ?? '').toLowerCase().split(/\s+/)[0]; // strip "ts twoslash" etc.
    // Suppress generic/empty labels — only show real language identifiers
    const showLabel =
      safeLang && safeLang !== 'text' && safeLang !== 'plaintext' && safeLang !== 'plain';
    const langLabel = showLabel ? escAttr(safeLang) : '';
    const highlighted = _skipHighlight ? escHtml(text) : highlight(text, safeLang);
    const langSpan = langLabel ? `<span class="code-block-lang">${langLabel}</span>` : '';
    return (
      `<div class="code-block">` +
      `<div class="code-block-header">` +
      langSpan +
      `<button class="code-copy-btn" type="button" aria-label="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` +
      `</div>` +
      `<pre class="code-block-pre"><code class="hljs">${highlighted}</code></pre>` +
      `</div>`
    );
  },

  // Inline code: exact file refs become links. Everything else stays code.
  codespan({ text }: { text: string }) {
    const raw = text.trim();
    const match = raw.match(
      /^((?:\.{1,2}\/|~\/)?(?:[\w.+()-]+\/)+[\w.+()-]+\.[\w]{1,10})(?::(\d+)(?:-(\d+))?)?$/
    );
    if (match && isFilePath(match[1])) {
      const path = match[1];
      const line = match[2] ? parseInt(match[2]) : undefined;
      const endLine = match[3] ? parseInt(match[3]) : undefined;
      return renderFileLink(path, line, endLine);
    }
    return `<code>${escHtml(text)}</code>`;
  },

  // Links — validate URL to prevent XSS
  link({ href, text }: { href?: string; text: string }) {
    const safeHref = sanitizeUrl(href);
    if (!safeHref) return escHtml(text);
    return `<a href="${escAttr(safeHref)}" target="_blank" rel="noopener noreferrer">${escHtml(text)}</a>`;
  },

  // Images — validate URL to prevent XSS
  image({ href, text }: { href?: string; text: string }) {
    const safeSrc = sanitizeUrl(href);
    if (!safeSrc) return escHtml(text);
    return `<img src="${escAttr(safeSrc)}" alt="${escAttr(text)}" loading="lazy" />`;
  },
};

function renderFileLink(path: string, line?: number, endLine?: number): string {
  const lineLabel = line ? `:${line}${endLine ? `-${endLine}` : ''}` : '';
  return `<a class="file-link" href="#" data-filepath="${escAttr(path)}" data-fileline="${line ?? ''}" aria-label="Open file ${escAttr(path)}${lineLabel}">${escHtml(path)}${lineLabel}</a>`;
}

/**
 * Validate a URL for safe use in link/image attributes.
 * Allows http:, https:, mailto:, and relative URLs.
 * Rejects javascript:, data:, vbscript: and other dangerous schemes.
 */
function sanitizeUrl(url: string | undefined): string {
  if (!url) return '';
  // Relative URLs are safe
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('#'))
    return url;
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') return url;
  } catch {
    // URL parse failure — treat as unsafe
  }
  return '';
}

/** Set of extensions to treat as file paths */
const FILE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'pyi',
  'pyx',
  'rs',
  'go',
  'cs',
  'java',
  'kt',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'json',
  'jsonl',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'html',
  'htm',
  'xml',
  'svg',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
  'styl',
  'sql',
  'graphql',
  'md',
  'mdx',
  'txt',
  'rst',
  'log',
  'env',
  'gitignore',
  'dockerignore',
  'env.local',
  'env.production',
]);

function isFilePath(raw: string): boolean {
  const ext = raw.split('.').pop()?.toLowerCase() ?? '';
  return FILE_EXTS.has(ext);
}

/** Pattern: explicit file paths with at least one directory segment + optional line suffix. */
const FILE_PATH_RE =
  /(?<![:\w/`])((?:\.{1,2}\/|~\/)?(?:[\w.+()-]+\/)+[\w.+()-]+\.[\w]{1,10})(?::(\d+)(?:-(\d+))?)?(?![:\w/`])/g;

const fileLinkExtension: TokenizerAndRendererExtension = {
  name: 'fileLink',
  level: 'inline',
  start(src) {
    return src.match(FILE_PATH_RE)?.index;
  },
  tokenizer(src) {
    FILE_PATH_RE.lastIndex = 0;
    const match = FILE_PATH_RE.exec(src);
    if (!match) return;
    const raw = match[0];
    const path = match[1];
    if (path.startsWith('/')) return;
    if (!isFilePath(path)) return;
    return {
      type: 'fileLink',
      raw,
      path,
      line: match[2] ? parseInt(match[2]) : undefined,
      endLine: match[3] ? parseInt(match[3]) : undefined,
    };
  },
  renderer(token) {
    const t = token as unknown as { path: string; line?: number; endLine?: number };
    return renderFileLink(t.path, t.line, t.endLine);
  },
};

type LatexToken = {
  type: 'latex' | 'latexBlock';
  raw: string;
  text: string;
};

type LatexMatch = {
  raw: string;
  text: string;
  end: number;
  display: boolean;
};

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && source[position] === '\\'; position--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
  let index = source.indexOf(closing, start);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(closing, index + closing.length);
  }
  return index;
}

function matchInlineLatex(source: string, start: number): LatexMatch | undefined {
  let opening: string;
  let closing: string;
  let display = false;

  if (source.startsWith('$$', start)) {
    opening = '$$';
    closing = '$$';
    display = true;
  } else if (source.startsWith('\\(', start)) {
    opening = '\\(';
    closing = '\\)';
  } else if (source.startsWith('\\[', start)) {
    opening = '\\[';
    closing = '\\]';
    display = true;
  } else if (source[start] === '$' && !isEscaped(source, start) && source[start + 1] !== '$') {
    if (/\s/.test(source[start + 1] ?? '')) return undefined;
    opening = '$';
    closing = '$';
  } else {
    return undefined;
  }

  if (source[start] === '\\' && isEscaped(source, start)) return undefined;
  const closingIndex = findClosingDelimiter(source, closing, start + opening.length);
  if (closingIndex < 0) return undefined;

  const text = source.slice(start + opening.length, closingIndex);
  const after = source.slice(closingIndex + closing.length);
  if (!text || text.includes('\n')) return undefined;
  if (
    opening === '$' &&
    (/\s$/.test(text) ||
      /^\d/.test(after) ||
      (/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(text) &&
        /^[A-Za-z_][A-Za-z0-9_]*/.test(after)) ||
      text.includes('`'))
  ) {
    return undefined;
  }

  const end = closingIndex + closing.length;
  return { raw: source.slice(start, end), text, end, display };
}

const latexBlockExtension: TokenizerAndRendererExtension = {
  name: 'latexBlock',
  level: 'block',
  start(source) {
    const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
    return match ? match.index + (match[0].startsWith('\n') ? 1 : 0) : undefined;
  },
  tokenizer(source) {
    const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
    if (dollarMatch?.[1]) {
      return { type: 'latexBlock', raw: dollarMatch[0], text: dollarMatch[1].trim() };
    }
    const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
    if (bracketMatch?.[1]) {
      return { type: 'latexBlock', raw: bracketMatch[0], text: bracketMatch[1].trim() };
    }
    return undefined;
  },
  renderer(token) {
    const latex = token as unknown as LatexToken;
    const raw = latex.raw.trim();
    const rendered = renderLatex(latex.text, { display: true });
    return `<div class="math-block whitespace-pre-wrap">${escHtml(rendered ?? raw)}</div>`;
  },
};

const latexInlineExtension: TokenizerAndRendererExtension = {
  name: 'latex',
  level: 'inline',
  start(source) {
    const indices = [source.indexOf('$'), source.indexOf('\\('), source.indexOf('\\[')].filter(
      (index) => index >= 0
    );
    return indices.length > 0 ? Math.min(...indices) : undefined;
  },
  tokenizer(source) {
    const match = matchInlineLatex(source, 0);
    if (!match) return undefined;
    return { type: 'latex', raw: match.raw, text: match.text };
  },
  renderer(token) {
    const latex = token as unknown as LatexToken;
    return `<span class="math-inline">${escHtml(renderLatex(latex.text) ?? latex.raw)}</span>`;
  },
};

/**
 * Convert complete math expressions in the streaming fast path without
 * parsing the rest of the Markdown. Code spans are copied verbatim so a
 * literal `$...$` example does not change while the response streams.
 */
function renderCompleteLatex(source: string): string {
  let result = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] === '`') {
      const fence = /^`+/.exec(source.slice(index))?.[0];
      if (fence) {
        const close = source.indexOf(fence, index + fence.length);
        if (close >= 0) {
          const end = close + fence.length;
          result += source.slice(index, end);
          index = end;
          continue;
        }
      }
    }

    const match = matchInlineLatex(source, index);
    if (match) {
      result += renderLatex(match.text, { display: match.display }) ?? match.raw;
      index = match.end;
      continue;
    }
    result += source[index];
    index++;
  }
  return result;
}

marked.use({
  breaks: true,
  renderer,
  extensions: [fileLinkExtension, latexBlockExtension, latexInlineExtension],
});

/** Above this size, marked+hljs parsing stalls the main thread (seconds on
 *  mobile) and the throttled re-render during streaming compounds it — fall
 *  back to escaped plain text so a runaway reasoning/text block can't hang
 *  the tab. */
const MAX_MARKDOWN_CHARS = 150_000;

/**
 * Convert a markdown string to sanitised HTML suitable for `{@html ...}`.
 * Synchronous (no async extension loaded). Oversized inputs are rendered as
 * escaped plain text instead of parsed markdown.
 */
export function renderMarkdown(
  src: string,
  opts?: { skipHighlight?: boolean; onUnresolvedLang?: (lang: string) => void }
): string {
  if (src.length > MAX_MARKDOWN_CHARS) {
    return `<pre class="whitespace-pre-wrap break-words">${escHtml(src)}</pre>`;
  }
  const prev = _skipHighlight;
  const prevLangHook = _onUnresolvedLang;
  _skipHighlight = opts?.skipHighlight ?? false;
  _onUnresolvedLang = opts?.onUnresolvedLang ?? null;
  try {
    return marked.parse(src) as string;
  } finally {
    _skipHighlight = prev;
    _onUnresolvedLang = prevLangHook;
  }
}

/** FNV-1a 32-bit hash over string content. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const MAX_MEMO_ENTRIES = 300;
const MAX_MEMO_CHARS = 4_000_000;
const _memoCache = new Map<string, string>();
let _memoTotalChars = 0;

function evictOldest(): void {
  const oldestKey = _memoCache.keys().next().value;
  if (oldestKey === undefined) return;
  const oldestVal = _memoCache.get(oldestKey);
  _memoCache.delete(oldestKey);
  if (oldestVal !== undefined) {
    _memoTotalChars -= oldestVal.length;
  }
}

/**
 * Memoized markdown render wrapping `renderMarkdown`.
 * Cache key is `${content.length}:${fnv1a(content)}`.
 * LRU via Map delete+reinsert on hit.
 * Bounds: max 300 entries AND max 4,000,000 total cached HTML chars.
 */
export function memoizedRenderMarkdown(content: string): string {
  const key = `${content.length}:${fnv1a(content)}`;
  const cached = _memoCache.get(key);
  if (cached !== undefined) {
    _memoCache.delete(key);
    _memoCache.set(key, cached);
    return cached;
  }

  const html = renderMarkdown(content);
  _memoCache.set(key, html);
  _memoTotalChars += html.length;

  while (_memoCache.size > MAX_MEMO_ENTRIES || _memoTotalChars > MAX_MEMO_CHARS) {
    evictOldest();
  }

  return html;
}

/**
 * Streaming preview — escaped plain text with preserved whitespace. Parsing
 * the full accumulated markdown on every token delta (the streaming hot spot)
 * stalls the main thread on long responses; this only resolves complete math
 * expressions before escaping, leaving the rest as plain text until final render.
 */
export function renderStreamingPreview(src: string): string {
  return `<pre class="whitespace-pre-wrap break-words">${escHtml(renderCompleteLatex(src))}</pre>`;
}

/**
 * Highlight a code snippet with hljs and return HTML-safe string for `{@html ...}`.
 * Falls back to plain HTML-escaped text if lang is unknown or empty.
 */
export function highlightCode(code: string, lang: string): string {
  return highlight(code, lang);
}
