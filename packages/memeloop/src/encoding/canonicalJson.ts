/** Resource bounds enforced while traversing and encoding canonical JSON. */
export interface CanonicalJsonLimits {
  /** Root is depth zero; every nested array/object member increments depth. */
  maxDepth: number;
  /** Counts every JSON value and every object key. */
  maxNodes: number;
  /** Per string/key bound checked before JSON escaping allocates an encoded copy. */
  maxStringCodeUnits: number;
  /** Per string/key UTF-8 bound. */
  maxStringBytes: number;
  /** Maximum UTF-8 bytes in the final canonical representation. */
  maxBytes: number;
}

export const DEFAULT_CANONICAL_JSON_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringCodeUnits: 1_048_576,
  maxStringBytes: 1_048_576,
  maxBytes: 1_048_576,
});

export type CanonicalJsonErrorCode =
  | 'accessor_property'
  | 'array_property'
  | 'cycle'
  | 'dangerous_key'
  | 'invalid_unicode'
  | 'invalid_limit'
  | 'invalid_number'
  | 'max_bytes'
  | 'max_depth'
  | 'max_nodes'
  | 'max_string_bytes'
  | 'max_string_code_units'
  | 'non_enumerable_property'
  | 'non_plain_object'
  | 'sparse_array'
  | 'symbol_property'
  | 'unsupported_type';

/** Stable fail-closed error surfaced by every canonical JSON entry point. */
export class CanonicalJsonError extends Error {
  public constructor(public readonly code: CanonicalJsonErrorCode, cause?: unknown) {
    super(`canonical_json_${code}`, cause === undefined ? undefined : { cause });
    this.name = 'CanonicalJsonError';
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/u;
const LIMIT_KEYS = [
  'maxDepth',
  'maxNodes',
  'maxStringCodeUnits',
  'maxStringBytes',
  'maxBytes',
] as const satisfies ReadonlyArray<keyof CanonicalJsonLimits>;
const LIMIT_KEY_SET: ReadonlySet<string> = new Set(LIMIT_KEYS);

/** Encode strict JSON with object keys sorted by UTF-16 code-unit order. */
export function canonicalJsonString(
  value: unknown,
  limits?: Partial<CanonicalJsonLimits>,
): string {
  return new CanonicalJsonEncoder(resolveLimits(limits)).encode(value);
}

/** UTF-8 bytes of {@link canonicalJsonString}. */
export function canonicalJsonBytes(
  value: unknown,
  limits?: Partial<CanonicalJsonLimits>,
): Uint8Array {
  return new TextEncoder().encode(canonicalJsonString(value, limits));
}

/**
 * Encode an unambiguous domain-separated envelope. Both the domain and payload
 * are JSON values inside `{"domain":...,"payload":...}`; no delimiter can be
 * injected to make two `(domain, payload)` pairs share bytes.
 */
export function domainSeparatedCanonicalJsonBytes(
  domain: string,
  payload: unknown,
  limits?: Partial<CanonicalJsonLimits>,
): Uint8Array {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new CanonicalJsonError('unsupported_type');
  }
  return canonicalJsonBytes({ domain, payload }, limits);
}

class CanonicalJsonEncoder {
  private readonly chunks: string[] = [];
  private readonly activeObjects = new Set<object>();
  private bytes = 0;
  private nodes = 0;

  public constructor(private readonly limits: CanonicalJsonLimits) {}

  public encode(value: unknown): string {
    this.writeValue(value, 0);
    return this.chunks.join('');
  }

  private writeValue(value: unknown, depth: number): void {
    if (depth > this.limits.maxDepth) this.fail('max_depth');
    this.consumeNode();
    if (value === null) {
      this.append('null');
      return;
    }
    switch (typeof value) {
      case 'string':
        this.writeString(value);
        return;
      case 'boolean':
        this.append(value ? 'true' : 'false');
        return;
      case 'number':
        this.writeNumber(value);
        return;
      case 'object':
        this.writeStructuredValue(value, depth);
        return;
      default:
        this.fail('unsupported_type');
    }
  }

  private writeNumber(value: number): void {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      this.fail('invalid_number');
    }
    this.append(JSON.stringify(value));
  }

  private writeString(value: string): void {
    const rawBytes = this.assertStringBounds(value);
    // JSON string encoding never uses fewer bytes than the raw valid UTF-8
    // plus its two quotes. Reject before JSON.stringify allocates an escaped
    // copy when even that lower bound cannot fit.
    if (rawBytes + 2 > this.limits.maxBytes - this.bytes) this.fail('max_bytes');
    this.append(JSON.stringify(value));
  }

  private writeStructuredValue(value: object, depth: number): void {
    this.withActiveObject(value, () => {
      let isArray: boolean;
      try {
        isArray = Array.isArray(value);
      } catch (error) {
        throw new CanonicalJsonError('non_plain_object', error);
      }
      if (isArray) this.writeArray(value as unknown[], depth);
      else this.writeObject(value, depth);
    });
  }

  private writeArray(value: unknown[], depth: number): void {
    if (this.readPrototype(value) !== Array.prototype) this.fail('non_plain_object');
    const properties = this.readProperties(value);
    const lengthProperty = properties.find(([key]) => key === 'length')?.[1];
    if (
      !lengthProperty || 'get' in lengthProperty || 'set' in lengthProperty ||
      !('value' in lengthProperty) || lengthProperty.enumerable ||
      typeof lengthProperty.value !== 'number' || !Number.isSafeInteger(lengthProperty.value) ||
      lengthProperty.value < 0
    ) this.fail('array_property');
    const length = lengthProperty.value;
    if (length > this.limits.maxNodes) this.fail('max_nodes');
    this.assertMinimumArrayBytes(length);
    const values = new Map<number, unknown>();
    for (const [key, descriptor] of properties) {
      if (key === 'length') continue;
      this.assertStringBounds(key);
      if (!ARRAY_INDEX.test(key)) this.fail('array_property');
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
        this.fail('array_property');
      }
      this.assertDataProperty(descriptor);
      values.set(index, descriptor.value);
    }
    if (values.size !== length) this.fail('sparse_array');

    this.append('[');
    for (let index = 0; index < length; index += 1) {
      if (index > 0) this.append(',');
      this.writeValue(values.get(index), depth + 1);
    }
    this.append(']');
  }

  private writeObject(value: object, depth: number): void {
    const prototype = this.readPrototype(value);
    if (prototype !== Object.prototype && prototype !== null) this.fail('non_plain_object');
    const properties = this.readProperties(value);
    const entries: Array<[key: string, value: unknown, encodedKey: string]> = [];
    let minimumBytes = 2;
    for (const [key, descriptor] of properties) {
      if (DANGEROUS_KEYS.has(key)) this.fail('dangerous_key');
      this.consumeNode();
      const rawKeyBytes = this.assertStringBounds(key);
      this.assertDataProperty(descriptor);
      const entrySyntaxBytes = entries.length === 0 ? 2 : 3;
      minimumBytes = this.addMinimumBytes(
        minimumBytes,
        rawKeyBytes + 2 + entrySyntaxBytes,
      );
      const encodedKey = JSON.stringify(key);
      // One comma after the first entry, one colon, and at least one byte for
      // the value. This prevents sorting a huge key set that cannot possibly
      // fit in the configured output bound.
      const escapedExtraBytes = utf8ByteLength(encodedKey) - (rawKeyBytes + 2);
      minimumBytes = this.addMinimumBytes(minimumBytes, escapedExtraBytes);
      entries.push([key, descriptor.value, encodedKey]);
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

    this.append('{');
    entries.forEach(([, item, encodedKey], index) => {
      if (index > 0) this.append(',');
      this.append(encodedKey);
      this.append(':');
      this.writeValue(item, depth + 1);
    });
    this.append('}');
  }

  private readPrototype(value: object): object | null {
    try {
      return Object.getPrototypeOf(value) as object | null;
    } catch (error) {
      throw new CanonicalJsonError('non_plain_object', error);
    }
  }

  private readProperties(value: object): Array<[string, PropertyDescriptor]> {
    let keys: Array<string | symbol>;
    try {
      keys = Reflect.ownKeys(value);
    } catch (error) {
      throw new CanonicalJsonError('non_plain_object', error);
    }
    if (keys.length > this.limits.maxNodes + 1) this.fail('max_nodes');
    if (keys.some(key => typeof key === 'symbol')) this.fail('symbol_property');
    return keys.map((key) => {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch (error) {
        throw new CanonicalJsonError('non_plain_object', error);
      }
      if (!descriptor) this.fail('non_plain_object');
      return [key as string, descriptor];
    });
  }

  private assertDataProperty(descriptor: PropertyDescriptor): asserts descriptor is PropertyDescriptor & {
    value: unknown;
  } {
    if ('get' in descriptor || 'set' in descriptor) this.fail('accessor_property');
    if (!descriptor.enumerable) this.fail('non_enumerable_property');
    if (!('value' in descriptor)) this.fail('accessor_property');
  }

  private withActiveObject(value: object, operation: () => void): void {
    if (this.activeObjects.has(value)) this.fail('cycle');
    this.activeObjects.add(value);
    try {
      operation();
    } finally {
      this.activeObjects.delete(value);
    }
  }

  private assertStringBounds(value: string): number {
    if (value.length > this.limits.maxStringCodeUnits) {
      this.fail('max_string_code_units');
    }
    const bytes = strictUtf8ByteLength(value, () => this.fail('invalid_unicode'));
    if (bytes > this.limits.maxStringBytes) {
      this.fail('max_string_bytes');
    }
    return bytes;
  }

  private assertMinimumArrayBytes(length: number): void {
    const remaining = this.limits.maxBytes - this.bytes;
    if (length === 0) {
      if (remaining < 2) this.fail('max_bytes');
      return;
    }
    // `[0]` is the shortest non-empty array and every additional value costs
    // at least one comma plus one value byte: 2 * length + 1.
    if (remaining < 1 || length > Math.floor((remaining - 1) / 2)) {
      this.fail('max_bytes');
    }
  }

  private addMinimumBytes(current: number, additional: number): number {
    const remaining = this.limits.maxBytes - this.bytes;
    if (current > remaining || additional > remaining - current) this.fail('max_bytes');
    return current + additional;
  }

  private consumeNode(): void {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) this.fail('max_nodes');
  }

  private append(value: string): void {
    const valueBytes = utf8ByteLength(value);
    if (valueBytes > this.limits.maxBytes - this.bytes) this.fail('max_bytes');
    this.bytes += valueBytes;
    this.chunks.push(value);
  }

  private fail(code: CanonicalJsonErrorCode): never {
    throw new CanonicalJsonError(code);
  }
}

function resolveLimits(overrides?: Partial<CanonicalJsonLimits>): CanonicalJsonLimits {
  const limits: CanonicalJsonLimits = { ...DEFAULT_CANONICAL_JSON_LIMITS };
  if (overrides === undefined) return limits;
  if (overrides === null || typeof overrides !== 'object') {
    throw new CanonicalJsonError('invalid_limit');
  }
  let prototype: object | null;
  let keys: Array<string | symbol>;
  try {
    prototype = Object.getPrototypeOf(overrides) as object | null;
    keys = Reflect.ownKeys(overrides);
  } catch (error) {
    throw new CanonicalJsonError('invalid_limit', error);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError('invalid_limit');
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !LIMIT_KEY_SET.has(key)) {
      throw new CanonicalJsonError('invalid_limit');
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(overrides, key);
    } catch (error) {
      throw new CanonicalJsonError('invalid_limit', error);
    }
    if (
      !descriptor || 'get' in descriptor || 'set' in descriptor ||
      !descriptor.enumerable || !('value' in descriptor) ||
      !Number.isSafeInteger(descriptor.value) || descriptor.value < 0
    ) {
      throw new CanonicalJsonError('invalid_limit');
    }
    limits[key as keyof CanonicalJsonLimits] = descriptor.value as number;
  }
  return limits;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function strictUtf8ByteLength(value: string, invalidUnicode: () => never): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) invalidUnicode();
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) invalidUnicode();
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalidUnicode();
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
