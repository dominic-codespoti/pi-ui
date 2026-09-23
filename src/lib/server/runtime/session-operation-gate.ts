/**
 * Per-owner freshness gate for asynchronous structural session operations.
 *
 * Each new intent advances the owner's sequence. A completion may commit only
 * while its captured sequence remains current; unstamped broadcasts are not
 * represented here because they are intentionally outside operation ownership.
 */
export type SessionOperationToken = number;

export interface SessionOperationGate {
  /** Start the newest operation and return its commit token. */
  begin(): SessionOperationToken;
  /** True only for the newest operation started by this gate. */
  isCurrent(token: SessionOperationToken): boolean;
}

export function createSessionOperationGate(): SessionOperationGate {
  let latest = 0;
  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(token) {
      return latest !== 0 && token === latest;
    },
  };
}
