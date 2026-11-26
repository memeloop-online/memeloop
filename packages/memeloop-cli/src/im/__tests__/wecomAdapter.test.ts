import { describe, expect, it, vi } from 'vitest';

vi.mock('../wecomCrypto.js', () => {
  return {
    decryptWecomEncryptPayload: vi.fn(),
    extractEncryptCDATA: vi.fn(),
    looksLikeWecomEncryptedXml: vi.fn(),
    parseWecomInboundFromXml: vi.fn(),
    verifyWecomPostMessageSignature: vi.fn(),
  };
});

import { verifyWecomUrl, WecomIMAdapter } from '../wecomAdapter.js';
import { decryptWecomEncryptPayload, extractEncryptCDATA, looksLikeWecomEncryptedXml, parseWecomInboundFromXml, verifyWecomPostMessageSignature } from '../wecomCrypto.js';

import { createHash } from 'node:crypto';

describe('wecomAdapter', () => {
  it('verifyWecomUrl returns null when token missing or signature mismatch', () => {
    expect(verifyWecomUrl(undefined, { msgSignature: 'x', timestamp: 't', nonce: 'n', echostr: 'e' })).toBeNull();
    expect(
      verifyWecomUrl('tok', { msgSignature: 'bad', timestamp: 't', nonce: 'n', echostr: 'e' }),
    ).toBeNull();
  });

  it('verifyWecomUrl returns echostr when signature matches', () => {
    const token = 'tok';
    const timestamp = '1700000000';
    const nonce = 'nonce';
    const echostr = 'hello';
    const arr = [token.trim(), timestamp, nonce].sort().join('');
    const hash = createHash('sha1').update(arr, 'utf8').digest('hex');
    const out = verifyWecomUrl(token, { msgSignature: hash, timestamp, nonce, echostr });
    expect(out).toBe(echostr);
  });

  it('verify returns false for empty body and validates json/plain path', () => {
    const adapter = new WecomIMAdapter('tok', undefined, undefined);
    const ctx: any = { body: Buffer.from('   '), query: {} };
    expect(adapter.verify(ctx)).toBe(false);

    const adapter2 = new WecomIMAdapter('tok', undefined, undefined);
    expect(adapter2.verify({
      body: Buffer.from(JSON.stringify({ FromUserName: 'u', Text: 'hi' })),
      query: {},
      headers: {},
    })).toBe(true);
    expect(adapter2.verify({ body: Buffer.from('{not-json'), query: {}, headers: {} })).toBe(false);
  });

  it('verify encrypted path uses signature + decrypt result', () => {
    vi.mocked(looksLikeWecomEncryptedXml).mockReturnValue(true);
    vi.mocked(extractEncryptCDATA).mockReturnValue('enc-b64');

    vi.mocked(verifyWecomPostMessageSignature).mockReturnValue(false);
    vi.mocked(decryptWecomEncryptPayload).mockReturnValue('xml');

    const adapter = new WecomIMAdapter('tok', 'aes-key', 'corp');
    const ctx: any = {
      body: Buffer.from('<xml>enc</xml>'),
      query: { msg_signature: 'sig', timestamp: 'ts', nonce: 'n' },
    };
    expect(adapter.verify(ctx)).toBe(false);

    vi.mocked(verifyWecomPostMessageSignature).mockReturnValue(true);
    vi.mocked(decryptWecomEncryptPayload).mockReturnValue(null as any);
    expect(adapter.verify(ctx)).toBe(false);

    vi.mocked(decryptWecomEncryptPayload).mockReturnValue('<xml/>');
    expect(adapter.verify(ctx)).toBe(true);
  });

  it('parse encrypted path returns null on invalid/encrypt/missing or verified message', () => {
    vi.mocked(looksLikeWecomEncryptedXml).mockReturnValue(true);
    vi.mocked(extractEncryptCDATA).mockReturnValue('enc-b64');

    vi.mocked(verifyWecomPostMessageSignature).mockReturnValue(false);
    const adapter = new WecomIMAdapter('tok', 'aes-key', 'corp');
    const ctx: any = {
      body: Buffer.from('<xml>enc</xml>'),
      query: { msg_signature: 'sig', timestamp: 'ts', nonce: 'n' },
    };
    expect(adapter.parse('ch1', ctx)).toBeNull();

    vi.mocked(verifyWecomPostMessageSignature).mockReturnValue(true);
    vi.mocked(decryptWecomEncryptPayload).mockReturnValue(null as any);
    expect(adapter.parse('ch1', ctx)).toBeNull();

    const inbound = { platform: 'wecom', imUserId: 'u1', text: 'hi', raw: { ok: true } };
    vi.mocked(decryptWecomEncryptPayload).mockReturnValue('<inner/>');
    vi.mocked(parseWecomInboundFromXml).mockReturnValue(inbound as any);
    const msg = adapter.parse('ch1', ctx) as any;
    expect(msg.channelId).toBeUndefined(); // parse returns msg directly from parseWecomInboundFromXml
    expect(msg.imUserId).toBe('u1');
  });

  it('parse plain json returns inbound message and sets channelId', () => {
    const adapter = new WecomIMAdapter('tok', undefined, undefined);
    vi.mocked(looksLikeWecomEncryptedXml).mockReturnValue(false);

    const ctx: any = {
      body: Buffer.from(JSON.stringify({ FromUserName: 'u1', Text: '  hello  ' })),
      query: {},
    };
    const msg = adapter.parse('channel-1', ctx) as any;
    expect(msg.platform).toBe('wecom');
    expect(msg.channelId).toBe('channel-1');
    expect(msg.text).toBe('hello');

    const missingText = adapter.parse('channel-1', {
      body: Buffer.from(JSON.stringify({ FromUserName: 'u1' })),
      query: {},
      headers: {},
    }) as any;
    expect(missingText).toBeNull();
  });
});
