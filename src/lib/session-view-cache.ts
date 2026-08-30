/**
 * Per-session view persistence — remembers UI-only state (draft text,
 * message expansion flags) keyed by session ID so switching between chats
 * preserves the user's context without carrying stale conversation content.
 *
 * Conversation MESSAGES are never cached here — they always come fresh from
 * session_loaded. Only user-owned, non-authoritative state survives:
 * - Draft: what you typed but haven't sent yet
 * - Expanded/truncated: which long messages you chose to expand
 * - Queued chips: steering/follow-up queue display (restored from server)
 */
export class SessionViewCache {
  private drafts = new Map<string, string>();
  private expanded = new Map<string, Record<string, boolean>>();
  private truncated = new Map<string, Record<string, boolean>>();

  /** Save outgoing session's view state before it gets overwritten. */
  save(
    sessionId: string,
    draft: string,
    expandedUserMsgs: Record<string, boolean>,
    truncatedUserMsgs: Record<string, boolean>
  ): void {
    if (draft.trim()) this.drafts.set(sessionId, draft);
    else this.drafts.delete(sessionId);
    if (Object.keys(expandedUserMsgs).length) this.expanded.set(sessionId, { ...expandedUserMsgs });
    else this.expanded.delete(sessionId);
    if (Object.keys(truncatedUserMsgs).length)
      this.truncated.set(sessionId, { ...truncatedUserMsgs });
    else this.truncated.delete(sessionId);
  }

  /** Restore saved state for the incoming session. Returns null if nothing cached. */
  restore(sessionId: string): {
    draft: string;
    expandedUserMsgs: Record<string, boolean>;
    truncatedUserMsgs: Record<string, boolean>;
  } | null {
    const draft = this.drafts.get(sessionId);
    const expandedUserMsgs = this.expanded.get(sessionId);
    const truncatedUserMsgs = this.truncated.get(sessionId);
    if (draft === undefined && expandedUserMsgs === undefined && truncatedUserMsgs === undefined)
      return null;
    return {
      draft: draft ?? '',
      expandedUserMsgs: expandedUserMsgs ?? {},
      truncatedUserMsgs: truncatedUserMsgs ?? {},
    };
  }

  /** Drop a specific session's cached view (e.g. after explicit discard). */
  evict(sessionId: string): void {
    this.drafts.delete(sessionId);
    this.expanded.delete(sessionId);
    this.truncated.delete(sessionId);
  }

  /** Drop all cached views (e.g. on logout or full reset). */
  clear(): void {
    this.drafts.clear();
    this.expanded.clear();
    this.truncated.clear();
  }

  /** Number of sessions with cached views (for debugging/testing). */
  /** Number of sessions with at least one cached field. */
  get size(): number {
    return new Set([...this.drafts.keys(), ...this.expanded.keys(), ...this.truncated.keys()]).size;
  }
}
