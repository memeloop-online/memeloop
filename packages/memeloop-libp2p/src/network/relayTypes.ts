import type { Listener } from '@libp2p/interface';
import type { DeviceCloudCommitFence, DeviceRelayReservationToken } from 'memeloop/device-network/portable';
import { RELAY_ADMISSION_REQUEST_TYPE, RELAY_ADMISSION_RESPONSE_TYPE } from './protocolConstants.js';

export interface RelayAdmissionRequestMessage {
  type: typeof RELAY_ADMISSION_REQUEST_TYPE;
  token: DeviceRelayReservationToken;
}

export type RelayAdmissionResponseMessage =
  | { type: typeof RELAY_ADMISSION_RESPONSE_TYPE; ok: true; peerId: string; expiresAt: number }
  | { type: typeof RELAY_ADMISSION_RESPONSE_TYPE; ok: false; reason: string };

export interface VerifiedRelayReservation {
  token: DeviceRelayReservationToken;
  relayMultiaddrs: string[];
  bootstrapMultiaddrs: string[];
  fence: DeviceCloudCommitFence;
}

export interface RelayGenerationEffects {
  bootstrapMultiaddrs: Set<string>;
  relayMultiaddrs: Set<string>;
  listeners: Set<Listener>;
}

export function emptyRelayGenerationEffects(): RelayGenerationEffects {
  return {
    bootstrapMultiaddrs: new Set(),
    relayMultiaddrs: new Set(),
    listeners: new Set(),
  };
}
