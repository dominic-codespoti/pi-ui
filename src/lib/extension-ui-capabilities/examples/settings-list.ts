import { SettingsList } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'settings-list',
  title: 'Let the user adjust extension preferences',
  surface: 'custom',
  expected: 'settings',
  factory: (_tui, theme, _keybindings, done) => {
    // #region published
    return new SettingsList(
      [
        {
          id: 'format',
          label: 'Format on save',
          description: 'Format edited files automatically',
          currentValue: 'On',
          values: ['On', 'Off'],
        },
        {
          id: 'verbosity',
          label: 'Output',
          currentValue: 'Concise',
          values: ['Concise', 'Detailed'],
        },
      ],
      8,
      {
        label: (s) => theme.fg('text', s),
        value: (s) => theme.fg('accent', s),
        description: (s) => theme.fg('muted', s),
        cursor: theme.fg('accent', '>'),
        hint: (s) => theme.fg('dim', s),
      },
      (id, value) => done({ id, value }),
      () => done(undefined)
    );
    // #endregion published
  },
} satisfies ExampleModule;
