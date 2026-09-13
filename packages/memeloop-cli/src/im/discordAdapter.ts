import { createPublicKey, verify } from 'node:crypto';

import type { IIMAdapter, ImInboundMessage, ImWebhookContext, MemeLoopLogger } from 'memeloop';

export type DiscordOutboundLogger = Pick<MemeLoopLogger, 'warn'>;

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function discordPublicKeyFromHex(hex: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/** Discord Interactions：Ed25519 验签（raw body + 头）。 */
export function verifyDiscordInteraction(
  publicKeyHex: string | undefined,
  context: ImWebhookContext,
): boolean {
  if (!publicKeyHex?.trim()) {
    return false;
  }
  const sigH = context.headers['x-signature-ed25519'];
  const tsH = context.headers['x-signature-timestamp'];
  const sig = (Array.isArray(sigH) ? sigH[0] : sigH) ?? '';
  const ts = (Array.isArray(tsH) ? tsH[0] : tsH) ?? '';
  if (!sig || !ts) {
    return false;
  }
  try {
    const key = discordPublicKeyFromHex(publicKeyHex.trim());
    const message = Buffer.from(ts + Buffer.from(context.body).toString('utf8'), 'utf8');
    return verify(null, message, key, Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

export type DiscordWebhookParseResult =
  | { kind: 'ping' }
  | {
    kind: 'application_command';
    applicationId: string;
    token: string;
    userId: string;
    text: string;
    raw: unknown;
  }
  | { kind: 'unsupported' };

function extractSlashCommandText(data: {
  options?: Array<{ value?: unknown; name?: string }>;
}): string {
  const parts: string[] = [];
  for (const o of data.options ?? []) {
    if (typeof o.value === 'string') {
      parts.push(o.value);
    }
  }
  return parts.join(' ').trim();
}

export function parseDiscordInteraction(
  _channelId: string,
  context: ImWebhookContext,
): DiscordWebhookParseResult {
  let json: {
    type?: number;
    token?: string;
    application_id?: string;
    member?: { user?: { id?: string } };
    user?: { id?: string };
    data?: { options?: Array<{ value?: unknown; name?: string }> };
  };
  try {
    json = JSON.parse(Buffer.from(context.body).toString('utf8')) as typeof json;
  } catch {
    return { kind: 'unsupported' };
  }
  if (json.type === 1) {
    return { kind: 'ping' };
  }
  if (json.type === 2 && json.token && json.application_id) {
    const userId = json.member?.user?.id ?? json.user?.id;
    const text = extractSlashCommandText(json.data ?? {});
    if (userId && text) {
      return {
        kind: 'application_command',
        applicationId: json.application_id,
        token: json.token,
        userId,
        text,
        raw: json,
      };
    }
  }
  return { kind: 'unsupported' };
}

export async function sendDiscordFollowup(
  applicationId: string,
  interactionToken: string,
  content: string,
  logger?: DiscordOutboundLogger,
): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 2000) }),
    });
    if (!response.ok) {
      logger?.warn?.(`Discord outbound webhook returned HTTP ${response.status}`, {
        applicationId,
        status: response.status,
      });
    }
  } catch (error) {
    logger?.warn?.('Discord outbound webhook failed', error);
  }
}

/**
 * Discord Interactions / Webhook：Ed25519 验签；parse 仍走统一 IIMAdapter（仅在有可解析文本时非 null）。
 */
export class DiscordIMAdapter implements IIMAdapter {
  readonly platform = 'discord' as const;

  constructor(private readonly publicKeyHex?: string) {}

  verify(context: ImWebhookContext): boolean {
    return verifyDiscordInteraction(this.publicKeyHex, context);
  }

  parse(channelId: string, context: ImWebhookContext): ImInboundMessage | null {
    const r = parseDiscordInteraction(channelId, context);
    if (r.kind !== 'application_command') {
      return null;
    }
    return {
      channelId,
      platform: 'discord',
      imUserId: r.userId,
      text: r.text,
      raw: r.raw,
    };
  }
}
