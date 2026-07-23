import type { Controller } from './controllerRunner.js';
import type { CredentialGrantResource, CredentialGrantStatus } from './resources.js';
import type { CredentialBrokerDriver, CredentialGrantHandle } from './security/credentialBroker.js';

export interface CredentialBrokerEndpoint {
  nodeId: string;
  brokerClass: string;
  healthy: boolean;
  audiences: string[];
  methods?: string[];
  /** Exact targets or prefix patterns ending in `*`. */
  targets?: string[];
  activeGrants?: number;
  maxGrants?: number;
}

export interface CredentialGrantPlacementRequirements {
  brokerClass?: string;
  requiredNode?: string;
  /** Host admission denial; binding becomes terminal Failed. */
  denyReason?: string;
}

export interface CredentialGrantBindingControllerOptions {
  listBrokers(): Promise<CredentialBrokerEndpoint[]>;
  requirementsForGrant?(
    grant: CredentialGrantResource,
  ): Promise<CredentialGrantPlacementRequirements>;
  now?: () => Date;
}

function targetMatches(pattern: string, target: string): boolean {
  return pattern.endsWith('*')
    ? target.startsWith(pattern.slice(0, -1))
    : pattern === target;
}

/** Independently selects a healthy broker that can honor the complete scope. */
export function createCredentialGrantBindingController(
  options: CredentialGrantBindingControllerOptions,
): Controller<CredentialGrantResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const grant = request.resource as CredentialGrantResource;
      const status = grant.status ?? {};
      if (status.phase && status.phase !== 'Pending') return { ready: true };
      const requirements = await options.requirementsForGrant?.(grant) ?? {};
      if (requirements.denyReason) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'FORBIDDEN',
              message: requirements.denyReason,
              retryable: false,
            },
          } satisfies CredentialGrantStatus,
          ready: true,
        };
      }
      const candidates = (await options.listBrokers()).filter((broker) =>
        broker.healthy &&
        (!requirements.requiredNode || broker.nodeId === requirements.requiredNode) &&
        (!requirements.brokerClass || broker.brokerClass === requirements.brokerClass) &&
        broker.audiences.includes(grant.spec.audience) &&
        (!broker.methods?.length || broker.methods.includes(grant.spec.method)) &&
        (!broker.targets?.length || broker.targets.some((pattern) => targetMatches(pattern, grant.spec.target))) &&
        (broker.maxGrants === undefined || (broker.activeGrants ?? 0) < broker.maxGrants)
      ).sort((left, right) =>
        (left.activeGrants ?? 0) - (right.activeGrants ?? 0) ||
        left.nodeId.localeCompare(right.nodeId) ||
        left.brokerClass.localeCompare(right.brokerClass)
      );
      const selected = candidates[0];
      const reconciledAt = now().toISOString();
      if (!selected) {
        const { assignedNode: _node, assignedBroker: _broker, binding: _binding, ...unbound } = status;
        return {
          status: {
            ...unbound,
            phase: 'Pending',
            conditions: [{
              type: 'CredentialBrokerScheduled',
              status: 'False',
              reason: 'NoEligibleBroker',
              message: `no healthy credential broker satisfies '${grant.spec.audience}' / '${grant.spec.target}'`,
              lastTransitionTime: reconciledAt,
            }],
          } satisfies CredentialGrantStatus,
          requeueAfterMs: 1000,
        };
      }
      if (
        status.assignedNode === selected.nodeId &&
        status.assignedBroker === selected.brokerClass &&
        status.binding?.leaseEpoch === request.leaseEpoch
      ) return { ready: true };
      return {
        status: {
          ...status,
          phase: 'Pending',
          assignedNode: selected.nodeId,
          assignedBroker: selected.brokerClass,
          binding: { leaseEpoch: request.leaseEpoch, boundAt: reconciledAt },
          conditions: [{
            type: 'CredentialBrokerScheduled',
            status: 'True',
            reason: 'BrokerSelected',
            message: `bound to '${selected.brokerClass}' on '${selected.nodeId}'`,
            lastTransitionTime: reconciledAt,
          }],
        } satisfies CredentialGrantStatus,
        ready: true,
      };
    },
  };
}

export interface CredentialHandleVault {
  /** The token remains outside ControlStore; handleRef is safe to persist. */
  put(handleReference: string, handle: CredentialGrantHandle): Promise<void>;
  get(handleReference: string): Promise<CredentialGrantHandle | undefined>;
  delete(handleReference: string): Promise<void>;
}

export interface CredentialGrantExecutionControllerOptions {
  nodeId: string;
  getBroker(
    brokerClass: string,
    nodeId: string,
  ): Promise<CredentialBrokerDriver | undefined>;
  vault: CredentialHandleVault;
  now?: () => Date;
}

/** Persists a fencing claim before issuing a worker-visible credential. */
export function createCredentialGrantExecutionController(
  options: CredentialGrantExecutionControllerOptions,
): Controller<CredentialGrantResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const grant = request.resource as CredentialGrantResource;
      const status = grant.status ?? {};
      if (status.assignedNode !== options.nodeId || !status.assignedBroker || !status.binding) {
        return { ready: true };
      }
      if (
        status.phase === 'Issued' ||
        status.phase === 'Renewed' ||
        status.phase === 'Revoked' ||
        status.phase === 'Expired' ||
        status.phase === 'Failed'
      ) return { ready: true };
      const broker = await options.getBroker(status.assignedBroker, options.nodeId);
      if (!broker) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNAVAILABLE',
              message: `bound credential broker '${status.assignedBroker}' is unavailable`,
              retryable: true,
            },
          } satisfies CredentialGrantStatus,
          ready: true,
        };
      }
      if (status.phase !== 'Issuing') {
        return {
          status: {
            ...status,
            phase: 'Issuing',
            issuanceClaim: {
              leaseEpoch: request.leaseEpoch,
              claimedAt: now().toISOString(),
            },
          } satisfies CredentialGrantStatus,
          requeueAfterMs: 1,
        };
      }
      if (status.issuanceClaim?.leaseEpoch !== request.leaseEpoch) {
        return {
          status: {
            ...status,
            phase: 'Failed',
            error: {
              code: 'UNKNOWN_EFFECT',
              message: 'controller epoch changed after credential issuance was claimed; refusing duplicate issuance',
              retryable: false,
            },
          } satisfies CredentialGrantStatus,
          ready: true,
        };
      }
      const handle = await broker.issue({
        ...grant.spec,
        grantId: grant.metadata.uid,
      });
      const handleReference = `credential://${options.nodeId}/${grant.metadata.uid}`;
      await options.vault.put(handleReference, handle);
      return {
        status: {
          ...status,
          phase: 'Issued',
          handleRef: handleReference,
          issuedAt: handle.claims.issuedAt,
          expiresAt: handle.claims.expiresAt,
          exposure: 'worker-visible',
          rotationRequired: true,
          rotationReason: 'grant was issued for a worker; rotate the underlying credential after exposure',
        } satisfies CredentialGrantStatus,
        ready: true,
      };
    },
  };
}

export async function revokeCredentialGrant(
  grant: CredentialGrantResource,
  broker: CredentialBrokerDriver,
  vault: CredentialHandleVault,
): Promise<void> {
  const handleReference = grant.status?.handleRef;
  if (!handleReference) return;
  const handle = await vault.get(handleReference);
  broker.revoke(handle?.claims.grantId ?? grant.metadata.uid);
  await vault.delete(handleReference);
}

export interface CredentialGrantLifecycleControllerOptions {
  nodeId: string;
  getBroker(
    brokerClass: string,
    nodeId: string,
  ): Promise<CredentialBrokerDriver | undefined>;
  vault: CredentialHandleVault;
  isRunTerminal(grant: CredentialGrantResource): Promise<boolean>;
  now?: () => Date;
}

/** Revokes issued grants on Run termination or expiry, including after restart. */
export function createCredentialGrantLifecycleController(
  options: CredentialGrantLifecycleControllerOptions,
): Controller<CredentialGrantResource['spec']> {
  const now = options.now ?? (() => new Date());
  return {
    async reconcile(request) {
      const grant = request.resource as CredentialGrantResource;
      const status = grant.status ?? {};
      if (
        status.assignedNode !== options.nodeId ||
        !status.assignedBroker ||
        (status.phase !== 'Issued' && status.phase !== 'Renewed')
      ) return { ready: true };
      const broker = await options.getBroker(status.assignedBroker, options.nodeId);
      if (!broker) return { requeueAfterMs: 1000 };
      const checkedAt = now();
      const expired = !Number.isFinite(Date.parse(status.expiresAt ?? '')) ||
        checkedAt.getTime() >= Date.parse(status.expiresAt ?? '');
      const runTerminal = await options.isRunTerminal(grant);
      if (!expired && !runTerminal) {
        return {
          requeueAfterMs: Math.max(
            1,
            Math.min(1000, Date.parse(status.expiresAt ?? '') - checkedAt.getTime()),
          ),
        };
      }
      await revokeCredentialGrant(grant, broker, options.vault);
      return {
        status: {
          ...status,
          phase: expired ? 'Expired' : 'Revoked',
          revokedAt: checkedAt.toISOString(),
        } satisfies CredentialGrantStatus,
        ready: true,
      };
    },
  };
}
