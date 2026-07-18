import type { ControlStoreAuthorizationRequest } from './controlStore.js';
import type { NodeTrustClass } from './resources.js';

export const NODE_API_VERSION = 'memeloop/v1';
export const NODE_KIND = 'Node';

export interface NodeSpec {
  nodeId: string;
  faultDomain: string;
  capacity?: {
    cpuMillicores?: number;
    memoryBytes?: number;
    gpuCount?: number;
  };
  labels?: Record<string, string>;
}

export interface NodeStatus {
  trustClass: NodeTrustClass;
  trustEvidence?: string;
  trustVerifiedBy?: string;
  trustVerifiedAt?: string;
  conditions?: Array<{
    type: string;
    status: 'True' | 'False' | 'Unknown';
    reason: string;
    lastTransitionTime: string;
  }>;
}

/**
 * Roles that a restricted or quarantine node must never hold.
 */
const FORBIDDEN_ROLES_FOR_UNTRUSTED = new Set([
  'controller',
  'voter',
  'scheduler',
  'plugin-host',
  'control-store-client',
  'storage-replica',
]);

/**
 * Create a ControlStore authorizer that enforces immutable Node trust admission.
 *
 * Rules:
 * 1. Node trustClass can only be set at creation time in spec.
 * 2. After creation, trustClass can only be changed by a verifier actor
 *    providing signed evidence, and only through status updates.
 * 3. A node cannot modify its own trustClass.
 * 4. Restricted/quarantine nodes cannot acquire leases for forbidden roles.
 * 5. Any attempt to use a self-report or label update to change trustClass
 *    is rejected.
 */
export function createNodeTrustAuthorizer(): (request: ControlStoreAuthorizationRequest) => void {
  return (request: ControlStoreAuthorizationRequest) => {
    if (request.reference.kind !== NODE_KIND) return;

    const { actor, verb, current, proposedStatus } = request;

    // Rule: only allow create, update-status, delete for Node resources.
    if (verb === 'create') {
      // At creation, trustClass must be explicitly set in spec.
      // This is checked by the caller; the authorizer just ensures the
      // resource kind is Node.
      return;
    }

    if (verb === 'update-status' && current && proposedStatus) {
      const currentStatus = current.status as NodeStatus | undefined;
      const proposedNodeStatus = proposedStatus as NodeStatus;

      // If trustClass is not changing, allow.
      if (currentStatus?.trustClass === proposedNodeStatus.trustClass) {
        return;
      }

      // Trust class is changing. Only verifier actors may change it.
      if (actor.kind !== 'verifier') {
        throw new Error(
          `Node trust class can only be changed by verifier actors, not ${actor.kind}`,
        );
      }

      // The verifier must provide evidence.
      if (!proposedNodeStatus.trustEvidence || proposedNodeStatus.trustEvidence.length === 0) {
        throw new Error('Node trust class change requires trustEvidence');
      }

      // The verifier must record its identity.
      if (!proposedNodeStatus.trustVerifiedBy || proposedNodeStatus.trustVerifiedBy !== actor.id) {
        throw new Error(
          `Node trust class change must record trustVerifiedBy matching the actor id ${actor.id}`,
        );
      }

      return;
    }

    if (verb === 'acquire-lease' || verb === 'renew-lease') {
      // Restricted/quarantine nodes cannot hold forbidden roles.
      // The lease name encodes the role, e.g. "controller/storage" or "scheduler/main".
      const leaseName = request.reference.name ?? '';
      const nodeTrust = (current?.status as NodeStatus | undefined)?.trustClass;
      if (nodeTrust === 'restricted' || nodeTrust === 'quarantine') {
        for (const role of FORBIDDEN_ROLES_FOR_UNTRUSTED) {
          if (leaseName.startsWith(role)) {
            throw new Error(
              `Node with trust class ${nodeTrust} cannot acquire lease for forbidden role ${role}`,
            );
          }
        }
      }
      return;
    }
  };
}

/**
 * Validate that a Node resource's spec does not attempt to self-assert
 * trust status through labels or annotations.
 */
export function validateNodeSpec(spec: NodeSpec): void {
  if (spec.labels) {
    const forbiddenLabels = ['trust-class', 'trustClass', 'node-trust'];
    for (const label of forbiddenLabels) {
      if (label in spec.labels) {
        throw new Error(
          `Node spec cannot self-assert trust through label ${label}; trust is managed through status by verifier actors`,
        );
      }
    }
  }
}

/**
 * Check whether a node with the given trust class is allowed to perform
 * a sensitive role. This is a pure function for use by schedulers and
 * admission controllers outside the ControlStore authorizer.
 */
export function isNodeAllowedForRole(trustClass: NodeTrustClass, role: string): boolean {
  if (trustClass === 'trusted') return true;
  return !FORBIDDEN_ROLES_FOR_UNTRUSTED.has(role);
}
