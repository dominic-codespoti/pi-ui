import { Markdown } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'markdown-summary',
  title: 'Show a formatted change summary',
  surface: 'custom',
  expected: 'markdown',
  factory: (_tui, theme) => {
    // #region published
    return new Markdown(
      '### Changes\n\n- Updated the cache\n- Added a **fast** lookup path',
      1,
      0,
      {
        heading: (s) => theme.fg('accent', s),
        link: (s) => theme.fg('accent', s),
        linkUrl: (s) => theme.fg('dim', s),
        code: (s) => theme.fg('warning', s),
        codeBlock: (s) => s,
        codeBlockBorder: (s) => theme.fg('muted', s),
        quote: (s) => theme.fg('muted', s),
        quoteBorder: (s) => theme.fg('muted', s),
        hr: (s) => theme.fg('dim', s),
        listBullet: (s) => theme.fg('accent', s),
        bold: (s) => theme.bold(s),
        italic: (s) => s,
        strikethrough: (s) => s,
        underline: (s) => s,
      }
    );
    // #endregion published
  },
} satisfies ExampleModule;
