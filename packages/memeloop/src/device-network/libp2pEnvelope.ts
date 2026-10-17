/** Shared strict shape checks for libp2p request/response envelopes. */

export interface Libp2pRequestEnvelopeOptions {
  type: string;
  maxIdLength?: number;
  maxMethodLength?: number;
  validateMethod?: (method: string) => boolean;
  validateGrant?: (grant: unknown) => boolean;
}

export interface Libp2pResponseEnvelopeOptions {
  type: string;
  maxIdLength?: number;
}

export function isLibp2pRequestEnvelope(
  value: unknown,
  options: Libp2pRequestEnvelopeOptions,
): value is { type: string; id: string; method: string; params: unknown; grant?: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKeys(record, ['type', 'id', 'method', 'params', 'grant']) &&
    record.type === options.type &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    record.id.length <= (options.maxIdLength ?? 128) &&
    typeof record.method === 'string' &&
    record.method.length > 0 &&
    record.method.length <= (options.maxMethodLength ?? 256) &&
    options.validateMethod?.(record.method) !== false &&
    'params' in record &&
    (record.grant === undefined || options.validateGrant?.(record.grant) !== false)
  );
}

export function isLibp2pResponseEnvelope(
  value: unknown,
  options: Libp2pResponseEnvelopeOptions,
): value is {
  type: string;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string };
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.type !== options.type ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > (options.maxIdLength ?? 128) ||
    typeof record.ok !== 'boolean'
  ) return false;
  if (record.ok) {
    return 'result' in record && hasOnlyKeys(record, ['type', 'id', 'ok', 'result']);
  }
  if (
    !('error' in record) ||
    !hasOnlyKeys(record, ['type', 'id', 'ok', 'error']) ||
    record.error === null ||
    typeof record.error !== 'object' ||
    Array.isArray(record.error)
  ) return false;
  const error = record.error as Record<string, unknown>;
  return (
    hasOnlyKeys(error, ['code']) &&
    typeof error.code === 'string' &&
    /^[a-z][a-z\d_]{0,63}$/u.test(error.code)
  );
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every(key => keys.has(key));
}
