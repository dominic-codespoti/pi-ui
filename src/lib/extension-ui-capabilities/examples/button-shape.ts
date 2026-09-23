import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'button-shape',
  title: 'Offer a primary action in a custom dialog',
  surface: 'custom',
  expected: 'button',
  factory: (_tui, theme, _keybindings, done) => {
    // #region published
    // These fields are the Pi UI shape for a native button; render also keeps it usable in a terminal.
    return {
      label: 'Run checks',
      variant: 'primary',
      onClick: () => done('run-checks'),
      render: (width: number) => [theme.fg('accent', truncateToWidth('[ Run checks ]', width))],
      invalidate() {},
    };
    // #endregion published
  },
} satisfies ExampleModule;
