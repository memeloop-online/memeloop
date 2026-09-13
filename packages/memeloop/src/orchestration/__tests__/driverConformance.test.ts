import { describe, expect, it, vi } from 'vitest';

import {
  createFakeModelProviderDriver,
  createFakeNetworkDriver,
  createFakeToolExecutionDriver,
  createModelProviderDriverConformanceSuite,
  createNetworkDriverConformanceSuite,
  createToolExecutionDriverConformanceSuite,
  runConformanceSuite,
} from '../drivers/driverConformance.js';

describe('driverConformance', () => {
  it('runs network driver conformance suite against fake driver', async () => {
    const driver = createFakeNetworkDriver();
    const suite = createNetworkDriverConformanceSuite();
    const result = await runConformanceSuite(suite, driver);

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(3);
  });

  it('runs model provider driver conformance suite against fake driver', async () => {
    const driver = createFakeModelProviderDriver();
    const suite = createModelProviderDriverConformanceSuite();
    const result = await runConformanceSuite(suite, driver);

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
  });

  it('runs tool execution driver conformance suite against fake driver', async () => {
    const driver = createFakeToolExecutionDriver();
    const suite = createToolExecutionDriverConformanceSuite();
    const result = await runConformanceSuite(suite, driver);

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
  });

  it('reports failures when driver does not conform', async () => {
    const badDriver = {
      getCapabilities: async () => ({}),
      prepare: async () => ({}),
      check: async () => ({}),
    };
    const suite = createNetworkDriverConformanceSuite();
    const result = await runConformanceSuite(suite, badDriver);

    expect(result.failed).toBeGreaterThan(0);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('does not complete before the injected latency elapses', async () => {
    vi.useFakeTimers();
    try {
      const driver = createFakeNetworkDriver({ latencyMs: 10 });
      const completed = vi.fn();
      const pending = driver.getCapabilities().then(completed);

      await vi.advanceTimersByTimeAsync(9);
      expect(completed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(completed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fake network driver supports failure injection', async () => {
    const driver = createFakeNetworkDriver({ failureRate: 1 });
    await expect(driver.getCapabilities()).rejects.toThrow('injected failure');
  });
});
