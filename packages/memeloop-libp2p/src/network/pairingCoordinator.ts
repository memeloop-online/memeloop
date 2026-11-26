import type { Libp2p, PeerId, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { Device, DeviceCapabilities, LocalPairingRequestOptions, PairingSession, TrustedDeviceRecord } from 'memeloop/device-network/portable';
import { strictPairingMultiaddrs } from './networkAddresses.js';
import type { Libp2pDeviceNetworkServiceOptions } from './networkTypes.js';
import {
  assertPairingDeviceIdentity,
  buildPairingConfirmCode,
  isPairingRequest,
  isPairingResponse,
  normalizePairingDevice,
  normalizePairingRequest,
  normalizePairingResponse,
  type PairingAdmission,
  type PairingDeviceEnvelope,
  type PairingRequestMessage,
  type PairingResponseMessage,
  randomPairingNonce,
} from './pairingMessages.js';
import {
  PAIRING_IDLE_TIMEOUT_MS,
  PAIRING_MAX_MULTIADDRS,
  PAIRING_MAX_PENDING_GLOBAL,
  PAIRING_MAX_PENDING_PER_PEER,
  PAIRING_MESSAGE_MAX_BYTES,
  PAIRING_PROTOCOL,
  PAIRING_SESSION_TTL_MS,
  PAIRING_TOTAL_TIMEOUT_MS,
} from './protocolConstants.js';
import { abortLibp2pStreamOnce, abortSignalError, readJsonMessage, writeJsonMessage } from './streamIO.js';

interface PairingCoordinatorHost {
  readonly options: Pick<Libp2pDeviceNetworkServiceOptions, 'identity' | 'trustStore'>;
  readonly capabilities: DeviceCapabilities;
  readonly trustedDevices: Map<string, TrustedDeviceRecord>;
  readonly discoveredDevices: Map<string, Device>;
  readonly explicitPairingAddresses: Map<string, string[]>;
  requireNode(): Libp2p;
  getMultiaddrs(): string[];
  rememberConnectedPairingAddress(peerId: string): void;
  updateDeviceTrust(peerId: string, trustMode: Device['trustMode'], trusted: boolean): void;
  emitDevices(): void;
}
export class PairingCoordinator {
  private readonly pairingSessions = new Map<string, PairingSession>();
  private readonly pairingAdmissions = new Map<string, PairingAdmission>();
  private readonly pairingChallenges = new Map<string, PairingAdmission>();
  private readonly pairingDiscoveredPeerIds = new Set<string>();
  private readonly pairingListeners = new Set<(sessions: PairingSession[]) => void>();

  constructor(private readonly host: PairingCoordinatorHost) {}

  public async listPairingSessions(): Promise<PairingSession[]> {
    this.refreshPairingSessionExpiry();
    return [...this.pairingSessions.values()];
  }

  public observePairingSessions(listener: (sessions: PairingSession[]) => void): () => void {
    this.pairingListeners.add(listener);
    void this.listPairingSessions().then(listener);
    return () => {
      this.pairingListeners.delete(listener);
    };
  }

  public async requestLocalPairing(
    peerId: string,
    options: LocalPairingRequestOptions = {},
  ): Promise<PairingSession> {
    const { signal } = options;
    if (signal?.aborted) throw abortSignalError(signal);
    const requestNonce = randomPairingNonce();
    const createdAt = Date.now();
    const expiresAt = createdAt + PAIRING_SESSION_TTL_MS;
    const request: PairingRequestMessage = {
      type: 'memeloop-local-pairing-request-v2',
      sessionId: `pairing-${createdAt}-${requestNonce}`,
      requestNonce,
      createdAt,
      expiresAt,
      device: this.localPairingDevice(),
    };
    const releaseAdmission = this.claimPairingAdmission({
      sessionId: request.sessionId,
      remotePeerId: peerId,
      requestNonce,
      expiresAt,
    });
    let stream: Stream | undefined;
    let removeAbortListener = (): void => {};
    try {
      stream = await this.host.requireNode().dialProtocol(
        this.pairingDialTarget(peerId, options),
        PAIRING_PROTOCOL,
        {
          runOnLimitedConnection: true,
          ...(signal ? { signal } : {}),
        },
      );
      if (signal) {
        const onAbort = (): void => {
          if (stream) abortLibp2pStreamOnce(stream, abortSignalError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
        if (signal.aborted) onAbort();
      }
      if (signal?.aborted) throw abortSignalError(signal);
      await writeJsonMessage(stream, request, PAIRING_MESSAGE_MAX_BYTES);
      const response = await readJsonMessage<PairingResponseMessage>(
        stream,
        PAIRING_MESSAGE_MAX_BYTES,
        PAIRING_IDLE_TIMEOUT_MS,
        PAIRING_TOTAL_TIMEOUT_MS,
        signal,
      );
      await stream.close(signal ? { signal } : undefined);
      removeAbortListener();
      if (signal?.aborted) throw abortSignalError(signal);
      const session = await this.sessionFromPairingResponse(peerId, request, response);
      this.host.rememberConnectedPairingAddress(peerId);
      session.remoteMultiaddrs = [
        ...new Set([
          ...(this.host.explicitPairingAddresses.get(peerId) ?? []),
          ...session.remoteMultiaddrs,
        ]),
      ].slice(0, PAIRING_MAX_MULTIADDRS);
      this.requirePairingAdmission(request.sessionId);
      this.pairingSessions.set(session.sessionId, session);
      this.pairingChallenges.set(session.sessionId, {
        sessionId: session.sessionId,
        remotePeerId: session.remotePeerId,
        requestNonce,
        expiresAt: session.expiresAt,
      });
      const remoteDevice = normalizePairingDevice(response.device);
      if (!remoteDevice) throw new Error('invalid_pairing_response');
      this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, remoteDevice);
      this.emitPairingSessions();
      this.host.emitDevices();
      return session;
    } catch (error) {
      if (stream) {
        abortLibp2pStreamOnce(
          stream,
          error instanceof Error ? error : new Error('pairing_request_failed'),
        );
      }
      throw error;
    } finally {
      removeAbortListener();
      releaseAdmission();
    }
  }

  public async acceptPairing(sessionId: string): Promise<void> {
    const session = this.requirePairingSession(sessionId);
    if (session.expiresAt <= Date.now()) {
      this.deletePairingSession(sessionId);
      this.emitPairingSessions();
      throw new Error('pairing_session_expired');
    }
    if (session.status !== 'pending') throw new Error('pairing_session_not_pending');
    const trustedDevice: TrustedDeviceRecord = {
      peerId: session.remotePeerId,
      publicKeyMultibase: session.remotePublicKeyMultibase,
      deviceName: session.remoteDeviceName,
      platform: session.remotePlatform,
      trustMode: 'local-pairing',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.host.trustedDevices.set(session.remotePeerId, trustedDevice);
    await this.host.options.trustStore?.saveTrustedDevice(trustedDevice);
    session.status = 'accepted';
    this.host.updateDeviceTrust(session.remotePeerId, 'local-pairing', true);
    this.emitPairingSessions();
    this.host.emitDevices();
  }

  public async rejectPairing(sessionId: string): Promise<void> {
    this.refreshPairingSessionExpiry();
    const session = this.pairingSessions.get(sessionId);
    if (!session) return;
    session.status = 'rejected';
    if (!this.host.trustedDevices.has(session.remotePeerId)) this.host.explicitPairingAddresses.delete(session.remotePeerId);
    this.emitPairingSessions();
  }

  private pairingDialTarget(
    peerId: string,
    options: LocalPairingRequestOptions,
  ): PeerId | ReturnType<typeof multiaddr>[] {
    const addresses = options.multiaddrs ?? this.host.discoveredDevices.get(peerId)?.multiaddrs ?? [];
    if (addresses.length === 0) return peerIdFromString(peerId);
    const normalized = strictPairingMultiaddrs(peerId, addresses);
    this.host.explicitPairingAddresses.set(peerId, normalized);
    return normalized.map((address) => multiaddr(address));
  }

  private localPairingDevice(): PairingDeviceEnvelope {
    const device = normalizePairingDevice({
      peerId: this.host.options.identity.peerId,
      publicKeyMultibase: this.host.options.identity.publicKeyMultibase,
      deviceName: this.host.options.identity.deviceName,
      platform: this.host.options.identity.platform,
      capabilities: this.host.capabilities,
      multiaddrs: this.host.getMultiaddrs(),
    });
    if (!device) throw new Error('invalid_local_pairing_device');
    return device;
  }

  public async handlePairingStream(stream: Stream, remotePeerId: string): Promise<void> {
    let releaseAdmission = (): void => {};
    try {
      const rawRequest = await readJsonMessage<unknown>(
        stream,
        PAIRING_MESSAGE_MAX_BYTES,
        PAIRING_IDLE_TIMEOUT_MS,
        PAIRING_TOTAL_TIMEOUT_MS,
      );
      const now = Date.now();
      if (!isPairingRequest(rawRequest, now)) throw new Error('invalid_pairing_request');
      const request = normalizePairingRequest(rawRequest, now);
      if (!request) throw new Error('invalid_pairing_request');
      if (request.device.peerId !== remotePeerId) throw new Error('pairing_peer_id_mismatch');
      releaseAdmission = this.claimPairingAdmission({
        sessionId: request.sessionId,
        remotePeerId,
        requestNonce: request.requestNonce,
        expiresAt: request.expiresAt,
      });
      await assertPairingDeviceIdentity(request.device);
      this.requirePairingAdmission(request.sessionId);
      const responseNonce = randomPairingNonce();
      const localDevice = this.localPairingDevice();
      const expiresAt = Math.min(request.expiresAt, Date.now() + PAIRING_SESSION_TTL_MS);
      if (expiresAt <= Date.now()) throw new Error('pairing_request_expired');
      const session: PairingSession = {
        sessionId: request.sessionId,
        localPeerId: this.host.options.identity.peerId,
        remotePeerId: request.device.peerId,
        remotePublicKeyMultibase: request.device.publicKeyMultibase,
        remoteDeviceName: request.device.deviceName,
        remotePlatform: request.device.platform,
        remoteCapabilities: request.device.capabilities,
        remoteMultiaddrs: request.device.multiaddrs,
        direction: 'inbound',
        status: 'pending',
        confirmCode: await buildPairingConfirmCode({
          initiator: request.device,
          responder: localDevice,
          requestNonce: request.requestNonce,
          responseNonce,
        }),
        createdAt: Date.now(),
        expiresAt,
      };
      const response: PairingResponseMessage = {
        type: 'memeloop-local-pairing-response-v2',
        sessionId: request.sessionId,
        requestNonce: request.requestNonce,
        responseNonce,
        accepted: true,
        expiresAt,
        device: localDevice,
      };
      await writeJsonMessage(stream, response);
      await stream.close();
      this.requirePairingAdmission(request.sessionId);
      this.pairingSessions.set(session.sessionId, session);
      this.pairingChallenges.set(session.sessionId, {
        sessionId: session.sessionId,
        remotePeerId: session.remotePeerId,
        requestNonce: request.requestNonce,
        expiresAt,
      });
      this.upsertDiscoveredDeviceFromPairing(session.remotePeerId, request.device);
      this.emitPairingSessions();
      this.host.emitDevices();
    } catch (error) {
      abortLibp2pStreamOnce(
        stream,
        error instanceof Error ? error : new Error('pairing_handler_failed'),
      );
      throw error;
    } finally {
      releaseAdmission();
    }
  }

  private async sessionFromPairingResponse(
    peerId: string,
    request: PairingRequestMessage,
    response: PairingResponseMessage,
  ): Promise<PairingSession> {
    const now = Date.now();
    if (!isPairingResponse(response, now)) throw new Error('invalid_pairing_response');
    const normalizedResponse = normalizePairingResponse(response, now);
    if (!normalizedResponse) throw new Error('invalid_pairing_response');
    if (normalizedResponse.sessionId !== request.sessionId) {
      throw new Error('pairing_session_mismatch');
    }
    if (normalizedResponse.requestNonce !== request.requestNonce) {
      throw new Error('pairing_nonce_mismatch');
    }
    if (normalizedResponse.device.peerId !== peerId) throw new Error('pairing_peer_id_mismatch');
    if (normalizedResponse.expiresAt > request.expiresAt) {
      throw new Error('pairing_response_expiry_mismatch');
    }
    await assertPairingDeviceIdentity(normalizedResponse.device);
    return {
      sessionId: request.sessionId,
      localPeerId: this.host.options.identity.peerId,
      remotePeerId: normalizedResponse.device.peerId,
      remotePublicKeyMultibase: normalizedResponse.device.publicKeyMultibase,
      remoteDeviceName: normalizedResponse.device.deviceName,
      remotePlatform: normalizedResponse.device.platform,
      remoteCapabilities: normalizedResponse.device.capabilities,
      remoteMultiaddrs: normalizedResponse.device.multiaddrs,
      direction: 'outbound',
      status: 'pending',
      confirmCode: await buildPairingConfirmCode({
        initiator: request.device,
        responder: normalizedResponse.device,
        requestNonce: request.requestNonce,
        responseNonce: normalizedResponse.responseNonce,
      }),
      createdAt: request.createdAt,
      expiresAt: normalizedResponse.expiresAt,
    };
  }

  private requirePairingSession(sessionId: string): PairingSession {
    const session = this.pairingSessions.get(sessionId);
    if (!session) throw new Error('pairing_session_not_found');
    return session;
  }

  private claimPairingAdmission(admission: PairingAdmission): () => void {
    this.refreshPairingSessionExpiry();
    if (
      this.pairingSessions.has(admission.sessionId) ||
      this.pairingAdmissions.has(admission.sessionId)
    ) {
      throw new Error('pairing_session_conflict');
    }
    const duplicateChallenge = [...this.pairingChallenges.values(), ...this.pairingAdmissions.values()]
      .some((current) =>
        current.remotePeerId === admission.remotePeerId &&
        current.requestNonce === admission.requestNonce
      );
    if (duplicateChallenge) throw new Error('pairing_nonce_conflict');

    const pendingSessions = [...this.pairingSessions.values()]
      .filter((session) => session.status === 'pending');
    if (pendingSessions.length + this.pairingAdmissions.size >= PAIRING_MAX_PENDING_GLOBAL) {
      throw new Error('pairing_pending_global_limit');
    }
    const peerPending = pendingSessions
      .filter((session) => session.remotePeerId === admission.remotePeerId).length;
    const peerAdmissions = [...this.pairingAdmissions.values()]
      .filter((current) => current.remotePeerId === admission.remotePeerId).length;
    if (peerPending + peerAdmissions >= PAIRING_MAX_PENDING_PER_PEER) {
      throw new Error('pairing_pending_peer_limit');
    }

    this.pairingAdmissions.set(admission.sessionId, admission);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.pairingAdmissions.get(admission.sessionId) === admission) {
        this.pairingAdmissions.delete(admission.sessionId);
      }
    };
  }

  private requirePairingAdmission(sessionId: string): PairingAdmission {
    const admission = this.pairingAdmissions.get(sessionId);
    if (!admission || admission.expiresAt <= Date.now()) {
      this.pairingAdmissions.delete(sessionId);
      throw new Error('pairing_admission_expired');
    }
    return admission;
  }

  private deletePairingSession(sessionId: string): void {
    const session = this.pairingSessions.get(sessionId);
    this.pairingSessions.delete(sessionId);
    this.pairingChallenges.delete(sessionId);
    if (session) this.cleanupPairingDiscoveredDevice(session.remotePeerId);
  }

  private refreshPairingSessionExpiry(): void {
    const now = Date.now();
    let changed = false;
    for (const [sessionId, session] of this.pairingSessions) {
      if (session.expiresAt <= now) {
        this.deletePairingSession(sessionId);
        changed = true;
      }
    }
    for (const [sessionId, admission] of this.pairingAdmissions) {
      if (admission.expiresAt <= now) this.pairingAdmissions.delete(sessionId);
    }
    for (const [sessionId, challenge] of this.pairingChallenges) {
      if (challenge.expiresAt <= now) this.pairingChallenges.delete(sessionId);
    }
    if (changed) this.emitPairingSessions();
  }

  private upsertDiscoveredDeviceFromPairing(peerId: string, device: PairingDeviceEnvelope): void {
    const current = this.host.discoveredDevices.get(peerId);
    if (!current) this.pairingDiscoveredPeerIds.add(peerId);
    this.host.discoveredDevices.set(peerId, {
      peerId,
      displayName: device.deviceName,
      platform: device.platform,
      trustMode: current?.trustMode ?? 'local-pairing',
      trusted: current?.trusted ?? this.host.trustedDevices.has(peerId),
      reachability: current?.reachability ?? {
        state: 'nearby',
        paths: device.multiaddrs.length > 0 ? ['lan'] : [],
      },
      capabilities: device.capabilities,
      multiaddrs: device.multiaddrs,
      lastSeen: Date.now(),
    });
  }

  private cleanupPairingDiscoveredDevice(peerId: string): void {
    if (
      !this.pairingDiscoveredPeerIds.has(peerId) ||
      this.host.trustedDevices.has(peerId) ||
      [...this.pairingSessions.values()].some((session) => session.remotePeerId === peerId)
    ) return;
    this.pairingDiscoveredPeerIds.delete(peerId);
    this.host.discoveredDevices.delete(peerId);
    this.host.emitDevices();
  }

  private emitPairingSessions(): void {
    const sessions = [...this.pairingSessions.values()];
    for (const listener of this.pairingListeners) listener(sessions);
  }

  public reset(): void {
    const hadPairingSessions = this.pairingSessions.size > 0;
    this.pairingAdmissions.clear();
    this.pairingChallenges.clear();
    this.pairingSessions.clear();
    this.pairingDiscoveredPeerIds.clear();
    this.host.discoveredDevices.clear();
    if (hadPairingSessions) this.emitPairingSessions();
  }
}
