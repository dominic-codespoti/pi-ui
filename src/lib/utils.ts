import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Compact relative timestamp: "just now", "5m ago", "yesterday", "Mar 4". */
export function formatRelativeDate(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < 2 * min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Adds an optional `ref` bindable to a component's props (mirrors bits-ui). */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null;
};

/** Strips the `children` snippet prop (mirrors bits-ui). */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;

/** Strips the `child` snippet prop (mirrors bits-ui). */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;

/** Strips both `children` and `child` snippet props (mirrors bits-ui). */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
