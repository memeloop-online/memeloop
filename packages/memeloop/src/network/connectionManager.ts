/**
 * WebSocket connection manager: connect, disconnect, auto-reconnect, heartbeat.
 * Used by node/desktop/mobile for JSON-RPC over WS.
 *
 * 可选：Noise_XX 三条 binary 握手（与 {@link createNodeServer} 一致）完成后，用 {@link NoiseJsonRpcCodec} 加密后续 UTF-8 JSON 文本帧（计划 §7.5.5）。
 */

import { NoiseJsonRpcCodec } from "./noiseTransport.js";
import {
  createNoiseXxInitiator,
  getNoiseXxPeerCryptoMaterial,
  MEMELOOP_NOISE_PROLOGUE_V1,
  type NoiseStaticKeyPair,
} from "./noiseXxHandshake.js";

export type ConnectionState = "closed" | "connecting" | "open";

export interface ConnectionManagerOptions {
  /** Auto-reconnect on close (default true) */
  autoReconnect?: boolean;
  /** Max reconnect attempts (default 10) */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay ms (default 1000) */
  reconnectDelayMs?: number;
  /** Heartbeat interval ms; 0 = no heartbeat (default 30000) */
  heartbeatIntervalMs?: number;
  /** Callback to send auth as first message after open; if returns a string, send it */
  onOpenSendAuth?: () => string | Promise<string | undefined>;
  /**
   * 客户端发起 Noise_XX；握手完成后再挂载 `onmessage`、发送 `onOpenSendAuth`、心跳。
   * 需与服务端使用相同 {@link MEMELOOP_NOISE_PROLOGUE_V1}（或显式传入相同 prologue）。
   */
  noise?: {
    staticKeyPair: NoiseStaticKeyPair;
    prologue?: Buffer;
  };
}

const defaultOptions: Required<Omit<ConnectionManagerOptions, "onOpenSendAuth" | "noise">> & {
  onOpenSendAuth?: () => string | Promise<string | undefined>;
  noise?: ConnectionManagerOptions["noise"];
} = {
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectDelayMs: 1000,
  heartbeatIntervalMs: 30_000,
};

export class ConnectionManager {
  private url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "closed";
  private opts: Required<Omit<ConnectionManagerOptions, "onOpenSendAuth" | "noise">> & {
    onOpenSendAuth?: () => string | Promise<string | undefined>;
    noise?: ConnectionManagerOptions["noise"];
  };
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private onMessageCb: ((data: string) => void) | null = null;
  private onOpenCb: (() => void) | null = null;
  private onCloseCb: ((event: { code?: number; reason?: string }) => void) | null = null;
  private noiseCodec: NoiseJsonRpcCodec | null = null;

  constructor(url: string, options: ConnectionManagerOptions = {}) {
    this.url = url;
    this.opts = { ...defaultOptions, ...options };
  }

  getState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "open") {
      return;
    }
    this.state = "connecting";
    this.noiseCodec = null;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        void this.afterOpen();
      };
      this.ws.onclose = (event) => {
        this.handleClose(event);
      };
      this.ws.onerror = () => {
        /* logged via onclose */
      };
    } catch {
      this.state = "closed";
      this.scheduleReconnect();
    }
  }

  private async afterOpen(): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    try {
      const noise = this.opts.noise;
      if (noise) {
        try {
          (ws as WebSocket & { binaryType?: string }).binaryType = "arraybuffer";
        } catch {
          /* ignore */
        }
        const prologue = noise.prologue ?? MEMELOOP_NOISE_PROLOGUE_V1;
        const peer = await createNoiseXxInitiator(noise.staticKeyPair, prologue);
        const message1 = peer.send();
        ws.send(new Uint8Array(message1));
        const message2 = await this.waitForOneBinaryFrame(ws);
        peer.recv(message2);
        const message3 = peer.send();
        ws.send(new Uint8Array(message3));
        const mat = getNoiseXxPeerCryptoMaterial(peer);
        this.noiseCodec = new NoiseJsonRpcCodec(mat.sendKey, mat.recvKey);
      }

      this.state = "open";
      this.reconnectAttempts = 0;

      ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event);
      };

      if (this.opts.onOpenSendAuth) {
        try {
          const authPayload = await this.opts.onOpenSendAuth();
          if (authPayload && this.ws?.readyState === WebSocket.OPEN) {
            this.sendRawUtf8(authPayload);
          }
        } catch {
          // ignore auth send failure
        }
      }

      if (this.opts.heartbeatIntervalMs > 0) {
        this.heartbeatTimer = setInterval(() => {
          this.sendHeartbeat();
        }, this.opts.heartbeatIntervalMs);
      }
      this.onOpenCb?.();
    } catch {
      this.state = "closed";
      this.noiseCodec = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      // `handleClose` 会 `scheduleReconnect`；此处不再重复调度
    }
  }

  /** 握手阶段收一条 binary（尚未挂接 onmessage）。 */
  private waitForOneBinaryFrame(ws: WebSocket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const done = (event: MessageEvent): void => {
        cleanup();
        const raw = event.data as string | ArrayBuffer | Buffer;
        if (typeof raw === "string") {
          reject(new Error("connectionManager: expected binary Noise handshake frame"));
          return;
        }
        if (raw instanceof ArrayBuffer) {
          resolve(Buffer.from(raw));
          return;
        }
        if (Buffer.isBuffer(raw)) {
          resolve(raw);
          return;
        }
        reject(new Error("connectionManager: unsupported WebSocket message payload"));
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("connectionManager: WebSocket error during Noise handshake"));
      };
      const cleanup = (): void => {
        ws.removeEventListener("message", done as EventListener);
        ws.removeEventListener("error", onError);
      };
      ws.addEventListener("message", done as EventListener, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
  }

  private sendRawUtf8(utf8: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.noiseCodec) {
      const enc = this.noiseCodec.encrypt(utf8);
      this.ws.send(new Uint8Array(enc));
    } else {
      this.ws.send(utf8);
    }
  }

  private sendHeartbeat(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: null });
      this.sendRawUtf8(payload);
    }
  }

  private handleMessage(event: MessageEvent): void {
    let text: string;
    const raw = event.data as string | ArrayBuffer | Buffer;
    if (this.noiseCodec) {
      const buf =
        typeof raw === "string"
          ? Buffer.from(raw, "binary")
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : Buffer.isBuffer(raw)
              ? raw
              : Buffer.from(String(raw));
      try {
        text = this.noiseCodec.decrypt(buf);
      } catch {
        return;
      }
    } else {
      text = typeof raw === "string" ? raw : "";
    }
    this.onMessageCb?.(text);
  }

  private handleClose(event: CloseEvent): void {
    this.state = "closed";
    this.noiseCodec = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws = null;
    this.onCloseCb?.({ code: event.code, reason: event.reason });
    if (this.opts.autoReconnect && this.reconnectAttempts < this.opts.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = this.opts.reconnectDelayMs * Math.min(this.reconnectAttempts, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this.opts.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.state = "closed";
  }

  send(data: string): void {
    this.sendRawUtf8(data);
  }

  onMessage(callback: (data: string) => void): void {
    this.onMessageCb = callback;
  }

  onOpen(callback: () => void): void {
    this.onOpenCb = callback;
  }

  onClose(callback: (event: { code?: number; reason?: string }) => void): void {
    this.onCloseCb = callback;
  }
}
