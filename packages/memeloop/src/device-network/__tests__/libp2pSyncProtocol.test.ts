import { describe, expect, it } from 'vitest';

import { attachmentBlobFromWire } from '../libp2pSyncProtocol.js';

describe('attachmentBlobFromWire', () => {
  it('decodes base64url without a Node Buffer dependency', async () => {
    const result = await attachmentBlobFromWire({
      dataBase64Url: '_-7d',
      filename: 'bytes.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    });

    expect(result).toEqual({
      data: new Uint8Array([255, 238, 221]),
      filename: 'bytes.bin',
      mimeType: 'application/octet-stream',
      size: 3,
    });
  });

  it('rejects malformed base64url', async () => {
    await expect(
      attachmentBlobFromWire({
        dataBase64Url: '***',
        filename: 'bytes.bin',
        mimeType: 'application/octet-stream',
        size: 3,
      }),
    ).rejects.toThrow('invalid_sync_response');
  });
});
