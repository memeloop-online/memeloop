import type { Stream } from '@libp2p/interface';
import type { DeviceAuthorizer } from 'memeloop/device-network/portable';
import { deviceConnectionGrantAllowsRpc, isLibp2pRpcRequest, LIBP2P_RPC_RESPONSE_TYPE } from 'memeloop/device-network/portable';
import type { Libp2pDeviceNetworkServiceOptions } from './networkTypes.js';
import { RPC_IDLE_TIMEOUT_MS, RPC_MESSAGE_MAX_BYTES, RPC_PROTOCOL, RPC_TOTAL_TIMEOUT_MS } from './protocolConstants.js';
import { rpcErrorCode } from './protocolErrors.js';
import { rpcGrantResources } from './rpcGrantResources.js';
import { readJsonMessage, writeJsonMessage } from './streamIO.js';

export async function handleRpcStream(
  host: { authorizer: DeviceAuthorizer; options: Pick<Libp2pDeviceNetworkServiceOptions, 'rpcHandler' | 'resolveRunGrantResources'> },
  stream: Stream,
  remotePeerId: string,
): Promise<void> {
  const requestAbort = new AbortController();
  let responseFinished = false;
  const onStreamClose = (event: Event): void => {
    if (responseFinished || requestAbort.signal.aborted) return;
    const closeEvent = event as Event & { error?: Error };
    requestAbort.abort(closeEvent.error ?? new Error('rpc_stream_closed'));
  };
  stream.addEventListener?.('close', onStreamClose, { once: true });
  let requestId = 'unknown';
  try {
    // Cloud authorization needs request.grant, which v2 carries inside this bounded frame.
    const request = await readJsonMessage<unknown>(
      stream,
      RPC_MESSAGE_MAX_BYTES,
      RPC_IDLE_TIMEOUT_MS,
      RPC_TOTAL_TIMEOUT_MS,
    );
    requestAbort.signal.throwIfAborted();
    if (!isLibp2pRpcRequest(request)) throw new Error('invalid_rpc_request');
    requestId = request.id;
    const authorized = await host.authorizer.canOpenProtocol({
      remotePeerId,
      protocol: RPC_PROTOCOL,
      direction: 'inbound',
      presentedGrant: request.grant,
    });
    if (!authorized) throw new Error('device_not_trusted');
    const grantResources = await rpcGrantResources({
      method: request.method,
      parameters: request.params,
      remotePeerId,
      presentedGrant: request.grant,
      resolveRunGrantResources: host.options.resolveRunGrantResources,
    });
    if (request.grant) {
      if (
        grantResources.requiresAllConversations &&
        request.grant.conversationScope.mode !== 'all'
      ) throw new Error('device_grant_rpc_scope_violation');
      if (
        grantResources.requiresAllDefinitions &&
        request.grant.definitionScope.mode !== 'all'
      ) throw new Error('device_grant_rpc_scope_violation');
      if (
        !deviceConnectionGrantAllowsRpc(request.grant, {
          method: request.method,
          ...(grantResources.conversationId
            ? { conversationId: grantResources.conversationId }
            : {}),
          ...(grantResources.definitionId ? { definitionId: grantResources.definitionId } : {}),
        })
      ) throw new Error('device_grant_rpc_scope_violation');
    }
    if (!host.options.rpcHandler) throw new Error('rpc_handler_not_configured');
    const result = await host.options.rpcHandler({
      remotePeerId,
      method: request.method,
      parameters: request.params,
      presentedGrant: request.grant,
      signal: requestAbort.signal,
    });
    requestAbort.signal.throwIfAborted();
    await writeJsonMessage(
      stream,
      {
        type: LIBP2P_RPC_RESPONSE_TYPE,
        id: request.id,
        ok: true,
        result,
      },
      RPC_MESSAGE_MAX_BYTES,
    );
  } catch (error) {
    if (!requestAbort.signal.aborted) {
      await writeJsonMessage(
        stream,
        {
          type: LIBP2P_RPC_RESPONSE_TYPE,
          id: requestId,
          ok: false,
          error: { code: rpcErrorCode(error) },
        },
        RPC_MESSAGE_MAX_BYTES,
      ).catch(() => undefined);
    }
  } finally {
    responseFinished = true;
    stream.removeEventListener?.('close', onStreamClose);
    await stream.close().catch(() => undefined);
  }
}
