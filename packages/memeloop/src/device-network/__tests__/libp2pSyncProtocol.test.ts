import { describe, expect, it } from 'vitest';

import { attachmentChunkFromWire, isLibp2pSyncRequest, isLibp2pSyncResponse, LIBP2P_SYNC_REQUEST_TYPE, LIBP2P_SYNC_RESPONSE_TYPE } from '../libp2pSyncProtocol.js';

describe('attachmentChunkFromWire', () => {
  it('decodes base64url without a Node Buffer dependency', async () => {
    const result = await attachmentChunkFromWire({
      dataBase64Url: '_-7d',
      byteLength: 3,
      offset: 0,
      totalSize: 3,
      done: true,
      filename: 'bytes.bin',
      mimeType: 'application/octet-stream',
    });

    expect(result).toEqual({
      data: new Uint8Array([255, 238, 221]),
      offset: 0,
      totalSize: 3,
      done: true,
      filename: 'bytes.bin',
      mimeType: 'application/octet-stream',
    });
  });

  it('rejects malformed base64url', async () => {
    await expect(
      attachmentChunkFromWire({
        dataBase64Url: '***',
        byteLength: 3,
        offset: 0,
        totalSize: 3,
        done: true,
        filename: 'bytes.bin',
        mimeType: 'application/octet-stream',
      }),
    ).rejects.toThrow('invalid_sync_attachment_chunk');
  });
});

describe('v2 sync envelopes', () => {
  it('rejects unknown keys and unbounded identifiers', () => {
    const request = {
      type: LIBP2P_SYNC_REQUEST_TYPE,
      id: 'request',
      method: 'pushEvents',
      params: { events: [] },
    };
    expect(isLibp2pSyncRequest(request)).toBe(true);
    expect(isLibp2pSyncRequest({ ...request, unknown: true })).toBe(false);
    expect(isLibp2pSyncRequest({ ...request, id: 'x'.repeat(129) })).toBe(false);

    const failure = {
      type: LIBP2P_SYNC_RESPONSE_TYPE,
      id: 'request',
      ok: false,
      error: { code: 'invalid_sync_params' },
    };
    expect(isLibp2pSyncResponse(failure)).toBe(true);
    expect(isLibp2pSyncResponse({ ...failure, diagnostics: 'secret' })).toBe(false);
    expect(isLibp2pSyncResponse({ ...failure, error: { code: 'bad-code' } })).toBe(false);
  });
});
