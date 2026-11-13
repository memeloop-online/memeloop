import type { DeviceConnectionGrant } from 'memeloop/device-network/portable';
import { AGENT_DEVICE_RPC_METHODS, deviceConnectionGrantAllowsRpc, isAgentDeviceRpcMethod, parseAgentDeviceRpcGrantResources } from 'memeloop/device-network/portable';
import type { Libp2pDeviceNetworkServiceOptions } from './networkTypes.js';
import { assertRpcGrantResourceIdentifier } from './requestParameters.js';

interface RpcGrantResources {
  conversationId?: string;
  definitionId?: string;
  requiresAllConversations?: boolean;
  requiresAllDefinitions?: boolean;
}

export async function rpcGrantResources(input: {
  method: string;
  parameters: unknown;
  remotePeerId: string;
  presentedGrant?: DeviceConnectionGrant;
  resolveRunGrantResources?: Libp2pDeviceNetworkServiceOptions['resolveRunGrantResources'];
}): Promise<RpcGrantResources> {
  if (!isAgentDeviceRpcMethod(input.method)) {
    throw new Error(`rpc_method_not_found:${input.method}`);
  }
  const asserted = parseAgentDeviceRpcGrantResources(input.method, input.parameters);
  const resources: RpcGrantResources = {
    ...(asserted.conversationId === undefined
      ? {}
      : { conversationId: asserted.conversationId }),
    ...(asserted.definitionId === undefined ? {} : { definitionId: asserted.definitionId }),
    ...(input.method === AGENT_DEVICE_RPC_METHODS.listConversations ||
        (input.method === AGENT_DEVICE_RPC_METHODS.create && asserted.conversationId === undefined)
      ? { requiresAllConversations: true }
      : {}),
    ...(input.method === AGENT_DEVICE_RPC_METHODS.getDefinitions
      ? { requiresAllDefinitions: true }
      : {}),
  };
  if (input.presentedGrant) {
    if (
      resources.requiresAllConversations &&
      input.presentedGrant.conversationScope.mode !== 'all'
    ) throw new Error('device_grant_rpc_scope_violation');
    if (
      resources.requiresAllDefinitions &&
      input.presentedGrant.definitionScope.mode !== 'all'
    ) throw new Error('device_grant_rpc_scope_violation');
    if (
      !deviceConnectionGrantAllowsRpc(input.presentedGrant, {
        method: input.method,
        ...(resources.conversationId ? { conversationId: resources.conversationId } : {}),
        ...(resources.definitionId ? { definitionId: resources.definitionId } : {}),
      })
    ) throw new Error('device_grant_rpc_scope_violation');
  }
  if (!input.presentedGrant || asserted.runId === undefined) return resources;

  const resolved = await input.resolveRunGrantResources?.(asserted.runId, input.remotePeerId);
  if (!resolved) throw new Error('device_grant_run_scope_unavailable');
  assertRpcGrantResourceIdentifier(resolved.requestPeerId);
  assertRpcGrantResourceIdentifier(resolved.conversationId);
  assertRpcGrantResourceIdentifier(resolved.definitionId);
  if (resolved.requestPeerId !== input.remotePeerId) {
    throw new Error('device_grant_run_peer_mismatch');
  }
  if (
    asserted.conversationId !== undefined &&
    asserted.conversationId !== resolved.conversationId
  ) {
    throw new Error('device_grant_run_conversation_mismatch');
  }
  return {
    conversationId: resolved.conversationId,
    definitionId: resolved.definitionId,
  };
}
