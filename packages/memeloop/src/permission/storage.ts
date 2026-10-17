import type { PermissionAction, PermissionRule, PermissionSet } from './types.js';

export interface PermissionSqlStatement {
  get(...arguments_: unknown[]): unknown;
  run(...arguments_: unknown[]): unknown;
}

export interface PermissionSqlDatabase {
  prepare(sql: string): PermissionSqlStatement;
}

const TABLE_NAME = 'permissions';
const STORAGE_KEY = 'user';
const MAX_PERMISSION_RULES = 256;
const MAX_PERMISSION_PATTERN_BYTES = 512;

/**
 * Load user-level permission set from SQLite.
 *
 * The `permissions` table stores JSON blobs keyed by `source`.
 * Returns an empty set if no persisted rules exist.
 */
export function loadUserPermissions(database: PermissionSqlDatabase): PermissionSet {
  try {
    const row = database
      .prepare(`SELECT rulesJson FROM ${TABLE_NAME} WHERE source = ? LIMIT 1`)
      .get(STORAGE_KEY);

    if (isRecord(row) && typeof row.rulesJson === 'string') {
      const parsed = parsePermissionSet(row.rulesJson);
      if (parsed !== undefined) return parsed;
    }
  } catch (error) {
    if (!isMissingPermissionTableError(error)) throw error;
  }

  return { rules: [], source: 'user' };
}

/**
 * Persist user-level permission set to SQLite.
 *
 * Uses INSERT OR REPLACE so first-time saves work without explicit table detection.
 */
export function saveUserPermissions(database: PermissionSqlDatabase, set: PermissionSet): void {
  const normalized = normalizePermissionSet(set);
  database.prepare(
    `INSERT OR REPLACE INTO ${TABLE_NAME} (source, rulesJson, updatedAt)
     VALUES (?, ?, ?)`,
  ).run(STORAGE_KEY, JSON.stringify(normalized), Date.now());
}

function parsePermissionSet(serialized: string): PermissionSet | undefined {
  try {
    return normalizePermissionSet(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    if (error instanceof Error && /^invalid_user_permission(?:_set|_rule)?$/u.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function normalizePermissionSet(value: unknown): PermissionSet {
  if (!isRecord(value) || value.source !== STORAGE_KEY || !Array.isArray(value.rules)) {
    throw new Error('invalid_user_permission_set');
  }
  if (value.rules.length > MAX_PERMISSION_RULES) {
    throw new Error('invalid_user_permission_set');
  }
  const rules: PermissionRule[] = value.rules.map(rule => {
    if (!isRecord(rule) || !hasOnlyKeys(rule, ['toolPattern', 'action'])) {
      throw new Error('invalid_user_permission_rule');
    }
    if (
      typeof rule.toolPattern !== 'string' ||
      rule.toolPattern.length === 0 ||
      rule.toolPattern.length > MAX_PERMISSION_PATTERN_BYTES ||
      new TextEncoder().encode(rule.toolPattern).byteLength > MAX_PERMISSION_PATTERN_BYTES ||
      !isPermissionAction(rule.action)
    ) {
      throw new Error('invalid_user_permission_rule');
    }
    return { toolPattern: rule.toolPattern, action: rule.action };
  });
  return { source: STORAGE_KEY, rules };
}

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every(key => allowedSet.has(key));
}

function isMissingPermissionTableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(?:no such table|table does not exist)/iu.test(error.message);
}

/** SQL statement to create the permissions table during migration. */
export const PERMISSIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    source TEXT PRIMARY KEY,
    rulesJson TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`;
