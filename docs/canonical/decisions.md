# Decisions

## 2026-11-03 — PWA login must not depend on hydration

A rebuilt server and refreshed desktop browser did not recover an installed phone PWA. Missing/cached-failed client assets left the SSR login button disabled, and the public unversioned worker was cached for four hours.

Use native required-field validation and an SSR-enabled submit button; disable only during submission. Keep server-side password validation unchanged. Register one build-versioned worker at the existing root scope with browser cache bypass; revalidate worker responses and install-time precache fetches. Do not clear site data or force-reload active chats. Production builds must complete before service restart.
