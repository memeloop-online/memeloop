import Database from 'better-sqlite3';
import type { ConversationEventDraft, ConversationForkRequest } from 'memeloop';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAgentStorage } from '../sqliteStorage.js';

const opened: SQLiteAgentStorage[] = [];
function storage(filename?: string) {
  const value = new SQLiteAgentStorage(filename ? { filename } : {});
  opened.push(value);
  return value;
}
afterEach(() => {
  for (const value of opened.splice(0)) value.close();
});

function user(id: string, timestamp: number, text: string): ConversationEventDraft {
  return {
    kind: 'message',
    eventId: id,
    conversationId: 'source',
    originNodeId: 'source-node',
    timestamp,
    message: { messageId: id, turnId: id, role: 'user', content: text, parts: [{ type: 'text', text }] },
  };
}

async function seed(value: SQLiteAgentStorage): Promise<void> {
  await value.appendLocalEvent({
    kind: 'metadataPatch',
    eventId: 'meta',
    conversationId: 'source',
    originNodeId: 'source-node',
    timestamp: 1,
    patch: { definitionId: 'definition', title: 'Original', instanceDelta: { modelConfig: { providerId: 'custom', modelId: 'model' } } },
  });
  await value.appendLocalEvent(user('first', 10, 'full prefix '.repeat(4000)));
  await value.appendLocalEvent({
    kind: 'message',
    eventId: 'answer',
    conversationId: 'source',
    originNodeId: 'source-node',
    timestamp: 20,
    message: {
      messageId: 'answer',
      turnId: 'first',
      role: 'assistant',
      content: 'answer',
      parts: [{ type: 'reasoning', text: 'retained reasoning' }, { type: 'text', text: 'answer' }],
    },
  });
  await value.appendLocalEvent({
    kind: 'message',
    eventId: 'compaction-summary',
    conversationId: 'source',
    originNodeId: 'source-node',
    timestamp: 25,
    message: {
      messageId: 'compaction-summary',
      turnId: 'compaction-summary',
      role: 'assistant',
      content: 'summary',
      parts: [{ type: 'text', text: 'summary' }],
      metadata: { isContextCompaction: true },
    },
  });
  await value.appendLocalEvent(user('edit', 30, 'original edit text'));
  await value.appendLocalEvent(user('later', 40, 'later turn'));
}

async function request(value: SQLiteAgentStorage, overrides: Partial<ConversationForkRequest> = {}): Promise<ConversationForkRequest> {
  const source = await value.loadConversationEditSource('source', 'edit');
  return {
    conversationId: 'source',
    messageId: 'edit',
    sourceRevision: source.sourceRevision,
    requestId: 'edit-request',
    targetConversationId: 'branch',
    replacementMessageId: 'replacement',
    text: 'changed text',
    ...overrides,
  };
}

describe('SQLite canonical conversation editing', () => {
  it('persists draft CAS and discard tombstones without changing canonical history', async () => {
    const value = storage();
    await seed(value);
    const before = await value.loadConversationEditSource('source', 'edit');
    expect(before.draft).toBeNull();
    const input = { conversationId: 'source', messageId: 'edit', expectedRevision: 0, text: 'draft' };
    expect(await value.saveConversationEditDraft(input)).toBe(1);
    await expect(value.saveConversationEditDraft(input)).rejects.toThrow('conversation_draft_conflict');
    expect(await value.saveConversationEditDraft({ ...input, expectedRevision: 1, text: null })).toBe(2);
    await expect(value.saveConversationEditDraft({ ...input, expectedRevision: 1 })).rejects.toThrow('conversation_draft_conflict');
    expect(await value.loadConversationEditSource('source', 'edit')).toEqual({
      ...before,
      draft: { text: null, revision: 2 },
    });
  });

  it('atomically retains full prefix and configuration; stages replacement only once', async () => {
    const value = storage();
    await seed(value);
    const input = await request(value);
    expect(await value.forkConversation(input, 'editing-node')).toBe('branch');
    expect(await value.forkConversation(input, 'editing-node')).toBe('branch');
    await expect(value.forkConversation({ ...input, text: 'different payload' })).rejects.toThrow('conversation_fork_request_conflict');
    const events = await value.getConversationEventPage('branch', { limit: 80, direction: 'forward' });
    expect(events.items).toHaveLength(3);
    const messages = events.items.filter(event => event.kind === 'message');
    expect(messages.map(event => event.message.content)).toEqual(['full prefix '.repeat(4000), 'answer']);
    expect(messages[1]?.message.parts[0]).toEqual({ type: 'reasoning', text: 'retained reasoning' });
    expect(messages[1]?.message.turnId).toBe(messages[0]?.message.messageId);
    expect(await value.getMessageById('branch', 'replacement')).toBeNull();
    const pending = await value.getPendingConversationBranchReplacement('branch');
    expect(pending).toMatchObject({
      messageId: 'replacement',
      turnId: 'replacement',
      content: 'changed text',
      metadata: { memeloopBranch: { rootConversationId: 'source', rootMessageId: 'edit', variantConversationId: 'branch', variantMessageId: 'replacement' } },
    });
    expect(await value.getPendingConversationBranchReplacement('source')).toBeNull();
    expect((await value.getConversationMeta('branch'))?.instanceDelta).toEqual((await value.getConversationMeta('source'))?.instanceDelta);
    expect((await value.getMessageById('source', 'later'))?.content).toBe('later turn');
  });

  it('rejects changed sources and rolls back all branch state on an append failure', async () => {
    const value = storage();
    await seed(value);
    const input = await request(value);
    await expect(value.forkConversation({ ...input, sourceRevision: 'stale' })).rejects.toThrow('conversation_edit_source_changed');
    expect(await value.getConversationMeta('branch')).toBeNull();
    // An invalid writer identity fails canonical validation inside the transaction,
    // including after the local editing state has been consulted.
    await expect(value.forkConversation(input, '')).rejects.toThrow();
    expect(await value.getConversationMeta('branch')).toBeNull();
    expect(await value.getPendingConversationBranchReplacement('branch')).toBeNull();
    const database = (value as unknown as { db: Database.Database }).db;
    const original = database.prepare('SELECT canonicalJson FROM messages WHERE messageId = ?').get('answer') as { canonicalJson: string };
    database.prepare('UPDATE messages SET canonicalJson = ? WHERE messageId = ?').run('{', 'answer');
    // The first prefix event has already been projected when reading the next
    // corrupt canonical payload fails; the complete target must roll back.
    await expect(value.forkConversation(input, 'valid-node')).rejects.toThrow('invalid canonical full-content JSON');
    expect(await value.getConversationMeta('branch')).toBeNull();
    expect((await value.getConversationEventPage('branch', { limit: 80 })).items).toEqual([]);
    expect(await value.getPendingConversationBranchReplacement('branch')).toBeNull();
    database.prepare('UPDATE messages SET canonicalJson = ? WHERE messageId = ?').run(original.canonicalJson, 'answer');
    expect(await value.forkConversation(input, 'valid-node')).toBe('branch');
  });

  it('replicates branch metadata through ordinary events while drafts stay local', async () => {
    const value = storage();
    const peer = storage();
    await seed(value);
    await value.saveConversationEditDraft({ conversationId: 'source', messageId: 'edit', expectedRevision: 0, text: 'local draft' });
    await value.forkConversation(await request(value), 'editing-node');
    const pending = (await value.getPendingConversationBranchReplacement('branch'))!;
    // This is the existing normal run acceptance's canonical user event.
    await value.appendLocalEvent({
      kind: 'message',
      eventId: 'replacement',
      conversationId: 'branch',
      originNodeId: 'editing-node',
      timestamp: 100,
      message: { ...pending, messageId: 'replacement', turnId: 'replacement', content: 'changed text', parts: pending.parts ?? [], role: 'user' },
    });
    for (const id of ['source', 'branch']) {
      const page = await value.getConversationEventPage(id, { limit: 80, direction: 'forward' });
      await peer.insertEventsIfAbsent([...page.items].reverse());
    }
    const expected = [{
      messageId: 'edit',
      selected: 0,
      alternatives: [{ conversationId: 'source', messageId: 'edit' }, { conversationId: 'branch', messageId: 'replacement' }],
    }];
    expect(await value.getConversationBranches('source', ['edit'])).toEqual(expected);
    expect(await peer.getConversationBranches('source', ['edit'])).toEqual(expected);
    expect(await peer.getConversationBranches('branch', ['replacement'])).toEqual([{ ...expected[0], messageId: 'replacement', selected: 1 }]);
    expect((await peer.loadConversationEditSource('source', 'edit')).draft).toBeNull();
    expect(await peer.getPendingConversationBranchReplacement('branch')).toBeNull();
    // The original host retains the exact payload after acceptance for retry digests.
    expect(await value.getPendingConversationBranchReplacement('branch')).toEqual(pending);
  });

  it('preserves authorized replacement attachments and excludes tombstoned turns', async () => {
    const value = storage();
    await seed(value);
    await value.appendLocalEvent({
      kind: 'tombstone',
      eventId: 'delete-first',
      conversationId: 'source',
      originNodeId: 'source-node',
      timestamp: 45,
      targetTurnId: 'first',
      reason: 'user-delete',
    });
    const bytes = Buffer.from('attachment');
    const attachment = {
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      filename: 'note.txt',
      mimeType: 'text/plain',
      size: bytes.length,
    };
    await value.saveAttachment(attachment, bytes);
    await value.appendLocalEvent({
      kind: 'message',
      eventId: 'attached',
      conversationId: 'source',
      originNodeId: 'source-node',
      timestamp: 50,
      message: {
        messageId: 'attached',
        turnId: 'attached',
        role: 'user',
        content: 'with file',
        parts: [{ type: 'text', text: 'with file' }, { type: 'attachment', attachment }],
        attachments: [attachment],
      },
    });
    const source = await value.loadConversationEditSource('source', 'attached');
    await value.forkConversation(await request(value, { messageId: 'attached', sourceRevision: source.sourceRevision }));
    const page = await value.getConversationEventPage('branch', { limit: 80, direction: 'forward' });
    expect(page.items.filter(event => event.kind === 'message').map(event => event.message.content)).toEqual(['original edit text', 'later turn']);
    expect((await value.getPendingConversationBranchReplacement('branch'))?.attachments).toEqual([attachment]);
    expect(await value.conversationReferencesAttachment('branch', attachment.contentHash)).toBe(true);
  });

  it('persists explicit main conversation selection and additive editor tables on reopening', async () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'memeloop-edit-')), 'history.sqlite');
    const value = storage(filename);
    await seed(value);
    expect(await value.getMainConversationId()).toBeNull();
    await expect(value.setMainConversationId('missing')).rejects.toThrow('conversation_main_missing');
    await value.setMainConversationId('source');
    await value.saveConversationEditDraft({ conversationId: 'source', messageId: 'edit', expectedRevision: 0, text: 'durable draft' });
    value.close();
    opened.splice(opened.indexOf(value), 1);
    const reopened = storage(filename);
    expect(await reopened.getMainConversationId()).toBe('source');
    expect((await reopened.loadConversationEditSource('source', 'edit')).draft).toEqual({ text: 'durable draft', revision: 1 });
    reopened.close();
    opened.splice(opened.indexOf(reopened), 1);
    const oldSchema = new Database(filename);
    oldSchema.exec('DROP TABLE conversation_edit_drafts; DROP TABLE conversation_edit_forks; DROP TABLE local_conversation_settings;');
    oldSchema.close();
    const upgraded = storage(filename);
    expect((await upgraded.loadConversationEditSource('source', 'edit')).text).toBe('original edit text');
    expect(await upgraded.getMainConversationId()).toBeNull();
  });
});
