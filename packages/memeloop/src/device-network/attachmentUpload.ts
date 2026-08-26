import type { AttachmentReference } from '../conversation/types.js';

export const ATTACHMENT_UPLOAD_RPC_METHODS = Object.freeze(
  {
    begin: 'memeloop.chat.beginAttachmentUpload',
    chunk: 'memeloop.chat.uploadAttachmentChunk',
    commit: 'memeloop.chat.commitAttachmentUpload',
  } as const,
);

export const ATTACHMENT_UPLOAD_LIMITS = Object.freeze(
  {
    totalBytes: 64 * 1_024 * 1_024,
    chunkBytes: 3 * 1_024 * 1_024,
    chunkBase64Characters: 4 * 1_024 * 1_024,
    identifierCharacters: 512,
    filenameCharacters: 1_024,
    mimeTypeCharacters: 256,
  } as const,
);

export const ATTACHMENT_UPLOAD_SHA256_PATTERN = /^sha256:[\da-f]{64}$/u;

export type AttachmentUploadRpcMethod = typeof ATTACHMENT_UPLOAD_RPC_METHODS[keyof typeof ATTACHMENT_UPLOAD_RPC_METHODS];

export type AttachmentUploadStage = 'begin' | 'chunk' | 'commit';

interface AttachmentUploadOperationIdentity {
  /** Caller-generated durable idempotency key. Reuse it for transport retries. */
  requestId: string;
  /** Mandatory authorization and storage scope for every upload operation. */
  conversationId: string;
}

export interface BeginAttachmentUploadRequest extends AttachmentUploadOperationIdentity {
  filename: string;
  mimeType: string;
  totalBytes: number;
}

export interface BeginAttachmentUploadResponse extends AttachmentUploadOperationIdentity {
  ok: true;
  /** Durable opaque handle; callers must not parse or synthesize it. */
  uploadId: string;
  totalBytes: number;
  maxChunkBytes: number;
}

export interface UploadAttachmentChunkRequest extends AttachmentUploadOperationIdentity {
  uploadId: string;
  offset: number;
  /** Must equal the strictly decoded byte count, not the base64 character count. */
  byteLength: number;
  encoding: 'base64';
  data: string;
  /** Optional integrity check over this decoded chunk. */
  sha256?: string;
}

export interface UploadAttachmentChunkResponse extends AttachmentUploadOperationIdentity {
  ok: true;
  uploadId: string;
  offset: number;
  byteLength: number;
}

export interface CommitAttachmentUploadRequest extends AttachmentUploadOperationIdentity {
  uploadId: string;
  /** Exact final byte count, checked against begin and persisted chunks. */
  size: number;
  /** Exact final digest and resulting content-addressed attachment hash. */
  sha256: string;
}

export interface CommitAttachmentUploadResponse extends AttachmentUploadOperationIdentity {
  ok: true;
  uploadId: string;
  attachment: AttachmentReference;
}

export interface AttachmentUploadRpcContract {
  [ATTACHMENT_UPLOAD_RPC_METHODS.begin]: {
    request: BeginAttachmentUploadRequest;
    response: BeginAttachmentUploadResponse;
  };
  [ATTACHMENT_UPLOAD_RPC_METHODS.chunk]: {
    request: UploadAttachmentChunkRequest;
    response: UploadAttachmentChunkResponse;
  };
  [ATTACHMENT_UPLOAD_RPC_METHODS.commit]: {
    request: CommitAttachmentUploadRequest;
    response: CommitAttachmentUploadResponse;
  };
}

export type AttachmentUploadRpcRequest<M extends AttachmentUploadRpcMethod> = AttachmentUploadRpcContract[M]['request'];

export type AttachmentUploadRpcResponse<M extends AttachmentUploadRpcMethod> = AttachmentUploadRpcContract[M]['response'];

export class AttachmentUploadProtocolError extends Error {
  readonly code = 'invalid_attachment_upload' as const;

  constructor(readonly field: string) {
    super(`Invalid attachment upload ${field}`);
    this.name = 'AttachmentUploadProtocolError';
  }
}

/** Raised by a durable store when an idempotency key or chunk offset drifts. */
export class AttachmentUploadConflictError extends Error {
  readonly code = 'attachment_upload_conflict' as const;

  constructor(
    readonly stage: AttachmentUploadStage,
    readonly requestId: string,
  ) {
    super(`Attachment upload ${stage} request conflicts with an existing operation`);
    this.name = 'AttachmentUploadConflictError';
  }
}

export interface AttachmentUploadStoreContext {
  /** Authenticated transport principal; never sourced from caller parameters. */
  ownerPeerId: string;
  signal?: AbortSignal;
}

export interface AttachmentUploadIdempotencyRecord {
  stage: AttachmentUploadStage;
  ownerPeerId: string;
  conversationId: string;
  requestId: string;
  fingerprint: string;
}

export interface PersistAttachmentUploadChunkInput extends Omit<UploadAttachmentChunkRequest, 'encoding' | 'data'> {
  /** Strictly decoded and, when requested, SHA-256 verified bytes. */
  data: Uint8Array;
}

/**
 * Durable streaming upload port. Implementations must not buffer a complete
 * upload in process memory. They must scope uploadId to conversationId and
 * the authenticated `ownerPeerId`, account quota/expiry to that owner, and
 * atomically enforce these idempotency rules:
 *
 * - the same `(stage, conversationId, requestId)` and operation fingerprint
 *   returns the stored result;
 * - reusing that key with another fingerprint throws
 *   `AttachmentUploadConflictError`;
 * - the same chunk operation at `(conversationId, uploadId, offset)` returns
 *   the same result, while a different request, bytes, or length conflicts;
 * - a repeated identical commit returns its original attachment, while size
 *   or digest drift conflicts.
 */
export interface AttachmentUploadStore {
  beginAttachmentUpload(
    request: BeginAttachmentUploadRequest,
    context: AttachmentUploadStoreContext,
  ): Promise<BeginAttachmentUploadResponse>;
  writeAttachmentUploadChunk(
    request: PersistAttachmentUploadChunkInput,
    context: AttachmentUploadStoreContext,
  ): Promise<UploadAttachmentChunkResponse>;
  commitAttachmentUpload(
    request: CommitAttachmentUploadRequest,
    context: AttachmentUploadStoreContext,
  ): Promise<CommitAttachmentUploadResponse>;
}

export interface AttachmentUploadRpcCallOptions {
  signal?: AbortSignal;
}

export type AttachmentUploadRpcCall = <M extends AttachmentUploadRpcMethod>(
  method: M,
  request: AttachmentUploadRpcRequest<M>,
  options?: AttachmentUploadRpcCallOptions,
) => Promise<unknown>;

export interface AttachmentUploadRpcClientOptions {
  call: AttachmentUploadRpcCall;
}

/**
 * Typed browser/mobile client over an injected RPC call. This only streams
 * bounded chunks; it intentionally provides no full-file buffering fallback.
 */
export function createAttachmentUploadRpcClient(
  options: AttachmentUploadRpcClientOptions,
) {
  async function request<M extends AttachmentUploadRpcMethod>(
    method: M,
    parameters: AttachmentUploadRpcRequest<M>,
    callOptions: AttachmentUploadRpcCallOptions = {},
  ): Promise<AttachmentUploadRpcResponse<M>> {
    callOptions.signal?.throwIfAborted();
    assertAttachmentUploadRpcRequest(method, parameters);
    if (method === ATTACHMENT_UPLOAD_RPC_METHODS.chunk) {
      await decodeAttachmentUploadChunk(parameters as UploadAttachmentChunkRequest);
    }
    callOptions.signal?.throwIfAborted();
    const raw = await options.call(method, parameters, callOptions);
    const response = parseAttachmentUploadRpcResponse(method, raw);
    assertAttachmentUploadRpcResponseCorrelation(method, parameters, response);
    return response;
  }

  return {
    begin: (
      parameters: BeginAttachmentUploadRequest,
      callOptions: AttachmentUploadRpcCallOptions = {},
    ) => request(ATTACHMENT_UPLOAD_RPC_METHODS.begin, parameters, callOptions),
    chunk: (
      parameters: UploadAttachmentChunkRequest,
      callOptions: AttachmentUploadRpcCallOptions = {},
    ) => request(ATTACHMENT_UPLOAD_RPC_METHODS.chunk, parameters, callOptions),
    commit: (
      parameters: CommitAttachmentUploadRequest,
      callOptions: AttachmentUploadRpcCallOptions = {},
    ) => request(ATTACHMENT_UPLOAD_RPC_METHODS.commit, parameters, callOptions),
  };
}

export type AttachmentUploadRpcClient = ReturnType<typeof createAttachmentUploadRpcClient>;

/** Validate an untrusted request, including actual base64 decoding for chunks. */
export function assertAttachmentUploadRpcRequest<M extends AttachmentUploadRpcMethod>(
  method: M,
  value: unknown,
): asserts value is AttachmentUploadRpcRequest<M> {
  const record = asRecord(value, 'request');
  assertOperationIdentity(record, 'request');
  switch (method) {
    case ATTACHMENT_UPLOAD_RPC_METHODS.begin:
      assertExactKeys(record, [
        'requestId',
        'conversationId',
        'filename',
        'mimeType',
        'totalBytes',
      ], 'request');
      assertText(record.filename, 'request.filename', ATTACHMENT_UPLOAD_LIMITS.filenameCharacters);
      assertText(record.mimeType, 'request.mimeType', ATTACHMENT_UPLOAD_LIMITS.mimeTypeCharacters);
      assertInteger(record.totalBytes, 'request.totalBytes', 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
      return;
    case ATTACHMENT_UPLOAD_RPC_METHODS.chunk: {
      assertExactKeys(record, [
        'requestId',
        'conversationId',
        'uploadId',
        'offset',
        'byteLength',
        'encoding',
        'data',
        'sha256',
      ], 'request');
      assertIdentifier(record.uploadId, 'request.uploadId');
      assertInteger(record.offset, 'request.offset', 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
      assertInteger(record.byteLength, 'request.byteLength', 1, ATTACHMENT_UPLOAD_LIMITS.chunkBytes);
      if (
        record.offset + record.byteLength >
          ATTACHMENT_UPLOAD_LIMITS.totalBytes
      ) fail('request.offset');
      if (record.encoding !== 'base64') fail('request.encoding');
      if (typeof record.data !== 'string') fail('request.data');
      const bytes = attachmentUploadBase64ToBytes(record.data);
      if (bytes.byteLength !== record.byteLength) fail('request.byteLength');
      if (record.sha256 !== undefined) assertSha256(record.sha256, 'request.sha256');
      return;
    }
    case ATTACHMENT_UPLOAD_RPC_METHODS.commit:
      assertExactKeys(record, [
        'requestId',
        'conversationId',
        'uploadId',
        'size',
        'sha256',
      ], 'request');
      assertIdentifier(record.uploadId, 'request.uploadId');
      assertInteger(record.size, 'request.size', 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
      assertSha256(record.sha256, 'request.sha256');
      return;
  }
}

/** Parse and bound an untrusted successful response. */
export function parseAttachmentUploadRpcResponse<M extends AttachmentUploadRpcMethod>(
  method: M,
  value: unknown,
): AttachmentUploadRpcResponse<M> {
  const record = asRecord(value, 'response');
  if (record.ok !== true) fail('response.ok');
  assertOperationIdentity(record, 'response');
  switch (method) {
    case ATTACHMENT_UPLOAD_RPC_METHODS.begin:
      assertExactKeys(record, [
        'ok',
        'requestId',
        'conversationId',
        'uploadId',
        'totalBytes',
        'maxChunkBytes',
      ], 'response');
      assertIdentifier(record.uploadId, 'response.uploadId');
      assertInteger(record.totalBytes, 'response.totalBytes', 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
      assertInteger(record.maxChunkBytes, 'response.maxChunkBytes', 1, ATTACHMENT_UPLOAD_LIMITS.chunkBytes);
      break;
    case ATTACHMENT_UPLOAD_RPC_METHODS.chunk:
      assertExactKeys(record, [
        'ok',
        'requestId',
        'conversationId',
        'uploadId',
        'offset',
        'byteLength',
      ], 'response');
      assertIdentifier(record.uploadId, 'response.uploadId');
      assertInteger(record.offset, 'response.offset', 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
      assertInteger(record.byteLength, 'response.byteLength', 1, ATTACHMENT_UPLOAD_LIMITS.chunkBytes);
      break;
    case ATTACHMENT_UPLOAD_RPC_METHODS.commit:
      assertExactKeys(record, [
        'ok',
        'requestId',
        'conversationId',
        'uploadId',
        'attachment',
      ], 'response');
      assertIdentifier(record.uploadId, 'response.uploadId');
      assertAttachmentReference(record.attachment, 'response.attachment');
      break;
  }
  return value as AttachmentUploadRpcResponse<M>;
}

/** Reject a valid-shaped response from another upload operation or scope. */
export function assertAttachmentUploadRpcResponseCorrelation<M extends AttachmentUploadRpcMethod>(
  method: M,
  request: AttachmentUploadRpcRequest<M>,
  response: AttachmentUploadRpcResponse<M>,
): void {
  if (
    response.requestId !== request.requestId ||
    response.conversationId !== request.conversationId
  ) fail('response');
  switch (method) {
    case ATTACHMENT_UPLOAD_RPC_METHODS.begin: {
      const beginRequest = request as BeginAttachmentUploadRequest;
      const beginResponse = response as BeginAttachmentUploadResponse;
      if (beginResponse.totalBytes !== beginRequest.totalBytes) fail('response.totalBytes');
      return;
    }
    case ATTACHMENT_UPLOAD_RPC_METHODS.chunk: {
      const chunkRequest = request as UploadAttachmentChunkRequest;
      const chunkResponse = response as UploadAttachmentChunkResponse;
      if (
        chunkResponse.uploadId !== chunkRequest.uploadId ||
        chunkResponse.offset !== chunkRequest.offset ||
        chunkResponse.byteLength !== chunkRequest.byteLength
      ) fail('response');
      return;
    }
    case ATTACHMENT_UPLOAD_RPC_METHODS.commit: {
      const commitRequest = request as CommitAttachmentUploadRequest;
      const commitResponse = response as CommitAttachmentUploadResponse;
      if (
        commitResponse.uploadId !== commitRequest.uploadId ||
        commitResponse.attachment.contentHash !== commitRequest.sha256 ||
        commitResponse.attachment.size !== commitRequest.size
      ) fail('response.attachment');
      return;
    }
  }
}

/**
 * Strictly decode a chunk and verify its optional SHA-256 before storage. The
 * returned bytes are independently owned and safe to pass to an async store.
 */
export async function decodeAttachmentUploadChunk(
  request: UploadAttachmentChunkRequest,
): Promise<Uint8Array> {
  assertAttachmentUploadRpcRequest(ATTACHMENT_UPLOAD_RPC_METHODS.chunk, request);
  const bytes = attachmentUploadBase64ToBytes(request.data);
  if (request.sha256 !== undefined && await sha256AttachmentUploadBytes(bytes) !== request.sha256) {
    fail('request.sha256');
  }
  return bytes;
}

export interface BuildAttachmentUploadChunkRequestInput extends Omit<UploadAttachmentChunkRequest, 'encoding' | 'data' | 'byteLength' | 'sha256'> {
  data: Uint8Array;
  /** Include a portable WebCrypto SHA-256 integrity check for this chunk. */
  includeSha256?: boolean;
}

/** Encode already-bounded bytes into the canonical chunk wire request. */
export async function buildAttachmentUploadChunkRequest(
  input: BuildAttachmentUploadChunkRequestInput,
): Promise<UploadAttachmentChunkRequest> {
  const normalized = normalizeBuildAttachmentUploadChunkRequestInput(input);
  const data = normalizePortableUint8Array(
    normalized.data,
    'request.data',
    1,
    ATTACHMENT_UPLOAD_LIMITS.chunkBytes,
    'request.byteLength',
  );
  const request: UploadAttachmentChunkRequest = {
    requestId: normalized.requestId,
    conversationId: normalized.conversationId,
    uploadId: normalized.uploadId,
    offset: normalized.offset,
    byteLength: data.byteLength,
    encoding: 'base64',
    data: encodeAttachmentUploadOwnedBytes(data),
    ...(normalized.includeSha256
      ? { sha256: await sha256OwnedAttachmentUploadBytes(data) }
      : {}),
  };
  assertAttachmentUploadRpcRequest(ATTACHMENT_UPLOAD_RPC_METHODS.chunk, request);
  return request;
}

/** Canonical operation digest suitable for a durable idempotency record. */
export async function fingerprintAttachmentUploadOperation<M extends AttachmentUploadRpcMethod>(
  method: M,
  request: AttachmentUploadRpcRequest<M>,
): Promise<string> {
  assertAttachmentUploadRpcRequest(method, request);
  const canonical = method === ATTACHMENT_UPLOAD_RPC_METHODS.begin
    ? canonicalBegin(request as BeginAttachmentUploadRequest)
    : method === ATTACHMENT_UPLOAD_RPC_METHODS.chunk
    ? canonicalChunk(request as UploadAttachmentChunkRequest)
    : canonicalCommit(request as CommitAttachmentUploadRequest);
  return sha256AttachmentUploadBytes(new TextEncoder().encode(canonical));
}

/** Build the small durable record used to compare a retry with its first operation. */
export async function buildAttachmentUploadIdempotencyRecord<M extends AttachmentUploadRpcMethod>(
  method: M,
  request: AttachmentUploadRpcRequest<M>,
  ownerPeerId: string,
): Promise<AttachmentUploadIdempotencyRecord> {
  assertIdentifier(ownerPeerId, 'ownerPeerId');
  return {
    stage: attachmentUploadStage(method),
    ownerPeerId,
    conversationId: request.conversationId,
    requestId: request.requestId,
    fingerprint: await fingerprintAttachmentUploadOperation(method, request),
  };
}

/** Accept an identical retry or throw the standard conflict for any drift. */
export async function assertAttachmentUploadIdempotentReplay<M extends AttachmentUploadRpcMethod>(
  existing: AttachmentUploadIdempotencyRecord,
  method: M,
  request: AttachmentUploadRpcRequest<M>,
  ownerPeerId: string,
): Promise<void> {
  const next = await buildAttachmentUploadIdempotencyRecord(method, request, ownerPeerId);
  if (
    existing.stage !== next.stage ||
    existing.ownerPeerId !== next.ownerPeerId ||
    existing.conversationId !== next.conversationId ||
    existing.requestId !== next.requestId ||
    existing.fingerprint !== next.fingerprint
  ) {
    throw new AttachmentUploadConflictError(next.stage, next.requestId);
  }
}

export async function sha256AttachmentUploadBytes(bytes: Uint8Array): Promise<string> {
  const owned = normalizePortableUint8Array(
    bytes,
    'sha256.input',
    0,
    ATTACHMENT_UPLOAD_LIMITS.totalBytes,
    'sha256.input',
  );
  return sha256OwnedAttachmentUploadBytes(owned);
}

async function sha256OwnedAttachmentUploadBytes(owned: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('sha256.unavailable');
  const digest = new Uint8Array(await subtle.digest('SHA-256', owned));
  return `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Strict canonical RFC 4648 base64 decoder with no Node Buffer dependency. */
export function attachmentUploadBase64ToBytes(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length > ATTACHMENT_UPLOAD_LIMITS.chunkBase64Characters ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)
  ) fail('request.data');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > ATTACHMENT_UPLOAD_LIMITS.chunkBytes) {
    fail('request.data');
  }
  const result = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (let offset = 0; offset < value.length; offset += 4) {
    const bits = (base64Value(value.charCodeAt(offset)) << 18) |
      (base64Value(value.charCodeAt(offset + 1)) << 12) |
      (value[offset + 2] === '=' ? 0 : base64Value(value.charCodeAt(offset + 2)) << 6) |
      (value[offset + 3] === '=' ? 0 : base64Value(value.charCodeAt(offset + 3)));
    if (writeOffset < byteLength) result[writeOffset++] = (bits >>> 16) & 0xFF;
    if (writeOffset < byteLength) result[writeOffset++] = (bits >>> 8) & 0xFF;
    if (writeOffset < byteLength) result[writeOffset++] = bits & 0xFF;
  }
  if (encodeAttachmentUploadOwnedBytes(result) !== value) fail('request.data');
  return result;
}

/** Canonical RFC 4648 base64 encoder with no Node Buffer/btoa dependency. */
export function attachmentUploadBytesToBase64(bytes: Uint8Array): string {
  const owned = normalizePortableUint8Array(
    bytes,
    'request.data',
    0,
    ATTACHMENT_UPLOAD_LIMITS.chunkBytes,
    'request.byteLength',
  );
  return encodeAttachmentUploadOwnedBytes(owned);
}

function encodeAttachmentUploadOwnedBytes(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const bits = (bytes[offset] << 16) |
      ((remaining > 1 ? bytes[offset + 1] : 0) << 8) |
      (remaining > 2 ? bytes[offset + 2] : 0);
    encoded += alphabet[(bits >>> 18) & 63];
    encoded += alphabet[(bits >>> 12) & 63];
    encoded += remaining > 1 ? alphabet[(bits >>> 6) & 63] : '=';
    encoded += remaining > 2 ? alphabet[bits & 63] : '=';
  }
  return encoded;
}

function canonicalBegin(request: BeginAttachmentUploadRequest): string {
  return JSON.stringify({
    method: ATTACHMENT_UPLOAD_RPC_METHODS.begin,
    requestId: request.requestId,
    conversationId: request.conversationId,
    filename: request.filename,
    mimeType: request.mimeType,
    totalBytes: request.totalBytes,
  });
}

function canonicalChunk(request: UploadAttachmentChunkRequest): string {
  return JSON.stringify({
    method: ATTACHMENT_UPLOAD_RPC_METHODS.chunk,
    requestId: request.requestId,
    conversationId: request.conversationId,
    uploadId: request.uploadId,
    offset: request.offset,
    byteLength: request.byteLength,
    encoding: request.encoding,
    data: request.data,
    ...(request.sha256 === undefined ? {} : { sha256: request.sha256 }),
  });
}

function canonicalCommit(request: CommitAttachmentUploadRequest): string {
  return JSON.stringify({
    method: ATTACHMENT_UPLOAD_RPC_METHODS.commit,
    requestId: request.requestId,
    conversationId: request.conversationId,
    uploadId: request.uploadId,
    size: request.size,
    sha256: request.sha256,
  });
}

function attachmentUploadStage(method: AttachmentUploadRpcMethod): AttachmentUploadStage {
  if (method === ATTACHMENT_UPLOAD_RPC_METHODS.begin) return 'begin';
  if (method === ATTACHMENT_UPLOAD_RPC_METHODS.chunk) return 'chunk';
  return 'commit';
}

interface NormalizedBuildAttachmentUploadChunkRequestInput {
  requestId: string;
  conversationId: string;
  uploadId: string;
  offset: number;
  data: unknown;
  includeSha256: boolean;
}

function normalizeBuildAttachmentUploadChunkRequestInput(
  value: unknown,
): NormalizedBuildAttachmentUploadChunkRequestInput {
  const descriptors = readPlainDataDescriptors(
    value,
    ['requestId', 'conversationId', 'uploadId', 'offset', 'data'],
    ['includeSha256'],
    'request',
  );
  const requestId = readDescriptorValue(descriptors, 'requestId', 'request.requestId');
  const conversationId = readDescriptorValue(descriptors, 'conversationId', 'request.conversationId');
  const uploadId = readDescriptorValue(descriptors, 'uploadId', 'request.uploadId');
  const offset = readDescriptorValue(descriptors, 'offset', 'request.offset');
  const data = readDescriptorValue(descriptors, 'data', 'request.data');
  const includeSha256 = Object.prototype.hasOwnProperty.call(descriptors, 'includeSha256')
    ? readDescriptorValue(descriptors, 'includeSha256', 'request.includeSha256')
    : false;
  assertIdentifier(requestId, 'request.requestId');
  assertIdentifier(conversationId, 'request.conversationId');
  assertIdentifier(uploadId, 'request.uploadId');
  assertInteger(offset, 'request.offset', 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
  if (typeof includeSha256 !== 'boolean') fail('request.includeSha256');
  return { requestId, conversationId, uploadId, offset, data, includeSha256 };
}

type OwnDescriptorRecord = Readonly<Record<PropertyKey, PropertyDescriptor>>;

function readPlainDataDescriptors(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): OwnDescriptorRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field);
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (!isPlainObjectPrototype(prototype)) fail(field);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof AttachmentUploadProtocolError) throw error;
    fail(field);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
    required.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
  ) fail(field);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) fail(field);
  }
  return descriptors;
}

function readDescriptorValue(
  descriptors: OwnDescriptorRecord,
  key: string,
  field: string,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !('value' in descriptor)) fail(field);
  return descriptor.value;
}

function isPlainObjectPrototype(prototype: object | null): boolean {
  if (prototype === null || prototype === Object.prototype) return true;
  try {
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructorValue: unknown = constructor && 'value' in constructor
      ? constructor.value as unknown
      : undefined;
    return typeof constructorValue === 'function' && constructorValue.name === 'Object';
  } catch {
    return false;
  }
}

/**
 * Brand-check a cross-realm Uint8Array using the unforgeable typed-array
 * intrinsic tag getter, then copy through its ordinary ArrayBuffer slots.
 * Object#toString, constructors, species, and caller properties are ignored.
 */
function normalizePortableUint8Array(
  value: unknown,
  field: string,
  minimumBytes: number,
  maximumBytes: number,
  sizeField: string,
): Uint8Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(value)) fail(field);
  try {
    if (readTypedArrayIntrinsic(value, Symbol.toStringTag) !== 'Uint8Array') fail(field);
    const buffer = readTypedArrayIntrinsic(value, 'buffer');
    const byteOffset = readTypedArrayIntrinsic(value, 'byteOffset');
    const byteLength = readTypedArrayIntrinsic(value, 'byteLength');
    if (
      buffer === null ||
      typeof buffer !== 'object' ||
      typeof byteOffset !== 'number' ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < minimumBytes ||
      byteLength > maximumBytes
    ) fail(sizeField);
    assertOrdinaryArrayBuffer(buffer);
    // A current-realm view avoids caller iterator/species/property access; the
    // second construction owns a detached-independent byte copy.
    return new Uint8Array(new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength));
  } catch (error) {
    if (error instanceof AttachmentUploadProtocolError) throw error;
    fail(field);
  }
}

function readTypedArrayIntrinsic(value: object, key: PropertyKey): unknown {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object | null;
  if (!typedArrayPrototype) fail('request.data');
  const descriptor = Object.getOwnPropertyDescriptor(typedArrayPrototype, key);
  const getter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, 'get');
  if (typeof getter !== 'function') fail('request.data');
  return Reflect.apply(getter, value, []);
}

function assertOrdinaryArrayBuffer(value: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength');
  const getter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, 'get');
  if (typeof getter !== 'function') fail('request.data');
  // The ArrayBuffer intrinsic rejects SharedArrayBuffer and forged objects.
  Reflect.apply(getter, value, []);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(record);
  if (actual.some(key => !keys.includes(key))) fail(field);
}

function assertOperationIdentity(record: Record<string, unknown>, field: string): void {
  assertIdentifier(record.requestId, `${field}.requestId`);
  assertIdentifier(record.conversationId, `${field}.conversationId`);
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  assertText(value, field, ATTACHMENT_UPLOAD_LIMITS.identifierCharacters);
}

function assertText(
  value: unknown,
  field: string,
  maximumCharacters: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    value !== value.trim()
  ) fail(field);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) fail(field);
  }
}

function assertInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(field);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !ATTACHMENT_UPLOAD_SHA256_PATTERN.test(value)) fail(field);
}

function assertAttachmentReference(
  value: unknown,
  field: string,
): asserts value is AttachmentReference {
  const record = asRecord(value, field);
  assertExactKeys(record, ['contentHash', 'filename', 'mimeType', 'size'], field);
  assertSha256(record.contentHash, `${field}.contentHash`);
  assertText(record.filename, `${field}.filename`, ATTACHMENT_UPLOAD_LIMITS.filenameCharacters);
  assertText(record.mimeType, `${field}.mimeType`, ATTACHMENT_UPLOAD_LIMITS.mimeTypeCharacters);
  assertInteger(record.size, `${field}.size`, 0, ATTACHMENT_UPLOAD_LIMITS.totalBytes);
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  fail('request.data');
}

function fail(field: string): never {
  throw new AttachmentUploadProtocolError(field);
}
