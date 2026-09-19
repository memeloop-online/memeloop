import type { AgentFrameworkContext, ControllerRunnerHandle, ControlStore, ControlStoreActor, ToolOperationExecutionController, ToolOperationResource } from 'memeloop';
import { isToolOperation, TOOL_OPERATION_KIND } from 'memeloop';

export interface ToolOperationControllers {
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  stop(): Promise<void>;
}

export interface ToolOperationLifecycleOptions {
  controlStore: ControlStore;
  executionController: ToolOperationExecutionController;
  binding: ControllerRunnerHandle;
  execution: ControllerRunnerHandle;
  executorReference: {
    apiVersion: string;
    kind: string;
    name: string;
  };
  executorActor: ControlStoreActor;
  logger: NonNullable<AgentFrameworkContext['logger']>;
}

/**
 * Keep the cancellation watch and executor health transition in one place so
 * the placement/execution setup remains independent of runtime shutdown.
 */
export function createToolOperationLifecycle(
  options: ToolOperationLifecycleOptions,
): ToolOperationControllers {
  const {
    controlStore,
    executionController,
    binding,
    execution,
    executorReference,
    executorActor,
    logger,
  } = options;
  const cancellationWatchAbort = new AbortController();
  const cancellationIterator = controlStore.watch<
    ToolOperationResource['spec'],
    ToolOperationResource['status']
  >(
    { kind: TOOL_OPERATION_KIND },
    { signal: cancellationWatchAbort.signal },
  )[Symbol.asyncIterator]();
  let cancellationWatcherStopped = false;
  const cancellationDone = (async () => {
    while (!cancellationWatcherStopped) {
      const event = await cancellationIterator.next();
      if (event.done || !event.value) break;
      if (!('resource' in event.value)) {
        continue;
      }
      const resource = event.value.resource;
      if (!isToolOperation(resource)) {
        logger.warn?.('tool operation cancellation watcher ignored a mismatched resource');
        continue;
      }
      if (event.value.type === 'DELETED') {
        executionController.cancel(resource);
      } else if (
        event.value.type === 'MODIFIED' &&
        resource.status?.phase === 'Cancelled'
      ) {
        executionController.cancel(resource);
      }
    }
  })().catch((error: unknown) => {
    if (!cancellationWatcherStopped) {
      logger.warn?.('tool operation cancellation watcher stopped', error);
    }
  });

  return {
    binding,
    execution,
    async stop() {
      cancellationWatcherStopped = true;
      executionController.cancelAll();
      cancellationWatchAbort.abort();
      await cancellationIterator.return?.();
      await Promise.all([binding.stop(), execution.stop()]);
      await cancellationDone;
      const current = await controlStore.get(executorReference).catch(() => null);
      if (current) {
        await controlStore.updateStatus(
          executorActor,
          executorReference,
          { ...current.status, healthy: false, heartbeat: new Date().toISOString() },
          { resourceVersion: current.metadata.resourceVersion },
        ).catch(() => undefined);
      }
    },
  };
}
