/**
 * Shallow routing helpers (history entry + `page.state` only — no load, no
 * navigation). SvelteKit 3 deprecated `pushState`/`replaceState` in favour of
 * `goto(url, { state, shallow: true })`, which runs the same `update_state`
 * path. Pass `''` for the current URL.
 */
import { goto } from '$app/navigation';

export function shallowPush(url: string | URL, state: App.PageState): Promise<void> {
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- shallow routing to the current page (or a same-page query change), not route navigation
  return goto(url, { state, shallow: true });
}

export function shallowReplace(url: string | URL, state: App.PageState): Promise<void> {
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- shallow routing to the current page (or a same-page query change), not route navigation
  return goto(url, { state, shallow: true, replace: true });
}
