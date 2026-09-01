import { type ModelAssignments, normalizeModelAssignments } from '../agent/types.js';
import type { ModelCatalogModel, ModelCatalogProvider } from '../modelCatalog/types.js';
import { assertProviderId, normalizeProviderBaseUrl, normalizeProviderModelRoutes, type ProviderModelRoute } from './providerRegistry.js';

/**
 * Host-neutral configuration for one provider account.
 *
 * Credentials are deliberately represented only by an opaque `secretRef`.
 * `providerType` selects a runtime implementation while `providerId` remains
 * the stable persisted/routing identity. `catalogProvider.name` is the sole
 * human-facing provider display name in this contract.
 */
export interface ProviderAccountConfig {
  readonly providerId: string;
  readonly providerType: string;
  readonly baseUrl?: string;
  readonly secretRef?: string;
  readonly enabled?: boolean;
  readonly models: readonly ProviderModelRoute[];
  /** Exact upstream catalog metadata; routes above remain authoritative. */
  readonly catalogProvider?: ModelCatalogProvider;
}

/** Canonical persisted provider accounts and the host's model assignments. */
export interface ProviderAccountSettings {
  readonly accounts: readonly ProviderAccountConfig[];
  readonly modelAssignments: ModelAssignments;
}

const MAX_SECRET_REF_UTF8_BYTES = 1_024;
const MAX_PROVIDER_ACCOUNTS = 512;
const MAX_CATALOG_MODELS_PER_PROVIDER = 10_000;
const MAX_CATALOG_ENVIRONMENT_NAMES = 128;
const MAX_CATALOG_MODALITIES = 8;
const MAX_CATALOG_ID_UTF8_BYTES = 1_024;
const MAX_CATALOG_NAME_UTF8_BYTES = 4_096;
const MAX_CATALOG_METADATA_UTF8_BYTES = 8_192;
const textEncoder = new TextEncoder();

const ACCOUNT_FIELDS = new Set([
  'providerId',
  'providerType',
  'baseUrl',
  'secretRef',
  'enabled',
  'models',
  'catalogProvider',
]);
const SETTINGS_FIELDS = new Set(['accounts', 'modelAssignments']);
const CATALOG_PROVIDER_FIELDS = new Set(['id', 'name', 'npm', 'api', 'doc', 'env', 'models']);
const CATALOG_MODEL_FIELDS = new Set([
  'id',
  'name',
  'attachment',
  'reasoning',
  'toolCall',
  'structuredOutput',
  'temperature',
  'releaseDate',
  'lastUpdated',
  'status',
  'modalities',
  'limit',
]);
const CATALOG_MODALITIES_FIELDS = new Set(['input', 'output']);
const CATALOG_LIMIT_FIELDS = new Set(['context', 'input', 'output']);
const CATALOG_MODEL_STATUSES = new Set(['alpha', 'beta', 'deprecated']);
const CATALOG_MODALITY_VALUES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

/**
 * Validate, detach, deterministically order, and deeply freeze provider data.
 *
 * The input is treated as untrusted persisted/plugin data. Accessors, symbols,
 * sparse arrays, non-plain prototypes, and unknown fields are rejected before
 * any input property is read, preventing schema validation from invoking host
 * code.
 */
export function normalizeProviderAccountConfig(
  input: unknown,
): Readonly<ProviderAccountConfig> {
  assertDataOnlyGraph(input, 'provider account');
  const account = requirePlainRecord(input, 'provider account');
  assertExactKeys(account, ACCOUNT_FIELDS, 'provider account');

  assertProviderId(account.providerId, 'providerId');
  assertProviderId(account.providerType, 'providerType');
  const providerId = account.providerId;
  const providerType = account.providerType;
  const baseUrl = account.baseUrl === undefined
    ? undefined
    : normalizeProviderBaseUrl(account.baseUrl, 'baseUrl');
  const secretReference = account.secretRef === undefined
    ? undefined
    : requireIdentifier(
      account.secretRef,
      'secretRef',
      MAX_SECRET_REF_UTF8_BYTES,
    );
  if (account.enabled !== undefined && typeof account.enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean');
  }

  const models = normalizeProviderModelRoutes(account.models, { allowEmpty: true });
  const catalogProvider = account.catalogProvider === undefined
    ? undefined
    : normalizeCatalogProvider(account.catalogProvider, providerId);

  return Object.freeze({
    providerId,
    providerType,
    models,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(secretReference === undefined ? {} : { secretRef: secretReference }),
    ...(account.enabled === undefined ? {} : { enabled: account.enabled }),
    ...(catalogProvider === undefined ? {} : { catalogProvider }),
  });
}

/** Validate, detach, and deeply freeze the aggregate provider settings graph. */
export function normalizeProviderAccountSettings(
  input: unknown,
): Readonly<ProviderAccountSettings> {
  assertDataOnlyGraph(input, 'provider account settings');
  const settings = requirePlainRecord(input, 'provider account settings');
  assertExactKeys(settings, SETTINGS_FIELDS, 'provider account settings');
  if (
    !Array.isArray(settings.accounts) ||
    settings.accounts.length > MAX_PROVIDER_ACCOUNTS
  ) {
    throw new TypeError('accounts must be a bounded array');
  }

  const accounts = settings.accounts.map(normalizeProviderAccountConfig);
  const providerIds = accounts.map(account => account.providerId);
  if (new Set(providerIds).size !== providerIds.length) {
    throw new TypeError('providerId values must be unique within provider account settings');
  }

  const modelAssignments = freezeModelAssignments(
    normalizeModelAssignments(settings.modelAssignments),
  );
  for (const [purpose, selection] of Object.entries(modelAssignments)) {
    const account = accounts.find(candidate => candidate.providerId === selection.providerId);
    if (account === undefined) {
      throw new TypeError(`modelAssignments.${purpose} references an unknown providerId`);
    }
    if (!account.models.some(route => route.modelId === selection.modelId)) {
      throw new TypeError(`modelAssignments.${purpose} references an unknown modelId`);
    }
  }
  return Object.freeze({
    accounts: Object.freeze(accounts),
    modelAssignments,
  });
}

function freezeModelAssignments(
  assignments: ModelAssignments,
): Readonly<ModelAssignments> {
  const result: ModelAssignments = {};
  for (
    const [key, selection] of Object.entries(assignments) as [
      keyof ModelAssignments,
      NonNullable<ModelAssignments[keyof ModelAssignments]>,
    ][]
  ) {
    result[key] = Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(selection.parameters === undefined
        ? {}
        : { parameters: Object.freeze({ ...selection.parameters }) }),
    });
  }
  return Object.freeze(result);
}

function normalizeCatalogProvider(
  value: unknown,
  providerId: string,
): ModelCatalogProvider {
  const provider = requirePlainRecord(value, 'catalogProvider');
  assertExactKeys(provider, CATALOG_PROVIDER_FIELDS, 'catalogProvider');
  const id = requireCatalogString(provider.id, 'catalogProvider.id', MAX_CATALOG_ID_UTF8_BYTES);
  if (id !== providerId) {
    throw new TypeError('catalogProvider.id must equal providerId');
  }
  const name = requireCatalogString(provider.name, 'catalogProvider.name', MAX_CATALOG_NAME_UTF8_BYTES);
  const environment = normalizeCatalogStringArray(
    provider.env,
    'catalogProvider.env',
    MAX_CATALOG_ENVIRONMENT_NAMES,
    value => /^[A-Za-z0-9_]+$/u.test(value),
  );
  if (
    !Array.isArray(provider.models) ||
    provider.models.length > MAX_CATALOG_MODELS_PER_PROVIDER
  ) {
    throw new TypeError('catalogProvider.models must be a bounded array');
  }
  const models = provider.models.map(normalizeCatalogModel);
  const modelIds = models.map(model => model.id);
  if (new Set(modelIds).size !== modelIds.length) {
    throw new TypeError('catalogProvider model ids must be unique');
  }
  return Object.freeze({
    id,
    name,
    ...(provider.npm === undefined
      ? {}
      : { npm: requireCatalogString(provider.npm, 'catalogProvider.npm', MAX_CATALOG_METADATA_UTF8_BYTES) }),
    ...(provider.api === undefined
      ? {}
      : { api: normalizeCatalogHttpUrl(provider.api, 'catalogProvider.api') }),
    ...(provider.doc === undefined
      ? {}
      : { doc: normalizeCatalogHttpUrl(provider.doc, 'catalogProvider.doc') }),
    env: Object.freeze(environment),
    models: Object.freeze(models),
  });
}

function normalizeCatalogModel(value: unknown): Readonly<ModelCatalogModel> {
  const model = requirePlainRecord(value, 'catalogProvider model');
  assertExactKeys(model, CATALOG_MODEL_FIELDS, 'catalogProvider model');
  const attachment = requireBoolean(model.attachment, 'catalogProvider model.attachment');
  const reasoning = requireBoolean(model.reasoning, 'catalogProvider model.reasoning');
  const toolCall = requireBoolean(model.toolCall, 'catalogProvider model.toolCall');
  for (const field of ['structuredOutput', 'temperature'] as const) {
    if (model[field] !== undefined && typeof model[field] !== 'boolean') {
      throw new TypeError(`catalogProvider model.${field} must be a boolean`);
    }
  }
  const structuredOutput = model.structuredOutput === undefined
    ? undefined
    : requireBoolean(model.structuredOutput, 'catalogProvider model.structuredOutput');
  const temperature = model.temperature === undefined
    ? undefined
    : requireBoolean(model.temperature, 'catalogProvider model.temperature');
  const status = model.status === undefined
    ? undefined
    : requireCatalogString(model.status, 'catalogProvider model.status', 32);
  if (status !== undefined && !CATALOG_MODEL_STATUSES.has(status)) {
    throw new TypeError('catalogProvider model.status is invalid');
  }
  const modalities = model.modalities === undefined
    ? undefined
    : normalizeCatalogModalities(model.modalities);
  const limit = model.limit === undefined
    ? undefined
    : normalizeCatalogLimit(model.limit);
  return Object.freeze({
    id: requireCatalogString(model.id, 'catalogProvider model.id', MAX_CATALOG_ID_UTF8_BYTES),
    name: requireCatalogString(model.name, 'catalogProvider model.name', MAX_CATALOG_NAME_UTF8_BYTES),
    attachment,
    reasoning,
    toolCall,
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(model.releaseDate === undefined
      ? {}
      : { releaseDate: normalizeCatalogDate(model.releaseDate, 'catalogProvider model.releaseDate') }),
    ...(model.lastUpdated === undefined
      ? {}
      : { lastUpdated: normalizeCatalogDate(model.lastUpdated, 'catalogProvider model.lastUpdated') }),
    ...(status === undefined ? {} : { status: status as ModelCatalogModel['status'] }),
    ...(modalities === undefined ? {} : { modalities }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function normalizeCatalogModalities(
  value: unknown,
): NonNullable<ModelCatalogModel['modalities']> {
  const modalities = requirePlainRecord(value, 'catalogProvider model.modalities');
  assertExactKeys(modalities, CATALOG_MODALITIES_FIELDS, 'catalogProvider model.modalities');
  return Object.freeze({
    input: Object.freeze(normalizeCatalogStringArray(
      modalities.input,
      'catalogProvider model.modalities.input',
      MAX_CATALOG_MODALITIES,
      value => CATALOG_MODALITY_VALUES.has(value),
    )),
    output: Object.freeze(normalizeCatalogStringArray(
      modalities.output,
      'catalogProvider model.modalities.output',
      MAX_CATALOG_MODALITIES,
      value => CATALOG_MODALITY_VALUES.has(value),
    )),
  });
}

function normalizeCatalogLimit(
  value: unknown,
): NonNullable<ModelCatalogModel['limit']> {
  const limit = requirePlainRecord(value, 'catalogProvider model.limit');
  assertExactKeys(limit, CATALOG_LIMIT_FIELDS, 'catalogProvider model.limit');
  const result: NonNullable<ModelCatalogModel['limit']> = {};
  for (const field of ['context', 'input', 'output'] as const) {
    const candidate = limit[field];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new TypeError(`catalogProvider model.limit.${field} must be a non-negative safe integer`);
    }
    result[field] = candidate as number;
  }
  return Object.freeze(result);
}

function normalizeCatalogStringArray(
  value: unknown,
  field: string,
  maximumItems: number,
  predicate: (value: string) => boolean = () => true,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  const result = value.map(item => requireCatalogString(item, field, MAX_CATALOG_METADATA_UTF8_BYTES));
  if (result.some(item => !predicate(item)) || new Set(result).size !== result.length) {
    throw new TypeError(`${field} contains invalid or duplicate values`);
  }
  return result;
}

function requireCatalogString(
  value: unknown,
  field: string,
  maximumBytes: number,
): string {
  const result = requireBoundedString(value, field, maximumBytes);
  if (hasAsciiControl(result)) throw new TypeError(`${field} contains control characters`);
  return result;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function normalizeCatalogDate(value: unknown, field: string): string {
  const result = requireCatalogString(value, field, 32);
  if (
    !/^\d{4}-\d{2}(?:-\d{2})?$/u.test(result) ||
    Number.isNaN(Date.parse(`${result}${result.length === 7 ? '-01' : ''}T00:00:00.000Z`))
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return result;
}

function normalizeCatalogHttpUrl(value: unknown, field: string): string {
  const candidate = requireCatalogString(value, field, MAX_CATALOG_METADATA_UTF8_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`${field} must be an HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError(`${field} must be an HTTP(S) URL without credentials`);
  }
  return candidate;
}

function requireIdentifier(
  value: unknown,
  field: string,
  maximumBytes: number,
): string {
  const result = requireBoundedString(value, field, maximumBytes);
  if (containsAsciiControlOrSpace(result)) {
    throw new TypeError(`${field} contains invalid characters`);
  }
  return result;
}

function requireBoundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    textEncoder.encode(value).byteLength > maximumBytes
  ) {
    throw new TypeError(`${field} is invalid or exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function containsAsciiControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function requirePlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError(`${label} contains unknown fields`);
  }
}

/** Assert a finite JSON-like data graph without invoking accessors. */
function assertDataOnlyGraph(value: unknown, label: string): void {
  const visited = new WeakSet();
  const active = new WeakSet();
  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return;
    if (active.has(current)) throw new TypeError(`${label} must not be cyclic`);
    if (visited.has(current)) return;
    const isArray = Array.isArray(current);
    if (
      isArray
        ? Object.getPrototypeOf(current) !== Array.prototype
        : Object.getPrototypeOf(current) !== Object.prototype
    ) {
      throw new TypeError(`${label} contains an exotic object`);
    }
    active.add(current);
    visited.add(current);
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key === 'symbol')) {
      throw new TypeError(`${label} contains symbol fields`);
    }
    if (isArray) {
      const array = current as unknown[];
      if (keys.length !== array.length + 1 || !keys.includes('length')) {
        throw new TypeError(`${label} contains a sparse or decorated array`);
      }
      for (let index = 0; index < array.length; index += 1) {
        if (!keys.includes(String(index))) {
          throw new TypeError(`${label} contains a sparse or decorated array`);
        }
      }
    }
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        descriptor === undefined || !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(`${label} contains an accessor or hidden field`);
      }
      visit(descriptor.value);
    }
    active.delete(current);
  };
  visit(value);
}
