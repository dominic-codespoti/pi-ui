import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'keyboard-overlay',
  title: 'Capture keyboard navigation in a terminal-style overlay',
  surface: 'custom',
  expected: 'terminal-fallback',
  factory: (tui, theme, _keybindings, done) => {
    // #region published
    let position = 0;
    const options = ['Inspect changes', 'Run tests', 'Cancel'];
    return {
      handleInput(data: string) {
        if (matchesKey(data, Key.up)) {
          position = (position + options.length - 1) % options.length;
          tui.requestRender();
        } else if (matchesKey(data, Key.down)) {
          position = (position + 1) % options.length;
          tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          done(options[position]);
        }
      },
      render(width: number) {
        const rows = [
          'Choose an action:',
          ...options.map((option, index) => `${index === position ? '›' : ' '} ${option}`),
        ];
        return rows.map((row) =>
          theme.fg(row.startsWith('›') ? 'accent' : 'text', truncateToWidth(row, width))
        );
      },
      invalidate() {},
    };
    // #endregion published
  },
} satisfies ExampleModule;
