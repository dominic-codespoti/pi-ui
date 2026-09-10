import type { UIMessage } from '#lib/client-messages.js';
import type { ContextUsage } from '#lib/ws/protocol.js';

/** Maximum number of inactive session views retained in memory. */
export const MAX_RETAINED_SESSION_VIEWS = 3;

/** UI state kept while a session is resident but not currently visible. */
export type SessionView = {
  messages: UIMessage[];
  activeStreamMsg: UIMessage | null;
  toolsById: Map<string, UIMessage>;
  expandedUserMsgs: Set<string>;
  truncatedUserMsgs: Set<string>;
  draft: string;
  contextUsage: ContextUsage | null;
  queuedSteering: string[];
  queuedFollowUp: string[];
  scrollAtBottom: boolean;
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
    if (Array.isArray(item)) return item.map(strip);
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

function cloneView(view: SessionView): SessionView {
  const messages = view.messages.map(cloneMessage);
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
    expandedUserMsgs: new Set(view.expandedUserMsgs),
    truncatedUserMsgs: new Set(view.truncatedUserMsgs),
    draft: view.draft,
    contextUsage: view.contextUsage ? { ...view.contextUsage } : null,
    queuedSteering: view.queuedSteering.slice(),
    queuedFollowUp: view.queuedFollowUp.slice(),
    scrollAtBottom: view.scrollAtBottom,
  };
}

/**
 * LRU store for inactive session views. The map's insertion order is the LRU
 * order: restoring or saving a view moves it to the newest end. The hard cap
 * deliberately keeps only three histories/rendered HTML snapshots in memory;
 * evicted sessions are rebuilt from the server on the next switch.
 */
export class SessionViewCache {
  private readonly views = new Map<string, SessionView>();

  /** Save a view and evict the least-recently-used inactive session if needed. */
  save(sessionId: string, view: SessionView): void {
    this.views.delete(sessionId);
    this.views.set(sessionId, cloneView(view));
    while (this.views.size > MAX_RETAINED_SESSION_VIEWS) {
      const oldest = this.views.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.views.delete(oldest);
    }
  }

  /** Restore a retained view and mark it as most recently used. */
  restore(sessionId: string): SessionView | null {
    const view = this.views.get(sessionId);
    if (!view) return null;
    this.views.delete(sessionId);
    this.views.set(sessionId, view);
    return view;
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
