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

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error('Model catalog response exceeds the size limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Model catalog response exceeds the size limit');
        throw new Error('Model catalog response exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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

  return {
    id,
    name: optionalString(value.name) ?? id,
    attachment: value.attachment === true,
    reasoning: value.reasoning === true,
    toolCall: value.tool_call === true,
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

  const providers: ModelCatalogProvider[] = [];
  for (const [fallbackId, rawProvider] of Object.entries(input)) {
    if (!isRecord(rawProvider)) continue;
    const id = optionalString(rawProvider.id) ?? fallbackId;
    if (id.trim() === '' || !isRecord(rawProvider.models)) continue;
    const models = Object.entries(rawProvider.models)
      .map(([modelId, rawModel]) => normalizeModel(modelId, rawModel))
      .filter((model): model is ModelCatalogModel => model !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
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
  providers.sort((left, right) => left.id.localeCompare(right.id));
  if (providers.length === 0) throw new TypeError('Model catalog contains no valid providers');

  return {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    source: MODEL_CATALOG_SOURCE_URL,
    catalogVersion: metadata.catalogVersion,
    fetchedAt: metadata.fetchedAt,
    providers,
  };
}

export function parseModelCatalog(input: unknown): ModelCatalog {
  if (!isRecord(input)) throw new TypeError('Model catalog cache must be an object');
  if (input.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw new TypeError('Unsupported model catalog schema version');
  }
  if (input.source !== MODEL_CATALOG_SOURCE_URL) {
    throw new TypeError('Untrusted model catalog source');
  }
  if (typeof input.catalogVersion !== 'string' || input.catalogVersion.trim() === '') {
    throw new TypeError('Model catalog version must not be empty');
  }
  if (typeof input.fetchedAt !== 'string' || !Number.isFinite(Date.parse(input.fetchedAt))) {
    throw new TypeError('Model catalog fetchedAt must be an ISO timestamp');
  }
  if (!Array.isArray(input.providers) || input.providers.length === 0) {
    throw new TypeError('Model catalog contains no providers');
  }
  for (const provider of input.providers) {
    if (
      !isRecord(provider) ||
      typeof provider.id !== 'string' ||
      typeof provider.name !== 'string' ||
      !Array.isArray(provider.env) ||
      !Array.isArray(provider.models)
    ) {
      throw new TypeError('Model catalog contains an invalid provider');
    }
    for (const model of provider.models) {
      if (
        !isRecord(model) ||
        typeof model.id !== 'string' ||
        typeof model.name !== 'string' ||
        typeof model.attachment !== 'boolean' ||
        typeof model.reasoning !== 'boolean' ||
        typeof model.toolCall !== 'boolean'
      ) {
        throw new TypeError('Model catalog contains an invalid model');
      }
    }
  }
  return input as unknown as ModelCatalog;
}

export function mergeDiscoveredModelIds(
  provider: ModelCatalogProvider | undefined,
  discoveredIds: readonly string[],
): ModelCatalogModel[] {
  const metadata = new Map(provider?.models.map((model) => [model.id, model]) ?? []);
  return [...new Set(discoveredIds.filter((id) => typeof id === 'string' && id.trim() !== ''))]
    .sort()
    .map(
      (id) =>
        metadata.get(id) ?? {
          id,
          name: id,
          attachment: false,
          reasoning: false,
          toolCall: false,
        },
    );
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

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => {
      timeoutController.abort(new Error('Model catalog request timed out'));
    },
    timeoutMs,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const response = await fetchImplementation(MODEL_CATALOG_SOURCE_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}`);
    const bytes = await readBoundedResponse(response, maxBytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const payload: unknown = JSON.parse(text);
    const etag = response.headers.get('etag')?.replaceAll('"', '').trim();
    return normalizeModelsDevelopmentCatalog(payload, {
      catalogVersion: etag || response.headers.get('last-modified') || `bytes-${bytes.byteLength}`,
      fetchedAt: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timeout);
  }
}
