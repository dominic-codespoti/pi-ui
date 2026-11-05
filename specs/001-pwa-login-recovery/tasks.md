---
last_verified: 2026-11-05
---
# Tasks

## Setup / foundational
- [x] [US1] Trace native authentication and reproduce missing-hydration disabling.
- [x] [US2] Establish stale public worker and cached-asset failure evidence.
Foundational checkpoint: authentication action already works; no credential migration.

## US1
- [x] [P] [US1] Make the existing native login form usable without JavaScript and cover the regression.

## US2
- [x] [P] [US2] Version and consolidate worker registration, revalidate worker responses and precache requests.

## Verification
- [x] [US1] Exercise native and hydrated sign-in against an isolated built server.
- [ ] [US2] Deploy only a complete build and verify public worker freshness and stale-cache recovery.
