import type { AgentAttachmentUploadSource } from 'memeloop';

export const MAX_BROWSER_FILE_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_BROWSER_FILE_ATTACHMENT_FILENAME_BYTES = 1_024;
export const MAX_BROWSER_FILE_ATTACHMENT_MIME_TYPE_BYTES = 256;

const MIME_TYPE_PATTERN = /^[!#$%&'*+.^_`|~\dA-Za-z-]+\/[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;

function strictUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7F) bytes += 1;
    else if (code <= 0x7FF) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xDC00 && low <= 0xDFFF)) throw new TypeError('browser attachment contains invalid Unicode');
      bytes += 4;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new TypeError('browser attachment contains invalid Unicode');
    } else bytes += 3;
  }
  return bytes;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertFileMetadata(file: File): { filename: string; mimeType: string; totalBytes: number } {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new TypeError('browser attachment size must be a non-negative safe integer');
  if (file.size > MAX_BROWSER_FILE_ATTACHMENT_BYTES) throw new RangeError('browser attachment exceeds 64 MiB');
  if (
    typeof file.name !== 'string' || file.name.length === 0 || file.name === '.' || file.name === '..' ||
    file.name.includes('/') || file.name.includes('\\') || hasAsciiControl(file.name) ||
    strictUtf8Bytes(file.name) > MAX_BROWSER_FILE_ATTACHMENT_FILENAME_BYTES
  ) throw new TypeError('browser attachment filename is invalid');
  const mimeType = file.type || 'application/octet-stream';
  if (
    strictUtf8Bytes(mimeType) > MAX_BROWSER_FILE_ATTACHMENT_MIME_TYPE_BYTES ||
    !MIME_TYPE_PATTERN.test(mimeType)
  ) throw new TypeError('browser attachment MIME type is invalid');
  if (typeof file.slice !== 'function') throw new TypeError('browser attachment does not support bounded range reads');
  return { filename: file.name, mimeType, totalBytes: file.size };
}

/** Wrap one immutable browser File as Core's bounded, cancellable upload source. */
export function createBrowserFileAttachmentSource(file: File): AgentAttachmentUploadSource {
  const metadata = assertFileMetadata(file);
  return Object.freeze({
    kind: 'source' as const,
    ...metadata,
    async readChunk(offset: number, maxBytes: number, options?: { signal?: AbortSignal }): Promise<Uint8Array | null> {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > metadata.totalBytes) {
        throw new RangeError('browser attachment offset is outside the file');
      }
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new RangeError('browser attachment chunk size must be a positive safe integer');
      }
      options?.signal?.throwIfAborted();
      if (offset === metadata.totalBytes) return null;
      const end = Math.min(metadata.totalBytes, offset + Math.min(maxBytes, metadata.totalBytes - offset));
      const buffer = await file.slice(offset, end).arrayBuffer();
      options?.signal?.throwIfAborted();
      const chunk = new Uint8Array(buffer);
      if (chunk.byteLength > maxBytes || chunk.byteLength > metadata.totalBytes - offset) {
        throw new RangeError('browser attachment range reader exceeded its request');
      }
      return chunk.byteLength === 0 ? null : chunk;
    },
  });
}
