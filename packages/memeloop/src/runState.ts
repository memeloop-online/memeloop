export type AgentRunState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const AGENT_RUN_ERROR_CODES = Object.freeze(
  [
    'CANCELLED',
    'INTERRUPTED',
    'INVALID_REQUEST',
    'USER_MESSAGE_TOO_LARGE',
    'MODEL_NOT_FOUND',
    'PROVIDER_AUTH_MISSING',
    'PROVIDER_CONFIGURATION_MISSING',
    'PROVIDER_UNAVAILABLE',
    'RATE_LIMITED',
    'RUNNER_UNAVAILABLE',
    'STORAGE_UNAVAILABLE',
    'DEVICE_AUTH_REQUIRED',
    'DEVICE_PERMISSION_DENIED',
    'NETWORK_UNAVAILABLE',
    'CONTEXT_COMPACTION_PENDING',
    'CONTEXT_COMPACTION_FAILED',
    'CONTEXT_BUDGET_EXCEEDED',
    'INTERNAL',
  ] as const,
);

export type AgentRunErrorCode = typeof AGENT_RUN_ERROR_CODES[number];

export const AGENT_RUN_ERROR_MESSAGE_KEYS = Object.freeze(
  {
    CANCELLED: 'agent.run.error.cancelled',
    INTERRUPTED: 'agent.run.error.interrupted',
    INVALID_REQUEST: 'agent.run.error.invalidRequest',
    USER_MESSAGE_TOO_LARGE: 'agent.run.error.userMessageTooLarge',
    MODEL_NOT_FOUND: 'agent.run.error.modelNotFound',
    PROVIDER_AUTH_MISSING: 'agent.run.error.providerAuthMissing',
    PROVIDER_CONFIGURATION_MISSING: 'agent.run.error.providerConfigurationMissing',
    PROVIDER_UNAVAILABLE: 'agent.run.error.providerUnavailable',
    RATE_LIMITED: 'agent.run.error.rateLimited',
    RUNNER_UNAVAILABLE: 'agent.run.error.runnerUnavailable',
    STORAGE_UNAVAILABLE: 'agent.run.error.storageUnavailable',
    DEVICE_AUTH_REQUIRED: 'agent.run.error.deviceAuthRequired',
    DEVICE_PERMISSION_DENIED: 'agent.run.error.devicePermissionDenied',
    NETWORK_UNAVAILABLE: 'agent.run.error.networkUnavailable',
    CONTEXT_COMPACTION_PENDING: 'agent.run.error.contextCompactionPending',
    CONTEXT_COMPACTION_FAILED: 'agent.run.error.contextCompactionFailed',
    CONTEXT_BUDGET_EXCEEDED: 'agent.run.error.contextBudgetExceeded',
    INTERNAL: 'agent.run.error.internal',
  } satisfies Readonly<Record<AgentRunErrorCode, string>>,
);

export type AgentRunErrorMessageKey = typeof AGENT_RUN_ERROR_MESSAGE_KEYS[AgentRunErrorCode];

export const AGENT_RUN_PROVIDER_SETTING_FIELDS = Object.freeze(
  [
    'apiKey',
    'baseUrl',
    'model',
    'apiMode',
  ] as const,
);

export type AgentRunProviderSettingField = typeof AGENT_RUN_PROVIDER_SETTING_FIELDS[number];

export interface AgentRunErrorLocalizationParameters {
  providerId?: string;
  modelId?: string;
  settingField?: AgentRunProviderSettingField;
  retryAfterMs?: number;
  requested?: number;
  limit?: number;
  /** Content-free durable compaction checkpoint identity. */
  checkpointRevision?: string;
  /** Total messages causally covered by the durable checkpoint. */
  processedMessages?: number;
  /** Optional storage-supplied estimate; absence means unknown, never zero. */
  remainingEstimate?: number;
}

export type AgentRunErrorSettingTarget =
  | {
    kind: 'provider';
    providerId: string;
    field: AgentRunProviderSettingField;
  }
  | { kind: 'model'; providerId: string; modelId: string }
  | { kind: 'runtime'; section: 'agent' | 'network' | 'storage' };

/**
 * Public, restart-safe error metadata. This type intentionally has no message,
 * cause, provider body, credential, or arbitrary metadata escape hatch.
 */
export interface AgentRunError {
  code: AgentRunErrorCode;
  messageKey: AgentRunErrorMessageKey;
  retryable: boolean;
  /** Opaque support correlation identifier; never a provider request body or credential. */
  diagnosticId: string;
  providerId?: string;
  modelId?: string;
  localizedParams?: AgentRunErrorLocalizationParameters;
  settingTarget?: AgentRunErrorSettingTarget;
}

export const AGENT_RUN_ERROR_LIMITS = Object.freeze(
  {
    maxTotalBytes: 4_096,
    maxDepth: 3,
    maxNodes: 3,
    maxProperties: 24,
    maxIdentifierBytes: 256,
    maxDiagnosticIdBytes: 128,
  } as const,
);

export class AgentRunErrorValidationError extends Error {
  constructor() {
    super('invalid agent run error');
    this.name = 'AgentRunErrorValidationError';
  }
}

/** Durable identity and lifecycle state for one accepted agent run. */
export interface AgentRunRecord {
  runId: string;
  conversationId: string;
  definitionId: string;
  /** User-rooted turn identity shared by all message events produced by this run. */
  turnId: string;
  requestPeerId: string;
  requestId: string;
  /** SHA-256 of the canonical execution payload for idempotency drift detection. */
  payloadDigest: string;
  /** Present only for a durable retry; binds the replacement run to its original user-root turn. */
  retrySourceTurnId?: string;
  state: AgentRunState;
  acceptedAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequestedAt?: number;
  error?: AgentRunError;
}

/**
 * A fenced, time-bounded right to execute one durable run.  The epoch changes
 * whenever a different runtime takes over after expiry, so stale owners cannot
 * commit lifecycle or checkpoint mutations.
 */
export interface AgentRunExecutionLease {
  runId: string;
  ownerId: string;
  fencingEpoch: number;
  expiresAt: number;
}

export interface AgentRunTransitionOptions {
  /** Required for every non-cancellation transition performed by an executor. */
  executionLease?: AgentRunExecutionLease;
}

const AGENT_RUN_ERROR_CODE_SET = new Set<AgentRunErrorCode>(AGENT_RUN_ERROR_CODES);
const AGENT_RUN_PROVIDER_SETTING_FIELD_SET = new Set<AgentRunProviderSettingField>(
  AGENT_RUN_PROVIDER_SETTING_FIELDS,
);
const ROOT_ERROR_KEYS = new Set([
  'code',
  'messageKey',
  'retryable',
  'diagnosticId',
  'providerId',
  'modelId',
  'localizedParams',
  'settingTarget',
]);
const LOCALIZATION_PARAM_KEYS = new Set([
  'providerId',
  'modelId',
  'settingField',
  'retryAfterMs',
  'requested',
  'limit',
  'checkpointRevision',
  'processedMessages',
  'remainingEstimate',
]);
const SECRET_SHAPE =
  /(?:\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+|\b(?:sk|gsk|xai)-[a-z0-9_-]{12,}|\bAIza[\w-]{20,}|\bAKIA[A-Z0-9]{12,}|eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
const DIAGNOSTIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const textEncoder = new TextEncoder();
let diagnosticSequence = 0;

interface DescriptorReadState {
  readonly seen: Set<object>;
  nodes: number;
  properties: number;
}

function invalidAgentRunError(): never {
  throw new AgentRunErrorValidationError();
}

function readDescriptorRecord(
  value: unknown,
  state: DescriptorReadState,
  depth: number,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    depth > AGENT_RUN_ERROR_LIMITS.maxDepth
  ) invalidAgentRunError();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalidAgentRunError();
  if (state.seen.has(value)) invalidAgentRunError();
  state.nodes += 1;
  if (state.nodes > AGENT_RUN_ERROR_LIMITS.maxNodes) invalidAgentRunError();
  state.seen.add(value);
  const keys = Reflect.ownKeys(value);
  state.properties += keys.length;
  if (state.properties > AGENT_RUN_ERROR_LIMITS.maxProperties) invalidAgentRunError();
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') invalidAgentRunError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalidAgentRunError();
    record[key] = descriptor.value as unknown;
  }
  return record;
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some(key => !allowed.has(key))) invalidAgentRunError();
}

function boundedSafeText(
  value: unknown,
  maximumBytes: number,
  options: { diagnostic?: boolean } = {},
): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    textEncoder.encode(value).byteLength <= maximumBytes &&
    !hasControlCharacter(value) &&
    !LONE_SURROGATE.test(value) &&
    !SECRET_SHAPE.test(value) &&
    (!options.diagnostic || DIAGNOSTIC_ID.test(value));
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

function safeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isAgentRunProviderSettingField(
  value: unknown,
): value is AgentRunProviderSettingField {
  return AGENT_RUN_PROVIDER_SETTING_FIELD_SET.has(value as AgentRunProviderSettingField);
}

function normalizeAgentRunErrorLocalizationParameters(
  value: unknown,
  state: DescriptorReadState,
): Readonly<AgentRunErrorLocalizationParameters> | undefined {
  if (value === undefined) return undefined;
  const input = readDescriptorRecord(value, state, 2);
  exactKeys(input, LOCALIZATION_PARAM_KEYS);
  if (
    input.providerId !== undefined &&
      !boundedSafeText(input.providerId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) ||
    input.modelId !== undefined &&
      !boundedSafeText(input.modelId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) ||
    input.settingField !== undefined && !isAgentRunProviderSettingField(input.settingField) ||
    input.retryAfterMs !== undefined &&
      (!safeFiniteNumber(input.retryAfterMs) || input.retryAfterMs < 0) ||
    input.requested !== undefined &&
      (!safeFiniteNumber(input.requested) || input.requested < 0) ||
    input.limit !== undefined && (!safeFiniteNumber(input.limit) || input.limit < 0) ||
    input.checkpointRevision !== undefined &&
      !boundedSafeText(input.checkpointRevision, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) ||
    input.processedMessages !== undefined &&
      (!safeFiniteNumber(input.processedMessages) ||
        !Number.isSafeInteger(input.processedMessages) || input.processedMessages < 0) ||
    input.remainingEstimate !== undefined &&
      (!safeFiniteNumber(input.remainingEstimate) ||
        !Number.isSafeInteger(input.remainingEstimate) || input.remainingEstimate < 1)
  ) invalidAgentRunError();
  const normalized: AgentRunErrorLocalizationParameters = {};
  if (typeof input.providerId === 'string') normalized.providerId = input.providerId;
  if (typeof input.modelId === 'string') normalized.modelId = input.modelId;
  if (isAgentRunProviderSettingField(input.settingField)) {
    normalized.settingField = input.settingField;
  }
  if (typeof input.retryAfterMs === 'number') normalized.retryAfterMs = input.retryAfterMs;
  if (typeof input.requested === 'number') normalized.requested = input.requested;
  if (typeof input.limit === 'number') normalized.limit = input.limit;
  if (typeof input.checkpointRevision === 'string') {
    normalized.checkpointRevision = input.checkpointRevision;
  }
  if (typeof input.processedMessages === 'number') {
    normalized.processedMessages = input.processedMessages;
  }
  if (typeof input.remainingEstimate === 'number') {
    normalized.remainingEstimate = input.remainingEstimate;
  }
  return Object.freeze(normalized);
}

/** Strictly validate and clone safe public error metadata. */
export function normalizeAgentRunError(value: unknown): AgentRunError {
  const state: DescriptorReadState = { seen: new Set(), nodes: 0, properties: 0 };
  const input = readDescriptorRecord(value, state, 1);
  exactKeys(input, ROOT_ERROR_KEYS);
  if (
    !AGENT_RUN_ERROR_CODE_SET.has(input.code as AgentRunErrorCode) ||
    input.messageKey !== AGENT_RUN_ERROR_MESSAGE_KEYS[input.code as AgentRunErrorCode] ||
    typeof input.retryable !== 'boolean' ||
    !boundedSafeText(
      input.diagnosticId,
      AGENT_RUN_ERROR_LIMITS.maxDiagnosticIdBytes,
      { diagnostic: true },
    ) ||
    input.providerId !== undefined &&
      !boundedSafeText(input.providerId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) ||
    input.modelId !== undefined &&
      !boundedSafeText(input.modelId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes)
  ) invalidAgentRunError();
  const localizedParameters = normalizeAgentRunErrorLocalizationParameters(
    input.localizedParams,
    state,
  );
  const settingTarget = normalizeAgentRunErrorSettingTarget(input.settingTarget, state);
  if (
    localizedParameters?.providerId !== undefined &&
      localizedParameters.providerId !== input.providerId ||
    localizedParameters?.modelId !== undefined && localizedParameters.modelId !== input.modelId ||
    settingTarget?.kind !== undefined &&
      settingTarget.kind !== 'runtime' && settingTarget.providerId !== input.providerId ||
    settingTarget?.kind === 'model' && settingTarget.modelId !== input.modelId ||
    settingTarget?.kind === 'provider' &&
      localizedParameters?.settingField !== undefined &&
      localizedParameters.settingField !== settingTarget.field
  ) invalidAgentRunError();
  const normalized: AgentRunError = {
    code: input.code as AgentRunErrorCode,
    messageKey: input.messageKey,
    retryable: input.retryable,
    diagnosticId: input.diagnosticId,
  };
  if (typeof input.providerId === 'string') normalized.providerId = input.providerId;
  if (typeof input.modelId === 'string') normalized.modelId = input.modelId;
  if (localizedParameters) normalized.localizedParams = localizedParameters;
  if (settingTarget) normalized.settingTarget = settingTarget;
  if (textEncoder.encode(JSON.stringify(normalized)).byteLength > AGENT_RUN_ERROR_LIMITS.maxTotalBytes) {
    invalidAgentRunError();
  }
  return Object.freeze(normalized);
}

function normalizeAgentRunErrorSettingTarget(
  value: unknown,
  state: DescriptorReadState,
): AgentRunErrorSettingTarget | undefined {
  if (value === undefined) return undefined;
  const target = readDescriptorRecord(value, state, 2);
  if (
    target.kind === 'provider' &&
    boundedSafeText(target.providerId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) &&
    isAgentRunProviderSettingField(target.field) &&
    Object.keys(target).every(
      key => key === 'kind' || key === 'providerId' || key === 'field',
    )
  ) {
    return Object.freeze({
      kind: 'provider' as const,
      providerId: target.providerId,
      field: target.field,
    });
  }
  if (
    target.kind === 'model' &&
    boundedSafeText(target.providerId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) &&
    boundedSafeText(target.modelId, AGENT_RUN_ERROR_LIMITS.maxIdentifierBytes) &&
    Object.keys(target).every(key => key === 'kind' || key === 'providerId' || key === 'modelId')
  ) {
    return Object.freeze({
      kind: 'model' as const,
      providerId: target.providerId,
      modelId: target.modelId,
    });
  }
  if (
    target.kind === 'runtime' &&
    (target.section === 'agent' || target.section === 'network' || target.section === 'storage') &&
    Object.keys(target).every(key => key === 'kind' || key === 'section')
  ) return Object.freeze({ kind: 'runtime' as const, section: target.section });
  return invalidAgentRunError();
}

export function assertAgentRunError(value: unknown): asserts value is AgentRunError {
  normalizeAgentRunError(value);
}

export function isAgentRunError(value: unknown): value is AgentRunError {
  try {
    normalizeAgentRunError(value);
    return true;
  } catch {
    return false;
  }
}

/** Throwable carrier whose Error message is always the stable public code. */
export class AgentRunFailure extends Error {
  readonly agentRunError: AgentRunError;

  constructor(agentRunError: AgentRunError) {
    const normalized = normalizeAgentRunError(agentRunError);
    super(normalized.code);
    this.name = 'AgentRunFailure';
    this.agentRunError = normalized;
  }

  /** Preserve the bounded public contract through shallow IPC error serializers. */
  toJSON(): { name: string; message: string; agentRunError: AgentRunError } {
    const agentRunError = normalizeAgentRunError(this.agentRunError);
    return { name: 'AgentRunFailure', message: agentRunError.code, agentRunError };
  }
}

export function isAgentRunFailure(value: unknown): value is AgentRunFailure {
  return value instanceof AgentRunFailure;
}

/** Extracts only a strict public contract; accessors and malformed wrappers are ignored. */
export function extractAgentRunError(value: unknown): AgentRunError | undefined {
  try {
    return normalizeAgentRunError(value);
  } catch (error) {
    if (!(error instanceof AgentRunErrorValidationError)) return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'agentRunError');
  if (!descriptor || !('value' in descriptor)) return undefined;
  try {
    return normalizeAgentRunError(descriptor.value);
  } catch (error) {
    if (!(error instanceof AgentRunErrorValidationError)) return undefined;
  }
  return undefined;
}

export function createAgentRunDiagnosticId(): string {
  let randomUuid: string | undefined;
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      randomUuid = globalThis.crypto.randomUUID();
    }
  } catch {
    randomUuid = undefined;
  }
  if (randomUuid !== undefined) return `agent-${randomUuid}`;
  diagnosticSequence = (diagnosticSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `agent-${Date.now().toString(36)}-${diagnosticSequence.toString(36)}`;
}

export type CreateAgentRunErrorInput = Omit<AgentRunError, 'diagnosticId'> & {
  diagnosticId?: string;
};

export function createAgentRunError(input: CreateAgentRunErrorInput): AgentRunError {
  const state: DescriptorReadState = { seen: new Set(), nodes: 0, properties: 0 };
  const descriptorInput = readDescriptorRecord(input, state, 1);
  exactKeys(descriptorInput, ROOT_ERROR_KEYS);
  return normalizeAgentRunError({
    ...descriptorInput,
    diagnosticId: descriptorInput.diagnosticId ?? createAgentRunDiagnosticId(),
  });
}

export interface CreateMissingProviderSettingAgentRunErrorInput {
  providerId: string;
  field: AgentRunProviderSettingField;
  modelId?: string;
  diagnosticId?: string;
}

/** Creates safe settings-navigation metadata without accepting a setting value. */
export function createMissingProviderSettingAgentRunError(
  input: CreateMissingProviderSettingAgentRunErrorInput,
): AgentRunError {
  const state: DescriptorReadState = { seen: new Set(), nodes: 0, properties: 0 };
  const descriptorInput = readDescriptorRecord(input, state, 1);
  exactKeys(descriptorInput, new Set(['providerId', 'field', 'modelId', 'diagnosticId']));
  const code: AgentRunErrorCode = descriptorInput.field === 'apiKey'
    ? 'PROVIDER_AUTH_MISSING'
    : 'PROVIDER_CONFIGURATION_MISSING';
  return createAgentRunError({
    code,
    messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS[code],
    retryable: false,
    providerId: descriptorInput.providerId as string,
    ...(descriptorInput.modelId === undefined
      ? {}
      : { modelId: descriptorInput.modelId as string }),
    localizedParams: {
      providerId: descriptorInput.providerId as string,
      ...(descriptorInput.modelId === undefined
        ? {}
        : { modelId: descriptorInput.modelId as string }),
      settingField: descriptorInput.field as AgentRunProviderSettingField,
    },
    settingTarget: {
      kind: 'provider',
      providerId: descriptorInput.providerId as string,
      field: descriptorInput.field as AgentRunProviderSettingField,
    },
    ...(descriptorInput.diagnosticId === undefined
      ? {}
      : { diagnosticId: descriptorInput.diagnosticId as string }),
  });
}

export type CreateMissingApiKeyAgentRunErrorInput = Omit<
  CreateMissingProviderSettingAgentRunErrorInput,
  'field'
>;

export function createMissingApiKeyAgentRunError(
  input: CreateMissingApiKeyAgentRunErrorInput,
): AgentRunError {
  const state: DescriptorReadState = { seen: new Set(), nodes: 0, properties: 0 };
  const descriptorInput = readDescriptorRecord(input, state, 1);
  exactKeys(descriptorInput, new Set(['providerId', 'modelId', 'diagnosticId']));
  return createMissingProviderSettingAgentRunError({
    providerId: descriptorInput.providerId as string,
    ...(descriptorInput.modelId === undefined
      ? {}
      : { modelId: descriptorInput.modelId as string }),
    ...(descriptorInput.diagnosticId === undefined
      ? {}
      : { diagnosticId: descriptorInput.diagnosticId as string }),
    field: 'apiKey',
  });
}

/** Fail-closed conversion that never persists raw exception messages/bodies. */
export function agentRunErrorFromUnknown(error: unknown): AgentRunError {
  const extracted = extractAgentRunError(error);
  if (extracted) return extracted;
  if (error instanceof Error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    const message = descriptor && 'value' in descriptor
      ? descriptor.value as unknown
      : undefined;
    if (typeof message === 'string' && message.startsWith('RUNNER_UNAVAILABLE:')) {
      return createAgentRunError({
        code: 'RUNNER_UNAVAILABLE',
        messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.RUNNER_UNAVAILABLE,
        retryable: false,
      });
    }
  }
  return createAgentRunError({
    code: 'INTERNAL',
    messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS.INTERNAL,
    retryable: false,
  });
}

export interface AgentRunPruneOptions {
  finishedBefore: number;
  maxRecords: number;
}

/**
 * Durable lifecycle/idempotency port. `createOrGet` atomically owns the
 * unique `(requestPeerId, requestId)` key, returns an existing record only
 * when its payload digest matches, and rejects payload drift.
 */
export interface AgentRunStateStore {
  createOrGet(record: AgentRunRecord): Promise<AgentRunRecord>;
  get(runId: string): Promise<AgentRunRecord | undefined>;
  /** Indexed replay lookup for the durable idempotency key. */
  getByRequest(requestPeerId: string, requestId: string): Promise<AgentRunRecord | undefined>;
  getByTurn(
    conversationId: string,
    turnId: string,
    requestPeerId: string,
  ): Promise<AgentRunRecord | undefined>;
  /** Atomic lifecycle CAS. Terminal records must never transition again. */
  transition(
    runId: string,
    expectedStates: readonly AgentRunState[],
    next: AgentRunRecord,
    options?: AgentRunTransitionOptions,
  ): Promise<boolean>;
  /** Atomically acquire an expired/unowned active run for one runtime. */
  claimExecution(
    runId: string,
    ownerId: string,
    now: number,
    leaseMs: number,
  ): Promise<AgentRunExecutionLease | undefined>;
  /** Extend a lease only when this owner still holds the exact fence. */
  renewExecution(
    lease: AgentRunExecutionLease,
    now: number,
    leaseMs: number,
  ): Promise<AgentRunExecutionLease | undefined>;
  /** Best-effort early release; a different owner/fence is never disturbed. */
  releaseExecution(lease: AgentRunExecutionLease): Promise<void>;
  listActive(): Promise<AgentRunRecord[]>;
  prune(options: AgentRunPruneOptions): Promise<void>;
}

export class AgentRunRequestConflictError extends Error {
  constructor(requestPeerId: string, requestId: string) {
    super(`Run request payload drift for ${requestPeerId}/${requestId}`);
    this.name = 'AgentRunRequestConflictError';
  }
}

/** Test/embedder fallback. Production hosts should inject a durable store. */
export class MemoryAgentRunStateStore implements AgentRunStateStore {
  private readonly records = new Map<string, AgentRunRecord>();
  private readonly requestIndex = new Map<string, string>();
  private readonly executionLeases = new Map<string, AgentRunExecutionLease>();

  private requestKey(requestPeerId: string, requestId: string): string {
    return JSON.stringify([requestPeerId, requestId]);
  }

  async createOrGet(record: AgentRunRecord): Promise<AgentRunRecord> {
    const normalized = cloneAgentRunRecord(record);
    const key = this.requestKey(normalized.requestPeerId, normalized.requestId);
    const existingId = this.requestIndex.get(key);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (!existing) throw new Error(`Run request index is corrupt: ${existingId}`);
      if (existing.payloadDigest !== normalized.payloadDigest) {
        throw new AgentRunRequestConflictError(normalized.requestPeerId, normalized.requestId);
      }
      return cloneAgentRunRecord(existing);
    }
    this.records.set(normalized.runId, normalized);
    this.requestIndex.set(key, normalized.runId);
    return cloneAgentRunRecord(normalized);
  }

  async get(runId: string): Promise<AgentRunRecord | undefined> {
    const record = this.records.get(runId);
    return record ? cloneAgentRunRecord(record) : undefined;
  }

  async getByRequest(
    requestPeerId: string,
    requestId: string,
  ): Promise<AgentRunRecord | undefined> {
    const runId = this.requestIndex.get(this.requestKey(requestPeerId, requestId));
    if (!runId) return undefined;
    const record = this.records.get(runId);
    if (!record) throw new Error(`Run request index is corrupt: ${runId}`);
    return cloneAgentRunRecord(record);
  }

  async getByTurn(
    conversationId: string,
    turnId: string,
    requestPeerId: string,
  ): Promise<AgentRunRecord | undefined> {
    const record = [...this.records.values()].find(candidate =>
      candidate.conversationId === conversationId &&
      candidate.turnId === turnId &&
      candidate.requestPeerId === requestPeerId
    );
    return record ? cloneAgentRunRecord(record) : undefined;
  }

  async transition(
    runId: string,
    expectedStates: readonly AgentRunState[],
    record: AgentRunRecord,
    options: AgentRunTransitionOptions = {},
  ): Promise<boolean> {
    const normalized = cloneAgentRunRecord(record);
    const existing = this.records.get(record.runId);
    if (!existing || runId !== record.runId || !expectedStates.includes(existing.state)) return false;
    const legalNext: Record<'accepted' | 'queued' | 'running', readonly AgentRunState[]> = {
      accepted: ['queued', 'failed', 'cancelled'],
      queued: ['running', 'failed', 'cancelled'],
      running: ['completed', 'failed', 'cancelled'],
    };
    if (
      (existing.state === 'completed' || existing.state === 'failed' || existing.state === 'cancelled') ||
      !legalNext[existing.state].includes(record.state)
    ) return false;
    if (
      existing.requestPeerId !== record.requestPeerId ||
      existing.requestId !== record.requestId ||
      existing.payloadDigest !== record.payloadDigest ||
      existing.retrySourceTurnId !== record.retrySourceTurnId ||
      existing.conversationId !== record.conversationId ||
      existing.definitionId !== record.definitionId ||
      existing.turnId !== record.turnId
    ) {
      throw new Error(`Cannot change immutable run identity: ${record.runId}`);
    }
    // Lifecycle mutations are the durable hand-off boundary.  Do not make
    // the fence merely advisory: an old runtime must not be able to advance
    // or finish a run after another runtime has taken it over.
    if (record.state !== 'cancelled' && !this.hasCurrentExecutionLease(runId, options.executionLease)) {
      return false;
    }
    this.records.set(record.runId, normalized);
    if (record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled') {
      this.executionLeases.delete(record.runId);
    }
    this.requestIndex.set(this.requestKey(record.requestPeerId, record.requestId), record.runId);
    return true;
  }

  async claimExecution(
    runId: string,
    ownerId: string,
    now: number,
    leaseMs: number,
  ): Promise<AgentRunExecutionLease | undefined> {
    const record = this.records.get(runId);
    if (!record || !isActiveAgentRunState(record.state)) return undefined;
    const existing = this.executionLeases.get(runId);
    if (existing && existing.expiresAt > now && existing.ownerId !== ownerId) return undefined;
    const lease: AgentRunExecutionLease = {
      runId,
      ownerId,
      fencingEpoch: existing && existing.ownerId === ownerId && existing.expiresAt > now
        ? existing.fencingEpoch
        : (existing?.fencingEpoch ?? 0) + 1,
      expiresAt: now + leaseMs,
    };
    this.executionLeases.set(runId, lease);
    return { ...lease };
  }

  async renewExecution(
    lease: AgentRunExecutionLease,
    now: number,
    leaseMs: number,
  ): Promise<AgentRunExecutionLease | undefined> {
    const record = this.records.get(lease.runId);
    const existing = this.executionLeases.get(lease.runId);
    if (
      !record ||
      !isActiveAgentRunState(record.state) ||
      !existing ||
      existing.ownerId !== lease.ownerId ||
      existing.fencingEpoch !== lease.fencingEpoch ||
      existing.expiresAt <= now
    ) return undefined;
    const renewed = { ...existing, expiresAt: now + leaseMs };
    this.executionLeases.set(lease.runId, renewed);
    return { ...renewed };
  }

  async releaseExecution(lease: AgentRunExecutionLease): Promise<void> {
    const existing = this.executionLeases.get(lease.runId);
    if (
      existing?.ownerId === lease.ownerId &&
      existing.fencingEpoch === lease.fencingEpoch
    ) this.executionLeases.delete(lease.runId);
  }

  async listActive(): Promise<AgentRunRecord[]> {
    return [...this.records.values()]
      .filter(record => record.state === 'accepted' || record.state === 'queued' || record.state === 'running')
      .map(record => cloneAgentRunRecord(record));
  }

  async prune(options: AgentRunPruneOptions): Promise<void> {
    for (const [runId, record] of this.records) {
      if (record.finishedAt !== undefined && record.finishedAt < options.finishedBefore) {
        this.deleteRecord(runId, record);
      }
    }
    const terminal = [...this.records.values()]
      .filter(record => record.finishedAt !== undefined)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.records.size > options.maxRecords && terminal.length > 0) {
      const record = terminal.shift();
      if (record) this.deleteRecord(record.runId, record);
    }
  }

  private deleteRecord(runId: string, record: AgentRunRecord): void {
    this.records.delete(runId);
    this.requestIndex.delete(this.requestKey(record.requestPeerId, record.requestId));
    this.executionLeases.delete(runId);
  }

  private hasCurrentExecutionLease(
    runId: string,
    lease: AgentRunExecutionLease | undefined,
  ): boolean {
    if (!lease || lease.runId !== runId || lease.expiresAt <= Date.now()) return false;
    const existing = this.executionLeases.get(runId);
    return existing?.ownerId === lease.ownerId &&
      existing.fencingEpoch === lease.fencingEpoch &&
      existing.expiresAt === lease.expiresAt;
  }
}

function isActiveAgentRunState(state: AgentRunState): boolean {
  return state === 'accepted' || state === 'queued' || state === 'running';
}

function cloneAgentRunRecord(record: AgentRunRecord): AgentRunRecord {
  return {
    ...record,
    ...(record.error ? { error: normalizeAgentRunError(record.error) } : {}),
  };
}
