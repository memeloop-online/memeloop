import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptNoiseFrame, encryptNoiseFrame, NoiseJsonRpcCodec } from '../noiseTransport.js';

describe('noiseTransport', () => {
  it('round-trips while preserving the detached frame contract', () => {
    const key = randomBytes(32);
    const counter = 0x0102030405060708n;
    const plain = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), 'utf8');
    const frame = encryptNoiseFrame(key, counter, plain);
    const frameLen = frame.readUInt32BE(0);
    const body = frame.subarray(4);
    const encodedCounter = body.subarray(0, 8);

    expect(frameLen).toBe(body.length);
    expect(encodedCounter.equals(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    expect(body.length).toBe(8 + plain.length + 16);

    const { counter: decodedCounter, plaintext, rest } = decryptNoiseFrame(key, frame);
    expect(decodedCounter).toBe(0x0102030405060708n);
    expect(plaintext.equals(plain)).toBe(true);
    expect(rest.length).toBe(0);
  });

  it('returns unread trailing bytes as rest', () => {
    const key = randomBytes(32);
    const first = encryptNoiseFrame(key, 0n, Buffer.from('first', 'utf8'));
    const second = encryptNoiseFrame(key, 1n, Buffer.from('second', 'utf8'));
    const joined = Buffer.concat([first, second]);

    const { counter, plaintext, rest } = decryptNoiseFrame(key, joined);

    expect(counter).toBe(0n);
    expect(plaintext.toString('utf8')).toBe('first');
    expect(rest.equals(second)).toBe(true);
  });

  it('rejects trailing bytes when decoding a single JSON-RPC frame', () => {
    const sendKey = randomBytes(32);
    const recvKey = Buffer.from(sendKey);
    const codec = new NoiseJsonRpcCodec(sendKey, recvKey);
    const first = codec.encrypt(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    const second = encryptNoiseFrame(recvKey, 1n, Buffer.from('extra', 'utf8'));

    expect(() => codec.decrypt(Buffer.concat([first, second]))).toThrow(
      'noiseTransport: unexpected trailing bytes',
    );
  });

  it('rejects tampered ciphertext with a normalized authentication error', () => {
    const key = randomBytes(32);
    const frame = encryptNoiseFrame(key, 2n, Buffer.from('tamper-test', 'utf8'));
    const tampered = Buffer.from(frame);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => decryptNoiseFrame(key, tampered)).toThrow('noiseTransport: authentication failed');
  });
});
