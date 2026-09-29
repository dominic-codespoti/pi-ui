import {
  APP_EXTENSION_SLOTS,
  type AppExtensionSlot,
  type AppExtensionSummary,
  type AppExtensionViewContribution,
} from './types.js';

/** Human-facing metadata for each view slot, used by the Apps launcher. */
export const APP_EXTENSION_SLOT_META: Record<
  AppExtensionSlot,
  { label: string; description: string }
> = {
  sidebar: {
    label: 'Sidebar',
    description: 'Opens in the left projects sidebar.',
  },
  'right-panel': {
    label: 'Right panel',
    description: 'Hosts inline in the Apps tab.',
  },
  workspace: {
    label: 'Workspace',
    description: 'Opens as a full-screen workspace; Back returns to chat.',
  },
};

/** A view contribution paired with its owning extension summary. */
export interface AppExtensionSlotView {
  extension: AppExtensionSummary;
  view: AppExtensionViewContribution;
}

function isKnownSlot(slot: string): slot is AppExtensionSlot {
  return (APP_EXTENSION_SLOTS as readonly string[]).includes(slot);
}

function compareSlotViews(a: AppExtensionSlotView, b: AppExtensionSlotView): number {
  const orderA = a.view.order ?? Number.MAX_SAFE_INTEGER;
  const orderB = b.view.order ?? Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return orderA - orderB;
  if (a.view.title !== b.view.title) return a.view.title < b.view.title ? -1 : 1;
  if (a.extension.id !== b.extension.id) return a.extension.id < b.extension.id ? -1 : 1;
  return a.view.id < b.view.id ? -1 : a.view.id > b.view.id ? 1 : 0;
}

/**
 * Group every contributed view by its declared slot (pure — safe to unit test
 * and reuse in any launcher UI). Views from disabled extensions are included;
 * callers decide how to present them. Contributions declaring an unknown slot
 * are ignored. Each group is sorted by `order`, then title, then extension id.
 */
export function groupExtensionViewsBySlot(
  extensions: AppExtensionSummary[],
): Record<AppExtensionSlot, AppExtensionSlotView[]> {
  // Exhaustive literal: adding a slot to `APP_EXTENSION_SLOTS` fails the
  // build here until the new group is handled, with no `Object.fromEntries`
  // assertion to keep in sync.
  const grouped: Record<AppExtensionSlot, AppExtensionSlotView[]> = {
    sidebar: [],
    'right-panel': [],
    workspace: [],
  };
  for (const extension of extensions) {
    for (const view of extension.views) {
      if (!isKnownSlot(view.slot)) continue;
      grouped[view.slot].push({ extension, view });
    }
  }
  for (const slot of APP_EXTENSION_SLOTS) {
    grouped[slot].sort(compareSlotViews);
  }
  return grouped;
}
