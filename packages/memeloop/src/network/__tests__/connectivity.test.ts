import { describe, expect, it, vi } from 'vitest';

import { ConnectivityManager, detectPublicIP, resolveConnectAddress } from '../connectivity.js';

describe('connectivity', () => {
  it('resolveConnectAddress prefers LAN then frp/publicIP', () => {
    expect(resolveConnectAddress({} as any)).toBeNull();
    expect(resolveConnectAddress({ connectivity: { lanAddress: 'lan', frpAddress: 'frp', publicIP: 'pub' } })).toBe('lan');
    expect(resolveConnectAddress({ connectivity: { lanAddress: 'lan', frpAddress: 'frp', publicIP: 'pub' } }, false)).toBe('frp');
    expect(resolveConnectAddress({ connectivity: { publicIP: 'pub' } })).toBe('pub');
    expect(resolveConnectAddress({ connectivity: { lanAddress: 'lan' } }, false)).toBe('lan');
  });

  it('detectPublicIP tries multiple services and returns first valid ip', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any);
    fetchSpy
      .mockRejectedValueOnce(new Error('net'))
      .mockResolvedValueOnce(new Response('not an ip', { status: 200 }))
      .mockResolvedValueOnce(new Response('1.2.3.4\n', { status: 200 }));

    await expect(detectPublicIP()).resolves.toBe('1.2.3.4');
    fetchSpy.mockRestore();
  });

  it('ConnectivityManager manages state, frp tunnel, probes, advertised address', async () => {
    vi.useFakeTimers();
    const cm = new ConnectivityManager(38472);
    expect(cm.getAdvertisedAddress()).toBeNull();

    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValueOnce(new Response('9.9.9.9', { status: 200 }));
    await cm.detectPublicIP();
    expect(cm.getAdvertisedAddress()).toEqual({ type: 'publicIP', address: '9.9.9.9:38472' });

    const stopFn = vi.fn().mockResolvedValue(undefined);
    const stop = await cm.startFrpTunnel({ serverAddr: 'x', localPort: 1 }, async () => ({
      frpAddress: 'frp:1',
      stop: stopFn,
    }));
    expect(cm.getAdvertisedAddress()).toEqual({ type: 'publicIP', address: '9.9.9.9:38472' }); // publicIP wins

    await stop();
    expect(stopFn).toHaveBeenCalledTimes(1);

    // probe
    fetchSpy.mockResolvedValueOnce(new Response('8.8.8.8', { status: 200 }));
    const onProbe = vi.fn();
    cm.startProbe(10, onProbe);
    await vi.advanceTimersByTimeAsync(11);
    expect(onProbe).toHaveBeenCalledTimes(1);
    cm.stopProbe();

    fetchSpy.mockRestore();
    vi.useRealTimers();
  });
});
