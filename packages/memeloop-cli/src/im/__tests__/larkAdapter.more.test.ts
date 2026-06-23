import { describe, expect, it } from 'vitest';

import { handleLarkWebhook, LarkIMAdapter } from '../larkAdapter.js';

describe('larkAdapter more branches', () => {
  it('handleLarkWebhook ignores invalid token and non-text messages', () => {
    const body = Buffer.from(JSON.stringify({
      header: { token: 'bad', event_type: 'im.message.receive_v1' },
      event: { message: { content: JSON.stringify({ text: 'x' }), chat_id: 'c1' } },
    }));
    const r1 = handleLarkWebhook('ch', 'good', undefined, { headers: {}, body });
    expect(r1.kind).toBe('ignore');

    const body2 = Buffer.from(JSON.stringify({
      header: { token: 'good', event_type: 'im.message.receive_v1' },
      event: { message: { content: '', chat_id: 'c1' } },
    }));
    const r2 = handleLarkWebhook('ch', 'good', undefined, { headers: {}, body: body2 });
    expect(r2.kind).toBe('ignore');
  });

  it('LarkIMAdapter verify and parse branches', () => {
    const adapter = new LarkIMAdapter('vt', undefined);
    expect(adapter.verify({ headers: {}, body: Buffer.from('') })).toBe(false);
    expect(adapter.verify({ headers: {}, body: Buffer.from('{bad}') })).toBe(false);
    expect(adapter.verify({ headers: {}, body: Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'x' })) })).toBe(true);
    expect(adapter.verify({ headers: {}, body: Buffer.from(JSON.stringify({ token: 'bad' })) })).toBe(false);
    expect(adapter.verify({ headers: {}, body: Buffer.from(JSON.stringify({ token: 'vt' })) })).toBe(true);

    const inboundBody = Buffer.from(JSON.stringify({
      header: { token: 'vt', event_type: 'im.message.receive_v1' },
      event: { message: { content: JSON.stringify({ text: 'hello' }), chat_id: 'c1' } },
    }));
    const msg = adapter.parse('ch1', { headers: {}, body: inboundBody });
    expect(msg?.platform).toBe('lark');
    expect(msg?.text).toBe('hello');
  });
});
