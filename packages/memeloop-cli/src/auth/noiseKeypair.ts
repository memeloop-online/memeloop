import { createPrivateKey, createPublicKey } from "node:crypto";

import type { NoiseStaticKeyPair } from "../network/noiseXxHandshake.js";
import type { NodeKeypair } from "./keypair.js";

/**
 * Convert X25519 SPKI/PKCS8 (base64url) from node storage into the 32-byte raw key pair
 * required by Noise `noise-handshake`.
 *
 * 将 Node 存储的 X25519 SPKI/PKCS8（base64url）转为 Noise `noise-handshake` 所需的 32 字节 raw 密钥对。
 */
export function nodeKeypairToNoiseStaticKeyPair(kp: NodeKeypair): NoiseStaticKeyPair {
  const privDer = Buffer.from(kp.x25519PrivateKey, "base64url");
  const pubDer = Buffer.from(kp.x25519PublicKey, "base64url");
  const privKey = createPrivateKey({ key: privDer, format: "der", type: "pkcs8" });
  const pubKey = createPublicKey({ key: pubDer, format: "der", type: "spki" });
  const privJwk = privKey.export({ format: "jwk" }) as { d?: string };
  const pubJwk = pubKey.export({ format: "jwk" }) as { x?: string };
  if (!privJwk.d || !pubJwk.x) {
    throw new Error("nodeKeypairToNoiseStaticKeyPair: x25519 JWK export failed");
  }
  return {
    secretKey: Buffer.from(privJwk.d, "base64url"),
    publicKey: Buffer.from(pubJwk.x, "base64url"),
  };
}
