import type {
  AgentOrchestrationCapabilities,
  AgentOrchestrationClient,
  OrchestrationApplyOptions,
  OrchestrationDeleteOptions,
  OrchestrationDeleteResult,
  OrchestrationGetOptions,
  OrchestrationListOptions,
  OrchestrationResource,
  OrchestrationResourceList,
  OrchestrationResourceManifest,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
  OrchestrationResourceStatus,
  OrchestrationWatchEvent,
  OrchestrationWatchOptions,
} from './client.js';
import { OrchestrationError } from './errors.js';
import type { OrchestrationErrorData } from './errors.js';

export const REMOTE_ORCHESTRATION_PROTOCOL = 'memeloop.resource.v1' as const;
export type RemoteOrchestrationOperation =
  | 'capabilities'
  | 'apply'
  | 'get'
  | 'list'
  | 'watch'
  | 'delete';

export interface RemoteOrchestrationRequest {
  protocol: typeof REMOTE_ORCHESTRATION_PROTOCOL;
  requestId: string;
  operation: RemoteOrchestrationOperation;
  payload: Record<string, unknown>;
}

export type RemoteOrchestrationResponse =
  | {
    protocol: typeof REMOTE_ORCHESTRATION_PROTOCOL;
    requestId: string;
    ok: true;
    result: unknown;
  }
  | {
    protocol: typeof REMOTE_ORCHESTRATION_PROTOCOL;
    requestId: string;
    ok: false;
    error: OrchestrationErrorData;
  };

export interface RemoteOrchestrationTransportOptions {
  signal?: AbortSignal;
}

/**
 * Portable host boundary. Browser, Electron renderer, React Native, and Tauri
 * WebView clients implement this interface; trusted hosts bind identity and
 * policy behind the server-side AgentOrchestrationClient.
 */
export interface RemoteOrchestrationTransport {
  request(
    request: RemoteOrchestrationRequest,
    options?: RemoteOrchestrationTransportOptions,
  ): Promise<RemoteOrchestrationResponse>;
  watch(
    request: RemoteOrchestrationRequest,
    options?: RemoteOrchestrationTransportOptions,
  ): AsyncIterable<RemoteOrchestrationResponse>;
}

export interface RemoteOrchestrationClientOptions {
  createRequestId?: () => string;
}

const REMOTE_OPERATIONS = new Set<RemoteOrchestrationOperation>([
  'capabilities',
  'apply',
  'get',
  'list',
  'watch',
  'delete',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorData(error: unknown): OrchestrationErrorData {
  if (error instanceof OrchestrationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function throwResponseError(response: Extract<RemoteOrchestrationResponse, { ok: false }>): never {
  throw new OrchestrationError(response.error);
}

function assertResponse(
  request: RemoteOrchestrationRequest,
  response: RemoteOrchestrationResponse,
): void {
  if (
    !isRecord(response) ||
    response.protocol !== REMOTE_ORCHESTRATION_PROTOCOL ||
    response.requestId !== request.requestId ||
    typeof response.ok !== 'boolean' ||
    (response.ok && !('result' in response)) ||
    (!response.ok &&
      (!isRecord(response.error) ||
        typeof response.error.code !== 'string' ||
        typeof response.error.message !== 'string' ||
        typeof response.error.retryable !== 'boolean'))
  ) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'remote orchestration response correlation or protocol mismatch',
      retryable: false,
    });
  }
}

let requestSequence = 0;

/** Build the policy-scoped Agent facade over a browser-safe remote transport. */
export function createRemoteOrchestrationClient(
  transport: RemoteOrchestrationTransport,
  options: RemoteOrchestrationClientOptions = {},
): AgentOrchestrationClient {
  const createRequestId = options.createRequestId ??
    (() => `resource-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`);

  function makeRequest(
    operation: RemoteOrchestrationOperation,
    payload: Record<string, unknown>,
  ): RemoteOrchestrationRequest {
    return {
      protocol: REMOTE_ORCHESTRATION_PROTOCOL,
      requestId: createRequestId(),
      operation,
      payload,
    };
  }

  async function request<T>(
    operation: RemoteOrchestrationOperation,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const envelope = makeRequest(operation, payload);
    const response = await transport.request(envelope, { signal });
    assertResponse(envelope, response);
    if (!response.ok) throwResponseError(response);
    return response.result as T;
  }

  return {
    getCapabilities() {
      return request<AgentOrchestrationCapabilities>('capabilities', {});
    },
    apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      resource: OrchestrationResourceManifest<TSpec>,
      applyOptions?: OrchestrationApplyOptions,
    ) {
      return request<OrchestrationResource<TSpec, TStatus>>('apply', {
        resource,
        ...(applyOptions ? { options: applyOptions } : {}),
      });
    },
    get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      reference: OrchestrationResourceReference,
      getOptions?: OrchestrationGetOptions,
    ) {
      return request<OrchestrationResource<TSpec, TStatus> | null>('get', {
        reference,
        ...(getOptions ? { options: getOptions } : {}),
      });
    },
    list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      query: OrchestrationResourceQuery,
      listOptions?: OrchestrationListOptions,
    ) {
      return request<OrchestrationResourceList<TSpec, TStatus>>('list', {
        query,
        ...(listOptions ? { options: listOptions } : {}),
      });
    },
    async *watch<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      query: OrchestrationResourceQuery,
      watchOptions?: OrchestrationWatchOptions,
    ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
      const envelope = makeRequest('watch', {
        query,
        ...(watchOptions
          ? {
            options: {
              ...watchOptions,
              signal: undefined,
            },
          }
          : {}),
      });
      for await (
        const response of transport.watch(envelope, {
          signal: watchOptions?.signal,
        })
      ) {
        assertResponse(envelope, response);
        if (!response.ok) throwResponseError(response);
        yield response.result as OrchestrationWatchEvent<TSpec, TStatus>;
      }
    },
    delete(reference: OrchestrationResourceReference, deleteOptions?: OrchestrationDeleteOptions) {
      return request<OrchestrationDeleteResult>('delete', {
        reference,
        ...(deleteOptions ? { options: deleteOptions } : {}),
      });
    },
  };
}

function requirePayload(payload: Record<string, unknown>, key: string): unknown {
  if (!(key in payload)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `remote orchestration request is missing payload.${key}`,
      retryable: false,
    });
  }
  return payload[key];
}

function success(
  request: RemoteOrchestrationRequest,
  result: unknown,
): RemoteOrchestrationResponse {
  return {
    protocol: REMOTE_ORCHESTRATION_PROTOCOL,
    requestId: request.requestId,
    ok: true,
    result,
  };
}

function failure(
  request: unknown,
  error: unknown,
): RemoteOrchestrationResponse {
  const requestRecord = isRecord(request) ? request : undefined;
  return {
    protocol: REMOTE_ORCHESTRATION_PROTOCOL,
    requestId: typeof requestRecord?.requestId === 'string'
      ? requestRecord.requestId
      : 'invalid',
    ok: false,
    error: errorData(error),
  };
}

/**
 * Trusted-side protocol adapter. The injected client has already bound actor,
 * admission, quotas, and resource scope; wire callers cannot select an actor.
 */
export function createRemoteOrchestrationHandler(client: AgentOrchestrationClient): {
  request(request: RemoteOrchestrationRequest): Promise<RemoteOrchestrationResponse>;
  watch(
    request: RemoteOrchestrationRequest,
    options?: RemoteOrchestrationTransportOptions,
  ): AsyncIterable<RemoteOrchestrationResponse>;
} {
  function validate(request: RemoteOrchestrationRequest): void {
    if (
      !isRecord(request) ||
      request.protocol !== REMOTE_ORCHESTRATION_PROTOCOL ||
      typeof request.requestId !== 'string' ||
      !request.requestId ||
      request.requestId.length > 256 ||
      !REMOTE_OPERATIONS.has(request.operation) ||
      !isRecord(request.payload)
    ) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: 'invalid remote orchestration request envelope',
        retryable: false,
      });
    }
  }

  return {
    async request(request) {
      try {
        validate(request);
        const payload = request.payload;
        switch (request.operation) {
          case 'capabilities':
            return success(request, await client.getCapabilities());
          case 'apply':
            return success(
              request,
              await client.apply(
                requirePayload(payload, 'resource') as OrchestrationResourceManifest,
                payload.options as OrchestrationApplyOptions | undefined,
              ),
            );
          case 'get':
            return success(
              request,
              await client.get(
                requirePayload(payload, 'reference') as OrchestrationResourceReference,
                payload.options as OrchestrationGetOptions | undefined,
              ),
            );
          case 'list':
            return success(
              request,
              await client.list(
                requirePayload(payload, 'query') as OrchestrationResourceQuery,
                payload.options as OrchestrationListOptions | undefined,
              ),
            );
          case 'delete':
            return success(
              request,
              await client.delete(
                requirePayload(payload, 'reference') as OrchestrationResourceReference,
                payload.options as OrchestrationDeleteOptions | undefined,
              ),
            );
          case 'watch':
            throw new OrchestrationError({
              code: 'INVALID',
              message: 'watch requests require the streaming protocol method',
              retryable: false,
            });
          default:
            throw new OrchestrationError({
              code: 'UNSUPPORTED',
              message: `unsupported remote orchestration operation '${String(request.operation)}'`,
              retryable: false,
            });
        }
      } catch (error) {
        return failure(request, error);
      }
    },
    async *watch(request, options = {}) {
      try {
        validate(request);
        if (request.operation !== 'watch') {
          throw new OrchestrationError({
            code: 'INVALID',
            message: 'streaming protocol accepts only watch operations',
            retryable: false,
          });
        }
        const watchOptions = request.payload.options as OrchestrationWatchOptions | undefined;
        for await (
          const event of client.watch(
            requirePayload(request.payload, 'query') as OrchestrationResourceQuery,
            {
              ...watchOptions,
              signal: options.signal,
            },
          )
        ) {
          yield success(request, event);
        }
      } catch (error) {
        yield failure(request, error);
      }
    },
  };
}

export interface FetchOrchestrationTransportOptions {
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string> | (() => Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  maxResponseBytes?: number;
  maxWatchLineBytes?: number;
}

/** Browser/Tauri/React-Native fetch transport with bounded NDJSON watch. */
export function createFetchOrchestrationTransport(
  options: FetchOrchestrationTransportOptions,
): RemoteOrchestrationTransport {
  const fetch_ = options.fetch ?? globalThis.fetch;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const maxWatchLineBytes = options.maxWatchLineBytes ?? 1024 * 1024;

  function assertWatchLineSize(line: string): void {
    if (new TextEncoder().encode(line).byteLength > maxWatchLineBytes) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: `remote orchestration watch line exceeds ${maxWatchLineBytes} bytes`,
        retryable: false,
      });
    }
  }

  async function headers(accept: string): Promise<Record<string, string>> {
    const additional = typeof options.headers === 'function'
      ? await options.headers()
      : options.headers ?? {};
    return {
      Accept: accept,
      'Content-Type': 'application/json',
      ...additional,
    };
  }

  async function post(
    request: RemoteOrchestrationRequest,
    accept: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch_(options.endpoint, {
      method: 'POST',
      headers: await headers(accept),
      body: JSON.stringify(request),
      signal,
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
    if (!response.ok) {
      throw new OrchestrationError({
        code: response.status === 401 || response.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE',
        message: `remote orchestration endpoint returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      });
    }
    return response;
  }

  async function readBoundedText(response: Response, limit: number): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: `remote orchestration response exceeds ${limit} bytes`,
            retryable: false,
          });
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  return {
    async request(request, transportOptions = {}) {
      const response = await post(request, 'application/json', transportOptions.signal);
      const text = await readBoundedText(response, maxResponseBytes);
      return JSON.parse(text) as RemoteOrchestrationResponse;
    },
    async *watch(request, transportOptions = {}) {
      const response = await post(
        request,
        'application/x-ndjson',
        transportOptions.signal,
      );
      if (!response.body) {
        throw new OrchestrationError({
          code: 'UNAVAILABLE',
          message: 'remote orchestration watch response has no body',
          retryable: true,
        });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let streamCompleted = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            streamCompleted = true;
            break;
          }
          pending += decoder.decode(value, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline >= 0) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            assertWatchLineSize(line);
            if (line) yield JSON.parse(line) as RemoteOrchestrationResponse;
            newline = pending.indexOf('\n');
          }
          // UTF-8 is never smaller than the JS code-unit count. This cheap
          // guard avoids repeatedly re-encoding an attacker-controlled partial
          // line; the exact byte check runs once when the line is complete.
          if (pending.length > maxWatchLineBytes) {
            throw new OrchestrationError({
              code: 'EXHAUSTED',
              message: `remote orchestration watch line exceeds ${maxWatchLineBytes} bytes`,
              retryable: false,
            });
          }
        }
        pending += decoder.decode();
        if (pending.trim()) {
          assertWatchLineSize(pending.trim());
          yield JSON.parse(pending) as RemoteOrchestrationResponse;
        }
      } finally {
        if (!streamCompleted) {
          await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
      }
    },
  };
}
