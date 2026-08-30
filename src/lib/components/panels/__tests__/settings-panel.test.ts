import { describe, it, expect } from 'vitest';
import SettingsPanel from '#lib/components/panels/settings-panel.svelte';

describe('SettingsPanel component', () => {
  it('exports component definition', () => {
    expect(SettingsPanel).toBeDefined();
  });
});
