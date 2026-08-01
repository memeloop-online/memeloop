import type { DeviceAuthorizer, MemeLoopProtocol, TrustedDeviceRecord } from './types.js';

export interface LocalTrustDeviceAuthorizerOptions {
  trustedDevices?: Iterable<TrustedDeviceRecord>;
  getTrustedDevice?: (peerId: string) => TrustedDeviceRecord | undefined;
  allowPairingProtocol?: boolean;
}

const PAIRING_PROTOCOL: MemeLoopProtocol = '/memeloop/pairing/2.0.0';

export class LocalTrustDeviceAuthorizer implements DeviceAuthorizer {
  private readonly trustedDevices = new Map<string, TrustedDeviceRecord>();
  private readonly allowPairingProtocol: boolean;

  constructor(private readonly options: LocalTrustDeviceAuthorizerOptions = {}) {
    this.allowPairingProtocol = options.allowPairingProtocol ?? true;
    for (const record of options.trustedDevices ?? []) {
      this.trustedDevices.set(record.peerId, record);
    }
  }

  public setTrustedDevice(record: TrustedDeviceRecord): void {
    this.trustedDevices.set(record.peerId, record);
  }

  public removeTrustedDevice(peerId: string): void {
    this.trustedDevices.delete(peerId);
  }

  public async canOpenProtocol(input: {
    remotePeerId: string;
    protocol: MemeLoopProtocol;
  }): Promise<boolean> {
    const record = this.options.getTrustedDevice?.(input.remotePeerId) ?? this.trustedDevices.get(input.remotePeerId);
    if (record?.revokedAt) return false;
    if (input.protocol === PAIRING_PROTOCOL) return this.allowPairingProtocol;
    return record !== undefined;
  }
}
