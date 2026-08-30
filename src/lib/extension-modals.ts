/**
 * Pure classification helpers for pi-tui extension components rendered inside
 * extension modals. Used by the page to decide whether a custom dialog needs
 * a text input and how its submit buttons are labeled.
 */
import type { ParsedComponent } from '#lib/tui-stubs.js';

export function parsedComponentHasAction(comp: ParsedComponent | undefined): boolean {
  if (!comp) return false;
  if (comp.kind === 'select' || comp.kind === 'button' || comp.kind === 'checkbox') return true;
  if (comp.kind === 'settings') return comp.items.some((it) => !!it.values?.length);
  if (comp.kind === 'container') return comp.children.some(parsedComponentHasAction);
  return false;
}

export function parsedComponentHasInput(comp: ParsedComponent | undefined): boolean {
  if (!comp) return false;
  if (comp.kind === 'input') return true;
  if (comp.kind === 'container') return comp.children.some(parsedComponentHasInput);
  return false;
}
export function parsedComponentHasCheckbox(comp: ParsedComponent | undefined): boolean {
  if (!comp) return false;
  if (comp.kind === 'checkbox') return true;
  if (comp.kind === 'container') return comp.children.some(parsedComponentHasCheckbox);
  return false;
}

export function parsedComponentIsDisplayOnly(comp: ParsedComponent | undefined): boolean {
  if (!comp) return false;
  if (comp.kind === 'container') return comp.children.every(parsedComponentIsDisplayOnly);

  return (
    comp.kind === 'text' ||
    comp.kind === 'markdown' ||
    comp.kind === 'progress' ||
    comp.kind === 'loader' ||
    comp.kind === 'image' ||
    (comp.kind === 'settings' && !comp.items.some((it) => !!it.values?.length))
  );
}

export function customModalNeedsTextInput(comp: ParsedComponent | undefined): boolean {
  if (!comp) return true;
  if (
    parsedComponentHasInput(comp) ||
    parsedComponentHasAction(comp) ||
    parsedComponentIsDisplayOnly(comp)
  )
    return false;
  return true;
}

export type ExtensionOptionParts = {
  index: string;
  label: string;
  description?: string;
};

/** Split an extension select option ("1. Label — description") into parts. */
export function extensionOptionParts(option: string, index: number): ExtensionOptionParts {
  const numbered = option.match(/^\s*(\d+)\.\s*(.*)$/);
  const text = numbered?.[2] ?? option.trim();
  const separator = text.indexOf(' — ');
  return {
    index: numbered?.[1] ?? String(index + 1),
    label: separator >= 0 ? text.slice(0, separator) : text,
    ...(separator >= 0 ? { description: text.slice(separator + 3) } : {}),
  };
}
