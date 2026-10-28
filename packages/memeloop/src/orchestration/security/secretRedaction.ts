/**
 * Secret redaction for logs, status, checkpoints, and crash diagnostics.
 *
 * Hosts must run any value through `redactSecrets` before it crosses into
 * persistent or observable surfaces. Redaction covers both secret-shaped keys
 * (apiKey, authorization, ...) and secret-shaped values (provider key formats,
 * model access handles). Redaction is best-effort defense in depth — the
 * primary guarantee comes from never passing secrets to untrusted contexts in
 * the first place.
 */

export interface SecretRedactionOptions {
  /** Extra key-name patterns treated as secret. */
  additionalKeyPatterns?: RegExp[];
  /** Extra value patterns treated as secret. */
  additionalValuePatterns?: RegExp[];
  /** Replacement text (default `[REDACTED]`). */
  replacement?: string;
}

const SECRET_KEY_PATTERN =
  /api[-_]?key|secret|passwd|password|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|private[-_]?key|client[-_]?secret|credential|bearer/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  // OpenAI-style keys.
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  // Anthropic-style keys.
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub personal access tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Model access handles (mlh1.<payload>.<signature>).
  /\bmlh1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

// Authorization headers keep their scheme prefix when redacted.
const BEARER_VALUE_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

const DEFAULT_REPLACEMENT = '[REDACTED]';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function freshPatterns(patterns: RegExp[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern.source, pattern.flags));
}

function redactString(value: string, valuePatterns: RegExp[], replacement: string): string {
  let result = value;
  for (const pattern of valuePatterns) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(BEARER_VALUE_PATTERN, `$1${replacement}`);
}

function keyIsSecret(key: string, keyPatterns: RegExp[]): boolean {
  return keyPatterns.some((pattern) => pattern.test(key));
}

/**
 * Deep-clone `value` with secrets masked. Secret-shaped keys are replaced
 * wholesale; strings are scanned for secret-shaped values. Handles Map/Set
 * via their entries; class instances are traversed as plain objects.
 */
export function redactSecrets<T>(value: T, options: SecretRedactionOptions = {}): T {
  const replacement = options.replacement ?? DEFAULT_REPLACEMENT;
  const keyPatterns = [SECRET_KEY_PATTERN, ...(options.additionalKeyPatterns ?? [])];
  const valuePatterns = [...freshPatterns(SECRET_VALUE_PATTERNS), ...(options.additionalValuePatterns ?? [])];

  function walk(input: unknown, keyHint?: string): unknown {
    if (typeof input === 'string') {
      if (keyHint !== undefined && keyIsSecret(keyHint, keyPatterns)) {
        return replacement;
      }
      return redactString(input, valuePatterns, replacement);
    }
    if (Array.isArray(input)) {
      return input.map((item) => walk(item));
    }
    if (input instanceof Map) {
      return new Map(Array.from(input.entries(), ([k, v]) => [k, walk(v, typeof k === 'string' ? k : undefined)]));
    }
    if (input instanceof Set) {
      return new Set(Array.from(input.values(), (item) => walk(item)));
    }
    if (isPlainObject(input)) {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) {
        output[key] = keyIsSecret(key, keyPatterns) ? replacement : walk(item, key);
      }
      return output;
    }
    return input;
  }

  return walk(value) as T;
}

/**
 * True when the value contains a secret-shaped key or value. Useful as a
 * final assertion before persisting worker-visible artifacts.
 */
export function containsSecrets(value: unknown, options: SecretRedactionOptions = {}): boolean {
  const keyPatterns = [SECRET_KEY_PATTERN, ...(options.additionalKeyPatterns ?? [])];
  const valuePatterns = [...freshPatterns(SECRET_VALUE_PATTERNS), BEARER_VALUE_PATTERN, ...(options.additionalValuePatterns ?? [])];

  function walk(input: unknown, keyHint?: string): boolean {
    if (typeof input === 'string') {
      if (keyHint !== undefined && keyIsSecret(keyHint, keyPatterns)) return true;
      return valuePatterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(input);
      });
    }
    if (Array.isArray(input)) {
      return input.some((item) => walk(item));
    }
    if (input instanceof Map) {
      return Array.from(input.entries()).some(([k, v]) => walk(v, typeof k === 'string' ? k : undefined));
    }
    if (input instanceof Set) {
      return Array.from(input.values()).some((item) => walk(item));
    }
    if (isPlainObject(input)) {
      return Object.entries(input).some(([key, item]) => keyIsSecret(key, keyPatterns) || walk(item, key));
    }
    return false;
  }

  return walk(value);
}
