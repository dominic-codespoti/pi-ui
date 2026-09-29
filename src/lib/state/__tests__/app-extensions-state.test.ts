import { beforeEach, describe, expect, it } from 'vitest';
import { AppExtensionsState, appExtensionsState } from '../app-extensions-state.svelte';
import { APP_EXTENSION_SLOTS } from '#lib/app-extensions/types.js';
import type { AppExtensionSlot, AppExtensionSummary } from '#lib/app-extensions/types.js';

const ACTIVE_VIEWS_STORAGE_KEY = 'pi-ui:app-extensions:active-views';
const PINNED_SIDEBAR_STORAGE_KEY = 'pi-ui:app-extensions:pinned-sidebar-views';
const LEGACY_ACTIVE_VIEW_STORAGE_KEY = 'pi-ui:app-extensions:active-view';

const summary = (
  id: string,
  viewIds: string[] = ['main'],
  slot: AppExtensionSlot = 'workspace',
  enabled = true,
): AppExtensionSummary => ({
  id,
  name: id,
  version: '1.0.0',
  enabled,
  capabilities: [],
  views: viewIds.map((viewId) => ({ id: viewId, title: viewId, slot })),
});

const multiSummary = (
  id: string,
  views: { id: string; slot: AppExtensionSlot }[],
  enabled = true,
): AppExtensionSummary => ({
  id,
  name: id,
  version: '1.0.0',
  enabled,
  capabilities: [],
  views: views.map((view) => ({ ...view, title: view.id })),
});

beforeEach(() => {
  localStorage.clear();
  appExtensionsState.setExtensions([]);
  appExtensionsState.setScope({});
  for (const slot of APP_EXTENSION_SLOTS) appExtensionsState.setActiveViewForSlot(slot, null);
  appExtensionsState.clearSidebarPins();
  localStorage.clear();
});

describe('AppExtensionsState', () => {
  it('starts empty with no scope, workspace selection, or sidebar pins', () => {
    const state = new AppExtensionsState();
    expect(state.extensions).toEqual([]);
    expect(state.scope).toEqual({});
    expect(state.activeView).toBeNull();
    expect(state.activeViewForSlot('workspace')).toBeNull();
    expect(state.pinnedSidebarViews).toEqual([]);
  });

  it('exposes a shared singleton', () => {
    expect(appExtensionsState).toBeInstanceOf(AppExtensionsState);
  });

  it('replaces the installed extension list and current scope', () => {
    appExtensionsState.setExtensions([summary('a'), summary('b')]);
    expect(appExtensionsState.extensions.map((entry) => entry.id)).toEqual(['a', 'b']);
    appExtensionsState.setExtensions([summary('c')]);
    expect(appExtensionsState.extensions.map((entry) => entry.id)).toEqual(['c']);

    appExtensionsState.setScope({ projectId: 'p1', sessionId: 's1' });
    expect(appExtensionsState.scope).toEqual({ projectId: 'p1', sessionId: 's1' });
    appExtensionsState.setScope({});
    expect(appExtensionsState.scope).toEqual({});
  });

  it('persists workspace and right-panel selections locally', () => {
    const initial = new AppExtensionsState();
    initial.setActiveViewForSlot('workspace', { extensionId: 'a', viewId: 'board' });
    initial.setActiveViewForSlot('right-panel', { extensionId: 'b', viewId: 'inspector' });

    const restored = new AppExtensionsState();
    restored.setExtensions([
      summary('a', ['board'], 'workspace'),
      summary('b', ['inspector'], 'right-panel'),
    ]);
    expect(restored.activeViewForSlot('workspace')).toEqual({ extensionId: 'a', viewId: 'board' });
    expect(restored.activeViewForSlot('right-panel')).toEqual({ extensionId: 'b', viewId: 'inspector' });
  });

  it('migrates old main-tab/full-page selections into one workspace selection', () => {
    localStorage.setItem(
      ACTIVE_VIEWS_STORAGE_KEY,
      JSON.stringify({
        'main-tab': { extensionId: 'a', viewId: 'chat' },
        'full-page': { extensionId: 'b', viewId: 'tasks' },
      }),
    );
    const state = new AppExtensionsState();
    expect(state.activeViewForSlot('workspace')).toEqual({ extensionId: 'b', viewId: 'tasks' });
    state.setExtensions([
      summary('a', ['chat'], 'workspace'),
      summary('b', ['tasks'], 'workspace'),
    ]);
    expect(state.resolveSlotView('workspace')?.view.id).toBe('tasks');
  });

  it('migrates a previous single sidebar selection into a local pin', () => {
    localStorage.setItem(
      ACTIVE_VIEWS_STORAGE_KEY,
      JSON.stringify({ sidebar: { extensionId: 'a', viewId: 'network' } }),
    );
    const state = new AppExtensionsState();
    state.setExtensions([summary('a', ['network'], 'sidebar')]);
    expect(state.pinnedSidebarViews).toEqual([{ extensionId: 'a', viewId: 'network' }]);
    expect(state.resolvePinnedSidebarViews()[0]?.view.id).toBe('network');
    expect(state.activeViewForSlot('sidebar')).toBeNull();
  });

  it('migrates the pre-slot right-panel selection', () => {
    localStorage.setItem(
      LEGACY_ACTIVE_VIEW_STORAGE_KEY,
      JSON.stringify({ extensionId: 'a', viewId: 'main' }),
    );
    const state = new AppExtensionsState();
    expect(state.activeViewForSlot('right-panel')).toEqual({ extensionId: 'a', viewId: 'main' });
    expect(localStorage.getItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY)).toBeNull();
  });

  it('ignores unknown stored slots and malformed legacy data', () => {
    localStorage.setItem(
      ACTIVE_VIEWS_STORAGE_KEY,
      JSON.stringify({
        sidebar: { extensionId: 'a', viewId: 'nav' },
        observatory: { extensionId: 'a', viewId: 'nav' },
      }),
    );
    const state = new AppExtensionsState();
    expect(state.activeViewForSlot('workspace')).toBeNull();
    expect(state.activeViewForSlot('right-panel')).toBeNull();
    expect(state.pinnedSidebarViews).toEqual([{ extensionId: 'a', viewId: 'nav' }]);

    localStorage.clear();
    localStorage.setItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY, '{not-json');
    const malformed = new AppExtensionsState();
    for (const slot of APP_EXTENSION_SLOTS) expect(malformed.activeViewForSlot(slot)).toBeNull();
  });

  it('keeps the right-panel alias in sync', () => {
    appExtensionsState.setActiveViewForSlot('right-panel', { extensionId: 'a', viewId: 'panel' });
    expect(appExtensionsState.activeView).toEqual({ extensionId: 'a', viewId: 'panel' });
    appExtensionsState.setActiveView(null);
    expect(appExtensionsState.activeViewForSlot('right-panel')).toBeNull();
  });

  it('pins, unpins, orders, and restores sidebar attachments locally', () => {
    appExtensionsState.setExtensions([
      multiSummary('a', [
        { id: 'first', slot: 'sidebar' },
        { id: 'second', slot: 'sidebar' },
      ]),
    ]);
    expect(appExtensionsState.pinSidebarView({ extensionId: 'a', viewId: 'first' })).toBe(true);
    expect(appExtensionsState.toggleSidebarViewPin({ extensionId: 'a', viewId: 'second' })).toBe(true);
    expect(appExtensionsState.pinnedSidebarViews).toEqual([
      { extensionId: 'a', viewId: 'first' },
      { extensionId: 'a', viewId: 'second' },
    ]);
    expect(appExtensionsState.isSidebarViewPinned({ extensionId: 'a', viewId: 'first' })).toBe(true);

    const restored = new AppExtensionsState();
    restored.setExtensions([
      multiSummary('a', [
        { id: 'first', slot: 'sidebar' },
        { id: 'second', slot: 'sidebar' },
      ]),
    ]);
    expect(restored.pinnedSidebarViews).toEqual(appExtensionsState.pinnedSidebarViews);
    restored.moveSidebarViewPin({ extensionId: 'a', viewId: 'second' }, 0);
    expect(restored.pinnedSidebarViews).toEqual([
      { extensionId: 'a', viewId: 'second' },
      { extensionId: 'a', viewId: 'first' },
    ]);
    restored.unpinSidebarView({ extensionId: 'a', viewId: 'first' });
    expect(restored.pinnedSidebarViews).toEqual([{ extensionId: 'a', viewId: 'second' }]);
    expect(restored.toggleSidebarViewPin({ extensionId: 'a', viewId: 'second' })).toBe(false);
  });

  it('only permits enabled sidebar contributions to be newly pinned', () => {
    appExtensionsState.setExtensions([
      summary('a', ['panel'], 'right-panel'),
      summary('b', ['nav'], 'sidebar', false),
    ]);
    expect(appExtensionsState.pinSidebarView({ extensionId: 'a', viewId: 'panel' })).toBe(false);
    expect(appExtensionsState.pinSidebarView({ extensionId: 'b', viewId: 'nav' })).toBe(false);
    expect(appExtensionsState.pinnedSidebarViews).toEqual([]);
  });

  it('keeps a pin while disabled but prunes it when the view is removed', () => {
    appExtensionsState.setExtensions([summary('a', ['nav'], 'sidebar')]);
    appExtensionsState.pinSidebarView({ extensionId: 'a', viewId: 'nav' });
    appExtensionsState.setExtensions([summary('a', ['nav'], 'sidebar', false)]);
    expect(appExtensionsState.pinnedSidebarViews).toEqual([{ extensionId: 'a', viewId: 'nav' }]);
    expect(appExtensionsState.resolvePinnedSidebarViews()[0]?.extension.enabled).toBe(false);
    appExtensionsState.setExtensions([summary('a', ['other'], 'sidebar')]);
    expect(appExtensionsState.pinnedSidebarViews).toEqual([]);
    expect(localStorage.getItem(PINNED_SIDEBAR_STORAGE_KEY)).toBe('[]');
  });

  it('prunes workspace selections when disabled or when the extension/view disappears', () => {
    appExtensionsState.setExtensions([summary('a', ['board'], 'workspace')]);
    appExtensionsState.setActiveViewForSlot('workspace', { extensionId: 'a', viewId: 'board' });
    appExtensionsState.setExtensions([summary('a', ['board'], 'workspace', false)]);
    expect(appExtensionsState.activeViewForSlot('workspace')).toBeNull();
    expect(appExtensionsState.resolveSlotView('workspace')).toBeUndefined();

    appExtensionsState.setExtensions([summary('a', ['board'], 'workspace')]);
    appExtensionsState.setActiveViewForSlot('workspace', { extensionId: 'a', viewId: 'board' });
    appExtensionsState.setExtensions([summary('a', ['other'], 'workspace')]);
    expect(appExtensionsState.activeViewForSlot('workspace')).toBeNull();
  });

  it('only resolves a selected view when its contribution declares that slot', () => {
    appExtensionsState.setExtensions([
      summary('a', ['panel'], 'right-panel'),
      summary('b', ['workspace'], 'workspace', false),
    ]);
    appExtensionsState.setActiveView({ extensionId: 'a', viewId: 'panel' });
    appExtensionsState.setActiveViewForSlot('workspace', { extensionId: 'b', viewId: 'workspace' });
    expect(appExtensionsState.resolveSlotView('workspace')).toBeUndefined();
    expect(appExtensionsState.resolveSlotView('right-panel')?.view.id).toBe('panel');
    expect(appExtensionsState.resolveSlotView('sidebar')).toBeUndefined();
  });

  it('clears only the requested launch surface without disturbing local pins', () => {
    appExtensionsState.setExtensions([
      multiSummary('a', [
        { id: 'nav', slot: 'sidebar' },
        { id: 'workspace', slot: 'workspace' },
        { id: 'panel', slot: 'right-panel' },
      ]),
    ]);
    appExtensionsState.pinSidebarView({ extensionId: 'a', viewId: 'nav' });
    appExtensionsState.setActiveViewForSlot('workspace', { extensionId: 'a', viewId: 'workspace' });
    appExtensionsState.setActiveViewForSlot('right-panel', { extensionId: 'a', viewId: 'panel' });
    appExtensionsState.setActiveViewForSlot('workspace', null);
    expect(appExtensionsState.activeViewForSlot('workspace')).toBeNull();
    expect(appExtensionsState.activeViewForSlot('right-panel')).toEqual({ extensionId: 'a', viewId: 'panel' });
    expect(appExtensionsState.pinnedSidebarViews).toEqual([{ extensionId: 'a', viewId: 'nav' }]);
  });
});
