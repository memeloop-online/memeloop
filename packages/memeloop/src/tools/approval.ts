import { canonicalJsonString } from '../encoding/canonicalJson.js';
import { sha256HexSync } from '../encoding/sha256.js';
import type { ApprovalDecision, ToolApprovalConfig, ToolApprovalRequest, ToolApprovalRequestInput } from './types.js';

const MAX_APPROVAL_PARAMETER_BYTES = 64 * 1024;
const MAX_APPROVAL_TEXT_BYTES = 64 * 1024;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const textEncoder = new TextEncoder();

export interface ToolApprovalPrincipal {
  runtimeId: string;
  runId: string;
  conversationId: string;
  agentId: string;
  toolName: string;
  parameterDigest: string;
}

export interface ToolApprovalResolution extends ToolApprovalPrincipal {
  approvalId: string;
  decision: 'allow' | 'deny';
}

export interface ToolApprovalBrokerOptions {
  runtimeId: string;
  onListenerError?: (error: unknown, request: ToolApprovalRequest) => void;
  /** Receives failures thrown by the listener-error observer itself. */
  onListenerErrorFailure?: (error: unknown, request: ToolApprovalRequest) => void;
}

export interface RequestToolApprovalOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingApproval {
  request: ToolApprovalRequest;
  resolve: (decision: 'allow' | 'deny') => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
}

export class ToolApprovalCollisionError extends Error {
  constructor(approvalId: string) {
    super(`Tool approval ID is already pending: ${approvalId}`);
    this.name = 'ToolApprovalCollisionError';
  }
}

/** Runtime-scoped, principal-bound tool approval lifecycle. */
export class ToolApprovalBroker {
  public readonly runtimeId: string;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(request: ToolApprovalRequest) => void>();
  private disposed = false;

  constructor(private readonly options: ToolApprovalBrokerOptions) {
    this.runtimeId = boundedId(options.runtimeId, 'runtimeId');
  }

  public onApprovalRequest(listener: (request: ToolApprovalRequest) => void): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public requestApproval(
    request: ToolApprovalRequestInput,
    options: RequestToolApprovalOptions = {},
  ): Promise<'allow' | 'deny'> {
    this.assertActive();
    validateRequest(request, this.runtimeId);
    const parameterSnapshot = snapshotParameters(request.parameters);
    const storedRequest: ToolApprovalRequest = Object.freeze({
      ...request,
      parameters: parameterSnapshot.parameters,
      parameterDigest: parameterSnapshot.digest,
      created: new Date(request.created),
    });
    if (this.pending.has(request.approvalId)) {
      throw new ToolApprovalCollisionError(request.approvalId);
    }
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 ||
      timeoutMs > MAX_APPROVAL_TIMEOUT_MS
    ) {
      throw new TypeError('Tool approval timeoutMs is outside the supported range');
    }
    if (options.signal?.aborted) return Promise.resolve('deny');

    return new Promise<'allow' | 'deny'>((resolve) => {
      const pending: PendingApproval = {
        request: storedRequest,
        resolve,
        signal: options.signal,
        settled: false,
      };
      this.pending.set(request.approvalId, pending);
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => this.settle(pending, 'deny'), timeoutMs);
      }
      if (options.signal) {
        pending.abortListener = () => this.settle(pending, 'deny');
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      for (const listener of this.listeners) {
        const listenerRequest = cloneRequest(pending.request);
        try {
          listener(listenerRequest);
        } catch (error) {
          try {
            this.options.onListenerError?.(error, cloneRequest(pending.request));
          } catch (observerError) {
            // Keep the approval promise pending even when the diagnostic hook
            // itself fails; give hosts a second, independent sink when they
            // need to retain that failure.
            this.options.onListenerErrorFailure?.(
              observerError,
              cloneRequest(pending.request),
            );
          }
        }
      }
    });
  }

  public resolveApproval(resolution: ToolApprovalResolution): boolean {
    const pending = this.pending.get(resolution.approvalId);
    if (!pending || !samePrincipal(pending.request, resolution)) return false;
    return this.settle(pending, resolution.decision);
  }

  public getPendingApprovals(): ToolApprovalRequest[] {
    return [...this.pending.values()].map(({ request }) => cloneRequest(request));
  }

  public cancelPendingApprovals(principal: Partial<Omit<ToolApprovalPrincipal, 'runtimeId'>>): number {
    let cancelled = 0;
    for (const pending of [...this.pending.values()]) {
      if (matchesPartialPrincipal(pending.request, principal) && this.settle(pending, 'deny')) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of [...this.pending.values()]) this.settle(pending, 'deny');
    this.listeners.clear();
  }

  private settle(pending: PendingApproval, decision: 'allow' | 'deny'): boolean {
    if (pending.settled || this.pending.get(pending.request.approvalId) !== pending) return false;
    pending.settled = true;
    this.pending.delete(pending.request.approvalId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    pending.resolve(decision);
    return true;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Tool approval broker is disposed');
  }
}

export function evaluateApproval(
  approval: ToolApprovalConfig | undefined,
  toolName: string,
  parameters: Record<string, unknown>,
): ApprovalDecision {
  let callContent: string;
  try {
    const snapshot = snapshotParameters(parameters);
    callContent = canonicalJsonString(
      { tool: toolName, parameters: snapshot.parameters },
      approvalCanonicalLimits(),
    );
  } catch {
    return 'deny';
  }
  if (!approval || approval.mode === 'auto') return 'allow';
  for (const pattern of approval.denyPatterns ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(callContent)) return 'deny';
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  for (const pattern of approval.allowPatterns ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(callContent)) return 'allow';
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return 'pending';
}

function validateRequest(request: ToolApprovalRequestInput, runtimeId: string): void {
  if (request.runtimeId !== runtimeId) throw new Error('Tool approval runtime principal mismatch');
  boundedId(request.approvalId, 'approvalId');
  boundedId(request.runId, 'runId');
  boundedId(request.conversationId, 'conversationId');
  boundedId(request.agentId, 'agentId');
  boundedId(request.toolName, 'toolName');
  if (!request.parameters || typeof request.parameters !== 'object' || Array.isArray(request.parameters)) {
    throw new TypeError('Tool approval parameters must be an object');
  }
  if (!(request.created instanceof Date) || !Number.isFinite(request.created.getTime())) {
    throw new TypeError('Tool approval created must be a valid Date');
  }
  if (
    request.originalText !== undefined && (
      typeof request.originalText !== 'string' ||
      textEncoder.encode(request.originalText).byteLength > MAX_APPROVAL_TEXT_BYTES
    )
  ) throw new TypeError('Tool approval originalText is invalid');
}

function boundedId(value: string, field: string): string {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 1_024 ||
    value !== value.trim() || hasControlCharacters(value) ||
    textEncoder.encode(value).byteLength > 1_024
  ) {
    throw new TypeError(`Tool approval ${field} is invalid`);
  }
  return value;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit === 0x7f) return true;
  }
  return false;
}

function samePrincipal(left: ToolApprovalPrincipal, right: ToolApprovalPrincipal): boolean {
  return left.runtimeId === right.runtimeId && left.runId === right.runId &&
    left.conversationId === right.conversationId && left.agentId === right.agentId &&
    left.toolName === right.toolName && left.parameterDigest === right.parameterDigest;
}

function matchesPartialPrincipal(
  request: ToolApprovalPrincipal,
  principal: Partial<Omit<ToolApprovalPrincipal, 'runtimeId'>>,
): boolean {
  return Object.entries(principal).every(([key, value]) => value === undefined || request[key as keyof ToolApprovalPrincipal] === value);
}

function approvalCanonicalLimits() {
  return {
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringCodeUnits: MAX_APPROVAL_PARAMETER_BYTES,
    maxStringBytes: MAX_APPROVAL_PARAMETER_BYTES,
    maxBytes: MAX_APPROVAL_PARAMETER_BYTES,
  } as const;
}

function snapshotParameters(parameters: Record<string, unknown>): {
  parameters: Readonly<Record<string, unknown>>;
  digest: string;
} {
  const canonical = canonicalJsonString(parameters, approvalCanonicalLimits());
  const detached = JSON.parse(canonical) as Record<string, unknown>;
  return {
    parameters: deepFreeze(detached),
    digest: `sha256:${sha256HexSync(textEncoder.encode(canonical))}`,
  };
}

function cloneRequest(request: ToolApprovalRequest): ToolApprovalRequest {
  return Object.freeze({
    ...request,
    parameters: request.parameters,
    created: new Date(request.created),
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
