import fs from 'node:fs';
import path from 'node:path';

import { parseVerifiedDevicePairingInvite } from '@memeloop/libp2p';
import type { PairingSession } from 'memeloop';

const MAXIMUM_INVITE_FILE_BYTES = 64 * 1024;

export interface PairingInviteNetwork {
  acceptPairing(sessionId: string): Promise<void>;
  rejectPairing(sessionId: string): Promise<void>;
  requestLocalPairing(
    peerId: string,
    options: { multiaddrs: string[] },
  ): Promise<PairingSession>;
}

export interface PairingInviteEvidence {
  confirmCode: string;
  direction: 'outbound';
  remoteDeviceName: string;
  remotePeerId: string;
  sessionId: string;
  trustedLocally: true;
}

function readInviteFile(inviteFile: string): string {
  const resolved = path.resolve(inviteFile);
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error('pairing invite path must be a regular non-symlink file');
    }
    if (stat.size < 1 || stat.size > MAXIMUM_INVITE_FILE_BYTES) {
      throw new Error(`pairing invite file must be between 1 and ${MAXIMUM_INVITE_FILE_BYTES} bytes`);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) {
      throw new Error('pairing invite file changed while it was being read');
    }
    return bytes.subarray(0, offset).toString('utf8').trim();
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Initiate pairing only with the identity-bound, signed invite explicitly
 * supplied by the operator. mDNS discoveries are never auto-trusted.
 */
export async function pairWithInviteFile(input: {
  inviteFile: string;
  network: PairingInviteNetwork;
}): Promise<PairingInviteEvidence> {
  const invite = await parseVerifiedDevicePairingInvite(readInviteFile(input.inviteFile));
  const session = await input.network.requestLocalPairing(invite.peerId, {
    multiaddrs: invite.multiaddrs,
  });
  if (
    session.direction !== 'outbound' ||
    session.remotePeerId !== invite.peerId ||
    session.remotePublicKeyMultibase !== invite.publicKeyMultibase
  ) {
    await input.network.rejectPairing(session.sessionId).catch(() => undefined);
    throw new Error('pairing response identity does not match the signed invite');
  }
  await input.network.acceptPairing(session.sessionId);
  return {
    confirmCode: session.confirmCode,
    direction: 'outbound',
    remoteDeviceName: session.remoteDeviceName,
    remotePeerId: session.remotePeerId,
    sessionId: session.sessionId,
    trustedLocally: true,
  };
}
