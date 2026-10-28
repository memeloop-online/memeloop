import type { AgentAttachmentInput, AgentAttachmentUploadSource, AgentCommittedAttachment } from './types.js';

/** Host-neutral attachment limits shared by session adapters. */
export const AGENT_ATTACHMENT_INPUT_LIMITS = Object.freeze(
  {
    filenameCharacters: 1_024,
    mimeTypeCharacters: 256,
    totalBytes: 64 * 1_024 * 1_024,
  } as const,
);

export const AGENT_ATTACHMENT_SHA256_PATTERN = /^sha256:[\da-f]{64}$/u;

export class AgentAttachmentInputError extends Error {
  readonly code = 'invalid_agent_attachment_input' as const;

  constructor(readonly field: string) {
    super(`Invalid agent attachment input ${field}`);
    this.name = 'AgentAttachmentInputError';
  }
}

/** Validate the portable source/reference shape without invoking accessors or the range reader. */
export function assertAgentAttachmentInput(
  attachment: AgentAttachmentInput,
): asserts attachment is AgentAttachmentInput {
  void normalizeAgentAttachmentInput(attachment);
}

/**
 * Return a descriptor-safe immutable copy for crossing a coordinator/host
 * boundary. Attachment bytes remain lazy: `readChunk` is copied, never called.
 */
export function normalizeAgentAttachmentInput(
  attachment: AgentAttachmentInput,
): AgentAttachmentInput {
  const root = readPlainRecord(attachment, 'attachment');
  const kind = readDataProperty(root, 'kind', 'attachment.kind');
  if (kind === 'source') return normalizeSource(root);
  if (kind === 'committed') return normalizeCommitted(root);
  throw new AgentAttachmentInputError('attachment.kind');
}

function normalizeSource(root: DescriptorRecord): AgentAttachmentUploadSource {
  assertExactKeys(root, ['kind', 'filename', 'mimeType', 'totalBytes', 'readChunk'], ['sha256'], 'source');
  const filename = readDataProperty(root, 'filename', 'source.filename');
  const mimeType = readDataProperty(root, 'mimeType', 'source.mimeType');
  const totalBytes = readDataProperty(root, 'totalBytes', 'source.totalBytes');
  const sha256 = readOptionalDataProperty(root, 'sha256', 'source.sha256');
  const readChunk = readDataProperty(root, 'readChunk', 'source.readChunk');
  assertAttachmentText(filename, AGENT_ATTACHMENT_INPUT_LIMITS.filenameCharacters, 'source.filename');
  assertAttachmentText(mimeType, AGENT_ATTACHMENT_INPUT_LIMITS.mimeTypeCharacters, 'source.mimeType');
  if (
    !Number.isSafeInteger(totalBytes) ||
    typeof totalBytes !== 'number' ||
    totalBytes < 0 ||
    totalBytes > AGENT_ATTACHMENT_INPUT_LIMITS.totalBytes
  ) throw new AgentAttachmentInputError('source.totalBytes');
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !AGENT_ATTACHMENT_SHA256_PATTERN.test(sha256))) {
    throw new AgentAttachmentInputError('source.sha256');
  }
  if (typeof readChunk !== 'function') throw new AgentAttachmentInputError('source.readChunk');
  return Object.freeze({
    kind: 'source',
    filename,
    mimeType,
    totalBytes,
    ...(sha256 === undefined ? {} : { sha256 }),
    readChunk: readChunk as AgentAttachmentUploadSource['readChunk'],
  });
}

function normalizeCommitted(root: DescriptorRecord): AgentCommittedAttachment {
  assertExactKeys(root, ['kind', 'reference'], [], 'committed');
  const referenceRecord = readPlainRecord(
    readDataProperty(root, 'reference', 'committed.reference'),
    'committed.reference',
  );
  assertExactKeys(
    referenceRecord,
    ['contentHash', 'filename', 'mimeType', 'size'],
    [],
    'committed.reference',
  );
  const contentHash = readDataProperty(referenceRecord, 'contentHash', 'committed.reference.contentHash');
  const filename = readDataProperty(referenceRecord, 'filename', 'committed.reference.filename');
  const mimeType = readDataProperty(referenceRecord, 'mimeType', 'committed.reference.mimeType');
  const size = readDataProperty(referenceRecord, 'size', 'committed.reference.size');
  if (typeof contentHash !== 'string' || !AGENT_ATTACHMENT_SHA256_PATTERN.test(contentHash)) {
    throw new AgentAttachmentInputError('committed.reference.contentHash');
  }
  assertAttachmentText(filename, AGENT_ATTACHMENT_INPUT_LIMITS.filenameCharacters, 'committed.reference.filename');
  assertAttachmentText(mimeType, AGENT_ATTACHMENT_INPUT_LIMITS.mimeTypeCharacters, 'committed.reference.mimeType');
  if (
    !Number.isSafeInteger(size) ||
    typeof size !== 'number' ||
    size < 0 ||
    size > AGENT_ATTACHMENT_INPUT_LIMITS.totalBytes
  ) throw new AgentAttachmentInputError('committed.reference.size');
  return Object.freeze({
    kind: 'committed',
    reference: Object.freeze({ contentHash, filename, mimeType, size }),
  });
}

type DescriptorRecord = Readonly<Record<PropertyKey, PropertyDescriptor>>;

function readPlainRecord(value: unknown, field: string): DescriptorRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentAttachmentInputError(field);
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (!isPlainPrototype(prototype)) throw new AgentAttachmentInputError(field);
    return Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof AgentAttachmentInputError) throw error;
    throw new AgentAttachmentInputError(field);
  }
}

/** Accept null-prototype and cross-realm object-literal prototypes, not class instances. */
function isPlainPrototype(prototype: object | null): boolean {
  if (prototype === null || prototype === Object.prototype) return true;
  try {
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructorValue: unknown = constructor && 'value' in constructor
      ? constructor.value as unknown
      : undefined;
    return typeof constructorValue === 'function' && constructorValue.name === 'Object';
  } catch {
    return false;
  }
}

function assertExactKeys(
  descriptors: DescriptorRecord,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
  ) throw new AgentAttachmentInputError(field);
}

function readDataProperty(
  descriptors: DescriptorRecord,
  key: string,
  field: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new AgentAttachmentInputError(field);
  }
  return descriptor.value;
}

function readOptionalDataProperty(
  descriptors: DescriptorRecord,
  key: string,
  field: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(descriptors, key)) return undefined;
  return readDataProperty(descriptors, key, field);
}

function assertAttachmentText(value: unknown, maximum: number, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) throw new AgentAttachmentInputError(field);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
