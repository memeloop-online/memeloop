import type { Libp2p, Listener, Stream } from '@libp2p/interface';
import { type Multiaddr, multiaddr } from '@multiformats/multiaddr';
import type { DeviceCloudCommitFence } from 'memeloop/device-network/portable';
import { RELAY_ADMISSION_DIAL_MAX_ATTEMPTS, RELAY_ADMISSION_DIAL_TIMEOUT_MS, RELAY_ADMISSION_PROTOCOL } from './protocolConstants.js';
import { linkedTimeoutController } from './streamIO.js';

export async function dialRelayAdmissionStream(
  node: Libp2p,
  address: string,
  signal: AbortSignal,
  fence: DeviceCloudCommitFence,
): Promise<Stream> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= RELAY_ADMISSION_DIAL_MAX_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    fence.throwIfStale();
    const controller = linkedTimeoutController(
      signal,
      RELAY_ADMISSION_DIAL_TIMEOUT_MS,
      'relay_admission_dial_timeout',
    );
    try {
      const stream = await node.dialProtocol(multiaddr(address), RELAY_ADMISSION_PROTOCOL, {
        signal: controller.signal,
      });
      signal.throwIfAborted();
      fence.throwIfStale();
      return stream;
    } catch (error) {
      signal.throwIfAborted();
      fence.throwIfStale();
      errors.push(
        `attempt ${attempt}/${RELAY_ADMISSION_DIAL_MAX_ATTEMPTS}: ${error instanceof Error ? error.message : 'relay_admission_dial_failed'}`,
      );
    } finally {
      controller.dispose();
    }
  }
  throw new Error(`relay_admission_dial_failed: ${errors.join('; ')}`);
}

export interface Libp2pRelayTransportManager {
  getListeners(): Listener[];
  listen(addresses: Multiaddr[]): Promise<void>;
}

function readRuntimeProperty(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function isLibp2pRelayTransportManager(value: unknown): value is Libp2pRelayTransportManager {
  if (value === null || typeof value !== 'object') return false;
  return typeof readRuntimeProperty(value, 'getListeners') === 'function' &&
    typeof readRuntimeProperty(value, 'listen') === 'function';
}

/**
 * Resolve the transport-manager capability exposed by libp2p components.
 */
export function resolveRelayTransportManager(node: unknown): Libp2pRelayTransportManager | undefined {
  if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return undefined;
  const components = readRuntimeProperty(node, 'components');
  if (components === null || typeof components !== 'object') return undefined;
  const manager = readRuntimeProperty(components, 'transportManager');
  return isLibp2pRelayTransportManager(manager) ? manager : undefined;
}
