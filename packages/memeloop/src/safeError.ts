import { redactSecrets } from './orchestration/security/secretRedaction.js';

export const DEFAULT_SAFE_ERROR_MESSAGE = 'Operation failed';
export const DEFAULT_SAFE_ERROR_MESSAGE_MAX_BYTES = 4096;
export const MAX_SAFE_ERROR_MESSAGE_BYTES = 65_536;

export interface SafeErrorMessageOptions {
  /** Trusted generic text used when the thrown value cannot be inspected safely. */
  fallback?: string;
  /** UTF-8 byte ceiling for the returned message. */
  maxBytes?: number;
}

/**
 * Convert a hostile thrown value into bounded, portable diagnostic text.
 *
 * Only an own data-property named `message` is inspected. Getters, prototype
 * access, `toString`, and arbitrary object traversal are deliberately avoided.
 * Secret-shaped values are redacted before the text reaches logs, storage, or
 * a wire response.
 */
export function safeErrorMessageFromUnknown(
  value: unknown,
  options: SafeErrorMessageOptions = {},
): string {
  const maxBytes = safeMaxBytes(options);
  const fallback = safeFallback(options, maxBytes);
  const candidate = ownStringDataProperty(value, 'message');
  if (candidate === undefined || candidate.length === 0) return fallback;

  // Reject before running redaction regexes so an attacker cannot force a
  // large transient allocation through an oversized thrown message.
  if (!isStrictUtf8WithinLimit(candidate, maxBytes)) return fallback;
  const redacted = redactSecrets(candidate);
  return isStrictUtf8WithinLimit(redacted, maxBytes) ? redacted : fallback;
}

/** Create an Error without retaining the hostile value as `cause`. */
export function safeErrorFromUnknown(
  value: unknown,
  options: SafeErrorMessageOptions = {},
): Error {
  return new Error(safeErrorMessageFromUnknown(value, options));
}

function safeMaxBytes(options: SafeErrorMessageOptions): number {
  const value = ownDataProperty(options, 'maxBytes');
  return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_SAFE_ERROR_MESSAGE_BYTES
    ? value
    : DEFAULT_SAFE_ERROR_MESSAGE_MAX_BYTES;
}

function safeFallback(options: SafeErrorMessageOptions, maxBytes: number): string {
  const configured = ownStringDataProperty(options, 'fallback');
  if (configured !== undefined && configured.length > 0) {
    const redacted = redactSecrets(configured);
    if (isStrictUtf8WithinLimit(redacted, maxBytes)) return redacted;
  }
  if (isStrictUtf8WithinLimit(DEFAULT_SAFE_ERROR_MESSAGE, maxBytes)) {
    return DEFAULT_SAFE_ERROR_MESSAGE;
  }
  // `maxBytes` is always positive, so this keeps the hard ceiling even when a
  // caller deliberately requests less room than the normal generic message.
  return 'E';
}

function ownStringDataProperty(value: unknown, key: string): string | undefined {
  const property = ownDataProperty(value, key);
  return typeof property === 'string' ? property : undefined;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isStrictUtf8WithinLimit(value: string, maxBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return false;
  }
  return true;
}
