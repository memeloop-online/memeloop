import type { DeviceAuthorizer, TrustedDeviceRecord } from 'memeloop';

/** Keeps a running libp2p node fail-closed while Cloud verification material refreshes. */
export class MutableDeviceAuthorizer implements DeviceAuthorizer {
  constructor(private delegate: DeviceAuthorizer) {}

  public setDelegate(delegate: DeviceAuthorizer): void {
    this.delegate = delegate;
  }

  public canOpenProtocol(input: Parameters<DeviceAuthorizer['canOpenProtocol']>[0]): Promise<boolean> {
    return this.delegate.canOpenProtocol(input);
  }
}

export function locallyPairedRecord(record: TrustedDeviceRecord | undefined): TrustedDeviceRecord | undefined {
  return record?.trustMode === 'local-pairing' ? record : undefined;
}
