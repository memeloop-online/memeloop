import { describe, expect, it } from 'vitest';

import * as libp2p from '../index.js';

// This probe intentionally fails type-checking if the removed compatibility
// signer export is reintroduced.
// @ts-expect-error Pairing-specific signer aliases are intentionally removed.
import type { signDevicePairingInvitePayload } from '../index.js';
export type RemovedPairingSignerAliasProbe = typeof signDevicePairingInvitePayload;

describe('libp2p public exports', () => {
  it('does not publish the removed pairing signer alias', () => {
    expect(libp2p).not.toHaveProperty('signDevicePairingInvitePayload');
  });
});
