import type Database from "better-sqlite3";
import type { PermissionSet } from "./types.js";

const TABLE_NAME = "permissions";
const STORAGE_KEY = "user";

/**
 * Load user-level permission set from SQLite.
 *
 * The `permissions` table stores JSON blobs keyed by `source`.
 * Returns an empty set if no persisted rules exist.
 */
export function loadUserPermissions(db: Database.Database): PermissionSet {
  try {
    const row = db
      .prepare(`SELECT rulesJson FROM ${TABLE_NAME} WHERE source = ? LIMIT 1`)
      .get(STORAGE_KEY) as { rulesJson: string } | undefined;

    if (row?.rulesJson) {
      return JSON.parse(row.rulesJson) as PermissionSet;
    }
  } catch {
    /* Table may not exist yet; return empty */
  }

  return { rules: [], source: "user" };
}

/**
 * Persist user-level permission set to SQLite.
 *
 * Uses INSERT OR REPLACE so first-time saves work without explicit table detection.
 */
export function saveUserPermissions(db: Database.Database, set: PermissionSet): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${TABLE_NAME} (source, rulesJson, updatedAt)
     VALUES (?, ?, ?)`,
  ).run(set.source, JSON.stringify(set), Date.now());
}

/** SQL statement to create the permissions table during migration. */
export const PERMISSIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    source TEXT PRIMARY KEY,
    rulesJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`;
