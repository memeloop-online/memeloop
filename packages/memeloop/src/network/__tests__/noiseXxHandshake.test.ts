import { describe, expect, it } from 'vitest';

import { completeNoiseXxHandshake, createNoiseXxInitiator, createNoiseXxResponder, generateX25519KeyPairForNoise, getNoiseXxPeerCryptoMaterial } from '../noiseXxHandshake.js';

describe('Noise_XX handshake', () => {
  it('derives matching session keys and exposes remote static keys', async () => {
    const a = await generateX25519KeyPairForNoise();
    const b = await generateX25519KeyPairForNoise();
    const r = await completeNoiseXxHandshake(a, b, Buffer.from('memeloop-prologue', 'utf8'));

    expect(r.initiatorToResponderKey.length).toBe(32);
    expect(r.responderToInitiatorKey.length).toBe(32);
    expect(r.initiatorRemoteStatic.equals(b.publicKey)).toBe(true);
    expect(r.responderRemoteStatic.equals(a.publicKey)).toBe(true);
    expect(r.initiatorHandshakeHash.equals(r.responderHandshakeHash)).toBe(true);
  });

  it('produces different keys for different static key pairs', async () => {
    const r1 = await completeNoiseXxHandshake(
      await generateX25519KeyPairForNoise(),
      await generateX25519KeyPairForNoise(),
    );
    const r2 = await completeNoiseXxHandshake(
      await generateX25519KeyPairForNoise(),
      await generateX25519KeyPairForNoise(),
    );
    expect(r1.initiatorToResponderKey.equals(r2.initiatorToResponderKey)).toBe(false);
  });

  it('wire sequence (three binary messages) matches completeNoiseXxHandshake keys', async () => {
    const prologue = Buffer.from('memeloop-prologue', 'utf8');
    const initiatorStatic = await generateX25519KeyPairForNoise();
    const responderStatic = await generateX25519KeyPairForNoise();

    const initiator = await createNoiseXxInitiator(initiatorStatic, prologue);
    const responder = await createNoiseXxResponder(responderStatic, prologue);

    const msg1 = initiator.send();
    responder.recv(msg1);
    const msg2 = responder.send();
    initiator.recv(msg2);
    const msg3 = initiator.send();
    responder.recv(msg3);

    expect(initiator.complete).toBe(true);
    expect(responder.complete).toBe(true);

    const iCrypto = getNoiseXxPeerCryptoMaterial(initiator);
    const rCrypto = getNoiseXxPeerCryptoMaterial(responder);

    // 同一次握手中：发起方 tx 与响应方 rx 配对（反之亦然）；静态公钥互见。
    expect(iCrypto.sendKey.equals(rCrypto.recvKey)).toBe(true);
    expect(iCrypto.recvKey.equals(rCrypto.sendKey)).toBe(true);
    expect(iCrypto.remoteStaticPublicKey.equals(responderStatic.publicKey)).toBe(true);
    expect(rCrypto.remoteStaticPublicKey.equals(initiatorStatic.publicKey)).toBe(true);
    expect(initiator.hash.equals(responder.hash)).toBe(true);
  });
});
