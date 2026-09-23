import { Loader } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'loader',
  title: 'Show that an operation is still running',
  surface: 'custom',
  expected: 'loader',
  factory: (tui, theme) => {
    // #region published
    const loader = new Loader(
      tui,
      (s) => theme.fg('accent', s),
      (s) => theme.fg('text', s),
      'Indexing project files…'
    );
    return loader;
    // #endregion published
  },
} satisfies ExampleModule;
