import { describe, expect, it } from 'vitest';

import { LOCAL_PAIRING_CONFIRMATION_DOMAIN } from '../portableLibp2pDeviceNetworkService.js';

describe('local pairing confirmation domain', () => {
  it('is bound to the v2 device-network contract', () => {
    expect(LOCAL_PAIRING_CONFIRMATION_DOMAIN).toBe('memeloop-local-pairing-confirm-v2');
  });
});
