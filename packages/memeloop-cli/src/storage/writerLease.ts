import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';

/** Persistent single-writer fencing for file-backed SQLite storage. */

export interface WriterLease {
  /** Canonical filename this lease covers. */
  readonly filename: string;
  /** Monotonically increasing fencing token. */
  readonly token: number;
  readonly ownerId: string;
  /** True while this lease is the valid writer. */
  held(): boolean;
  /** Voluntarily release the lease (storage close). */
  release(): void;
}

const LEASE_DDL = `
  CREATE TABLE IF NOT EXISTS memeloop_writer_lease (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    token INTEGER NOT NULL,
    ownerId TEXT NOT NULL,
    held INTEGER NOT NULL CHECK (held IN (0, 1)),
    ownerPid INTEGER
  )
`;

function canonicalFilename(filename: string): string {
  const absolute = resolve(filename);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function openLeaseDatabase(filename: string, nativeBinding?: string): Database.Database {
  const database = new Database(filename, { nativeBinding });
  try {
    database.pragma('busy_timeout = 5000');
    database.exec(LEASE_DDL);
    const hasOwnerPid = (): boolean => {
      const columns = database.prepare('PRAGMA table_info(memeloop_writer_lease)').all() as Array<{ name: string }>;
      return columns.some((column) => column.name === 'ownerPid');
    };
    // `CREATE TABLE IF NOT EXISTS` does not alter the lease table created by a
    // previous package. Serialize the additive migration so two new processes
    // opening the same legacy database cannot race to add the same column.
    if (!hasOwnerPid()) {
      database.exec('BEGIN IMMEDIATE');
      try {
        if (!hasOwnerPid()) {
          database.exec('ALTER TABLE memeloop_writer_lease ADD COLUMN ownerPid INTEGER');
        }
        database.exec('COMMIT');
      } catch (error) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw error;
      }
    }
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/**
 * Signal 0 is Node's cross-platform process-existence probe, including on
 * Windows. Any result other than a definitive `ESRCH` is treated as live so
 * lack of permission or an unexpected platform error cannot steal a lease.
 */
function isKnownLiveProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class WriterLeaseConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(filename: string) {
    super(`writer lease for '${filename}' is already held`);
    this.name = 'WriterLeaseConflictError';
  }
}

export function acquireWriterLease(filename: string, nativeBinding?: string): WriterLease {
  const canonical = canonicalFilename(filename);
  const database = openLeaseDatabase(canonical, nativeBinding);
  const ownerId = randomUUID();
  let token = 0;
  try {
    database.exec('BEGIN IMMEDIATE');
    const existing = database.prepare('SELECT token, held, ownerPid FROM memeloop_writer_lease WHERE singleton = 1').get() as
      | { token: number; held: number; ownerPid: number | null }
      | undefined;
    // Releases cannot run after a process is killed (notably by Squirrel
    // replacement on Windows), so a dead PID must not poison every future
    // start. A legacy row without a PID cannot prove its former writer is
    // gone, so it remains fail-closed rather than stealing a live writer.
    // Newer rows are recovered only when their owner is definitively absent.
    const ownerPid = existing?.ownerPid;
    if (
      existing?.held === 1 &&
      (ownerPid === null || ownerPid === undefined || isKnownLiveProcess(ownerPid))
    ) {
      database.exec('ROLLBACK');
      database.close();
      throw new WriterLeaseConflictError(canonical);
    }
    token = (existing?.token ?? 0) + 1;
    database.prepare(`
      INSERT INTO memeloop_writer_lease (singleton, token, ownerId, held, ownerPid)
      VALUES (1, ?, ?, 1, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        token = excluded.token,
        ownerId = excluded.ownerId,
        held = 1,
        ownerPid = excluded.ownerPid
    `).run(token, ownerId, process.pid);
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    if (database.open) database.close();
    throw error;
  }
  let closed = false;
  return {
    filename: canonical,
    token,
    ownerId,
    held: () => {
      if (closed) return false;
      const row = database.prepare(`
        SELECT 1 AS held FROM memeloop_writer_lease
        WHERE singleton = 1 AND token = ? AND ownerId = ? AND held = 1
      `).get(token, ownerId) as { held: number } | undefined;
      return row?.held === 1;
    },
    release: () => {
      if (closed) return;
      database.prepare(`
        UPDATE memeloop_writer_lease SET held = 0
        WHERE singleton = 1 AND token = ? AND ownerId = ?
      `).run(token, ownerId);
      database.close();
      closed = true;
    },
  };
}

/** Control-plane revocation: the current writer loses its lease immediately. */
export function revokeWriterLease(filename: string): void {
  const canonical = canonicalFilename(filename);
  const database = openLeaseDatabase(canonical);
  database.prepare('UPDATE memeloop_writer_lease SET held = 0 WHERE singleton = 1').run();
  database.close();
}

/** Current fencing token for a file, or undefined when never leased. */
export function currentWriterLeaseToken(filename: string): number | undefined {
  const canonical = canonicalFilename(filename);
  const database = openLeaseDatabase(canonical);
  const row = database.prepare('SELECT token FROM memeloop_writer_lease WHERE singleton = 1').get() as { token: number } | undefined;
  database.close();
  return row?.token;
}
