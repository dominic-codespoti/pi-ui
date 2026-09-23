# Executable examples

## Let the user choose a deployment mode

- Surface: custom
- Expected kind: select

```ts
import { SelectList } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
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
});
```

## Let the user adjust extension preferences

- Surface: custom
- Expected kind: settings

```ts
import { SettingsList } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
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
});
```

## Ask the user for a short value

- Surface: custom
- Expected kind: input

```ts
import { Input } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  const input = new Input({ prompt: 'Branch name: ', placeholder: 'feature/my-change' });
  input.onSubmit = (value) => done(value);
  return input;
});
```

## Collect a multi-line release note

- Surface: custom
- Expected kind: input

```ts
import { Editor } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
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
});
```

## Show a formatted change summary

- Surface: custom
- Expected kind: markdown

```ts
import { Markdown } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  return new Markdown('### Changes\n\n- Updated the cache\n- Added a **fast** lookup path', 1, 0, {
    heading: (s) => theme.fg('accent', s),
    link: (s) => theme.fg('accent', s),
    linkUrl: (s) => theme.fg('dim', s),
    code: (s) => theme.fg('warning', s),
    codeBlock: (s) => s,
    codeBlockBorder: (s) => theme.fg('muted', s),
    quote: (s) => theme.fg('muted', s),
    quoteBorder: (s) => theme.fg('muted', s),
    hr: (s) => theme.fg('dim', s),
    listBullet: (s) => theme.fg('accent', s),
    bold: (s) => theme.bold(s),
    italic: (s) => s,
    strikethrough: (s) => s,
    underline: (s) => s,
  });
});
```

## Display a short status message

- Surface: custom
- Expected kind: text

```ts
import { Text } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  return new Text('All checks passed. The branch is ready to merge.', 1, 0);
});
```

## Show that an operation is still running

- Surface: custom
- Expected kind: loader

```ts
import { Loader } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  const loader = new Loader(
    tui,
    (s) => theme.fg('accent', s),
    (s) => theme.fg('text', s),
    'Indexing project files…'
  );
  return loader;
});
```

## Display a small image in a custom view

- Surface: custom
- Expected kind: image

```ts
import { Image } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  const onePixelPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';
  return new Image(onePixelPng, 'image/png', {
    fallbackColor: (s) => theme.fg('muted', s),
  });
});
```

## Place a summary beside actionable choices

- Surface: custom
- Expected kind: container

```ts
import { HStack, Markdown, SelectList } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
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
});
```

## Offer a primary action in a custom dialog

- Surface: custom
- Expected kind: button

```ts
import { truncateToWidth } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
  // These fields are the Pi UI shape for a native button; render also keeps it usable in a terminal.
  return {
    label: 'Run checks',
    variant: 'primary',
    onClick: () => done('run-checks'),
    render: (width: number) => [theme.fg('accent', truncateToWidth('[ Run checks ]', width))],
    invalidate() {},
  };
});
```

## Let the user toggle an extension option

- Surface: custom
- Expected kind: checkbox

```ts
import { truncateToWidth } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
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
});
```

## Show a live task progress widget

- Surface: widget
- Expected kind: progress

```ts
ctx.ui.setWidget(
  'live-progress-widget',
  (tui, theme) => {
    let progress = 0.2;
    // These fields are the Pi UI shape for native progress; render keeps it usable in a terminal.
    const component = {
      label: 'Building project',
      progress,
      render: (width: number) => {
        const percent = Math.round(progress * 100);
        const barWidth = Math.max(0, Math.min(20, width - 8));
        const filled = Math.round(progress * barWidth);
        const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
        return [theme.fg('accent', `${component.label}: ${bar} ${percent}%`)];
      },
      invalidate() {},
      dispose: () => clearInterval(timer),
    };
    const timer = setInterval(() => {
      progress = Math.min(1, progress + 0.1);
      component.progress = progress;
      tui.requestRender();
      if (progress >= 1) clearInterval(timer);
    }, 500);
    return component;
  },
  { placement: 'belowEditor' }
);
```

## Capture keyboard navigation in a terminal-style overlay

- Surface: custom
- Expected kind: terminal fallback

```ts
import { Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
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
});
```
