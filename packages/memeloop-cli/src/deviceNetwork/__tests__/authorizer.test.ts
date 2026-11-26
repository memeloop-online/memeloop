import { AGENT_DEVICE_RPC_METHODS, createAgentRuntimeDeviceRpcHandler, type DeviceAuthorizer, type DeviceCloudCommitFence, type TrustedDeviceRecord } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { authorizeAgentRuntimeRpcWithDeviceAuthorizer, locallyPairedRecord, MutableDeviceAuthorizer } from '../authorizer.js';

function record(trustMode: TrustedDeviceRecord['trustMode']): TrustedDeviceRecord {
  return {
    peerId: 'peer-1',
    publicKeyMultibase: 'zPublicKey',
    deviceName: 'Peer',
    platform: 'cli',
    trustMode,
    createdAt: 1,
  };
}

function currentFence(): DeviceCloudCommitFence {
  const controller = new AbortController();
  return {
    generation: 1,
    signal: controller.signal,
    isCurrent: () => true,
    throwIfStale: () => undefined,
    commitSynchronous: ((operation: () => unknown) => {
      operation();
      return true;
    }) as DeviceCloudCommitFence['commitSynchronous'],
  };
}

describe('CLI device authorizer helpers', () => {
  it('allows only explicit local pairing to bypass Cloud grants', () => {
    const local = record('local-pairing');
    expect(locallyPairedRecord(local)).toBe(local);
    expect(locallyPairedRecord(record('cloud-account'))).toBeUndefined();
  });

  it('can replace a fail-closed delegate without restarting libp2p', async () => {
    const denied = { canOpenProtocol: vi.fn().mockResolvedValue(false) } satisfies DeviceAuthorizer;
    const allowed = { canOpenProtocol: vi.fn().mockResolvedValue(true) } satisfies DeviceAuthorizer;
    const mutable = new MutableDeviceAuthorizer(denied);
    const input = { remotePeerId: 'peer-1', protocol: '/memeloop/rpc/2.0.0' as const };

    await expect(mutable.canOpenProtocol(input)).resolves.toBe(false);
    expect(mutable.setDelegate(allowed, currentFence())).toBe(true);
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(true);
  });

  it('carries the authenticated RPC peer decision into the Core handler boundary', async () => {
    const canOpenProtocol = vi.fn().mockResolvedValue(true);
    const authorize = authorizeAgentRuntimeRpcWithDeviceAuthorizer({ canOpenProtocol });

    await expect(authorize({
      remotePeerId: 'paired-peer',
      method: 'memeloop.agent.getDefinitions',
      permission: 'agent.read',
      presentedGrant: undefined,
    })).resolves.toBe(true);
    expect(canOpenProtocol).toHaveBeenCalledWith({
      remotePeerId: 'paired-peer',
      protocol: '/memeloop/rpc/2.0.0',
      direction: 'inbound',
      presentedGrant: undefined,
    });

    const handler = createAgentRuntimeDeviceRpcHandler({
      runtime: {} as never,
      storage: {} as never,
      scheduledTaskHandler: async () => {
        throw new Error('scheduled_task_not_expected');
      },
      getAgentDefinitions: () => [],
      authorize,
    });
    await expect(handler({
      remotePeerId: 'paired-peer',
      method: AGENT_DEVICE_RPC_METHODS.getDefinitions,
      parameters: {},
    })).resolves.toEqual({ definitions: [] });
  });
});
