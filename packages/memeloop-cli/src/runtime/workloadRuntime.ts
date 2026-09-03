import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  AGENT_RUN_API_VERSION,
  AGENT_RUN_KIND,
  AGENT_WORKLOAD_KIND,
  type AgentFrameworkContext,
  type AgentRunResource,
  type AgentVolumeClaimResource,
  type AgentVolumeResource,
  type AgentWorkloadResource,
  BUILTIN_RUNTIME_CLASSES,
  canDriverSatisfyClass,
  type ControllerRunnerHandle,
  type ControlStore,
  type ControlStoreActor,
  createBindingController,
  createCapacityScheduler,
  createControllerRunner,
  createGatewayMediatedLLMProvider,
  createInProcessLoopRuntimeDriver,
  createManagedLoopRuntimeExecutionRoute,
  createManagedNetworkAdapter,
  createManagedStorageDriverAdapter,
  createModelEndpointBindingController,
  createNetworkAttachmentBindingController,
  createNetworkAttachmentExecutionController,
  createReplicationController,
  createRuntimeClassRoutingDriver,
  createRunVolumeController,
  createVolumeClaimBindingController,
  createVolumeClaimExecutionController,
  createVolumeManifest,
  createWorkloadExecutionController,
  DRIVER_REQUEST_API_VERSION,
  type DriverRequestEnvelope,
  featuresRequiredByClass,
  type ILLMProvider,
  isAgentRun,
  isAgentWorkload,
  isModelClass,
  isModelEndpoint,
  isNetworkAttachment,
  isNetworkClass,
  isStorageClass,
  isVolume,
  isVolumeClaim,
  type LoopRunStartRequest,
  type LoopRuntimeManagementDriver,
  type LoopRuntimePreparePayload,
  MODEL_ENDPOINT_API_VERSION,
  MODEL_ENDPOINT_KIND,
  type ModelAccessHandleBudget,
  modelClassNameForSpec,
  type ModelClassResource,
  type ModelClassSpec,
  type ModelEndpointResource,
  NETWORK_ATTACHMENT_KIND,
  NETWORK_CLASS_API_VERSION,
  NETWORK_CLASS_KIND,
  type NetworkAttachmentNode,
  type NetworkAttachmentResource,
  type NetworkClassResource,
  type NetworkEnforcementLevel,
  type NetworkPreparePayload,
  OrchestrationError,
  type ReplicationNode,
  type ReplicationTransport,
  type SchedulerNode,
  STORAGE_CLASS_API_VERSION,
  STORAGE_CLASS_KIND,
  type StorageClassResource,
  type StorageDriverEndpoint,
  type StorageManagementDriver,
  VOLUME_CLAIM_KIND,
  VOLUME_KIND,
  type WorkloadExecutionControllerHandle,
} from 'memeloop';
import { createFileManagedStorageStateStore, createLocalDirectoryStorageDriver, LOCAL_DIRECTORY_STORAGE_DRIVER_NAME } from '../orchestration/localDirectoryStorageDriver.js';
import type { NodeModelGateway } from '../orchestration/nodeModelGateway.js';
import { createProcessLoopRuntimeDriver } from '../orchestration/processLoopRuntimeDriver.js';
import { createProcessNetworkDriver, PROCESS_NETWORK_DRIVER_NAME } from '../orchestration/processNetworkDriver.js';
import { prepareLinuxProcessSandbox } from '../sandbox/linuxProcessSandbox.js';
import { createDriverRequestBuilder, sha256DriverValue } from './envelopeBuilders.js';
import type { ManagedPolicyRequestFactory } from './toolOperationTypes.js';

export interface WorkloadNetworkAttachmentControllers {
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface WorkloadVolumeControllers {
  binding: ControllerRunnerHandle;
  provisioning: ControllerRunnerHandle;
  publishing: ControllerRunnerHandle;
  replication?: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface WorkloadRuntimeOptions {
  controlStore: ControlStore;
  dataDir?: string;
  workloadExecution?: {
    enabled?: boolean;
    processIsolation?: boolean;
    modelGatewayEndpoint?: string;
    localNode?: Omit<Partial<SchedulerNode>, 'name' | 'trustClass'>;
    listSchedulerNodes?: () => Promise<SchedulerNode[]>;
    listNetworkAttachmentNodes?: () => Promise<NetworkAttachmentNode[]>;
    listStorageDriverEndpoints?: () => Promise<StorageDriverEndpoint[]>;
    storageReplication?: { listNodes(): Promise<ReplicationNode[]>; transport: ReplicationTransport };
    resolveModelProvider?: (endpoint: ModelEndpointResource, request: LoopRunStartRequest) => Promise<ILLMProvider | undefined>;
    resolveModelGatewayEndpoint?: (endpoint: ModelEndpointResource, request: LoopRunStartRequest) => Promise<string | undefined>;
  };
  modelEndpointRegistration?: { staleAfterMs?: number };
  modelGatewayConfig?: { loopBudget?: ModelAccessHandleBudget };
  credentialBroker?: { brokerClass: string; audiences: string[]; targets?: string[] };
  nodeId: string;
  trustClass: import('memeloop').ScriptTrustClass;
  runtime: import('memeloop').MemeLoopRuntime;
  context: AgentFrameworkContext;
  toolRegistry: import('memeloop').IToolRegistry;
  advertisedModels: ModelClassSpec[];
  modelGateway?: NodeModelGateway;
  llmProvider: ILLMProvider;
  scriptArtifactStore?: import('../orchestration/scriptArtifactStore.js').ScriptArtifactStoreReader;
  managedPolicyDriver: import('memeloop').PolicyApprovalManagementDriver;
  createManagedPolicyRequest: ManagedPolicyRequestFactory;
  logger: NonNullable<AgentFrameworkContext['logger']>;
}

export interface WorkloadRuntimeResult {
  bindingControllerRunner?: ControllerRunnerHandle;
  modelEndpointBindingControllerRunner?: ControllerRunnerHandle;
  networkAttachmentControllers?: WorkloadNetworkAttachmentControllers;
  volumeControllers?: WorkloadVolumeControllers;
  managedStorageDriver?: StorageManagementDriver;
  workloadExecutionController?: WorkloadExecutionControllerHandle;
  managedLoopRuntimeDriver?: LoopRuntimeManagementDriver;
}

type ResourceTypeMeta = { apiVersion?: string; kind?: string };

function hasResourceTypeMeta(value: unknown): value is ResourceTypeMeta {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.apiVersion === undefined || typeof candidate.apiVersion === 'string') &&
    (candidate.kind === undefined || typeof candidate.kind === 'string');
}

function narrowResource<T extends ResourceTypeMeta>(
  value: unknown,
  guard: (value: ResourceTypeMeta) => value is T,
): T | undefined {
  return hasResourceTypeMeta(value) && guard(value) ? value : undefined;
}

function managedPolicyForNetworkClass(networkClass: NetworkClassResource): Omit<NetworkPreparePayload['policy'], 'digest'> {
  const spec = networkClass.spec;
  const serviceAllowlist = [
    ...(spec.serviceAccess?.allowControlPlane ? ['control-plane'] : []),
    ...(spec.serviceAccess?.allowClusterServices ? ['cluster-services'] : []),
    ...(spec.serviceAccess?.allowModelGateway ? ['model-gateway'] : []),
  ];
  return {
    ...(spec.dns
      ? {
        dns: {
          policy: spec.dns.policy ?? 'default',
          ...(spec.dns.servers ? { servers: spec.dns.servers } : {}),
        },
      }
      : {}),
    ...(spec.proxy
      ? {
        proxy: {
          ...(spec.proxy.httpProxy ? { httpProxy: spec.proxy.httpProxy } : {}),
          ...(spec.proxy.httpsProxy ? { httpsProxy: spec.proxy.httpsProxy } : {}),
          ...(spec.proxy.noProxy ? { noProxy: spec.proxy.noProxy } : {}),
          ...(spec.proxy.mandatory !== undefined ? { mandatory: spec.proxy.mandatory } : {}),
        },
      }
      : {}),
    ...(serviceAllowlist.length > 0 ? { serviceAllowlist } : {}),
  };
}

export async function createWorkloadRuntime(options: WorkloadRuntimeOptions): Promise<WorkloadRuntimeResult> {
  const {
    controlStore,
    runtime,
    context,
    toolRegistry,
    advertisedModels,
    modelGateway,
    scriptArtifactStore,
    managedPolicyDriver,
    createManagedPolicyRequest,
    logger,
    llmProvider,
  } = options;
  const syncNodeId = options.nodeId;
  const workerTrustClass = options.trustClass;
  let bindingControllerRunner: ControllerRunnerHandle | undefined;
  let modelEndpointBindingControllerRunner: ControllerRunnerHandle | undefined;
  let networkAttachmentControllers: WorkloadNetworkAttachmentControllers | undefined;
  let volumeControllers: WorkloadVolumeControllers | undefined;
  let managedStorageDriver: StorageManagementDriver | undefined;
  let workloadExecutionController: WorkloadExecutionControllerHandle | undefined;
  let managedLoopRuntimeDriver: LoopRuntimeManagementDriver | undefined;
  if (options.workloadExecution?.enabled !== false) {
    const modelBindingActor = {
      id: 'controller/model-endpoint-binding',
      kind: 'controller' as const,
    };
    modelEndpointBindingControllerRunner = await createControllerRunner(
      controlStore,
      createModelEndpointBindingController({
        actor: modelBindingActor,
        async getWorkload(run) {
          const reference = run.spec.workloadRef;
          const resource = narrowResource(
            await controlStore.get<
              AgentWorkloadResource['spec'],
              AgentWorkloadResource['status']
            >({
              apiVersion: reference.apiVersion,
              kind: reference.kind,
              name: reference.name,
              namespace: reference.namespace,
            }),
            isAgentWorkload,
          );
          if (resource && reference.uid && resource.metadata.uid !== reference.uid) return null;
          return resource ?? null;
        },
        async listEndpoints() {
          const result = await controlStore.list<
            ModelEndpointResource['spec'],
            ModelEndpointResource['status']
          >({
            apiVersion: MODEL_ENDPOINT_API_VERSION,
            kind: MODEL_ENDPOINT_KIND,
          });
          return result.items.filter(isModelEndpoint);
        },
        async listRuns() {
          const result = await controlStore.list<
            AgentRunResource['spec'],
            AgentRunResource['status']
          >({
            apiVersion: AGENT_RUN_API_VERSION,
            kind: AGENT_RUN_KIND,
          });
          return result.items.filter(isAgentRun);
        },
        async getModelClass(endpoint) {
          const resource = await controlStore.get<
            ModelClassResource['spec'],
            ModelClassResource['status']
          >(endpoint.spec.modelClassRef);
          return resource && isModelClass(resource) ? resource : null;
        },
        ...(options.modelEndpointRegistration?.staleAfterMs !== undefined
          ? { endpointHeartbeatTtlMs: options.modelEndpointRegistration.staleAfterMs }
          : {}),
      }),
      {
        actor: modelBindingActor,
        leaseName: 'model-endpoint-binding',
        watchKind: AGENT_RUN_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          return isAgentRun(resource) && (!resource.status?.phase || resource.status.phase === 'Pending');
        },
      },
    );

    const processNetworkDriver = createProcessNetworkDriver({
      resolveService: async (name) => {
        if (name !== 'model-gateway') return undefined;
        return options.workloadExecution?.modelGatewayEndpoint;
      },
    });
    const networkCapabilityHandle = `capability:network:${randomBytes(32).toString('hex')}`;
    const networkSessionId = `node-network:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const buildNetworkRequest = createDriverRequestBuilder({
      actor: { id: `controller/network-${syncNodeId}`, kind: 'controller' },
      sessionId: networkSessionId,
      capabilityHandleRef: networkCapabilityHandle,
      controller: 'network',
      deadlineMs: 30_000,
    });
    const networkPayloadSchemaDigests = {
      prepare: sha256DriverValue('drivers.memeloop.io/network.prepare/v1alpha1'),
      release: sha256DriverValue('drivers.memeloop.io/network.release/v1alpha1'),
    };
    const createManagedNetworkRequest = <T>(input: {
      method: string;
      payload: T;
      attachment: NetworkAttachmentResource;
      actor: ControlStoreActor;
      leaseEpoch: string;
      idempotencyKey: string;
      payloadSchemaDigest: string;
    }): DriverRequestEnvelope<T> => {
      const runReference = input.attachment.spec.runRef;
      if (!runReference?.uid) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: `NetworkAttachment '${input.attachment.metadata.name}' has no bound AgentRun identity`,
          retryable: false,
        });
      }
      return buildNetworkRequest({
        method: input.method,
        payload: input.payload,
        resource: input.attachment,
        run: { uid: runReference.uid, attempt: 1 },
        fencingEpoch: input.leaseEpoch,
        idempotencyKey: input.idempotencyKey,
        payloadSchemaDigest: input.payloadSchemaDigest,
        actor: input.actor,
      });
    };
    const managedNetworkDriver = createManagedNetworkAdapter(processNetworkDriver, {
      supportedTrustClasses: [workerTrustClass],
      threatAssumptions: [
        'process environment policy is cooperative and cannot contain a hostile workload',
        'the NodeRuntime capability token and ControlStore desired state are trusted',
      ],
      maxPolicyRules: 256,
      verifyCapability: (request) =>
        request.capabilityHandleRef === networkCapabilityHandle &&
        request.session?.id === networkSessionId,
      async resolveAttachRequest(request) {
        const attachment = narrowResource(
          await controlStore.get<
            NetworkAttachmentResource['spec'],
            NetworkAttachmentResource['status']
          >({
            apiVersion: request.resource.apiVersion,
            kind: request.resource.kind,
            name: request.resource.name,
          }),
          isNetworkAttachment,
        );
        if (!attachment || attachment.metadata.uid !== request.resource.uid) {
          throw new OrchestrationError({
            code: 'NOT_FOUND',
            message: `NetworkAttachment '${request.resource.name}' is unavailable`,
            retryable: false,
          });
        }
        const networkClass = narrowResource(
          await controlStore.get<
            NetworkClassResource['spec'],
            NetworkClassResource['status']
          >(attachment.spec.networkClassRef),
          isNetworkClass,
        );
        if (!networkClass) {
          throw new OrchestrationError({
            code: 'NOT_FOUND',
            message: `NetworkClass '${attachment.spec.networkClassRef.name}' is unavailable`,
            retryable: false,
          });
        }
        const policy = managedPolicyForNetworkClass(networkClass);
        return {
          attachRequest: {
            attachment,
            networkClass,
            sandboxRef: request.payload.sandboxHandle,
          },
          networkClassDigest: sha256DriverValue(networkClass.spec),
          policyDigest: sha256DriverValue(policy),
        };
      },
    });
    const networkCapabilities = await processNetworkDriver.getCapabilities();
    const getNetworkClass = async (attachment: NetworkAttachmentResource) =>
      narrowResource(
        await controlStore.get<
          NetworkClassResource['spec'],
          NetworkClassResource['status']
        >(attachment.spec.networkClassRef),
        isNetworkClass,
      ) ?? null;
    const networkBindingActor = {
      id: 'controller/network-attachment-binding',
      kind: 'controller' as const,
    };
    const networkBinding = await createControllerRunner(
      controlStore,
      createNetworkAttachmentBindingController({
        getNetworkClass,
        async getWorkload(attachment) {
          const reference = attachment.spec.workloadRef;
          if (!reference?.name) return null;
          const resource = narrowResource(
            await controlStore.get<
              AgentWorkloadResource['spec'],
              AgentWorkloadResource['status']
            >({
              apiVersion: reference.apiVersion,
              kind: reference.kind,
              name: reference.name,
              namespace: attachment.metadata.namespace,
            }),
            isAgentWorkload,
          );
          if (resource && reference.uid && resource.metadata.uid !== reference.uid) return null;
          return resource ?? null;
        },
        listNodes: options.workloadExecution?.listNetworkAttachmentNodes ?? (async () => [{
          nodeId: syncNodeId,
          healthy: (await processNetworkDriver.getHealth()).healthy,
          capabilities: [networkCapabilities],
        }]),
      }),
      {
        actor: networkBindingActor,
        leaseName: 'network-attachment-binding',
        watchKind: NETWORK_ATTACHMENT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          if (!isNetworkAttachment(resource)) return false;
          return !resource.status?.phase || resource.status.phase === 'Pending';
        },
      },
    );
    const networkExecutionActor = {
      id: `controller/network-attachment-execution-${syncNodeId}`,
      kind: 'controller' as const,
    };
    const createManagedNetworkReleaseRequest = async (input: {
      attachment: NetworkAttachmentResource;
      networkHandle: string;
      actor: ControlStoreActor;
      leaseEpoch: string;
    }) =>
      createManagedNetworkRequest({
        method: 'network.release',
        payload: { networkHandle: input.networkHandle },
        attachment: input.attachment,
        actor: input.actor,
        leaseEpoch: input.leaseEpoch,
        idempotencyKey: `${input.attachment.metadata.uid}:release:${input.networkHandle}`,
        payloadSchemaDigest: networkPayloadSchemaDigests.release,
      });
    const networkExecution = await createControllerRunner(
      controlStore,
      createNetworkAttachmentExecutionController({
        nodeId: syncNodeId,
        getNetworkClass,
        getDriver: async (name) => name === PROCESS_NETWORK_DRIVER_NAME ? processNetworkDriver : undefined,
        managed: {
          getDriver: async (name) => name === PROCESS_NETWORK_DRIVER_NAME ? managedNetworkDriver : undefined,
          async createPrepareRequest({
            attachment,
            networkClass,
            sandboxHandle,
            actor,
            leaseEpoch,
          }) {
            const policyWithoutDigest = managedPolicyForNetworkClass(networkClass);
            const payload: NetworkPreparePayload = {
              sandboxHandle,
              networkClass: networkClass.metadata.name,
              networkClassDigest: sha256DriverValue(networkClass.spec),
              requestedFeatures: featuresRequiredByClass(networkClass),
              minimumEnforcementLevel: (
                networkClass.spec.enforcement === 'required'
                  ? 'namespace'
                  : 'process'
              ) satisfies NetworkEnforcementLevel,
              trustClass: workerTrustClass,
              policy: {
                ...policyWithoutDigest,
                digest: sha256DriverValue(policyWithoutDigest),
              },
            };
            return createManagedNetworkRequest({
              method: 'network.prepare',
              payload,
              attachment,
              actor,
              leaseEpoch,
              idempotencyKey: [
                attachment.metadata.uid,
                'prepare',
                attachment.metadata.generation,
                networkClass.metadata.resourceVersion,
                sandboxHandle,
              ].join(':'),
              payloadSchemaDigest: networkPayloadSchemaDigests.prepare,
            });
          },
          createReleaseRequest: createManagedNetworkReleaseRequest,
        },
      }),
      {
        actor: networkExecutionActor,
        leaseName: `network-attachment-execution-${syncNodeId}`,
        watchKind: NETWORK_ATTACHMENT_KIND,
        leaseTtlMs: 5000,
        resourceFilter: (resource) => {
          if (!isNetworkAttachment(resource)) return false;
          const attachment = resource;
          return attachment.status?.assignedNode === syncNodeId &&
            (
              attachment.status.phase === 'Pending' ||
              attachment.status.phase === 'Preparing' ||
              (attachment.status.phase === 'Attached' && Boolean(attachment.status.releaseRequestedAt))
            );
        },
      },
    );
    const networkCleanupAbort = new AbortController();
    const networkCleanupIterator = controlStore.watch<
      NetworkAttachmentResource['spec'],
      NetworkAttachmentResource['status']
    >(
      { kind: NETWORK_ATTACHMENT_KIND },
      { signal: networkCleanupAbort.signal },
    )[Symbol.asyncIterator]();
    let networkCleanupStopped = false;
    const networkCleanupDone = (async () => {
      while (!networkCleanupStopped) {
        const event = await networkCleanupIterator.next();
        if (event.done || !event.value) break;
        if (event.value.type === 'DELETED' && isNetworkAttachment(event.value.resource)) {
          const attachment = event.value.resource;
          if (
            attachment.status?.assignedNode === syncNodeId &&
            attachment.status.assignedDriver === PROCESS_NETWORK_DRIVER_NAME &&
            attachment.status.handle
          ) {
            const leaseEpoch = attachment.status.executionClaim?.leaseEpoch;
            if (!leaseEpoch) {
              logger.warn?.(
                `deleted NetworkAttachment '${attachment.metadata.name}' has no fencing claim; refusing unfenced cleanup`,
              );
              continue;
            }
            await managedNetworkDriver.releaseNetwork(
              await createManagedNetworkReleaseRequest({
                attachment,
                networkHandle: attachment.status.handle,
                actor: networkExecutionActor,
                leaseEpoch,
              }),
            );
          }
        }
      }
    })().catch((error: unknown) => {
      if (!networkCleanupStopped) logger.warn?.('network attachment cleanup watcher stopped', error);
    });
    networkAttachmentControllers = {
      binding: networkBinding,
      execution: networkExecution,
      async stop() {
        networkCleanupStopped = true;
        networkCleanupAbort.abort();
        await networkCleanupIterator.return?.();
        await Promise.all([networkBinding.stop(), networkExecution.stop()]);
        await Promise.race([
          networkCleanupDone,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
      },
    };

    const storageReplication = options.workloadExecution?.storageReplication;
    const localStorageDriver = options.dataDir && workerTrustClass === 'trusted'
      ? createLocalDirectoryStorageDriver({
        rootDirectory: path.join(options.dataDir, 'volumes'),
        nodeId: syncNodeId,
        externalReplication: storageReplication !== undefined,
      })
      : undefined;
    if (localStorageDriver) {
      const storageCapabilityHandle = `capability:storage:${randomBytes(32).toString('hex')}`;
      const storageSessionId = `node-storage:${syncNodeId}:${randomBytes(16).toString('hex')}`;
      const buildStorageRequest = createDriverRequestBuilder({
        actor: { id: `controller/storage-${syncNodeId}`, kind: 'controller' },
        sessionId: storageSessionId,
        capabilityHandleRef: storageCapabilityHandle,
        controller: 'storage',
        deadlineMs: 30_000,
      });
      const storageSchemaDigest = (method: string, fields: string[]) =>
        sha256DriverValue({
          apiVersion: `drivers.memeloop.io/${method}/v1alpha1`,
          fields,
        });
      const createManagedStorageRequest = <T>(input: {
        method: string;
        payload: T;
        resource: AgentVolumeClaimResource | AgentRunResource;
        actor: ControlStoreActor;
        leaseEpoch: string;
        idempotencyKey: string;
        fields: string[];
      }): DriverRequestEnvelope<T> =>
        buildStorageRequest({
          method: input.method,
          payload: input.payload,
          resource: input.resource,
          ...(input.resource.kind === AGENT_RUN_KIND
            ? { run: { uid: input.resource.metadata.uid, attempt: 1 } }
            : {}),
          fencingEpoch: input.leaseEpoch,
          idempotencyKey: input.idempotencyKey,
          actor: input.actor,
          payloadSchemaDigest: storageSchemaDigest(input.method, input.fields),
        });
      const findVolumeByDriverHandle = async (driverHandle: string) => {
        const volumes = await controlStore.list<
          AgentVolumeResource['spec'],
          AgentVolumeResource['status']
        >({ kind: VOLUME_KIND });
        const matches = volumes.items
          .filter(isVolume)
          .filter((volume) => volume.spec.driverHandle === driverHandle);
        if (matches.length > 1) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: `storage handle '${driverHandle}' resolves to multiple volumes`,
            retryable: false,
          });
        }
        return matches[0];
      };
      managedStorageDriver = createManagedStorageDriverAdapter(
        localStorageDriver,
        {
          authorizeRequest: (request) =>
            request.capabilityHandleRef === storageCapabilityHandle &&
            request.session?.id === storageSessionId,
          async resolveProvisionInput(request) {
            const claims = await controlStore.list<
              AgentVolumeClaimResource['spec'],
              AgentVolumeClaimResource['status']
            >({ kind: VOLUME_CLAIM_KIND });
            const claim = claims.items.filter(isVolumeClaim).find(
              (candidate) =>
                candidate.metadata.uid === request.resource.uid &&
                candidate.apiVersion === request.resource.apiVersion &&
                candidate.kind === request.resource.kind &&
                candidate.metadata.name === request.resource.name &&
                candidate.metadata.generation === request.resource.generation,
            );
            if (!claim) {
              throw new OrchestrationError({
                code: 'NOT_FOUND',
                message: 'managed storage claim identity is unavailable',
                retryable: false,
              });
            }
            const storageClass = narrowResource(
              await controlStore.get<
                StorageClassResource['spec'],
                StorageClassResource['status']
              >(claim.spec.storageClassRef),
              isStorageClass,
            );
            if (!storageClass) {
              throw new OrchestrationError({
                code: 'NOT_FOUND',
                message: 'managed StorageClass is unavailable',
                retryable: false,
              });
            }
            return { claim, storageClass };
          },
          resolveVolume: findVolumeByDriverHandle,
          stateStore: createFileManagedStorageStateStore(
            path.join(options.dataDir!, 'volumes', '.managed-state'),
          ),
          stableStageHandleFor: (request) =>
            `storage-stage:${
              sha256DriverValue({
                resourceUid: request.resource.uid,
                volumeHandle: request.payload.volumeHandle,
                nodeId: request.payload.nodeId,
              })
            }`,
          threatAssumptions: [
            'the local private volume root and managed state directory are trusted host storage',
            'the ControlStore volume resolver and NodeRuntime capability remain host-confined',
            'local-directory publication provides a process mount path, not kernel-enforced remote storage isolation',
          ],
        },
      );
      const storageCapabilities = await localStorageDriver.getCapabilities();
      const getStorageClass = async (claim: AgentVolumeClaimResource) =>
        narrowResource(
          await controlStore.get<
            StorageClassResource['spec'],
            StorageClassResource['status']
          >(claim.spec.storageClassRef),
          isStorageClass,
        ) ?? null;
      const volumeBindingActor = {
        id: 'controller/volume-claim-binding',
        kind: 'controller' as const,
      };
      const volumeBinding = await createControllerRunner(
        controlStore,
        createVolumeClaimBindingController({
          getStorageClass,
          listDrivers: options.workloadExecution?.listStorageDriverEndpoints ?? (async () => [{
            nodeId: syncNodeId,
            healthy: (await localStorageDriver.getHealth()).healthy,
            trust: workerTrustClass,
            capabilities: [storageCapabilities],
          }]),
        }),
        {
          actor: volumeBindingActor,
          leaseName: 'volume-claim-binding',
          watchKind: VOLUME_CLAIM_KIND,
          leaseTtlMs: 5000,
          resourceFilter: (resource) => {
            return isVolumeClaim(resource) && (!resource.status?.phase || resource.status.phase === 'Pending');
          },
        },
      );
      const volumeProvisionActor = {
        id: `controller/volume-claim-provision-${syncNodeId}`,
        kind: 'controller' as const,
      };
      const volumeProvisioning = await createControllerRunner(
        controlStore,
        createVolumeClaimExecutionController({
          nodeId: syncNodeId,
          getStorageClass,
          getDriver: async (name) =>
            name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
              ? localStorageDriver
              : undefined,
          managed: {
            getDriver: async (name) =>
              name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
                ? managedStorageDriver
                : undefined,
            createProvisionRequest: async ({ claim, storageClass, actor, leaseEpoch }) =>
              createManagedStorageRequest({
                method: 'storage.provision',
                resource: claim,
                actor,
                leaseEpoch,
                idempotencyKey: `provision:${claim.metadata.uid}`,
                fields: [
                  'capacityBytes',
                  'accessMode',
                  'storageClass',
                  'replicaCount',
                ],
                payload: {
                  capacityBytes: claim.spec.sizeBytes ?? 1,
                  accessMode: claim.spec.accessMode,
                  storageClass: storageClass.metadata.name,
                  replicaCount: 1,
                },
              }),
          },
          async ensureVolume(claim, storageClass, provisioned) {
            const name = `${claim.metadata.name}-volume`;
            const reference = {
              apiVersion: 'storage.memeloop.io/v1alpha1',
              kind: VOLUME_KIND,
              name,
              namespace: claim.metadata.namespace,
            };
            const existing = narrowResource(
              await controlStore.get<
                AgentVolumeResource['spec'],
                AgentVolumeResource['status']
              >(reference),
              isVolume,
            );
            if (existing) {
              if (
                existing.spec.claimRef?.uid !== claim.metadata.uid ||
                existing.spec.driverHandle !== provisioned.driverHandle
              ) {
                throw new OrchestrationError({
                  code: 'CONFLICT',
                  message: `existing volume '${name}' does not belong to claim '${claim.metadata.name}'`,
                  retryable: false,
                });
              }
              return existing;
            }
            const manifest = createVolumeManifest(name, {
              storageClassRef: {
                apiVersion: storageClass.apiVersion,
                kind: storageClass.kind,
                name: storageClass.metadata.name,
              },
              claimRef: {
                apiVersion: claim.apiVersion,
                kind: claim.kind,
                name: claim.metadata.name,
                uid: claim.metadata.uid,
              },
              driverHandle: provisioned.driverHandle,
              capacityBytes: provisioned.capacityBytes,
              topology: provisioned.topology,
              accessModes: [claim.spec.accessMode],
            });
            manifest.metadata.namespace = claim.metadata.namespace;
            const created = await controlStore.create<
              AgentVolumeResource['spec'],
              AgentVolumeResource['status']
            >(
              volumeProvisionActor,
              manifest,
              { idempotencyKey: `volume:${claim.metadata.uid}` },
            );
            return await controlStore.updateStatus(
              volumeProvisionActor,
              reference,
              {
                phase: 'Bound',
                health: 'healthy',
                replicas: [{
                  nodeId: syncNodeId,
                  state: 'healthy',
                  updatedAt: new Date().toISOString(),
                }],
              },
              { resourceVersion: created.metadata.resourceVersion },
            );
          },
        }),
        {
          actor: volumeProvisionActor,
          leaseName: `volume-claim-provision-${syncNodeId}`,
          watchKind: VOLUME_CLAIM_KIND,
          leaseTtlMs: 5000,
          resourceFilter: (resource) => {
            return isVolumeClaim(resource) && resource.status?.assignedNode === syncNodeId &&
              (resource.status.phase === 'Pending' || resource.status.phase === 'Provisioning');
          },
        },
      );
      const volumePublishActor = {
        id: `controller/run-volume-${syncNodeId}`,
        kind: 'controller' as const,
      };
      const updatePublishedTo = async (
        volume: AgentVolumeResource,
        workload: AgentWorkloadResource,
        published: boolean,
      ) => {
        const reference = {
          apiVersion: volume.apiVersion,
          kind: volume.kind,
          name: volume.metadata.name,
          namespace: volume.metadata.namespace,
        };
        const current = narrowResource(
          await controlStore.get<
            AgentVolumeResource['spec'],
            AgentVolumeResource['status']
          >(reference),
          isVolume,
        );
        if (!current) return;
        const others = (current.status?.publishedTo ?? []).filter(
          (item) => item.workloadRef?.uid !== workload.metadata.uid,
        );
        await controlStore.updateStatus(
          volumePublishActor,
          reference,
          {
            ...current.status,
            phase: published ? 'Published' : 'Bound',
            publishedTo: published
              ? [...others, {
                nodeId: syncNodeId,
                workloadRef: {
                  apiVersion: workload.apiVersion,
                  kind: workload.kind,
                  name: workload.metadata.name,
                  uid: workload.metadata.uid,
                },
              }]
              : others,
          },
          { resourceVersion: current.metadata.resourceVersion },
        );
      };
      const runVolume = await createControllerRunner(
        controlStore,
        createRunVolumeController({
          nodeId: syncNodeId,
          async getWorkload(run) {
            const reference = run.spec.workloadRef;
            const resource = narrowResource(
              await controlStore.get<
                AgentWorkloadResource['spec'],
                AgentWorkloadResource['status']
              >({
                apiVersion: reference.apiVersion,
                kind: reference.kind,
                name: reference.name,
                namespace: run.metadata.namespace,
              }),
              isAgentWorkload,
            );
            return resource && (!reference.uid || resource.metadata.uid === reference.uid)
              ? resource
              : null;
          },
          async getClaim(name, namespace) {
            const resource = await controlStore.get<
              AgentVolumeClaimResource['spec'],
              AgentVolumeClaimResource['status']
            >({
              apiVersion: 'storage.memeloop.io/v1alpha1',
              kind: VOLUME_CLAIM_KIND,
              name,
              namespace,
            });
            return resource && isVolumeClaim(resource) ? resource : null;
          },
          async getVolume(claim) {
            const reference = claim.status?.volumeRef;
            if (!reference) return null;
            const resource = await controlStore.get<
              AgentVolumeResource['spec'],
              AgentVolumeResource['status']
            >({
              apiVersion: reference.apiVersion,
              kind: reference.kind,
              name: reference.name,
              namespace: claim.metadata.namespace,
            });
            return resource && isVolume(resource) ? resource : null;
          },
          getDriver: async (name) =>
            name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
              ? localStorageDriver
              : undefined,
          managed: {
            getDriver: async (name) =>
              name === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
                ? managedStorageDriver
                : undefined,
            createStageRequest: async ({ run, volume, nodeId, actor, leaseEpoch }) =>
              createManagedStorageRequest({
                method: 'storage.stage',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `stage:${run.metadata.uid}:${volume.metadata.uid}`,
                fields: ['volumeHandle', 'nodeId'],
                payload: {
                  volumeHandle: volume.spec.driverHandle,
                  nodeId,
                },
              }),
            createPublishRequest: async ({
              run,
              stageHandle,
              workloadUid,
              readOnly,
              actor,
              leaseEpoch,
            }) =>
              createManagedStorageRequest({
                method: 'storage.publish',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `publish:${run.metadata.uid}:${stageHandle}`,
                fields: ['stageHandle', 'workloadUid', 'readOnly'],
                payload: { stageHandle, workloadUid, readOnly },
              }),
            createUnpublishRequest: async ({
              run,
              publishHandle,
              actor,
              leaseEpoch,
            }) =>
              createManagedStorageRequest({
                method: 'storage.unpublish',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `unpublish:${run.metadata.uid}:${publishHandle}`,
                fields: ['publishHandle'],
                payload: { publishHandle },
              }),
            createUnstageRequest: async ({
              run,
              stageHandle,
              actor,
              leaseEpoch,
            }) =>
              createManagedStorageRequest({
                method: 'storage.unstage',
                resource: run,
                actor,
                leaseEpoch,
                idempotencyKey: `unstage:${run.metadata.uid}:${stageHandle}`,
                fields: ['stageHandle'],
                payload: { stageHandle },
              }),
          },
          recordPublished: async (volume, workload) => updatePublishedTo(volume, workload, true),
          recordUnpublished: async (volume, workload) => updatePublishedTo(volume, workload, false),
        }),
        {
          actor: volumePublishActor,
          leaseName: `run-volume-${syncNodeId}`,
          watchKind: AGENT_RUN_KIND,
          leaseTtlMs: 5000,
          resourceFilter: (resource) => {
            return isAgentRun(resource) && resource.status?.volumePhase !== 'Released' &&
              resource.status?.volumePhase !== 'Failed';
          },
        },
      );
      const replication = storageReplication
        ? await createReplicationController({
          store: controlStore,
          actor: {
            id: `controller/storage-replication-${syncNodeId}`,
            kind: 'controller',
          },
          async getStorageClass(volume) {
            const storageClass = await controlStore.get<
              StorageClassResource['spec'],
              StorageClassResource['status']
            >(volume.spec.storageClassRef);
            return storageClass && isStorageClass(storageClass) ? storageClass : null;
          },
          listNodes: async () => await storageReplication.listNodes(),
          transport: storageReplication.transport,
        })
        : undefined;
      volumeControllers = {
        binding: volumeBinding,
        provisioning: volumeProvisioning,
        publishing: runVolume,
        ...(replication ? { replication } : {}),
        async stop() {
          await Promise.all([
            volumeBinding.stop(),
            volumeProvisioning.stop(),
            runVolume.stop(),
            replication?.stop(),
          ]);
        },
      };
    }

    const resolveModelProvider = options.workloadExecution?.resolveModelProvider ??
      (modelGateway
        ? async (
          endpoint: ModelEndpointResource,
          request: import('memeloop').LoopRunStartRequest,
        ): Promise<ILLMProvider | undefined> => {
          if (endpoint.spec.nodeId !== syncNodeId) return undefined;
          const modelClassResource = await controlStore.get<
            ModelClassResource['spec'],
            ModelClassResource['status']
          >(endpoint.spec.modelClassRef);
          const modelClass = modelClassResource && isModelClass(modelClassResource)
            ? modelClassResource
            : null;
          if (
            !modelClass ||
            (
              modelClass.spec.digest !== undefined &&
              endpoint.spec.modelDigest !== modelClass.spec.digest
            )
          ) {
            return undefined;
          }
          const workloadBudget = request.workload.spec.modelPolicy?.budget;
          const configuredBudget = options.modelGatewayConfig?.loopBudget;
          const maximumOutputTokens = [
            configuredBudget?.maxOutputTokens,
            workloadBudget?.maxTokens,
          ].filter((value): value is number => value !== undefined);
          const maximumCost = [
            configuredBudget?.maxCost,
            workloadBudget?.maxCost,
          ].filter((value): value is number => value !== undefined);
          const budget: ModelAccessHandleBudget = {
            ...configuredBudget,
            ...(maximumOutputTokens.length > 0
              ? { maxOutputTokens: Math.min(...maximumOutputTokens) }
              : {}),
            ...(maximumCost.length > 0 ? { maxCost: Math.min(...maximumCost) } : {}),
          };
          const policyDigest = sha256DriverValue({
            modelPolicy: request.workload.spec.modelPolicy,
            endpoint: {
              uid: endpoint.metadata.uid,
              resourceVersion: endpoint.metadata.resourceVersion,
              modelClassRef: endpoint.spec.modelClassRef,
              modelDigest: endpoint.spec.modelDigest,
              dataPolicy: endpoint.spec.dataPolicy,
            },
          });
          return createGatewayMediatedLLMProvider({
            gateway: modelGateway.gateway,
            broker: modelGateway.broker,
            modelClassRef: endpoint.spec.modelClassRef,
            ...(endpoint.spec.modelDigest !== undefined
              ? { modelDigest: endpoint.spec.modelDigest }
              : {}),
            policyDigest,
            runRef: {
              apiVersion: request.run.apiVersion,
              kind: request.run.kind,
              name: request.run.metadata.name,
              uid: request.run.metadata.uid,
            },
            attempt: 1,
            budget,
            name: llmProvider.name,
            modelId: modelClass.spec.model,
            model: llmProvider.model,
          });
        }
        : undefined);
    const baseInProcessDriver = createInProcessLoopRuntimeDriver(context, {
      ...(resolveModelProvider ? { resolveModelProvider } : {}),
    });
    const inProcessDriver = {
      async start(request: Parameters<typeof baseInProcessDriver.start>[0]) {
        const definitionId = request.workload.spec.profileId?.trim();
        if (definitionId) {
          const conversationId = `looprun:${request.run.metadata.namespace ?? 'default'}:${request.run.metadata.name}`;
          // Profile runners resolve their identity from durable conversation
          // metadata. Create/open that conversation before the portable driver
          // starts so workload execution follows the same fail-closed contract
          // as direct runtime entry points.
          await runtime.createAgent({ definitionId, conversationId });
        }
        return baseInProcessDriver.start(request);
      },
    };
    const linuxProcessSandbox = options.workloadExecution?.processIsolation === false
      ? undefined
      : await prepareLinuxProcessSandbox();
    if (options.workloadExecution?.processIsolation !== false && !linuxProcessSandbox) {
      logger.warn?.(
        'process RuntimeClasses are unavailable: Linux cgroup/namespace/seccomp preparation failed',
      );
    }
    const processDriver = !linuxProcessSandbox || !context.loopCheckpoints
      ? undefined
      : createProcessLoopRuntimeDriver({
        osSandbox: linuxProcessSandbox,
        checkpointStore: context.loopCheckpoints,
        runChildAgent: input => runtime.runChildAgent(input),
        ...(options.workloadExecution?.modelGatewayEndpoint !== undefined
          ? { gatewayEndpoint: options.workloadExecution.modelGatewayEndpoint }
          : {}),
        ...(options.workloadExecution?.resolveModelGatewayEndpoint
          ? {
            gatewayEndpointForModelEndpoint: options.workloadExecution.resolveModelGatewayEndpoint,
          }
          : {}),
        environmentForNetworkAttachment: async (handle) => processNetworkDriver.getEnvironmentPatch(handle),
        logger: {
          warn: (...arguments_: unknown[]) => {
            const [message, ...details] = arguments_;
            if (typeof message === 'string') {
              logger.warn?.(message, ...details);
            } else {
              logger.warn?.('process loop runtime warning', message, ...details);
            }
          },
        },
      });
    const narrowLoopRuntimeDriver = createRuntimeClassRoutingDriver({
      inProcessDriver,
      ...(processDriver ? { processDriver } : {}),
    });
    const runtimeCapabilityHandle = `capability:loop-runtime:${randomBytes(32).toString('hex')}`;
    const runtimeSessionId = `node-loop-runtime:${syncNodeId}:${randomBytes(16).toString('hex')}`;
    const buildRuntimeRequest = createDriverRequestBuilder({
      actor: { id: `controller/workload-execution-${syncNodeId}`, kind: 'controller' },
      sessionId: runtimeSessionId,
      capabilityHandleRef: runtimeCapabilityHandle,
      controller: 'loop-runtime',
    });
    const runtimeRoute = createManagedLoopRuntimeExecutionRoute(
      narrowLoopRuntimeDriver,
      {
        capabilities: {
          name: `node-loop-runtime/${syncNodeId}`,
          isolation: processDriver ? ['none', 'process'] : ['none'],
          supportedTrustClasses: ['trusted', 'restricted', 'quarantine'],
          // This management capability means that the adapter can snapshot an
          // active process and later restore that process from an opaque
          // LoopRuntimeCheckpoint handle. Script-level ctx.checkpoint/state is
          // separately backed by context.loopCheckpoints in processDriver.
          supportsCheckpoint: false,
          supportsRestore: false,
          supportsAdoption: false,
          persistence: 'process',
          threatAssumptions: [
            'the Node daemon, controller envelope builder, and configured OS sandbox are trusted',
            'live runtime handles cannot be adopted after daemon restart',
          ],
        },
        authorizeRequest: (request) =>
          request.capabilityHandleRef === runtimeCapabilityHandle &&
          request.session?.id === runtimeSessionId,
        createPreparePayload(
          request: LoopRunStartRequest,
        ): LoopRuntimePreparePayload {
          const runtimeClass = request.workload.spec.runtimeClass ??
            'host-profile';
          const runtimeSpec = request.workload.spec.runtimeClass
            ? BUILTIN_RUNTIME_CLASSES[request.workload.spec.runtimeClass]
            : undefined;
          if (request.workload.spec.runtimeClass && !runtimeSpec) {
            throw new OrchestrationError({
              code: 'INVALID',
              message: `unknown RuntimeClass '${request.workload.spec.runtimeClass}'`,
              retryable: false,
            });
          }
          return {
            runtimeClass,
            runtimeDigest: sha256DriverValue({
              runtimeClass,
              runtimeSpec: runtimeSpec ?? {
                isolation: 'none',
                hostProfile: true,
              },
            }),
            ...(request.workload.spec.scriptReference
              ? { scriptDigest: request.workload.spec.scriptReference }
              : {}),
            isolation: runtimeSpec?.isolation ?? 'none',
            trustClass: request.workload.spec.trust ?? 'trusted',
          };
        },
        createRequest<T>(
          request: LoopRunStartRequest,
          method: string,
          payload: T,
        ): DriverRequestEnvelope<T> {
          const runUid = request.run.metadata.uid;
          // An AgentRun is itself one immutable attempt. spec.retry describes
          // retry policy/count; it must not be repurposed as an attempt ID.
          const attempt = 1;
          const fencingEpoch = request.run.metadata.generation;
          const runtimeSpec = request.workload.spec.runtimeClass
            ? BUILTIN_RUNTIME_CLASSES[request.workload.spec.runtimeClass]
            : undefined;
          const deadlineMs = Date.now() +
            (runtimeSpec?.timeLimitMs ?? 300_000) + 30_000;
          return buildRuntimeRequest({
            method,
            payload,
            resource: request.run,
            run: { uid: runUid, attempt },
            // The durable pre-effect CAS admits one controller per immutable
            // AgentRun; resource generation is its management fence.
            fencingEpoch,
            idempotencyKey: `${runUid}:${fencingEpoch}:${method}`,
            deadlineMs: deadlineMs - Date.now(),
            payloadSchema: {
              apiVersion: DRIVER_REQUEST_API_VERSION,
              fields: payload !== null && typeof payload === 'object'
                ? Object.keys(payload).sort()
                : [],
            },
          });
        },
      },
    );
    const loopRuntimeDriver = runtimeRoute.executionDriver;
    managedLoopRuntimeDriver = runtimeRoute.managementDriver;
    const advertisedModelClasses = advertisedModels.flatMap((model) => {
      const raw = model.model;
      const registered = modelClassNameForSpec(model);
      return raw === registered ? [raw] : [raw, registered];
    });
    const localNode: SchedulerNode = {
      faultDomain: 'local',
      healthy: true,
      roles: ['worker'],
      availableRuntimeClasses: !processDriver
        ? []
        : Object.keys(BUILTIN_RUNTIME_CLASSES),
      availableToolClasses: toolRegistry.listTools(),
      availableModelClasses: advertisedModelClasses,
      driverConformancePassed: true,
      ...(options.credentialBroker && !options.workloadExecution?.localNode?.credentialCapabilities
        ? {
          credentialCapabilities: [{
            brokerClass: options.credentialBroker.brokerClass,
            audiences: options.credentialBroker.audiences,
            targets: options.credentialBroker.targets,
          }],
        }
        : {}),
      ...options.workloadExecution?.localNode,
      name: syncNodeId,
      trustClass: workerTrustClass,
    };
    const listLocalSchedulerNodes = async (): Promise<SchedulerNode[]> => {
      let networkCapabilities_ = options.workloadExecution?.localNode?.networkCapabilities;
      if (!networkCapabilities_) {
        const result = await controlStore.list<
          NetworkClassResource['spec'],
          NetworkClassResource['status']
        >({
          apiVersion: NETWORK_CLASS_API_VERSION,
          kind: NETWORK_CLASS_KIND,
        });
        networkCapabilities_ = result.items.filter(isNetworkClass)
          .filter((item) =>
            item.spec.driver === PROCESS_NETWORK_DRIVER_NAME &&
            canDriverSatisfyClass(networkCapabilities, item).satisfied
          )
          .map((item) => ({
            networkClass: item.metadata.name,
            enforcementLevel: networkCapabilities.enforcementLevel,
          }));
      }
      let availableStorageClasses = options.workloadExecution?.localNode?.availableStorageClasses;
      let availableVolumeClaims = options.workloadExecution?.localNode?.availableVolumeClaims;
      if (localStorageDriver && !availableStorageClasses) {
        const classes = await controlStore.list<
          StorageClassResource['spec'],
          StorageClassResource['status']
        >({
          apiVersion: STORAGE_CLASS_API_VERSION,
          kind: STORAGE_CLASS_KIND,
        });
        availableStorageClasses = classes.items.filter(isStorageClass)
          .filter((item) => item.spec.driver === LOCAL_DIRECTORY_STORAGE_DRIVER_NAME)
          .map((item) => item.metadata.name);
      }
      if (localStorageDriver && !availableVolumeClaims) {
        const claims = await controlStore.list<
          AgentVolumeClaimResource['spec'],
          AgentVolumeClaimResource['status']
        >({ kind: VOLUME_CLAIM_KIND });
        availableVolumeClaims = claims.items.filter(isVolumeClaim)
          .filter((item) =>
            item.status?.phase === 'Bound' &&
            item.status.assignedNode === syncNodeId
          )
          .map((item) => item.metadata.name);
      }
      return [{
        ...localNode,
        networkCapabilities: networkCapabilities_,
        ...(availableStorageClasses ? { availableStorageClasses } : {}),
        ...(availableVolumeClaims ? { availableVolumeClaims } : {}),
      }];
    };
    const bindingActor = { id: `controller/binding-${syncNodeId}`, kind: 'controller' as const };
    bindingControllerRunner = await createControllerRunner(
      controlStore,
      createBindingController(controlStore, {
        actor: bindingActor,
        scheduler: createCapacityScheduler(),
        listNodes: options.workloadExecution?.listSchedulerNodes ?? listLocalSchedulerNodes,
        async authorizePlacement(input) {
          const policyDigest = sha256DriverValue({
            placement: input.workload.spec.placement,
            trust: input.workload.spec.trust ?? 'restricted',
            securityProfileRef: input.workload.spec.securityProfileRef,
          });
          const decision = await managedPolicyDriver.authorizePlacement(
            createManagedPolicyRequest({
              method: 'policy.authorize-placement',
              payload: {
                policyDigest,
                nodeId: input.node.name,
                nodeTrustClass: input.node.trustClass,
                requiredTrustClass: input.workload.spec.trust ?? 'restricted',
                attested: input.node.attested === true,
                driverConformancePassed: input.node.driverConformancePassed === true,
              },
              resource: input.workload,
              actor: input.actor,
              leaseEpoch: input.leaseEpoch,
              idempotencyKey: `${input.workload.metadata.uid}:placement:${input.node.name}`,
              payloadFields: [
                'policyDigest',
                'nodeId',
                'nodeTrustClass',
                'requiredTrustClass',
                'attested',
                'driverConformancePassed',
              ],
            }),
          );
          return {
            outcome: decision.outcome === 'allow' ? 'allow' : 'deny',
            decisionHandle: decision.decisionHandle,
            policyDigest: decision.policyDigest,
            reasons: decision.reasons,
          };
        },
      }),
      {
        actor: bindingActor,
        leaseName: `binding-${syncNodeId}`,
        watchKind: AGENT_WORKLOAD_KIND,
        leaseTtlMs: 5000,
      },
    );
    workloadExecutionController = createWorkloadExecutionController(controlStore, loopRuntimeDriver, {
      actor: { id: `controller/workload-execution-${syncNodeId}`, kind: 'controller' },
      nodeId: syncNodeId,
      ...(options.modelEndpointRegistration?.staleAfterMs !== undefined
        ? { modelEndpointHeartbeatTtlMs: options.modelEndpointRegistration.staleAfterMs }
        : {}),
      resolveScriptSource: async (reference) => {
        if (!scriptArtifactStore) return undefined;
        const digestHex = reference.replace(/^sha256:/, '');
        if (!/^[a-f0-9]{64}$/.test(digestHex)) return undefined;
        return scriptArtifactStore.readArtifactContent(`script-${digestHex}`);
      },
      ...(localStorageDriver
        ? {
          async resolveVolumeMounts(_workload, run) {
            const mounts = [];
            for (const binding of run.status?.volumeBindings ?? []) {
              if (
                binding.assignedNode !== syncNodeId ||
                binding.assignedDriver !== LOCAL_DIRECTORY_STORAGE_DRIVER_NAME
              ) {
                throw new OrchestrationError({
                  code: 'FORBIDDEN',
                  message: `Run volume '${binding.name}' is not bound to this node/driver`,
                  retryable: false,
                });
              }
              const published = await localStorageDriver.getPublished(binding.publishHandle);
              if (!published) {
                throw new OrchestrationError({
                  code: 'UNAVAILABLE',
                  message: `published volume '${binding.name}' cannot be resolved after restart`,
                  retryable: true,
                });
              }
              mounts.push({
                name: binding.name,
                mountPath: published.mountPath,
                readOnly: binding.readOnly,
              });
            }
            return mounts;
          },
        }
        : {}),
      onError: (error) => logger.warn?.('workload execution controller error', error),
    });
  }

  return {
    bindingControllerRunner,
    modelEndpointBindingControllerRunner,
    networkAttachmentControllers,
    volumeControllers,
    managedStorageDriver,
    workloadExecutionController,
    managedLoopRuntimeDriver,
  };
}
