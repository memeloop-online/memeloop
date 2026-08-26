import type { ILLMProvider } from '../types.js';

export type ProviderOwnerKind = 'builtin' | 'host' | 'plugin';

export interface ProviderRegistryOwner {
  ownerId: string;
  kind: ProviderOwnerKind;
}

/** Public provider metadata. Raw credentials are deliberately not representable. */
export interface ProviderConfig {
  name: string;
  baseUrl?: string;
  secretRef?: string;
  capabilities?: readonly string[];
  models: readonly ProviderModelRoute[];
}

export interface ProviderModelRoute {
  modelId: string;
  wireModelId: string;
  apiMode: 'chat-completions' | 'responses';
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
  apiMode: 'chat-completions' | 'responses';
}

export interface ProviderRegistration {
  readonly name: string;
  readonly ownerId: string;
  dispose(): boolean;
}

/** Narrow runtime dependency; callers cannot mutate a host-owned registry. */
export interface ProviderRegistryResolver {
  get(name: string): ILLMProvider | undefined;
  getConfig(name: string): Readonly<ProviderConfig> | undefined;
  list(): string[];
  listConfigs(): Readonly<ProviderConfig>[];
  resolve(providerId: string, modelId: string): ResolvedProviderModel;
}

interface RegistryEntry extends RegisteredProvider {
  token: symbol;
}

const MAX_PROVIDER_IDENTIFIER_BYTES = 512;
const MAX_PROVIDER_URL_BYTES = 8_192;
const MAX_CAPABILITIES = 256;
const textEncoder = new TextEncoder();

export class ProviderRegistry implements ProviderRegistryResolver {
  private readonly providers = new Map<string, RegistryEntry>();

  register(
    owner: ProviderRegistryOwner,
    provider: ILLMProvider,
    config: Omit<ProviderConfig, 'name'>,
  ): ProviderRegistration {
    const normalizedOwner = normalizeOwner(owner);
    const name = requireProviderId(provider.name, 'provider name');
    assertConfigKeys(config);
    if (this.providers.has(name)) {
      const current = this.providers.get(name)!;
      throw new Error(
        `Provider registration collision: '${name}' is owned by '${current.owner.ownerId}'`,
      );
    }
    const token = Symbol(name);
    const entry: RegistryEntry = {
      token,
      provider,
      owner: normalizedOwner,
      config: normalizeConfig(name, config),
    };
    this.providers.set(name, entry);
    let disposed = false;
    return Object.freeze({
      name,
      ownerId: normalizedOwner.ownerId,
      dispose: (): boolean => {
        if (disposed) return false;
        disposed = true;
        const current = this.providers.get(name);
        if (current?.token !== token) return false;
        this.providers.delete(name);
        return true;
      },
    });
  }

  get(name: string): ILLMProvider | undefined {
    return this.providers.get(name)?.provider;
  }

  getConfig(name: string): Readonly<ProviderConfig> | undefined {
    const config = this.providers.get(name)?.config;
    return config === undefined ? undefined : cloneConfig(config);
  }

  list(): string[] {
    return [...this.providers.keys()].sort(compareCodeUnits);
  }

  listConfigs(): Readonly<ProviderConfig>[] {
    return this.list().map(name => cloneConfig(this.providers.get(name)!.config));
  }

  resolve(providerId: string, modelId: string): ResolvedProviderModel {
    const providerName = requireProviderId(providerId, 'providerId');
    const modelName = requireIdentifier(modelId, 'modelId', true);
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

function assertConfigKeys(config: Omit<ProviderConfig, 'name'>): void {
  if (
    config === null || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).some(key => !['baseUrl', 'secretRef', 'capabilities', 'models'].includes(key))
  ) throw new TypeError('invalid provider config');
}

function normalizeConfig(
  name: string,
  config: Omit<ProviderConfig, 'name'>,
): Readonly<ProviderConfig> {
  const baseUrl = config.baseUrl === undefined
    ? undefined
    : requireBoundedString(config.baseUrl, 'provider baseUrl', MAX_PROVIDER_URL_BYTES, false);
  if (baseUrl !== undefined) {
    try {
      const parsed = new URL(baseUrl);
      if (
        parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' &&
        parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1'
      ) {
        throw new TypeError('provider baseUrl must use https except for loopback development');
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('provider baseUrl')) throw error;
      throw new TypeError('provider baseUrl must be an absolute URL', { cause: error });
    }
  }
  const secretReference = config.secretRef === undefined
    ? undefined
    : requireIdentifier(config.secretRef, 'provider secretRef', true);
  const capabilities = config.capabilities === undefined
    ? undefined
    : normalizeCapabilities(config.capabilities);
  const models = normalizeModelRoutes(config.models);
  return Object.freeze({
    name,
    models,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(secretReference === undefined ? {} : { secretRef: secretReference }),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

function normalizeModelRoutes(value: readonly ProviderModelRoute[]): readonly ProviderModelRoute[] {
  const declaredRoutes: readonly ProviderModelRoute[] = value;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CAPABILITIES) {
    throw new TypeError('provider models must be a non-empty bounded array');
  }
  const normalized = declaredRoutes.map(route => {
    if (
      route === null || typeof route !== 'object' || Array.isArray(route) ||
      Object.keys(route).some(key => !['modelId', 'wireModelId', 'apiMode'].includes(key)) ||
      (route.apiMode !== 'chat-completions' && route.apiMode !== 'responses')
    ) throw new TypeError('invalid provider model route');
    return Object.freeze({
      modelId: requireIdentifier(route.modelId, 'provider modelId', true),
      wireModelId: requireIdentifier(route.wireModelId, 'provider wireModelId', true),
      apiMode: route.apiMode,
    });
  });
  if (new Set(normalized.map(route => route.modelId)).size !== normalized.length) {
    throw new TypeError('provider modelIds must be unique');
  }
  return Object.freeze([...normalized].sort((left, right) => compareCodeUnits(left.modelId, right.modelId)));
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
    models: Object.freeze(config.models.map(model => Object.freeze({ ...model }))),
  });
}

function requireIdentifier(value: unknown, field: string, allowSlash: boolean): string {
  const result = requireBoundedString(value, field, MAX_PROVIDER_IDENTIFIER_BYTES, false);
  if (containsAsciiControlOrSpace(result) || !allowSlash && result.includes('/')) {
    throw new TypeError(`${field} contains invalid characters`);
  }
  return result;
}

function requireProviderId(value: unknown, field: string): string {
  const result = requireIdentifier(value, field, false);
  if (!/^[a-z][a-z0-9._-]*$/.test(result)) {
    throw new TypeError(`${field} must use canonical lowercase provider-id grammar`);
  }
  return result;
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
