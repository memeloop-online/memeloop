import type { AgentReasoningEffort } from '../agent/types.js';
import { canonicalJsonString } from '../encoding/canonicalJson.js';
import type { ILLMProvider } from '../types.js';
import type { PortableLlmJsonValue } from './request.js';

export type ProviderOwnerKind = 'builtin' | 'host' | 'plugin';

export interface ProviderRegistryOwner {
  ownerId: string;
  kind: ProviderOwnerKind;
}

/** Public provider metadata keyed by a stable providerId. Raw credentials are not representable. */
export interface ProviderConfig {
  providerId: string;
  baseUrl?: string;
  secretRef?: string;
  capabilities?: readonly string[];
  models: readonly ProviderModelRoute[];
}

export type ProviderApiMode = 'chat-completions' | 'responses';

/**
 * Provider-specific generation defaults owned by one exact model route.
 *
 * These values are request semantics, not catalog capability claims.  A
 * route's defaults are applied when no explicit agent parameter is present;
 * call-scoped provider options are merged on top by prepareModelRequest.
 */
export interface ProviderModelRequestDefaults {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly reasoningEffort?: AgentReasoningEffort;
  readonly providerOptions?: Readonly<{
    readonly [provider: string]: Readonly<{
      readonly [option: string]: PortableLlmJsonValue;
    }>;
  }>;
}

export interface ProviderModelRoute {
  modelId: string;
  wireModelId: string;
  apiMode: ProviderApiMode;
  requestDefaults?: Readonly<ProviderModelRequestDefaults>;
}

export interface RegisteredProvider {
  provider: ILLMProvider;
  config: Readonly<ProviderConfig>;
  owner: Readonly<ProviderRegistryOwner>;
}

export interface ResolvedProviderModel {
  provider: ILLMProvider;
  providerId: string;
  modelId: string;
  wireModelId: string;
  apiMode: ProviderApiMode;
  requestDefaults?: Readonly<ProviderModelRequestDefaults>;
}

export interface ProviderRegistration {
  readonly providerId: string;
  readonly ownerId: string;
  dispose(): boolean;
}

/** Narrow runtime dependency; callers cannot mutate a host-owned registry. */
export interface ProviderRegistryResolver {
  get(providerId: string): ILLMProvider | undefined;
  getConfig(providerId: string): Readonly<ProviderConfig> | undefined;
  list(): string[];
  listConfigs(): Readonly<ProviderConfig>[];
  resolve(providerId: string, modelId: string): ResolvedProviderModel;
}

interface RegistryEntry extends RegisteredProvider {
  token: symbol;
}

/** Maximum encoded size of a canonical provider ID. */
export const PROVIDER_ID_MAX_UTF8_BYTES = 512;
/** Maximum encoded size of a logical or wire model ID. */
export const PROVIDER_MODEL_ID_MAX_UTF8_BYTES = 512;
/** Maximum number of exact logical-to-wire routes in one provider account. */
export const MAX_PROVIDER_MODEL_ROUTES = 10_000;
/** Maximum encoded size of a provider base URL. */
export const PROVIDER_BASE_URL_MAX_UTF8_BYTES = 8_192;

const MAX_PROVIDER_IDENTIFIER_BYTES = PROVIDER_ID_MAX_UTF8_BYTES;
const MAX_CAPABILITIES = 256;
const MAX_PROVIDER_OPTION_PROVIDERS = 64;
const MAX_PROVIDER_OPTIONS_PER_PROVIDER = 256;
export const PROVIDER_OPTION_JSON_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringCodeUnits: 64 * 1024,
  maxStringBytes: 64 * 1024,
  maxBytes: 256 * 1024,
});
const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const textEncoder = new TextEncoder();

/**
 * Test the canonical provider-id grammar shared by definitions, registries,
 * and host adapters. Provider IDs begin with a Unicode letter or number;
 * `.`, `_`, and `-` are permitted after the first code point. Unicode IDs are
 * preserved without host-only transliteration; human-facing display names
 * belong exclusively to the provider catalog metadata.
 */
export function isProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROVIDER_ID_MAX_UTF8_BYTES &&
    textEncoder.encode(value).byteLength <= PROVIDER_ID_MAX_UTF8_BYTES &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

/** Test the exact upstream API mode carried by a canonical model route. */
export function isProviderApiMode(value: unknown): value is ProviderApiMode {
  return value === 'chat-completions' || value === 'responses';
}

/** Assert the public provider-id contract with stable registry diagnostics. */
export function assertProviderId(
  value: unknown,
  field = 'providerId',
): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 ||
    value.length > PROVIDER_ID_MAX_UTF8_BYTES ||
    textEncoder.encode(value).byteLength > PROVIDER_ID_MAX_UTF8_BYTES
  ) {
    throw new TypeError(
      `${field} is invalid or exceeds ${PROVIDER_ID_MAX_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new TypeError(`${field} must begin with a letter or number and contain only letters, numbers, '.', '_', or '-'`);
  }
}

/**
 * Validate a provider endpoint without normalizing away the persisted spelling.
 * HTTPS is mandatory except for explicit HTTP loopback development endpoints.
 */
export function normalizeProviderBaseUrl(
  value: unknown,
  field = 'provider baseUrl',
): string {
  const baseUrl = requireBoundedString(
    value,
    field,
    PROVIDER_BASE_URL_MAX_UTF8_BYTES,
    false,
  );
  if (baseUrl !== baseUrl.trim()) {
    throw new TypeError(`${field} must not contain surrounding whitespace`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new TypeError(`${field} must be an absolute URL`, { cause: error });
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError(`${field} must not contain credentials`);
  }
  const loopback = parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && loopback)
  ) {
    throw new TypeError(`${field} must use HTTPS except for loopback HTTP development`);
  }
  return baseUrl;
}

export interface NormalizeProviderModelRoutesOptions {
  /** Provider accounts may be empty before discovery; executable registries may not. */
  allowEmpty?: boolean;
}

/** Strict canonical validator shared by persisted accounts and the executable registry. */
export function normalizeProviderModelRoutes(
  value: unknown,
  options: NormalizeProviderModelRoutesOptions = {},
): readonly ProviderModelRoute[] {
  if (!isStrictArray(value)) {
    throw new TypeError('provider models must be a bounded array');
  }
  if (
    value.length > MAX_PROVIDER_MODEL_ROUTES ||
    !options.allowEmpty && value.length === 0
  ) {
    throw new TypeError(
      options.allowEmpty
        ? 'provider models must be a bounded array'
        : 'provider models must be a non-empty bounded array',
    );
  }
  const normalized: Readonly<ProviderModelRoute>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const route = readStrictModelRoute(descriptor!.value);
    const requestDefaults = route.requestDefaults === undefined
      ? undefined
      : normalizeProviderModelRequestDefaults(route.requestDefaults);
    normalized.push(Object.freeze({
      modelId: requireModelRouteIdentifier(route.modelId, 'provider modelId'),
      wireModelId: requireModelRouteIdentifier(
        route.wireModelId,
        'provider wireModelId',
      ),
      apiMode: route.apiMode,
      ...(requestDefaults === undefined ? {} : { requestDefaults }),
    }));
  }
  if (new Set(normalized.map(route => route.modelId)).size !== normalized.length) {
    throw new TypeError('provider modelIds must be unique');
  }
  return Object.freeze(
    [...normalized].sort((left, right) => compareCodeUnits(left.modelId, right.modelId)),
  );
}

/** Validate and deeply freeze one route-owned request-default object. */
export function normalizeProviderModelRequestDefaults(
  value: unknown,
): Readonly<ProviderModelRequestDefaults> {
  const record = readStrictRecord(value, 'provider model requestDefaults');
  const allowed = new Set([
    'maxOutputTokens',
    'temperature',
    'topP',
    'reasoningEffort',
    'providerOptions',
  ]);
  if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('provider model requestDefaults contains unknown fields');
  }

  const maxOutputTokens = readOptionalMaxOutputTokens(record.maxOutputTokens);
  const temperature = readOptionalTemperature(record.temperature);
  const topP = readOptionalTopP(record.topP);
  const reasoningEffort = readOptionalReasoningEffort(record.reasoningEffort);
  const providerOptions = record.providerOptions === undefined
    ? undefined
    : normalizeProviderOptions(record.providerOptions);

  return Object.freeze({
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  });
}

export class ProviderRegistry implements ProviderRegistryResolver {
  private readonly providers = new Map<string, RegistryEntry>();

  register(
    owner: ProviderRegistryOwner,
    provider: ILLMProvider,
    config: Omit<ProviderConfig, 'providerId'>,
  ): ProviderRegistration {
    const normalizedOwner = normalizeOwner(owner);
    const providerId = requireProviderId(provider.name, 'providerId');
    assertConfigKeys(config);
    if (this.providers.has(providerId)) {
      const current = this.providers.get(providerId)!;
      throw new Error(
        `Provider registration collision: '${providerId}' is owned by '${current.owner.ownerId}'`,
      );
    }
    const token = Symbol(providerId);
    const entry: RegistryEntry = {
      token,
      provider,
      owner: normalizedOwner,
      config: normalizeConfig(providerId, config),
    };
    this.providers.set(providerId, entry);
    let disposed = false;
    return Object.freeze({
      providerId,
      ownerId: normalizedOwner.ownerId,
      dispose: (): boolean => {
        if (disposed) return false;
        disposed = true;
        const current = this.providers.get(providerId);
        if (current?.token !== token) return false;
        this.providers.delete(providerId);
        return true;
      },
    });
  }

  get(providerId: string): ILLMProvider | undefined {
    return this.providers.get(providerId)?.provider;
  }

  getConfig(providerId: string): Readonly<ProviderConfig> | undefined {
    const config = this.providers.get(providerId)?.config;
    return config === undefined ? undefined : cloneConfig(config);
  }

  list(): string[] {
    return [...this.providers.keys()].sort(compareCodeUnits);
  }

  listConfigs(): Readonly<ProviderConfig>[] {
    return this.list().map(providerId => cloneConfig(this.providers.get(providerId)!.config));
  }

  resolve(providerId: string, modelId: string): ResolvedProviderModel {
    const providerName = requireProviderId(providerId, 'providerId');
    const modelName = requireModelRouteIdentifier(modelId, 'modelId');
    const registered = this.providers.get(providerName);
    if (!registered) throw new Error(`Provider not found: ${providerName}`);
    const matches = registered.config.models.filter(route => route.modelId === modelName);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Model not found: ${providerName}/${modelName}`
          : `Ambiguous model route: ${providerName}/${modelName}`,
      );
    }
    const route = matches[0];
    return {
      provider: registered.provider,
      providerId: providerName,
      modelId: modelName,
      wireModelId: route.wireModelId,
      apiMode: route.apiMode,
      ...(route.requestDefaults === undefined
        ? {}
        : { requestDefaults: route.requestDefaults }),
    };
  }
}

function normalizeOwner(owner: ProviderRegistryOwner): Readonly<ProviderRegistryOwner> {
  if (
    owner === null || typeof owner !== 'object' || Array.isArray(owner) ||
    Object.keys(owner).some(key => key !== 'ownerId' && key !== 'kind') ||
    !['builtin', 'host', 'plugin'].includes(owner.kind)
  ) throw new TypeError('invalid provider registry owner');
  return Object.freeze({
    ownerId: requireIdentifier(owner.ownerId, 'provider ownerId', true),
    kind: owner.kind,
  });
}

function assertConfigKeys(config: Omit<ProviderConfig, 'providerId'>): void {
  if (
    config === null || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).some(key => !['baseUrl', 'secretRef', 'capabilities', 'models'].includes(key))
  ) throw new TypeError('invalid provider config');
}

function normalizeConfig(
  providerId: string,
  config: Omit<ProviderConfig, 'providerId'>,
): Readonly<ProviderConfig> {
  const baseUrl = config.baseUrl === undefined
    ? undefined
    : normalizeProviderBaseUrl(config.baseUrl);
  const secretReference = config.secretRef === undefined
    ? undefined
    : requireIdentifier(config.secretRef, 'provider secretRef', true);
  const capabilities = config.capabilities === undefined
    ? undefined
    : normalizeCapabilities(config.capabilities);
  const models = normalizeProviderModelRoutes(config.models);
  return Object.freeze({
    providerId,
    models,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(secretReference === undefined ? {} : { secretRef: secretReference }),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

function normalizeCapabilities(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new TypeError('invalid provider capabilities');
  }
  const normalized = value.map(capability => requireIdentifier(capability, 'provider capability', true));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('provider capabilities must be unique');
  }
  return Object.freeze([...normalized].sort(compareCodeUnits));
}

function cloneConfig(config: Readonly<ProviderConfig>): Readonly<ProviderConfig> {
  return Object.freeze({
    ...config,
    ...(config.capabilities === undefined
      ? {}
      : { capabilities: Object.freeze([...config.capabilities]) }),
    models: Object.freeze(config.models.map(model =>
      Object.freeze({
        modelId: model.modelId,
        wireModelId: model.wireModelId,
        apiMode: model.apiMode,
        ...(model.requestDefaults === undefined
          ? {}
          : { requestDefaults: cloneProviderModelRequestDefaults(model.requestDefaults) }),
      })
    )),
  });
}

function cloneProviderModelRequestDefaults(
  defaults: Readonly<ProviderModelRequestDefaults>,
): Readonly<ProviderModelRequestDefaults> {
  return Object.freeze({
    ...(defaults.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: defaults.maxOutputTokens }),
    ...(defaults.temperature === undefined ? {} : { temperature: defaults.temperature }),
    ...(defaults.topP === undefined ? {} : { topP: defaults.topP }),
    ...(defaults.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: defaults.reasoningEffort }),
    ...(defaults.providerOptions === undefined
      ? {}
      : { providerOptions: cloneProviderOptions(defaults.providerOptions) }),
  });
}

function cloneProviderOptions(
  value: ProviderModelRequestDefaults['providerOptions'],
): ProviderModelRequestDefaults['providerOptions'] {
  if (value === undefined) return undefined;
  const result: {
    [provider: string]: Readonly<{
      readonly [option: string]: PortableLlmJsonValue;
    }>;
  } = {};
  for (const provider of Object.keys(value)) {
    const options = value[provider];
    if (options === undefined) continue;
    const copied: { [option: string]: PortableLlmJsonValue } = {};
    for (const option of Object.keys(options)) copied[option] = freezeJson(options[option]);
    result[provider] = Object.freeze(copied);
  }
  return Object.freeze(result);
}

function requireIdentifier(value: unknown, field: string, allowSlash: boolean): string {
  const result = requireBoundedString(value, field, MAX_PROVIDER_IDENTIFIER_BYTES, false);
  if (containsAsciiControlOrSpace(result) || !allowSlash && result.includes('/')) {
    throw new TypeError(`${field} contains invalid characters`);
  }
  return result;
}

function requireProviderId(value: unknown, field: string): string {
  assertProviderId(value, field);
  return value;
}

function requireModelRouteIdentifier(value: unknown, field: string): string {
  const result = requireBoundedString(
    value,
    field,
    PROVIDER_MODEL_ID_MAX_UTF8_BYTES,
    false,
  );
  if (result !== result.trim() || containsAsciiControlOrSpace(result)) {
    throw new TypeError(`${field} contains invalid characters`);
  }
  return result;
}

function readStrictModelRoute(value: unknown): {
  modelId: unknown;
  wireModelId: unknown;
  apiMode: ProviderModelRoute['apiMode'];
  requestDefaults: unknown;
} {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('invalid provider model route');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < 3 || keys.length > 4 ||
    keys.some(key =>
      typeof key !== 'string' ||
      !['modelId', 'wireModelId', 'apiMode', 'requestDefaults'].includes(key)
    )
  ) {
    throw new TypeError('provider model route contains unknown fields');
  }
  const record = value as Record<string, unknown>;
  const modelId = readEnumerableDataProperty(record, 'modelId');
  const wireModelId = readEnumerableDataProperty(record, 'wireModelId');
  const apiMode = readEnumerableDataProperty(record, 'apiMode');
  const requestDefaults = Object.hasOwn(record, 'requestDefaults')
    ? readEnumerableDataProperty(record, 'requestDefaults')
    : undefined;
  if (!isProviderApiMode(apiMode)) {
    throw new TypeError('provider model route has an invalid apiMode');
  }
  return { modelId, wireModelId, apiMode, requestDefaults };
}

function readStrictRecord(value: unknown, field: string): Record<string, unknown> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError(`${field} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) {
    throw new TypeError(`${field} contains symbol fields`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${field} contains an accessor or hidden field`);
    }
  }
  return value as Record<string, unknown>;
}

function readOptionalMaxOutputTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 ||
    value > 1_000_000
  ) throw new TypeError('provider model requestDefaults.maxOutputTokens is invalid');
  return value;
}

function readOptionalTemperature(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new TypeError('provider model requestDefaults.temperature is invalid');
  }
  return value;
}

function readOptionalTopP(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('provider model requestDefaults.topP is invalid');
  }
  return value;
}

function readOptionalReasoningEffort(value: unknown): AgentReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (value !== 'minimal' && value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new TypeError('provider model requestDefaults.reasoningEffort is invalid');
  }
  return value;
}

function normalizeProviderOptions(
  value: unknown,
): Readonly<NonNullable<ProviderModelRequestDefaults['providerOptions']>> {
  let encoded: string;
  try {
    encoded = canonicalJsonString(value, PROVIDER_OPTION_JSON_LIMITS);
  } catch (error) {
    throw new TypeError('provider model requestDefaults.providerOptions is invalid', { cause: error });
  }
  const detached: unknown = JSON.parse(encoded);
  const record = readStrictRecord(detached, 'provider model requestDefaults.providerOptions');
  const providerKeys = Reflect.ownKeys(record);
  if (providerKeys.length > MAX_PROVIDER_OPTION_PROVIDERS) {
    throw new TypeError('provider model requestDefaults.providerOptions is too large');
  }
  const result: {
    [provider: string]: Readonly<{ [option: string]: PortableLlmJsonValue }>;
  } = {};
  for (const provider of providerKeys) {
    if (typeof provider !== 'string' || !isProviderOptionIdentifier(provider)) {
      throw new TypeError('provider model requestDefaults.providerOptions has an invalid provider');
    }
    const options = readStrictRecord(record[provider], `provider model requestDefaults.providerOptions.${provider}`);
    if (Reflect.ownKeys(options).length > MAX_PROVIDER_OPTIONS_PER_PROVIDER) {
      throw new TypeError('provider model requestDefaults.providerOptions has too many options');
    }
    const copied: { [option: string]: PortableLlmJsonValue } = {};
    for (const option of Reflect.ownKeys(options)) {
      if (typeof option !== 'string' || !isProviderOptionIdentifier(option)) {
        throw new TypeError('provider model requestDefaults.providerOptions has an invalid option');
      }
      copied[option] = freezeJson(options[option] as PortableLlmJsonValue);
    }
    result[provider] = Object.freeze(copied);
  }
  return Object.freeze(result);
}

function isProviderOptionIdentifier(value: string): boolean {
  return value.length > 0 && textEncoder.encode(value).byteLength <= PROVIDER_ID_MAX_UTF8_BYTES &&
    !containsAsciiControlOrSpace(value);
}

function freezeJson(value: PortableLlmJsonValue): PortableLlmJsonValue {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) freezeJson(item);
    } else {
      for (const key of Object.keys(value)) freezeJson(value[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function readEnumerableDataProperty(
  value: Record<string, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined || !descriptor.enumerable ||
    !('value' in descriptor)
  ) {
    throw new TypeError('invalid provider model route');
  }
  return descriptor.value;
}

function isStrictArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !keys.includes(key) || descriptor === undefined ||
      !descriptor.enumerable || !('value' in descriptor)
    ) return false;
  }
  return true;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
    textEncoder.encode(value).byteLength > maximumBytes
  ) throw new TypeError(`${field} is invalid or exceeds ${maximumBytes} UTF-8 bytes`);
  return value;
}

function containsAsciiControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
