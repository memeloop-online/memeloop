import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptWecomEncryptPayload, extractEncryptCDATA, looksLikeWecomEncryptedXml, parseWecomInboundFromXml, verifyWecomPostMessageSignature } from '../wecomCrypto.js';

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** 与官方算法对称：PKCS#7 填充后 AES-256-CBC，IV = key 前 16 字节。 */
function encryptWecomForTest(encodingAesKeyB64: string, xml: string, corpId: string): string {
  const key = Buffer.from(encodingAesKeyB64.trim() + '=', 'base64');
  if (key.length !== 32) {
    throw new Error('bad test key length');
  }
  const iv = key.subarray(0, 16);
  const random = randomBytes(16);
  const xmlBuf = Buffer.from(xml, 'utf8');
  const content = Buffer.concat([random, u32be(xmlBuf.length), xmlBuf, Buffer.from(corpId, 'utf8')]);
  const block = 16;
  const pad = block - (content.length % block) || block;
  const padded = Buffer.concat([content, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function encodingAesKeyFromRaw32(raw: Buffer): string {
  return raw.toString('base64').replace(/=+$/, '');
}

describe('wecomCrypto', () => {
  const token = 'wecomtok';
  const corpId = 'ww1234567890';
  const encodingKey = encodingAesKeyFromRaw32(Buffer.alloc(32, 9));

  it('verifyWecomPostMessageSignature matches sorted SHA1', () => {
    const enc = 'cipherblob';
    const ts = '1700000000';
    const nonce = 'nonce1';
    const arr = [token, ts, nonce, enc].sort().join('');
    const sig = createHash('sha1').update(arr, 'utf8').digest('hex');
    expect(verifyWecomPostMessageSignature(token, ts, nonce, enc, sig)).toBe(true);
    expect(verifyWecomPostMessageSignature(token, ts, nonce, enc, 'deadbeef')).toBe(false);
  });

  it('verifyWecomPostMessageSignature returns false on empty token/signature', () => {
    expect(verifyWecomPostMessageSignature('', 't', 'n', 'e', 'sig')).toBe(false);
    expect(verifyWecomPostMessageSignature('   ', 't', 'n', 'e', 'sig')).toBe(false);
    // msgSignature is required
    expect(verifyWecomPostMessageSignature(token, 't', 'n', 'e', '')).toBe(false);
  });

  it('decryptWecomEncryptPayload + parseWecomInboundFromXml roundtrip', () => {
    const xml = `<xml><FromUserName><![CDATA[fromU]]></FromUserName><Content><![CDATA[hi wecom]]></Content></xml>`;
    const b64 = encryptWecomForTest(encodingKey, xml, corpId);
    const plain = decryptWecomEncryptPayload(encodingKey, b64, corpId);
    expect(plain).toBe(xml);
    const msg = parseWecomInboundFromXml(plain!, 'chan1');
    expect(msg?.text).toBe('hi wecom');
    expect(msg?.imUserId).toBe('fromU');
  });

  it('decryptWecomEncryptPayload returns null when corpId mismatched but ciphertext is valid', () => {
    const xml = `<xml><FromUserName><![CDATA[fromU]]></FromUserName><Content><![CDATA[hi wecom]]></Content></xml>`;
    const b64 = encryptWecomForTest(encodingKey, xml, corpId);
    expect(decryptWecomEncryptPayload(encodingKey, b64, 'corp-wrong')).toBeNull();
  });

  it('decryptWecomEncryptPayload branches for invalid cipher length and broken padding', () => {
    // cipher length < 16
    expect(decryptWecomEncryptPayload(encodingKey, Buffer.from('short').toString('base64'), corpId)).toBeNull();

    // Break padding byte by flipping last ciphertext byte (keep length so decrypt reaches padding validation).
    const xml = `<xml><FromUserName><![CDATA[fromU]]></FromUserName><Content><![CDATA[hi wecom]]></Content></xml>`;
    const b64 = encryptWecomForTest(encodingKey, xml, corpId);
    const buf = Buffer.from(b64, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const corrupted = buf.toString('base64');
    expect(decryptWecomEncryptPayload(encodingKey, corrupted, corpId)).toBeNull();
  });

  it('returns null on invalid decrypt inputs and corp mismatch', () => {
    expect(decryptWecomEncryptPayload('bad', 'x')).toBeNull();
    expect(decryptWecomEncryptPayload(encodingKey, 'x', 'corp-mismatch')).toBeNull();
  });

  it('extractEncryptCDATA / looksLikeWecomEncryptedXml branches', () => {
    const xml = '<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>';
    expect(extractEncryptCDATA(xml)).toBe('abc');
    expect(extractEncryptCDATA('<xml></xml>')).toBeNull();
    expect(extractEncryptCDATA('<xml><Encrypt><![CDATA[]]></Encrypt></xml>')).toBeNull();
    expect(looksLikeWecomEncryptedXml(xml)).toBe(true);
    expect(looksLikeWecomEncryptedXml('<xml></xml>')).toBe(false);
  });

  it('parseWecomInboundFromXml returns null when Content/Text empty or FromUserName missing', () => {
    const xmlEmptyText = '<xml><FromUserName><![CDATA[u1]]></FromUserName><Content><![CDATA[]]></Content></xml>';
    const msg1 = parseWecomInboundFromXml(xmlEmptyText, 'ch1');
    expect(msg1).toBeNull();

    const xmlMissingFrom = '<xml><Content><![CDATA[hi]]></Content></xml>';
    const msg2 = parseWecomInboundFromXml(xmlMissingFrom, 'ch1');
    expect(msg2).toBeNull();

    const xmlWithFromLowercase = '<xml><fromusername><![CDATA[u2]]></fromusername><text><![CDATA[ok]]></text></xml>';
    const msg3 = parseWecomInboundFromXml(xmlWithFromLowercase, 'ch1');
    expect(msg3?.imUserId).toBe('u2');
    expect(msg3?.text).toBe('ok');
  });
});
