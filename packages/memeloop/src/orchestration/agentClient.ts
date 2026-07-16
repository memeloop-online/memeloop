import type { AgentOrchestrationClient } from './client.js';
import type { OrchestrationOwnerReference } from './client.js';
import { OrchestrationError } from './errors.js';
import type {
  AgentRunCondition,
  AgentRunManifest,
  AgentRunResource,
  AgentTrustLevel,
  AgentWorkloadCompletionPolicy,
  AgentWorkloadCondition,
  AgentWorkloadManifest,
  AgentWorkloadModelPolicy,
  AgentWorkloadNetworkPolicy,
  AgentWorkloadPlacement,
  AgentWorkloadResource,
  AgentWorkloadStoragePolicy,
  AgentWorkloadToolPolicy,
} from './resources.js';
import { agentRunReference, agentWorkloadReference, createAgentRunManifest, createAgentWorkloadManifest, isAgentRun, isAgentWorkload } from './resources.js';

export interface CreateAgentWorkloadOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  profileId?: string;
  scriptReference?: string;
  promptReference?: string;
  trust?: AgentTrustLevel;
  placement?: AgentWorkloadPlacement;
  modelPolicy?: AgentWorkloadModelPolicy;
  toolPolicy?: AgentWorkloadToolPolicy;
  networkPolicy?: AgentWorkloadNetworkPolicy;
  storagePolicy?: AgentWorkloadStoragePolicy;
  completionPolicy?: AgentWorkloadCompletionPolicy;
  ownerReferences?: OrchestrationOwnerReference[];
  idempotencyKey?: string;
}

export interface CreateAgentRunOptions {
  name?: string;
  generateName?: string;
  namespace?: string;
  workloadName: string;
  workloadNamespace?: string;
  promptReference?: string;
  retry?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface WaitForConditionOptions {
  timeout?: number;
  interval?: number;
}

export interface AgentClient {
  createWorkload(options: CreateAgentWorkloadOptions): Promise<AgentWorkloadResource>;
  getWorkload(name: string, namespace?: string): Promise<AgentWorkloadResource | null>;
  deleteWorkload(name: string, namespace?: string): Promise<void>;
  waitForWorkloadCondition(
    name: string,
    condition: AgentWorkloadCondition,
    options?: WaitForConditionOptions,
  ): Promise<{ observedResourceVersion: string; matched: true }>;

  createRun(options: CreateAgentRunOptions): Promise<AgentRunResource>;
  getRun(name: string, namespace?: string): Promise<AgentRunResource | null>;
  deleteRun(name: string, namespace?: string): Promise<void>;
  waitForRunCondition(
    name: string,
    condition: AgentRunCondition,
    options?: WaitForConditionOptions,
  ): Promise<{ observedResourceVersion: string; matched: true }>;
}

function requireName(name: string | undefined, generateName: string | undefined, label: string): string {
  if (name) return name;
  if (generateName) return `${generateName}${Math.random().toString(36).slice(2, 8)}`;
  throw new OrchestrationError({ code: 'INVALID', message: `${label} requires name or generateName`, retryable: false });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollCondition<
  TResource extends { metadata?: { resourceVersion?: string }; status?: { conditions?: Array<{ type: string; status: 'True' | 'False' | 'Unknown' }> } },
>(
  get: () => Promise<TResource | null>,
  condition: { type: string; status: 'True' | 'False' | 'Unknown' },
  options: WaitForConditionOptions,
): Promise<{ observedResourceVersion: string; matched: true }> {
  const intervalMs = Math.max(100, options.interval ?? 1000);
  const timeoutMs = options.timeout ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastResourceVersion = '0';

  while (true) {
    const resource = await get();
    if (resource) {
      lastResourceVersion = resource.metadata?.resourceVersion ?? '0';
      const match = resource.status?.conditions?.find(
        (candidate) => candidate.type === condition.type && candidate.status === condition.status,
      );
      if (match) {
        return { observedResourceVersion: lastResourceVersion, matched: true };
      }
    }

    if (Date.now() + intervalMs > deadline) {
      throw new OrchestrationError({
        code: 'TIMEOUT',
        message: `condition ${condition.type}=${condition.status} not met within ${timeoutMs}ms`,
        retryable: true,
        details: { lastResourceVersion },
      });
    }

    await sleep(intervalMs);
  }
}

export function createAgentClient(client: AgentOrchestrationClient, defaultNamespace?: string): AgentClient {
  function resolveNamespace(namespace?: string): string | undefined {
    return namespace ?? defaultNamespace;
  }

  return {
    async createWorkload(options: CreateAgentWorkloadOptions): Promise<AgentWorkloadResource> {
      const name = requireName(options.name, options.generateName, 'AgentWorkload');
      const manifest: AgentWorkloadManifest = createAgentWorkloadManifest(name, {
        profileId: options.profileId,
        scriptReference: options.scriptReference,
        promptReference: options.promptReference,
        trust: options.trust,
        placement: options.placement,
        modelPolicy: options.modelPolicy,
        toolPolicy: options.toolPolicy,
        networkPolicy: options.networkPolicy,
        storagePolicy: options.storagePolicy,
        completionPolicy: options.completionPolicy,
        ownerReferences: options.ownerReferences,
      });
      const result = await client.apply(manifest, {
        idempotencyKey: options.idempotencyKey,
        fieldManager: 'memeloop-agent-client',
      });
      if (!isAgentWorkload(result)) {
        throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-AgentWorkload resource', retryable: false });
      }
      return result;
    },

    async getWorkload(name: string, namespace?: string): Promise<AgentWorkloadResource | null> {
      const result = await client.get(agentWorkloadReference(name, resolveNamespace(namespace)));
      return result && isAgentWorkload(result) ? result : null;
    },

    async deleteWorkload(name: string, namespace?: string): Promise<void> {
      await client.delete(agentWorkloadReference(name, resolveNamespace(namespace)));
    },

    async waitForWorkloadCondition(
      name: string,
      condition: AgentWorkloadCondition,
      options: WaitForConditionOptions = {},
    ): Promise<{ observedResourceVersion: string; matched: true }> {
      return pollCondition(
        () => this.getWorkload(name, defaultNamespace),
        condition,
        options,
      );
    },

    async createRun(options: CreateAgentRunOptions): Promise<AgentRunResource> {
      const name = requireName(options.name, options.generateName, 'AgentRun');
      const manifest: AgentRunManifest = createAgentRunManifest(name, {
        workloadRef: agentWorkloadReference(options.workloadName, options.workloadNamespace ?? defaultNamespace),
        promptReference: options.promptReference,
        retry: options.retry,
        timeoutMs: options.timeoutMs,
      });
      const result = await client.apply(manifest, {
        idempotencyKey: options.idempotencyKey,
        fieldManager: 'memeloop-agent-client',
      });
      if (!isAgentRun(result)) {
        throw new OrchestrationError({ code: 'UNKNOWN_EFFECT', message: 'apply returned a non-AgentRun resource', retryable: false });
      }
      return result;
    },

    async getRun(name: string, namespace?: string): Promise<AgentRunResource | null> {
      const result = await client.get(agentRunReference(name, resolveNamespace(namespace)));
      return result && isAgentRun(result) ? result : null;
    },

    async deleteRun(name: string, namespace?: string): Promise<void> {
      await client.delete(agentRunReference(name, resolveNamespace(namespace)));
    },

    async waitForRunCondition(
      name: string,
      condition: AgentRunCondition,
      options: WaitForConditionOptions = {},
    ): Promise<{ observedResourceVersion: string; matched: true }> {
      return pollCondition(
        () => this.getRun(name, defaultNamespace),
        condition,
        options,
      );
    },
  };
}
