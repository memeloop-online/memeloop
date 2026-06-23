import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendTelegramTextMessage, TelegramIMAdapter } from '../telegramAdapter.js';

describe('telegramAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verify supports secret/no-secret branches', () => {
    const noSecret = new TelegramIMAdapter(undefined);
    expect(noSecret.verify({ headers: {}, body: Buffer.from('{}') })).toBe(true);

    const withSecret = new TelegramIMAdapter('sec');
    expect(withSecret.verify({
      headers: { 'x-telegram-bot-api-secret-token': 'bad' },
      body: Buffer.from('{}'),
    })).toBe(false);
    expect(withSecret.verify({
      headers: { 'x-telegram-bot-api-secret-token': 'sec' },
      body: Buffer.from('{}'),
    })).toBe(true);
  });

  it('parse handles invalid/missing chat and valid message', () => {
    const adapter = new TelegramIMAdapter();
    expect(adapter.parse('ch', { headers: {}, body: Buffer.from('{bad}') })).toBeNull();
    expect(adapter.parse('ch', { headers: {}, body: Buffer.from(JSON.stringify({ message: {} })) })).toBeNull();

    const msg = adapter.parse('ch', {
      headers: {},
      body: Buffer.from(JSON.stringify({ message: { text: 'hello', chat: { id: 123 } } })),
    });
    expect(msg?.platform).toBe('telegram');
    expect(msg?.imUserId).toBe('123');
    expect(msg?.text).toBe('hello');
  });

  it('sendTelegramTextMessage is best-effort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network')));
    await expect(sendTelegramTextMessage('bt', 'cid', 'txt')).resolves.toBeUndefined();
  });
});
