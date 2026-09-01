import { runInNewContext } from 'node:vm';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  assertAttachmentUploadIdempotentReplay,
  assertAttachmentUploadRpcRequest,
  assertAttachmentUploadRpcResponseCorrelation,
  ATTACHMENT_UPLOAD_LIMITS,
  ATTACHMENT_UPLOAD_RPC_METHODS,
  attachmentUploadBase64ToBytes,
  attachmentUploadBytesToBase64,
  AttachmentUploadConflictError,
  AttachmentUploadProtocolError,
  type AttachmentUploadRpcCallOptions,
  type AttachmentUploadRpcMethod,
  type AttachmentUploadRpcRequest,
  type BeginAttachmentUploadRequest,
  type BeginAttachmentUploadResponse,
  bindAttachmentUploadRpcClient,
  buildAttachmentUploadChunkRequest,
  buildAttachmentUploadIdempotencyRecord,
  type CheckedAttachmentUploadRpcCall,
  type CommitAttachmentUploadRequest,
  type CommitAttachmentUploadResponse,
  createAttachmentUploadRpcClient,
  decodeAttachmentUploadChunk,
  fingerprintAttachmentUploadOperation,
  parseAttachmentUploadRpcResponse,
  type UploadAttachmentChunkRequest,
  type UploadAttachmentChunkResponse,
} from '../attachmentUpload.js';

const sha256Hello = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function beginRequest(
  overrides: Partial<BeginAttachmentUploadRequest> = {},
): BeginAttachmentUploadRequest {
  return {
    requestId: 'begin-request-1',
    conversationId: 'conversation-1',
    filename: 'hello.txt',
    mimeType: 'text/plain',
    totalBytes: 5,
    ...overrides,
  };
}

function commitRequest(
  overrides: Partial<CommitAttachmentUploadRequest> = {},
): CommitAttachmentUploadRequest {
  return {
    requestId: 'commit-request-1',
    conversationId: 'conversation-1',
    uploadId: 'upload-1',
    size: 5,
    sha256: sha256Hello,
    ...overrides,
  };
}

describe('attachment upload v2 contract', () => {
  it('preserves each bound method request and response type', () => {
    const client = createAttachmentUploadRpcClient({
      call: async () => {
        throw new Error('unused transport');
      },
    });

    expectTypeOf(client.begin).toEqualTypeOf<
      (
        parameters: BeginAttachmentUploadRequest,
        callOptions?: AttachmentUploadRpcCallOptions,
      ) => Promise<BeginAttachmentUploadResponse>
    >();
    expectTypeOf(client.chunk).toEqualTypeOf<
      (
        parameters: UploadAttachmentChunkRequest,
        callOptions?: AttachmentUploadRpcCallOptions,
      ) => Promise<UploadAttachmentChunkResponse>
    >();
    expectTypeOf(client.commit).toEqualTypeOf<
      (
        parameters: CommitAttachmentUploadRequest,
        callOptions?: AttachmentUploadRpcCallOptions,
      ) => Promise<CommitAttachmentUploadResponse>
    >();
  });

  it('binds an already-checked call without another protocol pass', async () => {
    const checked = vi.fn(async (_method, request: { requestId: string; conversationId: string }) => ({
      ok: true as const,
      requestId: request.requestId,
      conversationId: request.conversationId,
      uploadId: 'upload-1',
      totalBytes: 5,
      maxChunkBytes: ATTACHMENT_UPLOAD_LIMITS.chunkBytes,
      alreadyChecked: true,
    })) as unknown as CheckedAttachmentUploadRpcCall;
    const client = bindAttachmentUploadRpcClient(checked);

    await expect(client.begin(beginRequest())).resolves.toMatchObject({
      uploadId: 'upload-1',
      alreadyChecked: true,
    });
    expect(checked).toHaveBeenCalledOnce();
    expect(checked).toHaveBeenCalledWith(
      ATTACHMENT_UPLOAD_RPC_METHODS.begin,
      beginRequest(),
      {},
    );
  });

  it('strictly bounds begin identity, conversation scope, metadata, and total size', () => {
    expect(() => {
      assertAttachmentUploadRpcRequest(ATTACHMENT_UPLOAD_RPC_METHODS.begin, beginRequest());
    }).not.toThrow();
    expect(() => {
      assertAttachmentUploadRpcRequest(
        ATTACHMENT_UPLOAD_RPC_METHODS.begin,
        beginRequest({ conversationId: '' }),
      );
    }).toThrow(AttachmentUploadProtocolError);
    expect(() => {
      assertAttachmentUploadRpcRequest(
        ATTACHMENT_UPLOAD_RPC_METHODS.begin,
        beginRequest({ totalBytes: ATTACHMENT_UPLOAD_LIMITS.totalBytes + 1 }),
      );
    }).toThrow(AttachmentUploadProtocolError);
    expect(() => {
      assertAttachmentUploadRpcRequest(ATTACHMENT_UPLOAD_RPC_METHODS.begin, {
        ...beginRequest(),
        ignored: true,
      });
    }).toThrow(AttachmentUploadProtocolError);
  });

  it('decodes canonical base64 and checks actual bytes instead of trusting declared length', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const base64 = attachmentUploadBytesToBase64(bytes);
    expect(base64).toBe('AAEC/f7/');
    expect(attachmentUploadBase64ToBytes(base64)).toEqual(bytes);

    const request: UploadAttachmentChunkRequest = {
      requestId: 'chunk-request-1',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      byteLength: 2,
      encoding: 'base64',
      data: 'aGVsbG8=',
    };
    expect(() => {
      assertAttachmentUploadRpcRequest(ATTACHMENT_UPLOAD_RPC_METHODS.chunk, request);
    }).toThrow(AttachmentUploadProtocolError);
    expect(() => attachmentUploadBase64ToBytes('aGVs bG8=')).toThrow(AttachmentUploadProtocolError);
    expect(() => attachmentUploadBase64ToBytes('AB==')).toThrow(AttachmentUploadProtocolError);
  });

  it('builds bounded chunks and verifies optional SHA-256 over decoded bytes', async () => {
    const request = await buildAttachmentUploadChunkRequest({
      requestId: 'chunk-request-1',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: new TextEncoder().encode('hello'),
      includeSha256: true,
    });

    expect(request).toMatchObject({
      byteLength: 5,
      data: 'aGVsbG8=',
      sha256: sha256Hello,
    });
    await expect(decodeAttachmentUploadChunk(request)).resolves.toEqual(
      new TextEncoder().encode('hello'),
    );
    await expect(decodeAttachmentUploadChunk({
      ...request,
      data: 'aGVsbGE=',
    })).rejects.toMatchObject({ field: 'request.sha256' });
    await expect(buildAttachmentUploadChunkRequest({
      requestId: 'chunk-request-2',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: new Uint8Array(ATTACHMENT_UPLOAD_LIMITS.chunkBytes + 1),
    })).rejects.toMatchObject({ field: 'request.byteLength' });
  });

  it('accepts genuine cross-realm Uint8Array values and copies before caller detachment', async () => {
    const crossRealm = runInNewContext(
      'new Uint8Array(new Uint8Array([9, 1, 2, 8]).buffer, 1, 2)',
    ) as Uint8Array;
    expect(crossRealm).not.toBeInstanceOf(Uint8Array);
    await expect(buildAttachmentUploadChunkRequest({
      requestId: 'cross-realm',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: crossRealm,
      includeSha256: true,
    })).resolves.toMatchObject({ byteLength: 2, data: 'AQI=' });

    const detachable = new Uint8Array([1, 2, 3]);
    const build = buildAttachmentUploadChunkRequest({
      requestId: 'detached-copy',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: detachable,
      includeSha256: true,
    });
    structuredClone(detachable.buffer, { transfer: [detachable.buffer] });
    expect(detachable.byteLength).toBe(0);
    await expect(build).resolves.toMatchObject({ byteLength: 3, data: 'AQID' });
  });

  it('enforces exact/max+1 chunk bytes for a cross-realm view', async () => {
    const exact = runInNewContext('new Uint8Array(size)', {
      size: ATTACHMENT_UPLOAD_LIMITS.chunkBytes,
    }) as Uint8Array;
    const exactRequest = await buildAttachmentUploadChunkRequest({
      requestId: 'cross-realm-exact',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: exact,
    });
    expect(exactRequest.byteLength).toBe(ATTACHMENT_UPLOAD_LIMITS.chunkBytes);
    expect(exactRequest.data).toHaveLength(ATTACHMENT_UPLOAD_LIMITS.chunkBase64Characters);

    const over = runInNewContext('new Uint8Array(size)', {
      size: ATTACHMENT_UPLOAD_LIMITS.chunkBytes + 1,
    }) as Uint8Array;
    await expect(buildAttachmentUploadChunkRequest({
      requestId: 'cross-realm-over',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: over,
    })).rejects.toMatchObject({ field: 'request.byteLength' });
  });

  it('rejects every non-Uint8 brand, SharedArrayBuffer, proxies, and forged tags', async () => {
    const invalid: unknown[] = [
      new Int8Array([1]),
      new Uint8ClampedArray([1]),
      new Uint16Array([1]),
      new DataView(new ArrayBuffer(1)),
      new Proxy(new Uint8Array([1]), {}),
      { byteLength: 1, 0: 1, [Symbol.toStringTag]: 'Uint8Array' },
    ];
    if (typeof SharedArrayBuffer === 'function') {
      invalid.push(new Uint8Array(new SharedArrayBuffer(1)));
    }
    for (const [index, data] of invalid.entries()) {
      await expect(buildAttachmentUploadChunkRequest({
        requestId: `invalid-brand-${index}`,
        conversationId: 'conversation-1',
        uploadId: 'upload-1',
        offset: 0,
        data: data as Uint8Array,
      })).rejects.toMatchObject({ field: 'request.data' });
    }
  });

  it('rejects a build-input accessor without invoking it', async () => {
    const getter = vi.fn(() => new Uint8Array([1]));
    const input = {
      requestId: 'getter',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      get data() {
        return getter();
      },
    };
    await expect(buildAttachmentUploadChunkRequest(input))
      .rejects.toMatchObject({ field: 'request' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('provides stable operation fingerprints and detects every payload drift', async () => {
    const request = await buildAttachmentUploadChunkRequest({
      requestId: 'chunk-request-1',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: new TextEncoder().encode('hello'),
      includeSha256: true,
    });
    const fingerprint = await fingerprintAttachmentUploadOperation(
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      request,
    );

    await expect(fingerprintAttachmentUploadOperation(
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      { ...request },
    )).resolves.toBe(fingerprint);
    await expect(fingerprintAttachmentUploadOperation(
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      { ...request, offset: 5 },
    )).resolves.not.toBe(fingerprint);
    await expect(fingerprintAttachmentUploadOperation(
      ATTACHMENT_UPLOAD_RPC_METHODS.commit,
      commitRequest(),
    )).resolves.not.toBe(fingerprint);

    const record = await buildAttachmentUploadIdempotencyRecord(
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      request,
      'peer-a',
    );
    await expect(assertAttachmentUploadIdempotentReplay(
      record,
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      { ...request },
      'peer-a',
    )).resolves.toBeUndefined();
    await expect(assertAttachmentUploadIdempotentReplay(
      record,
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      { ...request, data: 'aGVsbGE=' },
      'peer-a',
    )).rejects.toBeInstanceOf(AttachmentUploadConflictError);
    await expect(assertAttachmentUploadIdempotentReplay(
      record,
      ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
      { ...request },
      'peer-b',
    )).rejects.toBeInstanceOf(AttachmentUploadConflictError);

    const commit = commitRequest();
    const commitRecord = await buildAttachmentUploadIdempotencyRecord(
      ATTACHMENT_UPLOAD_RPC_METHODS.commit,
      commit,
      'peer-a',
    );
    await expect(assertAttachmentUploadIdempotentReplay(
      commitRecord,
      ATTACHMENT_UPLOAD_RPC_METHODS.commit,
      { ...commit },
      'peer-a',
    )).resolves.toBeUndefined();
    await expect(assertAttachmentUploadIdempotentReplay(
      commitRecord,
      ATTACHMENT_UPLOAD_RPC_METHODS.commit,
      { ...commit, size: commit.size - 1 },
      'peer-a',
    )).rejects.toBeInstanceOf(AttachmentUploadConflictError);
  });

  it('correlates every response to request id, conversation, upload, offset, size, and digest', () => {
    const begin = beginRequest();
    const beginResponse = parseAttachmentUploadRpcResponse(
      ATTACHMENT_UPLOAD_RPC_METHODS.begin,
      {
        ok: true,
        requestId: begin.requestId,
        conversationId: begin.conversationId,
        uploadId: 'upload-1',
        totalBytes: 5,
        maxChunkBytes: ATTACHMENT_UPLOAD_LIMITS.chunkBytes,
      },
    );
    expect(() => {
      assertAttachmentUploadRpcResponseCorrelation(
        ATTACHMENT_UPLOAD_RPC_METHODS.begin,
        begin,
        beginResponse,
      );
    }).not.toThrow();
    expect(() => {
      assertAttachmentUploadRpcResponseCorrelation(
        ATTACHMENT_UPLOAD_RPC_METHODS.begin,
        begin,
        { ...beginResponse, conversationId: 'conversation-2' },
      );
    }).toThrow(AttachmentUploadProtocolError);

    const commit = commitRequest();
    const commitResponse = parseAttachmentUploadRpcResponse(
      ATTACHMENT_UPLOAD_RPC_METHODS.commit,
      {
        ok: true,
        requestId: commit.requestId,
        conversationId: commit.conversationId,
        uploadId: commit.uploadId,
        attachment: {
          contentHash: commit.sha256,
          filename: 'hello.txt',
          mimeType: 'text/plain',
          size: commit.size,
        },
      },
    );
    expect(() => {
      assertAttachmentUploadRpcResponseCorrelation(
        ATTACHMENT_UPLOAD_RPC_METHODS.commit,
        commit,
        commitResponse,
      );
    }).not.toThrow();
    expect(() => {
      assertAttachmentUploadRpcResponseCorrelation(
        ATTACHMENT_UPLOAD_RPC_METHODS.commit,
        commit,
        {
          ...commitResponse,
          attachment: { ...commitResponse.attachment, size: 4 },
        },
      );
    }).toThrow(AttachmentUploadProtocolError);
  });

  it('forwards AbortSignal and keeps repeated chunk/commit payloads identical for retries', async () => {
    const call = vi.fn(async (
      method: AttachmentUploadRpcMethod,
      typedRequest: AttachmentUploadRpcRequest<AttachmentUploadRpcMethod>,
      options?: { signal?: AbortSignal },
    ) => {
      const request = typedRequest as unknown as Record<string, unknown>;
      options?.signal?.throwIfAborted();
      if (method === ATTACHMENT_UPLOAD_RPC_METHODS.chunk) {
        return {
          ok: true,
          requestId: request.requestId,
          conversationId: request.conversationId,
          uploadId: request.uploadId,
          offset: request.offset,
          byteLength: request.byteLength,
        };
      }
      return {
        ok: true,
        requestId: request.requestId,
        conversationId: request.conversationId,
        uploadId: request.uploadId,
        attachment: {
          contentHash: request.sha256,
          filename: 'hello.txt',
          mimeType: 'text/plain',
          size: request.size,
        },
      };
    });
    const client = createAttachmentUploadRpcClient({ call });
    const chunk = await buildAttachmentUploadChunkRequest({
      requestId: 'chunk-request-1',
      conversationId: 'conversation-1',
      uploadId: 'upload-1',
      offset: 0,
      data: new TextEncoder().encode('hello'),
      includeSha256: true,
    });
    const controller = new AbortController();

    await client.chunk(chunk, { signal: controller.signal });
    await client.chunk(chunk, { signal: controller.signal });
    await client.commit(commitRequest(), { signal: controller.signal });
    await client.commit(commitRequest(), { signal: controller.signal });
    expect(call.mock.calls[0]?.[1]).toEqual(call.mock.calls[1]?.[1]);
    expect(call.mock.calls[2]?.[1]).toEqual(call.mock.calls[3]?.[1]);
    expect(call.mock.calls[0]?.[2]).toEqual({ signal: controller.signal });

    controller.abort(new Error('cancel upload'));
    await expect(client.chunk(chunk, { signal: controller.signal })).rejects.toThrow('cancel upload');
    expect(call).toHaveBeenCalledTimes(4);
  });
});
