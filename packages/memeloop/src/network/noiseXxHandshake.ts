/**
 * Noise_XX 三消息握手（计划 §7.5.4），基于 `noise-handshake`（X25519 + BLAKE2b + ChaChaPoly）。
 * 全流量帧加密见 {@link encryptNoiseFrame} / {@link decryptNoiseFrame}（`noiseTransport.ts`）。
 *
 * 生产路径：WebSocket 建立后按序交换三条 **binary** 握手消息，再使用返回的会话密钥加密后续帧。
 *
 * 使用动态 `import()` 加载 CJS 包，避免在双格式（CJS+ESM）构建中使用 `import.meta`/`createRequire`。
 */

type NoiseClass = new(
  pattern: string,
  initiator: boolean,
  staticKeypair?: { publicKey: Buffer; secretKey: Buffer },
) => NoiseXxHandshakePeer;

/**
 * `noise-handshake` 对等实例：按顺序 `send` / `recv` 完成三条消息后即可握手结束。
 * 用于 WebSocket：每条 `send()` 产出的一条 Buffer 作为一个 **binary frame** 发到对端。
 */
export interface NoiseXxHandshakePeer {
  initialise(prologue: Buffer, remoteStatic?: Buffer): void;
  send(payload?: Buffer): Buffer;
  recv(buf: Buffer): Buffer;
  complete: boolean;
  tx: Buffer;
  rx: Buffer;
  rs: Buffer;
  hash: Buffer;
}

type DhModule = {
  generateKeyPair(): { publicKey: Buffer; secretKey: Buffer };
};

let noiseModulePromise: Promise<{ Noise: NoiseClass; dh: DhModule }> | undefined;

/** 与客户端/服务端共用，保证 Noise prologue 一致。 */
export const MEMELOOP_NOISE_PROLOGUE_V1 = Buffer.from('memeloop-noise-v1', 'utf8');

async function loadNoiseModules(): Promise<{ Noise: NoiseClass; dh: DhModule }> {
  if (!noiseModulePromise) {
    noiseModulePromise = (async () => {
      const [noiseMod, dhMod] = await Promise.all([
        import('noise-handshake'),
        import('noise-handshake/dh.js'),
      ]);
      const Noise = (noiseMod as { default?: NoiseClass }).default ?? (noiseMod as unknown as NoiseClass);
      const dh = dhMod as DhModule;
      return { Noise, dh };
    })();
  }
  return noiseModulePromise;
}

export type NoiseStaticKeyPair = {
  publicKey: Buffer;
  secretKey: Buffer;
};

/** 生成 X25519 静态密钥对（与 Noise 库默认曲线一致）。 */
export async function generateX25519KeyPairForNoise(): Promise<NoiseStaticKeyPair> {
  const { dh } = await loadNoiseModules();
  return dh.generateKeyPair();
}

/**
 * 发起方：构造后先 `send()` 得到第一条 binary 消息（msg1）。
 * 之后按序 `recv(对端第二条)` → `send()` 得到第三条。
 */
export async function createNoiseXxInitiator(
  staticKeypair: NoiseStaticKeyPair,
  prologue: Buffer = Buffer.alloc(0),
): Promise<NoiseXxHandshakePeer> {
  const { Noise } = await loadNoiseModules();
  const peer = new Noise('XX', true, staticKeypair);
  peer.initialise(prologue);
  return peer;
}

/**
 * 响应方：收到第一条 binary 后 `recv(msg1)`，再 `send()` 得到第二条；最后 `recv(msg3)`。
 */
export async function createNoiseXxResponder(
  staticKeypair: NoiseStaticKeyPair,
  prologue: Buffer = Buffer.alloc(0),
): Promise<NoiseXxHandshakePeer> {
  const { Noise } = await loadNoiseModules();
  const peer = new Noise('XX', false, staticKeypair);
  peer.initialise(prologue);
  return peer;
}

/**
 * 握手完成（`peer.complete === true`）后：用于 {@link encryptNoiseFrame} / {@link decryptNoiseFrame} 的 32 字节密钥。
 * - 发送方向：用 `sendKey` 作为 encrypt 的 key（本端发出的密文）
 * - 接收方向：用 `recvKey` 作为 decrypt 的 key（本端收到的密文）
 */
export function getNoiseXxPeerCryptoMaterial(peer: NoiseXxHandshakePeer): {
  sendKey: Buffer;
  recvKey: Buffer;
  remoteStaticPublicKey: Buffer;
  handshakeHash: Buffer;
} {
  return {
    sendKey: peer.tx,
    recvKey: peer.rx,
    remoteStaticPublicKey: peer.rs,
    handshakeHash: peer.hash,
  };
}

export interface NoiseXxHandshakeResult {
  /** Initiator → Responder 方向 ChaCha20-Poly1305 密钥（与 responder.rx 相同）。 */
  initiatorToResponderKey: Buffer;
  /** Responder → Initiator 方向密钥（与 initiator.rx 相同）。 */
  responderToInitiatorKey: Buffer;
  /** 发起方看到的对方静态公钥（应等于 responder 的 publicKey）。 */
  initiatorRemoteStatic: Buffer;
  /** 响应方看到的对方静态公钥（应等于 initiator 的 publicKey）。 */
  responderRemoteStatic: Buffer;
  initiatorHandshakeHash: Buffer;
  responderHandshakeHash: Buffer;
}

/**
 * 在内存中跑完 Noise_XX（用于单测或工具函数）；线上应分三条 WS binary 消息收发。
 */
export async function completeNoiseXxHandshake(
  initiatorStatic: NoiseStaticKeyPair,
  responderStatic: NoiseStaticKeyPair,
  prologue: Buffer = Buffer.alloc(0),
): Promise<NoiseXxHandshakeResult> {
  const initiator = await createNoiseXxInitiator(initiatorStatic, prologue);
  const responder = await createNoiseXxResponder(responderStatic, prologue);

  responder.recv(initiator.send());
  initiator.recv(responder.send());
  responder.recv(initiator.send());

  if (!initiator.complete || !responder.complete) {
    throw new Error('noise_xx: handshake incomplete');
  }
  if (!initiator.tx.equals(responder.rx) || !initiator.rx.equals(responder.tx)) {
    throw new Error('noise_xx: session key mismatch');
  }
  if (!initiator.rs.equals(responderStatic.publicKey) || !responder.rs.equals(initiatorStatic.publicKey)) {
    throw new Error('noise_xx: remote static key mismatch');
  }

  return {
    initiatorToResponderKey: initiator.tx,
    responderToInitiatorKey: initiator.rx,
    initiatorRemoteStatic: initiator.rs,
    responderRemoteStatic: responder.rs,
    initiatorHandshakeHash: initiator.hash,
    responderHandshakeHash: responder.hash,
  };
}
