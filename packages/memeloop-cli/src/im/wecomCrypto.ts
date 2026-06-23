import { createDecipheriv, createHash } from 'node:crypto';

import type { ImInboundMessage } from 'memeloop';

/** 企业微信密文 POST：token + timestamp + nonce + encrypt 字典序拼接后 SHA1。 */
export function verifyWecomPostMessageSignature(
  token: string | undefined,
  timestamp: string,
  nonce: string,
  encrypt: string,
  messageSignature: string,
): boolean {
  if (!token?.trim() || !messageSignature) return false;
  const array = [token.trim(), timestamp, nonce, encrypt].sort().join('');
  const hash = createHash('sha1').update(array, 'utf8').digest('hex');
  return hash === messageSignature;
}

export function extractEncryptCDATA(xml: string): string | null {
  const m = xml.match(/<Encrypt>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Encrypt>/i);
  return m?.[1]?.trim() ? m[1].trim() : null;
}

/**
 * 企业微信消息加解密（AES-256-CBC + PKCS#7），与官方示例一致。
 * @see https://developer.work.weixin.qq.com/document/path/90930
 */
export function decryptWecomEncryptPayload(encodingAesKey: string, encryptBase64: string, corpId?: string): string | null {
  const key = Buffer.from(encodingAesKey.trim() + '=', 'base64');
  if (key.length !== 32) {
    return null;
  }
  let cipher: Buffer;
  try {
    cipher = Buffer.from(encryptBase64, 'base64');
  } catch {
    return null;
  }
  if (cipher.length < 16) {
    return null;
  }
  const iv = key.subarray(0, 16);
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    let d = Buffer.concat([decipher.update(cipher), decipher.final()]);
    const pad = d[d.length - 1] ?? 0;
    if (pad < 1 || pad > 16) {
      return null;
    }
    d = d.subarray(0, d.length - pad);
    if (d.length < 20) {
      return null;
    }
    const content = d.subarray(16);
    const messageLength = content.readUInt32BE(0);
    if (messageLength <= 0 || 4 + messageLength > content.length) {
      return null;
    }
    const xml = content.subarray(4, 4 + messageLength).toString('utf8');
    if (corpId?.trim()) {
      const tailBuf = content.subarray(4 + messageLength);
      const want = Buffer.from(corpId.trim(), 'utf8');
      if (tailBuf.length !== want.length || !tailBuf.equals(want)) {
        return null;
      }
    }
    return xml;
  } catch {
    return null;
  }
}

function extractXmlCdata(tag: string, xml: string): string | null {
  const re = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const m = xml.match(re);
  return m?.[1] != null ? m[1].trim() : null;
}

export function parseWecomInboundFromXml(xml: string, channelId: string): ImInboundMessage | null {
  const text = extractXmlCdata('Content', xml) ??
    extractXmlCdata('Text', xml) ??
    extractXmlCdata('content', xml) ??
    '';
  const from = extractXmlCdata('FromUserName', xml) ?? extractXmlCdata('fromusername', xml) ?? '';
  if (!text.trim() || !from) {
    return null;
  }
  return {
    channelId,
    platform: 'wecom',
    imUserId: from,
    text: text.trim(),
    raw: { xml },
  };
}

export function looksLikeWecomEncryptedXml(body: string): boolean {
  return body.includes('<Encrypt>') && body.includes('CDATA');
}
