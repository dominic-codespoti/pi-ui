import type { TerminalInputHandler } from '@earendil-works/pi-coding-agent';
import { log } from './logger';

export type TerminalInputVerdict = { consumed: boolean; data?: string };

export class TerminalInputRegistry {
  private handlers = new Map<string | null, Set<TerminalInputHandler>>();

  register(owner: string | null, handler: TerminalInputHandler): () => void {
    let set = this.handlers.get(owner);
    if (!set) {
      set = new Set();
      this.handlers.set(owner, set);
    }
    set.add(handler);
    return () => this.unregister(owner, handler);
  }

  unregister(owner: string | null, handler: TerminalInputHandler): void {
    const set = this.handlers.get(owner);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(owner);
  }

  has(owner: string | null): boolean {
    return (this.handlers.get(owner)?.size ?? 0) > 0;
  }

  clear(owner: string | null): void {
    this.handlers.delete(owner);
  }

  /** pi-tui's listener-loop semantics; see tui.js handleInput. Never throws. */
  dispatch(owner: string | null, data: string): TerminalInputVerdict {
    const set = this.handlers.get(owner);
    if (!set || set.size === 0) return { consumed: false };
    let current = data;
    for (const handler of set) {
      try {
        const result = handler(current);
        if (result?.consume) return { consumed: true };
        if (result?.data !== undefined) current = result.data;
      } catch (err) {
        log.error('[pifrontier] onTerminalInput handler error:', err);
      }
    }
    if (current.length === 0) return { consumed: true };
    return current === data ? { consumed: false } : { consumed: false, data: current };
  }
}

export const terminalInputRegistry = new TerminalInputRegistry();
