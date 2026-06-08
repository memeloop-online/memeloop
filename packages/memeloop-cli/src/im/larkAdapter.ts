import { createDecipheriv, createHash } from "node:crypto";

import type { IIMAdapter, ImInboundMessage, ImWebhookContext } from "memeloop";

export type LarkWebhookResult =
  | { kind: "url_verification"; challenge: string }
  | { kind: "inbound"; message: ImInboundMessage }
  | { kind: "ignore" };

/**
 * 飞书事件加密：`encrypt` 字段 AES-256-CBC，key = SHA256(encrypt_key)，IV 为密文前 16 字节。
 * @see https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
 */
export function decryptLarkEncryptField(
  encryptKey: string | undefined,
  body: Uint8Array,
): string | null {
  if (!encryptKey?.trim()) {
    return null;
  }
  let wrap: { encrypt?: string };
  try {
    wrap = JSON.parse(Buffer.from(body).toString("utf8")) as { encrypt?: string };
  } catch {
    return null;
  }
  if (typeof wrap.encrypt !== "string" || !wrap.encrypt.trim()) {
    return null;
  }
  try {
    const key = createHash("sha256").update(encryptKey.trim(), "utf8").digest();
    const buf = Buffer.from(wrap.encrypt, "base64");
    if (buf.length <= 16) {
      return null;
    }
    const iv = buf.subarray(0, 16);
    const data = buf.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 飞书事件：URL 校验；明文或解密后的 im.message.receive_v1（未配置 encrypt_key 且仅有 encrypt 时 ignore）。
 */
export function handleLarkWebhook(
  channelId: string,
  verificationToken: string | undefined,
  encryptKey: string | undefined,
  context: ImWebhookContext,
): LarkWebhookResult {
  let json: {
    type?: string;
    challenge?: string;
    token?: string;
    header?: { token?: string; event_type?: string };
    event?: {
      message?: {
        content?: string;
        chat_id?: string;
        sender?: { sender_id?: { open_id?: string } };
      };
    };
  };
  const decrypted = decryptLarkEncryptField(encryptKey, context.body);
  try {
    json = JSON.parse(decrypted ?? Buffer.from(context.body).toString("utf8")) as typeof json;
  } catch {
    return { kind: "ignore" };
  }

  if (json.type === "url_verification" && typeof json.challenge === "string") {
    return { kind: "url_verification", challenge: json.challenge };
  }

  const bodyToken = json.token ?? json.header?.token;
  if (verificationToken?.trim() && bodyToken !== verificationToken.trim()) {
    return { kind: "ignore" };
  }

  if (json.header?.event_type === "im.message.receive_v1" && json.event?.message) {
    const message = json.event.message;
    let text = "";
    if (typeof message.content === "string" && message.content.trim()) {
      try {
        const c = JSON.parse(message.content) as { text?: string };
        text = typeof c.text === "string" ? c.text : message.content;
      } catch {
        text = message.content;
      }
    }
    const openId = message.sender?.sender_id?.open_id ?? message.chat_id ?? "unknown";
    if (text.trim()) {
      return {
        kind: "inbound",
        message: {
          channelId,
          platform: "lark",
          imUserId: openId,
          text: text.trim(),
          raw: json,
        },
      };
    }
  }

  return { kind: "ignore" };
}

export class LarkIMAdapter implements IIMAdapter {
  readonly platform = "lark" as const;

  constructor(
    private readonly verificationToken?: string,
    private readonly encryptKey?: string,
  ) {}

  verify(context: ImWebhookContext): boolean {
    const raw =
      decryptLarkEncryptField(this.encryptKey, context.body) ??
      Buffer.from(context.body).toString("utf8");
    if (!raw.trim()) {
      return false;
    }
    try {
      const index = JSON.parse(raw) as { token?: string; type?: string };
      if (index.type === "url_verification") {
        return true;
      }
      if (this.verificationToken?.trim()) {
        return index.token === this.verificationToken.trim();
      }
      return true;
    } catch {
      return false;
    }
  }

  parse(channelId: string, context: ImWebhookContext): ImInboundMessage | null {
    const r = handleLarkWebhook(channelId, this.verificationToken, this.encryptKey, context);
    return r.kind === "inbound" ? r.message : null;
  }
}
