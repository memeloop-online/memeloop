import { describe, expect, it, vi } from 'vitest';

import { AgentAttachmentInputError, assertAgentAttachmentInput, normalizeAgentAttachmentInput } from '../attachmentInput.js';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('agent attachment input validation', () => {
  it('copies and freezes a source descriptor without reading attachment bytes', () => {
    const readChunk = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const input = {
      kind: 'source' as const,
      filename: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: 1,
      sha256: HASH,
      readChunk,
    };
    const normalized = normalizeAgentAttachmentInput(input);
    expect(normalized).not.toBe(input);
    expect(normalized).toEqual(input);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(readChunk).not.toHaveBeenCalled();
    expect(() => {
      assertAgentAttachmentInput(input);
    }).not.toThrow();
    expect(readChunk).not.toHaveBeenCalled();
  });

  it('copies and recursively freezes a committed reference', () => {
    const input = {
      kind: 'committed' as const,
      reference: { contentHash: HASH, filename: 'image.png', mimeType: 'image/png', size: 12 },
    };
    const normalized = normalizeAgentAttachmentInput(input);
    expect(normalized).not.toBe(input);
    expect(normalized.kind).toBe('committed');
    if (normalized.kind !== 'committed') throw new Error('expected committed');
    expect(normalized.reference).not.toBe(input.reference);
    expect(Object.isFrozen(normalized.reference)).toBe(true);
  });

  it('rejects accessors without invoking them', () => {
    const getter = vi.fn(() => 'source');
    const input = {
      get kind() {
        return getter();
      },
      filename: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: 0,
      readChunk: vi.fn(),
    };
    expect(() => normalizeAgentAttachmentInput(input as never)).toThrowError(AgentAttachmentInputError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects exotic prototypes, symbols, and extra keys', () => {
    class Exotic {
      kind = 'source';
      filename = 'note.txt';
      mimeType = 'text/plain';
      totalBytes = 0;
      readChunk = vi.fn();
    }
    expect(() => normalizeAgentAttachmentInput(new Exotic() as never)).toThrowError(AgentAttachmentInputError);
    expect(() =>
      normalizeAgentAttachmentInput({
        kind: 'source',
        filename: 'note.txt',
        mimeType: 'text/plain',
        totalBytes: 0,
        readChunk: vi.fn(),
        dangerous: true,
      } as never)
    ).toThrowError(AgentAttachmentInputError);
    expect(() =>
      normalizeAgentAttachmentInput({
        kind: 'source',
        filename: 'note.txt',
        mimeType: 'text/plain',
        totalBytes: 0,
        readChunk: vi.fn(),
        [Symbol('dangerous')]: true,
      } as never)
    ).toThrowError(AgentAttachmentInputError);
  });
});
