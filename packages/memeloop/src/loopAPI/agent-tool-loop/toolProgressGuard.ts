import { domainSeparatedCanonicalJsonBytes } from '../../encoding/canonicalJson.js';
import { portableSha256Hex, type Sha256HexProvider } from '../../storage/atomicAgentRetry.js';

const DEFAULT_EXACT_REPEAT_THRESHOLD = 3;
const MAX_GUARD_THRESHOLD = 1_024;

export interface ToolProgressCall {
  readonly toolId: string;
  readonly parameters: unknown;
}

export interface ToolProgressGuardState {
  readonly recentExactBatchSignatures: string[];
  lastToolIdBatchSignature?: string;
  consecutiveUnprogressedBatches: number;
  lastProgressFingerprint?: string;
}

export interface ToolProgressGuardOptions {
  exactRepeatThreshold?: number;
  sameToolWithoutProgressThreshold?: number;
  sha256Hex?: Sha256HexProvider;
  signal?: AbortSignal;
}

export type ToolProgressGuardDecision =
  | { blocked: false }
  | { blocked: true; reason: 'exact-repeat' | 'same-tool-without-progress'; message: string };

export function createToolProgressGuardState(): ToolProgressGuardState {
  return {
    recentExactBatchSignatures: [],
    consecutiveUnprogressedBatches: 0,
  };
}

export async function fingerprintToolCalls(
  calls: readonly ToolProgressCall[],
  sha256Hex: Sha256HexProvider = portableSha256Hex,
  signal?: AbortSignal,
): Promise<string> {
  return digestCanonical(
    'memeloop-tool-call-batch-v2',
    calls.map(call => ({
      parameters: call.parameters,
      toolId: call.toolId,
    })),
    sha256Hex,
    signal,
  );
}

export async function observeToolProgress(
  state: ToolProgressGuardState,
  observation: unknown,
  options: Pick<ToolProgressGuardOptions, 'sha256Hex' | 'signal'> = {},
): Promise<void> {
  const fingerprint = await digestCanonical(
    'memeloop-tool-progress-v1',
    observation,
    options.sha256Hex ?? portableSha256Hex,
    options.signal,
  );
  if (
    state.lastProgressFingerprint !== undefined &&
    state.lastProgressFingerprint !== fingerprint
  ) {
    state.consecutiveUnprogressedBatches = 0;
  }
  state.lastProgressFingerprint = fingerprint;
}

export async function evaluateToolProgressGuard(
  state: ToolProgressGuardState,
  calls: readonly ToolProgressCall[],
  options: ToolProgressGuardOptions = {},
): Promise<ToolProgressGuardDecision> {
  const exactThreshold = resolveThreshold(
    options.exactRepeatThreshold,
    DEFAULT_EXACT_REPEAT_THRESHOLD,
    'exactRepeatThreshold',
  );
  const sameToolThreshold = resolveThreshold(
    options.sameToolWithoutProgressThreshold,
    Math.min(MAX_GUARD_THRESHOLD, Math.max(8, exactThreshold * 3)),
    'sameToolWithoutProgressThreshold',
  );
  if (sameToolThreshold <= exactThreshold) {
    throw new TypeError('sameToolWithoutProgressThreshold must exceed exactRepeatThreshold');
  }
  if (calls.length === 0) return { blocked: false };

  const sha256Hex = options.sha256Hex ?? portableSha256Hex;
  const exactSignature = await fingerprintToolCalls(calls, sha256Hex, options.signal);
  const toolIdSignature = await digestCanonical(
    'memeloop-tool-id-batch-v1',
    calls.map(call => call.toolId),
    sha256Hex,
    options.signal,
  );
  // Do not partially advance guard state if either provider call fails or the
  // run is cancelled between digests.
  options.signal?.throwIfAborted();
  state.recentExactBatchSignatures.push(exactSignature);
  if (state.recentExactBatchSignatures.length > exactThreshold) {
    state.recentExactBatchSignatures.splice(
      0,
      state.recentExactBatchSignatures.length - exactThreshold,
    );
  }

  if (state.lastToolIdBatchSignature === toolIdSignature) {
    state.consecutiveUnprogressedBatches += 1;
  } else {
    state.lastToolIdBatchSignature = toolIdSignature;
    state.consecutiveUnprogressedBatches = 1;
  }

  if (
    state.recentExactBatchSignatures.length === exactThreshold &&
    state.recentExactBatchSignatures.every(signature => signature === exactSignature)
  ) {
    return {
      blocked: true,
      reason: 'exact-repeat',
      message: `Blocked by doom-loop guard: the model repeated the same tool call batch ${exactThreshold} times.`,
    };
  }
  if (state.consecutiveUnprogressedBatches >= sameToolThreshold) {
    return {
      blocked: true,
      reason: 'same-tool-without-progress',
      message: `Blocked by doom-loop guard: the model used the same tool batch ${sameToolThreshold} times without observable progress.`,
    };
  }
  return { blocked: false };
}

function resolveThreshold(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 2 || resolved > MAX_GUARD_THRESHOLD) {
    throw new TypeError(`${field} must be a safe integer between 2 and ${MAX_GUARD_THRESHOLD}`);
  }
  return resolved;
}

async function digestCanonical(
  domain: string,
  value: unknown,
  sha256Hex: Sha256HexProvider,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const bytes = domainSeparatedCanonicalJsonBytes(domain, value, {
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringCodeUnits: 512 * 1_024,
    maxStringBytes: 512 * 1_024,
    maxBytes: 1_048_576,
  });
  let digest: string;
  try {
    digest = await sha256Hex(bytes, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  if (!/^[\da-f]{64}$/u.test(digest)) {
    throw new Error('tool_progress_sha256_invalid_digest');
  }
  return digest;
}
