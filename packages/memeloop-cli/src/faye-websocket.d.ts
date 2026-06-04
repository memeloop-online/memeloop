declare module "faye-websocket" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket {
    constructor(
      request: IncomingMessage,
      socket: Duplex,
      body: Buffer | string,
    );
    static isWebSocket(request: IncomingMessage): boolean;
    onmessage: ((event: { data: string | Buffer | ArrayBuffer }) => void) | null;
    send(data: string | Buffer | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
  }
}
