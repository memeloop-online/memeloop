import { CloudDeviceFetchClient, normalizeCloudDeviceBaseUrl } from 'memeloop';

const CLOUD_ACCESS_TOKEN_MAX_CHARACTERS = 16_384;

/**
 * CLI convenience constructor over Core's audited, abort-aware Cloud client.
 * Keeping this thin name preserves the public CLI API while sharing request
 * validation, response bounds, token caching, and generation cancellation.
 */
export class DeviceCloudClient extends CloudDeviceFetchClient {
  constructor(baseUrl: string, accessToken: string) {
    const normalized = normalizeDeviceCloudConfiguration({ baseUrl, accessToken });
    super({
      baseUrl: normalized.baseUrl,
      accessToken: normalized.accessToken,
    });
  }
}

export function normalizeDeviceCloudConfiguration(input: {
  baseUrl: string;
  accessToken: string;
}): { baseUrl: string; accessToken: string } {
  const accessToken = input.accessToken.trim();
  if (!accessToken || accessToken.length > CLOUD_ACCESS_TOKEN_MAX_CHARACTERS) {
    throw new Error('invalid_cloud_access_token');
  }
  return {
    baseUrl: normalizeCloudDeviceBaseUrl(input.baseUrl),
    accessToken,
  };
}
