import { SelectList } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'select-list',
  title: 'Let the user choose a deployment mode',
  surface: 'custom',
  expected: 'select',
  factory: (_tui, theme, _keybindings, done) => {
    // #region published
    const list = new SelectList(
      [
        { value: 'safe', label: 'Safe', description: 'Run checks before deploying' },
        { value: 'fast', label: 'Fast', description: 'Deploy without the extra checks' },
      ],
      8,
      {
        selectedPrefix: (s) => theme.fg('accent', s),
        selectedText: (s) => theme.fg('accent', s),
        description: (s) => theme.fg('muted', s),
        scrollInfo: (s) => theme.fg('dim', s),
        noMatch: (s) => theme.fg('warning', s),
      }
    );
    list.onSelect = (item) => done(item.value);
    return list;
    // #endregion published
  },
} satisfies ExampleModule;
