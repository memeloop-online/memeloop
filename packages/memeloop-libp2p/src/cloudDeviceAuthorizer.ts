import type { DeviceAuthorizer, MemeLoopProtocol, TrustedDeviceRecord } from 'memeloop';

import { verifyDeviceConnectionGrant } from './portableLibp2pDeviceNetworkService.js';

export interface CloudDeviceAuthorizerOptions {
  localPeerId: string;
  grantVerificationPublicKeyMultibase: string;
  getTrustedDevice?: (peerId: string) => TrustedDeviceRecord | undefined;
  allowPairingProtocol?: boolean;
  now?: () => number;
}

const PAIRING_PROTOCOL: MemeLoopProtocol = '/memeloop/pairing/1.0.0';

export class CloudDeviceAuthorizer implements DeviceAuthorizer {
  private readonly allowPairingProtocol: boolean;

  constructor(private readonly options: CloudDeviceAuthorizerOptions) {
    this.allowPairingProtocol = options.allowPairingProtocol ?? true;
  }

  public async canOpenProtocol(input: Parameters<DeviceAuthorizer['canOpenProtocol']>[0]): Promise<boolean> {
    const record = this.options.getTrustedDevice?.(input.remotePeerId);
    if (record?.revokedAt) return false;
    if (input.protocol === PAIRING_PROTOCOL) return this.allowPairingProtocol;
    if (record) return true;
    if (!input.presentedGrant) return false;

    const direction = input.direction ?? 'inbound';
    return verifyDeviceConnectionGrant({
      grant: input.presentedGrant,
      verificationPublicKeyMultibase: this.options.grantVerificationPublicKeyMultibase,
      subjectPeerId: direction === 'outbound' ? this.options.localPeerId : input.remotePeerId,
      allowedPeerId: direction === 'outbound' ? input.remotePeerId : this.options.localPeerId,
      now: this.options.now?.(),
    });
  }
}
