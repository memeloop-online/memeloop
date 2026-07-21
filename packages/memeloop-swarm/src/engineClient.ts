import http from 'node:http';
import https from 'node:https';

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

import { engineStatusError } from './errors.js';

/** Options accepted by every request issued through {@link DockerEngineClient}. */
export interface EngineRequestOptions {
  /** Query string parameters (values are URL-encoded by the client). */
  query?: Record<string, string>;
  /** JSON-serializable request body. */
  body?: unknown;
  /** Cancellation signal; combined with the client-level timeout. */
  signal?: AbortSignal;
}

export interface DockerEngineClientOptions {
  /**
   * Unix socket path of the Docker Engine API. Defaults to
   * `/var/run/docker.sock`. Ignored when {@link baseUrl} is set.
   */
  socketPath?: string;
  /**
   * TCP base URL of the Docker Engine API, e.g. `http://127.0.0.1:2375` or
   * `https://docker.internal:2376`. When set, takes precedence over
   * {@link socketPath}.
   */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimal Docker Engine API HTTP client built on `node:http`/`node:https`.
 *
 * Supports both the default unix socket transport and a TCP base URL. There is
 * deliberately no Docker SDK dependency: the driver speaks the documented
 * Engine API endpoints directly. All payloads are JSON; response bodies are
 * parsed as JSON when possible and otherwise returned as strings.
 */
export class DockerEngineClient {
  private readonly socketPath?: string;
  private readonly baseUrl?: URL;
  private readonly timeoutMs: number;

  constructor(options: DockerEngineClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.baseUrl) {
      this.baseUrl = new URL(options.baseUrl);
    } else {
      this.socketPath = options.socketPath ?? DEFAULT_SOCKET_PATH;
    }
  }

  /**
   * Issue an Engine API request and resolve with the parsed JSON body (or raw
   * text for non-JSON endpoints such as `/_ping`).
   *
   * @throws {OrchestrationError} `INVALID`/`FORBIDDEN`/`NOT_FOUND`/`CONFLICT`/
   * `UNAVAILABLE` for HTTP error statuses, `CANCELLED` when the caller's
   * signal aborts, and `TIMEOUT` when the client deadline elapses.
   */
  async request<T = unknown>(method: string, path: string, options: EngineRequestOptions = {}): Promise<T> {
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
    if (bodyText !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyText));
    }

    return await new Promise<T>((resolve, reject) => {
      const requestOptions: http.RequestOptions | https.RequestOptions = this.baseUrl
        ? {
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port,
          path: `${this.baseUrl.pathname.replace(/\/$/, '')}${requestPath}`,
          method,
          headers,
          signal,
        }
        : {
          socketPath: this.socketPath,
          path: requestPath,
          method,
          headers,
          signal,
        };
      const transport = this.baseUrl?.protocol === 'https:' ? https : http;
      const request = transport.request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 400) {
            let message = text.trim() || res.statusMessage || 'unknown error';
            try {
              const parsed = JSON.parse(text) as { message?: string };
              if (parsed && typeof parsed.message === 'string') message = parsed.message;
            } catch {
              // non-JSON error body; keep raw text
            }
            reject(engineStatusError(statusCode, message, `${method} ${path}`));
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
        res.on('error', reject);
      });
      request.on('error', reject);
      if (bodyText !== undefined) request.write(bodyText);
      request.end();
    });
  }
}
