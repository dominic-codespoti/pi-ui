import { Image } from '@earendil-works/pi-tui';
import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'image',
  title: 'Display a small image in a custom view',
  surface: 'custom',
  expected: 'image',
  factory: (_tui, theme) => {
    // #region published
    const onePixelPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=';
    return new Image(onePixelPng, 'image/png', {
      fallbackColor: (s) => theme.fg('muted', s),
    });
    // #endregion published
  },
} satisfies ExampleModule;
