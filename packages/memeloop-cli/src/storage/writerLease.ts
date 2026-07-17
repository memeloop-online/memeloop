/**
 * Single-writer fencing for file-backed SQLite storage (plan 24.43).
 *
 * A file database has exactly one writer lease at a time; the lease carries a
 * monotonically increasing fencing token. Storage instances assert the lease
 * before every mutation and fail with STALE_EPOCH after losing it, so a
 * partitioned or superseded writer can never issue stale writes. Readers are
 * unaffected (SQLite WAL allows concurrent reads).
 *
 * The registry is per-process; cross-process exclusion is delegated to
 * SQLite's own file locking. Control-plane revocation uses `revokeWriterLease`.
 */

export interface WriterLease {
  /** Absolute filename this lease covers. */
  readonly filename: string;
  /** Monotonically increasing fencing token. */
  readonly token: number;
  /** True while this lease is the valid writer. */
  held(): boolean;
  /** Voluntarily release the lease (storage close). */
  release(): void;
}

interface LeaseRecord {
  token: number;
  held: boolean;
}

const leases = new Map<string, LeaseRecord>();
let nextToken = 0;

export class WriterLeaseConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(filename: string) {
    super(`writer lease for '${filename}' is already held`);
    this.name = 'WriterLeaseConflictError';
  }
}

export function acquireWriterLease(filename: string): WriterLease {
  const existing = leases.get(filename);
  if (existing?.held) {
    throw new WriterLeaseConflictError(filename);
  }
  nextToken += 1;
  const record: LeaseRecord = { token: nextToken, held: true };
  leases.set(filename, record);
  return {
    filename,
    token: record.token,
    held: () => record.held,
    release: () => {
      record.held = false;
    },
  };
}

/** Control-plane revocation: the current writer loses its lease immediately. */
export function revokeWriterLease(filename: string): void {
  const record = leases.get(filename);
  if (record) record.held = false;
}

/** Current fencing token for a file, or undefined when never leased. */
export function currentWriterLeaseToken(filename: string): number | undefined {
  return leases.get(filename)?.token;
}
