import type {
  AgentFrameworkContext,
  AgentWorkloadResource,
  BuiltinToolContext,
  ControlStore,
  ControlStoreActor,
  DriverRequestEnvelope,
  ManagedToolPolicyDecision,
  PolicyApprovalManagementDriver,
  ScriptTrustClass,
  ToolAdmissionPolicy,
  ToolManagementDriver,
  ToolOperationApprovalBroker,
  ToolOperationResource,
  ToolOperationResult,
} from 'memeloop';

import type { ToolOperationControllers } from './toolOperationLifecycle.js';

export type { ToolOperationControllers } from './toolOperationLifecycle.js';

export type ManagedPolicyRequestFactory = <T>(input: {
  method: string;
  payload: T;
  resource: AgentWorkloadResource | ToolOperationResource;
  actor: ControlStoreActor;
  leaseEpoch: string;
  idempotencyKey: string;
  payloadFields: string[];
}) => DriverRequestEnvelope<T>;

export interface ToolOperationRuntimeOptions {
  controlStore: ControlStore;
  nodeId: string;
  trustClass: ScriptTrustClass;
  toolRegistry: NonNullable<AgentFrameworkContext['tools']>;
  builtinToolContext: BuiltinToolContext;
  logger: NonNullable<AgentFrameworkContext['logger']>;
  toolExecution?: {
    enabled?: boolean;
    maxConcurrent?: number;
    maxOutputLength?: number;
    admission?: ToolAdmissionPolicy;
    approvalBroker?: ToolOperationApprovalBroker;
  };
  workloadNodeLabels?: Record<string, string>;
  auditToolExecution?: (operation: ToolOperationResource, result: ToolOperationResult) => Promise<void>;
}

export interface ToolOperationRuntimeResult {
  toolOperationControllers?: ToolOperationControllers;
  managedToolDriver?: ToolManagementDriver;
  managedPolicyDriver: PolicyApprovalManagementDriver;
  createManagedPolicyRequest: ManagedPolicyRequestFactory;
  authorizeHostToolOperation?: (
    operation: ToolOperationResource,
    signal?: AbortSignal,
  ) => Promise<ManagedToolPolicyDecision>;
  authorizeHostExternalWorkload: (
    workload: AgentWorkloadResource,
    driverName: string,
  ) => Promise<{ decisionHandle: string; policyDigest: string }>;
}
