import type { MemeLoopProtocol } from 'memeloop/device-network/portable';

export const PAIRING_PROTOCOL: MemeLoopProtocol = '/memeloop/pairing/2.0.0';

export const RPC_PROTOCOL: MemeLoopProtocol = '/memeloop/rpc/2.0.0';

export const SYNC_PROTOCOL: MemeLoopProtocol = '/memeloop/sync/2.0.0';

export const ORCHESTRATION_PROTOCOL: MemeLoopProtocol = '/memeloop/orchestration/2.0.0';

export const RELAY_ADMISSION_PROTOCOL: MemeLoopProtocol = '/memeloop/relay-admission/2.0.0';

export const LIBP2P_DEVICE_NETWORK_FRAME_LIMITS = Object.freeze({
  pairing: Object.freeze({
    maxPayloadBytes: 64 * 1024,
    idleTimeoutMs: 2_000,
    totalTimeoutMs: 10_000,
  }),
  relayAdmission: Object.freeze({
    maxPayloadBytes: 64 * 1024,
    idleTimeoutMs: 2_000,
    totalTimeoutMs: 10_000,
  }),
  rpc: Object.freeze({
    maxPayloadBytes: 16 * 1024 * 1024,
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 30_000,
  }),
  sync: Object.freeze({
    maxPayloadBytes: 16 * 1024 * 1024,
    idleTimeoutMs: 15_000,
    totalTimeoutMs: 120_000,
  }),
});

export const PAIRING_SESSION_TTL_MS = 5 * 60_000;

export const PAIRING_CLOCK_SKEW_MS = 60_000;

export const PAIRING_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.maxPayloadBytes;

export const PAIRING_IDLE_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.idleTimeoutMs;

export const PAIRING_TOTAL_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.pairing.totalTimeoutMs;

export const PAIRING_MAX_PENDING_GLOBAL = 128;

export const PAIRING_MAX_PENDING_PER_PEER = 4;

export const PAIRING_MAX_SESSION_ID_LENGTH = 512;

export const PAIRING_MAX_PEER_ID_LENGTH = 256;

export const PAIRING_MAX_PUBLIC_KEY_LENGTH = 4_096;

export const PAIRING_MAX_DEVICE_NAME_LENGTH = 256;

export const PAIRING_MAX_CAPABILITY_ITEMS = 256;

export const PAIRING_MAX_CAPABILITY_STRING_LENGTH = 512;

export const PAIRING_MAX_WIKIS = 128;

export const PAIRING_MAX_WIKI_TITLE_LENGTH = 512;

export const PAIRING_MAX_WIKI_PATH_LENGTH = 2_048;

export const PAIRING_MAX_MULTIADDRS = 64;

export const PAIRING_MAX_MULTIADDR_LENGTH = 2_048;

export const PAIRING_NONCE_PATTERN = /^[\da-f]{32}$/u;

export const PAIRING_SESSION_ID_PATTERN = /^[\w.:-]+$/u;

export const RELAY_ADMISSION_DIAL_TIMEOUT_MS = PAIRING_IDLE_TIMEOUT_MS;

export const RELAY_ADMISSION_DIAL_MAX_ATTEMPTS = 3;

export const BOOTSTRAP_DIAL_TIMEOUT_MS = PAIRING_IDLE_TIMEOUT_MS;

export const RPC_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.maxPayloadBytes;

export const RPC_IDLE_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.idleTimeoutMs;

export const RPC_TOTAL_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.rpc.totalTimeoutMs;

export const SYNC_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.maxPayloadBytes;

export const SYNC_MESSAGE_PAGE_MAX_BYTES = SYNC_MESSAGE_MAX_BYTES - 64 * 1024;

export const SYNC_IDLE_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.idleTimeoutMs;

export const SYNC_TOTAL_TIMEOUT_MS = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.sync.totalTimeoutMs;

export const DEVICE_SYNC_MAX_PASSES = 64;

export const RELAY_ADMISSION_MESSAGE_MAX_BYTES = LIBP2P_DEVICE_NETWORK_FRAME_LIMITS.relayAdmission.maxPayloadBytes;

export const RELAY_ADMISSION_REQUEST_TYPE = 'memeloop-relay-admission-request-v2';

export const RELAY_ADMISSION_RESPONSE_TYPE = 'memeloop-relay-admission-response-v2';

export const RELAY_RESERVATION_MAX_ATTEMPTS = 3;

export const RELAY_RESERVATION_RETRY_DELAY_MS = 25;

export const CLOUD_DIRECTORY_MAX_ADDRESSES = 64;

export const CLOUD_DIRECTORY_MAX_ADDRESS_LENGTH = 2_048;

export const DEFAULT_RELAY_RESERVATION_TTL_MS = 5 * 60_000;

export const DEFAULT_RELAY_RESERVATION_SAFETY_MARGIN_MS = 60_000;
