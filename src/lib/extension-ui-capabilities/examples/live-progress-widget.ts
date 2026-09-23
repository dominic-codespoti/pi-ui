import type { ExampleModule } from '../types.ts';

export const example = {
  id: 'live-progress-widget',
  title: 'Show a live task progress widget',
  surface: 'widget',
  placement: 'belowEditor',
  expected: 'progress',
  factory: (tui, theme) => {
    // #region published
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
    // #endregion published
  },
} satisfies ExampleModule;
