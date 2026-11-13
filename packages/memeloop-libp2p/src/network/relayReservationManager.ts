import type { Libp2p, Stream } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import type { DeviceCloudCommitFence, DeviceRelayReservationToken } from 'memeloop/device-network/portable';
import { verifyDeviceRelayReservationToken } from './deviceIdentity.js';
import { strictMultiaddrs } from './networkAddresses.js';
import type { Libp2pDeviceNetworkServiceOptions } from './networkTypes.js';
import {
  BOOTSTRAP_DIAL_TIMEOUT_MS,
  DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS,
  DEFAULT_RELAY_RESERVATION_TTL_MS,
  PAIRING_IDLE_TIMEOUT_MS,
  PAIRING_TOTAL_TIMEOUT_MS,
  RELAY_ADMISSION_MESSAGE_MAX_BYTES,
  RELAY_ADMISSION_REQUEST_TYPE,
  RELAY_RESERVATION_MAX_ATTEMPTS,
  RELAY_RESERVATION_RETRY_DELAY_MS,
} from './protocolConstants.js';
import { dialRelayAdmissionStream, resolveRelayTransportManager } from './relayTransport.js';
import {
  emptyRelayGenerationEffects,
  type RelayAdmissionRequestMessage,
  type RelayAdmissionResponseMessage,
  type RelayGenerationEffects,
  type VerifiedRelayReservation,
} from './relayTypes.js';
import { isRelayAdmissionResponse, relayCircuitMultiaddr, relayTokenAudiencePeerId, relayTokenCoversReservation } from './relayValidation.js';
import {
  abortableDelay,
  abortLibp2pStreamOnce,
  abortSignalError,
  closeLibp2pStreamBestEffort,
  errorWithDiagnostics,
  linkedTimeoutController,
  readJsonMessage,
  writeJsonMessage,
} from './streamIO.js';

interface RelayReservationManagerHost {
  readonly options: Pick<Libp2pDeviceNetworkServiceOptions, 'identity' | 'relayReservationVerification'>;
  getNode(): Libp2p | undefined;
  requireNode(): Libp2p;
}
export class RelayReservationManager {
  private verifiedRelayReservation?: VerifiedRelayReservation;
  private relayGenerationEffects: RelayGenerationEffects = emptyRelayGenerationEffects();

  constructor(private readonly host: RelayReservationManagerHost) {}

  public async configureRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void> {
    if (signal !== fence.signal) throw new TypeError('relay_generation_signal_mismatch');
    signal.throwIfAborted();
    fence.throwIfStale();
    const verified = await this.verifyRelayReservation(token, signal, fence);
    signal.throwIfAborted();
    fence.throwIfStale();

    const previousEffects = this.relayGenerationEffects;
    fence.commitSynchronous(() => {
      this.verifiedRelayReservation = undefined;
      this.relayGenerationEffects = emptyRelayGenerationEffects();
    });
    // Rollback must finish even if this generation is cancelled while the
    // old listeners are closing. The coordinator serializes generations, so
    // the next generation cannot install replacements until this settles.
    await this.cleanupRelayGenerationEffects(previousEffects, new AbortController().signal);
    signal.throwIfAborted();
    fence.throwIfStale();

    let effects = emptyRelayGenerationEffects();
    try {
      if (this.host.getNode()) effects = await this.applyRelayReservation(verified, signal, fence);
      signal.throwIfAborted();
      fence.throwIfStale();
      const committed = fence.commitSynchronous(() => {
        // Cache only after verification and every external side effect have
        // completed under the same current generation.
        this.verifiedRelayReservation = verified;
        this.relayGenerationEffects = effects;
      });
      if (!committed) fence.throwIfStale();
    } catch (error) {
      await this.cleanupRelayGenerationEffects(effects, new AbortController().signal);
      throw error;
    }
  }

  /** Forget generation-owned relay credentials before the host tears down its listeners. */
  public async clearRelayReservation(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const effects = this.relayGenerationEffects;
    this.verifiedRelayReservation = undefined;
    this.relayGenerationEffects = emptyRelayGenerationEffects();
    await this.cleanupRelayGenerationEffects(
      effects,
      signal ?? new AbortController().signal,
    );
    signal?.throwIfAborted();
  }

  public async applyRelayReservation(
    verified: VerifiedRelayReservation,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<RelayGenerationEffects> {
    const effects = emptyRelayGenerationEffects();
    for (const address of verified.relayMultiaddrs) effects.relayMultiaddrs.add(address);
    try {
      signal.throwIfAborted();
      fence.throwIfStale();
      this.assertRelayReservationLifetime(verified.token);
      await this.admitRelayReservation(verified.token, signal, fence);
      signal.throwIfAborted();
      fence.throwIfStale();
      await this.reserveRelayListeners(verified.relayMultiaddrs, signal, fence, effects);
      const relayAddressSet = new Set(verified.relayMultiaddrs);
      await this.dialBootstrapPeers(
        verified.bootstrapMultiaddrs.filter((address) => !relayAddressSet.has(address)),
        signal,
        fence,
        effects,
      );
      signal.throwIfAborted();
      fence.throwIfStale();
      return effects;
    } catch (error) {
      await this.cleanupRelayGenerationEffects(effects, new AbortController().signal);
      throw error;
    }
  }

  private async verifyRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<VerifiedRelayReservation> {
    signal.throwIfAborted();
    fence.throwIfStale();
    const verification = this.host.options.relayReservationVerification;
    if (!verification) throw new Error('relay_admission_verification_key_unavailable');
    const verificationPublicKeyMultibase = verification.getVerificationPublicKeyMultibase()?.trim();
    if (!verificationPublicKeyMultibase) {
      throw new Error('relay_admission_verification_key_unavailable');
    }
    const now = verification.now?.() ?? Date.now();
    const reservationTtlMs = verification.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
    const reservationSafetyMarginMs = verification.reservationSafetyMarginMs ??
      DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
    if (
      !relayTokenCoversReservation(
        token,
        now,
        reservationTtlMs,
        reservationSafetyMarginMs,
      )
    ) {
      throw new Error('relay_reservation_token_ttl_insufficient');
    }
    if (
      !(await verifyDeviceRelayReservationToken({
        token,
        verificationPublicKeyMultibase,
        peerId: this.host.options.identity.peerId,
        now,
      }))
    ) {
      throw new Error('invalid_relay_reservation_token');
    }
    signal.throwIfAborted();
    fence.throwIfStale();
    if (!relayTokenAudiencePeerId(token.relayMultiaddrs)) {
      throw new Error('relay_reservation_token_audience_invalid');
    }
    const bootstrapMultiaddrs = strictMultiaddrs(token.bootstrapMultiaddrs);
    if (!bootstrapMultiaddrs) throw new Error('relay_reservation_token_audience_invalid');
    return {
      token,
      relayMultiaddrs: [...token.relayMultiaddrs],
      bootstrapMultiaddrs,
      fence,
    };
  }

  public currentVerifiedRelayReservation(): VerifiedRelayReservation | undefined {
    const verified = this.verifiedRelayReservation;
    if (!verified) return undefined;
    if (!verified.fence.isCurrent() || verified.fence.signal.aborted) {
      this.verifiedRelayReservation = undefined;
      return undefined;
    }
    const verification = this.host.options.relayReservationVerification;
    const now = verification?.now?.() ?? Date.now();
    const reservationTtlMs = verification?.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
    const reservationSafetyMarginMs = verification?.reservationSafetyMarginMs ??
      DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
    if (
      relayTokenCoversReservation(
        verified.token,
        now,
        reservationTtlMs,
        reservationSafetyMarginMs,
      )
    ) return verified;
    this.verifiedRelayReservation = undefined;
    return undefined;
  }

  private assertRelayReservationLifetime(token: DeviceRelayReservationToken): void {
    const verification = this.host.options.relayReservationVerification;
    const now = verification?.now?.() ?? Date.now();
    const reservationTtlMs = verification?.reservationTtlMs ?? DEFAULT_RELAY_RESERVATION_TTL_MS;
    const reservationSafetyMarginMs = verification?.reservationSafetyMarginMs ??
      DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS;
    if (
      !relayTokenCoversReservation(
        token,
        now,
        reservationTtlMs,
        reservationSafetyMarginMs,
      )
    ) {
      if (this.verifiedRelayReservation?.token === token) {
        this.verifiedRelayReservation = undefined;
      }
      throw new Error('relay_reservation_token_ttl_insufficient');
    }
  }

  private async dialBootstrapPeers(
    addresses: string[],
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
    effects: RelayGenerationEffects,
  ): Promise<void> {
    const node = this.host.requireNode();
    for (const address of addresses) {
      signal.throwIfAborted();
      fence.throwIfStale();
      const controller = linkedTimeoutController(
        signal,
        BOOTSTRAP_DIAL_TIMEOUT_MS,
        'bootstrap_dial_timeout',
      );
      try {
        await node.dial(multiaddr(address), { signal: controller.signal });
        effects.bootstrapMultiaddrs.add(address);
        signal.throwIfAborted();
        fence.throwIfStale();
      } catch (error) {
        signal.throwIfAborted();
        fence.throwIfStale();
        // Bootstrap improves reachability but is not required once relay
        // admission/listening succeeded.
        void error;
      } finally {
        controller.dispose();
      }
    }
  }

  private async admitRelayReservation(
    token: DeviceRelayReservationToken,
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
  ): Promise<void> {
    const relayAddresses = token.relayMultiaddrs
      .map((address) => address.trim())
      .filter((address) => address.length > 0);
    if (relayAddresses.length === 0) return;
    const node = this.host.requireNode();
    const errors: string[] = [];
    for (const address of relayAddresses) {
      signal.throwIfAborted();
      fence.throwIfStale();
      let stream: Stream | undefined;
      const onAbort = (): void => {
        if (stream) abortLibp2pStreamOnce(stream, abortSignalError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        stream = await dialRelayAdmissionStream(node, address, signal, fence);
        signal.throwIfAborted();
        fence.throwIfStale();
        const request: RelayAdmissionRequestMessage = {
          type: RELAY_ADMISSION_REQUEST_TYPE,
          token,
        };
        await writeJsonMessage(stream, request, RELAY_ADMISSION_MESSAGE_MAX_BYTES);
        signal.throwIfAborted();
        fence.throwIfStale();
        const response = await readJsonMessage<RelayAdmissionResponseMessage>(
          stream,
          RELAY_ADMISSION_MESSAGE_MAX_BYTES,
          PAIRING_IDLE_TIMEOUT_MS,
          PAIRING_TOTAL_TIMEOUT_MS,
        );
        signal.throwIfAborted();
        fence.throwIfStale();
        await closeLibp2pStreamBestEffort(
          stream,
          PAIRING_IDLE_TIMEOUT_MS,
          'relay_admission_close_timeout',
        );
        signal.throwIfAborted();
        fence.throwIfStale();
        if (
          isRelayAdmissionResponse(response) &&
          response.ok &&
          response.peerId === token.peerId &&
          response.expiresAt === token.expiresAt
        ) return;
        const reason = isRelayAdmissionResponse(response) && !response.ok
          ? response.reason
          : 'invalid_relay_admission_response';
        errors.push(`${address}: ${reason}`);
      } catch (error) {
        if (stream) {
          abortLibp2pStreamOnce(
            stream,
            error instanceof Error ? error : new Error('relay_admission_failed'),
          );
        }
        errors.push(
          `${address}: ${error instanceof Error ? error.message : 'relay_admission_failed'}`,
        );
        signal.throwIfAborted();
        fence.throwIfStale();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    }
    throw errorWithDiagnostics('relay_admission_failed', errors);
  }

  private async reserveRelayListeners(
    relayMultiaddrs: string[],
    signal: AbortSignal,
    fence: DeviceCloudCommitFence,
    effects: RelayGenerationEffects,
  ): Promise<void> {
    const relayAddresses = relayMultiaddrs
      .map((address) => address.trim())
      .filter((address) => address.length > 0);
    if (relayAddresses.length === 0) return;
    const transportManager = resolveRelayTransportManager(this.host.requireNode());
    if (!transportManager) throw new Error('relay_transport_manager_unavailable');
    const errors: string[] = [];
    for (const address of relayAddresses) {
      for (let attempt = 1; attempt <= RELAY_RESERVATION_MAX_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted();
        fence.throwIfStale();
        const listenersBefore = new Set(transportManager.getListeners());
        try {
          await transportManager.listen([relayCircuitMultiaddr(address)]);
          for (const listener of transportManager.getListeners()) {
            if (!listenersBefore.has(listener)) effects.listeners.add(listener);
          }
          signal.throwIfAborted();
          fence.throwIfStale();
          return;
        } catch (error) {
          for (const listener of transportManager.getListeners()) {
            if (!listenersBefore.has(listener)) effects.listeners.add(listener);
          }
          signal.throwIfAborted();
          fence.throwIfStale();
          errors.push(
            `${address} (attempt ${attempt}/${RELAY_RESERVATION_MAX_ATTEMPTS}): ${error instanceof Error ? error.message : 'relay_reservation_failed'}`,
          );
          if (attempt < RELAY_RESERVATION_MAX_ATTEMPTS) {
            await abortableDelay(
              RELAY_RESERVATION_RETRY_DELAY_MS * attempt,
              signal,
            );
            fence.throwIfStale();
          }
        }
      }
    }
    throw errorWithDiagnostics('relay_reservation_failed', errors);
  }

  private async cleanupRelayGenerationEffects(
    effects: RelayGenerationEffects,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const node = this.host.getNode();
    const transportManager = resolveRelayTransportManager(node);
    const relayListenerAddresses = new Set(
      [...effects.relayMultiaddrs].map((address) => relayCircuitMultiaddr(address).toString()),
    );
    const listeners = new Set(effects.listeners);
    for (const listener of transportManager?.getListeners() ?? []) {
      if (
        listener.getAddrs().some((address) => relayListenerAddresses.has(address.toString()))
      ) listeners.add(listener);
    }
    for (const listener of listeners) {
      signal.throwIfAborted();
      await listener.close().catch(() => undefined);
      signal.throwIfAborted();
    }
    if (!node) return;
    for (
      const address of new Set([
        ...effects.relayMultiaddrs,
        ...effects.bootstrapMultiaddrs,
      ])
    ) {
      signal.throwIfAborted();
      await node.hangUp(multiaddr(address), { signal }).catch(() => undefined);
      signal.throwIfAborted();
    }
  }

  public resetEffects(): void {
    this.relayGenerationEffects = emptyRelayGenerationEffects();
  }

  public retainEffects(effects: RelayGenerationEffects): void {
    this.relayGenerationEffects = effects;
  }
}
