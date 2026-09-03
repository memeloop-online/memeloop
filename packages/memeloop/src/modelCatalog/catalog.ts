import {
  type FetchModelCatalogOptions,
  MODEL_CATALOG_SCHEMA_VERSION,
  MODEL_CATALOG_SOURCE_URL,
  type ModelCatalog,
  type ModelCatalogModel,
  type ModelCatalogProvider,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_MODEL_STATUS = new Set(['alpha', 'beta', 'deprecated']);
const ALLOWED_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);
const ALLOWED_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const REASONING_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high'] as const;
const MAX_PROVIDERS = 512;
const MAX_MODELS_PER_PROVIDER = 10_000;
const MAX_TOTAL_MODELS = 50_000;
const MAX_ENV_PER_PROVIDER = 128;
const MAX_MODALITIES = 8;
const MAX_REASONING_EFFORTS = 4;
const MAX_ID_BYTES = 1_024;
const MAX_NAME_BYTES = 4_096;
const MAX_METADATA_BYTES = 8_192;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const textEncoder = new TextEncoder();

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Model catalog request aborted');
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (completion: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      completion();
    };
    const abort = (): void => {
      finish(() => {
        reject(abortReason(signal));
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      value => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error('Model catalog request failed'));
        });
      },
    );
  });
}

function createRequestSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(
    () => {
      controller.abort(new Error('Model catalog request timed out'));
    },
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error('Model catalog response exceeds the size limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const declaredLength = contentLength === null ? 0 : Number(contentLength);
  const initialCapacity = Number.isSafeInteger(declaredLength) && declaredLength > 0
    ? Math.min(declaredLength, maxBytes)
    : Math.min(64 * 1024, maxBytes);
  let buffer = new Uint8Array(Math.max(1, initialCapacity));
  let totalBytes = 0;
  let cancelled = false;
  let cancellationError: unknown;
  const cancelReader = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    try {
      void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
    } catch (error: unknown) {
      cancellationError = error;
    }
  };
  const abort = (): void => {
    cancelReader(signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader('Model catalog response exceeds the size limit');
        throw new Error(
          'Model catalog response exceeds the size limit',
          cancellationError === undefined ? undefined : { cause: cancellationError },
        );
      }
      if (totalBytes > buffer.byteLength) {
        let nextCapacity = buffer.byteLength;
        while (nextCapacity < totalBytes) {
          nextCapacity = Math.min(maxBytes, Math.max(nextCapacity + 1, nextCapacity * 2));
        }
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(buffer);
        buffer = expanded;
      }
      buffer.set(value, totalBytes - value.byteLength);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      reader.releaseLock();
    } catch {
      // A signal-raced read can remain pending in a non-conforming stream.
      cancelReader('Model catalog reader released after cancellation');
    }
  }
  return buffer.slice(0, totalBytes);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function sha256Hex(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SHA-256 is required to version an untagged model catalog');
  }
  const result = await raceWithSignal(
    globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
    signal,
  );
  return [...new Uint8Array(result)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item): item is string => typeof item === 'string' && item.trim() !== ''),
    ),
  ].sort();
}

function normalizeReasoningEfforts(
  value: unknown,
): ModelCatalogModel['reasoningEfforts'] {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized = [
    ...new Set(
      value.filter(
        (item): item is NonNullable<ModelCatalogModel['reasoningEfforts']>[number] => typeof item === 'string' && ALLOWED_REASONING_EFFORTS.has(item),
      ),
    ),
  ].sort(compareReasoningEfforts);
  return normalized.length === 0 ? undefined : Object.freeze(normalized);
}

function normalizeModel(fallbackId: string, value: unknown): ModelCatalogModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value.id) ?? fallbackId;
  if (id.trim() === '') return undefined;
  const modalities = isRecord(value.modalities)
    ? {
      input: stringArray(value.modalities.input),
      output: stringArray(value.modalities.output),
    }
    : undefined;
  const limitRecord = isRecord(value.limit) ? value.limit : undefined;
  const context = optionalNonNegativeNumber(limitRecord?.context);
  const input = optionalNonNegativeNumber(limitRecord?.input);
  const output = optionalNonNegativeNumber(limitRecord?.output);
  const status = typeof value.status === 'string' && ALLOWED_MODEL_STATUS.has(value.status)
    ? (value.status as ModelCatalogModel['status'])
    : undefined;
  const reasoningEfforts = normalizeReasoningEfforts(
    value.reasoning_efforts ?? value.reasoningEfforts,
  );

  return {
    id,
    name: optionalString(value.name) ?? id,
    attachment: value.attachment === true,
    reasoning: value.reasoning === true,
    toolCall: value.tool_call === true,
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(typeof value.structured_output === 'boolean'
      ? { structuredOutput: value.structured_output }
      : {}),
    ...(typeof value.temperature === 'boolean' ? { temperature: value.temperature } : {}),
    ...(optionalString(value.release_date)
      ? { releaseDate: optionalString(value.release_date) }
      : {}),
    ...(optionalString(value.last_updated)
      ? { lastUpdated: optionalString(value.last_updated) }
      : {}),
    ...(status ? { status } : {}),
    ...(modalities && (modalities.input.length > 0 || modalities.output.length > 0)
      ? { modalities }
      : {}),
    ...(context !== undefined || input !== undefined || output !== undefined
      ? { limit: { context, input, output } }
      : {}),
  };
}

export function normalizeModelsDevelopmentCatalog(
  input: unknown,
  metadata: { catalogVersion: string; fetchedAt: string },
): ModelCatalog {
  if (!isRecord(input)) throw new TypeError('Model catalog payload must be an object');
  if (metadata.catalogVersion.trim() === '') {
    throw new TypeError('Model catalog version must not be empty');
  }
  if (!Number.isFinite(Date.parse(metadata.fetchedAt))) {
    throw new TypeError('Model catalog fetchedAt must be an ISO timestamp');
  }
  const rawProviders = Object.entries(input);
  if (rawProviders.length > MAX_PROVIDERS) throw new TypeError('Model catalog has too many providers');

  const providers: ModelCatalogProvider[] = [];
  let totalModels = 0;
  for (const [fallbackId, rawProvider] of rawProviders) {
    if (!isRecord(rawProvider)) continue;
    const id = optionalString(rawProvider.id) ?? fallbackId;
    if (id.trim() === '' || !isRecord(rawProvider.models)) continue;
    if (Array.isArray(rawProvider.env) && rawProvider.env.length > MAX_ENV_PER_PROVIDER) {
      throw new TypeError('Model catalog provider env exceeds the limit');
    }
    const rawModels = Object.entries(rawProvider.models);
    if (rawModels.length > MAX_MODELS_PER_PROVIDER) {
      throw new TypeError('Model catalog provider has too many models');
    }
    totalModels += rawModels.length;
    if (totalModels > MAX_TOTAL_MODELS) throw new TypeError('Model catalog has too many models');
    for (const [, rawModel] of rawModels) {
      if (!isRecord(rawModel)) continue;
      if (Object.keys(rawModel).length > 64) throw new TypeError('Model catalog model has too many fields');
      if (isRecord(rawModel.modalities)) {
        for (const modality of [rawModel.modalities.input, rawModel.modalities.output]) {
          if (Array.isArray(modality) && modality.length > MAX_MODALITIES) {
            throw new TypeError('Model catalog modalities exceed the limit');
          }
        }
      }
    }
    const models = rawModels
      .map(([modelId, rawModel]) => normalizeModel(modelId, rawModel))
      .filter((model): model is ModelCatalogModel => model !== undefined)
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    providers.push({
      id,
      name: optionalString(rawProvider.name) ?? id,
      ...(optionalString(rawProvider.npm) ? { npm: optionalString(rawProvider.npm) } : {}),
      ...(optionalString(rawProvider.api) ? { api: optionalString(rawProvider.api) } : {}),
      ...(optionalString(rawProvider.doc) ? { doc: optionalString(rawProvider.doc) } : {}),
      env: stringArray(rawProvider.env),
      models,
    });
  }
  providers.sort((left, right) => compareCodeUnits(left.id, right.id));
  if (providers.length === 0) throw new TypeError('Model catalog contains no valid providers');

  return parseModelCatalog({
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    source: MODEL_CATALOG_SOURCE_URL,
    catalogVersion: metadata.catalogVersion,
    fetchedAt: metadata.fetchedAt,
    providers,
  });
}

export function parseModelCatalog(input: unknown): ModelCatalog {
  if (!isRecord(input)) throw new TypeError('Model catalog cache must be an object');
  assertExactKeys(input, ['schemaVersion', 'source', 'catalogVersion', 'fetchedAt', 'providers'], 'catalog');
  if (input.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw new TypeError('Unsupported model catalog schema version');
  }
  if (input.source !== MODEL_CATALOG_SOURCE_URL) {
    throw new TypeError('Untrusted model catalog source');
  }
  const catalogVersion = strictString(input.catalogVersion, 'catalogVersion', MAX_METADATA_BYTES);
  const fetchedAt = strictIsoTimestamp(input.fetchedAt, 'fetchedAt');
  if (Date.parse(fetchedAt) > Date.now() + MAX_FUTURE_SKEW_MS) {
    throw new TypeError('Model catalog fetchedAt is too far in the future');
  }
  if (
    !Array.isArray(input.providers) || input.providers.length === 0 ||
    input.providers.length > MAX_PROVIDERS
  ) {
    throw new TypeError('Model catalog contains no providers');
  }
  const providerIds = new Set<string>();
  let totalModels = 0;
  const providers = input.providers.map((rawProvider): ModelCatalogProvider => {
    if (!isRecord(rawProvider)) throw new TypeError('Model catalog contains an invalid provider');
    assertExactKeys(rawProvider, ['id', 'name', 'npm', 'api', 'doc', 'env', 'models'], 'provider');
    const id = strictString(rawProvider.id, 'provider.id', MAX_ID_BYTES);
    if (providerIds.has(id)) throw new TypeError(`Duplicate model catalog provider: ${id}`);
    providerIds.add(id);
    const name = strictString(rawProvider.name, 'provider.name', MAX_NAME_BYTES);
    const environment = strictStringArray(rawProvider.env, 'provider.env', MAX_ENV_PER_PROVIDER, value => /^[A-Za-z0-9_]+$/u.test(value));
    if (!Array.isArray(rawProvider.models) || rawProvider.models.length > MAX_MODELS_PER_PROVIDER) {
      throw new TypeError('Model catalog provider has too many models');
    }
    totalModels += rawProvider.models.length;
    if (totalModels > MAX_TOTAL_MODELS) throw new TypeError('Model catalog has too many models');
    const modelIds = new Set<string>();
    const models = rawProvider.models.map((rawModel): ModelCatalogModel => {
      const model = parseStrictModel(rawModel);
      if (modelIds.has(model.id)) throw new TypeError(`Duplicate model catalog model: ${id}/${model.id}`);
      modelIds.add(model.id);
      return model;
    });
    return freezeProvider({
      id,
      name,
      ...(rawProvider.npm === undefined
        ? {}
        : { npm: strictString(rawProvider.npm, 'provider.npm', MAX_METADATA_BYTES) }),
      ...(rawProvider.api === undefined
        ? {}
        : { api: strictHttpUrl(rawProvider.api, 'provider.api') }),
      ...(rawProvider.doc === undefined
        ? {}
        : { doc: strictHttpUrl(rawProvider.doc, 'provider.doc') }),
      env: environment,
      models,
    });
  });
  return Object.freeze({
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    source: MODEL_CATALOG_SOURCE_URL,
    catalogVersion,
    fetchedAt,
    providers: Object.freeze(providers),
  });
}

function parseStrictModel(value: unknown): ModelCatalogModel {
  if (!isRecord(value)) throw new TypeError('Model catalog contains an invalid model');
  assertExactKeys(value, [
    'id',
    'name',
    'attachment',
    'reasoning',
    'toolCall',
    'reasoningEfforts',
    'structuredOutput',
    'temperature',
    'releaseDate',
    'lastUpdated',
    'status',
    'modalities',
    'limit',
  ], 'model');
  if (
    typeof value.attachment !== 'boolean' || typeof value.reasoning !== 'boolean' ||
    typeof value.toolCall !== 'boolean' ||
    (value.structuredOutput !== undefined && typeof value.structuredOutput !== 'boolean') ||
    (value.temperature !== undefined && typeof value.temperature !== 'boolean') ||
    (value.status !== undefined &&
      (typeof value.status !== 'string' || !ALLOWED_MODEL_STATUS.has(value.status)))
  ) throw new TypeError('Model catalog contains an invalid model');
  const date = (raw: unknown, field: string): string => {
    const result = strictString(raw, field, 32);
    if (
      !/^\d{4}-\d{2}(?:-\d{2})?$/u.test(result) ||
      Number.isNaN(Date.parse(`${result}${result.length === 7 ? '-01' : ''}T00:00:00.000Z`))
    ) {
      throw new TypeError(`Model catalog ${field} is invalid`);
    }
    return result;
  };
  let modalities: ModelCatalogModel['modalities'];
  if (value.modalities !== undefined) {
    if (!isRecord(value.modalities)) throw new TypeError('Model catalog modalities are invalid');
    assertExactKeys(value.modalities, ['input', 'output'], 'modalities');
    modalities = Object.freeze({
      input: strictStringArray(value.modalities.input, 'modalities.input', MAX_MODALITIES, item => ALLOWED_MODALITIES.has(item)),
      output: strictStringArray(value.modalities.output, 'modalities.output', MAX_MODALITIES, item => ALLOWED_MODALITIES.has(item)),
    });
  }
  let reasoningEfforts: ModelCatalogModel['reasoningEfforts'];
  if (value.reasoningEfforts !== undefined) {
    reasoningEfforts = Object.freeze(
      strictStringArray(
        value.reasoningEfforts,
        'model.reasoningEfforts',
        MAX_REASONING_EFFORTS,
        item => ALLOWED_REASONING_EFFORTS.has(item),
      )
        .map(item => item as NonNullable<ModelCatalogModel['reasoningEfforts']>[number])
        .sort(compareReasoningEfforts),
    );
  }
  let limit: ModelCatalogModel['limit'];
  if (value.limit !== undefined) {
    if (!isRecord(value.limit)) throw new TypeError('Model catalog token limits are invalid');
    assertExactKeys(value.limit, ['context', 'input', 'output'], 'limit');
    const tokenLimit = (raw: unknown, field: string): number | undefined => {
      if (raw === undefined) return undefined;
      if (!Number.isSafeInteger(raw) || typeof raw !== 'number' || raw < 0) {
        throw new TypeError(`Model catalog ${field} must be a non-negative safe integer`);
      }
      return raw;
    };
    limit = Object.freeze({
      ...(value.limit.context === undefined ? {} : { context: tokenLimit(value.limit.context, 'limit.context') }),
      ...(value.limit.input === undefined ? {} : { input: tokenLimit(value.limit.input, 'limit.input') }),
      ...(value.limit.output === undefined ? {} : { output: tokenLimit(value.limit.output, 'limit.output') }),
    });
  }
  return Object.freeze({
    id: strictString(value.id, 'model.id', MAX_ID_BYTES),
    name: strictString(value.name, 'model.name', MAX_NAME_BYTES),
    attachment: value.attachment,
    reasoning: value.reasoning,
    toolCall: value.toolCall,
    ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    ...(value.structuredOutput === undefined ? {} : { structuredOutput: value.structuredOutput }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.releaseDate === undefined ? {} : { releaseDate: date(value.releaseDate, 'releaseDate') }),
    ...(value.lastUpdated === undefined ? {} : { lastUpdated: date(value.lastUpdated, 'lastUpdated') }),
    ...(value.status === undefined ? {} : { status: value.status as ModelCatalogModel['status'] }),
    ...(modalities === undefined ? {} : { modalities }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(record);
  if (keys.length > allowed.length || keys.some(key => !allowed.includes(key))) {
    throw new TypeError(`Model catalog ${label} contains unknown fields`);
  }
}

function strictString(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
    hasControlCharacters(value) || textEncoder.encode(value).byteLength > maxBytes
  ) throw new TypeError(`Model catalog ${field} is invalid`);
  return value;
}

function strictStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  validate: (value: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`Model catalog ${field} is invalid`);
  }
  const seen = new Set<string>();
  const result = value.map(item => strictString(item, field, MAX_ID_BYTES));
  if (result.some(item => !validate(item) || seen.has(item) || !seen.add(item))) {
    throw new TypeError(`Model catalog ${field} is invalid`);
  }
  return Object.freeze(result);
}

function compareReasoningEfforts(
  left: NonNullable<ModelCatalogModel['reasoningEfforts']>[number],
  right: NonNullable<ModelCatalogModel['reasoningEfforts']>[number],
): number {
  return REASONING_EFFORT_ORDER.indexOf(left) - REASONING_EFFORT_ORDER.indexOf(right);
}

function strictHttpUrl(value: unknown, field: string): string {
  const raw = strictString(value, field, MAX_METADATA_BYTES);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`Model catalog ${field} is invalid`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new TypeError(`Model catalog ${field} is invalid`);
  }
  return raw;
}

function strictIsoTimestamp(value: unknown, field: string): string {
  const raw = strictString(value, field, 64);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== raw) {
    throw new TypeError(`Model catalog ${field} must be a canonical ISO timestamp`);
  }
  return raw;
}

function freezeProvider(provider: ModelCatalogProvider): ModelCatalogProvider {
  return Object.freeze({
    ...provider,
    env: Object.freeze([...provider.env]),
    models: Object.freeze([...provider.models]),
  });
}

export function mergeDiscoveredModelIds(
  provider: ModelCatalogProvider | undefined,
  discoveredIds: readonly string[],
): readonly ModelCatalogModel[] {
  if (!Array.isArray(discoveredIds) || discoveredIds.length > MAX_MODELS_PER_PROVIDER) {
    throw new TypeError('Discovered model ids exceed the limit');
  }
  const ids = discoveredIds.map(id => strictString(id, 'discovered model id', MAX_ID_BYTES));
  if (new Set(ids).size !== ids.length) throw new TypeError('Discovered model ids contain duplicates');
  const metadata = new Map(provider?.models.map((model) => [model.id, parseStrictModel(model)]) ?? []);
  const merged = ids
    .sort()
    .map(
      (id) =>
        metadata.get(id) ?? Object.freeze({
          id,
          name: id,
          attachment: false,
          reasoning: false,
          toolCall: false,
        }),
    );
  return Object.freeze(merged);
}

export async function fetchModelCatalog(
  options: FetchModelCatalogOptions = {},
): Promise<ModelCatalog> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be positive');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  const request = createRequestSignal(options.signal, timeoutMs);
  const { signal } = request;
  try {
    const response = await raceWithSignal(
      Promise.resolve(fetchImplementation(MODEL_CATALOG_SOURCE_URL, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      })),
      signal,
    );
    if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}`);
    const bytes = await readBoundedResponse(response, maxBytes, signal);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const payload: unknown = JSON.parse(text);
    const etag = response.headers.get('etag')?.replaceAll('"', '').trim();
    const catalogVersion = etag || response.headers.get('last-modified') || await sha256Hex(bytes, signal);
    return normalizeModelsDevelopmentCatalog(payload, {
      catalogVersion,
      fetchedAt: new Date().toISOString(),
    });
  } finally {
    request.dispose();
  }
}
