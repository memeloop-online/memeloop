import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

import { kubernetesStatusError } from './errors.js';

/** Options accepted by every request issued through {@link KubernetesApiClient}. */
export interface KubernetesRequestOptions {
  /** Query string parameters (values are URL-encoded by the client). */
  query?: Record<string, string>;
  /** JSON-serializable request body. */
  body?: unknown;
  /** Cancellation signal; combined with the client-level timeout. */
  signal?: AbortSignal;
}

export interface KubernetesApiClientOptions {
  /**
   * API server base URL, e.g. `https://127.0.0.1:6443`. `http://` URLs are
   * accepted for tests and for apiserver-proxied setups.
   */
  baseUrl: string;
  /** Service-account or kubeconfig bearer token. Sent as `Authorization: Bearer`. */
  bearerToken?: string;
  /** Read the bearer token from this file instead of embedding it in driver config. */
  bearerTokenFile?: string;
  /** PEM-encoded CA certificate bundle used to verify the API server. */
  caCertificate?: string;
  /** Read the CA certificate bundle from this file instead of embedding it in driver config. */
  caCertificateFile?: string;
  /**
   * Explicitly disable TLS server verification. This weakens authentication
   * of the control plane endpoint and must be an intentional operator
   * choice — the driver never silently skips verification.
   */
  skipTlsVerify?: boolean;
  /** Per-request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal Kubernetes API client built on `node:https`/`node:http`.
 *
 * Bearer-token authentication, optional CA pinning, and an explicit
 * skip-verify flag. There is deliberately no `@kubernetes/client-node`
 * dependency: the driver speaks the documented REST endpoints directly.
 */
export class KubernetesApiClient {
  private readonly baseUrl: URL;
  private readonly bearerToken?: string;
  private readonly caCertificate?: string;
  private readonly skipTlsVerify: boolean;
  private readonly timeoutMs: number;

  constructor(options: KubernetesApiClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (options.bearerToken !== undefined && options.bearerTokenFile !== undefined) {
      throw new Error('Configure only one of bearerToken or bearerTokenFile');
    }
    if (options.caCertificate !== undefined && options.caCertificateFile !== undefined) {
      throw new Error('Configure only one of caCertificate or caCertificateFile');
    }
    this.bearerToken = options.bearerToken ??
      (options.bearerTokenFile ? readFileSync(options.bearerTokenFile, 'utf8').trim() : undefined);
    this.caCertificate = options.caCertificate ??
      (options.caCertificateFile ? readFileSync(options.caCertificateFile, 'utf8') : undefined);
    this.skipTlsVerify = options.skipTlsVerify ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Issue an API request and resolve with the parsed JSON body (or raw text
   * for non-JSON endpoints such as `/healthz`).
   *
   * @throws {OrchestrationError} mapped from the Kubernetes `Status` object on
   * error responses; `CANCELLED` on caller abort; `TIMEOUT` on deadline.
   */
  async request<T = unknown>(method: string, path: string, options: KubernetesRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) {
      throw new DOMException('The operation was aborted', 'AbortError');
    }
    const signals = [options.signal, AbortSignal.timeout(this.timeoutMs)].filter((s): s is AbortSignal => s !== undefined);
    const signal = AbortSignal.any(signals);

    const query = options.query && Object.keys(options.query).length > 0
      ? `?${new URLSearchParams(options.query).toString()}`
      : '';
    const requestPath = `${path}${query}`;
    const bodyText = options.body === undefined ? undefined : JSON.stringify(options.body);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    if (bodyText !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyText));
    }

    return await new Promise<T>((resolve, reject) => {
      const isHttps = this.baseUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const requestOptions: https.RequestOptions = {
        hostname: this.baseUrl.hostname,
        port: this.baseUrl.port,
        path: `${this.baseUrl.pathname.replace(/\/$/, '')}${requestPath}`,
        method,
        headers,
        signal,
        ...(isHttps
          ? {
            rejectUnauthorized: !this.skipTlsVerify,
            ...(this.caCertificate ? { ca: this.caCertificate } : {}),
          }
          : {}),
      };
      const request = transport.request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 400) {
            let message = text.trim() || response.statusMessage || 'unknown error';
            try {
              // Kubernetes error responses are `Status` objects.
              const parsed = JSON.parse(text) as { message?: string; reason?: string };
              if (parsed && typeof parsed.message === 'string') {
                message = parsed.reason ? `${parsed.reason}: ${parsed.message}` : parsed.message;
              }
            } catch {
              // non-JSON error body; keep raw text
            }
            const retryAfterHeader = response.headers['retry-after'];
            const retryAfterSeconds = typeof retryAfterHeader === 'string' ? Number.parseInt(retryAfterHeader, 10) : undefined;
            reject(kubernetesStatusError(
              statusCode,
              message,
              `${method} ${path}`,
              Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
            ));
            return;
          }
          if (text.length === 0) {
            resolve(undefined as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            resolve(text as T);
          }
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      if (bodyText !== undefined) request.write(bodyText);
      request.end();
    });
  }
}
