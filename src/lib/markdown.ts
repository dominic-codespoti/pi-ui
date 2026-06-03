import { marked, type RendererObject, type TokenizerAndRendererExtension } from 'marked';
import hljs from 'highlight.js/lib/core';

// Register the languages most likely to appear in LLM output
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';       // html
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import csharp from 'highlight.js/lib/languages/csharp';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);

/** Escape HTML special characters for safe insertion into attribute values. */
function escAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Escape HTML special characters for safe insertion into element text. */
function escHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Highlight code or fall back to plain-escaped text if language unknown. */
function highlight(code: string, lang: string): string {
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
      return hljs.highlightAuto(code, ['javascript', 'typescript', 'python', 'bash', 'json', 'yaml', 'html', 'css', 'sql', 'rust', 'go', 'csharp']).value;
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
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  // Code blocks — ChatGPT-style: rounded container, header with language + copy button.
  code({ text, lang }: { text: string; lang?: string }) {
    const safeLang = (lang ?? '').toLowerCase().split(/\s+/)[0]; // strip "ts twoslash" etc.
    const langLabel = safeLang ? escAttr(safeLang) : 'text';
    const highlighted = highlight(text, safeLang);
    return (
      `<div class="code-block">` +
        `<div class="code-block-header">` +
          `<span class="code-block-lang">${langLabel}</span>` +
          `<button class="code-copy-btn" type="button" aria-label="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` +
      `</div>` +
      `<pre class="code-block-pre"><code class="hljs">${highlighted}</code></pre>` +
      `</div>`
    );
  },

  // Inline code: exact file refs become links. Everything else stays code.
  codespan({ text }: { text: string }) {
    const raw = text.trim();
    const match = raw.match(/^((?:\.{1,2}\/|~\/)?(?:[\w.+()-]+\/)+[\w.+()-]+\.[\w]{1,10})(?::(\d+)(?:-(\d+))?)?$/);
    if (match && isFilePath(match[1])) {
      const path = match[1];
      const line = match[2] ? parseInt(match[2]) : undefined;
      const endLine = match[3] ? parseInt(match[3]) : undefined;
      return renderFileLink(path, line, endLine);
    }
    return `<code>${text}</code>`;
  },

};

function renderFileLink(path: string, line?: number, endLine?: number): string {
  const lineLabel = line ? `:${line}${endLine ? `-${endLine}` : ''}` : '';
  return `<a class="file-link" href="#" data-filepath="${escAttr(path)}" data-fileline="${line ?? ''}" aria-label="Open file ${escAttr(path)}${lineLabel}">${escHtml(path)}${lineLabel}</a>`;
}

/** Set of extensions to treat as file paths */
const FILE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyi', 'pyx',
  'rs', 'go', 'cs', 'java', 'kt', 'rb', 'php',
  'sh', 'bash', 'zsh', 'fish',
  'json', 'jsonl', 'json5',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'css', 'scss', 'less', 'styl',
  'sql', 'graphql',
  'md', 'mdx', 'txt', 'rst', 'log',
  'env', 'gitignore', 'dockerignore',
  'env.local', 'env.production',
]);

function isFilePath(raw: string): boolean {
  const ext = raw.split('.').pop()?.toLowerCase() ?? '';
  return FILE_EXTS.has(ext);
}

/** Pattern: explicit file paths with at least one directory segment + optional line suffix. */
const FILE_PATH_RE = /(?<![:\w/`])((?:\.{1,2}\/|~\/)?(?:[\w.+()-]+\/)+[\w.+()-]+\.[\w]{1,10})(?::(\d+)(?:-(\d+))?)?(?![:\w/`])/g;

const fileLinkExtension: TokenizerAndRendererExtension = {
  name: 'fileLink',
  level: 'inline',
  start(src) { return src.match(FILE_PATH_RE)?.index; },
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

marked.use({
  breaks: true,
  renderer,
  extensions: [fileLinkExtension],
});

/**
 * Convert a markdown string to sanitised HTML suitable for `{@html ...}`.
 * Synchronous (no async extension loaded).
 */
export function renderMarkdown(src: string): string {
  return marked.parse(src) as string;
}

/**
 * Highlight a code snippet with hljs and return HTML-safe string for `{@html ...}`.
 * Falls back to plain HTML-escaped text if lang is unknown or empty.
 */
export function highlightCode(code: string, lang: string): string {
  return highlight(code, lang);
}
