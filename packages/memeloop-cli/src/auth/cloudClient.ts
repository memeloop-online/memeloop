import { createPrivateKey, sign } from 'node:crypto';

export interface CloudRegisterOtpResult {
  nodeId: string;
  nodeSecret?: string;
}

export interface CloudJwtResult {
  accessToken: string;
  expiresIn?: number;
}

export interface CloudNodeChallengeResult {
  challenge: string;
  expiresIn?: number;
}

export interface NodeRegistrationPayload {
  nodeId: string;
  name?: string;
  capabilities?: {
    tools?: string[];
    hasWiki?: boolean;
    listenPort?: number;
  };
  publicIP?: string;
  frpAddress?: string;
  port?: number;
}

/**
 * HTTP client for the Cloud node registry.
 *
 * This client intentionally contains no peer transport. It only enrolls a node,
 * obtains short-lived registry authentication, publishes discovery metadata,
 * and sends heartbeats.
 */
export class CloudClient {
  public constructor(private readonly baseUrl: string) {}

  public async registerWithOtp(
    otp: string,
    keys?: { x25519PublicKey?: string; ed25519PublicKey?: string },
  ): Promise<CloudRegisterOtpResult> {
    return this.post('/api/nodes/register', {
      otp,
      ...(keys?.x25519PublicKey ? { x25519PublicKey: keys.x25519PublicKey } : {}),
      ...(keys?.ed25519PublicKey ? { ed25519PublicKey: keys.ed25519PublicKey } : {}),
    });
  }

  public async getJwt(nodeId: string, nodeSecret: string): Promise<CloudJwtResult> {
    return this.post('/api/nodes/token', { nodeId, nodeSecret });
  }

  public async getChallenge(nodeId: string): Promise<CloudNodeChallengeResult> {
    return this.post('/api/nodes/auth/challenge', { nodeId });
  }

  public async verifyChallenge(nodeId: string, signature: string): Promise<CloudJwtResult> {
    return this.post('/api/nodes/auth/verify', { nodeId, signature });
  }

  public async getJwtByChallenge(
    nodeId: string,
    ed25519PrivateKeyPkcs8Base64Url: string,
  ): Promise<CloudJwtResult> {
    const challenge = await this.getChallenge(nodeId);
    const privateKey = createPrivateKey({
      key: Buffer.from(ed25519PrivateKeyPkcs8Base64Url, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = sign(
      null,
      Buffer.from(challenge.challenge, 'base64url'),
      privateKey,
    ).toString('base64url');
    return this.verifyChallenge(nodeId, signature);
  }

  public async registerNode(
    payload: NodeRegistrationPayload,
    jwt: string,
  ): Promise<{ ok: boolean }> {
    return this.request(`/api/nodes/${encodeURIComponent(payload.nodeId)}`, {
      method: 'PUT',
      token: jwt,
      body: payload,
    });
  }

  public async heartbeat(nodeId: string, jwt: string): Promise<{ ok: boolean }> {
    return this.request(`/api/nodes/${encodeURIComponent(nodeId)}/heartbeat`, {
      method: 'POST',
      token: jwt,
      body: {},
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: 'POST', body });
  }

  private async request<T>(
    path: string,
    options: { method: 'POST' | 'PUT'; body: unknown; token?: string },
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method: options.method,
      headers,
      body: JSON.stringify(options.body),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 4096);
      throw new Error(`Cloud API ${response.status}: ${details}`);
    }
    return (await response.json()) as T;
  }
}
