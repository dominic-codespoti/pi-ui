---
last_verified: 2026-11-03
---
# PWA login recovery

## US1 — P1: Sign in without hydration
Why priority: a missing or cached-failed client chunk currently disables the only sign-in action.
Independent test: open the login page with JavaScript disabled or the app entry chunk unavailable and submit the configured password.

Given an unauthenticated browser whose client JavaScript cannot run, when a valid password is submitted, then the native form authenticates and redirects to the app. Given an empty input, when submit is attempted, then native required-field validation prevents submission. Invalid credentials remain rejected by the existing server action.

## US2 — P1: Update an installed PWA across releases
Why priority: the phone can retain an old worker or failed HTTP asset response even after the origin is corrected.
Independent test: load a new build while a previous worker exists and confirm the current worker is requested by build version with fresh asset reads.

Given an old worker and cached unversioned worker response, when the current app loads, then its build-specific worker is registered at the same root scope. Given a new worker installation, when its precache is populated, then listed assets are revalidated rather than copied from failed HTTP cache responses.

## Requirements
FR-001 The system MUST allow native login before client hydration.
FR-002 The system MUST preserve required-password and server-side password validation.
FR-003 The system MUST use one worker registration owner and a build-versioned worker URL.
FR-004 The system MUST require revalidation of the worker response and its install-time assets.
FR-005 The system MUST preserve credentials, chat/session data, and notification behavior and MUST NOT force reload active drafts.

## Entities and success criteria
Entities: login form, build version, root-scope worker registration, immutable asset precache.
Success: native login reaches the app; public worker responses require revalidation; the deployed browser registers the current version; existing offline immutable-asset caching remains.

## Assumptions
The existing native POST action is the authentication authority. No password change, data reset, or phone reinstallation is required. Physical handset verification depends on an authorized ADB connection; browser-only evidence must be identified as such.
