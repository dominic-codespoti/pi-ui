import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
