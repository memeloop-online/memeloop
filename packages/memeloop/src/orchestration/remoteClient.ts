import { safeErrorMessageFromUnknown } from '../safeError.js';

import type {
  AgentOrchestrationCapabilities,
  AgentOrchestrationClient,
  OrchestrationApplyOptions,
  OrchestrationCallOptions,
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

export const REMOTE_ORCHESTRATION_PROTOCOL = 'memeloop.resource.v2' as const;
export const REMOTE_ORCHESTRATION_DEADLINE_HEADER = 'X-MemeLoop-Orchestration-Deadline' as const;
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
  deadline?: string;
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
  /** Ordinary and watch request deadline when a call does not provide one. */
  defaultRequestTimeoutMs?: number;
  now?: () => Date;
}

export interface ReadOnlyOrchestrationClientOptions {
  /** Resource kinds visible to the remote client. Omit to retain every kind exposed by the source client. */
  allowedResourceKinds?: readonly string[];
}

export interface NamespacedOrchestrationClientOptions {
  /** Host-bound namespace. Callers may omit it, but cannot select another namespace. */
  namespace: string;
  /** Resource kinds the caller may access. An empty list denies every resource kind. */
  allowedResourceKinds: readonly string[];
  /**
   * Resource kinds the caller may apply or delete. Defaults to every allowed
   * kind; hosts should narrow this when status resources are
   * controller-owned.
   */
  mutableResourceKinds?: readonly string[];
}

const REMOTE_OPERATIONS = new Set<RemoteOrchestrationOperation>([
  'capabilities',
  'apply',
  'get',
  'list',
  'watch',
  'delete',
]);
const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 30_000;

interface RequestScope {
  signal: AbortSignal;
  deadline: string;
  dispose(): void;
}

function orchestrationCancellationError(): OrchestrationError {
  return new OrchestrationError({
    code: 'CANCELLED',
    message: 'remote orchestration request was cancelled',
    retryable: false,
  });
}

function orchestrationDeadlineError(): OrchestrationError {
  return new OrchestrationError({
    code: 'TIMEOUT',
    message: 'remote orchestration request deadline expired',
    retryable: false,
  });
}

function abortError(signal: AbortSignal): OrchestrationError {
  return signal.reason instanceof OrchestrationError
    ? signal.reason
    : orchestrationCancellationError();
}

function createRequestScope(options: {
  signal?: AbortSignal;
  deadline: string;
  now?: () => Date;
}): RequestScope {
  const deadlineMs = Date.parse(options.deadline);
  if (!Number.isFinite(deadlineMs)) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'remote orchestration request deadline is invalid',
      retryable: false,
    });
  }
  const controller = new AbortController();
  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(orchestrationCancellationError());
  };
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const remainingMs = deadlineMs - (options.now ?? (() => new Date()))().getTime();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) controller.abort(orchestrationDeadlineError());
  else {
    timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort(orchestrationDeadlineError());
    }, remainingMs);
  }
  return {
    signal: controller.signal,
    deadline: new Date(deadlineMs).toISOString(),
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function throwIfRequestAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function waitForRequest<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfRequestAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          signal.aborted
            ? abortError(signal)
            : error instanceof Error
            ? error
            : new Error('remote orchestration transport failed'),
        );
      },
    );
  });
}

function wireOptions<T extends OrchestrationCallOptions>(options: T | undefined): Omit<T, 'signal' | 'deadline'> | undefined {
  if (!options) return undefined;
  const { signal: _signal, deadline: _deadline, ...wire } = options;
  return Object.keys(wire).length > 0 ? wire : undefined;
}

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
    message: safeErrorMessageFromUnknown(error, { fallback: 'Remote orchestration request failed' }),
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
  const defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(defaultRequestTimeoutMs) || defaultRequestTimeoutMs <= 0) {
    throw new TypeError('defaultRequestTimeoutMs must be a positive safe integer');
  }
  const now = options.now ?? (() => new Date());
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
    callOptions?: OrchestrationCallOptions,
  ): Promise<T> {
    const envelope = makeRequest(operation, payload);
    const scope = createRequestScope({
      signal: callOptions?.signal,
      deadline: callOptions?.deadline ?? new Date(now().getTime() + defaultRequestTimeoutMs).toISOString(),
      now,
    });
    try {
      throwIfRequestAborted(scope.signal);
      const response = await waitForRequest(
        transport.request(envelope, {
          signal: scope.signal,
          deadline: scope.deadline,
        }),
        scope.signal,
      );
      throwIfRequestAborted(scope.signal);
      assertResponse(envelope, response);
      if (!response.ok) throwResponseError(response);
      return response.result as T;
    } finally {
      scope.dispose();
    }
  }

  return {
    getCapabilities(callOptions) {
      return request<AgentOrchestrationCapabilities>('capabilities', {}, callOptions);
    },
    apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      resource: OrchestrationResourceManifest<TSpec>,
      applyOptions?: OrchestrationApplyOptions,
    ) {
      const serializedOptions = wireOptions(applyOptions);
      return request<OrchestrationResource<TSpec, TStatus>>('apply', {
        resource,
        ...(serializedOptions ? { options: serializedOptions } : {}),
      }, applyOptions);
    },
    get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      reference: OrchestrationResourceReference,
      getOptions?: OrchestrationGetOptions,
    ) {
      const serializedOptions = wireOptions(getOptions);
      return request<OrchestrationResource<TSpec, TStatus> | null>('get', {
        reference,
        ...(serializedOptions ? { options: serializedOptions } : {}),
      }, getOptions);
    },
    list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
      query: OrchestrationResourceQuery,
      listOptions?: OrchestrationListOptions,
    ) {
      const serializedOptions = wireOptions(listOptions);
      return request<OrchestrationResourceList<TSpec, TStatus>>('list', {
        query,
        ...(serializedOptions ? { options: serializedOptions } : {}),
      }, listOptions);
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
      const serializedOptions = wireOptions(deleteOptions);
      return request<OrchestrationDeleteResult>('delete', {
        reference,
        ...(serializedOptions ? { options: serializedOptions } : {}),
      }, deleteOptions);
    },
  };
}

/**
 * Bind a remote/mobile caller to a read-only view of an existing policy-scoped
 * client. This is an enforcement boundary, not only capability advertising:
 * mutations and out-of-scope kinds fail before reaching the source client.
 */
export function createReadOnlyOrchestrationClient(
  client: AgentOrchestrationClient,
  options: ReadOnlyOrchestrationClientOptions = {},
): AgentOrchestrationClient {
  const allowedKinds = options.allowedResourceKinds
    ? new Set(options.allowedResourceKinds)
    : undefined;

  function assertAllowedKind(kind: string): void {
    if (!allowedKinds || allowedKinds.has(kind)) return;
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `remote orchestration access to resource kind '${kind}' is forbidden`,
      retryable: false,
    });
  }

  function forbidden(operation: 'apply' | 'delete'): never {
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `remote orchestration operation '${operation}' is read-only`,
      retryable: false,
    });
  }

  return {
    async getCapabilities(callOptions) {
      const capabilities = await client.getCapabilities(callOptions);
      return {
        operations: ['get', 'list', 'watch'],
        resourceKinds: capabilities.resourceKinds.filter((kind) => allowedKinds ? allowedKinds.has(kind) : true),
        interfaces: capabilities.interfaces.includes('resource') ? ['resource'] : [],
      };
    },
    async apply() {
      forbidden('apply');
    },
    async get(reference, getOptions) {
      assertAllowedKind(reference.kind);
      return await client.get(reference, getOptions);
    },
    async list(query, listOptions) {
      assertAllowedKind(query.kind);
      return await client.list(query, listOptions);
    },
    async *watch(query, watchOptions) {
      assertAllowedKind(query.kind);
      yield* client.watch(query, watchOptions);
    },
    async delete() {
      forbidden('delete');
    },
  };
}

/**
 * Bind a mutable remote caller to one host-selected namespace and an explicit
 * resource-kind allowlist. The wrapper is an authorization boundary: it
 * rejects cross-namespace references before they reach the source client and
 * fills an omitted namespace with the host-bound value.
 */
export function createNamespacedOrchestrationClient(
  client: AgentOrchestrationClient,
  options: NamespacedOrchestrationClientOptions,
): AgentOrchestrationClient {
  const namespace = options.namespace.trim();
  if (!namespace || namespace.length > 253) {
    throw new TypeError('namespace must contain between 1 and 253 characters');
  }
  const allowedKinds = new Set(options.allowedResourceKinds);
  const mutableKinds = new Set(options.mutableResourceKinds ?? options.allowedResourceKinds);
  for (const kind of mutableKinds) {
    if (!allowedKinds.has(kind)) {
      throw new TypeError(`mutable resource kind '${kind}' must also be allowed`);
    }
  }

  function assertAllowedKind(kind: string): void {
    if (allowedKinds.has(kind)) return;
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `remote orchestration access to resource kind '${kind}' is forbidden`,
      retryable: false,
    });
  }

  function bindNamespace<T extends { namespace?: string }>(metadata: T): T & { namespace: string } {
    if (metadata.namespace !== undefined && metadata.namespace !== namespace) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `remote orchestration access outside namespace '${namespace}' is forbidden`,
        retryable: false,
      });
    }
    return { ...metadata, namespace };
  }

  function assertMutableKind(kind: string): void {
    assertAllowedKind(kind);
    if (mutableKinds.has(kind)) return;
    throw new OrchestrationError({
      code: 'FORBIDDEN',
      message: `remote orchestration mutation of resource kind '${kind}' is forbidden`,
      retryable: false,
    });
  }

  return {
    async getCapabilities(callOptions) {
      const capabilities = await client.getCapabilities(callOptions);
      const resourceKinds = capabilities.resourceKinds.filter((kind) => allowedKinds.has(kind));
      const resourceOperations = Object.fromEntries(
        resourceKinds.map((kind) => {
          const sourceOperations = capabilities.resourceOperations?.[kind] ??
            capabilities.operations;
          return [
            kind,
            sourceOperations.filter((operation) => mutableKinds.has(kind) || (operation !== 'apply' && operation !== 'delete')),
          ];
        }),
      );
      return {
        operations: capabilities.operations,
        resourceKinds,
        resourceOperations,
        interfaces: capabilities.interfaces.includes('resource') ? ['resource'] : [],
      };
    },
    async apply(resource, applyOptions) {
      assertMutableKind(resource.kind);
      return await client.apply(
        {
          ...resource,
          metadata: bindNamespace(resource.metadata),
        },
        applyOptions,
      );
    },
    async get(reference, getOptions) {
      assertAllowedKind(reference.kind);
      return await client.get(bindNamespace(reference), getOptions);
    },
    async list(query, listOptions) {
      assertAllowedKind(query.kind);
      return await client.list(bindNamespace(query), listOptions);
    },
    watch(query, watchOptions) {
      assertAllowedKind(query.kind);
      return client.watch(bindNamespace(query), watchOptions);
    },
    async delete(reference, deleteOptions) {
      assertMutableKind(reference.kind);
      return await client.delete(bindNamespace(reference), deleteOptions);
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

function failure(request: unknown, error: unknown): RemoteOrchestrationResponse {
  const requestRecord = isRecord(request) ? request : undefined;
  return {
    protocol: REMOTE_ORCHESTRATION_PROTOCOL,
    requestId: typeof requestRecord?.requestId === 'string' ? requestRecord.requestId : 'invalid',
    ok: false,
    error: errorData(error),
  };
}

/**
 * Trusted-side protocol adapter. The injected client has already bound actor,
 * admission, quotas, and resource scope; wire callers cannot select an actor.
 */
export function createRemoteOrchestrationHandler(client: AgentOrchestrationClient): {
  request(
    request: RemoteOrchestrationRequest,
    options?: RemoteOrchestrationTransportOptions,
  ): Promise<RemoteOrchestrationResponse>;
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
    async request(request, options = {}) {
      const scope = createRequestScope({
        signal: options.signal,
        deadline: options.deadline ?? new Date(Date.now() + DEFAULT_REMOTE_REQUEST_TIMEOUT_MS).toISOString(),
      });
      try {
        validate(request);
        throwIfRequestAborted(scope.signal);
        const payload = request.payload;
        const callOptions = {
          signal: scope.signal,
          deadline: scope.deadline,
        };
        const operation = (() => {
          switch (request.operation) {
            case 'capabilities':
              return client.getCapabilities(callOptions);
            case 'apply':
              return client.apply(
                requirePayload(payload, 'resource') as OrchestrationResourceManifest,
                {
                  ...(isRecord(payload.options) ? payload.options : {}),
                  ...callOptions,
                } as OrchestrationApplyOptions,
              );
            case 'get':
              return client.get(
                requirePayload(payload, 'reference') as OrchestrationResourceReference,
                {
                  ...(isRecord(payload.options) ? payload.options : {}),
                  ...callOptions,
                } as OrchestrationGetOptions,
              );
            case 'list':
              return client.list(
                requirePayload(payload, 'query') as OrchestrationResourceQuery,
                {
                  ...(isRecord(payload.options) ? payload.options : {}),
                  ...callOptions,
                } as OrchestrationListOptions,
              );
            case 'delete':
              return client.delete(
                requirePayload(payload, 'reference') as OrchestrationResourceReference,
                {
                  ...(isRecord(payload.options) ? payload.options : {}),
                  ...callOptions,
                } as OrchestrationDeleteOptions,
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
        })() as Promise<unknown>;
        const result = await waitForRequest(operation, scope.signal);
        throwIfRequestAborted(scope.signal);
        return success(request, result);
      } catch (error) {
        return failure(request, error);
      } finally {
        scope.dispose();
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

  async function headers(accept: string, deadline?: string): Promise<Record<string, string>> {
    const additional = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
    return {
      Accept: accept,
      'Content-Type': 'application/json',
      ...additional,
      ...(deadline ? { [REMOTE_ORCHESTRATION_DEADLINE_HEADER]: deadline } : {}),
    };
  }

  async function post(
    request: RemoteOrchestrationRequest,
    accept: string,
    signal?: AbortSignal,
    deadline?: string,
  ): Promise<Response> {
    const response = await fetch_(options.endpoint, {
      method: 'POST',
      headers: await headers(accept, deadline),
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
      const response = await post(
        request,
        'application/json',
        transportOptions.signal,
        transportOptions.deadline,
      );
      const text = await readBoundedText(response, maxResponseBytes);
      return JSON.parse(text) as RemoteOrchestrationResponse;
    },
    async *watch(request, transportOptions = {}) {
      const response = await post(request, 'application/x-ndjson', transportOptions.signal);
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
