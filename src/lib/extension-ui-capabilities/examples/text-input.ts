import { Input } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'text-input',
  title: 'Ask the user for a short value',
  surface: 'custom',
  expected: 'input',
  factory: (_tui, _theme, _keybindings, done) => {
    // #region published
    const input = new Input({ prompt: 'Branch name: ', placeholder: 'feature/my-change' });
    input.onSubmit = (value) => done(value);
    return input;
    // #endregion published
  },
} satisfies ExampleModule;
