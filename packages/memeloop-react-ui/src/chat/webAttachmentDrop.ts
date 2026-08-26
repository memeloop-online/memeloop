import {
  DEFAULT_MAX_DROP_PAYLOAD_BYTES,
  DEFAULT_MAX_SELECTED_ATTACHMENTS,
  type MemeLoopAttachmentPolicy,
  MemeLoopAttachmentValidationError,
  resolveAttachmentPolicyLimit,
} from './attachmentValidation.js';
import type { DroppedAttachmentSnapshot } from './types.js';

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4;
  }
  return bytes;
}

/** Copy the ephemeral browser drag payload synchronously before awaiting host code. */
export function snapshotDroppedAttachments(
  dataTransfer: DataTransfer,
  policy: MemeLoopAttachmentPolicy = {},
): DroppedAttachmentSnapshot {
  const maximumCount = resolveAttachmentPolicyLimit(policy.maxSelectedCount, DEFAULT_MAX_SELECTED_ATTACHMENTS);
  const fileCount = dataTransfer.files.length;
  if (!Number.isSafeInteger(fileCount) || fileCount < 0 || fileCount > 1 || fileCount > maximumCount) {
    throw new MemeLoopAttachmentValidationError('attachment-count-exceeded', { maximum: Math.min(1, maximumCount) });
  }
  const files = Array.from(dataTransfer.files);
  const maximumPayloadBytes = resolveAttachmentPolicyLimit(policy.maxDropPayloadBytes, DEFAULT_MAX_DROP_PAYLOAD_BYTES);
  let payloadBytes = 0;
  const stringData = Object.create(null) as Record<string, string>;
  const typeCount = dataTransfer.types.length;
  if (!Number.isSafeInteger(typeCount) || typeCount < 0 || typeCount > maximumCount) {
    throw new MemeLoopAttachmentValidationError('attachment-count-exceeded', { maximum: maximumCount });
  }
  const types = Array.from(dataTransfer.types);
  for (const type of types) {
    const value = dataTransfer.getData(type);
    payloadBytes += utf8Length(type) + utf8Length(value);
    if (payloadBytes > maximumPayloadBytes) {
      throw new MemeLoopAttachmentValidationError('attachment-drop-payload-too-large', { maximumBytes: maximumPayloadBytes });
    }
    stringData[type] = value;
  }
  return Object.freeze({
    files: Object.freeze(files),
    stringData: Object.freeze(stringData),
  });
}
