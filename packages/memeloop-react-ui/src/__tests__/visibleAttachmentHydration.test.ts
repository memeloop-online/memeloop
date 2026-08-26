import type { AttachmentReference, ChatMessage } from 'memeloop';
import { describe, expect, it } from 'vitest';

import {
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
  MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
  messageHydrationIdentity,
  messageHydrationRevision,
  validateVisibleAttachmentHydrationResult,
} from '../chat/visibleAttachmentHydration.js';
import type { MemeLoopVisibleAttachmentHydrationResult } from '../chat/visibleAttachmentHydration.js';
import { subscribeVisibleAttachmentHydration } from '../chat/visibleAttachmentHydrationStore.js';

const reference: AttachmentReference = {
  contentHash: `sha256:${'a'.repeat(64)}`,
  filename: 'photo.png',
  mimeType: 'image/png',
  size: 3,
};

const message: ChatMessage = {
  messageId: 'message',
  turnId: 'turn',
  conversationId: 'conversation',
  originNodeId: 'node',
  originSequence: 7,
  timestamp: 8,
  lamportClock: 9,
  role: 'user',
  content: 'image',
  attachments: [reference],
};

function request() {
  return {
    message,
    identity: messageHydrationIdentity(message),
    revision: messageHydrationRevision(message, 'resident-r1'),
    references: [reference],
    referencesOmitted: false,
    maxCount: MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT,
    maxBytes: MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES,
    signal: new AbortController().signal,
  };
}

describe('visible attachment hydration contract', () => {
  it('copies bytes into an immutable resident-only result', () => {
    const source = new Uint8Array([1, 2, 3]);
    const current = request();
    const result = validateVisibleAttachmentHydrationResult(current, {
      identity: current.identity,
      revision: current.revision,
      attachments: [{ reference, source: { kind: 'bytes', data: source } }],
    });
    source[0] = 9;
    expect(result.attachments[0]?.source).toMatchObject({ kind: 'bytes', data: new Uint8Array([1, 2, 3]) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attachments)).toBe(true);
  });

  it('rejects stale identity/revision and reference substitution', () => {
    const current = request();
    const validAttachment = [{ reference, source: { kind: 'bytes' as const, data: new Uint8Array([1, 2, 3]) } }];
    expect(() =>
      validateVisibleAttachmentHydrationResult(current, {
        identity: { ...current.identity, messageId: 'stale' },
        revision: current.revision,
        attachments: validAttachment,
      })
    ).toThrow('attachment-hydration-identity-mismatch');
    expect(() =>
      validateVisibleAttachmentHydrationResult(current, {
        identity: current.identity,
        revision: 'stale-r0',
        attachments: validAttachment,
      })
    ).toThrow('attachment-hydration-revision-mismatch');
    expect(() =>
      validateVisibleAttachmentHydrationResult(current, {
        identity: current.identity,
        revision: current.revision,
        attachments: [{
          reference: { ...reference, filename: 'substituted.png' },
          source: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) },
        }],
      })
    ).toThrow('attachment-hydration-reference-mismatch');
  });

  it('enforces declared byte size, total byte limit and attachment count', () => {
    const current = request();
    expect(() =>
      validateVisibleAttachmentHydrationResult(current, {
        identity: current.identity,
        revision: current.revision,
        attachments: [{ reference, source: { kind: 'bytes', data: new Uint8Array(2) } }],
      })
    ).toThrow('attachment-hydration-invalid-result');

    const oversizedReference = { ...reference, size: current.maxBytes + 1 };
    expect(() =>
      validateVisibleAttachmentHydrationResult({ ...current, referencesOmitted: true, references: [] }, {
        identity: current.identity,
        revision: current.revision,
        attachments: [{ reference: oversizedReference, source: { kind: 'uri', uri: 'content://verified/image' } }],
      })
    ).toThrow('attachment-hydration-byte-limit-exceeded');

    expect(() =>
      validateVisibleAttachmentHydrationResult({ ...current, referencesOmitted: true, references: [] }, {
        identity: current.identity,
        revision: current.revision,
        attachments: Array.from({ length: current.maxCount + 1 }, (_, index) => ({
          reference: { ...reference, contentHash: `sha256:${index.toString(16).padStart(64, '0')}` },
          source: { kind: 'bytes', data: new Uint8Array(3) },
        })),
      })
    ).toThrow('attachment-hydration-count-exceeded');
  });

  it('allows only host-owned Native URI schemes', () => {
    const current = request();
    for (const uri of ['content://memeloop/image', 'file:///verified/image.png', 'https://example.test/image.png']) {
      expect(() =>
        validateVisibleAttachmentHydrationResult(current, {
          identity: current.identity,
          revision: current.revision,
          attachments: [{ reference, source: { kind: 'uri', uri } }],
        })
      ).not.toThrow();
    }
    for (const uri of ['javascript:alert(1)', 'data:image/png;base64,AA==', 'http://example.test/image.png']) {
      expect(() =>
        validateVisibleAttachmentHydrationResult(current, {
          identity: current.identity,
          revision: current.revision,
          attachments: [{ reference, source: { kind: 'uri', uri } }],
        })
      ).toThrow('attachment-hydration-invalid-result');
    }
  });

  it('replays one settled shared outcome without issuing another read', async () => {
    const current = request();
    const { signal: _signal, ...requestWithoutSignal } = current;
    const page: MemeLoopVisibleAttachmentHydrationResult = {
      identity: current.identity,
      revision: current.revision,
      attachments: [{ reference, source: { kind: 'bytes' as const, data: new Uint8Array([1, 2, 3]) } }],
    };
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return page;
    };
    let releaseFirst = () => {};
    const first = new Promise<MemeLoopVisibleAttachmentHydrationResult | null>((resolve, reject) => {
      releaseFirst = subscribeVisibleAttachmentHydration(loader, requestWithoutSignal, { result: resolve, error: reject });
    });
    await expect(first).resolves.toMatchObject({ revision: current.revision });

    let releaseSecond = () => {};
    const second = new Promise<MemeLoopVisibleAttachmentHydrationResult | null>((resolve, reject) => {
      releaseSecond = subscribeVisibleAttachmentHydration(loader, requestWithoutSignal, { result: resolve, error: reject });
    });
    await expect(second).resolves.toMatchObject({ revision: current.revision });
    expect(loadCount).toBe(1);
    releaseFirst();
    releaseSecond();
  });
});
