import { describe, expect, it } from 'vitest';

import { createBrowserFileAttachmentSource, MAX_BROWSER_FILE_ATTACHMENT_BYTES } from '../agent/browserFileAttachment.js';

function metadataOnlyFile(size: number, name = 'fixture.bin', type = 'application/octet-stream'): File {
  return {
    name,
    size,
    type,
    slice: () => {
      throw new Error('metadata-only fixture cannot be read');
    },
  } as unknown as File;
}

describe('createBrowserFileAttachmentSource', () => {
  it('accepts exact 64 MiB metadata and rejects max+1', () => {
    expect(createBrowserFileAttachmentSource(metadataOnlyFile(MAX_BROWSER_FILE_ATTACHMENT_BYTES)).totalBytes)
      .toBe(MAX_BROWSER_FILE_ATTACHMENT_BYTES);
    expect(() => createBrowserFileAttachmentSource(metadataOnlyFile(MAX_BROWSER_FILE_ATTACHMENT_BYTES + 1)))
      .toThrow(RangeError);
  });

  it('preserves a valid Unicode filename and supplies a portable MIME fallback', () => {
    const source = createBrowserFileAttachmentSource(metadataOnlyFile(1, '设计稿-🎮.png', ''));
    expect(source.filename).toBe('设计稿-🎮.png');
    expect(source.mimeType).toBe('application/octet-stream');
    expect(() => createBrowserFileAttachmentSource(metadataOnlyFile(1, 'broken-\uD800.txt'))).toThrow(TypeError);
  });

  it('reads only the requested immutable range and validates offset/chunk bounds', async () => {
    const source = createBrowserFileAttachmentSource(new File(['abcdef'], 'letters.txt', { type: 'text/plain' }));
    await expect(source.readChunk(2, 3)).resolves.toEqual(new Uint8Array([99, 100, 101]));
    await expect(source.readChunk(5, 99)).resolves.toEqual(new Uint8Array([102]));
    await expect(source.readChunk(6, 1)).resolves.toBeNull();
    await expect(source.readChunk(7, 1)).rejects.toThrow(RangeError);
    await expect(source.readChunk(0, 0)).rejects.toThrow(RangeError);
  });

  it('honours pre-aborted range reads without touching the File', async () => {
    let sliceCalls = 0;
    const file = {
      name: 'fixture.bin',
      size: 1,
      type: 'application/octet-stream',
      slice: () => {
        sliceCalls += 1;
        return new Blob(['x']);
      },
    } as unknown as File;
    const source = createBrowserFileAttachmentSource(file);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(source.readChunk(0, 1, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(sliceCalls).toBe(0);
  });

  it('rejects a hostile slice that returns more bytes than requested', async () => {
    const file = {
      name: 'fixture.bin',
      size: 10,
      type: 'application/octet-stream',
      slice: () => new Blob(['oversized']),
    } as unknown as File;
    const source = createBrowserFileAttachmentSource(file);
    await expect(source.readChunk(0, 2)).rejects.toThrow('exceeded its request');
  });

  it('rejects when cancellation arrives while arrayBuffer is pending', async () => {
    let resolveBuffer!: (buffer: ArrayBuffer) => void;
    const pendingBuffer = new Promise<ArrayBuffer>(resolve => {
      resolveBuffer = resolve;
    });
    const file = {
      name: 'fixture.bin',
      size: 1,
      type: 'application/octet-stream',
      slice: () => ({ arrayBuffer: () => pendingBuffer }),
    } as unknown as File;
    const source = createBrowserFileAttachmentSource(file);
    const controller = new AbortController();
    const operation = source.readChunk(0, 1, { signal: controller.signal });
    controller.abort(new Error('cancelled during read'));
    resolveBuffer(new Uint8Array([1]).buffer);
    await expect(operation).rejects.toThrow('cancelled during read');
  });
});
