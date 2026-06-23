import type { IIMAdapter, ImInboundMessage, ImWebhookContext } from 'memeloop';

export class TelegramIMAdapter implements IIMAdapter {
  readonly platform = 'telegram' as const;

  constructor(private readonly webhookSecret?: string) {}

  verify(context: ImWebhookContext): boolean {
    if (!this.webhookSecret?.trim()) {
      return true;
    }
    const h = context.headers['x-telegram-bot-api-secret-token'];
    const v = Array.isArray(h) ? h[0] : h;
    return v === this.webhookSecret;
  }

  parse(channelId: string, context: ImWebhookContext): ImInboundMessage | null {
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(context.body).toString('utf8')) as unknown;
    } catch {
      return null;
    }
    const root = data as {
      message?: { text?: string; chat?: { id?: number | string } };
    };
    const message = root.message;
    if (!message?.chat?.id) {
      return null;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    return {
      channelId,
      platform: 'telegram',
      imUserId: String(message.chat.id),
      text,
      raw: data,
    };
  }
}

export async function sendTelegramTextMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  }).catch(() => {
    /* 出站失败不阻塞 webhook 200 */
  });
}
