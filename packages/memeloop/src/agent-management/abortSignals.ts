/** Link session lifetime with one optional caller cancellation signal. */
export function linkAbortSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const signals = secondary === undefined ? [primary] : [primary, secondary];
  const relay = (signal: AbortSignal) => () => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  const listeners = signals.map(signal => ({ signal, listener: relay(signal) }));
  for (const { signal, listener } of listeners) {
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener);
      }
    },
  };
}
