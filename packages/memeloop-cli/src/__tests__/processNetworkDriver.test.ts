import { describe, expect, it, vi } from 'vitest';

import type { NetworkAttachmentResource, NetworkClassResource } from 'memeloop';
import { createProcessNetworkDriver, MODEL_GATEWAY_ENV, PROCESS_NETWORK_DRIVER_NAME } from '../orchestration/processNetworkDriver.js';

function networkClass(spec: Partial<NetworkClassResource['spec']>): NetworkClassResource {
  return {
    apiVersion: 'network.memeloop.io/v1alpha1',
    kind: 'NetworkClass',
    metadata: { name: 'net-1', uid: 'uid-net-1', generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec: { driver: PROCESS_NETWORK_DRIVER_NAME, enforcement: 'best-effort', ...spec },
  };
}

function attachment(): NetworkAttachmentResource {
  return {
    apiVersion: 'network.memeloop.io/v1alpha1',
    kind: 'NetworkAttachment',
    metadata: { name: 'attach-1', uid: 'uid-attach-1', generation: 1, resourceVersion: '1', creationTimestamp: '' },
    spec: {
      networkClassRef: { apiVersion: 'network.memeloop.io/v1alpha1', kind: 'NetworkClass', name: 'net-1' },
    },
  };
}

describe('createProcessNetworkDriver', () => {
  it('truthfully reports process-level enforcement limits', async () => {
    const driver = createProcessNetworkDriver();
    const capabilities = await driver.getCapabilities();

    expect(capabilities.name).toBe(PROCESS_NETWORK_DRIVER_NAME);
    expect(capabilities.enforcedFeatures).toEqual(['proxy']);
    expect(capabilities.supportsRequiredEnforcement).toBe(false);

    const health = await driver.getHealth();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain('process-level');
    expect(health.detail).toContain('no protection from a hostile host');
  });

  it('rejects enforcement-required classes instead of silently downgrading', async () => {
    const driver = createProcessNetworkDriver();
    const status = await driver.attach({
      attachment: attachment(),
      networkClass: networkClass({ enforcement: 'required', egress: { defaultAction: 'deny' } }),
      sandboxRef: 'pid:1',
    });

    expect(status.phase).toBe('Failed');
    expect(status.error?.code).toBe('FORBIDDEN');
  });

  it('injects proxy environment for a best-effort proxy class and reports bypass degradation for mandatory', async () => {
    const driver = createProcessNetworkDriver();
    const status = await driver.attach({
      attachment: attachment(),
      networkClass: networkClass({
        proxy: { httpsProxy: 'http://proxy:8080', noProxy: ['localhost'], mandatory: true },
        egress: { defaultAction: 'deny' },
      }),
      sandboxRef: 'pid:1',
    });

    expect(status.phase).toBe('Attached');
    expect(status.degraded).toContain('egress');
    expect(status.degraded).toContain('proxy-bypass');

    const patch = driver.getEnvironmentPatch(status.handle ?? '');
    expect(patch).toEqual({ HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost' });
  });

  it('fails a mandatory proxy class when no proxy endpoint is available', async () => {
    const driver = createProcessNetworkDriver();
    const status = await driver.attach({
      attachment: attachment(),
      networkClass: networkClass({ proxy: { mandatory: true } }),
      sandboxRef: 'pid:1',
    });

    expect(status.phase).toBe('Failed');
    expect(status.error?.code).toBe('UNAVAILABLE');
  });

  it('uses the driver default proxy for a class without an explicit address', async () => {
    const driver = createProcessNetworkDriver({ defaultProxy: 'http://default-proxy:3128' });
    const status = await driver.attach({
      attachment: attachment(),
      networkClass: networkClass({ proxy: {} }),
      sandboxRef: 'pid:1',
    });

    expect(status.phase).toBe('Attached');
    expect(driver.getEnvironmentPatch(status.handle ?? '')).toEqual({ HTTPS_PROXY: 'http://default-proxy:3128' });
  });

  it('resolves the model gateway service into the environment patch', async () => {
    const resolveService = vi.fn().mockResolvedValue('gateway://default');
    const driver = createProcessNetworkDriver({ resolveService });
    const status = await driver.attach({
      attachment: attachment(),
      networkClass: networkClass({ serviceAccess: { allowModelGateway: true } }),
      sandboxRef: 'pid:1',
    });

    expect(status.phase).toBe('Attached');
    expect(resolveService).toHaveBeenCalledWith('model-gateway');
    expect(driver.getEnvironmentPatch(status.handle ?? '')?.[MODEL_GATEWAY_ENV]).toBe('gateway://default');
  });

  it('detach removes the environment patch', async () => {
    const driver = createProcessNetworkDriver();
    const status = await driver.attach({
      attachment: attachment(),
      networkClass: networkClass({ proxy: { httpsProxy: 'http://proxy:8080' } }),
      sandboxRef: 'pid:1',
    });

    const handle = status.handle ?? '';
    expect(driver.getEnvironmentPatch(handle)).toBeDefined();
    await driver.detach(handle);
    expect(driver.getEnvironmentPatch(handle)).toBeUndefined();
  });
});
