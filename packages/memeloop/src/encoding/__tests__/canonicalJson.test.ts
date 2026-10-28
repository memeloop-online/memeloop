import { describe, expect, it, vi } from 'vitest';

import { canonicalJsonBytes, CanonicalJsonError, canonicalJsonString, domainSeparatedCanonicalJsonBytes } from '../canonicalJson.js';

describe('bounded canonical JSON', () => {
  it('sorts object keys by UTF-16 code units and preserves array order', () => {
    expect(canonicalJsonString({
      z: 1,
      '\u{10000}': 2,
      '\ue000': 3,
      a: [3, 2, 1],
    })).toBe('{"a":[3,2,1],"z":1,"𐀀":2,"":3}');
    expect(canonicalJsonString(Object.assign(Object.create(null) as object, { b: true, a: null })))
      .toBe('{"a":null,"b":true}');
  });

  it('uses escaped canonical JSON for Unicode, controls, and newlines', () => {
    const value = { text: 'line1\nline2\u0000é😀' };
    const encoded = canonicalJsonString(value);

    expect(encoded).toBe(JSON.stringify(value));
    expect(new TextDecoder().decode(canonicalJsonBytes(value))).toBe(encoded);
  });

  it('rejects unpaired UTF-16 before TextEncoder replacement can cause collisions', () => {
    expect(() => canonicalJsonBytes('\ud800')).toThrow('canonical_json_invalid_unicode');
    expect(() => canonicalJsonBytes('\ud801')).toThrow('canonical_json_invalid_unicode');
    expect(() => canonicalJsonBytes('\ud800x')).toThrow('canonical_json_invalid_unicode');
    expect(() => canonicalJsonBytes('x\udc00')).toThrow('canonical_json_invalid_unicode');
    expect(() => canonicalJsonString({ '\udfff': true })).toThrow(
      'canonical_json_invalid_unicode',
    );
    expect(new TextDecoder().decode(canonicalJsonBytes('😀'))).toBe('"😀"');
  });

  it('domain-separates without delimiter or length ambiguity', () => {
    const first = domainSeparatedCanonicalJsonBytes('a\n{"payload":"b"}', 'c');
    const second = domainSeparatedCanonicalJsonBytes('a', 'b\n{"payload":"c"}');

    expect(first).not.toEqual(second);
    expect(new TextDecoder().decode(first)).toBe(
      '{"domain":"a\\n{\\"payload\\":\\"b\\"}","payload":"c"}',
    );
    expect(domainSeparatedCanonicalJsonBytes('domain-a', { value: 1 })).not.toEqual(
      domainSeparatedCanonicalJsonBytes('domain-b', { value: 1 }),
    );
    expect(() => domainSeparatedCanonicalJsonBytes('', null)).toThrow(
      'canonical_json_unsupported_type',
    );
    expect(() => domainSeparatedCanonicalJsonBytes('\ud800', null)).toThrow(
      'canonical_json_invalid_unicode',
    );
  });

  it.each([
    undefined,
    () => undefined,
    Symbol('value'),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    new Date(0),
  ])('rejects non-strict JSON value %#', (value) => {
    expect(() => canonicalJsonString(value)).toThrow(CanonicalJsonError);
  });

  it('rejects accessors, hidden and symbol properties, dangerous keys, and array extensions', () => {
    const read = vi.fn(() => 1);
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: read });
    expect(() => canonicalJsonString(getter)).toThrow('canonical_json_accessor_property');
    expect(read).not.toHaveBeenCalled();
    const hidden = Object.defineProperty({}, 'value', { enumerable: false, value: 1 });
    expect(() => canonicalJsonString(hidden)).toThrow('canonical_json_non_enumerable_property');
    expect(() => canonicalJsonString({ [Symbol('value')]: 1 })).toThrow(
      'canonical_json_symbol_property',
    );
    const dangerous = Object.create(null) as Record<string, unknown>;
    dangerous.__proto__ = 'value';
    expect(() => canonicalJsonString(dangerous)).toThrow('canonical_json_dangerous_key');
    expect(() => canonicalJsonString({ constructor: 'value' })).toThrow(
      'canonical_json_dangerous_key',
    );
    expect(() => canonicalJsonString({ prototype: 'value' })).toThrow(
      'canonical_json_dangerous_key',
    );
    const extended = [1] as unknown[] & { extra?: number };
    extended.extra = 2;
    expect(() => canonicalJsonString(extended)).toThrow('canonical_json_array_property');
    const longExtension = [1] as unknown[] & Record<string, unknown>;
    longExtension['x'.repeat(64)] = 2;
    expect(() => canonicalJsonString(longExtension, { maxStringCodeUnits: 16 })).toThrow(
      'canonical_json_max_string_code_units',
    );
  });

  it('wraps revoked and throwing proxy failures in stable canonical errors', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => canonicalJsonString(revoked.proxy)).toThrow(
      'canonical_json_non_plain_object',
    );

    const ownKeysFailure = new Proxy({}, {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(() => canonicalJsonString(ownKeysFailure)).toThrow(
      'canonical_json_non_plain_object',
    );

    const get = vi.fn(() => {
      throw new Error('value getter must not run');
    });
    expect(canonicalJsonString(new Proxy({ safe: 1 }, { get }))).toBe('{"safe":1}');
    expect(get).not.toHaveBeenCalled();
  });

  it('never evaluates limit accessors and wraps hostile limit proxies', () => {
    const read = vi.fn(() => 8);
    const accessorLimits = Object.defineProperty({}, 'maxBytes', {
      enumerable: true,
      get: read,
    });
    expect(() => canonicalJsonString(null, accessorLimits)).toThrow(
      'canonical_json_invalid_limit',
    );
    expect(read).not.toHaveBeenCalled();

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => canonicalJsonString(null, revoked.proxy)).toThrow(
      'canonical_json_invalid_limit',
    );
    expect(() => canonicalJsonString(null, { maxBytes: 4, unexpected: 1 } as never)).toThrow(
      'canonical_json_invalid_limit',
    );
  });

  it('rejects sparse arrays and cycles but allows repeated acyclic references', () => {
    expect(() => canonicalJsonString(Array(1))).toThrow('canonical_json_sparse_array');
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalJsonString(cycle)).toThrow('canonical_json_cycle');
    const shared = { value: 1 };
    expect(canonicalJsonString([shared, shared])).toBe('[{"value":1},{"value":1}]');
    const indirectArrayCycle: unknown[] = [];
    const indirectObject = { nested: indirectArrayCycle };
    indirectArrayCycle.push(indirectObject);
    expect(() => canonicalJsonString(indirectObject)).toThrow('canonical_json_cycle');
  });

  it('enforces traversal and UTF-8 output bounds during encoding', () => {
    expect(() => canonicalJsonString([[0]], { maxDepth: 1 })).toThrow(
      'canonical_json_max_depth',
    );
    expect(() => canonicalJsonString({ a: 1 }, { maxNodes: 2 })).toThrow(
      'canonical_json_max_nodes',
    );
    expect(() => canonicalJsonString('abcd', { maxStringCodeUnits: 3 })).toThrow(
      'canonical_json_max_string_code_units',
    );
    expect(() => canonicalJsonString('é', { maxStringBytes: 1 })).toThrow(
      'canonical_json_max_string_bytes',
    );
    expect(() => canonicalJsonString('😀', { maxBytes: 5 })).toThrow(
      'canonical_json_max_bytes',
    );
    expect(canonicalJsonString('😀', { maxBytes: 6 })).toBe('"😀"');
    expect(() => canonicalJsonString('😀a', { maxBytes: 6 })).toThrow(
      'canonical_json_max_bytes',
    );
    expect(canonicalJsonString('é😀', { maxStringBytes: 6 })).toBe('"é😀"');
    expect(() => canonicalJsonString('é😀a', { maxStringBytes: 6 })).toThrow(
      'canonical_json_max_string_bytes',
    );
    expect(canonicalJsonString({ a: 0 }, { maxBytes: 7 })).toBe('{"a":0}');
    expect(() => canonicalJsonString({ a: 0 }, { maxBytes: 6 })).toThrow(
      'canonical_json_max_bytes',
    );
    expect(canonicalJsonString([0], { maxBytes: 3 })).toBe('[0]');
    expect(() => canonicalJsonString([0], { maxBytes: 2 })).toThrow(
      'canonical_json_max_bytes',
    );
  });

  it('uses a linear number of primitive/key encoding operations for a large object', () => {
    const count = 10_000;
    const value: Record<string, number> = {};
    for (let index = count - 1; index >= 0; index -= 1) {
      value[`key-${index.toString().padStart(5, '0')}`] = index;
    }
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const encoded = canonicalJsonString(value, {
        maxBytes: 1_000_000,
        maxNodes: count * 2 + 1,
      });
      expect(encoded.startsWith('{"key-00000":0,"key-00001":1,')).toBe(true);
      expect(encoded.endsWith(`"key-09999":${count - 1}}`)).toBe(true);
      expect(stringify).toHaveBeenCalledTimes(count * 2);
    } finally {
      stringify.mockRestore();
    }
  });

  it('rejects an impossible large string before allocating its escaped JSON copy', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(() => canonicalJsonString('x'.repeat(64 * 1024), { maxBytes: 32 })).toThrow(
        'canonical_json_max_bytes',
      );
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
});
