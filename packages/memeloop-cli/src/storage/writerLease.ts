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
    held INTEGER NOT NULL CHECK (held IN (0, 1))
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

function openLeaseDatabase(filename: string): Database.Database {
  const database = new Database(filename);
  database.pragma('busy_timeout = 5000');
  database.exec(LEASE_DDL);
  return database;
}

export class WriterLeaseConflictError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(filename: string) {
    super(`writer lease for '${filename}' is already held`);
    this.name = 'WriterLeaseConflictError';
  }
}

export function acquireWriterLease(filename: string): WriterLease {
  const canonical = canonicalFilename(filename);
  const database = openLeaseDatabase(canonical);
  const ownerId = randomUUID();
  let token = 0;
  try {
    database.exec('BEGIN IMMEDIATE');
    const existing = database.prepare('SELECT token, held FROM memeloop_writer_lease WHERE singleton = 1').get() as
      | { token: number; held: number }
      | undefined;
    if (existing?.held === 1) {
      database.exec('ROLLBACK');
      database.close();
      throw new WriterLeaseConflictError(canonical);
    }
    token = (existing?.token ?? 0) + 1;
    database.prepare(`
      INSERT INTO memeloop_writer_lease (singleton, token, ownerId, held)
      VALUES (1, ?, ?, 1)
      ON CONFLICT(singleton) DO UPDATE SET token = excluded.token, ownerId = excluded.ownerId, held = 1
    `).run(token, ownerId);
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
