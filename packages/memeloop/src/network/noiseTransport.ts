/**
 * Post-handshake framing for Noise + IETF ChaCha20-Poly1305 (plan §7.5.5).
 * Wire format: `[4-byte BE length][8-byte BE counter][ciphertext + 16-byte Poly1305 tag]`.
 * Nonce = 12 bytes: 4 zero + 8-byte counter (big-endian). Handshake / key derivation is done elsewhere.
 */

import * as sodium from 'sodium-universal';

const TAG_LENGTH = 16;
const COUNTER_BYTES = 8;
const NONCE_BYTES = 12;
const EMPTY_AAD = Buffer.alloc(0);

function nonceFromCounter(counter: bigint): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES, 0);
  nonce.writeBigUInt64BE(counter, NONCE_BYTES - COUNTER_BYTES);
  return nonce;
}

export function encryptNoiseFrame(key: Buffer, counter: bigint, plaintext: Buffer): Buffer {
  if (key.length !== 32) throw new Error('noiseTransport: key must be 32 bytes');
  const nonce = nonceFromCounter(counter);
  const sealed = Buffer.alloc(plaintext.length + TAG_LENGTH);
  sodium.crypto_aead_chacha20poly1305_ietf_encrypt(sealed, plaintext, EMPTY_AAD, null, nonce, key);

  const enc = sealed.subarray(0, plaintext.length);
  const tag = sealed.subarray(plaintext.length);
  const counterBe = Buffer.alloc(COUNTER_BYTES);
  counterBe.writeBigUInt64BE(counter, 0);
  const body = Buffer.concat([counterBe, enc, tag]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Post-handshake JSON-RPC framing using sendKey for encrypt and recvKey for decrypt. */
export class NoiseJsonRpcCodec {
  private sendCounter = 0n;

  constructor(
    private readonly sendKey: Buffer,
    private readonly recvKey: Buffer,
  ) {}

  encrypt(utf8Json: string): Buffer {
    const frame = encryptNoiseFrame(this.sendKey, this.sendCounter, Buffer.from(utf8Json, 'utf8'));
    this.sendCounter += 1n;
    return frame;
  }

  decrypt(frame: Buffer): string {
    const { plaintext, rest } = decryptNoiseFrame(this.recvKey, frame);
    if (rest.length > 0) {
      throw new Error('noiseTransport: unexpected trailing bytes');
    }
    return plaintext.toString('utf8');
  }
}

export function decryptNoiseFrame(
  key: Buffer,
  frame: Buffer,
): { counter: bigint; plaintext: Buffer; rest: Buffer } {
  if (key.length !== 32) throw new Error('noiseTransport: key must be 32 bytes');
  if (frame.length < 4 + COUNTER_BYTES + TAG_LENGTH) {
    throw new Error('noiseTransport: frame too short');
  }
  const length = frame.readUInt32BE(0);
  if (length < COUNTER_BYTES + TAG_LENGTH || frame.length < 4 + length) {
    throw new Error('noiseTransport: invalid frame length');
  }
  const body = frame.subarray(4, 4 + length);
  const counter = body.subarray(0, COUNTER_BYTES).readBigUInt64BE(0);
  const nonce = nonceFromCounter(counter);
  const ct = body.subarray(COUNTER_BYTES, body.length - TAG_LENGTH);
  const tag = body.subarray(body.length - TAG_LENGTH);
  const sealed = Buffer.concat([ct, tag]);
  const plaintext = Buffer.alloc(sealed.length - TAG_LENGTH);
  try {
    sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
      plaintext,
      null,
      sealed,
      EMPTY_AAD,
      nonce,
      key,
    );
  } catch (error) {
    throw new Error('noiseTransport: authentication failed', {
      cause: error,
    });
  }

  return { counter, plaintext, rest: frame.subarray(4 + length) };
}
