import { Text } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'plain-text',
  title: 'Display a short status message',
  surface: 'custom',
  expected: 'text',
  factory: () => {
    // #region published
    return new Text('All checks passed. The branch is ready to merge.', 1, 0);
    // #endregion published
  },
} satisfies ExampleModule;
