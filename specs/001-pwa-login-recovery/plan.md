---
last_verified: 2026-11-03
---
# Plan

## Technical context
SvelteKit SSR/native POST, Bun server, custom Bun adapter, root-scope service worker and Cloudflare public origin. A phone refresh still leaves the existing JavaScript-dependent submit disabled; public unversioned worker responses were observed cached for four hours.

## Constitution check
No project constitution is tracked. Preserve authentication, session data, notifications and immutable asset performance. Reuse existing form, worker and final response-header wrapper. No dependencies, reload loops, storage clearing, new endpoints or password changes.

## Structure and execution
US1: simplify the login submit state and retain native required validation; cover missing-hydration behavior in existing auth browser suite.
US2: shared registration helper uses build-versioned URL, root scope and updateViaCache none; disable duplicate generated registration. Server adds worker-only no-cache. Worker precache requests use cache reload.
Integrate, build locally once, run focused auth checks and runtime worker inspection. Deploy the completed build and source together to the Pi while idle; restart only pi-ui and verify through the public endpoint. Try the physical PWA only through authorized ADB, otherwise disclose that limit.

## Post-design gate
The change stays in existing components, does not change authentication or session protocols, and has no complexity exceptions.
