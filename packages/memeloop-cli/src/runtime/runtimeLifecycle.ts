export interface RuntimeLifecyclePlan {
  /** Ingress fence: reject new work and drain active runs first. */
  disposeRuntime(): Promise<void>;
  unloadPlugins?(): Promise<void> | undefined;
  stopControllers: readonly (() => Promise<void> | undefined)[];
  disposeComponents: readonly (() => void)[];
  closeControlStore?(): Promise<void> | undefined;
  closeStorage?(): void;
}

export interface RuntimeLifecycle {
  stop(): Promise<void>;
}

/**
 * Compose runtime shutdown once. The ordering is explicit and reusable for
 * every host embedding: ingress fence, plugin/controller drains, synchronous
 * registries, durable stores. A second stop observes the same promise.
 */
export function createRuntimeLifecycle(plan: RuntimeLifecyclePlan): RuntimeLifecycle {
  let stopPromise: Promise<void> | undefined;
  const settle = async (operation: PromiseLike<unknown> | undefined, failures: unknown[]): Promise<void> => {
    if (!operation) return;
    try {
      await operation;
    } catch (error) {
      failures.push(error);
    }
  };
  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      const failures: unknown[] = [];
      await settle(plan.disposeRuntime(), failures);
      await settle(plan.unloadPlugins?.(), failures);
      const controllerResults: PromiseSettledResult<void>[] = await Promise.allSettled(
        plan.stopControllers.map(stopController => Promise.resolve(stopController())),
      );
      for (const result of controllerResults) {
        if (result.status === 'rejected') failures.push(result.reason as unknown);
      }
      for (const disposeComponent of plan.disposeComponents) {
        try {
          disposeComponent();
        } catch (error) {
          failures.push(error);
        }
      }
      await settle(plan.closeControlStore?.(), failures);
      try {
        plan.closeStorage?.();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'one or more MemeLoop runtime components failed to stop');
      }
    })();
    return stopPromise;
  };
  return { stop };
}
