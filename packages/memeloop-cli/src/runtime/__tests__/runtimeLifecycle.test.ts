import { describe, expect, it } from 'vitest';

import { createRuntimeLifecycle } from '../runtimeLifecycle.js';

describe('runtime lifecycle', () => {
  it('fences ingress before drains and coalesces concurrent stop calls', async () => {
    const order: string[] = [];
    const lifecycle = createRuntimeLifecycle({
      disposeRuntime: async () => {
        order.push('runtime');
      },
      unloadPlugins: async () => {
        order.push('plugins');
      },
      stopControllers: [
        async () => {
          order.push('controller-a');
        },
        async () => {
          order.push('controller-b');
        },
      ],
      disposeComponents: [
        () => {
          order.push('components');
        },
      ],
      closeControlStore: async () => {
        order.push('control-store');
      },
      closeStorage: () => {
        order.push('storage');
      },
    });

    const first = lifecycle.stop();
    const second = lifecycle.stop();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(order).toEqual([
      'runtime',
      'plugins',
      'controller-a',
      'controller-b',
      'components',
      'control-store',
      'storage',
    ]);
  });

  it('aggregates component and controller failures after attempting every cleanup', async () => {
    const order: string[] = [];
    const lifecycle = createRuntimeLifecycle({
      disposeRuntime: async () => {
        order.push('runtime');
      },
      stopControllers: [
        async () => {
          order.push('controller');
          throw new Error('controller failed');
        },
      ],
      disposeComponents: [
        () => {
          order.push('component');
          throw new Error('component failed');
        },
      ],
      closeStorage: () => {
        order.push('storage');
      },
    });

    await expect(lifecycle.stop()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['runtime', 'controller', 'component', 'storage']);
  });
});
