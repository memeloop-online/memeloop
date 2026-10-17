import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { DiscordIMAdapter, parseDiscordInteraction, sendDiscordFollowup, verifyDiscordInteraction } from '../discordAdapter.js';

function rawEd25519PublicKeyHex(publicKey: KeyObject): string {
  const der = publicKey.export({
    type: 'spki',
    format: 'der',
  }) as Buffer;
  return der.subarray(-32).toString('hex');
}

describe('verifyDiscordInteraction', () => {
  it('returns true for a valid Ed25519 signature over timestamp+body', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const hex = rawEd25519PublicKeyHex(publicKey);
    const body = '{"type":1}';
    const ts = '1700000000';
    const sig = sign(undefined, Buffer.from(ts + body, 'utf8'), privateKey);
    const ok = verifyDiscordInteraction(hex, {
      headers: {
        'x-signature-ed25519': sig.toString('hex'),
        'x-signature-timestamp': ts,
      },
      body: Buffer.from(body),
    });
    expect(ok).toBe(true);
  });

  it('returns false when signature does not match public key', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const { privateKey: otherPriv } = generateKeyPairSync('ed25519');
    const hex = rawEd25519PublicKeyHex(publicKey);
    const body = '{"type":1}';
    const ts = '1700000000';
    const sig = sign(undefined, Buffer.from(ts + body, 'utf8'), otherPriv);
    expect(
      verifyDiscordInteraction(hex, {
        headers: {
          'x-signature-ed25519': sig.toString('hex'),
          'x-signature-timestamp': ts,
        },
        body: Buffer.from(body),
      }),
    ).toBe(false);
  });

  it('returns false without public key', () => {
    expect(
      verifyDiscordInteraction(undefined, {
        headers: {},
        body: Buffer.from('{}'),
      }),
    ).toBe(false);
  });

  it('returns false when public key is blank/whitespace', () => {
    expect(
      verifyDiscordInteraction('   ', {
        headers: {},
        body: Buffer.from('{}'),
      }),
    ).toBe(false);
  });

  it('returns false when signature headers are missing', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const hex = rawEd25519PublicKeyHex(publicKey);
    expect(
      verifyDiscordInteraction(hex, {
        headers: {
          'x-signature-ed25519': '00',
          // missing timestamp header
        },
        body: Buffer.from('{}'),
      }),
    ).toBe(false);
  });

  it('returns false when public key parsing/verify throws', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const body = '{"type":1}';
    const ts = '1700000000';
    const sig = sign(undefined, Buffer.from(ts + body, 'utf8'), privateKey);

    // Give an invalid public key hex to trigger the try/catch path.
    expect(
      verifyDiscordInteraction('zzzz', {
        headers: {
          'x-signature-ed25519': sig.toString('hex'),
          'x-signature-timestamp': ts,
        },
        body: Buffer.from(body),
      }),
    ).toBe(false);
    void publicKey; // keep linter happy if publicKey ends up unused
  });

  it('parseDiscordInteraction handles ping/command/unsupported', () => {
    const ping = parseDiscordInteraction('ch', {
      headers: {},
      body: Buffer.from(JSON.stringify({ type: 1 })),
    } as any);
    expect(ping.kind).toBe('ping');

    const cmd = parseDiscordInteraction('ch', {
      headers: {},
      body: Buffer.from(JSON.stringify({
        type: 2,
        token: 'tok',
        application_id: 'app',
        member: { user: { id: 'u1' } },
        data: { options: [{ name: 'q', value: 'hello' }] },
      })),
    } as any);
    expect(cmd.kind).toBe('application_command');

    const unsupported = parseDiscordInteraction('ch', {
      headers: {},
      body: Buffer.from('{bad'),
    } as any);
    expect(unsupported.kind).toBe('unsupported');
  });

  it('parseDiscordInteraction uses json.user.id when member.user.id missing', () => {
    const cmd = parseDiscordInteraction('ch', {
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          type: 2,
          token: 'tok',
          application_id: 'app',
          user: { id: 'u2' },
          data: { options: [{ name: 'q', value: 'hello' }] },
        }),
      ),
    } as any);
    expect(cmd.kind).toBe('application_command');
    if (cmd.kind === 'application_command') {
      expect(cmd.userId).toBe('u2');
      expect(cmd.text).toBe('hello');
    }
  });

  it('parseDiscordInteraction returns unsupported when extracted text is empty', () => {
    const unsupported = parseDiscordInteraction('ch', {
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          type: 2,
          token: 'tok',
          application_id: 'app',
          member: { user: { id: 'u1' } },
          data: { options: [{ name: 'q', value: 123 }] },
        }),
      ),
    } as any);
    expect(unsupported.kind).toBe('unsupported');
  });

  it('sendDiscordFollowup is best-effort', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockRejectedValueOnce(new Error('network'));
    await expect(sendDiscordFollowup('app', 'tok', 'x')).resolves.toBeUndefined();
    fetchSpy.mockRestore();
  });

  it('reports outbound failures without rejecting the interaction path', async () => {
    const warn = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockRejectedValueOnce(new Error('network'));

    await expect(sendDiscordFollowup('app', 'tok', 'x', { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Discord outbound webhook failed', expect.any(Error));
    fetchSpy.mockRestore();
  });

  it('reports non-success webhook responses', async () => {
    const warn = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValueOnce(new Response(null, { status: 429 }));

    await sendDiscordFollowup('app', 'tok', 'x', { warn });
    expect(warn).toHaveBeenCalledWith(
      'Discord outbound webhook returned HTTP 429',
      { applicationId: 'app', status: 429 },
    );
    fetchSpy.mockRestore();
  });
});

describe('DiscordIMAdapter.parse', () => {
  it('returns null when webhook payload is not an application_command', () => {
    const adapter = new DiscordIMAdapter();
    const r = adapter.parse('ch', {
      headers: {},
      body: Buffer.from(JSON.stringify({ type: 1 })),
    } as any);
    expect(r).toBeNull();
  });

  it('returns ImInboundMessage when payload is application_command', () => {
    const adapter = new DiscordIMAdapter();
    const r = adapter.parse('ch', {
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          type: 2,
          token: 'tok',
          application_id: 'app',
          user: { id: 'u1' },
          data: { options: [{ name: 'q', value: 'hello' }] },
        }),
      ),
    } as any);
    expect(r).not.toBeNull();
    if (r) {
      expect(r.channelId).toBe('ch');
      expect(r.platform).toBe('discord');
      expect(r.text).toBe('hello');
      expect(r.imUserId).toBe('u1');
    }
  });
});
