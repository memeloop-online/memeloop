import { hasCanonicalDeviceConnectionGrantClaims, hasCanonicalDeviceRelayReservationTokenClaims } from './deviceGrantMessages.js';
import type { CloudDeviceClient, CloudDeviceRecord, DeviceConnectionGrant, DeviceRelayReservationToken } from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_ERROR_MAX_CHARACTERS = 4_096;
const DEFAULT_TOKEN_SAFETY_MARGIN_MS = 2 * 60_000;
const CLOUD_URL_MAX_CHARACTERS = 2_048;
const CLOUD_ACCESS_TOKEN_MAX_CHARACTERS = 16_384;

type Awaitable<T> = T | Promise<T>;
type ConnectionGrantRequest = Parameters<CloudDeviceClient['createConnectionGrant']>[0];

export type CloudDeviceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CloudDeviceAccessTokenSupplier = (
  signal: AbortSignal,
) => Awaitable<string | undefined>;

export interface DeviceCloudTokenStorage {
  loadConnectionGrant(input: ConnectionGrantRequest): Awaitable<unknown>;
  saveConnectionGrant(
    input: ConnectionGrantRequest,
    grant: DeviceConnectionGrant,
  ): Awaitable<void>;
  loadRelayReservation(peerId: string): Awaitable<unknown>;
  saveRelayReservation(peerId: string, token: DeviceRelayReservationToken): Awaitable<void>;
  clear(): Awaitable<void>;
}

export class MemoryDeviceCloudTokenStorage implements DeviceCloudTokenStorage {
  private readonly grants = new Map<string, DeviceConnectionGrant>();
  private readonly relayReservations = new Map<string, DeviceRelayReservationToken>();

  public loadConnectionGrant(input: ConnectionGrantRequest): DeviceConnectionGrant | undefined {
    return this.grants.get(connectionGrantCacheKey(input));
  }

  public saveConnectionGrant(
    input: ConnectionGrantRequest,
    grant: DeviceConnectionGrant,
  ): void {
    this.grants.set(connectionGrantCacheKey(input), grant);
  }

  public loadRelayReservation(peerId: string): DeviceRelayReservationToken | undefined {
    return this.relayReservations.get(peerId);
  }

  public saveRelayReservation(peerId: string, token: DeviceRelayReservationToken): void {
    this.relayReservations.set(peerId, token);
  }

  public clear(): void {
    this.grants.clear();
    this.relayReservations.clear();
  }
}

export type CloudDeviceFetchErrorCode =
  | 'cloud_request_failed'
  | 'cloud_http_error'
  | 'cloud_response_invalid_json'
  | 'cloud_response_invalid_shape'
  | 'cloud_response_too_large';

export class CloudDeviceFetchError extends Error {
  public readonly code: CloudDeviceFetchErrorCode;
  public readonly status?: number;
  public readonly responseBody?: string;

  constructor(
    code: CloudDeviceFetchErrorCode,
    options?: { cause?: unknown; status?: number; responseBody?: string },
  ) {
    const detail = options?.status === undefined
      ? code
      : `${code}: ${options.status} ${(options.responseBody ?? '').trim()}`.trim();
    super(detail, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CloudDeviceFetchError';
    this.code = code;
    this.status = options?.status;
    this.responseBody = options?.responseBody;
  }
}

export interface CloudDeviceFetchClientOptions {
  baseUrl: string;
  fetch?: CloudDeviceFetch;
  accessToken?: string;
  getAccessToken?: CloudDeviceAccessTokenSupplier;
  credentials?: RequestCredentials;
  requestTimeoutMs?: number;
  responseMaxBytes?: number;
  errorMaxCharacters?: number;
  tokenStorage?: DeviceCloudTokenStorage;
  tokenSafetyMarginMs?: number;
  now?: () => number;
  onTokenStorageError?: (operation: 'load' | 'save', error: unknown) => void;
}

/** Browser/React Native-safe transport for the audited MemeLoop Cloud device API. */
export class CloudDeviceFetchClient implements CloudDeviceClient {
  public readonly baseUrl: string;
  private readonly fetchImplementation: CloudDeviceFetch;
  private readonly getAccessToken?: CloudDeviceAccessTokenSupplier;
  private readonly credentials: RequestCredentials;
  private readonly requestTimeoutMs: number;
  private readonly responseMaxBytes: number;
  private readonly errorMaxCharacters: number;
  private readonly tokenStorage: DeviceCloudTokenStorage;
  private readonly tokenSafetyMarginMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CloudDeviceFetchClientOptions) {
    this.baseUrl = normalizeCloudDeviceBaseUrl(options.baseUrl);
    if (options.fetch) {
      this.fetchImplementation = options.fetch;
    } else if (typeof globalThis.fetch === 'function') {
      this.fetchImplementation = globalThis.fetch.bind(globalThis);
    } else {
      throw new TypeError('cloud_fetch_required');
    }
    if (options.accessToken !== undefined && options.getAccessToken !== undefined) {
      throw new TypeError('cloud_access_token_supplier_ambiguous');
    }
    if (options.accessToken !== undefined) {
      const accessToken = normalizeAccessToken(options.accessToken);
      this.getAccessToken = () => accessToken;
    } else {
      this.getAccessToken = options.getAccessToken;
    }
    this.credentials = options.credentials ?? 'omit';
    this.requestTimeoutMs = positiveFinite(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.responseMaxBytes = positiveFinite(
      options.responseMaxBytes ?? DEFAULT_RESPONSE_MAX_BYTES,
      'responseMaxBytes',
    );
    this.errorMaxCharacters = positiveFinite(
      options.errorMaxCharacters ?? DEFAULT_ERROR_MAX_CHARACTERS,
      'errorMaxCharacters',
    );
    this.tokenSafetyMarginMs = nonNegativeFinite(
      options.tokenSafetyMarginMs ?? DEFAULT_TOKEN_SAFETY_MARGIN_MS,
      'tokenSafetyMarginMs',
    );
    this.tokenStorage = options.tokenStorage ?? new MemoryDeviceCloudTokenStorage();
    this.now = options.now ?? Date.now;
  }

  public async createBindingNonce(signal?: AbortSignal): Promise<{
    nonce: string;
    accountId: string;
    expiresAt: string;
  }> {
    const value = await this.request('/api/devices/binding/nonce', { method: 'POST' }, signal);
    if (
      !isRecord(value) || !nonEmptyString(value.nonce) || !nonEmptyString(value.accountId) ||
      !nonEmptyString(value.expiresAt)
    ) {
      throw invalidShape();
    }
    return { nonce: value.nonce, accountId: value.accountId, expiresAt: value.expiresAt };
  }

  public async registerDevice(
    input: Parameters<CloudDeviceClient['registerDevice']>[0],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; peerId: string }> {
    const value = await this.request('/api/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        peerId: input.identity.peerId,
        publicKeyMultibase: input.identity.publicKeyMultibase,
        deviceName: input.identity.deviceName,
        platform: input.identity.platform,
        cloudNonce: input.cloudNonce,
        signature: input.signature,
        capabilities: input.capabilities,
        multiaddrs: input.multiaddrs,
        relayReservations: input.relayReservations,
      }),
    }, signal);
    if (!isRecord(value) || typeof value.ok !== 'boolean' || !nonEmptyString(value.peerId)) {
      throw invalidShape();
    }
    return { ok: value.ok, peerId: value.peerId };
  }

  public async listDevices(signal?: AbortSignal): Promise<CloudDeviceRecord[]> {
    const value = await this.request('/api/devices', { method: 'GET' }, signal);
    if (
      !isRecord(value) || !Array.isArray(value.devices) ||
      !value.devices.every(isCloudDeviceRecord)
    ) {
      throw invalidShape();
    }
    return value.devices;
  }

  public async getConnectionGrantPublicKey(signal?: AbortSignal): Promise<{
    issuer: 'memeloop-cloud';
    publicKeyMultibase: string;
  }> {
    const value = await this.request(
      '/api/devices/connection-grant/public-key',
      { method: 'GET' },
      signal,
    );
    if (
      !isRecord(value) || value.issuer !== 'memeloop-cloud' ||
      !nonEmptyString(value.publicKeyMultibase)
    ) {
      throw invalidShape();
    }
    return { issuer: value.issuer, publicKeyMultibase: value.publicKeyMultibase };
  }

  public async createConnectionGrant(
    input: ConnectionGrantRequest,
    signal?: AbortSignal,
  ): Promise<DeviceConnectionGrant> {
    if (!isCanonicalConnectionGrantRequest(input)) {
      throw new TypeError('invalid_connection_grant_scope');
    }
    const cacheInput = normalizedConnectionGrantRequest(input);
    const cached = await this.loadCachedGrant(cacheInput);
    throwIfAborted(signal);
    if (isUsableConnectionGrant(cached, cacheInput, this.now() + this.tokenSafetyMarginMs)) {
      return cached;
    }
    const value = await this.request('/api/devices/connection-grant', {
      method: 'POST',
      body: JSON.stringify(input),
    }, signal);
    if (!isUsableConnectionGrant(value, cacheInput, this.now())) throw invalidShape();
    await this.saveCachedGrant(cacheInput, value);
    return value;
  }

  public async createRelayReservation(
    input: { peerId: string },
    signal?: AbortSignal,
  ): Promise<DeviceRelayReservationToken> {
    const cached = await this.loadCachedRelayReservation(input.peerId);
    throwIfAborted(signal);
    if (isUsableRelayReservation(cached, input.peerId, this.now() + this.tokenSafetyMarginMs)) {
      return cached;
    }
    const value = await this.request('/api/devices/relay-reservation', {
      method: 'POST',
      body: JSON.stringify(input),
    }, signal);
    if (!isUsableRelayReservation(value, input.peerId, this.now())) throw invalidShape();
    await this.saveCachedRelayReservation(input.peerId, value);
    return value;
  }

  public async heartbeat(
    input: Parameters<CloudDeviceClient['heartbeat']>[0],
    signal?: AbortSignal,
  ): Promise<{ ok: boolean }> {
    const value = await this.request('/api/devices/heartbeat', {
      method: 'POST',
      body: JSON.stringify(input),
    }, signal);
    if (!isRecord(value) || typeof value.ok !== 'boolean') throw invalidShape();
    return { ok: value.ok };
  }

  /** Clear every grant/relay token owned by this client configuration. */
  public async clearCachedTokens(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      await this.tokenStorage.clear();
    } catch (error) {
      this.options.onTokenStorageError?.('save', error);
      throw error;
    }
    throwIfAborted(signal);
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const request = createRequestSignal(signal, this.requestTimeoutMs);
    try {
      throwIfAborted(request.signal);
      const accessToken = await this.getAccessToken?.(request.signal);
      throwIfAborted(request.signal);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (accessToken !== undefined) {
        headers.authorization = `Bearer ${normalizeAccessToken(accessToken)}`;
      }
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
          ...init,
          credentials: this.credentials,
          headers,
          redirect: 'error',
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal.aborted) throw abortReason(request.signal);
        throw new CloudDeviceFetchError('cloud_request_failed', { cause: error });
      }
      const responseText = await readBoundedCloudResponse(
        response,
        this.responseMaxBytes,
        request.signal,
      );
      if (!response.ok) {
        const responseBody = responseText.slice(0, this.errorMaxCharacters);
        throw new CloudDeviceFetchError('cloud_http_error', {
          status: response.status,
          responseBody,
        });
      }
      try {
        return JSON.parse(responseText) as unknown;
      } catch (error) {
        throw new CloudDeviceFetchError('cloud_response_invalid_json', { cause: error });
      }
    } finally {
      request.dispose();
    }
  }

  private async loadCachedGrant(input: ConnectionGrantRequest): Promise<unknown> {
    try {
      return await this.tokenStorage.loadConnectionGrant(input);
    } catch (error) {
      this.options.onTokenStorageError?.('load', error);
      return undefined;
    }
  }

  private async saveCachedGrant(
    input: ConnectionGrantRequest,
    grant: DeviceConnectionGrant,
  ): Promise<void> {
    try {
      await this.tokenStorage.saveConnectionGrant(input, grant);
    } catch (error) {
      this.options.onTokenStorageError?.('save', error);
    }
  }

  private async loadCachedRelayReservation(peerId: string): Promise<unknown> {
    try {
      return await this.tokenStorage.loadRelayReservation(peerId);
    } catch (error) {
      this.options.onTokenStorageError?.('load', error);
      return undefined;
    }
  }

  private async saveCachedRelayReservation(
    peerId: string,
    token: DeviceRelayReservationToken,
  ): Promise<void> {
    try {
      await this.tokenStorage.saveRelayReservation(peerId, token);
    } catch (error) {
      this.options.onTokenStorageError?.('save', error);
    }
  }
}

export function normalizeCloudDeviceBaseUrl(value: string): string {
  const baseUrl = value.trim();
  if (!baseUrl || baseUrl.length > CLOUD_URL_MAX_CHARACTERS) throw new Error('invalid_cloud_url');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('invalid_cloud_url');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('cloud_url_requires_https');
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error('invalid_cloud_url');
  }
  return parsed.origin;
}

function normalizeAccessToken(value: string): string {
  const accessToken = value.trim();
  if (!accessToken || accessToken.length > CLOUD_ACCESS_TOKEN_MAX_CHARACTERS) {
    throw new Error('invalid_cloud_access_token');
  }
  return accessToken;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive and finite`);
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be non-negative and finite`);
  return value;
}

function createRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromParent = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new Error('cloud_request_timeout'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function readBoundedCloudResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel('cloud_response_too_large');
    throw new CloudDeviceFetchError('cloud_response_too_large');
  }
  throwIfAborted(signal);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await awaitWithAbort(response.text(), signal);
    throwIfAborted(signal);
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new CloudDeviceFetchError('cloud_response_too_large');
    }
    return text;
  }
  const reader = response.body.getReader();
  const cancelReader = (): void => {
    void reader.cancel('cloud_request_aborted');
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let text = '';
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel('cloud_response_too_large');
        throw new CloudDeviceFetchError('cloud_response_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    throwIfAborted(signal);
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancelReader);
  }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort(abortReason(signal));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('cloud_request_aborted');
}

function invalidShape(): CloudDeviceFetchError {
  return new CloudDeviceFetchError('cloud_response_invalid_shape');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isCloudDeviceRecord(value: unknown): value is CloudDeviceRecord {
  if (
    !isRecord(value) || !nonEmptyString(value.accountId) || !nonEmptyString(value.peerId) ||
    !nonEmptyString(value.publicKeyMultibase) || !nonEmptyString(value.deviceName) ||
    (value.platform !== 'desktop' && value.platform !== 'mobile' && value.platform !== 'cli' &&
      value.platform !== 'web') ||
    !isDeviceCapabilities(value.capabilities) ||
    !stringArray(value.multiaddrs) || !stringArray(value.relayReservations) ||
    typeof value.lastSeen !== 'number' || !Number.isFinite(value.lastSeen)
  ) {
    return false;
  }
  return value.revokedAt === undefined ||
    (typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt));
}

function isDeviceCapabilities(value: unknown): boolean {
  if (
    !isRecord(value) || !stringArray(value.tools) || !stringArray(value.mcpServers) ||
    typeof value.hasWiki !== 'boolean' || !stringArray(value.imChannels) ||
    !Array.isArray(value.wikis) ||
    (value.agentLoop !== undefined && typeof value.agentLoop !== 'boolean')
  ) {
    return false;
  }
  return value.wikis.every(wiki =>
    isRecord(wiki) && nonEmptyString(wiki.wikiId) &&
    (wiki.title === undefined || typeof wiki.title === 'string') &&
    (wiki.pathHint === undefined || typeof wiki.pathHint === 'string')
  );
}

function normalizedConnectionGrantRequest(input: ConnectionGrantRequest): ConnectionGrantRequest {
  return {
    subjectPeerId: input.subjectPeerId,
    allowedPeerIds: [...input.allowedPeerIds],
    protocols: [...input.protocols],
    rpcMethodScope: cloneScope(input.rpcMethodScope),
    conversationScope: cloneScope(input.conversationScope),
    definitionScope: cloneScope(input.definitionScope),
  };
}

function connectionGrantCacheKey(input: ConnectionGrantRequest): string {
  const normalized = normalizedConnectionGrantRequest(input);
  return JSON.stringify([
    normalized.subjectPeerId,
    normalized.allowedPeerIds,
    normalized.protocols,
    normalized.rpcMethodScope,
    normalized.conversationScope,
    normalized.definitionScope,
  ]);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function cloneScope<T extends ConnectionGrantRequest['rpcMethodScope']>(scope: T): T {
  return (scope.mode === 'ids' ? { mode: 'ids', ids: [...scope.ids] } : { mode: scope.mode }) as T;
}

function sameScope(
  left: ConnectionGrantRequest['rpcMethodScope'],
  right: ConnectionGrantRequest['rpcMethodScope'],
): boolean {
  return left.mode === right.mode &&
    (left.mode !== 'ids' || (right.mode === 'ids' && sameStringList(left.ids, right.ids)));
}

function isCanonicalConnectionGrantRequest(input: ConnectionGrantRequest): boolean {
  return hasCanonicalDeviceConnectionGrantClaims({
    ...input,
    issuer: 'memeloop-cloud',
    accountId: 'validation-account',
    issuedAt: 0,
    expiresAt: 1,
    signature: 'validation-signature',
  });
}

function isUsableConnectionGrant(
  value: unknown,
  input: ConnectionGrantRequest,
  usableAfter: number,
): value is DeviceConnectionGrant {
  if (!isRecord(value)) return false;
  const grant = value as unknown as DeviceConnectionGrant;
  if (!hasCanonicalDeviceConnectionGrantClaims(grant)) return false;
  return grant.issuer === 'memeloop-cloud' && grant.subjectPeerId === input.subjectPeerId &&
    nonEmptyString(grant.accountId) && sameStringList(grant.allowedPeerIds, input.allowedPeerIds) &&
    sameStringList(grant.protocols, input.protocols) &&
    sameScope(grant.rpcMethodScope, input.rpcMethodScope) &&
    sameScope(grant.conversationScope, input.conversationScope) &&
    sameScope(grant.definitionScope, input.definitionScope) &&
    typeof grant.issuedAt === 'number' && Number.isFinite(grant.issuedAt) &&
    typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt) &&
    grant.expiresAt > usableAfter && nonEmptyString(grant.signature);
}

function isUsableRelayReservation(
  value: unknown,
  peerId: string,
  usableAfter: number,
): value is DeviceRelayReservationToken {
  if (!isRecord(value)) return false;
  const token = value as unknown as DeviceRelayReservationToken;
  return hasCanonicalDeviceRelayReservationTokenClaims(token) && token.peerId === peerId &&
    typeof value.issuedAt === 'number' && Number.isFinite(value.issuedAt) &&
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) &&
    value.expiresAt > usableAfter && nonEmptyString(value.signature);
}
