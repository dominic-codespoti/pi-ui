import {
  APP_EXTENSION_SLOTS,
  type AppExtensionScope,
  type AppExtensionSlot,
  type AppExtensionSummary,
  type AppExtensionViewContribution,
} from '#lib/app-extensions/types.js';

/** Pointer to one contributed view inside one extension. */
export interface AppExtensionViewRef {
  extensionId: string;
  viewId: string;
}

/** A view contribution resolved against its owning extension summary. */
export interface AppExtensionResolvedView {
  extension: AppExtensionSummary;
  view: AppExtensionViewContribution;
}

/** Per-surface selection — at most one active view per slot. */
export type AppExtensionSlotSelection = Record<AppExtensionSlot, AppExtensionViewRef | null>;

const ACTIVE_VIEWS_STORAGE_KEY = 'pi-ui:app-extensions:active-views';
const PINNED_SIDEBAR_STORAGE_KEY = 'pi-ui:app-extensions:pinned-sidebar-views';
const LEGACY_ACTIVE_VIEW_STORAGE_KEY = 'pi-ui:app-extensions:active-view';

function emptySelection(): AppExtensionSlotSelection {
  return Object.fromEntries(APP_EXTENSION_SLOTS.map((slot) => [slot, null])) as AppExtensionSlotSelection;
}

function isViewRef(value: unknown): value is AppExtensionViewRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).extensionId === 'string' &&
    typeof (value as Record<string, unknown>).viewId === 'string'
  );
}

function readStoredActiveViews(): AppExtensionSlotSelection {
  const selection = emptySelection();
  if (typeof localStorage === 'undefined') return selection;
  try {
    const raw = localStorage.getItem(ACTIVE_VIEWS_STORAGE_KEY);
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        // `sidebar` is now a list of local pins; migrate its old single selection
        // in readStoredPinnedSidebarViews instead of treating it as an active slot.
        const workspace = record.workspace ?? record['full-page'] ?? record['main-tab'];
        const values: Partial<Record<AppExtensionSlot, unknown>> = {
          sidebar: null,
          'right-panel': record['right-panel'],
          workspace,
        };
        for (const slot of APP_EXTENSION_SLOTS) {
          const candidate = values[slot];
          if (isViewRef(candidate)) {
            selection[slot] = { extensionId: candidate.extensionId, viewId: candidate.viewId };
          }
        }
      }
      localStorage.removeItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY);
      return selection;
    }

    // Migrate the legacy single right-panel selection (pre-slot state).
    const legacy: unknown = JSON.parse(
      localStorage.getItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY) ?? 'null',
    );
    if (isViewRef(legacy)) {
      selection['right-panel'] = { extensionId: legacy.extensionId, viewId: legacy.viewId };
    }
    localStorage.removeItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY);
  } catch {
    // Treat malformed/unavailable browser storage as no saved selection.
  }
  return selection;
}

function readStoredPinnedSidebarViews(): AppExtensionViewRef[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const rawPins = localStorage.getItem(PINNED_SIDEBAR_STORAGE_KEY);
    if (rawPins !== null) {
      const parsed: unknown = JSON.parse(rawPins);
      if (Array.isArray(parsed)) return uniqueRefs(parsed.filter(isViewRef));
    }

    // Migrate the old one-view sidebar attachment into the new local pin list.
    const activeViews: unknown = JSON.parse(
      localStorage.getItem(ACTIVE_VIEWS_STORAGE_KEY) ?? 'null',
    );
    if (typeof activeViews === 'object' && activeViews !== null) {
      const sidebar = (activeViews as Record<string, unknown>).sidebar;
      if (isViewRef(sidebar)) return [{ extensionId: sidebar.extensionId, viewId: sidebar.viewId }];
    }
  } catch {
    // Malformed/unavailable storage means no pins.
  }
  return [];
}

function uniqueRefs(refs: AppExtensionViewRef[]): AppExtensionViewRef[] {
  const seen: string[] = [];
  return refs.filter((ref) => {
    const key = `${ref.extensionId}\0${ref.viewId}`;
    if (seen.includes(key)) return false;
    seen.push(key);
    return true;
  });
}

function storeActiveViews(selection: AppExtensionSlotSelection): void {
  if (typeof localStorage === 'undefined') return;
  try {
    // Older clients may still have a single sidebar selection in this object;
    // keep the new shape canonical and leave all sidebar state to the pin key.
    localStorage.setItem(
      ACTIVE_VIEWS_STORAGE_KEY,
      JSON.stringify({ ...selection, sidebar: null }),
    );
    localStorage.removeItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY);
  } catch {
    // Navigation still works for this page even if storage is unavailable.
  }
}

function storePinnedSidebarViews(refs: AppExtensionViewRef[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PINNED_SIDEBAR_STORAGE_KEY, JSON.stringify(refs));
  } catch {
    // The attachment remains available until reload if storage is unavailable.
  }
}

/**
 * Transport-agnostic frontend state for trusted app-level extensions. Server
 * enablement remains separate from browser-local workspace and sidebar choices.
 */
export class AppExtensionsState {
  /** Installed extension summaries (source of truth for views). */
  extensions = $state<AppExtensionSummary[]>([]);
  /** Current project/session scope passed down to extension views. */
  scope = $state<AppExtensionScope>({});
  /** Currently selected view per launch surface. Sidebar views are pinned separately. */
  activeViews = $state<AppExtensionSlotSelection>(readStoredActiveViews());
  /** Locally pinned sidebar attachments, in the user's preferred order. */
  pinnedSidebarViews = $state<AppExtensionViewRef[]>(readStoredPinnedSidebarViews());

  /**
   * Backwards-compatible alias for the right-panel selection — the original
   * single host before per-slot state existed.
   */
  get activeView(): AppExtensionViewRef | null {
    return this.activeViews['right-panel'];
  }

  /** Replace the extension list and prune references to removed contributions. */
  setExtensions(extensions: AppExtensionSummary[]): void {
    this.extensions = [...extensions];
    let activeChanged = false;
    for (const slot of APP_EXTENSION_SLOTS) {
      const current = this.activeViews[slot];
      if (!current) continue;
      if (slot === 'sidebar') {
        // Migrate any in-memory legacy sidebar selection to a local pin.
        if (this.resolveRefForSlot('sidebar', current)) this.pinSidebarView(current);
        this.activeViews.sidebar = null;
        activeChanged = true;
      } else if (!this.isRefLive(slot, current)) {
        this.activeViews[slot] = null;
        activeChanged = true;
      }
    }

    const pins = this.pinnedSidebarViews.filter((ref) => {
      const resolved = this.findView(ref.extensionId, ref.viewId);
      // Keep a pin while its extension is disabled so it returns when re-enabled.
      return resolved?.view.slot === 'sidebar';
    });
    const pinsChanged = pins.length !== this.pinnedSidebarViews.length;
    if (pinsChanged) this.pinnedSidebarViews = pins;
    if (activeChanged) storeActiveViews(this.activeViews);
    if (pinsChanged) storePinnedSidebarViews(pins);
  }

  /** Replace the active scope. */
  setScope(scope: AppExtensionScope): void {
    this.scope = { ...scope };
  }

  /** Select a view for a launch surface, or clear the surface with null. */
  setActiveViewForSlot(slot: AppExtensionSlot, view: AppExtensionViewRef | null): void {
    if (slot === 'sidebar') {
      if (view) this.pinSidebarView(view);
      else this.clearSidebarPins();
      return;
    }
    this.activeViews[slot] = view ? { ...view } : null;
    storeActiveViews(this.activeViews);
  }

  /** Read the selected view for one slot (a defensive copy, or null). */
  activeViewForSlot(slot: AppExtensionSlot): AppExtensionViewRef | null {
    if (slot === 'sidebar') return null;
    const current = this.activeViews[slot];
    return current ? { ...current } : null;
  }

  /** Backwards-compatible alias — selects the right-panel view, or clears it. */
  setActiveView(view: AppExtensionViewRef | null): void {
    this.setActiveViewForSlot('right-panel', view);
  }

  /** Pin a currently enabled sidebar contribution on this browser. */
  pinSidebarView(ref: AppExtensionViewRef): boolean {
    const resolved = this.resolveRefForSlot('sidebar', ref);
    if (!resolved) return false;
    if (this.isSidebarViewPinned(ref)) return true;
    this.pinnedSidebarViews = uniqueRefs([...this.pinnedSidebarViews, { ...ref }]);
    storePinnedSidebarViews(this.pinnedSidebarViews);
    return true;
  }

  /** Toggle a sidebar pin; returns the resulting pinned state. */
  toggleSidebarViewPin(ref: AppExtensionViewRef): boolean {
    if (this.isSidebarViewPinned(ref)) {
      this.unpinSidebarView(ref);
      return false;
    }
    return this.pinSidebarView(ref);
  }

  unpinSidebarView(ref: AppExtensionViewRef): void {
    const next = this.pinnedSidebarViews.filter(
      (pin) => pin.extensionId !== ref.extensionId || pin.viewId !== ref.viewId,
    );
    if (next.length === this.pinnedSidebarViews.length) return;
    this.pinnedSidebarViews = next;
    storePinnedSidebarViews(next);
  }

  /** Move a local sidebar attachment to a zero-based position. */
  moveSidebarViewPin(ref: AppExtensionViewRef, targetIndex: number): void {
    const currentIndex = this.pinnedSidebarViews.findIndex(
      (pin) => pin.extensionId === ref.extensionId && pin.viewId === ref.viewId,
    );
    if (currentIndex < 0 || !Number.isFinite(targetIndex)) return;
    const next = [...this.pinnedSidebarViews];
    const [moved] = next.splice(currentIndex, 1);
    const insertionIndex = Math.max(0, Math.min(Math.trunc(targetIndex), next.length));
    next.splice(insertionIndex, 0, moved);
    if (next.every((pin, index) => pin === this.pinnedSidebarViews[index])) return;
    this.pinnedSidebarViews = next;
    storePinnedSidebarViews(next);
  }

  clearSidebarPins(): void {
    if (!this.pinnedSidebarViews.length) return;
    this.pinnedSidebarViews = [];
    storePinnedSidebarViews([]);
  }

  isSidebarViewPinned(ref: AppExtensionViewRef): boolean {
    return this.pinnedSidebarViews.some(
      (pin) => pin.extensionId === ref.extensionId && pin.viewId === ref.viewId,
    );
  }

  /** Resolve stored sidebar pins, including disabled extensions for placeholders. */
  resolvePinnedSidebarViews(): AppExtensionResolvedView[] {
    return this.pinnedSidebarViews.flatMap((ref) => {
      const resolved = this.findView(ref.extensionId, ref.viewId);
      return resolved?.view.slot === 'sidebar' ? [resolved] : [];
    });
  }

  /** Resolve an installed extension view by ID. */
  findView(extensionId: string, viewId: string): AppExtensionResolvedView | undefined {
    const extension = this.extensions.find((entry) => entry.id === extensionId);
    const view = extension?.views.find((candidate) => candidate.id === viewId);
    if (!extension || !view) return undefined;
    return { extension, view };
  }

  /** Resolve the active view for a launch surface. */
  resolveSlotView(slot: AppExtensionSlot): AppExtensionResolvedView | undefined {
    if (slot === 'sidebar') return undefined;
    const ref = this.activeViews[slot];
    if (!ref) return undefined;
    const resolved = this.findView(ref.extensionId, ref.viewId);
    if (!resolved || !resolved.extension.enabled || resolved.view.slot !== slot) {
      return undefined;
    }
    return resolved;
  }

  /** Whether a stored ref still points at an enabled contribution for that slot. */
  isRefLive(slot: AppExtensionSlot, ref: AppExtensionViewRef): boolean {
    return this.resolveRefForSlot(slot, ref) !== undefined;
  }

  private resolveRefForSlot(
    slot: AppExtensionSlot,
    ref: AppExtensionViewRef,
  ): AppExtensionResolvedView | undefined {
    const resolved = this.findView(ref.extensionId, ref.viewId);
    if (!resolved || !resolved.extension.enabled || resolved.view.slot !== slot) {
      return undefined;
    }
    return resolved;
  }
}

/** Singleton shared by the app shell and extension view hosts. */
export const appExtensionsState = new AppExtensionsState();
