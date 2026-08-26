import { describe, expect, it } from 'vitest';

import { MemeLoopAttachmentValidationError, validateMemeLoopAttachmentSelection, validateWebFileAttachment, validateWikiTiddlerAttachment } from '../chat/attachmentValidation.js';
import { snapshotDroppedAttachments } from '../chat/webAttachmentDrop.js';

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(MemeLoopAttachmentValidationError);
    expect((error as MemeLoopAttachmentValidationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('attachment hostile input validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('rejects an invalid file size %s', size => {
    expectCode(() => {
      validateWebFileAttachment({ size, type: 'text/plain' }, 0);
    }, 'attachment-invalid-file-size');
  });

  it.each(
    [
      ['maxSelectedCount', 0],
      ['maxFileBytes', Number.NaN],
      ['maxWorkspaceNameBytes', Number.POSITIVE_INFINITY],
      ['maxTiddlerTitleBytes', -1],
      ['maxDropPayloadBytes', 1.5],
    ] as const,
  )('rejects invalid policy limit %s', (key, value) => {
    if (key === 'maxDropPayloadBytes' || key === 'maxSelectedCount') {
      expectCode(() => snapshotDroppedAttachments({ files: [], types: [], getData: () => '' } as unknown as DataTransfer, { [key]: value }), 'attachment-invalid-policy');
      return;
    }
    if (key === 'maxFileBytes') {
      expectCode(() => {
        validateWebFileAttachment({ size: 0, type: '' }, 0, { [key]: value });
      }, 'attachment-invalid-policy');
      return;
    }
    expectCode(() => validateWikiTiddlerAttachment({ workspaceName: 'Wiki', tiddlerTitle: 'Title' }, [], false, { [key]: value }), 'attachment-invalid-policy');
  });

  it('uses a frozen null-prototype record for hostile drag MIME type keys', () => {
    const snapshot = snapshotDroppedAttachments({
      files: [],
      types: ['__proto__', 'constructor'],
      getData: (type: string) => type === '__proto__' ? 'prototype-payload' : 'constructor-payload',
    } as unknown as DataTransfer);

    expect(Object.getPrototypeOf(snapshot.stringData)).toBeNull();
    expect(Object.isFrozen(snapshot.stringData)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(snapshot.stringData, '__proto__')).toBe(true);
    expect(snapshot.stringData['__proto__']).toBe('prototype-payload');
    expect(snapshot.stringData.constructor).toBe('constructor-payload');
  });

  it('rejects hostile collection lengths before iterating drop payloads', () => {
    let iteratorCalls = 0;
    const hostileCollection = {
      length: 1_000_000,
      [Symbol.iterator]() {
        iteratorCalls += 1;
        return [][Symbol.iterator]();
      },
    };
    expectCode(() =>
      snapshotDroppedAttachments({
        files: hostileCollection,
        types: [],
        getData: () => '',
      } as unknown as DataTransfer), 'attachment-count-exceeded');
    expect(iteratorCalls).toBe(0);

    expectCode(() =>
      snapshotDroppedAttachments({
        files: [],
        types: hostileCollection,
        getData: () => '',
      } as unknown as DataTransfer), 'attachment-count-exceeded');
    expect(iteratorCalls).toBe(0);
  });

  it('returns and deduplicates the explicit canonical tiddler identity', () => {
    const canonical = validateWikiTiddlerAttachment({ workspaceName: ' Wiki ', tiddlerTitle: ' Title ' }, [], false);
    expect(canonical).toEqual({ workspaceName: 'Wiki', tiddlerTitle: 'Title' });
    expect(Object.isFrozen(canonical)).toBe(true);
    expectCode(
      () => validateWikiTiddlerAttachment({ workspaceName: 'Wiki', tiddlerTitle: 'Title' }, [{ workspaceName: ' Wiki ', tiddlerTitle: ' Title ' }], false),
      'attachment-duplicate',
    );
  });

  it('clones and freezes an atomic portable selection without invoking attachment getters', () => {
    const batch = validateMemeLoopAttachmentSelection({
      file: { size: 4, type: 'text/plain' },
      wikiTiddlers: [{ workspaceName: ' Wiki ', tiddlerTitle: ' Design ' }],
    });
    expect(batch).toEqual({
      file: { size: 4, type: 'text/plain' },
      wikiTiddlers: [{ workspaceName: 'Wiki', tiddlerTitle: 'Design' }],
    });
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.wikiTiddlers)).toBe(true);
    expect(Object.isFrozen(batch.wikiTiddlers[0])).toBe(true);

    let getterCalls = 0;
    const hostile = {} as { workspaceName: string; tiddlerTitle: string };
    Object.defineProperty(hostile, 'workspaceName', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'Wiki';
      },
    });
    Object.defineProperty(hostile, 'tiddlerTitle', { enumerable: true, value: 'Design' });
    expectCode(() => validateMemeLoopAttachmentSelection({ wikiTiddlers: [hostile] }), 'attachment-invalid-tiddler-title');
    expect(getterCalls).toBe(0);
  });
});
