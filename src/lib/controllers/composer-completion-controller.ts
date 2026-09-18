import type { ClientMessage, ServerMessage } from '#lib/ws/protocol.js';

export type CompletionTrigger = '/' | '@' | '!' | '#';
export type CompletionItem = { value: string; label: string; description?: string };
export type CommandArgMode = {
  command: string;
  prefix: string;
  parentPrefix?: string;
  currentToken?: string;
};

export type CompletionControllerState = {
  fileCompletions: string[];
  extensionCompletions: CompletionItem[];
  commandArgCompletions: CompletionItem[];
  lastFileQuery: string;
  lastExtensionTrigger: string;
  lastExtensionQuery: string;
  commandArgCommand: string;
  commandArgPrefix: string;
  commandCompletionsPending: boolean;
  latestFileRequestId: string | null;
  latestExtensionRequestId: string | null;
  latestCommandRequestId: string | null;
  sessionId: string | null;
};

export type CompletionView = {
  websocketOpen: boolean;
  loading: boolean;
  sessionId: string | null;
  trigger: CompletionTrigger | null;
  query: string;
  commandArgMode: CommandArgMode | null;
};

export type CompletionResponse =
  | {
      type: 'file_completions';
      sessionId: string;
      requestId: string;
      query: string;
      entries?: string[];
      error?: string;
    }
  | {
      type: 'extension_completions';
      sessionId: string;
      requestId: string;
      trigger: string;
      query: string;
      items?: CompletionItem[];
      error?: string;
    }
  | {
      type: 'command_completions';
      sessionId: string;
      requestId: string;
      command: string;
      prefix: string;
      items?: CompletionItem[];
      error?: string;
    };

export type CompletionControllerOptions = {
  debounceMs?: number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
};

const initialState = (sessionId: string | null = null): CompletionControllerState => ({
  fileCompletions: [],
  extensionCompletions: [],
  commandArgCompletions: [],
  lastFileQuery: '',
  lastExtensionTrigger: '',
  lastExtensionQuery: '',
  commandArgCommand: '',
  commandArgPrefix: '',
  commandCompletionsPending: false,
  latestFileRequestId: null,
  latestExtensionRequestId: null,
  latestCommandRequestId: null,
  sessionId,
});

type CompletionChannel = 'file' | 'extension' | 'command';

/**
 * Owns composer completion debounce timers and request/session correlation.
 * The page supplies only a sender and projects this plain state into runes;
 * no Svelte or component state crosses this boundary.
 */
export class ComposerCompletionController {
  private state: CompletionControllerState;
  private readonly send: (message: ClientMessage) => boolean | void;
  private readonly debounceMs: number;
  private readonly schedule: NonNullable<CompletionControllerOptions['setTimeout']>;
  private readonly cancel: NonNullable<CompletionControllerOptions['clearTimeout']>;
  private timers: Partial<Record<CompletionChannel, ReturnType<typeof globalThis.setTimeout>>> = {};
  private requestSequence = 0;
  private currentView: CompletionView = {
    websocketOpen: false,
    loading: true,
    sessionId: null,
    trigger: null,
    query: '',
    commandArgMode: null,
  };
  private listener: ((state: CompletionControllerState) => void) | undefined;

  constructor(
    send: (message: ClientMessage) => boolean | void,
    options: CompletionControllerOptions = {}
  ) {
    this.state = initialState();
    this.send = send;
    this.debounceMs = options.debounceMs ?? 200;
    this.schedule =
      options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancel = options.clearTimeout ?? ((timer) => globalThis.clearTimeout(timer));
  }

  get current(): CompletionControllerState {
    return this.state;
  }

  subscribe(listener: (state: CompletionControllerState) => void): () => void {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  private publish(): void {
    this.listener?.(this.state);
  }

  private clearTimer(channel: CompletionChannel): void {
    const timer = this.timers[channel];
    if (timer !== undefined) {
      this.cancel(timer);
      delete this.timers[channel];
    }
  }

  clearTimers(): void {
    this.clearTimer('file');
    this.clearTimer('extension');
    this.clearTimer('command');
  }

  reset(sessionId = this.state.sessionId): void {
    this.clearTimers();
    this.state = initialState(sessionId);
    this.publish();
  }

  setSession(sessionId: string | null): void {
    if (sessionId === this.state.sessionId) return;
    this.reset(sessionId);
  }

  private arm(channel: CompletionChannel, callback: () => void): void {
    this.clearTimer(channel);
    this.timers[channel] = this.schedule(() => {
      delete this.timers[channel];
      callback();
    }, this.debounceMs);
  }
  private nextRequestId(): string {
    this.requestSequence += 1;
    return String(this.requestSequence);
  }

  private validView(view: CompletionView, sessionId: string): boolean {
    const current = this.currentView;
    const mode = view.commandArgMode;
    const currentMode = current.commandArgMode;
    return (
      view.websocketOpen &&
      !view.loading &&
      !!sessionId &&
      view.sessionId === sessionId &&
      this.state.sessionId === sessionId &&
      current.websocketOpen &&
      !current.loading &&
      current.sessionId === sessionId &&
      current.trigger === view.trigger &&
      current.query === view.query &&
      (mode?.command ?? '') === (currentMode?.command ?? '') &&
      (mode?.prefix ?? '') === (currentMode?.prefix ?? '')
    );
  }

  /**
   * Reconcile the current trigger/query. Calling this from the page's effect
   * is idempotent; changed values cancel prior timers and invalidate old
   * request ids before scheduling the new request.
   */
  update(view: CompletionView): void {
    this.currentView = {
      ...view,
      commandArgMode: view.commandArgMode ? { ...view.commandArgMode } : null,
    };
    const sessionId = view.sessionId;
    if (sessionId !== this.state.sessionId) this.setSession(sessionId);
    const usable = view.websocketOpen && !view.loading && !!sessionId;

    if (usable && view.trigger === '@' && view.query !== this.state.lastFileQuery) {
      this.state.lastFileQuery = view.query;
      this.state.latestFileRequestId = null;
      this.state.fileCompletions = [];
      const requestSessionId = sessionId;
      const requestQuery = view.query;
      this.arm('file', () => {
        if (!this.validView(view, requestSessionId!)) return;
        const requestId = this.nextRequestId();
        this.state.latestFileRequestId = requestId;
        this.send({
          type: 'file_complete',
          sessionId: requestSessionId!,
          requestId,
          query: requestQuery,
        });
      });
      this.publish();
    } else if (!usable || view.trigger !== '@') {
      this.clearTimer('file');
      this.state.lastFileQuery = '';
      this.state.fileCompletions = [];
      this.state.latestFileRequestId = null;
    }

    if (
      usable &&
      view.trigger !== null &&
      (view.trigger !== this.state.lastExtensionTrigger ||
        view.query !== this.state.lastExtensionQuery)
    ) {
      this.state.lastExtensionTrigger = view.trigger;
      this.state.lastExtensionQuery = view.query;
      this.state.extensionCompletions = [];
      this.state.latestExtensionRequestId = null;
      const requestSessionId = sessionId;
      const requestTrigger = view.trigger;
      const requestQuery = view.query;
      this.arm('extension', () => {
        if (!this.validView(view, requestSessionId!)) return;
        const requestId = this.nextRequestId();
        this.state.latestExtensionRequestId = requestId;
        this.send({
          type: 'get_extension_autocomplete',
          sessionId: requestSessionId!,
          requestId,
          trigger: requestTrigger,
          query: requestQuery,
        });
      });
      this.publish();
    } else if (!usable || view.trigger === null) {
      this.clearTimer('extension');
      this.state.lastExtensionTrigger = '';
      this.state.lastExtensionQuery = '';
      this.state.extensionCompletions = [];
      this.state.latestExtensionRequestId = null;
    }

    const mode = view.commandArgMode;
    if (usable && mode) {
      const needsFetch =
        mode.command !== this.state.commandArgCommand ||
        mode.prefix !== this.state.commandArgPrefix;
      if (needsFetch) {
        this.state.commandArgCommand = mode.command;
        this.state.commandArgPrefix = mode.prefix;
        this.state.commandCompletionsPending = true;
        this.state.commandArgCompletions = [];
        this.state.latestCommandRequestId = null;
        const requestSessionId = sessionId;
        const requestCommand = mode.command;
        const requestPrefix = mode.prefix;
        this.arm('command', () => {
          if (!this.validView(view, requestSessionId!)) return;
          const requestId = this.nextRequestId();
          this.state.latestCommandRequestId = requestId;
          this.send({
            type: 'get_command_completions',
            sessionId: requestSessionId!,
            requestId,
            command: requestCommand,
            prefix: requestPrefix,
          });
        });
      }
    } else {
      this.clearTimer('command');
      this.state.commandArgCompletions = [];
      this.state.commandArgCommand = '';
      this.state.commandArgPrefix = '';
      this.state.commandCompletionsPending = false;
      this.state.latestCommandRequestId = null;
    }
    this.publish();
  }

  /** Return true only when a response belongs to the currently visible query. */
  handleResponse(message: ServerMessage | CompletionResponse, view: CompletionView): boolean {
    const response = message as CompletionResponse;
    if (response.type === 'file_completions') {
      if (
        !view.loading &&
        view.websocketOpen &&
        response.sessionId === this.state.sessionId &&
        response.sessionId === view.sessionId &&
        response.requestId === this.state.latestFileRequestId &&
        view.trigger === '@' &&
        response.query === view.query
      ) {
        this.state.fileCompletions = response.entries ?? [];
        this.publish();
        return true;
      }
      return false;
    }
    if (response.type === 'extension_completions') {
      if (
        !view.loading &&
        view.websocketOpen &&
        response.sessionId === this.state.sessionId &&
        response.sessionId === view.sessionId &&
        response.requestId === this.state.latestExtensionRequestId &&
        response.trigger === view.trigger &&
        response.query === view.query
      ) {
        this.state.extensionCompletions = response.items ?? [];
        this.publish();
        return true;
      }
      return false;
    }
    if (response.type === 'command_completions') {
      const mode = view.commandArgMode;
      if (
        !view.loading &&
        view.websocketOpen &&
        mode &&
        response.sessionId === this.state.sessionId &&
        response.sessionId === view.sessionId &&
        response.requestId === this.state.latestCommandRequestId &&
        response.command === this.state.commandArgCommand &&
        response.prefix === this.state.commandArgPrefix &&
        mode.command === response.command &&
        mode.prefix === response.prefix
      ) {
        this.state.commandArgCompletions = response.items ?? [];
        this.state.commandCompletionsPending = false;
        this.publish();
        return true;
      }
      return false;
    }
    return false;
  }

  dispose(): void {
    this.clearTimers();
    this.listener = undefined;
  }
}
