import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

// These probes intentionally fail type-checking if a removed compatibility
// export is reintroduced. They are exported so noUnusedLocals cannot hide a
// stale public type.
// @ts-expect-error AttachmentRef is intentionally not a public alias.
import type { AttachmentRef } from '../index.js';
export type RemovedAttachmentAliasProbe = AttachmentRef;
// @ts-expect-error Desktop compatibility wire DTOs are intentionally removed.
import type { WikiInfo } from '../index.js';
export type RemovedWikiInfoProbe = WikiInfo;
// @ts-expect-error Desktop compatibility wire DTOs are intentionally removed.
import type { NodeProtocolCapabilities } from '../index.js';
export type RemovedNodeProtocolCapabilitiesProbe = NodeProtocolCapabilities;
// @ts-expect-error Desktop compatibility wire DTOs are intentionally removed.
import type { NodeStatus } from '../index.js';
export type RemovedNodeStatusProbe = NodeStatus;
// @ts-expect-error Desktop compatibility wire DTOs are intentionally removed.
import type { KnownNodeEntry } from '../index.js';
export type RemovedKnownNodeEntryProbe = KnownNodeEntry;

describe('protocol public exports', () => {
  it('does not publish removed compatibility aliases at runtime', () => {
    expect(protocol).not.toHaveProperty('AttachmentRef');
    expect(protocol).not.toHaveProperty('WikiInfo');
    expect(protocol).not.toHaveProperty('NodeProtocolCapabilities');
    expect(protocol).not.toHaveProperty('NodeStatus');
    expect(protocol).not.toHaveProperty('KnownNodeEntry');
  });
});
