import { safeErrorFromUnknown } from 'memeloop';

import type { MemeLoopChatOperation } from './coreTypes.js';

/**
 * Describes a failure raised by an error/listener observer.
 *
 * Observers are host-owned notification hooks. They must not be allowed to
 * replace the operation failure that caused the notification, but their own
 * failures still need a durable, host-independent record.
 */
export interface MemeLoopObserverFailure {
  readonly error: Error;
  readonly source: string;
  readonly operation?: MemeLoopChatOperation;
}

export type MemeLoopObserverErrorHandler = (failure: MemeLoopObserverFailure) => void;

const MAX_RECORDED_OBSERVER_FAILURES = 64;
const recordedObserverFailures: MemeLoopObserverFailure[] = [];

function createObserverFailure(
  error: unknown,
  source: string,
  operation: MemeLoopChatOperation | undefined,
): MemeLoopObserverFailure {
  return Object.freeze({
    error: safeErrorFromUnknown(error, { fallback: 'memeloop-ui-observer-failed', maxBytes: 4_096 }),
    source,
    ...(operation === undefined ? {} : { operation }),
  });
}

/**
 * Records an observer failure in a bounded in-memory sink. This is deliberately
 * independent of `console` and remains available when a host has no secondary
 * observer hook.
 */
export function recordMemeLoopObserverFailure(
  error: unknown,
  source: string,
  operation?: MemeLoopChatOperation,
): MemeLoopObserverFailure {
  const failure = createObserverFailure(error, source, operation);
  if (recordedObserverFailures.length >= MAX_RECORDED_OBSERVER_FAILURES) recordedObserverFailures.shift();
  recordedObserverFailures.push(failure);
  return failure;
}

/** Returns a stable snapshot of observer failures recorded by this package. */
export function getMemeLoopObserverFailures(): readonly MemeLoopObserverFailure[] {
  return Object.freeze([...recordedObserverFailures]);
}

/** Clears the package-level observer-failure sink (primarily for host teardown/tests). */
export function clearMemeLoopObserverFailures(): void {
  recordedObserverFailures.length = 0;
}

/** Records a caught observer/cleanup failure and offers it to a secondary hook. */
export function reportMemeLoopObserverFailure(
  error: unknown,
  source: string,
  operation: MemeLoopChatOperation | undefined,
  onObserverError?: MemeLoopObserverErrorHandler,
): MemeLoopObserverFailure {
  const failure = recordMemeLoopObserverFailure(error, source, operation);
  if (!onObserverError) return failure;
  try {
    onObserverError(failure);
  } catch (secondaryError) {
    recordMemeLoopObserverFailure(secondaryError, `${source}:onObserverError`, operation);
  }
  return failure;
}

/**
 * Invokes a notification observer without allowing it to break the UI event.
 * A secondary observer receives a structured record; if it also fails, both
 * failures remain observable through the bounded package sink.
 */
export function notifyMemeLoopObserver(
  callback: (() => void) | undefined,
  source: string,
  operation: MemeLoopChatOperation | undefined,
  onObserverError?: MemeLoopObserverErrorHandler,
): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    reportMemeLoopObserverFailure(error, source, operation, onObserverError);
  }
}
