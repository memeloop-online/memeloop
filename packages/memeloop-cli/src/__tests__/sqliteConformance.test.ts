import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStorageConformance } from 'memeloop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteAgentStorage } from '../storage/sqliteStorage.js';

describe('SQLiteAgentStorage conformance', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memeloop-sqlite-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('passes the storage conformance suite (in-memory)', async () => {
    const storage = new SQLiteAgentStorage();
    const report = await runStorageConformance(storage, { conversationId: 'sqlite-conformance' });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(report.checks);
  });

  it('passes the storage conformance suite (file-backed)', async () => {
    const storage = new SQLiteAgentStorage({ filename: join(directory, 'agent.db') });
    const report = await runStorageConformance(storage, { conversationId: 'sqlite-file-conformance' });
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(report.checks);
  });
});
