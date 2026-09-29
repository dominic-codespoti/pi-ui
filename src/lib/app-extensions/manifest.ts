/**
 * Runtime validation for trusted app-extension manifests.
 *
 * Structural validation only: a manifest that passes this schema is
 * well-formed, not sandboxed. Client code still loads only after explicit
 * install/enable (see `AppExtensionManifest` in `types.ts`), and the client
 * bridge must not expose process or filesystem primitives. This module makes
 * no claims about permissions or sandboxing — it only rejects malformed
 * manifests before they reach the registry/loader.
 */

import * as v from 'valibot';
import {
  APP_EXTENSION_API_VERSION,
  APP_EXTENSION_CAPABILITIES,
  APP_EXTENSION_SLOTS,
  type AppExtensionCapability,
  type AppExtensionManifest,
  type AppExtensionSlot,
} from './types.js';

// ── Shared primitives ─────────────────────────────────────────────────────────

/** Sane registry IDs: start with a letter/digit, then letters/digits/dot/underscore/dash. */
function idSchema(label: string) {
  return v.pipe(
    v.string(`${label} must be a string`),
    v.minLength(1, `${label} must not be empty`),
    v.maxLength(128, `${label} must be at most 128 characters`),
    v.regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      `${label} must start with a letter or digit and contain only letters, digits, ".", "_" or "-"`,
    ),
  );
}

/** Non-blank trimmed text with a length cap. */
function nonEmptyText(max: number, label: string) {
  return v.pipe(
    v.string(`${label} must be a string`),
    v.minLength(1, `${label} must not be empty`),
    v.maxLength(max, `${label} must be at most ${max} characters`),
    v.check((s) => s.trim().length > 0, `${label} must not be blank`),
  );
}

/** Semantic-ish version: MAJOR.MINOR.PATCH with optional prerelease/build metadata. */
const VersionSchema = v.pipe(
  v.string('Version must be a string'),
  v.regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
    'Version must be a semantic version like "1.2.3"',
  ),
);

/**
 * Safe relative entry path (client or server). Rejects absolute paths, `..`
 * segments, backslashes (ambiguous separators), query/fragment suffixes,
 * null bytes, and empty segments (`//`, trailing slash).
 */
function entryPathSchema(field: string) {
  return v.pipe(
    v.string(`${field} must be a string`),
    v.minLength(1, `${field} must not be empty`),
    v.maxLength(512, `${field} must be at most 512 characters`),
    v.check((s) => !s.includes('\0'), `${field} must not contain null bytes`),
    v.check(
      (s) => !s.includes('\\'),
      `${field} must use forward slashes (backslashes are ambiguous)`,
    ),
    v.check(
      (s) => !s.includes('?') && !s.includes('#'),
      `${field} must not contain a query string or fragment`,
    ),
    v.check(
      (s) => !s.startsWith('/') && !/^[a-zA-Z]:/.test(s),
      `${field} must be a relative path`,
    ),
    v.check(
      (s) => s.split('/').every((segment) => segment.length > 0 && segment !== '..'),
      `${field} must not contain ".." or empty path segments`,
    ),
  );
}

const ClientEntrySchema = entryPathSchema('clientEntry');
const ServerEntrySchema = entryPathSchema('serverEntry');

/** Optional JSON-object metadata (plain object, never an array or primitive). */
const JsonObjectSchema = v.pipe(
  v.unknown(),
  v.check(
    (val) => typeof val === 'object' && val !== null && !Array.isArray(val),
    'Schema must be a JSON object, not an array',
  ),
  v.record(v.string(), v.unknown()),
);

// ── Contributions ─────────────────────────────────────────────────────────────

const LEGACY_PRIMARY_SLOTS = ['main-tab', 'full-page'] as const;
const ViewSlotSchema = v.pipe(
  v.picklist(
    [...APP_EXTENSION_SLOTS, ...LEGACY_PRIMARY_SLOTS],
    'View slot must be a known extension slot',
  ),
  v.transform((slot): AppExtensionSlot =>
    slot === 'main-tab' || slot === 'full-page' ? 'workspace' : slot,
  ),
);

export const AppExtensionViewSchema = v.looseObject({
  id: idSchema('View id'),
  title: nonEmptyText(256, 'View title'),
  // Old package manifests are accepted, but normalized to Workspace at load time.
  slot: ViewSlotSchema,
  icon: v.optional(v.string('View icon must be a string')),
  order: v.optional(
    v.pipe(
      v.number('View order must be a number'),
      v.check((n: number) => Number.isFinite(n), 'View order must be a finite number'),
    ),
  ),
});

export const AppExtensionOperationSchema = v.looseObject({
  id: idSchema('Operation id'),
  kind: v.picklist(['read', 'action'], 'Operation kind must be "read" or "action"'),
  description: nonEmptyText(500, 'Operation description'),
  scope: v.optional(
    v.picklist(['app', 'project', 'session'], 'Operation scope must be "app", "project" or "session"'),
  ),
  inputSchema: v.optional(JsonObjectSchema),
  outputSchema: v.optional(JsonObjectSchema),
  exposeToAgent: v.optional(v.boolean('exposeToAgent must be a boolean')),
});

// ── Manifest ──────────────────────────────────────────────────────────────────

export const AppExtensionManifestSchema = v.looseObject({
  schemaVersion: v.literal(1, 'schemaVersion must be 1'),
  apiVersion: v.literal(
    APP_EXTENSION_API_VERSION,
    `apiVersion must be ${APP_EXTENSION_API_VERSION}`,
  ),
  id: idSchema('Extension id'),
  name: nonEmptyText(200, 'Extension name'),
  version: VersionSchema,
  description: v.optional(v.string('Extension description must be a string')),
  clientEntry: ClientEntrySchema,
  serverEntry: ServerEntrySchema,
  views: v.pipe(
    v.array(AppExtensionViewSchema),
    v.check(
      (views: v.InferOutput<typeof AppExtensionViewSchema>[]) => {
        const ids = views.map((view) => view.id);
        return new Set(ids).size === ids.length;
      },
      'View ids must be unique',
    ),
  ),
  operations: v.pipe(
    v.array(AppExtensionOperationSchema),
    v.check(
      (operations: v.InferOutput<typeof AppExtensionOperationSchema>[]) => {
        const ids = operations.map((operation) => operation.id);
        return new Set(ids).size === ids.length;
      },
      'Operation ids must be unique',
    ),
  ),
  events: v.optional(
    v.pipe(
      v.array(nonEmptyText(128, 'Event name')),
      v.check(
        (events: string[]) => new Set(events).size === events.length,
        'Event names must be unique',
      ),
    ),
  ),
  capabilities: v.optional(
    v.pipe(
      v.array(v.picklist([...APP_EXTENSION_CAPABILITIES], 'Capability must be a known value')),
      v.check(
        (capabilities: AppExtensionCapability[]) => new Set(capabilities).size === capabilities.length,
        'Capabilities must be unique',
      ),
    ),
  ),
  // NB: AppExtensionSummary.clientUrl is response-only and intentionally absent here.
});

/** Inferred manifest type. Must always satisfy the shared contract in `types.ts`. */
export type AppExtensionManifestData = v.InferOutput<typeof AppExtensionManifestSchema>;

// Compile-time guard: the inferred schema output stays assignable to the
// shared `AppExtensionManifest` contract (checked by `bun run check`).
const _manifestMatchesContract: AppExtensionManifest =
  null as unknown as AppExtensionManifestData;
void _manifestMatchesContract;

export type ParseAppExtensionManifestResult =
  | { ok: true; value: AppExtensionManifestData }
  | { ok: false; issues: string[] };

/**
 * Validates an unknown value as an `AppExtensionManifest`.
 * Never throws — returns `{ ok: false, issues: [...] }` on invalid structure.
 */
export function parseAppExtensionManifest(raw: unknown): ParseAppExtensionManifestResult {
  const res = v.safeParse(AppExtensionManifestSchema, raw);
  if (res.success) {
    return { ok: true, value: res.output };
  }
  return {
    ok: false,
    issues: res.issues.map((issue) => {
      const path = issue.path
        ? issue.path
            .map((segment) => segment.key)
            .filter((key) => key !== undefined)
            .join('.')
        : '';
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}
