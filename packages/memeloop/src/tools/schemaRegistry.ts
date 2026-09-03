import { toJSONSchema as zod4ToJsonSchema } from 'zod';

import { PORTABLE_LLM_REQUEST_LIMITS, type PortableLlmJsonValue } from '../llm/request.js';

export interface ToolSchemaMetadata {
  displayName: string;
  description: string;
}

/**
 * Instance-local parameter-schema catalog. Each runtime owns its registrations
 * so plugin disposal cannot mutate another runtime's schema namespace.
 */
export class ToolSchemaRegistry {
  private readonly toolSchemas = new Map<string, unknown>();
  private readonly toolMetadata = new Map<string, ToolSchemaMetadata>();
  private readonly owners = new Map<string, symbol>();

  registerToolParameterSchema(
    toolId: string,
    schema: unknown,
    metadata?: ToolSchemaMetadata,
  ): void {
    this.toolSchemas.set(toolId, schema);
    if (metadata) {
      this.toolMetadata.set(toolId, metadata);
    } else {
      this.toolMetadata.delete(toolId);
    }
    // An unscoped host write supersedes any previous scoped owner. A stale
    // plugin disposer must never remove the replacement.
    this.owners.delete(toolId);
  }

  registerOwnedToolParameterSchema(
    toolId: string,
    schema: unknown,
    metadata?: ToolSchemaMetadata,
  ): () => boolean {
    if (this.toolSchemas.has(toolId)) {
      throw new Error(`Tool schema conflicts with an existing tool: ${toolId}`);
    }
    const owner = Symbol(toolId);
    this.toolSchemas.set(toolId, schema);
    if (metadata) this.toolMetadata.set(toolId, metadata);
    this.owners.set(toolId, owner);
    return () => {
      if (this.owners.get(toolId) !== owner) return false;
      this.owners.delete(toolId);
      this.toolMetadata.delete(toolId);
      return this.toolSchemas.delete(toolId);
    };
  }

  unregisterToolParameterSchema(toolId: string): boolean {
    this.owners.delete(toolId);
    this.toolMetadata.delete(toolId);
    return this.toolSchemas.delete(toolId);
  }

  getToolParameterSchema(toolId: string): unknown {
    return this.toolSchemas.get(toolId);
  }

  getToolMetadata(toolId: string): ToolSchemaMetadata | undefined {
    return this.toolMetadata.get(toolId);
  }

  clear(): void {
    this.toolSchemas.clear();
    this.toolMetadata.clear();
    this.owners.clear();
  }

  /** Snapshot public schema data for an isolated runtime catalog. */
  fork(): ToolSchemaRegistry {
    const clone = new ToolSchemaRegistry();
    for (const [toolId, schema] of this.toolSchemas) {
      clone.registerToolParameterSchema(toolId, schema, this.toolMetadata.get(toolId));
    }
    return clone;
  }
}

export interface OwnedToolSchemaRegistry {
  registerOwnedToolParameterSchema(
    toolId: string,
    schema: unknown,
    metadata?: ToolSchemaMetadata,
  ): () => boolean;
}

interface SchemaNormalizationState {
  readonly active: WeakSet<object>;
  readonly ignoreNonEnumerableMetadata: boolean;
  nodes: number;
  rawBytes: number;
}

const DANGEROUS_SCHEMA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const textEncoder = new TextEncoder();

/**
 * Copy JSON Schema data across JS realms without retaining foreign prototypes.
 *
 * `structuredClone` is not a sufficient realm boundary in every RN/Jest VM.
 * This walker reads data descriptors only, rejects prototype-pollution keys and
 * non-JSON values, and applies the portable request limits before allocating a
 * Core-owned plain-data tree. The request validator remains the final contract.
 */
function normalizePortableToolSchema(
  value: unknown,
  options: { ignoreNonEnumerableMetadata?: boolean } = {},
): Record<string, PortableLlmJsonValue> {
  const state: SchemaNormalizationState = {
    active: new WeakSet(),
    ignoreNonEnumerableMetadata: options.ignoreNonEnumerableMetadata === true,
    nodes: 0,
    rawBytes: 0,
  };
  const normalized = normalizePortableSchemaValue(value, state, 0);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new TypeError('Tool parameter JSON Schema must be an object');
  }
  const serialized = JSON.stringify(normalized);
  if (textEncoder.encode(serialized).byteLength > PORTABLE_LLM_REQUEST_LIMITS.schemaBytes) {
    throw new TypeError('Tool parameter JSON Schema exceeds portable schema limits');
  }
  return normalized;
}

function normalizePortableSchemaValue(
  value: unknown,
  state: SchemaNormalizationState,
  depth: number,
): PortableLlmJsonValue {
  state.nodes += 1;
  if (
    state.nodes > PORTABLE_LLM_REQUEST_LIMITS.jsonNodes ||
    depth > PORTABLE_LLM_REQUEST_LIMITS.jsonDepth
  ) {
    throw new TypeError('Tool parameter JSON Schema exceeds portable structure limits');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Tool parameter JSON Schema contains a non-JSON number');
    }
    return value;
  }
  if (typeof value === 'string') {
    consumeSchemaBytes(state, value);
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError('Tool parameter JSON Schema contains a non-JSON value');
  }
  if (state.active.has(value)) {
    throw new TypeError('Tool parameter JSON Schema contains a cycle');
  }
  state.active.add(value);
  try {
    return Array.isArray(value)
      ? normalizePortableSchemaArray(value, state, depth)
      : normalizePortableSchemaRecord(value, state, depth);
  } finally {
    state.active.delete(value);
  }
}

function normalizePortableSchemaArray(
  value: unknown[],
  state: SchemaNormalizationState,
  depth: number,
): PortableLlmJsonValue[] {
  assertPlainArrayPrototype(value);
  if (value.length > PORTABLE_LLM_REQUEST_LIMITS.jsonArrayItems) {
    throw new TypeError('Tool parameter JSON Schema array exceeds portable limits');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    throw new TypeError('Tool parameter JSON Schema arrays must be dense plain data');
  }
  const result: PortableLlmJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isEnumerableDataDescriptor(descriptor)) {
      throw new TypeError('Tool parameter JSON Schema arrays must contain data properties');
    }
    result.push(normalizePortableSchemaValue(descriptor.value, state, depth + 1));
  }
  return result;
}

function normalizePortableSchemaRecord(
  value: object,
  state: SchemaNormalizationState,
  depth: number,
): Record<string, PortableLlmJsonValue> {
  assertPlainRecordPrototype(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > PORTABLE_LLM_REQUEST_LIMITS.jsonObjectKeys + 16 ||
    keys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError('Tool parameter JSON Schema object exceeds portable limits');
  }
  const result: Record<string, PortableLlmJsonValue> = {};
  let dataPropertyCount = 0;
  for (const key of keys as string[]) {
    if (DANGEROUS_SCHEMA_KEYS.has(key)) {
      throw new TypeError('Tool parameter JSON Schema contains a dangerous key');
    }
    consumeSchemaBytes(state, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      state.ignoreNonEnumerableMetadata &&
      descriptor !== undefined &&
      descriptor.enumerable === false &&
      'value' in descriptor
    ) {
      continue;
    }
    if (!isEnumerableDataDescriptor(descriptor)) {
      throw new TypeError('Tool parameter JSON Schema objects must contain data properties');
    }
    dataPropertyCount += 1;
    if (dataPropertyCount > PORTABLE_LLM_REQUEST_LIMITS.jsonObjectKeys) {
      throw new TypeError('Tool parameter JSON Schema object exceeds portable limits');
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: normalizePortableSchemaValue(descriptor.value, state, depth + 1),
    });
  }
  return result;
}

function assertPlainRecordPrototype(value: object): void {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null || prototype === Object.prototype) return;
  if (Object.getPrototypeOf(prototype) !== null || !hasNativeConstructor(prototype, 'Object')) {
    throw new TypeError('Tool parameter JSON Schema must contain plain objects');
  }
}

function assertPlainArrayPrototype(value: unknown[]): void {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === Array.prototype) return;
  const objectPrototype = prototype === null ? null : (Object.getPrototypeOf(prototype) as object | null);
  if (
    prototype === null ||
    objectPrototype === null ||
    Object.getPrototypeOf(objectPrototype) !== null ||
    !hasNativeConstructor(prototype, 'Array') ||
    !hasNativeConstructor(objectPrototype, 'Object')
  ) {
    throw new TypeError('Tool parameter JSON Schema must contain plain arrays');
  }
}

function hasNativeConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    return false;
  }
  try {
    return (
      Function.prototype.toString.call(descriptor.value) === `function ${name}() { [native code] }`
    );
  } catch {
    return false;
  }
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    'value' in descriptor &&
    !('get' in descriptor) &&
    !('set' in descriptor)
  );
}

function consumeSchemaBytes(state: SchemaNormalizationState, value: string): void {
  const bytes = textEncoder.encode(value).byteLength;
  if (bytes > PORTABLE_LLM_REQUEST_LIMITS.jsonStringBytes) {
    throw new TypeError('Tool parameter JSON Schema string exceeds portable limits');
  }
  state.rawBytes += bytes;
  if (state.rawBytes > PORTABLE_LLM_REQUEST_LIMITS.schemaBytes) {
    throw new TypeError('Tool parameter JSON Schema exceeds portable schema limits');
  }
}

/**
 * Convert a current Zod 4 schema or an already portable JSON Schema without
 * silently widening a registered tool to an unconstrained object.
 */
export function toolSchemaToJsonSchema(value: unknown): Record<string, unknown> {
  // Zod 4.4 exposes `toJSONSchema` as an own data method while later Zod 4
  // patches expose it through an accessor.  Use the package-owned converter
  // for both local and foreign Zod 4 objects, identified through the read-only
  // `_zod.version` data record; this avoids invoking arbitrary host accessors.
  if (isZod4Schema(value)) {
    return normalizePortableToolSchema(Reflect.apply(zod4ToJsonSchema, undefined, [value]), {
      ignoreNonEnumerableMetadata: true,
    });
  }
  const nativeMethod = findDataMethod(value, 'toJSONSchema');
  if (nativeMethod) {
    return normalizePortableToolSchema(Reflect.apply(nativeMethod, value, []), {
      ignoreNonEnumerableMetadata: true,
    });
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['type', 'properties', '$ref', 'oneOf', 'anyOf'].some((key) => hasOwnDataProperty(value, key))
  ) {
    return normalizePortableToolSchema(value);
  }

  throw new TypeError('Tool parameter schema must be a Zod 4 schema or a portable JSON Schema');
}

function isZod4Schema(value: unknown): value is object {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  try {
    const internalsDescriptor = Object.getOwnPropertyDescriptor(value, '_zod');
    const internals = descriptorValue(internalsDescriptor);
    if (internals === null || typeof internals !== 'object') return false;
    const version = descriptorValue(Object.getOwnPropertyDescriptor(internals, 'version'));
    if (version === null || typeof version !== 'object') return false;
    return descriptorValue(Object.getOwnPropertyDescriptor(version, 'major')) === 4;
  } catch {
    throw new TypeError('Tool parameter schema type lookup failed');
  }
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): unknown {
  if (!descriptor || !('value' in descriptor)) return undefined;
  return (descriptor as { value: unknown }).value;
}

function findDataMethod(
  value: unknown,
  key: string,
): ((...arguments_: unknown[]) => unknown) | undefined {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return undefined;
  }
  let candidate: object | null = value;
  for (let depth = 0; candidate !== null && depth <= 32; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    } catch {
      throw new TypeError('Tool parameter schema method lookup failed');
    }
    if (descriptor) {
      if (!('value' in descriptor)) {
        throw new TypeError('Tool parameter schema methods must be data properties');
      }
      if (descriptor.value === undefined) return undefined;
      if (typeof descriptor.value !== 'function') {
        throw new TypeError('Tool parameter schema method must be callable');
      }
      return descriptor.value as (...arguments_: unknown[]) => unknown;
    }
    try {
      candidate = Object.getPrototypeOf(candidate) as object | null;
    } catch {
      throw new TypeError('Tool parameter schema prototype lookup failed');
    }
  }
  if (candidate !== null) {
    throw new TypeError('Tool parameter schema prototype chain exceeds limits');
  }
  return undefined;
}

function hasOwnDataProperty(value: unknown, key: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError('Tool parameter schema property lookup failed');
  }
  if (!descriptor) return false;
  if (!isEnumerableDataDescriptor(descriptor)) {
    throw new TypeError('Tool parameter schema fields must be enumerable data properties');
  }
  return true;
}
