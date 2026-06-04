export type AuthType = "pairingToken" | "jwt" | "pin";

export interface AuthHandshakeParameters {
  nodeId: string;
  authType: AuthType;
  credential: string;
}

/** 服务端发起的配对/挑战（含 PIN 场景下的请求方与过期时间）。 */
export interface AuthChallenge {
  pin: string;
  requestingNodeId: string;
  expiresAt: number;
}

export interface PairingRequest {
  pin: string;
  requestingNodeId?: string;
  expiresAt?: number;
}

export interface PairingToken {
  token: string;
  issuedAt: number;
  expiresAt?: number;
}

/** Noise 握手阶段（抽象类型，便于协议层统一）。 */
export interface NoiseHandshake {
  stage: "msg1" | "msg2" | "msg3" | "done";
  payloadBase64: string;
}

/** known_nodes 记录项（类似 SSH known_hosts）。 */
export interface KnownNodeEntry {
  nodeId: string;
  staticPublicKey: string;
  name?: string;
  firstSeen: number;
  lastConnected: number;
  trustSource: "pin-pairing" | "cloud-registry";
}

/** LAN PIN 确认消息（基于公钥指纹确认码）。 */
export interface PinConfirmation {
  confirmCode: string;
}

/** Cloud challenge-response（Ed25519）消息体。 */
export interface ChallengeResponse {
  nodeId: string;
  challenge?: string;
  signature?: string;
}
