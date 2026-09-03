import { createHash, randomBytes } from 'node:crypto';

import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  type AgentFrameworkContext,
  type AgentLoopStep,
  type AgentRunResource,
  type AgentWorkloadResource,
  consumeWorkloadCapabilityGrant,
  type ControlStore,
  createManagedWorkerIdentityAdapter,
  type IdentityAttestationManagementDriver,
  issueWorkloadCapabilityGrant,
  markWorkloadCapabilityGrantUnknownEffect,
  OrchestrationError,
  parseWorkerCheckpointLoadPayload,
  parseWorkerCheckpointSavePayload,
  verifyWorkloadCapabilityGrant,
  type WorkerGatewaySession,
  type WorkerProtocolMethod,
} from 'memeloop';

import { loadOrCreateWorkerGatewayKeyPair, type NodeWorkerGatewayKeyPair, verifyWorkerEd25519Signature } from '../orchestration/nodeWorkerSecurity.js';
import { createWorkerArtifactUploadStore, type WorkerArtifactUploadStore, type WorkerArtifactUploadStoreOptions } from '../orchestration/workerArtifactUploadStore.js';
import { WorkerAssignmentResolutionCache } from '../orchestration/workerAssignmentResolutionCache.js';
import {
  createWorkerGatewayHttpHandler,
  type WorkerGatewayHttpHandler,
  type WorkerGatewayHttpHandlerOptions as HttpHandlerOptions,
} from '../orchestration/workerGatewayHttpHandler.js';
import { createDriverRequestBuilder } from './envelopeBuilders.js';

type RuntimeChildAgent = NonNullable<AgentFrameworkContext['runChildAgent']>;

/** Runtime-owned worker gateway configuration (kept independent of NodeRuntimeOptions). */
export interface WorkerGatewayRuntimeConfig {
  enabled?: boolean;
  publicUrl?: string;
  caCertificate?: string;
  sessionTtlMs?: number;
  maxRequestsPerMinute?: number;
  methodRequestsPerMinute?: Partial<Record<WorkerProtocolMethod, number>>;
  artifacts?: WorkerArtifactUploadStoreOptions;
}

export interface WorkerGatewayAuditSink {
  onAudit: NonNullable<HttpHandlerOptions['onAudit']>;
}

export interface WorkerGatewayRuntimeOptions {
  controlStore: ControlStore;
  dataDir: string;
  nodeId: string;
  sessionTtlMs: number;
  config?: WorkerGatewayRuntimeConfig;
  runtime: { runChildAgent: RuntimeChildAgent };
  loopCheckpoints: NonNullable<AgentFrameworkContext['loopCheckpoints']> | undefined;
  /** Resolve the current checkpoint port for hosts that can reconfigure it at runtime. */
  getLoopCheckpoints?: () => NonNullable<AgentFrameworkContext['loopCheckpoints']> | undefined;
  logger: NonNullable<AgentFrameworkContext['logger']>;
  audit?: WorkerGatewayAuditSink;
}

export interface WorkerGatewayRuntimeResult {
  /** Close gateway-owned artifact state during runtime teardown. */
  close(): Promise<void>;
  handler: WorkerGatewayHttpHandler;
  publicKey: string;
  publicKeyFingerprint: string;
  keys: NodeWorkerGatewayKeyPair;
  identityDriver: IdentityAttestationManagementDriver;
  artifacts: Pick<
    WorkerArtifactUploadStore,
    'resolveManifest' | 'openArtifact' | 'readArtifact' | 'deleteArtifact' | 'deleteArtifactsForRun'
  >;
}

function childAgentStepText(step: AgentLoopStep): string | undefined {
  if (step.type !== 'message') return undefined;
  if (typeof step.data === 'string') return step.data;
  if (!step.data || typeof step.data !== 'object') return undefined;
  if ((step.data as { type?: unknown }).type === 'text-delta') {
    const text = (step.data as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }
  if ('content' in step.data) {
    const content = (step.data as { content?: unknown }).content;
    return typeof content === 'string' ? content : undefined;
  }
  return undefined;
}

interface ResolvedWorkerAssignment {
  run: AgentRunResource;
  workload: AgentWorkloadResource;
  conversationId: string;
}

function externalWorkerConversationId(workload: AgentWorkloadResource): string {
  return `external:${workload.metadata.namespace ?? 'default'}:${workload.metadata.uid}`;
}

async function resolveWorkerAssignment(
  store: ControlStore,
  cache: WorkerAssignmentResolutionCache<ResolvedWorkerAssignment>,
  session: WorkerGatewaySession,
): Promise<ResolvedWorkerAssignment> {
  const resolveUncached = async (): Promise<ResolvedWorkerAssignment> => {
    let run: AgentRunResource | undefined;
    let continueToken: string | undefined;
    const observedTokens = new Set<string>();
    for (let pageIndex = 0; pageIndex < 100 && !run; pageIndex += 1) {
      const page = await store.list<AgentRunResource['spec'], AgentRunResource['status']>(
        { apiVersion: AGENT_RUN_API_VERSION, kind: AGENT_RUN_KIND },
        { limit: 50, ...(continueToken ? { continueToken } : {}) },
      );
      run = page.items.find(candidate => candidate.metadata.uid === session.run.uid);
      if (run || !page.continueToken) break;
      if (page.continueToken === continueToken || observedTokens.has(page.continueToken)) {
        throw new OrchestrationError({
          code: 'UNAVAILABLE',
          message: 'worker assignment pagination did not advance',
          retryable: true,
        });
      }
      observedTokens.add(page.continueToken);
      continueToken = page.continueToken;
    }
    if (!run) {
      throw new OrchestrationError({
        code: 'NOT_FOUND',
        message: 'worker assignment Run is unavailable',
        retryable: false,
      });
    }
    const workload = await store.get<AgentWorkloadResource['spec'], AgentWorkloadResource['status']>({
      apiVersion: run.spec.workloadRef.apiVersion,
      kind: run.spec.workloadRef.kind,
      name: run.spec.workloadRef.name,
      namespace: run.spec.workloadRef.namespace ?? run.metadata.namespace,
    });
    if (!workload || workload.metadata.uid !== run.spec.workloadRef.uid) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'worker assignment workload identity is unavailable',
        retryable: false,
      });
    }
    return { run, workload, conversationId: externalWorkerConversationId(workload) };
  };
  return cache.getOrCreate(
    session.name,
    new Date(session.expiresAt).getTime(),
    resolveUncached,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workerRequestShape(value: unknown): {
  kind?: unknown;
  input?: { profileId?: unknown; profile?: unknown; prompt?: unknown };
} {
  if (!isRecord(value)) return {};
  const record = value;
  const inputValue = record.input;
  if (inputValue === null || typeof inputValue !== 'object' || Array.isArray(inputValue)) {
    return { kind: record.kind };
  }
  const input = inputValue as Record<string, unknown>;
  return {
    kind: record.kind,
    input: {
      profileId: input.profileId,
      profile: input.profile,
      prompt: input.prompt,
    },
  };
}

/** Build the worker gateway and all gateway-owned identity/artifact adapters. */
export function createWorkerGatewayRuntime(
  options: WorkerGatewayRuntimeOptions,
): WorkerGatewayRuntimeResult {
  const keys = loadOrCreateWorkerGatewayKeyPair(options.dataDir);
  const actor = {
    id: `controller/worker-gateway-${options.nodeId}`,
    kind: 'controller' as const,
  };
  const workerArtifactUploads = createWorkerArtifactUploadStore(
    options.dataDir,
    options.config?.artifacts,
  );
  const identityCapability = `capability:identity:${randomBytes(32).toString('hex')}`;
  const identitySession = `node-identity:${options.nodeId}:${randomBytes(16).toString('hex')}`;
  const buildIdentityRequest = createDriverRequestBuilder({
    actor,
    sessionId: identitySession,
    capabilityHandleRef: identityCapability,
    controller: 'identity',
    deadlineMs: 60_000,
  });
  const identityRoute = createManagedWorkerIdentityAdapter({
    store: options.controlStore,
    actor,
    name: `${options.nodeId}-worker-ed25519-identity`,
    authorizeRequest: request =>
      request.capabilityHandleRef === identityCapability &&
      request.session?.id === identitySession,
    createRequest: input =>
      buildIdentityRequest({
        method: input.method,
        payload: input.payload,
        resource: input.enrollment,
        fencingEpoch: input.enrollment.metadata.generation,
        idempotencyKey: input.idempotencyKey,
        payloadSchema: {
          apiVersion: `drivers.memeloop.io/${input.method}/v1alpha1`,
          fields: input.payloadFields,
        },
      }),
    maxSessionTtlMs: options.sessionTtlMs,
    threatAssumptions: [
      'the WorkerEnrollment controller, bootstrap-token verifier, gateway key, and Ed25519 verifier are trusted',
      'pending raw bootstrap material exists only for the duration of one HTTP request',
      'the adapter proves key possession and channel binding, not hardware measured boot',
    ],
  });
  const assignmentCache = new WorkerAssignmentResolutionCache<ResolvedWorkerAssignment>();
  const handlerOptions: HttpHandlerOptions = {
    store: options.controlStore,
    actor,
    gatewayKeyFingerprint: keys.publicKeyFingerprint,
    signBootstrap: message => keys.sign(message),
    bindSession: (enrollmentName, request) => identityRoute.bindWorkerSession(enrollmentName, request),
    maxSessionTtlMs: options.sessionTtlMs,
    ...(options.config?.maxRequestsPerMinute === undefined
      ? {}
      : { maxRequestsPerMinute: options.config.maxRequestsPerMinute }),
    ...(options.config?.methodRequestsPerMinute === undefined
      ? {}
      : { methodRequestsPerMinute: options.config.methodRequestsPerMinute }),
    async dispatch({ requestId, session, method, target, payload, signal }) {
      signal.throwIfAborted();
      if (method === 'assignment.pull') {
        const assignment = await resolveWorkerAssignment(options.controlStore, assignmentCache, session);
        if (!assignment.workload.spec.profileId) {
          throw new OrchestrationError({
            code: 'UNSUPPORTED',
            message: 'worker assignment is not a profile workload',
            retryable: false,
          });
        }
        return {
          profileId: assignment.workload.spec.profileId,
          conversationId: assignment.conversationId,
          prompt: assignment.run.spec.promptReference ??
            assignment.workload.spec.promptReference ??
            assignment.workload.metadata.name,
        };
      }
      if (method === 'artifact.upload') {
        return workerArtifactUploads.handle(session, payload, signal);
      }
      if (method === 'checkpoint.load' || method === 'checkpoint.save') {
        const checkpoints = options.getLoopCheckpoints
          ? options.getLoopCheckpoints()
          : options.loopCheckpoints;
        if (!checkpoints) {
          throw new OrchestrationError({
            code: 'UNSUPPORTED',
            message: 'durable worker checkpoint storage is unavailable',
            retryable: false,
          });
        }
        if (target !== session.run.uid) {
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: 'worker checkpoint target does not match the bound Run',
            retryable: false,
          });
        }
        const assignment = await resolveWorkerAssignment(options.controlStore, assignmentCache, session);
        const checkpointNamespace = `external-worker:${session.run.uid}:${assignment.conversationId}`;
        if (method === 'checkpoint.load') {
          const request = parseWorkerCheckpointLoadPayload(payload);
          if (request.conversationId !== assignment.conversationId || request.scope.runId !== session.run.uid) {
            throw new OrchestrationError({
              code: 'FORBIDDEN',
              message: 'worker checkpoint identity does not match the bound assignment',
              retryable: false,
            });
          }
          signal.throwIfAborted();
          const record = checkpoints.loadCheckpointRecord
            ? await checkpoints.loadCheckpointRecord(checkpointNamespace, request.key, { scope: request.scope })
            : undefined;
          const value = record?.result ?? await checkpoints.loadCheckpoint(checkpointNamespace, request.key, { scope: request.scope });
          signal.throwIfAborted();
          return value === undefined
            ? { found: false, nextExpectedRevision: 0, fencingEpoch: 0, scope: request.scope }
            : {
              found: true,
              value,
              revision: record?.revision ?? 1,
              fencingEpoch: record?.fencingEpoch ?? 0,
              scope: request.scope,
            };
        }
        const request = parseWorkerCheckpointSavePayload(payload);
        if (request.conversationId !== assignment.conversationId || request.scope.runId !== session.run.uid) {
          throw new OrchestrationError({
            code: 'FORBIDDEN',
            message: 'worker checkpoint identity does not match the bound assignment',
            retryable: false,
          });
        }
        signal.throwIfAborted();
        await checkpoints.saveCheckpoint(checkpointNamespace, request.key, request.value, {
          scope: request.scope,
          expectedRevision: request.expectedRevision,
          fencingEpoch: request.fencingEpoch,
        });
        signal.throwIfAborted();
        const saved = checkpoints.loadCheckpointRecord
          ? await checkpoints.loadCheckpointRecord(checkpointNamespace, request.key, { scope: request.scope })
          : undefined;
        return {
          saved: true,
          revision: saved?.revision ?? request.expectedRevision + 1,
          fencingEpoch: saved?.fencingEpoch ?? request.fencingEpoch,
        };
      }
      if (method !== 'capability.request') {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `worker method '${method}' is not configured on this host`,
          retryable: false,
        });
      }
      const request = workerRequestShape(payload);
      const profileId = typeof request.input?.profileId === 'string'
        ? request.input.profileId
        : typeof request.input?.profile === 'string'
        ? request.input.profile
        : undefined;
      if (
        request.kind !== 'runAgent' ||
        !profileId ||
        typeof request.input?.prompt !== 'string' ||
        profileId.length > 256 ||
        request.input.prompt.length > 16_384
      ) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'worker runAgent capability request is malformed',
          retryable: false,
        });
      }
      const grantId = `cap-${
        createHash('sha256')
          .update(`${session.name}\0${requestId}`, 'utf8')
          .digest('hex')
          .slice(0, 40)
      }`;
      const channelBinding = `gateway-key:${keys.publicKeyFingerprint}`;
      const grant = await issueWorkloadCapabilityGrant(
        options.controlStore,
        actor,
        {
          grantId,
          session,
          channelBinding,
          protocolMethod: 'capability.request',
          capability: 'runAgent',
          target,
          budget: {
            maxRequests: 1,
            maxInputBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
            maxOutputBytes: 256 * 1024,
          },
          ttlMs: 60_000,
        },
        message => keys.sign(message),
      );
      await verifyWorkloadCapabilityGrant(
        grant,
        {
          grantId,
          sessionName: session.name,
          run: session.run,
          workerKeyFingerprint: session.workerKeyFingerprint,
          channelBinding,
          audience: session.audience,
          protocol: session.protocol,
          protocolMethod: 'capability.request',
          capability: 'runAgent',
          target,
          policyDigest: session.policyDigest,
        },
        (message, signature) => verifyWorkerEd25519Signature(keys.publicKey, message, signature),
      );
      signal.throwIfAborted();
      const consumedGrant = await consumeWorkloadCapabilityGrant(options.controlStore, actor, grant);
      const assignment = await resolveWorkerAssignment(options.controlStore, assignmentCache, session);
      const steps: AgentLoopStep[] = [];
      let text = '';
      let executionObserved = false;
      try {
        for await (
          const step of options.runtime.runChildAgent({
            profileId,
            prompt: request.input.prompt,
            conversationId: assignment.conversationId,
            signal,
          })
        ) {
          steps.push(step);
          text += childAgentStepText(step) ?? '';
          if (Buffer.byteLength(JSON.stringify({ steps, text }), 'utf8') > 256 * 1024) {
            throw new OrchestrationError({
              code: 'EXHAUSTED',
              message: 'worker child-agent response exceeds 256 KiB',
              retryable: false,
            });
          }
        }
        signal.throwIfAborted();
        executionObserved = true;
        return {
          profileId,
          conversationId: assignment.conversationId,
          steps,
          text,
        };
      } catch (error) {
        if (signal.aborted && !executionObserved) {
          try {
            await markWorkloadCapabilityGrantUnknownEffect(
              options.controlStore,
              actor,
              consumedGrant,
              signal.reason instanceof Error ? signal.reason.message : 'worker execution was cancelled',
            );
          } catch (markError) {
            options.logger.warn?.('worker capability grant outcome became unknown before it could be recorded', markError);
          }
        }
        throw error;
      }
    },
    ...(options.audit ? { onAudit: options.audit.onAudit } : {}),
    onError: error => options.logger.warn?.('worker gateway error', error),
  };
  const handler = createWorkerGatewayHttpHandler(handlerOptions);
  return {
    close: () => workerArtifactUploads.close(),
    handler,
    publicKey: keys.publicKey,
    publicKeyFingerprint: keys.publicKeyFingerprint,
    keys,
    identityDriver: identityRoute.driver,
    artifacts: {
      resolveManifest: (...arguments_) => workerArtifactUploads.resolveManifest(...arguments_),
      openArtifact: (...arguments_) => workerArtifactUploads.openArtifact(...arguments_),
      readArtifact: (...arguments_) => workerArtifactUploads.readArtifact(...arguments_),
      deleteArtifact: (...arguments_) => workerArtifactUploads.deleteArtifact(...arguments_),
      deleteArtifactsForRun: (...arguments_) => workerArtifactUploads.deleteArtifactsForRun(...arguments_),
    },
  };
}
