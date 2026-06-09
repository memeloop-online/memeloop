type NoiseClass = new (
  pattern: string,
  initiator: boolean,
  staticKeypair?: { publicKey: Buffer; secretKey: Buffer },
) => NoiseXxHandshakePeer;

export interface NoiseXxHandshakePeer {
  initialise(prologue: Buffer, remoteStatic?: Buffer): void;
  send(payload?: Buffer): Buffer;
  recv(buf: Buffer): Buffer;
  complete: boolean;
  tx: Buffer;
  rx: Buffer;
  rs: Buffer;
  hash: Buffer;
}

type DhModule = {
  generateKeyPair(): { publicKey: Buffer; secretKey: Buffer };
};

let noiseModulePromise: Promise<{ Noise: NoiseClass; dh: DhModule }> | undefined;

export const MEMELOOP_NOISE_PROLOGUE_V1 = Buffer.from("memeloop-noise-v1", "utf8");

async function loadNoiseModules(): Promise<{ Noise: NoiseClass; dh: DhModule }> {
  if (!noiseModulePromise) {
    noiseModulePromise = (async () => {
      const [noiseMod, dhMod] = await Promise.all([
        import("noise-handshake"),
        import("noise-handshake/dh.js"),
      ]);
      const Noise =
        (noiseMod as { default?: NoiseClass }).default ?? (noiseMod as unknown as NoiseClass);
      const dh = dhMod as DhModule;
      return { Noise, dh };
    })();
  }
  return noiseModulePromise;
}

export type NoiseStaticKeyPair = {
  publicKey: Buffer;
  secretKey: Buffer;
};

export async function generateX25519KeyPairForNoise(): Promise<NoiseStaticKeyPair> {
  const { dh } = await loadNoiseModules();
  return dh.generateKeyPair();
}

export async function createNoiseXxInitiator(
  staticKeypair: NoiseStaticKeyPair,
  prologue: Buffer = Buffer.alloc(0),
): Promise<NoiseXxHandshakePeer> {
  const { Noise } = await loadNoiseModules();
  const peer = new Noise("XX", true, staticKeypair);
  peer.initialise(prologue);
  return peer;
}

export async function createNoiseXxResponder(
  staticKeypair: NoiseStaticKeyPair,
  prologue: Buffer = Buffer.alloc(0),
): Promise<NoiseXxHandshakePeer> {
  const { Noise } = await loadNoiseModules();
  const peer = new Noise("XX", false, staticKeypair);
  peer.initialise(prologue);
  return peer;
}

export function getNoiseXxPeerCryptoMaterial(peer: NoiseXxHandshakePeer): {
  sendKey: Buffer;
  recvKey: Buffer;
  remoteStaticPublicKey: Buffer;
  handshakeHash: Buffer;
} {
  return {
    sendKey: peer.tx,
    recvKey: peer.rx,
    remoteStaticPublicKey: peer.rs,
    handshakeHash: peer.hash,
  };
}

export interface NoiseXxHandshakeResult {
  initiatorToResponderKey: Buffer;
  responderToInitiatorKey: Buffer;
  initiatorRemoteStatic: Buffer;
  responderRemoteStatic: Buffer;
  initiatorHandshakeHash: Buffer;
  responderHandshakeHash: Buffer;
}

export async function completeNoiseXxHandshake(
  initiatorStatic: NoiseStaticKeyPair,
  responderStatic: NoiseStaticKeyPair,
  prologue: Buffer = Buffer.alloc(0),
): Promise<NoiseXxHandshakeResult> {
  const initiator = await createNoiseXxInitiator(initiatorStatic, prologue);
  const responder = await createNoiseXxResponder(responderStatic, prologue);

  responder.recv(initiator.send());
  initiator.recv(responder.send());
  responder.recv(initiator.send());

  if (!initiator.complete || !responder.complete) {
    throw new Error("noise_xx: handshake incomplete");
  }
  if (!initiator.tx.equals(responder.rx) || !initiator.rx.equals(responder.tx)) {
    throw new Error("noise_xx: session key mismatch");
  }
  if (
    !initiator.rs.equals(responderStatic.publicKey) ||
    !responder.rs.equals(initiatorStatic.publicKey)
  ) {
    throw new Error("noise_xx: remote static key mismatch");
  }

  return {
    initiatorToResponderKey: initiator.tx,
    responderToInitiatorKey: initiator.rx,
    initiatorRemoteStatic: initiator.rs,
    responderRemoteStatic: responder.rs,
    initiatorHandshakeHash: initiator.hash,
    responderHandshakeHash: responder.hash,
  };
}
