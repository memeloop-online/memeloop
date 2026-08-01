import type { DeviceCapabilities, DeviceConnectionGrant, DeviceRelayReservationToken, LocalDeviceIdentity } from 'memeloop';

const CLOUD_REQUEST_TIMEOUT_MS = 10_000;
const CLOUD_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const CLOUD_ERROR_MAX_CHARACTERS = 4_096;
const CLOUD_URL_MAX_CHARACTERS = 2_048;
const CLOUD_ACCESS_TOKEN_MAX_CHARACTERS = 16_384;

export interface CloudDeviceRecord {
  accountId: string;
  peerId: string;
  publicKeyMultibase: string;
  deviceName: string;
  platform: 'desktop' | 'mobile' | 'cli';
  capabilities: DeviceCapabilities;
  multiaddrs: string[];
  relayReservations: string[];
  lastSeen: number;
  revokedAt?: number;
}

export interface ConnectionGrantPublicKey {
  issuer: 'memeloop-cloud';
  publicKeyMultibase: string;
}

export class DeviceCloudClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(baseUrl: string, accessToken: string) {
    const normalized = normalizeDeviceCloudConfiguration({ baseUrl, accessToken });
    this.baseUrl = normalized.baseUrl;
    this.accessToken = normalized.accessToken;
  }

  public async createBindingNonce(): Promise<{ nonce: string; accountId: string; expiresAt: string }> {
    return this.request('/api/devices/binding/nonce', { method: 'POST' });
  }

  public async registerDevice(input: {
    identity: LocalDeviceIdentity;
    cloudNonce: string;
    signature: string;
    capabilities: DeviceCapabilities;
    multiaddrs: string[];
    relayReservations: string[];
  }): Promise<{ ok: boolean; peerId: string }> {
    return this.request('/api/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        peerId: input.identity.peerId,
        publicKeyMultibase: input.identity.publicKeyMultibase,
        deviceName: input.identity.deviceName,
        platform: input.identity.platform,
        cloudNonce: input.cloudNonce,
        signature: input.signature,
        capabilities: input.capabilities,
        multiaddrs: input.multiaddrs,
        relayReservations: input.relayReservations,
      }),
    });
  }

  public async listDevices(): Promise<CloudDeviceRecord[]> {
    const response = await this.request<{ devices: CloudDeviceRecord[] }>('/api/devices', { method: 'GET' });
    return response.devices;
  }

  public async getConnectionGrantPublicKey(): Promise<ConnectionGrantPublicKey> {
    return this.request('/api/devices/connection-grant/public-key', { method: 'GET' });
  }

  public async createConnectionGrant(input: {
    subjectPeerId: string;
    allowedPeerIds: string[];
  }): Promise<DeviceConnectionGrant> {
    return this.request('/api/devices/connection-grant', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async createRelayReservation(input: { peerId: string }): Promise<DeviceRelayReservationToken> {
    return this.request('/api/devices/relay-reservation', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  public async heartbeat(input: {
    peerId: string;
    capabilities: DeviceCapabilities;
    multiaddrs: string[];
    relayReservations: string[];
  }): Promise<{ ok: boolean }> {
    return this.request('/api/devices/heartbeat', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const baseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.accessToken}`,
    };
    if (init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        baseHeaders[key] = value;
      }
    }
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: baseHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS),
    });
    const responseText = await readBoundedCloudResponse(response, CLOUD_RESPONSE_MAX_BYTES);
    if (!response.ok) {
      throw new Error(`${response.status} ${responseText.slice(0, CLOUD_ERROR_MAX_CHARACTERS)}`);
    }
    try {
      return JSON.parse(responseText) as T;
    } catch {
      throw new Error('cloud_response_invalid_json');
    }
  }
}

export function normalizeDeviceCloudConfiguration(input: {
  baseUrl: string;
  accessToken: string;
}): { baseUrl: string; accessToken: string } {
  const baseUrl = input.baseUrl.trim();
  const accessToken = input.accessToken.trim();
  if (!baseUrl || baseUrl.length > CLOUD_URL_MAX_CHARACTERS) throw new Error('invalid_cloud_url');
  if (!accessToken || accessToken.length > CLOUD_ACCESS_TOKEN_MAX_CHARACTERS) {
    throw new Error('invalid_cloud_access_token');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('invalid_cloud_url');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('cloud_url_requires_https');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error('invalid_cloud_url');
  }
  return { baseUrl: parsed.origin, accessToken };
}

async function readBoundedCloudResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel('cloud_response_too_large');
    throw new Error('cloud_response_too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel('cloud_response_too_large');
      throw new Error('cloud_response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
