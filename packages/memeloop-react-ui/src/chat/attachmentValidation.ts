import type { MemeLoopSelectedAttachmentBatch, WikiTiddlerAttachment } from './coreTypes.js';

export type MemeLoopAttachmentValidationErrorCode =
  | 'attachment-count-exceeded'
  | 'attachment-duplicate'
  | 'attachment-file-too-large'
  | 'attachment-invalid-file-size'
  | 'attachment-file-type-not-allowed'
  | 'attachment-invalid-tiddler-title'
  | 'attachment-invalid-workspace-name'
  | 'attachment-drop-payload-too-large'
  | 'attachment-atomic-commit-required'
  | 'attachment-invalid-policy';

export class MemeLoopAttachmentValidationError extends Error {
  public readonly name = 'MemeLoopAttachmentValidationError';

  public constructor(
    public readonly code: MemeLoopAttachmentValidationErrorCode,
    public readonly details: Readonly<Record<string, string | number>> = {},
  ) {
    super(code);
  }
}

export interface MemeLoopAttachmentPolicy {
  maxSelectedCount?: number;
  maxFileBytes?: number;
  allowedFileTypes?: readonly string[];
  maxWorkspaceNameBytes?: number;
  maxTiddlerTitleBytes?: number;
  maxDropPayloadBytes?: number;
}

export interface MemeLoopFileAttachment {
  size: number;
  type: string;
}

export const DEFAULT_MAX_SELECTED_ATTACHMENTS = 16;
export const DEFAULT_MAX_ATTACHMENT_FILE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_WORKSPACE_NAME_BYTES = 1_024;
export const DEFAULT_MAX_TIDDLER_TITLE_BYTES = 4_096;
export const DEFAULT_MAX_DROP_PAYLOAD_BYTES = 256 * 1024;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function readTiddlerIdentity(attachment: WikiTiddlerAttachment): WikiTiddlerAttachment {
  try {
    if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new TypeError('attachment identity must be an object');
    }
    const prototype = Object.getPrototypeOf(attachment) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('attachment identity must be plain data');
    const keys = Reflect.ownKeys(attachment);
    if (
      keys.length !== 2 ||
      keys.some(key => typeof key !== 'string' || (key !== 'workspaceName' && key !== 'tiddlerTitle'))
    ) throw new TypeError('attachment identity fields are invalid');
    const descriptors = Object.getOwnPropertyDescriptors(attachment);
    const workspace = descriptors.workspaceName;
    const title = descriptors.tiddlerTitle;
    if (
      !workspace?.enumerable || !('value' in workspace) || typeof workspace.value !== 'string' ||
      !title?.enumerable || !('value' in title) || typeof title.value !== 'string'
    ) throw new TypeError('attachment identity must contain string data');
    return { workspaceName: workspace.value, tiddlerTitle: title.value };
  } catch (error) {
    if (error instanceof MemeLoopAttachmentValidationError) throw error;
    throw new MemeLoopAttachmentValidationError('attachment-invalid-tiddler-title');
  }
}

export function resolveAttachmentPolicyLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new MemeLoopAttachmentValidationError('attachment-invalid-policy');
  }
  return resolved;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7F ? 1 : codePoint <= 0x7FF ? 2 : codePoint <= 0xFFFF ? 3 : 4;
  }
  return bytes;
}

export function validateWikiTiddlerAttachment(
  attachment: WikiTiddlerAttachment,
  selected: readonly WikiTiddlerAttachment[],
  hasSelectedFile: boolean,
  policy: MemeLoopAttachmentPolicy = {},
): WikiTiddlerAttachment {
  const maximum = resolveAttachmentPolicyLimit(policy.maxSelectedCount, DEFAULT_MAX_SELECTED_ATTACHMENTS);
  if (selected.length + (hasSelectedFile ? 1 : 0) >= maximum) {
    throw new MemeLoopAttachmentValidationError('attachment-count-exceeded', { maximum });
  }
  const identity = readTiddlerIdentity(attachment);
  const workspaceName = identity.workspaceName.trim();
  const tiddlerTitle = identity.tiddlerTitle.trim();
  const maximumWorkspaceNameBytes = resolveAttachmentPolicyLimit(policy.maxWorkspaceNameBytes, DEFAULT_MAX_WORKSPACE_NAME_BYTES);
  const maximumTiddlerTitleBytes = resolveAttachmentPolicyLimit(policy.maxTiddlerTitleBytes, DEFAULT_MAX_TIDDLER_TITLE_BYTES);
  if (!workspaceName || hasControlCharacters(workspaceName) || utf8Length(workspaceName) > maximumWorkspaceNameBytes) {
    throw new MemeLoopAttachmentValidationError('attachment-invalid-workspace-name');
  }
  if (!tiddlerTitle || hasControlCharacters(tiddlerTitle) || utf8Length(tiddlerTitle) > maximumTiddlerTitleBytes) {
    throw new MemeLoopAttachmentValidationError('attachment-invalid-tiddler-title');
  }
  if (
    selected.some(item => {
      const selectedIdentity = readTiddlerIdentity(item);
      return selectedIdentity.workspaceName.trim() === workspaceName && selectedIdentity.tiddlerTitle.trim() === tiddlerTitle;
    })
  ) {
    throw new MemeLoopAttachmentValidationError('attachment-duplicate');
  }
  // Returning the canonical value makes normalization explicit to every
  // caller; no validated-but-unnormalized object may enter the committed batch.
  return Object.freeze({ workspaceName, tiddlerTitle });
}

/**
 * Validate, clone and deeply freeze one host-owned selection before an atomic
 * commit. The returned array/tiddler identities never retain mutable resolver
 * objects; only the platform file handle remains opaque to this core helper.
 */
export function validateMemeLoopAttachmentSelection<TFile extends MemeLoopFileAttachment>(
  batch: MemeLoopSelectedAttachmentBatch<TFile>,
  policy: MemeLoopAttachmentPolicy = {},
): MemeLoopSelectedAttachmentBatch<TFile> {
  const attachments: readonly WikiTiddlerAttachment[] = batch.wikiTiddlers;
  const maximum = resolveAttachmentPolicyLimit(policy.maxSelectedCount, DEFAULT_MAX_SELECTED_ATTACHMENTS);
  if (!isArrayValue(attachments) || attachments.length + (batch.file ? 1 : 0) > maximum) {
    throw new MemeLoopAttachmentValidationError('attachment-count-exceeded', { maximum });
  }
  if (batch.file) validateWebFileAttachment(batch.file, attachments.length, policy);
  const canonical: WikiTiddlerAttachment[] = [];
  for (const attachment of attachments) {
    canonical.push(validateWikiTiddlerAttachment(attachment, canonical, !!batch.file, policy));
  }
  return Object.freeze({
    ...(batch.file ? { file: batch.file } : {}),
    wikiTiddlers: Object.freeze(canonical),
  });
}

export function validateWebFileAttachment(
  file: MemeLoopFileAttachment,
  selectedTiddlerCount: number,
  policy: MemeLoopAttachmentPolicy = {},
): void {
  const maximum = resolveAttachmentPolicyLimit(policy.maxSelectedCount, DEFAULT_MAX_SELECTED_ATTACHMENTS);
  if (selectedTiddlerCount >= maximum) {
    throw new MemeLoopAttachmentValidationError('attachment-count-exceeded', { maximum });
  }
  const maximumBytes = resolveAttachmentPolicyLimit(policy.maxFileBytes, DEFAULT_MAX_ATTACHMENT_FILE_BYTES);
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new MemeLoopAttachmentValidationError('attachment-invalid-file-size');
  }
  if (file.size > maximumBytes) {
    throw new MemeLoopAttachmentValidationError('attachment-file-too-large', { maximumBytes, size: file.size });
  }
  const allowed = policy.allowedFileTypes;
  if (allowed?.length && !allowed.some(type => type.endsWith('/*') ? file.type.startsWith(type.slice(0, -1)) : file.type === type)) {
    throw new MemeLoopAttachmentValidationError('attachment-file-type-not-allowed', { fileType: file.type });
  }
}
