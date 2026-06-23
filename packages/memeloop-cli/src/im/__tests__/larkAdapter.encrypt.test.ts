import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptLarkEncryptField, handleLarkWebhook } from '../larkAdapter.js';

function encryptLarkEnvelope(encryptKey: string, plaintextJson: string): Buffer {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const encrypt = Buffer.concat([iv, enc]).toString('base64');
  return Buffer.from(JSON.stringify({ encrypt }), 'utf8');
}

describe('Lark encrypted events', () => {
  it('decryptLarkEncryptField + handleLarkWebhook parses im.message.receive_v1', () => {
    const key = 'test-encrypt-key-32chars!!!!';
    const inner = {
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'vt' },
      event: {
        message: {
          content: JSON.stringify({ text: 'hello lark' }),
          chat_id: 'c1',
          sender: { sender_id: { open_id: 'ou1' } },
        },
      },
    };
    const body = encryptLarkEnvelope(key, JSON.stringify(inner));
    expect(decryptLarkEncryptField(key, body)).toContain('im.message.receive_v1');

    const r = handleLarkWebhook('ch1', 'vt', key, {
      headers: {},
      body,
    });
    expect(r.kind).toBe('inbound');
    if (r.kind === 'inbound') {
      expect(r.message.text).toBe('hello lark');
      expect(r.message.imUserId).toBe('ou1');
    }
  });

  it('returns null when encrypt key missing', () => {
    const body = Buffer.from(JSON.stringify({ encrypt: 'abc' }), 'utf8');
    expect(decryptLarkEncryptField(undefined, body)).toBeNull();
  });
});
