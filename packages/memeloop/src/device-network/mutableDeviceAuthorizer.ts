import type { DeviceAuthorizer, DeviceCloudCommitFence } from './types.js';

/**
 * Stable authorizer identity for long-lived network runtimes.
 *
 * Active-generation replacements are fenced. Reset is intentionally a
 * separate operation for the coordinator's serialized disposal phase, where
 * the old generation is already aborted and no active-generation fence can be
 * current.
 */
export class MutableDeviceAuthorizer implements DeviceAuthorizer {
  private delegate: DeviceAuthorizer;

  constructor(private readonly fallbackDelegate: DeviceAuthorizer) {
    this.delegate = fallbackDelegate;
  }

  /** Atomically install a delegate only while its Cloud generation is current. */
  public setDelegate(delegate: DeviceAuthorizer, fence: DeviceCloudCommitFence): boolean {
    return fence.commitSynchronous(() => {
      this.delegate = delegate;
    });
  }

  /** Restore the fail-closed/local-only delegate during serialized disposal. */
  public resetDelegate(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.delegate = this.fallbackDelegate;
    signal.throwIfAborted();
  }

  public canOpenProtocol(input: Parameters<DeviceAuthorizer['canOpenProtocol']>[0]): Promise<boolean> {
    // Capture one delegate per authorization call. A generation switch cannot
    // split a single decision across two verification policies.
    const delegate = this.delegate;
    return delegate.canOpenProtocol(input);
  }
}
