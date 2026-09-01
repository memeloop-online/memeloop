import type { AttachmentReference, ChatMessage, ConversationMessageListProjection } from 'memeloop';

import { getDisplayTruncation } from './displayBounds.js';

/** Keep image hydration well below the durable 32/64 MiB upload limits. */
export const MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT = 8;
export const MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES = 16 * 1024 * 1024;
export const MEMELOOP_VISIBLE_ATTACHMENT_CHUNK_BYTES = 256 * 1024;

const SHA256_PATTERN = /^sha256:[a-f\d]{64}$/u;
/**
 * Hydrated bytes are rendered in an image decoder owned by the host surface.
 * Keep this list deliberately small and raster-only: active image formats such
 * as SVG must never cross this preview boundary.
 */
const SAFE_RASTER_IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_FILENAME_BYTES = 1_024;
const MAX_URI_BYTES = 4_096;
const TRUSTED_NATIVE_IMAGE_URI_PATTERN = /^(?:content:\/\/[\dA-Za-z._~-]+(?:\/[^\s]*)?|file:\/\/\/[^/\s][^\s]*)$/u;

/** One raster-only MIME gate shared by durable and composer previews. */
export function isSafeRasterImageMimeType(value: unknown): value is string {
  return typeof value === 'string' && SAFE_RASTER_IMAGE_MIME_TYPES.has(value);
}

export interface MemeLoopMessageHydrationIdentity {
  conversationId: string;
  messageId: string;
  turnId: string;
  originNodeId: string;
  originSequence: number;
  timestamp: number;
  lamportClock: number;
}

export type MemeLoopVisibleAttachmentSource =
  | Readonly<{ kind: 'bytes'; data: Uint8Array }>
  /** Native hosts may return a host-owned, already-verified URI descriptor. */
  | Readonly<{ kind: 'uri'; uri: string }>;

export interface MemeLoopVisibleAttachment {
  reference: AttachmentReference;
  source: MemeLoopVisibleAttachmentSource;
}

export interface MemeLoopVisibleAttachmentHydrationRequest {
  /** The bounded resident projection. Loaders must not retain or mutate it. */
  message: ConversationMessageListProjection;
  identity: MemeLoopMessageHydrationIdentity;
  /** Opaque resident-window revision. A result for another revision is stale. */
  revision: string;
  /** Bounded references already present in the projection; empty when omitted. */
  references: readonly AttachmentReference[];
  referencesOmitted: boolean;
  maxCount: number;
  maxBytes: number;
  signal: AbortSignal;
}

export interface MemeLoopVisibleAttachmentHydrationResult {
  identity: MemeLoopMessageHydrationIdentity;
  revision: string;
  attachments: readonly MemeLoopVisibleAttachment[];
}

/** Optional host port. It is suitable for Web bytes and Native URI descriptors. */
export type MemeLoopVisibleAttachmentLoader = (
  request: MemeLoopVisibleAttachmentHydrationRequest,
) => Promise<MemeLoopVisibleAttachmentHydrationResult | null>;

export class MemeLoopVisibleAttachmentHydrationError extends Error {
  public readonly name = 'MemeLoopVisibleAttachmentHydrationError';

  public constructor(
    public readonly code:
      | 'attachment-hydration-count-exceeded'
      | 'attachment-hydration-byte-limit-exceeded'
      | 'attachment-hydration-identity-mismatch'
      | 'attachment-hydration-invalid-result'
      | 'attachment-hydration-reference-mismatch'
      | 'attachment-hydration-revision-mismatch',
  ) {
    super(code);
  }
}

export function messageHydrationIdentity(message: ConversationMessageListProjection): MemeLoopMessageHydrationIdentity {
  return Object.freeze({
    conversationId: message.conversationId,
    messageId: message.messageId,
    turnId: message.turnId,
    originNodeId: message.originNodeId,
    originSequence: message.originSequence,
    timestamp: message.timestamp,
    lamportClock: message.lamportClock,
  });
}

export function messageHydrationRevision(message: ConversationMessageListProjection, residentRevision?: string): string {
  const identity = messageHydrationIdentity(message);
  return [
    residentRevision ?? '',
    identity.conversationId,
    identity.messageId,
    identity.turnId,
    identity.originNodeId,
    String(identity.originSequence),
    String(identity.timestamp),
    String(identity.lamportClock),
  ].join('\u001F');
}

export function messageNeedsVisibleAttachmentHydration(message: ConversationMessageListProjection): boolean {
  return getDisplayTruncation(message)?.omittedFields.includes('attachments') === true;
}

/** Exact list projections never materialise attachment references. */
export function imageAttachmentReferences(_message: ConversationMessageListProjection): readonly AttachmentReference[] {
  return Object.freeze([]);
}

/** Explicit full-message helper for non-list/composer paths only. */
export function imageAttachmentReferencesFromFullMessage(message: ChatMessage): readonly AttachmentReference[] {
  const result: AttachmentReference[] = [];
  let bytes = 0;
  for (const reference of message.attachments ?? []) {
    if (!isImageReference(reference) || reference.size > MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES) continue;
    if (result.length >= MEMELOOP_VISIBLE_ATTACHMENT_MAX_COUNT || bytes + reference.size > MEMELOOP_VISIBLE_ATTACHMENT_MAX_BYTES) break;
    result.push(reference);
    bytes += reference.size;
  }
  return Object.freeze(result);
}

export function validateVisibleAttachmentHydrationResult(
  request: MemeLoopVisibleAttachmentHydrationRequest,
  value: MemeLoopVisibleAttachmentHydrationResult,
): MemeLoopVisibleAttachmentHydrationResult {
  if (!sameIdentity(request.identity, value.identity)) {
    throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-identity-mismatch');
  }
  if (request.revision !== value.revision) {
    throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-revision-mismatch');
  }
  if (!Array.isArray(value.attachments)) {
    throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-invalid-result');
  }
  const resultAttachments: readonly MemeLoopVisibleAttachment[] = value.attachments;
  if (resultAttachments.length > request.maxCount) {
    throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-count-exceeded');
  }

  const requested = new Map(request.references.map(reference => [reference.contentHash, reference] as const));
  const seen = new Set<string>();
  const attachments: MemeLoopVisibleAttachment[] = [];
  let totalBytes = 0;
  for (const item of resultAttachments) {
    const reference = cloneImageReference(item.reference);
    if (seen.has(reference.contentHash)) {
      throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-reference-mismatch');
    }
    seen.add(reference.contentHash);
    if (!request.referencesOmitted) {
      const expected = requested.get(reference.contentHash);
      if (!expected || !sameReference(expected, reference)) {
        throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-reference-mismatch');
      }
    }
    totalBytes += reference.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > request.maxBytes) {
      throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-byte-limit-exceeded');
    }
    attachments.push(Object.freeze({ reference, source: cloneSource(item.source, reference) }));
  }
  return Object.freeze({
    identity: Object.freeze({ ...request.identity }),
    revision: request.revision,
    attachments: Object.freeze(attachments),
  });
}

export function sameMessageHydrationIdentity(
  left: MemeLoopMessageHydrationIdentity,
  right: MemeLoopMessageHydrationIdentity,
): boolean {
  return sameIdentity(left, right);
}

function cloneSource(source: MemeLoopVisibleAttachmentSource, reference: AttachmentReference): MemeLoopVisibleAttachmentSource {
  if (source.kind === 'bytes') {
    if (!isUint8Array(source.data) || source.data.byteLength !== reference.size) {
      throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-invalid-result');
    }
    return Object.freeze({ kind: 'bytes', data: new Uint8Array(source.data) });
  }
  if (source.kind === 'uri' && validText(source.uri, MAX_URI_BYTES) && TRUSTED_NATIVE_IMAGE_URI_PATTERN.test(source.uri)) {
    return Object.freeze({ kind: 'uri', uri: source.uri });
  }
  throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-invalid-result');
}

function cloneImageReference(value: AttachmentReference): AttachmentReference {
  if (
    !value || typeof value !== 'object' ||
    !SHA256_PATTERN.test(value.contentHash) ||
    !validText(value.filename, MAX_FILENAME_BYTES) ||
    !isSafeRasterImageMimeType(value.mimeType) ||
    !Number.isSafeInteger(value.size) || value.size < 1
  ) throw new MemeLoopVisibleAttachmentHydrationError('attachment-hydration-invalid-result');
  return Object.freeze({
    contentHash: value.contentHash,
    filename: value.filename,
    mimeType: value.mimeType,
    size: value.size,
  });
}

function isImageReference(reference: AttachmentReference): boolean {
  try {
    cloneImageReference(reference);
    return true;
  } catch {
    return false;
  }
}

function sameReference(left: AttachmentReference, right: AttachmentReference): boolean {
  return left.contentHash === right.contentHash && left.filename === right.filename &&
    left.mimeType === right.mimeType && left.size === right.size;
}

function sameIdentity(left: MemeLoopMessageHydrationIdentity, right: MemeLoopMessageHydrationIdentity): boolean {
  return left.conversationId === right.conversationId && left.messageId === right.messageId &&
    left.turnId === right.turnId && left.originNodeId === right.originNodeId &&
    left.originSequence === right.originSequence && left.timestamp === right.timestamp &&
    left.lamportClock === right.lamportClock;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function validText(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return false;
    bytes += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4;
    if (bytes > maximumBytes) return false;
  }
  return true;
}
