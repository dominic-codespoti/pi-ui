import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'checkbox-shape',
  title: 'Let the user toggle an extension option',
  surface: 'custom',
  expected: 'checkbox',
  factory: (_tui, theme, _keybindings, done) => {
    // #region published
    // These fields are the Pi UI shape for a native checkbox; render keeps it usable in a terminal.
    const checkbox: {
      label: string;
      checked: boolean;
      onToggle: (next: boolean) => void;
      render: (width: number) => string[];
      invalidate(): void;
    } = {
      label: 'Include generated files',
      checked: true,
      onToggle: (next) => {
        checkbox.checked = next;
        done(next);
      },
      render: (width) => {
        const mark = checkbox.checked ? 'x' : ' ';
        const plainText = `[${mark}] Include generated files`;
        return [theme.fg('text', truncateToWidth(plainText, width))];
      },
      invalidate() {},
    };
    return checkbox;
    // #endregion published
  },
} satisfies ExampleModule;
