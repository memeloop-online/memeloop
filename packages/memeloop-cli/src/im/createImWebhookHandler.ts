import type { IAgentStorage, MemeLoopRuntime } from "memeloop";
import {
  IMChannelManager,
  streamRuntimeAgentReplyToIm,
  TextMessageRenderer,
  tryHandleImSlashCommand,
} from "memeloop";
import type { ImWebhookHandler } from "../network/nodeServerImpl.js";

import { resolveQuestionAnswer } from "memeloop";
import type { ImChannelYaml } from "../config";
import {
  parseDiscordInteraction,
  sendDiscordFollowup,
  verifyDiscordInteraction,
} from "./discordAdapter.js";
import { createImTaggedDriver } from "./imTaggedDriver.js";
import { handleLarkWebhook } from "./larkAdapter.js";
import { sendTelegramTextMessage, TelegramIMAdapter } from "./telegramAdapter.js";
import { verifyWecomUrl, WecomIMAdapter } from "./wecomAdapter.js";

export interface CreateImWebhookHandlerOptions {
  channels: ImChannelYaml[];
  manager: IMChannelManager;
  runtime: MemeLoopRuntime;
  storage: IAgentStorage;
}

function parseQueryString(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const part of qs.split("&")) {
    const index = part.indexOf("=");
    if (index < 0) {
      out[decodeURIComponent(part)] = "";
    } else {
      out[decodeURIComponent(part.slice(0, index))] = decodeURIComponent(part.slice(index + 1));
    }
  }
  return out;
}

type ImWebhookArguments = Parameters<ImWebhookHandler>[0] & {
  method?: string;
  queryString?: string;
};

export function createImWebhookHandler(options: CreateImWebhookHandlerOptions): ImWebhookHandler {
  const { channels, manager, runtime, storage } = options;

  const driver = {
    createAgent: runtime.createAgent.bind(runtime),
    sendMessage: runtime.sendMessage.bind(runtime),
  };

  const handler = async ({
    req,
    res,
    channelId,
    body,
    method = "POST",
    queryString = "",
  }: ImWebhookArguments) => {
    const cfg = channels.find((c) => c.channelId === channelId);
    if (!cfg) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("unknown channel");
      return;
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    const query = parseQueryString(queryString);
    const context = { headers, body, query };

    if (cfg.platform === "wecom" && method === "GET") {
      const echostr = verifyWecomUrl(cfg.wecomToken, {
        msgSignature: query.msg_signature ?? "",
        timestamp: query.timestamp ?? "",
        nonce: query.nonce ?? "",
        echostr: query.echostr ?? "",
      });
      if (echostr == null) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("verify failed");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(echostr);
      return;
    }

    if (cfg.platform === "telegram") {
      const adapter = new TelegramIMAdapter(cfg.webhookSecret);
      if (!adapter.verify(context)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const inbound = adapter.parse(channelId, context);
      if (!inbound || !inbound.text.trim()) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      try {
        const tagged = createImTaggedDriver(runtime, storage, {
          channelId: inbound.channelId,
          platform: inbound.platform,
          imUserId: inbound.imUserId,
        });
        // Route order: slash commands -> pendingQuestionId -> normal message (see plan v8).
        const existing = await manager.getBinding(inbound.channelId, inbound.imUserId);
        const definitionId = cfg.defaultDefinitionId ?? "memeloop:general-assistant";
        if (inbound.text.startsWith("/") && inbound.text.trim().length > 1) {
          const slash = await tryHandleImSlashCommand({
            rawText: inbound.text,
            channelId: inbound.channelId,
            imUserId: inbound.imUserId,
            manager,
            storage,
            driver: tagged,
            runtime,
            defaultDefinitionId: definitionId,
          });
          if (slash.handled) {
            await sendTelegramTextMessage(
              cfg.botToken,
              inbound.imUserId,
              slash.messages.join("\n\n"),
            );
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
          }
        }
        if (existing?.pendingQuestionId) {
          const ok = resolveQuestionAnswer(existing.pendingQuestionId, inbound.text);
          await manager.setBinding({ ...existing, pendingQuestionId: undefined });
          await sendTelegramTextMessage(
            cfg.botToken,
            inbound.imUserId,
            ok ? "已收到回答，继续执行…" : "回答未被接受（可能已超时）",
          );
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
          return;
        }
        const { conversationId } = await manager.dispatchInbound(inbound, tagged, {
          defaultDefinitionId: definitionId,
        });
        void streamRuntimeAgentReplyToIm({
          runtime,
          conversationId,
          platform: "telegram",
          renderer: new TextMessageRenderer(),
          flush: (text) => sendTelegramTextMessage(cfg.botToken, inbound.imUserId, text),
        }).catch((error: unknown) =>
          sendTelegramTextMessage(
            cfg.botToken,
            inbound.imUserId,
            `⚠️ ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      } catch (error) {
        await sendTelegramTextMessage(
          cfg.botToken,
          inbound.imUserId,
          `处理失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (cfg.platform === "discord") {
      if (!verifyDiscordInteraction(cfg.discordPublicKey, context)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const parsed = parseDiscordInteraction(channelId, context);
      if (parsed.kind === "ping") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: 1 }));
        return;
      }
      if (parsed.kind === "application_command") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: 5 }));
        const definitionId = cfg.defaultDefinitionId ?? "memeloop:general-assistant";
        void (async () => {
          try {
            await manager.dispatchInbound(
              {
                channelId,
                platform: "discord",
                imUserId: parsed.userId,
                text: parsed.text,
                raw: parsed.raw,
              },
              driver,
              { defaultDefinitionId: definitionId },
            );
            await sendDiscordFollowup(parsed.applicationId, parsed.token, "已收到，正在处理…");
          } catch (error) {
            await sendDiscordFollowup(
              parsed.applicationId,
              parsed.token,
              `处理失败：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: 1 }));
      return;
    }

    if (cfg.platform === "lark") {
      const larkResponse = handleLarkWebhook(
        channelId,
        cfg.larkVerificationToken,
        cfg.larkEncryptKey,
        context,
      );
      if (larkResponse.kind === "url_verification") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: larkResponse.challenge }));
        return;
      }
      if (larkResponse.kind === "inbound") {
        try {
          await manager.dispatchInbound(larkResponse.message, driver, {
            defaultDefinitionId: cfg.defaultDefinitionId ?? "memeloop:general-assistant",
          });
        } catch {
          /* 仍返回 200 避免飞书重试风暴 */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }

    if (cfg.platform === "wecom") {
      const adapter = new WecomIMAdapter(cfg.wecomToken, cfg.wecomEncodingAesKey, cfg.wecomCorpId);
      if (!adapter.verify(context)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      const inbound = adapter.parse(channelId, context);
      if (!inbound || !inbound.text.trim()) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");
        return;
      }
      try {
        await manager.dispatchInbound(inbound, driver, {
          defaultDefinitionId: cfg.defaultDefinitionId ?? "memeloop:general-assistant",
        });
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("success");
      return;
    }

    res.writeHead(501, { "Content-Type": "text/plain" });
    res.end("platform not supported");
  };

  return handler as ImWebhookHandler;
}
