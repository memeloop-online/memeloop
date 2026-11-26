/**
 * Strict, portable RFC 4648 codecs used at RPC trust boundaries.
 *
 * The implementation deliberately does not delegate to Buffer/atob/btoa:
 * those APIs differ in how much malformed input they silently accept across
 * runtimes.  Both decoders also re-encode the result, so non-zero trailing
 * bits and alternate spellings are rejected as non-canonical.
 */

export type Base64Variant = 'standard' | 'url';

export interface Base64DecodeOptions {
  variant?: Base64Variant;
  /** Standard base64 is padded; URL-safe base64 is unpadded. */
  padding?: 'required' | 'optional';
  allowEmpty?: boolean;
  maxBytes?: number;
}

const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeBase64(bytes: Uint8Array, variant: Base64Variant = 'standard'): string {
  const alphabet = variant === 'url' ? URL_ALPHABET : STANDARD_ALPHABET;
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const first = bytes[offset] ?? 0;
    const second = remaining > 1 ? bytes[offset + 1] ?? 0 : 0;
    const third = remaining > 2 ? bytes[offset + 2] ?? 0 : 0;
    const bits = (first << 16) | (second << 8) | third;
    encoded += alphabet[(bits >>> 18) & 63];
    encoded += alphabet[(bits >>> 12) & 63];
    encoded += remaining > 1 ? alphabet[(bits >>> 6) & 63] : '=';
    encoded += remaining > 2 ? alphabet[bits & 63] : '=';
  }
  return variant === 'url' ? encoded.replace(/=+$/u, '') : encoded;
}

export function decodeBase64(value: string, options: Base64DecodeOptions = {}): Uint8Array {
  const variant = options.variant ?? 'standard';
  const padding = options.padding ?? (variant === 'standard' ? 'required' : 'optional');
  const allowEmpty = options.allowEmpty ?? true;
  if (typeof value !== 'string') throw new TypeError('invalid base64');
  if (!allowEmpty && value.length === 0) throw new TypeError('invalid base64');

  const alphabet = variant === 'url' ? URL_ALPHABET : STANDARD_ALPHABET;
  if (variant === 'url' && value.includes('=')) throw new TypeError('invalid base64');
  if (padding === 'required' && value.length % 4 !== 0) throw new TypeError('invalid base64');
  if (padding === 'optional' && value.length % 4 === 1) throw new TypeError('invalid base64');
  if (variant === 'standard' && padding === 'required') {
    if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)) {
      throw new TypeError('invalid base64');
    }
  } else if (!new RegExp(`^[${variant === 'url' ? 'A-Za-z\\d_-' : 'A-Za-z\\d+/'}]*$`, 'u').test(value)) {
    throw new TypeError('invalid base64');
  }

  const normalized = variant === 'url'
    ? value.padEnd(Math.ceil(value.length / 4) * 4, '=')
    : value;
  const paddingBytes = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const byteLength = (normalized.length / 4) * 3 - paddingBytes;
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || byteLength > options.maxBytes)
  ) {
    throw new RangeError('base64 exceeds maximum byte length');
  }
  const result = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (let offset = 0; offset < normalized.length; offset += 4) {
    const a = alphabet.indexOf(normalized[offset] ?? '');
    const b = alphabet.indexOf(normalized[offset + 1] ?? '');
    const c = normalized[offset + 2] === '=' ? 0 : alphabet.indexOf(normalized[offset + 2] ?? '');
    const d = normalized[offset + 3] === '=' ? 0 : alphabet.indexOf(normalized[offset + 3] ?? '');
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new TypeError('invalid base64');
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (writeOffset < result.length) result[writeOffset++] = (bits >>> 16) & 0xFF;
    if (writeOffset < result.length) result[writeOffset++] = (bits >>> 8) & 0xFF;
    if (writeOffset < result.length) result[writeOffset++] = bits & 0xFF;
  }
  if (encodeBase64(result, variant) !== value) throw new TypeError('invalid base64');
  return result;
}
