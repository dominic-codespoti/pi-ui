import { Editor } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'multiline-editor',
  title: 'Collect a multi-line release note',
  surface: 'custom',
  expected: 'input',
  factory: (tui, theme, _keybindings, done) => {
    // #region published
    const editor = new Editor(
      tui,
      {
        borderColor: (s) => theme.fg('accent', s),
        selectList: {
          selectedPrefix: (s) => theme.fg('accent', s),
          selectedText: (s) => theme.fg('accent', s),
          description: (s) => theme.fg('muted', s),
          scrollInfo: (s) => theme.fg('dim', s),
          noMatch: (s) => theme.fg('warning', s),
        },
      },
      { paddingX: 1 }
    );
    editor.setText('Shipped the new preview panel.');
    editor.onSubmit = (text) => done(text);
    return editor;
    // #endregion published
  },
} satisfies ExampleModule;
