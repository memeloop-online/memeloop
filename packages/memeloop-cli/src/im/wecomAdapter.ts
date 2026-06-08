import { createHash } from "node:crypto";

import type { IIMAdapter, ImInboundMessage, ImWebhookContext } from "memeloop";

import {
  decryptWecomEncryptPayload,
  extractEncryptCDATA,
  looksLikeWecomEncryptedXml,
  parseWecomInboundFromXml,
  verifyWecomPostMsgSignature as verifyWecomPostMessageSignature,
} from "./wecomCrypto.js";

export type WecomUrlVerifyQuery = {
  msgSignature: string;
  timestamp: string;
  nonce: string;
  echostr: string;
};

/** 企业微信：回调 URL GET 校验（token + timestamp + nonce 字典序 SHA1）。 */
export function verifyWecomUrl(token: string | undefined, q: WecomUrlVerifyQuery): string | null {
  if (!token?.trim()) {
    return null;
  }
  const array = [token.trim(), q.timestamp, q.nonce].sort().join("");
  const hash = createHash("sha1").update(array, "utf8").digest("hex");
  if (hash !== q.msgSignature) {
    return null;
  }
  return q.echostr;
}

function parseWecomJsonBody(body: Uint8Array): ImInboundMessage | null {
  let json: {
    FromUserName?: string;
    Text?: string;
    Content?: string;
    MsgType?: string;
  };
  try {
    json = JSON.parse(Buffer.from(body).toString("utf8")) as typeof json;
  } catch {
    return null;
  }
  const text =
    typeof json.Text === "string"
      ? json.Text
      : typeof json.Content === "string"
        ? json.Content
        : "";
  const from = typeof json.FromUserName === "string" ? json.FromUserName : "";
  if (!text.trim() || !from) {
    return null;
  }
  return {
    channelId: "",
    platform: "wecom",
    imUserId: from,
    text: text.trim(),
    raw: json,
  };
}

export class WecomIMAdapter implements IIMAdapter {
  readonly platform = "wecom" as const;

  constructor(
    private readonly token?: string,
    private readonly encodingAesKey?: string,
    private readonly corpId?: string,
  ) {}

  verify(context: ImWebhookContext): boolean {
    const raw = Buffer.from(context.body).toString("utf8");
    if (!raw.trim()) {
      return false;
    }
    if (this.encodingAesKey?.trim() && looksLikeWecomEncryptedXml(raw)) {
      const q = context.query ?? {};
      const messageSig = q.msg_signature ?? "";
      const ts = q.timestamp ?? "";
      const nonce = q.nonce ?? "";
      const encrypt = extractEncryptCDATA(raw);
      if (
        !encrypt ||
        !verifyWecomPostMessageSignature(this.token, ts, nonce, encrypt, messageSig)
      ) {
        return false;
      }
      const xml = decryptWecomEncryptPayload(this.encodingAesKey, encrypt, this.corpId);
      return Boolean(xml);
    }
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }

  parse(channelId: string, context: ImWebhookContext): ImInboundMessage | null {
    const raw = Buffer.from(context.body).toString("utf8");
    if (this.encodingAesKey?.trim() && looksLikeWecomEncryptedXml(raw)) {
      const q = context.query ?? {};
      const encrypt = extractEncryptCDATA(raw);
      if (
        !encrypt ||
        !verifyWecomPostMessageSignature(
          this.token,
          q.timestamp ?? "",
          q.nonce ?? "",
          encrypt,
          q.msg_signature ?? "",
        )
      ) {
        return null;
      }
      const inner = decryptWecomEncryptPayload(this.encodingAesKey, encrypt, this.corpId);
      if (!inner) {
        return null;
      }
      const message = parseWecomInboundFromXml(inner, channelId);
      return message;
    }
    const message = parseWecomJsonBody(context.body);
    if (!message) {
      return null;
    }
    return { ...message, channelId };
  }
}
