import { describe, expect, it } from 'vitest';
import { APP_EXTENSION_SLOT_META, groupExtensionViewsBySlot } from './slots.js';
import {
  APP_EXTENSION_SLOTS,
  type AppExtensionSlot,
  type AppExtensionSummary,
} from './types.js';

const summary = (
  id: string,
  views: { id: string; title: string; slot: string; order?: number }[],
  enabled = true,
): AppExtensionSummary => ({
  id,
  name: id,
  version: '1.0.0',
  enabled,
  capabilities: [],
  views: views.map((view) => ({
    id: view.id,
    title: view.title,
    slot: view.slot as AppExtensionSlot,
    order: view.order,
  })),
});

describe('APP_EXTENSION_SLOT_META', () => {
  it('covers every declared slot with a label and description', () => {
    expect(Object.keys(APP_EXTENSION_SLOT_META).sort()).toEqual([...APP_EXTENSION_SLOTS].sort());
    for (const slot of APP_EXTENSION_SLOTS) {
      expect(APP_EXTENSION_SLOT_META[slot].label.length).toBeGreaterThan(0);
      expect(APP_EXTENSION_SLOT_META[slot].description.length).toBeGreaterThan(0);
    }
  });
});

describe('groupExtensionViewsBySlot', () => {
  it('returns an entry for all three declared slots, even when empty', () => {
    const grouped = groupExtensionViewsBySlot([]);
    expect(Object.keys(grouped).sort()).toEqual([...APP_EXTENSION_SLOTS].sort());
    for (const slot of APP_EXTENSION_SLOTS) {
      expect(grouped[slot]).toEqual([]);
    }
  });

  it('groups one view under each declared slot', () => {
    const grouped = groupExtensionViewsBySlot([
      summary('ext-a', [{ id: 'nav', title: 'Nav', slot: 'sidebar' }]),
      summary('ext-b', [{ id: 'panel', title: 'Panel', slot: 'right-panel' }]),
      summary('ext-c', [{ id: 'page', title: 'Page', slot: 'workspace' }]),
    ]);
    expect(grouped.sidebar.map((entry) => entry.view.id)).toEqual(['nav']);
    expect(grouped['right-panel'].map((entry) => entry.view.id)).toEqual(['panel']);
    expect(grouped.workspace.map((entry) => entry.view.id)).toEqual(['page']);
  });

  it('keeps views from disabled extensions listed (callers disable launches)', () => {
    const grouped = groupExtensionViewsBySlot([
      summary('ext-off', [{ id: 'panel', title: 'Panel', slot: 'right-panel' }], false),
    ]);
    expect(grouped['right-panel']).toHaveLength(1);
    expect(grouped['right-panel'][0]?.extension.id).toBe('ext-off');
    expect(grouped['right-panel'][0]?.extension.enabled).toBe(false);
  });

  it('sorts by order, then title, then extension id, then view id', () => {
    const grouped = groupExtensionViewsBySlot([
      summary('ext-b', [
        { id: 'v1', title: 'Beta', slot: 'right-panel', order: 2 },
        { id: 'v2', title: 'Alpha', slot: 'right-panel', order: 2 },
      ]),
      summary('ext-a', [
        { id: 'v1', title: 'Alpha', slot: 'right-panel', order: 2 },
        { id: 'late', title: 'Alpha', slot: 'right-panel' },
        { id: 'early', title: 'Alpha', slot: 'right-panel', order: 1 },
        { id: 'zeta', title: 'Alpha', slot: 'right-panel', order: 2 },
        { id: 'alpha', title: 'Alpha', slot: 'right-panel', order: 2 },
      ]),
    ]);
    const order = grouped['right-panel'].map((entry) => `${entry.extension.id}:${entry.view.id}`);
    expect(order).toEqual([
      // Lowest explicit order first, unordered views last.
      'ext-a:early',
      // Same order + title: extension id breaks the tie …
      'ext-a:alpha',
      'ext-a:v1',
      'ext-a:zeta',
      'ext-b:v2',
      // … then title orders the rest …
      'ext-b:v1',
      // … and views without an order sort last.
      'ext-a:late',
    ]);
  });

  it('ignores contributions declaring an unknown slot at runtime', () => {
    const grouped = groupExtensionViewsBySlot([
      summary('ext-a', [
        { id: 'ok', title: 'Ok', slot: 'sidebar' },
        { id: 'bogus', title: 'Bogus', slot: 'observatory' },
      ]),
    ]);
    expect(grouped.sidebar.map((entry) => entry.view.id)).toEqual(['ok']);
    for (const slot of APP_EXTENSION_SLOTS) {
      expect(grouped[slot].some((entry) => entry.view.id === 'bogus')).toBe(false);
    }
  });
});
