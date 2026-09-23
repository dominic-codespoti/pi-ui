import { HStack, Markdown, SelectList } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'hstack-layout',
  title: 'Place a summary beside actionable choices',
  surface: 'custom',
  expected: 'container',
  factory: (_tui, theme, _keybindings, done) => {
    // #region published
    const summary = new Markdown(
      '### Deploy\n\nChoose a rollout strategy for the current release.',
      1,
      0,
      {
        heading: (s) => theme.fg('accent', s),
        link: (s) => s,
        linkUrl: (s) => s,
        code: (s) => s,
        codeBlock: (s) => s,
        codeBlockBorder: (s) => s,
        quote: (s) => s,
        quoteBorder: (s) => s,
        hr: (s) => s,
        listBullet: (s) => s,
        bold: (s) => theme.bold(s),
        italic: (s) => s,
        strikethrough: (s) => s,
        underline: (s) => s,
      }
    );
    const choices = new SelectList(
      [
        { value: 'canary', label: 'Canary', description: 'Start with a small group' },
        { value: 'all', label: 'All users', description: 'Roll out immediately' },
      ],
      6,
      {
        selectedPrefix: (s) => theme.fg('accent', s),
        selectedText: (s) => theme.fg('accent', s),
        description: (s) => theme.fg('muted', s),
        scrollInfo: (s) => theme.fg('dim', s),
        noMatch: (s) => theme.fg('warning', s),
      }
    );
    choices.onSelect = (item) => done(item.value);
    return new HStack([summary, choices]);
    // #endregion published
  },
} satisfies ExampleModule;
