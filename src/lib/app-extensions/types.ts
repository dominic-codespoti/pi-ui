/** Shared, browser-safe contracts for trusted app-level extensions. */
export const APP_EXTENSION_API_VERSION = 1 as const;

export const APP_EXTENSION_SLOTS = ['sidebar', 'right-panel', 'workspace'] as const;
export type AppExtensionSlot = (typeof APP_EXTENSION_SLOTS)[number];

/**
 * Sensitive server capabilities an extension must declare in its manifest.
 * Shown on the app card; the server context rejects undeclared use.
 * - `workspace.write`: write files under the project root.
 * - `session.read`: read the calling session's recent transcript.
 * - `catalog.list`: list projects and sessions.
 */
export const APP_EXTENSION_CAPABILITIES = [
  'workspace.write',
  'session.read',
  'catalog.list',
] as const;
export type AppExtensionCapability = (typeof APP_EXTENSION_CAPABILITIES)[number];

/** Project IDs carry canonical project cwd values; session IDs are catalog-validated IDs. */
export interface AppExtensionScope {
  projectId?: string;
  sessionId?: string;
}

export interface AppExtensionViewContribution {
  id: string;
  title: string;
  slot: AppExtensionSlot;
  icon?: string;
  order?: number;
}

export interface AppExtensionOperationDeclaration {
  id: string;
  kind: 'read' | 'action';
  description: string;
  /** Required context; omitted means app-scoped. This is validated server-side. */
  scope?: 'app' | 'project' | 'session';
  /** JSON-Schema-shaped metadata for authoring and agent tool registration. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  exposeToAgent?: boolean;
}

/** Persisted package manifest. Runtime code is loaded only after explicit install/enable. */
export interface AppExtensionManifest {
  schemaVersion: 1;
  apiVersion: typeof APP_EXTENSION_API_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string;
  clientEntry: string;
  serverEntry: string;
  views: AppExtensionViewContribution[];
  operations: AppExtensionOperationDeclaration[];
  events?: string[];
  /** Sensitive server capabilities this package may use. Absent means none. */
  capabilities?: AppExtensionCapability[];
}

export interface AppExtensionSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** Same-origin, authenticated URL for the built client entry. */
  clientUrl?: string;
  views: AppExtensionViewContribution[];
  /** Declared sensitive capabilities (always present, empty when none). */
  capabilities: AppExtensionCapability[];
}

export interface AppExtensionCallContext {
  scope: AppExtensionScope;
  caller: { kind: 'ui' | 'agent'; sessionId?: string };
  signal?: AbortSignal;
}

export interface AppExtensionExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
}

/** One projected session transcript message for extension handlers. */
export interface AppExtensionSessionMessage {
  role: 'user' | 'assistant' | 'tool' | 'other';
  text: string;
  toolName?: string;
  isError?: boolean;
}

/** Minimal project catalog entry for extension handlers. */
export interface AppExtensionProjectSummary {
  cwd: string;
  name: string;
}

/** Minimal session catalog entry for extension handlers. */
export interface AppExtensionSessionSummary {
  id: string;
  cwd: string;
  name?: string;
  messageCount: number;
}

/** Server-only services supplied to backend operation handlers. */
export interface AppExtensionExecutionContext extends AppExtensionCallContext {
  workspace: {
    readText(relativePath: string): Promise<string>;
    readJson(relativePath: string): Promise<unknown>;
    listFiles(relativePath?: string): Promise<string[]>;
    /**
     * Write text under the project root (requires the `workspace.write`
     * capability). Parent directories are created; writes are atomic.
     */
    writeText(relativePath: string, content: string): Promise<{ bytesWritten: number }>;
  };
  /** Recent transcript of the calling session (requires `session.read`). */
  session: {
    getMessages(options?: {
      limit?: number;
      kinds?: Array<AppExtensionSessionMessage['role']>;
    }): Promise<AppExtensionSessionMessage[]>;
  };
  /** Project catalog (requires the `catalog.list` capability). */
  projects: {
    list(): Promise<AppExtensionProjectSummary[]>;
  };
  /** Sessions in the calling project (requires the `catalog.list` capability). */
  sessions: {
    list(): Promise<AppExtensionSessionSummary[]>;
  };
  cli: {
    run(
      program: string,
      args: string[],
      options?: { timeoutMs?: number; maxOutputBytes?: number }
    ): Promise<AppExtensionExecResult>;
  };
  storage: {
    get(key: string): Promise<unknown | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  emit(eventName: string, data?: unknown): void;
}

/** Client-only bridge. Implementations must not expose process or filesystem primitives. */
export interface AppExtensionClientApi {
  readonly extensionId: string;
  readonly scope: AppExtensionScope;
  read(
    operationId: string,
    input?: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
  invoke(
    operationId: string,
    input?: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
  subscribe(
    eventName: string,
    listener: (data: unknown) => void,
    scope?: AppExtensionScope
  ): () => void;
  notify(message: string, kind?: 'info' | 'success' | 'warning' | 'error'): void;
  /**
   * Replace the chat composer draft for the session in the view's scope.
   * Rejects when the view has no session scope or it is not the active one.
   */
  setComposerDraft(text: string): Promise<void>;
  /**
   * Ask the user to confirm an action with a host-rendered dialog.
   * Resolves true on confirm, false on cancel/dismiss.
   */
  confirm(options: { title?: string; message: string; confirmLabel?: string }): Promise<boolean>;
  /**
   * Open a project-relative file in the host file viewer.
   * Rejects without a project scope or for paths escaping the project root.
   */
  openFile(path: string): Promise<void>;
  /**
   * Switch chat to another session by ID. The view scope updates reactively.
   */
  switchSession(sessionId: string): Promise<void>;
  /**
   * Submit text as a chat prompt to the session in the view's scope.
   * Rejects when the view has no session scope or the send fails.
   */
  prompt(text: string): Promise<void>;
}

export interface AppExtensionClientModule {
  mount(
    root: HTMLElement,
    api: AppExtensionClientApi
  ): void | (() => void) | { unmount(): void };
}

export interface AppExtensionEvent {
  extensionId: string;
  eventName: string;
  data: unknown;
  scope?: AppExtensionScope;
}
