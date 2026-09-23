import { execFileSync } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ReadonlyFooterDataProvider {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
}

/** Session-owned branch/status data consumed by SDK extension footer factories. */
export class SessionFooterDataProvider implements ReadonlyFooterDataProvider {
  private branch: string | null;
  private readonly statuses = new Map<string, string>();
  private providerCount = 0;
  private watcher: FSWatcher | undefined;
  private callbacks = new Set<() => void>();
  private disposed = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private headPath: string | null;

  constructor(private cwd: string) {
    this.headPath = this.findHeadPath(cwd);
    this.branch = this.resolveBranch();
    this.watchHead();
  }

  getGitBranch(): string | null {
    return this.branch;
  }
  getExtensionStatuses(): ReadonlyMap<string, string> {
    return this.statuses;
  }
  getAvailableProviderCount(): number {
    return this.providerCount;
  }
  onBranchChange(callback: () => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  setExtensionStatus(key: string, text: string | undefined): void {
    if (text === undefined) this.statuses.delete(key);
    else this.statuses.set(key, text);
  }
  setAvailableProviderCount(count: number): void {
    this.providerCount = count;
  }
  setCwd(cwd: string): void {
    if (resolve(cwd) === resolve(this.cwd)) return;
    this.cwd = cwd;
    this.watcher?.close();
    this.headPath = this.findHeadPath(cwd);
    this.branch = this.resolveBranch();
    this.watchHead();
    this.notify();
  }
  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
    this.callbacks.clear();
  }

  private findHeadPath(cwd: string): string | null {
    try {
      return execFileSync(
        'git',
        ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'HEAD'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();
    } catch {
      return null;
    }
  }

  private resolveBranch(): string | null {
    try {
      const branch = execFileSync('git', ['-C', this.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return branch === 'HEAD' ? 'detached' : branch || null;
    } catch {
      return null;
    }
  }
  private watchHead(): void {
    if (!this.headPath || this.disposed) return;
    try {
      this.watcher = watch(dirname(this.headPath), (_event, filename) => {
        if (!filename || filename.toString() === 'HEAD') this.scheduleRefresh();
      });
      // Worktrees point HEAD at a ref file; also watch that ref's directory.
      void readFile(this.headPath, 'utf8')
        .then((head) => {
          const ref = head.trim().match(/^ref: (.+)$/)?.[1];
          if (!ref || this.disposed) return;
          const path = resolve(dirname(this.headPath!), ref);
          try {
            const refWatcher = watch(dirname(path), (_event, filename) => {
              if (!filename || filename.toString() === path.split('/').pop())
                this.scheduleRefresh();
            });
            this.watcher?.on('close', () => refWatcher.close());
          } catch {
            /* HEAD watcher remains sufficient for checkout updates. */
          }
        })
        .catch(() => {});
    } catch {
      /* Git metadata may be transient; branch reads remain available. */
    }
  }
  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const branch = this.resolveBranch();
      if (branch === this.branch || this.disposed) return;
      this.branch = branch;
      this.notify();
    }, 80);
  }
  private notify(): void {
    for (const callback of this.callbacks) callback();
  }
}
