/**
 * SDK-agnostic resident-session infrastructure.
 *
 * The server owns session lifecycle, queued runs, and UI/catalog side effects;
 * this store only tracks resident entries and the small amount of coordination
 * state needed to safely operate on them.
 */

export interface ResidentEntry {
  readonly id: string;
  readonly path: string | null;
  generation: number;
  historyBytes: number;
}

export interface ResidentStoreOptions<T extends ResidentEntry> {
  /** Clock exposed to callers that stamp resident metadata. */
  clock?: () => number;
  /** Additional server-owned conditions that make an entry non-evictable. */
  pinPredicate?: (entry: T) => boolean;
}

export type ResidentOperation<T> = () => T | PromiseLike<T>;

/**
 * Indexed resident registry plus rejection-safe coordination primitives.
 *
 * A path index is maintained alongside the stable-id index so path lookups do
 * not scan every resident. Transient locks/pins/reservations are keyed by the
 * same stable id and are cleared when the entry is removed.
 */
export class ResidentStore<T extends ResidentEntry> {
  private readonly entriesById = new Map<string, T>();
  private readonly entriesByPath = new Map<string, T>();
  private readonly pinPredicate: ((entry: T) => boolean) | undefined;
  private readonly clock: () => number;
  private globalMutationQueue: Promise<unknown> = Promise.resolve();
  private readonly sessionMutationQueues = new Map<string, Promise<unknown>>();
  private readonly activationPins = new Map<string, number>();
  private readonly runReservations = new Set<string>();

  constructor(options: ResidentStoreOptions<T> = {}) {
    this.clock = options.clock ?? Date.now;
    this.pinPredicate = options.pinPredicate;
  }

  now(): number {
    return this.clock();
  }

  get size(): number {
    return this.entriesById.size;
  }

  get(id: string): T | undefined {
    return this.entriesById.get(id);
  }

  getByPath(path: string): T | undefined {
    return this.entriesByPath.get(path);
  }

  values(): IterableIterator<T> {
    return this.entriesById.values();
  }

  keys(): IterableIterator<string> {
    return this.entriesById.keys();
  }

  /**
   * Register an entry, preserving the first resident for duplicate ids/paths.
   * Returning the resident makes duplicate handling explicit to the lifecycle
   * owner, which can dispose a duplicate SDK object without store knowledge.
   */
  register(entry: T): T {
    const byId = this.entriesById.get(entry.id);
    if (byId) return byId;
    const byPath = entry.path === null ? undefined : this.entriesByPath.get(entry.path);
    if (byPath) return byPath;

    this.entriesById.set(entry.id, entry);
    if (entry.path !== null) this.entriesByPath.set(entry.path, entry);
    return entry;
  }

  /** Remove and invalidate an entry and all of its per-id coordination state. */
  remove(idOrEntry: string | T): T | undefined {
    const id = typeof idOrEntry === 'string' ? idOrEntry : idOrEntry.id;
    const entry = this.entriesById.get(id);
    if (!entry) return undefined;

    this.entriesById.delete(id);
    if (entry.path !== null && this.entriesByPath.get(entry.path) === entry) {
      this.entriesByPath.delete(entry.path);
    }
    this.runReservations.delete(id);
    this.activationPins.delete(id);
    this.sessionMutationQueues.delete(id);
    entry.generation++;
    return entry;
  }

  /** Increment the current generation, invalidating work captured earlier. */
  bumpGeneration(idOrEntry: string | T): number {
    const entry = typeof idOrEntry === 'string' ? this.entriesById.get(idOrEntry) : idOrEntry;
    if (!entry) return -1;
    entry.generation++;
    return entry.generation;
  }

  /** Check both registry identity and generation captured by an async caller. */
  isCurrent(entry: T, generation: number): boolean {
    return this.entriesById.get(entry.id) === entry && entry.generation === generation;
  }

  setHistoryBytes(idOrEntry: string | T, historyBytes: number): boolean {
    const entry = typeof idOrEntry === 'string' ? this.entriesById.get(idOrEntry) : idOrEntry;
    if (!entry || this.entriesById.get(entry.id) !== entry) return false;
    entry.historyBytes = historyBytes;
    return true;
  }

  totalHistoryBytes(): number {
    let total = 0;
    for (const entry of this.entriesById.values()) total += entry.historyBytes;
    return total;
  }

  /** Run an operation after all earlier global mutations, recovering on reject. */
  withGlobalLock<R>(operation: ResidentOperation<R>): Promise<R> {
    const run = this.globalMutationQueue.then(operation, operation);
    this.globalMutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Run an operation after all earlier mutations for one resident id. */
  withSessionLock<R>(id: string, operation: ResidentOperation<R>): Promise<R> {
    const previous = this.sessionMutationQueues.get(id) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.sessionMutationQueues.set(
      id,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  pinActivation(id: string): void {
    this.activationPins.set(id, (this.activationPins.get(id) ?? 0) + 1);
  }

  releaseActivationPin(id: string): void {
    const pins = this.activationPins.get(id) ?? 0;
    if (pins <= 1) this.activationPins.delete(id);
    else this.activationPins.set(id, pins - 1);
  }

  activationPinCount(id: string): number {
    return this.activationPins.get(id) ?? 0;
  }

  async withActivationPin<R>(id: string, operation: ResidentOperation<R>): Promise<R> {
    this.pinActivation(id);
    try {
      return await operation();
    } finally {
      this.releaseActivationPin(id);
    }
  }

  isPinned(entry: T): boolean {
    return (
      this.activationPinCount(entry.id) > 0 ||
      this.runReservations.has(entry.id) ||
      this.pinPredicate?.(entry) === true
    );
  }

  hasRunReservation(id: string): boolean {
    return this.runReservations.has(id);
  }

  releaseRunSlot(id: string): void {
    this.runReservations.delete(id);
  }

  /**
   * Count running entries and in-flight reservations. The reservation is added
   * before dispatch, closing the race before an SDK lifecycle event arrives.
   */
  concurrentRunCount(isRunning: (entry: T) => boolean = () => false): number {
    let count = 0;
    for (const entry of this.entriesById.values()) {
      if (isRunning(entry) || this.runReservations.has(entry.id)) count++;
    }
    return count;
  }

  /** Reserve one run slot, atomically with respect to this synchronous store. */
  reserveRunSlot(
    idOrEntry: string | T,
    maxConcurrentRuns: number,
    isRunning: (entry: T) => boolean = () => false,
    countAsRunning: (entry: T) => boolean = isRunning
  ): boolean {
    const entry = typeof idOrEntry === 'string' ? this.entriesById.get(idOrEntry) : idOrEntry;
    if (!entry || this.entriesById.get(entry.id) !== entry) return false;
    if (isRunning(entry) || this.runReservations.has(entry.id)) return false;
    if (this.concurrentRunCount(countAsRunning) >= maxConcurrentRuns) return false;
    this.runReservations.add(entry.id);
    return true;
  }
}
