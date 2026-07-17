import type { NodeTrustClass } from './resources.js';
import type { AgentVolumeReplicaStatus, AgentVolumeResource, StorageClassResource } from './resources.js';

/**
 * Replicated storage controller (plan 24.45).
 *
 * Pure decision logic plus a thin executor over an injected transport:
 * - Placement spreads replicas across fault domains and never places trusted
 *   replicas on quarantine nodes (explicit class opt-in required).
 * - Every replica's content hash is verified against the volume's contentHash
 *   (the source of truth); mismatches and unreadable replicas are rebuilt
 *   from the primary.
 * - Transfers originate only from the fenced primary; primary changes bump a
 *   monotonically increasing epoch so stale primaries cannot serve data.
 * - Loss and corruption converge to the desired replica count.
 */

export interface ReplicationNode {
  nodeId: string;
  faultDomain?: string;
  trust: NodeTrustClass;
}

export interface ReplicationTransport {
  /** Read a replica's content hash; null when unreadable/missing. */
  readReplicaHash(volume: AgentVolumeResource, nodeId: string): Promise<string | null>;
  /** Transfer replica content from the primary to a target node; returns the stored hash. */
  transferReplica(volume: AgentVolumeResource, fromNodeId: string, toNodeId: string, epoch: number): Promise<string>;
}

export interface ReplicationContext extends ReplicationTransport {
  nodes: ReplicationNode[];
  now?: () => string;
}

export type ReplicationAction =
  | { type: 'elect-primary'; nodeId: string; epoch: number }
  | { type: 'mark-degraded'; nodeId: string; reason: string }
  | { type: 'mark-offline'; nodeId: string }
  | { type: 'place-replica'; nodeId: string; fromNodeId: string }
  | { type: 'rebuild-replica'; nodeId: string; fromNodeId: string };

export interface ReplicationResult {
  volume: AgentVolumeResource;
  actions: ReplicationAction[];
}

function desiredFactor(storageClass: StorageClassResource): number {
  return Math.max(1, storageClass.spec.replication?.factor ?? 1);
}

function isEligible(node: ReplicationNode, storageClass: StorageClassResource): boolean {
  if (node.trust === 'quarantine') {
    return storageClass.spec.replication?.allowQuarantineReplicas === true;
  }
  return true;
}

/**
 * Choose target nodes for new replicas, preferring fault domains not already
 * covered by existing replicas and skipping nodes that already host one.
 */
export function planReplicaPlacement(
  existing: AgentVolumeReplicaStatus[],
  candidates: ReplicationNode[],
  count: number,
): ReplicationNode[] {
  const usedNodes = new Set(existing.map((replica) => replica.nodeId));
  const usedDomains = new Set(
    existing
      .map((replica) => candidates.find((node) => node.nodeId === replica.nodeId)?.faultDomain)
      .filter((domain): domain is string => domain !== undefined),
  );
  const available = candidates.filter((node) => !usedNodes.has(node.nodeId));
  const freshDomain = available.filter((node) => node.faultDomain !== undefined && !usedDomains.has(node.faultDomain));
  const rest = available.filter((node) => !freshDomain.includes(node));
  return [...freshDomain, ...rest].slice(0, count);
}

/**
 * Reconcile one volume to its desired replica state. Reads and verifies all
 * replicas, elects/fences a primary, rebuilds corrupt or lost replicas, and
 * converges to the class's desired factor when autoRebuild is enabled.
 */
export async function reconcileVolumeReplication(
  volume: AgentVolumeResource,
  storageClass: StorageClassResource,
  context: ReplicationContext,
): Promise<ReplicationResult> {
  const now = context.now?.() ?? new Date().toISOString();
  const actions: ReplicationAction[] = [];
  const desired = desiredFactor(storageClass);
  const status = volume.status ?? {};
  const replicas: AgentVolumeReplicaStatus[] = [...(status.replicas ?? [])];
  let contentHash = status.contentHash;
  let primaryNodeId = status.primaryNodeId;
  let primaryEpoch = status.primaryEpoch ?? 0;

  // 1. Verify every replica's hash (null = unreadable/offline).
  const hashes = new Map<string, string | null>();
  for (const replica of replicas) {
    hashes.set(replica.nodeId, await context.readReplicaHash(volume, replica.nodeId));
  }

  // 2. Bootstrap the source of truth when none is recorded yet.
  if (!contentHash) {
    const readable = replicas.find((replica) => hashes.get(replica.nodeId) != null);
    contentHash = readable ? hashes.get(readable.nodeId)! : undefined;
    if (readable && contentHash) {
      primaryNodeId = readable.nodeId;
      primaryEpoch += 1;
      actions.push({ type: 'elect-primary', nodeId: readable.nodeId, epoch: primaryEpoch });
    }
  }

  // 3. Classify replicas against the source of truth.
  for (const [index, replica] of replicas.entries()) {
    const hash = hashes.get(replica.nodeId);
    if (hash == null) {
      if (replica.state !== 'offline') {
        replicas[index] = { ...replica, state: 'offline', updatedAt: now };
        actions.push({ type: 'mark-offline', nodeId: replica.nodeId });
      }
      continue;
    }
    if (contentHash && hash !== contentHash) {
      if (replica.state !== 'degraded') {
        replicas[index] = { ...replica, state: 'degraded', contentHash: hash, updatedAt: now };
        actions.push({ type: 'mark-degraded', nodeId: replica.nodeId, reason: 'content hash mismatch' });
      }
      continue;
    }
    if (replica.state !== 'healthy' || replica.contentHash !== hash) {
      replicas[index] = { ...replica, state: 'healthy', contentHash: hash, updatedAt: now };
    }
  }

  const healthyReplicas = () => replicas.filter((replica) => replica.state === 'healthy' && replica.contentHash === contentHash);

  // 4. Fence a primary: keep the current one if still healthy, otherwise elect
  //    a healthy replica. Primary changes bump the epoch; transfers originate
  //    only from the primary.
  const primaryHealthy = primaryNodeId !== undefined && healthyReplicas().some((replica) => replica.nodeId === primaryNodeId);
  if (!primaryHealthy) {
    const candidate = healthyReplicas()[0];
    if (candidate) {
      primaryNodeId = candidate.nodeId;
      primaryEpoch += 1;
      actions.push({ type: 'elect-primary', nodeId: candidate.nodeId, epoch: primaryEpoch });
    } else {
      primaryNodeId = undefined;
    }
  }

  // 5. Rebuild corrupt replicas from the primary.
  if (primaryNodeId && contentHash && storageClass.spec.replication?.autoRebuild !== false) {
    for (const [index, replica] of replicas.entries()) {
      if (replica.state !== 'degraded') continue;
      replicas[index] = { ...replica, state: 'rebuilding', updatedAt: now };
      actions.push({ type: 'rebuild-replica', nodeId: replica.nodeId, fromNodeId: primaryNodeId });
      const stored = await context.transferReplica(volume, primaryNodeId, replica.nodeId, primaryEpoch);
      replicas[index] = stored === contentHash
        ? { ...replicas[index], state: 'healthy', contentHash: stored, updatedAt: now }
        : { ...replicas[index], state: 'degraded', contentHash: stored, updatedAt: now };
    }
  }

  // 6. Place new replicas until the desired factor is met.
  const hostingNodes = new Set(replicas.map((replica) => replica.nodeId));
  const missing = desired - healthyReplicas().length - replicas.filter((replica) => replica.state === 'rebuilding').length;
  if (primaryNodeId && contentHash && missing > 0 && storageClass.spec.replication?.autoRebuild !== false) {
    const candidates = context.nodes.filter((node) => isEligible(node, storageClass));
    const targets = planReplicaPlacement(replicas, candidates, missing);
    for (const target of targets) {
      if (hostingNodes.has(target.nodeId)) continue;
      actions.push({ type: 'place-replica', nodeId: target.nodeId, fromNodeId: primaryNodeId });
      const stored = await context.transferReplica(volume, primaryNodeId, target.nodeId, primaryEpoch);
      replicas.push({
        nodeId: target.nodeId,
        state: stored === contentHash ? 'healthy' : 'degraded',
        contentHash: stored,
        updatedAt: now,
      });
      hostingNodes.add(target.nodeId);
    }
  }

  const healthy = healthyReplicas().length;
  const health = healthy >= desired ? 'healthy' : healthy > 0 || replicas.some((replica) => replica.state === 'rebuilding') ? 'degraded' : 'failed';

  return {
    volume: {
      ...volume,
      status: {
        ...status,
        replicas,
        ...(contentHash ? { contentHash } : {}),
        // Always overwrite: a lost primary must not linger in status.
        primaryNodeId,
        primaryEpoch,
        health,
      },
    },
    actions,
  };
}
