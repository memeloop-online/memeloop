import type { AgentRuntimeRpcAuthorizationRequest, DeviceAuthorizer, TrustedDeviceRecord } from 'memeloop';

export { MutableDeviceAuthorizer } from 'memeloop';

export function locallyPairedRecord(record: TrustedDeviceRecord | undefined): TrustedDeviceRecord | undefined {
  return record?.trustMode === 'local-pairing' ? record : undefined;
}

/**
 * Preserve the authenticated transport decision at the Core RPC handler
 * boundary. The handler independently enforces method/resource grant scopes;
 * this bridge proves that a grant or explicit local pairing was authenticated
 * for the Noise-bound remote PeerId.
 */
export function authorizeAgentRuntimeRpcWithDeviceAuthorizer(
  authorizer: DeviceAuthorizer,
): (request: AgentRuntimeRpcAuthorizationRequest) => Promise<boolean> {
  return request =>
    authorizer.canOpenProtocol({
      remotePeerId: request.remotePeerId,
      protocol: '/memeloop/rpc/2.0.0',
      direction: 'inbound',
      presentedGrant: request.presentedGrant,
    });
}
