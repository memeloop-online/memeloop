import { type AgentOrchestrationClient, createRemoteOrchestrationClient, OrchestrationError, type RemoteOrchestrationResponse, type RemoteOrchestrationTransport } from 'memeloop';

export type TauriInvoke = <T>(
  command: string,
  arguments_?: Record<string, unknown>,
) => Promise<T>;

export interface TauriOrchestrationTransportOptions {
  invoke: TauriInvoke;
  commands?: {
    request?: string;
    watchOpen?: string;
    watchNext?: string;
    watchClose?: string;
  };
}

interface WatchOpenResult {
  watchId: string;
}

type WatchNextResult =
  | { done: true }
  | { done: false; response: RemoteOrchestrationResponse };

function cancelled(): OrchestrationError {
  return new OrchestrationError({
    code: 'CANCELLED',
    message: 'Tauri orchestration watch was cancelled',
    retryable: false,
  });
}

/**
 * Portable Tauri WebView transport. The host injects `invoke` from
 * `@tauri-apps/api/core`; protocol packages do not depend on the Tauri SDK.
 */
export function createTauriOrchestrationTransport(
  options: TauriOrchestrationTransportOptions,
): RemoteOrchestrationTransport {
  const commands = {
    request: options.commands?.request ?? 'orchestration_request',
    watchOpen: options.commands?.watchOpen ?? 'orchestration_watch_open',
    watchNext: options.commands?.watchNext ?? 'orchestration_watch_next',
    watchClose: options.commands?.watchClose ?? 'orchestration_watch_close',
  };

  return {
    request(request, transportOptions) {
      if (transportOptions?.signal?.aborted) return Promise.reject(cancelled());
      return options.invoke<RemoteOrchestrationResponse>(commands.request, {
        request,
      });
    },
    async *watch(request, transportOptions) {
      if (transportOptions?.signal?.aborted) throw cancelled();
      const opened = await options.invoke<WatchOpenResult>(commands.watchOpen, {
        request,
      });
      if (!opened || typeof opened.watchId !== 'string' || !opened.watchId) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'Tauri orchestration bridge returned an invalid watchId',
          retryable: false,
        });
      }
      try {
        for (;;) {
          if (transportOptions?.signal?.aborted) throw cancelled();
          const next = await options.invoke<WatchNextResult>(
            commands.watchNext,
            { watchId: opened.watchId },
          );
          if (next.done) return;
          yield next.response;
        }
      } finally {
        await options.invoke<unknown>(commands.watchClose, {
          watchId: opened.watchId,
        }).catch(() => undefined);
      }
    },
  };
}

export function createTauriOrchestrationClient(
  options: TauriOrchestrationTransportOptions,
): AgentOrchestrationClient {
  return createRemoteOrchestrationClient(
    createTauriOrchestrationTransport(options),
  );
}
