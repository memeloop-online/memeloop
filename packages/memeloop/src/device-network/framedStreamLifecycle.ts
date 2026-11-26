/** Shared abort/cleanup lifecycle for length-prefixed RPC streams. */

export interface FramedAbortableStream {
  abort(error: Error): Promise<void> | void;
}

export interface FramedStreamLifecycle {
  abort(error: Error): Promise<void>;
  dispose(): void;
}

export function bindFramedStreamLifecycle(
  stream: FramedAbortableStream,
  signal: AbortSignal | undefined,
  abortReason: Error,
): FramedStreamLifecycle {
  let aborted = false;
  const abort = async (error: Error): Promise<void> => {
    if (aborted) return;
    aborted = true;
    await stream.abort(error);
  };
  const onAbort = () => {
    void abort(signal?.reason instanceof Error ? signal.reason : abortReason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return {
    abort,
    dispose: () => signal?.removeEventListener('abort', onAbort),
  };
}
