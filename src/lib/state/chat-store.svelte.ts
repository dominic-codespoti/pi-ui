/**
 * Conversation state for the main chat page: the message list, streaming
 * lifecycle, tool traces, queue chips, compaction/retry notices, and the
 * throttled markdown-render pipeline.
 *
 * Extracted from +page.svelte so the message lifecycle is unit-testable and
 * so a future per-session view model has a single owner. Transport concerns
 * (WebSocket) and cross-store sync (projectsState, wake lock) stay page-side;
 * handleServer delegates here via the on* methods.
 */
import {
  uid,
  rawMessagesToUI,
  extractTextContent,
  formatToolInput,
  type UIMessage,
  type CompactionNoticeDetails,
} from '#lib/client-messages.js';
import { memoizedRenderMarkdown, renderMarkdown, renderStreamingPreview } from '#lib/markdown.js';

export class ChatStore {
  messages = $state<UIMessage[]>([]);
  /** Direct pointer to the currently-streaming assistant message — avoids O(n) lastStreaming() scans. */
  activeStreamMsg = $state<UIMessage | null>(null);
  isStreaming = $state(false);
  expandedUserMsgs = $state<Record<string, boolean>>({});
  truncatedUserMsgs = $state<Record<string, boolean>>({});
  /** Pending steered messages (queue_update) */
  queuedSteering = $state<string[]>([]);
  /** Pending follow-up messages (queue_update) */
  queuedFollowUp = $state<string[]>([]);
  /** Whether context compaction is currently running */
  isCompacting = $state(false);
  /** Whether the server truncated older messages from the initial payload. */
  messagesTruncated = $state(false);
  /** Total session message count (may exceed visible messages.length). */
  totalMessageCount = $state(0);
  /** How many raw SDK messages we've loaded so far (used for correct history pagination). */
  totalRawMessagesLoaded = $state(0);

  // ── Message helpers ─────────────────────────────────────────────────────────

  createFreshAssistant(): UIMessage {
    return {
      id: uid(),
      role: 'assistant',
      content: '',
      thinking: '',
      thinkingExpanded: false,
      streaming: true,
      startMs: Date.now(),
      createdAt: Date.now(),
    };
  }

  lastStreaming(role: UIMessage['role']): UIMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === role && this.messages[i].streaming) return this.messages[i];
    }
  }

  findToolMessage(toolCallId: string): UIMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'tool' && this.messages[i].toolCallId === toolCallId)
        return this.messages[i];
    }
    return undefined;
  }

  // ── Throttled markdown rendering during streaming ──────────────────────────
  // Internal throttle buffer and language tracking are deliberately NON-reactive
  // (never rendered directly).

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal throttle buffer, never read reactively
  private _pendingRenderSet = new Set<UIMessage>();
  private _renderScheduled = false;
  /**
   * Fence languages still loading when a message was last rendered, keyed by
   * message id. Lets the lazy-grammar-ready handler re-render ONLY the
   * messages that actually need the new language (re-rendering every loaded
   * message per registration is O(history × grammars)).
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- non-reactive tracking map, never rendered
  private _unresolvedLangs = new Map<string, Set<string>>();

  recordUnresolvedLang(m: UIMessage, lang: string): void {
    let set: Set<string> | undefined;
    if (!set) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain set inside a non-reactive map
      set = new Set();
      this._unresolvedLangs.set(m.id, set);
    }
    set.add(lang);
  }

  /** Prune tracking for messages that no longer exist (wholesale replacements). */
  pruneUnresolvedLangs(): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived snapshot, never rendered
    const live = new Set(this.messages.map((m) => m.id));
    for (const id of this._unresolvedLangs.keys()) {
      if (!live.has(id)) this._unresolvedLangs.delete(id);
    }
  }

  hasUnresolvedLang(id: string, lang: string): boolean {
    return this._unresolvedLangs.get(id)?.has(lang) ?? false;
  }

  scheduleContentRender(msg: UIMessage): void {
    this._pendingRenderSet.add(msg);
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      for (const m of this._pendingRenderSet) {
        if (!this.messages.includes(m)) continue; // stale — evicted or replaced
        if (m.streaming) {
          // Escaped plain-text preview — full markdown parse per delta is the
          // streaming hot spot (100k chars ≈ 24 ms parse, 60×/s); the
          // message_end / sealStreaming finalize paths render real markdown.
          if (m.content) m.renderedContent = renderStreamingPreview(m.content);
          if (m.thinking) m.renderedThinking = renderStreamingPreview(m.thinking);
        } else {
          if (m.content)
            m.renderedContent = renderMarkdown(m.content, {
              onUnresolvedLang: (lang) => this.recordUnresolvedLang(m, lang),
            });
          if (m.thinking)
            m.renderedThinking = renderMarkdown(m.thinking, {
              onUnresolvedLang: (lang) => this.recordUnresolvedLang(m, lang),
            });
        }
      }
      this._pendingRenderSet.clear();
      this._renderScheduled = false;
    });
  }

  /**
   * Drop empty streaming assistant bubbles (LLM turns that produced only tool
   * calls, no text/thinking) and finalize partial renders for turns that ended
   * without message_end (agent_error, abort).
   */
  sealStreaming(): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.streaming && m.role === 'assistant' && !m.content && !m.thinking) {
        this.messages.splice(i, 1);
      } else if (m.streaming) {
        m.streaming = false;
        if (m.content)
          m.renderedContent = renderMarkdown(m.content, {
            onUnresolvedLang: (lang) => this.recordUnresolvedLang(m, lang),
          });
        if (m.thinking)
          m.renderedThinking = renderMarkdown(m.thinking, {
            onUnresolvedLang: (lang) => this.recordUnresolvedLang(m, lang),
          });
      }
    }
  }

  /**
   * Populate renderedContent for a bulk history load. Trailing messages
   * (likely in the viewport) get full markdown; older ones get an empty
   * string that suppresses the inline renderMarkdown fallback and is
   * populated lazily by the component's IntersectionObserver.
   */
  populateRenderedContent(eagerCount: number): void {
    const n = this.messages.length;
    const cutoff = Math.max(0, n - eagerCount);
    for (let i = 0; i < n; i++) {
      const m = this.messages[i];
      if (m.role !== 'assistant') continue;
      if (i >= cutoff) {
        if (m.content && m.renderedContent === undefined)
          m.renderedContent = memoizedRenderMarkdown(m.content);
        if (m.thinking && m.renderedThinking === undefined)
          m.renderedThinking = renderMarkdown(m.thinking);
      } else {
        if (m.content && m.renderedContent === undefined) m.renderedContent = '';
        if (m.thinking && m.renderedThinking === undefined) m.renderedThinking = '';
      }
    }
  }

  // ── Notices ────────────────────────────────────────────────────────────────

  /** Shows a transient status/error message inline in the chat transcript
   *  instead of a corner toast. Client-only — never sent to the session, so
   *  it does not persist past a reload. */
  showNotice(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    this.messages.push({
      id: uid(),
      role: 'notice',
      content: message,
      noticeKind: 'toast',
      level,
      streaming: false,
      createdAt: Date.now(),
    });
  }

  dismissNotice(id: string): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx >= 0) this.messages.splice(idx, 1);
  }

  // ── Server event handlers (delegated from handleServer) ────────────────────

  onAgentStart(): void {
    this.isStreaming = true;
  }

  onAgentStop(): void {
    this.isStreaming = false;
    this.sealStreaming();
    this.activeStreamMsg = null;
  }

  /**
   * Finalize a completed run: drop empty assistant bubbles, surface error /
   * empty-response notices. Returns the user-facing failure message when the
   * turn ended abnormally (null on success).
   */
  finishAgentRun(runMessages: unknown[] | undefined): string | null {
    if (!Array.isArray(runMessages)) return null;
    const finalAssistant = [...runMessages].reverse().find((candidate) => {
      return (
        !!candidate &&
        typeof candidate === 'object' &&
        (candidate as { role?: string }).role === 'assistant'
      );
    }) as Record<string, unknown> | undefined;
    const stopReason = finalAssistant?.stopReason as string | undefined;
    const content = finalAssistant?.content;
    const blocks = Array.isArray(content)
      ? (content as Array<{ type?: string; text?: string; thinking?: string; data?: string }>)
      : [];
    const hasToolCall = blocks.some(
      (block) => block.type === 'toolCall' || block.type === 'tool_use'
    );
    const hasVisibleOutput =
      typeof content === 'string'
        ? content.trim().length > 0
        : blocks.some(
            (block) =>
              (block.type === 'text' && !!block.text) ||
              (block.type === 'thinking' && !!block.thinking) ||
              (block.type === 'image' && !!block.data)
          );
    const failureMessage =
      stopReason === 'error'
        ? `Agent error: ${
            typeof finalAssistant?.errorMessage === 'string' && finalAssistant.errorMessage
              ? finalAssistant.errorMessage
              : 'The model stopped with an error and returned no details.'
          }`
        : stopReason &&
            stopReason !== 'toolUse' &&
            stopReason !== 'aborted' &&
            !hasVisibleOutput &&
            !hasToolCall
          ? 'Agent returned an empty response.'
          : undefined;
    if (failureMessage) {
      const emptyAssistant = this.messages.findLastIndex(
        (m) =>
          m.role === 'assistant' && !m.streaming && !m.content && !m.thinking && !m.images?.length
      );
      if (emptyAssistant >= 0) this.messages.splice(emptyAssistant, 1);
      this.showNotice(failureMessage, stopReason === 'error' ? 'error' : 'warning');
    }
    return failureMessage ?? null;
  }

  /** message_start fires for user, assistant, AND toolResult messages — only create a bubble for the assistant turn. */
  beginAssistantTurn(message: unknown): void {
    if ((message as { role?: string } | undefined)?.role === 'assistant') {
      this.messages.push(this.createFreshAssistant());
      this.activeStreamMsg = this.messages[this.messages.length - 1];
    }
  }

  applyStreamDelta(event: { type: string; delta?: string } | undefined): void {
    if (event?.type === 'text_delta' && typeof event.delta === 'string') {
      const a = this.activeStreamMsg;
      if (a) {
        a.content += event.delta;
        this.scheduleContentRender(a);
      }
    } else if (event?.type === 'thinking_delta' && typeof event.delta === 'string') {
      const a = this.activeStreamMsg;
      if (a) {
        if (!a.thinkingStartMs) a.thinkingStartMs = Date.now();
        a.thinking = (a.thinking ?? '') + event.delta;
        this.scheduleContentRender(a);
      }
    }
  }

  /** message_end for an assistant message: seal usage, images, final markdown. */
  endAssistantMessage(endMsg: Record<string, unknown> | undefined): void {
    const a = this.activeStreamMsg;
    if (endMsg?.role === 'assistant') {
      if (a) {
        a.endMs = Date.now();
        a.streaming = false;
        if (endMsg.stopReason === 'aborted') {
          a.aborted = true;
          a.content = 'Operation aborted';
        } else if (endMsg.usage) {
          const usage = endMsg.usage as {
            input: number;
            output: number;
            totalTokens: number;
            cost: { total: number };
          };
          a.usage = {
            input: usage.input,
            output: usage.output,
            totalTokens: usage.totalTokens,
            cost: { total: usage.cost?.total ?? 0 },
          };
          // Extract any image blocks from the final message content
          if (endMsg.content) {
            const imgBlocks = (
              endMsg.content as { type: string; data?: string; mimeType?: string }[]
            ).filter((b) => b.type === 'image' && b.data && b.mimeType);
            if (imgBlocks.length > 0) {
              a.images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
            }
          }
        }
        // Extension markdown transformers ran server-side on the final text —
        // replace the streamed buffer so the live view matches history reloads.
        if (endMsg.contentTransformed === true && endMsg.stopReason !== 'aborted') {
          let finalText = '';
          let finalThinking = '';
          if (Array.isArray(endMsg.content)) {
            for (const block of endMsg.content) {
              if (!block || typeof block !== 'object' || !('type' in block)) continue;
              if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
                finalText += (finalText ? '\n\n' : '') + block.text;
              } else if (
                block.type === 'thinking' &&
                'thinking' in block &&
                typeof block.thinking === 'string'
              ) {
                finalThinking += (finalThinking ? '\n\n' : '') + block.thinking;
              }
            }
          }
          if (finalText) a.content = finalText;
          if (finalThinking) a.thinking = finalThinking;
        }
        // Final markdown render — full parse with hljs now that streaming is done
        if (a.content) a.renderedContent = memoizedRenderMarkdown(a.content);
        if (a.thinking)
          a.renderedThinking = renderMarkdown(a.thinking, {
            onUnresolvedLang: (lang) => this.recordUnresolvedLang(a, lang),
          });
      }
      this.activeStreamMsg = null;
    } else if (endMsg?.role === 'custom') {
      const customUi = rawMessagesToUI([endMsg]);
      if (customUi.length > 0) {
        this.messages.push(...customUi);
      }
    }
  }

  toolExecutionStart(msg: Record<string, unknown>, expandedDefault: boolean): void {
    const toolName = (msg.toolName as string | undefined) ?? 'tool';
    const toolCallId = msg.toolCallId as string | undefined;
    const details = (msg.args ?? msg.input ?? msg.details) as Record<string, unknown> | undefined;
    this.messages.push({
      id: uid(),
      role: 'tool',
      content: '',
      toolName,
      toolCallId,
      toolInput: formatToolInput(toolName, details),
      toolArgs: details,
      renderedCallHtml: msg.renderedCallHtml as string[] | undefined,
      streaming: true,
      expanded: expandedDefault,
      startMs: Date.now(),
      createdAt: Date.now(),
    });
  }

  toolExecutionUpdate(msg: Record<string, unknown>): void {
    const updateId = msg.toolCallId as string | undefined;
    const t = updateId ? this.findToolMessage(updateId) : this.lastStreaming('tool');
    if (t) {
      const partial = msg.partialResult as
        { content?: { type: string; text?: string }[] } | undefined;
      if (partial?.content) {
        t.content = extractTextContent(partial.content);
      }
      if (msg.renderedResultHtml) t.renderedResultHtml = msg.renderedResultHtml as string[];
    }
  }

  toolExecutionEnd(msg: Record<string, unknown>): void {
    const endId = msg.toolCallId as string | undefined;
    const t = endId ? this.findToolMessage(endId) : this.lastStreaming('tool');
    if (t) {
      if (msg.renderedResultHtml) t.renderedResultHtml = msg.renderedResultHtml as string[];
      t.streaming = false;
      t.isError = (msg.isError as boolean | undefined) ?? false;
      const result = msg.result as
        | {
            content?:
              | {
                  type: string;
                  text?: string;
                  data?: string;
                  mimeType?: string;
                }[]
              | undefined;
            details?: { diff?: string; patch?: string };
          }
        | undefined;

      if (result?.content) {
        t.content = extractTextContent(result.content);
        const imgBlocks = result.content.filter((b) => b.type === 'image' && b.data && b.mimeType);
        if (imgBlocks.length > 0) {
          t.images = imgBlocks.map((b) => `data:${b.mimeType};base64,${b.data}`);
        }
      }
      // Capture diff for edit tool
      const diff = result?.details?.diff;
      if (diff) {
        t.diff = diff;
        t.lineCount = diff.split('\n').length;
        // Auto-expand diff so it's immediately visible
        t.expanded = true;
      } else if (t.content) {
        const lines = t.content.split('\n').length;
        t.lineCount = lines;
        // Auto-expand errors (the user needs to see what failed) and
        // short outputs (≤ 8 lines and ≤ 400 chars).
        if (t.isError || (lines <= 8 && t.content.length <= 400)) {
          t.expanded = true;
        }
      }
    }
  }

  setQueues(steering: string[] | undefined, followUp: string[] | undefined): void {
    this.queuedSteering = steering ?? [];
    this.queuedFollowUp = followUp ?? [];
  }

  compactionStart(reason: string): void {
    const startedAt = Date.now();
    const normalizedReason = reason.trim() || 'automatic';
    this.isCompacting = true;
    this.messages.push({
      id: uid(),
      role: 'notice',
      content:
        normalizedReason === 'manual'
          ? 'compacting context…'
          : `auto-compacting context (${normalizedReason})…`,
      noticeKind: 'compaction',
      compaction: {
        reason: normalizedReason,
        status: 'running',
        startedAt,
      },
      streaming: true,
      createdAt: startedAt,
    });
  }

  compactionEnd(msg: Record<string, unknown>): void {
    const endedAt = Date.now();
    const aborted = (msg.aborted as boolean | undefined) ?? false;
    const willRetry = (msg.willRetry as boolean | undefined) ?? false;
    const errMsg = msg.errorMessage as string | undefined;
    const compResult = msg.result as
      { tokensBefore?: number; estimatedTokensAfter?: number } | undefined;
    const cu = msg.contextUsage as { tokens?: number | null } | undefined;
    const notice = [...this.messages]
      .reverse()
      .find((m) => m.role === 'notice' && m.noticeKind === 'compaction' && m.streaming);
    const previous = notice?.compaction;
    const startedAt = previous?.startedAt ?? notice?.createdAt ?? endedAt;
    const durationMs = Math.max(0, endedAt - startedAt);
    const tokensBefore = compResult?.tokensBefore ?? previous?.tokensBefore;
    const tokensAfter = compResult?.estimatedTokensAfter ?? cu?.tokens ?? previous?.tokensAfter;
    const status: CompactionNoticeDetails['status'] = willRetry
      ? 'retrying'
      : errMsg
        ? 'failed'
        : aborted
          ? 'aborted'
          : 'completed';
    const reason = previous?.reason ?? 'automatic';
    this.isCompacting = false;
    if (notice) {
      notice.streaming = false;
      notice.compaction = {
        ...(previous ?? { status: 'running', startedAt }),
        reason,
        status,
        startedAt,
        endedAt,
        durationMs,
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        ...(errMsg ? { errorMessage: errMsg } : {}),
        willRetry,
      };
      notice.content = willRetry
        ? `compaction failed${errMsg ? `: ${errMsg}` : ''} · retrying…`
        : errMsg
          ? `compaction failed: ${errMsg}`
          : aborted
            ? 'compaction aborted'
            : compResult?.tokensBefore != null && compResult.estimatedTokensAfter != null
              ? `context compacted · ${compResult.tokensBefore.toLocaleString()} → ${compResult.estimatedTokensAfter.toLocaleString()} tokens`
              : 'context compacted';
    }
  }

  retryStart(msg: Record<string, unknown>): void {
    const attempt = (msg.attempt as number | undefined) ?? 1;
    const max = (msg.maxAttempts as number | undefined) ?? 1;
    const delayS = Math.round(((msg.delayMs as number | undefined) ?? 0) / 1000);
    const errMsg = (msg.errorMessage as string | undefined) ?? '';
    this.messages.push({
      id: uid(),
      role: 'notice',
      content: `retrying (${attempt}/${max}${delayS > 0 ? `, ${delayS}s` : ''})${errMsg ? ` — ${errMsg}` : ''}`,
      noticeKind: 'retry',
      streaming: true,
      createdAt: Date.now(),
    });
  }

  retryEnd(msg: Record<string, unknown>): void {
    const notice = [...this.messages]
      .reverse()
      .find((m) => m.role === 'notice' && m.noticeKind === 'retry' && m.streaming);
    if (notice) {
      notice.streaming = false;
      const success = (msg.success as boolean | undefined) ?? false;
      const finalErr = msg.finalError as string | undefined;
      notice.content = success
        ? 'retry succeeded'
        : `retry failed${finalErr ? `: ${finalErr}` : ''}`;
    }
  }

  /** older_messages — prepend paginated history. */
  prependOlder(older: {
    messages: unknown[];
    totalMessageCount: number;
    messagesTruncated: boolean;
  }): void {
    const olderUi = rawMessagesToUI(older.messages);
    this.messages = [...olderUi, ...this.messages];
    this.totalRawMessagesLoaded += older.messages.length;
    this.totalMessageCount = older.totalMessageCount;
    this.messagesTruncated = older.messagesTruncated;
  }

  pushSlashResult(result: {
    command: string;
    message: string;
    level?: 'info' | 'warning' | 'error';
  }): void {
    this.messages.push({
      id: uid(),
      role: 'notice',
      content: result.message,
      noticeKind: result.level === 'error' ? 'retry' : undefined,
      customType: 'slash_result',
      streaming: false,
      createdAt: Date.now(),
    });
  }
}
