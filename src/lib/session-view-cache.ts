import type { UIMessage } from '#lib/client-messages.js';
import type { ContextUsage } from '#lib/ws/protocol.js';

/** Maximum number of inactive session views retained in memory. */
export const MAX_RETAINED_SESSION_VIEWS = 3;

/** UI state kept while a session is resident but not currently visible. */
export type SessionViewUiState = {
  expandedUserMsgs: Set<string>;
  truncatedUserMsgs: Set<string>;
  draft: string;
  contextUsage: ContextUsage | null;
  queuedSteering: string[];
  queuedFollowUp: string[];
  queuedDeferred: string[];
  scrollAtBottom: boolean;
};

/** UI state and the retained transcript for an inactive resident session. */
export type SessionView = SessionViewUiState & {
  messages: UIMessage[];
  activeStreamMsg: UIMessage | null;
  toolsById: Map<string, UIMessage>;
};

const IMAGE_DATA_URL_RE = /data:image\/[^;]+;base64,[A-Za-z0-9+/_=-]+/gi;

function stripImageData(value: string): string {
  return value.replace(IMAGE_DATA_URL_RE, '');
}

function isImageData(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/[\w.+-]+;base64,/i.test(value);
}

function stripBinaryArgs(value: Record<string, unknown>): Record<string, unknown> {
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(strip).filter((child): child is unknown => child !== undefined);
    }
    if (!item || typeof item !== 'object') return isImageData(item) ? undefined : item;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) {
      // Tool arguments can contain an image attachment under either a data or
      // src field. Do not let a background view pin those base64 bytes.
      if ((key === 'data' || key === 'src') && isImageData(child)) continue;
      const next = strip(child);
      if (next !== undefined) result[key] = next;
    }
    return result;
  };
  return strip(value) as Record<string, unknown>;
}

function sameBinaryValue(value: unknown, cached: unknown): boolean {
  if (Array.isArray(value)) {
    if (!Array.isArray(cached)) return false;
    let cachedIndex = 0;
    for (const child of value) {
      if (child === undefined || isImageData(child)) continue;
      if (cachedIndex >= cached.length || !sameBinaryValue(child, cached[cachedIndex])) {
        return false;
      }
      cachedIndex++;
    }
    return cachedIndex === cached.length;
  }
  if (value && typeof value === 'object') {
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return false;
    const cachedRecord = cached as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if ((key === 'data' || key === 'src') && isImageData(child)) continue;
      if (isImageData(child)) {
        if (key in cachedRecord) return false;
        continue;
      }
      if (!(key in cachedRecord) || !sameBinaryValue(child, cachedRecord[key])) return false;
    }
    return Object.keys(cachedRecord).every((key) => key in value);
  }
  return isImageData(value) ? cached === undefined : value === cached;
}

function sameStringArray(value: string[] | undefined, cached: string[] | undefined): boolean {
  if (value === undefined) return cached === undefined;
  if (!cached || value.length !== cached.length) return false;
  return value.every((item, index) => stripImageData(item) === cached[index]);
}

function sameRecord(value: object | undefined, cached: object | undefined): boolean {
  if (value === undefined) return cached === undefined;
  if (!cached) return false;
  const left = value as Record<string, unknown>;
  const right = cached as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const child = left[key];
    const cachedChild = right[key];
    if (child && typeof child === 'object') {
      if (!sameRecord(child as object, cachedChild as object | undefined)) return false;
    } else if (child !== cachedChild) {
      return false;
    }
  }
  return true;
}

function sameMessage(message: UIMessage, cached: UIMessage): boolean {
  if (
    message.id !== cached.id ||
    message.role !== cached.role ||
    message.streaming !== cached.streaming ||
    stripImageData(message.content) !== cached.content ||
    (message.toolInput !== undefined && stripImageData(message.toolInput) !== cached.toolInput) ||
    (message.toolInput === undefined && cached.toolInput !== undefined) ||
    (message.diff !== undefined && stripImageData(message.diff) !== cached.diff) ||
    (message.diff === undefined && cached.diff !== undefined) ||
    (message.details !== undefined && stripImageData(message.details) !== cached.details) ||
    (message.details === undefined && cached.details !== undefined) ||
    (message.renderedContent !== undefined &&
      stripImageData(message.renderedContent) !== cached.renderedContent) ||
    (message.renderedContent === undefined && cached.renderedContent !== undefined) ||
    (message.renderedThinking !== undefined &&
      stripImageData(message.renderedThinking) !== cached.renderedThinking) ||
    (message.renderedThinking === undefined && cached.renderedThinking !== undefined) ||
    !sameStringArray(message.renderedCallHtml, cached.renderedCallHtml) ||
    !sameStringArray(message.renderedResultHtml, cached.renderedResultHtml) ||
    !sameStringArray(message.renderedNoticeHtml, cached.renderedNoticeHtml) ||
    (message.toolArgs !== undefined &&
      (!cached.toolArgs || !sameBinaryValue(message.toolArgs, cached.toolArgs))) ||
    (message.toolArgs === undefined && cached.toolArgs !== undefined) ||
    !sameRecord(message.usage, cached.usage) ||
    !sameRecord(message.compaction, cached.compaction)
  ) {
    return false;
  }

  const simpleKeys: (keyof UIMessage)[] = [
    'toolCallId',
    'toolName',
    'isError',
    'aborted',
    'expanded',
    'lineCount',
    'thinking',
    'thinkingExpanded',
    'startMs',
    'endMs',
    'thinkingStartMs',
    'detailExpanded',
    'noticeKind',
    'customType',
    'outputElided',
    'outputBytes',
    'outputLoading',
    'level',
    'source',
    'createdAt',
  ];
  return simpleKeys.every((key) => message[key] === cached[key]);
}

function cloneMessage(message: UIMessage): UIMessage {
  // Attachments are re-fetched from the authoritative snapshot on switch; a
  // background view must never pin their base64 bytes.
  const withoutImages: UIMessage = { ...message };
  delete withoutImages.images;
  return {
    ...withoutImages,
    content: stripImageData(message.content),
    ...(message.toolArgs ? { toolArgs: stripBinaryArgs(message.toolArgs) } : {}),
    ...(message.toolInput ? { toolInput: stripImageData(message.toolInput) } : {}),
    ...(message.diff ? { diff: stripImageData(message.diff) } : {}),
    ...(message.details ? { details: stripImageData(message.details) } : {}),
    renderedContent: message.renderedContent ? stripImageData(message.renderedContent) : undefined,
    renderedThinking: message.renderedThinking
      ? stripImageData(message.renderedThinking)
      : undefined,
    usage: message.usage ? { ...message.usage, cost: { ...message.usage.cost } } : undefined,
    compaction: message.compaction ? { ...message.compaction } : undefined,
    renderedCallHtml: message.renderedCallHtml?.map(stripImageData),
    renderedResultHtml: message.renderedResultHtml?.map(stripImageData),
    renderedNoticeHtml: message.renderedNoticeHtml?.map(stripImageData),
  };
}

function cloneUiState(view: SessionViewUiState): SessionViewUiState {
  return {
    expandedUserMsgs: new Set(view.expandedUserMsgs),
    truncatedUserMsgs: new Set(view.truncatedUserMsgs),
    draft: view.draft,
    contextUsage: view.contextUsage ? { ...view.contextUsage } : null,
    queuedSteering: view.queuedSteering.slice(),
    queuedFollowUp: view.queuedFollowUp.slice(),
    queuedDeferred: view.queuedDeferred.slice(),
    scrollAtBottom: view.scrollAtBottom,
  };
}

function cloneView(view: SessionView, reuseFrom?: SessionView): SessionView {
  const previousById = reuseFrom
    ? new Map(reuseFrom.messages.map((message) => [message.id, message]))
    : null;
  const messages = view.messages.map((message) => {
    const previous = previousById?.get(message.id);
    return previous && sameMessage(message, previous) ? previous : cloneMessage(message);
  });
  const byId = new Map(messages.map((message) => [message.id, message]));
  const toolsById = new Map<string, UIMessage>();
  for (const [id, message] of view.toolsById) {
    toolsById.set(id, byId.get(message.id) ?? cloneMessage(message));
  }

  return {
    messages,
    activeStreamMsg: view.activeStreamMsg
      ? (byId.get(view.activeStreamMsg.id) ?? cloneMessage(view.activeStreamMsg))
      : null,
    toolsById,
    ...cloneUiState(view),
  };
}

export class SessionViewCache {
  private readonly views = new Map<string, SessionView>();

  /** Save a view and evict the least-recently-used inactive session if needed. */
  save(sessionId: string, view: SessionView): void {
    const previous = this.views.get(sessionId);
    this.views.delete(sessionId);
    this.views.set(sessionId, cloneView(view, previous));
    while (this.views.size > MAX_RETAINED_SESSION_VIEWS) {
      const oldest = this.views.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.views.delete(oldest);
    }
  }

  /**
   * Restore only the inexpensive UI state for a retained resident. The
   * transcript stays in the cache for background event updates and is not
   * copied into the visible session before its authoritative snapshot arrives.
   */
  restoreUiState(sessionId: string): SessionViewUiState | null {
    const view = this.views.get(sessionId);
    if (!view) return null;
    this.views.delete(sessionId);
    this.views.set(sessionId, view);
    return cloneUiState(view);
  }

  /** Restore a retained view and mark it as most recently used. */
  restore(sessionId: string): SessionView | null {
    const view = this.views.get(sessionId);
    if (!view) return null;
    this.views.delete(sessionId);
    this.views.set(sessionId, view);
    return cloneView(view);
  }

  /** Drop a specific session's cached view. */
  evict(sessionId: string): void {
    this.views.delete(sessionId);
  }

  /** Drop all cached views. */
  clear(): void {
    this.views.clear();
  }

  get size(): number {
    return this.views.size;
  }
}
