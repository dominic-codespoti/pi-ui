import type { ClientMessage } from '#lib/ws/protocol.js';
import {
  MAX_IMAGE_PAYLOAD,
  TEXT_FILE_EXTENSIONS,
  prepareImage,
  fileToText,
} from '#lib/attachments.js';

export type PreparedImage = { data: string; mimeType: string };
export type AttachedImage = PreparedImage & { name: string; src: string };
/** A text attachment staged inline; spreadsheet parsing and binary upload staging remain page-owned. */
export type AttachedFile = { name: string; content: string; size: number };
export type ComposerDraft = {
  input: string;
  attachedImages: AttachedImage[];
  attachedFiles: AttachedFile[];
};

export type ComposerState = ComposerDraft;
export type ComposerNoticeLevel = 'info' | 'warning' | 'error';
export type ComposerNotice = { message: string; level: ComposerNoticeLevel };

export type ComposerContext = {
  websocketOpen: boolean;
  loading: boolean;
  pendingNewSession?: boolean;
  streaming: boolean;
  sessionId: string | null;
  extensionCommands?: readonly string[];
  /** An explicit new-session failure restores the draft captured at beginPendingNewSession. */
  sessionError?: string | null;
  /** Timeout responses may arrive after the server created the new session. */
  newSessionTimedOut?: boolean;
};

export type ComposerMessageClassification =
  | { kind: 'shell'; command: string; text: string }
  | {
      kind: 'slash';
      command: string;
      args: string;
      text: string;
      route: ComposerSlashRoute;
      blockedWhileStreaming: boolean;
    }
  | { kind: 'prompt'; text: string };

export type ComposerSlashRoute =
  | 'new'
  | 'compact'
  | 'fork'
  | 'resume'
  | 'model'
  | 'copy'
  | 'hotkeys'
  | 'settings'
  | 'thinking'
  | 'trust'
  | 'reload'
  | 'login'
  | 'logout'
  | 'session'
  | 'clone'
  | 'export'
  | 'import'
  | 'bug'
  | 'share'
  | 'changelog'
  | 'name'
  | 'tree'
  | 'extension'
  | 'shell'
  | 'unknown';

export type ComposerEffect =
  | { type: 'notice'; notice: ComposerNotice }
  | { type: 'new_session'; targetCwd?: string }
  | { type: 'open_fork_dialog' }
  | { type: 'open_session_panel' }
  | { type: 'open_model_panel' }
  | { type: 'copy_last_assistant' }
  | { type: 'show_hotkeys' }
  | { type: 'open_settings'; section?: 'session' | 'shortcuts' }
  | { type: 'open_import' }
  | { type: 'confirm_share'; sessionId?: string }
  | { type: 'open_tree_modal' };

export type ComposerUserMessage = {
  id: string;
  role: 'user';
  content: string;
  images?: string[];
  streaming: false;
  createdAt: number;
};

export type SubmitFailureReason = 'disconnected' | 'loading' | 'empty' | 'send_rejected';
export type SubmitResult =
  | {
      accepted: true;
      kind: 'prompt' | 'steer' | 'follow_up' | 'command';
      message?: ClientMessage;
      userMessage?: ComposerUserMessage;
      effects: ComposerEffect[];
    }
  | {
      accepted: false;
      reason: SubmitFailureReason;
      effects: ComposerEffect[];
    };

/**
 * Results from inline attachment ingestion. The controller handles images and
 * extensions in TEXT_FILE_EXTENSIONS only. Spreadsheet parsing and binary
 * upload staging are page-owned; callers must handle returned `unsupported`
 * files through those page-owned paths.
 */
export type AttachmentIngestionResult = {
  accepted: Array<AttachedImage | AttachedFile>;
  rejected: Array<{ name: string; reason: string }>;
  /** Files not handled inline, such as spreadsheets and binary uploads. */
  unsupported: File[];
  notices: ComposerNotice[];
};

export type ComposerControllerOptions = {
  prepareImage?: (file: File) => Promise<PreparedImage | null>;
  /** Reads an accepted text extension; spreadsheet and binary ingestion is page-owned. */
  fileToText?: (file: File) => Promise<string>;
  send?: (message: ClientMessage) => boolean | void;
  dispatchEffect?: (effect: ComposerEffect) => boolean | void;
  createId?: () => string;
  now?: () => number;
  maxImagePayload?: number;
  maxTextFileSize?: number;
};

export type ComposerAttachmentContext = {
  sessionId: string | null;
  generation: number;
};

const STREAMING_BLOCKED_COMMANDS: Record<string, true> = {
  compact: true,
  reload: true,
  login: true,
  logout: true,
  clone: true,
};
const BUILTIN_COMMANDS: Record<string, true> = {
  new: true,
  compact: true,
  fork: true,
  resume: true,
  model: true,
  copy: true,
  hotkeys: true,
  settings: true,
  thinking: true,
  trust: true,
  reload: true,
  login: true,
  logout: true,
  session: true,
  clone: true,
  export: true,
  bug: true,
  import: true,
  share: true,
  changelog: true,
  name: true,
  tree: true,
  shell: true,
};

const defaultId = (): string => crypto.randomUUID();

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return {
    input: draft.input,
    attachedImages: draft.attachedImages.map((image) => ({ ...image })),
    attachedFiles: draft.attachedFiles.map((file) => ({ ...file })),
  };
}

function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/** Classify text without invoking any UI or transport side effects. */
export function classifyComposerMessage(
  value: string,
  extensionCommands: readonly string[] = [],
  streaming = false
): ComposerMessageClassification {
  const text = value.trim();
  if (text === '!') return { kind: 'prompt', text };
  if (text.startsWith('!')) {
    return { kind: 'shell', command: text.slice(1).trim(), text };
  }
  if (!text.startsWith('/')) return { kind: 'prompt', text };

  const [rawCommand = '', ...rest] = text.slice(1).split(/\s+/);
  const command = rawCommand.toLowerCase();
  const args = rest.join(' ').trim();
  let route: ComposerSlashRoute =
    command in BUILTIN_COMMANDS ? (command as ComposerSlashRoute) : 'unknown';
  if (
    route === 'unknown' &&
    extensionCommands.some((candidate) => candidate.toLowerCase() === command)
  ) {
    route = 'extension';
  }
  return {
    kind: 'slash',
    command,
    args,
    text,
    route,
    blockedWhileStreaming: streaming && command in STREAMING_BLOCKED_COMMANDS,
  };
}

/** Build the text and image shape accepted by a normal prompt. */
export function buildPromptContent(
  text: string,
  images: readonly AttachedImage[],
  files: readonly AttachedFile[],
  sessionId: string | null = null
): Extract<ClientMessage, { type: 'prompt' }> {
  const trimmed = text.trim();
  const fullText =
    files.length > 0
      ? files.map((file) => `Content of ${file.name}:\n${file.content}`).join('\n\n---\n\n') +
        (trimmed ? `\n\n---\n\n${trimmed}` : '')
      : trimmed;
  const payloadImages =
    images.length > 0 ? images.map(({ data, mimeType }) => ({ data, mimeType })) : undefined;
  return {
    type: 'prompt',
    ...(sessionId ? { sessionId } : {}),
    message: fullText,
    ...(payloadImages ? { images: payloadImages } : {}),
  };
}

export function canSubmitFollowUp(context: ComposerContext, state: ComposerState): boolean {
  return (
    context.websocketOpen &&
    !context.loading &&
    !context.pendingNewSession &&
    !context.streaming &&
    state.input.trim().length > 0 &&
    state.attachedImages.length === 0 &&
    state.attachedFiles.length === 0
  );
}

/**
 * Owns composer state and decisions while leaving DOM work, haptics, STT, and
 * modal presentation to the page. All mutable state is instance-local.
 */
export class ComposerController {
  private state: ComposerState = { input: '', attachedImages: [], attachedFiles: [] };
  private context: ComposerContext = {
    websocketOpen: false,
    loading: true,
    pendingNewSession: false,
    streaming: false,
    sessionId: null,
    extensionCommands: [],
  };
  private pendingNewSessionDraft: ComposerDraft | null = null;
  private attachmentGeneration = 0;
  private disposed = false;
  private readonly prepare: (file: File) => Promise<PreparedImage | null>;
  private readonly readText: (file: File) => Promise<string>;
  private readonly send?: (message: ClientMessage) => boolean | void;
  private readonly dispatchEffect?: (effect: ComposerEffect) => boolean | void;
  private readonly createId: () => string;
  private readonly now: () => number;
  private readonly maxImagePayload: number;
  private readonly maxTextFileSize: number;
  private listener: ((state: ComposerState) => void) | undefined;

  constructor(options: ComposerControllerOptions = {}) {
    this.prepare = options.prepareImage ?? prepareImage;
    this.readText = options.fileToText ?? fileToText;
    this.send = options.send;
    this.dispatchEffect = options.dispatchEffect;
    this.createId = options.createId ?? defaultId;
    this.now = options.now ?? (() => Date.now());
    this.maxImagePayload = options.maxImagePayload ?? MAX_IMAGE_PAYLOAD;
    this.maxTextFileSize = options.maxTextFileSize ?? 1024 * 1024;
  }

  get current(): ComposerState {
    return cloneDraft(this.state);
  }

  get currentContext(): ComposerContext {
    return { ...this.context, extensionCommands: [...(this.context.extensionCommands ?? [])] };
  }

  subscribe(listener: (state: ComposerState) => void): () => void {
    if (this.disposed) return () => {};
    this.listener = listener;
    listener(this.current);
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  private publish(): void {
    if (!this.disposed) this.listener?.(this.current);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attachmentGeneration++;
    this.listener = undefined;
  }

  setInput(input: string): void {
    if (this.disposed || this.state.input === input) return;
    this.state.input = input;
    this.publish();
  }

  setDraft(draft: ComposerDraft): void {
    if (this.disposed) return;
    this.state = cloneDraft(draft);
    this.publish();
  }

  captureDraft(): ComposerDraft {
    return this.current;
  }

  restoreDraft(draft: ComposerDraft): void {
    this.setDraft(draft);
  }

  clearDraft(): void {
    if (
      this.state.input === '' &&
      this.state.attachedImages.length === 0 &&
      this.state.attachedFiles.length === 0
    )
      return;
    this.state = { input: '', attachedImages: [], attachedFiles: [] };
    this.publish();
  }
  /** Reconcile page-owned lifecycle context and preserve drafts around new-session transitions. */
  updateContext(next: ComposerContext): void {
    const wasPending = this.context.pendingNewSession === true;
    const isPending = next.pendingNewSession === true;
    if (
      this.context.sessionId !== next.sessionId ||
      wasPending !== isPending ||
      (!this.context.loading && next.loading)
    ) {
      this.attachmentGeneration++;
    }
    this.context = {
      ...next,
      extensionCommands: [...(next.extensionCommands ?? [])],
    };
    if (isPending && !wasPending) {
      if (!this.pendingNewSessionDraft) this.pendingNewSessionDraft = this.captureDraft();
      // Keep staged attachments during the optimistic transition, matching the page's
      // existing behavior; the new authoritative session may clear them explicitly.
      this.setInput('');
    } else if (!isPending && wasPending && next.sessionError && !next.newSessionTimedOut) {
      if (this.pendingNewSessionDraft) this.restoreDraft(this.pendingNewSessionDraft);
      this.pendingNewSessionDraft = null;
    } else if (!isPending && wasPending) {
      this.pendingNewSessionDraft = null;
    }
  }

  captureAttachmentContext(): ComposerAttachmentContext {
    return { sessionId: this.context.sessionId, generation: this.attachmentGeneration };
  }

  isAttachmentContextCurrent(context: ComposerAttachmentContext): boolean {
    return (
      !this.disposed &&
      context.generation === this.attachmentGeneration &&
      context.sessionId === this.context.sessionId
    );
  }

  restorePendingNewSessionDraft(): boolean {
    if (!this.pendingNewSessionDraft) return false;
    this.restoreDraft(this.pendingNewSessionDraft);
    this.pendingNewSessionDraft = null;
    return true;
  }

  clearAttachments(): void {
    if (this.disposed) return;
    this.attachmentGeneration++;
    if (this.state.attachedImages.length === 0 && this.state.attachedFiles.length === 0) return;
    this.state.attachedImages = [];
    this.state.attachedFiles = [];
    this.publish();
  }

  removeAttachment(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.attachedImages.length) {
      return false;
    }
    this.state.attachedImages.splice(index, 1);
    this.publish();
    return true;
  }

  removeFileAttachment(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.state.attachedFiles.length) {
      return false;
    }
    this.state.attachedFiles.splice(index, 1);
    this.publish();
    return true;
  }
  /** Ingest images and accepted text extensions; spreadsheet and binary files are page-owned. */
  async processAttachmentFiles(files: readonly File[]): Promise<AttachmentIngestionResult> {
    const attachmentContext = this.captureAttachmentContext();
    const accepted: Array<AttachedImage | AttachedFile> = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const unsupported: File[] = [];
    const notices: ComposerNotice[] = [];
    for (const file of files) {
      if (!this.isAttachmentContextCurrent(attachmentContext)) {
        return { accepted: [], rejected: [], unsupported: [], notices: [] };
      }
      const name = file.name || 'clipboard image';
      if (file.type.startsWith('image/')) {
        try {
          const prepared = await this.prepare(file);
          if (!this.isAttachmentContextCurrent(attachmentContext)) {
            return { accepted: [], rejected: [], unsupported: [], notices: [] };
          }
          if (!prepared) {
            const reason = `Could not prepare image: ${name}`;
            rejected.push({ name, reason });
            notices.push({ message: reason, level: 'warning' });
            continue;
          }
          if (prepared.data.length > this.maxImagePayload) {
            const reason = `Image too large: ${name} (max 3MB encoded)`;
            rejected.push({ name, reason });
            notices.push({ message: reason, level: 'warning' });
            continue;
          }
          const image: AttachedImage = {
            ...prepared,
            name,
            src: `data:${prepared.mimeType};base64,${prepared.data}`,
          };
          this.state.attachedImages.push(image);
          accepted.push({ ...image });
        } catch {
          if (!this.isAttachmentContextCurrent(attachmentContext)) {
            return { accepted: [], rejected: [], unsupported: [], notices: [] };
          }
          const reason = `Could not prepare image: ${name}`;
          rejected.push({ name, reason });
          notices.push({ message: reason, level: 'warning' });
        }
        continue;
      }

      if (!TEXT_FILE_EXTENSIONS.has(fileExtension(name))) {
        unsupported.push(file);
        continue;
      }
      if (file.size > this.maxTextFileSize) {
        const reason = `File too large: ${name} (max 1MB)`;
        rejected.push({ name, reason });
        notices.push({ message: reason, level: 'warning' });
        continue;
      }
      try {
        const content = await this.readText(file);
        if (!this.isAttachmentContextCurrent(attachmentContext)) {
          return { accepted: [], rejected: [], unsupported: [], notices: [] };
        }
        const textFile: AttachedFile = { name, content, size: file.size };
        this.state.attachedFiles.push(textFile);
        accepted.push({ ...textFile });
      } catch {
        if (!this.isAttachmentContextCurrent(attachmentContext)) {
          return { accepted: [], rejected: [], unsupported: [], notices: [] };
        }
        const reason = `Could not read file: ${name}`;
        rejected.push({ name, reason });
        notices.push({ message: reason, level: 'warning' });
      }
    }
    if (accepted.length > 0) this.publish();
    return { accepted, rejected, unsupported, notices };
  }

  classify(text = this.state.input): ComposerMessageClassification {
    return classifyComposerMessage(
      text,
      this.context.extensionCommands ?? [],
      this.context.streaming
    );
  }

  canSubmitFollowUp(): boolean {
    return canSubmitFollowUp(this.context, this.state);
  }

  private effect(effect: ComposerEffect, effects: ComposerEffect[]): boolean {
    effects.push(effect);
    return this.dispatchEffect?.(effect) !== false;
  }

  private sendMessage(message: ClientMessage): boolean {
    if (!this.send) return false;
    return this.send(message) !== false;
  }
  submit(asFollowUp = false): SubmitResult {
    const effects: ComposerEffect[] = [];
    if (!this.context.websocketOpen) return { accepted: false, reason: 'disconnected', effects };
    if (this.context.loading || this.context.pendingNewSession)
      return { accepted: false, reason: 'loading', effects };

    const text = this.state.input.trim();
    const hasAttachments =
      this.state.attachedImages.length > 0 || this.state.attachedFiles.length > 0;
    if (!text && !hasAttachments) return { accepted: false, reason: 'empty', effects };

    const classification = this.classify(text);
    if (!asFollowUp && classification.kind !== 'prompt' && !hasAttachments) {
      if (classification.kind === 'shell') {
        if (!classification.command) return { accepted: false, reason: 'empty', effects };
        const message: ClientMessage = {
          type: 'run_builtin',
          ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
          command: 'shell',
          args: classification.command,
        };
        if (!this.sendMessage(message))
          return { accepted: false, reason: 'send_rejected', effects };
        this.clearDraft();
        return { accepted: true, kind: 'command', message, effects };
      }
      if (classification.blockedWhileStreaming) {
        this.effect(
          {
            type: 'notice',
            notice: {
              message: 'Wait for the agent to finish before running this command.',
              level: 'warning',
            },
          },
          effects
        );
        return { accepted: false, reason: 'send_rejected', effects };
      }
      const route = classification.route;
      let message: ClientMessage | undefined;
      let effectAccepted = true;
      switch (route) {
        case 'new':
          this.pendingNewSessionDraft = this.captureDraft();
          effectAccepted = this.effect(
            {
              type: 'new_session',
              ...(classification.args ? { targetCwd: classification.args } : {}),
            },
            effects
          );
          break;
        case 'fork':
          effectAccepted = this.effect({ type: 'open_fork_dialog' }, effects);
          break;
        case 'resume':
          effectAccepted = this.effect({ type: 'open_session_panel' }, effects);
          break;
        case 'model':
          effectAccepted = this.effect({ type: 'open_model_panel' }, effects);
          break;
        case 'settings':
          effectAccepted = this.effect({ type: 'open_settings' }, effects);
          break;
        case 'trust':
          effectAccepted = this.effect({ type: 'open_settings', section: 'session' }, effects);
          break;
        case 'thinking':
          message = classification.args
            ? {
                type: 'set_thinking_level',
                ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
                level: classification.args,
              }
            : {
                type: 'cycle_thinking_level',
                ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
              };
          break;
        case 'bug':
          message = {
            type: 'run_builtin',
            ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
            command: 'bug_preview',
            ...(classification.args ? { args: classification.args } : {}),
          };
          break;
        case 'import':
          effectAccepted = this.effect({ type: 'open_import' }, effects);
          break;
        case 'share':
          effectAccepted = this.effect(
            {
              type: 'confirm_share',
              ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
            },
            effects
          );
          break;
        case 'copy':
          effectAccepted = this.effect({ type: 'copy_last_assistant' }, effects);
          break;
        case 'hotkeys':
          effectAccepted = this.effect({ type: 'show_hotkeys' }, effects);
          break;
        case 'tree':
          effectAccepted = this.effect({ type: 'open_tree_modal' }, effects);
          break;
        case 'compact':
          message = {
            type: 'compact',
            ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
            ...(classification.args ? { customInstructions: classification.args } : {}),
          };
          break;
        case 'extension':
          message = {
            type: 'run_builtin',
            ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
            command: 'extension',
            args: classification.text,
          };
          break;
        case 'unknown':
          // Unknown slash text is ordinary prompt text, preserving the existing fallback.
          break;
        default:
          message = {
            type: 'run_builtin',
            ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
            command: route,
            ...(classification.args ? { args: classification.args } : {}),
          };
          break;
      }
      if (!effectAccepted) return { accepted: false, reason: 'send_rejected', effects };
      if (route === 'unknown') {
        // Fall through to the normal prompt path below.
      } else {
        if (message && !this.sendMessage(message))
          return { accepted: false, reason: 'send_rejected', effects };
        this.clearDraft();
        return { accepted: true, kind: 'command', message, effects };
      }
    }

    if (this.context.streaming) {
      if (!text) return { accepted: false, reason: 'empty', effects };
      const message: ClientMessage = {
        type: 'steer',
        ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
        message: text,
      };
      if (!this.sendMessage(message)) return { accepted: false, reason: 'send_rejected', effects };
      this.setInput('');
      return { accepted: true, kind: 'steer', message, effects };
    }

    const prompt = buildPromptContent(
      text,
      this.state.attachedImages,
      this.state.attachedFiles,
      this.context.sessionId
    );
    const message: ClientMessage =
      asFollowUp && !hasAttachments
        ? {
            type: 'follow_up',
            ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
            message: text,
          }
        : prompt;
    if (!this.sendMessage(message)) return { accepted: false, reason: 'send_rejected', effects };

    const userMessage: ComposerUserMessage = {
      id: this.createId(),
      role: 'user',
      content: prompt.message,
      images:
        this.state.attachedImages.length > 0
          ? this.state.attachedImages.map((image) => image.src)
          : undefined,
      streaming: false,
      createdAt: this.now(),
    };
    this.clearDraft();
    return {
      accepted: true,
      kind: message.type === 'follow_up' ? 'follow_up' : 'prompt',
      message,
      userMessage,
      effects,
    };
  }
}
