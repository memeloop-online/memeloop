declare module "noise-handshake" {
  interface NoisePeer {
    initialise(prologue: Buffer, remoteStatic?: Buffer): void;
    send(payload?: Buffer): Buffer;
    recv(buf: Buffer): Buffer;
    complete: boolean;
    tx: Buffer;
    rx: Buffer;
    rs: Buffer;
    hash: Buffer;
  }

  const Noise: new (
    pattern: string,
    initiator: boolean,
    staticKeypair?: { publicKey: Buffer; secretKey: Buffer },
  ) => NoisePeer;
  export default Noise;
}

declare module "noise-handshake/dh.js" {
  export function generateKeyPair(): { publicKey: Buffer; secretKey: Buffer };
}
